/**
 * Staging phase 2b, Task 4: promotions of one project run in parallel on disjoint landing sets
 * (landing claims, B1); accept and release take turns per project (the production claim, B2) in
 * accept order, and a cleared promotion waits for production in clearance order (B3); each
 * promotion steps under its own lock (B4).
 */
import { describe, expect, it } from "vitest";
import { runGc } from "../../src/services/gc.js";
import { repairPromotingLandings } from "../../src/services/promotions.js";
import { getRelease } from "../../src/services/releases.js";
import { DONE_STATES, releaseFixture } from "../promotion-helpers.js";

describe("parallel promotions", { timeout: 180_000 }, () => {
  it("two disjoint promotions run at the same time; accept and release take turns (accept order)", async () => {
    const { f, client, promote, untilState, landTask } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    const ra = await promote(client.token, a);
    const rb = await promote(client.token, b);
    expect([ra.status, rb.status], JSON.stringify([ra.body, rb.body])).toEqual([202, 202]);
    const [ida, idb] = [ra.body.promotionId as string, rb.body.promotionId as string];
    expect((await untilState(ida, ...DONE_STATES)).state).toBe("live");
    expect((await untilState(idb, ...DONE_STATES)).state).toBe("live");
    // production windows never overlap: accepted(X), live(X), accepted(Y), live(Y)
    const seq = (await f.svc.db.prepare("SELECT action, subject_id FROM events WHERE org_id = ? AND action IN ('promotion.accepted', 'promotion.live') ORDER BY rowid").bind(f.o.orgId).all<{ action: string; subject_id: string }>()).results;
    expect(seq.map((e) => e.action)).toEqual(["promotion.accepted", "promotion.live", "promotion.accepted", "promotion.live"]);
    expect(seq[0]!.subject_id).toBe(seq[1]!.subject_id);
    expect(seq[2]!.subject_id).toBe(seq[3]!.subject_id);
    // every claim ended with its accept
    expect(await f.svc.db.prepare("SELECT 1 FROM promotion_landings WHERE active = 1 AND promotion_id IN (?, ?)").bind(ida, idb).first()).toBeNull();
  });

  it("a promotion waiting for a developer holds nothing: a later self promotion passes it; the approved one rebuilds without counting and carries its clearance", async () => {
    const { f, client, promote, approve, untilState, landTask, row } = await releaseFixture();
    const dev = await f.memberWithAccess("developer", "write");
    const a = await landTask(client.token, "API", { "src/a.ts": "export const a = 1;\n" });
    const b = await landTask(client.token, "Copy", { "public/b.html": "b\n" });
    const ida = (await promote(client.token, a)).body.promotionId as string;
    await untilState(ida, "pending_approval");
    const idb = (await promote(client.token, b)).body.promotionId as string;
    expect((await untilState(idb, ...DONE_STATES)).state).toBe("live");
    expect((await row(ida)).state).toBe("pending_approval");
    expect((await approve(dev.token, ida)).status).toBe(200);
    const pa = await untilState(ida, ...DONE_STATES);
    expect(pa).toMatchObject({ state: "live", rebuilds: 0, clearance_kind: "developer", cleared_by: dev.userId });
  });

  it("a set landing held by another in-flight promotion → 409 promotion_dependency_busy naming it; the task itself → promotion_in_progress naming it", async () => {
    const { runner, client, promote, untilState, landTask } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/x.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/x.html": "b\n" });
    runner.opts.hold = ["integrate"];
    const ida = (await promote(client.token, a)).body.promotionId as string;
    await untilState(ida, "building");
    const rb = await promote(client.token, b);
    expect([rb.status, rb.body.error.code, rb.body.error.details?.promotionId, rb.body.error.details?.taskId, rb.body.error.details?.title]).toEqual([409, "promotion_dependency_busy", ida, a, "A"]);
    expect(rb.body.error.message).toBe("'A' is being promoted; wait until it finishes");
    const again = await promote(client.token, a);
    expect([again.status, again.body.error.code, again.body.error.details?.promotionId]).toEqual([409, "promotion_in_progress", ida]);
  });

  it("concurrent requests whose sets share a landing: exactly one is accepted (landing claims)", async () => {
    const { f, client, promote, landTask } = await releaseFixture();
    await landTask(client.token, "Base", { "public/x.html": "0\n" });
    const a = await landTask(client.token, "A", { "public/x.html": "a\n", "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/y.html": "b\n", "public/b.html": "b\n" });
    // C's set is [Base, A, C], A's is [Base, A]; B shares nothing with either
    const c = await landTask(client.token, "C", { "public/x.html": "c\n", "public/c.html": "c\n" });
    const rs = await Promise.all([promote(client.token, a), promote(client.token, c)]);
    expect(rs.map((r) => r.status).sort(), JSON.stringify(rs.map((r) => r.body))).toEqual([202, 409]);
    // the database invariant: no landing is claimed twice
    expect(await f.svc.db.prepare("SELECT landing_id FROM promotion_landings WHERE active = 1 GROUP BY landing_id HAVING COUNT(*) > 1").first()).toBeNull();
    expect((await promote(client.token, b)).status).toBe(202);
  });

  it("a cleared promotion waits while another holds production (production_busy, chain ended) and goes on when it is released; retry-release meanwhile → 409 production_busy", async () => {
    const { f, runner, client, promote, retry, row, view, untilState, landTask } = await releaseFixture();
    const dev = await f.memberWithAccess("developer", "write");
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    const c = await landTask(client.token, "C", { "public/c.html": "c\n" });
    runner.opts.deployWithoutActivating = true;
    const ida = (await promote(client.token, a)).body.promotionId as string;
    expect((await untilState(ida, ...DONE_STATES)).state).toBe("release_failed");
    runner.opts.deployWithoutActivating = false;
    runner.opts.hold = ["release-deploy"];
    const idb = (await promote(client.token, b)).body.promotionId as string;
    await f.until(async () => {
      const p = await row(idb);
      return p.state === "releasing" && !!p.release_id && (await getRelease(f.svc, f.o.orgId, p.release_id))!.state === "deploying";
    }, 30_000);
    const idc = (await promote(client.token, c)).body.promotionId as string;
    await f.until(async () => {
      const p = await row(idc);
      return p.state === "cleared" && p.chain_at === null;
    }, 30_000);
    expect(await row(idc)).toMatchObject({ reason_code: "production_busy", reason: "Waiting for another update to reach production." });
    expect((await view(client.token, idc)).body).toMatchObject({ state: "cleared", waitingForProduction: true, reason: "Waiting for another update to reach production." });
    const r = await retry(dev.token, ida);
    expect([r.status, r.body.error?.code, r.body.error?.details?.promotionId]).toEqual([409, "production_busy", idb]);
    expect((await row(ida)).state).toBe("release_failed");
    runner.opts.hold = [];
    await runner.runPending();
    expect((await untilState(idb, ...DONE_STATES)).state).toBe("live");
    expect((await untilState(ida, "live")).state).toBe("live"); // B's release contains A (P2-4)
    const pc = await untilState(idc, ...DONE_STATES);
    expect(pc).toMatchObject({ state: "live", rebuilds: 0 });
    // C's accept came after B's release ended (accept order)
    const seq = (await f.svc.db.prepare("SELECT action, subject_id FROM events WHERE org_id = ? AND action IN ('promotion.accepted', 'promotion.live') AND subject_id IN (?, ?) ORDER BY rowid").bind(f.o.orgId, idb, idc).all<{ action: string; subject_id: string }>()).results;
    expect(seq).toEqual([
      { action: "promotion.accepted", subject_id: idb },
      { action: "promotion.live", subject_id: idb },
      { action: "promotion.accepted", subject_id: idc },
      { action: "promotion.live", subject_id: idc },
    ]);
  });

  it("waiting promotions take production in clearance order; the accept deadline starts when production is taken", async () => {
    const { f, runner, client, promote, row, untilState, untilHeld, resume, landTask } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    const c = await landTask(client.token, "C", { "public/c.html": "c\n" });
    runner.opts.hold = ["release-deploy"];
    const ida = (await promote(client.token, a)).body.promotionId as string;
    await f.until(async () => (await row(ida)).state === "releasing", 30_000);
    // B and C clear (B first) and wait; C is resumed first, but B is ahead in line
    const idb = (await promote(client.token, b)).body.promotionId as string;
    await untilHeld(idb, (p) => p.state === "cleared");
    const idc = (await promote(client.token, c)).body.promotionId as string;
    await untilHeld(idc, (p) => p.state === "cleared");
    expect((await row(idb)).cleared_at! <= (await row(idc)).cleared_at!).toBe(true);
    // the cleared promotions waited long (an old clearance): the accept deadline counts from the claim
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    await f.svc.db.prepare("UPDATE promotions SET cleared_at = ? WHERE promotion_id = ?").bind(old, idb).run();
    await resume(idc);
    await resume(idb);
    await f.h.drainSteps(2);
    runner.opts.hold = [];
    await runner.runPending();
    expect((await untilState(ida, ...DONE_STATES)).state).toBe("live");
    expect((await untilState(idb, ...DONE_STATES)).state).toBe("live");
    expect((await untilState(idc, ...DONE_STATES)).state).toBe("live");
    const accepted = (await f.svc.db.prepare("SELECT subject_id FROM events WHERE org_id = ? AND action = 'promotion.accepted' ORDER BY rowid").bind(f.o.orgId).all<{ subject_id: string }>()).results.map((e) => e.subject_id);
    expect(accepted).toEqual([ida, idb, idc]);
    expect((await row(idb)).claimed_at! > old).toBe(true);
  });

  it("two promotions building at once keep their own chains (per-promotion step lock)", async () => {
    const { f, runner, client, promote, untilState, landTask, row } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    runner.opts.hold = ["integrate"];
    const ida = (await promote(client.token, a)).body.promotionId as string;
    const idb = (await promote(client.token, b)).body.promotionId as string;
    await untilState(ida, "building");
    await untilState(idb, "building");
    await f.h.drainSteps(4);
    expect((await row(ida)).chain_at).not.toBeNull();
    expect((await row(idb)).chain_at).not.toBeNull();
    runner.opts.hold = [];
    await runner.runPending();
    expect((await untilState(ida, ...DONE_STATES)).state).toBe("live");
    expect((await untilState(idb, ...DONE_STATES)).state).toBe("live");
  });

  it("GC repairs a promoting landing with no active claim and releases claims of ended promotions", async () => {
    const { f, client, landTask, landingState } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const landing = (await f.svc.db.prepare("SELECT landing_id FROM staging_landings WHERE task_id = ?").bind(a).first<{ landing_id: string }>())!.landing_id;
    const now = new Date().toISOString();
    // a promotion that ended with its claim still active and its landing still promoting (as a crash before the batch would leave)
    await f.svc.db.batch([
      f.svc.db.prepare("INSERT INTO promotions (promotion_id, org_id, project_id, target_landing_id, landings_json, state, requested_by, created_at, updated_at) VALUES ('prm-ended', ?, ?, ?, ?, 'failed', ?, ?, ?)").bind(f.o.orgId, f.pid, landing, JSON.stringify([landing]), client.userId, now, now),
      f.svc.db.prepare("UPDATE staging_landings SET state = 'promoting' WHERE landing_id = ?").bind(landing),
      f.svc.db.prepare("INSERT INTO promotion_landings (promotion_id, landing_id, org_id, project_id, active, created_at) VALUES ('prm-ended', ?, ?, ?, 1, ?)").bind(landing, f.o.orgId, f.pid, now),
    ]);
    expect(await repairPromotingLandings(f.svc, f.o.orgId)).toBe(2);
    expect(await landingState(a)).toBe("landed");
    expect(await f.svc.db.prepare("SELECT active FROM promotion_landings WHERE promotion_id = 'prm-ended'").first<{ active: number }>()).toEqual({ active: 0 });
  });
  it("a promotion built before another promotion's accept rebuilds without counting toward the cap (I1)", async () => {
    const { f, runner, client, promote, row, untilState, landTask } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    runner.opts.hold = ["integrate"];
    const ida = (await promote(client.token, a)).body.promotionId as string;
    const idb = (await promote(client.token, b)).body.promotionId as string;
    await untilState(ida, "building");
    await untilState(idb, "building");
    // only B's build answers: B goes live while A's build (on the old main) waits
    const jobB = (await row(idb)).integrate_job_id;
    const job = runner.pending.find((j) => j.jobId === jobB)!;
    runner.pending.splice(runner.pending.indexOf(job), 1);
    await runner.run(job);
    expect((await untilState(idb, ...DONE_STATES)).state).toBe("live");
    expect((await row(ida)).state).toBe("building");
    runner.opts.hold = [];
    await runner.runPending();
    const pa = await untilState(ida, ...DONE_STATES);
    expect(pa).toMatchObject({ state: "live", rebuilds: 0 });
    expect(pa.promotion_rebuilds).toBeGreaterThanOrEqual(1);
  });

  it("the first in line rebuilds on the new main while the holder releases, so it takes production without another rebuild when the release ends", async () => {
    const { f, runner, client, promote, row, untilRow, untilState, landTask } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    // both proposals are built on the same main; one accepts first and holds production
    runner.opts.hold = ["integrate", "release-deploy"];
    const ida = (await promote(client.token, a)).body.promotionId as string;
    const idb = (await promote(client.token, b)).body.promotionId as string;
    await untilState(ida, "building");
    await untilState(idb, "building");
    runner.opts.hold = ["release-deploy"];
    await runner.runPending();
    let holder = "";
    await f.until(async () => {
      await f.h.drainSteps(1);
      for (const id of [ida, idb]) if ((await row(id)).state === "releasing") holder = id;
      return !!holder;
    }, 30_000);
    const waiter = holder === ida ? idb : ida;
    // the waiter rebuilds now (the holder's accept moved main) and waits, ready, on the new main
    const ready = await untilRow(waiter, (p) => p.state === "cleared" && p.reason_code === "production_busy" && p.promotion_rebuilds >= 1, 30_000);
    expect(ready.rebuilds).toBe(0);
    expect((await row(holder)).state).toBe("releasing");
    const proposal = (await f.svc.ledger(f.o.orgId).getProposal(ready.proposal_id!))!;
    for (const rc of proposal.resourceChanges) expect((await f.svc.ledger(f.o.orgId).getHead(rc.resourceId))?.revisionId).toBe(rc.baseRevision);
    runner.opts.hold = [];
    await runner.runPending();
    expect((await untilState(holder, ...DONE_STATES)).state).toBe("live");
    const done = await untilState(waiter, ...DONE_STATES);
    // no rebuild after the release ended: it took production with the proposal built during the release
    expect(done).toMatchObject({ state: "live", rebuilds: 0, promotion_rebuilds: ready.promotion_rebuilds, proposal_id: ready.proposal_id });
    const seq = (await f.svc.db.prepare("SELECT action, subject_id FROM events WHERE org_id = ? AND action IN ('promotion.accepted', 'promotion.live') AND subject_id IN (?, ?) ORDER BY rowid").bind(f.o.orgId, ida, idb).all<{ action: string; subject_id: string }>()).results;
    expect(seq).toEqual([
      { action: "promotion.accepted", subject_id: holder },
      { action: "promotion.live", subject_id: holder },
      { action: "promotion.accepted", subject_id: waiter },
      { action: "promotion.live", subject_id: waiter },
    ]);
  });

  it("the machine deadline after rebuilds caused by other promotions tells the client production kept changing", async () => {
    const { f, runner, client, promote, row, untilState, landTask } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    runner.opts.hold = ["integrate"];
    const id = (await promote(client.token, a)).body.promotionId as string;
    await untilState(id, "building");
    await f.svc.db.prepare("UPDATE promotions SET promotion_rebuilds = 2 WHERE promotion_id = ?").bind(id).run();
    f.h.deps.now = () => new Date(Date.now() + 7 * 3600_000);
    expect(await untilState(id, "failed")).toMatchObject({ reason_code: "promotion_timed_out", reason: "Production kept changing; promote again." });
    expect((await row(id)).rebuilds).toBe(0);
  });

  it("GC wakes the first promotion waiting for production when its queue nudge was lost", async () => {
    const { f, client, promote, row, untilState, untilHeld, landTask, queuedSteps } = await releaseFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const id = (await promote(client.token, a)).body.promotionId as string;
    await untilHeld(id, (p) => p.state === "cleared");
    // it waited for production; the release that freed production never nudged it (lost)
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await f.svc.db.prepare("UPDATE promotions SET reason_code = 'production_busy', reason = ?, chain_at = NULL, updated_at = ? WHERE promotion_id = ?").bind("Waiting for another update to reach production.", old, id).run();
    expect(queuedSteps(id)).toBe(0);
    await runGc(f.svc, { orgs: [f.o.orgId] });
    expect(queuedSteps(id)).toBe(1);
    expect((await untilState(id, ...DONE_STATES)).state).toBe("live");
    expect((await row(id)).reason_code).toBeNull();
  });
});
