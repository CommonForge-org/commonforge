import { FIXTURE_ORG, FIXTURE_TIME, LEDGER_SCENARIOS, acceptFixture, runLedgerScenario } from "@commonforge-org/ledger";
import { describe, expect, it } from "vitest";
import { OrgLedgerTestHarness } from "./harness.js";

describe("OrgLedger (SQLite DO) passes every ledger scenario", () => {
  it("has scenarios to run", () => {
    expect(LEDGER_SCENARIOS.length).toBeGreaterThanOrEqual(19);
  });
  it("record steps run through the DO's own putProposal RPC body (it pins the organization)", async () => {
    const h = new OrgLedgerTestHarness();
    const f = acceptFixture();
    await h.putProposal({ ...f.proposal, state: "open" }, FIXTURE_TIME.now);
    expect(await h.stub.getOrganization()).toBe(FIXTURE_ORG);
    await expect(h.putProposal({ ...f.proposal, state: "accepted" }, FIXTURE_TIME.now)).rejects.toThrow(/^ledger_conflict: .*set only by accept/);
  });
  for (const s of LEDGER_SCENARIOS) {
    it(`${s.id}: ${s.title}`, async () => {
      const { failures } = await runLedgerScenario(new OrgLedgerTestHarness(), s);
      expect(failures).toEqual([]);
    });
  }
});
