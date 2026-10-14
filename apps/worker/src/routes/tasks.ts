/**
 * Tasks, workspaces, task leases (agent principals), the agent capability broker, materialization
 * plans and task asset uploads.
 */
import {
  AbsoluteDirSchema,
  LfsUrlSchema,
  MountNameSchema,
  RelativePathSchema,
  Sha256HexSchema,
  manifestId as toManifestId,
  parseRevisionId,
  resourceId as toResourceId,
  taskWorkspaceId as toTaskWorkspaceId,
  type AssetManifest,
  type MaterializationPlan,
  type TaskWorkspaceHandle,
  type ProviderCoords,
} from "@commonforge-org/core";
import { WORKSPACE_JSON_PATH, planMaterialization, type MaterializationGrant } from "@commonforge-org/runner-protocol";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Services } from "../context.js";
import { randomToken } from "../lib/crypto.js";
import { lfsEndpointUrl } from "../lib/lfs-config.js";
import { ApiError, badRequest, conflict, forbidden, notFound, parseQuery, readJson } from "../lib/http.js";
import {
  canReadProject,
  canReadResource,
  canSeeTask,
  canWriteResource,
  canWriteTaskResource,
  isDeveloper,
  orgActor,
  readableProject,
  requireRole,
  requireUser,
  seesCanonical,
  taskActor,
  type OrgActor,
} from "../middleware/authz.js";
import { leaseTokenHash } from "../services/auth.js";
import { issueAgentCredential } from "../services/capability-broker.js";
import { getProject, getResource, getRole, projectPolicy, resourceCoords, type ProjectRow } from "../services/directory.js";
import { agentRef, recordEvent, userRef } from "../services/events.js";
import { getPromotion, holderOf } from "../services/promotions.js";
import { assertStagingProject, landingOfTask, landingParts } from "../services/staging.js";
import { stagingPolicyOf } from "../services/staging-policy.js";
import { createTask } from "../services/task-create.js";
import {
  DEFAULT_LEASE_SECONDS,
  MAX_LEASE_SECONDS,
  getTask,
  listWorkspaces,
  taskSnapshot,
  revokeWorkspaceWriteTokens,
  type TaskRow,
  type WorkspaceRow,
} from "../services/tasks.js";

export const taskRoutes = new Hono<AppEnv>();

async function loadTask(c: Context<AppEnv>, opts: { agentOnly?: boolean } = {}): Promise<{ task: TaskRow; actor: OrgActor & { agent: boolean } }> {
  const task = await getTask(c.get("svc"), c.req.param("id")!);
  if (!task) throw notFound("task not found");
  const actor = await taskActor(c, task, opts.agentOnly ? { allowUser: false } : {});
  // tasks are developer objects; in staging mode a client works on the tasks they created (their
  // agent is admitted by `taskActor` on exactly that condition; the user by `canSeeTask`)
  if (!isDeveloper(actor.role) && actor.role !== "client") throw notFound("task not found");
  // provider errors (their text can name the task repo) reach a client or their agent as a plain message
  c.set("plainProviderErrors", !isDeveloper(actor.role));
  if (!actor.agent && !(await canSeeTask(c.get("svc"), actor, task))) throw notFound("task not found");
  return { task, actor };
}

/**
 * Staging mode (spec 2026-10-07 §4): the project a client may create and list tasks in. Anything
 * short of a readable staging-mode project answers exactly as for a client without staging mode
 * (403 insufficient_role), so the answer does not reveal whether such a project exists.
 */
async function stagingClientProject(svc: Services, actor: OrgActor, projectId: string): Promise<ProjectRow> {
  const project = await getProject(svc.db, actor.orgId, projectId);
  if (!project || !stagingPolicyOf(project) || !(await canReadProject(svc, actor, projectId))) requireRole(actor, ["owner", "developer"]);
  return project!;
}

/** Owners/developers: the readable project. Clients: {@link stagingClientProject}. Others: 403 as before. */
async function taskProject(c: Context<AppEnv>): Promise<{ actor: OrgActor; project: () => Promise<ProjectRow> }> {
  const actor = await orgActor(c, c.req.param("org")!);
  const svc = c.get("svc");
  const pid = c.req.param("pid")!;
  if (actor.role === "client") {
    const project = await stagingClientProject(svc, actor, pid);
    return { actor, project: async () => project };
  }
  requireRole(actor, ["owner", "developer"]);
  return { actor, project: () => readableProject(svc, actor, pid) };
}

/**
 * `rawErrors`: owners/developers see a failed workspace's raw error (it may name repositories); a
 * client and their agent (staging mode) get the stable code `workspace_failed` instead.
 */
function presentTask(task: TaskRow, workspaces: WorkspaceRow[], rawErrors: boolean, extra: Record<string, unknown> = {}) {
  return {
    taskId: task.task_id,
    orgId: task.org_id,
    projectId: task.project_id,
    changeId: task.change_id,
    title: task.title,
    request: task.request,
    state: task.state,
    snapshot: taskSnapshot(task),
    lease: task.lease_expires_at ? { generation: task.lease_generation, expiresAt: new Date(task.lease_expires_at).toISOString(), holder: task.lease_holder } : null,
    workspaces: workspaces.map((w) => ({
      taskWorkspaceId: w.task_workspace_id,
      mountName: w.mount_name,
      resourceId: w.resource_id,
      provider: w.provider,
      access: w.access,
      baseRevision: w.base_revision,
      state: w.state,
      ...(w.asset_manifest_id ? { assetManifestId: w.asset_manifest_id } : {}),
      ...(w.error ? { error: rawErrors ? w.error : "workspace_failed" } : {}),
    })),
    ...(task.revises_task_id ? { revisesTaskId: task.revises_task_id } : {}),
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    ...extra,
  };
}

// ------------------------------------------------------------------------------- create / read

taskRoutes.post("/orgs/:org/projects/:pid/tasks", async (c) => {
  const { actor, project: loadProject } = await taskProject(c);
  const body = await readJson(
    c,
    z.object({
      title: z.string().trim().min(1).max(200),
      request: z.string().max(16_000).default(""),
      /** the mounts the agent may change (default: every mount the creator may start a task in) */
      writeMounts: z.array(MountNameSchema).min(1).max(16).optional(),
      /** read-only mounts in the workspace (default: every other mount the creator can read) */
      readMounts: z.array(MountNameSchema).max(32).optional(),
    }),
  );
  const svc = c.get("svc");
  const project = await loadProject();
  const task = await createTask(svc, actor, project, body);
  return c.json(presentTask(task, await listWorkspaces(svc, task.task_id), seesCanonical(actor.role)), 201);
});

/**
 * Revise a task that is live on staging (staging phase 2, R6): the task's creator, or an owner or
 * developer who can see it. Its landing must be `landed`, or `promoting` in a promotion that waits
 * for approval or is cleared (submitting the revision supersedes that promotion). Creates the
 * follow-up task — the original's write and read mounts, from live staging, titled
 * `"<original title> (revision N)"` — whose proposal joins the landing as its next part when it is
 * submitted. Body `{ request? }`. → 201 Task.
 */
taskRoutes.post("/tasks/:id/revise", async (c) => {
  const user = requireUser(c);
  const svc = c.get("svc");
  const task = await getTask(svc, c.req.param("id")!);
  if (!task) throw notFound("task not found");
  const role = await getRole(svc.db, task.org_id, user.userId);
  if (!role || (!isDeveloper(role) && role !== "client")) throw notFound("task not found");
  const actor: OrgActor = { orgId: task.org_id, userId: user.userId, role };
  // canSeeTask: a client only for a task they created, while the project is in staging mode
  if (!(await canSeeTask(svc, actor, task))) throw notFound("task not found");
  c.set("plainProviderErrors", !isDeveloper(role));
  const body = await readJson(c, z.object({ request: z.string().max(16_000).default("") }));
  const project = role === "client" ? await stagingClientProject(svc, actor, task.project_id) : await readableProject(svc, actor, task.project_id);
  assertStagingProject(project);
  const l = await landingOfTask(svc, task.org_id, task.task_id);
  let revisable = l?.state === "landed";
  if (l?.state === "promoting") {
    // the promotion that claims it (B1) has not started accepting
    const holder = await holderOf(svc, l.landing_id);
    const p = holder ? await getPromotion(svc, holder) : null;
    revisable = p?.state === "pending_approval" || p?.state === "cleared";
  }
  if (!l || !revisable) throw conflict("landing_not_revisable", "only a task that is live on staging (and not being accepted into production) can be revised");
  const original = (await getTask(svc, l.task_id))!;
  const parts = await landingParts(svc, l);
  const partTasks = parts.map((x) => x.taskId);
  // revisions created but not joined yet (still being worked on); failed or canceled ones do not count
  const pending = await svc.db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE org_id = ? AND revises_task_id IN (${partTasks.map(() => "?").join(", ")}) AND task_id NOT IN (${partTasks.map(() => "?").join(", ")}) AND state NOT IN ('failed', 'canceled')`)
    .bind(task.org_id, ...partTasks, ...partTasks)
    .first<{ n: number }>();
  const n = parts.length + (pending?.n ?? 0);
  const ws = await listWorkspaces(svc, original.task_id);
  const revision = await createTask(svc, actor, project, {
    title: `${original.title} (revision ${n})`.slice(0, 200),
    request: body.request,
    writeMounts: ws.filter((w) => w.access === "write").map((w) => w.mount_name),
    readMounts: ws.filter((w) => w.access === "read").map((w) => w.mount_name),
    revisesTaskId: original.task_id,
  });
  return c.json(presentTask(revision, await listWorkspaces(svc, revision.task_id), seesCanonical(role)), 201);
});

taskRoutes.get("/orgs/:org/projects/:pid/tasks", async (c) => {
  const { actor, project: loadProject } = await taskProject(c);
  const svc = c.get("svc");
  const project = await loadProject();
  // staging mode: a client lists only the tasks they created
  const rows =
    actor.role === "client"
      ? await svc.db.prepare("SELECT * FROM tasks WHERE org_id = ? AND project_id = ? AND created_by = ? ORDER BY created_at DESC").bind(actor.orgId, project.project_id, actor.userId).all<TaskRow>()
      : await svc.db.prepare("SELECT * FROM tasks WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC").bind(actor.orgId, project.project_id).all<TaskRow>();
  // `updatedAt` moves with a lease taken or released and a state change; `leaseExpiresAt` is the
  // current lease's expiry (null once released): enough for "the agent checked out … ago"
  return c.json({
    tasks: rows.results.map((t) => ({
      taskId: t.task_id,
      title: t.title,
      state: t.state,
      changeId: t.change_id,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      leaseExpiresAt: t.lease_expires_at ? new Date(t.lease_expires_at).toISOString() : null,
    })),
  });
});

taskRoutes.get("/tasks/:id", async (c) => {
  const { task, actor } = await loadTask(c);
  const svc = c.get("svc");
  const candidates = await svc.db.prepare("SELECT candidate_id, resource_id, task_workspace_id, created_at FROM task_candidates WHERE task_id = ? ORDER BY created_at").bind(task.task_id).all<{ candidate_id: string; resource_id: string; task_workspace_id: string; created_at: string }>();
  const ledger = svc.ledger(task.org_id);
  const list = [];
  for (const cand of candidates.results) {
    const rec = await ledger.getCandidate(cand.candidate_id);
    list.push({ candidateId: cand.candidate_id, resourceId: cand.resource_id, taskWorkspaceId: cand.task_workspace_id, state: rec?.state ?? "unknown", preparedReceiptId: rec?.preparedReceiptId ?? null, sha: rec?.candidate.sha, changedPaths: rec?.candidate.changedPaths ?? [] });
  }
  const ws = await listWorkspaces(svc, task.task_id);
  const handles = await Promise.all(ws.map((w) => (w.provider === "artifacts" ? ledger.getWorkspace(w.task_workspace_id) : null)));
  const out = presentTask(task, ws, seesCanonical(actor.role), { candidates: list });
  // task repo URLs only for the task's agent, its assignee and owners (I-1); never a client's own
  // session (staging mode): only their agent, the lease token, gets coordinates
  const seesRepos = actor.agent || actor.role === "owner" || (seesCanonical(actor.role) && task.lease_holder === actor.userId);
  if (seesRepos) out.workspaces = out.workspaces.map((w, i) => ({ ...w, ...(handles[i] ? { remoteUrl: handles[i]!.coords.remoteUrl } : {}) }));
  return c.json(out);
});

// ------------------------------------------------------------------------------------- leases

/**
 * Take the task lease: returns an agent bearer token (`cfl_…`, shown once) scoped to this task.
 * A new lease bumps the generation; the previous agent token stops working and the task repos'
 * active write tokens are revoked (lease loss, plan §F "Token leakage").
 */
taskRoutes.post("/tasks/:id/lease", async (c) => {
  const p = c.get("principal");
  if (p?.kind !== "user") throw p ? forbidden("agent_not_allowed", "agents cannot take leases") : new ApiError(401, "unauthenticated", "authentication required");
  const { task, actor } = await loadTask(c);
  const body = await readJson(c, z.object({ ttlSeconds: z.number().int().min(300).max(MAX_LEASE_SECONDS).default(DEFAULT_LEASE_SECONDS) }));
  const svc = c.get("svc");
  if (!["ready", "running"].includes(task.state)) throw conflict("task_not_ready", `task is ${task.state}`);
  // M-4: taking over someone else's live lease is an owner action
  const live = task.lease_hash !== null && (task.lease_expires_at ?? 0) > svc.now().getTime();
  if (live && task.lease_holder !== actor.userId && actor.role !== "owner") throw conflict("lease_held", "another developer holds this task's lease");
  const ws = await listWorkspaces(svc, task.task_id);
  for (const w of ws) if (w.access === "write" && !(await canWriteTaskResource(svc, actor, task, w.mount_name, w.resource_id))) throw forbidden("no_write_grant", `no write grant on mount ${w.mount_name}`);
  const token = randomToken("cfl");
  const expiresAt = svc.now().getTime() + body.ttlSeconds * 1000;
  const r = await svc.db
    .prepare("UPDATE tasks SET lease_hash = ?, lease_generation = lease_generation + 1, lease_expires_at = ?, lease_holder = ?, state = 'running', updated_at = ? WHERE task_id = ? AND lease_generation = ? RETURNING lease_generation")
    .bind(await leaseTokenHash(svc, token), expiresAt, actor.userId, svc.nowIso(), task.task_id, task.lease_generation)
    .first<{ lease_generation: number }>();
  if (!r) throw conflict("lease_race", "the lease changed concurrently; retry");
  await revokeWorkspaceWriteTokens(svc, task.org_id, ws);
  await recordEvent(svc, { orgId: task.org_id, projectId: task.project_id, actor: userRef(actor.userId), action: "task.started", subjectKind: "task", subjectId: task.task_id, resourceIds: ws.map((w) => w.resource_id), detail: { leaseGeneration: r.lease_generation } });
  c.header("cache-control", "no-store");
  return c.json({ taskId: task.task_id, leaseToken: token, leaseGeneration: r.lease_generation, expiresAt: new Date(expiresAt).toISOString() });
});

taskRoutes.delete("/tasks/:id/lease", async (c) => {
  const { task, actor } = await loadTask(c);
  const svc = c.get("svc");
  if (!actor.agent && actor.role !== "owner" && task.lease_holder !== actor.userId) throw forbidden("not_task_assignee", "only the lease holder, its agent or an owner may release the lease");
  await svc.db.prepare("UPDATE tasks SET lease_hash = NULL, lease_expires_at = NULL, lease_generation = lease_generation + 1, updated_at = ? WHERE task_id = ?").bind(svc.nowIso(), task.task_id).run();
  await revokeWorkspaceWriteTokens(svc, task.org_id, await listWorkspaces(svc, task.task_id));
  await recordEvent(svc, { orgId: task.org_id, projectId: task.project_id, actor: actor.agent ? agentRef(task.task_id, actor.userId) : userRef(actor.userId), action: "task.lease_released", subjectKind: "task", subjectId: task.task_id, resourceIds: taskSnapshot(task).entries.map((e) => e.resourceId) });
  return c.json({ ok: true });
});

// --------------------------------------------------------------------------- capability broker

/**
 * Agent credentials (plan §B.4, §F): the caller must hold the current task lease (agent token);
 * the lease holder's grant on the resource is re-checked now. Written mounts → a token for the
 * task's own `-tasks` repo via `issueWorkspaceCredential` (refuses canonical, non-writable, stale
 * lease); reference mounts → a **read** token on the task's read-only reference copy in `-tasks`
 * (seeded at the pinned sha). Agents never get canonical tokens (I-6). TTL ≤ min(1 h, lease remaining).
 */
taskRoutes.post("/tasks/:id/credential", async (c) => {
  const { task, actor } = await loadTask(c, { agentOnly: true });
  const body = await readJson(c, z.object({ mountName: MountNameSchema, access: z.enum(["read", "write"]) }));
  const p = c.get("principal") as Extract<AppEnv["Variables"]["principal"], { kind: "agent" }>;
  const cred = await issueAgentCredential(c.get("svc"), task, actor, p, body);
  c.header("cache-control", "no-store");
  return c.json(cred);
});

// ------------------------------------------------------------------------------ materialization

/** `MaterializationPlan` for the CLI (`cforge checkout`); built from the ledger and grants only. */
taskRoutes.get("/tasks/:id/materialization", async (c) => {
  const { task, actor } = await loadTask(c);
  // the plan carries repository coordinates: a client's session never reads it, only their agent
  if (!actor.agent && !seesCanonical(actor.role)) throw forbidden("lease_required", "this call requires the task lease token");
  const q = parseQuery(c, z.object({ root: AbsoluteDirSchema }));
  const svc = c.get("svc");
  const snapshot = taskSnapshot(task);
  const ledger = svc.ledger(task.org_id);
  const ws = await listWorkspaces(svc, task.task_id);
  const handles = [];
  const refCopies = new Map<string, TaskWorkspaceHandle>();
  for (const w of ws) {
    if (w.provider !== "artifacts") continue;
    const h = await ledger.getWorkspace(w.task_workspace_id);
    if (!h || h.state !== "writable" || w.state !== "writable") continue;
    if (w.access === "write") handles.push(h);
    else refCopies.set(w.resource_id, h);
  }
  const grants: MaterializationGrant[] = [];
  for (const e of snapshot.entries) {
    const writable = handles.some((h) => h.resourceId === e.resourceId) && (await canWriteTaskResource(svc, actor, task, e.mountName, e.resourceId));
    // a client's agent clones task copies only (its writable fork, read-only reference copies):
    // never a canonical source, e.g. for a written mount it may no longer write (folder detached)
    if (!seesCanonical(actor.role) && !writable && !refCopies.has(e.resourceId)) continue;
    const r = await getResource(svc.db, task.org_id, e.resourceId);
    if (!r || !(await canReadResource(svc, actor, e.resourceId))) continue;
    const coords = resourceCoords(r) as ProviderCoords | null;
    if (!coords) continue;
    let manifest: AssetManifest | undefined;
    const rev = parseRevisionId(e.revisionId);
    if (rev.kind === "r2m") manifest = (await (await svc.assets(task.org_id)).readManifest(rev.manifestId, e.resourceId)) ?? undefined;
    grants.push({ resourceId: toResourceId(e.resourceId), operations: writable ? ["read", "write"] : ["read"], coords, ...(manifest ? { manifest } : {}) });
  }
  const project = await svc.db.prepare("SELECT * FROM projects WHERE org_id = ? AND project_id = ?").bind(task.org_id, task.project_id).first<Parameters<typeof projectPolicy>[0]>();
  const policy = project ? projectPolicy(project) : {};
  const writableIds = new Set(grants.filter((g) => g.operations.includes("write")).map((g) => g.resourceId as string));
  const plan = planMaterialization(snapshot, handles.filter((h) => writableIds.has(h.resourceId)), {
    principal: agentRef(task.task_id, actor.userId),
    workspaceRoot: q.root,
    grants,
    context: {
      request: `${task.title}\n\n${task.request}`,
      roles: [{ principal: `user:${actor.userId}`, role: actor.role }],
      rules: policy.rules ?? [],
      validationCommands: (policy.checks ?? []).map((ch) => ({ checkId: ch.checkId, mountName: ch.mountName, command: ch.command })),
    },
  });
  const lfsIds = new Set(grants.filter((g) => g.coords.kind === "artifacts").map((g) => g.resourceId as string));
  return c.json(withLfsUrls(pointReferencesAtCopies(plan, refCopies), (rid) => (lfsIds.has(rid) ? lfsEndpointUrl(svc.env, task.org_id, rid) : null)));
});

/**
 * Folders phase 4 (P4-7): each Artifacts (git) mount gets its folder's LFS endpoint, which
 * `cforge checkout` sets as `lfs.url` and its credential helper answers with the lease.
 */
function withLfsUrls(plan: MaterializationPlan, lfsUrl: (resourceId: string) => string | null): MaterializationPlan {
  const mounts = plan.mounts.map((m) => {
    const url = m.source.kind === "git" ? lfsUrl(m.resourceId) : null;
    // no public URL configured (or not https): no lfsUrl, rather than a plan the CLI refuses
    if (!url || m.source.kind !== "git" || !LfsUrlSchema.safeParse(url).success) return m;
    return { ...m, source: { ...m.source, lfsUrl: url } };
  });
  return { ...plan, mounts };
}

/**
 * I-6: reference mounts are cloned from their read-only `-tasks` copy (seeded at the pinned sha),
 * never from canonical. Rewrites the mount source and its workspace.json entry accordingly.
 * TODO(runner-protocol): let `planMaterialization` take reference copies directly.
 */
function pointReferencesAtCopies(plan: MaterializationPlan, copies: Map<string, TaskWorkspaceHandle>): MaterializationPlan {
  if (copies.size === 0) return plan;
  const mounts = plan.mounts.map((m) => {
    const copy = copies.get(m.resourceId);
    if (!copy || m.writable || m.source.kind !== "git") return m;
    return { ...m, source: { ...m.source, remoteUrl: copy.coords.remoteUrl, credential: "helper" as const } };
  });
  const contextFiles = plan.contextFiles.map((f) => {
    if (f.path !== WORKSPACE_JSON_PATH) return f;
    const doc = JSON.parse(f.content) as { mounts: Array<{ resourceId: string; writable: boolean; source: { kind: string; remoteUrl?: string }; coords: unknown }> };
    for (const m of doc.mounts) {
      const copy = copies.get(m.resourceId);
      if (!copy || m.writable || m.source.kind !== "git") continue;
      m.source.remoteUrl = copy.coords.remoteUrl;
      m.coords = copy.coords;
    }
    return { ...f, content: `${JSON.stringify(doc, null, 2)}\n` };
  });
  return { ...plan, mounts, contextFiles };
}

// ------------------------------------------------------------------------------------- assets

const StageSchema = z.object({ mountName: MountNameSchema, path: RelativePathSchema, size: z.number().int().nonnegative().max(5 * 1024 ** 3), mime: z.string().min(1).max(255) });

async function assetWorkspace(c: Context<AppEnv>, task: TaskRow, mountName: string): Promise<WorkspaceRow> {
  const ws = (await listWorkspaces(c.get("svc"), task.task_id)).find((w) => w.mount_name === mountName);
  if (!ws || ws.provider !== "r2-assets") throw notFound("no asset workspace for this mount");
  if (ws.state !== "writable") throw conflict("workspace_not_writable", `workspace is ${ws.state}`);
  return ws;
}

taskRoutes.post("/tasks/:id/assets/stage", async (c) => {
  const { task, actor } = await loadTask(c, { agentOnly: true });
  const body = await readJson(c, StageSchema);
  const svc = c.get("svc");
  if (task.state !== "running") throw conflict("task_not_running", `task is ${task.state}`);
  const ws = await assetWorkspace(c, task, body.mountName);
  if (!(await canWriteResource(svc, actor, ws.resource_id))) throw forbidden("no_write_grant", "no write grant on this resource");
  const staged = await (await svc.assets(task.org_id)).stageUpload({ organizationId: task.org_id, taskWorkspaceId: toTaskWorkspaceId(ws.task_workspace_id), path: body.path, size: body.size, mime: body.mime });
  return c.json({ stagingKey: staged.stagingKey, uploadUrl: `/api/tasks/${task.task_id}/assets/upload?key=${encodeURIComponent(staged.stagingKey)}` });
});

taskRoutes.put("/tasks/:id/assets/upload", async (c) => {
  const { task, actor } = await loadTask(c, { agentOnly: true });
  const key = z.string().min(1).parse(c.req.query("key"));
  const svc = c.get("svc");
  if (task.state !== "running") throw conflict("task_not_running", `task is ${task.state}`);
  const len = Number(c.req.header("content-length"));
  if (!Number.isFinite(len) || len < 0) throw new ApiError(411, "length_required", "content-length is required");
  const ws = await listWorkspaces(svc, task.task_id);
  const target = ws.find((w) => w.provider === "r2-assets" && w.state === "writable" && key.startsWith(`org/${task.org_id}/staging/${w.task_workspace_id}/`));
  if (!target) throw forbidden("scope_violation", "staging key outside this task's asset workspaces");
  if (!(await canWriteResource(svc, actor, target.resource_id))) throw forbidden("no_write_grant", "no write grant on this resource");
  if (!c.req.raw.body) throw badRequest("invalid_request", "body required");
  const r = await (await svc.assets(task.org_id)).putStaged(key, c.req.raw.body as never);
  return c.json({ stagingKey: key, size: r.size }, 201);
});

/** Promote staged uploads (HEAD + sha256 verified) and write the task's new manifest. */
taskRoutes.post("/tasks/:id/assets/commit", async (c) => {
  const { task, actor } = await loadTask(c, { agentOnly: true });
  const body = await readJson(
    c,
    z.object({
      mountName: MountNameSchema,
      changes: z
        .array(
          z.union([
            z.object({ path: RelativePathSchema, stagingKey: z.string().min(1), sha256: Sha256HexSchema, mime: z.string().min(1).max(255) }),
            z.object({ path: RelativePathSchema, delete: z.literal(true) }),
          ]),
        )
        .min(1)
        .max(1000),
    }),
  );
  const svc = c.get("svc");
  if (task.state !== "running") throw conflict("task_not_running", `task is ${task.state}`);
  const ws = await assetWorkspace(c, task, body.mountName);
  if (!(await canWriteResource(svc, actor, ws.resource_id))) throw forbidden("no_write_grant", "no write grant on this resource");
  const assets = await svc.assets(task.org_id);
  const baseId = ws.asset_manifest_id ?? (parseRevisionId(ws.base_revision) as { manifestId: string }).manifestId;
  const base = await assets.readManifest(baseId, ws.resource_id);
  if (!base) throw conflict("manifest_missing", "base manifest not found");
  const entries = new Map(base.entries.map((e) => [e.path as string, e]));
  for (const ch of body.changes) {
    if ("delete" in ch) {
      entries.delete(ch.path);
      continue;
    }
    if (!ch.stagingKey.startsWith(`org/${task.org_id}/staging/${ws.task_workspace_id}/`)) throw forbidden("scope_violation", "staging key outside this workspace");
    const p = await assets.promoteStaged({ stagingKey: ch.stagingKey, expectedSha256: ch.sha256, resourceId: toResourceId(ws.resource_id) });
    entries.set(ch.path, { path: ch.path, sha256: p.sha256, size: p.size, mime: ch.mime, objectKey: p.objectKey, source: { kind: "task", ref: task.task_id } } as AssetManifest["entries"][number]);
  }
  const m = await assets.writeManifest({ resourceId: toResourceId(ws.resource_id), parentManifestId: toManifestId(base.manifestId), entries: [...entries.values()] });
  await svc.db.prepare("UPDATE task_workspaces SET asset_manifest_id = ?, updated_at = ? WHERE task_workspace_id = ?").bind(m.manifestId, svc.nowIso(), ws.task_workspace_id).run();
  await recordEvent(svc, { orgId: task.org_id, projectId: task.project_id, actor: agentRef(task.task_id, actor.userId), action: "assets.committed", subjectKind: "workspace", subjectId: ws.task_workspace_id, resourceIds: [ws.resource_id], detail: { manifestId: m.manifestId, entries: m.entries.length } });
  return c.json({ taskWorkspaceId: ws.task_workspace_id, manifestId: m.manifestId, parentManifestId: base.manifestId, entries: m.entries.length });
});

