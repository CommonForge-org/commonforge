/**
 * `OrgLedger`: the per-organization acceptance ledger (plan §A.4, §A.7; P0: one DO per org, §C.2).
 *
 * - Every mutating RPC runs inside `ctx.storage.transactionSync` through {@link SqliteLedgerStore}.
 *   `accept` / `restore` / `bindHead` call the shared `executeCommit` / `executeRestore` /
 *   `executeBindHead`, which plan with the ledger invariants and apply writes only via the shared
 *   `applyWrites`. No network I/O ever happens inside a transaction.
 * - Inputs are validated with core/ledger Zod schemas at the RPC boundary. Every thrown error carries
 *   a stable code prefix (`ledger_invalid_input: ...`, see errors.ts for the HTTP mapping); a policy
 *   refusal is a returned `{ ok: false, code }` decision, not an error.
 * - Organization pinning: every mutating RPC names the acting organization (in its input or as the
 *   first argument). The first *successful* write pins the ledger to it; afterwards any write for
 *   another organization throws `ledger_wrong_organization`.
 * - Record-keeping writes are guarded by `@commonforge-org/ledger`'s record guards (the same rules a
 *   Postgres store enforces; ledger conformance `record.*` scenarios): proposal identity is immutable, terminal
 *   states are final, `updatedAt` is monotonic and bounded by the ledger clock; receipts and
 *   approvals are write-once; candidate/workspace identity is immutable.
 * - Outbox: committed events are drained by `alarm()` to the `OUTBOX` queue in `seq` order, one
 *   message at a time. The alarm is set in the same synchronous turn as the commit (so it is part of
 *   the same storage batch). A row is marked delivered only after `send` resolved; on failure the
 *   row keeps its place (later rows wait), `next_attempt_at` moves out with exponential backoff, and
 *   after {@link OUTBOX_MAX_ATTEMPTS} failures it is dead-lettered (audited, never sent again, no
 *   longer blocking). Delivery is at-least-once; consumers dedupe by `(organizationId, dedupeKey)`.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  AcceptInputSchema,
  ApprovalRefSchema,
  CandidateRecordSchema,
  IdSegmentSchema,
  IntegrationReceiptSchema,
  PreparedReceiptSchema,
  ProposalRecordSchema,
  TaskWorkspaceHandleSchema,
  hashCanonicalSync,
  type AcceptedHead,
  type AcceptedProjectVersion,
  type ApprovalRef,
  type AuditEvent,
  type CandidateRecord,
  type IntegrationReceipt,
  type OutboxEvent,
  type PreparedReceipt,
  type ProposalRecord,
  type TaskWorkspaceHandle,
} from '@commonforge-org/core';
import {
  BindHeadRequestSchema,
  PROPOSAL_TERMINAL_STATES,
  RestoreRequestSchema,
  assertNotFuture,
  checkCandidateUpdate,
  checkWorkspaceUpdate,
  executeBindHead,
  executeCommit,
  executePutProposal,
  executeRestore,
  type CommitDecision,
} from '@commonforge-org/ledger';
import { z } from 'zod';
import type { Env } from '../env.js';
import { ledgerError, toLedgerRpcError } from './errors.js';
import { migrate } from './schema.js';
import { SqliteLedgerStore, type AuditRow, type ConsumedEvent, type OutboxRow, type RefState, type SqliteLedgerTx } from './sqlite-store.js';

export type LedgerResult =
  | { ok: true; replayed: boolean; acceptedVersionId: string }
  | Extract<CommitDecision, { ok: false }>;

export const OUTBOX_BATCH_LIMIT = 100;
export const OUTBOX_RETRY_BASE_MS = 2_000;
export const OUTBOX_RETRY_MAX_MS = 5 * 60_000;
/** Failed sends after which a row is dead-lettered (about 1.3 h of backoff in total). */
export const OUTBOX_MAX_ATTEMPTS = 20;
/** Principal recorded on audit events the ledger itself emits. */
export const LEDGER_SERVICE_ACTOR = { kind: 'service', id: 'org-ledger' } as const;

/** Delay before retrying a row that has failed `attempts` times (attempts >= 1). */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(OUTBOX_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_RETRY_MAX_MS);
}

const PageSchema = z.object({
  after: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
});
const OutboxQuerySchema = PageSchema.extend({ filter: z.enum(['all', 'pending', 'dead']).default('all') });
const ResourceIdArg = z.string().min(1);
const ConsumeSchema = z.object({
  dedupeKey: z.string().min(1).max(512),
  eventId: z.string().min(1).max(256).nullable().default(null),
  kind: z.string().min(1).max(64),
  outcome: z.string().min(1).max(200),
});
const ReconciliationInputSchema = z.object({
  resourceId: z.string().min(1),
  revisionId: z.string().min(1),
  state: z.enum(['synced', 'pending', 'diverged']),
  /** sha observed on the canonical ref (audit detail only) */
  observedSha: z.string().max(64).nullable().optional(),
  /** consume this event in the same transaction (no effect when it was already consumed) */
  consume: ConsumeSchema.optional(),
});
export type ConsumeInput = z.input<typeof ConsumeSchema>;
export type ReconciliationInput = z.input<typeof ReconciliationInputSchema>;

export interface ReconciliationResult {
  /** the head is still at `revisionId` (otherwise nothing was changed: a newer head exists) */
  headMatches: boolean;
  /** the state changed (an audit event was written) */
  changed: boolean;
  /** the event was consumed by this call */
  consumed: boolean;
  /** the event had already been consumed earlier; nothing was written */
  alreadyConsumed: boolean;
}

function toResult(d: CommitDecision): LedgerResult {
  if (!d.ok) return d;
  return { ok: true, replayed: d.replayed === true, acceptedVersionId: d.acceptedVersionId };
}

const wroteOutbox = (d: CommitDecision): boolean => d.ok && d.replayed !== true && d.writes.some((w) => w.op === 'appendOutbox');

function outboxSubject(event: OutboxEvent): AuditEvent['subject'] {
  if (event.kind === 'projection-refresh') return { kind: 'resource', id: event.payload.resourceIds[0] ?? event.eventId };
  return { kind: 'resource', id: event.payload.resourceId };
}

export interface DrainResult {
  sent: number;
  /** a send failed and the row was rescheduled (the drain stopped there) */
  failed: boolean;
  deadLettered: number;
  /** the head-of-line row is still backing off; the alarm is set for its retry time */
  waiting: boolean;
  remaining: boolean;
}

export class OrgLedger extends DurableObject<Env> {
  readonly #store: SqliteLedgerStore;
  #draining: Promise<DrainResult> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = new SqliteLedgerStore(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage);
      // recovery: never leave pending outbox rows without an alarm
      if (this.#store.transactionSync((tx) => tx.hasPendingOutbox()) && (await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now());
      }
    });
  }

  /**
   * Test seam: the ledger clock. Only tests running inside the DO (`runInDurableObject`) set it, to
   * run conformance record scenarios through the real `putProposal` at the scenario's time. An
   * instance field, so it is not reachable over RPC.
   */
  clockForTests: (() => string) | null = null;

  #now(): string {
    return this.clockForTests?.() ?? new Date().toISOString();
  }

  /** Run an RPC body, converting every error to a coded `LedgerRpcError`. */
  async #rpc<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw toLedgerRpcError(e);
    }
  }

  /**
   * Run a ledger operation and, in the same synchronous turn as its commit, arm the outbox alarm,
   * so the alarm write lands in the same storage batch as the outbox rows (no await in between).
   */
  #commit(op: (tx: SqliteLedgerTx) => CommitDecision): CommitDecision {
    const d = this.#store.transactionSync(op);
    if (wroteOutbox(d)) void this.ctx.storage.setAlarm(Date.now());
    return d;
  }

  /** Record-keeping write on behalf of `organizationId`: check the pin, write, pin on success. */
  #recordTx<T>(organizationId: string, fn: (tx: SqliteLedgerTx) => T): T {
    const org = IdSegmentSchema.parse(organizationId);
    return this.#store.transactionSync((tx) => {
      tx.checkLedgerOrganization(org);
      const r = fn(tx);
      tx.pinLedgerOrganization(org);
      return r;
    });
  }

  // ------------------------------------------------------------------ ledger operations

  /** Conditional acceptance (§B.9). The acting organization is the proposal's. */
  async accept(input: unknown): Promise<LedgerResult> {
    return this.#rpc(() => {
      const parsed = AcceptInputSchema.parse(input);
      const now = this.#now();
      const d = this.#commit((tx) => {
        const proposal = tx.getProposal(parsed.proposalId);
        if (proposal) tx.checkLedgerOrganization(proposal.organizationId);
        const decision = executeCommit(tx, parsed, now);
        if (decision.ok && proposal) tx.pinLedgerOrganization(proposal.organizationId);
        return decision;
      });
      return toResult(d);
    });
  }

  /** Forward restore of one resource head under CAS. Pins the organization only on success. */
  async restore(input: unknown): Promise<LedgerResult> {
    return this.#rpc(() => {
      const parsed = RestoreRequestSchema.parse(input);
      const now = this.#now();
      const d = this.#commit((tx) => {
        tx.checkLedgerOrganization(parsed.organizationId);
        const decision = executeRestore(tx, parsed, now);
        if (decision.ok) tx.pinLedgerOrganization(parsed.organizationId);
        return decision;
      });
      return toResult(d);
    });
  }

  /** Genesis: create a resource's first head and bind it to the organization (pins only on success). */
  async bindHead(input: unknown): Promise<LedgerResult> {
    return this.#rpc(() => {
      const parsed = BindHeadRequestSchema.parse(input);
      const now = this.#now();
      const d = this.#commit((tx) => {
        tx.checkLedgerOrganization(parsed.organizationId);
        const decision = executeBindHead(tx, parsed, now);
        if (decision.ok) tx.pinLedgerOrganization(parsed.organizationId);
        return decision;
      });
      return toResult(d);
    });
  }

  // ------------------------------------------------------------------ record keeping (never moves heads)

  /** Create or update a proposal under the rules of the ledger's `checkProposalUpdate` (via `executePutProposal`). */
  async putProposal(record: unknown): Promise<ProposalRecord> {
    return this.#rpc(() => {
      const p = ProposalRecordSchema.parse(record);
      const now = this.#now();
      return this.#recordTx(p.organizationId, (tx) => executePutProposal(tx, p, now).proposal);
    });
  }

  /** Write-once approval of an existing, non-terminal proposal. */
  async putApproval(organizationId: string, approval: unknown): Promise<ApprovalRef> {
    return this.#rpc(() => {
      const a = ApprovalRefSchema.parse(approval);
      assertNotFuture('approvedAt', a.approvedAt, Date.now());
      return this.#recordTx(organizationId, (tx) => {
        const proposal = tx.getProposal(a.proposalId);
        if (!proposal) throw ledgerError('ledger_not_found', `unknown proposal ${a.proposalId}`);
        if (PROPOSAL_TERMINAL_STATES.includes(proposal.state)) throw ledgerError('ledger_conflict', `proposal ${a.proposalId} is ${proposal.state}`);
        tx.putApproval(a);
        return a;
      });
    });
  }

  /** Candidate lifecycle record; the frozen candidate is immutable, state follows core's machine. */
  async putCandidate(organizationId: string, record: unknown): Promise<CandidateRecord> {
    return this.#rpc(() => {
      const c = CandidateRecordSchema.parse(record);
      return this.#recordTx(organizationId, (tx) => {
        if (checkCandidateUpdate(tx.getCandidate(c.candidate.candidateId), c) === 'write') tx.putCandidate(c);
        return c;
      });
    });
  }

  /** Task workspace handle; identity is immutable, state follows core's machine. */
  async putWorkspace(organizationId: string, handle: unknown): Promise<TaskWorkspaceHandle> {
    return this.#rpc(() => {
      const w = TaskWorkspaceHandleSchema.parse(handle);
      return this.#recordTx(organizationId, (tx) => {
        if (checkWorkspaceUpdate(tx.getWorkspace(w.taskWorkspaceId), w) === 'write') tx.putWorkspace(w);
        return w;
      });
    });
  }

  /** Record a `prepare-candidate` receipt (the caller verified the runner signature first). Write-once. */
  async recordPreparedReceipt(organizationId: string, receipt: unknown): Promise<void> {
    return this.#rpc(() => {
      const r = PreparedReceiptSchema.parse(receipt);
      assertNotFuture('preparedAt', r.preparedAt, Date.now());
      this.#recordTx(organizationId, (tx) => tx.putPreparedReceipt(r));
    });
  }

  /**
   * Record an `integrate` receipt (the caller verified the runner signature first). Write-once per
   * (proposalId, jobId); the proposal must exist and not be terminal (an accepted proposal's
   * receipts are frozen), and a new job's receipt may not be older than the latest one.
   */
  async recordIntegrationReceipt(organizationId: string, receipt: unknown): Promise<void> {
    return this.#rpc(() => {
      const r = IntegrationReceiptSchema.parse(receipt);
      assertNotFuture('integratedAt', r.integratedAt, Date.now());
      this.#recordTx(organizationId, (tx) => {
        const proposal = tx.getProposal(r.proposalId);
        if (!proposal) throw ledgerError('ledger_not_found', `unknown proposal ${r.proposalId}`);
        if (PROPOSAL_TERMINAL_STATES.includes(proposal.state)) {
          throw ledgerError('ledger_conflict', `proposal ${r.proposalId} is ${proposal.state}; its receipts are frozen`);
        }
        const latest = tx.getIntegrationReceipt(r.proposalId);
        if (latest && latest.jobId !== r.jobId && r.integratedAt < latest.integratedAt) {
          throw ledgerError('ledger_conflict', `integration receipt ${r.jobId} is older than the recorded ${latest.jobId}`);
        }
        tx.putIntegrationReceipt(r);
      });
    });
  }

  /** Set a project's current policy revision (never decreases). */
  async setPolicyRevision(organizationId: string, projectId: string, policyRevision: number): Promise<void> {
    return this.#rpc(() => {
      const project = IdSegmentSchema.parse(projectId);
      const rev = z.number().int().nonnegative().parse(policyRevision);
      this.#recordTx(organizationId, (tx) => {
        const current = tx.getCurrentPolicyRevision(project);
        if (current !== null && rev < current) throw ledgerError('ledger_conflict', `policy revision for ${project} cannot decrease (${current} -> ${rev})`);
        tx.setPolicyRevision(project, rev);
      });
    });
  }

  // ------------------------------------------------------------------ consumer side (Task 17; never moves heads)

  /** Consumer dedupe: the record of an already consumed `(organizationId, dedupeKey)`, or null. */
  async getConsumedEvent(organizationId: string, dedupeKey: string): Promise<ConsumedEvent | null> {
    return this.#rpc(() => {
      const org = IdSegmentSchema.parse(organizationId);
      const key = z.string().min(1).parse(dedupeKey);
      return this.#store.transactionSync((tx) => tx.getConsumed(org, key));
    });
  }

  /** Mark an event consumed; `false` when it already was (a duplicate delivery). */
  async consumeEvent(organizationId: string, input: ConsumeInput): Promise<boolean> {
    return this.#rpc(() => {
      const c = ConsumeSchema.parse(input);
      const at = this.#now();
      return this.#recordTx(organizationId, (tx) => tx.putConsumed({ organizationId, ...c, consumedAt: at }));
    });
  }

  /**
   * Record what the canonical ref was observed to be relative to a head (`synced` / `diverged`, or
   * back to `pending`), and optionally consume the event that produced the observation, atomically.
   * Projection health only: the head itself never moves. A change is applied only while the head is
   * still at `revisionId`; every change is audited (`head.reconciliation_changed`).
   */
  async recordReconciliation(organizationId: string, input: ReconciliationInput): Promise<ReconciliationResult> {
    return this.#rpc(() => {
      const r = ReconciliationInputSchema.parse(input);
      const at = this.#now();
      return this.#recordTx(organizationId, (tx) => {
        const out: ReconciliationResult = { headMatches: false, changed: false, consumed: false, alreadyConsumed: false };
        if (r.consume && tx.getConsumed(organizationId, r.consume.dedupeKey)) return { ...out, alreadyConsumed: true };
        const head = tx.getHead(r.resourceId);
        out.headMatches = head !== null && head.revisionId === r.revisionId;
        const from = tx.setReconciliation(r.resourceId, r.revisionId, r.state);
        if (out.headMatches && r.observedSha !== undefined) {
          tx.putRefState({ resourceId: r.resourceId, revisionId: r.revisionId, state: r.state, observedSha: r.observedSha, observedAt: at });
        }
        if (from !== null) {
          out.changed = true;
          tx.appendAudit({
            auditId: `au-${hashCanonicalSync([organizationId, 'head.reconciliation_changed', r.resourceId, r.revisionId, from, r.state, at]).slice(0, 32)}`,
            organizationId,
            at: at as AuditEvent['at'],
            actor: LEDGER_SERVICE_ACTOR,
            action: 'head.reconciliation_changed',
            subject: { kind: 'resource', id: r.resourceId },
            detail: { revisionId: r.revisionId, from, to: r.state, ...(r.observedSha !== undefined ? { observedSha: r.observedSha } : {}), ...(r.consume ? { dedupeKey: r.consume.dedupeKey } : {}) },
          });
        }
        if (r.consume) out.consumed = tx.putConsumed({ organizationId, ...r.consume, consumedAt: at });
        return out;
      });
    });
  }

  /** Last canonical-ref observation recorded for a resource (lease candidates, review I-1). */
  async getRefState(resourceId: string): Promise<RefState | null> {
    return this.#rpc(() => {
      const id = ResourceIdArg.parse(resourceId);
      return this.#store.transactionSync((tx) => tx.getRefState(id));
    });
  }

  // ------------------------------------------------------------------ reads

  async getAcceptedVersion(acceptedVersionId: string): Promise<AcceptedProjectVersion | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(acceptedVersionId);
      return this.#store.transactionSync((tx) => tx.getAcceptedVersion(id));
    });
  }

  async getOrganization(): Promise<string | null> {
    return this.#rpc(() => this.#store.transactionSync((tx) => tx.getLedgerOrganization()));
  }

  async getHead(resourceId: string): Promise<AcceptedHead | null> {
    return this.#rpc(() => {
      const id = ResourceIdArg.parse(resourceId);
      return this.#store.transactionSync((tx) => tx.getHead(id));
    });
  }

  async listHeads(): Promise<AcceptedHead[]> {
    return this.#rpc(() => this.#store.transactionSync((tx) => tx.listHeads()));
  }

  async getResourceOrganization(resourceId: string): Promise<string | null> {
    return this.#rpc(() => {
      const id = ResourceIdArg.parse(resourceId);
      return this.#store.transactionSync((tx) => tx.getResourceOrganization(id));
    });
  }

  async getProposal(proposalId: string): Promise<ProposalRecord | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(proposalId);
      return this.#store.transactionSync((tx) => tx.getProposal(id));
    });
  }

  async getPreparedReceipt(receiptId: string): Promise<PreparedReceipt | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(receiptId);
      return this.#store.transactionSync((tx) => tx.getPreparedReceipt(id));
    });
  }

  /** The latest recorded integration receipt of a proposal (review I1: the authority, not D1). */
  async getIntegrationReceipt(proposalId: string): Promise<IntegrationReceipt | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(proposalId);
      return this.#store.transactionSync((tx) => tx.getIntegrationReceipt(id));
    });
  }

  async listProposals(projectId?: string): Promise<ProposalRecord[]> {
    return this.#rpc(() => {
      const id = z.string().min(1).optional().parse(projectId);
      return this.#store.transactionSync((tx) => tx.listProposals(id));
    });
  }

  async listApprovals(proposalId: string): Promise<ApprovalRef[]> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(proposalId);
      return this.#store.transactionSync((tx) => tx.listApprovals(id));
    });
  }

  async getCandidate(candidateId: string): Promise<CandidateRecord | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(candidateId);
      return this.#store.transactionSync((tx) => tx.getCandidate(id));
    });
  }

  async listCandidates(resourceId: string): Promise<CandidateRecord[]> {
    return this.#rpc(() => {
      const id = ResourceIdArg.parse(resourceId);
      return this.#store.transactionSync((tx) => tx.listCandidates(id));
    });
  }

  async getWorkspace(taskWorkspaceId: string): Promise<TaskWorkspaceHandle | null> {
    return this.#rpc(() => {
      const id = z.string().min(1).parse(taskWorkspaceId);
      return this.#store.transactionSync((tx) => tx.getWorkspace(id));
    });
  }

  /** Accepted versions with `sequence > after`, ascending (one DO serves one organization). */
  async listAcceptedVersions(query: { after?: number; limit?: number } = {}): Promise<AcceptedProjectVersion[]> {
    return this.#rpc(() => {
      const q = PageSchema.parse(query);
      return this.#store.transactionSync((tx) => tx.listAcceptedVersions(q.after, q.limit));
    });
  }

  /** Outbox rows with `seq > after`, ascending; `filter`: all (default), pending, or dead. */
  async listOutbox(query: { after?: number; limit?: number; filter?: 'all' | 'pending' | 'dead' } = {}): Promise<OutboxRow[]> {
    return this.#rpc(() => {
      const q = OutboxQuerySchema.parse(query);
      return this.#store.transactionSync((tx) => tx.listOutbox({ filter: q.filter, afterSeq: q.after, limit: q.limit }));
    });
  }

  /** Dead-lettered outbox rows (exceeded {@link OUTBOX_MAX_ATTEMPTS}); never sent again automatically. */
  async listDeadLetters(query: { after?: number; limit?: number } = {}): Promise<OutboxRow[]> {
    return this.#rpc(() => {
      const q = PageSchema.parse(query);
      return this.#store.transactionSync((tx) => tx.listOutbox({ filter: 'dead', afterSeq: q.after, limit: q.limit }));
    });
  }

  /** Audit rows with `seq > after`, ascending. */
  async listAudit(query: { after?: number; limit?: number } = {}): Promise<AuditRow[]> {
    return this.#rpc(() => {
      const q = PageSchema.parse(query);
      return this.#store.transactionSync((tx) => tx.listAudit(q.after, q.limit));
    });
  }

  // ------------------------------------------------------------------ outbox delivery

  override async alarm(): Promise<void> {
    await this.drainOutbox();
  }

  /** Drain pending outbox rows to the queue (single-flight). Exposed for tests and ops. */
  async drainOutbox(): Promise<DrainResult> {
    if (!this.#draining) {
      this.#draining = this.#drain().finally(() => {
        this.#draining = null;
      });
    }
    return this.#draining;
  }

  async #drain(): Promise<DrainResult> {
    const result: DrainResult = { sent: 0, failed: false, deadLettered: 0, waiting: false, remaining: false };
    const rows = this.#store.transactionSync((tx) => tx.listOutbox({ filter: 'pending', afterSeq: 0, limit: OUTBOX_BATCH_LIMIT }));
    for (const row of rows) {
      if (row.nextAttemptAt > Date.now()) {
        // head of line is backing off: later rows wait for it
        await this.ctx.storage.setAlarm(row.nextAttemptAt);
        return { ...result, waiting: true, remaining: true };
      }
      try {
        // network I/O: strictly outside any transaction
        await this.env.OUTBOX.send(row.event, { contentType: 'json' });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const failure = this.#store.transactionSync((tx) => {
          const attempts = tx.markOutboxFailed(row.seq, message, (n) => Date.now() + outboxBackoffMs(n));
          if (attempts < OUTBOX_MAX_ATTEMPTS) return { dead: false, attempts };
          const at = this.#now();
          tx.markOutboxDead(row.seq, at);
          tx.appendAudit({
            auditId: `au-${hashCanonicalSync([row.event.organizationId, 'outbox.dead_lettered', row.event.eventId]).slice(0, 32)}`,
            organizationId: row.event.organizationId,
            at: at as AuditEvent['at'],
            actor: LEDGER_SERVICE_ACTOR,
            action: 'outbox.dead_lettered',
            subject: outboxSubject(row.event),
            detail: { eventId: row.event.eventId, kind: row.event.kind, dedupeKey: row.event.dedupeKey, attempts, lastError: message.slice(0, 1000) },
          });
          return { dead: true, attempts };
        });
        if (failure.dead) {
          result.deadLettered++;
          continue;
        }
        await this.ctx.storage.setAlarm(Date.now() + outboxBackoffMs(failure.attempts));
        return { ...result, failed: true, remaining: true };
      }
      const now = this.#now();
      if (this.#store.transactionSync((tx) => tx.markOutboxSent(row.seq, now))) result.sent++;
    }
    result.remaining = this.#store.transactionSync((tx) => tx.hasPendingOutbox());
    if (result.remaining) await this.ctx.storage.setAlarm(Date.now());
    return result;
  }
}
