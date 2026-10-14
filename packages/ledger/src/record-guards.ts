/**
 * Guards for the record-keeping writes that `planCommit` later trusts (proposals, candidates, task
 * workspaces). Pure functions with no storage, so every store enforces the same rules: the Worker's
 * OrgLedger DO, VibeControl's Postgres store, the in-memory store. A store's record-keeping endpoint
 * must call these, or the proposal executor {@link executePutProposal}, before writing; the ledger
 * conformance scenarios (`record.*`) check this for proposals.
 *
 * Proposal rules (`checkProposalUpdate`):
 *  - `createdAt` / `updatedAt` may not be later than the ledger clock (+ {@link CLOCK_SKEW_MS}),
 *    and `createdAt <= updatedAt`.
 *  - `accepted` is set only by acceptance (planCommit's `putProposal` write).
 *  - Identity is immutable: `organizationId`, `projectId`, `changeId`, `createdAt`.
 *  - Terminal states (`accepted`, `rejected`, `superseded`, `withdrawn`) are final. An identical
 *    re-put of the stored record is a no-op; anything else is refused.
 *  - Allowed transitions: core's `PROPOSAL_TRANSITIONS` minus `accepted`, plus same-state updates:
 *    open <-> prepared, open|prepared -> rejected|superseded|withdrawn.
 *  - `updatedAt` never decreases, and must strictly increase when any hashed field changes
 *    (`proposalHash`, snapshots, resource/asset changes, read dependencies, policy revision), so
 *    approvals given before the change are invalid afterwards (no A -> B -> A replay).
 *
 * Refusals throw {@link LedgerRecordError}: `record_conflict` (HTTP 409: immutable field, terminal
 * state, disallowed transition, monotonic value going back) or `record_invalid_input` (HTTP 400:
 * schema-invalid record, timestamp in the future, createdAt after updatedAt).
 */
import {
  CANDIDATE_TRANSITIONS,
  CoreError,
  PROPOSAL_TRANSITIONS,
  ProposalRecordSchema,
  ProposalStateSchema,
  TASK_WORKSPACE_TRANSITIONS,
  canTransition,
  canonicalJson,
  isTerminal,
  type CandidateRecord,
  type ProposalRecord,
  type ProposalState,
  type TaskWorkspaceHandle,
} from '@commonforge-org/core';
import type { z } from 'zod';
import type { LedgerTx } from './store.js';

export const LEDGER_RECORD_ERROR_CODES = ['record_conflict', 'record_invalid_input'] as const;
export type LedgerRecordErrorCode = (typeof LEDGER_RECORD_ERROR_CODES)[number];

/** HTTP status a consuming app should use for each record error code. */
export const LEDGER_RECORD_ERROR_STATUS: Readonly<Record<LedgerRecordErrorCode, number>> = {
  record_conflict: 409,
  record_invalid_input: 400,
};

/** A refused record-keeping write. `detail` is the human-readable reason without the code prefix. */
export class LedgerRecordError extends CoreError<LedgerRecordErrorCode> {
  readonly detail: string;
  constructor(code: LedgerRecordErrorCode, detail: string) {
    super(code, detail);
    this.name = 'LedgerRecordError';
    this.detail = detail;
  }
}

export function isLedgerRecordError(e: unknown, code?: LedgerRecordErrorCode): e is LedgerRecordError {
  return e instanceof LedgerRecordError && (code === undefined || e.code === code);
}

const conflict = (detail: string) => new LedgerRecordError('record_conflict', detail);
const invalid = (detail: string) => new LedgerRecordError('record_invalid_input', detail);

/** Tolerated caller clock skew for caller-supplied timestamps. */
export const CLOCK_SKEW_MS = 5_000;

/** Proposal states that never change again (derived from core's `PROPOSAL_TRANSITIONS`). */
export const PROPOSAL_TERMINAL_STATES: readonly ProposalState[] = ProposalStateSchema.options.filter((s) => isTerminal(PROPOSAL_TRANSITIONS, s));

/**
 * Proposal transitions a record-keeping write may perform: core's `PROPOSAL_TRANSITIONS` without
 * `accepted` (set only by acceptance), plus same-state updates of non-terminal proposals.
 */
export const PROPOSAL_RECORD_TRANSITIONS: Readonly<Record<ProposalState, readonly ProposalState[]>> = {
  open: ['open', 'prepared', 'rejected', 'superseded', 'withdrawn'],
  prepared: ['prepared', 'open', 'rejected', 'superseded', 'withdrawn'],
  accepted: [],
  rejected: [],
  superseded: [],
  withdrawn: [],
};

const HASHED_FIELDS = [
  'proposalHash',
  'baseSnapshotId',
  'candidateSnapshotId',
  'resourceChanges',
  'readDependencies',
  'assetManifestChanges',
  'policyRevision',
] as const satisfies readonly (keyof ProposalRecord)[];

const IMMUTABLE_FIELDS = ['organizationId', 'projectId', 'changeId', 'createdAt'] as const satisfies readonly (keyof ProposalRecord)[];

/** Refuse a caller timestamp later than the ledger clock plus skew (`record_invalid_input`). */
export function assertNotFuture(field: string, value: string, nowMs: number): void {
  if (Date.parse(value) > nowMs + CLOCK_SKEW_MS) {
    throw invalid(`${field} ${value} is later than the ledger clock (${new Date(nowMs).toISOString()})`);
  }
}

/**
 * Decide whether `next` may be stored over `existing` (null = new record).
 * Returns `'noop'` for an identical re-put, `'write'` otherwise; throws {@link LedgerRecordError}.
 */
export function checkProposalUpdate(existing: ProposalRecord | null, next: ProposalRecord, nowMs: number): 'noop' | 'write' {
  if (existing && canonicalJson(existing) === canonicalJson(next)) return 'noop';
  assertNotFuture('createdAt', next.createdAt, nowMs);
  assertNotFuture('updatedAt', next.updatedAt, nowMs);
  if (next.createdAt > next.updatedAt) throw invalid('createdAt is later than updatedAt');
  if (next.state === 'accepted') throw conflict('proposal state "accepted" is set only by accept()');
  if (!existing) return 'write';

  for (const f of IMMUTABLE_FIELDS) {
    if (existing[f] !== next[f]) throw conflict(`proposal ${next.proposalId}: ${f} is immutable`);
  }
  if (PROPOSAL_TERMINAL_STATES.includes(existing.state)) {
    throw conflict(`proposal ${next.proposalId} is ${existing.state} and final`);
  }
  if (!PROPOSAL_RECORD_TRANSITIONS[existing.state].includes(next.state)) {
    throw conflict(`proposal ${next.proposalId}: ${existing.state} -> ${next.state} is not allowed`);
  }
  if (next.updatedAt < existing.updatedAt) {
    throw conflict(`proposal ${next.proposalId}: updatedAt cannot decrease (${existing.updatedAt} -> ${next.updatedAt})`);
  }
  const hashedChanged = HASHED_FIELDS.some((f) => canonicalJson(existing[f]) !== canonicalJson(next[f]));
  if (hashedChanged && next.updatedAt === existing.updatedAt) {
    throw conflict(`proposal ${next.proposalId}: hashed content changed without advancing updatedAt`);
  }
  return 'write';
}

/** Candidate re-put: the frozen candidate is immutable; state follows core's candidate machine. */
export function checkCandidateUpdate(existing: CandidateRecord | null, next: CandidateRecord): 'noop' | 'write' {
  if (!existing) return 'write';
  if (canonicalJson(existing) === canonicalJson(next)) return 'noop';
  if (canonicalJson(existing.candidate) !== canonicalJson(next.candidate)) {
    throw conflict(`candidate ${next.candidate.candidateId}: the frozen candidate (resource, sha, base, ...) is immutable`);
  }
  if (existing.state !== next.state && !canTransition(CANDIDATE_TRANSITIONS, existing.state, next.state)) {
    throw conflict(`candidate ${next.candidate.candidateId}: ${existing.state} -> ${next.state} is not allowed`);
  }
  if (next.updatedAt < existing.updatedAt) throw conflict(`candidate ${next.candidate.candidateId}: updatedAt cannot decrease`);
  return 'write';
}

/** Workspace re-put: identity (resource, base, provider, coords) is immutable; state follows core's machine. */
export function checkWorkspaceUpdate(existing: TaskWorkspaceHandle | null, next: TaskWorkspaceHandle): 'noop' | 'write' {
  if (!existing) return 'write';
  if (canonicalJson(existing) === canonicalJson(next)) return 'noop';
  const { state: _a, ...idA } = existing;
  const { state: _b, ...idB } = next;
  if (canonicalJson(idA) !== canonicalJson(idB)) {
    throw conflict(`workspace ${next.taskWorkspaceId}: resource/base/provider/coords are immutable`);
  }
  if (!canTransition(TASK_WORKSPACE_TRANSITIONS, existing.state, next.state)) {
    throw conflict(`workspace ${next.taskWorkspaceId}: ${existing.state} -> ${next.state} is not allowed`);
  }
  return 'write';
}

/**
 * Record-keeping proposal write over the {@link LedgerTx} port: parse, guard with
 * {@link checkProposalUpdate} against the stored record and write unless it is a no-op. Call inside
 * one store transaction; `now` is the ledger clock (UTC ISO timestamp). Throws
 * {@link LedgerRecordError}; nothing is written on a throw.
 */
export function executePutProposal(tx: LedgerTx, input: z.input<typeof ProposalRecordSchema>, now: string): { result: 'noop' | 'write'; proposal: ProposalRecord } {
  const parsed = ProposalRecordSchema.safeParse(input);
  if (!parsed.success) throw invalid(`invalid ProposalRecord: ${parsed.error.message}`);
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw invalid(`now must be a timestamp, got ${JSON.stringify(now)}`);
  const p = parsed.data;
  const result = checkProposalUpdate(tx.getProposal(p.proposalId), p, nowMs);
  if (result === 'write') tx.putProposal(p);
  return { result, proposal: p };
}
