import { describe, expect, it } from "vitest";
import { canonicalNs, harness, member, provisionedTask, tasksNs } from "../helpers.js";

describe("tasks, workspaces, leases and the agent capability broker", () => {
  it("provisions a seeded -tasks repo in a queue step and records it in the ledger", async () => {
    const h = harness();
    const { o, web, api, task, runner } = await provisionedTask(h);
    const ws = task.workspaces.find((w: any) => w.mountName === "website");
    expect(ws.access).toBe("write");
    expect(ws.state).toBe("writable");
    expect(ws.taskWorkspaceId).toMatch(/^tw-[0-9a-f]{24}$/);
    expect(ws.remoteUrl).toContain(`/git/${tasksNs(o.orgId)}/ws-${ws.taskWorkspaceId}.git`);
    const repo = h.artifacts.repo(tasksNs(o.orgId), `ws-${ws.taskWorkspaceId}`);
    expect(repo.refs.get("main")).toBe(web.sha);
    expect(repo.tokens.filter((t) => t.state === "active")).toHaveLength(0); // create token revoked
    // I-6: the reference mount gets its own read-only copy in -tasks, seeded at the pinned sha
    const ref = task.workspaces.find((w: any) => w.mountName === "api");
    expect([ref.access, ref.state]).toEqual(["read", "writable"]);
    expect(h.artifacts.repo(tasksNs(o.orgId), `ws-${ref.taskWorkspaceId}`).refs.get("main")).toBe(api.sha);
    expect(runner.handled.map((j) => j.job.kind)).toEqual(["seed-workspace", "seed-workspace"]);
    // seed jobs: canonical read + task-fork write only
    expect(runner.credentials.map((c) => [c.repo.split("/")[0], c.access, c.status])).toEqual([
      [canonicalNs(o.orgId), "read", 200],
      [tasksNs(o.orgId), "write", 200],
      [canonicalNs(o.orgId), "read", 200],
      [tasksNs(o.orgId), "write", 200],
    ]);
    expect(task.snapshot.entries.find((e: any) => e.mountName === "website").operations).toEqual(["read", "write"]);
    expect(task.snapshot.entries.find((e: any) => e.mountName === "api").operations).toEqual(["read"]);
  });

  it("lease → agent token scoped to the task → write token for the task repo only", async () => {
    const h = harness();
    const { o, taskId, task, api } = await provisionedTask(h);
    const lease = await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} });
    expect(lease.status).toBe(200);
    expect(lease.body.leaseToken).toMatch(/^cfl_/);
    const agent = lease.body.leaseToken as string;

    const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "website", access: "write" } });
    expect(cred.status).toBe(200);
    expect(cred.headers.get("cache-control")).toBe("no-store");
    expect(cred.body.scope).toBe("write");
    expect(cred.body.remoteUrl).toContain(tasksNs(o.orgId));
    expect(Date.parse(cred.body.expiresAt) - Date.now()).toBeLessThanOrEqual(3600_000 + 5000);
    const minted = h.artifacts.tokenByPlaintext(cred.body.secret)!;
    expect(minted.ns).toBe(tasksNs(o.orgId));
    expect(minted.name).toBe(`ws-${task.workspaces.find((w: any) => w.mountName === "website").taskWorkspaceId}`);

    // AT-17 / I-6: agents never get a canonical token; references are read-only -tasks copies
    const w = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "api", access: "write" } });
    expect(w.status).toBe(403);
    expect(w.body.error.code).toBe("read_only_mount");
    const r = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "api", access: "read" } });
    expect(r.status).toBe(200);
    const rt = h.artifacts.tokenByPlaintext(r.body.secret)!;
    const refWs = task.workspaces.find((x: any) => x.mountName === "api");
    expect([rt.ns, rt.name, rt.token.scope]).toEqual([tasksNs(o.orgId), `ws-${refWs.taskWorkspaceId}`, "read"]);
    expect(h.artifacts.repo(canonicalNs(o.orgId), api.resourceId).tokens.filter((t) => t.state === "active")).toHaveLength(0);

    // the agent token works only for its own task routes
    expect((await h.api("GET", `/api/orgs/${o.orgId}`, { token: agent })).status).toBe(403);
    expect((await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).status).toBe(200);
    // users need the lease token for credentials
    const u = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: o.token, body: { mountName: "website", access: "write" } });
    expect(u.status).toBe(403);
    expect(u.body.error.code).toBe("lease_required");

    // the route validates the root with core's AbsoluteDirSchema (no late plan-schema failure)
    for (const bad of ["work/t1", "/work/../t1", "/work/./t1"]) {
      expect((await h.api("GET", `/api/tasks/${taskId}/materialization?root=${encodeURIComponent(bad)}`, { token: agent })).status, bad).toBe(400);
    }
    const plan = await h.api("GET", `/api/tasks/${taskId}/materialization?root=/work/t1`, { token: agent });
    expect(plan.status).toBe(200);
    const mounts = Object.fromEntries(plan.body.mounts.map((m: any) => [m.mountName, m]));
    expect(mounts.website.writable).toBe(true);
    expect(mounts.website.source.remoteUrl).toContain(tasksNs(o.orgId));
    expect(mounts.api.writable).toBe(false);
    expect(mounts.api.source.remoteUrl).toContain(`/git/${tasksNs(o.orgId)}/ws-${refWs.taskWorkspaceId}.git`);
    expect(JSON.stringify(plan.body)).not.toContain(canonicalNs(o.orgId)); // no canonical coordinates at all
    expect(JSON.stringify(plan.body)).not.toMatch(/art_v\d_/);
  });

  it("a new lease cuts off the previous agent: old token 401, its write tokens revoked, stale generation refused", async () => {
    const h = harness();
    const { o, taskId, task } = await provisionedTask(h);
    const first = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} })).body.leaseToken;
    const cred = await h.api("POST", `/api/tasks/${taskId}/credential`, { token: first, body: { mountName: "website", access: "write" } });
    expect(cred.status).toBe(200);
    const second = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} })).body.leaseToken;
    expect((await h.api("POST", `/api/tasks/${taskId}/credential`, { token: first, body: { mountName: "website", access: "write" } })).status).toBe(401);
    expect(h.artifacts.tokenByPlaintext(cred.body.secret)!.token.state).toBe("revoked");
    expect((await h.api("POST", `/api/tasks/${taskId}/credential`, { token: second, body: { mountName: "website", access: "write" } })).status).toBe(200);
    // a lease token of another task is useless here
    const other = await h.api("POST", `/api/orgs/${o.orgId}/projects/${task.projectId}/tasks`, { token: o.token, body: { title: "other", writeMounts: ["website"] } });
    await h.drainSteps();
    const otherLease = (await h.api("POST", `/api/tasks/${other.body.taskId}/lease`, { token: o.token, body: {} })).body.leaseToken;
    expect((await h.api("POST", `/api/tasks/${taskId}/credential`, { token: otherLease, body: { mountName: "website", access: "write" } })).status).toBe(404);
  });

  it("AT-25: client principals get no task, no lease, no credential and no canonical coordinates", async () => {
    const h = harness();
    const { o, taskId, web, pid } = await provisionedTask(h);
    const client = await member(h, o, "client");
    for (const scope of [{ kind: "project", id: pid }, { kind: "resource", id: web.resourceId }]) {
      await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope, operations: ["read"] } });
    }
    expect((await h.api("GET", `/api/tasks/${taskId}`, { token: client.token })).status).toBe(404);
    expect((await h.api("POST", `/api/tasks/${taskId}/lease`, { token: client.token, body: {} })).status).toBe(404);
    expect((await h.api("POST", `/api/tasks/${taskId}/credential`, { token: client.token, body: { mountName: "website", access: "read" } })).status).toBe(403);
    expect((await h.api("GET", `/api/tasks/${taskId}/materialization?root=/x`, { token: client.token })).status).toBe(404);
    const create = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: client.token, body: { title: "x", writeMounts: ["website"] } });
    expect(create.status).toBe(403);
    // even knowing the canonical remote URL, there is no endpoint that mints for it without a signed job
    const canonical = h.artifacts.repo(canonicalNs(o.orgId), web.resourceId).info;
    const forged = await h.api("POST", "/api/runner/credential", {
      token: client.token,
      body: { signedJob: { job: {}, jobId: "x", kid: "k1", sig: "0".repeat(64) }, repo: { kind: "artifacts", namespace: canonicalNs(o.orgId), repoName: canonical.name, repoId: canonical.id, remoteUrl: canonical.remote }, access: "read" },
    });
    expect(forged.status).toBe(403);
    const tokensForCanonical = h.artifacts.repo(canonicalNs(o.orgId), web.resourceId).tokens.filter((t) => t.state === "active");
    expect(tokensForCanonical).toHaveLength(0);
  });

  it("a developer without a write grant cannot create or lease a task on that mount", async () => {
    const h = harness();
    const { o, taskId, web, api, pid } = await provisionedTask(h);
    const dev = await member(h, o, "developer");
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: dev.userId, scope: { kind: "resource", id: api.resourceId }, operations: ["read"] } });
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: dev.userId, scope: { kind: "project", id: pid }, operations: ["read"] } });
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: dev.userId, scope: { kind: "resource", id: web.resourceId }, operations: ["read"] } });
    const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: dev.token, body: { title: "x", writeMounts: ["website"] } });
    expect(t.status).toBe(403);
    const l = await h.api("POST", `/api/tasks/${taskId}/lease`, { token: dev.token, body: {} });
    expect(l.status).toBe(403);
    expect(l.body.error.code).toBe("no_write_grant");
  });
});
