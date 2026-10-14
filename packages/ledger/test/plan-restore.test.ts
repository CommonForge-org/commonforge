import { describe, expect, it } from 'vitest';
import { FIXTURE_ACTOR, FIXTURE_ORG, FIXTURE_TIME, acceptFixture, baseRev, fixtureRev, planRestore } from '../src/index.js';
import { accepted, commit, restore, storeWith } from './helpers.js';

function acceptedStore() {
  const f = acceptFixture();
  const store = storeWith(f.seed);
  const d = accepted(commit(store, f.input));
  return { f, store, firstVersion: d.acceptedVersionId };
}

const req = (over: Record<string, unknown> = {}) => ({
  organizationId: FIXTURE_ORG,
  resourceId: 'r1',
  expectedHead: '' as string,
  targetRevision: baseRev('r1') as string,
  idempotencyKey: 'restore-1',
  actor: FIXTURE_ACTOR,
  ...over,
});

describe('planRestore', () => {
  it('restore creates a forward head equal to the target', () => {
    const { f, store } = acceptedStore();
    expect(store.head('r1')).toMatchObject({ revisionId: f.candidate.r1, versionSeq: 2 });
    const d = accepted(restore(store, req({ expectedHead: f.candidate.r1 }), FIXTURE_TIME.later));
    expect(d.acceptedVersionId).toBe('av-000000000002');
    expect(store.head('r1')).toMatchObject({
      revisionId: baseRev('r1'),
      versionSeq: 3,
      acceptedVersionId: 'av-000000000002',
      acceptedAt: FIXTURE_TIME.later,
      reconciliation: 'pending',
    });
    // history is never rewritten: the accept is still there, the restore is a new version
    expect(store.acceptedVersions().map((v) => [v.kind, v.sequence])).toEqual([
      ['accept', 1],
      ['restore', 2],
    ]);
    expect(store.acceptedVersions()[1]).toMatchObject({
      proposalId: null,
      proposalHash: null,
      heads: [{ resourceId: 'r1', revisionId: baseRev('r1'), previousRevisionId: f.candidate.r1, versionSeq: 3 }],
    });
    expect(store.outbox().at(-1)).toMatchObject({
      kind: 'reconcile-ref',
      payload: { resourceId: 'r1', targetRevision: baseRev('r1'), expectedCurrent: f.candidate.r1, acceptedVersionId: 'av-000000000002' },
    });
    expect(store.audit().at(-1)).toMatchObject({ action: 'resource.restored', subject: { kind: 'resource', id: 'r1' } });
  });

  it('refuses under CAS when the expected head is stale', () => {
    const { store } = acceptedStore();
    const d = restore(store, req({ expectedHead: baseRev('r1') }));
    expect(d).toMatchObject({ ok: false, code: 'expected_head_stale', resourceId: 'r1' });
    expect(store.head('r1').versionSeq).toBe(2);
  });

  it('refuses when the resource has no head', () => {
    const { store } = acceptedStore();
    const d = restore(store, req({ resourceId: 'r9', expectedHead: baseRev('r9'), targetRevision: baseRev('r9') }));
    expect(d).toMatchObject({ ok: false, code: 'expected_head_stale', resourceId: 'r9' });
  });

  it('refuses a target that was never an accepted head (restore_target_unknown)', () => {
    const { f, store } = acceptedStore();
    const d = restore(store, req({ expectedHead: f.candidate.r1, targetRevision: fixtureRev('r1', 'never-reviewed') }));
    expect(d).toMatchObject({ ok: false, code: 'restore_target_unknown', resourceId: 'r1' });
    expect(store.head('r1').versionSeq).toBe(2);
  });

  it('is idempotent: same key replays the original version without advancing', () => {
    const { f, store } = acceptedStore();
    const first = accepted(restore(store, req({ expectedHead: f.candidate.r1 })));
    const again = restore(store, req({ expectedHead: f.candidate.r1 }));
    expect(again).toEqual({ ok: true, replayed: true, acceptedVersionId: first.acceptedVersionId });
    expect(store.head('r1').versionSeq).toBe(3);
    expect(store.acceptedVersions()).toHaveLength(2);
  });

  it('same key with a different restore request is refused', () => {
    const { f, store } = acceptedStore();
    accepted(restore(store, req({ expectedHead: f.candidate.r1 })));
    const d = restore(store, req({ expectedHead: baseRev('r1'), targetRevision: f.candidate.r1 }));
    expect(d).toMatchObject({ ok: false, code: 'idempotency_key_conflict' });
    expect(store.head('r1').versionSeq).toBe(3);
  });

  it('an accept idempotency key cannot be reused for a restore', () => {
    const { f, store } = acceptedStore();
    const d = restore(store, req({ expectedHead: f.candidate.r1, idempotencyKey: f.input.idempotencyKey }));
    expect(d).toMatchObject({ ok: false, code: 'idempotency_key_conflict' });
  });

  it('planRestore alone is pure', () => {
    const { f, store } = acceptedStore();
    const d = store.transactionSync((tx) => planRestore(tx, req({ expectedHead: f.candidate.r1 }), FIXTURE_TIME.later));
    expect(d.ok).toBe(true);
    expect(store.head('r1').versionSeq).toBe(2);
  });
});
