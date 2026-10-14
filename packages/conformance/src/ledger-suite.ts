/**
 * `describeLedgerConformance(storeFactory)` — runs the ledger package's store-agnostic scenario
 * list (`LEDGER_SCENARIOS`: AT-09 … AT-15, one scenario per refusal code, and the `record.*`
 * record-keeping guard scenarios) against any
 * `LedgerStore` that can be seeded: the in-memory store, the Worker's OrgLedger Durable Object,
 * VibeControl's Postgres store. Scenario logic lives in `@commonforge-org/ledger`; this file only
 * registers one vitest case per scenario.
 *
 * Worker-safe (no `node:` imports), so it can run under `@cloudflare/vitest-pool-workers`.
 */
import { describe, expect, it } from 'vitest';
import { LEDGER_SCENARIOS, hasRecordSteps, runLedgerScenario, type LedgerConformanceTarget, type LedgerScenario } from '@commonforge-org/ledger';

export type { LedgerConformanceTarget, LedgerScenario } from '@commonforge-org/ledger';

export interface LedgerConformanceOptions {
  /** describe() title (default `LedgerStore conformance`) */
  name?: string;
  /** scenario ids to skip, with the reason (shown in the skipped test title) */
  skip?: Readonly<Record<string, string>>;
  /** called after each scenario with the store it used */
  dispose?(target: LedgerConformanceTarget): void | Promise<void>;
  /** per-scenario timeout in ms */
  timeoutMs?: number;
  /**
   * Run `record.*` scenarios over the transaction port when the target has no `putProposal`
   * record endpoint (stores without one, e.g. the in-memory store). Otherwise such a target fails
   * those scenarios: a store that claims conformance must expose its real record endpoint.
   */
  allowPortOnlyRecords?: boolean;
}

/** A fresh, empty store per scenario. */
export type LedgerStoreFactory = () => LedgerConformanceTarget | Promise<LedgerConformanceTarget>;

/** The scenarios the suite runs (re-exported for reporting). */
export const LEDGER_CONFORMANCE_SCENARIOS: readonly LedgerScenario[] = LEDGER_SCENARIOS;

export function describeLedgerConformance(storeFactory: LedgerStoreFactory, options: LedgerConformanceOptions = {}): void {
  const skip = options.skip ?? {};
  describe(options.name ?? 'LedgerStore conformance', () => {
    for (const s of LEDGER_SCENARIOS) {
      const reason = skip[s.id];
      if (reason !== undefined) {
        it.skip(`${s.id}: ${s.title} (skipped: ${reason})`, () => {});
        continue;
      }
      it(
        `${s.id}: ${s.title}`,
        async () => {
          const target = await storeFactory();
          try {
            if (hasRecordSteps(s) && target.putProposal === undefined && !options.allowPortOnlyRecords) {
              throw new Error(
                `${s.id}: the target has no putProposal hook. Wire it to the store's real record-keeping endpoint ` +
                  '(or pass allowPortOnlyRecords for a store without one) so the record guards are tested where they run.',
              );
            }
            const { failures } = await runLedgerScenario(target, s);
            expect(failures).toEqual([]);
          } finally {
            await options.dispose?.(target);
          }
        },
        options.timeoutMs,
      );
    }
  });
}
