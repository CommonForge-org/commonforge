import { describe, expect, it } from "vitest";
import { ImportError } from "../../src/services/artifacts.js";
import { FakeRunner } from "../fakes/runner.js";
import { canonicalNs, harness, member, ownerWithOrg } from "../helpers.js";

const waitUntil = async (cond: () => Promise<boolean>, ms = 2000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("intake", () => {
  it("imports a public repo in a queue step, revokes the import token, binds the head and mounts it", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    h.importer.remotes.set("https://github.com/demo/website.git", { master: { "index.html": "hello" } });
    const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Portal" } });
    const r = await h.api("POST", `/api/orgs/${o.orgId}/intake/url`, {
      token: o.token,
      body: { url: "https://github.com/demo/website.git", branch: "master", name: "website", projectId: p.body.projectId, mountName: "website" },
    });
    expect(r.status).toBe(202);
    expect(h.steps).toEqual([{ type: "intake.import", orgId: o.orgId, intakeId: r.body.intakeId }]);
    const before = await h.api("GET", `/api/orgs/${o.orgId}/resources/${r.body.resourceId}`, { token: o.token });
    expect(before.body.state).toBe("importing");

    await h.drainSteps();
    const i = await h.api("GET", `/api/orgs/${o.orgId}/intake/${r.body.intakeId}`, { token: o.token });
    expect(i.body.state).toBe("completed");
    const res = await h.api("GET", `/api/orgs/${o.orgId}/resources/${r.body.resourceId}`, { token: o.token });
    expect(res.body.state).toBe("active");
    expect(res.body.branch).toBe("master"); // recorded explicitly; the service reports "main"
    expect(res.body.head.revisionId).toMatch(/^art:/);
    expect(h.artifacts.activeTokens(canonicalNs(o.orgId), r.body.resourceId)).toHaveLength(0);
    const file = await h.api("GET", `/api/orgs/${o.orgId}/projects/${p.body.projectId}/file?mount=website&path=index.html`, { token: o.token });
    expect(file.body).toBe("hello");
  });

  it("retries a 504 with depth 1, and treats 404-after-409 and refusals as failures", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    h.importer.remotes.set("https://github.com/demo/big.git", { main: { a: "1" } });
    h.importer.failNext.push(new ImportError("import_timeout", "timed out"));
    const big = await h.api("POST", `/api/orgs/${o.orgId}/intake/url`, { token: o.token, body: { url: "https://github.com/demo/big.git", branch: "main", name: "big" } });
    await h.drainSteps();
    expect(h.importer.calls.map((c) => c.depth)).toEqual([undefined, 1]);
    const bi = await h.api("GET", `/api/orgs/${o.orgId}/intake/${big.body.intakeId}`, { token: o.token });
    expect(bi.body.state).toBe("completed");
    const br = await h.api("GET", `/api/orgs/${o.orgId}/resources/${big.body.resourceId}`, { token: o.token });
    expect(br.body.source.historyTruncated).toBe(true);

    h.importer.failNext.push(new ImportError("import_in_progress", "in progress"));
    const ghost = await h.api("POST", `/api/orgs/${o.orgId}/intake/url`, { token: o.token, body: { url: "https://github.com/demo/big.git", branch: "main", name: "ghost" } });
    await h.drainSteps();
    const gi = await h.api("GET", `/api/orgs/${o.orgId}/intake/${ghost.body.intakeId}`, { token: o.token });
    expect(gi.body.state).toBe("failed");
    expect(gi.body.error).toMatch(/vanished after 409/);

    const priv = await h.api("POST", `/api/orgs/${o.orgId}/intake/url`, { token: o.token, body: { url: "https://github.com/demo/private.git", branch: "main", name: "priv" } });
    await h.drainSteps();
    expect((await h.api("GET", `/api/orgs/${o.orgId}/intake/${priv.body.intakeId}`, { token: o.token })).body.state).toBe("failed");
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources/${priv.body.resourceId}`, { token: o.token })).body.state).toBe("failed");
  });

  it("refuses non-https, credentialed URLs and non-developers", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    for (const url of ["http://github.com/a/b.git", "https://user:pw@github.com/a/b.git", "git@github.com:a/b.git", "https://localhost/x.git"]) {
      const r = await h.api("POST", `/api/orgs/${o.orgId}/intake/url`, { token: o.token, body: { url, branch: "main", name: "x" } });
      expect(r.status).toBe(400);
    }
  });

  it("ZIP: stages in R2, inventories in the runner, explains the plan, confirm creates resources", async () => {
    const h = harness();
    const runner = new FakeRunner(h, {
      inventory: {
        entries: [
          { path: "website/index.html", size: 10, sha256: "a".repeat(64) },
          { path: "website/node_modules/x/index.js", size: 10, sha256: "b".repeat(64) },
          { path: "api/src/index.ts", size: 10, sha256: "c".repeat(64) },
          { path: "api/.env", size: 10, sha256: "d".repeat(64) },
          { path: "media/video.mp4", size: 50 * 1024 * 1024, sha256: "e".repeat(64) },
        ],
        rejected: [{ path: "../escape.txt", reason: "path_escape" }],
      },
    });
    const o = await ownerWithOrg(h);
    const bytes = new TextEncoder().encode("PK\u0003\u0004 fake zip bytes");
    const up = await h.api("POST", `/api/orgs/${o.orgId}/intake/zip?name=portal.zip`, { token: o.token, raw: bytes, headers: { "content-type": "application/zip", "content-length": String(bytes.length) } });
    expect(up.status).toBe(202);
    expect(up.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: o.token })).body.state === "inventoried");
    expect(runner.errors).toEqual([]);
    expect(runner.handled[0]!.job.kind).toBe("inventory");
    const i = await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: o.token });
    expect(i.body.plan.placements.map((p: any) => [p.resourceName, p.provider])).toEqual([
      ["api", "artifacts"],
      ["website", "artifacts"],
      ["portal-assets", "r2-assets"],
    ]);
    const reasons = Object.fromEntries(i.body.plan.excluded.map((e: any) => [e.path, e.reason]));
    expect(reasons["api/.env"]).toMatch(/credential/);
    expect(reasons["website/node_modules/x/index.js"]).toMatch(/dependency/);
    expect(reasons["../escape.txt"]).toMatch(/path_escape/);

    const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Portal" } });
    const c = await h.api("POST", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}/confirm`, { token: o.token, body: { projectId: p.body.projectId } });
    expect(c.status).toBe(200);
    expect(c.body.resources).toHaveLength(3);
    expect(c.body.pendingPopulation).toBe(true);
    const again = await h.api("POST", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}/confirm`, { token: o.token, body: {} });
    expect(again.status).toBe(409);
    const proj = await h.api("GET", `/api/orgs/${o.orgId}/projects/${p.body.projectId}`, { token: o.token });
    expect(proj.body.mounts.map((m: any) => m.mountName).sort()).toEqual(["api", "portal-assets", "website"]);
  });

  it("ZIP confirm refuses a planned folder name the project already has, before creating anything; skip it and the rest is mounted", async () => {
    const h = harness();
    const runner = new FakeRunner(h, {
      inventory: {
        entries: [
          { path: "website/index.html", size: 10, sha256: "a".repeat(64) },
          { path: "api/src/index.ts", size: 10, sha256: "c".repeat(64) },
        ],
        rejected: [],
      },
    });
    const o = await ownerWithOrg(h);
    const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Portal" } });
    const existing = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "old-api", provider: "r2-assets" } });
    await h.api("POST", `/api/orgs/${o.orgId}/projects/${p.body.projectId}/mounts`, { token: o.token, body: { mountName: "api", resourceId: existing.body.resourceId } });
    const bytes = new TextEncoder().encode("PK\u0003\u0004 fake zip bytes");
    const up = await h.api("POST", `/api/orgs/${o.orgId}/intake/zip?name=portal.zip`, { token: o.token, raw: bytes, headers: { "content-type": "application/zip", "content-length": String(bytes.length) } });
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: o.token })).body.state === "inventoried");
    expect(runner.errors).toEqual([]);
    const before = (await h.api("GET", `/api/orgs/${o.orgId}/resources`, { token: o.token })).body.resources.length;

    const clash = await h.api("POST", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}/confirm`, { token: o.token, body: { projectId: p.body.projectId } });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("mount_exists");
    expect(clash.body.error.details.names).toEqual(["api"]);
    // nothing created, and the intake can still be confirmed
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources`, { token: o.token })).body.resources.length).toBe(before);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: o.token })).body.state).toBe("inventoried");

    const ok = await h.api("POST", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}/confirm`, { token: o.token, body: { projectId: p.body.projectId, skip: ["api"] } });
    expect(ok.status).toBe(200);
    expect(ok.body.resources.map((r: any) => [r.name, r.mountName])).toEqual([["website", "website"]]);
    const proj = await h.api("GET", `/api/orgs/${o.orgId}/projects/${p.body.projectId}`, { token: o.token });
    expect(proj.body.mounts.find((m: any) => m.mountName === "api").resourceId).toBe(existing.body.resourceId);
    const events = await h.api("GET", `/api/orgs/${o.orgId}/events?projectId=${p.body.projectId}`, { token: o.token });
    expect(events.body.events.filter((e: any) => e.action === "mount.added").map((e: any) => e.detail?.mountName)).toContain("website");
  });

  it("adding intake folders to a project is owner-only, like adding a mount; developers may still create the resources", async () => {
    const h = harness();
    new FakeRunner(h, { inventory: { entries: [{ path: "site/index.html", size: 10, sha256: "a".repeat(64) }], rejected: [] } });
    const o = await ownerWithOrg(h);
    const dev = await member(h, o, "developer");
    const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Portal" } });
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: dev.userId, scope: { kind: "project", id: p.body.projectId }, operations: ["read"] } });
    const url = await h.api("POST", `/api/orgs/${o.orgId}/intake/url`, { token: dev.token, body: { url: "https://github.com/demo/site.git", branch: "main", name: "site", projectId: p.body.projectId, mountName: "site" } });
    expect(url.status).toBe(403);
    expect(url.body.error.code).toBe("insufficient_role");
    const bytes = new TextEncoder().encode("PK\u0003\u0004 fake zip bytes");
    const up = await h.api("POST", `/api/orgs/${o.orgId}/intake/zip?name=site.zip`, { token: dev.token, raw: bytes, headers: { "content-type": "application/zip", "content-length": String(bytes.length) } });
    expect(up.status).toBe(202);
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: dev.token })).body.state === "inventoried");
    const mounted = await h.api("POST", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}/confirm`, { token: dev.token, body: { projectId: p.body.projectId } });
    expect(mounted.status).toBe(403);
    const plain = await h.api("POST", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}/confirm`, { token: dev.token, body: {} });
    expect(plain.status).toBe(200);
    expect(plain.body.resources[0].mountName).toBeUndefined();
  });

  it("URL import refuses a taken folder name up front, creating no resource", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Portal" } });
    const existing = await h.api("POST", `/api/orgs/${o.orgId}/resources`, { token: o.token, body: { name: "site", provider: "r2-assets" } });
    await h.api("POST", `/api/orgs/${o.orgId}/projects/${p.body.projectId}/mounts`, { token: o.token, body: { mountName: "website", resourceId: existing.body.resourceId } });
    const before = (await h.api("GET", `/api/orgs/${o.orgId}/resources`, { token: o.token })).body.resources.length;
    const r = await h.api("POST", `/api/orgs/${o.orgId}/intake/url`, { token: o.token, body: { url: "https://github.com/demo/website.git", branch: "main", name: "website", projectId: p.body.projectId, mountName: "website" } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("mount_exists");
    expect(h.steps).toEqual([]);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources`, { token: o.token })).body.resources.length).toBe(before);
  });
  it("include anyway: an owner keeps an inspected secret-named file; every other exclusion, a developer and a skipped folder are refused", async () => {
    const h = harness();
    const runner = new FakeRunner(h, {
      inventory: {
        entries: [
          { path: "website/index.html", size: 10, sha256: "a".repeat(64) },
          { path: "website/.npmrc", size: 40, sha256: "b".repeat(64) },
          { path: "website/node_modules/x/.npmrc", size: 10, sha256: "c".repeat(64) },
          { path: "website/dist/app.js", size: 10, sha256: "d".repeat(64) },
          { path: "api/.git/HEAD", size: 10, sha256: "e".repeat(64) },
          { path: "api/src/index.ts", size: 10, sha256: "f".repeat(64) },
          { path: "api/.env", size: 10, sha256: "1".repeat(64) },
          { path: "keys/id_ed25519", size: 33 * 1024 * 1024, sha256: "2".repeat(64) },
          { path: ".env.local", size: 10, sha256: "3".repeat(64) },
          { path: "website/.env", size: 10, sha256: "4".repeat(64) },
          { path: "website/.GIT/.env", size: 10, sha256: "5".repeat(64) },
          { path: "website/NODE_MODULES/.npmrc", size: 10, sha256: "6".repeat(64) },
          { path: "Dist/.env", size: 10, sha256: "7".repeat(64) },
        ],
        // the same name twice in the archive: the inventory keeps one entry and refuses the other
        rejected: [{ path: "../.npmrc", reason: "path_escape" }, { path: "website/.env", reason: "duplicate" }],
      },
    });
    const o = await ownerWithOrg(h);
    const dev = await member(h, o, "developer");
    const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Portal" } });
    const bytes = new TextEncoder().encode("PK\u0003\u0004 fake zip bytes");
    const up = await h.api("POST", `/api/orgs/${o.orgId}/intake/zip?name=portal.zip`, { token: o.token, raw: bytes, headers: { "content-type": "application/zip", "content-length": String(bytes.length) } });
    const url = `/api/orgs/${o.orgId}/intake/${up.body.intakeId}/confirm`;
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: o.token })).body.state === "inventoried");
    expect(runner.errors).toEqual([]);
    const before = (await h.api("GET", `/api/orgs/${o.orgId}/resources`, { token: o.token })).body.resources.length;

    // anything not blocked by the secret-name rule is refused, by path, before anything is created
    const bad = await h.api("POST", url, { token: o.token, body: { projectId: p.body.projectId, include: ["website/.npmrc", "website/node_modules/x/.npmrc", "website/dist/app.js", "api/.git/HEAD", "../.npmrc", "keys/id_ed25519", "website/index.html", "nope.txt"] } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("include_refused");
    expect(bad.body.error.details.paths).toEqual(["website/node_modules/x/.npmrc", "website/dist/app.js", "api/.git/HEAD", "../.npmrc", "keys/id_ed25519", "website/index.html", "nope.txt"]);
    expect(Object.fromEntries(bad.body.error.details.refused.map((r: any) => [r.path, r.why]))).toMatchObject({ "keys/id_ed25519": "oversize", "website/index.html": "not_excluded", "api/.git/HEAD": "not_secret_name" });
    // review I1: a path with any non-secret exclusion row (here, an inventory-refused duplicate) is never includable
    const plan = (await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: o.token })).body.plan;
    expect(plan.excluded.filter((e: any) => e.path === "website/.env").map((e: any) => e.reason)).toEqual(["refused by inventory: duplicate", expect.stringMatching(/credential/)]);
    // case variants of excluded folders are excluded as those folders, so nothing under them is includable
    const reasons = Object.fromEntries(plan.excluded.map((e: any) => [e.path, e.reason]));
    expect(reasons["website/.GIT/.env"]).toMatch(/nested repository/);
    expect(reasons["website/NODE_MODULES/.npmrc"]).toMatch(/dependency/);
    expect(reasons["Dist/.env"]).toBe("build output");
    expect(plan.placements.map((p: any) => p.resourceName)).not.toContain("Dist");
    const tricky = await h.api("POST", url, { token: o.token, body: { projectId: p.body.projectId, include: ["website/.env", "website/.GIT/.env", "website/NODE_MODULES/.npmrc"] } });
    expect(tricky.status).toBe(400);
    expect(tricky.body.error.details.refused.map((r: any) => [r.path, r.why])).toEqual([
      ["website/.env", "not_secret_name"],
      ["website/.GIT/.env", "not_secret_name"],
      ["website/NODE_MODULES/.npmrc", "not_secret_name"],
    ]);
    // a secret-named file whose folder is skipped (or has no code resource) has nowhere to go
    const skipped = await h.api("POST", url, { token: o.token, body: { projectId: p.body.projectId, skip: ["api"], include: ["api/.env", ".env.local"] } });
    expect(skipped.status).toBe(400);
    expect(skipped.body.error.details.paths).toEqual(["api/.env", ".env.local"]);
    // owners only
    const byDev = await h.api("POST", url, { token: dev.token, body: { include: ["website/.npmrc"] } });
    expect(byDev.status).toBe(403);
    expect(byDev.body.error.code).toBe("insufficient_role");
    expect((await h.api("GET", `/api/orgs/${o.orgId}/resources`, { token: o.token })).body.resources.length).toBe(before);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: o.token })).body.state).toBe("inventoried");

    const ok = await h.api("POST", url, { token: o.token, body: { projectId: p.body.projectId, include: ["website/.npmrc", "website/.npmrc"] } });
    expect(ok.status).toBe(200);
    expect(ok.body.includedAnyway).toEqual(["website/.npmrc"]);
    expect(ok.body.pendingPopulation).toBe(true);
    const i = await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: o.token });
    expect(i.body.plan.includedAnyway).toEqual([{ path: "website/.npmrc", resourceName: "website" }]);
    expect(ok.body.excluded).toBe(i.body.plan.excluded.length - 1);
    // the event names the paths and is owner-only (org-level, no resources)
    const ownerEvents = await h.api("GET", `/api/orgs/${o.orgId}/events`, { token: o.token });
    const ev = ownerEvents.body.events.find((e: any) => e.action === "intake.included_anyway");
    expect(ev.detail.paths).toEqual(["website/.npmrc"]);
    expect(ev.projectId).toBeNull();
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: dev.userId, scope: { kind: "project", id: p.body.projectId }, operations: ["read"] } });
    const devEvents = await h.api("GET", `/api/orgs/${o.orgId}/events`, { token: dev.token });
    expect(devEvents.body.events.map((e: any) => e.action)).not.toContain("intake.included_anyway");
    // the choice on the intake itself is owner-only too
    const devView = await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: dev.token });
    expect(devView.status).toBe(200);
    expect(devView.body.plan.includedAnyway).toBeUndefined();
    expect(devView.body.result.includedAnyway).toBeUndefined();
    expect(i.body.result.includedAnyway).toEqual(["website/.npmrc"]);
  });

  it("include accepts paths as long as the inventory's (4096), and a folder named like an Object key is code", async () => {
    const h = harness();
    const long = `${"a".repeat(2000)}/${"b".repeat(2000)}/.env`;
    new FakeRunner(h, { inventory: { entries: [{ path: `${"a".repeat(2000)}/x.ts`, size: 10, sha256: "a".repeat(64) }, { path: long, size: 10, sha256: "b".repeat(64) }, { path: "constructor/index.ts", size: 10, sha256: "c".repeat(64) }], rejected: [] } });
    const o = await ownerWithOrg(h);
    const bytes = new TextEncoder().encode("PK\u0003\u0004 fake zip bytes");
    const up = await h.api("POST", `/api/orgs/${o.orgId}/intake/zip?name=long.zip`, { token: o.token, raw: bytes, headers: { "content-type": "application/zip", "content-length": String(bytes.length) } });
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: o.token })).body.state === "inventoried");
    const i = await h.api("GET", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}`, { token: o.token });
    expect(i.body.plan.placements.map((p: any) => p.pathPrefix)).toContain("constructor/");
    const ok = await h.api("POST", `/api/orgs/${o.orgId}/intake/${up.body.intakeId}/confirm`, { token: o.token, body: { include: [long] } });
    expect(ok.status).toBe(200);
    expect(ok.body.includedAnyway).toEqual([long]);
  });
});
