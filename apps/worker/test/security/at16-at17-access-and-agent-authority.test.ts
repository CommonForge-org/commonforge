/**
 * Security suite — AT-16 (unauthorized access, here across tenants; the per-principal matrix inside
 * one org is test/api/authz-matrix.test.ts) and AT-17 (agent authority: an agent can never push
 * canonical accepted code or overwrite accepted assets).
 */
import { sha256HexSync } from "@commonforge-org/core";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { canonicalNs, codeResource, freezeAndPropose, harness, member, ownerWithOrg, prepareAndIntegrate, projectWith, provisionedTask, tasksNs } from "../helpers.js";

const leaked = (body: unknown, ...needles: string[]) => needles.filter((n) => JSON.stringify(body ?? "").includes(n));

describe("security: AT-16 tenants and resources", () => {
  it("automatic folder access never reaches a member without the project; a client's Change never writes canonical; viewers never write", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const secret = await codeResource(h, o, "internal", { "k.txt": "secret" });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const inProject = await member(h, o, "client");
    const viewer = await member(h, o, "viewer");
    const notInProject = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: inProject.userId, level: "write" } });
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: viewer.userId, level: "read" } });
    // even a write project grant seeded straight into D1 (the API refuses one for a viewer) gives a viewer read only
    const { env } = await import("cloudflare:workers");
    const seeded = await env.DB.prepare("UPDATE grants SET operations_json = '[\"read\",\"write\"]' WHERE org_id = ? AND user_id = ? AND scope_kind = 'project' AND scope_id = ?").bind(o.orgId, viewer.userId, pid).run();
    expect(seeded.meta.changes).toBe(1);
    await h.api("POST", `${P}/mounts`, { token: o.token, body: { mountName: "internal", resourceId: secret.resourceId } });
    const ops = async (who: { userId: string }) => (await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${who.userId}`, { token: o.token })).body.grants.find((x: any) => x.scope.id === secret.resourceId)?.operations;
    expect(await ops(viewer)).toEqual(["read"]);
    // the client's Change reaches the new folder, but only as "through tasks": no canonical write
    expect(await ops(inProject)).toEqual(["read", "write"]);
    const view = await h.api("GET", P, { token: inProject.token });
    expect(view.body.mounts.every((m: { canWrite: boolean }) => m.canWrite === false)).toBe(true);
    // the project is not in staging mode: no task either
    const t = await h.api("POST", `${P}/tasks`, { token: inProject.token, body: { title: "x" } });
    expect(t.status).toBe(403);
    const g2 = await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${notInProject.userId}`, { token: o.token });
    expect(g2.body.grants.some((x: any) => x.scope.id === secret.resourceId)).toBe(false);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${secret.resourceId}`, { token: notInProject.token })).status).toBe(404);
  });

  it("project access never gives a viewer write, a client's write is Can change, and a developer never gives write to anyone", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const grantsOf = async (userId: string) => (await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${userId}`, { token: o.token })).body.grants;
    const client = await member(h, o, "client");
    const viewer = await member(h, o, "viewer");
    // (a) viewers: write is refused outright, as a level or as a folder, and nothing changes
    for (const who of [viewer]) {
      await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: who.userId, level: "read" } });
      const before = await grantsOf(who.userId);
      for (const body of [{ userId: who.userId, level: "write" }, { userId: who.userId, level: "write", folders: { [web.resourceId]: "read" } }]) {
        const r = await h.api("PUT", `${P}/access`, { token: o.token, body });
        expect([r.status, r.body.error.code]).toEqual([400, "grant_exceeds_role"]);
      }
      const r = await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: who.userId, level: "read", folders: { [web.resourceId]: "write" } } });
      expect([r.status, r.body.error.code]).toEqual([400, "folder_exceeds_project"]);
      expect(await grantsOf(who.userId)).toEqual(before);
    }
    // a client: Can change from the owner, never above the project level
    expect((await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "write" } })).status).toBe(200);
    const r = await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read", folders: { [web.resourceId]: "write" } } });
    expect([r.status, r.body.error.code]).toEqual([400, "folder_exceeds_project"]);
    // (b) a developer (even one with write) can raise no one to write: owner only
    const dev = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } });
    const other = await member(h, o, "developer");
    for (const before of ["none", "read"] as const) {
      if (before === "read") await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: other.userId, level: "read" } });
      const snapshot = await grantsOf(other.userId);
      const r = await h.api("PUT", `${P}/access`, { token: dev.token, body: { userId: other.userId, level: "write" } });
      expect([r.status, r.body.error.code], `from ${before}`).toEqual([403, "grant_owner_only"]);
      expect(await grantsOf(other.userId)).toEqual(snapshot);
    }
    expect((await grantsOf(other.userId)).every((g: any) => !g.operations.includes("write"))).toBe(true);
  });

  it("another org's owner can neither read nor mount nor export this org's resources, proposals, exports or events", async () => {
    const h = harness();
    const a = await provisionedTask(h);
    const { proposal } = await freezeAndPropose(h, a.o, a.taskId, { "index.html": "secret v2" });
    const exp = await h.api("POST", `/api/orgs/${a.o.orgId}/projects/${a.pid}/exports`, { token: a.o.token });
    expect(exp.status).toBeLessThan(300);
    await h.drainSteps();

    const b = await ownerWithOrg(h, "Other Agency");
    const pb = await projectWith(h, b, []);
    const A = `/api/orgs/${a.o.orgId}`;
    const B = `/api/orgs/${b.orgId}`;
    const probes: Array<[string, string, unknown?]> = [
      // A's ids through A's paths: B is a stranger to org A
      ["GET", `${A}`],
      ["GET", `${A}/projects/${a.pid}`],
      ["GET", `${A}/projects/${a.pid}/tree?mount=website`],
      ["GET", `${A}/resources/${a.web.resourceId}`],
      ["GET", `${A}/resources/${a.web.resourceId}/versions`],
      ["GET", `${A}/proposals/${proposal.proposalId}`],
      ["GET", `${A}/exports/${exp.body.exportId}`],
      ["GET", `${A}/events`],
      ["GET", `/api/tasks/${a.taskId}`],
      // A's ids through B's own org paths: every lookup is (org, id), never id alone
      ["GET", `${B}/resources/${a.web.resourceId}`],
      ["GET", `${B}/resources/${a.web.resourceId}/versions`],
      ["GET", `${B}/proposals/${proposal.proposalId}`],
      ["GET", `${B}/exports/${exp.body.exportId}`],
      ["POST", `${B}/projects/${pb}/mounts`, { mountName: "stolen", resourceId: a.web.resourceId, mode: "pinned-reference", operations: ["read"] }],
      ["POST", `${B}/resources/${a.web.resourceId}/restore`, { expectedHead: a.web.revisionId, targetRevision: a.web.revisionId, idempotencyKey: "cross-tenant-1" }],
      ["POST", `${B}/proposals/${proposal.proposalId}/approvals`, { proposalHash: proposal.proposalHash }],
    ];
    const failures: string[] = [];
    for (const [method, path, body] of probes) {
      const r = await h.api(method, path, { token: b.token, ...(body !== undefined ? { body } : {}) });
      if (r.status < 400) failures.push(`${method} ${path} → ${r.status}`);
      const l = leaked(r.body, a.web.repoId, canonicalNs(a.o.orgId), tasksNs(a.o.orgId), "secret v2", a.web.revisionId);
      if (l.length) failures.push(`${method} ${path} leaked ${l.join(", ")}`);
    }
    expect(failures).toEqual([]);
    // B's own event feed and project list show nothing of A
    const feed = await h.api("GET", `${B}/events`, { token: b.token });
    expect(leaked(feed.body, a.o.orgId, a.pid, a.web.resourceId, proposal.proposalId)).toEqual([]);
    expect((await h.api("GET", `${B}/projects/${pb}`, { token: b.token })).body.mounts).toEqual([]);
  });

  it("detaching never leaves a project member holding a folder no project gives, and never touches outsiders", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const f = await codeResource(h, o, "f", { "a.txt": "a" });
    const pid = await projectWith(h, o, [{ mountName: "f", resourceId: f.resourceId }]);
    const insider = await member(h, o, "client");
    const outsider = await member(h, o, "developer");
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: insider.userId, level: "read" } });
    // a real outsider: a direct write grant on the folder, no grant on the project
    const put = await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: outsider.userId, scope: { kind: "resource", id: f.resourceId }, operations: ["read", "write"] } });
    expect(put.status).toBeLessThan(300);
    const before = await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${outsider.userId}`, { token: o.token });
    expect(before.body.grants.some((x: any) => x.scope.kind === "project")).toBe(false);
    const d = await h.api("DELETE", `/api/orgs/${o.orgId}/projects/${pid}/mounts/f`, { token: o.token });
    expect(d.body.changed).toEqual([insider.userId]);
    const g = await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${insider.userId}`, { token: o.token });
    expect(g.body.grants.some((x: any) => x.scope.id === f.resourceId)).toBe(false);
    const after = await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${outsider.userId}`, { token: o.token });
    expect(after.body.grants).toEqual(before.body.grants);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${f.resourceId}`, { token: outsider.token })).status).toBe(200);
  });
});

describe("security: AT-17 agent authority", () => {
  it("every credential an agent receives is for its own -tasks copies; references are read-only; canonical is never minted for an agent", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    const lease = await h.api("POST", `/api/tasks/${t.taskId}/lease`, { token: t.o.token, body: {} });
    const agent = lease.body.leaseToken as string;
    const minted: string[] = [];
    for (const [mountName, access] of [["website", "write"], ["website", "read"], ["api", "read"]] as const) {
      const r = await h.api("POST", `/api/tasks/${t.taskId}/credential`, { token: agent, body: { mountName, access } });
      expect(r.status, `${mountName}/${access}`).toBe(200);
      const where = h.artifacts.tokenByPlaintext(r.body.secret)!;
      expect(where.ns, `${mountName}/${access}`).toBe(tasksNs(t.o.orgId));
      expect(r.body.remoteUrl).not.toContain("-canonical/");
      minted.push(r.body.secret);
    }
    // the pinned reference mount never gets a write token
    const refWrite = await h.api("POST", `/api/tasks/${t.taskId}/credential`, { token: agent, body: { mountName: "api", access: "write" } });
    expect(refWrite.status).toBeGreaterThanOrEqual(400);
    // no canonical token was ever handed to the agent
    for (const [key, repo] of h.artifacts.repos) {
      if (!key.startsWith(`${canonicalNs(t.o.orgId)}/`)) continue;
      for (const tok of repo.tokens) expect(minted).not.toContain(tok.plaintext);
    }
    // the runner broker, evidence key and result endpoints need a job signed by this Worker
    const canonical = h.artifacts.repo(canonicalNs(t.o.orgId), t.web.resourceId).info;
    const coords = { kind: "artifacts", namespace: canonicalNs(t.o.orgId), repoName: canonical.name, repoId: canonical.id, remoteUrl: canonical.remote };
    const forged = { job: { kind: "integrate" }, jobId: "job-agent", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), credentialBroker: "https://worker.test/api/runner/credential", kid: "k1", sig: "0".repeat(64) };
    expect((await h.api("POST", "/api/runner/credential", { token: agent, body: { signedJob: forged, repo: coords, access: "write" } })).status).toBe(403);
    expect((await h.api("POST", "/api/runner/evidence-key", { token: agent, body: { signedJob: forged } })).status).toBe(403);
    expect((await h.api("POST", "/api/runner/results", { token: agent, body: { signedJob: forged, result: { jobId: "job-agent", ok: true, receipt: {} } } })).status).toBe(403);
    // the agent cannot move accepted state by any user route
    const O = `/api/orgs/${t.o.orgId}`;
    expect((await h.api("POST", `${O}/resources/${t.web.resourceId}/restore`, { token: agent, body: { expectedHead: t.web.revisionId, targetRevision: t.web.revisionId, idempotencyKey: "agent-restore-1" } })).status).toBe(403);
    expect((await h.api("POST", `${O}/resources/${t.web.resourceId}/adopt-head`, { token: agent })).status).toBe(403);
    expect(h.artifacts.repo(canonicalNs(t.o.orgId), t.web.resourceId).refs.get("main")).toBe(t.web.sha);
  });

  it("after a full task no write token stays active on any task repository", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    const { proposal } = await freezeAndPropose(h, t.o, t.taskId, { "index.html": "v2" });
    await prepareAndIntegrate(h, t.o, proposal.proposalId);
    await h.api("POST", `/api/orgs/${t.o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: t.o.token, body: { proposalHash: proposal.proposalHash } });
    expect((await h.api("POST", `/api/orgs/${t.o.orgId}/proposals/${proposal.proposalId}/accept`, { token: t.o.token, body: { idempotencyKey: "accept-at17-02" } })).status).toBe(200);
    for (const [key, repo] of h.artifacts.repos) {
      if (!key.startsWith(`${tasksNs(t.o.orgId)}/`)) continue;
      expect(repo.tokens.filter((x) => x.state === "active" && x.scope === "write"), key).toEqual([]);
    }
  });

  it("an agent cannot overwrite accepted assets: staging is confined to its workspace, and the accepted manifest moves only on accept", async () => {
    const h = harness();
    new FakeRunner(h);
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "v1" });
    const brand = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "brand", provider: "r2-assets" } });
    const rid = brand.body.resourceId as string;
    const pid = await projectWith(h, o, [
      { mountName: "website", resourceId: web.resourceId },
      { mountName: "brand", resourceId: rid },
    ]);
    const t = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title: "new logo", writeMounts: ["brand"] } });
    await h.drainSteps();
    const agent = (await h.api("POST", `/api/tasks/${t.body.taskId}/lease`, { token: o.token, body: {} })).body.leaseToken as string;
    const accepted = async () => (await h.api("GET", `/api/orgs/${o.orgId}/resources/${rid}`, { token: o.token })).body.head.revisionId as string;
    const before = await accepted();

    const logo = new TextEncoder().encode("new logo bytes");
    const stage = await h.api("POST", `/api/tasks/${t.body.taskId}/assets/stage`, { token: agent, body: { mountName: "brand", path: "logo.png", size: logo.length, mime: "image/png" } });
    expect(stage.status).toBe(200);
    expect(stage.body.stagingKey).toMatch(new RegExp(`^org/${o.orgId}/staging/`));
    // an upload or commit naming any key outside its own staging area is refused
    const outside = [`org/${o.orgId}/res/${rid}/objects/${"a".repeat(64)}`, `org/${o.orgId}/staging/tw-someone-else/logo.png`, `org/other-org/staging/x`];
    for (const key of outside) {
      const up = await h.api("PUT", `/api/tasks/${t.body.taskId}/assets/upload?key=${encodeURIComponent(key)}`, { token: agent, raw: logo, headers: { "content-length": String(logo.length) } });
      expect([up.status, up.body.error?.code], key).toEqual([403, "scope_violation"]);
      const commit = await h.api("POST", `/api/tasks/${t.body.taskId}/assets/commit`, { token: agent, body: { mountName: "brand", changes: [{ path: "logo.png", stagingKey: key, sha256: sha256HexSync(logo), mime: "image/png" }] } });
      expect(commit.status, key).toBe(403);
    }
    // a path that escapes the asset mount is invalid input
    const escape = await h.api("POST", `/api/tasks/${t.body.taskId}/assets/stage`, { token: agent, body: { mountName: "brand", path: "../website/index.html", size: 1, mime: "text/html" } });
    expect(escape.status).toBe(400);
    // a legitimate commit writes the task's own manifest; the accepted head is unchanged
    expect((await h.api("PUT", stage.body.uploadUrl, { token: agent, raw: logo, headers: { "content-length": String(logo.length) } })).status).toBe(201);
    const ok = await h.api("POST", `/api/tasks/${t.body.taskId}/assets/commit`, { token: agent, body: { mountName: "brand", changes: [{ path: "logo.png", stagingKey: stage.body.stagingKey, sha256: sha256HexSync(logo), mime: "image/png" }] } });
    expect(ok.status).toBe(200);
    expect(await accepted()).toBe(before);
    expect(ok.body.manifestId).not.toBe(before.replace(/^r2m:/, ""));
  });
});

