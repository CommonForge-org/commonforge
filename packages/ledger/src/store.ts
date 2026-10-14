/**
 * Storage ports for the ledger (plan §A.4).
 *
 * `planCommit` / `planRestore` are synchronous and side-effect free: they read through a
 * {@link LedgerTx} and return a decision carrying {@link LedgerWrite}s, which the adapter applies with
 * {@link applyWrites} inside the same transaction. Every store (in-memory, the Worker's `OrgLedger`
 * DO, VibeControl's Postgres store) implements these ports; the invariants live only in this package.
 *
 * Additions to the §A.4 text (all reads, so the invariants can stay in one place):
 * - `getPreparedReceipt(receiptId)` — `planCommit` must prove each new head is a prepared candidate
 *   (objects retained in canonical) and not just an id the caller typed.
 * - `getIntegrationReceipt(proposalId)` — the proposal hash does not cover the integration commit,
 *   so a new head that is not the candidate revision itself must be the integration commit the
 *   runner produced for this proposal on top of the expected head.
 * - `getCurrentPolicyRevision(projectId)` — `policy_revision_stale` needs the live policy revision.
 * - `getLatestAcceptedVersion(organizationId)` — `acceptedVersionId` is monotonic per organization,
 *   so the next sequence is derived inside the transaction (no clocks, no random ids).
 * - `wasAcceptedHead(resourceId, revisionId)` — restore may only move a head forward to a revision
 *   that was previously an accepted head of that resource; otherwise restore would be a way to
 *   accept unreviewed code. Stores must record every applied `setHead` (including seeds) for this.
 * - `getResourceOrganization(resourceId)` + write `bindResource` — `AcceptedHead` carries no
 *   organization, so the ledger records which organization owns each resource (written once, by
 *   `planBindHead`). Accept and restore refuse resources not bound to the acting organization
 *   instead of trusting a caller-asserted organization.
 *
 * Changed signatures vs §A.4:
 * - `getIdempotency(organizationId, key)` / `putIdempotency(organizationId, rec)`: **idempotency keys
 *   are scoped per organization** (the same key in two organizations is two unrelated requests).
 *   A Postgres store keys the table by `(organization_id, key)`; a DO per org gets this for free.
 *
 * Contract for implementations:
 * - A transaction is atomic and serializable with respect to every other ledger transaction of the
 *   same organization: either all writes of `fn` land or none do, and no other transaction
 *   observes or interleaves with a partial state.
 * - `fn` is synchronous. Durable Object `transactionSync` cannot await; a Postgres store runs the
 *   whole operation as one RPC/statement. Never perform network I/O inside `fn`.
 * - If `fn` throws, nothing it wrote persists.
 * - Records returned by reads must not be mutated by callers; stores may return shared objects.
 */
import type {
  AcceptedHead,
  AcceptedProjectVersion,
  AuditEvent,
  IdempotencyRecord,
  IntegrationReceipt,
  OutboxEvent,
  PreparedReceipt,
  ProposalId,
  ProposalRecord,
  ResourceId,
  RevisionId,
} from '@commonforge-org/core';

export interface LedgerStore {
  /** Run `fn` atomically. Fabric: DO `transactionSync`. VibeControl: one plpgsql RPC per operation. */
  transaction<T>(fn: (tx: LedgerTx) => T): Promise<T>;
}

export interface LedgerTx {
  // ---- §A.4 ----
  getHead(resourceId: ResourceId): AcceptedHead | null;
  setHead(head: AcceptedHead): void;
  getProposal(proposalId: ProposalId): ProposalRecord | null;
  putProposal(p: ProposalRecord): void;
  /** Idempotency keys are scoped per organization. */
  getIdempotency(organizationId: string, key: string): IdempotencyRecord | null;
  putIdempotency(organizationId: string, rec: IdempotencyRecord): void;
  putAcceptedVersion(v: AcceptedProjectVersion): void;
  appendOutbox(event: OutboxEvent): void;
  appendAudit(event: AuditEvent): void;

  // ---- additions (reads only; see module comment) ----
  /** A `prepare-candidate` receipt recorded by the consuming app after verifying the runner result. */
  getPreparedReceipt(receiptId: string): PreparedReceipt | null;
  /** The latest `integrate` receipt recorded for the proposal (after the app verified its signature). */
  getIntegrationReceipt(proposalId: ProposalId): IntegrationReceipt | null;
  /** Current policy revision of the project; `null` means none recorded and is treated as `0`. */
  getCurrentPolicyRevision(projectId: string): number | null;
  /** The accepted project version with the highest `sequence` for the organization, if any. */
  getLatestAcceptedVersion(organizationId: string): AcceptedProjectVersion | null;
  /** True when `revisionId` has ever been the accepted head of `resourceId` (seeded heads included). */
  wasAcceptedHead(resourceId: ResourceId, revisionId: RevisionId): boolean;
  /** The organization that owns the resource (set once by `bindResource`), or `null` if unbound. */
  getResourceOrganization(resourceId: ResourceId): string | null;
  /** Record resource ownership. Written only by `planBindHead`; never changes once set. */
  bindResource(resourceId: ResourceId, organizationId: string): void;
}

/** One state change computed by `planCommit` / `planRestore`, applied by {@link applyWrites}. */
export type LedgerWrite =
  | { op: 'setHead'; head: AcceptedHead }
  | { op: 'putProposal'; proposal: ProposalRecord }
  | { op: 'putAcceptedVersion'; version: AcceptedProjectVersion }
  | { op: 'bindResource'; resourceId: ResourceId; organizationId: string }
  | { op: 'putIdempotency'; organizationId: string; record: IdempotencyRecord }
  | { op: 'appendOutbox'; event: OutboxEvent }
  | { op: 'appendAudit'; event: AuditEvent };

export type LedgerWriteOp = LedgerWrite['op'];
