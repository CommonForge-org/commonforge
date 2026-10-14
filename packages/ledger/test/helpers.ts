import type { AcceptInput } from '@commonforge-org/core';
import {
  FIXTURE_TIME,
  InMemoryLedgerStore,
  executeCommit,
  executeRestore,
  type CommitDecision,
  type LedgerSeed,
  type RestoreRequestInput,
} from '../src/index.js';

export const NOW = FIXTURE_TIME.now;

export function storeWith(...seeds: LedgerSeed[]): InMemoryLedgerStore {
  const store = new InMemoryLedgerStore();
  for (const s of seeds) store.seed(s);
  return store;
}

/** Plan and apply an accept in one serialized transaction. */
export function commit(store: InMemoryLedgerStore, input: AcceptInput, now: string = NOW): CommitDecision {
  return store.transactionSync((tx) => executeCommit(tx, input, now));
}

export function restore(store: InMemoryLedgerStore, input: RestoreRequestInput, now: string = NOW): CommitDecision {
  return store.transactionSync((tx) => executeRestore(tx, input, now));
}

/** Narrow a decision to the accepted (non-replayed) variant or fail the test. */
export function accepted(d: CommitDecision) {
  if (!d.ok || d.replayed) throw new Error(`expected an accepted decision, got ${JSON.stringify(d)}`);
  return d;
}

/** Structured clone that drops brands for tweaking inputs. */
export function clone<T>(v: T): T {
  return structuredClone(v);
}
