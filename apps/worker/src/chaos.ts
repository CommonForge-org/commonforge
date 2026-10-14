/**
 * Chaos flags: deliberate fault injection for the fault suite (plan §G.5, Task 23).
 *
 * `COMMONFORGE_CHAOS` names the faults to inject, comma-separated (unknown names are ignored with a
 * warning). Never on by default: wrangler.jsonc sets no value. A Worker refuses (ignores) the flags
 * unless it is local — `COMMONFORGE_PUBLIC_URL` on localhost, 127.0.0.1, ::1, `*.localhost` or
 * `*.test` (`wrangler dev`, vitest) — or the deployment explicitly opts in with
 * `COMMONFORGE_CHAOS_ALLOW_DEPLOYED=inject-faults` (a rehearsal Worker, never production).
 *
 * Each point models one row of plan §G.5 and fires in production code, so the same flags drive the
 * local fault suite (apps/worker/test/fault) and a rehearsal against a deployed Worker:
 *
 * | flag                           | where                                | what happens                                                                                      |
 * |--------------------------------|--------------------------------------|---------------------------------------------------------------------------------------------------|
 * | `after_fork_before_record`     | step `workspace.create`              | the task repo is created, then the step "crashes" and its message is lost: no ledger handle      |
 * | `after_prepare_before_commit`  | step `candidate.prepare`             | the prepared receipt is written, then the step crashes (1st delivery): retried, receipts reused  |
 * | `provider_5xx_during_prepare`  | step `candidate.prepare`             | the provider answers 5xx (`provider_unavailable`) on the 1st delivery: nothing is prepared       |
 * | `after_commit_before_reconcile`| outbox consumer, `reconcile-ref`     | the ledger committed; the consumer crashes before the reconcile job (1st delivery): head pending |
 * | `lost_accept_response`         | `POST …/proposals/:id/accept`        | the accept commits, then the response is lost (503); a retry with the same key replays it        |
 * | `runner_job_expiry`            | `issueJob`                           | every signed job expires 1 s after issue: the broker refuses its credentials, its result is late |
 * | `after_file_change_accept_before_landing` | step `files.accept` | the ledger accepted the file change's proposal, then the step crashes (1st delivery) before promotion and `added`: the retry finishes the landing |
 * | `after_integrate_result_before_receipt` | `POST /api/runner/results` (integrate) | the job is marked succeeded in D1, then the request crashes before the ledger has the receipt (1st POST only): "applying"; the runner's retry re-applies |
 */
import type { Env } from "./env.js";
import { isLocalUrl } from "./lib/local-host.js";

export const CHAOS_POINTS = [
  "after_fork_before_record",
  "after_prepare_before_commit",
  "provider_5xx_during_prepare",
  "after_commit_before_reconcile",
  "lost_accept_response",
  "runner_job_expiry",
  "after_integrate_result_before_receipt",
  "after_file_change_accept_before_landing",
] as const;
export type ChaosPoint = (typeof CHAOS_POINTS)[number];

/** Value of `COMMONFORGE_CHAOS_ALLOW_DEPLOYED` that lets a deployed (non-local) Worker inject faults. */
export const CHAOS_ALLOW_DEPLOYED = "inject-faults";

type ChaosEnv = Pick<Env, "COMMONFORGE_PUBLIC_URL"> & { COMMONFORGE_CHAOS?: string; COMMONFORGE_CHAOS_ALLOW_DEPLOYED?: string };

/** A deliberate crash: transient for the queues (the message is retried), never a real failure code. */
export class ChaosCrash extends Error {
  readonly code = "chaos_crash";
  constructor(readonly point: ChaosPoint) {
    super(`chaos: injected fault ${point}`);
    this.name = "ChaosCrash";
  }
}

export function isLocalWorker(env: Pick<Env, "COMMONFORGE_PUBLIC_URL">): boolean {
  return isLocalUrl(env.COMMONFORGE_PUBLIC_URL);
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(msg);
}

/** The active chaos points (empty unless set *and* allowed). */
export function activeChaos(env: ChaosEnv | undefined): ChaosPoint[] {
  const raw = (env?.COMMONFORGE_CHAOS ?? "").trim();
  if (!raw || !env) return [];
  if (!isLocalWorker(env) && env.COMMONFORGE_CHAOS_ALLOW_DEPLOYED !== CHAOS_ALLOW_DEPLOYED) {
    warnOnce(`refused:${raw}`, `[chaos] COMMONFORGE_CHAOS is set on a deployed Worker without COMMONFORGE_CHAOS_ALLOW_DEPLOYED=${CHAOS_ALLOW_DEPLOYED}: ignored`);
    return [];
  }
  const out: ChaosPoint[] = [];
  for (const name of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if ((CHAOS_POINTS as readonly string[]).includes(name)) out.push(name as ChaosPoint);
    else warnOnce(`unknown:${name}`, `[chaos] unknown chaos point ${JSON.stringify(name)}: ignored`);
  }
  return out;
}

/** True when `point` should fire now; logs every firing (the evidence of an injected fault). */
export function chaos(env: ChaosEnv | undefined, point: ChaosPoint, context = ""): boolean {
  if (!activeChaos(env).includes(point)) return false;
  console.warn(`[chaos] ${point}${context ? ` ${context}` : ""}`);
  return true;
}
