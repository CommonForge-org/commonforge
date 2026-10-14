/**
 * Intake (plan §0.3 A6, C.1 #2, FR-02).
 *
 * URL import: public HTTPS remotes only, run in a queue step (import is effectively synchronous but
 * takes up to ~70 s, then 504 + rollback). On 504 retry once with `depth: 1`; record the branch
 * explicitly (Artifacts misreports `default_branch`); a 409 "in progress" followed by 404 is a failed
 * import. The 24 h token returned by import is revoked at once.
 *
 * ZIP upload: bytes go to R2 staging (`org/<org>/intake/<id>/upload.zip`), a runner `inventory` job
 * lists them (deterministic, no execution); the Worker turns the listing into a placement plan with
 * a reason for every exclusion; `confirm` creates the resources and mounts.
 */
import { artRevisionId } from "@commonforge-org/core";
import type { InventoryReceipt } from "@commonforge-org/runner-protocol";
import { isArtifactsProviderError } from "@commonforge-org/provider-cloudflare";
import type { Services } from "../context.js";
import { ImportError, repoInfoCoords } from "./artifacts.js";
import { grantFolderToProjectPeople } from "./access.js";
import { getMount, getProject, getResource, updateResource } from "./directory.js";
import { recordEvent, userRef } from "./events.js";
import { bindHead } from "./resources.js";
import { onRunnerResult } from "./runner-jobs.js";
import { onStep, onStepFailed } from "./steps.js";

export const MAX_ZIP_BYTES = 100 * 1024 * 1024;
export const ARTIFACTS_MAX_BLOB = 32 * 1024 * 1024;

export interface IntakeRow {
  intake_id: string;
  org_id: string;
  kind: "url" | "zip";
  state: string;
  request_json: string;
  r2_key: string | null;
  job_id: string | null;
  inventory_json: string | null;
  plan_json: string | null;
  result_json: string | null;
  error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface UrlIntakeRequest {
  resourceId: string;
  url: string;
  branch: string;
  depth?: number;
  projectId?: string;
  mountName?: string;
}

export async function getIntake(svc: Services, orgId: string, intakeId: string): Promise<IntakeRow | null> {
  return svc.db.prepare("SELECT * FROM intakes WHERE org_id = ? AND intake_id = ?").bind(orgId, intakeId).first<IntakeRow>();
}

export async function updateIntake(svc: Services, intakeId: string, patch: Partial<Pick<IntakeRow, "state" | "request_json" | "inventory_json" | "plan_json" | "result_json" | "error" | "job_id">>): Promise<void> {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  await svc.db
    .prepare(`UPDATE intakes SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE intake_id = ?`)
    .bind(...keys.map((k) => patch[k] ?? null), svc.nowIso(), intakeId)
    .run();
}

const BLOCKED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".arpa", ".nip.io", ".sslip.io", ".localtest.me"];

/**
 * Only `https://host/...` on the default port, without credentials, query or fragment; no IP
 * literals, single-label or internal-looking names (M-7; Cloudflare fetches, but defence in depth).
 */
export function validateImportUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return null;
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return null;
  return u.toString();
}

export type StepOutcome = { done: true } | { retry: true; delaySeconds: number; reason: string };

/** Queue step `intake.import`. */
export async function runUrlImport(svc: Services, orgId: string, intakeId: string): Promise<StepOutcome> {
  const intake = await getIntake(svc, orgId, intakeId);
  if (!intake || intake.state === "completed" || intake.state === "failed") return { done: true };
  const req = JSON.parse(intake.request_json) as UrlIntakeRequest;
  const resource = await getResource(svc.db, orgId, req.resourceId);
  if (!resource) return { done: true };
  const ns = svc.provider().namespace(orgId, "canonical");
  const fail = async (error: string) => {
    await updateIntake(svc, intakeId, { state: "failed", error });
    await updateResource(svc.db, orgId, req.resourceId, { state: "failed", error }, svc.nowIso());
    return { done: true } as const;
  };

  let info = await lookup(svc, ns, req.resourceId);
  if (info === "in_progress") return { retry: true, delaySeconds: 5, reason: "import in progress" };
  if (!info) {
    await updateIntake(svc, intakeId, { state: "importing" });
    try {
      const created = await svc.importer.importRepo(ns, req.resourceId, { url: req.url, branch: req.branch, ...(req.depth ? { depth: req.depth } : {}) });
      info = created;
    } catch (e) {
      if (!(e instanceof ImportError)) throw e;
      switch (e.code) {
        case "import_timeout":
          if (req.depth) return fail(`import timed out even with depth ${req.depth}`);
          // the server rolled the repo back; retry shallow (history truncated, recorded on the resource)
          await updateIntake(svc, intakeId, { request_json: JSON.stringify({ ...req, depth: 1 }) });
          return { retry: true, delaySeconds: 1, reason: "504: retry with depth 1" };
        case "import_in_progress":
        case "already_exists": {
          const again = await lookup(svc, ns, req.resourceId);
          if (again === "in_progress") return { retry: true, delaySeconds: 5, reason: "import in progress" };
          if (!again) return fail("import failed (repository vanished after 409)"); // 404 after 409
          info = again;
          break;
        }
        case "provider_unavailable":
          return { retry: true, delaySeconds: 10, reason: e.message };
        default:
          return fail(e.message);
      }
    }
  }
  // never keep the 24 h token returned by import/create
  for (const t of await svc.transport.listTokens(ns, info.name)) {
    if (t.state === "active") await svc.transport.revokeToken(ns, info.name, t.id);
  }
  const [head] = await svc.transport.log(ns, info.name, { ref: req.branch, limit: 1 });
  if (!head) return fail(`branch ${req.branch} not found in the imported repository`);
  const coords = repoInfoCoords(ns, info);
  const now = svc.nowIso();
  await updateResource(svc.db, orgId, req.resourceId, { coords_json: JSON.stringify(coords), branch: req.branch }, now);
  const rev = artRevisionId(coords.repoId, head.hash);
  await bindHead(svc, orgId, req.resourceId, rev, userRef(intake.created_by));
  await updateResource(svc.db, orgId, req.resourceId, { state: "active", error: null, source_json: JSON.stringify({ kind: "url", url: req.url, branch: req.branch, ...(req.depth ? { depth: req.depth, historyTruncated: true } : {}) }) }, now);
  let mounted = false;
  if (req.projectId && req.mountName && (await getProject(svc.db, orgId, req.projectId))) {
    const ins = await svc.db
      .prepare("INSERT OR IGNORE INTO mounts (org_id, project_id, mount_name, resource_id, mode, operations_json, created_at) VALUES (?, ?, ?, ?, 'must-match-accepted', '[\"read\",\"write\"]', ?)")
      .bind(orgId, req.projectId, req.mountName, req.resourceId, now)
      .run();
    const inserted = (ins.meta.changes ?? 0) > 0;
    if (inserted) {
      await svc.db.prepare("UPDATE projects SET membership_revision = membership_revision + 1 WHERE org_id = ? AND project_id = ?").bind(orgId, req.projectId).run();
      await recordEvent(svc, { orgId, projectId: req.projectId, actor: userRef(intake.created_by), action: "mount.added", subjectKind: "project", subjectId: req.projectId, resourceIds: [req.resourceId], detail: { mountName: req.mountName, resourceId: req.resourceId, intakeId } });
    }
    // the name was checked free at request time; if another add won it meanwhile, say so (no silent
    // claim). A retry of this step finds its own earlier mount: still mounted, nothing bumped twice.
    mounted = inserted || (await getMount(svc.db, orgId, req.projectId, req.mountName))?.resource_id === req.resourceId;
    // idempotent (only widens), so a retry that stopped before it still grants the folder
    if (mounted) await grantFolderToProjectPeople(svc, { orgId, projectId: req.projectId, resourceId: req.resourceId, actorId: intake.created_by });
  }
  await updateIntake(svc, intakeId, { state: "completed", result_json: JSON.stringify({ resourceId: req.resourceId, revisionId: rev, branch: req.branch, ...(req.mountName ? { mounted } : {}) }) });
  await recordEvent(svc, { orgId, actor: userRef(intake.created_by), action: "intake.imported", subjectKind: "resource", subjectId: req.resourceId, resourceIds: [req.resourceId], detail: { revisionId: rev } });
  return { done: true };
}

// registered here (not in steps.ts) so steps.ts does not import this module: attaching a folder reaches
// services/access.ts → tasks.ts → steps.ts, and steps.ts → intake.ts would close a load-order cycle
onStep("intake.import", (svc, msg) => runUrlImport(svc, msg.orgId, msg.intakeId));
onStepFailed("intake.import", (svc, msg, reason) => updateIntake(svc, msg.intakeId, { state: "failed", error: reason }));

async function lookup(svc: Services, ns: string, name: string) {
  try {
    return await svc.transport.getRepo(ns, name);
  } catch (e) {
    if (isArtifactsProviderError(e, "already_exists")) return "in_progress" as const; // GET answers 409 while importing
    throw e;
  }
}

// ------------------------------------------------------------------------------------------ ZIP

export interface Placement {
  resourceName: string;
  provider: "artifacts" | "r2-assets";
  /** archive prefix this resource is built from ('' = root) */
  pathPrefix: string;
  files: number;
  bytes: number;
  reason: string;
}

export interface PlacementPlan {
  placements: Placement[];
  excluded: Array<{ path: string; reason: string }>;
  /**
   * Set at confirm: excluded files an owner included anyway after inspecting them (only files
   * blocked by the secret-looking-name rule qualify), and the code resource each one goes into.
   */
  includedAnyway?: Array<{ path: string; resourceName: string }>;
}

/** The exclusion reason of the secret-looking-name rule: the only exclusion an owner may override. */
export const SECRET_NAME_REASON = "looks like a credential file; blocked (content not inspected or shown)";

const MEDIA_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|mov|webm|mkv|mp3|wav|ogg|flac|pdf|psd|ai|zip|gz|tgz|woff2?|ttf|otf)$/i;
const SECRET_RE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|\.npmrc|\.netrc|\.pypirc|service-account.*\.json)$/i;
const EXCLUDED_SEGMENTS: Record<string, string> = {
  node_modules: "dependency folder (reinstall from the lockfile)",
  ".git": "nested repository metadata (import the repository by URL to keep its history)",
  dist: "build output",
  build: "build output",
  ".next": "build output",
  ".turbo": "build cache",
  ".cache": "cache",
};

/** Deterministic placement rules over an inventory (no AI, no execution). */
export function placementPlan(inventory: InventoryReceipt, archiveName: string): PlacementPlan {
  const excluded: PlacementPlan["excluded"] = inventory.rejected.map((r) => ({ path: r.path, reason: `refused by inventory: ${r.reason}` }));
  const code = new Map<string, { files: number; bytes: number }>();
  const assets = { files: 0, bytes: 0 };
  for (const e of inventory.entries) {
    const segs = e.path.split("/");
    // case-insensitive (`.GIT/`, `NODE_MODULES/`), own keys only (a folder named "constructor" is code)
    const seg = segs.map((s) => s.toLowerCase()).find((s) => Object.hasOwn(EXCLUDED_SEGMENTS, s));
    if (seg) {
      excluded.push({ path: e.path, reason: EXCLUDED_SEGMENTS[seg]! });
      continue;
    }
    if (SECRET_RE.test(e.path)) {
      excluded.push({ path: e.path, reason: SECRET_NAME_REASON });
      continue;
    }
    if (e.size > ARTIFACTS_MAX_BLOB || MEDIA_RE.test(e.path)) {
      assets.files++;
      assets.bytes += e.size;
      continue;
    }
    const top = segs.length > 1 ? segs[0]! : "";
    const g = code.get(top) ?? { files: 0, bytes: 0 };
    g.files++;
    g.bytes += e.size;
    code.set(top, g);
  }
  const base = archiveName.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64) || "upload";
  const placements: Placement[] = [];
  const rootOnly = code.size === 1 && code.has("");
  for (const [top, g] of [...code.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    placements.push({
      resourceName: top === "" ? base : top,
      provider: "artifacts",
      pathPrefix: top === "" ? "" : `${top}/`,
      files: g.files,
      bytes: g.bytes,
      reason: rootOnly ? "source files at the archive root" : top === "" ? "loose files at the archive root" : `top-level folder "${top}" kept as its own code resource`,
    });
  }
  if (assets.files > 0) {
    placements.push({ resourceName: `${base}-assets`, provider: "r2-assets", pathPrefix: "", files: assets.files, bytes: assets.bytes, reason: "media/binary files and files over 32 MiB stay out of Git (R2 asset collection)" });
  }
  return { placements, excluded };
}

export type IncludeRefusal = "not_excluded" | "not_secret_name" | "oversize" | "no_placement";

/**
 * "Include anyway" (UX-POLISH §11.3): resolve an owner's request to include excluded files.
 * A path qualifies only when every exclusion row the dry run has for it is the secret-looking-name rule (never
 * `.git/`, `node_modules`, build output, refused or oversize entries), it fits in Git, and the code
 * resource its folder becomes is being created (`chosen`). Everything else is refused, by path.
 */
export function resolveIncludes(
  plan: PlacementPlan,
  inventory: { entries: ReadonlyArray<{ path: string; size: number }> },
  chosen: Placement[],
  include: string[],
): { included: Array<{ path: string; resourceName: string }>; refused: Array<{ path: string; why: IncludeRefusal }> } {
  // every exclusion row of a path counts: a path the inventory also refused (e.g. a duplicate entry
  // name) is never includable, whatever its other row says
  const reasons = new Map<string, string[]>();
  for (const e of plan.excluded) reasons.set(e.path, [...(reasons.get(e.path) ?? []), e.reason]);
  const sizes = new Map(inventory.entries.map((e) => [e.path, e.size]));
  const included: Array<{ path: string; resourceName: string }> = [];
  const refused: Array<{ path: string; why: IncludeRefusal }> = [];
  for (const path of [...new Set(include)]) {
    const rows = reasons.get(path);
    if (rows === undefined) {
      refused.push({ path, why: "not_excluded" });
      continue;
    }
    const size = sizes.get(path);
    if (rows.some((r) => r !== SECRET_NAME_REASON) || size === undefined) {
      refused.push({ path, why: "not_secret_name" });
      continue;
    }
    if (size > ARTIFACTS_MAX_BLOB) {
      refused.push({ path, why: "oversize" });
      continue;
    }
    const segs = path.split("/");
    const prefix = segs.length > 1 ? `${segs[0]}/` : "";
    const into = chosen.find((p) => p.provider === "artifacts" && p.pathPrefix === prefix);
    if (!into) {
      refused.push({ path, why: "no_placement" });
      continue;
    }
    included.push({ path, resourceName: into.resourceName });
  }
  return { included, refused };
}

onRunnerResult("inventory", async (svc, row, job, result) => {
  if (job.kind !== "inventory") return;
  const intake = await getIntake(svc, row.org_id, job.intakeId);
  if (!intake) return;
  if (!result.ok) {
    await updateIntake(svc, intake.intake_id, { state: "failed", error: `inventory ${result.code}: ${result.detail.slice(0, 500)}` });
    return;
  }
  const receipt = result.receipt as InventoryReceipt;
  const req = JSON.parse(intake.request_json) as { filename: string };
  const plan = placementPlan(receipt, req.filename);
  await updateIntake(svc, intake.intake_id, { state: "inventoried", inventory_json: JSON.stringify(receipt), plan_json: JSON.stringify(plan) });
});
