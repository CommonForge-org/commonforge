/**
 * Staging releases (staging phase 1, Task 5): a `staging` channel in the release service with its
 * own live pointer, deploy lock and rollback, and no publish approval.
 */
import { describe, expect, it } from "vitest";
import { getLive, getRelease, prepareStagingRelease, startStagingDeploy } from "../../src/services/releases.js";
import { FakeRunner } from "../fakes/runner.js";
import { projectWith } from "../helpers.js";
import { stagingFixture } from "../staging-helpers.js";

describe("staging releases", () => {
  it("build → deploy (no publish approval) → live on the staging pointer only", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const rel = await prepareStagingRelease(f.svc, await f.stagingInput("b-1"));
    expect(rel.channel).toBe("staging");
    expect(rel.accepted_version_id).toBe("staging-b-1");
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, rel.release_id))!.state === "publish_approved");
    await startStagingDeploy(f.svc, (await getRelease(f.svc, f.o.orgId, rel.release_id))!, f.o.userId);
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, rel.release_id))!.state === "live");
    expect((await getLive(f.svc, f.o.orgId, f.pid, "staging"))!.release_id).toBe(rel.release_id);
    expect(await getLive(f.svc, f.o.orgId, f.pid)).toBeNull();
    expect(runner.errors).toEqual([]);
    const deployed = runner.handled.find((j) => j.job.kind === "release-deploy")!.job as { targets: Array<{ workerName: string; config: { vars: Record<string, string>; compatibilityFlags: string[]; d1Databases?: unknown[] }; dataFiles?: Array<{ path: string }> }> };
    expect(deployed.targets[0]!.workerName).toBe(`cfapp-${f.o.orgId}-api-staging`);
    expect(deployed.targets[0]!.config.vars.PAYMENT_WEBHOOK_URL).toMatch(/\/api\/sink\//);
    // the sink is a same-account workers.dev Worker: Cloudflare refuses the fetch (1042) without this flag
    expect(runner.handled.find((j) => j.job.kind === "release-build")!.job).toMatchObject({ environment: { api: { compatibilityFlags: ["global_fetch_strictly_public"] } } });
    expect(deployed.targets[0]!.config.compatibilityFlags).toEqual(["global_fetch_strictly_public"]);
    expect(deployed.targets[0]!.config.vars.APP_ENV).toBe("staging");
    expect(deployed.targets[0]!.config.d1Databases).toHaveLength(1);
    // the deploy job carries the data files the target digest covers
    expect(deployed.targets[0]!.dataFiles?.map((d) => d.path)).toEqual(["migrations/0001_init.sql", "seed/contacts.sql", "seed/orders.json"]);
    // same build → the same release (idempotent)
    expect((await prepareStagingRelease(f.svc, await f.stagingInput("b-1"))).release_id).toBe(rel.release_id);
    // no publish approval exists or was needed
    expect((await f.svc.db.prepare("SELECT COUNT(*) AS n FROM release_publish_approvals WHERE release_id = ?").bind(rel.release_id).first<{ n: number }>())!.n).toBe(0);
  });

  it("without capture vars a staging release adds no compatibility flags", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const input = await f.stagingInput("b-1");
    const rel = await prepareStagingRelease(f.svc, { ...input, staging: { ...input.staging, captureVars: [] } });
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, rel.release_id))!.state === "publish_approved");
    const build = runner.handled.find((j) => j.job.kind === "release-build")!.job as { environment: Record<string, { compatibilityFlags?: string[] }> };
    expect(build.environment.api).not.toHaveProperty("compatibilityFlags");
  });

  it("a staging deploy never blocks or is blocked by a production deploy, and a failed one rolls back to the previous staging release", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    // production is live (an older pointer row than staging's): staging must neither read nor move it
    await f.svc.db.prepare("INSERT INTO release_live (org_id, project_id, release_id, accepted_version_id, output_digest, deployments_json, since) VALUES (?, ?, 'rel-prod-live', 'av-1', ?, '[]', ?)").bind(f.o.orgId, f.pid, "1".repeat(64), f.svc.nowIso()).run();
    const first = await f.liveStaging("b-1");
    runner.opts.fail = { "release-deploy": { code: "provider_unavailable", detail: "wrangler deploy failed" } };
    const second = await prepareStagingRelease(f.svc, await f.stagingInput("b-2"));
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, second.release_id))!.state === "publish_approved");
    await startStagingDeploy(f.svc, (await getRelease(f.svc, f.o.orgId, second.release_id))!, f.o.userId);
    await f.until(async () => ["failed", "recovery_required"].includes((await getRelease(f.svc, f.o.orgId, second.release_id))!.state));
    expect((await getLive(f.svc, f.o.orgId, f.pid, "staging"))!.release_id).toBe(first.release_id);
    expect((await getRelease(f.svc, f.o.orgId, second.release_id))!.previous_release_id).toBe(first.release_id);
    expect((await getLive(f.svc, f.o.orgId, f.pid))!.release_id).toBe("rel-prod-live");
  });

  it("a staging deploy that fails its health check is rolled back to the previous staging release; production's pointer stays", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    await f.svc.db.prepare("INSERT INTO release_live (org_id, project_id, release_id, accepted_version_id, output_digest, deployments_json, since) VALUES (?, ?, 'rel-prod-live', 'av-1', ?, '[]', ?)").bind(f.o.orgId, f.pid, "1".repeat(64), f.svc.nowIso()).run();
    const first = await f.liveStaging("b-1");
    const second = await prepareStagingRelease(f.svc, await f.stagingInput("b-2"));
    // the second release's Worker answers, but not with its release id
    const health = f.h.deps.healthFetch;
    f.h.deps.healthFetch = async (url) => {
      const r = await health(url);
      const body = r.status === 200 ? ((await r.clone().json()) as { release?: string }) : null;
      return body?.release === second.release_id ? new Response("broken", { status: 500 }) : r;
    };
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, second.release_id))!.state === "publish_approved");
    await startStagingDeploy(f.svc, (await getRelease(f.svc, f.o.orgId, second.release_id))!, f.o.userId);
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, second.release_id))!.rollback_state === "done", 15_000);
    expect((await getRelease(f.svc, f.o.orgId, second.release_id))!.state).toBe("failed");
    expect((await getLive(f.svc, f.o.orgId, f.pid, "staging"))!.release_id).toBe(first.release_id);
    expect((await getLive(f.svc, f.o.orgId, f.pid))!.release_id).toBe("rel-prod-live");
    expect(runner.errors).toEqual([]);
  });

  it("every release.* event of a staging release carries channel \"staging\" in detail and client detail", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const first = await f.liveStaging("b-1");
    const second = await prepareStagingRelease(f.svc, await f.stagingInput("b-2"));
    const health = f.h.deps.healthFetch;
    f.h.deps.healthFetch = async (url) => {
      const r = await health(url);
      const body = r.status === 200 ? ((await r.clone().json()) as { release?: string }) : null;
      return body?.release === second.release_id ? new Response("broken", { status: 500 }) : r;
    };
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, second.release_id))!.state === "publish_approved");
    await startStagingDeploy(f.svc, (await getRelease(f.svc, f.o.orgId, second.release_id))!, f.o.userId);
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, second.release_id))!.rollback_state === "done", 15_000);
    expect(runner.errors).toEqual([]);
    const rows = (
      await f.svc.db
        .prepare("SELECT action, detail_json, client_visible, client_detail_json FROM events WHERE org_id = ? AND subject_kind = 'release' AND subject_id IN (?, ?) ORDER BY seq")
        .bind(f.o.orgId, first.release_id, second.release_id)
        .all<{ action: string; detail_json: string | null; client_visible: number; client_detail_json: string | null }>()
    ).results;
    const actions = rows.map((r) => r.action);
    for (const a of ["release.prepare_requested", "release.prepared", "release.deploy_requested", "release.live", "release.health_failed", "release.rolled_back"]) expect(actions).toContain(a);
    for (const r of rows) {
      expect([r.action, JSON.parse(r.detail_json ?? "{}").channel]).toEqual([r.action, "staging"]);
      if (r.client_visible) expect([r.action, JSON.parse(r.client_detail_json ?? "{}").channel]).toEqual([r.action, "staging"]);
    }
  });

  it("the deploy lock is per channel: a production deploy in flight does not block staging, another staging deploy does", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h, { manual: true });
    const a = await prepareStagingRelease(f.svc, await f.stagingInput("b-1"));
    const b = await prepareStagingRelease(f.svc, await f.stagingInput("b-2"));
    await runner.runPending();
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, b.release_id))!.state === "publish_approved" && (await getRelease(f.svc, f.o.orgId, a.release_id))!.state === "publish_approved");
    // a production release of the same project, deploying right now
    await f.svc.db
      .prepare("INSERT INTO releases (release_id, org_id, project_id, accepted_version_id, sources_json, recipe_json, recipe_revision, policy_revision, environment_json, env_digest, identity_key, state, build_state, created_by, created_at, updated_at) SELECT 'rel-prod-inflight', org_id, project_id, 'av-1', sources_json, recipe_json, recipe_revision, policy_revision, environment_json, env_digest, 'prod-identity', 'deploying', 'built', created_by, created_at, ? FROM releases WHERE release_id = ?")
      .bind(f.svc.nowIso(), a.release_id)
      .run();
    expect((await getRelease(f.svc, f.o.orgId, "rel-prod-inflight"))!.channel).toBe("production");
    await startStagingDeploy(f.svc, (await getRelease(f.svc, f.o.orgId, a.release_id))!, f.o.userId);
    expect((await getRelease(f.svc, f.o.orgId, a.release_id))!.state).toBe("deploying");
    // a second staging deploy waits for the first
    await expect(startStagingDeploy(f.svc, (await getRelease(f.svc, f.o.orgId, b.release_id))!, f.o.userId)).rejects.toMatchObject({ code: "deploy_in_progress" });
    // the production row was never touched
    expect((await getRelease(f.svc, f.o.orgId, "rel-prod-inflight"))!.state).toBe("deploying");
  });

  it("a staging deploy request sweeps only staging releases: a stale production deploy is left alone", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const rel = await prepareStagingRelease(f.svc, await f.stagingInput("b-1"));
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, rel.release_id))!.state === "publish_approved");
    // a production deploy whose job never existed and that has not moved for an hour (sweepable)
    const old = new Date(Date.now() - 3_600_000).toISOString();
    await f.svc.db
      .prepare("INSERT INTO releases (release_id, org_id, project_id, accepted_version_id, sources_json, recipe_json, recipe_revision, policy_revision, environment_json, env_digest, identity_key, state, build_state, created_by, created_at, updated_at) SELECT 'rel-prod-stale', org_id, project_id, 'av-1', sources_json, recipe_json, recipe_revision, policy_revision, environment_json, env_digest, 'prod-identity', 'deploying', 'built', created_by, created_at, ? FROM releases WHERE release_id = ?")
      .bind(old, rel.release_id)
      .run();
    await startStagingDeploy(f.svc, (await getRelease(f.svc, f.o.orgId, rel.release_id))!, f.o.userId);
    expect((await getRelease(f.svc, f.o.orgId, "rel-prod-stale"))!.state).toBe("deploying");
  });

  it("a staging deploy never targets a production Worker of the org (another project's policy, or a production live deployment)", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const rel = await prepareStagingRelease(f.svc, await f.stagingInput("b-1"));
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, rel.release_id))!.state === "publish_approved");
    const name = `cfapp-${f.o.orgId}-api-staging`;
    // another project's production policy names it (stored before -staging names were reserved; the API refuses it now)
    const other = await projectWith(f.h, f.o, []);
    const policy = { release: { targets: [{ targetId: "a", kind: "worker", mountName: "a", outputPath: "dist", main: "index.js", workerName: name }] } };
    await f.svc.db.prepare("UPDATE projects SET policy_json = ? WHERE project_id = ?").bind(JSON.stringify(policy), other).run();
    await expect(startStagingDeploy(f.svc, (await getRelease(f.svc, f.o.orgId, rel.release_id))!, f.o.userId)).rejects.toMatchObject({ code: "release_target_in_use", status: 409 });
    await f.svc.db.prepare("UPDATE projects SET policy_json = '{}' WHERE project_id = ?").bind(other).run();
    // a production live pointer records a deployment to it
    await f.svc.db
      .prepare("INSERT INTO release_live (org_id, project_id, release_id, accepted_version_id, output_digest, deployments_json, since) VALUES (?, ?, 'rel-prod-live', 'av-1', ?, ?, ?)")
      .bind(f.o.orgId, other, "1".repeat(64), JSON.stringify([{ targetId: "a", workerName: name, versionId: "v1", url: "https://x" }]), f.svc.nowIso())
      .run();
    await expect(startStagingDeploy(f.svc, (await getRelease(f.svc, f.o.orgId, rel.release_id))!, f.o.userId)).rejects.toMatchObject({ code: "release_target_in_use", status: 409 });
    expect((await getRelease(f.svc, f.o.orgId, rel.release_id))!.state).toBe("publish_approved");
    // gone from production: staging deploys again
    await f.svc.db.prepare("DELETE FROM release_live WHERE release_id = 'rel-prod-live'").run();
    await startStagingDeploy(f.svc, (await getRelease(f.svc, f.o.orgId, rel.release_id))!, f.o.userId);
    expect((await getRelease(f.svc, f.o.orgId, rel.release_id))!.state).toBe("deploying");
  });

  it("the publish route refuses a staging release", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const rel = await prepareStagingRelease(f.svc, await f.stagingInput("b-1"));
    const r = await f.h.api("POST", `/api/orgs/${f.o.orgId}/releases/${rel.release_id}/publish-approvals`, { token: f.o.token, body: { outputDigest: "0".repeat(64) } });
    expect([r.status, r.body.error.code]).toEqual([409, "staging_release"]);
  });

  it("production listings never show staging releases", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    await f.liveStaging("b-1");
    const list = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/releases`, { token: f.o.token });
    expect(list.body).toEqual({ releases: [], live: null });
    expect((await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/releases/live`, { token: f.o.token })).body).toEqual({ live: null });
  });

  it("only startStagingDeploy deploys a staging release, and only a staging release", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const rel = await prepareStagingRelease(f.svc, await f.stagingInput("b-1"));
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, rel.release_id))!.state === "publish_approved");
    // the production deploy route still needs a publish approval, which a staging release never gets
    const d = await f.h.api("POST", `/api/orgs/${f.o.orgId}/releases/${rel.release_id}/deploy`, { token: f.o.token, body: { idempotencyKey: "deploy-staging-1" } });
    expect([d.status, d.body.error.code]).toEqual([409, "publish_approval_required"]);
    await f.svc.db.prepare("UPDATE releases SET channel = 'production' WHERE release_id = ?").bind(rel.release_id).run();
    await expect(startStagingDeploy(f.svc, (await getRelease(f.svc, f.o.orgId, rel.release_id))!, f.o.userId)).rejects.toMatchObject({ code: "not_staging" });
  });

  it("a staging deploy binds only this project's staging resources and -staging Worker names", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const rel = await prepareStagingRelease(f.svc, await f.stagingInput("b-1"));
    await f.until(async () => (await getRelease(f.svc, f.o.orgId, rel.release_id))!.state === "publish_approved");
    const row = (await getRelease(f.svc, f.o.orgId, rel.release_id))!;
    const receipt = JSON.parse(row.build_receipt_json!) as { targets: Array<{ config: { kvNamespaces: Array<{ binding: string; id: string }>; d1Databases?: Array<{ binding: string; id: string }> } }> };
    const env = JSON.parse(row.environment_json) as { targets: Array<{ workerName: string }> };
    const tamper = async (patch: { receipt?: unknown; env?: unknown }) => {
      await f.svc.db.prepare("UPDATE releases SET build_receipt_json = ?, environment_json = ? WHERE release_id = ?").bind(JSON.stringify(patch.receipt ?? receipt), JSON.stringify(patch.env ?? env), rel.release_id).run();
      return (await getRelease(f.svc, f.o.orgId, rel.release_id))!;
    };
    const t0 = receipt.targets[0]!;
    // a production KV namespace of the org (org_deploy_resources) is not a staging resource
    const prodKv = await f.h.api("POST", `/api/orgs/${f.o.orgId}/deploy-resources`, { token: f.o.token, body: { kind: "kv", name: "orders" } });
    const kvForeign = { targets: [{ ...t0, config: { ...t0.config, kvNamespaces: [{ binding: "ORDERS", id: prodKv.body.id }] } }] };
    await expect(startStagingDeploy(f.svc, await tamper({ receipt: kvForeign }), f.o.userId)).rejects.toMatchObject({ code: "binding_not_allowed" });
    // another project's staging D1 is not this project's
    const other = crypto.randomUUID();
    await f.svc.db.prepare("INSERT INTO staging_resources (org_id, project_id, target_id, kind, binding, generation, resource_id, state, created_at) VALUES (?, 'p-other', 'api', 'd1', 'DB', 1, ?, 'active', ?)").bind(f.o.orgId, other, f.svc.nowIso()).run();
    const d1Foreign = { targets: [{ ...t0, config: { ...t0.config, d1Databases: [{ binding: "DB", id: other }] } }] };
    await expect(startStagingDeploy(f.svc, await tamper({ receipt: d1Foreign }), f.o.userId)).rejects.toMatchObject({ code: "binding_not_allowed" });
    // a production Worker name (no -staging suffix) is refused
    await expect(startStagingDeploy(f.svc, await tamper({ env: { ...env, targets: [{ ...env.targets[0]!, workerName: `cfapp-${f.o.orgId}-api` }] } }), f.o.userId)).rejects.toMatchObject({ code: "release_target_not_allowed" });
    // nothing was deployed
    expect((await getRelease(f.svc, f.o.orgId, rel.release_id))!.state).toBe("publish_approved");
    // a retired generation of this project's own resources is still allowed (rolling back to an older staging release)
    await f.svc.db.prepare("UPDATE staging_resources SET state = 'retired' WHERE org_id = ? AND project_id = ?").bind(f.o.orgId, f.pid).run();
    await startStagingDeploy(f.svc, await tamper({}), f.o.userId);
    expect((await getRelease(f.svc, f.o.orgId, rel.release_id))!.state).toBe("deploying");
  });
});
