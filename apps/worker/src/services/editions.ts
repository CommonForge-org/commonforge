/**
 * Client Workspace Editions (PRD §4.5, FR-16..FR-18, §7.5; plan §B.13, §C.1 row 9, §F).
 *
 * - **Policy** (developer-configured, server-owned): per source mount a read allowlist (canonical
 *   globs: what is published), a write allowlist (canonical path prefixes: what a return may
 *   change), plus protected paths (canonical globs a return may never change) and excludes.
 * - **Build**: a runner `build-edition` job writes ONE parentless commit with only the allowlisted
 *   files into the edition's own repo in the `-editions` namespace (AT-26). The result is an
 *   immutable build row: the server-side edition manifest (inventory, mappings, canonical bases,
 *   source release).
 * - **Access**: an edition grant (separate from project/resource grants) lets a client start edit
 *   sessions, download the edition as a ZIP and get a **read** token on the edition repo only;
 *   nothing here can resolve or mint for a canonical repository (AT-25).
 * - **Return**: a ZIP upload is checked by the Worker (safe reader, AT-28), staged in R2, mapped by
 *   core `diffAgainstInventory` + `mapEditionDelta` against the session's build (AT-29), refused
 *   when the target moved since the build (AT-30), and handed to a runner `edition-return` job that
 *   pushes a candidate into a fresh `-tasks` repo. The Worker then freezes it like any task
 *   candidate and opens a proposal, so review / integrate / accept are the normal flow.
 */
import { getLive } from "./releases.js";
import {
  MountNameSchema,
  PathPrefixSchema,
  candidateId as toCandidateId,
  checkPath,
  isWithinPrefix,
  diffAgainstInventory,
  joinPath,
  mapEditionDelta,
  parseRevisionId,
  sha256Hex,
  CoreError,
  type ArtifactsCoords,
  type BlockedChange,
  type EditionManifestServerSide,
  type EditionMapping,
  type EditionReturnReceipt,
  type MappedChange,
  type ProjectSnapshot,
} from "@commonforge-org/core";
import { ArtifactsProviderError, editionRepoName, isArtifactsProviderError, namespaceFor } from "@commonforge-org/provider-cloudflare";
import type { EditionBuildReceipt, IntegrationJobInput } from "@commonforge-org/runner-protocol";
import { z } from "zod";
import type { Services } from "../context.js";
import { conflict } from "../lib/http.js";
import { repoInfoCoords } from "./artifacts.js";
import { getProject, getResource, type Role } from "./directory.js";
import { recordEvent, userRef } from "./events.js";
import { buildProposal, proposalResourceIds } from "./proposals.js";
import { issueJob, onRunnerResult, type RunnerJobRow } from "./runner-jobs.js";
import { enqueueStep, onStep, onStepFailed } from "./steps.js";
import { ensureFreshTaskRepo, liveCanonical } from "./task-repos.js";
import { getTask, getWorkspaceRow, setTaskState, setWorkspaceState } from "./tasks.js";

// =============================================================================================
// Policy
// =============================================================================================

const PatternSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((p) => checkPath(p).ok, "expected a relative path or glob without '..'");

/** A write-allowlist entry: a canonical path prefix (a file or a folder; "" = the whole resource). */
const WritePrefixSchema = z
  .string()
  .max(512)
  .refine((p) => !/[*?]/.test(p), "write paths are path prefixes, not globs")
  .refine((p) => checkPath(p, { allowEmpty: true }).ok, "expected a relative path without '..'")
  .transform((p) => (checkPath(p, { allowEmpty: true }) as { path: string }).path);

export const EditionSourceSchema = z.object({
  mountName: MountNameSchema,
  /** read allowlist: canonical-path globs (core `matchesPathPattern`; a plain path matches itself and below) */
  include: z.array(PatternSchema).min(1).max(200),
  /** write allowlist: canonical path prefixes a return may change */
  write: z.array(WritePrefixSchema).max(200).default([]),
  /** where the mount appears in the edition ("" = edition root; default: root for one source, else the mount name) */
  editionPathPrefix: PathPrefixSchema.optional(),
});

export const EditionPolicySchema = z
  .object({
    sources: z.array(EditionSourceSchema).min(1).max(8),
    /** always-excluded globs, applied after include (default `**\/.env*`) */
    exclude: z.array(PatternSchema).max(200).default(["**/.env*"]),
    /** canonical-path globs a return may never change (policy, pipeline, dependencies, contract tests) */
    protectedPaths: z.array(PatternSchema).max(200).default([]),
  })
  .superRefine((p, ctx) => {
    const names = new Set<string>();
    p.sources.forEach((s, i) => {
      if (names.has(s.mountName)) ctx.addIssue({ code: "custom", message: "a mount appears twice", path: ["sources", i, "mountName"] });
      names.add(s.mountName);
    });
    if (p.sources.filter((s) => s.write.length > 0).length > 1) {
      ctx.addIssue({ code: "custom", message: "only one source may be writable (a return targets one resource)", path: ["sources"] });
    }
    const prefixes = p.sources.map((s) => editionPrefixOf(p.sources.length, s));
    prefixes.forEach((a, i) =>
      prefixes.forEach((b, j) => {
        if (i < j && (a === b || a === "" || b === "" || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))) {
          ctx.addIssue({ code: "custom", message: "edition path prefixes of two sources overlap", path: ["sources", j, "editionPathPrefix"] });
        }
      }),
    );
  });
export type EditionPolicy = z.infer<typeof EditionPolicySchema>;
export type EditionSource = EditionPolicy["sources"][number];

export function editionPrefixOf(sourceCount: number, s: { mountName: string; editionPathPrefix?: string | undefined }): string {
  return s.editionPathPrefix ?? (sourceCount === 1 ? "" : s.mountName);
}

/**
 * Server-owned mappings (plan §B.13): each source maps read-only at its edition prefix; each write
 * prefix adds a longer, writable mapping (core `mapEditionPath` takes the longest match).
 */
export function mappingsFor(policy: EditionPolicy, resourceIdByMount: ReadonlyMap<string, string>): EditionMapping[] {
  const out: EditionMapping[] = [];
  for (const s of policy.sources) {
    const resourceId = resourceIdByMount.get(s.mountName)!;
    const ep = editionPrefixOf(policy.sources.length, s);
    const wholeWritable = s.write.includes("");
    out.push({ editionPathPrefix: ep, resourceId, canonicalPathPrefix: "", writable: wholeWritable } as EditionMapping);
    for (const w of new Set(s.write)) {
      if (w === "") continue;
      out.push({ editionPathPrefix: joinPath(ep, w), resourceId, canonicalPathPrefix: w, writable: true } as EditionMapping);
    }
  }
  return out;
}

/** Protected canonical globs as edition paths (client display only; enforcement is on canonical paths). */
export function protectedEditionPaths(policy: EditionPolicy): string[] {
  const src = policy.sources.find((s) => s.write.length > 0);
  if (!src) return [];
  const ep = editionPrefixOf(policy.sources.length, src);
  return policy.protectedPaths.map((p) => (ep ? `${ep}/${p}` : p));
}

// =============================================================================================
// Rows
// =============================================================================================

export type EditionState = "draft" | "building" | "ready" | "failed";

export interface EditionRow {
  edition_id: string;
  org_id: string;
  project_id: string;
  name: string;
  policy_json: string;
  policy_revision: number;
  repo_json: string | null;
  state: EditionState;
  current_build_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface BuildRow {
  build_id: string;
  edition_id: string;
  org_id: string;
  policy_revision: number;
  policy_json: string;
  state: "queued" | "ready" | "failed";
  job_id: string | null;
  source_release_id: string | null;
  snapshot_json: string;
  bases_json: string;
  mappings_json: string;
  protected_json: string;
  sha: string | null;
  inventory_json: string | null;
  error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  session_id: string;
  edition_id: string;
  build_id: string;
  org_id: string;
  project_id: string;
  user_id: string;
  title: string;
  request: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
}

export type ReturnState = "queued" | "running" | "freezing" | "proposed" | "no_changes" | "stale" | "conflict" | "refused" | "failed";

export interface ReturnRow {
  return_id: string;
  session_id: string;
  edition_id: string;
  build_id: string;
  org_id: string;
  project_id: string;
  user_id: string;
  mode: "full" | "partial";
  deletions_json: string;
  r2_key: string;
  size: number;
  sha256: string;
  tool: string | null;
  resource_id: string;
  expected_head: string;
  task_id: string;
  task_workspace_id: string;
  state: ReturnState;
  job_id: string | null;
  preview_json: string;
  receipt_json: string | null;
  proposal_id: string | null;
  error_code: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type Inventory = EditionManifestServerSide["inventory"];
export type Bases = Array<{ resourceId: string; revisionId: string }>;

export const editionPolicy = (e: EditionRow) => EditionPolicySchema.parse(JSON.parse(e.policy_json));
export const editionRepo = (e: EditionRow) => (e.repo_json ? (JSON.parse(e.repo_json) as ArtifactsCoords) : null);

export async function getEdition(svc: Services, orgId: string, editionId: string): Promise<EditionRow | null> {
  return svc.db.prepare("SELECT * FROM editions WHERE org_id = ? AND edition_id = ?").bind(orgId, editionId).first<EditionRow>();
}

export async function getBuild(svc: Services, buildId: string): Promise<BuildRow | null> {
  return svc.db.prepare("SELECT * FROM edition_builds WHERE build_id = ?").bind(buildId).first<BuildRow>();
}

export async function getSession(svc: Services, orgId: string, sessionId: string): Promise<SessionRow | null> {
  return svc.db.prepare("SELECT * FROM edition_sessions WHERE org_id = ? AND session_id = ?").bind(orgId, sessionId).first<SessionRow>();
}

export async function getReturn(svc: Services, returnId: string): Promise<ReturnRow | null> {
  return svc.db.prepare("SELECT * FROM edition_returns WHERE return_id = ?").bind(returnId).first<ReturnRow>();
}

async function updateReturn(svc: Services, returnId: string, patch: Partial<Pick<ReturnRow, "state" | "job_id" | "receipt_json" | "proposal_id" | "error_code" | "error">>, from?: ReturnState[]): Promise<boolean> {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
  const where = from ? ` AND state IN (${from.map(() => "?").join(", ")})` : "";
  const r = await svc.db
    .prepare(`UPDATE edition_returns SET ${sets} WHERE return_id = ?${where}`)
    .bind(...keys.map((k) => patch[k] ?? null), svc.nowIso(), returnId, ...(from ?? []))
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * The live release of a project (PRD §4.5, AT-30: an edit session records the currently deployed
 * release). Read from the release service's live pointer (Task 22, `release_live`: it moves only
 * after a deploy passed its `/version` check). Null while nothing was published; builds always
 * start from the accepted heads, recorded in `canonicalBases`.
 */
export async function liveRelease(svc: Services, orgId: string, projectId: string): Promise<{ releaseId: string } | null> {
  const live = await getLive(svc, orgId, projectId);
  return live ? { releaseId: live.release_id } : null;
}

// =============================================================================================
// Build
// =============================================================================================

export const EDITION_LOCK_MS = 120_000;

/**
 * Queue step `edition.build`: make sure the edition repo exists in `-editions` (created once,
 * adopted on retry), then issue the `build-edition` job. The job result is applied below.
 */
onStep("edition.build", async (svc, msg) => {
  const build = await getBuild(svc, msg.buildId);
  if (!build || build.state !== "queued" || build.job_id) return { done: true };
  const edition = await getEdition(svc, build.org_id, build.edition_id);
  if (!edition) return { done: true };
  const out = await svc.gate.withLock("edition", edition.edition_id, EDITION_LOCK_MS, async () => {
    const again = await getBuild(svc, build.build_id);
    if (!again || again.state !== "queued" || again.job_id) return;
    const repo = await ensureEditionRepo(svc, edition);
    // the policy snapshotted on the build row (M-5), never the edition's current one
    const policy = EditionPolicySchema.parse(JSON.parse(build.policy_json));
    const bases = JSON.parse(build.bases_json) as Bases;
    const snapshot = JSON.parse(build.snapshot_json) as ProjectSnapshot;
    const sources = [];
    for (const s of policy.sources) {
      const entry = snapshot.entries.find((e) => e.mountName === s.mountName);
      const base = entry ? bases.find((b) => b.resourceId === entry.resourceId) : undefined;
      if (!entry || !base) throw new Error(`source ${s.mountName} missing from the build snapshot`);
      const canonical = await liveCanonical(svc, build.org_id, entry.resourceId);
      sources.push({
        resourceId: entry.resourceId,
        canonical,
        sha: (parseRevisionId(base.revisionId as never) as { sha: string }).sha,
        canonicalPathPrefix: "",
        editionPathPrefix: editionPrefixOf(policy.sources.length, s),
        include: s.include,
      });
    }
    const job = await issueJob(svc, { kind: "build-edition", editionId: edition.edition_id, sources, exclude: policy.exclude, editionRepo: repo } as IntegrationJobInput, {
      orgId: build.org_id,
      subject: `edition-build:${build.build_id}`,
      lifetimeSeconds: 3600,
    });
    await svc.db.prepare("UPDATE edition_builds SET job_id = ?, updated_at = ? WHERE build_id = ? AND job_id IS NULL").bind(job.jobId, svc.nowIso(), build.build_id).run();
  });
  if (out.locked) return { retry: true, delaySeconds: 5, reason: "another step holds this edition" };
  return { done: true };
});

onStepFailed("edition.build", async (svc, msg, reason) => {
  const build = await getBuild(svc, msg.buildId);
  if (!build || build.state !== "queued") return;
  await finishBuild(svc, build, { ok: false, error: reason.slice(0, 500) });
});

/** The edition repo `ed-<editionId>` in `<prefix>-<org>-editions`; created on the first build. */
async function ensureEditionRepo(svc: Services, edition: EditionRow): Promise<ArtifactsCoords> {
  const ns = namespaceFor(svc.env.COMMONFORGE_NAMESPACE_PREFIX, edition.org_id, "editions");
  const name = editionRepoName(edition.edition_id);
  const known = editionRepo(edition);
  let info = await svc.transport.getRepo(ns, name);
  if (known && (!info || info.id !== known.repoId)) throw new ArtifactsProviderError("repo_mismatch", "the edition repository changed");
  if (!info) {
    try {
      const created = await svc.transport.createRepo(ns, name, { description: `commonforge edition ${edition.edition_id}`, defaultBranch: "main" });
      info = { id: created.id, name: created.name, defaultBranch: created.defaultBranch, remote: created.remote, source: created.source, readOnly: created.readOnly };
    } catch (e) {
      if (!isArtifactsProviderError(e, "already_exists")) throw e;
      info = await svc.transport.getRepo(ns, name);
      if (!info) throw e;
    }
    // the create token is never kept
    for (const t of await svc.transport.listTokens(ns, name)) if (t.state === "active") await svc.transport.revokeToken(ns, name, t.id).catch(() => false);
  }
  const coords = repoInfoCoords(ns, info);
  if (!known) await svc.db.prepare("UPDATE editions SET repo_json = ?, updated_at = ? WHERE edition_id = ?").bind(JSON.stringify(coords), svc.nowIso(), edition.edition_id).run();
  return coords;
}

async function finishBuild(svc: Services, build: BuildRow, out: { ok: true; receipt: EditionBuildReceipt } | { ok: false; error: string }): Promise<void> {
  const now = svc.nowIso();
  const edition = await getEdition(svc, build.org_id, build.edition_id);
  const snapshot = JSON.parse(build.snapshot_json) as ProjectSnapshot;
  const resourceIds = snapshot.entries.map((e) => e.resourceId);
  if (out.ok) {
    await svc.db
      .prepare("UPDATE edition_builds SET state = 'ready', sha = ?, inventory_json = ?, error = NULL, updated_at = ? WHERE build_id = ? AND state = 'queued'")
      .bind(out.receipt.sha, JSON.stringify(out.receipt.inventory), now, build.build_id)
      .run();
    // a newer build is never replaced by an older one that finished later
    await svc.db
      .prepare(
        // never a build of an older policy revision (re-review M-5), never over a newer build
        "UPDATE editions SET state = 'ready', current_build_id = ?, updated_at = ? WHERE edition_id = ? AND policy_revision = ? AND (current_build_id IS NULL OR (SELECT created_at FROM edition_builds WHERE build_id = editions.current_build_id) <= ?)",
      )
      .bind(build.build_id, now, build.edition_id, build.policy_revision, build.created_at)
      .run();
    await recordEvent(svc, { orgId: build.org_id, projectId: edition?.project_id ?? null, actor: { kind: "runner", id: "integration-runner" } as never, action: "edition.built", subjectKind: "edition", subjectId: build.edition_id, resourceIds, detail: { buildId: build.build_id, files: out.receipt.inventory.length } });
  } else {
    await svc.db.prepare("UPDATE edition_builds SET state = 'failed', error = ?, updated_at = ? WHERE build_id = ? AND state = 'queued'").bind(out.error, now, build.build_id).run();
    await svc.db.prepare("UPDATE editions SET state = CASE WHEN current_build_id IS NULL THEN 'failed' ELSE 'ready' END, updated_at = ? WHERE edition_id = ?").bind(now, build.edition_id).run();
    await recordEvent(svc, { orgId: build.org_id, projectId: edition?.project_id ?? null, actor: { kind: "runner", id: "integration-runner" } as never, action: "edition.build_failed", subjectKind: "edition", subjectId: build.edition_id, resourceIds, detail: { buildId: build.build_id, error: out.error } });
  }
}

onRunnerResult("build-edition", async (svc, row: RunnerJobRow, job, result) => {
  if (job.kind !== "build-edition") return;
  const build = await svc.db.prepare("SELECT * FROM edition_builds WHERE job_id = ?").bind(row.job_id).first<BuildRow>();
  if (!build) return;
  if (!result.ok) return finishBuild(svc, build, { ok: false, error: `${result.code}: ${result.detail.slice(0, 500)}` });
  const receipt = result.receipt as EditionBuildReceipt;
  await finishBuild(svc, build, { ok: true, receipt });
});

// =============================================================================================
// Manifest, preview
// =============================================================================================

/** The server-side manifest (plan §B.13) of a ready build. */
export function manifestOf(edition: EditionRow, build: BuildRow): EditionManifestServerSide {
  const snapshot = JSON.parse(build.snapshot_json) as ProjectSnapshot;
  const repo = editionRepo(edition);
  return {
    editionId: edition.edition_id,
    policyRevision: build.policy_revision,
    sourceReleaseId: build.source_release_id,
    exportedSnapshotId: snapshot.snapshotId,
    inventory: JSON.parse(build.inventory_json ?? "[]") as Inventory,
    mappings: JSON.parse(build.mappings_json) as EditionMapping[],
    canonicalBases: JSON.parse(build.bases_json) as EditionManifestServerSide["canonicalBases"],
    ...(repo ? { editionRepo: repo } : {}),
    allowedAssetNamespaces: [],
    contractVersions: {},
    protectedPaths: JSON.parse(build.protected_json) as string[],
  } as EditionManifestServerSide;
}

export interface ReturnPreview {
  allowed: MappedChange[];
  blocked: BlockedChange[];
  unchanged: number;
  omitted: number;
  unknownDeletions: string[];
  ignored: string[];
  strippedFolder: string | null;
}

/** Core diff + mapping of a return, exactly as the runner will compute it (AT-29, AT-28). */
export async function previewReturn(
  manifest: EditionManifestServerSide,
  entries: Array<{ path: string; data: Uint8Array }>,
  mode: "full" | "partial",
  deletions: string[],
  targetResourceId: string,
): Promise<{ allowed: MappedChange[]; blocked: BlockedChange[]; unchanged: number; omitted: number; unknownDeletions: string[] }> {
  const returned = [];
  for (const e of entries) returned.push({ path: e.path, sha256: await sha256Hex(e.data) });
  let delta;
  try {
    delta = diffAgainstInventory(manifest.inventory, returned, mode, deletions);
  } catch (e) {
    if (e instanceof CoreError) throw Object.assign(new Error(e.message), { code: "invalid_edition_return" });
    throw e;
  }
  const mapped = mapEditionDelta(delta, manifest);
  const allowed = mapped.allowed.filter((a) => a.resourceId === targetResourceId);
  const blocked = [...mapped.blocked, ...mapped.allowed.filter((a) => a.resourceId !== targetResourceId).map((a) => ({ path: a.editionPath, reason: "not_mapped" as const }))].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return { allowed, blocked, unchanged: delta.unchanged.length, omitted: delta.omitted.length, unknownDeletions: delta.unknownDeletions };
}

// =============================================================================================
// Return: fresh task repo → edition-return job → freeze → proposal
// =============================================================================================

/**
 * Queue step `edition.return`: create the empty `-tasks` repo the runner pushes the candidate to
 * (its `main` must not exist: the job leases it absent), record the workspace in the ledger, then
 * issue the `edition-return` job.
 */
onStep("edition.return", async (svc, msg) => {
  const ret = await getReturn(svc, msg.returnId);
  if (!ret || ret.state !== "queued" || ret.job_id) return { done: true };
  const out = await svc.gate.withLock("workspace", ret.task_workspace_id, EDITION_LOCK_MS, async () => {
    const again = await getReturn(svc, ret.return_id);
    if (!again || again.state !== "queued" || again.job_id) return;
    const edition = await getEdition(svc, ret.org_id, ret.edition_id);
    const build = await getBuild(svc, ret.build_id);
    const resource = await getResource(svc.db, ret.org_id, ret.resource_id);
    if (!edition || !build || !resource) throw new Error("edition, build or resource is gone");
    // AT-30: re-check right before the job (the runner checks the ledger head once more)
    const head = await svc.ledger(ret.org_id).getHead(ret.resource_id);
    if (head?.revisionId !== ret.expected_head) {
      await failReturn(svc, again, "stale", "stale_base", "the target moved since the edition was built");
      return;
    }
    const handle = await ensureFreshTaskRepo(svc, {
      orgId: ret.org_id,
      taskWorkspaceId: ret.task_workspace_id,
      resourceId: ret.resource_id,
      baseRevision: ret.expected_head,
      description: `commonforge edition return ${ret.return_id} resource ${ret.resource_id}`,
    });
    const canonical = await liveCanonical(svc, ret.org_id, ret.resource_id);
    const job = await issueJob(
      svc,
      {
        kind: "edition-return",
        edition: manifestOf(edition, build),
        upload: { r2Key: ret.r2_key, mode: ret.mode, ...(JSON.parse(ret.deletions_json).length ? { deletions: JSON.parse(ret.deletions_json) as string[] } : {}) },
        target: { resourceId: ret.resource_id, canonical, expectedHead: ret.expected_head },
        candidateFork: { taskWorkspaceId: handle.taskWorkspaceId, coords: handle.coords },
      } as IntegrationJobInput,
      { orgId: ret.org_id, subject: `edition-return:${ret.return_id}`, lifetimeSeconds: 3600 },
    );
    await updateReturn(svc, ret.return_id, { state: "running", job_id: job.jobId }, ["queued"]);
  });
  if (out.locked) return { retry: true, delaySeconds: 5, reason: "another step is provisioning this workspace" };
  return { done: true };
});

onStepFailed("edition.return", async (svc, msg, reason) => {
  const ret = await getReturn(svc, msg.returnId);
  if (!ret || (ret.state !== "queued" && ret.state !== "running")) return;
  await failReturn(svc, ret, "failed", "provider_unavailable", reason);
});

/** A return that will never produce a candidate: its workspace is abandoned (GC deletes the repo). */
async function failReturn(svc: Services, ret: ReturnRow, state: ReturnState, code: string, detail: string): Promise<void> {
  if (!(await updateReturn(svc, ret.return_id, { state, error_code: code, error: detail.slice(0, 2000) }, ["queued", "running", "freezing"]))) return;
  await abandonReturnWorkspace(svc, ret, code === "no_changes" ? "canceled" : "failed");
  await recordEvent(svc, {
    orgId: ret.org_id,
    projectId: ret.project_id,
    actor: { kind: "runner", id: "integration-runner" } as never,
    action: state === "no_changes" ? "edition.return_empty" : "edition.return_failed",
    subjectKind: "edition",
    subjectId: ret.edition_id,
    resourceIds: [ret.resource_id],
    detail: { returnId: ret.return_id, code, detail: detail.slice(0, 1000) },
    clientVisible: true,
    clientDetail: { returnId: ret.return_id, code },
  });
}

async function abandonReturnWorkspace(svc: Services, ret: ReturnRow, taskState: "failed" | "canceled"): Promise<void> {
  const ws = await getWorkspaceRow(svc, ret.task_workspace_id);
  const ledger = svc.ledger(ret.org_id);
  const handle = await ledger.getWorkspace(ret.task_workspace_id);
  if (handle && handle.state !== "abandoned" && handle.state !== "collected" && handle.state !== "frozen") await ledger.putWorkspace(ret.org_id, { ...handle, state: "abandoned" });
  if (ws && ws.state !== "frozen" && ws.state !== "collected") await setWorkspaceState(svc, ws.task_workspace_id, "abandoned");
  await setTaskState(svc, ret.task_id, taskState);
}

/** Map a runner failure code to the return's state (what the client is told). */
function failureState(code: string): ReturnState {
  if (code === "stale_base") return "stale";
  if (code === "textual_conflict") return "conflict";
  if (code === "scope_violation") return "refused";
  return "failed";
}

onRunnerResult("edition-return", async (svc, row: RunnerJobRow, job, result) => {
  if (job.kind !== "edition-return") return;
  const ret = await svc.db.prepare("SELECT * FROM edition_returns WHERE job_id = ?").bind(row.job_id).first<ReturnRow>();
  if (!ret) return;
  if (!result.ok) {
    await failReturn(svc, ret, failureState(result.code), result.code, result.detail);
    return;
  }
  const receipt = result.receipt as EditionReturnReceipt;
  // the receipt must answer this return (parseRunnerResultForJob already bound it to the job)
  if (receipt.resourceId !== ret.resource_id || receipt.expectedHead !== ret.expected_head) {
    await failReturn(svc, ret, "failed", "receipt_mismatch", "the runner receipt does not match this return");
    return;
  }
  await updateReturn(svc, ret.return_id, { receipt_json: JSON.stringify(receipt) });
  if (!receipt.candidate) {
    await failReturn(svc, ret, "no_changes", "no_changes", "no allowed change differs from the edition");
    return;
  }
  await updateReturn(svc, ret.return_id, { state: "freezing" }, ["running"]);
  await enqueueStep(svc, { type: "edition.candidate", orgId: ret.org_id, returnId: ret.return_id });
});

/**
 * Queue step `edition.candidate`: freeze the runner's candidate exactly like an agent's
 * (`freezeCandidate`: HEAD check, write tokens revoked, changed paths computed server-side), then
 * open the proposal and prepare the candidate. Idempotent per return.
 */
onStep("edition.candidate", async (svc, msg) => {
  const ret = await getReturn(svc, msg.returnId);
  if (!ret || ret.state !== "freezing" || !ret.receipt_json) return { done: true };
  const receipt = JSON.parse(ret.receipt_json) as EditionReturnReceipt;
  if (!receipt.candidate) return { done: true };
  const task = await getTask(svc, ret.task_id);
  const ws = await getWorkspaceRow(svc, ret.task_workspace_id);
  if (!task || !ws) return { done: true };
  const ledger = svc.ledger(ret.org_id);
  const candidateId = toCandidateId(ret.task_workspace_id, receipt.candidate.sha);
  let rec = await ledger.getCandidate(candidateId);
  if (!rec) {
    if (ws.state === "writable") await setWorkspaceState(svc, ws.task_workspace_id, "freezing", { from: "writable" });
    const handle = await ledger.getWorkspace(ws.task_workspace_id);
    if (!handle) throw new Error("edition return workspace is not recorded in the ledger");
    let candidate;
    try {
      candidate = await svc.provider().freezeCandidate({ ...handle, state: "writable" }, { expectedSha: receipt.candidate.sha, submitter: userRef(ret.user_id), tool: ret.tool ?? "edition-zip" });
    } catch (e) {
      await setWorkspaceState(svc, ws.task_workspace_id, "writable", { from: "freezing" });
      throw e;
    }
    const now = svc.nowIso();
    await ledger.putCandidate(ret.org_id, { candidate, state: "frozen", preparedReceiptId: null, updatedAt: now });
    await ledger.putWorkspace(ret.org_id, { ...handle, state: "frozen" });
    await setWorkspaceState(svc, ws.task_workspace_id, "frozen");
    await svc.db
      .prepare("INSERT OR IGNORE INTO task_candidates (candidate_id, task_id, org_id, resource_id, task_workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(candidate.candidateId, task.task_id, task.org_id, candidate.resourceId, ws.task_workspace_id, now)
      .run();
    await setTaskState(svc, task.task_id, "submitted");
    await recordEvent(svc, { orgId: ret.org_id, projectId: ret.project_id, actor: userRef(ret.user_id), action: "task.candidate_frozen", subjectKind: "candidate", subjectId: candidate.candidateId, resourceIds: [candidate.resourceId], detail: { taskId: task.task_id, sha: candidate.sha, changedPaths: candidate.changedPaths.length, editionId: ret.edition_id } });
    rec = (await ledger.getCandidate(candidateId))!;
  }
  // the proposal (once per return)
  // deterministic per return, so a retried step finds the proposal it already opened
  const proposalId = `prop-ed-${(await sha256Hex(`cf.edition-return-proposal/1|${ret.return_id}`)).slice(0, 32)}`;
  if (!(await ledger.getProposal(proposalId))) {
    const built = await buildProposal(svc, (await getTask(svc, task.task_id))!, proposalId, [rec], []);
    await ledger.putProposal(built.record);
    await svc.db
      .prepare("INSERT OR IGNORE INTO proposals_index (proposal_id, org_id, project_id, task_id, base_snapshot_json, candidate_snapshot_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(proposalId, ret.org_id, ret.project_id, task.task_id, JSON.stringify(built.baseSnapshot), JSON.stringify(built.candidateSnapshot), ret.user_id, svc.nowIso())
      .run();
    await recordEvent(svc, {
      orgId: ret.org_id,
      projectId: ret.project_id,
      actor: userRef(ret.user_id),
      action: "proposal.created",
      subjectKind: "proposal",
      subjectId: proposalId,
      resourceIds: proposalResourceIds(built.record),
      detail: { proposalHash: built.record.proposalHash, changeId: task.change_id, editionId: ret.edition_id, returnId: ret.return_id },
      clientVisible: true,
      clientDetail: { proposalHash: built.record.proposalHash, returnId: ret.return_id },
    });
  }
  if (rec.state === "frozen") await enqueueStep(svc, { type: "candidate.prepare", orgId: ret.org_id, candidateId: rec.candidate.candidateId });
  await updateReturn(svc, ret.return_id, { state: "proposed", proposal_id: proposalId }, ["freezing"]);
  return { done: true };
});

onStepFailed("edition.candidate", async (svc, msg, reason) => {
  const ret = await getReturn(svc, msg.returnId);
  if (!ret || ret.state !== "freezing") return;
  await failReturn(svc, ret, "failed", "freeze_failed", reason);
});

/** Everything a project's editions need from the project row (for the snapshot). */
export async function requireProject(svc: Services, orgId: string, projectId: string) {
  const project = await getProject(svc.db, orgId, projectId);
  if (!project) throw conflict("project_missing", "project not found");
  return project;
}

// =============================================================================================
// Edition access and the edition-scoped view of a proposal (review I-1)
// =============================================================================================

/**
 * "use" of an edition: the owner, or a client/developer holding a live edition grant. Viewers never
 * (review M-7): a demoted grant holder loses use at once, whatever the grant table still says.
 */
export async function editionUse(svc: Services, actor: { orgId: string; userId: string; role: Role }, editionId: string): Promise<boolean> {
  if (actor.role === "viewer") return false;
  if (actor.role === "owner") return true;
  return !!(await svc.db.prepare("SELECT 1 AS x FROM edition_grants WHERE edition_id = ? AND user_id = ? AND org_id = ?").bind(editionId, actor.userId, actor.orgId).first());
}

/**
 * The edition a proposal came from, seen through the edition: which canonical paths a client may
 * be shown, and as which edition paths. A path is in scope when it maps into the edition and is
 * either published (in the build's inventory) or was added by this return itself. Everything else
 * (unpublished names included) is never shown to an edition-only client.
 */
export interface EditionScope {
  editionId: string;
  name: string;
  returnUserId: string;
  toEditionPath(resourceId: string, canonicalPath: string): string | null;
}

export function scopeOf(edition: EditionRow, build: BuildRow, ret: ReturnRow): EditionScope {
  const mappings = JSON.parse(build.mappings_json) as EditionMapping[];
  // re-review m-1: published paths plus the paths this very return added; never any other name
  const inventory = new Set(inventoryPaths(build));
  const own = (ret.receipt_json ? (JSON.parse(ret.receipt_json) as EditionReturnReceipt).allowed : (JSON.parse(ret.preview_json) as { allowed: MappedChange[] }).allowed) ?? [];
  for (const a of own) inventory.add(a.editionPath);
  const returnUserId = ret.user_id;
  return {
    editionId: edition.edition_id,
    name: edition.name,
    returnUserId,
    toEditionPath(resourceId, canonicalPath) {
      const p = checkPath(canonicalPath);
      if (!p.ok) return null;
      let best: EditionMapping | undefined;
      for (const m of mappings) {
        if (m.resourceId !== resourceId || !isWithinPrefix(p.path, m.canonicalPathPrefix)) continue;
        if (!best || m.canonicalPathPrefix.length > best.canonicalPathPrefix.length) best = m;
      }
      if (!best) return null;
      const rest = best.canonicalPathPrefix === "" ? p.path : p.path.slice(best.canonicalPathPrefix.length).replace(/^\//, "");
      const ep = [best.editionPathPrefix, rest].filter(Boolean).join("/");
      return inventory.has(ep) ? ep : null;
    },
  };
}

function inventoryPaths(b: BuildRow): string[] {
  return b.inventory_json ? (JSON.parse(b.inventory_json) as Inventory).map((i) => i.editionPath) : [];
}

/** The edition scope of a proposal for this actor, or null (not an edition proposal, or no use of it). */
export async function editionScopeForProposal(svc: Services, actor: { orgId: string; userId: string; role: Role }, proposalId: string): Promise<EditionScope | null> {
  const ret = await svc.db.prepare("SELECT * FROM edition_returns WHERE org_id = ? AND proposal_id = ? LIMIT 1").bind(actor.orgId, proposalId).first<ReturnRow>();
  if (!ret || !(await editionUse(svc, actor, ret.edition_id))) return null;
  const edition = await getEdition(svc, actor.orgId, ret.edition_id);
  const build = await getBuild(svc, ret.build_id);
  return edition && build ? scopeOf(edition, build, ret) : null;
}

/** Revoke a user's edition read tokens (one edition, or all of the org's). */
export async function revokeEditionTokens(svc: Services, orgId: string, userId: string, editionId?: string): Promise<void> {
  const rows = await svc.db
    .prepare(`SELECT edition_id, token_id FROM edition_tokens WHERE org_id = ? AND user_id = ? AND expires_at > ?${editionId ? " AND edition_id = ?" : ""}`)
    .bind(orgId, userId, svc.now().getTime(), ...(editionId ? [editionId] : []))
    .all<{ edition_id: string; token_id: string }>();
  for (const t of rows.results) {
    const e = await getEdition(svc, orgId, t.edition_id);
    const repo = e ? editionRepo(e) : null;
    if (repo) await svc.transport.revokeToken(repo.namespace, repo.repoName, t.token_id).catch(() => false);
  }
  await svc.db.prepare(`DELETE FROM edition_tokens WHERE org_id = ? AND user_id = ?${editionId ? " AND edition_id = ?" : ""}`).bind(orgId, userId, ...(editionId ? [editionId] : [])).run();
}

/** Every token minted on an edition repo (a policy change stops serving the old build, M-5). */
export async function revokeAllEditionTokens(svc: Services, edition: EditionRow): Promise<void> {
  const repo = editionRepo(edition);
  if (repo) {
    for (const t of await svc.transport.listTokens(repo.namespace, repo.repoName).catch(() => [])) {
      if (t.state === "active") await svc.transport.revokeToken(repo.namespace, repo.repoName, t.id).catch(() => false);
    }
  }
  await svc.db.prepare("DELETE FROM edition_tokens WHERE edition_id = ?").bind(edition.edition_id).run();
}

/** The member's edition grants on one project's editions (edition ids). */
export async function projectEditionGrantIds(svc: Services, orgId: string, userId: string, projectId: string): Promise<string[]> {
  const rows = await svc.db
    .prepare("SELECT g.edition_id FROM edition_grants g JOIN editions e ON e.edition_id = g.edition_id AND e.org_id = g.org_id WHERE g.org_id = ? AND g.user_id = ? AND e.project_id = ? ORDER BY g.edition_id")
    .bind(orgId, userId, projectId)
    .all<{ edition_id: string }>();
  return rows.results.map((r) => r.edition_id);
}

/**
 * Project access set to none (admin screens §5) ends the member's grants on that project's editions:
 * the statement, so it joins the access change's one batch. Then call `revokeProjectEditionTokens`.
 */
export function projectEditionGrantsDelete(db: D1Database, orgId: string, userId: string, projectId: string): D1PreparedStatement {
  return db
    .prepare("DELETE FROM edition_grants WHERE org_id = ? AND user_id = ? AND edition_id IN (SELECT edition_id FROM editions WHERE org_id = ? AND project_id = ?)")
    .bind(orgId, userId, orgId, projectId);
}

/** Revoke the member's edition read tokens on one project's editions (as `revokeEditionTokens`, per edition). */
export async function revokeProjectEditionTokens(svc: Services, orgId: string, userId: string, projectId: string): Promise<void> {
  const rows = await svc.db
    .prepare("SELECT DISTINCT t.edition_id FROM edition_tokens t JOIN editions e ON e.edition_id = t.edition_id AND e.org_id = t.org_id WHERE t.org_id = ? AND t.user_id = ? AND e.project_id = ?")
    .bind(orgId, userId, projectId)
    .all<{ edition_id: string }>();
  for (const r of rows.results) await revokeEditionTokens(svc, orgId, userId, r.edition_id);
}

/** Removal, or demotion to viewer, ends every edition grant of the member and revokes their tokens (M-7). */
export async function revokeEditionAccess(svc: Services, orgId: string, userId: string): Promise<void> {
  await revokeEditionTokens(svc, orgId, userId);
  await svc.db.prepare("DELETE FROM edition_grants WHERE org_id = ? AND user_id = ?").bind(orgId, userId).run();
}
