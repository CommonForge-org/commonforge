import { describe, expect, it } from "vitest";
import { canonicalNs, codeResource, harness, member, ownerWithOrg, projectWith } from "../helpers.js";

describe("projects, mounts and resources", () => {
  it("creates a canonical repo (create token revoked), binds the head, browses it", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "<h1>hi</h1>", "src/app.ts": "export {}" });
    expect(h.artifacts.activeTokens(canonicalNs(o.orgId), web.resourceId)).toHaveLength(0);
    expect(web.revisionId).toBe(`art:${web.repoId}:${web.sha}`);
    const again = await h.api("POST", `/api/orgs/${o.orgId}/resources/${web.resourceId}/adopt-head`, { token: o.token });
    expect(again.status).toBe(200); // idempotent replay of the genesis bind
    expect(again.body.revisionId).toBe(web.revisionId);

    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const tree = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/tree?mount=website`, { token: o.token });
    expect(tree.status).toBe(200);
    expect(tree.body.entries.map((e: any) => e.path)).toEqual(["index.html", "src"]);
    const sub = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/tree?mount=website&path=src`, { token: o.token });
    expect(sub.body.entries.map((e: any) => e.path)).toEqual(["src/app.ts"]);
    const file = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/file?mount=website&path=index.html`, { token: o.token });
    expect(file.status).toBe(200);
    expect(file.body).toBe("<h1>hi</h1>");
    const escape = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/file?mount=website&path=../x`, { token: o.token });
    expect(escape.status).toBe(400);

    const snap = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/snapshot`, { token: o.token });
    expect(snap.status).toBe(200);
    expect(snap.body.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.body.entries).toEqual([expect.objectContaining({ mountName: "website", revisionId: web.revisionId })]);
  });

  it("asset resources start bound to an empty manifest", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const r = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "brand", provider: "r2-assets" } });
    expect(r.status).toBe(201);
    expect(r.body.state).toBe("active");
    const got = await h.api("GET", `/api/orgs/${o.orgId}/resources/${r.body.resourceId}`, { token: o.token });
    expect(got.body.head.revisionId).toMatch(/^r2m:[0-9a-f]{64}$/);
    const pid = await projectWith(h, o, [{ mountName: "brand", resourceId: r.body.resourceId }]);
    const tree = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/tree?mount=brand`, { token: o.token });
    expect(tree.status).toBe(200);
    expect(tree.body.entries).toEqual([]);
  });

  it("AT-16: a project member without an independent resource grant cannot see or read it", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "public" });
    const secret = await codeResource(h, o, "internal-api", { "secret.ts": "KEY=1" });
    const pid = await projectWith(h, o, [
      { mountName: "website", resourceId: web.resourceId },
      { mountName: "api", resourceId: secret.resourceId },
    ]);
    for (const role of ["developer", "client", "viewer"]) {
      const m = await member(h, o, role);
      // no project grant: the project does not exist for them
      expect((await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}`, { token: m.token })).status).toBe(404);
      await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: m.userId, scope: { kind: "project", id: pid }, operations: ["read"] } });
      await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: m.userId, scope: { kind: "resource", id: web.resourceId }, operations: ["read"] } });
      const p = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}`, { token: m.token });
      expect(p.status).toBe(200);
      expect(p.body.mounts.map((x: any) => x.mountName)).toEqual(["website"]);
      expect(JSON.stringify(p.body)).not.toContain(secret.resourceId);
      for (const path of ["tree?mount=api", "file?mount=api&path=secret.ts"]) {
        const r = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/${path}`, { token: m.token });
        expect(r.status).toBe(404);
      }
      expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${secret.resourceId}`, { token: m.token })).status).toBe(404);
      const list = await h.api("GET", `/api/orgs/${o.orgId}/resources`, { token: m.token });
      expect(list.body.resources.map((r: any) => r.resourceId)).toEqual([web.resourceId]);
      const snap = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/snapshot`, { token: m.token });
      expect(snap.body.entries.map((e: any) => e.resourceId)).toEqual([web.resourceId]);
      const ok = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/file?mount=website&path=index.html`, { token: m.token });
      expect(ok.status).toBe(200);
    }
  });

  it("clients and viewers never receive canonical coordinates and browse accepted versions only", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "v1" });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    for (const role of ["client", "viewer"]) {
      const m = await member(h, o, role);
      for (const scope of [{ kind: "project", id: pid }, { kind: "resource", id: web.resourceId }]) {
        await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: m.userId, scope, operations: ["read"] } });
      }
      const r = await h.api("GET", `/api/orgs/${o.orgId}/resources/${web.resourceId}`, { token: m.token });
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.body);
      expect(r.body.coords).toBeUndefined();
      expect(text).not.toContain("artifacts.cloudflare.net");
      expect(text).not.toContain(canonicalNs(o.orgId));
      const list = JSON.stringify((await h.api("GET", `/api/orgs/${o.orgId}/resources`, { token: m.token })).body);
      expect(list).not.toContain("artifacts.cloudflare.net");
      const explicit = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/tree?mount=website&revision=${encodeURIComponent(web.revisionId)}`, { token: m.token });
      expect(explicit.status).toBe(403);
      // no write path for clients/viewers
      expect((await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: m.token, body: { name: "x" } })).status).toBe(403);
      expect((await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: m.token, body: { name: "x", provider: "artifacts" } })).status).toBe(403);
    }
  });

  it("I-2: mounts and policy are owner-only; policy changes bump the ledger policy revision", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { a: "1" });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const dev = await member(h, o, "developer");
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: dev.userId, scope: { kind: "project", id: pid }, operations: ["read"] } });
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: dev.userId, scope: { kind: "resource", id: web.resourceId }, operations: ["read", "write"] } });
    // probe A: a developer (even with grants) cannot weaken policy or change mounts
    const pol = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: dev.token, body: { approvalRoles: ["developer"], checks: [] } });
    expect(pol.status).toBe(403);
    expect((await h.api("DELETE", `/api/orgs/${o.orgId}/projects/${pid}/mounts/website`, { token: dev.token })).status).toBe(403);
    expect((await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/mounts`, { token: dev.token, body: { mountName: "w2", resourceId: web.resourceId } })).status).toBe(403);
    const ok = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, {
      token: o.token,
      body: { checks: [{ checkId: "test", mountName: "website", command: "npm test" }], approvalRoles: ["client"] },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.policyRevision).toBe(1);
    const proj = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}`, { token: dev.token });
    expect(proj.body.policy.checks[0].command).toBe("npm test");
  });
});
