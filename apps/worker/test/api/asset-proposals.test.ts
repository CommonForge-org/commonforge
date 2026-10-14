/**
 * Task 23 (found live on the CI deployment): a task with a frozen asset workspace can be proposed
 * more than once (attempt 1 fails integration, a fix is submitted, attempt 2 is a new proposal).
 * The Worker's asset "prepared receipt" is write-once in the ledger, so it must be identical each
 * time; it used to carry the proposal's creation time and the second proposal failed 409
 * `ledger_conflict` ("write-once violation: prepared_receipts rcpt-asset-…").
 */
import { sha256HexSync } from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { codeResource, harness, member, ownerWithOrg, projectWith, waitUntil, type Harness } from "../helpers.js";

describe("asset prepared receipts", () => {
  it("a second proposal of the same task re-records the same asset receipt", async () => {
    const h = harness();
    new FakeRunner(h);
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "v1" });
    const brand = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "brand", provider: "r2-assets" } });
    const pid = await projectWith(h, o, [
      { mountName: "website", resourceId: web.resourceId },
      { mountName: "brand", resourceId: brand.body.resourceId },
    ]);
    const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "t", writeMounts: ["website", "brand"], readMounts: [] } });
    expect(t.status).toBe(201);
    await h.drainSteps();
    const taskId = t.body.taskId as string;
    const agent = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} })).body.leaseToken as string;

    const bytes = new TextEncoder().encode("violet-logo");
    const stage = await h.api("POST", `/api/tasks/${taskId}/assets/stage`, { token: agent, body: { mountName: "brand", path: "logo.png", size: bytes.length, mime: "image/png" } });
    expect((await h.api("PUT", stage.body.uploadUrl, { token: agent, raw: bytes, headers: { "content-length": String(bytes.length) } })).status).toBe(201);
    const commit = await h.api("POST", `/api/tasks/${taskId}/assets/commit`, { token: agent, body: { mountName: "brand", changes: [{ path: "logo.png", stagingKey: stage.body.stagingKey, sha256: sha256HexSync(bytes), mime: "image/png" }] } });
    expect(commit.status).toBe(200);
    const wss = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body.workspaces;
    const brandWs = wss.find((w: any) => w.mountName === "brand");
    expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${brandWs.taskWorkspaceId}/freeze`, { token: agent, body: {} })).status).toBe(200);

    const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "website", access: "write" } });
    const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
    const base = h.artifacts.repo(where.ns, where.name).refs.get("main")!;
    const sha = h.artifacts.makeCommit({ "index.html": "<img src=logo.png>" }, [base]);
    h.artifacts.push(where.ns, where.name, "main", sha);
    const webWs = wss.find((w: any) => w.mountName === "website");
    expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${webWs.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } })).status).toBe(201);

    const p1 = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
    expect(p1.status).toBe(201);
    await h.drainSteps();
    await new Promise((r) => setTimeout(r, 15)); // a later clock than proposal 1
    // review m5: a GC sweep (markSwept) may bump the frozen row's updated_at after the first receipt
    await env.DB.prepare("UPDATE task_workspaces SET updated_at = ? WHERE task_workspace_id = ?").bind(new Date(Date.now() + 1000).toISOString(), brandWs.taskWorkspaceId).run();
    const p2 = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
    expect(p2.status, JSON.stringify(p2.body)).toBe(201);
    const assetReceipt = (p: any) => p.preparedReceipts.find((r: any) => r.resourceId === brand.body.resourceId)?.receiptId;
    expect(assetReceipt(p2.body)).toBe(assetReceipt(p1.body));
  });

});

/** website, api, requirements (git) + brand (R2) under the `quote` contract and a website check. */
async function contractWorld() {
  const h = harness();
  const runner = new FakeRunner(h);
  const o = await ownerWithOrg(h);
  const web = await codeResource(h, o, "website", { "index.html": "v1" });
  const api = await codeResource(h, o, "api", { "scripts/quote-sample.ts": "console.log('{}')" });
  const req = await codeResource(h, o, "requirements", { "contracts/quote.schema.json": "{}" });
  const brand = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "brand", provider: "r2-assets" } });
  const pid = await projectWith(h, o, [
    { mountName: "website", resourceId: web.resourceId },
    { mountName: "api", resourceId: api.resourceId },
    { mountName: "requirements", resourceId: req.resourceId },
    { mountName: "brand", resourceId: brand.body.resourceId },
  ]);
  const contract = { contractId: "quote", version: "1", producerResource: api.resourceId, consumerResource: web.resourceId, schema: { resourceId: req.resourceId, path: "contracts/quote.schema.json" }, producerOutput: { mountName: "api", command: "node scripts/quote-sample.ts" } };
  const check = { checkId: "quote-contract", mountName: "website", command: "pnpm exec vitest run tests/quote-contract.test.ts", timeoutSeconds: 300 };
  expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { checks: [check], contracts: [contract], rules: [] } })).status).toBe(200);
  return { h, runner, o, pid, web, api, req, brandId: brand.body.resourceId as string };
}

async function task(h: Harness, o: { token: string; orgId: string }, pid: string, writeMounts: string[]) {
  const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "t", writeMounts, readMounts: [] } });
  expect(t.status).toBe(201);
  await h.drainSteps();
  const taskId = t.body.taskId as string;
  const agent = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} })).body.leaseToken as string;
  return { taskId, agent };
}

async function logoFrozen(h: Harness, taskId: string, agent: string) {
  const bytes = new TextEncoder().encode("amber-logo");
  const stage = await h.api("POST", `/api/tasks/${taskId}/assets/stage`, { token: agent, body: { mountName: "brand", path: "logo.png", size: bytes.length, mime: "image/png" } });
  await h.api("PUT", stage.body.uploadUrl, { token: agent, raw: bytes, headers: { "content-length": String(bytes.length) } });
  expect((await h.api("POST", `/api/tasks/${taskId}/assets/commit`, { token: agent, body: { mountName: "brand", changes: [{ path: "logo.png", stagingKey: stage.body.stagingKey, sha256: sha256HexSync(bytes), mime: "image/png" }] } })).status).toBe(200);
  const ws = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body.workspaces.find((w: any) => w.mountName === "brand");
  expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: {} })).status).toBe(200);
}

async function integrateJob(h: Harness, runner: FakeRunner, o: { token: string; orgId: string }, taskId: string) {
  const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  await h.drainSteps();
  const r = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/integrate`, { token: o.token });
  expect(r.status, JSON.stringify(r.body)).toBe(202);
  await waitUntil(async () => runner.handled.some((j) => j.job.kind === "integrate" && (j.job as any).proposalId === p.body.proposalId));
  const job = runner.handled.find((j) => j.job.kind === "integrate" && (j.job as any).proposalId === p.body.proposalId)!.job as any;
  await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}`, { token: o.token })).body.integration?.forCurrentHash === true);
  return { proposal: p.body, job };
}

describe("review C1: policy checks and contracts always run (pinned references, fail closed)", () => {
  it("a website-only task (agent 3 / client edition shape) is contract-checked against a pinned api reference", async () => {
    const { h, runner, o, pid, web, api, req } = await contractWorld();
    const { taskId, agent } = await task(h, o, pid, ["website"]);
    // the agent's task snapshot (credentials, materialization) still holds only its own mount
    const plan = await h.api("GET", `/api/tasks/${taskId}/materialization?root=/tmp/x`, { token: agent });
    expect(plan.status).toBe(200);
    expect(JSON.stringify(plan.body)).not.toContain(api.resourceId);
    expect((await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "api", access: "read" } })).status).toBeGreaterThanOrEqual(400);
    const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "website", access: "write" } });
    const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
    const sha = h.artifacts.makeCommit({ "index.html": "v2" }, [h.artifacts.repo(where.ns, where.name).refs.get("main")!]);
    h.artifacts.push(where.ns, where.name, "main", sha);
    const ws = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body.workspaces.find((w: any) => w.mountName === "website");
    expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } })).status).toBe(201);
    const { proposal, job } = await integrateJob(h, runner, o, taskId);
    expect(job.contracts.map((c: any) => c.contractId)).toEqual(["quote"]);
    expect(job.checks.map((c: any) => c.checkId)).toEqual(["quote-contract"]);
    expect(job.references.map((r: any) => r.resourceId).sort()).toEqual([api.resourceId, req.resourceId].sort());
    const pinned = job.baseSnapshot.entries.filter((e: any) => e.mountName !== "website").map((e: any) => `${e.mountName}:${e.mode}`).sort();
    expect(pinned).toEqual(["api:must-match-accepted", "requirements:must-match-accepted"]);
    // the pinned producer is bound into the proposal: a must-match read dependency (re-review R1)
    expect(proposal.readDependencies.filter((d: any) => d.resourceId === api.resourceId)).toEqual([expect.objectContaining({ mode: "must-match-accepted" })]);
    // re-review m1: the run evaluated the contract, and the owner sees both resource ids
    const ov = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}`, { token: o.token });
    expect(ov.body.lastAttempt.contractChecks).toEqual([{ contractId: "quote", result: "pass", producerResource: api.resourceId, consumerResource: web.resourceId }]);
    // a client who reads only the website sees the api/requirements dependencies redacted
    const client = await member(h, o, "client");
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope: { kind: "project", id: pid }, operations: ["read"] } });
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope: { kind: "resource", id: web.resourceId }, operations: ["read"] } });
    const cv = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}`, { token: client.token });
    expect(cv.status).toBe(200);
    expect(JSON.stringify(cv.body)).not.toContain(api.resourceId);
    expect(cv.body.readDependencies.filter((d: any) => d.redacted).length).toBe(2);
    expect(cv.body.lastAttempt.contractChecks).toEqual([{ contractId: "quote", result: "pass", consumerResource: web.resourceId }]);
  });

  it("a logo-only (assets-only) task is contract-checked too", async () => {
    const { h, runner, o, pid, api, req, web } = await contractWorld();
    const { taskId, agent } = await task(h, o, pid, ["brand"]);
    await logoFrozen(h, taskId, agent);
    const { job } = await integrateJob(h, runner, o, taskId);
    expect(job.targets).toEqual([]);
    expect(job.contracts.map((c: any) => c.contractId)).toEqual(["quote"]);
    expect(job.references.map((r: any) => r.resourceId).sort()).toEqual([api.resourceId, req.resourceId, web.resourceId].sort());
  });

  it("refuses 409 policy_unevaluable when the contract's producer mount is gone (never drops it)", async () => {
    const { h, runner, o, pid } = await contractWorld();
    expect((await h.api("DELETE", `/api/orgs/${o.orgId}/projects/${pid}/mounts/api`, { token: o.token })).status).toBeLessThan(300);
    const { taskId, agent } = await task(h, o, pid, ["brand"]);
    await logoFrozen(h, taskId, agent);
    const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
    expect(p.status).toBe(201);
    await h.drainSteps();
    const r = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/integrate`, { token: o.token });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("policy_unevaluable");
    expect(JSON.stringify(r.body.error.details)).toContain("producer mount api");
    expect(runner.handled.filter((j) => j.job.kind === "integrate")).toEqual([]);
  });
});

describe("review I1: integration state comes from the ledger", () => {
  it("a result recorded in D1 but not in the ledger is 'applying', blocks accept with 409 integration_applying, and the runner's retry re-applies it", async () => {
    const { h, runner, o, pid } = await contractWorld();
    const { taskId, agent } = await task(h, o, pid, ["brand"]);
    await logoFrozen(h, taskId, agent);
    const posts: Array<{ signedJob: any; result: unknown }> = [];
    const orig = runner.post.bind(runner);
    runner.post = async (signedJob: any, result: unknown) => {
      if (signedJob.job.kind === "integrate") posts.push({ signedJob, result });
      return orig(signedJob, result);
    };
    h.envOverrides.COMMONFORGE_CHAOS = "after_integrate_result_before_receipt";
    const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
    await h.drainSteps();
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/integrate`, { token: o.token })).status).toBe(202);
    await waitUntil(async () => posts.length === 1);
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}`, { token: o.token })).body.lastAttempt?.state === "applying");
    const view = (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}`, { token: o.token })).body;
    expect(view.integration).toBeNull();
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/approvals`, { token: o.token, body: { proposalHash: p.body.proposalHash } });
    const early = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-applying-1" } });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("integration_applying");
    expect(early.headers.get("retry-after")).toBe("2");
    // the runner retries its result POST: replayed, and the receipt is applied now
    delete h.envOverrides.COMMONFORGE_CHAOS;
    const retry = await orig(posts[0]!.signedJob, posts[0]!.result);
    expect(retry.status).toBeLessThan(300);
    expect(retry.body.replayed).toBe(true);
    const after = (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}`, { token: o.token })).body;
    expect(after.lastAttempt.state).toBe("succeeded");
    expect(after.integration?.forCurrentHash).toBe(true);
    // a second retry is a no-op (one proposal.integrated event)
    expect((await orig(posts[0]!.signedJob, posts[0]!.result)).status).toBeLessThan(300);
    const evs = (await h.api("GET", `/api/orgs/${o.orgId}/events?limit=500`, { token: o.token })).body.events.filter((e: any) => e.action === "proposal.integrated" && e.subject.id === p.body.proposalId);
    expect(evs.length).toBe(1);
    const ok = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-applying-2" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

/** Push a commit onto the task's mount and freeze it. */
async function gitFrozen(h: Harness, taskId: string, agent: string, mountName: string, files: Record<string, string>) {
  const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName, access: "write" } });
  const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
  const sha = h.artifacts.makeCommit(files, [h.artifacts.repo(where.ns, where.name).refs.get("main")!]);
  h.artifacts.push(where.ns, where.name, "main", sha);
  const ws = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body.workspaces.find((w: any) => w.mountName === mountName);
  expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } })).status).toBe(201);
}

async function approveAndAccept(h: Harness, o: { token: string; orgId: string }, proposal: { proposalId: string; proposalHash: string }, key: string) {
  await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } });
  return h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: key } });
}

describe("re-review R1: policy references are must-match-accepted (no write skew)", () => {
  it("a requirements-only proposal validated against api@A0 is refused dependency_stale once an api change is accepted; re-proposing re-pins and passes", async () => {
    const { h, runner, o, pid, api } = await contractWorld();
    const r = await task(h, o, pid, ["requirements"]);
    await gitFrozen(h, r.taskId, r.agent, "requirements", { "contracts/quote.schema.json": '{"v":2}' });
    const { proposal: pr } = await integrateJob(h, runner, o, r.taskId);
    // meanwhile an api-only change is validated and accepted
    const a = await task(h, o, pid, ["api"]);
    await gitFrozen(h, a.taskId, a.agent, "api", { "scripts/quote-sample.ts": "console.log('{\"v\":2}')" });
    const { proposal: pa } = await integrateJob(h, runner, o, a.taskId);
    const acc = await approveAndAccept(h, o, pa, "accept-api-1");
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    // the requirements proposal pinned api@A0: the review shows it stale, and accept refuses
    expect((await h.api("GET", `/api/orgs/${o.orgId}/proposals/${pr.proposalId}`, { token: o.token })).body.stale).toContain(api.resourceId);
    const refused = await approveAndAccept(h, o, pr, "accept-req-1");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("dependency_stale");
    // re-proposing the same task re-pins api at its new head; validated again, it is accepted
    const { proposal: pr2, job } = await integrateJob(h, runner, o, r.taskId);
    const apiHead = (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${pa.proposalId}`, { token: o.token })).body.integration.results[0].revisionId;
    expect(job.baseSnapshot.entries.find((e: any) => e.mountName === "api").revisionId).toBe(apiHead);
    const ok = await approveAndAccept(h, o, pr2, "accept-req-2");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

describe("re-review R3: 'applying' never becomes permanent", () => {
  it("a receipt never recorded past the grace reads failed receipt_not_recorded (Validate again), and a new run recovers", async () => {
    const { h, o, pid } = await contractWorld();
    const { taskId, agent } = await task(h, o, pid, ["brand"]);
    await logoFrozen(h, taskId, agent);
    h.envOverrides.COMMONFORGE_CHAOS = "after_integrate_result_before_receipt";
    const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
    await h.drainSteps();
    const view = async () => (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}`, { token: o.token })).body;
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/integrate`, { token: o.token })).status).toBe(202);
    await waitUntil(async () => (await view()).lastAttempt?.state === "applying");
    delete h.envOverrides.COMMONFORGE_CHAOS;
    // the runner gave up retrying; the job finished longer ago than the grace
    const jobId = (await view()).lastAttempt.jobId as string;
    await env.DB.prepare("UPDATE runner_jobs SET completed_at = ? WHERE job_id = ?").bind(Date.now() - 3 * 60_000, jobId).run();
    const stuck = (await view()).lastAttempt;
    expect(stuck.state).toBe("failed");
    expect(stuck.code).toBe("receipt_not_recorded");
    const acc = await approveAndAccept(h, o, p.body, "accept-stuck-1");
    expect(acc.status).toBe(409);
    expect(acc.body.error.code).toBe("receipt_not_recorded");
    // "Validate again": a fresh run is recorded and accept succeeds
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/integrate`, { token: o.token })).status).toBe(202);
    await waitUntil(async () => (await view()).lastAttempt?.state === "succeeded");
    expect((await view()).integration?.forCurrentHash).toBe(true);
    const ok = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-stuck-2" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("an older integrate job finishing after a newer one never overwrites the newer state", async () => {
    const { h, runner, o, pid } = await contractWorld();
    const { taskId, agent } = await task(h, o, pid, ["brand"]);
    await logoFrozen(h, taskId, agent);
    const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
    await h.drainSteps();
    runner.opts.manual = true;
    const view = async () => (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}`, { token: o.token })).body;
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/integrate`, { token: o.token })).status).toBe(202);
    await waitUntil(async () => runner.pending.length === 1);
    await new Promise((r) => setTimeout(r, 5));
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/integrate`, { token: o.token })).status).toBe(202);
    await waitUntil(async () => runner.pending.length === 2);
    const [older, newer] = runner.pending.splice(0);
    await runner.run(newer!);
    expect((await view()).lastAttempt).toMatchObject({ state: "succeeded", jobId: newer!.jobId });
    await new Promise((r) => setTimeout(r, 5)); // the older job's receipt is stamped later
    await runner.run(older!);
    const v = await view();
    expect(v.lastAttempt).toMatchObject({ state: "succeeded", jobId: newer!.jobId });
    expect(v.integration.jobId).toBe(newer!.jobId);
    const ok = await approveAndAccept(h, o, p.body, "accept-order-1");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("a run finishing after acceptance is superseded, and an accept retry with the same key replays", async () => {
    const { h, runner, o, pid } = await contractWorld();
    const { taskId, agent } = await task(h, o, pid, ["brand"]);
    await logoFrozen(h, taskId, agent);
    const { proposal } = await integrateJob(h, runner, o, taskId);
    runner.opts.manual = true;
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/integrate`, { token: o.token })).status).toBe(202);
    await waitUntil(async () => runner.pending.length === 1);
    const first = await approveAndAccept(h, o, proposal, "accept-late-1");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await runner.runPending(); // receipts are frozen now
    const v = (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}`, { token: o.token })).body;
    expect(v.lastAttempt.state).toBe("succeeded");
    const again = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-late-1" } });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, acceptedVersionId: first.body.acceptedVersionId });
  });
});
