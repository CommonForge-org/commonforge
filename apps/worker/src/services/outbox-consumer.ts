/**
 * Outbox consumer (`commonforge-outbox`, plan §A.5 rule 2, §A.6 "Canonical ref", §F rows
 * "Partial provider failure" and "Duplicate events").
 *
 * The OrgLedger DO delivers each committed `OutboxEvent` at least once (Task 15). This consumer
 * applies each one **once** per `(organizationId, dedupeKey)`: the dedupe row lives in the ledger
 * (`consumed_events`). For `reconcile-ref` it is written in the same DO transaction as the
 * reconciliation state, so a crash leaves both or neither; `projection-refresh` and
 * `candidate-superseded` write their (idempotent) effect first and consume after it.
 *
 * Lease rule (review I-1): a reconcile pushes only with a lease on a sha it vouches for (the event's
 * previous head, the sha last recorded as synced, or a foreign sha already recorded as `diverged`
 * for this head), re-checks the head after reading the branch, and re-checks it again after the
 * job: if the head moved meanwhile, the current head goes back to `pending` and gets its own
 * reconcile request. An older job therefore never leaves a newer head wrongly `synced`.
 *
 * - `reconcile-ref` (after every accept/restore): project the ledger head onto the canonical
 *   branch through `ArtifactsVersionProvider.reconcileAccepted` (a runner `reconcile-ref` job,
 *   joined across redeliveries by a key salted with the dedupeKey). The head's `reconciliation`
 *   stays `pending` until the job reports; `synced` consumes the event; `diverged` is recorded and
 *   the message retried (the next attempt leases on the newly observed sha); a failed push with the
 *   ref unmoved (`provider_unavailable`) is retried and never marks the head `diverged`. An event
 *   whose target is no longer the head is consumed as `superseded` (the newer head has its own
 *   event). Permanent provider errors (repo gone or recreated) record `diverged` and consume.
 * - `projection-refresh`: refresh the D1 `resource_heads` projection.
 * - `candidate-superseded`: mark a still frozen/prepared candidate `superseded`.
 *
 * After `max_retries` the Queue moves a message to `commonforge-outbox-dlq`
 * ({@link handleOutboxDeadLetters}); the head stays `pending` and the GC sweep re-requests it.
 */
import {
  OutboxEventSchema,
  hashCanonicalSync,
  parseRevisionId,
  toIsoUtc,
  type AcceptedHead,
  type OutboxEvent,
} from "@commonforge-org/core";
import { isArtifactsProviderError } from "@commonforge-org/provider-cloudflare";
import type { Services } from "../context.js";
import { getResource, resourceCoords } from "./directory.js";
import { recordEvent } from "./events.js";
import { resourceRef } from "./resources.js";
import { RESULT_GRACE_MS, RunnerPendingError, runnerSubmit } from "./runner-jobs.js";
import { chaos } from "../chaos.js";

export const OUTBOX_QUEUE = "commonforge-outbox";
export const OUTBOX_DLQ = "commonforge-outbox-dlq";
/** Must match `max_retries` of the outbox consumer in wrangler.jsonc. */
export const OUTBOX_MAX_RETRIES = 10;
/** Principal on records the consumer and the GC write. */
export const SERVICE_ACTOR = { kind: "service", id: "worker-outbox" } as const;

/** Provider errors that retrying cannot fix: record `diverged`, consume, leave it to an operator. */
const PERMANENT_RECONCILE_CODES = new Set(["not_found", "repo_mismatch", "revision_mismatch", "invalid_input", "receipt_mismatch", "canonical_namespace_refused", "namespace_refused"]);

export type ApplyOutcome =
  | { done: true; outcome: string; duplicate?: boolean }
  | { done: false; delaySeconds: number; reason: string };

export function retryDelaySeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
}

/** Queue consumer for `commonforge-outbox`. Malformed bodies are dropped (a retry cannot fix them). */
export async function handleOutboxBatch(svc: Services, batch: MessageBatch): Promise<void> {
  for (const m of batch.messages) {
    const parsed = OutboxEventSchema.safeParse(m.body);
    if (!parsed.success) {
      console.error(`outbox: dropping malformed message ${m.id}`);
      m.ack();
      continue;
    }
    // chaos (G.5, AT-13): the ledger committed, the consumer dies before the reconcile job (1st delivery)
    if (parsed.data.kind === "reconcile-ref" && m.attempts <= 1 && chaos(svc.env, "after_commit_before_reconcile", parsed.data.dedupeKey)) {
      m.retry({ delaySeconds: retryDelaySeconds(m.attempts) });
      continue;
    }
    try {
      const out = await applyOutboxEvent(svc, parsed.data);
      if (out.done) m.ack();
      else m.retry({ delaySeconds: out.delaySeconds });
    } catch (e) {
      console.error(`outbox: ${parsed.data.kind} ${parsed.data.dedupeKey} failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
      m.retry({ delaySeconds: retryDelaySeconds(m.attempts) });
    }
  }
}

/** Apply one outbox event at most once (idempotent; safe to call for any redelivery). */
export async function applyOutboxEvent(svc: Services, ev: OutboxEvent): Promise<ApplyOutcome> {
  const ledger = svc.ledger(ev.organizationId);
  const seen = await ledger.getConsumedEvent(ev.organizationId, ev.dedupeKey);
  if (seen) return { done: true, outcome: seen.outcome, duplicate: true };
  switch (ev.kind) {
    case "reconcile-ref":
      return reconcileRef(svc, ev);
    case "projection-refresh": {
      await refreshHeadProjections(svc, ev.organizationId, ev.payload.resourceIds);
      await ledger.consumeEvent(ev.organizationId, consumeOf(ev, "refreshed"));
      return { done: true, outcome: "refreshed" };
    }
    case "candidate-superseded": {
      const rec = await ledger.getCandidate(ev.payload.candidateId);
      let outcome = "ignored";
      if (rec && (rec.state === "frozen" || rec.state === "prepared")) {
        await ledger.putCandidate(ev.organizationId, { ...rec, state: "superseded", updatedAt: svc.nowIso() });
        outcome = "superseded";
      }
      await ledger.consumeEvent(ev.organizationId, consumeOf(ev, outcome));
      return { done: true, outcome };
    }
  }
}

const consumeOf = (ev: OutboxEvent, outcome: string) => ({ dedupeKey: ev.dedupeKey, eventId: ev.eventId, kind: ev.kind, outcome });

async function reconcileRef(svc: Services, ev: Extract<OutboxEvent, { kind: "reconcile-ref" }>): Promise<ApplyOutcome> {
  const org = ev.organizationId;
  const { resourceId, targetRevision } = ev.payload;
  const ledger = svc.ledger(org);
  const head = await ledger.getHead(resourceId);
  const finish = async (outcome: string, state?: AcceptedHead["reconciliation"], observedSha?: string | null): Promise<ApplyOutcome> => {
    if (head && state) {
      const r = await ledger.recordReconciliation(org, { resourceId, revisionId: head.revisionId, state, ...(observedSha !== undefined ? { observedSha } : {}), consume: consumeOf(ev, outcome) });
      // the head moved under us: the newer head's own event (or the request below) reconciles it
      if (!r.headMatches && !r.alreadyConsumed && r.consumed) outcome = `${outcome}:head_moved`;
    } else {
      await ledger.consumeEvent(org, consumeOf(ev, outcome));
    }
    await refreshHeadProjections(svc, org, [resourceId]);
    return { done: true, outcome };
  };

  if (!head) return finish("no_head");
  // A later accept/restore moved the head; that version's own event reconciles it. A job this event
  // already ran may still have landed after the newer head synced: verify that head first.
  const superseded = async (): Promise<ApplyOutcome> => {
    // N-1: our own (or any older) job may still be queued with a lease a restore made valid again
    const open = await openReconcileJob(svc, org, resourceId, null);
    if (open) return { done: false, delaySeconds: 30, reason: `waiting for open reconcile job ${open}` };
    await verifySyncedHead(svc, ev);
    return finish("superseded");
  };
  if (head.revisionId !== targetRevision) return superseded();
  const parsed = parseRevisionId(head.revisionId);
  // Asset manifests and other non-git revisions have no provider ref to project.
  if (parsed.kind !== "art") return finish("synced:no_ref", "synced");

  const resource = await getResource(svc.db, org, resourceId);
  const coords = resource ? resourceCoords(resource) : null;
  if (!resource || resource.provider !== "artifacts" || !coords || coords.kind !== "artifacts") return finish("failed:no_resource", "diverged");
  const branch = resource.branch ?? "main";

  // 1. Read the branch. Already at the head: nothing to push.
  let current: string | null;
  try {
    const [c] = await svc.transport.log(coords.namespace, coords.repoName, { ref: branch, limit: 1 });
    current = c?.hash ?? null;
  } catch (e) {
    return { done: false, delaySeconds: 30, reason: `branch read failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` };
  }
  if (current === parsed.sha) {
    // N-1: never settle without a push while an older job (another target) could still land
    const open = await openReconcileJob(svc, org, resourceId, parsed.sha);
    if (open) return { done: false, delaySeconds: 30, reason: `waiting for open reconcile job ${open}` };
    return finish("synced", "synced", current);
  }

  // 2. Lease only on a sha we vouch for (review I-1): the event's previous head, the sha last
  //    recorded as synced, or a foreign sha already recorded (as `diverged`) while this head was
  //    current. Anything else is recorded first; the next attempt may then override it.
  const leases = new Set<string | null>();
  const prev = ev.payload.expectedCurrent ? parseRevisionId(ev.payload.expectedCurrent) : null;
  if (ev.payload.expectedCurrent === null) leases.add(null);
  else if (prev?.kind === "art" && prev.repoId === parsed.repoId) leases.add(prev.sha);
  const refState = await ledger.getRefState(resourceId);
  if (refState?.state === "synced") leases.add(refState.observedSha);
  if (refState?.state === "diverged" && refState.revisionId === head.revisionId) leases.add(refState.observedSha);
  if (!leases.has(current)) {
    const r = await ledger.recordReconciliation(org, { resourceId, revisionId: head.revisionId, state: "diverged", observedSha: current });
    await refreshHeadProjections(svc, org, [resourceId]);
    if (!r.headMatches) return superseded();
    return { done: false, delaySeconds: 30, reason: `diverged: ${branch} holds unrecorded ${current ?? "nothing"}` };
  }

  // 3. Re-check the head after reading the branch: a newer head that synced in between is never
  //    overwritten (its sha is not what we lease on unless it is still our predecessor).
  const again = await ledger.getHead(resourceId);
  if (!again || again.revisionId !== head.revisionId) return superseded();

  let result;
  try {
    result = await svc
      .provider()
      .reconcileAccepted(resourceRef(resource), head, runnerSubmit(svc, org, `reconcile:${resourceId}`, { keySalt: ev.dedupeKey }), { branch, expectedCurrentSha: current });
  } catch (e) {
    if (e instanceof RunnerPendingError) return { done: false, delaySeconds: 10, reason: e.message };
    const code = (e as { code?: unknown }).code;
    const runnerCode = (e as { details?: { code?: unknown } }).details?.code;
    if (isArtifactsProviderError(e) && typeof code === "string" && PERMANENT_RECONCILE_CODES.has(code)) {
      console.error(`reconcile ${resourceId}: permanent failure ${e.message.slice(0, 300)}`);
      return finish(`failed:${code}`, "diverged");
    }
    // provider_unavailable (5xx, ops gate busy) or a runner failure, e.g. a push that failed with
    // the ref unmoved: the head stays `pending` (never `diverged`) and the event is retried.
    const why = runnerCode ? `runner ${String(runnerCode)}` : String(code ?? "error");
    return { done: false, delaySeconds: 30, reason: `${why}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}` };
  }

  // 4. Post-check: if the head moved while the job ran, our push may have landed after the newer
  //    head synced. Put the current head back to `pending` and request its reconcile, leasing on
  //    the sha we just pushed; then consume this (now stale) event.
  const after = await ledger.getHead(resourceId);
  if (after && after.revisionId !== head.revisionId) {
    await ledger.recordReconciliation(org, { resourceId, revisionId: after.revisionId, state: "pending" });
    const req = reconcileRequest(org, after, `after-stale:${ev.dedupeKey}`, svc.now(), result.status === "synced" ? head.revisionId : null);
    if (req) await svc.deps.outboxQueue(svc.env).send(req);
    await ledger.consumeEvent(org, consumeOf(ev, `superseded_after_push:${result.status}`));
    await refreshHeadProjections(svc, org, [resourceId]);
    return { done: true, outcome: `superseded_after_push:${result.status}` };
  }
  if (result.status === "synced") return finish("synced", "synced", result.observedSha);
  // diverged: something else holds the ref. Record it (projection health), keep the event, retry:
  // the next attempt may lease on the recorded foreign sha and move the ref to the ledger head.
  await ledger.recordReconciliation(org, { resourceId, revisionId: head.revisionId, state: "diverged", observedSha: result.observedSha });
  await refreshHeadProjections(svc, org, [resourceId]);
  return { done: false, delaySeconds: 30, reason: `diverged: ${result.ref} holds ${result.observedSha ?? "nothing"}` };
}

/**
 * Review N-1: an open (queued, not past expiry + result grace) `reconcile-ref` job for the resource
 * whose target is not `exceptTargetSha`. Its lease is a sha, and a restore can make that sha the
 * branch value again, so such a job may still push; nothing may be settled without a push (or
 * consumed as superseded) until it resolved or expired. Returns its jobId.
 */
export async function openReconcileJob(svc: Services, org: string, resourceId: string, exceptTargetSha: string | null): Promise<string | null> {
  const rows = await svc.db
    .prepare("SELECT job_id, signed_json FROM runner_jobs WHERE org_id = ? AND subject = ? AND kind = 'reconcile-ref' AND status = 'queued' AND expires_at > ?")
    .bind(org, `reconcile:${resourceId}`, svc.now().getTime() - RESULT_GRACE_MS)
    .all<{ job_id: string; signed_json: string }>();
  for (const r of rows.results) {
    const target = (JSON.parse(r.signed_json) as { job?: { targetSha?: string } }).job?.targetSha;
    if (target !== exceptTargetSha) return r.job_id;
  }
  return null;
}

/**
 * A head recorded `synced` whose branch holds something else (e.g. an older event's job landed
 * after it synced): record the observation as `diverged` (so a reconcile may lease on it) and
 * request a reconcile of that head.
 */
async function verifySyncedHead(svc: Services, ev: Extract<OutboxEvent, { kind: "reconcile-ref" }>): Promise<void> {
  const org = ev.organizationId;
  const ledger = svc.ledger(org);
  const current = await ledger.getHead(ev.payload.resourceId);
  if (!current || current.reconciliation !== "synced") return; // pending/diverged: already being reconciled
  const rev = parseRevisionId(current.revisionId);
  if (rev.kind !== "art") return;
  const resource = await getResource(svc.db, org, ev.payload.resourceId);
  const coords = resource ? resourceCoords(resource) : null;
  if (!resource || !coords || coords.kind !== "artifacts") return;
  const [c] = await svc.transport.log(coords.namespace, coords.repoName, { ref: resource.branch ?? "main", limit: 1 });
  const observed = c?.hash ?? null;
  if (observed === rev.sha) return;
  const r = await ledger.recordReconciliation(org, { resourceId: current.resourceId, revisionId: current.revisionId, state: "diverged", observedSha: observed });
  if (!r.headMatches) return;
  const req = reconcileRequest(org, current, `verify:${ev.dedupeKey}`, svc.now());
  if (req) await svc.deps.outboxQueue(svc.env).send(req);
}

/** Refresh the D1 `resource_heads` projection from the ledger (authority) for these resources. */
export async function refreshHeadProjections(svc: Services, orgId: string, resourceIds: readonly string[], heads?: readonly AcceptedHead[]): Promise<void> {
  const ledger = svc.ledger(orgId);
  const now = svc.nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const rid of new Set(resourceIds)) {
    const h = heads?.find((x) => x.resourceId === rid) ?? (await ledger.getHead(rid));
    if (!h) {
      stmts.push(svc.db.prepare("DELETE FROM resource_heads WHERE org_id = ? AND resource_id = ?").bind(orgId, rid));
      continue;
    }
    stmts.push(
      svc.db
        .prepare(
          `INSERT INTO resource_heads (org_id, resource_id, revision_id, version_seq, accepted_version_id, accepted_at, reconciliation, refreshed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (org_id, resource_id) DO UPDATE SET revision_id = excluded.revision_id, version_seq = excluded.version_seq,
             accepted_version_id = excluded.accepted_version_id, accepted_at = excluded.accepted_at,
             reconciliation = excluded.reconciliation, refreshed_at = excluded.refreshed_at
           WHERE excluded.version_seq >= resource_heads.version_seq`,
        )
        .bind(orgId, h.resourceId, h.revisionId, h.versionSeq, h.acceptedVersionId, h.acceptedAt, h.reconciliation, now),
    );
  }
  if (stmts.length > 0) await svc.db.batch(stmts);
}

/**
 * A `reconcile-ref` request that does not come from a ledger commit (a `pushed` wakeup that found
 * the ref moved, or the GC backstop for heads left `pending`). It carries its own dedupeKey, so a
 * duplicate of *this request* is applied once, while the consumer's head checks make it harmless
 * next to the ledger's original event.
 */
export function reconcileRequest(orgId: string, head: AcceptedHead, reason: string, now: Date, expectedCurrent: string | null = null): OutboxEvent | null {
  if (!head.acceptedVersionId) return null;
  const dedupeKey = `reconcile-ref:${head.acceptedVersionId}:${head.resourceId}:${reason}`.slice(0, 512);
  return OutboxEventSchema.parse({
    eventId: `ob-${hashCanonicalSync([orgId, dedupeKey]).slice(0, 32)}`,
    organizationId: orgId,
    kind: "reconcile-ref",
    dedupeKey,
    createdAt: toIsoUtc(now),
    attempts: 0,
    deliveredAt: null,
    payload: { resourceId: head.resourceId, targetRevision: head.revisionId, expectedCurrent, acceptedVersionId: head.acceptedVersionId },
  });
}

/**
 * Dead-letter consumer (`commonforge-outbox-dlq`): an event that exhausted its retries. Recorded as
 * an `outbox.dead_lettered` activity event (owners, and readers of the resources it names); the
 * head stays `pending`/`diverged` and the GC sweep keeps re-requesting reconciliation.
 */
export async function handleOutboxDeadLetters(svc: Services, batch: MessageBatch): Promise<void> {
  for (const m of batch.messages) {
    const parsed = OutboxEventSchema.safeParse(m.body);
    try {
      if (parsed.success) {
        const ev = parsed.data;
        const resourceIds = ev.kind === "projection-refresh" ? ev.payload.resourceIds : [ev.payload.resourceId];
        await recordEvent(svc, {
          orgId: ev.organizationId,
          actor: SERVICE_ACTOR as never,
          action: "outbox.dead_lettered",
          subjectKind: "resource",
          subjectId: resourceIds[0] ?? ev.eventId,
          resourceIds,
          detail: { eventId: ev.eventId, kind: ev.kind, dedupeKey: ev.dedupeKey, deliveries: m.attempts },
        });
        console.error(`outbox: dead-lettered ${ev.kind} ${ev.dedupeKey}`);
      } else {
        console.error(`outbox dlq: malformed message ${m.id}`);
      }
      m.ack();
    } catch (e) {
      console.error(`outbox dlq: ${e instanceof Error ? e.message : String(e)}`);
      m.retry({ delaySeconds: 60 });
    }
  }
}
