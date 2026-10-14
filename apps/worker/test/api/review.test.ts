/**
 * Task 16 review fixes (C-1, I-1..I-6, minors), including the reviewer's probe cases
 * (zz-review-probe.test.ts A–H) as real assertions.
 */
import { describe, expect, it } from "vitest";
import { agentPush, canonicalNs, email, freezeAndPropose, harness, member, prepareAndIntegrate, provisionedTask, tasksNs, waitUntil } from "../helpers.js";

const grant = (h: ReturnType<typeof harness>, o: { token: string; orgId: string }, userId: string, kind: string, id: string, operations: string[]) =>
  h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId, scope: { kind, id }, operations } });

describe("review fixes", () => {
  it("C-1: integrate job carries the real base snapshot (runner stale check passes) and evidence names the candidate snapshot", async () => {
    const h = harness();
    const { o, taskId, runner, web } = await provisionedTask(h);
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    const view = await prepareAndIntegrate(h, o, proposal.proposalId);
    const job = runner.handled.find((j) => j.job.kind === "integrate")!.job as any;
    expect(job.baseSnapshot.snapshotId).toBe(proposal.baseSnapshotId);
    // the real runner's check: the target's entry pins exactly expectedHead
    const entry = job.baseSnapshot.entries.find((e: any) => e.resourceId === web.resourceId);
    expect(entry.revisionId).toBe(job.targets[0].expectedHead);
    expect(view.integration.forCurrentHash).toBe(true);
    expect(runner.errors).toEqual([]);
  });

  it("C-1: evidence signed for another snapshot is not recorded", async () => {
    const h = harness();
    const { o, taskId, runner } = await provisionedTask(h);
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    await h.drainSteps();
    // a runner that signs evidence with the base snapshot id (the pre-fix contract)
    runner.opts.evidenceSnapshotId = proposal.baseSnapshotId;
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/integrate`, { token: o.token })).status).toBe(202);
    // the results endpoint refuses it (parseRunnerResultForJob binds evidence to candidateSnapshotId)
    await waitUntil(async () => runner.errors.length > 0);
    expect(String(runner.errors[0])).toMatch(/result refused: 400 .*invalid_result/);
    const p = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}`, { token: o.token });
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: p.body.proposalHash } });
    const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-wrong-ev" } });
    expect(acc.status).toBe(409);
    expect(acc.body.error.code).toBe("evidence_missing");
  });

  it("I-1 (probes B/C): only the agent, the lease holder or an owner freezes; others cannot release the lease or take it over", async () => {
    const h = harness();
    const { o, taskId, pid, web, api } = await provisionedTask(h);
    const { ws, sha } = await agentPush(h, o.token, taskId, { "index.html": "v2" });
    const devNo = await member(h, o, "developer");
    const dev = await member(h, o, "developer");
    for (const r of [web.resourceId, api.resourceId]) await grant(h, o, dev.userId, "resource", r, ["read", "write"]);
    await grant(h, o, dev.userId, "project", pid, ["read"]);
    expect((await h.api("DELETE", `/api/tasks/${taskId}/lease`, { token: devNo.token })).status).toBe(404);
    expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: devNo.token, body: { expectedSha: sha } })).status).toBe(404);
    const notAssignee = await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: dev.token, body: { expectedSha: sha } });
    expect(notAssignee.status).toBe(403);
    expect(notAssignee.body.error.code).toBe("not_task_assignee");
    expect((await h.api("DELETE", `/api/tasks/${taskId}/lease`, { token: dev.token })).status).toBe(403);
    const takeover = await h.api("POST", `/api/tasks/${taskId}/lease`, { token: dev.token, body: {} });
    expect(takeover.status).toBe(409);
    expect(takeover.body.error.code).toBe("lease_held");
    // developers do not see task repo URLs or fork coordinates
    const tv = await h.api("GET", `/api/tasks/${taskId}`, { token: dev.token });
    expect(JSON.stringify(tv.body)).not.toContain("remoteUrl");
    // the lease holder (owner here) freezes; a reference copy is never frozen
    const refWs = tv.body.workspaces.find((w: any) => w.mountName === "api");
    expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${refWs.taskWorkspaceId}/freeze`, { token: o.token, body: { expectedSha: sha } })).status).toBe(409);
    expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: o.token, body: { expectedSha: sha } })).status).toBe(201);
    const cand = await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}/candidates`, { token: dev.token });
    expect(JSON.stringify(cand.body)).not.toContain('"fork"');
  });

  it("I-6: the reference copy is collected once the task is submitted", async () => {
    const h = harness();
    const { o, taskId, task } = await provisionedTask(h);
    const ref = task.workspaces.find((w: any) => w.mountName === "api");
    await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    const after = await h.api("GET", `/api/tasks/${taskId}`, { token: o.token });
    expect(after.body.state).toBe("submitted");
    expect(after.body.workspaces.find((w: any) => w.mountName === "api").state).toBe("collected");
    expect(h.artifacts.findRepo(tasksNs(o.orgId), `ws-${ref.taskWorkspaceId}`)).toBeUndefined();
  });

  it("I-3 (probe E): events are filtered by grants; clients get codes/paths, never runner output", async () => {
    const h = harness();
    const { o, taskId, pid, web, runner } = await provisionedTask(h);
    runner.opts.fail = { integrate: { code: "check_failed", detail: "secret canary CANARY_SECRET=xyz in src/quote.ts" } };
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    await h.drainSteps();
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/integrate`, { token: o.token });
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/events`, { token: o.token })).body.events.some((e: any) => e.action === "proposal.integration_failed"));
    const devNo = await member(h, o, "developer");
    const ev = await h.api("GET", `/api/orgs/${o.orgId}/events`, { token: devNo.token });
    expect(ev.body.events).toEqual([]);
    const client = await member(h, o, "client");
    await grant(h, o, client.userId, "project", pid, ["read"]);
    const noRes = await h.api("GET", `/api/orgs/${o.orgId}/events`, { token: client.token });
    expect(noRes.body.events.map((e: any) => e.action)).toEqual(["project.created"]);
    await grant(h, o, client.userId, "resource", web.resourceId, ["read"]);
    const ce = await h.api("GET", `/api/orgs/${o.orgId}/events`, { token: client.token });
    const failed = ce.body.events.find((e: any) => e.action === "proposal.integration_failed");
    expect(failed.detail).toEqual({ code: "check_failed", conflictPaths: [] });
    expect(JSON.stringify(ce.body)).not.toContain("CANARY");
    const owner = await h.api("GET", `/api/orgs/${o.orgId}/events`, { token: o.token });
    expect(JSON.stringify(owner.body)).toContain("CANARY"); // developers/owners keep the detail
  });

  it("M-2/M-3: developers cannot narrow write grants; removing a member ends their leases and revokes write tokens", async () => {
    const h = harness();
    const { o, taskId, web, api, pid } = await provisionedTask(h);
    const dev = await member(h, o, "developer");
    for (const r of [web.resourceId, api.resourceId]) await grant(h, o, dev.userId, "resource", r, ["read", "write"]);
    await grant(h, o, dev.userId, "project", pid, ["read"]);
    const other = await member(h, o, "developer");
    await grant(h, o, other.userId, "resource", web.resourceId, ["read"]);
    const narrow = await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: other.token, body: { userId: dev.userId, scope: { kind: "resource", id: web.resourceId }, operations: ["read"] } });
    expect(narrow.status).toBe(403);
    const lease = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: dev.token, body: {} })).body.leaseToken;
    const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: lease, body: { mountName: "website", access: "write" } });
    expect(cred.status).toBe(200);
    expect((await h.api("DELETE", `/api/orgs/${o.orgId}/members/${dev.userId}`, { token: o.token })).status).toBe(200);
    expect(h.artifacts.tokenByPlaintext(cred.body.secret)!.token.state).toBe("revoked");
    expect((await h.api("GET", `/api/tasks/${taskId}`, { token: lease })).status).toBe(401);
  });

  it("M-6: no agent token when the lease has under 60 s left", async () => {
    let now = Date.now();
    const h = harness({ now: () => new Date(now) });
    const { o, taskId } = await provisionedTask(h);
    const lease = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: { ttlSeconds: 300 } })).body.leaseToken;
    now += 250_000;
    const r = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: lease, body: { mountName: "website", access: "write" } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("lease_too_short");
  });

  it("M-8: integrate needs write grants; M-9: unreadable dependencies are redacted", async () => {
    const h = harness();
    const { o, taskId, pid, web } = await provisionedTask(h);
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    await h.drainSteps();
    const dev = await member(h, o, "developer");
    await grant(h, o, dev.userId, "project", pid, ["read"]);
    await grant(h, o, dev.userId, "resource", web.resourceId, ["read"]);
    const i = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/integrate`, { token: dev.token });
    expect(i.status).toBe(403);
    expect(i.body.error.code).toBe("no_write_grant");
    const v = await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}`, { token: dev.token });
    expect(v.body.readDependencies).toEqual([{ redacted: true, mode: "pinned-reference" }]);
  });

  it("M-7 (probe H): import URLs to IP literals, ports and internal names are refused", async () => {
    const h = harness();
    const { o } = await provisionedTask(h);
    for (const url of ["https://169.254.169.254/latest/meta-data", "https://10.0.0.1:22/x.git", "https://127.0.0.1.nip.io/x", "https://github.com:8443/a/b.git", "https://git.internal/a.git", "https://[::1]/a.git"]) {
      const r = await h.api("POST", `/api/orgs/${o.orgId}/intake/url`, { token: o.token, body: { url, branch: "main", name: "x" } });
      expect([url, r.status]).toEqual([url, 400]);
    }
  });

  it("probe D: 30 distinct addresses from one IP are capped", async () => {
    const h = harness();
    const codes: number[] = [];
    for (let i = 0; i < 30; i++) codes.push((await h.api("POST", "/api/auth/magic-link", { body: { email: email("victim") }, headers: { "cf-connecting-ip": "198.51.100.77" } })).status);
    expect(codes.filter((c) => c === 202)).toHaveLength(10);
    expect(h.email.sent).toHaveLength(10);
  });

  it("agents never hold a canonical token after a full task (AT-17 / I-6)", async () => {
    const h = harness();
    const { o, taskId, web, api } = await provisionedTask(h);
    const { agent } = await agentPush(h, o.token, taskId, { "index.html": "v2" });
    await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "api", access: "read" } });
    for (const r of [web.resourceId, api.resourceId]) {
      expect(h.artifacts.repo(canonicalNs(o.orgId), r).tokens.filter((t) => t.state === "active")).toHaveLength(0);
    }
  });

  it("N-1: a check on a reference mount runs: the job names it as a canonical read reference", async () => {
    const h = harness();
    const { o, taskId, pid, runner, api } = await provisionedTask(h);
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { checks: [{ checkId: "api-unit", mountName: "api", command: "npm test" }] } });
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    const view = await prepareAndIntegrate(h, o, proposal.proposalId); // fails (scope_violation) without references
    expect(view.integration.checks).toEqual([{ checkId: "api-unit", result: "pass" }]);
    const signed = runner.handled.find((j) => j.job.kind === "integrate")!;
    const job = signed.job as any;
    expect(job.references.map((r: any) => [r.resourceId, r.coords.namespace])).toEqual([[api.resourceId, canonicalNs(o.orgId)]]);
    // the runner may read the reference, never write it
    const creds = runner.credentials.filter((c) => c.jobId === signed.jobId);
    expect(creds.find((c) => c.repo.endsWith(`/${api.resourceId}`))).toMatchObject({ access: "read", status: 200 });
    const w = await runner.credential(signed, job.references[0].coords, "write");
    expect(w.status).toBe(409); // the job already reported (and write was never in scope)
  });

  it("N-2/N-3: narrowing a write grant ends the lease; removal revokes read tokens too", async () => {
    const h = harness();
    const { o, taskId, web, api, pid } = await provisionedTask(h);
    const dev = await member(h, o, "developer");
    await grant(h, o, dev.userId, "project", pid, ["read"]);
    await grant(h, o, dev.userId, "resource", web.resourceId, ["read", "write"]);
    await grant(h, o, dev.userId, "resource", api.resourceId, ["read"]);
    const { agent, ws, sha, cred } = await agentPush(h, dev.token, taskId, { "index.html": "v2" });
    const ref = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "api", access: "read" } });
    await grant(h, o, dev.userId, "resource", web.resourceId, ["read"]);
    expect((await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).status).toBe(401);
    expect(h.artifacts.tokenByPlaintext(cred.secret)!.token.state).toBe("revoked");
    expect(h.artifacts.tokenByPlaintext(ref.body.secret)!.token.state).toBe("revoked");
    expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } })).status).toBe(401);
  });

  it("N-4: a failed task marks its reference copies abandoned for the GC sweep", async () => {
    const h = harness();
    const o = await (await import("../helpers.js")).ownerWithOrg(h);
    const { codeResource, projectWith } = await import("../helpers.js");
    const { FakeRunner } = await import("../fakes/runner.js");
    const web = await codeResource(h, o, "website", { a: "1" });
    const api = await codeResource(h, o, "api", { b: "1" });
    new FakeRunner(h, { failSeedResource: web.resourceId });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }, { mountName: "api", resourceId: api.resourceId }]);
    const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "x", writeMounts: ["website"] } });
    await h.drainSteps();
    const v = await h.api("GET", `/api/tasks/${t.body.taskId}`, { token: o.token });
    expect(v.body.state).toBe("failed");
    expect(v.body.workspaces.map((w: any) => [w.mountName, w.state])).toEqual([["api", "abandoned"], ["website", "failed"]]);
  });

  it("N-5: IPv6 clients share a per-IP bucket per /64", async () => {
    const { ipBucket } = await import("../../src/services/auth.js");
    expect(ipBucket("2001:db8:1:2:aaaa::1")).toBe(ipBucket("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"));
    expect(ipBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(ipBucket("2001:db8:1:3::1")).not.toBe(ipBucket("2001:db8:1:2::1"));
    expect(ipBucket("203.0.113.7")).toBe("203.0.113.7");
    const h = harness();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await h.api("POST", "/api/auth/magic-link", { body: { email: email("v6") }, headers: { "cf-connecting-ip": `2001:db8:77:${i % 1 === 0 ? 5 : 5}::${(i + 1).toString(16)}` } })).status);
    expect(codes.filter((c) => c === 202)).toHaveLength(10);
  });

  it("N-6: task.created is hidden from developers who cannot read every task resource", async () => {
    const h = harness();
    const { o, web, pid } = await provisionedTask(h);
    const dev = await member(h, o, "developer");
    await grant(h, o, dev.userId, "project", pid, ["read"]);
    await grant(h, o, dev.userId, "resource", web.resourceId, ["read", "write"]);
    const ev = await h.api("GET", `/api/orgs/${o.orgId}/events`, { token: dev.token });
    expect(ev.body.events.map((e: any) => e.action)).not.toContain("task.created");
  });
});
