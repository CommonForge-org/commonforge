/**
 * Runner job lifecycle on the Worker side (plan §B.8).
 *
 * - `issueJob` signs a `SignedJob` (runner-protocol `signJob`, key `COMMONFORGE_RUNNER_JOB_KEY`),
 *   records it in D1 and enqueues it to `commonforge-runner-jobs`.
 * - `runnerSubmit` is the `RunnerSubmit` the providers use: issue (or join an identical open job),
 *   then poll D1 until the runner posts the result to `POST /api/runner/results`. A step that times
 *   out throws {@link RunnerPendingError}; the queue retries it and joins the same open job.
 * - Results are verified (job signature, receipt shape, evidence HMAC with the per-job derived key),
 *   applied once per `jobId` (a different second result is a conflict), and the job's minted
 *   tokens are revoked.
 */
import {
  canonicalJson,
  sha256Hex,
  type RunnerJobKind,
  type RunnerOutcome,
  type RunnerSubmit,
} from "@commonforge-org/core";
import {
  defaultMaxLifetimeSeconds,
  parseRunnerResultForJob,
  signJob,
  verifyEvidence,
  verifySignedJob,
  type IntegrationJob,
  type IntegrationJobInput,
  type IntegrationJobKind,
  type JobKeyring,
  type RunnerResult,
  type SignedJob,
} from "@commonforge-org/runner-protocol";
import { ArtifactsProviderError } from "@commonforge-org/provider-cloudflare";
import type { Services } from "../context.js";
import { newId } from "../lib/crypto.js";
import { ApiError, badRequest, conflict } from "../lib/http.js";
import { ChaosCrash, chaos } from "../chaos.js";
import { isLocalHostname } from "../lib/local-host.js";

/** Results may arrive this long after `expiresAt` (a job that finished right at its deadline). */
export const RESULT_GRACE_MS = 15 * 60_000;

/**
 * The runner has not answered yet. An `ArtifactsProviderError('provider_unavailable')` so providers
 * rethrow it unchanged and the step queue treats it as transient (retry joins the same open job).
 */
export class RunnerPendingError extends ArtifactsProviderError {
  constructor(readonly jobId: string) {
    super("provider_unavailable", `runner_pending: job ${jobId} has no result yet`, { jobId });
  }
}

export interface RunnerJobRow {
  job_id: string;
  org_id: string;
  kind: IntegrationJobKind;
  job_key: string;
  subject: string | null;
  signed_json: string;
  status: "queued" | "succeeded" | "failed";
  result_json: string | null;
  result_hash: string | null;
  issued_at: number;
  expires_at: number;
  completed_at: number | null;
}

export const keyring = (svc: Services): JobKeyring => [svc.jobKey()];

/** `credentialBroker` inside signed jobs; `COMMONFORGE_PUBLIC_URL` must be configured (M-13). */
export function brokerUrl(svc: Services): string {
  const base = (svc.env.COMMONFORGE_PUBLIC_URL ?? "").replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new ApiError(503, "config_missing", "COMMONFORGE_PUBLIC_URL is not configured");
  }
  const local = isLocalHostname(u.hostname);
  if (u.protocol !== "https:" && !local) throw new ApiError(503, "config_invalid", "COMMONFORGE_PUBLIC_URL must be https");
  return `${base}/api/runner/credential`;
}

export interface IssueOptions {
  orgId: string;
  /** e.g. `intake:<id>`, `proposal:<id>` — used to find jobs for a subject */
  subject?: string;
  lifetimeSeconds?: number;
  /** dedupe key (default: hash of the job body) */
  jobKey?: string;
  /** runs after the job is recorded and before it is enqueued (link the job id to its subject first) */
  beforeEnqueue?: (jobId: string) => Promise<void>;
}

/** Sign, record and enqueue a job. `job` may be built from the jobId (integrate binds its ref to it). */
export async function issueJob(svc: Services, job: IntegrationJobInput | ((jobId: string) => IntegrationJobInput), opts: IssueOptions): Promise<SignedJob> {
  const jobId = newId("job", 12);
  const body = typeof job === "function" ? job(jobId) : job;
  const now = svc.now().getTime();
  // chaos (G.5): the job expires 1 s after issue; the broker refuses it, a late result is rejected
  const lifetime = chaos(svc.env, "runner_job_expiry", body.kind) ? 1 : Math.min(opts.lifetimeSeconds ?? 3600, defaultMaxLifetimeSeconds(body.kind));
  const signed = await signJob(
    {
      job: body,
      jobId,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + lifetime * 1000).toISOString(),
      credentialBroker: brokerUrl(svc),
    },
    svc.jobKey(),
  );
  const key = opts.jobKey ?? (await sha256Hex(canonicalJson(body)));
  await svc.db
    .prepare("INSERT INTO runner_jobs (job_id, org_id, kind, job_key, subject, signed_json, status, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)")
    .bind(jobId, opts.orgId, body.kind, key, opts.subject ?? null, JSON.stringify(signed), now, now + lifetime * 1000)
    .run();
  if (opts.beforeEnqueue) await opts.beforeEnqueue(jobId);
  await svc.deps.runnerQueue(svc.env).send({ signedJob: signed });
  return signed;
}

export async function getJob(svc: Services, jobId: string): Promise<RunnerJobRow | null> {
  return svc.db.prepare("SELECT * FROM runner_jobs WHERE job_id = ?").bind(jobId).first<RunnerJobRow>();
}

function toOutcome<K extends RunnerJobKind>(row: RunnerJobRow): RunnerOutcome<never> | null {
  if (row.status === "queued" || !row.result_json) return null;
  const r = JSON.parse(row.result_json) as RunnerResult;
  return (r.ok ? { jobId: r.jobId, ok: true, receipt: r.receipt } : { jobId: r.jobId, ok: false, code: r.code, detail: r.detail, ...(r.evidence ? { evidence: r.evidence } : {}) }) as RunnerOutcome<never> & { _k?: K };
}

/**
 * `RunnerSubmit` for steps: joins an identical open (or already succeeded) job instead of issuing
 * a duplicate, then waits for its result. Throws {@link RunnerPendingError} on timeout.
 *
 * `opts.keySalt` scopes the join to one logical operation (e.g. one outbox event): a job body that
 * recurs for a *different* operation (reconcile X→T, restore, reconcile X→T again) must not reuse
 * the earlier, already succeeded job's result.
 */
export function runnerSubmit(svc: Services, orgId: string, subject?: string, opts: { keySalt?: string } = {}): RunnerSubmit {
  return (async (jobReq: { kind: RunnerJobKind }) => {
    const key = await sha256Hex(canonicalJson(opts.keySalt === undefined ? jobReq : { salt: opts.keySalt, job: jobReq }));
    const now = svc.now().getTime();
    let row = await svc.db
      .prepare("SELECT * FROM runner_jobs WHERE org_id = ? AND job_key = ? ORDER BY issued_at DESC LIMIT 1")
      .bind(orgId, key)
      .first<RunnerJobRow>();
    const reusable = row && (row.status === "succeeded" || (row.status === "queued" && row.expires_at > now));
    let jobId = reusable ? row!.job_id : (await issueJob(svc, jobReq as IntegrationJobInput, { orgId, ...(subject ? { subject } : {}), jobKey: key })).jobId;
    const { pollMs, timeoutMs } = svc.deps.runnerWait;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      row = await getJob(svc, jobId);
      const outcome = row ? toOutcome(row) : null;
      if (outcome) return outcome;
      if (Date.now() >= deadline) throw new RunnerPendingError(jobId);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }) as RunnerSubmit;
}

/** Verify a SignedJob presented by the runner and load our record of it. */
export async function verifyPresentedJob(
  svc: Services,
  value: unknown,
  opts: { allowExpired?: boolean; allowedKinds?: readonly IntegrationJobKind[] } = {},
): Promise<{ signedJob: SignedJob; row: RunnerJobRow }> {
  let now = svc.now().getTime();
  if (opts.allowExpired && value && typeof value === "object" && typeof (value as { expiresAt?: unknown }).expiresAt === "string") {
    const exp = Date.parse((value as { expiresAt: string }).expiresAt);
    if (Number.isFinite(exp) && now > exp && now <= exp + RESULT_GRACE_MS) now = exp - 1;
  }
  const v = await verifySignedJob(value, keyring(svc), { now, ...(opts.allowedKinds ? { allowedKinds: opts.allowedKinds } : {}) });
  if (!v.ok) throw new ApiError(v.reason === "expired" ? 410 : 403, v.reason === "expired" ? "job_expired" : "job_invalid", `signed job refused: ${v.reason}`);
  const row = await getJob(svc, v.signedJob.jobId);
  if (!row || canonicalJson(JSON.parse(row.signed_json)) !== canonicalJson(v.signedJob)) throw new ApiError(403, "job_unknown", "this Worker did not issue that job");
  return { signedJob: v.signedJob, row };
}

export type ResultApplier = (svc: Services, row: RunnerJobRow, job: IntegrationJob, result: RunnerResult) => Promise<void>;
const appliers = new Map<string, ResultApplier>();

/** Register the side effect of a result kind that nobody waits for (integrate, inventory, export). */
export function onRunnerResult(kind: IntegrationJobKind, fn: ResultApplier): void {
  appliers.set(kind, fn);
}

/** `POST /api/runner/results`: verify, dedupe by jobId, store, revoke the job's tokens, apply. */
export async function acceptRunnerResult(svc: Services, body: { signedJob: unknown; result: unknown }): Promise<{ jobId: string; replayed: boolean; status: string }> {
  const { signedJob, row } = await verifyPresentedJob(svc, body.signedJob, { allowExpired: true });
  let result: RunnerResult;
  try {
    // binds the receipt to the job's fields (jobId, proposal, refs, shas, evidence snapshot)
    result = parseRunnerResultForJob(signedJob as never, body.result) as RunnerResult;
  } catch (e) {
    throw badRequest("invalid_result", e instanceof Error ? e.message.slice(0, 500) : "malformed result");
  }
  if (result.jobId !== signedJob.jobId) throw badRequest("invalid_result", "result jobId differs from the job");
  await checkEvidence(svc, signedJob, result);
  const hash = await sha256Hex(canonicalJson(result));

  if (row.status !== "queued") {
    if (row.result_hash === hash) {
      // review I1: a retried integrate result re-applies (idempotent: an identical receipt put is a
      // no-op), so a POST that failed after the D1 update never leaves the ledger without it
      if (signedJob.job.kind === "integrate" && row.status === "succeeded") await appliers.get("integrate")?.(svc, row, signedJob.job, result);
      return { jobId: row.job_id, replayed: true, status: row.status };
    }
    throw conflict("result_conflict", `job ${row.job_id} already has a different result`);
  }
  const status = result.ok ? "succeeded" : "failed";
  const upd = await svc.db
    .prepare("UPDATE runner_jobs SET status = ?, result_json = ?, result_hash = ?, completed_at = ? WHERE job_id = ? AND status = 'queued'")
    .bind(status, JSON.stringify(result), hash, svc.now().getTime(), row.job_id)
    .run();
  if ((upd.meta.changes ?? 0) === 0) {
    const again = await getJob(svc, row.job_id);
    if (again?.result_hash === hash) return { jobId: row.job_id, replayed: true, status: again.status };
    throw conflict("result_conflict", `job ${row.job_id} already has a different result`);
  }
  await revokeJobTokens(svc, row.job_id);
  // chaos (review I1): the D1 row says succeeded, the ledger has no receipt yet; the runner retries
  if (signedJob.job.kind === "integrate" && chaos(svc.env, "after_integrate_result_before_receipt", row.job_id)) throw new ChaosCrash("after_integrate_result_before_receipt");
  const apply = appliers.get(signedJob.job.kind);
  if (apply) await apply(svc, row, signedJob.job, result);
  return { jobId: row.job_id, replayed: false, status };
}

/** Evidence must carry the per-job HMAC (agent text never satisfies it). */
async function checkEvidence(svc: Services, signedJob: SignedJob, result: RunnerResult): Promise<void> {
  const evidence = result.ok ? (signedJob.job.kind === "integrate" ? (result.receipt as { evidence?: unknown }).evidence : undefined) : result.evidence;
  if (evidence === undefined) return;
  const v = await verifyEvidence(evidence, keyring(svc), { jobId: signedJob.jobId });
  if (!v.ok) throw new ApiError(403, "evidence_invalid", `validation evidence refused: ${v.reason}`);
}

export async function revokeJobTokens(svc: Services, jobId: string): Promise<void> {
  const rows = await svc.db.prepare("SELECT namespace, repo_name, token_id FROM runner_job_tokens WHERE job_id = ?").bind(jobId).all<{ namespace: string; repo_name: string; token_id: string }>();
  for (const t of rows.results) {
    try {
      await svc.transport.revokeToken(t.namespace, t.repo_name, t.token_id);
    } catch {
      /* best effort: the token expires with the job anyway */
    }
  }
}
