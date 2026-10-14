/**
 * The "Demo Client / Customer Portal" project on the CI deployment, built from fixtures/ through the
 * product API (plus one operator genesis push per git resource): org, client member, project,
 * resources website/api/requirements (Artifacts) and brand-assets (R2), mounts, client grants (read; with staging, Can change on the git folders),
 * the org's KV, and the policy (contract check, approval/publish roles, preview and release recipes).
 * Shared by e2e.ts and rehearsal.ts.
 */
import { join } from "node:path";
import { ArtifactsOperator, Client, Evidence, PROTECTED_ORGS, RELEASE_PREFIX, TARGET, copyFixture, poll } from "./lib.ts";
import { isOrgResource, listAllPages, orgWorkers } from "./names.ts";
import { STAGING_CAPTURE_VARS, STAGING_PROMOTION, stagingEnvironment } from "../../video/scripts/seed-demo-policy.ts";

export const MOUNTS = ["website", "api", "requirements"] as const;
const enc = encodeURIComponent;

export interface DemoProject {
  orgId: string;
  projectId: string;
  clientUserId: string;
  res: Record<string, any>;
  kvId: string;
  /** the org D1 bound in production (only when set up with `staging`) */
  d1Id?: string;
  apiWorker: string;
  siteWorker: string;
  workersDevSubdomain: string;
}

/** Recipe install step. pnpm's one-day release-age policy: the fixtures pin
 * @cloudflare/workers-types@5.20261006.1 (published 2026-10-06 01:25 UTC); drop the env once that
 * version is older than a day. */
const install = (mountName: string) => ({
  stepId: `${mountName === "api" ? "api" : "site"}-install`,
  mountName,
  command: "pnpm install --frozen-lockfile --ignore-scripts",
  env: { PNPM_CONFIG_MINIMUM_RELEASE_AGE: "0" },
});
const noVerify = { PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false" };

/**
 * The demo project's policy. `staging` is opt-in (default off): enabling it creates
 * `<workerName>-staging` Workers and per-project staging D1/KV, which cleanupRun and sweep.ts remove
 * (by the `<prefix>-<orgId>-` / `<prefix>-o-` name prefixes, names.ts).
 * With `staging` on and `p.d1Id` given (an org D1 created through POST deploy-resources kind d1 in
 * the same setup), the production release also binds it as `DB` and `release.migrations` names the
 * api `migrations` folder, so a promotion applies migrations to production before the code.
 * Staging starts only after the owner's baseline (an owner publish of the current `main`): with
 * `staging` on, `setupDemoProject` publishes it right after the policy is saved.
 */
export function demoPolicy(p: { res: Record<string, any>; apiWorker: string; siteWorker: string; sub: string; kvId: string; d1Id?: string }, opts: { staging?: boolean } = {}) {
  const withD1 = !!opts.staging && !!p.d1Id;
  const releaseRecipe = {
    recipeId: "ci-release", revision: 1, steps: [
      install("api"),
      { stepId: "api-bundle", mountName: "api", command: "pnpm exec wrangler deploy --dry-run --outdir dist", env: noVerify },
      install("website"),
      { stepId: "site-build", mountName: "website", command: "pnpm exec vite build", env: { ...noVerify, VITE_QUOTE_API_URL: `https://${p.apiWorker}.${p.sub}.workers.dev` } },
    ],
  };
  // Staging builds the same website against the staging API Worker (`<apiWorker>-staging`).
  const stagingRecipe = {
    ...releaseRecipe,
    recipeId: "ci-staging",
    steps: releaseRecipe.steps.map((s) =>
      s.stepId === "site-build" ? { ...s, env: { ...s.env, VITE_QUOTE_API_URL: `https://${p.apiWorker}-staging.${p.sub}.workers.dev` } } : s,
    ),
  };
  // Staging D1/KV and seed data: platform-created per project, never production ids. Production D1
  // (an org-owned database: `release.environment.api.d1Databases` and `release.migrations` below) is
  // bound only with `withD1`, behind the same staging opt-in; production is never seeded.
  const staging = {
    recipe: stagingRecipe,
    environment: stagingEnvironment(),
    captureVars: STAGING_CAPTURE_VARS,
    // the spec's demo rules, one source with the recording seed (video/scripts/seed-demo-policy.ts)
    promotion: STAGING_PROMOTION,
  };
  return {
    checks: [{ checkId: "quote-contract", mountName: "website", command: "pnpm exec vitest run tests/quote-contract.test.ts", timeoutSeconds: 300 }],
    contracts: [{
      contractId: "quote", version: "1", producerResource: p.res.api.resourceId, consumerResource: p.res.website.resourceId,
      schema: { resourceId: p.res.requirements.resourceId, path: "contracts/quote.schema.json" },
      producerOutput: { mountName: "api", command: "node scripts/quote-sample.ts" },
    }],
    rules: ["GET /quote responses must match requirements/contracts/quote.schema.json"],
    approvalRoles: ["owner", "client"],
    publishRoles: ["owner"],
    preview: {
      recipe: { recipeId: "ci-preview", revision: 1, steps: [
        install("api"),
        { stepId: "api-bundle", mountName: "api", command: "pnpm exec wrangler deploy --dry-run --outdir dist", env: noVerify },
        install("website"),
        { stepId: "site-build", mountName: "website", command: "pnpm exec vite build --base ./", env: { ...noVerify, VITE_QUOTE_API_URL: "./api" } },
      ], output: { mountName: "website", path: "dist" } },
      bundles: [{ name: "api", mountName: "api", path: "dist" }],
      hostVars: { APP_VERSION: "preview" },
      ttlSeconds: 3600,
    },
    release: {
      recipe: releaseRecipe,
      targets: [
        { targetId: "api", kind: "worker", mountName: "api", outputPath: "dist", main: "index.js", workerName: p.apiWorker },
        { targetId: "website", kind: "assets", mountName: "website", outputPath: "dist", workerName: p.siteWorker },
      ],
      environment: { api: { vars: { APP_VERSION: "1.0.0" }, kvNamespaces: [{ binding: "ORDERS", id: p.kvId }], ...(withD1 ? { d1Databases: [{ binding: "DB", id: p.d1Id }] } : {}) } },
      healthCheck: { targetId: "api", path: "/version" },
      ...(withD1 ? { migrations: [{ targetId: "api", binding: "DB", dir: "migrations" }] } : {}),
    },
    ...(opts.staging ? { staging } : {}),
  };
}

/**
 * Create the org (as `owner`), add `clientEmail` as a client, and build the project. `onOrg` is
 * called as soon as the org exists (so a failing run can still be cleaned up).
 */
export async function setupDemoProject(o: {
  ev: Evidence; owner: Client; op: ArtifactsOperator; runDir: string; orgName: string; clientEmail: string; onOrg?: (orgId: string) => void; onKv?: (id: string) => void; onD1?: (id: string) => void;
  /** also create the production D1 and put staging (with production migrations) in the policy; default off */
  staging?: boolean;
}): Promise<DemoProject> {
  const { ev, owner, op } = o;
  const org = await ev.step("create org", () => owner.req("POST", "/api/orgs", { name: o.orgName }), (x) => x);
  const orgId: string = org.orgId;
  o.onOrg?.(orgId);
  const O = `/api/orgs/${enc(orgId)}`;
  const clientMember = await ev.step("add client member", () => owner.req("POST", `${O}/members`, { email: o.clientEmail, role: "client" }), (m) => ({ userId: m.userId, role: m.role }));
  const project = await ev.step("create project", () => owner.req("POST", `${O}/projects`, { name: "Customer Portal" }), (p) => p);
  const pid: string = project.projectId;
  const P = `${O}/projects/${enc(pid)}`;
  const res: Record<string, any> = {};
  for (const m of MOUNTS) {
    res[m] = await ev.step(`resource ${m}: create, genesis push (x-token basic auth), adopt-head, mount`, async () => {
      const r = await owner.req("POST", `${O}/resources`, { name: m, provider: "artifacts" });
      const dir = join(o.runDir, "genesis", m);
      const files = await copyFixture(m, dir);
      const pushed = await op.genesisPush({ namespace: r.coords.namespace, repoName: r.coords.repoName, remoteUrl: r.coords.remoteUrl, dir, work: join(o.runDir, "genesis") });
      const head = await owner.req("POST", `${O}/resources/${enc(r.resourceId)}/adopt-head`, {});
      await owner.req("POST", `${P}/mounts`, { mountName: m, resourceId: r.resourceId, operations: ["read", "write"] });
      return { ...r, files: files.length, genesisSha: pushed.sha, username: pushed.username, head };
    }, (v) => ({ resourceId: v.resourceId, files: v.files, genesisSha: v.genesisSha, gitUsername: v.username, namespace: v.coords.namespace }));
  }
  res["brand-assets"] = await ev.step("resource brand-assets (R2) + mount", async () => {
    const r = await owner.req("POST", `${O}/resources`, { name: "brand-assets", provider: "r2-assets" });
    await owner.req("POST", `${P}/mounts`, { mountName: "brand-assets", resourceId: r.resourceId, operations: ["read", "write"] });
    return r;
  }, (v) => ({ resourceId: v.resourceId }));
  // staging: the client may change the git folders through tasks ("Can change": write on them); else read
  const clientOps = o.staging ? ["read", "write"] : ["read"];
  await ev.step(o.staging ? "client grants (project + git folders Can change, brand-assets read)" : "client read grants (project + resources)", async () => {
    await owner.req("PUT", `${O}/grants`, { userId: clientMember.userId, scope: { kind: "project", id: pid }, operations: clientOps });
    for (const m of MOUNTS) await owner.req("PUT", `${O}/grants`, { userId: clientMember.userId, scope: { kind: "resource", id: res[m].resourceId }, operations: clientOps });
    await owner.req("PUT", `${O}/grants`, { userId: clientMember.userId, scope: { kind: "resource", id: res["brand-assets"].resourceId }, operations: ["read"] });
  });
  const kv = await ev.step("deploy resource: KV orders", () => owner.req("POST", `${O}/deploy-resources`, { kind: "kv", name: "orders" }), (k) => ({ title: k.title, id: k.id }));
  o.onKv?.(kv.id);
  const d1 = o.staging ? await ev.step("deploy resource: D1 contacts (production database)", () => owner.req("POST", `${O}/deploy-resources`, { kind: "d1", name: "contacts" }), (d) => ({ title: d.title, id: d.id })) : undefined;
  if (d1) o.onD1?.(d1.id);
  const sub = "commonforge";
  const apiWorker = `${RELEASE_PREFIX}-${orgId}-api`;
  const siteWorker = `${RELEASE_PREFIX}-${orgId}-website`;
  await ev.step("policy (checks, contract, approval/publish roles, preview, release)", () => owner.req("PUT", `${P}/policy`, demoPolicy({ res, apiWorker, siteWorker, sub, kvId: kv.id, d1Id: d1?.id }, { staging: o.staging })), (r) => ({ policyRevision: r.policyRevision }));
  if (o.staging) {
    await ev.step("baseline: owner publishes main to production (staging starts after it)", async () => {
      const r = await owner.req("POST", `${P}/releases`, {});
      const built = await poll("baseline release build", () => owner.req("GET", `${O}/releases/${enc(r.releaseId)}`), (v) => v.buildState !== "building", 25 * 60_000, 5000);
      if (built.buildState !== "built") throw new Error(`baseline release build ${built.buildState}: ${JSON.stringify(built.error)}`);
      await owner.req("POST", `${O}/releases/${enc(r.releaseId)}/publish-approvals`, { outputDigest: built.outputDigest });
      await owner.req("POST", `${O}/releases/${enc(r.releaseId)}/deploy`, { idempotencyKey: "baseline-" + orgId });
      const done = await poll("baseline release live", () => owner.req("GET", `${O}/releases/${enc(r.releaseId)}`), (v) => ["live", "failed", "recovery_required", "partial"].includes(v.state), 20 * 60_000, 5000);
      if (done.state !== "live") throw new Error(`baseline release ${done.state}: ${JSON.stringify(done.error)}`);
      const st = await poll("staging baseline", () => owner.req("GET", `${P}/staging`), (v) => v.state === "active", 5 * 60_000, 3000);
      return { releaseId: r.releaseId, state: st.state };
    }, (v) => v);
  }
  return { orgId, projectId: pid, clientUserId: clientMember.userId, res, kvId: kv.id, ...(d1 ? { d1Id: d1.id } : {}), apiWorker, siteWorker, workersDevSubdomain: sub };
}

/**
 * Per-run cleanup: the release Workers and their `-staging` copies, then every D1 database and KV
 * namespace of the org (name/title `<prefix>-<orgId>-`: the org KV and D1 and the platform's staging
 * D1/KV), its Artifacts namespaces, and the sessions. Workers go first, so no Worker still binds a
 * database being deleted. `kvId`/`d1Id` (when known) are deleted even if the listing missed them.
 * Production (`--target production`): the canonical namespace stays (the org's ledger data points at
 * it), only the task and edition repos go, and the sessions are the person's own `cforge login`
 * sessions, so they are never logged out.
 */
export async function cleanupRun(o: { ev: Evidence; op: ArtifactsOperator; orgId: string; kvId: string; d1Id?: string; sessions: Array<Client | undefined> }): Promise<void> {
  if (PROTECTED_ORGS.includes(o.orgId)) throw new Error(`refusing to clean up protected org ${o.orgId}`);
  const prod = TARGET === "production";
  await o.ev.step(prod ? "cleanup: release + staging Workers, the run's D1/KV by id, task + edition repos (canonical repos and sessions kept)" : "cleanup: release + staging Workers, org D1/KV, Artifacts namespaces, sessions", async () => {
    const out: Record<string, unknown> = {};
    const err = (e: any) => String(e?.message).slice(0, 200);
    for (const w of orgWorkers(RELEASE_PREFIX, o.orgId)) {
      out[w] = await o.op.call("DELETE", `/workers/scripts/${w}?force=true`).then(() => "deleted", (e: any) => (e?.status === 404 ? "absent" : err(e)));
    }
    const d1 = new Map<string, string>(o.d1Id ? [[o.d1Id, o.d1Id]] : []);
    const kv = new Map<string, string>(o.kvId ? [[o.kvId, o.kvId]] : []);
    // production (review I2): only the D1/KV this run names by id, never by name prefix, so a mistyped
    // org id given to cleanup-org.ts can not delete a real org's databases
    if (!prod) try {
      for (const db of await listAllPages((page, per) => o.op.call<Array<{ uuid: string; name: string }>>("GET", `/d1/database?page=${page}&per_page=${per}`)))
        if (isOrgResource(db.name, RELEASE_PREFIX, o.orgId)) d1.set(db.uuid, db.name);
    } catch (e) {
      out.d1List = err(e);
    }
    if (!prod) try {
      for (const ns of await listAllPages((page, per) => o.op.call<Array<{ id: string; title: string }>>("GET", `/storage/kv/namespaces?page=${page}&per_page=${per}`)))
        if (isOrgResource(ns.title, RELEASE_PREFIX, o.orgId)) kv.set(ns.id, ns.title);
    } catch (e) {
      out.kvList = err(e);
    }
    for (const [id, name] of d1) out[`d1 ${name}`] = await o.op.call("DELETE", `/d1/database/${id}`).then(() => "deleted", (e: any) => (e?.status === 404 ? "absent" : err(e)));
    for (const [id, title] of kv) out[`kv ${title}`] = await o.op.call("DELETE", `/storage/kv/namespaces/${id}`).then(() => "deleted", (e: any) => (e?.status === 404 ? "absent" : err(e)));
    out.namespaces = await o.op.deleteOrgNamespaces(o.orgId, prod ? ["tasks", "editions"] : undefined).catch(err);
    if (!prod) for (const c of o.sessions) if (c) await c.req("POST", "/api/auth/logout", {}).catch(() => undefined);
    return out;
  }, (v) => v).catch(() => undefined);
}
