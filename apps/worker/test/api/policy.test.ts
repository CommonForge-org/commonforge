import { describe, expect, it } from "vitest";
import { codeResource, harness, member, ownerWithOrg, projectWith } from "../helpers.js";
import { isLedgerConflict } from "../../src/services/policy.js";
import { workerName } from "../release-fixtures.js";

async function setup() {
  const h = harness();
  const o = await ownerWithOrg(h);
  const web = await codeResource(h, o, "website", { "index.html": "hi" });
  const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
  return { h, o, pid, P: `/api/orgs/${o.orgId}/projects/${pid}` };
}
const good = { checks: [{ checkId: "build", mountName: "website", command: "pnpm build", timeoutSeconds: 300, required: true }], contracts: [], rules: ["Keep the quote API stable"], approvalRoles: ["owner", "client"], publishRoles: ["owner"] };

describe("policy editing", () => {
  it("validate reports issues by path and never saves", async () => {
    const { h, o, P } = await setup();
    const bad = await h.api("POST", `${P}/policy/validate`, { token: o.token, body: { ...good, checks: [{ checkId: "build", mountName: "website", command: "", timeoutSeconds: 99999 }], approvalRoles: [] } });
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    const paths = bad.body.issues.map((i: any) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["checks.0.command", "checks.0.timeoutSeconds", "approvalRoles"]));
    const ok = await h.api("POST", `${P}/policy/validate`, { token: o.token, body: good });
    expect(ok.body).toEqual({ ok: true, issues: [] });
    expect((await h.api("GET", P, { token: o.token })).body.policyRevision).toBe(0);
  });

  it("validate runs the release-target checks too (path: release)", async () => {
    const { h, o, P } = await setup();
    // schema-valid (a worker target with main, health-checked), so it is assertTargetsAllowed that refuses the name
    const release = {
      recipe: { recipeId: "r", revision: 1, steps: [{ stepId: "b", mountName: "website", command: "pnpm build" }] },
      targets: [{ targetId: "site", kind: "worker", mountName: "website", outputPath: "dist", main: "index.js", workerName: "someone-elses-worker" }],
      environment: {},
      healthCheck: { targetId: "site", path: "/version" },
    };
    const r = await h.api("POST", `${P}/policy/validate`, { token: o.token, body: { ...good, release } });
    expect(r.body.ok).toBe(false);
    expect(r.body.issues).toEqual([{ path: "release", message: expect.stringContaining("must be named") }]);
  });

  it("validate is owner-only", async () => {
    const { h, o, P } = await setup();
    const dev = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } });
    expect((await h.api("POST", `${P}/policy/validate`, { token: dev.token, body: good })).status).toBe(403);
  });

  it("a stale expectedRevision is refused with the current revision; a current one saves", async () => {
    const { h, o, P } = await setup();
    const first = await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, expectedRevision: 0 } });
    expect(first.status).toBe(200);
    expect(first.body.policyRevision).toBe(1);
    expect(first.body.policy).not.toHaveProperty("expectedRevision");
    const stale = await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, rules: [], expectedRevision: 0 } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("policy_changed");
    expect(stale.body.error.details.policyRevision).toBe(1);
    expect((await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, rules: [] } })).status).toBe(200);
  });

  it("the project says who last changed the policy, to owners and developers", async () => {
    const { h, o, P } = await setup();
    await h.api("PUT", `${P}/policy`, { token: o.token, body: good });
    const p = await h.api("GET", P, { token: o.token });
    const me = await h.api("GET", "/api/me", { token: o.token });
    expect(p.body.policyChanged).toEqual({ at: expect.any(String), by: me.body.user.email });
    const client = await member(h, o, "client");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: client.userId, level: "read" } });
    expect((await h.api("GET", P, { token: client.token })).body).not.toHaveProperty("policyChanged");
  });
  it("a stale save changes nothing: GET shows the same policy and revision", async () => {
    const { h, o, P } = await setup();
    await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, expectedRevision: 0 } });
    const before = (await h.api("GET", P, { token: o.token })).body;
    const stale = await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, rules: ["Mine"], approvalRoles: ["owner"], expectedRevision: 0 } });
    expect(stale.status).toBe(409);
    const after = (await h.api("GET", P, { token: o.token })).body;
    expect(after.policyRevision).toBe(before.policyRevision);
    expect(after.policy).toEqual(before.policy);
    expect(after.policyChanged).toEqual(before.policyChanged);
  });

  it("developers with the project see who last changed the policy", async () => {
    const { h, o, P } = await setup();
    await h.api("PUT", `${P}/policy`, { token: o.token, body: good });
    const dev = await member(h, o, "developer");
    await h.api("PUT", `${P}/access`, { token: o.token, body: { userId: dev.userId, level: "read" } });
    const me = await h.api("GET", "/api/me", { token: o.token });
    const p = (await h.api("GET", P, { token: dev.token })).body;
    expect(p.policy.rules).toEqual(good.rules);
    expect(p.policyChanged).toEqual({ at: expect.any(String), by: me.body.user.email });
  });

  it("production releases bind only org-owned D1 (with release.migrations) and never carry data files: validate and PUT agree", async () => {
    const { h, o, P } = await setup();
    const base = {
      recipe: { recipeId: "r", revision: 1, steps: [{ stepId: "b", mountName: "website", command: "pnpm build" }] },
      targets: [{ targetId: "api", kind: "worker", mountName: "website", outputPath: "dist", main: "index.js", workerName: workerName(o.orgId, "api") }],
      healthCheck: { targetId: "api", path: "/version" },
    };
    // a D1 id the platform did not create for this org: 403 binding_not_allowed
    const foreign = { ...base, environment: { api: { vars: {}, kvNamespaces: [], d1Databases: [{ binding: "DB", id: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" }] } } };
    const vf = await h.api("POST", `${P}/policy/validate`, { token: o.token, body: { ...good, release: foreign } });
    expect(vf.body).toEqual({ ok: false, issues: [{ path: "release", message: expect.stringContaining("was not created by CommonForge") }] });
    const pf = await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, release: foreign } });
    expect([pf.status, pf.body.error.code]).toEqual([403, "binding_not_allowed"]);
    // `data` is derived by the Worker from release.migrations; a policy cannot set it (400)
    const data = { ...base, environment: { api: { vars: {}, kvNamespaces: [], data: ["migrations"] } } };
    const vd = await h.api("POST", `${P}/policy/validate`, { token: o.token, body: { ...good, release: data } });
    expect(vd.body.issues).toEqual([{ path: "release.environment.api.data", message: expect.stringContaining("release.migrations") }]);
    expect((await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, release: data } })).status).toBe(400);
    // compatibility flags are platform-set for staging; production takes the source's wrangler.jsonc (400)
    const flags = { ...base, environment: { api: { vars: {}, kvNamespaces: [], compatibilityFlags: ["global_fetch_strictly_public"] } } };
    const vc = await h.api("POST", `${P}/policy/validate`, { token: o.token, body: { ...good, release: flags } });
    expect(vc.body.issues).toEqual([{ path: "release.environment.api.compatibilityFlags", message: expect.stringContaining("wrangler.jsonc") }]);
    expect((await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, release: flags } })).status).toBe(400);
    expect((await h.api("GET", P, { token: o.token })).body.policyRevision).toBe(0);
    // an org-owned D1 with its migrations folder is accepted
    const d1 = await h.api("POST", `/api/orgs/${o.orgId}/deploy-resources`, { token: o.token, body: { kind: "d1", name: "contacts" } });
    expect(d1.status).toBe(201);
    const owned = { ...base, environment: { api: { vars: {}, kvNamespaces: [], d1Databases: [{ binding: "DB", id: d1.body.id }] } }, migrations: [{ targetId: "api", binding: "DB", dir: "migrations" }] };
    expect((await h.api("POST", `${P}/policy/validate`, { token: o.token, body: { ...good, release: owned } })).body).toEqual({ ok: true, issues: [] });
    const put = await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, release: owned } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    // empty lists are fine (they are the same as absent)
    const okRelease = { ...base, environment: { api: { vars: {}, kvNamespaces: [], d1Databases: [], data: [] } } };
    expect((await h.api("POST", `${P}/policy/validate`, { token: o.token, body: { ...good, release: okRelease } })).body).toEqual({ ok: true, issues: [] });
  });

  it("production release Workers may not be named *-staging (reserved for staging): validate and PUT both refuse", async () => {
    const { h, o, P } = await setup();
    const release = {
      recipe: { recipeId: "r", revision: 1, steps: [{ stepId: "b", mountName: "website", command: "pnpm build" }] },
      targets: [
        { targetId: "api", kind: "worker", mountName: "website", outputPath: "dist", main: "index.js", workerName: workerName(o.orgId, "api") },
        { targetId: "stg", kind: "worker", mountName: "website", outputPath: "dist", main: "index.js", workerName: workerName(o.orgId, "api-staging") },
      ],
      environment: {},
      healthCheck: { targetId: "api", path: "/version" },
    };
    const v = await h.api("POST", `${P}/policy/validate`, { token: o.token, body: { ...good, release } });
    expect(v.body).toEqual({ ok: false, issues: [{ path: "release.targets.1.workerName", message: expect.stringContaining("reserved for staging") }] });
    const put = await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, release } });
    expect(put.status).toBe(400);
    expect(JSON.stringify(put.body)).toContain("reserved for staging");
    expect((await h.api("GET", P, { token: o.token })).body.policyRevision).toBe(0);
  });

  it("a Worker quota refusal is an issue at release for validate, and the same 409 for PUT", async () => {
    const { h, o, P } = await setup();
    // six distinct, correctly named Workers: past the org's quota of five (assertOrgWorkerQuota)
    const targets = ["a", "b", "c", "d", "e", "f"].map((n) => ({ targetId: n, kind: "worker", mountName: "website", outputPath: "dist", main: "index.js", workerName: workerName(o.orgId, n) }));
    const release = { recipe: { recipeId: "r", revision: 1, steps: [{ stepId: "b", mountName: "website", command: "pnpm build" }] }, targets, environment: {}, healthCheck: { targetId: "a", path: "/version" } };
    const v = await h.api("POST", `${P}/policy/validate`, { token: o.token, body: { ...good, release } });
    expect(v.body).toEqual({ ok: false, issues: [{ path: "release", message: expect.stringContaining("at most 5") }] });
    const put = await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, release } });
    expect([put.status, put.body.error.code]).toEqual([409, "quota_exceeded"]);
    expect((await h.api("GET", P, { token: o.token })).body.policyRevision).toBe(0);
  });

  it("a ledger refusal (the ledger's revision is already ahead) is 409 policy_changed with the current revision", async () => {
    const { h, o, pid, P } = await setup();
    await h.api("PUT", `${P}/policy`, { token: o.token, body: good });
    // another save got to the ledger first (revision 3) while the directory still says 1
    const { env } = await import("cloudflare:workers");
    const { createServices } = await import("../../src/context.js");
    await createServices(env, h.deps).ledger(o.orgId).setPolicyRevision(o.orgId, pid, 3);
    const r = await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...good, rules: [] } });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error.code).toBe("policy_changed");
    expect(r.body.error.details.policyRevision).toBe(1);
    const after = (await h.api("GET", P, { token: o.token })).body;
    expect([after.policyRevision, after.policy.rules]).toEqual([1, good.rules]);
  });
});

describe("isLedgerConflict", () => {
  it("matches only a ledger_conflict RPC refusal", () => {
    expect(isLedgerConflict(new Error("ledger_conflict: policy revision for p cannot decrease (3 -> 2)"))).toBe(true);
    expect(isLedgerConflict(new Error("ledger_internal: boom"))).toBe(false);
    expect(isLedgerConflict(new Error("conflict: ledger_conflict"))).toBe(false);
    expect(isLedgerConflict("ledger_conflict: as a string")).toBe(true);
  });
});
