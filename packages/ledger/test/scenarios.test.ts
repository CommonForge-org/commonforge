import { describe, expect, it } from 'vitest';
import { ProposalRecordSchema } from '@commonforge-org/core';
import { InMemoryLedgerStore, LEDGER_RECORD_ERROR_CODES, defaultRecordErrorCode, executePutProposal, hasRecordSteps, LEDGER_REFUSAL_CODES, LEDGER_SCENARIOS, runLedgerScenario } from '../src/index.js';

describe('ledger scenarios against InMemoryLedgerStore', () => {
  for (const s of LEDGER_SCENARIOS) {
    it(`${s.id}: ${s.title}`, async () => {
      const { failures } = await runLedgerScenario(new InMemoryLedgerStore(), s);
      expect(failures).toEqual([]);
    });
  }

  it('scenario ids are unique', () => {
    const ids = LEDGER_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every refusal code is exercised by some scenario', () => {
    const exercised = new Set(
      LEDGER_SCENARIOS.flatMap((s) =>
        s.steps.flatMap((st) =>
          st.kind === 'record' ? [] : st.kind === 'op' ? (st.expect.ok ? [] : [st.expect.code]) : (st.expectRefusals ?? []).map((r) => r.code),
        ),
      ),
    );
    expect([...LEDGER_REFUSAL_CODES].filter((c) => !exercised.has(c))).toEqual([]);
  });

  it('every record error code is exercised by some record step', () => {
    const exercised = new Set(LEDGER_SCENARIOS.flatMap((s) => s.steps.flatMap((st) => (st.kind === 'record' && !st.expect.ok ? [st.expect.code] : []))));
    expect([...LEDGER_RECORD_ERROR_CODES].filter((c) => !exercised.has(c))).toEqual([]);
  });

  describe('record steps go through the target putProposal endpoint when present', () => {
    class EndpointStore extends InMemoryLedgerStore {
      constructor(private readonly guarded: boolean) {
        super();
      }
      putProposal(record: Parameters<typeof executePutProposal>[1], now: string): Promise<unknown> {
        return this.transaction((tx) => (this.guarded ? executePutProposal(tx, record, now) : tx.putProposal(ProposalRecordSchema.parse(record))));
      }
    }
    const recordScenarios = LEDGER_SCENARIOS.filter(hasRecordSteps);

    it('has record scenarios', () => expect(recordScenarios.length).toBeGreaterThanOrEqual(3));
    for (const s of recordScenarios) {
      const expectsRefusal = s.steps.some((st) => st.kind === 'record' && !st.expect.ok);
      it(`${s.id}: a guarded endpoint passes${expectsRefusal ? ', an unguarded endpoint fails' : ''}`, async () => {
        expect((await runLedgerScenario(new EndpointStore(true), s)).failures).toEqual([]);
        if (expectsRefusal) expect((await runLedgerScenario(new EndpointStore(false), s)).failures).not.toEqual([]);
      });
    }

    it('maps coded endpoint errors (default mapper)', () => {
      expect(defaultRecordErrorCode(new Error('ledger_conflict: x'))).toBe('record_conflict');
      expect(defaultRecordErrorCode(new Error('ledger_invalid_input: x'))).toBe('record_invalid_input');
      expect(defaultRecordErrorCode(new Error('boom'))).toBeNull();
    });
  });

  it('a scenario run reports failures instead of throwing', async () => {
    const s = LEDGER_SCENARIOS.find((x) => x.id === 'accept.fast-forward')!;
    const broken = { ...s, expectHeads: [{ ...s.expectHeads[0]!, versionSeq: 7 }] };
    const { failures } = await runLedgerScenario(new InMemoryLedgerStore(), broken);
    expect(failures).toHaveLength(1);
  });
});
