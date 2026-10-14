/**
 * Fault-injection suite (plan §G.5, Task 23) over the real Worker on miniflare: D1, the OrgLedger
 * Durable Object, R2 and the queue handlers are real; Artifacts and the runner are the in-memory
 * doubles (test/fakes). Every fault is injected by a production chaos flag (`COMMONFORGE_CHAOS`,
 * src/chaos.ts), never by poking test state, so the same flags drive a rehearsal Worker.
 *
 * | §G.5 row                                         | flag                            | AT    |
 * |--------------------------------------------------|---------------------------------|-------|
 * | crash after fork, before ledger record → GC      | after_fork_before_record        |       |
 * | crash after prepare receipt, before commit       | after_prepare_before_commit     |       |
 * | provider 5xx during prepare → previous intact    | provider_5xx_during_prepare     | AT-12 |
 * | crash after commit, before reconcile → replay    | after_commit_before_reconcile   | AT-13 |
 * | lost accept response → same key, same version    | lost_accept_response            | AT-14 |
 * | runner job expiry → broker refuses, result late  | runner_job_expiry               |       |
 */
import type { OutboxEvent } from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { activeChaos, CHAOS_ALLOW_DEPLOYED, CHAOS_POINTS, isLocalWorker } from "../../src/chaos.js";
import { createServices } from "../../src/context.js";
import { runGc } from "../../src/services/gc.js";
import { RESULT_GRACE_MS } from "../../src/services/runner-jobs.js";
import { FakeRunner } from "../fakes/runner.js";
import { canonicalNs, codeResource, freezeAndPropose, harness, ownerWithOrg, prepareAndIntegrate, projectWith, provisionedTask, tasksNs, type Harness } from "../helpers.js";

const OUTBOX = "commonforge-outbox";
const STEPS = "commonforge-steps";
const ledgerOf = (orgId: string) => env.ORG_LEDGER.get(env.ORG_LEDGER.idFromName(`org:${orgId}`));
const repoName = (taskWorkspaceId: string) => `ws-${taskWorkspaceId}`;
const injecting = (h: Harness, ...points: string[]) => {
  h.envOverrides.COMMONFORGE_CHAOS = points.join(",");
};
const stopInjecting = (h: Harness) => {
  delete h.envOverrides.COMMONFORGE_CHAOS;
};

async function headOf(h: Harness, o: { token: string; orgId: string }, resourceId: string) {
  return (await h.api("GET", `/api/orgs/${o.orgId}/resources/${resourceId}`, { token: o.token })).body.head as { revisionId: string; versionSeq: number; reconciliation: string };
}

async function approveAndAccept(h: Harness, o: { token: string; orgId: string }, proposal: { proposalId: string; proposalHash: string }, key: string) {
  expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } })).status).toBe(201);
  return h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: key } });
}

describe("chaos flags: guarded, never on by default", () => {
  it("the shipped configuration sets no chaos flag", () => {
    // vitest loads apps/worker/wrangler.jsonc: its vars are what a deploy gets
    expect(env.COMMONFORGE_CHAOS).toBeUndefined();
    expect(env.COMMONFORGE_CHAOS_ALLOW_DEPLOYED).toBeUndefined();
    expect(activeChaos(env)).toEqual([]);
  });

  it("a deployed Worker ignores the flags unless explicitly allowed; unknown names are ignored", () => {
    const deployed = { COMMONFORGE_PUBLIC_URL: "https://commonforge-worker.example.workers.dev", COMMONFORGE_CHAOS: "lost_accept_response" };
    expect(isLocalWorker(deployed)).toBe(false);
    expect(activeChaos(deployed)).toEqual([]);
    expect(activeChaos({ ...deployed, COMMONFORGE_CHAOS_ALLOW_DEPLOYED: "yes" })).toEqual([]);
    expect(activeChaos({ ...deployed, COMMONFORGE_CHAOS_ALLOW_DEPLOYED: CHAOS_ALLOW_DEPLOYED })).toEqual(["lost_accept_response"]);
    for (const url of ["http://localhost:8787", "http://127.0.0.1:8787", "https://worker.test", "http://app.localhost"]) expect(isLocalWorker({ COMMONFORGE_PUBLIC_URL: url })).toBe(true);
    expect(isLocalWorker({ COMMONFORGE_PUBLIC_URL: "" })).toBe(false);
    expect(activeChaos({ COMMONFORGE_PUBLIC_URL: "http://127.0.0.1:8787", COMMONFORGE_CHAOS: ` ${CHAOS_POINTS.join(" , ")}, rm_rf ` })).toEqual([...CHAOS_POINTS]);
  });

  it("/health names the active faults so a rehearsal can see them", async () => {
    const h = harness();
    expect((await h.api("GET", "/health")).body).toEqual({ ok: true, service: "commonforge-worker", deployment: "production", emailMode: "log" });
    injecting(h, "lost_accept_response");
    expect((await h.api("GET", "/health")).body.chaos).toEqual(["lost_accept_response"]);
  });
});

describe("fault injection (plan §G.5)", () => {
  it("after_fork_before_record: the task repo exists with no ledger record; the GC sweep fails the workspace and deletes the repo", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    injecting(h, "after_fork_before_record");
    const created = await h.api("POST", `/api/orgs/${t.o.orgId}/projects/${t.pid}/tasks`, { token: t.o.token, body: { title: "crashes after fork", writeMounts: ["website"] } });
    expect(created.status).toBe(201);
    await h.drainSteps();
    stopInjecting(h);
    const ws = created.body.workspaces as Array<{ taskWorkspaceId: string }>;
    const ledger = ledgerOf(t.o.orgId);
    for (const w of ws) {
      expect(h.artifacts.findRepo(tasksNs(t.o.orgId), repoName(w.taskWorkspaceId)), "the fork landed").toBeTruthy();
      expect(await ledger.getWorkspace(w.taskWorkspaceId), "no ledger record").toBeNull();
    }
    expect((await h.api("GET", `/api/tasks/${created.body.taskId}`, { token: t.o.token })).body.state).toBe("provisioning");

    const svc = createServices(h.env(), h.deps);
    let r = await runGc(svc, { orgs: [t.o.orgId], stuckProvisioningSeconds: 0 });
    expect(r.errors).toEqual([]);
    expect((await h.api("GET", `/api/tasks/${created.body.taskId}`, { token: t.o.token })).body.state).toBe("failed");
    r = await runGc(svc, { orgs: [t.o.orgId], stuckProvisioningSeconds: 0 });
    expect(r.errors).toEqual([]);
    for (const w of ws) expect(h.artifacts.findRepo(tasksNs(t.o.orgId), repoName(w.taskWorkspaceId)), "the sweep collected the orphan").toBeUndefined();
    // idempotent, and the healthy task's repos were never touched
    r = await runGc(svc, { orgs: [t.o.orgId], stuckProvisioningSeconds: 0 });
    expect([r.sweptGhosts, r.errors]).toEqual([[], []]);
    for (const w of t.task.workspaces) expect(h.artifacts.findRepo(tasksNs(t.o.orgId), repoName(w.taskWorkspaceId))).toBeTruthy();
  });

  it("after_prepare_before_commit: the receipt is written, the step crashes; the retry reuses the receipt and acceptance still commits", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    injecting(h, "after_prepare_before_commit");
    const { proposal, sha } = await freezeAndPropose(h, t.o, t.taskId, { "index.html": "v2" });
    const [step] = h.steps.splice(0);
    let r = await h.deliver(STEPS, [step], 1); // first delivery: prepare, then crash
    expect(r.retried).toHaveLength(1);
    expect(t.runner.handled.filter((j) => j.job.kind === "prepare-candidate")).toHaveLength(1);
    let view = await h.api("GET", `/api/orgs/${t.o.orgId}/proposals/${proposal.proposalId}`, { token: t.o.token });
    expect(view.body.state).toBe("open"); // not prepared: the crash came before the candidate record
    const early = await h.api("POST", `/api/orgs/${t.o.orgId}/proposals/${proposal.proposalId}/accept`, { token: t.o.token, body: { idempotencyKey: "accept-early-0001" } });
    expect(early.status).toBe(409);

    // the redelivery joins the finished runner job: same receipt, recorded once
    r = await h.deliver(STEPS, [step], 2);
    expect(r.acked).toHaveLength(1);
    stopInjecting(h);
    expect(t.runner.handled.filter((j) => j.job.kind === "prepare-candidate")).toHaveLength(1);
    view = await h.api("GET", `/api/orgs/${t.o.orgId}/proposals/${proposal.proposalId}`, { token: t.o.token });
    expect(view.body.state).toBe("prepared");
    const integrated = await prepareAndIntegrate(h, t.o, proposal.proposalId);
    const acc = await approveAndAccept(h, t.o, integrated, "accept-after-crash-1");
    expect(acc.status).toBe(200);
    expect((await headOf(h, t.o, t.web.resourceId)).revisionId).toBe(`art:${t.web.repoId}:${sha}`);
    expect(t.runner.errors).toEqual([]);
  });

  it("provider_5xx_during_prepare (AT-12): the second resource fails to prepare; no accepted head advances; the retry prepares and both advance together", async () => {
    const h = harness();
    const runner = new FakeRunner(h);
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "v1" });
    const api = await codeResource(h, o, "api", { "src/index.ts": "api v1" });
    const pid = await projectWith(h, o, [
      { mountName: "website", resourceId: web.resourceId },
      { mountName: "api", resourceId: api.resourceId },
    ]);
    const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "website + api", writeMounts: ["website", "api"] } });
    expect(t.status).toBe(201);
    await h.drainSteps();
    const taskId = t.body.taskId as string;
    const lease = await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} });
    const agent = lease.body.leaseToken as string;
    const task = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body;
    const shas: Record<string, string> = {};
    for (const mount of ["website", "api"]) {
      const ws = task.workspaces.find((w: any) => w.mountName === mount);
      const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: mount, access: "write" } });
      expect(cred.status).toBe(200);
      const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
      const base = h.artifacts.repo(where.ns, where.name).refs.get("main")!;
      const sha = h.artifacts.makeCommit({ ...h.artifacts.files.get(base), [mount === "api" ? "src/index.ts" : "index.html"]: `${mount} v2` }, [base]);
      h.artifacts.push(where.ns, where.name, "main", sha);
      shas[mount] = sha;
      expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } })).status).toBe(201);
    }
    const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
    expect(p.status).toBe(201);
    const prepares = h.steps.splice(0) as Array<{ type: string; candidateId: string }>;
    expect(prepares.map((m) => m.type)).toEqual(["candidate.prepare", "candidate.prepare"]);

    // the first resource prepares; then the provider fails (5xx) for the second
    let r = await h.deliver(STEPS, [prepares[0]]);
    expect(r.acked).toHaveLength(1);
    injecting(h, "provider_5xx_during_prepare");
    r = await h.deliver(STEPS, [prepares[1]]);
    expect(r.retried).toHaveLength(1);
    stopInjecting(h);
    const view = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}`, { token: o.token });
    expect(view.body.state).toBe("open");
    const refused = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-partial-01" } });
    expect(refused.status).toBe(409);
    expect((await headOf(h, o, web.resourceId)).revisionId).toBe(web.revisionId);
    expect((await headOf(h, o, api.resourceId)).revisionId).toBe(api.revisionId);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}/versions`, { token: o.token })).body.versions).toHaveLength(1);

    // the queue redelivers: prepared; one acceptance advances both heads in one version
    r = await h.deliver(STEPS, [prepares[1]], 2);
    expect(r.acked).toHaveLength(1);
    const prepared = await prepareAndIntegrate(h, o, p.body.proposalId);
    const acc = await approveAndAccept(h, o, prepared, "accept-both-0001");
    expect(acc.status).toBe(200);
    expect((await headOf(h, o, web.resourceId)).revisionId).toBe(`art:${web.repoId}:${shas.website}`);
    expect((await headOf(h, o, api.resourceId)).revisionId).toBe(`art:${api.repoId}:${shas.api}`);
    const wv = (await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}/versions`, { token: o.token })).body.versions[0];
    const av = (await h.api("GET", `/api/orgs/${o.orgId}/resources/${api.resourceId}/versions`, { token: o.token })).body.versions[0];
    expect(wv.acceptedVersionId).toBe(av.acceptedVersionId);
    expect(runner.errors).toEqual([]);
  });

  it("after_commit_before_reconcile (AT-13): the head shows pending while the consumer is down; replay reconciles once", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    const { proposal, sha } = await freezeAndPropose(h, t.o, t.taskId, { "index.html": "v2" });
    const prepared = await prepareAndIntegrate(h, t.o, proposal.proposalId);
    const acc = await approveAndAccept(h, t.o, prepared, "accept-reconcile-1");
    expect(acc.status).toBe(200);
    const event = (await ledgerOf(t.o.orgId).listOutbox({ filter: "all" })).map((row) => row.event).find((e) => e.kind === "reconcile-ref" && e.payload.acceptedVersionId === acc.body.acceptedVersionId) as OutboxEvent;
    expect(event).toBeTruthy();
    const canonical = () => h.artifacts.repo(canonicalNs(t.o.orgId), t.web.resourceId).refs.get("main");
    const reconcileJobs = () => t.runner.handled.filter((j) => j.job.kind === "reconcile-ref").length;

    injecting(h, "after_commit_before_reconcile");
    let r = await h.deliver(OUTBOX, [event], 1);
    expect(r.retried).toHaveLength(1);
    expect(reconcileJobs()).toBe(0);
    expect((await headOf(h, t.o, t.web.resourceId)).revisionId).toBe(`art:${t.web.repoId}:${sha}`); // committed
    expect((await headOf(h, t.o, t.web.resourceId)).reconciliation).toBe("pending");
    expect(canonical()).toBe(t.web.sha); // refs/heads/main still lags

    // the redelivery (the flag still set: it fires on a first delivery only) reconciles
    r = await h.deliver(OUTBOX, [event], 2);
    expect(r.acked).toHaveLength(1);
    expect((await headOf(h, t.o, t.web.resourceId)).reconciliation).toBe("synced");
    expect(canonical()).toBe(sha);
    r = await h.deliver(OUTBOX, [event, event], 3);
    expect(r.acked).toHaveLength(2);
    expect(reconcileJobs()).toBe(1);
    stopInjecting(h);
  });

  it("lost_accept_response (AT-14): the accept commits but the answer is lost; the retry with the same key returns the same version", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    const { proposal, sha } = await freezeAndPropose(h, t.o, t.taskId, { "index.html": "v2" });
    const prepared = await prepareAndIntegrate(h, t.o, proposal.proposalId);
    injecting(h, "lost_accept_response");
    const lost = await approveAndAccept(h, t.o, prepared, "accept-lost-00001");
    expect(lost.status).toBe(503);
    expect(lost.body.error.code).toBe("chaos_response_lost");
    const head = await headOf(h, t.o, t.web.resourceId);
    expect(head.revisionId).toBe(`art:${t.web.repoId}:${sha}`);

    const retry = await h.api("POST", `/api/orgs/${t.o.orgId}/proposals/${proposal.proposalId}/accept`, { token: t.o.token, body: { idempotencyKey: "accept-lost-00001" } });
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    const versions = (await h.api("GET", `/api/orgs/${t.o.orgId}/resources/${t.web.resourceId}/versions`, { token: t.o.token })).body.versions;
    expect(versions.map((v: any) => v.kind)).toEqual(["accept", "bind"]);
    expect(retry.body.acceptedVersionId).toBe(versions[0].acceptedVersionId);
    expect((await headOf(h, t.o, t.web.resourceId)).versionSeq).toBe(head.versionSeq);
    stopInjecting(h);
  });

  it("runner_job_expiry: the broker refuses an expired job's credentials, a result past the grace is rejected, GC closes it, a fresh job succeeds", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    t.runner.opts.manual = true;
    h.deps.runnerWait = { pollMs: 5, timeoutMs: 20 };
    injecting(h, "runner_job_expiry");
    const { proposal } = await freezeAndPropose(h, t.o, t.taskId, { "index.html": "v2" });
    await h.drainSteps(1);
    stopInjecting(h);
    const job = t.runner.pending[0]!;
    expect(job.job.kind).toBe("prepare-candidate");
    expect(Date.parse(job.expiresAt) - Date.parse(job.issuedAt)).toBe(1000);
    // the broker never mints for a job this close to its deadline, and refuses it once it expired
    const before = h.artifacts.activeTokens(canonicalNs(t.o.orgId), t.web.resourceId).length;
    const soon = await t.runner.credential(job, (job.job as any).canonical, "write");
    expect([soon.status, soon.body.error.code]).toEqual([409, "job_expiring"]);
    const after = harness({ now: () => new Date(Date.parse(job.expiresAt) + 5 * 60_000) });
    const expired = await after.api("POST", "/api/runner/credential", { body: { signedJob: job, repo: (job.job as any).canonical, access: "write" } });
    expect([expired.status, expired.body.error.code]).toEqual([410, "job_expired"]);
    expect(h.artifacts.activeTokens(canonicalNs(t.o.orgId), t.web.resourceId)).toHaveLength(before);
    const late = harness({ now: () => new Date(Date.parse(job.expiresAt) + RESULT_GRACE_MS + 60_000) });
    const posted = await late.api("POST", "/api/runner/results", { body: { signedJob: job, result: { jobId: job.jobId, ok: false, code: "provider_unavailable", detail: "late" } } });
    expect(posted.status).toBe(410);

    const r = await runGc(createServices(late.env(), late.deps), { orgs: [t.o.orgId] }); // the sweep, past the result grace
    expect(r.expiredJobs).toBeGreaterThanOrEqual(1);
    t.runner.pending.splice(0);
    t.runner.opts.manual = false;
    h.deps.runnerWait = { pollMs: 5, timeoutMs: 3000 };
    const prepared = await prepareAndIntegrate(h, t.o, proposal.proposalId);
    expect(prepared.state).toBe("prepared");
    expect(t.runner.handled.filter((j) => j.job.kind === "prepare-candidate").map((j) => j.jobId)).not.toContain(job.jobId);
  });
});
