/**
 * `GET /api/tasks/:id/assets/file`: lease-authenticated reads of a task's asset mounts (the route
 * `cforge checkout` uses for R2 mounts). Pinned to the task snapshot's manifest (or, with
 * `source=workspace`, the task's own asset workspace); refuses users, other tasks' leases, expired or
 * released leases, mounts outside the snapshot, git mounts and paths outside the manifest.
 */
import { sha256HexSync } from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { lfsEndpointUrl } from "../../src/lib/lfs-config.js";
import { FakeRunner } from "../fakes/runner.js";
import { codeResource, harness, ownerWithOrg, projectWith, waitUntil, type Harness } from "../helpers.js";

type Owner = { token: string; orgId: string; userId: string };

async function lease(h: Harness, o: Owner, taskId: string): Promise<string> {
  const r = await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} });
  expect(r.status).toBe(200);
  return r.body.leaseToken as string;
}

async function newTask(h: Harness, o: Owner, pid: string, body: Record<string, unknown>): Promise<string> {
  const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "t", ...body } });
  expect(t.status).toBe(201);
  await h.drainSteps();
  return t.body.taskId as string;
}

/** Stage, upload and commit `files` into the task's asset workspace for `mount`; returns the new manifest id. */
async function commitAssets(h: Harness, taskId: string, agent: string, mount: string, files: Record<string, string>): Promise<string> {
  const changes = [];
  for (const [path, text] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(text);
    const stage = await h.api("POST", `/api/tasks/${taskId}/assets/stage`, { token: agent, body: { mountName: mount, path, size: bytes.length, mime: "image/png" } });
    expect(stage.status).toBe(200);
    expect((await h.api("PUT", stage.body.uploadUrl, { token: agent, raw: bytes, headers: { "content-length": String(bytes.length) } })).status).toBe(201);
    changes.push({ path, stagingKey: stage.body.stagingKey, sha256: sha256HexSync(bytes), mime: "image/png" });
  }
  const commit = await h.api("POST", `/api/tasks/${taskId}/assets/commit`, { token: agent, body: { mountName: mount, changes } });
  expect(commit.status).toBe(200);
  return commit.body.manifestId as string;
}

/**
 * Project with `website` + `api` (git) and `brand` (R2) whose accepted head holds logo.png and
 * fonts/brand.txt, accepted through a real change (stage → commit → freeze → propose → accept).
 */
async function world() {
  const h = harness();
  const runner = new FakeRunner(h);
  const o = await ownerWithOrg(h);
  const web = await codeResource(h, o, "website", { "index.html": "v1" });
  const api = await codeResource(h, o, "api", { "src/index.ts": "api v1" });
  const brand = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "brand", provider: "r2-assets" } });
  const pid = await projectWith(h, o, [
    { mountName: "website", resourceId: web.resourceId },
    { mountName: "api", resourceId: api.resourceId },
    { mountName: "brand", resourceId: brand.body.resourceId },
  ]);
  // an assets-only seed change: integrated with no git targets (follow-up Task 23), then accepted
  const seed = await newTask(h, o, pid, { writeMounts: ["brand"], readMounts: [] });
  const agent = await lease(h, o, seed);
  const manifestId = await commitAssets(h, seed, agent, "brand", { "logo.png": "teal-logo-v1", "fonts/brand.txt": "Inter" });
  const wss = (await h.api("GET", `/api/tasks/${seed}`, { token: agent })).body.workspaces;
  const ws = wss.find((w: any) => w.mountName === "brand");
  expect((await h.api("POST", `/api/tasks/${seed}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: {} })).status).toBe(200);
  const p = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId: seed } });
  expect(p.status).toBe(201);
  await h.drainSteps();
  expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/integrate`, { token: o.token })).status).toBe(202);
  await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}`, { token: o.token })).body.integration?.forCurrentHash === true);
  await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/approvals`, { token: o.token, body: { proposalHash: p.body.proposalHash } });
  expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${p.body.proposalId}/accept`, { token: o.token, body: { idempotencyKey: `accept-${seed}` } })).status).toBe(200);
  expect(runner.errors).toEqual([]);
  return { h, o, pid, brandId: brand.body.resourceId as string, manifestId };
}

const file = (taskId: string, q: Record<string, string>) => `/api/tasks/${taskId}/assets/file?${new URLSearchParams(q)}`;

describe("materialization plan: LFS URLs (folders phase 4, P4-7)", () => {
  it("git mounts carry lfsUrl = lfsEndpointUrl(env, org, resourceId); asset mounts don't", async () => {
    const { h, o, pid, brandId } = await world();
    const taskId = await newTask(h, o, pid, { writeMounts: ["website"], readMounts: ["api", "brand"] });
    const agent = await lease(h, o, taskId);
    const plan = await h.api("GET", `/api/tasks/${taskId}/materialization?root=/work/t`, { token: agent });
    expect(plan.status).toBe(200);
    const mounts = Object.fromEntries(plan.body.mounts.map((m: any) => [m.mountName, m]));
    for (const name of ["website", "api"]) {
      expect(mounts[name].source.kind).toBe("git");
      expect(mounts[name].source.lfsUrl).toBe(lfsEndpointUrl(env, o.orgId, mounts[name].resourceId));
    }
    expect(mounts.website.source.lfsUrl).toBe(`https://worker.test/api/lfs/${o.orgId}/${mounts.website.resourceId}/info/lfs`);
    expect(mounts.brand.resourceId).toBe(brandId);
    expect(mounts.brand.source.kind).toBe("assets");
    expect(mounts.brand.source).not.toHaveProperty("lfsUrl");
  });
});

describe("GET /api/tasks/:id/assets/file (lease-authenticated asset reads)", () => {
  it("streams a reference asset mount from the snapshot's manifest with the lease alone", async () => {
    const { h, o, pid, manifestId } = await world();
    const taskId = await newTask(h, o, pid, { writeMounts: ["website"], readMounts: ["brand"] });
    const agent = await lease(h, o, taskId);
    const r = await h.api("GET", file(taskId, { mount: "brand", path: "logo.png" }), { token: agent });
    expect(r.status).toBe(200);
    expect(r.body).toBe("teal-logo-v1");
    expect(r.headers.get("x-commonforge-revision")).toBe(`r2m:${manifestId}`);
    expect(r.headers.get("x-commonforge-sha256")).toBe(sha256HexSync(new TextEncoder().encode("teal-logo-v1")));
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const nested = await h.api("GET", file(taskId, { mount: "brand", path: "fonts/brand.txt" }), { token: agent });
    expect(nested.body).toBe("Inter");
    // the user-only project file route still refuses the lease
    expect((await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/file?mount=brand&path=logo.png`, { token: agent })).status).toBe(403);
  });

  it("stays pinned to the snapshot after the resource moves on; source=workspace reads the task's own manifest", async () => {
    const { h, o, pid, manifestId } = await world();
    const reader = await newTask(h, o, pid, { writeMounts: ["website"], readMounts: ["brand"] });
    const readerAgent = await lease(h, o, reader);
    // a second task rewrites the logo in its own asset workspace
    const writer = await newTask(h, o, pid, { writeMounts: ["brand"], readMounts: [] });
    const writerAgent = await lease(h, o, writer);
    const before = await h.api("GET", file(writer, { mount: "brand", path: "logo.png", source: "workspace" }), { token: writerAgent });
    expect(before.body).toBe("teal-logo-v1"); // no commit yet: the workspace manifest is the base
    const newManifest = await commitAssets(h, writer, writerAgent, "brand", { "logo.png": "violet-logo-v2" });

    const ws = await h.api("GET", file(writer, { mount: "brand", path: "logo.png", source: "workspace" }), { token: writerAgent });
    expect(ws.status).toBe(200);
    expect(ws.body).toBe("violet-logo-v2");
    expect(ws.headers.get("x-commonforge-revision")).toBe(`r2m:${newManifest}`);
    // the default stays on the writer's snapshot, and the other task never sees the change
    const snap = await h.api("GET", file(writer, { mount: "brand", path: "logo.png" }), { token: writerAgent });
    expect([snap.body, snap.headers.get("x-commonforge-revision")]).toEqual(["teal-logo-v1", `r2m:${manifestId}`]);
    expect((await h.api("GET", file(reader, { mount: "brand", path: "logo.png" }), { token: readerAgent })).body).toBe("teal-logo-v1");
    // a reference mount has no asset workspace
    const noWs = await h.api("GET", file(reader, { mount: "brand", path: "logo.png", source: "workspace" }), { token: readerAgent });
    expect(noWs.status).toBe(404);
  });

  it("refuses users, missing credentials, other tasks' leases, released and expired leases", async () => {
    const { h, o, pid } = await world();
    const taskA = await newTask(h, o, pid, { writeMounts: ["website"], readMounts: ["brand"] });
    const taskB = await newTask(h, o, pid, { writeMounts: ["api"], readMounts: ["brand"] });
    const agentA = await lease(h, o, taskA);
    const agentB = await lease(h, o, taskB);
    const q = { mount: "brand", path: "logo.png" };

    const asUser = await h.api("GET", file(taskA, q), { token: o.token });
    expect([asUser.status, asUser.body.error.code]).toEqual([403, "lease_required"]);
    expect((await h.api("GET", file(taskA, q))).status).toBe(401);
    // B's lease on A's task: the task does not exist for it
    const other = await h.api("GET", file(taskA, q), { token: agentB });
    expect([other.status, other.body.error.code]).toEqual([404, "not_found"]);
    expect((await h.api("GET", file(taskB, q), { token: agentB })).status).toBe(200);

    // a new lease replaces the old token
    const agentA2 = await lease(h, o, taskA);
    expect((await h.api("GET", file(taskA, q), { token: agentA })).status).toBe(401);
    expect((await h.api("GET", file(taskA, q), { token: agentA2 })).status).toBe(200);
    // released
    expect((await h.api("DELETE", `/api/tasks/${taskA}/lease`, { token: agentA2 })).status).toBe(200);
    expect((await h.api("GET", file(taskA, q), { token: agentA2 })).status).toBe(401);
    // expired
    await env.DB.prepare("UPDATE tasks SET lease_expires_at = ? WHERE task_id = ?").bind(Date.now() - 1000, taskB).run();
    const expired = await h.api("GET", file(taskB, q), { token: agentB });
    expect([expired.status, expired.body.error.code]).toEqual([401, "unauthenticated"]);
  });

  it("refuses paths outside the manifest, mounts outside the snapshot and git mounts", async () => {
    const { h, o, pid } = await world();
    const scoped = await newTask(h, o, pid, { writeMounts: ["website"], readMounts: [] });
    const agent = await lease(h, o, scoped);
    // brand is a project mount, but not in this task's snapshot
    const outside = await h.api("GET", file(scoped, { mount: "brand", path: "logo.png" }), { token: agent });
    expect([outside.status, outside.body.error.code]).toEqual([404, "not_found"]);
    expect((await h.api("GET", file(scoped, { mount: "nope", path: "logo.png" }), { token: agent })).status).toBe(404);
    // git mounts (written or canonical reference) are not served here
    const git = await h.api("GET", file(scoped, { mount: "website", path: "index.html" }), { token: agent });
    expect([git.status, git.body.error.code]).toEqual([400, "not_assets"]);

    const withBrand = await newTask(h, o, pid, { writeMounts: ["website"], readMounts: ["brand", "api"] });
    const agent2 = await lease(h, o, withBrand);
    const ref = await h.api("GET", file(withBrand, { mount: "api", path: "src/index.ts" }), { token: agent2 });
    expect([ref.status, ref.body.error.code]).toEqual([400, "not_assets"]);
    const missing = await h.api("GET", file(withBrand, { mount: "brand", path: "secret.png" }), { token: agent2 });
    expect([missing.status, missing.body.error.code]).toEqual([404, "not_found"]);
    const dir = await h.api("GET", file(withBrand, { mount: "brand", path: "fonts" }), { token: agent2 });
    expect(dir.status).toBe(404);
    for (const bad of ["../logo.png", "/logo.png", "fonts/../logo.png"]) {
      const r = await h.api("GET", file(withBrand, { mount: "brand", path: bad }), { token: agent2 });
      expect([bad, r.status, r.body.error.code]).toEqual([bad, 400, "invalid_path"]);
    }
    expect((await h.api("GET", file(withBrand, { mount: "brand", path: "logo.png", source: "head" }), { token: agent2 })).status).toBe(400);
  });

  it("refuses once the task is no longer running", async () => {
    const { h, o, pid } = await world();
    const taskId = await newTask(h, o, pid, { writeMounts: ["brand"], readMounts: [] });
    const agent = await lease(h, o, taskId);
    await commitAssets(h, taskId, agent, "brand", { "logo.png": "v3" });
    const ws = (await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body.workspaces.find((w: any) => w.mountName === "brand");
    expect((await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: {} })).status).toBe(200);
    expect((await h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body.state).toBe("submitted");
    const r = await h.api("GET", file(taskId, { mount: "brand", path: "logo.png" }), { token: agent });
    expect([r.status, r.body.error.code]).toEqual([409, "task_not_running"]);
  });

  it("re-checks the lease holder's read grant on the resource", async () => {
    const { h, o, pid, brandId } = await world();
    const dev = await h.signIn(`dev-${crypto.randomUUID().slice(0, 8)}@example.test`);
    const me = (await h.api("GET", "/api/me", { token: dev })).body.user;
    const add = await h.api("POST", `/api/orgs/${o.orgId}/members`, { token: o.token, body: { email: me.email, role: "developer" } });
    expect(add.status).toBe(201);
    const webId = (await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}`, { token: o.token })).body.mounts.find((m: any) => m.mountName === "website").resourceId;
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: me.userId, scope: { kind: "project", id: pid }, operations: ["read"] } });
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: me.userId, scope: { kind: "resource", id: webId }, operations: ["read", "write"] } });
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: me.userId, scope: { kind: "resource", id: brandId }, operations: ["read"] } });
    const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: dev, body: { title: "dev", writeMounts: ["website"], readMounts: ["brand"] } });
    expect(t.status).toBe(201);
    await h.drainSteps();
    const agent = (await h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: dev, body: {} })).body.leaseToken;
    expect((await h.api("GET", file(t.body.taskId, { mount: "brand", path: "logo.png" }), { token: agent })).status).toBe(200);
    // the grant is re-checked per request (the grant API also ends the leases; drop the row alone here)
    await env.DB.prepare("DELETE FROM grants WHERE org_id = ? AND user_id = ? AND scope_kind = 'resource' AND scope_id = ?").bind(o.orgId, me.userId, brandId).run();
    const after = await h.api("GET", file(t.body.taskId, { mount: "brand", path: "logo.png" }), { token: agent });
    expect([after.status, after.body.error.code]).toEqual([404, "not_found"]);
    // and through the grant API the lease itself ends
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: me.userId, scope: { kind: "resource", id: brandId }, operations: ["read"] } });
    const agent2 = (await h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: dev, body: {} })).body.leaseToken;
    expect((await h.api("GET", file(t.body.taskId, { mount: "brand", path: "logo.png" }), { token: agent2 })).status).toBe(200);
    await h.api("DELETE", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: me.userId, scope: { kind: "resource", id: brandId } } });
    expect((await h.api("GET", file(t.body.taskId, { mount: "brand", path: "logo.png" }), { token: agent2 })).status).toBe(401);
  });
});
