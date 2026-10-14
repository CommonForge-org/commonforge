/**
 * Capability broker (plan §B.4, §B.8, §F "Canonical source mutation", "Token leakage").
 *
 * Runners: `POST /api/runner/credential` presents a `SignedJob`. The broker verifies it
 * (`verifySignedJob`), requires the job to be ours and still open, asks `authorizeCredentialRequest`
 * whether the job names that exact repository with that access (canonical **write** only for
 * prepare-candidate / integrate / reconcile-ref), checks the repo against the live server record
 * (id and remote URL, namespace of the job's org), and mints a token whose TTL never outlives the
 * job (`<= expiresAt`, <= 1 h). It returns the job's coordinates, never the request's.
 *
 * Agents: `POST /api/tasks/:id/credential` ({@link issueAgentCredential}) — task lease + resource grant →
 * `issueWorkspaceCredential` for the task's own `-tasks` copies (writable copy or read-only reference
 * copy); never a canonical token. A client's own session never gets any credential. Staging mode
 * (spec 2026-10-07 §4): the agent of a client's own task (lease holder = creator, project in staging
 * mode, checked by `taskActor`) may receive its own task fork's credentials (`-tasks`, write, per
 * `canStageWrite`) and read tokens on its reference copies; it still never receives canonical
 * credentials.
 */
import type { WorkspaceCredential } from "@commonforge-org/core";
import { RunnerCredentialRequestSchema, authorizeCredentialRequest, type RunnerCredentialResponse } from "@commonforge-org/runner-protocol";
import { parseNamespace } from "@commonforge-org/provider-cloudflare";
import type { Principal, Services } from "../context.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/http.js";
import { canReadResource, canWriteTaskResource, type OrgActor } from "../middleware/authz.js";
import { getResource, resourceCoords } from "./directory.js";
import { agentRef, recordEvent } from "./events.js";
import { verifyPresentedJob } from "./runner-jobs.js";
import { listWorkspaces, taskSnapshot, type TaskRow } from "./tasks.js";

export const MAX_RUNNER_TOKEN_SECONDS = 3600;
export const MIN_TOKEN_SECONDS = 60;
export const MAX_AGENT_TOKEN_SECONDS = 3600;

export async function issueRunnerCredential(svc: Services, body: unknown): Promise<RunnerCredentialResponse> {
  const raw = (body ?? {}) as { signedJob?: unknown; repo?: unknown; access?: unknown };
  const { signedJob, row } = await verifyPresentedJob(svc, raw.signedJob);
  const req = RunnerCredentialRequestSchema.safeParse({ signedJob, repo: raw.repo, access: raw.access });
  if (!req.success) throw badRequest("invalid_request", req.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  if (row.status !== "queued") throw conflict("job_finished", "the job already reported its result; no further credentials");

  const auth = authorizeCredentialRequest({ job: signedJob.job }, { repo: req.data.repo, access: req.data.access });
  if (!auth.ok) throw forbidden(auth.reason, auth.detail);
  const coords = auth.coords;
  if (coords.kind !== "artifacts") throw forbidden("repo_not_in_job", "only Artifacts repositories are brokered here");
  const ns = parseNamespace(svc.env.COMMONFORGE_NAMESPACE_PREFIX, coords.namespace);
  if (!ns || ns.organizationId !== row.org_id) throw forbidden("namespace_role_mismatch", "repository is outside the job's organization");

  // the job's coordinates must still be the live repository (recreated repo / tampered URL → refuse)
  const info = await svc.transport.getRepo(coords.namespace, coords.repoName);
  if (!info || info.id !== coords.repoId || info.remote !== coords.remoteUrl) throw forbidden("identity_mismatch", "repository identity does not match the server record");

  const remaining = Math.floor((Date.parse(signedJob.expiresAt) - svc.now().getTime()) / 1000);
  const ttl = Math.min(MAX_RUNNER_TOKEN_SECONDS, remaining);
  if (ttl < MIN_TOKEN_SECONDS) throw new ApiError(409, "job_expiring", "the job expires in less than 60 s; no credential issued");
  const t = await svc.transport.createToken(coords.namespace, coords.repoName, auth.access, ttl);
  await svc.db
    .prepare("INSERT INTO runner_job_tokens (job_id, namespace, repo_name, token_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.job_id, coords.namespace, coords.repoName, t.id, svc.now().getTime())
    .run();
  return { token: t.plaintext, tokenId: t.id, expiresAt: new Date(t.expiresAt).toISOString(), remoteUrl: coords.remoteUrl };
}

/** `POST <credentialBroker>/revoke`: revoke a token this job was given (only that job's tokens). */
export async function revokeRunnerCredential(svc: Services, signedJobValue: unknown, tokenId: string): Promise<void> {
  // an expired job may still clean up its tokens
  const { row } = await verifyPresentedJob(svc, signedJobValue, { allowExpired: true });
  const t = await svc.db
    .prepare("SELECT namespace, repo_name FROM runner_job_tokens WHERE job_id = ? AND token_id = ?")
    .bind(row.job_id, tokenId)
    .first<{ namespace: string; repo_name: string }>();
  if (!t) throw notFound("token not issued for this job");
  await svc.transport.revokeToken(t.namespace, t.repo_name, tokenId);
}

/**
 * Agent credentials (`POST /api/tasks/:id/credential`). The caller holds the current task lease
 * (checked by the auth middleware: the lease token resolves only while current and unexpired); the
 * lease holder's grant on the resource is re-checked now. Written mounts → a token for the task's
 * own `-tasks` repo via `issueWorkspaceCredential` (refuses canonical namespaces, non-writable
 * workspaces and stale lease generations); reference mounts → a **read** token on the task's read-only
 * reference copy in `-tasks` (seeded at the pinned sha). Agents never get canonical tokens (§F row 1).
 * TTL ≤ min(1 h, lease remaining); under 60 s left → refused.
 */
export async function issueAgentCredential(
  svc: Services,
  task: TaskRow,
  actor: OrgActor,
  p: Extract<Principal, { kind: "agent" }>,
  body: { mountName: string; access: "read" | "write" },
): Promise<WorkspaceCredential> {
  if (task.state !== "running") throw conflict("task_not_running", `task is ${task.state}`);
  const snapshot = taskSnapshot(task);
  const entry = snapshot.entries.find((e) => e.mountName === body.mountName);
  if (!entry) throw notFound("mount not in this task");
  const resource = await getResource(svc.db, task.org_id, entry.resourceId);
  if (!resource || !(await canReadResource(svc, actor, entry.resourceId))) throw notFound("mount not in this task");
  if (resource.provider !== "artifacts") throw badRequest("not_git", "asset mounts are written through /assets, not git");
  const leaseRemaining = Math.floor((p.leaseExpiresAt - svc.now().getTime()) / 1000);
  const ttl = Math.min(MAX_AGENT_TOKEN_SECONDS, leaseRemaining);
  const ws = (await listWorkspaces(svc, task.task_id)).find((w) => w.resource_id === entry.resourceId);

  if (!ws || ws.provider !== "artifacts") throw conflict("mount_not_materialized", "this mount has no task copy");
  if (body.access === "write" && ws.access !== "write") throw forbidden("read_only_mount", "reference mounts are read-only copies");
  if (body.access === "write" && !(await canWriteTaskResource(svc, actor, task, entry.mountName, entry.resourceId))) throw forbidden("no_write_grant", "the lease holder has no write grant on this resource");
  if (ttl < MIN_TOKEN_SECONDS) throw conflict("lease_too_short", "the lease has less than 60 s left");
  const handle = await svc.ledger(task.org_id).getWorkspace(ws.task_workspace_id);
  if (!handle || ws.state === "provisioning") throw conflict("workspace_not_ready", `workspace is ${ws.state}`);
  // only ever a token for the task's own -tasks repo (the provider refuses canonical namespaces)
  const cred = await svc.provider().issueWorkspaceCredential(handle, {
    principal: agentRef(task.task_id, actor.userId),
    operations: body.access === "write" ? ["read", "write"] : ["read"],
    ttlSeconds: ttl,
    leaseGeneration: p.leaseGeneration,
    leaseExpiresAt: new Date(p.leaseExpiresAt).toISOString() as never,
  });
  await recordEvent(svc, { orgId: task.org_id, projectId: task.project_id, actor: agentRef(task.task_id, actor.userId), action: "credential.issued", subjectKind: "workspace", subjectId: ws.task_workspace_id, resourceIds: [ws.resource_id], detail: { scope: cred.scope, expiresAt: cred.expiresAt, tokenId: cred.tokenId, reference: ws.access === "read" } });
  return cred;
}
