/**
 * Staging phase 2, Task 9: revisions (R6) and staging bases for every task (R5). A landed task is
 * revised by a follow-up task that starts from live staging; on submit its proposal joins the
 * original landing as the next part (the landing keeps its place, `checking` until a build with
 * it is live). Staging builds, promotions (build, gate) and rollbacks cover every part. A revision
 * supersedes a promotion that has not started accepting; one submitted while a promotion is
 * accepting waits, and lands as a landing of its own once the original was promoted.
 */
import { describe, expect, it } from "vitest";
import { getPromotion, rebuildPromotion, type PromotionRow } from "../../src/services/promotions.js";
import { currentApprovals } from "../../src/services/proposals.js";
import { markLandedIfParts } from "../../src/services/staging.js";
import { currentStaging } from "../../src/services/staging-state.js";
import { enqueueStep } from "../../src/services/steps.js";
import { FakeRunner } from "../fakes/runner.js";
import { STAGING_SECTION, stagingFixture, stagingReleasePolicy, type StagingFixture } from "../staging-helpers.js";

/** `api/public/**` clears itself; source goes through the (unconfigured) classifier → developer. */
const RULES = [
  { paths: ["api/public/**"], level: "self" },
  { paths: ["api/src/**"], level: "classify" },
  { paths: ["api/migrations/**"], level: "classify" },
];
const STAGING = { ...STAGING_SECTION, promotion: { rules: RULES, classifier: { provider: "none", threshold: 0.9 } } };

async function revisionFixture() {
  const f = await stagingFixture({ staging: STAGING });
  const runner = new FakeRunner(f.h);
  const client = await f.clientWithAccess();
  const dev = await f.memberWithAccess("developer", "write");
  return { f, runner, client, dev, ...helpers(f) };
}

function helpers(f: StagingFixture) {
  const ledger = f.svc.ledger(f.o.orgId);
  const revise = (token: string, taskId: string, body: Record<string, unknown> = {}) => f.h.api("POST", `/api/tasks/${taskId}/revise`, { token, body });
  const promote = (token: string, taskId: string) => f.h.api("POST", `/api/tasks/${taskId}/promote`, { token, body: {} });
  const view = (token: string, id: string) => f.h.api("GET", `/api/orgs/${f.o.orgId}/promotions/${id}`, { token });
  const row = async (id: string): Promise<PromotionRow> => (await getPromotion(f.svc, id))!;
  /** drain one round at a time until `cond`; the promotion is then held there (its queued steps dropped) */
  async function untilHeld(id: string, cond: (p: PromotionRow) => boolean): Promise<PromotionRow> {
    const end = Date.now() + 20_000;
    for (;;) {
      const p = await row(id);
      if (cond(p)) {
        hold(id);
        return p;
      }
      if (Date.now() > end) throw new Error(`timed out (promotion ${p.state})`);
      await f.h.drainSteps(1);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  function hold(id: string) {
    const steps = f.h.steps as Array<{ type: string; promotionId?: string }>;
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.type === "promotion.advance" && steps[i]!.promotionId === id) steps.splice(i, 1);
  }
  const resume = (id: string) => enqueueStep(f.svc, { type: "promotion.advance", orgId: f.o.orgId, promotionId: id });
  async function landTask(token: string, title: string, files: Record<string, string>): Promise<string> {
    const taskId = await f.submitTask(token, title, files);
    await f.untilLanded(taskId);
    return taskId;
  }
  /** As the task's agent: lease, push `files` on top of the task's base, freeze (the task becomes `submitted`). */
  async function pushAndFreeze(token: string, taskId: string, files: Record<string, string | null>): Promise<void> {
    await (await pushOnly(token, taskId, files))();
  }
  /** {@link pushAndFreeze} without the freeze: returns it (a `null` file is deleted). */
  async function pushOnly(token: string, taskId: string, files: Record<string, string | null>): Promise<() => Promise<void>> {
    await f.until(async () => (await f.h.api("GET", `/api/tasks/${taskId}`, { token })).body.state === "ready");
    const lease = await f.h.api("POST", `/api/tasks/${taskId}/lease`, { token, body: {} });
    expect(lease.status, JSON.stringify(lease.body)).toBe(200);
    const agent = lease.body.leaseToken as string;
    const ws = (await f.h.api("GET", `/api/tasks/${taskId}`, { token: agent })).body.workspaces.find((w: { mountName: string }) => w.mountName === "api");
    const cred = await f.h.api("POST", `/api/tasks/${taskId}/credential`, { token: agent, body: { mountName: "api", access: "write" } });
    expect(cred.status, JSON.stringify(cred.body)).toBe(200);
    const where = f.h.artifacts.tokenByPlaintext(cred.body.secret)!;
    const base = f.h.artifacts.repo(where.ns, where.name).refs.get("main")!;
    const tree: Record<string, string> = { ...f.h.artifacts.files.get(base) };
    for (const [path, v] of Object.entries(files)) if (v === null) delete tree[path];
    else tree[path] = v;
    const sha = f.h.artifacts.makeCommit(tree, [base]);
    f.h.artifacts.push(where.ns, where.name, "main", sha);
    return async () => {
      const frozen = await f.h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } });
      expect(frozen.status, JSON.stringify(frozen.body)).toBe(201);
    };
  }
  /** Revise `taskId` as `token` and submit the revision with `files`; returns the revision's task id (steps not drained). */
  async function submitRevision(token: string, taskId: string, files: Record<string, string | null>): Promise<string> {
    const r = await revise(token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await pushAndFreeze(token, r.body.taskId, files);
    return r.body.taskId as string;
  }
  const landingOf = async (taskId: string) => (await f.svc.db.prepare("SELECT * FROM staging_landings WHERE org_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 1").bind(f.o.orgId, taskId).first<{ landing_id: string; proposal_id: string; state: string; seq: number }>())!;
  const parts = async (landingId: string) => (await f.svc.db.prepare("SELECT part, task_id, proposal_id FROM staging_landing_parts WHERE landing_id = ? ORDER BY part").bind(landingId).all<{ part: number; task_id: string; proposal_id: string }>()).results;
  /** wait until the landing has `n` parts and is live on staging again */
  async function untilParts(taskId: string, n: number): Promise<void> {
    const l = await landingOf(taskId);
    await f.until(async () => (await parts(l.landing_id)).length >= n, 15_000);
    await f.untilLanded(taskId);
  }
  const liveFiles = async () => {
    const cur = await currentStaging(f.svc, f.o.orgId, f.pid);
    return f.h.artifacts.files.get(cur!.shas[f.api.resourceId]!.sha)!;
  };
  const mainFiles = async () => f.h.artifacts.files.get(await f.headSha())!;
  return { ledger, revise, promote, view, row, untilHeld, hold, resume, landTask, pushAndFreeze, pushOnly, submitRevision, landingOf, parts, untilParts, liveFiles, mainFiles };
}

const leak = (orgId: string) => new RegExp(`-${orgId}-(tasks|canonical)|artifacts\\.cloudflare\\.net`);

describe("task revisions", { timeout: 180_000 }, () => {
  it("a developer revises a client's landed task: the revision starts from live staging and joins the landing as part 2", async () => {
    const { f, runner, client, dev, revise, landTask, pushAndFreeze, landingOf, parts, untilParts, liveFiles } = await revisionFixture();
    const taskId = await landTask(client.token, "Footer", { "public/footer.html": "<footer>v1</footer>\n" });
    const before = await landingOf(taskId);
    const live = await currentStaging(f.svc, f.o.orgId, f.pid);
    const r = await revise(dev.token, taskId, { request: "Make the footer bold" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ title: "Footer (revision 1)", request: "Make the footer bold", revisesTaskId: taskId });
    // seeded from live staging (R5), with the original's mounts
    const entry = r.body.snapshot.entries.find((e: { mountName: string }) => e.mountName === "api");
    expect(entry.revisionId).toBe(live!.shas[f.api.resourceId]!.revisionId);
    expect(r.body.workspaces.map((w: { mountName: string; access: string }) => [w.mountName, w.access])).toEqual([["api", "write"]]);
    // a second revision while the first is still being worked on is number 2
    const r2 = await revise(dev.token, taskId);
    expect(r2.body.title).toBe("Footer (revision 2)");
    await f.svc.db.prepare("UPDATE tasks SET state = 'canceled' WHERE task_id = ?").bind(r2.body.taskId).run();

    await pushAndFreeze(dev.token, r.body.taskId, { "src/footer.ts": "export const bold = true;\n" });
    await untilParts(taskId, 2);
    // the landing kept its place: no landing of its own for the revision
    const after = await landingOf(taskId);
    expect([after.landing_id, after.seq, after.state]).toEqual([before.landing_id, before.seq, "landed"]);
    expect(await f.svc.db.prepare("SELECT 1 FROM staging_landings WHERE task_id = ?").bind(r.body.taskId).first()).toBeNull();
    const ps = await parts(before.landing_id);
    expect(ps.map((p) => [p.part, p.task_id])).toEqual([
      [1, taskId],
      [2, r.body.taskId],
    ]);
    expect(ps[1]!.proposal_id).toMatch(/^prop-stg-/);
    expect((await f.svc.db.prepare("SELECT kind FROM proposals_index WHERE proposal_id = ?").bind(ps[1]!.proposal_id).first<{ kind: string }>())!.kind).toBe("staging");
    // staging has both parts' edits
    const files = await liveFiles();
    expect(files["public/footer.html"]).toBe("<footer>v1</footer>\n");
    expect(files["src/footer.ts"]).toBe("export const bold = true;\n");
    // the landing went checking (part 2) before it was landed again
    const checking = (await f.svc.db.prepare("SELECT detail_json FROM events WHERE org_id = ? AND action = 'staging.landing_checking' AND subject_id = ?").bind(f.o.orgId, taskId).all<{ detail_json: string }>()).results.map((e) => JSON.parse(e.detail_json));
    expect(checking).toContainEqual({ landingId: before.landing_id, part: 2, revisionTaskId: r.body.taskId });
    // the client's staging view lists the parts of their landing
    const v = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging`, { token: client.token });
    expect(v.body.landings.find((l: { landingId: string }) => l.landingId === before.landing_id).parts).toEqual([
      { part: 1, taskId },
      { part: 2, taskId: r.body.taskId },
    ]);
    // the third revision is numbered after the joined part and the canceled one is not counted
    expect((await revise(client.token, taskId)).body.title).toBe("Footer (revision 2)");
    expect(runner.errors).toEqual([]);
  });

  it("promoting a revised landing integrates both parts; the gate sees part 2's paths", async () => {
    const { f, client, dev, promote, view, row, landTask, submitRevision, untilParts, mainFiles } = await revisionFixture();
    const taskId = await landTask(client.token, "Footer", { "public/footer.html": "<footer>v1</footer>\n" });
    await submitRevision(dev.token, taskId, { "src/footer.ts": "export const bold = true;\n" });
    await untilParts(taskId, 2);
    const r = await promote(client.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await f.until(async () => ["pending_approval", "cleared", "failed"].includes((await row(r.body.promotionId)).state), 20_000);
    const p = await row(r.body.promotionId);
    // part 1 alone would clear itself; part 2's source path needs a developer
    expect(p).toMatchObject({ state: "pending_approval", level: "developer" });
    expect(JSON.parse(p.proposal_hashes_json)).toHaveLength(2);
    expect(Object.keys(JSON.parse(p.merge_bases_json!))).toHaveLength(2);
    const gate = (await view(dev.token, p.promotion_id)).body.gate;
    expect(gate.perPath.map((x: { path: string }) => x.path).sort()).toEqual(["api/public/footer.html", "api/src/footer.ts"]);
    // the promotion proposal carries both parts' candidates, and its build has both edits
    const proposal = (await f.svc.ledger(f.o.orgId).getProposal(p.proposal_id!))!;
    expect(proposal.resourceChanges).toHaveLength(2);
    const a = await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${p.promotion_id}/approve`, { token: dev.token, body: {} });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    await f.until(async () => ["live", "release_failed", "failed"].includes((await row(p.promotion_id)).state), 30_000);
    expect((await row(p.promotion_id)).state).toBe("live");
    const main = await mainFiles();
    expect(main["public/footer.html"]).toBe("<footer>v1</footer>\n");
    expect(main["src/footer.ts"]).toBe("export const bold = true;\n");
  });

  it("a revision submitted while the promotion waits for approval supersedes it (clearance void); promoting again works", async () => {
    const { f, client, dev, revise, promote, row, landTask, pushAndFreeze, landingOf, parts, untilParts } = await revisionFixture();
    const taskId = await landTask(client.token, "API", { "src/contacts.ts": "export const contacts = [];\n" });
    const pr = await promote(client.token, taskId);
    await f.until(async () => (await row(pr.body.promotionId)).state === "pending_approval", 20_000);
    expect((await landingOf(taskId)).state).toBe("promoting");
    // the revise is allowed while the promotion waits; the promotion ends only when the revision is submitted
    const r = await revise(dev.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await row(pr.body.promotionId)).state).toBe("pending_approval");
    await pushAndFreeze(dev.token, r.body.taskId, { "src/contacts.ts": "export const contacts = ['Ada'];\n" });
    await f.until(async () => (await row(pr.body.promotionId)).state === "superseded", 15_000);
    expect(await row(pr.body.promotionId)).toMatchObject({ reason_code: "landing_revised", clearance_kind: null, cleared_by: null });
    await untilParts(taskId, 2);
    expect((await parts((await landingOf(taskId)).landing_id)).map((p) => p.task_id)).toEqual([taskId, r.body.taskId]);
    const again = await promote(client.token, taskId);
    expect(again.status, JSON.stringify(again.body)).toBe(202);
  });

  it("a cleared promotion is superseded by a revision too", async () => {
    const { f, client, dev, promote, row, untilHeld, landTask, submitRevision, untilParts } = await revisionFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const pr = await promote(client.token, taskId);
    await untilHeld(pr.body.promotionId, (p) => p.state === "cleared");
    await submitRevision(dev.token, taskId, { "public/index.html": "<h1>Hello</h1>\n" });
    await f.until(async () => (await row(pr.body.promotionId)).state === "superseded", 15_000);
    await untilParts(taskId, 2);
    // the clearance's ledger approval no longer counts: the row is superseded and void
    expect(await row(pr.body.promotionId)).toMatchObject({ clearance_kind: null, clearance_key: null });
  });

  it("a revision submitted while the promotion is accepting waits, then lands as a landing of its own after the promotion", async () => {
    const { f, client, revise, promote, row, untilHeld, hold, resume, landTask, pushAndFreeze, landingOf, parts, liveFiles, mainFiles } = await revisionFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const original = await landingOf(taskId);
    const pr = await promote(client.token, taskId);
    await untilHeld(pr.body.promotionId, (p) => p.state === "cleared");
    const r = await revise(client.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // the promotion's step has entered accepting (held there): a revise is refused now…
    // (its chain is lost: no heartbeat, so the waiting revision's nudges are not deduplicated away)
    await f.svc.db.prepare("UPDATE promotions SET state = 'accepting', chain_at = NULL WHERE promotion_id = ?").bind(pr.body.promotionId).run();
    expect((await revise(client.token, taskId)).body.error.code).toBe("landing_not_revisable");
    // …and the revision already being worked on waits when submitted
    await pushAndFreeze(client.token, r.body.taskId, { "public/about.html": "<p>About</p>\n" });
    // (the promotion stays held: its steps are dropped after every round; the waiting revision nudges it)
    let nudged = 0;
    for (let i = 0; i < 15; i++) {
      await f.h.drainSteps(1);
      nudged += (f.h.steps as Array<{ type: string; promotionId?: string }>).filter((s) => s.type === "promotion.advance" && s.promotionId === pr.body.promotionId).length;
      hold(pr.body.promotionId);
    }
    expect(nudged).toBeGreaterThan(0);
    expect((await row(pr.body.promotionId)).state).toBe("accepting");
    expect((await landingOf(taskId)).state).toBe("promoting");
    expect(await parts(original.landing_id)).toHaveLength(1);
    expect(await f.svc.db.prepare("SELECT 1 FROM staging_landings WHERE task_id = ?").bind(r.body.taskId).first()).toBeNull();
    const queued = (f.h.steps as Array<{ type: string; taskId?: string }>).filter((s) => s.type === "staging.land" && s.taskId === r.body.taskId);
    expect(queued.length).toBeGreaterThan(0);
    // the promotion goes on: accepted (the landing promoted), then the revision lands on its own
    await resume(pr.body.promotionId);
    await f.until(async () => ["live", "release_failed", "failed"].includes((await row(pr.body.promotionId)).state), 30_000);
    expect((await row(pr.body.promotionId)).state).toBe("live");
    expect((await landingOf(taskId)).state).toBe("promoted");
    await f.untilLanded(r.body.taskId);
    const own = await landingOf(r.body.taskId);
    expect(own.landing_id).not.toBe(original.landing_id);
    expect(own.seq).toBeGreaterThan(original.seq);
    expect(await parts(own.landing_id)).toEqual([expect.objectContaining({ part: 1, task_id: r.body.taskId })]);
    expect((await f.svc.db.prepare("SELECT revises_task_id FROM tasks WHERE task_id = ?").bind(r.body.taskId).first<{ revises_task_id: string }>())!.revises_task_id).toBe(taskId);
    // staging: main (with the original) plus the revision; main has only the original
    const files = await liveFiles();
    expect(files["public/index.html"]).toBe("<h1>Hi</h1>\n");
    expect(files["public/about.html"]).toBe("<p>About</p>\n");
    expect((await mainFiles())["public/about.html"]).toBeUndefined();
  });

  it("a revision still waiting 2 h after its submit lands on its own (revision_landed_alone)", async () => {
    const { f, client, revise, promote, row, untilHeld, hold, landTask, pushAndFreeze, landingOf } = await revisionFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const pr = await promote(client.token, taskId);
    await untilHeld(pr.body.promotionId, (p) => p.state === "cleared");
    const r = await revise(client.token, taskId);
    await f.svc.db.prepare("UPDATE promotions SET state = 'accepting' WHERE promotion_id = ?").bind(pr.body.promotionId).run();
    await pushAndFreeze(client.token, r.body.taskId, { "public/about.html": "<p>About</p>\n" });
    for (let i = 0; i < 3; i++) {
      await f.h.drainSteps(1);
      hold(pr.body.promotionId);
    }
    expect(await f.svc.db.prepare("SELECT 1 FROM staging_landings WHERE task_id = ?").bind(r.body.taskId).first()).toBeNull();
    // submitted 3 h ago (the submit is the task's newest candidate)
    await f.svc.db.prepare("UPDATE task_candidates SET created_at = ? WHERE task_id = ?").bind(new Date(Date.now() - 3 * 3600_000).toISOString(), r.body.taskId).run();
    const end = Date.now() + 20_000;
    for (;;) {
      await f.h.drainSteps(1);
      hold(pr.body.promotionId);
      const own = await f.svc.db.prepare("SELECT state FROM staging_landings WHERE task_id = ?").bind(r.body.taskId).first<{ state: string }>();
      if (own?.state === "landed") break;
      if (Date.now() > end) throw new Error(`timed out (${own?.state})`);
    }
    expect(await landingOf(r.body.taskId)).toMatchObject({ state: "landed", reason_code: "revision_landed_alone", reason: "The task this revises was still being accepted into production after 2 hours, so this revision landed on its own." });
    expect((await row(pr.body.promotionId)).state).toBe("accepting");
  });

  it("a revision of a task whose landing failed lands on its own with revision_without_original", async () => {
    const { f, client, revise, landTask, pushAndFreeze, landingOf } = await revisionFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const r = await revise(client.token, taskId);
    await f.svc.db.prepare("UPDATE staging_landings SET state = 'failed' WHERE task_id = ?").bind(taskId).run();
    await pushAndFreeze(client.token, r.body.taskId, { "public/about.html": "<p>About</p>\n" });
    await f.untilLanded(r.body.taskId);
    expect(await landingOf(r.body.taskId)).toMatchObject({ state: "landed", reason_code: "revision_without_original", reason: "The task this revises is no longer in staging, so this revision landed on its own, without it." });
  });

  it("a staging conflict blamed on a revised landing drops only the new part; the live part stays and the revision is told why", async () => {
    const { f, runner, client, dev, ledger, revise, landTask, pushAndFreeze, landingOf, parts, liveFiles } = await revisionFixture();
    const taskId = await landTask(client.token, "Footer", { "public/footer.html": "<footer>v1</footer>\n" });
    const l = await landingOf(taskId);
    const r = await revise(dev.token, taskId);
    runner.opts.stagingConflict = { landingId: l.landing_id, paths: ["public/footer.html"] };
    await pushAndFreeze(dev.token, r.body.taskId, { "public/footer.html": "<footer>v2</footer>\n" });
    await f.until(async () => !!(await f.svc.db.prepare("SELECT 1 FROM events WHERE action = 'staging.revision_dropped' AND subject_id = ?").bind(r.body.taskId).first()), 15_000);
    runner.opts.stagingConflict = undefined;
    await f.untilLanded(taskId);
    expect(await landingOf(taskId)).toMatchObject({ landing_id: l.landing_id, state: "landed", reason_code: null });
    expect((await parts(l.landing_id)).map((p) => p.task_id)).toEqual([taskId]);
    const dropped = (await f.svc.db.prepare("SELECT detail_json, client_detail_json FROM events WHERE action = 'staging.revision_dropped' AND subject_id = ?").bind(r.body.taskId).first<{ detail_json: string; client_detail_json: string }>())!;
    expect(JSON.parse(dropped.detail_json)).toMatchObject({ landingId: l.landing_id, part: 2, code: "textual_conflict", reason: "This revision conflicts with staging in public/footer.html. The task stays in staging without it; revise it again from the current staging." });
    expect(JSON.parse(dropped.client_detail_json)).toEqual({ landingId: l.landing_id, code: "textual_conflict" });
    const revProposal = (await f.svc.db.prepare("SELECT proposal_id FROM proposals_index WHERE task_id = ?").bind(r.body.taskId).first<{ proposal_id: string }>())!.proposal_id;
    expect((await ledger.getProposal(revProposal))!.state).toBe("withdrawn");
    expect((await liveFiles())["public/footer.html"]).toBe("<footer>v1</footer>\n");
    // a retried land step never appends the dropped revision again
    await enqueueStep(f.svc, { type: "staging.land", orgId: f.o.orgId, taskId: r.body.taskId });
    await f.h.drainSteps();
    expect(await parts(l.landing_id)).toHaveLength(1);
    // the task can be revised again
    expect((await revise(client.token, taskId)).status).toBe(201);
  });

  it("a non-conflict build failure while a landing checks only a new part drops that part, not the landing", async () => {
    const { f, runner, client, dev, revise, landTask, pushAndFreeze, landingOf, parts } = await revisionFixture();
    const taskId = await landTask(client.token, "Footer", { "public/footer.html": "<footer>v1</footer>\n" });
    const l = await landingOf(taskId);
    const r = await revise(dev.token, taskId);
    runner.opts.fail = { "staging-build": { code: "provider_unavailable", detail: "push failed (test)" } } as never;
    await pushAndFreeze(dev.token, r.body.taskId, { "public/footer.css": "footer {}\n" });
    await f.until(async () => !!(await f.svc.db.prepare("SELECT 1 FROM events WHERE action = 'staging.revision_dropped' AND subject_id = ?").bind(r.body.taskId).first()), 15_000);
    runner.opts.fail = undefined;
    await f.untilLanded(taskId);
    expect(await landingOf(taskId)).toMatchObject({ state: "landed" });
    expect(await parts(l.landing_id)).toHaveLength(1);
  });

  it("a part appended between a build's merge and its going live keeps the landing checking until a build with it is live", async () => {
    const { f, client, dev, revise, landTask, pushOnly, landingOf, parts, liveFiles } = await revisionFixture();
    const taskId = await landTask(client.token, "Footer", { "public/footer.html": "<footer>v1</footer>\n" });
    const l = await landingOf(taskId);
    const r1 = await revise(dev.token, taskId);
    const r2 = await revise(dev.token, taskId);
    const freeze1 = await pushOnly(dev.token, r1.body.taskId, { "public/one.html": "1\n" });
    const freeze2 = await pushOnly(dev.token, r2.body.taskId, { "public/two.html": "2\n" });
    await freeze1();
    const newest = () => f.svc.db.prepare("SELECT build_id, state FROM staging_builds WHERE org_id = ? AND project_id = ? ORDER BY seq DESC LIMIT 1").bind(f.o.orgId, f.pid).first<{ build_id: string; state: string }>();
    const end = Date.now() + 20_000;
    while ((await parts(l.landing_id)).length < 2 || !["building", "deploying"].includes((await newest())!.state)) {
      if (Date.now() > end) throw new Error("timed out");
      await f.h.drainSteps(1);
    }
    const b1 = (await newest())!.build_id;
    await freeze2(); // part 3 joins while build 1 (with parts 1–2) is past its merge
    const buildState = async (id: string) => (await f.svc.db.prepare("SELECT state FROM staging_builds WHERE build_id = ?").bind(id).first<{ state: string }>())!.state;
    while ((await buildState(b1)) !== "live") {
      if (Date.now() > end) throw new Error("timed out");
      await f.h.drainSteps(1);
    }
    expect(await parts(l.landing_id)).toHaveLength(3);
    expect((await landingOf(taskId)).state).toBe("checking");
    await f.untilLanded(taskId);
    const files = await liveFiles();
    expect([files["public/one.html"], files["public/two.html"]]).toEqual(["1\n", "2\n"]);
  });

  it("the landed transition is conditional on the part count it was checked with", async () => {
    const { f, client, landTask, landingOf } = await revisionFixture();
    const taskId = await landTask(client.token, "Footer", { "public/footer.html": "<footer>v1</footer>\n" });
    await f.svc.db.prepare("UPDATE staging_landings SET state = 'checking' WHERE task_id = ?").bind(taskId).run();
    const l = (await landingOf(taskId)) as never;
    expect(await markLandedIfParts(f.svc, l, 2)).toBe(false);
    expect((await landingOf(taskId)).state).toBe("checking");
    expect(await markLandedIfParts(f.svc, l, 1)).toBe(true);
    expect((await landingOf(taskId)).state).toBe("landed");
  });

  it("a revision built on a later landing it overlaps makes that landing part of the promotion", async () => {
    const { f, client, dev, promote, landTask, submitRevision, landingOf, untilParts } = await revisionFixture();
    const other = await f.clientWithAccess();
    const taskId = await landTask(client.token, "Home", { "public/index.html": "<h1>Hi</h1>\n" });
    const later = await landTask(other.token, "Menu", { "public/menu.html": "<nav>a</nav>\n" });
    const [l, m] = [await landingOf(taskId), await landingOf(later)];
    expect(m.seq).toBeGreaterThan(l.seq);
    // the revision was seeded from staging with Menu and edits Menu's file
    await submitRevision(dev.token, taskId, { "public/menu.html": "<nav>a</nav><nav>b</nav>\n" });
    await untilParts(taskId, 2);
    const r = await promote(client.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.landings.map((x: { landingId: string }) => x.landingId)).toEqual([l.landing_id, m.landing_id]);
  });

  it("a revision's after-landings are exactly those of the build it was seeded from (never another build with the same commit)", async () => {
    const { f, dev, revise, promote, landTask, pushAndFreeze, landingOf, untilParts } = await revisionFixture();
    const other = await f.clientWithAccess();
    const taskId = await landTask(f.o.token, "Home", { "public/index.html": "<h1>Hi</h1>\n" });
    const seed = (await currentStaging(f.svc, f.o.orgId, f.pid))!;
    const r = await revise(dev.token, taskId);
    expect((await f.svc.db.prepare("SELECT staging_build_id FROM tasks WHERE task_id = ?").bind(r.body.taskId).first<{ staging_build_id: string }>())!.staging_build_id).toBe(seed.buildId);
    // a later landing on the same path, which the revision never saw
    const later = await landTask(other.token, "Home too", { "public/index.html": "<h1>Hello</h1>\n" });
    await pushAndFreeze(dev.token, r.body.taskId, { "public/extra.html": "x\n" });
    await untilParts(taskId, 2);
    const [l, w] = [await landingOf(taskId), await landingOf(later)];
    // another build whose merge result has the revision's base commit (as a resource no landing
    // touches keeps main's sha in every build) and that lists the later landing
    const base = seed.shas[f.api.resourceId]!;
    await f.svc.db
      .prepare("INSERT INTO staging_builds (build_id, org_id, project_id, seq, landings_json, state, staging_json, created_by, created_at, updated_at) VALUES ('sb-same-sha', ?, ?, 1000, ?, 'failed', ?, ?, ?, ?)")
      .bind(f.o.orgId, f.pid, JSON.stringify([l.landing_id, w.landing_id]), JSON.stringify({ [f.api.resourceId]: base }), f.o.userId, f.svc.nowIso(), f.svc.nowIso())
      .run();
    const p = await promote(f.o.token, taskId);
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    expect(p.body.landings.map((x: { landingId: string }) => x.landingId)).toEqual([l.landing_id]);
  });

  it("a landed landing that no longer merges with production fails (conflicts_with_production); staging goes live again without it", async () => {
    const { f, runner, client, ledger, promote, row, landTask, landingOf, liveFiles } = await revisionFixture();
    const other = await f.clientWithAccess();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(other.token, "B", { "public/b.html": "b\n" });
    const lb = await landingOf(b);
    // once A is in main, B no longer merges (the fake runner blames B)
    runner.opts.stagingConflict = { landingId: lb.landing_id, paths: ["public/b.html"] };
    const p = await promote(client.token, a);
    expect(p.status, JSON.stringify(p.body)).toBe(202);
    await f.until(async () => ["live", "release_failed", "failed"].includes((await row(p.body.promotionId)).state), 30_000);
    await f.until(async () => (await landingOf(b)).state === "failed", 20_000);
    expect(await landingOf(b)).toMatchObject({ reason_code: "conflicts_with_production", reason: "Conflicts with a change now in production. Start a new task from the current staging." });
    expect((await ledger.getProposal(lb.proposal_id))!.state).toBe("withdrawn");
    await f.until(async () => !(await f.svc.db.prepare("SELECT 1 FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'merging', 'building', 'deploying')").bind(f.o.orgId, f.pid).first()), 20_000);
    const newest = (await f.svc.db.prepare("SELECT state, landings_json FROM staging_builds WHERE org_id = ? AND project_id = ? ORDER BY seq DESC LIMIT 1").bind(f.o.orgId, f.pid).first<{ state: string; landings_json: string }>())!;
    expect(newest).toMatchObject({ state: "live", landings_json: "[]" });
    expect((await liveFiles())["public/a.html"]).toBe("a\n");
    expect((await liveFiles())["public/b.html"]).toBeUndefined();
  });

  it("after 5 failed builds in a row a failing build requests no further build (staging.stuck for developers)", async () => {
    const { f, runner, client, landTask, landingOf } = await revisionFixture();
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    const lb = await landingOf(b);
    const now = f.svc.nowIso();
    for (let i = 0; i < 4; i++) {
      await f.svc.db
        .prepare("INSERT INTO staging_builds (build_id, org_id, project_id, seq, landings_json, state, created_by, created_at, updated_at) VALUES (?, ?, ?, (SELECT MAX(seq) + 1 FROM staging_builds WHERE org_id = ? AND project_id = ?), '[]', 'failed', ?, ?, ?)")
        .bind(`sb-failed-${i}`, f.o.orgId, f.pid, f.o.orgId, f.pid, f.o.userId, now, now)
        .run();
    }
    runner.opts.stagingConflict = { landingId: lb.landing_id, paths: ["public/b.html"] };
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/reset`, { token: f.o.token, body: {} })).status).toBe(202);
    // generous waits: under full-suite load the failed build's handling (runner result, steps) can lag
    await f.until(async () => (await landingOf(b)).state === "failed", 60_000);
    const stuckEvent = () => f.svc.db.prepare("SELECT client_visible FROM events WHERE org_id = ? AND action = 'staging.stuck'").bind(f.o.orgId).first<{ client_visible: number }>();
    await f.until(async () => !!(await stuckEvent()), 60_000);
    await runner.idle();
    await f.h.drainSteps();
    expect(await f.svc.db.prepare("SELECT 1 FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'merging', 'building', 'deploying')").bind(f.o.orgId, f.pid).first()).toBeNull();
    const stuck = await stuckEvent();
    expect(stuck).toBeTruthy();
    expect(stuck!.client_visible).toBe(0);
  }, 240_000);

  it("a landing revised twice (the second a revert) promotes only its own net edits: a later landing never leaks into main", async () => {
    const { f, client, dev, promote, row, landTask, submitRevision, untilParts, mainFiles } = await revisionFixture();
    const other = await f.clientWithAccess();
    const taskId = await landTask(client.token, "Home", { "public/index.html": "<h1>Hi</h1>\n" });
    await landTask(other.token, "Menu", { "public/menu.html": "<nav>a</nav>\n" });
    await submitRevision(dev.token, taskId, { "public/banner.html": "<p>Sale</p>\n" });
    await untilParts(taskId, 2);
    await submitRevision(dev.token, taskId, { "public/banner.html": null });
    await untilParts(taskId, 3);
    const r = await promote(client.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.landings).toHaveLength(1);
    await f.until(async () => ["live", "release_failed", "failed", "pending_approval"].includes((await row(r.body.promotionId)).state), 30_000);
    expect((await row(r.body.promotionId)).state).toBe("live");
    const main = await mainFiles();
    expect(main["public/index.html"]).toBe("<h1>Hi</h1>\n");
    expect(main["public/banner.html"]).toBeUndefined();
    expect(main["public/menu.html"]).toBeUndefined();
  });

  it("a revision superseding a promotion that is building again (after a rebuild) leaves no clearance that counts", async () => {
    const { f, client, dev, revise, promote, row, untilHeld, resume, landTask, pushAndFreeze } = await revisionFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const pr = await promote(client.token, taskId);
    const cleared = await untilHeld(pr.body.promotionId, (p) => p.state === "cleared");
    const rev = await revise(dev.token, taskId); // revisable while cleared
    expect(await rebuildPromotion(f.svc, cleared.promotion_id, ["cleared"])).toBe(true);
    await resume(cleared.promotion_id);
    const building = await untilHeld(cleared.promotion_id, (p) => p.state === "building" || p.state === "gating");
    expect(building.clearance_kind).toBe("self"); // kept across the rebuild until the gate decides
    await pushAndFreeze(dev.token, rev.body.taskId, { "public/index.html": "<h1>Hello</h1>\n" });
    await f.until(async () => (await row(cleared.promotion_id)).state === "superseded", 15_000);
    const p = await row(cleared.promotion_id);
    expect(p).toMatchObject({ clearance_kind: null, clearance_key: null, cleared_by: null });
    const proposal = (await f.svc.ledger(f.o.orgId).getProposal(p.proposal_id!))!;
    const approvals = await f.svc.ledger(f.o.orgId).listApprovals(proposal.proposalId);
    expect(approvals.some((a) => a.role.startsWith("clearance:"))).toBe(true); // still in the ledger…
    expect(await currentApprovals(f.svc, f.o.orgId, f.pid, approvals, proposal)).toEqual([]); // …but it no longer counts
  });

  it("rolling back a revised landing takes every part out and withdraws every part's proposal", async () => {
    const { f, client, dev, ledger, landTask, submitRevision, landingOf, parts, untilParts, liveFiles } = await revisionFixture();
    const taskId = await landTask(client.token, "Footer", { "public/footer.html": "<footer>v1</footer>\n" });
    const revisionId = await submitRevision(dev.token, taskId, { "public/footer.css": "footer { font-weight: bold; }\n" });
    await untilParts(taskId, 2);
    const l = await landingOf(taskId);
    const ps = await parts(l.landing_id);
    // rolling back through the revision's task id takes the whole landing out
    const rb = await f.h.api("POST", `/api/tasks/${revisionId}/rollback`, { token: dev.token, body: {} });
    expect(rb.status, JSON.stringify(rb.body)).toBe(202);
    await f.until(async () => (await landingOf(taskId)).state === "rolled_back", 15_000);
    for (const p of ps) expect((await ledger.getProposal(p.proposal_id))!.state).toBe("withdrawn");
    await f.until(async () => !(await f.svc.db.prepare("SELECT 1 FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'merging', 'building', 'deploying')").bind(f.o.orgId, f.pid).first()), 15_000);
    const files = await liveFiles();
    expect(files["public/footer.html"]).toBeUndefined();
    expect(files["public/footer.css"]).toBeUndefined();
    // a rolled-back task can no longer be revised
    expect((await f.h.api("POST", `/api/tasks/${taskId}/revise`, { token: client.token, body: {} })).body.error.code).toBe("landing_not_revisable");
  });
});

describe("task revisions: who may revise what", { timeout: 120_000 }, () => {
  it("a client revises their own task (client-safe response); another client's task is not found", async () => {
    const { f, client, revise, landTask } = await revisionFixture();
    const other = await f.clientWithAccess();
    const taskId = await landTask(client.token, "Footer", { "public/footer.html": "<footer>v1</footer>\n" });
    const r = await revise(client.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(JSON.stringify(r.body)).not.toMatch(leak(f.o.orgId));
    expect(r.body.revisesTaskId).toBe(taskId);
    const o = await revise(other.token, taskId);
    expect([o.status, o.body.error.code]).toEqual([404, "not_found"]);
    // the other client neither lists nor reads the revision
    expect((await f.h.api("GET", `/api/tasks/${r.body.taskId}`, { token: other.token })).status).toBe(404);
    expect((await revise(other.token, r.body.taskId)).status).toBe(404);
  });

  it("a task that is not live on staging cannot be revised (409 landing_not_revisable)", async () => {
    const { f, client, revise } = await revisionFixture();
    const t = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "Draft", writeMounts: ["api"] } });
    expect(t.status).toBe(201);
    const r = await revise(client.token, t.body.taskId);
    expect([r.status, r.body.error.code]).toEqual([409, "landing_not_revisable"]);
    // a submitted task whose landing is still checking is not revisable yet either
    const submitted = await f.submitTask(client.token, "Checking", { "public/x.html": "x\n" });
    const landingId = await f.landingIdOf(submitted);
    await f.svc.db.prepare("UPDATE staging_landings SET state = 'checking' WHERE landing_id = ?").bind(landingId).run();
    const c = await revise(client.token, submitted);
    expect([c.status, c.body.error.code]).toEqual([409, "landing_not_revisable"]);
  });

  it("a viewer cannot revise; without staging mode nobody can", async () => {
    const { f, client, revise, landTask } = await revisionFixture();
    const viewer = await f.memberWithAccess("viewer");
    const taskId = await landTask(client.token, "Footer", { "public/footer.html": "<footer>v1</footer>\n" });
    expect((await revise(viewer.token, taskId)).status).toBe(404);
    const off = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { release: stagingReleasePolicy(f.o.orgId) } });
    expect(off.status).toBe(200);
    expect((await revise(f.o.token, taskId)).status).toBe(404);
  });
});
