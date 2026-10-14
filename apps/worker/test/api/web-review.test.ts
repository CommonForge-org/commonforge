/**
 * Task 20 review C-1 / I-4: the proposal view exposes its latest integration attempt whatever the
 * outcome (role-filtered), and the versions list carries the genesis (bound) version so the
 * imported revision can be restored.
 */
import { describe, expect, it } from "vitest";
import { freezeAndPropose, harness, member, prepareAndIntegrate, provisionedTask, waitUntil } from "../helpers.js";

const grant = (h: ReturnType<typeof harness>, o: { token: string; orgId: string }, userId: string, kind: string, id: string, operations: string[]) =>
  h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId, scope: { kind, id }, operations } });

describe("Task 20 review: proposal lastAttempt and genesis versions", () => {
  it("C-1: a failed integrate run (signed evidence) is shown as the last attempt; integration stays null", async () => {
    const h = harness();
    const { o, taskId, runner, pid, web } = await provisionedTask(h);
    runner.opts.integrateFailure = { code: "contract_failed", detail: "quote.json: unexpected property breakdown CANARY_DETAIL", contractId: "quote-schema", conflictPaths: ["tests/quote.test.ts"] };
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    await h.drainSteps();
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/integrate`, { token: o.token })).status).toBe(202);
    const url = `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}`;
    await waitUntil(async () => (await h.api("GET", url, { token: o.token })).body.lastAttempt?.state === "failed");
    expect(runner.errors).toEqual([]);
    const dev = (await h.api("GET", url, { token: o.token })).body;
    expect(dev.integration).toBeNull();
    expect(dev.lastAttempt).toMatchObject({
      state: "failed",
      forCurrentHash: true,
      code: "contract_failed",
      contractChecks: [{ contractId: "quote-schema", result: "fail" }],
      mergeOutcome: [{ resourceId: web.resourceId, result: "textual-conflict", conflictPaths: ["tests/quote.test.ts"] }],
      conflictPaths: ["tests/quote.test.ts"],
      signedEvidence: true,
    });
    expect(dev.lastAttempt.jobId).toMatch(/^job-/);
    expect(dev.lastAttempt.detail).toContain("CANARY_DETAIL");

    // clients: codes, names and paths only (I-3)
    const client = await member(h, o, "client");
    await grant(h, o, client.userId, "project", pid, ["read"]);
    await grant(h, o, client.userId, "resource", web.resourceId, ["read"]);
    const cv = (await h.api("GET", url, { token: client.token })).body;
    expect(cv.lastAttempt).toMatchObject({ state: "failed", code: "contract_failed", conflictPaths: ["tests/quote.test.ts"] });
    expect(cv.lastAttempt.jobId).toBeUndefined();
    expect(cv.lastAttempt.detail).toBeUndefined();
    expect(cv.lastAttempt.evidenceId).toBeUndefined();
    expect(JSON.stringify(cv)).not.toContain("CANARY");
  });

  it("C-1: a queued run shows as queued; a passing run as succeeded for the current hash", async () => {
    const h = harness();
    const { o, taskId, runner } = await provisionedTask(h);
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    await h.drainSteps();
    const url = `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}`;
    expect((await h.api("GET", url, { token: o.token })).body.lastAttempt).toBeNull();
    runner.opts.manual = true;
    await h.api("POST", `${url}/integrate`, { token: o.token });
    expect((await h.api("GET", url, { token: o.token })).body.lastAttempt).toMatchObject({ state: "queued", expired: false, code: null, signedEvidence: false });
    runner.opts.manual = false;
    await runner.runPending();
    const view = (await h.api("GET", url, { token: o.token })).body;
    expect(view.lastAttempt).toMatchObject({ state: "succeeded", forCurrentHash: true, signedEvidence: true });
    expect(view.integration.forCurrentHash).toBe(true);
  });

  it("I-4: versions include the bound (imported) version, and restoring to it works after an accept", async () => {
    const h = harness();
    const { o, taskId, web } = await provisionedTask(h);
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    const view = await prepareAndIntegrate(h, o, proposal.proposalId);
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: view.proposalHash } });
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-g-01" } })).status).toBe(200);
    const versions = (await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}/versions`, { token: o.token })).body.versions;
    const genesis = versions[versions.length - 1];
    expect(genesis).toMatchObject({ kind: "bind", proposalId: null, head: { revisionId: web.revisionId } });
    const head = versions[0].head.revisionId;
    const r = await h.api("POST", `/api/orgs/${o.orgId}/resources/${web.resourceId}/restore`, { token: o.token, body: { expectedHead: head, targetRevision: genesis.head.revisionId, idempotencyKey: "restore-g-01" } });
    expect(r.status).toBe(200);
    expect(r.body.headRevisionId).toBe(web.revisionId);
  });
});
