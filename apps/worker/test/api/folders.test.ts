import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { agentPush, codeResource, harness, member, ownerWithOrg, projectWith, provisionedTask, type Harness } from "../helpers.js";
import { stagingFixture } from "../staging-helpers.js";

const initState = async (orgId: string, rid: string) => (await env.DB.prepare("SELECT state FROM folder_inits WHERE org_id = ? AND resource_id = ?").bind(orgId, rid).first<{ state: string }>())?.state;
/** Drain the steps and let the fake runner answer, until nothing moves. */
async function setUp(h: Harness, runner: FakeRunner) {
  for (let i = 0; i < 10; i++) {
    await h.drainSteps();
    await runner.idle();
    if (h.steps.length === 0) break;
  }
}

describe("project folders", () => {
  it("lists folders with kind, state and the other projects they are in", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const pidA = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const pidB = await projectWith(h, o, [{ mountName: "site", resourceId: web.resourceId }]);
    const r = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pidA}/folders`, { token: o.token });
    expect(r.status).toBe(200);
    expect(r.body.folders).toEqual([
      { mountName: "website", resourceId: web.resourceId, resourceName: "website", provider: "artifacts", state: "active", writable: true, settingUp: false, setupFailed: false, alsoIn: [{ projectId: pidB, name: "Customer Portal" }] },
    ]);
  });

  it("non-owners see only folders they can read, and only projects they can read in alsoIn", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const api = await codeResource(h, o, "api", { "a.ts": "1" });
    const pid = await projectWith(h, o, [
      { mountName: "website", resourceId: web.resourceId },
      { mountName: "api", resourceId: api.resourceId },
    ]);
    await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const dev = await member(h, o, "developer");
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "read", folders: { [api.resourceId]: "none" } } });
    const r = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/folders`, { token: dev.token });
    expect(r.body.folders.map((f: any) => [f.mountName, f.alsoIn])).toEqual([["website", []]]);
    const client = await member(h, o, "client");
    expect((await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/folders`, { token: client.token })).status).toBe(403);
  });

  it("a new folder is a git folder: created empty, attached, given to the project's people, then set up by the runner", async () => {
    const h = harness();
    const runner = new FakeRunner(h);
    const o = await ownerWithOrg(h);
    const pid = await projectWith(h, o, []);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const client = await member(h, o, "client");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    const r = await h.api("POST", `${P}/folders`, { token: o.token, body: { name: "brand-assets" } });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ mountName: "brand-assets", resourceId: expect.any(String) });
    const rid = r.body.resourceId as string;
    const res = await h.api("GET", `/api/orgs/${o.orgId}/resources/${rid}`, { token: o.token });
    expect(res.body).toMatchObject({ provider: "artifacts", state: "empty", head: null });
    const mount = (await h.api("GET", P, { token: o.token })).body.mounts.find((m: any) => m.mountName === "brand-assets");
    expect(mount).toMatchObject({ resourceId: rid, mode: "must-match-accepted", operations: ["read", "write"] });
    expect(await initState(o.orgId, rid)).toBe("pending");
    expect(h.steps).toContainEqual({ type: "folders.init", orgId: o.orgId, resourceId: rid });
    // setting up until its first version is bound
    expect((await h.api("GET", `${P}/folders`, { token: o.token })).body.folders).toMatchObject([{ mountName: "brand-assets", provider: "artifacts", state: "empty", settingUp: true }]);
    await setUp(h, runner);
    const list = await h.api("GET", `${P}/folders`, { token: o.token });
    expect(list.body.folders).toMatchObject([{ mountName: "brand-assets", provider: "artifacts", state: "active", settingUp: false }]);
    const tree = await h.api("GET", `${P}/tree?mount=brand-assets`, { token: client.token });
    expect(tree.status).toBe(200);
    expect(tree.body.entries.map((e: any) => e.path).sort()).toEqual([".gitattributes", ".lfsconfig", "README.md"]);
  });

  it("kind is optional and ignored: files and code give the same git folder; another kind is 400", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const pid = await projectWith(h, o, []);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    for (const [name, kind] of [["media", "files"], ["code", "code"]] as const) {
      const r = await h.api("POST", `${P}/folders`, { token: o.token, body: { name, kind } });
      expect(r.status).toBe(201);
      expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${r.body.resourceId}`, { token: o.token })).body).toMatchObject({ provider: "artifacts", state: "empty" });
      expect(await initState(o.orgId, r.body.resourceId)).toBe("pending");
    }
    const bad = await h.api("POST", `${P}/folders`, { token: o.token, body: { name: "other", kind: "other" } });
    expect([bad.status, bad.body.error.code]).toEqual([400, "invalid_request"]);
  });

  it("developers who can read the project may add a folder; a taken name creates nothing", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const pid = await projectWith(h, o, []);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const dev = await member(h, o, "developer");
    const outsider = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } });
    expect((await h.api("POST", `${P}/folders`, { token: outsider.token, body: { name: "x" } })).status).toBe(404);
    const ok = await h.api("POST", `${P}/folders`, { token: dev.token, body: { name: "media" } });
    expect(ok.status).toBe(201);
    // the creator holds read + write on what they create
    const g = await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${dev.userId}`, { token: o.token });
    expect(g.body.grants.find((x: any) => x.scope.id === ok.body.resourceId).operations).toEqual(["read", "write"]);
    const before = (await h.api("GET", `/api/orgs/${o.orgId}/resources`, { token: o.token })).body.resources.length;
    const inits = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM folder_inits WHERE org_id = ?").bind(o.orgId).first<{ n: number }>())!.n;
    expect(await inits()).toBe(1);
    const dup = await h.api("POST", `${P}/folders`, { token: o.token, body: { name: "media" } });
    expect([dup.status, dup.body.error.code]).toEqual([409, "mount_exists"]);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources`, { token: o.token })).body.resources.length).toBe(before);
    expect(await inits()).toBe(1);
  });

  it("an invalid name is 400, clients and viewers are 403, and a new folder bumps membershipRevision and records mount.added", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const pid = await projectWith(h, o, []);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const client = await member(h, o, "client");
    const viewer = await member(h, o, "viewer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    expect((await h.api("POST", `${P}/folders`, { token: o.token, body: { name: "../bad" } })).status).toBe(400);
    expect((await h.api("POST", `${P}/folders`, { token: o.token, body: { name: "" } })).status).toBe(400);
    expect((await h.api("POST", `${P}/folders`, { token: client.token, body: { name: "brand" } })).status).toBe(403);
    expect((await h.api("POST", `${P}/folders`, { token: viewer.token, body: { name: "brand" } })).status).toBe(403);
    const rev = (await h.api("GET", P, { token: o.token })).body.membershipRevision as number;
    const r = await h.api("POST", `${P}/folders`, { token: o.token, body: { name: "brand" } });
    expect(r.status).toBe(201);
    expect((await h.api("GET", P, { token: o.token })).body.membershipRevision).toBe(rev + 1);
    const ev = await h.api("GET", `/api/orgs/${o.orgId}/events?projectId=${pid}`, { token: o.token });
    expect(ev.body.events.filter((e: any) => e.action === "mount.added").map((e: any) => e.detail)).toEqual([{ mountName: "brand", resourceId: r.body.resourceId }]);
  });

  it("in a staging-mode project the new folder's first version is live at once, without a staging landing", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const P = `/api/orgs/${f.o.orgId}/projects/${f.pid}`;
    const r = await f.h.api("POST", `${P}/folders`, { token: f.o.token, body: { name: "media" } });
    expect(r.status).toBe(201);
    await setUp(f.h, runner);
    expect((await f.h.api("GET", `${P}/folders`, { token: f.o.token })).body.folders.find((x: any) => x.mountName === "media")).toMatchObject({ state: "active", settingUp: false });
    const res = await f.h.api("GET", `/api/orgs/${f.o.orgId}/resources/${r.body.resourceId}`, { token: f.o.token });
    expect(res.body.head?.revisionId).toBeTruthy();
    const landings = await env.DB.prepare("SELECT COUNT(*) AS n FROM staging_landings WHERE org_id = ? AND project_id = ?").bind(f.o.orgId, f.pid).first<{ n: number }>();
    expect(landings!.n).toBe(0);
  });

  it("alsoIn lists another project for a developer who can read both", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const pidA = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const pidB = await projectWith(h, o, [{ mountName: "site", resourceId: web.resourceId }]);
    const dev = await member(h, o, "developer");
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pidA}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } });
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pidB}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } });
    const r = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pidA}/folders`, { token: dev.token });
    expect(r.body.folders.map((f: any) => [f.mountName, f.alsoIn])).toEqual([["website", [{ projectId: pidB, name: "Customer Portal" }]]]);
  });

  it("attaching a folder the project already has is 409 folder_already_attached and changes nothing", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const rev = (await h.api("GET", P, { token: o.token })).body.membershipRevision as number;
    const dup = await h.api("POST", `${P}/mounts`, { token: o.token, body: { mountName: "site", resourceId: web.resourceId } });
    expect([dup.status, dup.body.error.code]).toEqual([409, "folder_already_attached"]);
    const p = (await h.api("GET", P, { token: o.token })).body;
    expect(p.mounts.map((m: any) => m.mountName)).toEqual(["website"]);
    expect(p.membershipRevision).toBe(rev);
    // a taken name is still mount_exists
    const other = await codeResource(h, o, "other", { "a.txt": "a" });
    const taken = await h.api("POST", `${P}/mounts`, { token: o.token, body: { mountName: "website", resourceId: other.resourceId } });
    expect([taken.status, taken.body.error.code]).toEqual([409, "mount_exists"]);
  });
});

describe("trying a failed folder setup again", () => {
  it("owners and developers with write may; 404 for an unknown folder, 409 unless the setup failed; 202 restarts it", async () => {
    const h = harness();
    const runner = new FakeRunner(h, { fail: { "init-folder": { code: "branch_not_empty", detail: "test" } } });
    const o = await ownerWithOrg(h);
    const pid = await projectWith(h, o, []);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const r = await h.api("POST", `${P}/folders`, { token: o.token, body: { name: "media" } });
    const rid = r.body.resourceId as string;
    // still pending: nothing to try again
    const early = await h.api("POST", `${P}/folders/media/setup/retry`, { token: o.token });
    expect([early.status, early.body.error.code]).toEqual([409, "setup_not_failed"]);
    await setUp(h, runner);
    const failed = (await h.api("GET", `${P}/folders`, { token: o.token })).body.folders[0];
    expect(failed).toMatchObject({ state: "failed", settingUp: false, setupFailed: true });
    expect(failed.error).toMatch(/^Setting up this folder failed: /);
    expect((await h.api("POST", `${P}/folders/nope/setup/retry`, { token: o.token })).status).toBe(404);
    const reader = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: reader.userId, level: "read" } });
    expect((await h.api("POST", `${P}/folders/media/setup/retry`, { token: reader.token })).status).toBe(403);
    const client = await member(h, o, "client");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    expect((await h.api("POST", `${P}/folders/media/setup/retry`, { token: client.token })).status).toBe(403);
    const writer = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: writer.userId, level: "write" } });
    runner.opts.fail = undefined;
    const again = await h.api("POST", `${P}/folders/media/setup/retry`, { token: writer.token });
    expect([again.status, again.body]).toEqual([202, { state: "empty", settingUp: true }]);
    expect((await h.api("GET", `${P}/folders`, { token: o.token })).body.folders[0]).toMatchObject({ state: "empty", settingUp: true, setupFailed: false });
    await setUp(h, runner);
    expect((await h.api("GET", `${P}/folders`, { token: o.token })).body.folders[0]).toMatchObject({ state: "active", settingUp: false, setupFailed: false });
    expect(await initState(o.orgId, rid)).toBe("done");
    // a folder without a setup (attached, not added here) has nothing to try again
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    await h.api("POST", `${P}/mounts`, { token: o.token, body: { mountName: "website", resourceId: web.resourceId } });
    const none = await h.api("POST", `${P}/folders/website/setup/retry`, { token: o.token });
    expect([none.status, none.body.error.code]).toEqual([409, "setup_not_failed"]);
    expect((await h.api("GET", `${P}/folders`, { token: o.token })).body.folders.find((f: any) => f.mountName === "website")).toMatchObject({ settingUp: false, setupFailed: false });
    // a folder that failed some other way (an import) has no setup to try again either
    await env.DB.prepare("UPDATE resources SET state = 'failed', error = 'import failed (test)' WHERE resource_id = ?").bind(web.resourceId).run();
    expect((await h.api("GET", `${P}/folders`, { token: o.token })).body.folders.find((f: any) => f.mountName === "website")).toMatchObject({ state: "failed", settingUp: false, setupFailed: false });
  });
});

describe("detaching a folder", () => {
  it("removes the folder from the project's people, keeps the folder, and records mount.removed", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const client = await member(h, o, "client");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    const d = await h.api("DELETE", `${P}/mounts/website`, { token: o.token });
    expect(d.status).toBe(200);
    expect(d.body.changed).toEqual([client.userId]);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}`, { token: client.token })).status).toBe(404);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}`, { token: o.token })).status).toBe(200);
    const ev = await h.api("GET", `/api/orgs/${o.orgId}/events?projectId=${pid}`, { token: o.token });
    expect(ev.body.events.some((e: any) => e.action === "mount.removed")).toBe(true);
  });

  it("a person keeps what their other projects give; people outside the project are untouched", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const shared = await codeResource(h, o, "shared", { "a.txt": "a" });
    const pidA = await projectWith(h, o, [{ mountName: "shared", resourceId: shared.resourceId }]);
    const pidB = await projectWith(h, o, [{ mountName: "shared", resourceId: shared.resourceId }]);
    const dev = await member(h, o, "developer");
    const direct = await member(h, o, "viewer");
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pidA}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } });
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pidB}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } });
    // a direct folder grant for someone without project A
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: direct.userId, scope: { kind: "resource", id: shared.resourceId }, operations: ["read"] } });
    await h.api("DELETE", `/api/orgs/${o.orgId}/projects/${pidA}/mounts/shared`, { token: o.token });
    const g = await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${dev.userId}`, { token: o.token });
    expect(g.body.grants.find((x: any) => x.scope.id === shared.resourceId).operations).toEqual(["read"]);
    const gv = await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${direct.userId}`, { token: o.token });
    expect(gv.body.grants.find((x: any) => x.scope.id === shared.resourceId).operations).toEqual(["read"]);
  });

  it("losing write through a detach ends the person's lease", async () => {
    const h = harness();
    const { o, taskId, pid } = await provisionedTask(h);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const dev = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } });
    const { agent } = await agentPush(h, dev.token, taskId, { "index.html": "v2" });
    await h.api("DELETE", `${P}/mounts/website`, { token: o.token });
    expect((await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).status).toBe(401);
  });

  it("detaching one of two mounts of the same folder in one project leaves members' access intact", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const dev = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } });
    // a second mount of the same folder (data from before folder_already_attached; the API now refuses it)
    await env.DB.prepare("INSERT INTO mounts (org_id, project_id, mount_name, resource_id, mode, operations_json, created_at) VALUES (?, ?, 'site', ?, 'must-match-accepted', '[\"read\",\"write\"]', ?)")
      .bind(o.orgId, pid, web.resourceId, new Date().toISOString())
      .run();
    const d = await h.api("DELETE", `${P}/mounts/site`, { token: o.token });
    expect([d.status, d.body.changed]).toEqual([200, []]);
    const g = await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${dev.userId}`, { token: o.token });
    expect(g.body.grants.find((x: any) => x.scope.id === web.resourceId).operations).toEqual(["read", "write"]);
  });

  it("is atomic: when the batch fails, the mount and every grant stay as they were", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const client = await member(h, o, "client");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    const rev = (await h.api("GET", P, { token: o.token })).body.membershipRevision as number;
    const real = env.DB.batch.bind(env.DB);
    const seen: string[][] = [];
    const spy = vi.spyOn(env.DB, "batch").mockImplementation(async (stmts: D1PreparedStatement[]) => {
      const sql = stmts.map((s) => String((s as unknown as { statement?: string }).statement ?? ""));
      seen.push(sql);
      if (sql.some((q) => q.startsWith("DELETE FROM mounts"))) throw new Error("injected: grant write failed");
      return real(stmts);
    });
    try {
      const d = await h.api("DELETE", `${P}/mounts/website`, { token: o.token });
      expect(d.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    // the mount DELETE, the revision bump and the grant removal were one batch
    const detach = seen.find((sql) => sql.some((q) => q.startsWith("DELETE FROM mounts")))!;
    expect(detach.some((q) => q.startsWith("UPDATE projects SET membership_revision"))).toBe(true);
    expect(detach.some((q) => q.startsWith("DELETE FROM grants"))).toBe(true);
    const p = (await h.api("GET", P, { token: o.token })).body;
    expect(p.mounts.map((m: any) => m.mountName)).toEqual(["website"]);
    expect(p.membershipRevision).toBe(rev);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}`, { token: client.token })).status).toBe(200);
    const ev = await h.api("GET", `/api/orgs/${o.orgId}/events?projectId=${pid}`, { token: o.token });
    expect(ev.body.events.some((e: any) => e.action === "mount.removed")).toBe(false);
  });

  it("a detach that finds the mount already gone is 404", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    expect((await h.api("DELETE", `${P}/mounts/website`, { token: o.token })).status).toBe(200);
    expect((await h.api("DELETE", `${P}/mounts/website`, { token: o.token })).status).toBe(404);
  });
});
