import { resourceId, sha256HexSync, snapshotId, type IntegrationReceipt, type ProposalHash } from '@commonforge-org/core';
import { describe, expect, it } from 'vitest';
import {
  BIND_REQUEST_TAG,
  FIXTURE_ACTOR,
  FIXTURE_ORG,
  FIXTURE_TIME,
  LedgerInputError,
  acceptFixture,
  baseRev,
  executeBindHead,
  fixtureRev,
  fixtureSha,
  planCommit,
  type BindHeadRequestInput,
  type InMemoryLedgerStore,
} from '../src/index.js';
import { requestHash } from '../src/internal.js';
import { NOW, accepted, clone, commit, restore, storeWith } from './helpers.js';

const r1 = resourceId('r1');
const moved = fixtureRev('r1', 'moved');
const integrated = fixtureRev('r1', 'integrated');

/** r1 moved since the proposal; the runner integrated the candidate onto the moved head. */
function integrationWorld(tweak: (receipt: IntegrationReceipt) => void = () => {}) {
  const f = acceptFixture();
  const receipt: IntegrationReceipt = {
    jobId: 'job-int-1',
    proposalId: f.input.proposalId,
    results: [{ resourceId: r1, integrationRef: 'refs/commonforge/integrations/prop-1', sha: fixtureSha('int'), revisionId: integrated, expectedHead: moved }],
    evidence: { ...clone(f.input.evidence[0]!), evidenceId: 'ev-int' },
    integratedAt: FIXTURE_TIME.prepared,
  };
  tweak(receipt);
  const store = storeWith(f.seed, { heads: [{ resourceId: 'r1', revisionId: moved, versionSeq: 2 }], integrationReceipts: [receipt] });
  const input = clone(f.input);
  input.expectedHeads = [{ resourceId: r1, revisionId: moved }];
  input.newHeads[0]!.revisionId = integrated;
  return { f, store, input, receipt };
}

describe('I-1: integration commit is bound to its own receipt evidence', () => {
  it('accepts with the receipt evidence alone (input evidence not needed for that resource)', () => {
    const { store, input } = integrationWorld();
    expect(commit(store, { ...input, evidence: [] })).toMatchObject({ ok: true });
    expect(store.head('r1').revisionId).toBe(integrated);
  });

  it('P1: receipt left over from earlier proposal content (other hash) → receipt_missing', () => {
    const { store, input } = integrationWorld((r) => {
      r.evidence.proposalHash = sha256HexSync('some-older-proposal-hash') as ProposalHash;
    });
    expect(commit(store, input)).toMatchObject({ ok: false, code: 'receipt_missing', resourceId: 'r1' });
    expect(store.head('r1').revisionId).toBe(moved);
  });

  it('P16: receipt evidence with a failed check refuses even if the caller passes passing evidence', () => {
    const { store, input } = integrationWorld((r) => {
      r.evidence.checks[0]!.result = 'fail';
    });
    expect(commit(store, input)).toMatchObject({ ok: false, code: 'evidence_missing' });
  });

  it('receipt evidence with a failed contract check refuses', () => {
    const { store, input } = integrationWorld((r) => {
      r.evidence.contractChecks = [{ contractId: 'c1', producerResource: r1, consumerResource: resourceId('r2'), result: 'fail' }];
    });
    expect(commit(store, input)).toMatchObject({ ok: false, code: 'evidence_missing' });
  });

  it('receipt evidence without a clean merge outcome for the resource refuses', () => {
    const { store, input } = integrationWorld((r) => {
      r.evidence.mergeOutcome = [];
    });
    expect(commit(store, input)).toMatchObject({ ok: false, code: 'evidence_missing', resourceId: 'r1' });
  });
});

describe('M5: evidence', () => {
  it('P9: a failing item for this proposal is not masked by a passing one', () => {
    const f = acceptFixture();
    const input = clone(f.input);
    const failing = { ...clone(input.evidence[0]!), evidenceId: 'ev-fail' };
    failing.checks[0]!.result = 'fail';
    input.evidence.push(failing);
    expect(commit(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'evidence_missing' });
  });

  it('P11: evidence for another snapshot refuses', () => {
    const f = acceptFixture();
    const input = clone(f.input);
    input.evidence[0]!.snapshotId = snapshotId(sha256HexSync('unrelated snapshot'));
    expect(commit(storeWith(f.seed), input)).toMatchObject({ ok: false, code: 'evidence_missing' });
  });

  it('evidence for another proposal hash is ignored, not a refusal by itself', () => {
    const f = acceptFixture();
    const input = clone(f.input);
    const other = { ...clone(input.evidence[0]!), evidenceId: 'ev-other', proposalHash: sha256HexSync('x') as ProposalHash };
    other.checks[0]!.result = 'fail';
    input.evidence.push(other);
    expect(commit(storeWith(f.seed), input)).toMatchObject({ ok: true });
  });
});

describe('M1: time sanity', () => {
  it('P4: approval dated after now → approval_invalid', () => {
    const f = acceptFixture({ approvedAt: '2026-10-06T13:00:00.001Z' });
    expect(commit(storeWith(f.seed), f.input)).toMatchObject({ ok: false, code: 'approval_invalid' });
  });

  it('approval at exactly now is valid', () => {
    const f = acceptFixture({ approvedAt: NOW });
    expect(commit(storeWith(f.seed), f.input)).toMatchObject({ ok: true });
  });

  it('P5: now earlier than the proposal mutation throws LedgerInputError', () => {
    const f = acceptFixture();
    const store = storeWith(f.seed);
    expect(() => store.transactionSync((tx) => planCommit(tx, f.input, '2020-01-01T00:00:00.000Z'))).toThrow(LedgerInputError);
  });
});

const restoreReq = (over: Record<string, unknown>) => ({
  organizationId: FIXTURE_ORG,
  resourceId: 'r1',
  expectedHead: baseRev('r1') as string,
  targetRevision: baseRev('r1') as string,
  idempotencyKey: 'rk',
  actor: FIXTURE_ACTOR,
  ...over,
});

describe('M2: organization is derived from the ledger, never trusted', () => {
  it('P2: restore under another organization is refused and writes nothing', () => {
    const f = acceptFixture();
    const store = storeWith(f.seed);
    accepted(commit(store, f.input));
    const d = restore(store, restoreReq({ organizationId: 'org-other', expectedHead: f.candidate.r1 }));
    expect(d).toMatchObject({ ok: false, code: 'expected_head_stale', resourceId: 'r1' });
    expect(store.acceptedVersions()).toHaveLength(1);
  });

  it('accept refuses a resource bound to another organization', () => {
    const f = acceptFixture();
    const store = storeWith({ ...f.seed, heads: f.seed.heads!.map((h) => ({ ...h, organizationId: 'org-other' })) });
    expect(commit(store, f.input)).toMatchObject({ ok: false, code: 'expected_head_stale', resourceId: 'r1' });
  });

  it('accept refuses an unbound resource', () => {
    const f = acceptFixture();
    const store = storeWith({ ...f.seed, heads: f.seed.heads!.map(({ organizationId: _o, ...h }) => h) });
    expect(commit(store, f.input)).toMatchObject({ ok: false, code: 'expected_head_stale', resourceId: 'r1' });
  });
});

describe('M3: restore to the current head', () => {
  it('P3: is refused as restore_noop without writes or consuming the key', () => {
    const f = acceptFixture();
    const store = storeWith(f.seed);
    expect(restore(store, restoreReq({}))).toMatchObject({ ok: false, code: 'restore_noop', resourceId: 'r1' });
    expect(store.acceptedVersions()).toEqual([]);
    expect(store.outbox()).toEqual([]);
    expect(store.idempotency('rk', FIXTURE_ORG)).toBeNull();
  });
});

const bindReq = (over: Partial<BindHeadRequestInput> = {}): BindHeadRequestInput => ({
  organizationId: FIXTURE_ORG,
  resourceId: 'r1',
  revisionId: baseRev('r1'),
  idempotencyKey: 'bind-r1',
  actor: FIXTURE_ACTOR,
  ...over,
});
const bind = (store: InMemoryLedgerStore, req: BindHeadRequestInput, now = NOW) => store.transactionSync((tx) => executeBindHead(tx, req, now));

describe('M4: planBindHead (genesis)', () => {
  it('P7: creates the first head, binds the org, records a version and an audit event', () => {
    const f = acceptFixture();
    const store = storeWith({ ...f.seed, heads: [] });
    const d = accepted(bind(store, bindReq()));
    expect(d.acceptedVersionId).toBe('av-000000000001');
    expect(store.head('r1')).toMatchObject({ revisionId: baseRev('r1'), versionSeq: 1, acceptedVersionId: d.acceptedVersionId, reconciliation: 'synced' });
    expect(store.acceptedVersions()[0]).toMatchObject({ kind: 'bind', proposalId: null, heads: [{ previousRevisionId: null, versionSeq: 1 }] });
    expect(store.idempotency('bind-r1', FIXTURE_ORG)).toMatchObject({ scope: 'bind' });
    expect(store.audit().map((a) => a.action)).toEqual(['resource.bound']);
    expect(store.outbox()).toEqual([]);
    // the bound head is a normal head: the proposal can now be accepted on top of it
    expect(commit(store, f.input)).toMatchObject({ ok: true, acceptedVersionId: 'av-000000000002' });
    // and the genesis revision is a valid restore target
    expect(restore(store, restoreReq({ expectedHead: f.candidate.r1 }))).toMatchObject({ ok: true });
  });

  it('is idempotent and CAS on "no head"', () => {
    const store = storeWith({});
    const first = accepted(bind(store, bindReq()));
    expect(bind(store, bindReq())).toEqual({ ok: true, replayed: true, acceptedVersionId: first.acceptedVersionId });
    expect(bind(store, bindReq({ revisionId: fixtureRev('r1', 'other') }))).toMatchObject({ ok: false, code: 'idempotency_key_conflict' });
    expect(bind(store, bindReq({ idempotencyKey: 'bind-again' }))).toMatchObject({ ok: false, code: 'expected_head_stale', resourceId: 'r1' });
    expect(bind(store, bindReq({ organizationId: 'org-other', idempotencyKey: 'steal' }))).toMatchObject({ ok: false, code: 'expected_head_stale' });
    expect(store.acceptedVersions()).toHaveLength(1);
  });

  it('a bind key never replays an accept (and vice versa)', () => {
    const f = acceptFixture({ idempotencyKey: 'bind-r1' });
    const store = storeWith({ ...f.seed, heads: [] });
    accepted(bind(store, bindReq()));
    expect(commit(store, f.input)).toMatchObject({ ok: false, code: 'idempotency_key_conflict' });
  });

  it('an accept key never replays a bind, even through the legacy accept scope', () => {
    const f = acceptFixture({ idempotencyKey: 'shared-key' });
    const store = storeWith(f.seed);
    const a = accepted(commit(store, f.input));
    expect(store.idempotency('shared-key', FIXTURE_ORG)).toMatchObject({ scope: 'accept', acceptedVersionId: a.acceptedVersionId });
    // r2 is unbound and has no head, so only idempotency can refuse this bind
    expect(bind(store, bindReq({ resourceId: 'r2', revisionId: baseRev('r2'), idempotencyKey: 'shared-key' }))).toMatchObject({ ok: false, code: 'idempotency_key_conflict' });
    expect(store.findHead('r2')).toBeNull();
  });

  it('replays a bind recorded before the bind scope existed (scope accept, same request hash)', () => {
    const store = storeWith({});
    const req = bindReq();
    const hash = requestHash(BIND_REQUEST_TAG, { organizationId: req.organizationId, resourceId: req.resourceId, revisionId: req.revisionId, actor: req.actor });
    store.transactionSync((tx) =>
      tx.putIdempotency(FIXTURE_ORG, { key: 'bind-r1', scope: 'accept', requestHash: hash, acceptedVersionId: 'av-000000000001' as never, createdAt: NOW }),
    );
    expect(bind(store, req)).toEqual({ ok: true, replayed: true, acceptedVersionId: 'av-000000000001' });
    expect(bind(store, bindReq({ revisionId: fixtureRev('r1', 'other') }))).toMatchObject({ ok: false, code: 'idempotency_key_conflict' });
  });
});

describe('M6: idempotency keys are scoped per organization', () => {
  it('P15: the same key in two organizations is two independent requests', () => {
    const a = acceptFixture({ idempotencyKey: 'same' });
    const b = acceptFixture({ proposalId: 'prop-x', resources: ['x1'], organizationId: 'org-2', projectId: 'proj-2', idempotencyKey: 'same' });
    const store = storeWith(a.seed, b.seed);
    expect(commit(store, a.input)).toMatchObject({ ok: true, acceptedVersionId: 'av-000000000001' });
    expect(commit(store, b.input)).toMatchObject({ ok: true, acceptedVersionId: 'av-000000000001' });
    expect(store.idempotency('same', 'org-2')).toMatchObject({ scope: 'accept' });
  });
});
