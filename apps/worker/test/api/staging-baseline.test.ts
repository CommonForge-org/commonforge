/**
 * Staging phase 2b, Task 3 (B6, B7): staging in a project starts after the owner's baseline — a
 * production release live while production equals `main` on every source. Before it, landings wait
 * (`awaiting_baseline`, nothing built), promote and reset are refused, and a waiting landing rolls
 * back at once. Clearance releases start from the baseline's revisions (no genesis exemption).
 */
import { describe, expect, it } from "vitest";
import { runGc } from "../../src/services/gc.js";
import { getPromotion, type PromotionRow } from "../../src/services/promotions.js";
import { onProductionLive } from "../../src/services/releases.js";
import { FakeRunner } from "../fakes/runner.js";
import { codeResource } from "../helpers.js";
import { STAGING_SECTION, stagingFixture, stagingReleasePolicy, type StagingFixture } from "../staging-helpers.js";

const WAITING = "Waiting for the owner's first production publish.";
const SELF = { ...STAGING_SECTION, promotion: { rules: [{ paths: ["api/public/**"], level: "self" }], classifier: { provider: "none", threshold: 0.9 } } };
const DONE_STATES = ["live", "release_failed", "failed", "pending_approval", "superseded", "sent_back"];

function promotionHelpers(f: StagingFixture) {
  const promote = (token: string, taskId: string) => f.h.api("POST", `/api/tasks/${taskId}/promote`, { token, body: {} });
  const row = async (id: string): Promise<PromotionRow> => (await getPromotion(f.svc, id))!;
  async function untilState(id: string, ...states: string[]): Promise<PromotionRow> {
    await f.until(async () => states.includes((await row(id)).state), 30_000);
    return row(id);
  }
  return { promote, untilState };
}

const baselineOf = (f: StagingFixture) => f.svc.db.prepare("SELECT release_id, sources_json FROM staging_baselines WHERE org_id = ? AND project_id = ?").bind(f.o.orgId, f.pid).first<{ release_id: string; sources_json: string }>();

describe("staging starts after the owner's production baseline", { timeout: 120_000 }, () => {
  it("without a baseline: tasks are created, landings wait (no build), staging says so, promote and reset are refused", async () => {
    const f = await stagingFixture({ baseline: false });
    new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const taskId = await f.submitTask(client.token, "Copy", { "public/a.html": "a\n" });
    const landingId = await f.landingIdOf(taskId);
    await f.h.drainSteps();
    const l = await f.svc.db.prepare("SELECT state, reason_code, reason FROM staging_landings WHERE landing_id = ?").bind(landingId).first();
    expect(l).toEqual({ state: "checking", reason_code: "awaiting_baseline", reason: WAITING });
    expect((await f.svc.db.prepare("SELECT COUNT(*) AS n FROM staging_builds WHERE org_id = ?").bind(f.o.orgId).first<{ n: number }>())!.n).toBe(0);
    const view = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging`, { token: client.token });
    expect(view.body).toMatchObject({ state: "awaiting_baseline", stateText: WAITING, baseline: null, landings: [{ landingId, state: "checking", reasonCode: "awaiting_baseline", reason: WAITING }] });
    const promote = await f.h.api("POST", `/api/tasks/${taskId}/promote`, { token: client.token, body: {} });
    expect([promote.status, promote.body.error.code]).toEqual([409, "staging_awaiting_baseline"]);
    const reset = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/reset`, { token: f.o.token, body: {} });
    expect([reset.status, reset.body.error.code]).toEqual([409, "staging_awaiting_baseline"]);
    expect(await baselineOf(f)).toBeNull();
  });

  it("the owner's publish of the current main establishes the baseline and starts the waiting build", async () => {
    const f = await stagingFixture({ baseline: false });
    new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const taskId = await f.submitTask(client.token, "Copy", { "public/a.html": "a\n" });
    const landingId = await f.landingIdOf(taskId);
    const rel = await f.ownerPublish();
    const b = await baselineOf(f);
    expect(b?.release_id).toBe(rel.release_id);
    expect(JSON.parse(b!.sources_json)).toEqual(JSON.parse(rel.sources_json));
    await f.untilLanded(taskId);
    expect(await f.svc.db.prepare("SELECT state, reason_code, reason FROM staging_landings WHERE landing_id = ?").bind(landingId).first()).toEqual({ state: "landed", reason_code: null, reason: null });
    expect((await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging`, { token: client.token })).body).toMatchObject({ state: "active", stateText: null, baseline: { since: expect.any(String) } });
    // only owners and developers see which release it was
    expect((await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging`, { token: client.token })).body.baseline.releaseId).toBeUndefined();
    expect((await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging`, { token: f.o.token })).body.baseline.releaseId).toBe(rel.release_id);
    const events = (await f.svc.db.prepare("SELECT detail_json, client_detail_json FROM events WHERE org_id = ? AND action = 'staging.baseline_established'").bind(f.o.orgId).all<{ detail_json: string; client_detail_json: string }>()).results;
    expect(events).toHaveLength(1);
    // the release id is for owners and developers only
    expect(JSON.parse(events[0]!.detail_json)).toMatchObject({ releaseId: rel.release_id });
    expect(JSON.parse(events[0]!.client_detail_json)).toEqual({});
  });

  it("a live release behind main is no baseline; publishing main is", async () => {
    const f = await stagingFixture({ baseline: false, staging: false });
    new FakeRunner(f.h);
    await f.ownerPublish();
    await f.acceptOnMain({ "src/other.ts": "x\n" }); // main moves past production
    const put = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { release: stagingReleasePolicy(f.o.orgId), staging: STAGING_SECTION } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(await baselineOf(f)).toBeNull();
    const rel = await f.ownerPublish();
    expect((await baselineOf(f))?.release_id).toBe(rel.release_id);
  });

  it("turning staging on when production already runs main establishes the baseline at once; turning it off and on keeps it", async () => {
    const f = await stagingFixture({ baseline: false, staging: false });
    new FakeRunner(f.h);
    const rel = await f.ownerPublish();
    expect(await baselineOf(f)).toBeNull(); // staging mode is off: no baseline yet
    const on = { release: stagingReleasePolicy(f.o.orgId), staging: STAGING_SECTION };
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: on })).status).toBe(200);
    expect((await baselineOf(f))?.release_id).toBe(rel.release_id);
    await f.acceptOnMain({ "src/other.ts": "x\n" });
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { release: stagingReleasePolicy(f.o.orgId) } })).status).toBe(200);
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: on })).status).toBe(200);
    expect((await baselineOf(f))?.release_id).toBe(rel.release_id);
  });

  it("a waiting landing rolled back before the baseline leaves at once", async () => {
    const f = await stagingFixture({ baseline: false });
    new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const taskId = await f.submitTask(client.token, "Copy", { "public/a.html": "a\n" });
    const landingId = await f.landingIdOf(taskId);
    const r = await f.h.api("POST", `/api/tasks/${taskId}/rollback`, { token: client.token, body: {} });
    expect([r.status, r.body.buildId]).toEqual([202, null]);
    expect((await f.svc.db.prepare("SELECT state FROM staging_landings WHERE landing_id = ?").bind(landingId).first<{ state: string }>())!.state).toBe("rolled_back");
    // its landing proposal is closed like any rolled-back landing's
    const proposalId = (await f.svc.db.prepare("SELECT proposal_id FROM staging_landings WHERE landing_id = ?").bind(landingId).first<{ proposal_id: string }>())!.proposal_id;
    expect((await f.svc.ledger(f.o.orgId).getProposal(proposalId))!.state).toBe("withdrawn");
    // a later baseline builds nothing for it
    await f.ownerPublish();
    await f.h.drainSteps();
    expect((await f.svc.db.prepare("SELECT COUNT(*) AS n FROM staging_builds WHERE org_id = ?").bind(f.o.orgId).first<{ n: number }>())!.n).toBe(0);
  });
});

/** While installed, every staging build request fails (a D1 trigger refuses the insert). */
async function failBuildRequests(f: StagingFixture, on: boolean): Promise<void> {
  await f.svc.db.prepare(on ? "CREATE TRIGGER test_fail_builds BEFORE INSERT ON staging_builds BEGIN SELECT RAISE(ABORT, 'test: staging build request fails'); END" : "DROP TRIGGER test_fail_builds").run();
}

describe("a kick that failed is repeated (state-based)", { timeout: 120_000 }, () => {
  for (const via of ["gc", "policy save", "next go-live"] as const) {
    it(`the first kick after the owner's publish fails; the ${via} starts the waiting build`, async () => {
      const f = await stagingFixture({ baseline: false });
      new FakeRunner(f.h);
      const client = await f.clientWithAccess();
      const taskId = await f.submitTask(client.token, "Copy", { "public/a.html": "a\n" });
      const landingId = await f.landingIdOf(taskId);
      await failBuildRequests(f, true);
      await f.ownerPublish(); // live, baseline written; the hook's kick fails (logged, release stays live)
      await failBuildRequests(f, false);
      expect(await baselineOf(f)).not.toBeNull();
      expect(await f.svc.db.prepare("SELECT state, reason_code FROM staging_landings WHERE landing_id = ?").bind(landingId).first()).toEqual({ state: "checking", reason_code: "awaiting_baseline" });
      if (via === "gc") await runGc(f.svc, { orgs: [f.o.orgId] });
      else if (via === "policy save") expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { release: stagingReleasePolicy(f.o.orgId), staging: STAGING_SECTION } })).status).toBe(200);
      else {
        await f.acceptOnMain({ "README.md": "next\n" });
        await f.ownerPublish();
      }
      await f.untilLanded(taskId);
      expect(await f.svc.db.prepare("SELECT state, reason_code, reason FROM staging_landings WHERE landing_id = ?").bind(landingId).first()).toEqual({ state: "landed", reason_code: null, reason: null });
    });
  }
});

describe("production-live hooks", { timeout: 120_000 }, () => {
  it("a throwing hook does not stop the next one (nor the baseline's)", async () => {
    const f = await stagingFixture({ baseline: false });
    new FakeRunner(f.h);
    let throwing = true;
    const seen: string[] = [];
    onProductionLive(async (_svc, rel) => {
      if (throwing && rel.org_id === f.o.orgId) throw new Error("test hook fails");
    });
    onProductionLive(async (_svc, rel) => {
      if (rel.org_id === f.o.orgId) seen.push(rel.release_id);
    });
    const rel = await f.ownerPublish();
    throwing = false;
    expect(rel.state).toBe("live");
    expect(seen).toEqual([rel.release_id]);
    expect((await baselineOf(f))?.release_id).toBe(rel.release_id);
  });
});

describe("clearance releases start from the baseline (B7: no genesis exemption)", { timeout: 180_000 }, () => {
  it("end to end with a real baseline: the owner publishes, a client's copy task lands and goes live self-cleared", async () => {
    const f = await stagingFixture({ staging: SELF, baseline: false });
    new FakeRunner(f.h);
    const { promote, untilState } = promotionHelpers(f);
    const client = await f.clientWithAccess();
    const first = await f.ownerPublish();
    expect((await baselineOf(f))?.release_id).toBe(first.release_id);
    const taskId = await f.submitTask(client.token, "Copy", { "public/a.html": "a\n" });
    await f.untilLanded(taskId);
    const r = await promote(client.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const p = await untilState(r.body.promotionId, ...DONE_STATES);
    expect(p).toMatchObject({ state: "live", clearance_kind: "self", reason_code: null });
    expect(p.release_id).not.toBe(first.release_id);
  });

  it("a direct accept before the baseline is owner-published: a self-cleared promotion goes live", async () => {
    const f = await stagingFixture({ staging: SELF, baseline: false });
    new FakeRunner(f.h);
    const { promote, untilState } = promotionHelpers(f);
    const client = await f.clientWithAccess();
    await f.acceptOnMain({ "README.md": "before the baseline\n" });
    await f.seedBaseline(); // stands for the owner's publish of this main
    const taskId = await f.submitTask(client.token, "Copy", { "public/a.html": "a\n" });
    await f.untilLanded(taskId);
    const r = await promote(client.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(await untilState(r.body.promotionId, ...DONE_STATES)).toMatchObject({ state: "live", reason_code: null });
  });

  it("a direct accept after the baseline that no promotion made needs an owner's publish", async () => {
    const f = await stagingFixture({ staging: SELF });
    new FakeRunner(f.h);
    const { promote, untilState } = promotionHelpers(f);
    const client = await f.clientWithAccess();
    await f.acceptOnMain({ "README.md": "after the baseline\n" });
    const taskId = await f.submitTask(client.token, "Copy", { "public/a.html": "a\n" });
    await f.untilLanded(taskId);
    const r = await promote(client.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const p = await untilState(r.body.promotionId, ...DONE_STATES);
    expect(p).toMatchObject({ state: "release_failed", reason_code: "release_needs_publish_approval" });
    expect(p.detail).toContain("no promotion cleared");
  });

  it("a folder mounted after the baseline needs an owner's publish, even with only its adopted head and nothing ever live", async () => {
    const f = await stagingFixture({ staging: SELF });
    new FakeRunner(f.h);
    const { promote, untilState } = promotionHelpers(f);
    const client = await f.clientWithAccess();
    const assets = await codeResource(f.h, f.o, "assets", { "logo.svg": "<svg/>\n" });
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: { mountName: "assets", resourceId: assets.resourceId } })).status).toBe(201);
    const release = stagingReleasePolicy(f.o.orgId);
    release.recipe.steps.push({ stepId: "assets", mountName: "assets", command: "true" });
    expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { release, staging: SELF } })).status).toBe(200);
    const taskId = await f.submitTask(client.token, "Copy", { "public/a.html": "a\n" });
    await f.untilLanded(taskId);
    const p = await untilState((await promote(client.token, taskId)).body.promotionId, ...DONE_STATES);
    expect(p).toMatchObject({ state: "release_failed", reason_code: "release_needs_publish_approval" });
    expect(p.detail).toContain(assets.resourceId);
  });
});
