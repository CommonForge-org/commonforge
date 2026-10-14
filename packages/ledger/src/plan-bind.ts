/**
 * `planBindHead`: genesis. Creates the first accepted head of a resource that has none (a freshly
 * created/imported canonical repo, an asset resource's initial manifest) and binds the resource to
 * its organization, so stores never write heads outside the ledger invariants.
 *
 * Checks, in order:
 *  1. structure / `now` → `LedgerInputError`
 *  2. idempotency (scope `bind`, organization-scoped key; request tag `cf.ledger.bind/1` keeps a
 *     bind and an accept from ever replaying each other): replay or `idempotency_key_conflict`.
 *     A bind recorded before core had `bind` (scope `accept`, same tag) still replays.
 *  3. `expected_head_stale` — the resource already has a head or is already bound (CAS on "none")
 *
 * Writes: `bindResource`, `setHead` (versionSeq 1, reconciliation `synced` — the bound revision is
 * what the provider ref was observed at, so no `reconcile-ref` event), `putAcceptedVersion`
 * (`kind: 'bind'`, `proposalId: null`), `putIdempotency` (scope `bind`),
 * `appendAudit` (`resource.bound`).
 */
import { applyWrites } from './apply-writes.js';
import { BindHeadRequestSchema, LedgerInputError, refuse, type BindHeadRequestInput, type CommitDecision } from './decision.js';
import { auditEvent, checkIdempotency, nextAcceptedVersion, parseNow, requestHash } from './internal.js';
import type { LedgerTx, LedgerWrite } from './store.js';

/** Request-hash domain tag for bind idempotency records. */
export const BIND_REQUEST_TAG = 'cf.ledger.bind/1';

export function planBindHead(tx: LedgerTx, input: BindHeadRequestInput, now: string): CommitDecision {
  const parsed = BindHeadRequestSchema.safeParse(input);
  if (!parsed.success) throw new LedgerInputError(`invalid BindHeadRequest: ${parsed.error.message}`);
  const req = parsed.data;
  const at = parseNow(now);

  const hash = requestHash(BIND_REQUEST_TAG, {
    organizationId: req.organizationId,
    resourceId: req.resourceId,
    revisionId: req.revisionId,
    actor: req.actor,
  });
  const replay = checkIdempotency(tx, req.organizationId, req.idempotencyKey, 'bind', hash, ['accept']);
  if (replay) return replay;

  const existing = tx.getHead(req.resourceId);
  const owner = tx.getResourceOrganization(req.resourceId);
  if (existing || owner !== null) {
    return refuse('expected_head_stale', 'resource already has a head or an owner; genesis expects none', req.resourceId);
  }

  const { sequence, acceptedVersionId } = nextAcceptedVersion(tx, req.organizationId);
  const heads = [{ resourceId: req.resourceId, revisionId: req.revisionId, previousRevisionId: null, versionSeq: 1 }];
  const writes: LedgerWrite[] = [
    { op: 'bindResource', resourceId: req.resourceId, organizationId: req.organizationId },
    {
      op: 'setHead',
      head: { resourceId: req.resourceId, revisionId: req.revisionId, versionSeq: 1, acceptedVersionId, acceptedAt: at, reconciliation: 'synced' },
    },
    {
      op: 'putAcceptedVersion',
      version: {
        acceptedVersionId,
        organizationId: req.organizationId,
        sequence,
        kind: 'bind',
        proposalId: null,
        proposalHash: null,
        heads,
        actor: req.actor,
        acceptedAt: at,
      },
    },
    { op: 'putIdempotency', organizationId: req.organizationId, record: { key: req.idempotencyKey, scope: 'bind', requestHash: hash, acceptedVersionId, createdAt: at } },
    {
      op: 'appendAudit',
      event: auditEvent({
        organizationId: req.organizationId,
        at,
        actor: req.actor,
        action: 'resource.bound',
        subject: { kind: 'resource', id: req.resourceId },
        avId: acceptedVersionId,
        detail: { sequence, heads },
      }),
    },
  ];
  return { ok: true, acceptedVersionId, writes };
}

/** Plan and, on a fresh bind, apply the writes. Call inside one store transaction. */
export function executeBindHead(tx: LedgerTx, input: BindHeadRequestInput, now: string): CommitDecision {
  const d = planBindHead(tx, input, now);
  if (d.ok && !d.replayed) applyWrites(tx, d.writes);
  return d;
}
