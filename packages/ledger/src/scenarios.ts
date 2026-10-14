/**
 * Store-agnostic ledger scenarios (AT-09 … AT-15 plus one per refusal code), as plain data, so
 * `@commonforge-org/conformance` can run the same list against every `LedgerStore` (in-memory,
 * the Worker's OrgLedger DO, VibeControl's Postgres store):
 *
 * ```ts
 * for (const s of LEDGER_SCENARIOS) {
 *   it(s.title, async () => {
 *     const { failures } = await runLedgerScenario(await makeTarget(), s);
 *     expect(failures).toEqual([]);
 *   });
 * }
 * ```
 *
 * A target is a `LedgerStore` that can also be seeded with a {@link LedgerSeed}. Operations run
 * through `store.transaction(tx => executeCommit|executeRestore|executeBindHead(...))`; final state is read back
 * through the same transaction port.
 *
 * `record` steps are record-keeping proposal writes. When the target provides `putProposal` (its
 * real record-keeping endpoint: an RPC, an HTTP route, a plpgsql function), they go through it, so
 * the scenarios check that the endpoint enforces the record guards (`checkProposalUpdate`): a
 * proposal can never be re-opened, back-dated, re-homed or marked accepted outside `planCommit`.
 * Without the hook they fall back to `executePutProposal` over the transaction port, which checks
 * only the port's round-trip; `describeLedgerConformance` refuses that fallback unless asked.
 * Each `record` step expects either a result or a {@link LedgerRecordErrorCode}.
 */
import {
  resourceId as toResourceId,
  sha256HexSync,
  type AcceptInput,
  type IntegrationReceipt,
  type ProposalRecordSchema,
  type ProposalState,
} from '@commonforge-org/core';
import type { z } from 'zod';
import type { BindHeadRequestInput, CommitDecision, LedgerRefusalCode, RestoreRequestInput } from './decision.js';
import { executeBindHead } from './plan-bind.js';
import {
  FIXTURE_ACTOR,
  FIXTURE_ORG,
  FIXTURE_TIME,
  acceptFixture,
  baseRev,
  fixtureRev,
  fixtureSha,
  mergeSeeds,
} from './fixtures.js';
import { executeCommit } from './plan-commit.js';
import { executeRestore } from './plan-restore.js';
import { LedgerRecordError, executePutProposal, type LedgerRecordErrorCode } from './record-guards.js';
import type { LedgerSeed } from './seed.js';
import type { LedgerStore } from './store.js';

export type LedgerOperation =
  | { kind: 'accept'; input: AcceptInput; now: string }
  | { kind: 'restore'; input: RestoreRequestInput; now: string }
  | { kind: 'bind'; input: BindHeadRequestInput; now: string };

/** A record-keeping write (never moves heads). */
export type RecordOperation = { kind: 'putProposal'; record: z.input<typeof ProposalRecordSchema>; now: string };

export type RecordExpectation = { ok: true; result?: 'noop' | 'write' } | { ok: false; code: LedgerRecordErrorCode };

export type RecordOutcome = { ok: true; result: 'noop' | 'write' } | { ok: false; code: LedgerRecordErrorCode; detail: string };

export type DecisionExpectation =
  | {
      ok: true;
      replayed?: boolean;
      acceptedVersionId?: string;
      /** the acceptedVersionId must equal the one returned by this earlier step (0-based) */
      sameAcceptedVersionAsStep?: number;
    }
  | { ok: false; code: LedgerRefusalCode; resourceId?: string };

export type ScenarioStep =
  | { kind: 'op'; op: LedgerOperation; expect: DecisionExpectation }
  | {
      /** submitted together; the store must serialize them */
      kind: 'concurrent';
      ops: LedgerOperation[];
      expectOkCount: number;
      /** refusals expected among the losers (order-independent) */
      expectRefusals?: Array<{ code: LedgerRefusalCode; resourceId?: string }>;
    }
  | { kind: 'record'; op: RecordOperation; expect: RecordExpectation };

export interface LedgerScenario {
  id: string;
  title: string;
  /** PRD acceptance tests / plan items this scenario covers */
  covers: string[];
  seed: LedgerSeed;
  steps: ScenarioStep[];
  expectHeads: Array<{ resourceId: string; revisionId: string; versionSeq: number }>;
  /** latest accepted version sequence per organization after all steps (null = none) */
  expectLatestSequence?: Array<{ organizationId: string; sequence: number | null }>;
  /** stored proposal state (and `updatedAt`, when given) after all steps */
  expectProposals?: Array<{ proposalId: string; state: ProposalState; updatedAt?: string }>;
}

/** A store under conformance test: a `LedgerStore` plus seeding. */
export interface LedgerConformanceTarget extends LedgerStore {
  seed(seed: LedgerSeed): void | Promise<void>;
  /**
   * The store's real record-keeping endpoint for proposals, with the ledger clock at `now`
   * (stores whose endpoint stamps its own clock must let the test pin it). It resolves on a write
   * or no-op and rejects on a refusal. When present, `record` steps go through it.
   */
  putProposal?(record: RecordOperation['record'], now: string): Promise<unknown>;
  /**
   * Map an error from {@link putProposal} to its record code (`null` = not a refusal; the error
   * is rethrown). Default: a `LedgerRecordError`'s code, else a `record_*` or `ledger_conflict` /
   * `ledger_invalid_input` message prefix.
   */
  recordErrorCode?(e: unknown): LedgerRecordErrorCode | null;
}

/** Default {@link LedgerConformanceTarget.recordErrorCode}. */
export function defaultRecordErrorCode(e: unknown): LedgerRecordErrorCode | null {
  if (e instanceof LedgerRecordError) return e.code;
  const message = e instanceof Error ? e.message : String(e);
  const m = /^(record_conflict|record_invalid_input|ledger_conflict|ledger_invalid_input):/.exec(message);
  if (!m) return null;
  return m[1] === 'record_conflict' || m[1] === 'ledger_conflict' ? 'record_conflict' : 'record_invalid_input';
}

/** True when the scenario has `record` steps (they need the target's record endpoint for full conformance). */
export function hasRecordSteps(scenario: LedgerScenario): boolean {
  return scenario.steps.some((s) => s.kind === 'record');
}

export function runLedgerOperation(store: LedgerStore, op: LedgerOperation): Promise<CommitDecision> {
  return store.transaction((tx) => {
    switch (op.kind) {
      case 'accept':
        return executeCommit(tx, op.input, op.now);
      case 'restore':
        return executeRestore(tx, op.input, op.now);
      case 'bind':
        return executeBindHead(tx, op.input, op.now);
    }
  });
}

/**
 * Run a record-keeping write in one transaction. A guard refusal is returned (it throws before any
 * write, so nothing is written); any other error propagates.
 */
export function runRecordOperation(store: LedgerStore, op: RecordOperation): Promise<RecordOutcome> {
  return store.transaction((tx): RecordOutcome => {
    try {
      return { ok: true, result: executePutProposal(tx, op.record, op.now).result };
    } catch (e) {
      if (e instanceof LedgerRecordError) return { ok: false, code: e.code, detail: e.detail };
      throw e;
    }
  });
}

async function runRecordEndpoint(target: LedgerConformanceTarget, op: RecordOperation): Promise<RecordOutcome> {
  try {
    await target.putProposal!(op.record, op.now);
    return { ok: true, result: 'write' };
  } catch (e) {
    const code = (target.recordErrorCode ?? defaultRecordErrorCode)(e);
    if (code === null) throw e;
    return { ok: false, code, detail: e instanceof Error ? e.message : String(e) };
  }
}

export interface ScenarioRun {
  /** decisions per step (one per op; several for a concurrent step; none for a record step) */
  decisions: CommitDecision[][];
  /** record outcomes per step (null for operation steps) */
  records: Array<RecordOutcome | null>;
  /** human-readable expectation failures; empty means the scenario passed */
  failures: string[];
}

export async function runLedgerScenario(target: LedgerConformanceTarget, scenario: LedgerScenario): Promise<ScenarioRun> {
  await target.seed(scenario.seed);
  const decisions: CommitDecision[][] = [];
  const records: Array<RecordOutcome | null> = [];
  const failures: string[] = [];
  const show = (d: unknown) => JSON.stringify(d, (k, v) => (k === 'writes' ? `[${(v as unknown[]).length} writes]` : v));

  for (const [i, step] of scenario.steps.entries()) {
    if (step.kind === 'record') {
      const viaEndpoint = target.putProposal !== undefined;
      const r = viaEndpoint ? await runRecordEndpoint(target, step.op) : await runRecordOperation(target, step.op);
      decisions.push([]);
      records.push(r);
      const e = step.expect;
      // an endpoint does not report noop vs write; only the port path checks `result`
      if (e.ok && (!r.ok || (!viaEndpoint && e.result !== undefined && r.result !== e.result))) failures.push(`step ${i}: expected record ${e.result ?? 'ok'}, got ${show(r)}`);
      if (!e.ok && (r.ok || r.code !== e.code)) failures.push(`step ${i}: expected record refusal ${e.code}, got ${show(r)}`);
      continue;
    }
    records.push(null);
    if (step.kind === 'op') {
      const d = await runLedgerOperation(target, step.op);
      decisions.push([d]);
      const e = step.expect;
      if (e.ok) {
        if (!d.ok) failures.push(`step ${i}: expected ok, got ${show(d)}`);
        else {
          if (e.replayed !== undefined && (d.replayed === true) !== e.replayed) failures.push(`step ${i}: expected replayed=${e.replayed}, got ${show(d)}`);
          if (e.acceptedVersionId !== undefined && d.acceptedVersionId !== e.acceptedVersionId) {
            failures.push(`step ${i}: expected acceptedVersionId ${e.acceptedVersionId}, got ${d.acceptedVersionId}`);
          }
          if (e.sameAcceptedVersionAsStep !== undefined) {
            const prior = decisions[e.sameAcceptedVersionAsStep]?.[0];
            if (!prior?.ok || prior.acceptedVersionId !== d.acceptedVersionId) {
              failures.push(`step ${i}: expected acceptedVersionId of step ${e.sameAcceptedVersionAsStep}, got ${d.acceptedVersionId}`);
            }
          }
        }
      } else if (d.ok || d.code !== e.code || (e.resourceId !== undefined && d.resourceId !== e.resourceId)) {
        failures.push(`step ${i}: expected refusal ${e.code}${e.resourceId ? `@${e.resourceId}` : ''}, got ${show(d)}`);
      }
    } else {
      const ds = await Promise.all(step.ops.map((op) => runLedgerOperation(target, op)));
      decisions.push(ds);
      const okCount = ds.filter((d) => d.ok).length;
      if (okCount !== step.expectOkCount) failures.push(`step ${i}: expected ${step.expectOkCount} ok, got ${okCount}: ${show(ds)}`);
      if (step.expectRefusals) {
        const got = ds
          .filter((d) => !d.ok)
          .map((d) => (d.ok ? '' : `${d.code}@${d.resourceId ?? ''}`))
          .sort();
        const want = step.expectRefusals.map((r) => `${r.code}@${r.resourceId ?? ''}`).sort();
        if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`step ${i}: expected refusals ${want}, got ${got}`);
      }
    }
  }

  const { heads, latest, proposals } = await target.transaction((tx) => ({
    heads: scenario.expectHeads.map((h) => tx.getHead(toResourceId(h.resourceId))),
    latest: (scenario.expectLatestSequence ?? []).map((l) => tx.getLatestAcceptedVersion(l.organizationId)?.sequence ?? null),
    proposals: (scenario.expectProposals ?? []).map((p) => tx.getProposal(p.proposalId as never)),
  }));
  (scenario.expectProposals ?? []).forEach((want, i) => {
    const got = proposals[i];
    if (!got || got.state !== want.state || (want.updatedAt !== undefined && got.updatedAt !== want.updatedAt)) {
      failures.push(`proposal ${want.proposalId}: expected ${want.state}${want.updatedAt ? `@${want.updatedAt}` : ''}, got ${got ? `${got.state}@${got.updatedAt}` : 'none'}`);
    }
  });
  scenario.expectHeads.forEach((want, i) => {
    const got = heads[i];
    if (!got || got.revisionId !== want.revisionId || got.versionSeq !== want.versionSeq) {
      failures.push(`head ${want.resourceId}: expected ${want.revisionId}#${want.versionSeq}, got ${got ? `${got.revisionId}#${got.versionSeq}` : 'none'}`);
    }
  });
  (scenario.expectLatestSequence ?? []).forEach((want, i) => {
    if (latest[i] !== want.sequence) failures.push(`latest sequence for ${want.organizationId}: expected ${want.sequence}, got ${latest[i]}`);
  });
  return { decisions, records, failures };
}

// ---------------------------------------------------------------------------------------------
// Scenario list
// ---------------------------------------------------------------------------------------------

const NOW = FIXTURE_TIME.now;
const accept = (input: AcceptInput, now: string = NOW): LedgerOperation => ({ kind: 'accept', input, now });
const restoreOp = (input: Omit<RestoreRequestInput, 'organizationId' | 'actor'>, now: string = NOW): LedgerOperation => ({
  kind: 'restore',
  input: { organizationId: FIXTURE_ORG, actor: FIXTURE_ACTOR, ...input },
  now,
});
const op = (o: LedgerOperation, expect: DecisionExpectation): ScenarioStep => ({ kind: 'op', op: o, expect });
const putProposal = (record: RecordOperation['record'], expect: RecordExpectation, now: string = NOW): ScenarioStep => ({
  kind: 'record',
  op: { kind: 'putProposal', record, now },
  expect,
});
const recordRefused = (code: LedgerRecordErrorCode): RecordExpectation => ({ ok: false, code });
const refused = (code: LedgerRefusalCode, resourceId?: string): DecisionExpectation =>
  resourceId === undefined ? { ok: false, code } : { ok: false, code, resourceId };
const base1 = (r: string) => ({ resourceId: r, revisionId: baseRev(r), versionSeq: 1 });
const otherHash = sha256HexSync('not this proposal');

function buildScenarios(): LedgerScenario[] {
  const list: LedgerScenario[] = [];

  {
    const f = acceptFixture();
    list.push({
      id: 'accept.fast-forward',
      title: 'accept fast-forwards the head to the prepared candidate',
      covers: ['B.9'],
      seed: f.seed,
      steps: [op(accept(f.input), { ok: true, acceptedVersionId: 'av-000000000001' })],
      expectHeads: [{ resourceId: 'r1', revisionId: f.candidate.r1!, versionSeq: 2 }],
      expectLatestSequence: [{ organizationId: FIXTURE_ORG, sequence: 1 }],
    });
  }
  {
    const a = acceptFixture({ proposalId: 'prop-a' });
    const b = acceptFixture({ proposalId: 'prop-b' });
    list.push({
      id: 'AT-09.stale-after-advance',
      title: 'AT-09: advancing the accepted head refuses an older proposal on the same base',
      covers: ['AT-09', 'F.stale-acceptance'],
      seed: mergeSeeds(a.seed, b.seed),
      steps: [op(accept(a.input), { ok: true }), op(accept(b.input), refused('expected_head_stale', 'r1'))],
      expectHeads: [{ resourceId: 'r1', revisionId: a.candidate.r1!, versionSeq: 2 }],
    });
  }
  {
    const f = acceptFixture();
    list.push({
      id: 'refuse.expected_head_stale',
      title: 'refuses when the expected head is stale',
      covers: ['AT-09'],
      seed: mergeSeeds(f.seed, { heads: [{ resourceId: 'r1', revisionId: fixtureRev('r1', 'elsewhere'), versionSeq: 2 }] }),
      steps: [op(accept(f.input), refused('expected_head_stale', 'r1'))],
      expectHeads: [{ resourceId: 'r1', revisionId: fixtureRev('r1', 'elsewhere'), versionSeq: 2 }],
      expectLatestSequence: [{ organizationId: FIXTURE_ORG, sequence: null }],
    });
  }
  {
    const pin = fixtureRev('r2', 'old');
    const pinned = acceptFixture({ proposalId: 'prop-pin', resources: ['r1'], readDependencies: [{ resourceId: 'r2', revisionId: pin, mode: 'pinned-reference' }] });
    const must = acceptFixture({ proposalId: 'prop-must', resources: ['r3'], readDependencies: [{ resourceId: 'r2', revisionId: pin, mode: 'must-match-accepted' }] });
    list.push({
      id: 'AT-10.dependency-modes',
      title: 'AT-10: pinned-reference dependency may be stale; must-match-accepted may not',
      covers: ['AT-10', 'refuse.dependency_stale'],
      seed: mergeSeeds(pinned.seed, must.seed),
      steps: [op(accept(pinned.input), { ok: true }), op(accept(must.input), refused('dependency_stale', 'r2'))],
      expectHeads: [
        { resourceId: 'r1', revisionId: pinned.candidate.r1!, versionSeq: 2 },
        base1('r2'),
        base1('r3'),
      ],
    });
  }
  {
    const f = acceptFixture({ updatedAt: '2026-10-06T12:30:00.000Z' });
    list.push({
      id: 'AT-11.approval-before-mutation',
      title: 'AT-11: approval older than the proposal mutation is invalid',
      covers: ['AT-11', 'refuse.approval_invalid'],
      seed: f.seed,
      steps: [op(accept(f.input), refused('approval_invalid'))],
      expectHeads: [base1('r1')],
    });
  }
  {
    const f = acceptFixture();
    const input = structuredClone(f.input);
    input.approvals = input.approvals.map((a) => ({ ...a, proposalHash: otherHash as typeof a.proposalHash }));
    list.push({
      id: 'AT-11.approval-other-hash',
      title: 'AT-11: approval whose proposalHash differs is invalid',
      covers: ['AT-11', 'refuse.approval_invalid'],
      seed: f.seed,
      steps: [op(accept(input), refused('approval_invalid'))],
      expectHeads: [base1('r1')],
    });
  }
  {
    const f = acceptFixture();
    const input = { ...structuredClone(f.input), proposalHash: otherHash as AcceptInput['proposalHash'] };
    list.push({
      id: 'refuse.proposal_hash_mismatch',
      title: 'refuses when the input proposal hash differs from the recorded proposal',
      covers: ['AT-11'],
      seed: f.seed,
      steps: [op(accept(input), refused('proposal_hash_mismatch'))],
      expectHeads: [base1('r1')],
    });
  }
  {
    const f = acceptFixture({ policyRevision: 1 });
    list.push({
      id: 'refuse.policy_revision_stale',
      title: 'refuses when the policy revision changed after the proposal',
      covers: ['F.stale-acceptance'],
      seed: mergeSeeds(f.seed, { policyRevisions: [{ projectId: 'proj-1', policyRevision: 2 }] }),
      steps: [op(accept(f.input), refused('policy_revision_stale'))],
      expectHeads: [base1('r1')],
    });
  }
  {
    const f = acceptFixture({ resources: ['r1', 'r2'] });
    list.push({
      id: 'AT-12.partial-preparation',
      title: 'AT-12: second resource not prepared → no head advances (receipt_missing)',
      covers: ['AT-12', 'refuse.receipt_missing'],
      seed: { ...f.seed, preparedReceipts: f.seed.preparedReceipts!.filter((r) => r.resourceId !== 'r2') },
      steps: [op(accept(f.input), refused('receipt_missing', 'r2'))],
      expectHeads: [base1('r1'), base1('r2')],
      expectLatestSequence: [{ organizationId: FIXTURE_ORG, sequence: null }],
    });
  }
  {
    const f = acceptFixture({ resources: ['r1', 'r2'] });
    list.push({
      id: 'atomic.multi-resource-stale',
      title: 'multi-resource proposal is atomic: one stale head writes nothing',
      covers: ['AT-12'],
      seed: mergeSeeds(f.seed, { heads: [{ resourceId: 'r2', revisionId: fixtureRev('r2', 'moved'), versionSeq: 2 }] }),
      steps: [op(accept(f.input), refused('expected_head_stale', 'r2'))],
      expectHeads: [base1('r1'), { resourceId: 'r2', revisionId: fixtureRev('r2', 'moved'), versionSeq: 2 }],
      expectLatestSequence: [{ organizationId: FIXTURE_ORG, sequence: null }],
    });
  }
  {
    const f = acceptFixture();
    list.push({
      id: 'refuse.evidence_missing',
      title: 'refuses without signed validation evidence (signature presence)',
      covers: ['B.7'],
      seed: f.seed,
      steps: [
        op(accept({ ...f.input, evidence: [] }), refused('evidence_missing')),
        op(accept({ ...f.input, evidence: f.input.evidence.map((e) => ({ ...e, signature: '' })) }), refused('evidence_missing')),
      ],
      expectHeads: [base1('r1')],
    });
  }
  {
    const f = acceptFixture();
    list.push({
      id: 'refuse.proposal_not_prepared',
      title: 'refuses a proposal that is not prepared',
      covers: ['A.6'],
      seed: { ...f.seed, proposals: [{ ...f.proposal, state: 'open' }] },
      steps: [op(accept(f.input), refused('proposal_not_prepared'))],
      expectHeads: [base1('r1')],
    });
  }
  {
    const f = acceptFixture({ idempotencyKey: 'k1' });
    list.push({
      id: 'AT-13.AT-14.replay',
      title: 'AT-13/AT-14: repeated delivery replays the original acceptedVersionId without advancing',
      covers: ['AT-13', 'AT-14', 'F.duplicate-events'],
      seed: f.seed,
      steps: [
        op(accept(f.input), { ok: true, replayed: false }),
        op(accept(f.input), { ok: true, replayed: true, sameAcceptedVersionAsStep: 0 }),
        op(accept(f.input, FIXTURE_TIME.later), { ok: true, replayed: true, sameAcceptedVersionAsStep: 0 }),
      ],
      expectHeads: [{ resourceId: 'r1', revisionId: f.candidate.r1!, versionSeq: 2 }],
      expectLatestSequence: [{ organizationId: FIXTURE_ORG, sequence: 1 }],
    });
  }
  {
    const a = acceptFixture({ idempotencyKey: 'k1' });
    const b = acceptFixture({ proposalId: 'prop-2', resources: ['r2'], idempotencyKey: 'k1' });
    list.push({
      id: 'idempotency.key-conflict',
      title: 'same idempotency key with a different request is refused, not replayed',
      covers: ['AT-14'],
      seed: mergeSeeds(a.seed, b.seed),
      steps: [op(accept(a.input), { ok: true }), op(accept(b.input), refused('idempotency_key_conflict'))],
      expectHeads: [{ resourceId: 'r1', revisionId: a.candidate.r1!, versionSeq: 2 }, base1('r2')],
    });
  }
  {
    const a = acceptFixture({ proposalId: 'prop-p1', projectId: 'proj-1' });
    const b = acceptFixture({ proposalId: 'prop-p2', projectId: 'proj-2' });
    list.push({
      id: 'AT-15.shared-resource',
      title: 'AT-15: two projects sharing a resource hit the same head check',
      covers: ['AT-15'],
      seed: mergeSeeds(a.seed, b.seed),
      steps: [op(accept(a.input), { ok: true }), op(accept(b.input), refused('expected_head_stale', 'r1'))],
      expectHeads: [{ resourceId: 'r1', revisionId: a.candidate.r1!, versionSeq: 2 }],
    });
  }
  {
    const a = acceptFixture({ proposalId: 'prop-a' });
    const b = acceptFixture({ proposalId: 'prop-b' });
    list.push({
      id: 'concurrency.one-winner',
      title: 'two interleaved commits against the same head: exactly one wins',
      covers: ['G.1', 'AT-09'],
      seed: mergeSeeds(a.seed, b.seed),
      steps: [{ kind: 'concurrent', ops: [accept(a.input), accept(b.input)], expectOkCount: 1, expectRefusals: [{ code: 'expected_head_stale', resourceId: 'r1' }] }],
      expectHeads: [],
      expectLatestSequence: [{ organizationId: FIXTURE_ORG, sequence: 1 }],
    });
  }
  {
    const f = acceptFixture();
    const moved = fixtureRev('r1', 'moved');
    const integrated = fixtureRev('r1', 'integrated');
    const receipt: IntegrationReceipt = {
      jobId: 'job-int-1',
      proposalId: f.input.proposalId,
      results: [
        {
          resourceId: toResourceId('r1'),
          integrationRef: 'refs/commonforge/integrations/prop-1',
          sha: fixtureSha('r1:integrated'),
          revisionId: integrated,
          expectedHead: moved,
        },
      ],
      evidence: f.input.evidence[0]!,
      integratedAt: FIXTURE_TIME.prepared,
    };
    const input = structuredClone(f.input);
    input.expectedHeads = [{ resourceId: toResourceId('r1'), revisionId: moved }];
    input.newHeads[0]!.revisionId = integrated;
    const ff = structuredClone(input);
    ff.newHeads[0]!.revisionId = f.candidate.r1!;
    ff.idempotencyKey = 'ff-attempt';
    list.push({
      id: 'receipts.integration-commit',
      title: 'a stale-base candidate needs the integration commit; a direct fast-forward is refused',
      covers: ['B.8', 'refuse.receipt_missing'],
      seed: mergeSeeds(f.seed, { heads: [{ resourceId: 'r1', revisionId: moved, versionSeq: 2 }], integrationReceipts: [receipt] }),
      steps: [op(accept(ff), refused('receipt_missing', 'r1')), op(accept(input), { ok: true })],
      expectHeads: [{ resourceId: 'r1', revisionId: integrated, versionSeq: 3 }],
    });
  }
  {
    const f = acceptFixture();
    list.push({
      id: 'restore.forward-cas',
      title: 'restore creates a forward head equal to the target under CAS, idempotently',
      covers: ['B.9'],
      seed: f.seed,
      steps: [
        op(accept(f.input), { ok: true, acceptedVersionId: 'av-000000000001' }),
        op(restoreOp({ resourceId: 'r1', expectedHead: baseRev('r1'), targetRevision: baseRev('r1'), idempotencyKey: 'rs-stale' }), refused('expected_head_stale', 'r1')),
        op(restoreOp({ resourceId: 'r1', expectedHead: f.candidate.r1!, targetRevision: f.candidate.r1!, idempotencyKey: 'rs-noop' }), refused('restore_noop', 'r1')),
        op(
          { kind: 'restore', input: { organizationId: 'org-other', actor: FIXTURE_ACTOR, resourceId: 'r1', expectedHead: f.candidate.r1!, targetRevision: baseRev('r1'), idempotencyKey: 'rs-foreign' }, now: NOW },
          refused('expected_head_stale', 'r1'),
        ),
        op(
          restoreOp({ resourceId: 'r1', expectedHead: f.candidate.r1!, targetRevision: fixtureRev('r1', 'never'), idempotencyKey: 'rs-unknown' }),
          refused('restore_target_unknown', 'r1'),
        ),
        op(restoreOp({ resourceId: 'r1', expectedHead: f.candidate.r1!, targetRevision: baseRev('r1'), idempotencyKey: 'rs-1' }), {
          ok: true,
          acceptedVersionId: 'av-000000000002',
        }),
        op(restoreOp({ resourceId: 'r1', expectedHead: f.candidate.r1!, targetRevision: baseRev('r1'), idempotencyKey: 'rs-1' }), {
          ok: true,
          replayed: true,
          sameAcceptedVersionAsStep: 5,
        }),
      ],
      expectHeads: [{ resourceId: 'r1', revisionId: baseRev('r1'), versionSeq: 3 }],
      expectLatestSequence: [{ organizationId: FIXTURE_ORG, sequence: 2 }],
    });
  }
  {
    const f = acceptFixture();
    const bindInput = { organizationId: FIXTURE_ORG, resourceId: 'r1', revisionId: baseRev('r1'), idempotencyKey: 'bind-r1', actor: FIXTURE_ACTOR };
    list.push({
      id: 'bind.genesis',
      title: 'planBindHead creates the first head (CAS on none, idempotent); accept then builds on it',
      covers: ['M4'],
      seed: { ...f.seed, heads: [] },
      steps: [
        op({ kind: 'bind', input: bindInput, now: NOW }, { ok: true, acceptedVersionId: 'av-000000000001' }),
        op({ kind: 'bind', input: bindInput, now: NOW }, { ok: true, replayed: true, sameAcceptedVersionAsStep: 0 }),
        op({ kind: 'bind', input: { ...bindInput, idempotencyKey: 'bind-2' }, now: NOW }, refused('expected_head_stale', 'r1')),
        op(accept(f.input), { ok: true, acceptedVersionId: 'av-000000000002' }),
      ],
      expectHeads: [{ resourceId: 'r1', revisionId: f.candidate.r1!, versionSeq: 2 }],
      expectLatestSequence: [{ organizationId: FIXTURE_ORG, sequence: 2 }],
    });
  }
  for (const variant of ['other-hash', 'failed-check'] as const) {
    const f = acceptFixture();
    const moved = fixtureRev('r1', 'moved');
    const integrated = fixtureRev('r1', 'integrated');
    const evidence = { ...structuredClone(f.input.evidence[0]!), evidenceId: 'ev-int' };
    if (variant === 'other-hash') evidence.proposalHash = otherHash as typeof evidence.proposalHash;
    else evidence.checks[0]!.result = 'fail';
    const receipt: IntegrationReceipt = {
      jobId: 'job-int-1',
      proposalId: f.input.proposalId,
      results: [
        { resourceId: toResourceId('r1'), integrationRef: 'refs/commonforge/integrations/prop-1', sha: fixtureSha('r1:integrated'), revisionId: integrated, expectedHead: moved },
      ],
      evidence,
      integratedAt: FIXTURE_TIME.prepared,
    };
    const input = structuredClone(f.input);
    input.expectedHeads = [{ resourceId: toResourceId('r1'), revisionId: moved }];
    input.newHeads[0]!.revisionId = integrated;
    list.push({
      id: `receipts.integration-evidence.${variant}`,
      title:
        variant === 'other-hash'
          ? 'an integration receipt produced for earlier proposal content never qualifies (receipt_missing)'
          : "an integration commit whose own evidence failed is refused despite passing caller evidence (evidence_missing)",
      covers: ['B.8', 'AT-11', variant === 'other-hash' ? 'refuse.receipt_missing' : 'refuse.evidence_missing'],
      seed: mergeSeeds(f.seed, { heads: [{ resourceId: 'r1', revisionId: moved, versionSeq: 2 }], integrationReceipts: [receipt] }),
      steps: [op(accept(input), variant === 'other-hash' ? refused('receipt_missing', 'r1') : refused('evidence_missing'))],
      expectHeads: [{ resourceId: 'r1', revisionId: moved, versionSeq: 2 }],
    });
  }
  {
    const fs = ['r1', 'r2', 'r3'].map((r, i) => acceptFixture({ proposalId: `prop-${i}`, resources: [r] }));
    list.push({
      id: 'sequence.monotonic',
      title: 'acceptedVersionId is monotonic per organization',
      covers: ['A.5'],
      seed: mergeSeeds(...fs.map((f) => f.seed)),
      steps: fs.map((f, i) => op(accept(f.input), { ok: true, acceptedVersionId: `av-${String(i + 1).padStart(12, '0')}` })),
      expectHeads: fs.map((f, i) => ({ resourceId: `r${i + 1}`, revisionId: f.candidate[`r${i + 1}`]!, versionSeq: 2 })),
      expectLatestSequence: [{ organizationId: FIXTURE_ORG, sequence: 3 }],
    });
  }
  {
    const f = acceptFixture();
    const p = f.proposal;
    list.push({
      id: 'record.proposal-guards',
      title: 'record-keeping proposal writes cannot mark accepted, re-home, back-date or future-date; accepted is final',
      covers: ['task-15 I-1', 'record_conflict', 'record_invalid_input'],
      seed: f.seed,
      steps: [
        putProposal(p, { ok: true, result: 'noop' }),
        putProposal({ ...p, state: 'accepted', updatedAt: FIXTURE_TIME.approved }, recordRefused('record_conflict')),
        putProposal({ ...p, projectId: 'proj-other', updatedAt: FIXTURE_TIME.approved }, recordRefused('record_conflict')),
        putProposal({ ...p, state: 'open', updatedAt: FIXTURE_TIME.created }, recordRefused('record_conflict')),
        putProposal({ ...p, policyRevision: p.policyRevision + 1 }, recordRefused('record_conflict')),
        putProposal({ ...p, updatedAt: '2026-10-07T13:00:00.000Z' }, recordRefused('record_invalid_input')),
        putProposal({ ...p, createdAt: FIXTURE_TIME.approved }, recordRefused('record_invalid_input')),
        op(accept(f.input), { ok: true }),
        putProposal({ ...p, state: 'withdrawn', updatedAt: FIXTURE_TIME.later }, recordRefused('record_conflict'), FIXTURE_TIME.later),
      ],
      expectHeads: [{ resourceId: 'r1', revisionId: f.candidate.r1!, versionSeq: 2 }],
      expectProposals: [{ proposalId: p.proposalId, state: 'accepted' }],
    });
  }
  {
    const f = acceptFixture();
    const p = f.proposal;
    const reopenedAt = '2026-10-06T12:30:00.000Z';
    list.push({
      id: 'record.reprepare-invalidates-approvals',
      title: 'reopening and re-preparing a proposal advances updatedAt, so earlier approvals no longer accept it',
      covers: ['AT-11', 'task-15 I-1'],
      seed: f.seed,
      steps: [
        putProposal({ ...p, state: 'open', updatedAt: reopenedAt }, { ok: true, result: 'write' }),
        op(accept(f.input), refused('proposal_not_prepared')),
        putProposal({ ...p, state: 'prepared', updatedAt: reopenedAt }, { ok: true, result: 'write' }),
        op(accept({ ...f.input, idempotencyKey: 'after-reprepare' }), refused('approval_invalid')),
      ],
      expectHeads: [base1('r1')],
      expectProposals: [{ proposalId: p.proposalId, state: 'prepared', updatedAt: reopenedAt }],
    });
  }
  {
    const f = acceptFixture();
    const p = f.proposal;
    list.push({
      id: 'record.terminal-is-final',
      title: 'a withdrawn proposal stays withdrawn and is never accepted',
      covers: ['A.6', 'task-15 I-1'],
      seed: f.seed,
      steps: [
        putProposal({ ...p, state: 'withdrawn', updatedAt: FIXTURE_TIME.approved }, { ok: true, result: 'write' }),
        putProposal({ ...p, state: 'withdrawn', updatedAt: FIXTURE_TIME.approved }, { ok: true, result: 'noop' }),
        putProposal({ ...p, state: 'prepared', updatedAt: FIXTURE_TIME.now }, recordRefused('record_conflict')),
        op(accept(f.input), refused('proposal_not_prepared')),
      ],
      expectHeads: [base1('r1')],
      expectProposals: [{ proposalId: p.proposalId, state: 'withdrawn', updatedAt: FIXTURE_TIME.approved }],
    });
  }
  for (const variant of ['optional', 'required', 'skipped-required'] as const) {
    const f = acceptFixture();
    const input = structuredClone(f.input);
    input.evidence[0]!.checks.push({
      checkId: 'lint',
      command: 'pnpm lint',
      result: variant === 'skipped-required' ? 'skipped' : 'fail',
      ...(variant === 'optional' ? { required: false } : { required: true }),
      startedAt: FIXTURE_TIME.prepared,
      endedAt: FIXTURE_TIME.prepared,
    });
    list.push({
      id: variant === 'skipped-required' ? 'evidence.skipped-required-check' : `evidence.failed-${variant}-check`,
      title:
        variant === 'optional'
          ? 'a failed check marked required: false is recorded but does not block acceptance'
          : variant === 'required'
            ? 'a failed check marked required: true refuses (evidence_missing)'
            : 'a skipped required check does not count as passing (evidence_missing)',
      covers: ['B.7', 'CheckResult.required'],
      seed: f.seed,
      steps: [op(accept(input), variant === 'optional' ? { ok: true } : refused('evidence_missing'))],
      expectHeads: [variant === 'optional' ? { resourceId: 'r1', revisionId: f.candidate.r1!, versionSeq: 2 } : base1('r1')],
    });
  }
  {
    // follow-up Task 23: an assets-only proposal (a logo replacement) is accepted on the evidence of
    // an integrate run with no git targets: checks/contracts pass, mergeOutcome is empty, and the
    // evidence binds the manifests through the proposal hash
    const f = acceptFixture({ proposalId: 'prop-assets', resources: [], assetResources: ['brand'] });
    const base = { resourceId: 'brand', revisionId: f.input.expectedHeads[0]!.revisionId, versionSeq: 1 };
    list.push({
      id: 'accept.assets-only',
      title: 'an assets-only proposal is accepted with integrate evidence that has an empty merge outcome',
      covers: ['B.7', 'B.9', 'assets-only'],
      seed: f.seed,
      steps: [op(accept(f.input), { ok: true })],
      expectHeads: [{ resourceId: 'brand', revisionId: f.candidate.brand!, versionSeq: 2 }],
    });
    const failed = structuredClone(f.input);
    failed.evidence[0]!.checks[0] = { ...failed.evidence[0]!.checks[0]!, result: 'fail', required: true };
    const otherHash = structuredClone(f.input);
    otherHash.evidence[0]!.proposalHash = 'f'.repeat(64) as never;
    list.push({
      id: 'refuse.assets-only-evidence',
      title: 'an assets-only proposal still needs evidence for its hash and candidate snapshot, with every required check passing',
      covers: ['B.7', 'refuse.evidence_missing', 'assets-only'],
      seed: f.seed,
      steps: [
        op(accept({ ...f.input, evidence: [] }), refused('evidence_missing')),
        op(accept(otherHash), refused('evidence_missing')),
        op(accept({ ...f.input, evidence: f.input.evidence.map((e) => ({ ...e, snapshotId: 'a'.repeat(64) as never })) }), refused('evidence_missing')),
        op(accept(failed), refused('evidence_missing')),
      ],
      expectHeads: [base],
    });
  }
  return list;
}

/** Every ledger scenario; Task 10 wraps this as `describeLedgerConformance(storeFactory)`. */
export const LEDGER_SCENARIOS: readonly LedgerScenario[] = buildScenarios();
