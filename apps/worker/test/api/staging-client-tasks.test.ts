import { ArtifactsProviderError } from "@commonforge-org/provider-cloudflare";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { canonicalNs, codeResource, member, projectWith } from "../helpers.js";
import { STAGING_SECTION, stagingFixture, stagingReleasePolicy } from "../staging-helpers.js";

describe("client tasks in a staging-mode project", () => {
  it("a client creates a task, its agent pushes and freezes; the client's own responses carry no coordinates", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await member(f.h, f.o, "client");
    await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: client.userId, level: "write" } });
    const created = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "Update the footer", writeMounts: ["api"] } });
    expect(created.status).toBe(201);
    await f.h.drainSteps();
    const taskId = created.body.taskId;
    const lease = await f.h.api("POST", `/api/tasks/${taskId}/lease`, { token: client.token, body: {} });
    expect(lease.status).toBe(200);
    const seen = await f.h.api("GET", `/api/tasks/${taskId}`, { token: client.token });
    expect(seen.status).toBe(200);
    for (const r of [created, lease, seen]) expect(JSON.stringify(r.body)).not.toMatch(new RegExp(`-${f.o.orgId}-(tasks|canonical)`));
    const cred = await f.h.api("POST", `/api/tasks/${taskId}/credential`, { token: lease.body.leaseToken, body: { mountName: "api", access: "write" } });
    expect(cred.status).toBe(200);
    expect(cred.body.remoteUrl).toMatch(/-tasks/);
    expect(runner.errors).toEqual([]);
  });
  it("a task created with no folders gets them from the owner's settings: writable folders to change, read-only ones to read, no-access ones not at all", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const docs = await codeResource(f.h, f.o, "docs", { "README.md": "docs\n" });
    const secret = await codeResource(f.h, f.o, "secret", { "keys.txt": "x\n" });
    for (const m of [
      { mountName: "docs", resourceId: docs.resourceId, operations: ["read"] },
      { mountName: "secret", resourceId: secret.resourceId },
    ])
      expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: m })).status).toBe(201);
    const client = await member(f.h, f.o, "client");
    const access = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: client.userId, level: "write", folders: { [secret.resourceId]: "none" } } });
    expect(access.status, JSON.stringify(access.body)).toBe(200);
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "Update the footer" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.workspaces.filter((w: { access: string }) => w.access === "write").map((w: { mountName: string }) => w.mountName)).toEqual(["api"]);
    expect(t.body.workspaces.filter((w: { access: string }) => w.access === "read").map((w: { mountName: string }) => w.mountName)).toEqual(["docs"]);
    const names = t.body.snapshot.entries.map((e: { mountName: string }) => e.mountName).sort();
    expect(names).toEqual(["api", "docs"]);
    expect(JSON.stringify(t.body)).not.toContain("secret");
    // the owner (no folder exceptions): every writable folder
    const own = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: f.o.token, body: { title: "Owner task" } });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.workspaces.filter((w: { access: string }) => w.access === "write").map((w: { mountName: string }) => w.mountName).sort()).toEqual(["api", "secret"]);
  });
  it("a task created with no folders leaves out a folder that is not ready, and is refused when none is; at most 16 folders", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const empty = await f.h.api("POST", `/api/orgs/${f.o.orgId}/resources`, { token: f.o.token, body: { name: "empty", provider: "artifacts" } });
    expect(empty.status).toBe(201);
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: { mountName: "empty", resourceId: empty.body.resourceId } })).status).toBe(201);
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: f.o.token, body: { title: "Default" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.workspaces.filter((w: { access: string }) => w.access === "write").map((w: { mountName: string }) => w.mountName)).toEqual(["api"]);
    // named explicitly, the same folder is refused as before
    const named = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: f.o.token, body: { title: "Named", writeMounts: ["empty"] } });
    expect([named.status, named.body.error.code]).toEqual([409, "resource_not_ready"]);
    // only that folder open for changes: refused
    expect((await f.h.api("DELETE", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts/api`, { token: f.o.token })).status).toBeLessThan(300);
    const none = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: f.o.token, body: { title: "None" } });
    expect([none.status, none.body.error.code]).toEqual([403, "no_write_grant"]);
    // more than 16 folders open for changes: the default is refused, naming them still works
    for (let i = 0; i < 17; i++) {
      const r = await codeResource(f.h, f.o, `r${i}`, { "a.txt": `${i}\n` });
      expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: { mountName: `r${i}`, resourceId: r.resourceId } })).status).toBe(201);
    }
    const many = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: f.o.token, body: { title: "Many" } });
    expect([many.status, many.body.error.code]).toEqual([400, "too_many_folders"]);
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: f.o.token, body: { title: "Some", writeMounts: ["r1"] } })).status).toBe(201);
  });
  it("the owner decides per client: Can change, Read only or No access per folder; a client with Read only changes nothing there", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const docs = await codeResource(f.h, f.o, "docs", { "README.md": "docs\n" });
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: { mountName: "docs", resourceId: docs.resourceId } })).status).toBe(201);
    const [a, b] = [await member(f.h, f.o, "client"), await member(f.h, f.o, "client")];
    // a may change api only (docs Read only); b may only read the project
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: a.userId, level: "write", folders: { [docs.resourceId]: "read" } } })).status).toBe(200);
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: b.userId, level: "read" } })).status).toBe(200);
    const view = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}`, { token: a.token });
    expect(view.body.mounts.map((m: { mountName: string; canStartTask: boolean; canWrite: boolean }) => [m.mountName, m.canStartTask, m.canWrite])).toEqual([
      ["api", true, false],
      ["docs", false, false],
    ]);
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: a.token, body: { title: "Footer" } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.workspaces.map((w: { mountName: string; access: string }) => `${w.mountName}:${w.access}`).sort()).toEqual(["api:write", "docs:read"]);
    const named = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: a.token, body: { title: "Docs", writeMounts: ["docs"] } });
    expect([named.status, named.body.error.code]).toEqual([403, "no_write_grant"]);
    const none = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: b.token, body: { title: "x" } });
    expect([none.status, none.body.error.code]).toEqual([403, "no_write_grant"]);
    // Read only after the task was created: the lease ends and the agent's write credential is refused
    await f.h.drainSteps();
    const lease = await f.h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: a.token, body: {} });
    expect(lease.status).toBe(200);
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: a.userId, level: "read" } })).status).toBe(200);
    const cred = await f.h.api("POST", `/api/tasks/${t.body.taskId}/credential`, { token: lease.body.leaseToken, body: { mountName: "api", access: "write" } });
    expect(cred.status).toBeGreaterThanOrEqual(400);
  });
  it("a task created with no folders is refused when no folder is open to the person for changes (403 no_write_grant)", async () => {
    const f = await stagingFixture();
    const client = await member(f.h, f.o, "client");
    await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: client.userId, level: "write" } });
    // the only folder becomes read-only for this project
    expect((await f.h.api("DELETE", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts/api`, { token: f.o.token })).status).toBeLessThan(300);
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: { mountName: "api", resourceId: f.api.resourceId, operations: ["read"] } })).status).toBe(201);
    const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "x" } });
    expect([r.status, r.body.error.code]).toEqual([403, "no_write_grant"]);
  });
  it("without staging mode a client still cannot create a task (403 insufficient_role)", async () => {
    const f = await stagingFixture({ staging: false });
    const client = await member(f.h, f.o, "client");
    const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "x", writeMounts: ["api"] } });
    expect([r.status, r.body.error.code]).toEqual([403, "insufficient_role"]);
  });
  it("a client cannot see or lease another client's task, cannot create proposals, and gets no canonical credential", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const [a, b] = [await member(f.h, f.o, "client"), await member(f.h, f.o, "client")];
    for (const c of [a, b]) await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: c.userId, level: "write" } });
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: a.token, body: { title: "A", writeMounts: ["api"] } });
    await f.h.drainSteps();
    expect((await f.h.api("GET", `/api/tasks/${t.body.taskId}`, { token: b.token })).status).toBe(404);
    expect((await f.h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: b.token, body: {} })).status).toBe(404);
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/proposals`, { token: a.token, body: { taskId: t.body.taskId } })).status).toBe(403);
  });
  // Phase 2 ruling R5 (reverts the Phase 1 ruling): every task in a staging-mode project, whatever
  // the creator's role, starts from the live staging commit
  it("an owner's or developer's task in a staging-mode project with a live staging build starts from the live staging commit", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const stagingSha = await f.seedLiveStagingBuild(); // inserts a live staging_builds row with staging_json for the api resource
    const dev = await member(f.h, f.o, "developer");
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: dev.userId, level: "write" } })).status).toBe(200);
    for (const token of [f.o.token, dev.token]) {
      const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token, body: { title: "dev", writeMounts: ["api"] } });
      expect(t.status, JSON.stringify(t.body)).toBe(201);
      const rev = t.body.snapshot.entries.find((e: { mountName: string }) => e.mountName === "api").revisionId;
      expect(rev).toMatch(new RegExp(`:${stagingSha}$`));
      expect(rev).not.toMatch(new RegExp(`:${f.initialHeadSha}$`));
    }
  });
  it("a client's task in the same project starts from the live staging commit", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const stagingSha = await f.seedLiveStagingBuild();
    const client = await f.clientWithAccess();
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "client", writeMounts: ["api"] } });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const task = await f.svc.db.prepare("SELECT snapshot_json FROM tasks WHERE task_id = ?").bind(t.body.taskId).first<{ snapshot_json: string }>();
    const entry = (JSON.parse(task!.snapshot_json) as { entries: Array<{ mountName: string; revisionId: string }> }).entries.find((e) => e.mountName === "api")!;
    expect(entry.revisionId).toMatch(new RegExp(`:${stagingSha}$`));
  });
});

describe("client tasks: what stays closed", () => {
  async function clientTask(opts: { access?: boolean } = {}) {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await member(f.h, f.o, "client");
    if (opts.access !== false) await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: client.userId, level: "write" } });
    return { f, runner, client };
  }
  const leak = (orgId: string) => new RegExp(`-${orgId}-(tasks|canonical)|artifacts\\.cloudflare\\.net`);

  it("viewers, and clients without access to the project, are refused exactly as without staging mode", async () => {
    const { f, client } = await clientTask({ access: false });
    const viewer = await member(f.h, f.o, "viewer");
    await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: viewer.userId, level: "read" } });
    for (const who of [viewer, client]) {
      const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: who.token, body: { title: "x", writeMounts: ["api"] } });
      expect([r.status, r.body.error.code, r.body.error.message]).toEqual([403, "insufficient_role", "requires one of: owner, developer"]);
      const l = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: who.token });
      expect([l.status, l.body.error.code]).toEqual([403, "insufficient_role"]);
    }
    // an unknown project answers the same (no existence leak)
    const u = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/prj-nope/tasks`, { token: client.token, body: { title: "x", writeMounts: ["api"] } });
    expect([u.status, u.body.error.code]).toEqual([403, "insufficient_role"]);
  });

  it("a client lists only their own tasks; the owner's task stays invisible to them", async () => {
    const { f, client } = await clientTask();
    const mine = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "mine", writeMounts: ["api"] } });
    const theirs = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: f.o.token, body: { title: "owner's", writeMounts: ["api"] } });
    await f.h.drainSteps();
    const l = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token });
    expect(l.body.tasks.map((t: { taskId: string }) => t.taskId)).toEqual([mine.body.taskId]);
    expect((await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: f.o.token })).body.tasks).toHaveLength(2);
    expect((await f.h.api("GET", `/api/tasks/${theirs.body.taskId}`, { token: client.token })).status).toBe(404);
    expect((await f.h.api("POST", `/api/tasks/${theirs.body.taskId}/lease`, { token: client.token, body: {} })).status).toBe(404);
  });

  it("the client's session cannot read the materialization plan; their agent's plan names only task copies", async () => {
    const { f, client } = await clientTask();
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "plan", writeMounts: ["api"] } });
    await f.h.drainSteps();
    const lease = await f.h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: client.token, body: {} });
    const asUser = await f.h.api("GET", `/api/tasks/${t.body.taskId}/materialization?root=/work`, { token: client.token });
    expect([asUser.status, asUser.body.error.code]).toEqual([403, "lease_required"]);
    const plan = await f.h.api("GET", `/api/tasks/${t.body.taskId}/materialization?root=/work`, { token: lease.body.leaseToken });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body.mounts.map((m: { mountName: string; writable: boolean }) => [m.mountName, m.writable])).toEqual([["api", true]]);
    expect(JSON.stringify(plan.body)).not.toMatch(new RegExp(`-${f.o.orgId}-canonical`));
  });

  it("the client freezes as lease holder without receiving the fork; the owner's response keeps it", async () => {
    const { f, client } = await clientTask();
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "freeze", writeMounts: ["api"] } });
    await f.h.drainSteps();
    const lease = await f.h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: client.token, body: {} });
    const agent = lease.body.leaseToken as string;
    const task = (await f.h.api("GET", `/api/tasks/${t.body.taskId}`, { token: agent })).body;
    expect(task.workspaces[0].remoteUrl).toMatch(/-tasks/);
    const cred = await f.h.api("POST", `/api/tasks/${t.body.taskId}/credential`, { token: agent, body: { mountName: "api", access: "write" } });
    const where = f.h.artifacts.tokenByPlaintext(cred.body.secret)!;
    const base = f.h.artifacts.repo(where.ns, where.name).refs.get("main")!;
    const sha = f.h.artifacts.makeCommit({ ...f.h.artifacts.files.get(base), "src/index.ts": "export default {};\n" }, [base]);
    f.h.artifacts.push(where.ns, where.name, "main", sha);
    const fr = await f.h.api("POST", `/api/tasks/${t.body.taskId}/workspaces/${task.workspaces[0].taskWorkspaceId}/freeze`, { token: client.token, body: { expectedSha: sha } });
    expect(fr.status, JSON.stringify(fr.body)).toBe(201);
    expect(fr.body.fork).toBeUndefined();
    expect(JSON.stringify(fr.body)).not.toMatch(leak(f.o.orgId));
    const after = await f.h.api("GET", `/api/tasks/${t.body.taskId}`, { token: client.token });
    expect(after.body.candidates).toHaveLength(1);
    // the client view: no raw revision ids, task workspace ids or shas in the client's own responses
    for (const r of [fr, after, lease]) expect(JSON.stringify(r.body)).not.toMatch(/"(art|cand|local):|taskWorkspaceId|"sha"|"fork"/);
    expect(JSON.stringify(after.body)).not.toMatch(leak(f.o.orgId));
  });

  it("a provider error on freeze never leaks the task repo to a client; a developer still gets the raw message", async () => {
    const { f, client } = await clientTask();
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "provider error", writeMounts: ["api"] } });
    await f.h.drainSteps();
    const lease = await f.h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: client.token, body: {} });
    const agent = lease.body.leaseToken as string;
    const task = (await f.h.api("GET", `/api/tasks/${t.body.taskId}`, { token: agent })).body;
    const cred = await f.h.api("POST", `/api/tasks/${t.body.taskId}/credential`, { token: agent, body: { mountName: "api", access: "write" } });
    const where = f.h.artifacts.tokenByPlaintext(cred.body.secret)!;
    const base = f.h.artifacts.repo(where.ns, where.name).refs.get("main")!;
    const sha = f.h.artifacts.makeCommit({ ...f.h.artifacts.files.get(base), "src/index.ts": "export default {};\n" }, [base]);
    f.h.artifacts.push(where.ns, where.name, "main", sha);
    f.h.artifacts.listTokens = async () => {
      throw new ArtifactsProviderError("freeze_incomplete", `write tokens kept appearing on ${where.name} (-${f.o.orgId}-tasks) during 4 revoke rounds`);
    };
    const freezeUrl = `/api/tasks/${t.body.taskId}/workspaces/${task.workspaces[0].taskWorkspaceId}/freeze`;
    const asClient = await f.h.api("POST", freezeUrl, { token: client.token, body: { expectedSha: sha } });
    expect([asClient.status, asClient.body.error.code]).toEqual([409, "freeze_incomplete"]);
    expect(JSON.stringify(asClient.body)).not.toMatch(leak(f.o.orgId));
    const asAgent = await f.h.api("POST", freezeUrl, { token: agent, body: { expectedSha: sha } });
    expect([asAgent.status, asAgent.body.error.code]).toEqual([409, "freeze_incomplete"]);
    expect(JSON.stringify(asAgent.body)).not.toMatch(leak(f.o.orgId));
    const asOwner = await f.h.api("POST", freezeUrl, { token: f.o.token, body: { expectedSha: sha } });
    expect([asOwner.status, asOwner.body.error.code]).toEqual([409, "freeze_incomplete"]);
    expect(asOwner.body.error.message).toContain(`-${f.o.orgId}-tasks`);
  });

  it("a client's agent gets a plain provider_unavailable message on credential", async () => {
    const { f, client } = await clientTask();
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "unavailable", writeMounts: ["api"] } });
    await f.h.drainSteps();
    const lease = await f.h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: client.token, body: {} });
    f.h.artifacts.createToken = async () => {
      throw new ArtifactsProviderError("provider_unavailable", `POST /repos/ws-x/tokens on -${f.o.orgId}-tasks → 503`);
    };
    const cred = await f.h.api("POST", `/api/tasks/${t.body.taskId}/credential`, { token: lease.body.leaseToken, body: { mountName: "api", access: "write" } });
    expect([cred.status, cred.body.error.code, cred.body.error.message]).toEqual([503, "provider_unavailable", "The workspace service is unavailable; try again."]);
  });

  it("turning staging mode off closes the client's task to the client and to their agent", async () => {
    const { f, client } = await clientTask();
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "off", writeMounts: ["api"] } });
    await f.h.drainSteps();
    const lease = await f.h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: client.token, body: {} });
    expect(lease.status).toBe(200);
    const off = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { release: stagingReleasePolicy(f.o.orgId) } });
    expect(off.status).toBe(200);
    expect((await f.h.api("GET", `/api/tasks/${t.body.taskId}`, { token: client.token })).status).toBe(404);
    const cred = await f.h.api("POST", `/api/tasks/${t.body.taskId}/credential`, { token: lease.body.leaseToken, body: { mountName: "api", access: "write" } });
    expect([cred.status, cred.body.error.code]).toEqual([403, "lease_holder_not_authorized"]);
    // back on: the same lease works again (the task and lease were never the problem)
    await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { release: stagingReleasePolicy(f.o.orgId), staging: STAGING_SECTION } });
    expect((await f.h.api("POST", `/api/tasks/${t.body.taskId}/credential`, { token: lease.body.leaseToken, body: { mountName: "api", access: "write" } })).status).toBe(200);
  });

  it("a client's task starts from the live staging commit and its fork is seeded there", async () => {
    const { f, runner, client } = await clientTask();
    const stagingSha = await f.seedLiveStagingBuild();
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "from staging", writeMounts: ["api"] } });
    expect(t.status).toBe(201);
    await f.h.drainSteps();
    expect(runner.errors).toEqual([]);
    const lease = await f.h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: client.token, body: {} });
    const asAgent = (await f.h.api("GET", `/api/tasks/${t.body.taskId}`, { token: lease.body.leaseToken })).body;
    expect(asAgent.workspaces[0].baseRevision).toMatch(new RegExp(`:${stagingSha}$`));
    const cred = await f.h.api("POST", `/api/tasks/${t.body.taskId}/credential`, { token: lease.body.leaseToken, body: { mountName: "api", access: "write" } });
    const where = f.h.artifacts.tokenByPlaintext(cred.body.secret)!;
    expect(where.ns).toMatch(/-tasks$/);
    expect(f.h.artifacts.repo(where.ns, where.name).refs.get("main")).toBe(stagingSha);
  });

  it("fix 1: a written folder detached mid-task never turns into a canonical source in the client agent's plan", async () => {
    const { f, client } = await clientTask();
    // the client also has the resource through a second project (Change there too), so detaching
    // keeps their grant and their lease (losing Change would end the lease, as for a developer)
    const other = await projectWith(f.h, f.o, [{ mountName: "api", resourceId: f.api.resourceId, operations: ["read"] }]);
    await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${other}/access`, { token: f.o.token, body: { userId: client.userId, level: "write" } });
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "detach", writeMounts: ["api"] } });
    await f.h.drainSteps();
    const lease = await f.h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: client.token, body: {} });
    expect(lease.status).toBe(200);
    const d = await f.h.api("DELETE", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts/api`, { token: f.o.token });
    expect(d.status).toBe(200);
    expect((await f.h.api("GET", `/api/orgs/${f.o.orgId}/resources/${f.api.resourceId}`, { token: client.token })).status).toBe(200);
    const plan = await f.h.api("GET", `/api/tasks/${t.body.taskId}/materialization?root=/work`, { token: lease.body.leaseToken });
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);
    expect(plan.body.mounts).toEqual([]);
    const text = JSON.stringify(plan.body);
    expect(text).not.toContain(canonicalNs(f.o.orgId));
    expect(text).not.toMatch(/-canonical/);
    const canonicalUrl = (await f.sources())[0]!.canonical.remoteUrl;
    expect(text).not.toContain(canonicalUrl);
  });

  it("fix 2: a failed workspace shows the client and their agent a stable code, never the raw error", async () => {
    const { f, runner, client } = await clientTask();
    const ns = canonicalNs(f.o.orgId);
    runner.opts.fail = { "seed-workspace": { code: "provider_unavailable", detail: `base ${"a".repeat(40)} not found in ${ns}/${f.api.resourceId}` } };
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "fails", writeMounts: ["api"] } });
    expect(t.status).toBe(201);
    await f.h.drainSteps();
    const asClient = await f.h.api("GET", `/api/tasks/${t.body.taskId}`, { token: client.token });
    expect(asClient.body.workspaces.map((w: { error?: string }) => w.error)).toEqual(["workspace_failed"]);
    for (const r of [t, asClient]) expect(JSON.stringify(r.body)).not.toMatch(/-canonical/);
    // the owner keeps the raw text for diagnosis
    const asOwner = await f.h.api("GET", `/api/tasks/${t.body.taskId}`, { token: f.o.token });
    expect(asOwner.body.workspaces[0].error).toContain(ns);
  });

  it("minor: a malformed live staging entry falls back to the head instead of failing the create", async () => {
    const { f } = await clientTask();
    const head = (await f.sources())[0]!;
    for (const bad of [{ [f.api.resourceId]: null }, { [f.api.resourceId]: { sha: "x" } }, { [f.api.resourceId]: { revisionId: 42 } }, { [f.api.resourceId]: { revisionId: "not-a-revision" } }]) {
      await f.svc.db.prepare("DELETE FROM staging_builds WHERE org_id = ? AND project_id = ?").bind(f.o.orgId, f.pid).run();
      const now = f.svc.nowIso();
      await f.svc.db
        .prepare("INSERT INTO staging_builds (build_id, org_id, project_id, seq, landings_json, state, staging_json, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, '[]', 'live', ?, ?, ?, ?)")
        .bind(`sb-bad-${crypto.randomUUID()}`, f.o.orgId, f.pid, JSON.stringify(bad), f.o.userId, now, now)
        .run();
      const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: f.o.token, body: { title: "bad", writeMounts: ["api"] } });
      expect(t.status, JSON.stringify(bad)).toBe(201);
      expect(t.body.snapshot.entries[0].revisionId).toBe(head.revisionId);
    }
  });

  it("a client cannot write a mount the project opens read-only", async () => {
    const { f, client } = await clientTask();
    await f.svc.db.prepare("UPDATE mounts SET operations_json = ? WHERE org_id = ? AND project_id = ?").bind(JSON.stringify(["read"]), f.o.orgId, f.pid).run();
    const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "ro", writeMounts: ["api"] } });
    expect(r.status).toBe(403);
  });
});
