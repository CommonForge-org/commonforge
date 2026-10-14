/**
 * Client Workspace Editions (Task 21; PRD §4.5, FR-16..FR-18; plan §B.13, §C.1 row 9; API.md
 * "Editions"). Policy and builds are developer actions; sessions, download, read credential and
 * returns are the client's "Start an update". Clients never receive canonical coordinates, tasks,
 * job ids or raw revision ids here (AT-25/AT-26, O-1); the edition repo is the only repository a
 * client can get a token for, and only a read token.
 */
import { sha256Hex, type MappedChange, type BlockedChange, type EditionReturnReceipt } from "@commonforge-org/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Services } from "../context.js";
import { newId } from "../lib/crypto.js";
import { ApiError, badRequest, conflict, forbidden, notFound, readJson } from "../lib/http.js";
import { readReturnZip, RETURN_ZIP_LIMITS, writeZip, ZipRefused } from "../lib/zip.js";
import { canReadProject, canReadResource, canWriteResource, isDeveloper, orgActor, readableProject, type OrgActor } from "../middleware/authz.js";
import { getMount, getResource, getRole, type ProjectRow } from "../services/directory.js";
import {
  EditionPolicySchema,
  editionPolicy,
  editionPrefixOf,
  editionRepo,
  getBuild,
  getEdition,
  getReturn,
  getSession,
  liveRelease,
  manifestOf,
  requireProject,
  revokeAllEditionTokens,
  revokeEditionTokens as revokeUserEditionTokens,
  mappingsFor,
  previewReturn,
  protectedEditionPaths,
  type BuildRow,
  type EditionPolicy,
  type EditionRow,
  type Inventory,
  type ReturnRow,
  type SessionRow,
} from "../services/editions.js";
import { recordEvent, userRef } from "../services/events.js";
import { isStagingProject } from "../services/staging-state.js";
import { getJob } from "../services/runner-jobs.js";
import { projectSnapshot } from "../services/snapshot.js";
import { enqueueStep } from "../services/steps.js";
import { newChangeId, taskWorkspaceIdFor } from "../services/tasks.js";

export const editionsRoutes = new Hono<AppEnv>();

/** Returned ZIPs are small source trees (media goes through R2 asset tasks). */
export const MAX_RETURN_BYTES = 32 * 1024 * 1024;
export const MAX_EDITION_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_EDITION_TOKEN_SECONDS = 86_400;

// ------------------------------------------------------------------------------------- access

interface Access {
  edition: EditionRow;
  policy: EditionPolicy;
  actor: OrgActor;
  /** owner, or a developer who can read the project and every source (developer view) */
  developer: boolean;
  /** may change policy, build and grant: owner, or a developer with write on every source */
  manage: boolean;
  /** may start edit sessions: owner, or an edition grant holder */
  use: boolean;
}

async function sourceResourceIds(svc: Services, e: EditionRow, policy: EditionPolicy): Promise<Map<string, string> | null> {
  const out = new Map<string, string>();
  for (const s of policy.sources) {
    const m = await getMount(svc.db, e.org_id, e.project_id, s.mountName);
    if (!m) return null;
    out.set(s.mountName, m.resource_id);
  }
  return out;
}

async function hasEditionGrant(svc: Services, editionId: string, userId: string): Promise<boolean> {
  return !!(await svc.db.prepare("SELECT 1 AS x FROM edition_grants WHERE edition_id = ? AND user_id = ?").bind(editionId, userId).first());
}

async function accessFor(svc: Services, actor: OrgActor, edition: EditionRow): Promise<Access | null> {
  const policy = editionPolicy(edition);
  const granted = await hasEditionGrant(svc, edition.edition_id, actor.userId);
  let developer = actor.role === "owner";
  let manage = actor.role === "owner";
  if (!developer && isDeveloper(actor.role) && (await canReadProject(svc, actor, edition.project_id))) {
    const ids = await sourceResourceIds(svc, edition, policy);
    if (ids) {
      developer = true;
      manage = true;
      for (const rid of ids.values()) {
        if (!(await canReadResource(svc, actor, rid))) developer = manage = false;
        else if (!(await canWriteResource(svc, actor, rid))) manage = false;
      }
    }
  }
  // review M-7: viewers never use an edition, whatever the grant table says
  const use = actor.role !== "viewer" && (actor.role === "owner" || granted);
  if (!developer && !use) return null;
  return { edition, policy, actor, developer, manage, use };
}

/** The edition if the caller may see it (404 otherwise: no existence leak). */
async function loadEdition(c: Context<AppEnv>, need: "view" | "manage" | "use" = "view"): Promise<Access> {
  const actor = await orgActor(c, c.req.param("org")!);
  const svc = c.get("svc");
  const edition = await getEdition(svc, actor.orgId, c.req.param("eid")!);
  const access = edition ? await accessFor(svc, actor, edition) : null;
  if (!access) throw notFound("edition not found");
  if (need === "manage" && !access.manage) throw forbidden(access.developer ? "no_write_grant" : "insufficient_role", "configuring an edition needs write on every source resource");
  if (need === "use" && !access.use) throw forbidden("no_edition_grant", "you have no grant on this edition");
  return access;
}

/** A session: its own user (still holding edition access), or a developer view for managers. */
async function loadSession(c: Context<AppEnv>): Promise<{ access: Access; session: SessionRow; own: boolean }> {
  const actor = await orgActor(c, c.req.param("org")!);
  const svc = c.get("svc");
  const session = await getSession(svc, actor.orgId, c.req.param("sid")!);
  const edition = session ? await getEdition(svc, actor.orgId, session.edition_id) : null;
  const access = edition ? await accessFor(svc, actor, edition) : null;
  if (!session || !access) throw notFound("session not found");
  const own = session.user_id === actor.userId && access.use;
  if (!own && !access.developer) throw notFound("session not found");
  return { access, session, own };
}

// ------------------------------------------------------------------------------------- views

function inventoryOf(b: BuildRow | null): Inventory {
  return b?.inventory_json ? (JSON.parse(b.inventory_json) as Inventory) : [];
}

function presentBuild(b: BuildRow) {
  const snapshot = JSON.parse(b.snapshot_json) as { snapshotId: string };
  return {
    buildId: b.build_id,
    state: b.state,
    policyRevision: b.policy_revision,
    // AT-30: the live release (release service live pointer) when the build was made; null if nothing is live
    sourceReleaseId: b.source_release_id,
    canonicalBases: JSON.parse(b.bases_json) as unknown,
    exportedSnapshotId: snapshot.snapshotId,
    commit: b.sha,
    files: inventoryOf(b).length,
    ...(b.error ? { error: b.error } : {}),
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

async function presentEdition(svc: Services, a: Access) {
  const e = a.edition;
  const current = e.current_build_id ? await getBuild(svc, e.current_build_id) : null;
  const inv = inventoryOf(current);
  const writable = a.policy.sources.find((s) => s.write.length > 0);
  const editable = writable ? writable.write.map((w) => [editionPrefixOf(a.policy.sources.length, writable), w].filter(Boolean).join("/")) : [];
  const base = {
    editionId: e.edition_id,
    projectId: e.project_id,
    name: e.name,
    state: e.state,
    ready: !!current && current.state === "ready",
    policyRevision: e.policy_revision,
    files: inv.length,
    // what a return may change (edition paths; "" = everything) and what it never may
    editable,
    protected: protectedEditionPaths(a.policy),
    readOnly: !writable,
    builtAt: current?.updated_at ?? null,
    canStartUpdate: a.use && !!current && !readOnlyPolicy(a.policy),
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
  if (!a.developer) return base;
  const builds = (await svc.db.prepare("SELECT * FROM edition_builds WHERE edition_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20").bind(e.edition_id).all<BuildRow>()).results;
  const repo = editionRepo(e);
  return {
    ...base,
    policy: a.policy,
    canManage: a.manage,
    currentBuildId: e.current_build_id,
    // the edition's own repository (never a canonical one)
    repo: repo ? { namespace: repo.namespace, repoName: repo.repoName, remoteUrl: repo.remoteUrl } : null,
    builds: builds.map(presentBuild),
    createdBy: e.created_by,
  };
}

/** The ZIP's base name, which is the folder it unpacks to ("compress this folder" wraps it). */
export function downloadRoot(edition: EditionRow, session: SessionRow): string {
  const slug = edition.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "edition";
  return `${slug}-${session.session_id}`;
}

const readOnlyPolicy = (p: EditionPolicy) => !p.sources.some((s) => s.write.length > 0);

const CLIENT_ERROR: Record<string, string> = {
  stale_base: "The live application changed since this working copy was made. Start a new update to get the current version.",
  textual_conflict: "Some files you changed were also changed in the application meanwhile. Start a new update and apply your edits again.",
  scope_violation: "The upload was refused: it contains files or changes that this working copy does not allow.",
  no_changes: "Nothing in the upload differs from the working copy in a place you may change.",
  provider_unavailable: "The service could not process the upload. Try again.",
  job_expired: "The upload was not processed in time. Try again.",
  freeze_failed: "The update could not be recorded. Try again.",
  receipt_mismatch: "The update could not be recorded. Try again.",
};

/** A client sees edition paths only; developers also see canonical paths, the task and the job. */
function presentReturn(r: ReturnRow, developer: boolean) {
  const preview = JSON.parse(r.preview_json) as { allowed: MappedChange[]; blocked: BlockedChange[]; ignored: string[]; strippedFolder: string | null; unchanged: number; omitted: number; unknownDeletions: string[] };
  const receipt = r.receipt_json ? (JSON.parse(r.receipt_json) as EditionReturnReceipt) : null;
  const allowed = receipt?.allowed ?? preview.allowed;
  const blocked = receipt?.blocked ?? preview.blocked;
  return {
    returnId: r.return_id,
    sessionId: r.session_id,
    editionId: r.edition_id,
    state: r.state,
    mode: r.mode,
    deletions: JSON.parse(r.deletions_json) as string[],
    changes: allowed.map((a) => ({ path: a.editionPath, kind: a.kind, ...(a.oldEditionPath ? { oldPath: a.oldEditionPath } : {}), ...(developer ? { canonicalPath: a.canonicalPath } : {}) })),
    blocked,
    unchanged: preview.unchanged,
    // partial returns: files left out are kept as they are, never deleted (AT-29)
    keptAsIs: preview.omitted,
    unknownDeletions: preview.unknownDeletions,
    ignored: preview.ignored,
    strippedFolder: preview.strippedFolder,
    proposalId: r.proposal_id,
    tool: r.tool,
    ...(r.error_code ? { error: { code: r.error_code, message: CLIENT_ERROR[r.error_code] ?? "The update could not be processed.", ...(developer && r.error ? { detail: r.error } : {}) } } : {}),
    ...(developer ? { taskId: r.task_id, taskWorkspaceId: r.task_workspace_id, jobId: r.job_id, resourceId: r.resource_id, size: r.size, sha256: r.sha256 } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** A return whose job the GC closed (expired without a result) is reported as failed. */
async function settle(svc: Services, r: ReturnRow): Promise<ReturnRow> {
  if (r.state !== "running" || !r.job_id) return r;
  const job = await getJob(svc, r.job_id);
  if (!job || job.status !== "failed" || !job.result_json) return r;
  const result = JSON.parse(job.result_json) as { code?: string; detail?: string };
  if (result.code !== "job_expired") return r;
  await svc.db.prepare("UPDATE edition_returns SET state = 'failed', error_code = 'job_expired', error = ?, updated_at = ? WHERE return_id = ? AND state = 'running'").bind(result.detail ?? "expired", svc.nowIso(), r.return_id).run();
  return (await getReturn(svc, r.return_id))!;
}

async function presentSession(svc: Services, s: SessionRow, a: Access, developer: boolean) {
  const build = await getBuild(svc, s.build_id);
  const rows = (await svc.db.prepare("SELECT * FROM edition_returns WHERE session_id = ? ORDER BY created_at DESC, rowid DESC").bind(s.session_id).all<ReturnRow>()).results;
  const returns = [];
  for (const r of rows) returns.push(presentReturn(await settle(svc, r), developer));
  const target = targetOf(a, build);
  const head = target ? await svc.ledger(s.org_id).getHead(target.resourceId) : null;
  return {
    sessionId: s.session_id,
    editionId: s.edition_id,
    editionName: a.edition.name,
    projectId: s.project_id,
    title: s.title,
    request: s.request,
    state: s.state,
    files: inventoryOf(build).length,
    // the application moved since this working copy was made: a return would be refused (AT-30)
    stale: !!target && head?.revisionId !== target.base,
    policyChanged: !!build && build.policy_revision !== a.edition.policy_revision,
    downloadUrl: `/api/orgs/${s.org_id}/edition-sessions/${s.session_id}/download`,
    // the folder the ZIP unpacks to; a returned ZIP wrapped in exactly this folder is unwrapped
    downloadRoot: downloadRoot(a.edition, s),
    returnUrl: `/api/orgs/${s.org_id}/edition-sessions/${s.session_id}/returns`,
    returns,
    ...(developer ? { buildId: s.build_id, userId: s.user_id } : {}),
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

/** The writable source of a build: resource, mount and canonical base. */
function targetOf(a: Access, build: BuildRow | null): { mountName: string; resourceId: string; base: string } | null {
  if (!build) return null;
  const src = a.policy.sources.find((s) => s.write.length > 0);
  if (!src) return null;
  const snap = JSON.parse(build.snapshot_json) as { entries: Array<{ mountName: string; resourceId: string }> };
  const entry = snap.entries.find((e) => e.mountName === src.mountName);
  const base = entry ? (JSON.parse(build.bases_json) as Array<{ resourceId: string; revisionId: string }>).find((b) => b.resourceId === entry.resourceId) : undefined;
  return entry && base ? { mountName: src.mountName, resourceId: entry.resourceId, base: base.revisionId } : null;
}

// --------------------------------------------------------------------------- policy (developer)

const EditionBodySchema = z.object({ name: z.string().trim().min(1).max(120) }).and(EditionPolicySchema);

async function checkSources(svc: Services, actor: OrgActor, project: ProjectRow, policy: EditionPolicy): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const s of policy.sources) {
    const m = await getMount(svc.db, actor.orgId, project.project_id, s.mountName);
    const r = m ? await getResource(svc.db, actor.orgId, m.resource_id) : null;
    if (!m || !r || !(await canReadResource(svc, actor, r.resource_id))) throw notFound(`mount ${s.mountName} not found`);
    if (r.provider !== "artifacts") throw badRequest("not_git", `mount ${s.mountName} is an asset collection; editions publish source repositories`);
    if (!(await canWriteResource(svc, actor, r.resource_id))) throw forbidden("no_write_grant", `publishing ${s.mountName} needs a write grant on it`);
    ids.set(s.mountName, r.resource_id);
  }
  return ids;
}

editionsRoutes.post("/orgs/:org/projects/:pid/editions", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  await refuseInStagingMode(svc, project);
  const body = await readJson(c, EditionBodySchema);
  const { name, ...rest } = body;
  const policy = EditionPolicySchema.parse(rest);
  const ids = await checkSources(svc, actor, project, policy);
  const editionId = newId("edn", 8);
  const now = svc.nowIso();
  await svc.db
    .prepare("INSERT INTO editions (edition_id, org_id, project_id, name, policy_json, policy_revision, state, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?)")
    .bind(editionId, actor.orgId, project.project_id, name, JSON.stringify(policy), actor.userId, now, now)
    .run();
  await recordEvent(svc, { orgId: actor.orgId, projectId: project.project_id, actor: userRef(actor.userId), action: "edition.created", subjectKind: "edition", subjectId: editionId, resourceIds: [...ids.values()], detail: { name, policyRevision: 1 } });
  const edition = (await getEdition(svc, actor.orgId, editionId))!;
  return c.json(await presentEdition(svc, (await accessFor(svc, actor, edition))!), 201);
});

editionsRoutes.put("/orgs/:org/editions/:eid/policy", async (c) => {
  const a = await loadEdition(c, "manage");
  const svc = c.get("svc");
  const body = await readJson(c, z.object({ name: z.string().trim().min(1).max(120).optional() }).and(EditionPolicySchema));
  const { name, ...rest } = body;
  const policy = EditionPolicySchema.parse(rest);
  const project = await readableProject(svc, a.actor, a.edition.project_id);
  const ids = await checkSources(svc, a.actor, project, policy);
  await svc.db
    // review M-5: the old build is no longer offered (sessions, downloads, clones) until a rebuild
    .prepare("UPDATE editions SET name = ?, policy_json = ?, policy_revision = policy_revision + 1, current_build_id = NULL, state = 'draft', updated_at = ? WHERE edition_id = ?")
    .bind(name ?? a.edition.name, JSON.stringify(policy), svc.nowIso(), a.edition.edition_id)
    .run();
  const edition = (await getEdition(svc, a.actor.orgId, a.edition.edition_id))!;
  await revokeAllEditionTokens(svc, edition);
  await recordEvent(svc, { orgId: a.actor.orgId, projectId: edition.project_id, actor: userRef(a.actor.userId), action: "edition.policy_changed", subjectKind: "edition", subjectId: edition.edition_id, resourceIds: [...ids.values()], detail: { policyRevision: edition.policy_revision } });
  return c.json(await presentEdition(svc, (await accessFor(svc, a.actor, edition))!));
});

/**
 * Publish a build: the sources at their current accepted heads (or, once releases exist, the live
 * release, Task 22) → runner `build-edition` → one fresh commit in the edition repo.
 */
editionsRoutes.post("/orgs/:org/editions/:eid/builds", async (c) => {
  const a = await loadEdition(c, "manage");
  const svc = c.get("svc");
  const project = await readableProject(svc, a.actor, a.edition.project_id);
  const ids = await checkSources(svc, a.actor, project, a.policy);
  const snapshot = await projectSnapshot(svc, project, { onlyMounts: new Set(a.policy.sources.map((s) => s.mountName)) });
  const bases: Array<{ resourceId: string; revisionId: string }> = [];
  for (const s of a.policy.sources) {
    const e = snapshot.entries.find((x) => x.mountName === s.mountName);
    if (!e || !e.revisionId.startsWith("art:")) throw conflict("no_accepted_head", `mount ${s.mountName} has no accepted version`);
    bases.push({ resourceId: e.resourceId, revisionId: e.revisionId });
  }
  const release = await liveRelease(svc, a.actor.orgId, project.project_id);
  const buildId = newId("edb", 8);
  const now = svc.nowIso();
  await svc.db
    .prepare(
      "INSERT INTO edition_builds (build_id, edition_id, org_id, policy_revision, policy_json, state, source_release_id, snapshot_json, bases_json, mappings_json, protected_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    // returns may never touch excluded paths either (review M-3): they are protected for the build
    .bind(buildId, a.edition.edition_id, a.actor.orgId, a.edition.policy_revision, JSON.stringify(a.policy), release?.releaseId ?? null, JSON.stringify(snapshot), JSON.stringify(bases), JSON.stringify(mappingsFor(a.policy, ids)), JSON.stringify([...new Set([...a.policy.protectedPaths, ...a.policy.exclude])]), a.actor.userId, now, now)
    .run();
  await svc.db.prepare("UPDATE editions SET state = CASE WHEN current_build_id IS NULL THEN 'building' ELSE state END, updated_at = ? WHERE edition_id = ?").bind(now, a.edition.edition_id).run();
  await enqueueStep(svc, { type: "edition.build", orgId: a.actor.orgId, buildId });
  await recordEvent(svc, { orgId: a.actor.orgId, projectId: project.project_id, actor: userRef(a.actor.userId), action: "edition.build_requested", subjectKind: "edition", subjectId: a.edition.edition_id, resourceIds: [...ids.values()], detail: { buildId, policyRevision: a.edition.policy_revision, sourceReleaseId: release?.releaseId ?? null } });
  return c.json({ editionId: a.edition.edition_id, buildId, state: "queued", sourceReleaseId: release?.releaseId ?? null }, 202);
});

async function listVisible(c: Context<AppEnv>, projectId?: string) {
  const actor = await orgActor(c, c.req.param("org")!);
  const svc = c.get("svc");
  const rows = projectId
    ? await svc.db.prepare("SELECT * FROM editions WHERE org_id = ? AND project_id = ? ORDER BY created_at").bind(actor.orgId, projectId).all<EditionRow>()
    : await svc.db.prepare("SELECT * FROM editions WHERE org_id = ? ORDER BY created_at LIMIT 200").bind(actor.orgId).all<EditionRow>();
  const out = [];
  for (const e of rows.results) {
    const a = await accessFor(svc, actor, e);
    if (a) out.push(await presentEdition(svc, a));
  }
  return c.json({ editions: out });
}

editionsRoutes.get("/orgs/:org/projects/:pid/editions", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  await readableProject(c.get("svc"), actor, c.req.param("pid"));
  return listVisible(c, c.req.param("pid"));
});

editionsRoutes.get("/orgs/:org/editions", (c) => listVisible(c));

editionsRoutes.get("/orgs/:org/editions/:eid", async (c) => {
  const a = await loadEdition(c);
  return c.json(await presentEdition(c.get("svc"), a));
});

// ------------------------------------------------------------------------------------- grants

const GrantBody = z.object({ userId: z.string().min(1).max(128) });

editionsRoutes.get("/orgs/:org/editions/:eid/grants", async (c) => {
  const a = await loadEdition(c);
  if (!a.developer) throw forbidden("insufficient_role", "only developers see edition grants");
  const rows = await c.get("svc").db.prepare("SELECT user_id, granted_by, created_at FROM edition_grants WHERE edition_id = ? ORDER BY created_at").bind(a.edition.edition_id).all<{ user_id: string; granted_by: string; created_at: string }>();
  return c.json({ grants: rows.results.map((g) => ({ userId: g.user_id, grantedBy: g.granted_by, createdAt: g.created_at })) });
});

/** Edition access is its own grant (PRD §6); it implies nothing about canonical resources. */
editionsRoutes.put("/orgs/:org/editions/:eid/grants", async (c) => {
  const a = await loadEdition(c, "manage");
  const svc = c.get("svc");
  const body = await readJson(c, GrantBody);
  const role = await getRole(svc.db, a.actor.orgId, body.userId);
  if (!role) throw notFound("member not found");
  if (role === "viewer") throw badRequest("grant_exceeds_role", "viewers cannot propose changes; make them a client first");
  const now = svc.nowIso();
  await svc.db.prepare("INSERT OR IGNORE INTO edition_grants (edition_id, org_id, user_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)").bind(a.edition.edition_id, a.actor.orgId, body.userId, a.actor.userId, now).run();
  await recordEvent(svc, { orgId: a.actor.orgId, projectId: a.edition.project_id, actor: userRef(a.actor.userId), action: "edition.granted", subjectKind: "edition", subjectId: a.edition.edition_id, detail: { userId: body.userId } });
  return c.json({ editionId: a.edition.edition_id, userId: body.userId, role }, 201);
});

editionsRoutes.delete("/orgs/:org/editions/:eid/grants", async (c) => {
  const a = await loadEdition(c, "manage");
  const svc = c.get("svc");
  const body = await readJson(c, GrantBody);
  const r = await svc.db.prepare("DELETE FROM edition_grants WHERE edition_id = ? AND user_id = ?").bind(a.edition.edition_id, body.userId).run();
  if ((r.meta.changes ?? 0) === 0) throw notFound("grant not found");
  // revocation blocks future platform access (PRD §11: it cannot erase local copies)
  await revokeUserEditionTokens(svc, a.actor.orgId, body.userId, a.edition.edition_id);
  await recordEvent(svc, { orgId: a.actor.orgId, projectId: a.edition.project_id, actor: userRef(a.actor.userId), action: "edition.grant_revoked", subjectKind: "edition", subjectId: a.edition.edition_id, detail: { userId: body.userId } });
  return c.json({ ok: true });
});

// ------------------------------------------------------------------------------------ sessions

/**
 * P42-2: a staging-mode project takes client changes as client tasks (staging, then promotion), so
 * no edition is created there, and an edition from before staging starts no update and takes no
 * return. Everything else about such an edition (reads, grants, an open session's download, the
 * proposals earlier returns opened) is unaffected.
 */
async function refuseInStagingMode(svc: Services, where: { org_id: string; project_id: string }): Promise<void> {
  if (await isStagingProject(svc, where.org_id, where.project_id)) throw conflict("staging_mode", "staging-mode projects use client tasks: start a task instead of an edition update");
}

/** "Start an update": pins the current build (its inventory, canonical bases and live release). */
editionsRoutes.post("/orgs/:org/editions/:eid/sessions", async (c) => {
  const a = await loadEdition(c, "use");
  const svc = c.get("svc");
  const body = await readJson(c, z.object({ title: z.string().trim().min(1).max(200), request: z.string().max(16_000).default("") }));
  await refuseInStagingMode(svc, a.edition);
  if (!a.edition.current_build_id) throw conflict("edition_not_ready", "this edition has not been published yet (developer setup required)");
  if (readOnlyPolicy(a.policy)) throw conflict("edition_read_only", "this edition publishes reference material only");
  const sessionId = newId("eds", 8);
  const now = svc.nowIso();
  await svc.db
    .prepare("INSERT INTO edition_sessions (session_id, edition_id, build_id, org_id, project_id, user_id, title, request, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)")
    .bind(sessionId, a.edition.edition_id, a.edition.current_build_id, a.actor.orgId, a.edition.project_id, a.actor.userId, body.title, body.request, now, now)
    .run();
  await recordEvent(svc, { orgId: a.actor.orgId, projectId: a.edition.project_id, actor: userRef(a.actor.userId), action: "edition.session_started", subjectKind: "edition", subjectId: a.edition.edition_id, detail: { sessionId, title: body.title }, clientVisible: true, clientDetail: { sessionId, title: body.title } });
  const session = (await getSession(svc, a.actor.orgId, sessionId))!;
  return c.json(await presentSession(svc, session, a, a.developer), 201);
});

editionsRoutes.get("/orgs/:org/editions/:eid/sessions", async (c) => {
  const a = await loadEdition(c);
  const svc = c.get("svc");
  const rows = a.developer
    ? await svc.db.prepare("SELECT * FROM edition_sessions WHERE edition_id = ? ORDER BY created_at DESC LIMIT 100").bind(a.edition.edition_id).all<SessionRow>()
    : await svc.db.prepare("SELECT * FROM edition_sessions WHERE edition_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100").bind(a.edition.edition_id, a.actor.userId).all<SessionRow>();
  const out = [];
  for (const s of rows.results) out.push(await presentSession(svc, s, a, a.developer));
  return c.json({ sessions: out });
});

editionsRoutes.get("/orgs/:org/edition-sessions/:sid", async (c) => {
  const { access, session } = await loadSession(c);
  return c.json(await presentSession(c.get("svc"), session, access, access.developer));
});

/** The session's working copy as a ZIP: exactly the published edition files (no history, no `.git`). */
editionsRoutes.get("/orgs/:org/edition-sessions/:sid/download", async (c) => {
  const { access, session } = await loadSession(c);
  const svc = c.get("svc");
  const build = await getBuild(svc, session.build_id);
  const repo = editionRepo(access.edition);
  if (!build || build.state !== "ready" || !build.sha || !repo) throw conflict("edition_not_ready", "this working copy is not available");
  if (build.policy_revision !== access.edition.policy_revision) throw conflict("edition_policy_changed", "the developer changed what this edition publishes; start a new update");
  const inv = inventoryOf(build);
  if (inv.reduce((n, f) => n + f.size, 0) > MAX_EDITION_DOWNLOAD_BYTES) throw new ApiError(413, "too_large", "this edition is too large to download as a ZIP; use the git remote");
  const files = [];
  for (const f of inv) {
    const bytes = await svc.transport.readFile(repo.namespace, repo.repoName, build.sha, f.editionPath);
    if (!bytes) throw conflict("edition_unavailable", "this working copy was replaced by a newer edition; start a new update");
    if ((await sha256Hex(bytes)) !== f.sha256) throw new ApiError(502, "edition_mismatch", "the edition repository does not match its manifest");
    files.push({ path: f.editionPath, data: bytes });
  }
  const zip = writeZip(files);
  const root = downloadRoot(access.edition, session);
  return new Response(zip, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${root}.zip"`,
      "content-length": String(zip.length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

/**
 * A read token on the edition repo (for `git clone`), never on a canonical one (AT-25). Only the
 * session's own user; TTL ≤ 24 h; revoked when the edition grant is revoked.
 */
editionsRoutes.post("/orgs/:org/edition-sessions/:sid/credential", async (c) => {
  const { access, session, own } = await loadSession(c);
  if (!own) throw forbidden("not_session_owner", "only the person who started this update gets its credential");
  const svc = c.get("svc");
  const body = await readJson(c, z.object({ ttlSeconds: z.number().int().min(60).max(MAX_EDITION_TOKEN_SECONDS).default(3600) }));
  const repo = editionRepo(access.edition);
  const build = await getBuild(svc, session.build_id);
  if (!repo || !build?.sha) throw conflict("edition_not_ready", "this working copy is not available");
  if (build.policy_revision !== access.edition.policy_revision || access.edition.current_build_id !== build.build_id) {
    throw conflict("edition_policy_changed", "this working copy is no longer the published edition; start a new update");
  }
  const info = await svc.transport.getRepo(repo.namespace, repo.repoName);
  if (!info || info.id !== repo.repoId) throw conflict("repo_mismatch", "the edition repository changed");
  if (!repo.namespace.endsWith("-editions")) throw forbidden("namespace_refused", "editions live in the -editions namespace only");
  const t = await svc.transport.createToken(repo.namespace, repo.repoName, "read", body.ttlSeconds);
  await svc.db.prepare("INSERT INTO edition_tokens (edition_id, org_id, user_id, token_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(access.edition.edition_id, session.org_id, access.actor.userId, t.id, Date.parse(t.expiresAt), svc.now().getTime()).run();
  await recordEvent(svc, { orgId: session.org_id, projectId: session.project_id, actor: userRef(access.actor.userId), action: "edition.credential_issued", subjectKind: "edition", subjectId: access.edition.edition_id, detail: { sessionId: session.session_id, tokenId: t.id, scope: "read", expiresAt: t.expiresAt } });
  c.header("cache-control", "no-store");
  return c.json({ tokenId: t.id, secret: t.plaintext, scope: "read", expiresAt: new Date(t.expiresAt).toISOString(), remoteUrl: info.remote, branch: "main", commit: build.sha, current: access.edition.current_build_id === build.build_id });
});

// ------------------------------------------------------------------------------------- returns

const ReturnQuery = z.object({
  mode: z.enum(["full", "partial"]).default("partial"),
  tool: z.string().trim().min(1).max(128).optional(),
});

/**
 * Return the edited working copy (raw ZIP body). `?mode=partial` (default): files left out stay as
 * they are; only `delete=` paths are deleted. `?mode=full`: the ZIP is the whole working copy; a
 * published file missing from it is a deletion. The edition manifest (inventory, mappings,
 * protected paths, bases) is the server's; nothing in the upload can change it (AT-28).
 */
editionsRoutes.post("/orgs/:org/edition-sessions/:sid/returns", async (c) => {
  const { access, session, own } = await loadSession(c);
  if (!own) throw forbidden("not_session_owner", "only the person who started this update can send it back");
  const svc = c.get("svc");
  await refuseInStagingMode(svc, access.edition);
  const q = ReturnQuery.parse({ mode: c.req.query("mode") ?? undefined, tool: c.req.query("tool") ?? undefined });
  const deletions = (c.req.queries("delete") ?? []).filter((d) => d.length > 0);
  if (deletions.length > 1000 || deletions.some((d) => d.length > 1024)) throw badRequest("invalid_request", "too many or too long deletions");
  const len = Number(c.req.header("content-length"));
  if (!Number.isFinite(len) || len <= 0) throw new ApiError(411, "length_required", "content-length is required");
  if (len > MAX_RETURN_BYTES) throw new ApiError(413, "too_large", `returns are limited to ${MAX_RETURN_BYTES} bytes`);

  const build = await getBuild(svc, session.build_id);
  if (!build || build.state !== "ready") throw conflict("edition_not_ready", "this working copy is not available");
  // a changed policy invalidates the session (like a proposal's policy revision)
  if (build.policy_revision !== access.edition.policy_revision) throw conflict("edition_policy_changed", "the developer changed what this edition allows; start a new update");
  const target = targetOf(access, build);
  if (!target) throw conflict("edition_read_only", "this edition publishes reference material only");
  // AT-30: never apply an old working copy over newer accepted (or live) work
  const head = await svc.ledger(session.org_id).getHead(target.resourceId);
  if (head?.revisionId !== target.base) throw conflict("edition_stale", "the live application changed since this working copy was made; start a new update");

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length !== len) throw badRequest("invalid_request", "body length differs from content-length");
  let zip;
  try {
    zip = await readReturnZip(bytes, RETURN_ZIP_LIMITS, downloadRoot(access.edition, session));
  } catch (e) {
    if (e instanceof ZipRefused) throw badRequest("zip_refused", e.message, { reason: e.reason });
    throw e;
  }
  // AT-28: traversal, symlinks, special files, duplicates, ratio bombs refuse the whole return
  if (zip.rejected.length > 0) throw badRequest("zip_refused", "the upload contains entries that are never accepted", { rejected: zip.rejected.slice(0, 200) });

  const manifest = manifestOf(access.edition, build);
  // a full return names the whole working copy: one that matches none of it (e.g. a renamed
  // wrapper folder) would delete every editable file, so it is refused instead
  if (q.mode === "full") {
    const published = new Set(manifest.inventory.map((i) => i.editionPath));
    if (!zip.entries.some((e) => published.has(e.path))) {
      throw badRequest("full_return_unmatched", "none of the uploaded files is part of this working copy; zip the files themselves (or the downloaded folder), or send only the changed files", { downloadRoot: downloadRoot(access.edition, session) });
    }
  }
  let preview;
  try {
    preview = await previewReturn(manifest, zip.entries, q.mode, deletions, target.resourceId);
  } catch (e) {
    if ((e as { code?: string }).code === "invalid_edition_return") throw badRequest("invalid_edition_return", (e as Error).message);
    throw e;
  }
  if (preview.allowed.length === 0) {
    throw conflict("no_allowed_changes", preview.blocked.length ? "every change in the upload touches a place this working copy does not allow" : "nothing in the upload differs from the working copy", {
      blocked: preview.blocked.slice(0, 200),
      unchanged: preview.unchanged,
    });
  }

  // a new task with one write workspace for the target (a fresh -tasks repo; the runner pushes into it)
  const project = await requireProject(svc, session.org_id, session.project_id);
  const snapshot = await projectSnapshot(svc, project, { writeMounts: new Set([target.mountName]) });
  const entry = snapshot.entries.find((e) => e.resourceId === target.resourceId);
  if (entry?.revisionId !== target.base) throw conflict("edition_stale", "the live application changed since this working copy was made; start a new update");

  // stage for the runner (which re-validates): the upload as sent, or a re-pack only when a wrapper
  // folder or OS junk had to be removed (review M-1: never two full copies in the common case)
  const returnId = newId("edr", 8);
  const staged = zip.strippedFolder || zip.ignored.length ? writeZip(zip.entries) : bytes;
  const r2Key = `org/${session.org_id}/edition-returns/${returnId}/upload.zip`;
  const sha = await sha256Hex(staged);
  await svc.env.COMMONFORGE_ASSETS.put(r2Key, staged, { sha256: sha, httpMetadata: { contentType: "application/zip" } });
  const taskId = `task-${crypto.randomUUID()}`;
  const wsId = taskWorkspaceIdFor(taskId, target.resourceId);
  const now = svc.nowIso();
  const previewJson = JSON.stringify({ ...preview, ignored: zip.ignored, strippedFolder: zip.strippedFolder });
  await svc.db.batch([
    svc.db
      .prepare("INSERT INTO tasks (task_id, org_id, project_id, change_id, title, request, state, snapshot_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?)")
      .bind(taskId, session.org_id, session.project_id, newChangeId(), `Client update: ${session.title}`.slice(0, 200), session.request, JSON.stringify(snapshot), access.actor.userId, now, now),
    svc.db
      .prepare("INSERT INTO task_workspaces (task_workspace_id, task_id, org_id, resource_id, mount_name, provider, access, base_revision, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'artifacts', 'write', ?, 'provisioning', ?, ?)")
      .bind(wsId, taskId, session.org_id, target.resourceId, target.mountName, target.base, now, now),
    svc.db
      .prepare(
        "INSERT INTO edition_returns (return_id, session_id, edition_id, build_id, org_id, project_id, user_id, mode, deletions_json, r2_key, size, sha256, tool, resource_id, expected_head, task_id, task_workspace_id, state, preview_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
      )
      .bind(returnId, session.session_id, session.edition_id, build.build_id, session.org_id, session.project_id, access.actor.userId, q.mode, JSON.stringify(deletions), r2Key, staged.length, sha, q.tool ?? null, target.resourceId, target.base, taskId, wsId, previewJson, now, now),
  ]);
  await enqueueStep(svc, { type: "edition.return", orgId: session.org_id, returnId });
  await recordEvent(svc, {
    orgId: session.org_id,
    projectId: session.project_id,
    actor: userRef(access.actor.userId),
    action: "edition.returned",
    subjectKind: "edition",
    subjectId: session.edition_id,
    resourceIds: [target.resourceId],
    detail: { returnId, sessionId: session.session_id, taskId, mode: q.mode, allowed: preview.allowed.length, blocked: preview.blocked.length, tool: q.tool ?? null },
    clientVisible: true,
    clientDetail: { returnId, mode: q.mode, changed: preview.allowed.length, blocked: preview.blocked.length },
  });
  return c.json(presentReturn((await getReturn(svc, returnId))!, access.developer), 202);
});

editionsRoutes.get("/orgs/:org/edition-returns/:rid", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const r = await getReturn(svc, c.req.param("rid"));
  if (!r || r.org_id !== actor.orgId) throw notFound("return not found");
  const edition = await getEdition(svc, actor.orgId, r.edition_id);
  const access = edition ? await accessFor(svc, actor, edition) : null;
  const own = !!access?.use && r.user_id === actor.userId;
  if (!access || (!own && !access.developer)) throw notFound("return not found");
  return c.json(presentReturn(await settle(svc, r), access.developer));
});

