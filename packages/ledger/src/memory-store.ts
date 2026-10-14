/**
 * In-memory `LedgerStore` for tests, the conformance suite and local tooling.
 *
 * - `transactionSync(fn)` runs `fn` against a private copy of the state and swaps it in only if `fn`
 *   returns normally (all-or-nothing). Transactions cannot nest, and `fn` must be synchronous —
 *   the same constraints as a Durable Object's `transactionSync`.
 * - `transaction(fn)` queues `fn` behind every previously submitted transaction, so concurrent
 *   callers are serialized exactly as one DO per organization serializes them.
 * - Writes are validated against core's schemas and the uniqueness rules every real store must
 *   enforce (UNIQUE constraints in SQL): idempotency key; acceptedVersionId and sequence per
 *   organization; outbox dedupeKey per organization; auditId.
 * - Every applied `setHead` (and every seeded head) is added to the resource's head history,
 *   which backs `wasAcceptedHead`. Resource → organization bindings never change once set.
 * - Idempotency records are keyed by (organizationId, key).
 * - Reads return copies; mutating them never changes the store.
 */
import {
  AcceptedHeadSchema,
  AcceptedProjectVersionSchema,
  AuditEventSchema,
  IdempotencyRecordSchema,
  OutboxEventSchema,
  ProposalRecordSchema,
  type AcceptedHead,
  type AcceptedProjectVersion,
  type AuditEvent,
  type IdempotencyRecord,
  type IntegrationReceipt,
  type OutboxEvent,
  type PreparedReceipt,
  type ProposalRecord,
} from '@commonforge-org/core';
import { z } from 'zod';
import {
  parseLedgerSeed,
  type LedgerSeed,
  type SeedHeadInput,
} from './seed.js';
import type { LedgerStore, LedgerTx } from './store.js';

interface State {
  heads: Map<string, AcceptedHead>;
  headHistory: Map<string, Set<string>>;
  bindings: Map<string, string>;
  proposals: Map<string, ProposalRecord>;
  preparedReceipts: Map<string, PreparedReceipt>;
  integrationReceipts: Map<string, IntegrationReceipt>;
  policyRevisions: Map<string, number>;
  idempotency: Map<string, IdempotencyRecord>;
  acceptedVersions: AcceptedProjectVersion[];
  outbox: OutboxEvent[];
  audit: AuditEvent[];
}

function emptyState(): State {
  return {
    heads: new Map(),
    headHistory: new Map(),
    bindings: new Map(),
    proposals: new Map(),
    preparedReceipts: new Map(),
    integrationReceipts: new Map(),
    policyRevisions: new Map(),
    idempotency: new Map(),
    acceptedVersions: [],
    outbox: [],
    audit: [],
  };
}

const copy = <T>(v: T): T => structuredClone(v);

const idemKey = (organizationId: string, key: string) => JSON.stringify([organizationId, key]);

function bind(state: State, resourceId: string, organizationId: string): void {
  const owner = state.bindings.get(resourceId);
  if (owner !== undefined && owner !== organizationId) throw new Error(`resource ${resourceId} is already bound to ${owner}`);
  state.bindings.set(resourceId, organizationId);
}

function recordHead(state: State, head: AcceptedHead): void {
  state.heads.set(head.resourceId, head);
  let hist = state.headHistory.get(head.resourceId);
  if (!hist) state.headHistory.set(head.resourceId, (hist = new Set()));
  hist.add(head.revisionId);
}

function isThenable(v: unknown): boolean {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

class MemoryTx implements LedgerTx {
  closed = false;
  constructor(private readonly s: State) {}

  private live(): State {
    if (this.closed) throw new Error('ledger transaction is closed');
    return this.s;
  }

  getHead(resourceId: string) {
    const h = this.live().heads.get(resourceId);
    return h ? copy(h) : null;
  }
  setHead(head: AcceptedHead): void {
    recordHead(this.live(), AcceptedHeadSchema.parse(head));
  }
  getProposal(proposalId: string) {
    const p = this.live().proposals.get(proposalId);
    return p ? copy(p) : null;
  }
  putProposal(p: ProposalRecord): void {
    const v = ProposalRecordSchema.parse(p);
    this.live().proposals.set(v.proposalId, v);
  }
  getIdempotency(organizationId: string, key: string) {
    const r = this.live().idempotency.get(idemKey(organizationId, key));
    return r ? copy(r) : null;
  }
  putIdempotency(organizationId: string, rec: IdempotencyRecord): void {
    const v = IdempotencyRecordSchema.parse(rec);
    const s = this.live();
    const k = idemKey(z.string().min(1).parse(organizationId), v.key);
    if (s.idempotency.has(k)) throw new Error(`unique violation: idempotency key ${v.key}`);
    s.idempotency.set(k, v);
  }
  putAcceptedVersion(version: AcceptedProjectVersion): void {
    const v = AcceptedProjectVersionSchema.parse(version);
    const s = this.live();
    for (const x of s.acceptedVersions) {
      if (x.organizationId !== v.organizationId) continue;
      if (x.acceptedVersionId === v.acceptedVersionId || x.sequence === v.sequence) {
        throw new Error(`unique violation: accepted version ${v.acceptedVersionId} / sequence ${v.sequence}`);
      }
    }
    s.acceptedVersions.push(v);
  }
  appendOutbox(event: OutboxEvent): void {
    const v = OutboxEventSchema.parse(event);
    const s = this.live();
    if (s.outbox.some((x) => x.organizationId === v.organizationId && (x.dedupeKey === v.dedupeKey || x.eventId === v.eventId))) {
      throw new Error(`unique violation: outbox ${v.dedupeKey}`);
    }
    s.outbox.push(v);
  }
  appendAudit(event: AuditEvent): void {
    const v = AuditEventSchema.parse(event);
    const s = this.live();
    if (s.audit.some((x) => x.auditId === v.auditId)) throw new Error(`unique violation: audit ${v.auditId}`);
    s.audit.push(v);
  }
  getPreparedReceipt(receiptId: string) {
    const r = this.live().preparedReceipts.get(receiptId);
    return r ? copy(r) : null;
  }
  getIntegrationReceipt(proposalId: string) {
    const r = this.live().integrationReceipts.get(proposalId);
    return r ? copy(r) : null;
  }
  getCurrentPolicyRevision(projectId: string) {
    return this.live().policyRevisions.get(projectId) ?? null;
  }
  getLatestAcceptedVersion(organizationId: string) {
    let best: AcceptedProjectVersion | null = null;
    for (const v of this.live().acceptedVersions) {
      if (v.organizationId === organizationId && (!best || v.sequence > best.sequence)) best = v;
    }
    return best ? copy(best) : null;
  }
  wasAcceptedHead(resourceId: string, revisionId: string): boolean {
    return this.live().headHistory.get(resourceId)?.has(revisionId) ?? false;
  }
  getResourceOrganization(resourceId: string): string | null {
    return this.live().bindings.get(resourceId) ?? null;
  }
  bindResource(resourceId: string, organizationId: string): void {
    bind(this.live(), resourceId, z.string().min(1).parse(organizationId));
  }
}

export class InMemoryLedgerStore implements LedgerStore {
  private state: State = emptyState();
  private inTx = false;
  private queue: Promise<unknown> = Promise.resolve();

  /** Run `fn` atomically and synchronously (DO `transactionSync` semantics). */
  transactionSync<T>(fn: (tx: LedgerTx) => T): T {
    if (this.inTx) throw new Error('nested ledger transactions are not supported');
    const working = copy(this.state);
    const tx = new MemoryTx(working);
    this.inTx = true;
    try {
      const result = fn(tx);
      if (isThenable(result)) {
        // swallow the abandoned promise's eventual rejection; the transaction is already refused
        (result as unknown as Promise<unknown>).then(undefined, () => undefined);
        throw new Error('ledger transaction callback must be synchronous');
      }
      this.state = working;
      return result;
    } finally {
      tx.closed = true;
      this.inTx = false;
    }
  }

  /** Serialized async wrapper: transactions run one at a time in submission order. */
  transaction<T>(fn: (tx: LedgerTx) => T): Promise<T> {
    const run = this.queue.then(() => this.transactionSync(fn));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---- seeding (outside transactions; used by tests and the conformance harness) ----

  private seedable(): State {
    if (this.inTx) throw new Error('cannot seed during a transaction');
    return this.state;
  }

  seed(seed: LedgerSeed): void {
    const p = parseLedgerSeed(seed);
    const s = this.seedable();
    for (const { organizationId, ...h } of p.heads) {
      if (organizationId !== undefined) bind(s, h.resourceId, organizationId);
      recordHead(s, h);
    }
    for (const x of p.proposals) s.proposals.set(x.proposalId, x);
    for (const r of p.preparedReceipts) s.preparedReceipts.set(r.receiptId, r);
    for (const r of p.integrationReceipts) s.integrationReceipts.set(r.proposalId, r);
    for (const x of p.policyRevisions) s.policyRevisions.set(x.projectId, x.policyRevision);
  }

  seedHead(head: SeedHeadInput): void {
    this.seed({ heads: [head] });
  }
  seedProposal(p: z.input<typeof ProposalRecordSchema>): void {
    this.seed({ proposals: [p] });
  }
  seedPreparedReceipt(r: NonNullable<LedgerSeed['preparedReceipts']>[number]): void {
    this.seed({ preparedReceipts: [r] });
  }
  seedIntegrationReceipt(r: NonNullable<LedgerSeed['integrationReceipts']>[number]): void {
    this.seed({ integrationReceipts: [r] });
  }
  seedPolicyRevision(projectId: string, policyRevision: number): void {
    this.seed({ policyRevisions: [{ projectId, policyRevision }] });
  }

  // ---- inspection (copies) ----

  /** The current head; throws when the resource has none. */
  head(resourceId: string): AcceptedHead {
    const h = this.state.heads.get(resourceId);
    if (!h) throw new Error(`no head for resource ${resourceId}`);
    return copy(h);
  }
  findHead(resourceId: string): AcceptedHead | null {
    const h = this.state.heads.get(resourceId);
    return h ? copy(h) : null;
  }
  proposal(proposalId: string): ProposalRecord | null {
    const p = this.state.proposals.get(proposalId);
    return p ? copy(p) : null;
  }
  idempotency(key: string, organizationId: string): IdempotencyRecord | null {
    const r = this.state.idempotency.get(idemKey(organizationId, key));
    return r ? copy(r) : null;
  }
  acceptedVersions(): AcceptedProjectVersion[] {
    return copy(this.state.acceptedVersions);
  }
  outbox(): OutboxEvent[] {
    return copy(this.state.outbox);
  }
  audit(): AuditEvent[] {
    return copy(this.state.audit);
  }
}
