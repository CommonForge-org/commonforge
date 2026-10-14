/**
 * Staging phase 2b, Task 6 (B8, B9): a promotion tries the task alone (without earlier overlapping
 * landings) when required checks cover every resource it changes, tells the client what it goes
 * without, and widens once to the closure when the alone build conflicts or a required check fails
 * (telling the client what it needs). Developers link a landing to an earlier one it must travel
 * with.
 */
import { describe, expect, it } from "vitest";
import { aloneFirstApplies } from "../../src/services/promotion-alone.js";
import { FakeRunner } from "../fakes/runner.js";
import { DONE_STATES, promotionHelpers, RELEASE_STAGING } from "../promotion-helpers.js";
import { STAGING_FILES, stagingFixture } from "../staging-helpers.js";

const PAGE = (l1: string, l3: string) => `${l1}\nmiddle\n${l3}\n`;
const API_TEST = { checkId: "api-test", mountName: "api", command: "pnpm test", timeoutSeconds: 60, required: true, gatesAlone: true };

/** The release fixture with `public/page.html` on main from the start and the policy's `checks` (default: a required `gatesAlone` check on `api`). */
async function aloneFixture(o: { checks?: unknown[] } = {}) {
  const f = await stagingFixture({ files: { ...STAGING_FILES, "public/page.html": PAGE("top", "bottom") }, staging: RELEASE_STAGING });
  const policy = JSON.parse((await f.project()).policy_json);
  const put = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { ...policy, checks: o.checks ?? [API_TEST] } });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  const runner = new FakeRunner(f.h);
  const client = await f.clientWithAccess();
  return { f, runner, client, ...promotionHelpers(f) };
}

type Fixture = Awaited<ReturnType<typeof aloneFixture>>;
const travelWith = (x: Fixture, token: string, landingId: string, withLandingId: string) => x.f.h.api("POST", `/api/orgs/${x.f.o.orgId}/staging/landings/${landingId}/travel-with`, { token, body: { landingId: withLandingId } });
const unlink = (x: Fixture, token: string, landingId: string, withLandingId: string) => x.f.h.api("DELETE", `/api/orgs/${x.f.o.orgId}/staging/landings/${landingId}/travel-with/${withLandingId}`, { token });
const claims = (x: Fixture, id: string) => x.f.svc.db.prepare("SELECT landing_id FROM promotion_landings WHERE promotion_id = ? AND active = 1 ORDER BY landing_id").bind(id).all<{ landing_id: string }>().then((r) => r.results.map((c) => c.landing_id).sort());

describe("aloneFirstApplies (B8)", () => {
  const mounts = [
    { mount_name: "api", resource_id: "r-api" },
    { mount_name: "site", resource_id: "r-site" },
  ];
  it("every changed resource needs a required gatesAlone check on one of its mounts", () => {
    expect(aloneFirstApplies({ checks: [API_TEST] }, new Set(["r-api"]), mounts)).toBe(true);
    expect(aloneFirstApplies({ checks: [{ ...API_TEST, required: undefined }] }, new Set(["r-api"]), mounts)).toBe(true); // default required
    expect(aloneFirstApplies({ checks: [{ ...API_TEST, gatesAlone: undefined }] }, new Set(["r-api"]), mounts)).toBe(false); // default: does not gate alone
    expect(aloneFirstApplies({ checks: [{ ...API_TEST, gatesAlone: false }] }, new Set(["r-api"]), mounts)).toBe(false);
    expect(aloneFirstApplies({ checks: [API_TEST] }, new Set(["r-api", "r-site"]), mounts)).toBe(false);
    expect(aloneFirstApplies({ checks: [{ ...API_TEST, required: false }] }, new Set(["r-api"]), mounts)).toBe(false);
    expect(aloneFirstApplies({ checks: [{ ...API_TEST, mountName: "site" }] }, new Set(["r-api"]), mounts)).toBe(false);
    expect(aloneFirstApplies({ checks: [] }, new Set(["r-api"]), mounts)).toBe(false);
    expect(aloneFirstApplies({ checks: [API_TEST] }, new Set(), mounts)).toBe(false);
  });
});

describe("alone-first", { timeout: 180_000 }, () => {
  it("with a required check on the changed folder, a task goes to production without an earlier overlapping landing (named up front)", async () => {
    const x = await aloneFixture();
    const { f, client, promote, view, untilState, landTask, mainFiles, landing, landingState } = x;
    const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const b = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
    const la = (await landing(a)).landing_id;
    const r = await promote(client.token, b);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ mode: "alone", landings: [{ taskId: b }], goingWithout: [{ landingId: la, taskId: a, title: "Header", text: "Going to production without 'Header' (still in staging)" }] });
    expect(r.body.landings).toHaveLength(1);
    const id = r.body.promotionId as string;
    expect(await claims(x, id)).toEqual([(await landing(b)).landing_id]);
    expect((await untilState(id, ...DONE_STATES)).state).toBe("live");
    // only Footer's own edit reached main (the explicit merge base leaves Header behind)
    expect((await mainFiles())["public/page.html"]).toBe(PAGE("top", "BOTTOM"));
    const v = (await view(client.token, id)).body;
    expect(v).toMatchObject({ mode: "alone", needs: [], goingWithout: [{ taskId: a, title: "Header", text: "Going to production without 'Header' (still in staging)" }] });
    // Header is still in staging, promotable on its own
    expect(await landingState(a)).toBe("landed");
    // gatesAlone is the promotion service's: the signed integrate jobs carry the check without it (byte-identical for runners)
    const integrates = x.runner.handled.filter((j) => j.job.kind === "integrate");
    expect(integrates.length).toBeGreaterThan(0);
    for (const j of integrates) {
      expect((j.job as { checks: unknown[] }).checks).toEqual([{ checkId: "api-test", mountName: "api", command: "pnpm test", timeoutSeconds: 60, required: true }]);
      expect(JSON.stringify(j)).not.toContain("gatesAlone");
    }
    void f;
  });

  it("an alone build that conflicts widens to the earlier tasks it needs and tells the client", async () => {
    const x = await aloneFixture();
    const { f, client, promote, view, untilState, untilRow, landTask, mainFiles, landing, row, events } = x;
    const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    // edits line 1 again, on top of Header: alone, it conflicts with main's line 1
    const b = await landTask(client.token, "Footer2", { "public/page.html": PAGE("TOP2", "bottom") });
    const r = await promote(client.token, b);
    expect(r.body).toMatchObject({ mode: "alone", goingWithout: [{ taskId: a }] });
    const id = r.body.promotionId as string;
    const alone = await untilRow(id, (p) => p.state === "building" && !!p.proposal_id);
    const w = await untilRow(id, (p) => p.mode === "closure");
    expect(w).toMatchObject({ reason_code: "needs_dependencies", reason: "Needs 'Header'; promoting them together.", rebuilds: 0 });
    expect(w.detail).toContain("alone build failed (textual_conflict)");
    expect(w.detail).toContain("public/page.html");
    expect(JSON.parse(w.landings_json)).toEqual([(await landing(a)).landing_id, (await landing(b)).landing_id]);
    expect(await claims(x, id)).toEqual([(await landing(a)).landing_id, (await landing(b)).landing_id].sort());
    expect((await landing(a)).state).toBe("promoting");
    // the alone attempt's proposal is closed; the widened build has a proposal of its own
    expect((await f.svc.ledger(f.o.orgId).getProposal(alone.proposal_id!))!.state).toBe("superseded");
    const cv = (await view(client.token, id)).body;
    expect(cv).toMatchObject({ mode: "closure", needs: [{ taskId: a, title: "Header" }], goingWithout: [], reason: "Needs 'Header'; promoting them together." });
    expect(JSON.stringify(cv)).not.toContain("page.html"); // no paths for clients
    expect((await untilState(id, ...DONE_STATES)).state).toBe("live");
    expect((await row(id)).proposal_id).not.toBe(alone.proposal_id);
    expect((await mainFiles())["public/page.html"]).toBe(PAGE("TOP2", "bottom"));
    expect(await events("promotion.widened", id)).toBe(1);
    expect((await landing(a)).state).toBe("promoted");
  });

  it("a required check that fails alone (and passes together) widens", async () => {
    const x = await aloneFixture();
    const { client, runner, promote, untilState, landTask, mainFiles, eventRows, row } = x;
    const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const b = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
    runner.opts.integrateFailureIf = (job) => (job.candidates.length === 1 ? { code: "check_failed", detail: "api-test failed", failChecks: ["api-test"] } : undefined);
    const r = await promote(client.token, b);
    expect(r.body.mode).toBe("alone");
    const id = r.body.promotionId as string;
    expect((await untilState(id, ...DONE_STATES)).state).toBe("live");
    const ev = await eventRows("promotion.widened", id);
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.detail_json!)).toMatchObject({ code: "needs_dependencies", needs: [a], failure: "check_failed" });
    expect(JSON.parse(ev[0]!.client_detail_json!)).toEqual({ promotionId: id, code: "needs_dependencies" });
    expect(JSON.parse((await row(id)).needs_json)).toMatchObject([{ taskId: a, title: "Header" }]);
    expect((await mainFiles())["public/page.html"]).toBe(PAGE("TOP", "BOTTOM"));
  });

  it("a widened promotion is gated again: a dependency on a developer path needs a developer's approval", async () => {
    const x = await aloneFixture();
    const { f, client, promote, approve, untilState, landTask, row } = x;
    const dev = await f.memberWithAccess("developer", "write");
    await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom"), "src/header.ts": "export const h = 1;\n" });
    const b = await landTask(client.token, "Footer2", { "public/page.html": PAGE("TOP2", "bottom") });
    const r = await promote(client.token, b);
    expect(r.body.mode).toBe("alone");
    const id = r.body.promotionId as string;
    const p = await untilState(id, ...DONE_STATES);
    expect(p).toMatchObject({ state: "pending_approval", mode: "closure", level: "developer", clearance_kind: null });
    expect((await approve(dev.token, id)).status).toBe(200);
    expect(await untilState(id, ...DONE_STATES)).toMatchObject({ state: "live", clearance_kind: "developer" });
    expect((await row(id)).needs_json).toContain("Header");
  });

  it("a widened alone build that fails again fails (widened at most once)", async () => {
    const x = await aloneFixture();
    const { client, runner, promote, untilState, landTask, events, landingState } = x;
    const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const b = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
    runner.opts.integrateFailureIf = () => ({ code: "check_failed", detail: "api-test failed", failChecks: ["api-test"] });
    const id = (await promote(client.token, b)).body.promotionId as string;
    expect(await untilState(id, ...DONE_STATES)).toMatchObject({ state: "failed", mode: "closure", reason_code: "check_failed", reason: "A required check failed when combined with production." });
    expect(await events("promotion.widened", id)).toBe(1);
    expect([await landingState(a), await landingState(b)]).toEqual(["landed", "landed"]);
  });

  it("without a required check covering the changed folder: today's closure, nothing going without", async () => {
    const { gatesAlone: _, ...plain } = API_TEST;
    for (const checks of [[], [{ ...API_TEST, required: false }], [plain], [{ ...API_TEST, gatesAlone: false }]]) {
      const x = await aloneFixture({ checks });
      const { client, promote, view, landTask, landing } = x;
      const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
      const b = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
      const r = await promote(client.token, b);
      expect(r.status).toBe(202);
      expect(r.body).toMatchObject({ mode: "closure", landings: [{ taskId: a }, { taskId: b }], goingWithout: [] });
      expect((await view(client.token, r.body.promotionId)).body).toMatchObject({ mode: "closure", goingWithout: [], needs: [] });
      expect((await landing(a)).state).toBe("promoting");
    }
  });

  it("a task with no earlier overlapping landing is a closure promotion even with checks (nothing to go without)", async () => {
    const { client, promote, landTask } = await aloneFixture();
    const t = await landTask(client.token, "Copy", { "public/page.html": PAGE("top", "BOTTOM") });
    expect((await promote(client.token, t)).body).toMatchObject({ mode: "closure", goingWithout: [] });
  });

  it("widening needs a landing another promotion holds → failed promotion_dependency_busy naming it", async () => {
    const x = await aloneFixture();
    const { f, runner, client, promote, row, view, landTask, landing, untilState } = x;
    const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const b = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
    runner.opts.hold = ["integrate"];
    const ida = (await promote(client.token, a)).body.promotionId as string;
    await untilState(ida, "building");
    // Header is held by its own promotion: Footer goes alone (its set does not include Header)
    const rb = await promote(client.token, b);
    expect(rb.body).toMatchObject({ mode: "alone", goingWithout: [{ taskId: a, text: "Going to production without 'Header' (being promoted separately)" }] });
    expect((await view(client.token, rb.body.promotionId)).body.goingWithout[0].text).toBe("Going to production without 'Header' (being promoted separately)");
    const idb = rb.body.promotionId as string;
    const pb = await untilState(idb, "building");
    const jobOf = () => runner.pending.findIndex((j) => j.job.kind === "integrate" && (j.job as { proposalId: string }).proposalId === pb.proposal_id);
    await f.until(async () => jobOf() >= 0, 20_000);
    // only Footer's alone build answers (with a failed check); Header's stays held
    const i = jobOf();
    const [job] = runner.pending.splice(i, 1);
    runner.opts.integrateFailureIf = () => ({ code: "check_failed", detail: "api-test failed", failChecks: ["api-test"] });
    await runner.run(job!);
    const failed = await untilState(idb, ...DONE_STATES);
    expect(failed).toMatchObject({ state: "failed", reason_code: "promotion_dependency_busy", reason: "Needs 'Header', which is being promoted now; promote again once it is live." });
    expect(failed.detail).toContain("alone build failed (check_failed)");
    expect(failed.detail).toContain(ida);
    expect((await view(client.token, idb)).body.reason).toBe("Needs 'Header', which is being promoted now; promote again once it is live.");
    // never promoted without it: Footer is back in staging, Header still with its own promotion
    expect((await landing(b)).state).toBe("landed");
    expect((await landing(a)).state).toBe("promoting");
    expect(await claims(x, idb)).toEqual([]);
    expect(await claims(x, ida)).toEqual([(await landing(a)).landing_id]);
    // Header's promotion goes on
    runner.opts.integrateFailureIf = undefined;
    runner.opts.hold = [];
    await runner.runPending();
    expect((await untilState(ida, ...DONE_STATES)).state).toBe("live");
  });

  it("withdraw works in both modes: alone (building) and widened (every claimed landing back to landed)", async () => {
    const x = await aloneFixture();
    const { f, runner, client, promote, untilRow, untilState, landTask, landing, row } = x;
    const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const b = await landTask(client.token, "Footer2", { "public/page.html": PAGE("TOP2", "bottom") });
    const withdraw = (id: string) => f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/withdraw`, { token: client.token, body: {} });
    // alone, while building
    runner.opts.hold = ["integrate"];
    const id1 = (await promote(client.token, b)).body.promotionId as string;
    await untilState(id1, "building");
    expect((await withdraw(id1)).status).toBe(200);
    expect([(await landing(a)).state, (await landing(b)).state]).toEqual(["landed", "landed"]);
    runner.opts.hold = [];
    await runner.runPending();
    await f.h.drainSteps();
    expect((await row(id1)).state).toBe("withdrawn");
    // widened (the alone build conflicts), then withdrawn: Header goes back too
    const id2 = (await promote(client.token, b)).body.promotionId as string;
    await untilRow(id2, (p) => p.mode === "closure");
    expect((await landing(a)).state).toBe("promoting");
    expect((await withdraw(id2)).status).toBe(200);
    expect([(await landing(a)).state, (await landing(b)).state]).toEqual(["landed", "landed"]);
    expect(await claims(x, id2)).toEqual([]);
    await f.h.drainSteps();
    expect((await row(id2)).state).toBe("withdrawn");
  });

  it("travel-with: a developer links Footer to an unrelated earlier landing; it is promoted with it in both modes; clients cannot link; later or departed links are refused", async () => {
    const x = await aloneFixture();
    const { f, client, promote, untilState, landTask, landing, mainFiles } = x;
    const dev = await f.memberWithAccess("developer", "write");
    const h = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const o = await landTask(client.token, "Other", { "public/other.html": "other\n" });
    const ft = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
    const [lh, lo, lf] = [(await landing(h)).landing_id, (await landing(o)).landing_id, (await landing(ft)).landing_id];
    expect((await travelWith(x, client.token, lf, lo)).status).toBe(403);
    const ok = await travelWith(x, dev.token, lf, lo);
    expect([ok.status, ok.body]).toEqual([201, { landingId: lf, withLandingId: lo }]);
    expect((await travelWith(x, dev.token, lf, lo)).status).toBe(201); // idempotent
    // only an earlier landing
    const later = await travelWith(x, dev.token, lo, lf);
    expect([later.status, later.body.error.code]).toEqual([409, "travel_with_not_earlier"]);
    expect((await travelWith(x, dev.token, lf, "lnd-nope")).status).toBe(404);
    // developers see the links in the staging view; clients do not
    const sv = (await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging`, { token: dev.token })).body;
    expect(sv.landings.find((l: { landingId: string }) => l.landingId === lf).travelsWith).toEqual([lo]);
    const cv = (await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging`, { token: client.token })).body;
    expect(cv.landings.find((l: { landingId: string }) => l.landingId === lf).travelsWith).toBeUndefined();
    // alone mode: the alone set includes the link; Header (overlapping, not linked) stays behind
    const r = await promote(client.token, ft);
    expect(r.body).toMatchObject({ mode: "alone", landings: [{ landingId: lo }, { landingId: lf }], goingWithout: [{ landingId: lh, title: "Header" }] });
    expect((await untilState(r.body.promotionId, ...DONE_STATES)).state).toBe("live");
    expect(await mainFiles()).toMatchObject({ "public/other.html": "other\n", "public/page.html": PAGE("top", "BOTTOM") });

    // closure mode (no overlap to go without): the link still joins; a link to a landing that left staging refuses
    const xt = await landTask(client.token, "X", { "public/x.html": "x\n" });
    const yt = await landTask(client.token, "Y", { "public/y.html": "y\n" });
    const [lx, ly] = [(await landing(xt)).landing_id, (await landing(yt)).landing_id];
    expect((await travelWith(x, dev.token, ly, lx)).status).toBe(201);
    const rb = await f.h.api("POST", `/api/tasks/${xt}/rollback`, { token: client.token, body: {} });
    expect(rb.status, JSON.stringify(rb.body)).toBe(202);
    await f.until(async () => (await landing(xt)).state === "rolled_back", 20_000);
    await f.untilLanded(yt);
    const refused = await promote(client.token, yt);
    expect([refused.status, refused.body.error.code, refused.body.error.details]).toEqual([409, "travel_with_left_staging", { landingId: ly, withLandingId: lx }]);
    expect((await unlink(x, dev.token, ly, lx)).status).toBe(204);
    const again = await promote(client.token, yt);
    expect([again.status, again.body.mode, again.body.landings]).toEqual([202, "closure", [{ landingId: ly, taskId: yt }]]);
  });

  it("travel-with in closure mode: the linked landing joins the set without sharing a path", async () => {
    const x = await aloneFixture({ checks: [] });
    const { f, client, promote, landTask, landing } = x;
    const dev = await f.memberWithAccess("developer", "write");
    const o = await landTask(client.token, "Other", { "public/other.html": "other\n" });
    const t = await landTask(client.token, "Footer", { "public/page.html": PAGE("top", "BOTTOM") });
    expect((await travelWith(x, dev.token, (await landing(t)).landing_id, (await landing(o)).landing_id)).status).toBe(201);
    const r = await promote(client.token, t);
    expect(r.body).toMatchObject({ mode: "closure", landings: [{ taskId: o }, { taskId: t }], goingWithout: [] });
  });

  it("the owner turns off the covering check after the request: the next build widens before anything is accepted", async () => {
    const x = await aloneFixture();
    const { f, runner, client, promote, untilState, landTask, mainFiles, eventRows, row } = x;
    const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const b = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
    runner.opts.hold = ["integrate"];
    const r = await promote(client.token, b);
    expect(r.body.mode).toBe("alone");
    const id = r.body.promotionId as string;
    await untilState(id, "building");
    const policy = JSON.parse((await f.project()).policy_json);
    const put = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { ...policy, checks: [{ ...API_TEST, gatesAlone: false }] } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    runner.opts.hold = [];
    await runner.runPending();
    const p = await untilState(id, ...DONE_STATES);
    expect(p).toMatchObject({ state: "live", mode: "closure" });
    expect(JSON.parse(p.needs_json)).toMatchObject([{ taskId: a, title: "Header" }]);
    const ev = await eventRows("promotion.widened", id);
    expect(ev.map((e) => JSON.parse(e.detail_json!).failure)).toEqual(["policy_changed"]);
    expect((await row(id)).detail ?? "").not.toContain("alone build failed");
    expect((await mainFiles())["public/page.html"]).toBe(PAGE("TOP", "BOTTOM"));
    // no accepted version ever had Footer without Header
    expect(await x.events("promotion.accepted", id)).toBe(1);
  });

  it("a developer links a task while its promotion lacks the linked task: the promotion is superseded (before accepting); once accepting, the link is refused", async () => {
    const x = await aloneFixture();
    const { f, runner, client, promote, view, untilState, untilHeld, landTask, landing, row } = x;
    const dev = await f.memberWithAccess("developer", "write");
    await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const o = await landTask(client.token, "Other", { "public/other.html": "other\n" });
    const ft = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
    const [lo, lf] = [(await landing(o)).landing_id, (await landing(ft)).landing_id];
    runner.opts.hold = ["integrate"];
    const id1 = (await promote(client.token, ft)).body.promotionId as string;
    await untilState(id1, "building");
    expect((await travelWith(x, dev.token, lf, lo)).status).toBe(201);
    expect(await row(id1)).toMatchObject({ state: "superseded", reason_code: "travel_with_added", reason: "A developer linked this task to 'Other'; promote again." });
    expect((await view(client.token, id1)).body.reason).toBe("A developer linked this task to 'Other'; promote again.");
    expect((await landing(ft)).state).toBe("landed");
    runner.opts.hold = [];
    await runner.runPending();
    // promoted again: with the link
    const r2 = await promote(client.token, ft);
    expect(r2.body.landings).toEqual([{ landingId: lo, taskId: o }, { landingId: lf, taskId: ft }]);
    const id2 = r2.body.promotionId as string;
    await untilHeld(id2, (p) => p.state === "cleared");
    // a promotion that took production (accepting) refuses a new link it lacks
    await f.svc.db.prepare("UPDATE promotions SET state = 'accepting', claimed_at = ? WHERE promotion_id = ?").bind(new Date().toISOString(), id2).run();
    const lh = (await landing((await f.svc.db.prepare("SELECT task_id FROM tasks WHERE title = 'Header' AND org_id = ?").bind(f.o.orgId).first<{ task_id: string }>())!.task_id)).landing_id;
    const refused = await travelWith(x, dev.token, lf, lh);
    expect([refused.status, refused.body.error.code, refused.body.error.details?.promotionId]).toEqual([409, "travel_with_in_flight", id2]);
    expect(await f.svc.db.prepare("SELECT 1 FROM staging_landing_links WHERE landing_id = ? AND with_landing_id = ?").bind(lf, lh).first()).toBeNull();
    expect((await row(id2)).state).toBe("accepting");
  });

  it("in alone mode, a departed link of a landing it goes without does not refuse the request (the closure's links are checked when it widens)", async () => {
    const x = await aloneFixture();
    const { f, client, promote, landTask, landing } = x;
    const dev = await f.memberWithAccess("developer", "write");
    const o = await landTask(client.token, "Other", { "public/other.html": "other\n" });
    const h = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const ft = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
    const [lo, lh] = [(await landing(o)).landing_id, (await landing(h)).landing_id];
    expect((await travelWith(x, dev.token, lh, lo)).status).toBe(201);
    expect((await f.h.api("POST", `/api/tasks/${o}/rollback`, { token: client.token, body: {} })).status).toBe(202);
    await f.until(async () => (await landing(o)).state === "rolled_back", 20_000);
    await f.untilLanded(ft);
    // Header itself is refused; Footer goes alone without Header
    expect((await promote(client.token, h)).body.error.code).toBe("travel_with_left_staging");
    const r = await promote(client.token, ft);
    expect([r.status, r.body.mode, r.body.goingWithout.map((g: { landingId: string }) => g.landingId)]).toEqual([202, "alone", [lh]]);
  });

  it("at most 20 travel-with links per landing", async () => {
    const x = await aloneFixture();
    const { f, client, landTask, landing } = x;
    const dev = await f.memberWithAccess("developer", "write");
    const o = await landTask(client.token, "Other", { "public/other.html": "other\n" });
    const t = await landTask(client.token, "Footer", { "public/page.html": PAGE("top", "BOTTOM") });
    const [lo, lt] = [(await landing(o)).landing_id, (await landing(t)).landing_id];
    for (let i = 0; i < 20; i++) {
      await f.svc.db.prepare("INSERT INTO staging_landing_links (landing_id, with_landing_id, org_id, project_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(lt, `lnd-x${i}`, f.o.orgId, f.pid, dev.userId, new Date().toISOString()).run();
    }
    const r = await travelWith(x, dev.token, lt, lo);
    expect([r.status, r.body.error?.code]).toEqual([409, "travel_with_limit"]);
    await f.svc.db.prepare("DELETE FROM staging_landing_links WHERE landing_id = ? AND with_landing_id = 'lnd-x0'").bind(lt).run();
    expect((await travelWith(x, dev.token, lt, lo)).status).toBe(201);
    expect((await travelWith(x, dev.token, lt, lo)).status).toBe(201); // an existing link at the limit is still fine
  });

  it("a link written after the request read its sets is enforced before the build and before taking production", async () => {
    const x = await aloneFixture({ checks: [] });
    const { f, client, promote, untilHeld, resume, landTask, landing, untilState, acceptedVersionsOf } = x;
    const dev = await f.memberWithAccess("developer", "write");
    const o = await landTask(client.token, "Other", { "public/other.html": "other\n" });
    const t = await landTask(client.token, "Footer", { "public/page.html": PAGE("top", "BOTTOM") });
    const [lo, lt] = [(await landing(o)).landing_id, (await landing(t)).landing_id];
    const link = (withId: string) => f.svc.db.prepare("INSERT INTO staging_landing_links (landing_id, with_landing_id, org_id, project_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(lt, withId, f.o.orgId, f.pid, dev.userId, new Date().toISOString()).run();
    const unlinkAll = () => f.svc.db.prepare("DELETE FROM staging_landing_links WHERE landing_id = ?").bind(lt).run();
    // (a) the row exists, its build has not run: the link is written behind the request's back
    const id1 = (await promote(client.token, t)).body.promotionId as string;
    await link(lo);
    expect(await untilState(id1, ...DONE_STATES)).toMatchObject({ state: "superseded", reason_code: "travel_with_added", reason: "A developer linked this task to 'Other'; promote again." });
    expect((await landing(t)).state).toBe("landed");
    // (b) cleared and waiting to take production: the link arrives (a lost supersede); nothing is accepted
    await unlinkAll();
    const id2 = (await promote(client.token, t)).body.promotionId as string;
    const p2 = await untilHeld(id2, (p) => p.state === "cleared");
    await link(lo);
    await resume(id2);
    expect(await untilState(id2, ...DONE_STATES)).toMatchObject({ state: "superseded", reason_code: "travel_with_added" });
    expect(await acceptedVersionsOf(p2.proposal_id!)).toEqual([]);
    // (c) a link to a landing that left staging fails it
    await unlinkAll();
    const id3 = (await promote(client.token, t)).body.promotionId as string;
    await link("lnd-gone");
    expect(await untilState(id3, ...DONE_STATES)).toMatchObject({ state: "failed", reason_code: "travel_with_left_staging", reason: "A task this one must travel with left staging. A developer needs to remove the link first." });
    // promoting again (the link removed) goes through
    await unlinkAll();
    const id4 = (await promote(client.token, t)).body.promotionId as string;
    expect((await untilState(id4, ...DONE_STATES)).state).toBe("live");
  });
});
