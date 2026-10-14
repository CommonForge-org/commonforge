import { describe, expect, it } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { codeResource, member, projectWith } from "../helpers.js";
import { stagingFixture } from "../staging-helpers.js";

const writeMounts = (t: { workspaces: Array<{ mountName: string; access: string }> }) => t.workspaces.filter((w) => w.access === "write").map((w) => w.mountName).sort();

describe("a folder's writable setting per project (PATCH …/mounts/:mount)", () => {
  it("owner only; read-only stops new tasks changing it for everyone; writable again lets them", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const P = `/api/orgs/${f.o.orgId}/projects/${f.pid}`;
    const dev = await f.memberWithAccess("developer", "write");
    const client = await f.clientWithAccess();
    for (const who of [dev, client]) expect((await f.h.api("PATCH", `${P}/mounts/api`, { token: who.token, body: { writable: false } })).status).toBe(403);
    expect((await f.h.api("PATCH", `${P}/mounts/nope`, { token: f.o.token, body: { writable: false } })).status).toBe(404);
    expect((await f.h.api("PATCH", `${P}/mounts/api`, { token: f.o.token, body: { writable: "no" } })).status).toBe(400);

    const ro = await f.h.api("PATCH", `${P}/mounts/api`, { token: f.o.token, body: { writable: false } });
    expect([ro.status, ro.body.operations]).toEqual([200, ["read"]]);
    expect((await f.h.api("GET", `${P}/folders`, { token: f.o.token })).body.folders.find((x: { mountName: string }) => x.mountName === "api").writable).toBe(false);
    for (const who of [f.o, dev, client]) {
      const view = await f.h.api("GET", P, { token: who.token });
      expect(view.body.mounts.find((m: { mountName: string }) => m.mountName === "api").canStartTask).toBe(false);
      const named = await f.h.api("POST", `${P}/tasks`, { token: who.token, body: { title: "x", writeMounts: ["api"] } });
      expect([named.status, named.body.error.code]).toEqual([403, "mount_read_only"]);
    }
    const events = await f.h.api("GET", `/api/orgs/${f.o.orgId}/events?projectId=${f.pid}`, { token: f.o.token });
    expect(JSON.stringify(events.body)).toContain("mount.changed");

    expect((await f.h.api("PATCH", `${P}/mounts/api`, { token: f.o.token, body: { writable: true } })).body.operations).toEqual(["read", "write"]);
    const again = await f.h.api("POST", `${P}/tasks`, { token: dev.token, body: { title: "y" } });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    // the client's Can change on it was taken when it went read-only: the owner gives it again
    const refused = await f.h.api("POST", `${P}/tasks`, { token: client.token, body: { title: "z" } });
    expect([refused.status, refused.body.error.code]).toEqual([403, "no_write_grant"]);
    expect((await f.h.api("PUT", `${P}/access`, { token: f.o.token, body: { userId: client.userId, level: "write" } })).status).toBe(200);
    expect((await f.h.api("POST", `${P}/tasks`, { token: client.token, body: { title: "z" } })).status).toBe(201);
  });

  it("read-only ends a client's Can change and their leases, unless another project still lets them change it", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const P = `/api/orgs/${f.o.orgId}/projects/${f.pid}`;
    const client = await f.clientWithAccess();
    const t = await f.h.api("POST", `${P}/tasks`, { token: client.token, body: { title: "Footer" } });
    expect(t.status).toBe(201);
    await f.h.drainSteps();
    const lease = await f.h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: client.token, body: {} });
    expect(lease.status).toBe(200);
    const ro = await f.h.api("PATCH", `${P}/mounts/api`, { token: f.o.token, body: { writable: false } });
    expect(ro.body.changed).toEqual([client.userId]);
    const ops = async () => (await f.h.api("GET", `/api/orgs/${f.o.orgId}/grants?userId=${client.userId}`, { token: f.o.token })).body.grants.find((g: any) => g.scope.id === f.api.resourceId).operations;
    expect(await ops()).toEqual(["read"]);
    expect((await f.h.api("POST", `/api/tasks/${t.body.taskId}/credential`, { token: lease.body.leaseToken, body: { mountName: "api", access: "write" } })).status).toBe(401);

    // another project that lets them change it keeps their Can change
    const other = await projectWith(f.h, f.o, [{ mountName: "api", resourceId: f.api.resourceId }]);
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${other}/access`, { token: f.o.token, body: { userId: client.userId, level: "write" } })).status).toBe(200);
    expect(await ops()).toEqual(["read", "write"]);
    expect((await f.h.api("PATCH", `${P}/mounts/api`, { token: f.o.token, body: { writable: true } })).status).toBe(200);
    expect((await f.h.api("PATCH", `${P}/mounts/api`, { token: f.o.token, body: { writable: false } })).body.changed).toEqual([]);
    expect(await ops()).toEqual(["read", "write"]);
    // a repeated read-only PATCH still narrows (a retry after a narrowing that failed part-way)
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${other}/access`, { token: f.o.token, body: { userId: client.userId, level: "read" } })).status).toBe(200);
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare("UPDATE grants SET operations_json = '[\"read\",\"write\"]' WHERE org_id = ? AND user_id = ? AND scope_kind = 'resource' AND scope_id = ?").bind(f.o.orgId, client.userId, f.api.resourceId).run();
    expect((await f.h.api("PATCH", `${P}/mounts/api`, { token: f.o.token, body: { writable: false } })).body.changed).toEqual([client.userId]);
    expect(await ops()).toEqual(["read"]);
  });

  it("a developer's task already checked out keeps its write when the folder goes read-only (their write comes from their grant)", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const P = `/api/orgs/${f.o.orgId}/projects/${f.pid}`;
    const dev = await f.memberWithAccess("developer", "write");
    const t = await f.h.api("POST", `${P}/tasks`, { token: dev.token, body: { title: "Footer" } });
    await f.h.drainSteps();
    const lease = await f.h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: dev.token, body: {} });
    expect((await f.h.api("PATCH", `${P}/mounts/api`, { token: f.o.token, body: { writable: false } })).status).toBe(200);
    expect((await f.h.api("POST", `/api/tasks/${t.body.taskId}/credential`, { token: lease.body.leaseToken, body: { mountName: "api", access: "write" } })).status).toBe(200);
  });

  it("Can change in one project never reaches a folder that project keeps read-only (resource grants are org-wide)", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const docs = await codeResource(f.h, f.o, "docs", { "README.md": "docs\n" });
    // project A (the fixture) attaches docs read-only; project B attaches it writable
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: { mountName: "docs", resourceId: docs.resourceId, operations: ["read"] } })).status).toBe(201);
    const b = await projectWith(f.h, f.o, [{ mountName: "docs", resourceId: docs.resourceId }]);
    const client = await member(f.h, f.o, "client");
    const access = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: client.userId, level: "write" } });
    expect(access.body.folders.find((x: { mountName: string }) => x.mountName === "docs")).toMatchObject({ level: "read", readOnly: true });
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${b}/access`, { token: f.o.token, body: { userId: client.userId, level: "read" } })).status).toBe(200);
    const ops = (await f.h.api("GET", `/api/orgs/${f.o.orgId}/grants?userId=${client.userId}`, { token: f.o.token })).body.grants.find((g: any) => g.scope.id === docs.resourceId).operations;
    expect(ops).toEqual(["read"]);
    // a folder attached read-only later does not get the client's Can change either
    const more = await codeResource(f.h, f.o, "more", { "a.txt": "a\n" });
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: { mountName: "more", resourceId: more.resourceId, operations: ["read"] } })).status).toBe(201);
    const ops2 = (await f.h.api("GET", `/api/orgs/${f.o.orgId}/grants?userId=${client.userId}`, { token: f.o.token })).body.grants.find((g: any) => g.scope.id === more.resourceId).operations;
    expect(ops2).toEqual(["read"]);
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "x" } });
    expect(writeMounts(t.body)).toEqual(["api"]);
  });
});
