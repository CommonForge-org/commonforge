import {
  artRevisionId,
  computeProposalHashSync,
  proposalHash as toProposalHash,
  resourceId,
  sha256HexSync,
  type AcceptInput,
  type IntegrationReceipt,
} from '@commonforge-org/core';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_ORG,
  FIXTURE_TIME,
  InMemoryLedgerStore,
  LedgerInputError,
  acceptFixture,
  baseRev,
  fixtureRev,
  fixtureSha,
  executeCommit,
  mergeSeeds,
  planCommit,
  type LedgerTx,
} from '../src/index.js';
import { NOW, accepted, clone, commit, storeWith } from './helpers.js';

const r1 = resourceId('r1');
const r2 = resourceId('r2');
const otherHash = toProposalHash(sha256HexSync('some other proposal'));

function plan(store: InMemoryLedgerStore, input: AcceptInput, now: string = NOW) {
  return store.transactionSync((tx) => planCommit(tx, input, now));
}

describe('planCommit: success', () => {
  it('fast-forwards the head and plans every ledger write', () => {
    const f = acceptFixture();
    const store = storeWith(f.seed);
    const d = accepted(plan(store, f.input));

    expect(d.acceptedVersionId).toBe('av-000000000001');
    const ops = d.writes.map((w) => w.op);
    expect(ops).toEqual(['setHead', 'putProposal', 'putAcceptedVersion', 'putIdempotency', 'appendOutbox', 'appendAudit']);
    // planCommit is pure: nothing is written until the writes are applied
    expect(store.head('r1').versionSeq).toBe(1);

    const committed = accepted(commit(store, f.input));
    expect(committed.acceptedVersionId).toBe('av-000000000001');
    expect(store.head('r1')).toMatchObject({
      revisionId: f.candidate.r1,
      versionSeq: 2,
      acceptedVersionId: 'av-000000000001',
      acceptedAt: NOW,
      reconciliation: 'pending',
    });
    expect(store.proposal('prop-1')?.state).toBe('accepted');
    expect(store.acceptedVersions()).toEqual([
      expect.objectContaining({
        acceptedVersionId: 'av-000000000001',
        organizationId: FIXTURE_ORG,
        sequence: 1,
        kind: 'accept',
        proposalId: 'prop-1',
        proposalHash: f.input.proposalHash,
        heads: [{ resourceId: 'r1', revisionId: f.candidate.r1, previousRevisionId: baseRev('r1'), versionSeq: 2 }],
      }),
    ]);
    expect(store.outbox()).toEqual([
      expect.objectContaining({
        kind: 'reconcile-ref',
        dedupeKey: 'reconcile-ref:av-000000000001:r1',
        payload: { resourceId: 'r1', targetRevision: f.candidate.r1, expectedCurrent: baseRev('r1'), acceptedVersionId: 'av-000000000001' },
      }),
    ]);
    expect(store.audit()).toEqual([expect.objectContaining({ action: 'proposal.accepted', subject: { kind: 'proposal', id: 'prop-1' } })]);
    expect(store.idempotency(f.input.idempotencyKey, 'org-1')).toMatchObject({ scope: 'accept', acceptedVersionId: 'av-000000000001' });
  });

  it('accepts an integration commit recorded for the proposal on top of the expected head', () => {
    const f = acceptFixture();
    // someone else advanced r1 since the proposal was made; the runner integrated onto the new head
    const moved = fixtureRev('r1', 'moved');
    const integrated = fixtureRev('r1', 'integrated');
    const receipt: IntegrationReceipt = {
      jobId: 'job-int-1',
      proposalId: f.input.proposalId,
      results: [
        { resourceId: r1, integrationRef: 'refs/commonforge/integrations/prop-1', sha: fixtureSha('r1:integrated'), revisionId: integrated, expectedHead: moved },
      ],
      evidence: f.input.evidence[0]!,
      integratedAt: FIXTURE_TIME.prepared,
    };
    const store = storeWith(f.seed, { heads: [{ resourceId: 'r1', revisionId: moved, versionSeq: 2 }], integrationReceipts: [receipt] });
    const input = clone(f.input);
    input.expectedHeads = [{ resourceId: r1, revisionId: moved }];
    input.newHeads[0]!.revisionId = integrated;
    const d = accepted(commit(store, input));
    expect(store.head('r1')).toMatchObject({ revisionId: integrated, versionSeq: 3, acceptedVersionId: d.acceptedVersionId });
  });
});

describe('planCommit: refusals (one per code)', () => {
  it('refuses when expected head is stale', () => {
    const f = acceptFixture();
    const store = storeWith(f.seed);
    store.seedHead({ resourceId: 'r1', revisionId: fixtureRev('r1', 'someone-else'), versionSeq: 2 });
    expect(plan(store, f.input)).toMatchObject({ ok: false, code: 'expected_head_stale', resourceId: 'r1' });
  });

  it('refuses when the resource has no head at all', () => {
    const f = acceptFixture();
    const store = storeWith({ ...f.seed, heads: [] });
    expect(plan(store, f.input)).toMatchObject({ ok: false, code: 'expected_head_stale', resourceId: 'r1' });
  });

  it('proposal_hash_mismatch: input hash differs from the recorded proposal', () => {
    const f = acceptFixture();
    const input = { ...clone(f.input), proposalHash: otherHash };
    input.approvals = input.approvals.map((a) => ({ ...a, proposalHash: otherHash }));
    input.evidence = input.evidence.map((e) => ({ ...e, proposalHash: otherHash }));
    expect(plan(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'proposal_hash_mismatch' });
  });

  it('proposal_hash_mismatch: recorded proposal content no longer matches its hash', () => {
    const f = acceptFixture({ resources: ['r1', 'r2'] });
    const tampered = clone(f.proposal);
    tampered.resourceChanges = tampered.resourceChanges.slice(0, 1);
    const store = storeWith({ ...f.seed, proposals: [tampered] });
    expect(plan(store, f.input)).toMatchObject({ ok: false, code: 'proposal_hash_mismatch' });
  });

  it('proposal_hash_mismatch: input omits a resource the proposal changes', () => {
    const f = acceptFixture({ resources: ['r1', 'r2'] });
    const input = clone(f.input);
    input.newHeads = input.newHeads.filter((h) => h.resourceId !== 'r2');
    input.expectedHeads = input.expectedHeads.filter((h) => h.resourceId !== 'r2');
    expect(plan(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'proposal_hash_mismatch', resourceId: 'r2' });
  });

  it('proposal_hash_mismatch: duplicate resource entries are refused', () => {
    const f = acceptFixture();
    const input = clone(f.input);
    input.newHeads = [input.newHeads[0]!, { ...input.newHeads[0]!, revisionId: fixtureRev('r1', 'evil') }];
    expect(plan(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'proposal_hash_mismatch', resourceId: 'r1' });
    const input2 = clone(f.input);
    input2.expectedHeads = [input2.expectedHeads[0]!, input2.expectedHeads[0]!];
    expect(plan(storeWith(f.seed), input2)).toMatchObject({ ok: false, code: 'proposal_hash_mismatch', resourceId: 'r1' });
  });

  it('proposal_hash_mismatch: read dependencies differ from the hashed proposal', () => {
    const f = acceptFixture();
    const input = clone(f.input);
    input.readDependencies = [{ resourceId: r2, revisionId: baseRev('r2'), mode: 'pinned-reference' }];
    expect(plan(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'proposal_hash_mismatch' });
  });

  it('proposal_hash_mismatch: input policy revision differs from the hashed proposal', () => {
    const f = acceptFixture();
    expect(plan(storeWith(f.seed), { ...f.input, policyRevision: 2 })).toMatchObject({ ok: false, code: 'proposal_hash_mismatch' });
  });

  it('dependency_stale (AT-10): must-match-accepted may not be stale; pinned-reference may', () => {
    const stalePin = fixtureRev('r2', 'old');
    const pinned = acceptFixture({ readDependencies: [{ resourceId: 'r2', revisionId: stalePin, mode: 'pinned-reference' }] });
    expect(commit(storeWith(pinned.seed), pinned.input)).toMatchObject({ ok: true });

    const mustMatch = acceptFixture({ readDependencies: [{ resourceId: 'r2', revisionId: stalePin, mode: 'must-match-accepted' }] });
    const store = storeWith(mustMatch.seed);
    expect(commit(store, mustMatch.input)).toMatchObject({ ok: false, code: 'dependency_stale', resourceId: 'r2' });
    expect(store.head('r1').versionSeq).toBe(1);

    const fresh = acceptFixture({ readDependencies: [{ resourceId: 'r2', revisionId: baseRev('r2'), mode: 'must-match-accepted' }] });
    expect(commit(storeWith(fresh.seed), fresh.input)).toMatchObject({ ok: true });
  });

  it('dependency_stale: must-match-accepted on a resource with no head', () => {
    const f = acceptFixture({ readDependencies: [{ resourceId: 'r9', revisionId: baseRev('r9'), mode: 'must-match-accepted' }] });
    const store = storeWith({ ...f.seed, heads: f.seed.heads!.filter((h) => h.resourceId !== 'r9') });
    expect(plan(store, f.input)).toMatchObject({ ok: false, code: 'dependency_stale', resourceId: 'r9' });
  });

  it('approval_invalid: approval older than the proposal mutation', () => {
    const f = acceptFixture({ updatedAt: '2026-10-06T12:00:00.001Z', approvedAt: '2026-10-06T12:00:00.000Z' });
    expect(plan(storeWith(f.seed), f.input)).toMatchObject({ ok: false, code: 'approval_invalid' });
  });

  it('approval at exactly the proposal mutation time is valid', () => {
    const f = acceptFixture({ updatedAt: FIXTURE_TIME.approved, approvedAt: FIXTURE_TIME.approved });
    expect(plan(storeWith(f.seed), f.input)).toMatchObject({ ok: true });
  });

  it('approval_invalid: approval for a different proposal hash', () => {
    const f = acceptFixture();
    const input = clone(f.input);
    input.approvals[0]!.proposalHash = otherHash;
    expect(plan(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'approval_invalid' });
  });

  it('approval_invalid: one bad approval among good ones still refuses', () => {
    const f = acceptFixture();
    const input = clone(f.input);
    input.approvals.push({ ...input.approvals[0]!, approvalId: 'appr-old', approvedAt: FIXTURE_TIME.created });
    expect(plan(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'approval_invalid' });
  });

  it('approval_invalid: no approvals, wrong proposalId, or malformed approval', () => {
    const f = acceptFixture();
    expect(plan(storeWith(f.seed), { ...f.input, approvals: [] })).toMatchObject({ ok: false, code: 'approval_invalid' });
    const wrongId = clone(f.input);
    (wrongId.approvals[0] as { proposalId: string }).proposalId = 'prop-other';
    expect(plan(storeWith(f.seed), wrongId)).toMatchObject({ ok: false, code: 'approval_invalid' });
    const malformed = clone(f.input);
    (malformed.approvals[0] as { approvedAt: string }).approvedAt = '2026-10-06T12:00:00+00:00';
    expect(plan(storeWith(f.seed), malformed)).toMatchObject({ ok: false, code: 'approval_invalid' });
  });

  it('policy_revision_stale: policy changed after the proposal was hashed', () => {
    const f = acceptFixture({ policyRevision: 1 });
    const store = storeWith(f.seed, { policyRevisions: [{ projectId: 'proj-1', policyRevision: 2 }] });
    expect(plan(store, f.input)).toMatchObject({ ok: false, code: 'policy_revision_stale' });
  });

  it('policy_revision_stale: no recorded policy counts as revision 0', () => {
    const f = acceptFixture({ policyRevision: 1 });
    const store = storeWith({ ...f.seed, policyRevisions: [] });
    expect(plan(store, f.input)).toMatchObject({ ok: false, code: 'policy_revision_stale' });
    const zero = acceptFixture({ policyRevision: 0 });
    expect(plan(storeWith({ ...zero.seed, policyRevisions: [] }), zero.input)).toMatchObject({ ok: true });
  });

  it('receipt_missing: receipt id not recorded on the proposal', () => {
    const f = acceptFixture();
    const input = clone(f.input);
    input.newHeads[0]!.preparedReceiptId = 'prep-forged';
    expect(plan(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'receipt_missing', resourceId: 'r1' });
  });

  it('receipt_missing: receipt recorded on the proposal but absent from the store', () => {
    const f = acceptFixture();
    expect(plan(storeWith({ ...f.seed, preparedReceipts: [] }), f.input)).toMatchObject({
      ok: false,
      code: 'receipt_missing',
      resourceId: 'r1',
    });
  });

  it('receipt_missing: receipt is for a different candidate', () => {
    const f = acceptFixture();
    const receipts = clone(f.seed.preparedReceipts!);
    receipts[0]!.revisionId = fixtureRev('r1', 'other-candidate');
    expect(plan(storeWith({ ...f.seed, preparedReceipts: receipts }), f.input)).toMatchObject({ ok: false, code: 'receipt_missing' });
  });

  it('receipt_missing: new head is neither the candidate nor a recorded integration commit', () => {
    const f = acceptFixture();
    const input = clone(f.input);
    input.newHeads[0]!.revisionId = fixtureRev('r1', 'unreviewed');
    expect(plan(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'receipt_missing', resourceId: 'r1' });
  });

  it('receipt_missing: fast-forward to a candidate not based on the expected head (lost-update guard)', () => {
    const f = acceptFixture();
    const moved = fixtureRev('r1', 'moved');
    const store = storeWith(f.seed, { heads: [{ resourceId: 'r1', revisionId: moved, versionSeq: 2 }] });
    const input = clone(f.input);
    input.expectedHeads = [{ resourceId: r1, revisionId: moved }];
    expect(plan(store, input)).toMatchObject({ ok: false, code: 'receipt_missing', resourceId: 'r1' });
  });

  it('receipt_missing: integration receipt made against a different expected head', () => {
    const f = acceptFixture();
    const moved = fixtureRev('r1', 'moved');
    const integrated = fixtureRev('r1', 'integrated');
    const receipt: IntegrationReceipt = {
      jobId: 'job-int-1',
      proposalId: f.input.proposalId,
      results: [
        { resourceId: r1, integrationRef: 'refs/commonforge/integrations/prop-1', sha: fixtureSha('x'), revisionId: integrated, expectedHead: baseRev('r1') },
      ],
      evidence: f.input.evidence[0]!,
      integratedAt: FIXTURE_TIME.prepared,
    };
    const store = storeWith(f.seed, { heads: [{ resourceId: 'r1', revisionId: moved, versionSeq: 2 }], integrationReceipts: [receipt] });
    const input = clone(f.input);
    input.expectedHeads = [{ resourceId: r1, revisionId: moved }];
    input.newHeads[0]!.revisionId = integrated;
    expect(plan(store, input)).toMatchObject({ ok: false, code: 'receipt_missing', resourceId: 'r1' });
  });

  it('evidence_missing: no evidence', () => {
    const f = acceptFixture();
    expect(plan(storeWith(f.seed), { ...f.input, evidence: [] })).toMatchObject({ ok: false, code: 'evidence_missing' });
  });

  it('evidence_missing: signature absent (presence only; HMAC verification is the app’s job)', () => {
    const f = acceptFixture();
    const input = clone(f.input);
    (input.evidence[0] as { signature: string }).signature = '';
    expect(plan(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'evidence_missing' });
    const noSig = clone(f.input);
    delete (noSig.evidence[0] as { signature?: string }).signature;
    expect(plan(storeWith(f.seed), noSig)).toMatchObject({ ok: false, code: 'evidence_missing' });
  });

  it('evidence_missing: evidence for another proposal hash, a failed check, or a non-clean merge', () => {
    const f = acceptFixture();
    const wrongHash = clone(f.input);
    wrongHash.evidence[0]!.proposalHash = otherHash;
    expect(plan(storeWith(f.seed), wrongHash)).toMatchObject({ ok: false, code: 'evidence_missing' });

    const failed = clone(f.input);
    failed.evidence[0]!.checks[0]!.result = 'fail';
    expect(plan(storeWith(f.seed), failed)).toMatchObject({ ok: false, code: 'evidence_missing' });

    const conflict = clone(f.input);
    conflict.evidence[0]!.mergeOutcome[0]!.result = 'textual-conflict';
    expect(plan(storeWith(f.seed), conflict)).toMatchObject({ ok: false, code: 'evidence_missing', resourceId: 'r1' });
  });

  it('evidence_missing: a changed resource has no clean merge outcome', () => {
    const f = acceptFixture({ resources: ['r1', 'r2'] });
    const input = clone(f.input);
    input.evidence[0]!.mergeOutcome = input.evidence[0]!.mergeOutcome.filter((m) => m.resourceId !== 'r2');
    expect(plan(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'evidence_missing', resourceId: 'r2' });
  });

  it('proposal_not_prepared: open, unknown, or already-accepted proposals', () => {
    const f = acceptFixture();
    const open = { ...clone(f.proposal), state: 'open' as const };
    expect(plan(storeWith({ ...f.seed, proposals: [open] }), f.input)).toMatchObject({ ok: false, code: 'proposal_not_prepared' });
    expect(plan(storeWith({ ...f.seed, proposals: [] }), f.input)).toMatchObject({ ok: false, code: 'proposal_not_prepared' });

    const store = storeWith(f.seed);
    accepted(commit(store, f.input));
    expect(commit(store, { ...f.input, idempotencyKey: 'another-key' })).toMatchObject({ ok: false, code: 'proposal_not_prepared' });
  });
});

describe('planCommit: idempotency (AT-14)', () => {
  it('replays by idempotency key without advancing', () => {
    const f = acceptFixture({ idempotencyKey: 'k1' });
    const store = storeWith(f.seed);
    const first = accepted(commit(store, f.input));
    const second = commit(store, f.input);
    expect(second).toEqual({ ok: true, replayed: true, acceptedVersionId: first.acceptedVersionId });
    expect(store.head('r1').versionSeq).toBe(2);
    expect(store.acceptedVersions()).toHaveLength(1);
    expect(store.outbox()).toHaveLength(1);
  });

  it('replays even after the head has since moved (lost response retried late)', () => {
    const f = acceptFixture({ idempotencyKey: 'k1' });
    const store = storeWith(f.seed);
    const first = accepted(commit(store, f.input));
    store.seedHead({ resourceId: 'r1', revisionId: fixtureRev('r1', 'later'), versionSeq: 3 });
    expect(commit(store, f.input)).toMatchObject({ ok: true, replayed: true, acceptedVersionId: first.acceptedVersionId });
  });

  it('replay is independent of array order in the request', () => {
    const f = acceptFixture({ resources: ['r1', 'r2'] });
    const store = storeWith(f.seed);
    const first = accepted(commit(store, f.input));
    const reordered = clone(f.input);
    reordered.newHeads.reverse();
    reordered.expectedHeads.reverse();
    expect(commit(store, reordered)).toMatchObject({ ok: true, replayed: true, acceptedVersionId: first.acceptedVersionId });
  });

  it('same key with a different request is refused (idempotency_key_conflict), not replayed', () => {
    const a = acceptFixture({ idempotencyKey: 'k1' });
    const b = acceptFixture({ proposalId: 'prop-2', resources: ['r2'], idempotencyKey: 'k1' });
    const store = storeWith(a.seed, b.seed);
    accepted(commit(store, a.input));
    const d = commit(store, b.input);
    expect(d).toMatchObject({ ok: false, code: 'idempotency_key_conflict' });
    expect(store.head('r2').versionSeq).toBe(1);
    expect(store.acceptedVersions()).toHaveLength(1);
  });

  it('a refusal does not consume the idempotency key', () => {
    const f = acceptFixture({ idempotencyKey: 'k1' });
    const store = storeWith(f.seed, { policyRevisions: [{ projectId: 'proj-1', policyRevision: 2 }] });
    expect(commit(store, f.input)).toMatchObject({ ok: false, code: 'policy_revision_stale' });
    expect(store.idempotency('k1', 'org-1')).toBeNull();
  });
});

describe('planCommit: concurrency and atomicity', () => {
  it('two interleaved commits against the same head: exactly one wins', async () => {
    const a = acceptFixture({ proposalId: 'prop-a' });
    const b = acceptFixture({ proposalId: 'prop-b' });
    const store = storeWith(mergeSeeds(a.seed, b.seed));
    const results = await Promise.all([
      store.transaction((tx) => commitIn(tx, a.input)),
      store.transaction((tx) => commitIn(tx, b.input)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ code: 'expected_head_stale', resourceId: 'r1' })]);
    expect(store.head('r1').versionSeq).toBe(2);
    expect(store.acceptedVersions()).toHaveLength(1);
  });

  it('multi-resource proposal is atomic: one stale head writes nothing', () => {
    const f = acceptFixture({ resources: ['r1', 'r2'] });
    const store = storeWith(f.seed);
    store.seedHead({ resourceId: 'r2', revisionId: fixtureRev('r2', 'moved'), versionSeq: 2 });
    expect(commit(store, f.input)).toMatchObject({ ok: false, code: 'expected_head_stale', resourceId: 'r2' });
    expect(store.head('r1')).toMatchObject({ revisionId: baseRev('r1'), versionSeq: 1 });
    expect(store.acceptedVersions()).toEqual([]);
    expect(store.outbox()).toEqual([]);
    expect(store.audit()).toEqual([]);
    expect(store.proposal('prop-1')?.state).toBe('prepared');
  });

  it('multi-resource proposal advances every head under one accepted version', () => {
    const f = acceptFixture({ resources: ['r1', 'r2'] });
    const store = storeWith(f.seed);
    const d = accepted(commit(store, f.input));
    expect(store.head('r1')).toMatchObject({ revisionId: f.candidate.r1, versionSeq: 2, acceptedVersionId: d.acceptedVersionId });
    expect(store.head('r2')).toMatchObject({ revisionId: f.candidate.r2, versionSeq: 2, acceptedVersionId: d.acceptedVersionId });
    expect(store.acceptedVersions()).toHaveLength(1);
    expect(store.acceptedVersions()[0]!.heads.map((h) => h.resourceId)).toEqual(['r1', 'r2']);
    expect(store.outbox().map((e) => e.kind)).toEqual(['reconcile-ref', 'reconcile-ref']);
  });

  it('acceptedVersionId is monotonic per organization', () => {
    const fs = ['r1', 'r2', 'r3'].map((r, i) => acceptFixture({ proposalId: `prop-${i}`, resources: [r] }));
    const other = acceptFixture({ proposalId: 'prop-x', resources: ['x1'], organizationId: 'org-2', projectId: 'proj-2' });
    const store = storeWith(...fs.map((f) => f.seed), other.seed);
    const ids = fs.map((f) => accepted(commit(store, f.input)).acceptedVersionId);
    expect(ids).toEqual(['av-000000000001', 'av-000000000002', 'av-000000000003']);
    expect([...ids].sort()).toEqual(ids);
    expect(store.acceptedVersions().map((v) => v.sequence)).toEqual([1, 2, 3]);
    // another organization has its own sequence
    expect(accepted(commit(store, other.input)).acceptedVersionId).toBe('av-000000000001');
  });
});

describe('planCommit: input validation', () => {
  it('throws LedgerInputError for structurally invalid input or timestamps', () => {
    const f = acceptFixture();
    const store = storeWith(f.seed);
    expect(() => plan(store, { ...f.input, proposalId: 'bad id' as AcceptInput['proposalId'] })).toThrow(LedgerInputError);
    expect(() => plan(store, f.input, '2026-10-06T13:00:00Z')).toThrow(LedgerInputError);
    expect(() => plan(store, f.input, '2026-10-06T13:00:00.000+01:00')).toThrow(LedgerInputError);
  });

  it('proposal hash recomputation uses core hashing', () => {
    const f = acceptFixture();
    expect(computeProposalHashSync(f.proposal)).toBe(f.proposal.proposalHash);
    expect(artRevisionId('repo-r1', fixtureSha('r1:base'))).toBe(baseRev('r1'));
    expect(r2).toBe('r2');
  });
});

function commitIn(tx: LedgerTx, input: AcceptInput) {
  return executeCommit(tx, input, NOW);
}
