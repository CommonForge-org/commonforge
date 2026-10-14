/**
 * Tasks and task workspaces (plan §B.4).
 *
 * One task workspace per (task, written resource): Artifacts resources get a fresh `-tasks` repo
 * seeded at the pinned base (provider `createIsolatedChange`, run in a queue step serialized per
 * workspace id); asset resources get an R2 staging area (no repo). The workspace id is
 * deterministic per (task, resource), so a retried step adopts the earlier attempt's repo.
 */
import { changeId as toChangeId, sha256HexSync, type ProjectSnapshot, type TaskWorkspaceHandle } from "@commonforge-org/core";
import type { Services } from "../context.js";
import { getResource } from "./directory.js";
import { recordEvent, userRef } from "./events.js";
import { resourceRef } from "./resources.js";
import { runnerSubmit } from "./runner-jobs.js";
import { onStep, onStepFailed } from "./steps.js";
import { chaos } from "../chaos.js";

export const DEFAULT_LEASE_SECONDS = 3600;
export const MAX_LEASE_SECONDS = 8 * 3600;
export const PROVISION_LOCK_MS = 180_000;

export type TaskState = "provisioning" | "ready" | "running" | "submitted" | "failed" | "canceled";
export type WorkspaceState = "provisioning" | "writable" | "freezing" | "frozen" | "failed" | "abandoned" | "collected";

export interface TaskRow {
  task_id: string;
  org_id: string;
  project_id: string;
  change_id: string;
  title: string;
  request: string;
  state: TaskState;
  snapshot_json: string;
  created_by: string;
  lease_hash: string | null;
  lease_generation: number;
  lease_expires_at: number | null;
  lease_holder: string | null;
  created_at: string;
  updated_at: string;
  /** the task this one revises (staging phase 2, R6: its proposal joins that task's landing) */
  revises_task_id?: string | null;
  /** the staging build the task was seeded from (null: from the heads) */
  staging_build_id?: string | null;
}

export interface WorkspaceRow {
  task_workspace_id: string;
  task_id: string;
  org_id: string;
  resource_id: string;
  mount_name: string;
  provider: "artifacts" | "r2-assets";
  access: "write" | "read";
  base_revision: string;
  state: WorkspaceState;
  attempts: number;
  error: string | null;
  asset_manifest_id: string | null;
  created_at: string;
  updated_at: string;
}

export const taskSnapshot = (t: TaskRow) => JSON.parse(t.snapshot_json) as ProjectSnapshot;

/** Deterministic per (task, resource): retries adopt the same repo (provider R-1). */
export function taskWorkspaceIdFor(taskId: string, resourceId: string): string {
  return `tw-${sha256HexSync(`cf.task-workspace/1|${taskId}|${resourceId}`).slice(0, 24)}`;
}

export const newChangeId = () => toChangeId(`chg-${crypto.randomUUID()}`);

export async function getTask(svc: Services, taskId: string): Promise<TaskRow | null> {
  return svc.db.prepare("SELECT * FROM tasks WHERE task_id = ?").bind(taskId).first<TaskRow>();
}

export async function listWorkspaces(svc: Services, taskId: string): Promise<WorkspaceRow[]> {
  return (await svc.db.prepare("SELECT * FROM task_workspaces WHERE task_id = ? ORDER BY mount_name").bind(taskId).all<WorkspaceRow>()).results;
}

export async function getWorkspaceRow(svc: Services, taskWorkspaceId: string): Promise<WorkspaceRow | null> {
  return svc.db.prepare("SELECT * FROM task_workspaces WHERE task_workspace_id = ?").bind(taskWorkspaceId).first<WorkspaceRow>();
}

export async function setWorkspaceState(svc: Services, id: string, state: WorkspaceState, extra: { error?: string | null; from?: WorkspaceState } = {}): Promise<boolean> {
  const r = await svc.db
    .prepare(`UPDATE task_workspaces SET state = ?, error = ?, updated_at = ? WHERE task_workspace_id = ?${extra.from ? " AND state = ?" : ""}`)
    .bind(state, extra.error ?? null, svc.nowIso(), id, ...(extra.from ? [extra.from] : []))
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function setTaskState(svc: Services, taskId: string, state: TaskState): Promise<void> {
  await svc.db.prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE task_id = ?").bind(state, svc.nowIso(), taskId).run();
}

/** After a workspace changed state: ready when every workspace is writable; failed when one failed. */
export async function refreshTaskState(svc: Services, taskId: string): Promise<void> {
  const task = await getTask(svc, taskId);
  if (!task) return;
  const ws = await listWorkspaces(svc, taskId);
  if (ws.some((w) => w.state === "failed")) {
    await setTaskState(svc, taskId, "failed");
    return markReferenceCopiesAbandoned(svc, task.org_id, ws);
  }
  if (task.state === "provisioning" && ws.every((w) => w.state === "writable")) return setTaskState(svc, taskId, "ready");
  const writes = ws.filter((w) => w.access === "write");
  if (task.state === "running" && writes.length > 0 && writes.every((w) => w.state === "frozen")) {
    await setTaskState(svc, taskId, "submitted");
    await collectReferenceWorkspaces(svc, task.org_id, ws);
  }
}

/**
 * Read-only reference copies are only needed while the task runs: once it is submitted they are
 * abandoned and deleted (best effort; Task 17 GC sweeps leftovers).
 */
export async function collectReferenceWorkspaces(svc: Services, orgId: string, ws: WorkspaceRow[]): Promise<void> {
  const ledger = svc.ledger(orgId);
  for (const w of ws) {
    if (w.access !== "read" || w.state !== "writable") continue;
    try {
      const handle = await ledger.getWorkspace(w.task_workspace_id);
      if (handle) {
        await ledger.putWorkspace(orgId, { ...handle, state: "abandoned" });
        await svc.provider().collectWorkspace({ ...handle, state: "abandoned" });
        await ledger.putWorkspace(orgId, { ...handle, state: "collected" });
      }
      await setWorkspaceState(svc, w.task_workspace_id, "collected", { from: "writable" });
    } catch (e) {
      console.warn(`reference workspace ${w.task_workspace_id} not collected: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Queue step `workspace.create`: create + seed the task repo, record the handle in the ledger. */
onStep("workspace.create", async (svc, msg) => {
  const row = await getWorkspaceRow(svc, msg.taskWorkspaceId);
  if (!row || row.state !== "provisioning") return { done: true };
  const task = await getTask(svc, row.task_id);
  const resource = await getResource(svc.db, row.org_id, row.resource_id);
  if (!task || !resource) return { done: true };
  const locked = await svc.gate.withLock("workspace", row.task_workspace_id, PROVISION_LOCK_MS, async () => {
    const again = await getWorkspaceRow(svc, row.task_workspace_id);
    if (!again || again.state !== "provisioning") return;
    await svc.db.prepare("UPDATE task_workspaces SET attempts = attempts + 1 WHERE task_workspace_id = ?").bind(row.task_workspace_id).run();
    const provider = svc.provider(runnerSubmit(svc, row.org_id, `workspace:${row.task_workspace_id}`));
    const handle: TaskWorkspaceHandle = await provider.createIsolatedChange({
      resource: resourceRef(resource),
      baseRevision: row.base_revision as TaskWorkspaceHandle["baseRevision"],
      taskId: task.task_id as never,
      organizationId: row.org_id as never,
      changeId: task.change_id as never,
      purpose: "agent-task",
      taskWorkspaceId: row.task_workspace_id,
    });
    // chaos (G.5): the Worker dies here and the step message is lost; the GC sweep must collect the repo
    if (chaos(svc.env, "after_fork_before_record", row.task_workspace_id)) return;
    await svc.ledger(row.org_id).putWorkspace(row.org_id, handle);
    await setWorkspaceState(svc, row.task_workspace_id, "writable", { from: "provisioning" });
    await recordEvent(svc, {
      orgId: row.org_id,
      projectId: task.project_id,
      actor: userRef(task.created_by),
      action: "workspace.provisioned",
      subjectKind: "workspace",
      subjectId: row.task_workspace_id,
      resourceIds: [row.resource_id],
      detail: { taskId: task.task_id, mountName: row.mount_name },
    });
    await refreshTaskState(svc, task.task_id);
  });
  if (locked.locked) return { retry: true, delaySeconds: 5, reason: "another step is provisioning this workspace" };
  return { done: true };
});

onStepFailed("workspace.create", async (svc, msg, reason) => {
  const row = await getWorkspaceRow(svc, msg.taskWorkspaceId);
  if (!row || row.state !== "provisioning") return;
  await setWorkspaceState(svc, row.task_workspace_id, "failed", { error: reason.slice(0, 500), from: "provisioning" });
  await refreshTaskState(svc, row.task_id);
});

export async function revokeWorkspaceWriteTokens(svc: Services, orgId: string, ws: WorkspaceRow[], scopes: ReadonlyArray<"read" | "write"> = ["write"]): Promise<void> {
  for (const w of ws) {
    // collected reference copies are deleted repositories: nothing left to revoke (releasing a
    // lease after the last freeze must succeed)
    if (w.provider !== "artifacts" || w.state === "provisioning" || w.state === "collected") continue;
    const handle = await svc.ledger(orgId).getWorkspace(w.task_workspace_id);
    if (!handle) continue;
    let tokens;
    try {
      tokens = await svc.transport.listTokens(handle.coords.namespace, handle.coords.repoName);
    } catch (e) {
      if ((e as { code?: string })?.code === "not_found") continue; // already deleted (GC, abandoned copy)
      throw e;
    }
    for (const t of tokens) {
      if (t.state === "active" && scopes.includes(t.scope)) await svc.transport.revokeToken(handle.coords.namespace, handle.coords.repoName, t.id);
    }
  }
}

/**
 * Lease loss (M-3, §F "Token leakage"): when a member is removed or demoted, or loses a grant, end
 * every lease they hold in the org and revoke **every** token (write and read, N-3) minted on those
 * tasks' repos, reference copies included.
 */
export async function revokeUserLeases(svc: Services, orgId: string, userId: string): Promise<number> {
  const rows = await svc.db
    .prepare("SELECT task_id FROM tasks WHERE org_id = ? AND lease_holder = ? AND lease_hash IS NOT NULL")
    .bind(orgId, userId)
    .all<{ task_id: string }>();
  for (const r of rows.results) {
    await svc.db
      .prepare("UPDATE tasks SET lease_hash = NULL, lease_expires_at = NULL, lease_generation = lease_generation + 1, updated_at = ? WHERE task_id = ?")
      .bind(svc.nowIso(), r.task_id)
      .run();
    await revokeWorkspaceWriteTokens(svc, orgId, await listWorkspaces(svc, r.task_id), ["read", "write"]);
  }
  return rows.results.length;
}

/**
 * N-4: a task that will never be submitted (failed) leaves its read-only reference copies as
 * `abandoned` (D1 and ledger) so the Task 17 GC sweep collects them. Lease expiry without a
 * submission is found by that sweep itself (tasks `running` with an expired lease).
 */
export async function markReferenceCopiesAbandoned(svc: Services, orgId: string, ws: WorkspaceRow[]): Promise<void> {
  const ledger = svc.ledger(orgId);
  for (const w of ws) {
    if (w.access !== "read" || w.state !== "writable") continue;
    try {
      const handle = await ledger.getWorkspace(w.task_workspace_id);
      if (handle && handle.state === "writable") await ledger.putWorkspace(orgId, { ...handle, state: "abandoned" });
      await setWorkspaceState(svc, w.task_workspace_id, "abandoned", { from: "writable" });
    } catch (e) {
      console.warn(`reference workspace ${w.task_workspace_id} not marked: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
