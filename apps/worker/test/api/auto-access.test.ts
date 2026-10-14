import { describe, expect, it } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { codeResource, harness, member, ownerWithOrg, projectWith } from "../helpers.js";

describe("automatic access for attached folders", () => {
  it("a folder attached later goes to everyone with the project, at their level capped by role; only widens", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const docs = await codeResource(h, o, "docs", { "README.md": "docs" });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const client = await member(h, o, "client");
    const dev = await member(h, o, "developer");
    const outsider = await member(h, o, "viewer");
    // the client had website hidden earlier; that exception does not block new folders
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read", folders: { [web.resourceId]: "none" } } });
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } });

    expect((await h.api("POST", `${P}/mounts`, { token: o.token, body: { mountName: "docs", resourceId: docs.resourceId } })).status).toBe(201);

    const access = (await h.api("GET", `${P}/access`, { token: o.token })).body.people;
    const lvl = (id: string) => access.find((p: any) => p.userId === id).folders.find((f: any) => f.mountName === "docs").level;
    expect(lvl(client.userId)).toBe("read");
    expect(lvl(dev.userId)).toBe("write");
    expect(lvl(outsider.userId)).toBe("none");
    expect((await h.api("GET", `${P}/tree?mount=docs`, { token: client.token })).status).toBe(200);
    expect((await h.api("GET", `${P}/tree?mount=website`, { token: client.token })).status).toBe(404);
    expect((await h.api("GET", `${P}/tree?mount=docs`, { token: outsider.token })).status).toBe(404);
  });

  it("attaching never narrows an existing folder grant", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const shared = await codeResource(h, o, "shared", { "a.txt": "a" });
    const pidA = await projectWith(h, o, [{ mountName: "shared", resourceId: shared.resourceId }]);
    const pidB = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const dev = await member(h, o, "developer");
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pidA}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } });
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pidB}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } });
    await h.api("POST", `/api/orgs/${o.orgId}/projects/${pidB}/mounts`, { token: o.token, body: { mountName: "shared", resourceId: shared.resourceId } });
    const g = await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${dev.userId}`, { token: o.token });
    expect(g.body.grants.find((x: any) => x.scope.id === shared.resourceId).operations).toEqual(["read", "write"]);
  });
});

describe("automatic access through import attaches", () => {
  const waitUntil = async (cond: () => Promise<boolean>, ms = 2000) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("URL import attaches with automatic access", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    h.importer.remotes.set("https://github.com/demo/website.git", { master: { "index.html": "hello" } });
    const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Portal" } });
    const P = `/api/orgs/${o.orgId}/projects/${p.body.projectId}`;
    const client = await member(h, o, "client");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    const r = await h.api("POST", `/api/orgs/${o.orgId}/intake/url`, {
      token: o.token,
      body: { url: "https://github.com/demo/website.git", branch: "master", name: "website", projectId: p.body.projectId, mountName: "website" },
    });
    expect(r.status).toBe(202);
    await h.drainSteps();
    const file = await h.api("GET", `${P}/file?mount=website&path=index.html`, { token: client.token });
    expect(file.status).toBe(200);
    expect(file.body).toBe("hello");
  });

  it("URL import retry: a mount an earlier attempt already inserted still gives the folder (mounted, no second bump)", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    h.importer.remotes.set("https://github.com/demo/website.git", { master: { "index.html": "hello" } });
    const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Portal" } });
    const pid = p.body.projectId as string;
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const client = await member(h, o, "client");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    const r = await h.api("POST", `/api/orgs/${o.orgId}/intake/url`, {
      token: o.token,
      body: { url: "https://github.com/demo/website.git", branch: "master", name: "website", projectId: pid, mountName: "website" },
    });
    expect(r.status).toBe(202);
    // an earlier attempt of the step inserted the mount and stopped before granting it
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare("INSERT INTO mounts (org_id, project_id, mount_name, resource_id, mode, operations_json, created_at) VALUES (?, ?, 'website', ?, 'must-match-accepted', '[\"read\",\"write\"]', ?)")
      .bind(o.orgId, pid, r.body.resourceId, new Date().toISOString())
      .run();
    const rev = (await h.api("GET", P, { token: o.token })).body.membershipRevision;
    await h.drainSteps();
    const i = await h.api("GET", `/api/orgs/${o.orgId}/intake/${r.body.intakeId}`, { token: o.token });
    expect(i.body.state).toBe("completed");
    expect(i.body.result.mounted).toBe(true);
    expect((await h.api("GET", `${P}/file?mount=website&path=index.html`, { token: client.token })).status).toBe(200);
    expect((await h.api("GET", P, { token: o.token })).body.membershipRevision).toBe(rev);
    // the step running again changes nothing more
    await h.deliver("commonforge-steps", [{ type: "intake.import", orgId: o.orgId, intakeId: r.body.intakeId }]);
    const grants = (await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${client.userId}`, { token: o.token })).body.grants;
    expect(grants.filter((g: any) => g.scope.id === r.body.resourceId).map((g: any) => g.operations)).toEqual([["read"]]);
  });

  it("ZIP confirm attaches with automatic access", async () => {
    const h = harness();
    const runner = new FakeRunner(h, { inventory: { entries: [{ path: "website/index.html", size: 10, sha256: "a".repeat(64) }], rejected: [] } });
    const o = await ownerWithOrg(h);
    const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Portal" } });
    const P = `/api/orgs/${o.orgId}/projects/${p.body.projectId}`;
    const client = await member(h, o, "client");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    const bytes = new TextEncoder().encode("PK\u0003\u0004 fake zip bytes");
    const up = await h.api("POST", `/api/orgs/${o.orgId}/intake/zip?name=portal.zip`, { token: o.token, raw: bytes, headers: { "content-type": "application/zip", "content-length": String(bytes.length) } });
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: o.token })).body.state === "inventoried");
    expect(runner.errors).toEqual([]);
    const ok = await h.api("POST", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}/confirm`, { token: o.token, body: { projectId: p.body.projectId } });
    expect(ok.status).toBe(200);
    const mine = (await h.api("GET", `${P}/access`, { token: o.token })).body.people.find((x: any) => x.userId === client.userId);
    expect(mine.folders.map((f: any) => [f.mountName, f.level])).toEqual([["website", "read"]]);
  });
});
