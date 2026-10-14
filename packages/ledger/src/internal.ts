import {
  IsoUtcTimestampSchema,
  acceptedVersionId as toAcceptedVersionId,
  canonicalJson,
  hashCanonicalSync,
  type AcceptedVersionId,
  type AuditEvent,
  type IdempotencyScope,
  type IsoUtcTimestamp,
  type OutboxEvent,
  type PrincipalRef,
  type ProposalHash,
  type ResourceId,
  type RevisionId,
} from '@commonforge-org/core';
import { LedgerInputError, refuse, type CommitDecision } from './decision.js';
import type { LedgerTx } from './store.js';

export function parseNow(now: string): IsoUtcTimestamp {
  const r = IsoUtcTimestampSchema.safeParse(now);
  if (!r.success) throw new LedgerInputError(`now must be a UTC ISO timestamp with millisecond precision, got ${JSON.stringify(now)}`);
  return r.data;
}

/** Canonical form of a set-like array: entries sorted by their canonical JSON. */
export function canonicalSet<T>(items: readonly T[]): T[] {
  return [...items].map((v) => [canonicalJson(v), v] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

export function requestHash(tag: string, payload: Record<string, unknown>): string {
  try {
    return hashCanonicalSync({ $t: tag, ...payload });
  } catch (e) {
    throw new LedgerInputError(`request is not canonical JSON: ${(e as Error).message}`);
  }
}

/**
 * Idempotency gate, evaluated before any other check so a lost-response retry replays even after
 * the heads it moved have moved again. `undefined` means "key unused, proceed".
 * `legacyScopes`: scopes older stores recorded for the same operation (the request hash still has
 * to match, and request hashes are domain-tagged per operation).
 */
export function checkIdempotency(
  tx: LedgerTx,
  organizationId: string,
  key: string,
  scope: IdempotencyScope,
  hash: string,
  legacyScopes: readonly IdempotencyScope[] = [],
): CommitDecision | undefined {
  const rec = tx.getIdempotency(organizationId, key);
  if (!rec) return undefined;
  if ((rec.scope === scope || legacyScopes.includes(rec.scope)) && rec.requestHash === hash) {
    return { ok: true, replayed: true, acceptedVersionId: rec.acceptedVersionId };
  }
  return refuse('idempotency_key_conflict', `idempotency key already used for a different ${rec.scope} request`);
}

/** `av-` + zero-padded per-organization sequence: monotonic and lexicographically sortable. */
export function formatAcceptedVersionId(sequence: number): AcceptedVersionId {
  return toAcceptedVersionId(`av-${String(sequence).padStart(12, '0')}`);
}

export function nextAcceptedVersion(tx: LedgerTx, organizationId: string): { sequence: number; acceptedVersionId: AcceptedVersionId } {
  const latest = tx.getLatestAcceptedVersion(organizationId);
  const sequence = (latest?.sequence ?? 0) + 1;
  return { sequence, acceptedVersionId: formatAcceptedVersionId(sequence) };
}

/** Deterministic id from parts (planning is pure: no clocks or random ids). */
export function derivedId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}-${hashCanonicalSync(parts).slice(0, 32)}`;
}

export function reconcileRefEvent(
  organizationId: string,
  resourceId: ResourceId,
  targetRevision: RevisionId,
  expectedCurrent: RevisionId | null,
  avId: AcceptedVersionId,
  now: IsoUtcTimestamp,
): OutboxEvent {
  const dedupeKey = `reconcile-ref:${avId}:${resourceId}`;
  return {
    eventId: derivedId('ob', [organizationId, dedupeKey]),
    organizationId,
    kind: 'reconcile-ref',
    dedupeKey,
    createdAt: now,
    attempts: 0,
    deliveredAt: null,
    payload: { resourceId, targetRevision, expectedCurrent, acceptedVersionId: avId },
  };
}

export function auditEvent(args: {
  organizationId: string;
  at: IsoUtcTimestamp;
  actor: PrincipalRef;
  action: string;
  subject: AuditEvent['subject'];
  proposalHash?: ProposalHash;
  avId: AcceptedVersionId;
  detail: Record<string, unknown>;
}): AuditEvent {
  const ev: AuditEvent = {
    auditId: derivedId('au', [args.organizationId, args.action, args.avId]),
    organizationId: args.organizationId,
    at: args.at,
    actor: args.actor,
    action: args.action,
    subject: args.subject,
    detail: { acceptedVersionId: args.avId, ...args.detail },
  };
  if (args.proposalHash !== undefined) ev.proposalHash = args.proposalHash;
  return ev;
}

/**
 * The resource must be bound to `organizationId`; an unbound or foreign resource has no head visible
 * to that organization. `undefined` means OK.
 */
export function checkResourceOrganization(tx: LedgerTx, resourceId: ResourceId, organizationId: string): CommitDecision | undefined {
  const owner = tx.getResourceOrganization(resourceId);
  if (owner === organizationId) return undefined;
  return refuse(
    'expected_head_stale',
    owner === null ? 'resource is not bound to any organization' : 'resource belongs to another organization',
    resourceId,
  );
}
