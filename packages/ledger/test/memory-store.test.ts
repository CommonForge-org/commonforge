import { resourceId } from '@commonforge-org/core';
import { describe, expect, it } from 'vitest';
import { InMemoryLedgerStore, acceptFixture, applyWrites, baseRev, fixtureRev, planCommit } from '../src/index.js';
import { NOW, accepted, storeWith } from './helpers.js';

describe('InMemoryLedgerStore', () => {
  it('rolls back every write when the transaction throws', () => {
    const f = acceptFixture();
    const store = storeWith(f.seed);
    expect(() =>
      store.transactionSync((tx) => {
        const d = accepted(planCommit(tx, f.input, NOW));
        applyWrites(tx, d.writes);
        throw new Error('crash after apply');
      }),
    ).toThrow('crash after apply');
    expect(store.head('r1').versionSeq).toBe(1);
    expect(store.acceptedVersions()).toEqual([]);
    expect(store.outbox()).toEqual([]);
    expect(store.idempotency(f.input.idempotencyKey, 'org-1')).toBeNull();
    expect(store.proposal('prop-1')?.state).toBe('prepared');
  });

  it('rejects asynchronous transaction callbacks and rolls them back', async () => {
    const store = storeWith(acceptFixture().seed);
    await expect(store.transaction((() => Promise.resolve(1)) as never)).rejects.toThrow(/synchronous/);
    expect(() => store.transactionSync(() => Promise.resolve(1))).toThrow(/synchronous/);
  });

  it('refuses nested transactions', () => {
    const store = new InMemoryLedgerStore();
    expect(() => store.transactionSync(() => store.transactionSync(() => 1))).toThrow(/nested/);
  });

  it('serializes async transactions in submission order', async () => {
    const store = new InMemoryLedgerStore();
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => store.transaction(() => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it('validates records written through the tx', () => {
    const store = new InMemoryLedgerStore();
    expect(() =>
      store.transactionSync((tx) => tx.setHead({ resourceId: resourceId('r1'), revisionId: baseRev('r1'), versionSeq: 0 } as never)),
    ).toThrow();
  });

  it('records head history for restore targets, including seeds', () => {
    const store = new InMemoryLedgerStore();
    store.seedHead({ resourceId: 'r1', revisionId: baseRev('r1'), versionSeq: 1 });
    store.seedHead({ resourceId: 'r1', revisionId: fixtureRev('r1', 'two'), versionSeq: 2 });
    store.transactionSync((tx) => {
      expect(tx.wasAcceptedHead(resourceId('r1'), baseRev('r1'))).toBe(true);
      expect(tx.wasAcceptedHead(resourceId('r1'), fixtureRev('r1', 'nope'))).toBe(false);
    });
  });

  it('head() throws for an unknown resource', () => {
    expect(() => new InMemoryLedgerStore().head('r1')).toThrow(/no head/);
  });

  it('returns copies so callers cannot mutate store state', () => {
    const store = storeWith(acceptFixture().seed);
    const h = store.head('r1') as { versionSeq: number };
    h.versionSeq = 99;
    expect(store.head('r1').versionSeq).toBe(1);
  });
});
