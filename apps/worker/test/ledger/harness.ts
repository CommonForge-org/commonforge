/**
 * DO-backed `LedgerConformanceTarget`: every transaction runs inside the real `OrgLedger` instance
 * (via `runInDurableObject`) against its SQLite storage, through the same `SqliteLedgerStore`
 * adapter the DO's RPC methods use.
 */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { LedgerConformanceTarget, LedgerSeed, LedgerTx } from "@commonforge-org/ledger";
import type { OrgLedger } from "../../src/ledger/org-ledger.js";
import { SqliteLedgerStore, type SqliteLedgerTx } from "../../src/ledger/sqlite-store.js";

export type LedgerStub = DurableObjectStub<OrgLedger>;

/** A stub for a brand-new OrgLedger (unique name per call). */
export function freshLedger(prefix = "org"): LedgerStub {
  return env.ORG_LEDGER.get(env.ORG_LEDGER.idFromName(`${prefix}-${crypto.randomUUID()}`));
}

/** Run a synchronous SQLite ledger transaction inside the DO. */
export function inLedgerTx<T>(stub: LedgerStub, fn: (tx: SqliteLedgerTx) => T): Promise<T> {
  return runInDurableObject(stub, (_instance, state) => new SqliteLedgerStore(state.storage).transactionSync(fn));
}

export class OrgLedgerTestHarness implements LedgerConformanceTarget {
  constructor(readonly stub: LedgerStub = freshLedger("conformance")) {}

  seed(seed: LedgerSeed): Promise<void> {
    return runInDurableObject(this.stub, (_instance, state) => new SqliteLedgerStore(state.storage).seed(seed));
  }

  transaction<T>(fn: (tx: LedgerTx) => T): Promise<T> {
    return inLedgerTx(this.stub, fn);
  }

  /** Record steps go through the DO's real `putProposal` (its RPC body), with the clock pinned to `now`. */
  putProposal(record: unknown, now: string): Promise<unknown> {
    return runInDurableObject(this.stub, async (obj) => {
      const instance = obj as unknown as OrgLedger;
      instance.clockForTests = () => now;
      try {
        return await instance.putProposal(record);
      } finally {
        instance.clockForTests = null;
      }
    });
  }
}

/** A fake `Queue` producer: records sends, fails the next `failNext` sends. */
export class QueueMock {
  sent: unknown[] = [];
  failNext = 0;
  calls = 0;
  async send(body: unknown): Promise<void> {
    this.calls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("queue unavailable (mock)");
    }
    this.sent.push(structuredClone(body));
  }
  async sendBatch(): Promise<void> {
    throw new Error("sendBatch not expected");
  }
}

/** Replace the instance's OUTBOX binding with `mock` (lasts until the instance is evicted). */
export async function installQueueMock(stub: LedgerStub, mock = new QueueMock()): Promise<QueueMock> {
  await runInDurableObject(stub, (instance) => {
    const self = instance as unknown as { env: Record<string, unknown> };
    self.env = { ...self.env, OUTBOX: mock };
  });
  return mock;
}

export async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
