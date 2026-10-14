/**
 * Candidate freeze (plan §B.5) and candidate reads.
 *
 * Freeze: the workspace is first marked `freezing` (the provider's workspace resolver then reports
 * it frozen, so no new write token can be minted), then `freezeCandidate` checks the branch HEAD
 * against `expectedSha`, revokes every write token, re-reads HEAD and computes `changedPaths`
 * (never trusted from input). On success the ledger records the frozen candidate and the workspace
 * as frozen, and a queue step prepares the candidate. On failure the workspace is writable again.
 */
import { GitShaSchema, type FrozenCandidate } from "@commonforge-org/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Services } from "../context.js";
import { conflict, forbidden, notFound, readJson } from "../lib/http.js";
import { canSeeTask, canWriteTaskResource, isDeveloper, orgActor, readableResource, seesCanonical, taskActor } from "../middleware/authz.js";
import { agentRef, recordEvent, userRef } from "../services/events.js";
import { isStagingProject } from "../services/staging-state.js";
import { enqueueStep } from "../services/steps.js";
import { getTask, getWorkspaceRow, refreshTaskState, setWorkspaceState, type TaskRow } from "../services/tasks.js";
import "../services/candidates.js";

export const candidateRoutes = new Hono<AppEnv>();

/** Staging mode (spec 2026-10-07 §4): a task that just became `submitted` lands in staging. */
async function landIfStaging(svc: Services, task: TaskRow): Promise<void> {
  const now = await getTask(svc, task.task_id);
  if (now?.state === "submitted" && (await isStagingProject(svc, now.org_id, now.project_id))) await enqueueStep(svc, { type: "staging.land", orgId: now.org_id, taskId: now.task_id });
}

/** `fork` (task repo coordinates) only for owners and the task's own agent/assignee (I-1). */
export function presentCandidate(c: FrozenCandidate, state: string, preparedReceiptId: string | null, canonical: boolean) {
  const { fork, ...rest } = c;
  return { ...rest, state, preparedReceiptId, ...(canonical ? { fork } : {}) };
}

candidateRoutes.post("/tasks/:id/workspaces/:ws/freeze", async (c) => {
  const svc = c.get("svc");
  const task = await getTask(svc, c.req.param("id"));
  if (!task) throw notFound("task not found");
  const actor = await taskActor(c, task);
  // staging mode: a client freezes their own task (their agent is admitted by `taskActor`, the
  // client's session by `canSeeTask` plus the lease-holder rule below)
  if (!isDeveloper(actor.role) && actor.role !== "client") throw notFound("task not found");
  // provider errors (their text can name the task repo) reach a client or their agent as a plain message
  c.set("plainProviderErrors", !isDeveloper(actor.role));
  if (!actor.agent) {
    if (!(await canSeeTask(svc, actor, task))) throw notFound("task not found");
    // I-1: only the task's agent, its assignee (current lease holder) or an owner may freeze
    const assignee = task.lease_holder === actor.userId && (task.lease_expires_at ?? 0) > svc.now().getTime();
    if (actor.role !== "owner" && !assignee) throw forbidden("not_task_assignee", "only the task's agent, its lease holder or an owner may freeze");
  }
  const body = await readJson(c, z.object({ expectedSha: GitShaSchema.optional(), tool: z.string().max(256).optional() }));
  const ws = await getWorkspaceRow(svc, c.req.param("ws"));
  if (!ws || ws.task_id !== task.task_id) throw notFound("workspace not found");
  if (ws.access !== "write") throw conflict("workspace_read_only", "reference copies are never frozen");
  if (!actor.agent && !(await canWriteTaskResource(svc, actor, task, ws.mount_name, ws.resource_id))) throw forbidden("no_write_grant", "no write grant on this resource");
  const principal = actor.agent ? agentRef(task.task_id, actor.userId) : userRef(actor.userId);

  if (ws.provider === "r2-assets") {
    if (!ws.asset_manifest_id) throw conflict("nothing_to_freeze", "commit asset changes first");
    if (!(await setWorkspaceState(svc, ws.task_workspace_id, "frozen", { from: "writable" }))) throw conflict("workspace_not_writable", `workspace is ${ws.state}`);
    await recordEvent(svc, { orgId: task.org_id, projectId: task.project_id, actor: principal, action: "task.candidate_frozen", subjectKind: "workspace", subjectId: ws.task_workspace_id, resourceIds: [ws.resource_id], detail: { taskId: task.task_id, manifestId: ws.asset_manifest_id } });
    await refreshTaskState(svc, task.task_id);
    await landIfStaging(svc, task);
    return c.json({ taskWorkspaceId: ws.task_workspace_id, state: "frozen", manifestId: ws.asset_manifest_id });
  }

  if (!body.expectedSha) throw conflict("expected_sha_required", "expectedSha (the commit you pushed) is required");
  // stop new mints before freezing (the resolver reports `freezing` as frozen)
  if (!(await setWorkspaceState(svc, ws.task_workspace_id, "freezing", { from: "writable" }))) throw conflict("workspace_not_writable", `workspace is ${ws.state}`);
  const ledger = svc.ledger(task.org_id);
  let candidate: FrozenCandidate;
  try {
    const handle = await ledger.getWorkspace(ws.task_workspace_id);
    if (!handle) throw conflict("workspace_not_ready", "workspace is not recorded in the ledger");
    candidate = await svc.provider().freezeCandidate(handle, { expectedSha: body.expectedSha, submitter: principal, ...(body.tool ? { tool: body.tool } : {}) });
  } catch (e) {
    await setWorkspaceState(svc, ws.task_workspace_id, "writable", { from: "freezing" });
    throw e;
  }
  const now = svc.nowIso();
  const handle = (await ledger.getWorkspace(ws.task_workspace_id))!;
  await ledger.putCandidate(task.org_id, { candidate, state: "frozen", preparedReceiptId: null, updatedAt: now });
  await ledger.putWorkspace(task.org_id, { ...handle, state: "frozen" });
  await setWorkspaceState(svc, ws.task_workspace_id, "frozen", { from: "freezing" });
  await svc.db
    .prepare("INSERT OR IGNORE INTO task_candidates (candidate_id, task_id, org_id, resource_id, task_workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(candidate.candidateId, task.task_id, task.org_id, candidate.resourceId, ws.task_workspace_id, now)
    .run();
  await enqueueStep(svc, { type: "candidate.prepare", orgId: task.org_id, candidateId: candidate.candidateId });
  await recordEvent(svc, { orgId: task.org_id, projectId: task.project_id, actor: principal, action: "task.candidate_frozen", subjectKind: "candidate", subjectId: candidate.candidateId, resourceIds: [candidate.resourceId], detail: { taskId: task.task_id, sha: candidate.sha, changedPaths: candidate.changedPaths.length } });
  await refreshTaskState(svc, task.task_id);
  await landIfStaging(svc, task);
  // the task fork's coordinates: never in a client's own session response (their agent gets them)
  return c.json(presentCandidate(candidate, "frozen", null, actor.agent || seesCanonical(actor.role)), 201);
});

candidateRoutes.get("/orgs/:org/resources/:rid/candidates", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const r = await readableResource(svc, actor, c.req.param("rid"));
  const list = await svc.ledger(actor.orgId).listCandidates(r.resource_id);
  return c.json({ candidates: list.map((x) => presentCandidate(x.candidate, x.state, x.preparedReceiptId, actor.role === "owner")) });
});

candidateRoutes.get("/orgs/:org/candidates/:cid", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const rec = await svc.ledger(actor.orgId).getCandidate(c.req.param("cid"));
  if (!rec) throw notFound("candidate not found");
  await readableResource(svc, actor, rec.candidate.resourceId);
  return c.json(presentCandidate(rec.candidate, rec.state, rec.preparedReceiptId, actor.role === "owner"));
});
