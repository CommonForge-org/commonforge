import { describe, expect, it } from "vitest";
import { agentPush, codeResource, harness, member, ownerWithOrg, projectWith, provisionedTask } from "../helpers.js";

async function setup() {
  const h = harness();
  const o = await ownerWithOrg(h);
  const web = await codeResource(h, o, "website", { "index.html": "hi" });
  const api = await codeResource(h, o, "api", { "src/index.ts": "api" });
  const pid = await projectWith(h, o, [
    { mountName: "website", resourceId: web.resourceId },
    { mountName: "api", resourceId: api.resourceId },
  ]);
  const P = `/api/orgs/${o.orgId}/projects/${pid}`;
  return { h, o, web, api, pid, P };
}

describe("project access", () => {
  it("one PUT gives a client the project and every folder; GET reports it", async () => {
    const { h, o, P } = await setup();
    const client = await member(h, o, "client");
    expect((await h.api("GET", P, { token: client.token })).status).toBe(404);
    const put = await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ userId: client.userId, role: "client", level: "read" });
    expect(put.body.folders.map((f: any) => [f.mountName, f.level])).toEqual([["api", "read"], ["website", "read"]]);
    expect((await h.api("GET", `${P}/tree?mount=api`, { token: client.token })).status).toBe(200);
    expect((await h.api("GET", `${P}/tree?mount=website`, { token: client.token })).status).toBe(200);
    const all = await h.api("GET", `${P}/access`, { token: o.token });
    const byEmail = Object.fromEntries(all.body.people.map((p: any) => [p.role, p.level]));
    expect(byEmail).toMatchObject({ owner: "write", client: "read" });
  });

  it("a folder exception hides one folder; none removes everything", async () => {
    const { h, o, P, api } = await setup();
    const client = await member(h, o, "client");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read", folders: { [api.resourceId]: "none" } } });
    expect((await h.api("GET", `${P}/tree?mount=api`, { token: client.token })).status).toBe(404);
    expect((await h.api("GET", `${P}/tree?mount=website`, { token: client.token })).status).toBe(200);
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "none" } });
    expect((await h.api("GET", P, { token: client.token })).status).toBe(404);
    const me = await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${client.userId}`, { token: o.token });
    expect(me.body.grants).toEqual([]);
  });

  it("refuses what the access rules forbid", async () => {
    const { h, o, P, api } = await setup();
    const client = await member(h, o, "client");
    const viewer = await member(h, o, "viewer");
    const cases: Array<[unknown, number, string]> = [
      // a client may hold write ("Can change", through tasks only); a viewer may not
      [{ userId: viewer.userId, level: "write" }, 400, "grant_exceeds_role"],
      [{ userId: client.userId, level: "read", folders: { [api.resourceId]: "write" } }, 400, "folder_exceeds_project"],
      [{ userId: client.userId, level: "read", folders: { "res-not-here": "none" } }, 400, "unknown_folder"],
      [{ userId: o.userId, level: "read" }, 400, "owner_access_implicit"],
    ];
    for (const [body, status, code] of cases) {
      const r = await h.api("PUT", `${P}/access`, { token: o.token, body });
      expect([r.status, r.body.error.code]).toEqual([status, code]);
    }
    expect((await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: "u-nobody", level: "read" } })).status).toBe(404);
    expect((await h.api("GET", `${P}/access`, { token: client.token })).status).toBe(403);
  });

  it("developers may only raise someone from none to read", async () => {
    const { h, o, P, api } = await setup();
    const dev = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } });
    const client = await member(h, o, "client");
    const viewer = await member(h, o, "viewer");
    expect((await h.api("PUT", `${P}/access`, { token: dev.token, body: { userId: client.userId, level: "read" } })).status).toBe(200);
    const refused: unknown[] = [
      { userId: client.userId, level: "none" },
      { userId: viewer.userId, level: "read", folders: { [api.resourceId]: "none" } },
    ];
    for (const body of refused) {
      const r = await h.api("PUT", `${P}/access`, { token: dev.token, body });
      expect([r.status, r.body.error.code]).toEqual([403, "grant_owner_only"]);
    }
    const other = await member(h, o, "developer");
    const w = await h.api("PUT", `${P}/access`, { token: dev.token, body: { userId: other.userId, level: "write" } });
    expect([w.status, w.body.error.code]).toEqual([403, "grant_owner_only"]);
  });

  it("a folder shared with another project stays readable through that project", async () => {
    const { h, o, P, web } = await setup();
    const pid2 = await projectWith(h, o, [{ mountName: "site", resourceId: web.resourceId }]);
    const P2 = `/api/orgs/${o.orgId}/projects/${pid2}`;
    const client = await member(h, o, "client");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    await h.api("PUT", `${P2}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "none" } });
    expect((await h.api("GET", P, { token: client.token })).status).toBe(404);
    expect((await h.api("GET", `${P2}/tree?mount=site`, { token: client.token })).status).toBe(200);
  });

  it("narrowing a developer from write to read ends their lease (same path as the grants API)", async () => {
    const h = harness();
    const { o, taskId, pid } = await provisionedTask(h);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const dev = await member(h, o, "developer");
    expect((await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } })).status).toBe(200);
    const { agent, cred } = await agentPush(h, dev.token, taskId, { "index.html": "v2" });
    expect((await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } })).status).toBe(200);
    expect((await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).status).toBe(401);
    expect(h.artifacts.tokenByPlaintext(cred.secret)!.token.state).toBe("revoked");
  });

  it("a shared folder is never narrowed through another project: write held through one project survives a PUT on the other, and so does the lease", async () => {
    const h = harness();
    const { o, taskId, pid, web } = await provisionedTask(h);
    const P1 = `/api/orgs/${o.orgId}/projects/${pid}`;
    const docs = await codeResource(h, o, "docs", { "README.md": "docs" });
    const p2 = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Billing" } });
    const P2 = `/api/orgs/${o.orgId}/projects/${p2.body.projectId}`;
    for (const m of [{ mountName: "site", resourceId: web.resourceId }, { mountName: "docs", resourceId: docs.resourceId }]) expect((await h.api("POST", `${P2}/mounts`, { token: o.token, body: m })).status).toBe(201);
    const dev = await member(h, o, "developer");
    expect((await h.api("PUT", `${P1}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } })).status).toBe(200);
    const { agent, cred } = await agentPush(h, dev.token, taskId, { "index.html": "v2" });
    // read on P2 with an exception on another folder of P2: the shared website keeps write (nothing is
    // removed or narrowed, so the lease survives; removing the docs grant later would end it, as any removal)
    const put = await h.api("PUT", `${P2}/access`, { token: o.token, body: { userId: dev.userId, level: "read", folders: { [docs.resourceId]: "none" } } });
    expect(put.status).toBe(200);
    const grants = (await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${dev.userId}`, { token: o.token })).body.grants;
    expect(grants.find((g: any) => g.scope.id === web.resourceId).operations).toEqual(["read", "write"]);
    expect(grants.some((g: any) => g.scope.id === docs.resourceId)).toBe(false);
    expect((await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).status).toBe(200);
    expect(h.artifacts.tokenByPlaintext(cred.secret)!.token.state).toBe("active");
    // GET shows the shared folder above the project level, held through the other project
    const me = (await h.api("GET", `${P2}/access`, { token: o.token })).body.people.find((p: any) => p.userId === dev.userId);
    expect(me.level).toBe("read");
    expect(me.folders.find((f: any) => f.mountName === "site")).toMatchObject({ level: "write", shared: true, via: "Customer Portal" });
    expect(me.folders.find((f: any) => f.mountName === "docs")).toMatchObject({ level: "none" });
    expect(me.folders.find((f: any) => f.mountName === "docs").shared).toBeUndefined();
    // widening through this project still works
    expect((await h.api("PUT", `${P2}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } })).status).toBe(200);
    const after = (await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${dev.userId}`, { token: o.token })).body.grants;
    expect(after.find((g: any) => g.scope.id === docs.resourceId).operations).toEqual(["read", "write"]);
  });

  /** P1 = the provisioned task's project ("Customer Portal": website + api); P2 = "Billing" attaching the same website as `site`. */
  async function twoProjects() {
    const h = harness();
    const t = await provisionedTask(h);
    const { o } = t;
    const p2 = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Billing" } });
    const P2 = `/api/orgs/${o.orgId}/projects/${p2.body.projectId}`;
    expect((await h.api("POST", `${P2}/mounts`, { token: o.token, body: { mountName: "site", resourceId: t.web.resourceId } })).status).toBe(201);
    const dev = await member(h, o, "developer");
    const put = async (P: string, body: unknown, token = o.token) => h.api("PUT", `${P}/access`, { token, body });
    const folderOps = async (userId: string) => (await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${userId}`, { token: o.token })).body.grants.find((g: any) => g.scope.id === t.web.resourceId)?.operations;
    const site = async (P: string, userId: string) => (await h.api("GET", `${P}/access`, { token: o.token })).body.people.find((p: any) => p.userId === userId).folders.find((f: any) => f.resourceId === t.web.resourceId);
    return { ...t, h, P1: `/api/orgs/${o.orgId}/projects/${t.pid}`, P2, dev, put, folderOps, site };
  }

  it("the floor is what the other projects give: lowering on P2 narrows a shared folder down to it, and the lease ends", async () => {
    const { h, P1, P2, dev, put, folderOps, site, taskId } = await twoProjects();
    expect((await put(P1, { userId: dev.userId, level: "read" })).status).toBe(200);
    expect((await put(P2, { userId: dev.userId, level: "write" })).status).toBe(200);
    expect(await folderOps(dev.userId)).toEqual(["read", "write"]);
    const { agent, cred } = await agentPush(h, dev.token, taskId, { "index.html": "v2" });
    // P1 gives read only, so P2 may take the shared folder down to read
    expect((await put(P2, { userId: dev.userId, level: "read" })).status).toBe(200);
    expect(await folderOps(dev.userId)).toEqual(["read"]);
    expect((await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).status).toBe(401);
    expect(h.artifacts.tokenByPlaintext(cred.secret)!.token.state).toBe("revoked");
    const f = await site(P2, dev.userId);
    expect(f).toMatchObject({ level: "read", min: "read" });
    expect(f.shared).toBeUndefined();
    expect(f.via).toBeUndefined();
    // and never below the floor: "none" on P2 keeps read (P1 still gives it)
    expect((await put(P2, { userId: dev.userId, level: "read", folders: { [f.resourceId]: "none" } })).status).toBe(200);
    expect(await folderOps(dev.userId)).toEqual(["read"]);
  });

  it("lowering on P2 keeps a shared folder at the write P1 gives, marked as held through P1", async () => {
    const { P1, P2, dev, put, folderOps, site } = await twoProjects();
    expect((await put(P1, { userId: dev.userId, level: "write" })).status).toBe(200);
    expect((await put(P2, { userId: dev.userId, level: "write" })).status).toBe(200);
    expect((await put(P2, { userId: dev.userId, level: "read" })).status).toBe(200);
    expect(await folderOps(dev.userId)).toEqual(["read", "write"]);
    expect(await site(P2, dev.userId)).toMatchObject({ level: "write", min: "write", shared: true, via: "Customer Portal" });
  });

  it("the floor never raises a folder: one hidden on both projects stays hidden", async () => {
    const { h, o, P1, P2, put, folderOps, web } = await twoProjects();
    const client = await member(h, o, "client");
    expect((await put(P1, { userId: client.userId, level: "read", folders: { [web.resourceId]: "none" } })).status).toBe(200);
    expect((await put(P2, { userId: client.userId, level: "read", folders: { [web.resourceId]: "none" } })).status).toBe(200);
    expect(await folderOps(client.userId)).toBeUndefined();
    expect((await put(P1, { userId: client.userId, level: "read", folders: { [web.resourceId]: "none" } })).status).toBe(200);
    expect(await folderOps(client.userId)).toBeUndefined();
    expect((await h.api("GET", `${P2}/tree?mount=site`, { token: client.token })).status).toBe(404);
  });

  it("the floor never lets a developer's PUT give write, even when another project gives it", async () => {
    const { h, o, P1, P2, put, folderOps, web } = await twoProjects();
    const actor = await member(h, o, "developer");
    expect((await put(P2, { userId: actor.userId, level: "read" })).status).toBe(200);
    const other = await member(h, o, "developer");
    expect((await put(P1, { userId: other.userId, level: "write" })).status).toBe(200);
    // the owner narrowed the shared folder directly; P1 still says write
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: other.userId, scope: { kind: "resource", id: web.resourceId }, operations: ["read"] } })).status).toBeLessThan(300);
    expect((await put(P2, { userId: other.userId, level: "read" }, actor.token)).status).toBe(200);
    expect(await folderOps(other.userId)).toEqual(["read"]);
  });

  it("a developer sees only the folders they can read, for every person (GET and PUT)", async () => {
    const { h, o, P, api } = await setup();
    const dev = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "read", folders: { [api.resourceId]: "none" } } });
    const all = await h.api("GET", `${P}/access`, { token: dev.token });
    expect(all.status).toBe(200);
    for (const p of all.body.people) expect(p.folders.map((f: any) => f.mountName), p.email).toEqual(["website"]);
    expect(JSON.stringify(all.body)).not.toContain(api.resourceId);
    // owners still see every folder
    const full = await h.api("GET", `${P}/access`, { token: o.token });
    for (const p of full.body.people) expect(p.folders.map((f: any) => f.mountName)).toEqual(["api", "website"]);
    const client = await member(h, o, "client");
    const put = await h.api("PUT", `${P}/access`, { token: dev.token, body: { userId: client.userId, level: "read" } });
    expect(put.status).toBe(200);
    expect(put.body.folders.map((f: any) => f.mountName)).toEqual(["website"]);
  });

  it("a developer's PUT skips the folders the developer cannot read: the person gets the project and the readable folders only", async () => {
    const { h, o, P, api, web } = await setup();
    const dev = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "read", folders: { [api.resourceId]: "none" } } });
    const client = await member(h, o, "client");
    expect((await h.api("PUT", `${P}/access`, { token: dev.token, body: { userId: client.userId, level: "read" } })).status).toBe(200);
    const grants = (await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${client.userId}`, { token: o.token })).body.grants;
    expect(grants.map((g: any) => [g.scope.kind, g.scope.id, g.operations]).sort()).toEqual([
      ["project", P.split("/").pop(), ["read"]],
      ["resource", web.resourceId, ["read"]],
    ]);
    expect((await h.api("GET", `${P}/tree?mount=api`, { token: client.token })).status).toBe(404);
  });

  it("a folder-only write grant counts as holding write: a developer's PUT for that person is refused", async () => {
    const { h, o, P, web } = await setup();
    const dev = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } });
    const other = await member(h, o, "developer");
    const g = await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: other.userId, scope: { kind: "resource", id: web.resourceId }, operations: ["read", "write"] } });
    expect(g.status).toBeLessThan(300);
    const r = await h.api("PUT", `${P}/access`, { token: dev.token, body: { userId: other.userId, level: "read" } });
    expect([r.status, r.body.error.code]).toEqual([403, "grant_owner_only"]);
    const grants = (await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${other.userId}`, { token: o.token })).body.grants;
    expect(grants.map((x: any) => [x.scope.id, x.operations])).toEqual([[web.resourceId, ["read", "write"]]]);
  });
});
