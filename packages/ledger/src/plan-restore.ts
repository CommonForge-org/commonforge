/**
 * `planRestore` (plan §B.9): move a resource's head *forward* to a revision it previously had, under
 * compare-and-swap on the current head. History is never rewritten: the restore is a new accepted
 * project version (`kind: 'restore'`) with a new, higher `versionSeq`.
 *
 * Checks, in order:
 *  1. structure / `now` → `LedgerInputError`
 *  2. idempotency (scope `restore`, keys scoped to the request's organization): replay, or
 *     `idempotency_key_conflict`
 *  3. `expected_head_stale` — resource not bound to `organizationId` (the caller-supplied org is
 *     verified against the ledger's binding, never trusted), no head, or head ≠ `expectedHead`
 *  4. `restore_noop` — `targetRevision` already is the head: nothing is written
 *  5. `restore_target_unknown` — `targetRevision` was never an accepted head of the resource
 *     (otherwise restore would bypass review)
 *
 * Signature deviation from §B.9: takes `now` (timestamps must not come from a clock inside the
 * pure planner) and `organizationId` in the request (see `RestoreRequest`).
 */
import { applyWrites } from './apply-writes.js';
import { LedgerInputError, RestoreRequestSchema, refuse, type CommitDecision, type RestoreRequestInput } from './decision.js';
import { auditEvent, checkIdempotency, checkResourceOrganization, nextAcceptedVersion, parseNow, reconcileRefEvent, requestHash } from './internal.js';
import type { LedgerTx, LedgerWrite } from './store.js';

/** Request-hash domain tag for restore idempotency records. */
export const RESTORE_REQUEST_TAG = 'cf.ledger.restore/1';

export function planRestore(tx: LedgerTx, input: RestoreRequestInput, now: string): CommitDecision {
  const parsed = RestoreRequestSchema.safeParse(input);
  if (!parsed.success) throw new LedgerInputError(`invalid RestoreRequest: ${parsed.error.message}`);
  const req = parsed.data;
  const at = parseNow(now);

  const hash = requestHash(RESTORE_REQUEST_TAG, {
    organizationId: req.organizationId,
    resourceId: req.resourceId,
    expectedHead: req.expectedHead,
    targetRevision: req.targetRevision,
    actor: req.actor,
  });
  const replay = checkIdempotency(tx, req.organizationId, req.idempotencyKey, 'restore', hash);
  if (replay) return replay;

  const foreign = checkResourceOrganization(tx, req.resourceId, req.organizationId);
  if (foreign) return foreign;
  const head = tx.getHead(req.resourceId);
  if (!head) return refuse('expected_head_stale', `resource has no accepted head; expected ${req.expectedHead}`, req.resourceId);
  if (head.revisionId !== req.expectedHead) {
    return refuse('expected_head_stale', `head is ${head.revisionId}, expected ${req.expectedHead}`, req.resourceId);
  }
  if (req.targetRevision === head.revisionId) {
    return refuse('restore_noop', 'target already is the accepted head; nothing to restore', req.resourceId);
  }
  if (!tx.wasAcceptedHead(req.resourceId, req.targetRevision)) {
    return refuse('restore_target_unknown', `${req.targetRevision} was never an accepted head of this resource`, req.resourceId);
  }

  const { sequence, acceptedVersionId } = nextAcceptedVersion(tx, req.organizationId);
  const versionSeq = head.versionSeq + 1;
  const heads = [{ resourceId: req.resourceId, revisionId: req.targetRevision, previousRevisionId: head.revisionId, versionSeq }];
  const writes: LedgerWrite[] = [
    {
      op: 'setHead',
      head: { resourceId: req.resourceId, revisionId: req.targetRevision, versionSeq, acceptedVersionId, acceptedAt: at, reconciliation: 'pending' },
    },
    {
      op: 'putAcceptedVersion',
      version: {
        acceptedVersionId,
        organizationId: req.organizationId,
        sequence,
        kind: 'restore',
        proposalId: null,
        proposalHash: null,
        heads,
        actor: req.actor,
        acceptedAt: at,
      },
    },
    { op: 'putIdempotency', organizationId: req.organizationId, record: { key: req.idempotencyKey, scope: 'restore', requestHash: hash, acceptedVersionId, createdAt: at } },
    {
      op: 'appendOutbox',
      event: reconcileRefEvent(req.organizationId, req.resourceId, req.targetRevision, head.revisionId, acceptedVersionId, at),
    },
    {
      op: 'appendAudit',
      event: auditEvent({
        organizationId: req.organizationId,
        at,
        actor: req.actor,
        action: 'resource.restored',
        subject: { kind: 'resource', id: req.resourceId },
        avId: acceptedVersionId,
        detail: { sequence, heads },
      }),
    },
  ];
  return { ok: true, acceptedVersionId, writes };
}

/** Plan and, on a fresh restore, apply the writes. Call inside one store transaction. */
export function executeRestore(tx: LedgerTx, input: RestoreRequestInput, now: string): CommitDecision {
  const d = planRestore(tx, input, now);
  if (d.ok && !d.replayed) applyWrites(tx, d.writes);
  return d;
}
