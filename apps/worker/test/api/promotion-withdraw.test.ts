/**
 * Staging phase 2b, Task 5 (B5): a promotion is withdrawn by its requester, an owner or a developer
 * at any point before it is accepted. Its landings go back to `landed`, its claims are released, its
 * proposal is closed and its clearance is void; nothing reaches `main`. From `accepting` on, a
 * withdraw is refused (`409 promotion_accepted`): it never races the accept.
 */
import { describe, expect, it } from "vitest";
import { withdrawPromotion } from "../../src/services/promotions.js";
import { DONE_STATES, releaseFixture } from "../promotion-helpers.js";

type Fixture = Awaited<ReturnType<typeof releaseFixture>>;

const withdraw = (x: Fixture, token: string, id: string) => x.f.h.api("POST", `/api/orgs/${x.f.o.orgId}/promotions/${id}/withdraw`, { token, body: {} });

/** a self-cleared promotion of a new file held in `cleared` (its accept would come next) */
async function heldCleared(x: Fixture, file = "public/a.html") {
  const t = await x.landTask(x.client.token, "Copy", { [file]: "a\n" });
  const id = (await x.promote(x.client.token, t)).body.promotionId as string;
  const p = await x.untilHeld(id, (r) => r.state === "cleared");
  return { t, id, p };
}

describe("withdraw", { timeout: 120_000 }, () => {
  it("the requesting client withdraws while it waits for a developer: landings back in staging, clearance void, proposal superseded, client reads 'Withdrawn'", async () => {
    const x = await releaseFixture();
    const { f, client, promote, view, untilState, landTask, row, events, eventRows } = x;
    const t = await landTask(client.token, "API", { "src/a.ts": "a\n" });
    const id = (await promote(client.token, t)).body.promotionId as string;
    const p = await untilState(id, "pending_approval");
    const r = await withdraw(x, client.token, id);
    expect([r.status, r.body.state, r.body.reason, r.body.reasonCode]).toEqual([200, "withdrawn", "Withdrawn", "withdrawn"]);
    expect((await view(client.token, id)).body).toMatchObject({ state: "withdrawn", reason: "Withdrawn" });
    expect(await row(id)).toMatchObject({ state: "withdrawn", clearance_kind: null, clearance_key: null, cleared_by: null, cleared_at: null, detail: null });
    expect((await f.svc.db.prepare("SELECT state FROM staging_landings WHERE task_id = ?").bind(t).first<{ state: string }>())!.state).toBe("landed");
    expect((await f.svc.ledger(f.o.orgId).getProposal(p.proposal_id!))!.state).toBe("superseded");
    expect(await f.svc.db.prepare("SELECT 1 FROM promotion_landings WHERE promotion_id = ? AND active = 1").bind(id).first()).toBeNull();
    expect(await events("promotion.withdrawn", id)).toBe(1);
    expect(JSON.parse((await eventRows("promotion.withdrawn", id))[0]!.actor_json)).toMatchObject({ id: client.userId });
    // a second withdraw: already ended
    const again = await withdraw(x, client.token, id);
    expect([again.status, again.body.error.code]).toEqual([409, "promotion_not_in_flight"]);
    // the task can be promoted again
    expect((await promote(client.token, t)).status).toBe(202);
  });

  it("withdraw while building: the late integrate receipt is ignored", async () => {
    const x = await releaseFixture();
    const { f, runner, client, promote, untilState, landTask, row, landingState, acceptedVersionsOf } = x;
    const before = await f.headSha();
    const t = await landTask(client.token, "Copy", { "public/a.html": "a\n" });
    runner.opts.hold = ["integrate"];
    const id = (await promote(client.token, t)).body.promotionId as string;
    const building = await untilState(id, "building");
    expect((await withdraw(x, f.o.token, id)).status).toBe(200);
    runner.opts.hold = [];
    await runner.runPending();
    await f.h.drainSteps();
    expect((await row(id)).state).toBe("withdrawn");
    expect(await landingState(t)).toBe("landed");
    expect(await acceptedVersionsOf(building.proposal_id!)).toHaveLength(0);
    expect(await f.headSha()).toBe(before);
  });

  it("a cleared promotion can be withdrawn; once accepting it cannot (409 promotion_accepted)", async () => {
    const x = await releaseFixture();
    const { f, runner, client, promote, untilState, untilHeld, resume, landTask, row, landingState, mainFiles } = x;
    const { t, id } = await heldCleared(x);
    expect((await withdraw(x, client.token, id)).status).toBe(200);
    // its chain goes on (a step was in flight): nothing is accepted
    await resume(id);
    await f.h.drainSteps();
    expect((await row(id)).state).toBe("withdrawn");
    expect(await landingState(t)).toBe("landed");
    expect((await mainFiles())["public/a.html"]).toBeUndefined();

    // a second promotion driven to releasing
    const t2 = await landTask(client.token, "More", { "public/b.html": "b\n" });
    runner.opts.hold = ["release-deploy"];
    const id2 = (await promote(client.token, t2)).body.promotionId as string;
    await untilHeld(id2, (r) => r.state === "releasing");
    const r = await withdraw(x, client.token, id2);
    expect([r.status, r.body.error.code]).toEqual([409, "promotion_accepted"]);
    runner.opts.hold = [];
    await runner.runPending();
    await resume(id2);
    expect((await untilState(id2, ...DONE_STATES)).state).toBe("live");
    const late = await withdraw(x, f.o.token, id2);
    expect([late.status, late.body.error.code]).toEqual([409, "promotion_accepted"]);
  });

  it("another client may not withdraw (403 not_promotion_requester); a developer may; an ended one → 409 promotion_not_in_flight", async () => {
    const x = await releaseFixture();
    const { f, client, promote, untilState, landTask, row } = x;
    const other = await f.clientWithAccess();
    const dev = await f.memberWithAccess("developer");
    const t = await landTask(client.token, "API", { "src/a.ts": "a\n" });
    const id = (await promote(client.token, t)).body.promotionId as string;
    await untilState(id, "pending_approval");
    const refused = await withdraw(x, other.token, id);
    expect([refused.status, refused.body.error.code]).toEqual([403, "not_promotion_requester"]);
    expect((await row(id)).state).toBe("pending_approval");
    const ok = await withdraw(x, dev.token, id);
    expect([ok.status, ok.body.state]).toEqual([200, "withdrawn"]);
    const ended = await withdraw(x, f.o.token, id);
    expect([ended.status, ended.body.error.code]).toEqual([409, "promotion_not_in_flight"]);
    // an unknown promotion
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/prm-none/withdraw`, { token: f.o.token, body: {} })).status).toBe(404);
  });
});

describe("withdraw vs accept", { timeout: 120_000 }, () => {
  it("the accept took production after the withdraw read the promotion: 409 promotion_accepted and nothing is changed", async () => {
    const x = await releaseFixture();
    const { f, runner, client, untilState, untilHeld, resume, row, landingState, events, mainFiles } = x;
    const { t, id, p: stale } = await heldCleared(x);
    runner.opts.hold = ["release-deploy"];
    await resume(id);
    await untilHeld(id, (r) => r.state === "releasing");
    // the withdraw read `cleared`; its compare-and-set excludes accepting and later
    await expect(withdrawPromotion(f.svc, stale, { userId: client.userId, role: "client" })).rejects.toMatchObject({ status: 409, code: "promotion_accepted" });
    const now = await row(id);
    expect(now).toMatchObject({ state: "releasing", reason_code: null });
    expect(now.clearance_kind).not.toBeNull();
    expect(await landingState(t)).toBe("promoted");
    expect((await f.svc.ledger(f.o.orgId).getProposal(now.proposal_id!))!.state).toBe("accepted");
    expect(await events("promotion.withdrawn", id)).toBe(0);
    runner.opts.hold = [];
    await runner.runPending();
    await resume(id);
    expect((await untilState(id, ...DONE_STATES)).state).toBe("live");
    expect((await mainFiles())["public/a.html"]).toBe("a\n");
  });

  it("withdraw and the cleared → accepting step at the same time: exactly one wins, and the loser changes nothing", async () => {
    // the withdraw starts at different points of the step's run (both outcomes occur)
    for (const delay of [0, 2, 10, 40]) {
      const x = await releaseFixture();
      const { f, runner, client, untilState, resume, landingState, events, mainFiles, acceptedVersionsOf } = x;
      const before = await f.headSha();
      const { t, id, p } = await heldCleared(x);
      runner.opts.hold = [];
      await resume(id);
      const [r] = await Promise.all([new Promise((ok) => setTimeout(ok, delay)).then(() => withdraw(x, client.token, id)), f.h.drainSteps()]);
      const final = await untilState(id, "withdrawn", ...DONE_STATES);
      if (r.status === 200) {
        expect(final.state).toBe("withdrawn");
        expect(await landingState(t)).toBe("landed");
        expect(await acceptedVersionsOf(p.proposal_id!)).toHaveLength(0);
        expect(await f.headSha()).toBe(before);
        expect(await events("promotion.accepted", id)).toBe(0);
        expect(await f.svc.db.prepare("SELECT 1 FROM promotions WHERE promotion_id = ? AND state IN ('accepting', 'releasing')").bind(id).first()).toBeNull();
      } else {
        expect([r.status, r.body.error.code]).toEqual([409, "promotion_accepted"]);
        expect(final.state).toBe("live");
        expect(await landingState(t)).toBe("promoted");
        expect(await events("promotion.withdrawn", id)).toBe(0);
        expect((await mainFiles())["public/a.html"]).toBe("a\n");
      }
      // the claims are released either way (by the withdraw or by the accept)
      expect(await f.svc.db.prepare("SELECT 1 FROM promotion_landings WHERE promotion_id = ? AND active = 1").bind(id).first()).toBeNull();
    }
  });
});
