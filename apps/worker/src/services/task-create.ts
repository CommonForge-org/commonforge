/**
 * Task creation (the `POST …/tasks` route and task revisions, staging phase 2 Task 9): checks the
 * actor's write/read access on the named mounts, pins the project snapshot, writes the task and its
 * workspaces and starts provisioning. Authorization of the project itself is the caller's.
 *
 * Staging mode (R5): every task, whatever the creator's role, starts from the live staging build
 * where it has a revision (a resource without one, or with a malformed entry, starts from its head).
 */
import type { Services } from "../context.js";
import { badRequest, conflict, forbidden, notFound, type ApiError } from "../lib/http.js";
import { canReadResource, canStageWrite, canWriteResource, type OrgActor } from "../middleware/authz.js";
import { getMount, getResource, type MountRow, type ProjectRow, type ResourceRow } from "./directory.js";
import { recordEvent, userRef } from "./events.js";
import { projectSnapshot } from "./snapshot.js";
import { stagingPolicyOf } from "./staging-policy.js";
import { currentStaging } from "./staging-state.js";
import { enqueueStep } from "./steps.js";
import { getTask, newChangeId, setTaskState, taskWorkspaceIdFor, type TaskRow } from "./tasks.js";

/** At most this many write mounts per task (the route's `writeMounts` limit). */
export const MAX_WRITE_MOUNTS = 16;

export interface CreateTaskInput {
  title: string;
  request: string;
  /**
   * The mounts the agent may change. Default (left out): every mount the creator may start a task
   * in ({@link writeMountIssue}) that has an accepted version, so a person never chooses folders:
   * the owner's access settings decide them.
   */
  writeMounts?: string[];
  /** read-only mounts in the workspace (default: every other mount the creator can read) */
  readMounts?: string[];
  /** resourceId → revision id each resource starts from (default: live staging in staging mode, else the heads) */
  baseRevisions?: Map<string, string>;
  /** the task this one revises (staging phase 2, R6) */
  revisesTaskId?: string;
}

/** The live staging build (its id, null without staging mode or a live build) and its revision per resource. */
export async function stagingBases(svc: Services, project: ProjectRow): Promise<{ buildId: string | null; bases: Map<string, string> }> {
  const out = new Map<string, string>();
  if (!stagingPolicyOf(project)) return { buildId: null, bases: out };
  const live = await currentStaging(svc, project.org_id, project.project_id);
  // a malformed entry is skipped (that resource starts from its head); never a failed create
  for (const [rid, s] of Object.entries(live?.shas ?? {})) if (s && typeof s === "object" && typeof (s as { revisionId?: unknown }).revisionId === "string") out.set(rid, s.revisionId);
  return { buildId: live && out.size > 0 ? live.buildId : null, bases: out };
}

/**
 * Why `actor` may not start a task that writes to mount `m` (resource `r`), or null when they may:
 * the one rule behind `createTask`'s write-mount checks and the project view's `canStartTask`.
 * Owners and developers need a write grant on the resource; a client (staging mode only) a git
 * folder the owner opened for writing ({@link canStageWrite}); every role a `write` mount and an
 * active resource. Read access on the resource is the caller's (a mount the caller cannot read is
 * a 404 in `createTask` and not listed in the project view). Viewers never start tasks.
 */
export async function writeMountIssue(svc: Services, actor: OrgActor, project: ProjectRow, m: MountRow, r: ResourceRow): Promise<ApiError | null> {
  const writable = (JSON.parse(m.operations_json) as string[]).includes("write");
  if (actor.role === "client") {
    // staging mode: a client writes only task copies of folders the owner opened for writing
    if (!writable) return forbidden("mount_read_only", `mount ${m.mount_name} is read-only in this project`);
    if (!(await canStageWrite(svc, actor, project, m.mount_name, r.resource_id))) return forbidden("no_write_grant", `no write grant on mount ${m.mount_name}`);
  } else {
    if (actor.role !== "owner" && actor.role !== "developer") return forbidden("no_write_grant", `no write grant on mount ${m.mount_name}`);
    if (!(await canWriteResource(svc, actor, r.resource_id))) return forbidden("no_write_grant", `no write grant on mount ${m.mount_name}`);
    if (!writable) return forbidden("mount_read_only", `mount ${m.mount_name} is read-only in this project`);
  }
  if (r.state !== "active") return conflict("resource_not_ready", `mount ${m.mount_name} is ${r.state}`);
  return null;
}

/**
 * The write mounts of a task created without any: every mount `actor` may start a task in
 * (readable, {@link writeMountIssue} null). Refused when there is none; `createTask` then leaves out
 * those without an accepted version.
 */
export async function defaultWriteMounts(svc: Services, actor: OrgActor, project: ProjectRow): Promise<string[]> {
  const out: string[] = [];
  const mounts = await svc.db.prepare("SELECT * FROM mounts WHERE org_id = ? AND project_id = ? ORDER BY mount_name").bind(actor.orgId, project.project_id).all<MountRow>();
  for (const m of mounts.results) {
    const r = await getResource(svc.db, actor.orgId, m.resource_id);
    if (!r || !(await canReadResource(svc, actor, r.resource_id))) continue;
    if ((await writeMountIssue(svc, actor, project, m, r)) !== null) continue;
    out.push(m.mount_name);
  }
  if (!out.length) throw forbidden("no_write_grant", "there is no folder you can start a task in in this project; ask your developer to open one for changes");
  // the explicit limit (`writeMounts` at most 16) holds for the default too
  if (out.length > MAX_WRITE_MOUNTS) throw badRequest("too_many_folders", `more than ${MAX_WRITE_MOUNTS} folders could be changed; choose the task's folders (writeMounts)`);
  return out;
}

export async function createTask(svc: Services, actor: OrgActor, project: ProjectRow, input: CreateTaskInput): Promise<TaskRow> {
  const chosen = input.writeMounts !== undefined;
  const writes = new Set(input.writeMounts ?? (await defaultWriteMounts(svc, actor, project)));
  const targets: Array<{ mountName: string; resourceId: string; provider: "artifacts" | "r2-assets" }> = [];
  for (const name of writes) {
    const m = await getMount(svc.db, actor.orgId, project.project_id, name);
    if (!m) throw notFound(`mount ${name} not found`);
    const r = await getResource(svc.db, actor.orgId, m.resource_id);
    if (!r || !(await canReadResource(svc, actor, r.resource_id))) throw notFound(`mount ${name} not found`);
    const issue = await writeMountIssue(svc, actor, project, m, r);
    if (issue) throw issue;
    targets.push({ mountName: m.mount_name, resourceId: r.resource_id, provider: r.provider });
  }
  let reads: Set<string>;
  if (input.readMounts) reads = new Set(input.readMounts);
  else {
    reads = new Set();
    for (const m of await svc.db.prepare("SELECT mount_name, resource_id FROM mounts WHERE org_id = ? AND project_id = ?").bind(actor.orgId, project.project_id).all<{ mount_name: string; resource_id: string }>().then((r) => r.results)) {
      if (!writes.has(m.mount_name) && (await canReadResource(svc, actor, m.resource_id))) reads.add(m.mount_name);
    }
  }
  // I-6: agents never get canonical tokens; reference mounts are read-only copies in -tasks
  const refs: Array<{ mountName: string; resourceId: string }> = [];
  for (const name of reads) {
    const m = await getMount(svc.db, actor.orgId, project.project_id, name);
    if (!m || !(await canReadResource(svc, actor, m.resource_id))) throw notFound(`mount ${name} not found`);
    const r = await getResource(svc.db, actor.orgId, m.resource_id);
    if (r?.provider === "artifacts" && r.state === "active") refs.push({ mountName: m.mount_name, resourceId: r.resource_id });
  }
  // the staging build the task is seeded from is recorded (`tasks.staging_build_id`): a revision's landing builds on its landings
  const seed = input.baseRevisions ? { buildId: null, bases: input.baseRevisions } : await stagingBases(svc, project);
  const baseRevisions = seed.bases;
  const snapshot = await projectSnapshot(svc, project, { writeMounts: writes, onlyMounts: new Set([...writes, ...reads]), ...(baseRevisions.size ? { baseRevisions } : {}) });
  const unversioned = targets.filter((t) => !snapshot.entries.some((e) => e.resourceId === t.resourceId));
  const first = unversioned[0];
  if (first && (chosen || unversioned.length === targets.length)) throw conflict("no_accepted_head", `mount ${first.mountName} has no accepted version`);
  // defaulted: a folder with no first version yet is left out (it is not in the snapshot either)
  for (const t of unversioned) {
    targets.splice(targets.indexOf(t), 1);
    writes.delete(t.mountName);
  }

  const taskId = `task-${crypto.randomUUID()}`;
  const changeId = newChangeId();
  const now = svc.nowIso();
  const stmts = [
    svc.db
      .prepare("INSERT INTO tasks (task_id, org_id, project_id, change_id, title, request, state, snapshot_json, created_by, created_at, updated_at, revises_task_id, staging_build_id) VALUES (?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?)")
      .bind(taskId, actor.orgId, project.project_id, changeId, input.title, input.request, JSON.stringify(snapshot), actor.userId, now, now, input.revisesTaskId ?? null, seed.buildId),
  ];
  const all = [
    ...targets.map((t) => ({ ...t, access: "write" as const })),
    ...refs.filter((r) => snapshot.entries.some((e) => e.resourceId === r.resourceId)).map((r) => ({ ...r, provider: "artifacts" as const, access: "read" as const })),
  ];
  for (const t of all) {
    const entry = snapshot.entries.find((e) => e.resourceId === t.resourceId)!;
    stmts.push(
      svc.db
        .prepare(
          "INSERT INTO task_workspaces (task_workspace_id, task_id, org_id, resource_id, mount_name, provider, access, base_revision, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        // asset workspaces are R2 staging areas: writable at once
        .bind(taskWorkspaceIdFor(taskId, t.resourceId), taskId, actor.orgId, t.resourceId, t.mountName, t.provider, t.access, entry.revisionId, t.provider === "artifacts" ? "provisioning" : "writable", now, now),
    );
  }
  await svc.db.batch(stmts);
  for (const t of all) if (t.provider === "artifacts") await enqueueStep(svc, { type: "workspace.create", orgId: actor.orgId, taskWorkspaceId: taskWorkspaceIdFor(taskId, t.resourceId) });
  if (all.every((t) => t.provider !== "artifacts")) await setTaskState(svc, taskId, "ready");
  await recordEvent(svc, {
    orgId: actor.orgId,
    projectId: project.project_id,
    actor: userRef(actor.userId),
    action: "task.created",
    subjectKind: "task",
    subjectId: taskId,
    resourceIds: snapshot.entries.map((e) => e.resourceId),
    detail: { title: input.title, writeMounts: [...writes], ...(input.revisesTaskId ? { revisesTaskId: input.revisesTaskId } : {}) },
  });
  return (await getTask(svc, taskId))!;
}
