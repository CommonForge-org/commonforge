/**
 * Task 22: the gated release service.
 * AT-21 hosting separation, AT-33 immutable release identity, AT-34 authorized deployment matches
 * the observed live version, AT-35 deployment failure keeps the previous live pointer and retries
 * without a new acceptance.
 */
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { orgKv, releasePolicy, workerName } from "../release-fixtures.js";
import { freezeAndPropose, harness, member, prepareAndIntegrate, provisionedTask, waitUntil, type Harness } from "../helpers.js";


/** "Production": what each deployed Worker would answer on /version (driven by the fake deploys). */
function liveServices(h: Harness, runner: FakeRunner) {
  const live = new Map<string, Record<string, string>>();
  runner.opts.onDeploy = (name, vars) => live.set(name, vars);
  h.deps.healthFetch = async (url: string) => {
    const name = /^https:\/\/([a-z0-9-]+)\.demo\.workers\.dev\/version$/.exec(url)?.[1];
    const vars = name ? live.get(name) : undefined;
    if (!vars) return new Response("no such worker", { status: 404 });
    return Response.json({ name, version: vars.APP_VERSION, release: vars.COMMONFORGE_RELEASE_ID ?? null });
  };
  return live;
}

async function setup(h: Harness, policy: Record<string, unknown> = {}) {
  const t = await provisionedTask(h);
  const kv = await orgKv(h, t.o);
  const release = releasePolicy(t.o.orgId, kv);
  const put = await h.api("PUT", `/api/orgs/${t.o.orgId}/projects/${t.pid}/policy`, { token: t.o.token, body: { release, ...policy } });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return { ...t, kv, release };
}

const releases = (h: Harness, o: { token: string; orgId: string }, pid: string) => `/api/orgs/${o.orgId}/projects/${pid}/releases`;

async function prepared(h: Harness, o: { token: string; orgId: string }, pid: string) {
  const r = await h.api("POST", releases(h, o, pid), { token: o.token, body: {} });
  if (![200, 202].includes(r.status)) throw new Error(JSON.stringify(r.body));
  await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/releases/${r.body.releaseId}`, { token: o.token })).body.buildState !== "building");
  return (await h.api("GET", `/api/orgs/${o.orgId}/releases/${r.body.releaseId}`, { token: o.token })).body;
}

async function deployAndSettle(h: Harness, o: { token: string; orgId: string }, releaseId: string, key: string) {
  const d = await h.api("POST", `/api/orgs/${o.orgId}/releases/${releaseId}/deploy`, { token: o.token, body: { idempotencyKey: key } });
  await waitUntil(async () => !["deploying"].includes((await h.api("GET", `/api/orgs/${o.orgId}/releases/${releaseId}`, { token: o.token })).body.state));
  await h.drainSteps(); // release.health
  return { d, rel: (await h.api("GET", `/api/orgs/${o.orgId}/releases/${releaseId}`, { token: o.token })).body };
}

describe("release service", () => {
  it("AT-21: accepting a Change deploys nothing; publishing needs its own publish approval", async () => {
    const h = harness();
    const { o, taskId, runner, pid } = await setup(h);
    liveServices(h, runner);
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    await prepareAndIntegrate(h, o, proposal.proposalId);
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } });
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-rel-1" } })).status).toBe(200);
    await h.drainSteps();
    // accepted: no release job of any kind exists
    expect(runner.handled.filter((j) => j.job.kind.startsWith("release-"))).toEqual([]);
    expect((await h.api("GET", releases(h, o, pid), { token: o.token })).body).toEqual({ releases: [], live: null });

    const rel = await prepared(h, o, pid);
    expect(rel).toMatchObject({ state: "prepared", buildState: "built", status: "Ready for publish approval", live: false, publishApproved: false });
    expect(rel.outputDigest).toMatch(/^[0-9a-f]{64}$/);
    // the proposal approval and the acceptance do not authorize publishing
    const noApproval = await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-0001" } });
    expect(noApproval.status).toBe(409);
    expect(noApproval.body.error.code).toBe("publish_approval_required");
    expect(runner.handled.filter((j) => j.job.kind === "release-deploy")).toEqual([]);

    // default publishRoles = owner: developers and clients cannot approve publishing
    const dev = await member(h, o, "developer");
    const devTry = await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/publish-approvals`, { token: dev.token, body: { outputDigest: rel.outputDigest } });
    expect(devTry.status).toBe(404); // no grants on the project: the release is invisible
    const approval = await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: rel.outputDigest } });
    expect(approval.status).toBe(201);
    expect(approval.body).toMatchObject({ releaseId: rel.releaseId, outputDigest: rel.outputDigest, role: "owner" });
    const after = (await h.api("GET", `/api/orgs/${o.orgId}/releases/${rel.releaseId}`, { token: o.token })).body;
    expect(after).toMatchObject({ state: "publish_approved", status: "Approved, not live", publishApproved: true });
  });

  it("publishRoles is server-owned policy; a developer approval counts only when the policy says so", async () => {
    const h = harness();
    const { o, pid, runner } = await setup(h);
    liveServices(h, runner);
    const dev = await member(h, o, "developer");
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: dev.userId, scope: { kind: "project", id: pid }, operations: ["read"] } });
    const proj = (await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}`, { token: o.token })).body;
    for (const m of proj.mounts ?? []) await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: dev.userId, scope: { kind: "resource", id: m.resourceId }, operations: ["read", "write"] } });
    const rel = await prepared(h, o, pid);
    const refused = await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/publish-approvals`, { token: dev.token, body: { outputDigest: rel.outputDigest } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("publish_role_not_allowed");
    // a developer cannot change the policy that gates them (owner-only PUT)
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: dev.token, body: { release: releasePolicy(o.orgId), publishRoles: ["developer"] } })).status).toBe(403);
  });

  it("AT-33: any change of source, recipe or environment is a new release identity that needs its own approval", async () => {
    const h = harness();
    const { o, pid, taskId, runner } = await setup(h);
    liveServices(h, runner);
    const r1 = await prepared(h, o, pid);
    // same inputs → the same release (idempotent prepare)
    const again = await h.api("POST", releases(h, o, pid), { token: o.token, body: {} });
    expect([again.status, again.body.releaseId, again.body.created]).toEqual([200, r1.releaseId, false]);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${r1.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: r1.outputDigest } });
    // approving some other output than the one built is refused
    const wrong = await h.api("POST", `/api/orgs/${o.orgId}/releases/${r1.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: "0".repeat(64) } });
    expect([wrong.status, wrong.body.error.code]).toEqual([409, "output_digest_mismatch"]);

    // environment change (owner edits production vars) → new identity, new env digest
    const envChanged = { ...releasePolicy(o.orgId), environment: { api: { vars: { APP_VERSION: "1.0.1" }, kvNamespaces: [] } } };
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { release: envChanged } });
    const r2 = await prepared(h, o, pid);
    expect(r2.releaseId).not.toBe(r1.releaseId);
    expect(r2.envDigest).not.toBe(r1.envDigest);
    expect(r2.outputDigest).not.toBe(r1.outputDigest);
    expect(r2.publishApproved).toBe(false); // r1's approval does not carry over
    expect((await h.api("POST", `/api/orgs/${o.orgId}/releases/${r2.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-r2-01" } })).body.error.code).toBe("publish_approval_required");

    // recipe change → new identity
    await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { release: { ...envChanged, recipe: { ...envChanged.recipe, revision: 2 } } } });
    const r3 = await prepared(h, o, pid);
    expect(new Set([r1.releaseId, r2.releaseId, r3.releaseId]).size).toBe(3);
    expect(r3.recipeRevision).toBe(2);

    // source change: a new accepted version → new identity bound to it
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v3" });
    await prepareAndIntegrate(h, o, proposal.proposalId);
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } });
    const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-at33" } });
    const r4 = await prepared(h, o, pid);
    expect(r4.acceptedVersionId).toBe(acc.body.acceptedVersionId);
    expect(r4.releaseId).not.toBe(r3.releaseId);
    expect(r4.outputDigest).not.toBe(r3.outputDigest);
    // preparing against an outdated accepted version is refused
    const stale = await h.api("POST", releases(h, o, pid), { token: o.token, body: { acceptedVersionId: r1.acceptedVersionId } });
    expect([stale.status, stale.body.error.code]).toEqual([409, "accepted_version_stale"]);
  });

  it("AT-34: only the release service deploys, with the approved output, and the live version reports that release", async () => {
    const h = harness();
    const { o, pid, runner } = await setup(h);
    const live = liveServices(h, runner);
    const rel = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: rel.outputDigest } });
    const { d, rel: done } = await deployAndSettle(h, o, rel.releaseId, "deploy-at34-1");
    expect(d.status).toBe(202);
    expect(done).toMatchObject({ state: "live", status: "Live", live: true, outputDigest: rel.outputDigest, health: { ok: true } });
    expect(done.deployments.map((x: any) => x.workerName)).toEqual([workerName(o.orgId, "api"), workerName(o.orgId, "website")]);
    // observed live identity == recorded release identity
    expect(live.get(workerName(o.orgId, "api"))).toMatchObject({ COMMONFORGE_RELEASE_ID: rel.releaseId, APP_VERSION: "1.0.0" });
    const deployJob = runner.handled.find((j) => j.job.kind === "release-deploy")!.job as any;
    expect(deployJob.outputDigest).toBe(rel.outputDigest);
    expect(JSON.stringify(deployJob)).not.toContain("test-deploy-token"); // the token is never in a job
    // the deploy credential went to that open job only
    expect(runner.deployCredentials).toEqual([{ jobId: runner.handled.find((j) => j.job.kind === "release-deploy")!.jobId, status: 200, gotToken: true }]);
    const late = await h.api("POST", "/api/runner/deploy-credential", { body: { signedJob: runner.handled.find((j) => j.job.kind === "release-deploy")! } });
    expect([late.status, late.body.error.code]).toEqual([409, "job_finished"]);
    // other job kinds never get it
    const build = runner.handled.find((j) => j.job.kind === "release-build")!;
    expect((await h.api("POST", "/api/runner/deploy-credential", { body: { signedJob: build } })).status).toBe(403);
    // live pointer
    const ptr = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/releases/live`, { token: o.token });
    expect(ptr.body.live).toMatchObject({ releaseId: rel.releaseId, acceptedVersionId: rel.acceptedVersionId });
    // review m-2: health details (observed bodies) are for developers only
    expect(JSON.stringify(done.health)).toContain('"body"');
    const viewer = await member(h, o, "viewer");
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: viewer.userId, scope: { kind: "project", id: pid }, operations: ["read"] } });
    for (const m of (await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}`, { token: o.token })).body.mounts ?? []) await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: viewer.userId, scope: { kind: "resource", id: m.resourceId }, operations: ["read"] } });
    const vv = (await h.api("GET", `/api/orgs/${o.orgId}/releases/${rel.releaseId}`, { token: viewer.token })).body;
    expect(vv.health).toEqual({ ok: true, checkedAt: done.health.checkedAt, targets: [{ targetId: "api", ok: true }, { targetId: "website", ok: true }] });
    // a retried deploy request (same key) does not deploy twice
    const replay = await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-at34-1" } });
    expect([replay.status, replay.body.replayed]).toEqual([200, true]);
    expect(runner.handled.filter((j) => j.job.kind === "release-deploy")).toHaveLength(1);
    // every release.* event names its channel (a production release: "production")
    const { env } = await import("cloudflare:workers");
    const evs = (await env.DB.prepare("SELECT action, detail_json, client_detail_json FROM events WHERE subject_kind = 'release' AND subject_id = ?").bind(rel.releaseId).all<{ action: string; detail_json: string; client_detail_json: string | null }>()).results;
    expect(evs.map((e) => e.action)).toContain("release.live");
    for (const e of evs) expect([e.action, JSON.parse(e.detail_json).channel, JSON.parse(e.client_detail_json ?? "{}").channel]).toEqual([e.action, "production", "production"]);
  });

  it("AT-35: a failed deploy keeps the previous live pointer, shows Approved, not live, and retries without a new acceptance", async () => {
    const h = harness();
    const { o, pid, runner, taskId } = await setup(h);
    const live = liveServices(h, runner);
    // release A goes live
    const a = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${a.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: a.outputDigest } });
    expect((await deployAndSettle(h, o, a.releaseId, "deploy-a-0001")).rel.state).toBe("live");

    // release B (a new accepted version) fails to deploy
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "B" });
    await prepareAndIntegrate(h, o, proposal.proposalId);
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } });
    const accepted = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-b-at35" } });
    const versionsBefore = (await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}`, { token: o.token })).body.state;
    const b = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${b.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: b.outputDigest } });
    runner.opts.fail = { "release-deploy": { code: "provider_unavailable", detail: "wrangler deploy of api (commonforge-demo-api) failed: exit 1 (Authentication error)" } };
    const failed = (await deployAndSettle(h, o, b.releaseId, "deploy-b-0001")).rel;
    expect(failed).toMatchObject({ state: "failed", status: "Approved, not live", live: false, publishApproved: true, error: { code: "provider_unavailable" } });
    const ptr = (await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/releases/live`, { token: o.token })).body.live;
    expect(ptr.releaseId).toBe(a.releaseId); // previous live pointer kept
    expect(live.get(workerName(o.orgId, "api"))?.COMMONFORGE_RELEASE_ID).toBe(a.releaseId);
    // the client sees the state, not the runner's text
    const client = await member(h, o, "client");
    await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope: { kind: "project", id: pid }, operations: ["read"] } });
    const proj = (await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}`, { token: o.token })).body;
    for (const m of proj.mounts ?? []) await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope: { kind: "resource", id: m.resourceId }, operations: ["read"] } });
    const cv = (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: client.token })).body;
    expect(cv).toMatchObject({ status: "Approved, not live", error: { code: "provider_unavailable" } });
    expect(cv.error.detail).toBeUndefined();
    expect(cv.deployJobId).toBeUndefined();

    // retry the SAME release: no new acceptance, no new approval, no new release
    runner.opts.fail = {};
    const retried = (await deployAndSettle(h, o, b.releaseId, "deploy-b-0002")).rel;
    expect(retried).toMatchObject({ releaseId: b.releaseId, state: "live", live: true, deployAttempts: 2, acceptedVersionId: accepted.body.acceptedVersionId });
    expect((await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/releases/live`, { token: o.token })).body.live.releaseId).toBe(b.releaseId);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}`, { token: o.token })).body.state).toBe(versionsBefore);
    const versions = await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/releases`, { token: o.token });
    expect(versions.body.releases.map((r: any) => r.releaseId).sort()).toEqual([a.releaseId, b.releaseId].sort());
  });

  it("AT-35/I-4: a deploy whose health check never reports the release, with nothing to roll back to, is recovery_required", async () => {
    const h = harness();
    const { o, pid, runner } = await setup(h);
    liveServices(h, runner);
    runner.opts.onDeploy = () => undefined; // the deploy "succeeds" but production keeps answering the old version
    const rel = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: rel.outputDigest } });
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-hc-0001" } });
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/releases/${rel.releaseId}`, { token: o.token })).body.state === "health_verification");
    // deliver the health step past its attempts
    let msgs = h.steps.splice(0);
    expect(msgs).toHaveLength(1);
    for (let attempt = 1; attempt <= 6 && msgs.length > 0; attempt++) {
      const r = await h.deliver("commonforge-steps", msgs, attempt);
      msgs = r.retried.map((x) => x.body);
    }
    const r = (await h.api("GET", `/api/orgs/${o.orgId}/releases/${rel.releaseId}`, { token: o.token })).body;
    // review I-4: the new code IS serving and there is nothing to roll back to: never "previous release still live"
    expect(r).toMatchObject({ state: "recovery_required", status: "Recovery required: production is unverified", error: { code: "health_check_failed" }, live: false, rollback: null });
    expect((await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/releases/live`, { token: o.token })).body.live).toBeNull();
  });

  it("I-5/R-2: a partial deploy that changed production (nothing to roll back to) is recovery_required, and a retry finishes live", async () => {
    const h = harness();
    const { o, pid, runner } = await setup(h);
    liveServices(h, runner);
    runner.opts.partialDeploy = true;
    const rel = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: rel.outputDigest } });
    const r = (await deployAndSettle(h, o, rel.releaseId, "deploy-pt-0001")).rel;
    // the api target was uploaded before the website failed: production changed, no previous release
    expect(r).toMatchObject({ state: "recovery_required", error: { code: "deploy_changed_production" }, live: false, rollback: null, status: "Recovery required: production is unverified" });
    runner.opts.partialDeploy = false;
    const again = (await deployAndSettle(h, o, rel.releaseId, "deploy-pt-0002")).rel;
    expect(again).toMatchObject({ state: "live", live: true, deployAttempts: 2 });
  });

  it("C-1: release targets stay in the org's Worker namespace and platform-created bindings (policy, prepare, deploy)", async () => {
    const h = harness();
    const { o, pid, release, kv } = await setup(h);
    const put = (rel: unknown) => h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { release: rel } });
    const withTarget = (name: string) => ({ ...release, targets: [release.targets[0], { ...release.targets[1]!, workerName: name }] });
    // platform Workers are refused by the schema itself (400); other orgs' and unprefixed names by the namespace rule (403)
    for (const name of ["commonforge-worker", "commonforge-preview", `cfapp-${o.orgId}-`]) expect((await put(withTarget(name))).status, name).toBe(400);
    for (const name of ["cfapp-o-ffffffffffff-website", "someones-site", `cfappx-${o.orgId}-site`]) {
      const r = await put(withTarget(name));
      expect([r.status, r.body.error.code], name).toEqual([403, "release_target_not_allowed"]);
    }
    // a KV id the platform did not create for this org (another org's, or any id on the account)
    const other = await (await import("../helpers.js")).ownerWithOrg(h);
    const foreignKv = await orgKv(h, other, "orders");
    const foreign = await put({ ...release, environment: { api: { vars: {}, kvNamespaces: [{ binding: "ORDERS", id: foreignKv }] } } });
    expect([foreign.status, foreign.body.error.code]).toEqual([403, "binding_not_allowed"]);
    expect((await put({ ...release, environment: { api: { vars: {}, kvNamespaces: [{ binding: "ORDERS", id: "0".repeat(32) }] } } })).body.error.code).toBe("binding_not_allowed");
    // a free-form health URL is no longer accepted (it is derived from the target's workers.dev URL)
    expect((await put({ ...release, healthCheck: { targetId: "api", path: "/version", url: "https://spoof.example/version" } })).status).toBe(400);
    // re-checked at prepare and deploy: a binding removed after the policy was saved is refused
    const rel = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: rel.outputDigest } });
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare("DELETE FROM org_deploy_resources WHERE resource_id = ?").bind(kv).run();
    const d = await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-c1-0001" } });
    expect([d.status, d.body.error.code]).toEqual([403, "binding_not_allowed"]);
    const p2 = await h.api("POST", releases(h, o, pid), { token: o.token, body: {} });
    expect([p2.status, p2.body.error.code]).toEqual([403, "binding_not_allowed"]);
  });

  it("C-1: a release whose build receipt carries a D1 binding is refused at deploy (binding_not_allowed)", async () => {
    const h = harness();
    const { o, pid } = await setup(h);
    const rel = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: rel.outputDigest } });
    const { env } = await import("cloudflare:workers");
    const row = await env.DB.prepare("SELECT build_receipt_json FROM releases WHERE release_id = ?").bind(rel.releaseId).first<{ build_receipt_json: string }>();
    const receipt = JSON.parse(row!.build_receipt_json);
    receipt.targets[0].config.d1Databases = [{ binding: "DB", id: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" }];
    await env.DB.prepare("UPDATE releases SET build_receipt_json = ? WHERE release_id = ?").bind(JSON.stringify(receipt), rel.releaseId).run();
    const d = await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-d1-0001" } });
    expect([d.status, d.body.error.code]).toEqual([403, "binding_not_allowed"]);
  });

  it("I-4: a health failure after a successful deploy rolls back to the previous release, and only then says it is live", async () => {
    const h = harness();
    const { o, pid, runner, taskId } = await setup(h);
    const live = liveServices(h, runner);
    const a = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${a.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: a.outputDigest } });
    expect((await deployAndSettle(h, o, a.releaseId, "deploy-rb-a001")).rel.state).toBe("live");
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "B" });
    await prepareAndIntegrate(h, o, proposal.proposalId);
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } });
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-rb-b01" } });
    const b = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${b.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: b.outputDigest } });
    // B uploads fine but its /version never answers B (e.g. a broken release); A's rollback upload works
    const onDeploy = runner.opts.onDeploy!;
    runner.opts.onDeploy = (name, vars) => (vars.COMMONFORGE_RELEASE_ID === b.releaseId ? live.set(name, { ...vars, COMMONFORGE_RELEASE_ID: "broken" }) : onDeploy(name, vars));
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${b.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-rb-b001" } });
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body.state === "health_verification");
    await h.drainSteps(); // health retries → fail → rollback job (A) issued
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body.rollback?.state === "verifying");
    const mid = (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body;
    expect(mid).toMatchObject({ state: "recovery_required", status: "Not verified, rolling back" });
    // no other deploy of the project while the rollback runs
    await h.drainSteps(); // rollback verification
    const done = (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body;
    expect(done).toMatchObject({ state: "failed", status: "Approved, not live", rollback: { state: "done", toReleaseId: a.releaseId }, live: false });
    expect(live.get(workerName(o.orgId, "api"))?.COMMONFORGE_RELEASE_ID).toBe(a.releaseId); // A really serves again
    const ptr = (await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/releases/live`, { token: o.token })).body.live;
    expect(ptr.releaseId).toBe(a.releaseId);
    const rollbackJob = runner.handled.filter((j) => j.job.kind === "release-deploy").at(-1)!;
    expect((rollbackJob.job as any).releaseId).toBe(a.releaseId);
    expect(runner.deployCredentials.at(-1)).toMatchObject({ jobId: rollbackJob.jobId, status: 200 });
  });

  it("I-4: a failed rollback is recovery_required, and the UI says production is unverified", async () => {
    const h = harness();
    const { o, pid, runner, taskId } = await setup(h);
    const live = liveServices(h, runner);
    const a = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${a.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: a.outputDigest } });
    await deployAndSettle(h, o, a.releaseId, "deploy-rf-a001");
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "B" });
    await prepareAndIntegrate(h, o, proposal.proposalId);
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } });
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-rf-b01" } });
    const b = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${b.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: b.outputDigest } });
    runner.opts.onDeploy = (name, vars) => live.set(name, { ...vars, COMMONFORGE_RELEASE_ID: "broken" });
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${b.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-rf-b001" } });
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body.state === "health_verification");
    runner.opts.fail = { "release-deploy": { code: "provider_unavailable", detail: "wrangler: authentication error" } };
    await h.drainSteps();
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body.rollback?.state === "failed");
    const r = (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body;
    expect(r).toMatchObject({ state: "recovery_required", status: "Recovery required: production is unverified", error: { code: "rollback_failed" } });
  });

  it("I-4: only one deploy per project at a time", async () => {
    const h = harness();
    const { o, pid, runner, taskId } = await setup(h);
    liveServices(h, runner);
    const a = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${a.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: a.outputDigest } });
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "B" });
    await prepareAndIntegrate(h, o, proposal.proposalId);
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } });
    await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "accept-se-b01" } });
    const b = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${b.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: b.outputDigest } });
    runner.opts.manual = true;
    expect((await h.api("POST", `/api/orgs/${o.orgId}/releases/${a.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-se-a001" } })).status).toBe(202);
    const second = await h.api("POST", `/api/orgs/${o.orgId}/releases/${b.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-se-b001" } });
    expect([second.status, second.body.error.code]).toEqual([409, "deploy_in_progress"]);
  });

  it("m-4: pull-mode runners are never handed a release-deploy job (they could fetch the deploy token)", async () => {
    const h = harness();
    const { o, pid, runner } = await setup(h);
    liveServices(h, runner);
    const rel = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: rel.outputDigest } });
    runner.opts.manual = true;
    expect((await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-m4-0001" } })).status).toBe(202);
    const next = await h.api("POST", "/api/runner/jobs/next", { token: "test-runner-bearer-0123456789abcdef", body: { runnerId: "pull-1" } });
    expect(next.status).toBe(204);
  });

  it("m-3: every target is verified: an assets target that does not run the uploaded version fails the health check", async () => {
    const h = harness();
    const { o, pid, runner } = await setup(h);
    liveServices(h, runner);
    runner.opts.deployWithoutActivating = true; // /version still answers (vars), but the account runs older versions
    const rel = await prepared(h, o, pid);
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${rel.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: rel.outputDigest } });
    const r = (await deployAndSettle(h, o, rel.releaseId, "deploy-m3-0001")).rel;
    expect(r.state).toBe("recovery_required");
    expect(r.health.targets.map((t: any) => [t.targetId, t.ok])).toEqual([["api", false], ["website", false]]);
  });
});

async function acceptedB(h: Harness, o: { token: string; orgId: string }, taskId: string, key: string) {
  const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": key });
  await prepareAndIntegrate(h, o, proposal.proposalId);
  await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: proposal.proposalHash } });
  await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: `accept-${key}` } });
}

async function approvedRelease(h: Harness, o: { token: string; orgId: string }, pid: string) {
  const r = await prepared(h, o, pid);
  await h.api("POST", `/api/orgs/${o.orgId}/releases/${r.releaseId}/publish-approvals`, { token: o.token, body: { outputDigest: r.outputDigest } });
  return r;
}

describe("re-review fixes", { timeout: 30_000 }, () => {
  it("R-1: a deploy job lost without a result releases the project's deploy lock; the stuck release needs recovery", async () => {
    const h = harness();
    const { o, pid, runner, taskId } = await setup(h);
    liveServices(h, runner);
    const a = await approvedRelease(h, o, pid);
    runner.opts.manual = true; // the runner never answers
    expect((await h.api("POST", `/api/orgs/${o.orgId}/releases/${a.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-r1-a001" } })).status).toBe(202);
    runner.opts.manual = false;
    runner.pending.length = 0; // lost
    await acceptedB(h, o, taskId, "r1b");
    const b = await approvedRelease(h, o, pid);
    expect((await h.api("POST", `/api/orgs/${o.orgId}/releases/${b.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-r1-b001" } })).body.error.code).toBe("deploy_in_progress");
    // the job expires and the GC closes it (no result ever arrives)
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare("UPDATE runner_jobs SET expires_at = ? WHERE kind = 'release-deploy'").bind(Date.now() - 16 * 60_000).run();
    await h.worker.scheduled({} as ScheduledController, env, {} as ExecutionContext);
    const stuck = (await h.api("GET", `/api/orgs/${o.orgId}/releases/${a.releaseId}`, { token: o.token })).body;
    expect(stuck).toMatchObject({ state: "recovery_required", error: { code: "deploy_lost" }, status: "Recovery required: production is unverified" });
    // the lock is free: B deploys
    expect((await deployAndSettle(h, o, b.releaseId, "deploy-r1-b002")).rel.state).toBe("live");
    // owner action on A: mark recovered (owner only), then it can be retried
    const dev = await member(h, o, "developer");
    expect((await h.api("POST", `/api/orgs/${o.orgId}/releases/${a.releaseId}/recover`, { token: dev.token, body: { note: "checked" } })).status).toBe(403);
    const rec = await h.api("POST", `/api/orgs/${o.orgId}/releases/${a.releaseId}/recover`, { token: o.token, body: { note: "checked production by hand" } });
    expect(rec.body).toMatchObject({ state: "failed", error: { code: "recovered_by_owner" } });
    expect((await h.api("POST", `/api/orgs/${o.orgId}/releases/${a.releaseId}/recover`, { token: o.token, body: { note: "again" } })).body.error.code).toBe("not_recoverable");
  });

  it("R-1: a lost deploy is also detected lazily at the next deploy claim (job already closed as failed)", async () => {
    const h = harness();
    const { o, pid, runner, taskId } = await setup(h);
    liveServices(h, runner);
    const a = await approvedRelease(h, o, pid);
    runner.opts.manual = true;
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${a.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-r1l-a01" } });
    runner.opts.manual = false;
    runner.pending.length = 0;
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare("UPDATE runner_jobs SET status = 'failed', result_json = '{}' WHERE kind = 'release-deploy'").run();
    await acceptedB(h, o, taskId, "r1lb");
    const b = await approvedRelease(h, o, pid);
    expect((await deployAndSettle(h, o, b.releaseId, "deploy-r1l-b01")).rel.state).toBe("live");
    expect((await h.api("GET", `/api/orgs/${o.orgId}/releases/${a.releaseId}`, { token: o.token })).body.error.code).toBe("deploy_lost");
  });

  it("R-2: a partial deploy over a live release rolls back; the pointer is cleared until the rollback verifies; editions never see a wrong release", async () => {
    const h = harness();
    const { o, pid, runner, taskId } = await setup(h);
    const live = liveServices(h, runner);
    const a = await approvedRelease(h, o, pid);
    expect((await deployAndSettle(h, o, a.releaseId, "deploy-r2-a001")).rel.state).toBe("live");
    await acceptedB(h, o, taskId, "r2b");
    const b = await approvedRelease(h, o, pid);
    runner.opts.partialDeploy = true; // api uploaded, website failed
    runner.opts.manual = true;
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${b.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-r2-b001" } });
    await runner.runPending();
    const mid = (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body;
    expect(mid).toMatchObject({ state: "recovery_required", error: { code: "deploy_changed_production" }, rollback: { state: "running", toReleaseId: a.releaseId } });
    expect(live.get(workerName(o.orgId, "api"))?.COMMONFORGE_RELEASE_ID).toBe(b.releaseId); // B's api really serves
    // the pointer no longer claims A is live, so nothing (editions, AT-30) can record it
    expect((await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/releases/live`, { token: o.token })).body.live).toBeNull();
    const { liveRelease } = await import("../../src/services/editions.js");
    const { createServices } = await import("../../src/context.js");
    const { env } = await import("cloudflare:workers");
    expect(await liveRelease(createServices(env, h.deps), o.orgId, pid)).toBeNull();
    runner.opts.partialDeploy = false;
    runner.opts.manual = false;
    await runner.runPending(); // the rollback deploy of A
    await h.drainSteps();
    const done = (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body;
    expect(done).toMatchObject({ state: "failed", rollback: { state: "done" } });
    expect(live.get(workerName(o.orgId, "api"))?.COMMONFORGE_RELEASE_ID).toBe(a.releaseId);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/releases/live`, { token: o.token })).body.live.releaseId).toBe(a.releaseId);
    expect((await liveRelease(createServices(env, h.deps), o.orgId, pid))?.releaseId).toBe(a.releaseId);
  });

  it("R-2: a failed deploy that left production untouched keeps the verified previous release live; an unverifiable one does not", async () => {
    const h = harness();
    const { o, pid, runner, taskId } = await setup(h);
    liveServices(h, runner);
    const a = await approvedRelease(h, o, pid);
    await deployAndSettle(h, o, a.releaseId, "deploy-r2u-a01");
    await acceptedB(h, o, taskId, "r2ub");
    const b = await approvedRelease(h, o, pid);
    runner.opts.fail = { "release-deploy": { code: "provider_unavailable", detail: "wrangler: auth error" } };
    expect((await deployAndSettle(h, o, b.releaseId, "deploy-r2u-b01")).rel).toMatchObject({ state: "failed", status: "Approved, not live" });
    expect((await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/releases/live`, { token: o.token })).body.live.releaseId).toBe(a.releaseId);
    // the same failure when production cannot be checked: never claim A is live
    h.cf.failActive = true;
    const r = (await deployAndSettle(h, o, b.releaseId, "deploy-r2u-b02")).rel;
    // production cannot be checked: it may have changed, so recovery starts (the rollback of A fails
    // here too, since deploys keep failing) and nothing claims A is live meanwhile
    expect(r.state).toBe("recovery_required");
    expect(["deploy_unverified", "rollback_failed"]).toContain(r.error.code);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/releases/live`, { token: o.token })).body.live).toBeNull();
  });

  it("m-d: a rollback removes Workers only the failed release deployed", async () => {
    const h = harness();
    const { o, pid, runner, taskId, release } = await setup(h);
    const live = liveServices(h, runner);
    const a = await approvedRelease(h, o, pid);
    await deployAndSettle(h, o, a.releaseId, "deploy-md-a01");
    // B adds a third Worker, and its health fails
    const extra = { ...release, targets: [...release.targets, { targetId: "docs", kind: "assets", mountName: "website", outputPath: "dist", workerName: workerName(o.orgId, "docs") }] };
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { release: extra } })).status).toBe(200);
    await acceptedB(h, o, taskId, "mdb");
    const b = await approvedRelease(h, o, pid);
    const onDeploy = runner.opts.onDeploy!;
    runner.opts.onDeploy = (name, vars) => (vars.COMMONFORGE_RELEASE_ID === b.releaseId ? live.set(name, { ...vars, COMMONFORGE_RELEASE_ID: "broken" }) : onDeploy(name, vars));
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${b.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-md-b01" } });
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body.state !== "deploying");
    await h.drainSteps();
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body.rollback?.state === "verifying");
    await h.drainSteps();
    expect((await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body.rollback.state).toBe("done");
    expect(h.cf.deleted).toEqual([workerName(o.orgId, "docs")]);
  });

  it("m-b: deploy resources and release Workers have per-org caps", async () => {
    const h = harness();
    const { o, pid, release } = await setup(h); // already 1 KV
    for (let i = 2; i <= 5; i++) await orgKv(h, o, `kv${i}`);
    const sixth = await h.api("POST", `/api/orgs/${o.orgId}/deploy-resources`, { token: o.token, body: { kind: "kv", name: "kv6" } });
    expect([sixth.status, sixth.body.error.code]).toEqual([409, "quota_exceeded"]);
    const many = { ...release, targets: [0, 1, 2, 3, 4, 5].map((i) => ({ targetId: `t${i}`, kind: "assets", mountName: "website", outputPath: "dist", workerName: workerName(o.orgId, `w${i}`) })), environment: {}, healthCheck: { targetId: "api", path: "/version" } };
    many.targets[0] = { ...release.targets[0]!, targetId: "api" } as never;
    const r = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { release: many } });
    expect([r.status, r.body.error.code]).toEqual([409, "quota_exceeded"]);
  });
});

describe("follow-up fixes (n-1, n-2)", { timeout: 30_000 }, () => {
  it("n-1: the stale sweep never races a result being applied; it sweeps once the applier had its grace", async () => {
    const h = harness();
    const { o, pid, runner } = await setup(h);
    liveServices(h, runner);
    const a = await approvedRelease(h, o, pid);
    runner.opts.manual = true;
    expect((await h.api("POST", `/api/orgs/${o.orgId}/releases/${a.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-n1-a001" } })).status).toBe(202);
    runner.opts.manual = false;
    runner.pending.length = 0;
    // the result was just stored (job no longer queued, result hash set) but its applier has not moved the release yet
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare("UPDATE runner_jobs SET status = 'succeeded', result_json = '{}', result_hash = 'h', completed_at = ? WHERE kind = 'release-deploy'").bind(Date.now()).run();
    await h.worker.scheduled({} as ScheduledController, env, {} as ExecutionContext);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/releases/${a.releaseId}`, { token: o.token })).body.state).toBe("deploying");
    // the applier never moved it: after the grace the sweep releases the lock
    await env.DB.prepare("UPDATE runner_jobs SET completed_at = ? WHERE kind = 'release-deploy'").bind(Date.now() - 3 * 60_000).run();
    await h.worker.scheduled({} as ScheduledController, env, {} as ExecutionContext);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/releases/${a.releaseId}`, { token: o.token })).body).toMatchObject({ state: "recovery_required", error: { code: "deploy_lost" } });
  });

  it("n-1: rollbackFailed only applies to the rollback state its caller observed", async () => {
    const h = harness();
    const { o, pid, runner, taskId } = await setup(h);
    liveServices(h, runner);
    const a = await approvedRelease(h, o, pid);
    await deployAndSettle(h, o, a.releaseId, "deploy-n1r-a01");
    await acceptedB(h, o, taskId, "n1rb");
    const b = await approvedRelease(h, o, pid);
    runner.opts.partialDeploy = true;
    runner.opts.manual = true;
    await h.api("POST", `/api/orgs/${o.orgId}/releases/${b.releaseId}/deploy`, { token: o.token, body: { idempotencyKey: "deploy-n1r-b01" } });
    await runner.runPending(); // B fails partially: rollback of A is issued (running), its job stays pending
    expect((await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body.rollback.state).toBe("running");
    const { env } = await import("cloudflare:workers");
    const { createServices } = await import("../../src/context.js");
    const { getRelease, rollbackFailed } = await import("../../src/services/releases.js");
    const svc = createServices(env, h.deps);
    const seenRunning = (await getRelease(svc, o.orgId, b.releaseId))!;
    // a rollback result was just stored for the job: the sweep leaves it to its applier
    await env.DB.prepare("UPDATE runner_jobs SET status = 'succeeded', result_json = '{}', result_hash = 'h', completed_at = ? WHERE job_id = ?").bind(Date.now(), seenRunning.rollback_job_id).run();
    await h.worker.scheduled({} as ScheduledController, env, {} as ExecutionContext);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body.rollback.state).toBe("running");
    // the applier moves it to verifying; a sweep that read "running" earlier must not overwrite that
    await env.DB.prepare("UPDATE releases SET rollback_state = 'verifying' WHERE release_id = ?").bind(b.releaseId).run();
    expect(await rollbackFailed(svc, seenRunning, "the rollback job ended without a result", "running")).toBe(false);
    const after = (await h.api("GET", `/api/orgs/${o.orgId}/releases/${b.releaseId}`, { token: o.token })).body;
    expect(after.rollback.state).toBe("verifying");
    expect(after.error?.code).not.toBe("rollback_failed");
    runner.opts.manual = false;
    runner.opts.partialDeploy = false;
  });

  it("n-2: a release Worker name belongs to one project of the org (policy or live deployment)", async () => {
    const h = harness();
    const { o, web, kv, release, pid } = await setup(h);
    const { projectWith } = await import("../helpers.js");
    const other = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const put = (body: unknown) => h.api("PUT", `/api/orgs/${o.orgId}/projects/${other}/policy`, { token: o.token, body: { release: body } });
    // the same names as the first project's policy
    const same = await put(releasePolicy(o.orgId, kv));
    expect([same.status, same.body.error.code]).toEqual([409, "release_target_in_use"]);
    // one clashing name is enough
    const one = await put({ ...release, targets: [{ ...release.targets[0]!, workerName: workerName(o.orgId, "api2") }, release.targets[1]!] });
    expect([one.status, one.body.error.code, one.body.error.details?.workerName]).toEqual([409, "release_target_in_use", workerName(o.orgId, "website")]);
    // its own names are fine
    const own = { ...release, targets: release.targets.map((t) => ({ ...t, workerName: workerName(o.orgId, `${t.targetId}2`) })) };
    expect((await put(own)).status).toBe(200);
    // a name another project's LIVE release still runs stays taken after that project's policy dropped it
    const { env } = await import("cloudflare:workers");
    await env.DB.prepare("INSERT INTO release_live (org_id, project_id, release_id, accepted_version_id, output_digest, deployments_json, since) VALUES (?, ?, 'rel-x', 'av-x', ?, ?, ?)")
      .bind(o.orgId, other, "0".repeat(64), JSON.stringify([{ targetId: "docs", workerName: workerName(o.orgId, "docs"), versionId: "v1" }]), new Date().toISOString())
      .run();
    await put(own); // its policy no longer names docs
    const docs = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body: { release: { ...release, targets: [...release.targets, { targetId: "docs", kind: "assets", mountName: "website", outputPath: "dist", workerName: workerName(o.orgId, "docs") }] } } });
    expect([docs.status, docs.body.error.code]).toEqual([409, "release_target_in_use"]);
  });
});
