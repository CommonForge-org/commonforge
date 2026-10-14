/**
 * Staging phase 2, Task 7: promotions — request (with the landings a task depends on), the
 * promotion build on `main`, the gate, self/owner/developer clearances, approve, send back, and
 * clearances carried across rebuilds (ruling P2-1). Task 8 continues from `cleared` in the same
 * chain (accept, release; promotion-release.test.ts): these tests hold a promotion at `cleared`
 * (`untilState`/`untilRow` drop its queued steps there) to look at it.
 */
import { describe, expect, it } from "vitest";
import { userRef } from "../../src/services/events.js";
import { acceptInputFor, currentApprovals } from "../../src/services/proposals.js";
import { getPromotion, rebuildPromotion, type PromotionRow } from "../../src/services/promotions.js";
import { runGc } from "../../src/services/gc.js";
import { approvePromotion, sendBackPromotion } from "../../src/services/promotions.js";
import { requestBuild } from "../../src/services/staging.js";
import { enqueueStep } from "../../src/services/steps.js";
import { FakeRunner } from "../fakes/runner.js";
import { ownerWithOrg } from "../helpers.js";
import { promotionHelpers } from "../promotion-helpers.js";
import { STAGING_SECTION, stagingFixture, stagingReleasePolicy, type StagingFixture } from "../staging-helpers.js";

/** `api/public/**` clears itself; source and migrations go through the (unconfigured) classifier. */
const RULES = [
  { paths: ["api/public/**"], level: "self" },
  { paths: ["api/src/**"], level: "classify" },
  { paths: ["api/migrations/**"], level: "classify" },
];
const stagingWith = (rules: unknown[]) => ({ ...STAGING_SECTION, promotion: { rules, classifier: { provider: "none", threshold: 0.9 } } });

async function flowFixture(rules: unknown[] = RULES) {
  const f = await stagingFixture({ staging: stagingWith(rules) });
  const runner = new FakeRunner(f.h);
  const client = await f.clientWithAccess();
  return { f, runner, client, ...flowHelpers(f) };
}

function flowHelpers(f: StagingFixture) {
  const shared = promotionHelpers(f);
  /** drain steps until the promotion is in one of `states` (held there when that is `cleared`) */
  const untilState = (id: string, ...states: string[]): Promise<PromotionRow> => shared.untilRow(id, (p) => states.includes(p.state));
  const clearances = async (p: PromotionRow) => (await f.svc.ledger(f.o.orgId).listApprovals(p.proposal_id!)).filter((a) => a.role.startsWith("clearance:"));
  /** what Task 8 does when accept finds main moved or the policy changed: rebuild, and the chain goes on */
  async function rebuild(id: string) {
    expect(await rebuildPromotion(f.svc, id, ["cleared", "pending_approval"], { stale: true })).toBe(true);
    await enqueueStep(f.svc, { type: "promotion.advance", orgId: f.o.orgId, promotionId: id });
  }
  /** save the policy with these promotion rules (and approval roles); the PUT nudges waiting promotions */
  async function putRules(rules: unknown[], extra: Record<string, unknown> = {}) {
    const r = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { release: stagingReleasePolicy(f.o.orgId), staging: stagingWith(rules), ...extra } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  const candidateOf = async (taskId: string) => {
    const l = (await f.svc.db.prepare("SELECT proposal_id FROM staging_landings WHERE org_id = ? AND task_id = ?").bind(f.o.orgId, taskId).first<{ proposal_id: string }>())!;
    return (await f.svc.ledger(f.o.orgId).getProposal(l.proposal_id))!.resourceChanges[0]!.candidateId;
  };
  return { ...shared, untilState, clearances, rebuild, putRules, candidateOf };
}

describe("promotions", { timeout: 120_000 }, () => {
  it("a copy-only task clears itself: clearance:self by the requester for the proposal hash", async () => {
    const { f, runner, client, promote, view, untilState, landTask, landingState, clearances } = await flowFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Welcome</h1>\n" });
    const r = await promote(client.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.landings).toHaveLength(1);
    expect(r.body.landings[0].taskId).toBe(taskId);
    expect(await landingState(taskId)).toBe("promoting");
    const p = await untilState(r.body.promotionId, "cleared", "pending_approval", "failed");
    expect(p).toMatchObject({ state: "cleared", level: "self", clearance_kind: "self", cleared_by: client.userId });
    expect(p.proposal_id).toMatch(/^prop-pro-/);
    const c = await clearances(p);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ role: "clearance:self", proposalHash: p.proposal_hash, approver: { kind: "user", id: client.userId } });
    // the ledger would take it: the clearance counts for the current proposal
    const proposal = (await f.svc.ledger(f.o.orgId).getProposal(p.proposal_id!))!;
    expect((await acceptInputFor(f.svc, proposal, "k-self", userRef(client.userId))).approvals.map((a) => a.role)).toEqual(["clearance:self"]);
    // the promotion build ran on main with the task's own edits
    expect((await f.svc.ledger(f.o.orgId).getIntegrationReceipt(p.proposal_id!))!.evidence.proposalHash).toBe(p.proposal_hash);
    // clients read state, landings, level, reasons and the alone-first lists (task titles) only
    const v = await view(client.token, r.body.promotionId);
    expect(v.status).toBe(200);
    expect(Object.keys(v.body).sort()).toEqual(["goingWithout", "landings", "level", "mode", "needs", "promotionId", "reason", "reasonCode", "state", "waitingForProduction"]);
    expect(v.body).toMatchObject({ state: "cleared", level: "self" });
    expect(runner.errors).toEqual([]);
  });

  it("an API task waits for a developer (client sees the code and the plain text, no gate); the developer approves", async () => {
    const { f, client, promote, view, untilState, landTask, clearances, queuedSteps } = await flowFixture();
    const dev = await f.memberWithAccess("developer");
    const taskId = await landTask(client.token, "API", { "src/contacts.ts": "export const contacts = [];\n" });
    const r = await promote(client.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const p = await untilState(r.body.promotionId, "pending_approval", "cleared", "failed");
    await f.h.drainSteps();
    expect(queuedSteps(p.promotion_id)).toBe(0);
    expect(p).toMatchObject({ state: "pending_approval", level: "developer", reason_code: "classifier_unavailable" });
    const v = await view(client.token, p.promotion_id);
    expect(v.body).toMatchObject({ state: "pending_approval", reasonCode: "classifier_unavailable", reason: "Needs a developer's review." });
    expect(v.body.gate).toBeUndefined();
    expect(v.body.detail).toBeUndefined();
    expect(JSON.stringify(v.body)).not.toContain("api/src");
    const dv = await view(dev.token, p.promotion_id);
    expect(dv.body.gate.perPath).toEqual([{ path: "api/src/contacts.ts", level: "classify", rule: 1 }]);
    // clients cannot approve
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${p.promotion_id}/approve`, { token: client.token, body: {} })).status).toBe(403);
    const a = await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${p.promotion_id}/approve`, { token: dev.token, body: {} });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ state: "cleared", clearance: { kind: "developer", clearedBy: dev.userId } });
    // the chain had ended in pending_approval: exactly one chain goes on from the approval
    expect(queuedSteps(p.promotion_id)).toBe(1);
    const cleared = await untilState(p.promotion_id, "cleared");
    expect(cleared).toMatchObject({ clearance_kind: "developer", cleared_by: dev.userId, reason_code: null });
    expect((await clearances(cleared)).map((c) => [c.role, c.approver.id])).toEqual([["clearance:developer", dev.userId]]);
    // approving twice is refused
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${p.promotion_id}/approve`, { token: dev.token, body: {} })).status).toBe(409);
  });

  it("an owner's own request clears as developer", async () => {
    const { f, promote, untilState, landTask } = await flowFixture();
    const taskId = await landTask(f.o.token, "Owner API", { "src/owner.ts": "export const owner = 1;\n" });
    const r = await promote(f.o.token, taskId);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(await untilState(r.body.promotionId, "cleared", "pending_approval", "failed")).toMatchObject({ state: "cleared", level: "developer", clearance_kind: "developer", cleared_by: f.o.userId });
  });

  it("a destructive migration waits for a developer, who sends it back with a note the client reads", async () => {
    const { f, client, promote, view, untilState, landTask, landingState } = await flowFixture();
    const dev = await f.memberWithAccess("developer");
    const taskId = await landTask(client.token, "Drop", { "migrations/0002_drop.sql": "DROP TABLE contacts;\n" });
    const r = await promote(client.token, taskId);
    const p = await untilState(r.body.promotionId, "pending_approval", "cleared", "failed");
    expect(p).toMatchObject({ state: "pending_approval", reason_code: "migration_destructive" });
    expect((await view(dev.token, p.promotion_id)).body.gate.veto).toMatchObject({ kind: "destructive" });
    // a client cannot send back
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${p.promotion_id}/send-back`, { token: client.token, body: { note: "x" } })).status).toBe(403);
    const note = "Please keep the contacts table; add a new column instead.";
    const s = await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${p.promotion_id}/send-back`, { token: dev.token, body: { note } });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.state).toBe("sent_back");
    expect(await landingState(taskId)).toBe("landed");
    expect((await view(client.token, p.promotion_id)).body).toMatchObject({ state: "sent_back", reasonCode: "sent_back", reason: note });
    expect((await f.svc.ledger(f.o.orgId).getProposal(p.proposal_id!))!.state).toBe("superseded");
    // the task can be promoted again
    const again = await promote(client.token, taskId);
    expect(again.status, JSON.stringify(again.body)).toBe(202);
  });

  it("a task that touches a file an earlier landing touched is promoted with it", async () => {
    const { f, client, promote, untilState, landTask, landingState } = await flowFixture();
    const a = await landTask(client.token, "A", { "public/index.html": "<h1>A</h1>\n" });
    const other = await landTask(client.token, "Other", { "public/about.html": "<p>About</p>\n" });
    const b = await landTask(client.token, "B", { "public/index.html": "<h1>B</h1>\n" });
    const r = await promote(client.token, b);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.landings.map((l: { taskId: string }) => l.taskId)).toEqual([a, b]);
    expect(await landingState(a)).toBe("promoting");
    expect(await landingState(other)).toBe("landed");
    const p = await untilState(r.body.promotionId, "cleared", "pending_approval", "failed");
    expect(p.state).toBe("cleared");
    expect(JSON.parse(p.proposal_hashes_json)).toHaveLength(2);
  });

  it("a task already being promoted → promotion_in_progress naming its promotion; another task's promotion is accepted (B1)", async () => {
    const { client, promote, landTask } = await flowFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    const ra = await promote(client.token, a);
    expect(ra.status).toBe(202);
    const second = await promote(client.token, b);
    expect(second.status, JSON.stringify(second.body)).toBe(202);
    const again = await promote(client.token, a);
    expect([again.status, again.body.error.code, again.body.error.details?.promotionId]).toEqual([409, "promotion_in_progress", ra.body.promotionId]);
  });

  it("a client cannot promote another client's task; a viewer cannot promote", async () => {
    const { f, client, promote, view, landTask } = await flowFixture();
    const taskId = await landTask(client.token, "Mine", { "public/a.html": "a\n" });
    const other = await f.clientWithAccess();
    expect((await promote(other.token, taskId)).status).toBe(404);
    const viewer = await f.memberWithAccess("viewer");
    expect((await promote(viewer.token, taskId)).status).toBe(404);
    const r = await promote(client.token, taskId);
    expect(r.status).toBe(202);
    // another client reads the promotion (it is in their project) but not its reasons
    const v = await view(other.token, r.body.promotionId);
    expect(v.status).toBe(200);
    expect(v.body.reason).toBeNull();
  });

  it("main moved after a developer cleared it: rebuilt on the new main with a new proposal, the clearance carried", async () => {
    const { f, client, promote, untilState, untilRow, landTask, events, clearances, rebuild } = await flowFixture();
    const dev = await f.memberWithAccess("developer");
    const taskId = await landTask(client.token, "API", { "src/contacts.ts": "export const contacts = [];\n" });
    const r = await promote(client.token, taskId);
    const id = r.body.promotionId as string;
    await untilState(id, "pending_approval");
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/approve`, { token: dev.token, body: {} })).status).toBe(200);
    const first = await untilState(id, "cleared");
    await f.acceptOnMain({ "README.md": "moved\n" });
    await rebuild(id);
    const second = await untilRow(id, (p) => p.state === "cleared" && p.proposal_id !== first.proposal_id);
    expect(second).toMatchObject({ clearance_kind: "developer", cleared_by: dev.userId, clearance_key: first.clearance_key });
    expect((await clearances(second)).map((c) => [c.role, c.approver.id, c.proposalHash])).toEqual([["clearance:developer", dev.userId, second.proposal_hash]]);
    expect(await events("promotion.pending_approval", id)).toBe(1);
    expect((await f.svc.ledger(f.o.orgId).getProposal(first.proposal_id!))!.state).toBe("superseded");
    // the new build contains main's change and the task's
    const receipt = (await f.svc.ledger(f.o.orgId).getIntegrationReceipt(second.proposal_id!))!;
    const files = f.h.artifacts.files.get(receipt.results[0]!.revisionId.split(":").pop()!)!;
    expect(files["README.md"]).toBe("moved\n");
    expect(files["src/contacts.ts"]).toBe("export const contacts = [];\n");
    const proposal = (await f.svc.ledger(f.o.orgId).getProposal(second.proposal_id!))!;
    expect((await acceptInputFor(f.svc, proposal, "k-moved", userRef(dev.userId))).approvals).toHaveLength(1);
  });

  it("a policy edit that does not raise the level keeps a developer clearance across a rebuild", async () => {
    const { f, client, promote, untilState, untilRow, resume, landTask, queuedSteps, putRules, events } = await flowFixture();
    const dev = await f.memberWithAccess("developer");
    const taskId = await landTask(client.token, "API", { "src/contacts.ts": "export const contacts = [];\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    await untilState(id, "pending_approval");
    await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/approve`, { token: dev.token, body: {} });
    const first = await untilState(id, "cleared");
    await putRules([{ paths: ["api/docs/**"], level: "self" }, ...RULES]);
    // a cleared promotion runs its own chain (Task 8): the policy save does not nudge it
    expect(queuedSteps(id)).toBe(0);
    await resume(id);
    const second = await untilRow(id, (p) => p.state === "cleared" && p.proposal_id !== first.proposal_id);
    expect(second.policy_revision).toBeGreaterThan(first.policy_revision!);
    expect(second).toMatchObject({ clearance_kind: "developer", cleared_by: dev.userId });
    expect(await events("promotion.pending_approval", id)).toBe(1);
  });

  it("a policy edit that raises a self-cleared set to developer voids the clearance", async () => {
    const { f, client, promote, untilState, untilRow, resume, landTask, putRules, clearances } = await flowFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    expect(await untilState(id, "cleared", "pending_approval")).toMatchObject({ state: "cleared", clearance_kind: "self" });
    await putRules([{ paths: ["api/public/**"], level: "developer" }]);
    await resume(id);
    const p = await untilState(id, "pending_approval");
    expect(p).toMatchObject({ level: "developer", reason_code: "developer_paths", clearance_kind: null, clearance_key: null, cleared_by: null });
    expect(await clearances(p)).toEqual([]);
  });

  it("send back from cleared voids the clearance: an accept attempt fails", async () => {
    const { f, client, promote, untilState, landTask, landingState } = await flowFixture();
    const dev = await f.memberWithAccess("developer");
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    const p = await untilState(id, "cleared");
    const proposal = (await f.svc.ledger(f.o.orgId).getProposal(p.proposal_id!))!;
    const s = await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/send-back`, { token: dev.token, body: { note: "Not yet, the launch is next week." } });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(await row(f, id)).toMatchObject({ state: "sent_back", clearance_kind: null, cleared_by: null });
    expect(await landingState(taskId)).toBe("landed");
    expect(await currentApprovals(f.svc, f.o.orgId, f.pid, await f.svc.ledger(f.o.orgId).listApprovals(proposal.proposalId), proposal)).toEqual([]);
    const accepted = await f.svc.ledger(f.o.orgId).accept(await acceptInputFor(f.svc, proposal, `${f.o.orgId}:k-sent-back`, userRef(client.userId)));
    expect(accepted.ok).toBe(false);
    // sending back twice is refused
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/send-back`, { token: dev.token, body: { note: "again" } })).status).toBe(409);
  });

  it("promoting landings stay in staging: a new staging build includes them; they cannot be rolled back meanwhile", async () => {
    const { f, client, promote, untilState, landTask, landingState } = await flowFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const r = await promote(client.token, taskId);
    await untilState(r.body.promotionId, "cleared");
    const landingId = r.body.landings[0].landingId as string;
    const buildId = await requestBuild(f.svc, f.o.orgId, f.pid, f.o.userId);
    const b = await f.svc.db.prepare("SELECT landings_json FROM staging_builds WHERE build_id = ?").bind(buildId).first<{ landings_json: string }>();
    expect(JSON.parse(b!.landings_json)).toContain(landingId);
    await f.until(async () => (await f.svc.db.prepare("SELECT state FROM staging_builds WHERE build_id = ?").bind(buildId).first<{ state: string }>())!.state === "live", 20_000);
    expect(await landingState(taskId)).toBe("promoting");
    const rb = await f.h.api("POST", `/api/tasks/${taskId}/rollback`, { token: client.token, body: {} });
    expect(rb.status).toBe(409);
    expect(rb.body.error.code).toBe("promotion_in_progress");
  });

  it("a gate read error is gated once more before asking a developer", async () => {
    const { f, client, promote, untilState, landTask, events } = await flowFixture([{ paths: ["api/public/**", "api/migrations/**"], level: "self" }]);
    const taskId = await landTask(client.token, "Phone", { "migrations/0002_phone.sql": "ALTER TABLE contacts ADD COLUMN phone TEXT;\n" });
    const read = f.h.artifacts.readFile.bind(f.h.artifacts);
    let failures = 0;
    f.h.artifacts.readFile = async (...args: Parameters<typeof read>) => {
      if (failures === 0) {
        failures++;
        throw new Error("artifacts unavailable");
      }
      return read(...args);
    };
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    const p = await untilState(id, "cleared", "pending_approval", "failed");
    expect(failures).toBe(1);
    expect(p).toMatchObject({ state: "cleared", level: "self", clearance_kind: "self" });
    expect(JSON.parse(p.gate_json!).veto.kind).toBe("additive");
    expect(await events("promotion.pending_approval", id)).toBe(0);
  });

  it("a conflict with production fails the promotion and returns its landings to staging", async () => {
    const { f, runner, client, promote, view, untilState, landTask, landingState } = await flowFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    runner.opts.integrateFailure = { code: "textual_conflict", detail: "conflict in api: public/index.html", conflictPaths: ["public/index.html"] };
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    const p = await untilState(id, "failed", "cleared", "pending_approval");
    expect(p).toMatchObject({ state: "failed", reason_code: "textual_conflict", reason: "Conflicts with production." });
    expect(p.detail).toContain("public/index.html");
    expect(await landingState(taskId)).toBe("landed");
    const v = await view(client.token, id);
    expect(v.body.reason).toBe("Conflicts with production.");
    expect(JSON.stringify(v.body)).not.toContain("public/index.html");
    expect((await view(f.o.token, id)).body.detail).toContain("public/index.html");
  });
});

describe("promotions: bounds, repairs and races (review round 1)", { timeout: 120_000 }, () => {
  const hours = (h: number) => () => new Date(Date.now() + h * 3600_000);

  it("an integrate job that never answers is reissued after it expires, and the 6 h deadline fails the promotion", async () => {
    const { f, runner, client, promote, row, untilState, landTask, landingState } = await flowFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    runner.opts.hold = ["integrate"];
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    await untilState(id, "building");
    f.h.deps.now = hours(2); // the job expired: a fresh one
    await f.until(async () => (await row(id)).job_attempts >= 1, 20_000);
    expect((await row(id)).state).toBe("building");
    f.h.deps.now = hours(7); // past the deadline, counted from when the promotion was requested
    const p = await untilState(id, "failed");
    expect(p).toMatchObject({ reason_code: "promotion_timed_out", reason: "The promotion stopped before it finished. Try promoting again." });
    expect(await landingState(taskId)).toBe("landed");
  });

  it("an integrate job that keeps failing transiently is retried at most 10 times", async () => {
    const { f, runner, client, promote, untilState, landTask } = await flowFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    runner.opts.fail = { integrate: { code: "provider_unavailable", detail: "artifacts is down (test)" } };
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    const p = await untilState(id, "failed", "cleared");
    expect(p).toMatchObject({ state: "failed", reason_code: "promotion_job_limit", job_attempts: 10 });
    expect(runner.handled.filter((j) => j.job.kind === "integrate")).toHaveLength(11);
  });

  it("main moving on every build fails the promotion after 10 rebuilds", async () => {
    const { f, client, promote, row, untilState, landTask } = await flowFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    await untilState(id, "cleared");
    await f.svc.db.prepare("UPDATE promotions SET rebuilds = 10 WHERE promotion_id = ?").bind(id).run();
    expect(await rebuildPromotion(f.svc, id, ["cleared"], { stale: true })).toBe(true);
    expect(await row(id)).toMatchObject({ state: "failed", reason_code: "promotion_rebuild_limit", reason: "Production kept changing; promote again." });
  });

  it("a promotion whose step was lost is nudged by the next request for its landing and fails at its deadline", async () => {
    const { f, client, promote, untilState, landTask, landingState } = await flowFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    // a request that died after its batch (row, landing and claim written, no step enqueued)
    const landing = (await f.svc.db.prepare("SELECT landing_id FROM staging_landings WHERE task_id = ?").bind(a).first<{ landing_id: string }>())!.landing_id;
    const since = new Date(Date.now() - 7 * 3600_000).toISOString();
    await f.svc.db.batch([
      f.svc.db.prepare("INSERT INTO promotions (promotion_id, org_id, project_id, target_landing_id, landings_json, state, requested_by, created_at, updated_at, machine_since) VALUES ('prm-lost', ?, ?, ?, ?, 'requested', ?, ?, ?, ?)").bind(f.o.orgId, f.pid, landing, JSON.stringify([landing]), client.userId, since, since, since),
      f.svc.db.prepare("UPDATE staging_landings SET state = 'promoting' WHERE landing_id = ?").bind(landing),
      f.svc.db.prepare("INSERT INTO promotion_landings (promotion_id, landing_id, org_id, project_id, active, created_at) VALUES ('prm-lost', ?, ?, ?, 1, ?)").bind(landing, f.o.orgId, f.pid, since),
    ]);
    const r = await promote(client.token, a);
    expect([r.status, r.body.error.code, r.body.error.details?.promotionId]).toEqual([409, "promotion_in_progress", "prm-lost"]);
    expect(await untilState("prm-lost", "failed")).toMatchObject({ reason_code: "promotion_timed_out" });
    expect(await landingState(a)).toBe("landed");
    expect(await f.svc.db.prepare("SELECT 1 FROM promotion_landings WHERE promotion_id = 'prm-lost' AND active = 1").first()).toBeNull();
    expect((await promote(client.token, a)).status).toBe(202);
  });

  it("refused requests do not multiply the promotion's step chain (one heartbeat-guarded chain)", async () => {
    const { f, runner, client, promote, untilState, landTask, queuedSteps } = await flowFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    runner.opts.hold = ["integrate"];
    const id = (await promote(client.token, a)).body.promotionId as string;
    await untilState(id, "building");
    for (let i = 0; i < 20; i++) expect((await promote(client.token, a)).body.error.code).toBe("promotion_in_progress");
    expect(queuedSteps(id)).toBeLessThanOrEqual(2);
    // a duplicate step that finds the chain running ends instead of waiting
    await enqueueStep(f.svc, { type: "promotion.advance", orgId: f.o.orgId, promotionId: id });
    await f.h.drainSteps(3);
    expect(queuedSteps(id)).toBeLessThanOrEqual(2);
    expect((await getPromotion(f.svc, id))!.chain_at).not.toBeNull();
  });

  it("GC gives a step to an in-flight promotion whose chain went silent", async () => {
    const { f, runner, client, promote, untilState, landTask, queuedSteps, hold } = await flowFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    runner.opts.hold = ["integrate"];
    const id = (await promote(client.token, a)).body.promotionId as string;
    await untilState(id, "building");
    hold(id); // the chain is lost
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await f.svc.db.prepare("UPDATE promotions SET chain_at = ?, updated_at = ? WHERE promotion_id = ?").bind(old, old, id).run();
    expect(queuedSteps(id)).toBe(0);
    await runGc(f.svc, { orgs: [f.o.orgId] });
    expect(queuedSteps(id)).toBe(1);
  });

  it("a chain that ends clears its heartbeat, so an approval starts the next one", async () => {
    const { f, client, promote, untilState, landTask, queuedSteps } = await flowFixture();
    const dev = await f.memberWithAccess("developer");
    const taskId = await landTask(client.token, "API", { "src/contacts.ts": "export const contacts = [];\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    await untilState(id, "pending_approval");
    await f.h.drainSteps();
    expect((await getPromotion(f.svc, id))!.chain_at).toBeNull();
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/approve`, { token: dev.token, body: {} })).status).toBe(200);
    expect(queuedSteps(id)).toBe(1);
  });

  it("a promoting landing no promotion lists is repaired by a request and by GC", async () => {
    const { f, client, promote, landTask, landingState } = await flowFixture();
    const a = await landTask(client.token, "A", { "public/a.html": "a\n" });
    const b = await landTask(client.token, "B", { "public/b.html": "b\n" });
    await f.svc.db.prepare("UPDATE staging_landings SET state = 'promoting' WHERE org_id = ? AND task_id IN (?, ?)").bind(f.o.orgId, a, b).run();
    await runGc(f.svc, { orgs: [f.o.orgId] });
    expect(await landingState(b)).toBe("landed");
    await f.svc.db.prepare("UPDATE staging_landings SET state = 'promoting' WHERE org_id = ? AND task_id = ?").bind(f.o.orgId, a).run();
    const r = await promote(client.token, a);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
  });

  it("approve and send back are bound to the proposal hash they read: a rebuild in between is refused", async () => {
    const { f, client, promote, row, untilState, landTask } = await flowFixture();
    const dev = await f.memberWithAccess("developer");
    const taskId = await landTask(client.token, "API", { "src/contacts.ts": "export const contacts = [];\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    const read = await untilState(id, "pending_approval");
    // the row moved on to another proposal hash after the developer read it
    await f.svc.db.prepare("UPDATE promotions SET proposal_hash = ? WHERE promotion_id = ?").bind(`${read.proposal_hash!.slice(0, -4)}beef`, id).run();
    await expect(approvePromotion(f.svc, read, { userId: dev.userId, role: "developer" })).rejects.toMatchObject({ status: 409, code: "promotion_changed" });
    await expect(sendBackPromotion(f.svc, read, { userId: dev.userId, role: "developer" }, "no")).rejects.toMatchObject({ status: 409, code: "promotion_changed" });
    expect(await row(id)).toMatchObject({ state: "pending_approval", clearance_kind: null });
  });

  it("a promoting landing that staging fails supersedes its promotion; the other landings return to staging", async () => {
    const { f, client, promote, row, untilState, landTask, landingState, candidateOf, clearances } = await flowFixture();
    const a = await landTask(client.token, "A", { "public/index.html": "<h1>A</h1>\n" });
    const b = await landTask(client.token, "B", { "public/index.html": "<h1>B</h1>\n" });
    const id = (await promote(client.token, b)).body.promotionId as string;
    const p = await untilState(id, "cleared");
    const ledger = f.svc.ledger(f.o.orgId);
    const rec = (await ledger.getCandidate(await candidateOf(a)))!;
    await ledger.putCandidate(f.o.orgId, { ...rec, state: "superseded", updatedAt: f.svc.nowIso() });
    await requestBuild(f.svc, f.o.orgId, f.pid, f.o.userId);
    await f.until(async () => (await row(id)).state === "superseded", 20_000);
    expect(await row(id)).toMatchObject({ reason_code: "landing_failed", clearance_kind: null, cleared_by: null });
    expect(await landingState(a)).toBe("failed");
    expect(await landingState(b)).toBe("landed");
    expect((await ledger.getProposal(p.proposal_id!))!.state).toBe("superseded");
    const proposal = (await ledger.getProposal(p.proposal_id!))!;
    expect(await currentApprovals(f.svc, f.o.orgId, f.pid, await ledger.listApprovals(proposal.proposalId), proposal)).toEqual([]);
    expect(await clearances(p)).toHaveLength(1); // written, no longer honoured
  });

  it("approval roles: a developer outside approvalRoles cannot approve; an owner outside them is not auto-cleared", async () => {
    const { f, client, promote, untilState, landTask, putRules } = await flowFixture();
    const dev = await f.memberWithAccess("developer");
    await putRules(RULES, { approvalRoles: ["owner"] });
    const taskId = await landTask(client.token, "API", { "src/contacts.ts": "export const contacts = [];\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    await untilState(id, "pending_approval");
    const refused = await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/approve`, { token: dev.token, body: {} });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("approval_role_not_allowed");
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/approve`, { token: f.o.token, body: {} })).status).toBe(200);
    await untilState(id, "cleared");

    const g = await flowFixture();
    await g.putRules(RULES, { approvalRoles: ["developer"] });
    const own = await g.landTask(g.f.o.token, "Owner API", { "src/owner.ts": "export const owner = 1;\n" });
    const oid = (await g.promote(g.f.o.token, own)).body.promotionId as string;
    expect(await g.untilState(oid, "pending_approval", "cleared")).toMatchObject({ state: "pending_approval" });
  });

  it("a carried clearance needs a clearer who still qualifies", async () => {
    const { f, client, promote, row, untilState, landTask, rebuild } = await flowFixture();
    const dev = await f.memberWithAccess("developer");
    const taskId = await landTask(client.token, "API", { "src/contacts.ts": "export const contacts = [];\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    await untilState(id, "pending_approval");
    await f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/approve`, { token: dev.token, body: {} });
    const first = await untilState(id, "cleared");
    await f.svc.db.prepare("UPDATE memberships SET role = 'client' WHERE org_id = ? AND user_id = ?").bind(f.o.orgId, dev.userId).run();
    await f.acceptOnMain({ "README.md": "moved\n" });
    await rebuild(id);
    await untilState(id, "pending_approval");
    expect((await row(id)).proposal_id).not.toBe(first.proposal_id);
    expect(await row(id)).toMatchObject({ clearance_kind: null, cleared_by: null });
  });

  it("an earlier overlapping landing that is not live yet blocks the request", async () => {
    const { f, client, promote, landTask } = await flowFixture();
    const a = await landTask(client.token, "A", { "public/index.html": "<h1>A</h1>\n" });
    const b = await landTask(client.token, "B", { "public/index.html": "<h1>B</h1>\n" });
    await f.svc.db.prepare("UPDATE staging_landings SET state = 'checking' WHERE org_id = ? AND task_id = ?").bind(f.o.orgId, a).run();
    const r = await promote(client.token, b);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("promotion_dependency_busy");
  });

  it("another org cannot read a promotion", async () => {
    const { f, client, promote, view, landTask } = await flowFixture();
    const taskId = await landTask(client.token, "Copy", { "public/a.html": "a\n" });
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    const other = await ownerWithOrg(f.h, "Other Org");
    expect((await f.h.api("GET", `/api/orgs/${other.orgId}/promotions/${id}`, { token: other.token })).status).toBe(404);
    expect((await f.h.api("GET", `/api/orgs/${f.o.orgId}/promotions/${id}`, { token: other.token })).status).toBe(404);
    expect((await view(f.o.token, id)).status).toBe(200);
  });
});

describe("promotions: set guard and policy (review round 2)", { timeout: 120_000 }, () => {
  it("a landing that left the set behind the staging hook's back supersedes the promotion at the next step", async () => {
    const { f, runner, client, promote, row, untilState, landTask, landingState } = await flowFixture();
    const a = await landTask(client.token, "A", { "public/index.html": "<h1>A</h1>\n" });
    const b = await landTask(client.token, "B", { "public/index.html": "<h1>B</h1>\n" });
    runner.opts.hold = ["integrate"];
    const id = (await promote(client.token, b)).body.promotionId as string;
    await untilState(id, "building");
    await f.svc.db.prepare("UPDATE staging_landings SET state = 'failed' WHERE org_id = ? AND task_id = ?").bind(f.o.orgId, a).run();
    runner.opts.hold = [];
    await runner.runPending();
    const p = await untilState(id, "superseded", "cleared");
    expect(p).toMatchObject({ state: "superseded", reason_code: "landing_failed" });
    expect(await landingState(b)).toBe("landed");
    expect((await f.svc.ledger(f.o.orgId).getProposal(p.proposal_id!))!.state).toBe("superseded");
    expect((await row(id)).clearance_kind).toBeNull();
  });

  it("a policy change no step was nudged for is caught at the gate: rebuilt on the new policy before anyone is asked", async () => {
    const { f, runner, client, promote, untilState, landTask, putRules } = await flowFixture();
    const taskId = await landTask(client.token, "Copy", { "public/index.html": "<h1>Hi</h1>\n" });
    runner.opts.hold = ["integrate"];
    const id = (await promote(client.token, taskId)).body.promotionId as string;
    const building = await untilState(id, "building");
    await putRules([{ paths: ["api/public/**"], level: "developer" }]);
    runner.opts.hold = [];
    await runner.runPending();
    const p = await untilState(id, "pending_approval", "cleared");
    expect(p).toMatchObject({ state: "pending_approval", reason_code: "developer_paths" });
    expect(p.policy_revision).toBeGreaterThan(building.policy_revision!);
    expect(p.proposal_id).not.toBe(building.proposal_id);
  });

  it("in staging mode, approvalRoles must include owner or developer", async () => {
    const { f } = await flowFixture();
    const r = await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy`, { token: f.o.token, body: { release: stagingReleasePolicy(f.o.orgId), staging: stagingWith(RULES), approvalRoles: ["client"] } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_policy");
    const v = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/policy/validate`, { token: f.o.token, body: { release: stagingReleasePolicy(f.o.orgId), staging: stagingWith(RULES), approvalRoles: ["client"] } });
    expect(v.body.issues.map((i: { path: string }) => i.path)).toContain("approvalRoles");
  });
});

const row = async (f: StagingFixture, id: string) => (await getPromotion(f.svc, id))!;
