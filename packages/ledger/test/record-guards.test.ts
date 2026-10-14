import {
  CandidateRecordSchema,
  PROPOSAL_TRANSITIONS,
  ProposalStateSchema,
  TaskWorkspaceHandleSchema,
  isCoreError,
  type ProposalRecord,
} from '@commonforge-org/core';
import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_MS,
  FIXTURE_ACTOR,
  FIXTURE_TIME,
  InMemoryLedgerStore,
  LedgerRecordError,
  PROPOSAL_RECORD_TRANSITIONS,
  PROPOSAL_TERMINAL_STATES,
  acceptFixture,
  assertNotFuture,
  baseRev,
  checkCandidateUpdate,
  checkProposalUpdate,
  checkWorkspaceUpdate,
  executePutProposal,
  isLedgerRecordError,
} from '../src/index.js';

const NOW_MS = Date.parse(FIXTURE_TIME.now);
const proposal = (): ProposalRecord => acceptFixture().proposal;

function refusal(fn: () => unknown): LedgerRecordError {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerRecordError) return e;
    throw e;
  }
  throw new Error('expected a LedgerRecordError');
}

describe('record guards: proposals', () => {
  it('keeps the transition table the worker shipped with', () => {
    expect(PROPOSAL_TERMINAL_STATES).toEqual(['accepted', 'rejected', 'superseded', 'withdrawn']);
    const sorted = Object.fromEntries(Object.entries(PROPOSAL_RECORD_TRANSITIONS).map(([k, v]) => [k, [...v].sort()]));
    expect(sorted).toEqual({
      open: ['open', 'prepared', 'rejected', 'superseded', 'withdrawn'],
      prepared: ['open', 'prepared', 'rejected', 'superseded', 'withdrawn'],
      accepted: [],
      rejected: [],
      superseded: [],
      withdrawn: [],
    });
  });

  it("is core's PROPOSAL_TRANSITIONS without accepted, plus same-state updates of live proposals", () => {
    for (const s of ProposalStateSchema.options) {
      const want = PROPOSAL_TERMINAL_STATES.includes(s) ? [] : [s, ...PROPOSAL_TRANSITIONS[s].filter((t) => t !== 'accepted')];
      expect([...PROPOSAL_RECORD_TRANSITIONS[s]].sort()).toEqual(want.sort());
    }
  });

  it('new records: write; accepted, future and inverted timestamps are refused', () => {
    const p = proposal();
    expect(checkProposalUpdate(null, p, NOW_MS)).toBe('write');
    expect(refusal(() => checkProposalUpdate(null, { ...p, state: 'accepted' }, NOW_MS))).toMatchObject({ code: 'record_conflict', detail: expect.stringMatching(/set only by accept/) });
    expect(refusal(() => checkProposalUpdate(null, { ...p, updatedAt: '2099-01-01T00:00:00.000Z' }, NOW_MS))).toMatchObject({ code: 'record_invalid_input', detail: expect.stringMatching(/^updatedAt/) });
    expect(refusal(() => checkProposalUpdate(null, { ...p, createdAt: FIXTURE_TIME.approved }, NOW_MS))).toMatchObject({ code: 'record_invalid_input' });
  });

  it('A: terminal proposals stay terminal; an identical re-put is a no-op', () => {
    for (const terminal of ['withdrawn', 'rejected', 'superseded', 'accepted'] as const) {
      const stored = { ...proposal(), state: terminal };
      expect(checkProposalUpdate(stored, stored, NOW_MS)).toBe('noop');
      expect(refusal(() => checkProposalUpdate(stored, proposal(), NOW_MS)).detail).toMatch(new RegExp(`${terminal} and final`));
    }
  });

  it('B: updatedAt never decreases; hashed content needs a newer updatedAt', () => {
    const p = proposal();
    expect(refusal(() => checkProposalUpdate(p, { ...p, updatedAt: FIXTURE_TIME.created }, NOW_MS)).detail).toMatch(/updatedAt cannot decrease/);
    expect(refusal(() => checkProposalUpdate(p, { ...p, policyRevision: 2 }, NOW_MS)).detail).toMatch(/without advancing updatedAt/);
    expect(checkProposalUpdate(p, { ...p, policyRevision: 2, updatedAt: FIXTURE_TIME.approved }, NOW_MS)).toBe('write');
    expect(checkProposalUpdate(p, { ...p, state: 'open' }, NOW_MS)).toBe('write');
  });

  it('C: identity fields are immutable', () => {
    const p = proposal();
    for (const patch of [{ projectId: 'proj-other' }, { changeId: 'chg-other' }, { createdAt: '2025-12-31T00:00:00.000Z' }, { organizationId: 'org-2' }]) {
      expect(refusal(() => checkProposalUpdate(p, { ...p, ...patch } as ProposalRecord, NOW_MS)).detail).toMatch(/is immutable/);
    }
  });

  it('D: clock skew is tolerated up to CLOCK_SKEW_MS', () => {
    expect(() => assertNotFuture('x', new Date(NOW_MS + CLOCK_SKEW_MS).toISOString(), NOW_MS)).not.toThrow();
    expect(() => assertNotFuture('x', new Date(NOW_MS + CLOCK_SKEW_MS + 1).toISOString(), NOW_MS)).toThrow(LedgerRecordError);
  });

  it('LedgerRecordError is a coded CoreError', () => {
    const e = refusal(() => checkProposalUpdate(null, { ...proposal(), state: 'accepted' }, NOW_MS));
    expect(isCoreError(e)).toBe(true);
    expect(isLedgerRecordError(e, 'record_conflict')).toBe(true);
    expect(e.message).toBe(`record_conflict: ${e.detail}`);
  });

  it('executePutProposal guards and writes through the LedgerTx port', () => {
    const store = new InMemoryLedgerStore();
    const p = proposal();
    expect(store.transactionSync((tx) => executePutProposal(tx, p, FIXTURE_TIME.now)).result).toBe('write');
    expect(store.transactionSync((tx) => executePutProposal(tx, p, FIXTURE_TIME.now)).result).toBe('noop');
    expect(() => store.transactionSync((tx) => executePutProposal(tx, { ...p, state: 'accepted' }, FIXTURE_TIME.now))).toThrow(/^record_conflict: /);
    expect(() => store.transactionSync((tx) => executePutProposal(tx, { ...p, proposalHash: 'nope' }, FIXTURE_TIME.now))).toThrow(/^record_invalid_input: /);
    expect(store.proposal(p.proposalId)?.state).toBe('prepared');
  });
});

describe('record guards: candidates and workspaces', () => {
  const fork = { kind: 'artifacts', namespace: 'commonforge-org-1-tasks', repoName: 'ws-1', repoId: 'ws-1', remoteUrl: 'https://acct.artifacts.cloudflare.net/git/commonforge-org-1-tasks/ws-1.git' } as const;
  const candidate = {
    candidateId: 'cand:ws-1:' + 'c'.repeat(40),
    taskWorkspaceId: 'ws-1',
    fork,
    resourceId: 'r1',
    baseRevision: baseRev('r1'),
    sha: 'c'.repeat(40),
    treeId: 'd'.repeat(40),
    frozenAt: FIXTURE_TIME.prepared,
    submitter: FIXTURE_ACTOR,
    changedPaths: ['src/a.ts'],
  };
  const rec = (over: Record<string, unknown> = {}) =>
    CandidateRecordSchema.parse({ candidate, state: 'frozen', preparedReceiptId: null, updatedAt: FIXTURE_TIME.prepared, ...over });
  const ws = (over: Record<string, unknown> = {}) =>
    TaskWorkspaceHandleSchema.parse({ taskWorkspaceId: 'ws-1', resourceId: 'r1', baseRevision: baseRev('r1'), provider: 'artifacts', coords: fork, state: 'writable', ...over });

  it('candidates: frozen candidate immutable, state follows the machine, updatedAt monotonic', () => {
    const frozen = rec();
    const prepared = rec({ state: 'prepared', preparedReceiptId: 'prep-1', updatedAt: FIXTURE_TIME.approved });
    expect(checkCandidateUpdate(null, frozen)).toBe('write');
    expect(checkCandidateUpdate(frozen, frozen)).toBe('noop');
    expect(checkCandidateUpdate(frozen, prepared)).toBe('write');
    expect(refusal(() => checkCandidateUpdate(prepared, rec({ candidate: { ...candidate, resourceId: 'r2' }, state: 'prepared', updatedAt: FIXTURE_TIME.later }))).detail).toMatch(/immutable/);
    expect(refusal(() => checkCandidateUpdate(prepared, rec({ updatedAt: FIXTURE_TIME.later }))).detail).toMatch(/prepared -> frozen/);
    expect(refusal(() => checkCandidateUpdate(prepared, rec({ state: 'prepared', preparedReceiptId: 'prep-2', updatedAt: FIXTURE_TIME.created }))).detail).toMatch(/updatedAt cannot decrease/);
  });

  it('workspaces: identity immutable, state follows the machine (incl. read_only)', () => {
    expect(checkWorkspaceUpdate(null, ws())).toBe('write');
    expect(checkWorkspaceUpdate(ws(), ws())).toBe('noop');
    expect(checkWorkspaceUpdate(ws(), ws({ state: 'frozen' }))).toBe('write');
    expect(checkWorkspaceUpdate(ws(), ws({ state: 'read_only' }))).toBe('write');
    expect(refusal(() => checkWorkspaceUpdate(ws({ state: 'read_only' }), ws()))).toMatchObject({ code: 'record_conflict' });
    expect(refusal(() => checkWorkspaceUpdate(ws(), ws({ resourceId: 'r2', state: 'frozen' }))).detail).toMatch(/immutable/);
    expect(refusal(() => checkWorkspaceUpdate(ws({ state: 'frozen' }), ws())).detail).toMatch(/frozen -> writable/);
  });
});
