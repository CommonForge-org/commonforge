/**
 * Shared helpers for the promotion tests (staging phase 2 and 2b): routes, row reads, waiting on a
 * promotion (draining every step, or one round at a time and holding it), landing tasks, and the
 * release fixture (copy clears itself, source and migrations go through the unconfigured classifier).
 */
import { getPromotion, type PromotionRow } from "../src/services/promotions.js";
import { enqueueStep } from "../src/services/steps.js";
import { FakeRunner } from "./fakes/runner.js";
import { STAGING_SECTION, stagingFixture, type StagingFixture } from "./staging-helpers.js";

/** `api/public/**` clears itself; source and migrations go through the (unconfigured) classifier. */
export const RELEASE_RULES = [
  { paths: ["api/public/**"], level: "self" },
  { paths: ["api/src/**"], level: "classify" },
  { paths: ["api/migrations/**"], level: "classify" },
];
export const RELEASE_STAGING = { ...STAGING_SECTION, promotion: { rules: RELEASE_RULES, classifier: { provider: "none", threshold: 0.9 } } };
/** Where a promotion's chain stops by itself. */
export const DONE_STATES = ["live", "release_failed", "failed", "pending_approval", "superseded", "sent_back"];

/** A staging project with {@link RELEASE_STAGING}, a running fake runner, a client with access, and the helpers. */
export async function releaseFixture() {
  const f = await stagingFixture({ staging: RELEASE_STAGING });
  const runner = new FakeRunner(f.h);
  const client = await f.clientWithAccess();
  return { f, runner, client, ...promotionHelpers(f) };
}

export function promotionHelpers(f: StagingFixture) {
  const ledger = f.svc.ledger(f.o.orgId);
  const promote = (token: string, taskId: string) => f.h.api("POST", `/api/tasks/${taskId}/promote`, { token, body: {} });
  const view = (token: string, id: string) => f.h.api("GET", `/api/orgs/${f.o.orgId}/promotions/${id}`, { token });
  const retry = (token: string, id: string) => f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/retry-release`, { token, body: {} });
  const approve = (token: string, id: string) => f.h.api("POST", `/api/orgs/${f.o.orgId}/promotions/${id}/approve`, { token, body: {} });
  const row = async (id: string): Promise<PromotionRow> => (await getPromotion(f.svc, id))!;
  /** drain every step until the promotion is in one of `states` (its chain goes on) */
  async function untilState(id: string, ...states: string[]): Promise<PromotionRow> {
    await f.until(async () => states.includes((await row(id)).state), 30_000);
    return row(id);
  }
  /** drop the promotion's queued `promotion.advance` steps */
  function hold(id: string) {
    const steps = f.h.steps as Array<{ type: string; promotionId?: string }>;
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i]!.type === "promotion.advance" && steps[i]!.promotionId === id) steps.splice(i, 1);
  }
  /**
   * Drain steps one round at a time until `cond` holds for the promotion. A promotion that is
   * `cleared` then is held there: its queued steps are dropped (the accept would come next).
   */
  async function untilRow(id: string, cond: (p: PromotionRow) => boolean, ms = 20_000): Promise<PromotionRow> {
    const end = Date.now() + ms;
    for (;;) {
      const p = await row(id);
      if (cond(p)) {
        if (p.state === "cleared") hold(id);
        return p;
      }
      if (Date.now() > end) throw new Error(`timed out (promotion ${p.state})`);
      await f.h.drainSteps(1);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  /** drain one round at a time until `cond`; the promotion is then held (its queued steps dropped) */
  async function untilHeld(id: string, cond: (p: PromotionRow) => boolean): Promise<PromotionRow> {
    const p = await untilRow(id, cond);
    hold(id);
    return p;
  }
  /** a held promotion goes on (one step, as its chain would) */
  const resume = (id: string) => enqueueStep(f.svc, { type: "promotion.advance", orgId: f.o.orgId, promotionId: id });
  /** submit a task as `token` and wait until it (and every earlier one) is live on staging */
  async function landTask(token: string, title: string, files: Record<string, string>): Promise<string> {
    const taskId = await f.submitTask(token, title, files);
    await f.untilLanded(taskId);
    return taskId;
  }
  const landing = async (taskId: string) => (await f.svc.db.prepare("SELECT landing_id, proposal_id, state FROM staging_landings WHERE org_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 1").bind(f.o.orgId, taskId).first<{ landing_id: string; proposal_id: string; state: string }>())!;
  const landingState = async (taskId: string) => (await f.svc.db.prepare("SELECT state FROM staging_landings WHERE org_id = ? AND task_id = ? ORDER BY seq DESC LIMIT 1").bind(f.o.orgId, taskId).first<{ state: string }>())?.state;
  const mainFiles = async () => f.h.artifacts.files.get(await f.headSha())!;
  const approvals = async (releaseId: string) => (await f.svc.db.prepare("SELECT role, approver FROM release_publish_approvals WHERE release_id = ? ORDER BY approved_at").bind(releaseId).all<{ role: string; approver: string }>()).results;
  const eventRows = async (action: string, subjectId: string) =>
    (await f.svc.db.prepare("SELECT actor_json, detail_json, client_detail_json FROM events WHERE org_id = ? AND action = ? AND subject_id = ?").bind(f.o.orgId, action, subjectId).all<{ actor_json: string; detail_json: string | null; client_detail_json: string | null }>()).results;
  const events = async (action: string, id: string) => (await f.svc.db.prepare("SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND action = ? AND subject_id = ?").bind(f.o.orgId, action, id).first<{ n: number }>())!.n;
  async function stagingSettled(): Promise<void> {
    await f.until(async () => !(await f.svc.db.prepare("SELECT 1 FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'merging', 'building', 'deploying')").bind(f.o.orgId, f.pid).first()), 20_000);
  }
  const newestBuild = async () => (await f.svc.db.prepare("SELECT landings_json, state FROM staging_builds WHERE org_id = ? AND project_id = ? ORDER BY seq DESC LIMIT 1").bind(f.o.orgId, f.pid).first<{ landings_json: string; state: string }>())!;
  async function acceptedVersionsOf(proposalId: string) {
    return (await ledger.listAcceptedVersions({ after: 0, limit: 500 })).filter((v) => v.proposalId === proposalId);
  }
  /** queued `promotion.advance` steps of a promotion (not delivered yet) */
  const queuedSteps = (id: string) => (f.h.steps as Array<{ type: string; promotionId?: string }>).filter((m) => m.type === "promotion.advance" && m.promotionId === id).length;
  return { ledger, promote, view, retry, approve, row, untilState, untilRow, hold, untilHeld, resume, landTask, landing, landingState, mainFiles, approvals, eventRows, events, stagingSettled, newestBuild, acceptedVersionsOf, queuedSteps };
}
