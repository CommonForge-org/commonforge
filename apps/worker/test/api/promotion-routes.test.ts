/**
 * Staging phase 3, Task 4: the read routes the web needs. The promotion dry run (P3-7) computes the
 * set `POST` would promote without writing; the promotions list per project (P3-8) filters by state
 * and role; the developer promotion view carries each landing's request and parts, the
 * per-resource `main` head and result revision ids (readable through the file route) and the
 * checks; the project view's mounts say whether the caller may start a task on them
 * (`canStartTask`, createTask's own rule).
 */
import { describe, expect, it } from "vitest";
import { latestIntegration } from "../../src/services/proposals.js";
import { FakeRunner } from "../fakes/runner.js";
import { member, ownerWithOrg } from "../helpers.js";
import { DONE_STATES, promotionHelpers, releaseFixture, RELEASE_STAGING } from "../promotion-helpers.js";
import { STAGING_FILES, stagingFixture, type StagingFixture } from "../staging-helpers.js";

const PAGE = (l1: string, l3: string) => `${l1}\nmiddle\n${l3}\n`;
const ALONE_CHECK = { checkId: "api-test", mountName: "api", command: "pnpm test", timeoutSeconds: 60, required: true, gatesAlone: true };

/** Rows a promotion request writes (and the step queue): the dry run must leave all of them as they are. */
async function writeCounts(f: StagingFixture) {
  const n = async (sql: string) => (await f.svc.db.prepare(sql).bind(f.o.orgId).first<{ n: number }>())!.n;
  return {
    promotions: await n("SELECT COUNT(*) AS n FROM promotions WHERE org_id = ?"),
    claims: await n("SELECT COUNT(*) AS n FROM promotion_landings WHERE org_id = ?"),
    events: await n("SELECT COUNT(*) AS n FROM events WHERE org_id = ?"),
    landings: (await f.svc.db.prepare("SELECT landing_id, state, updated_at FROM staging_landings WHERE org_id = ? ORDER BY landing_id").bind(f.o.orgId).all()).results,
    steps: f.h.steps.length,
  };
}

/** The release fixture with `public/page.html` on main and the given policy checks. */
async function pageFixture(checks: unknown[] = []) {
  const f = await stagingFixture({ files: { ...STAGING_FILES, "public/page.html": PAGE("top", "bottom") }, staging: RELEASE_STAGING });
  if (checks.length) {
    const policy = JSON.parse((await f.project()).policy_json);
    const put = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { ...policy, checks } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
  }
  const runner = new FakeRunner(f.h);
  const client = await f.clientWithAccess();
  return { f, runner, client, ...promotionHelpers(f) };
}

const dryRun = (f: StagingFixture, token: string, taskId: string) => f.h.api("GET", `/api/tasks/${taskId}/promote`, { token });
const list = (f: StagingFixture, token: string, query = "", orgId = f.o.orgId) => f.h.api("GET", `/api/orgs/${orgId}/projects/${f.pid}/promotions${query}`, { token });

describe("promotion dry run (P3-7)", { timeout: 180_000 }, () => {
  it("closure: the same landings and mode the following POST returns, and nothing written", async () => {
    const { f, client, promote, landTask, landing } = await pageFixture();
    const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const b = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
    await f.h.drainSteps();
    const before = await writeCounts(f);
    const d = await dryRun(f, client.token, b);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toEqual({
      landings: [
        { landingId: (await landing(a)).landing_id, taskId: a, title: "Header" },
        { landingId: (await landing(b)).landing_id, taskId: b, title: "Footer" },
      ],
      mode: "closure",
      goingWithout: [],
    });
    expect(await writeCounts(f)).toEqual(before);
    const r = await promote(client.token, b);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.mode).toBe(d.body.mode);
    expect(r.body.landings).toEqual(d.body.landings.map((l: { landingId: string; taskId: string }) => ({ landingId: l.landingId, taskId: l.taskId })));
    expect(r.body.goingWithout).toEqual(d.body.goingWithout);
    // while it is promoting, the dry run refuses like POST (and nudges nothing)
    const steps = f.h.steps.length;
    const busy = await dryRun(f, client.token, b);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("promotion_in_progress");
    expect(f.h.steps.length).toBe(steps);
  });

  it("alone: names what it goes without, exactly as the POST does", async () => {
    const { f, client, promote, landTask, landing } = await pageFixture([ALONE_CHECK]);
    const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const b = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
    await f.h.drainSteps();
    const before = await writeCounts(f);
    const d = await dryRun(f, client.token, b);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const la = (await landing(a)).landing_id;
    expect(d.body).toEqual({
      landings: [{ landingId: (await landing(b)).landing_id, taskId: b, title: "Footer" }],
      mode: "alone",
      goingWithout: [{ landingId: la, taskId: a, title: "Header", text: "Going to production without 'Header' (still in staging)" }],
    });
    expect(await writeCounts(f)).toEqual(before);
    const r = await promote(client.token, b);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect({ mode: r.body.mode, goingWithout: r.body.goingWithout, landings: r.body.landings }).toEqual({ mode: d.body.mode, goingWithout: d.body.goingWithout, landings: [{ landingId: d.body.landings[0].landingId, taskId: b }] });
  });

  it("authorization as POST: another client and a viewer get 404; a developer may", async () => {
    const { f, client, landTask } = await pageFixture();
    const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const other = await f.clientWithAccess();
    const viewer = await f.memberWithAccess("viewer");
    const dev = await f.memberWithAccess("developer", "write");
    expect((await dryRun(f, other.token, a)).status).toBe(404);
    expect((await dryRun(f, viewer.token, a)).status).toBe(404);
    const d = await dryRun(f, dev.token, a);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.landings.map((l: { taskId: string }) => l.taskId)).toEqual([a]);
  });
});

describe("promotions list (P3-8)", { timeout: 180_000 }, () => {
  it("newest first, filtered by state; clients see only their own in the client shape; viewers 403; other orgs 404; unknown states 400", async () => {
    const { f, client, promote, untilState, landTask } = await releaseFixture();
    const other = await f.clientWithAccess();
    const dev = await f.memberWithAccess("developer", "write");
    const viewer = await f.memberWithAccess("viewer");
    // the client's copy change clears itself; the other client's source change waits for a developer
    const mine = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hello</h1>\n" });
    const theirs = await landTask(other.token, "Source", { "src/x.ts": "export const x = 1;\n" });
    const p1 = (await promote(client.token, mine)).body.promotionId as string;
    await untilState(p1, ...DONE_STATES);
    const p2 = (await promote(other.token, theirs)).body.promotionId as string;
    expect((await untilState(p2, ...DONE_STATES)).state).toBe("pending_approval");

    const all = await list(f, dev.token);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.promotions.map((p: { promotionId: string }) => p.promotionId)).toEqual([p2, p1]);
    expect(all.body.promotions[0]).toMatchObject({ state: "pending_approval", requestedBy: other.userId, gate: expect.any(Object) });
    const pending = await list(f, dev.token, "?state=pending_approval,cleared");
    expect(pending.body.promotions.map((p: { promotionId: string }) => p.promotionId)).toEqual([p2]);
    const owner = await list(f, f.o.token, "?state=live");
    expect(owner.body.promotions.map((p: { promotionId: string }) => p.promotionId)).toEqual([p1]);

    const own = await list(f, client.token);
    expect(own.status).toBe(200);
    expect(own.body.promotions.map((p: { promotionId: string }) => p.promotionId)).toEqual([p1]);
    for (const k of ["gate", "resources", "checks", "proposalId", "detail", "requestedBy"]) expect(own.body.promotions[0][k], k).toBeUndefined();
    expect(own.body.promotions[0].landings[0].request).toBeUndefined();
    expect((await list(f, other.token, "?state=pending_approval")).body.promotions.map((p: { promotionId: string }) => p.promotionId)).toEqual([p2]);
    expect((await list(f, client.token, "?state=pending_approval")).body.promotions).toEqual([]);

    expect((await list(f, viewer.token)).status).toBe(403);
    const stranger = await ownerWithOrg(f.h, "Elsewhere");
    expect((await list(f, stranger.token)).status).toBe(404);
    const bad = await list(f, dev.token, "?state=pending_approval,nope");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_request");
    // a developer without access to the project
    const outsider = await member(f.h, f.o, "developer");
    expect((await list(f, outsider.token)).status).toBe(404);
  });
});

describe("developer promotion view", { timeout: 180_000 }, () => {
  it("each landing's request and parts, the head/result revisions of the receipt (readable through the file route), the checks; clients get none of it", async () => {
    const { f, client, promote, view, untilState, landTask } = await releaseFixture();
    const dev = await f.memberWithAccess("developer", "write");
    const taskId = await landTask(client.token, "Phone numbers", { "src/phone.ts": "export const phone = '555';\n" });
    await f.svc.db.prepare("UPDATE tasks SET request = ? WHERE task_id = ?").bind("Store a phone number for every contact.", taskId).run();
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    const p = await untilState(id, ...DONE_STATES);
    expect(p.state).toBe("pending_approval");
    const integ = (await latestIntegration(f.svc, f.o.orgId, p.proposal_id!))!;

    const dv = await view(dev.token, id);
    expect(dv.status, JSON.stringify(dv.body)).toBe(200);
    expect(dv.body.landings).toEqual([{ landingId: p.target_landing_id, taskId, title: "Phone numbers", state: "promoting", request: "Store a phone number for every contact.", parts: [{ part: 1, taskId, title: "Phone numbers" }] }]);
    expect(dv.body.resources).toEqual(integ.receipt.results.map((r) => ({ resourceId: r.resourceId, mountName: "api", head: r.expectedHead, result: r.revisionId })));
    expect(dv.body.resources).toHaveLength(1);
    expect(dv.body.resources[0].head).toMatch(/^art:/);
    expect(dv.body.resources[0].result).toMatch(/^art:/);
    expect(dv.body.checks).toEqual({ checks: integ.receipt.evidence.checks, contractChecks: integ.receipt.evidence.contractChecks, mergeOutcome: integ.receipt.evidence.mergeOutcome });

    // the review screen reads both sides through the file route at those revisions
    const file = (rev: string, path: string) => f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/file?mount=api&path=${encodeURIComponent(path)}&revision=${encodeURIComponent(rev)}`, { token: dev.token });
    const after = await file(dv.body.resources[0].result, "src/phone.ts");
    expect(after.status).toBe(200);
    expect(after.body).toBe("export const phone = '555';\n");
    expect((await file(dv.body.resources[0].head, "src/phone.ts")).status).toBe(404);
    expect((await file(dv.body.resources[0].head, "src/index.ts")).status).toBe(200);

    const cv = await view(client.token, id);
    expect(cv.status).toBe(200);
    for (const k of ["resources", "checks", "gate"]) expect(cv.body[k], k).toBeUndefined();
    expect(cv.body.landings).toEqual([{ landingId: p.target_landing_id, taskId, title: "Phone numbers", state: "promoting" }]);
    expect(JSON.stringify(cv.body)).not.toContain("Store a phone number");
  });

  it("before a receipt exists: resources [] and checks null", async () => {
    const { f, client, promote, view, untilRow, hold, landTask } = await releaseFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    hold(id);
    await untilRow(id, (r) => r.state === "requested");
    hold(id);
    const dv = await view(f.o.token, id);
    expect(dv.status, JSON.stringify(dv.body)).toBe(200);
    expect(dv.body).toMatchObject({ resources: [], checks: null });
  });
});

describe("canStartTask on the project view's mounts", { timeout: 120_000 }, () => {
  const mountsOf = async (f: StagingFixture, token: string) => (await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}`, { token })).body.mounts as Array<{ mountName: string; canWrite: boolean; canStartTask: boolean }>;
  const create = (f: StagingFixture, token: string) => f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token, body: { title: "New", request: "", writeMounts: ["api"] } });

  it("a client in a staging project: true for a git folder opened for writing (createTask accepts), false once it is read-only (createTask refuses)", async () => {
    const f = await stagingFixture();
    const client = await f.clientWithAccess();
    const viewer = await f.memberWithAccess("viewer");
    const m = await mountsOf(f, client.token);
    expect(m).toEqual([expect.objectContaining({ mountName: "api", canWrite: false, canStartTask: true })]);
    expect((await create(f, client.token)).status).toBe(201);
    expect((await mountsOf(f, f.o.token))[0]!.canStartTask).toBe(true);
    expect((await mountsOf(f, viewer.token))[0]!.canStartTask).toBe(false);
    await f.svc.db.prepare("UPDATE mounts SET operations_json = ? WHERE org_id = ? AND project_id = ?").bind(JSON.stringify(["read"]), f.o.orgId, f.pid).run();
    expect((await mountsOf(f, client.token))[0]!.canStartTask).toBe(false);
    const refused = await create(f, client.token);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("mount_read_only");
    expect((await mountsOf(f, f.o.token))[0]!.canStartTask).toBe(false);
    expect((await create(f, f.o.token)).body.error.code).toBe("mount_read_only");
  });

  it("a client in a project without staging: false, and createTask refuses", async () => {
    const f = await stagingFixture({ staging: false });
    const client = await f.clientWithAccess();
    expect((await mountsOf(f, client.token))[0]!.canStartTask).toBe(false);
    expect((await create(f, client.token)).status).toBe(403);
    expect((await mountsOf(f, f.o.token))[0]!.canStartTask).toBe(true);
  });
});

/** Count the D1 statements the Worker under test prepares (and batches) while `fn` runs. */
async function countingD1<T>(f: StagingFixture, fn: () => Promise<T>): Promise<{ value: T; statements: number }> {
  const db = f.h.env().DB;
  let statements = 0;
  (f.h.envOverrides as Record<string, unknown>).DB = new Proxy(db, {
    get(t, k) {
      if (k === "prepare")
        return (sql: string) => {
          statements++;
          return db.prepare(sql);
        };
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  try {
    return { value: await fn(), statements };
  } finally {
    delete (f.h.envOverrides as Record<string, unknown>).DB;
  }
}

describe("Task 4 review", { timeout: 180_000 }, () => {
  it("the list reads 60 promotions with a bounded number of D1 statements, without resources/checks (only GET /promotions/:id has them)", async () => {
    const { f, client, promote, untilState, view, landTask } = await releaseFixture();
    const dev = await f.memberWithAccess("developer", "write");
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hello</h1>\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    await untilState(id, ...DONE_STATES);
    // 59 more ended promotions of the same landing (copies of the row, older)
    const row = (await f.svc.db.prepare("SELECT * FROM promotions WHERE promotion_id = ?").bind(id).first<Record<string, unknown>>())!;
    const cols = Object.keys(row);
    for (let i = 0; i < 59; i++) {
      const copy = { ...row, promotion_id: `prm-copy-${String(i).padStart(3, "0")}`, state: "failed", created_at: new Date(Date.parse(row.created_at as string) - (i + 1) * 1000).toISOString() };
      await f.svc.db.prepare(`INSERT INTO promotions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => (copy as Record<string, unknown>)[c] ?? null)).run();
    }
    for (const who of [dev, f.o, client]) {
      const { value: r, statements } = await countingD1(f, () => list(f, who.token));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.promotions).toHaveLength(60);
      expect(r.body.promotions[0].promotionId).toBe(id);
      for (const p of r.body.promotions) {
        expect(p.resources).toBeUndefined();
        expect(p.checks).toBeUndefined();
      }
      // auth plus a few batched reads, independent of the number of promotions
      expect(statements, `statements for ${who === dev ? "developer" : who === client ? "client" : "owner"}`).toBeLessThanOrEqual(15);
    }
    const devList = (await list(f, dev.token)).body.promotions;
    expect(devList[1]).toMatchObject({ promotionId: "prm-copy-000", state: "failed", gate: expect.anything(), requestedBy: client.userId });
    expect(devList[1].landings[0]).toMatchObject({ taskId, title: "Copy", parts: [{ part: 1, taskId, title: "Copy" }] });
    const single = await view(dev.token, id);
    expect(single.body.resources).toEqual(expect.any(Array));
    expect(single.body).toHaveProperty("checks");
  });

  it("a developer lacking read on a resource the promotion changes gets the client view (list and GET alike)", async () => {
    const { f, client, promote, view, untilState, landTask } = await releaseFixture();
    const dev = await f.memberWithAccess("developer", "write");
    const other = await f.memberWithAccess("developer", "write");
    const taskId = await landTask(client.token, "Phone numbers", { "src/phone.ts": "export const phone = '555';\n" });
    await f.svc.db.prepare("UPDATE tasks SET request = ? WHERE task_id = ?").bind("Store a phone number for every contact.", taskId).run();
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    expect((await untilState(id, ...DONE_STATES)).state).toBe("pending_approval");
    const del = await f.svc.db.prepare("DELETE FROM grants WHERE org_id = ? AND user_id = ? AND scope_kind = 'resource' AND scope_id = ?").bind(f.o.orgId, dev.userId, f.api.resourceId).run();
    expect(del.meta.changes).toBe(1);
    const single = await view(dev.token, id);
    expect(single.status).toBe(200);
    const listed = (await list(f, dev.token)).body.promotions;
    expect(listed).toHaveLength(1);
    for (const v of [single.body, listed[0]]) {
      for (const k of ["gate", "resources", "checks", "proposalId", "detail", "requestedBy", "clearance"]) expect(v[k], k).toBeUndefined();
      expect(v.landings).toEqual([{ landingId: expect.any(String), taskId, title: "Phone numbers", state: "promoting" }]);
      expect(v.reason).toBeNull();
      expect(v.reasonCode).toBeNull();
      expect(JSON.stringify(v)).not.toContain("Store a phone number");
    }
    expect(single.body).toEqual(listed[0]);
    // a developer who reads every resource still gets the developer view
    const full = await view(other.token, id);
    expect(full.body).toMatchObject({ gate: expect.anything(), requestedBy: client.userId, reasonCode: expect.any(String) });
    expect(full.body.landings[0].request).toBe("Store a phone number for every contact.");
  });

  it("approve and send-back need read on every resource the promotion changes (403 promotion_not_visible); a full-access developer and the owner still act", async () => {
    const { f, client, promote, view, approve, untilState, landTask, row } = await releaseFixture();
    const dev = await f.memberWithAccess("developer", "write");
    const other = await f.memberWithAccess("developer", "write");
    const sendBack = (token: string, id: string) => f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/send-back`, { token, body: { note: "not yet" } });
    const first = await landTask(client.token, "Phone numbers", { "src/phone.ts": "export const phone = '555';\n" });
    const a = (await promote(client.token, first)).body.promotionId as string;
    expect((await untilState(a, ...DONE_STATES)).state).toBe("pending_approval");
    const del = await f.svc.db.prepare("DELETE FROM grants WHERE org_id = ? AND user_id = ? AND scope_kind = 'resource' AND scope_id = ?").bind(f.o.orgId, dev.userId, f.api.resourceId).run();
    expect(del.meta.changes).toBe(1);
    for (const r of [await approve(dev.token, a), await sendBack(dev.token, a)]) {
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body.error.code).toBe("promotion_not_visible");
    }
    expect((await row(a)).state).toBe("pending_approval");
    // a developer who reads every resource sends it back; the owner approves the next one
    const back = await sendBack(other.token, a);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.state).toBe("sent_back");
    const b = (await promote(client.token, first)).body.promotionId as string;
    expect((await untilState(b, ...DONE_STATES)).state).toBe("pending_approval");
    expect((await approve(dev.token, b)).status).toBe(403);
    const ok = await approve(other.token, b);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await view(f.o.token, b)).status).toBe(200);
  });

  it("a malformed task snapshot (before a proposal exists) gives a developer the client view, not an error", async () => {
    const { f, client, promote, view, untilState, landTask } = await releaseFixture();
    const dev = await f.memberWithAccess("developer", "write");
    const taskId = await landTask(client.token, "Phone numbers", { "src/phone.ts": "export const phone = '555';\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    await untilState(id, ...DONE_STATES);
    await f.svc.db.prepare("UPDATE promotions SET proposal_id = NULL WHERE promotion_id = ?").bind(id).run();
    await f.svc.db.prepare("UPDATE tasks SET snapshot_json = ? WHERE task_id = ?").bind("{not json", taskId).run();
    const single = await view(dev.token, id);
    expect(single.status, JSON.stringify(single.body)).toBe(200);
    expect(single.body.gate).toBeUndefined();
    const listed = await list(f, dev.token);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.promotions[0].gate).toBeUndefined();
    // the owner still reads everything
    expect((await view(f.o.token, id)).body.gate).toBeDefined();
  });

  it("dry run after a crash: `promoting` landings no promotion claims count as landed (as POST repairs them), and nothing is written", async () => {
    const { f, client, promote, landTask, landing } = await pageFixture();
    const a = await landTask(client.token, "Header", { "public/page.html": PAGE("TOP", "bottom") });
    const b = await landTask(client.token, "Footer", { "public/page.html": PAGE("TOP", "BOTTOM") });
    await f.h.drainSteps();
    // a crash left both landings `promoting` with no promotion that claims them
    await f.svc.db.prepare("UPDATE staging_landings SET state = 'promoting' WHERE org_id = ? AND task_id IN (?, ?)").bind(f.o.orgId, a, b).run();
    const before = await writeCounts(f);
    const d = await dryRun(f, client.token, b);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const la = (await landing(a)).landing_id;
    const lb = (await landing(b)).landing_id;
    expect(d.body).toEqual({ landings: [{ landingId: la, taskId: a, title: "Header" }, { landingId: lb, taskId: b, title: "Footer" }], mode: "closure", goingWithout: [] });
    expect(await writeCounts(f)).toEqual(before);
    expect((await landing(b)).state).toBe("promoting");
    const r = await promote(client.token, b);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.landings).toEqual(d.body.landings.map((l: { landingId: string; taskId: string }) => ({ landingId: l.landingId, taskId: l.taskId })));
  });

  it("a client's list includes promotions they requested, even without a landing they created", async () => {
    const { f, client, promote, untilState, landTask } = await releaseFixture();
    const other = await f.clientWithAccess();
    const theirs = await landTask(other.token, "Source", { "src/x.ts": "export const x = 1;\n" });
    const id = (await promote(other.token, theirs)).body.promotionId as string;
    expect((await untilState(id, ...DONE_STATES)).state).toBe("pending_approval");
    expect((await list(f, client.token)).body.promotions).toEqual([]);
    await f.svc.db.prepare("UPDATE promotions SET requested_by = ? WHERE promotion_id = ?").bind(client.userId, id).run();
    const mine = (await list(f, client.token)).body.promotions;
    expect(mine.map((p: { promotionId: string }) => p.promotionId)).toEqual([id]);
    expect(mine[0].reasonCode).toEqual(expect.any(String));
    expect(mine[0].gate).toBeUndefined();
  });
});
