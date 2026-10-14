/**
 * Tasks board, New task, Promote (staging phase 3, Task 7): the board's mapping is pure and
 * table-tested; the screens are checked by server rendering, with the fixture's staging demo.
 */
import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client.js";
import { FakeApi, FIXTURE_ORG as ORG, FIXTURE_PROJECT as PID, FIXTURE_STAGING_TASKS as T } from "../src/api/fake.js";
import type { LandingState, Mount, PromotionPreview, PromotionState, Role, StagingLanding, TaskSummary } from "../src/api/types.js";
import { boardCards, boardColumn, canPromoteLanding, canRollBackLanding, canWithdrawPromotion, cardState, droppedRevisions, followedOverlay, promotionSettled, stopFollowing, type BoardPlace } from "../src/lib/model.js";
import { errorMessage } from "../src/ui.js";
import { parseRoute, projectHref, promotionHref } from "../src/lib/router.js";
import { checkoutCommand, checkoutDir, NewTaskForm, newTaskInput, newTaskServerError, validateNewTask, EMPTY_TASK, type NewTaskValues } from "../src/screens/NewTaskSheet.js";
import { pendingProductionItems } from "../src/screens/Overview.js";
import { loadLive, type LiveState } from "../src/screens/project-data.js";
import { navItems } from "../src/screens/ProjectShell.js";
import { promoteErrorText, PromoteSheetView } from "../src/screens/PromoteSheet.js";
import { AgentHandoff, handoffTask } from "../src/screens/AgentHandoff.js";
import { boardFromLive, followDelay, mayWithdraw, TasksBoardView, withFollowed, type OpenSheet } from "../src/screens/TasksBoard.js";

function renderToString(el: Parameters<typeof render>[0]): string {
  return render(el).replace(/<!-- -->/g, "");
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const noop = () => {};

function clock(start = Date.parse("2026-10-11T12:00:00.000Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
const STEP = 1000;

async function stagingLive(role: Role, api = new FakeApi({ role, staging: true })): Promise<{ api: FakeApi; live: LiveState }> {
  api.role = role;
  const project = await api.getProject(ORG, PID);
  return { api, live: await loadLive(api, ORG, PID, role, { project }) };
}

/** Promote a demo task and poll until it waits for a person or ends. */
async function promoteAndSettle(api: FakeApi, c: ReturnType<typeof clock>, taskId: string) {
  const r = await api.promoteTask(taskId);
  for (let i = 0; i < 30; i++) {
    const v = await api.getPromotion(ORG, r.promotionId);
    if (promotionSettled(v.state)) return v;
    c.advance(STEP);
  }
  throw new Error("the promotion never settled");
}

function board(role: Role, live: LiveState, mounts: readonly Mount[] = [], extra: { newTaskOpen?: boolean; requested?: ReadonlySet<string>; initialSheet?: OpenSheet | null } = {}) {
  const cards = boardFromLive(live.staging, live.boardTasks, live.promotions, role, null, live.events);
  return renderToString(createElement(TasksBoardView, { cards, role, org: ORG, pid: PID, stagingUrl: "https://staging.example.dev", mounts, now: new Date(), ...extra }));
}

/** The text of one column of a rendered board. */
function column(html: string, id: string): string {
  const start = html.indexOf(`data-testid="board-col-${id}"`);
  const end = html.indexOf("</section>", start);
  return text(html.slice(start, end));
}

// ---------------------------------------------------------------------------------- the mapping

/**
 * The landing × promotion pairs the Worker produces (services/promotions.ts, staging.ts): a request
 * moves the landings `landed` → `promoting` in the same batch; the accept (`finishAccept`) moves them
 * to `promoted` while the promotion goes `releasing`; a failed release keeps them `promoted`
 * (`release_failed`, retried); an ended promotion (`endPromotion`) puts them back to `landed`; a
 * landing staging dropped after the claim can still be promoted (review M5).
 */
type Row = [LandingState, PromotionState | null, BoardPlace, string, "landing" | "promotion" | null];
const REALISTIC: Row[] = [
  ["checking", null, "staging", "Getting ready on staging…", null],
  ["checking", "sent_back", "staging", "Getting ready on staging…", null],
  ["landed", null, "staging", "Live on staging", null],
  ["landed", "failed", "staging", "Couldn't go live", "promotion"],
  ["landed", "sent_back", "staging", "Sent back to staging", "promotion"],
  ["landed", "superseded", "staging", "Live on staging", null],
  ["landed", "withdrawn", "staging", "Live on staging · promotion withdrawn", null],
  ["promoting", "requested", "staging", "Going to production…", "promotion"],
  ["promoting", "building", "staging", "Going to production…", "promotion"],
  ["promoting", "gating", "staging", "Going to production…", "promotion"],
  ["promoting", "pending_approval", "waiting", "Waiting for a developer's approval", "promotion"],
  ["promoting", "cleared", "staging", "Going to production…", "promotion"],
  ["promoting", "accepting", "staging", "Going to production…", "promotion"],
  // the accept moved the landings on; production is not live yet
  ["promoted", "releasing", "staging", "Going to production…", "promotion"],
  ["promoted", "release_failed", "staging", "Couldn't go live", "promotion"],
  ["promoted", "live", "live", "Live", null],
  ["promoted", null, "live", "Live", null],
  ["failed", null, "staging", "Couldn't land", "landing"],
  ["failed", "accepting", "staging", "Couldn't land", "landing"],
  ["rolling_back", null, "staging", "Rolling back…", null],
  ["rolled_back", null, "rolled_back", "Rolled back", null],
  ["rolled_back", "withdrawn", "rolled_back", "Rolled back", null],
];

describe("boardColumn and cardState", () => {
  it("places and words every landing × promotion pair the Worker produces", () => {
    const going = ["requested", "building", "gating", "cleared", "accepting", "releasing"];
    for (const [l, p, place, line, reasonFrom] of REALISTIC) {
      const landing = { state: l, reason: "landing reason" };
      const promotion = p ? { state: p, reason: "promotion reason" } : null;
      const s = cardState({ state: "submitted" }, landing, promotion);
      const reason = reasonFrom === "landing" ? "landing reason" : reasonFrom === "promotion" ? "promotion reason" : null;
      expect([l, p, boardColumn({ state: "submitted" }, landing, promotion), s.line, s.reason]).toEqual([l, p, place, line, reason]);
      expect([l, p, s.heading]).toEqual([l, p, p === "pending_approval" ? "Production update pending approval" : null]);
      expect([l, p, s.going]).toEqual([l, p, (l === "promoting" || l === "promoted") && !!p && going.includes(p)]);
    }
  });

  it("a promoted landing is Live only once its promotion is (or without one)", () => {
    for (const p of ["accepting", "releasing", "release_failed"] as const) expect(boardColumn({ state: "submitted" }, { state: "promoted" }, { state: p })).toBe("staging");
    expect(boardColumn({ state: "submitted" }, { state: "promoted" }, { state: "live" })).toBe("live");
    expect(boardColumn({ state: "submitted" }, { state: "promoted" }, null)).toBe("live");
    expect(cardState({ state: "submitted" }, { state: "promoted" }, { state: "release_failed", reason: "The production update did not go live." })).toMatchObject({ line: "Couldn't go live", tone: "bad", reason: "The production update did not go live." });
  });

  it("tasks without a landing are Working (a canceled one is off the board)", () => {
    for (const [state, line] of [
      ["provisioning", "Getting the workspace ready…"],
      ["ready", "Ready for your agent"],
      ["running", "The agent is working"],
      ["submitted", "Going to staging…"],
      ["failed", "The task stopped before it finished"],
    ] as const) {
      expect(boardColumn({ state }, null, null)).toBe("working");
      expect(cardState({ state }, null, null).line).toBe(line);
    }
    expect(boardColumn({ state: "canceled" }, null, null)).toBeNull();
    expect(boardColumn(null, null, null)).toBeNull();
  });

  it("Promote, Roll back and Withdraw only when the states allow them", () => {
    expect(canPromoteLanding({ state: "landed" }, null)).toBe(true);
    for (const p of ["sent_back", "withdrawn", "superseded", "failed"] as const) expect(canPromoteLanding({ state: "landed" }, { state: p })).toBe(true);
    for (const p of ["requested", "building", "gating", "pending_approval", "cleared", "accepting", "releasing", "release_failed"] as const) expect(canPromoteLanding({ state: "landed" }, { state: p })).toBe(false);
    for (const l of ["checking", "failed", "promoting", "promoted", "rolled_back", "rolling_back"] as const) expect(canPromoteLanding({ state: l }, null)).toBe(false);
    expect(canRollBackLanding({ state: "checking" }, null)).toBe(true);
    expect(canRollBackLanding({ state: "landed" }, { state: "withdrawn" })).toBe(true);
    expect(canRollBackLanding({ state: "landed" }, { state: "pending_approval" })).toBe(false);
    expect(canRollBackLanding({ state: "promoting" }, null)).toBe(false);
    // Worker BEFORE_ACCEPT
    for (const p of ["requested", "building", "gating", "pending_approval", "cleared"] as const) expect(canWithdrawPromotion({ state: p })).toBe(true);
    for (const p of ["accepting", "releasing", "release_failed", "live", "failed", "sent_back", "superseded", "withdrawn"] as const) expect(canWithdrawPromotion({ state: p })).toBe(false);
  });

  it("Withdraw: developers on every promotion before the accept, clients only on the ones they requested", () => {
    const p = { promotionId: "prm-1", state: "building" as const };
    expect(mayWithdraw(p, "developer", new Set(), null)).toBe(true);
    expect(mayWithdraw(p, "owner", new Set(), null)).toBe(true);
    expect(mayWithdraw(p, "client", new Set(), "u-client")).toBe(false);
    expect(mayWithdraw(p, "client", new Set(["prm-1"]), "u-client")).toBe(true);
    expect(mayWithdraw({ ...p, requestedBy: "u-client" }, "client", new Set(), "u-client")).toBe(true);
    expect(mayWithdraw({ ...p, requestedBy: "u-other" }, "client", new Set(), "u-client")).toBe(false);
    expect(mayWithdraw(p, "viewer", new Set(["prm-1"]), "u-v")).toBe(false);
    expect(mayWithdraw({ ...p, state: "accepting" }, "developer", new Set(), null)).toBe(false);
    // a refusal anyway (another tab, a stale page): in plain words
    expect(errorMessage(new ApiError(403, "not_promotion_requester", "only the client who requested this promotion, an owner or a developer can withdraw it"))).toBe("Only the person who asked for this production update can withdraw it.");
    expect(errorMessage(new ApiError(409, "resource_not_ready", "mount api is provisioning"))).toBe("A folder of this project isn't ready yet. Try again in a few minutes.");
  });

  it("one card per landing, revisions folded in through parts, newest landing of a task wins, tasks without one in Working", () => {
    const task = (taskId: string, state: TaskSummary["state"], createdAt: string): TaskSummary => ({ taskId, title: `Task ${taskId}`, state, changeId: `chg-${taskId}`, createdAt });
    const landing = (landingId: string, taskId: string, state: LandingState, createdAt: string, over: Partial<StagingLanding> = {}): StagingLanding => ({ landingId, taskId, title: `Landing ${taskId}`, state, reasonCode: null, reason: null, promotion: null, createdBy: "u-client", createdAt, ...over });
    const cards = boardCards(
      [task("t1", "submitted", "2026-10-11T10:00:00Z"), task("t1r", "submitted", "2026-10-11T10:30:00Z"), task("t2", "running", "2026-10-11T11:00:00Z"), task("t3", "submitted", "2026-10-11T09:00:00Z")],
      [
        landing("l1", "t1", "landed", "2026-10-11T10:10:00Z", { parts: [{ part: 1, taskId: "t1" }, { part: 2, taskId: "t1r" }], promotion: { promotionId: "prm-1", state: "pending_approval" } }),
        landing("l3b", "t3", "landed", "2026-10-11T09:30:00Z"),
        landing("l3a", "t3", "rolled_back", "2026-10-11T09:10:00Z"),
        landing("l4", "t4", "landed", "2026-10-11T08:00:00Z"),
      ],
      [{ promotionId: "prm-1", state: "pending_approval", landings: [], level: "developer", reasonCode: "migration_destructive", reason: "Changes the database structure in a way that needs a developer.", waitingForProduction: false, mode: "closure", goingWithout: [], needs: [] }],
      new Set(["t1", "t1r", "t2", "t3"]),
    );
    expect(cards.map((c) => [c.taskId, c.place, c.own])).toEqual([
      ["t2", "working", true],
      ["t1", "waiting", true],
      ["t3", "staging", true],
      ["t4", "staging", false],
    ]);
    expect(cards[1]!.state.reason).toBe("Changes the database structure in a way that needs a developer.");
    expect(cards[3]!.title).toBe("Landing t4");
  });

  it("a revision staging dropped is not a Working card: a muted line on its landing's card", () => {
    const task = (taskId: string, state: TaskSummary["state"], createdAt: string): TaskSummary => ({ taskId, title: `Task ${taskId}`, state, changeId: `chg-${taskId}`, createdAt });
    const l1: StagingLanding = { landingId: "l1", taskId: "t1", title: "Task t1", state: "landed", reasonCode: null, reason: null, promotion: null, parts: [{ part: 1, taskId: "t1" }], createdBy: "u-client", createdAt: "2026-10-11T10:10:00Z" };
    const tasks = [task("t1", "submitted", "2026-10-11T10:00:00Z"), task("t1r", "submitted", "2026-10-11T10:30:00Z")];
    // before it joins the landing (its submit is on the way): Working, as any submitted task
    expect(boardCards(tasks, [l1], [], "all").map((c) => [c.taskId, c.place])).toEqual([
      ["t1r", "working"],
      ["t1", "staging"],
    ]);
    const events = [{ action: "staging.revision_dropped", subject: { kind: "task", id: "t1r" }, detail: { landingId: "l1", code: "build_failed" } }];
    const dropped = droppedRevisions(events);
    expect([...dropped]).toEqual([["t1r", "l1"]]);
    const cards = boardCards(tasks, [l1], [], "all", dropped);
    expect(cards.map((c) => [c.taskId, c.place])).toEqual([["t1", "staging"]]);
    expect(cards[0]!.droppedRevisions).toEqual([{ taskId: "t1r", title: "Task t1r" }]);
    const html = text(renderToString(createElement(TasksBoardView, { cards, role: "client", org: ORG, pid: PID, stagingUrl: null, mounts: [] })));
    expect(html).toContain("'Task t1r' couldn't be added to staging.");
    expect(column(renderToString(createElement(TasksBoardView, { cards, role: "client", org: ORG, pid: PID, stagingUrl: null, mounts: [] })), "working")).toContain("Nothing is being worked on.");
    // back in the landing's parts (a later land took it): shown with the landing as usual
    const again = boardCards(tasks, [{ ...l1, parts: [{ part: 1, taskId: "t1" }, { part: 2, taskId: "t1r" }] }], [], "all", dropped);
    expect(again.map((c) => [c.taskId, c.droppedRevisions.length])).toEqual([["t1", 0]]);
  });

  it("follows a requested promotion only until the project poll carries it", () => {
    const v = (state: PromotionState, waitingForProduction = false) => ({ state, waitingForProduction });
    expect(stopFollowing(v("building"), null)).toBe(false);
    expect(stopFollowing(v("building"), { state: "requested" })).toBe(false);
    expect(stopFollowing(v("building"), { state: "building" })).toBe(true);
    expect(stopFollowing(v("pending_approval"), null)).toBe(true);
    expect(stopFollowing(v("live"), null)).toBe(true);
    expect(stopFollowing(v("cleared"), null)).toBe(false);
    expect(stopFollowing(v("cleared", true), null)).toBe(true);
    expect(stopFollowing(v("releasing"), null)).toBe(true);
    expect(followDelay(0)).toBe(3000);
    expect(followDelay(1)).toBe(6000);
    expect(followDelay(9)).toBe(24000);
  });

  it("approve after pending: once following stopped, the polled row wins over the followed copy", () => {
    const l: StagingLanding = { landingId: "l1", taskId: "t1", title: "Rename", state: "promoting", reasonCode: null, reason: null, promotion: null, createdBy: "u", createdAt: "2026-10-11T10:00:00Z" };
    const base = { promotionId: "prm-9", landings: [{ landingId: "l1", taskId: "t1", title: "Rename", state: "promoting" as const }], level: null, reasonCode: null, reason: null, waitingForProduction: false, mode: "closure" as const, goingWithout: [], needs: [] };
    const pending = { ...base, state: "pending_approval" as const, level: "developer" as const };
    const staging = { enabled: true as const, state: "active" as const, url: "https://staging.example.dev", current: null, building: false, landings: [l] } as unknown as Parameters<typeof boardFromLive>[0];
    const tasks: TaskSummary[] = [{ taskId: "t1", title: "Rename", state: "submitted", changeId: "c", createdAt: "2026-10-11T09:00:00Z" }];
    // following: the copy is newer than the poll (which does not name it yet)
    expect(followedOverlay(pending, { following: true, polled: false, pollAt: 5, stoppedAt: null })).toBe(pending);
    // stopped at pending_approval, the poll not caught up yet: the copy still stands in
    expect(followedOverlay(pending, { following: false, polled: false, pollAt: 5, stoppedAt: 10 })).toBe(pending);
    // a developer approves; the poll names it cleared: the polled row wins, the stale copy is dropped
    expect(followedOverlay(pending, { following: false, polled: true, pollAt: 20, stoppedAt: 10 })).toBeNull();
    const cleared = [{ ...pending, state: "cleared" as const }];
    const shown = boardFromLive({ ...staging, landings: [{ ...l, promotion: { promotionId: "prm-9", state: "cleared" } }] } as typeof staging, tasks, cleared, "client", followedOverlay(pending, { following: false, polled: true, pollAt: 20, stoppedAt: 10 }));
    expect(shown.map((c) => [c.place, c.state.line])).toEqual([["staging", "Going to production…"]]);
    // a poll read after the stop that does not name it (a client cannot list it): the copy goes too
    expect(followedOverlay(pending, { following: false, polled: false, pollAt: 11, stoppedAt: 10 })).toBeNull();
  });

  it("a followed promotion stands in for the staging view's until the poll names it", () => {
    const l: StagingLanding = { landingId: "l1", taskId: "t1", title: "x", state: "promoting", reasonCode: null, reason: null, promotion: null, createdBy: "u", createdAt: "2026-10-11T10:00:00Z" };
    const followed = { promotionId: "prm-9", state: "building" as const, landings: [{ landingId: "l1", taskId: "t1", title: "x", state: "promoting" as const }], level: null, reasonCode: null, reason: null, waitingForProduction: false, mode: "closure" as const, goingWithout: [], needs: [] };
    expect(withFollowed([l], followed)[0]!.promotion).toEqual({ promotionId: "prm-9", state: "building" });
    expect(withFollowed([{ ...l, promotion: { promotionId: "prm-8", state: "withdrawn" } }], followed)[0]!.promotion).toEqual({ promotionId: "prm-8", state: "withdrawn" });
  });
});

// ------------------------------------------------------------------------------------- routing

describe("Tasks routes", () => {
  it("parses the Tasks tab and the promotion review route", () => {
    expect(parseRoute("/o/o-1/p/p-1/tasks", "")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "tasks" });
    expect(projectHref("o-1", "p-1", "tasks")).toBe("/o/o-1/p/p-1/tasks");
    expect(promotionHref("o-1", "p-1", "prm-1")).toBe("/o/o-1/p/p-1/promotions/prm-1");
    expect(parseRoute("/o/o-1/p/p-1/promotions/prm-1", "")).toEqual({ name: "promotion", org: "o-1", pid: "p-1", promotionId: "prm-1" });
  });

  it("the Tasks nav item only in staging mode", () => {
    expect(navItems(ORG, PID, 0).map((i) => i.id)).not.toContain("tasks");
    expect(navItems(ORG, PID, 0, false, true).map((i) => i.id)).toEqual(["overview", "tasks", "files", "changes", "versions", "activity"]);
  });
});

// ---------------------------------------------------------------------------------- the board

describe("Tasks board", () => {
  it("loads the board's tasks and promotions with the poll in staging mode (never for viewers or without staging)", async () => {
    const { live } = await stagingLive("client");
    expect(live.boardTasks?.map((t) => t.taskId)).toEqual([T.working, T.rename, T.phone, T.copy]);
    expect(live.promotions).toEqual([]);
    const viewer = await stagingLive("viewer");
    expect(viewer.live.boardTasks).toBeUndefined();
    expect(viewer.live.promotions).toBeUndefined();
    expect(viewer.api.calls.some((c) => c.method === "listPromotions")).toBe(false);
    const off = new FakeApi({ role: "client" });
    const offLive = await loadLive(off, ORG, PID, "client");
    expect(offLive.boardTasks).toBeUndefined();
    expect(off.calls.some((c) => c.method === "listPromotions")).toBe(false);
  });

  it("renders the four columns with the demo for a client", async () => {
    const { live, api } = await stagingLive("client");
    const project = await api.getProject(ORG, PID);
    const html = board("client", live, project.mounts);
    for (const t of ["Working", "In staging", "Waiting for approval", "Live"]) expect(html).toContain(`>${t} <`);
    expect(column(html, "working")).toContain("Show opening hours on the contact page");
    expect(column(html, "working")).toContain("The agent is working");
    const staging = column(html, "staging");
    for (const t of ["Update the home page copy, banner and footer", "Add a phone field to the contact form", "Rename the contact name column"]) expect(staging).toContain(t);
    expect(staging).toContain("Live on staging");
    expect((html.match(/>Promote</g) ?? []).length).toBe(3);
    expect((html.match(/>Roll back</g) ?? []).length).toBe(3);
    expect(html).toContain('href="https://staging.example.dev"');
    expect(html).toContain("Open in staging");
    expect(column(html, "waiting")).toContain("Nothing is waiting for approval.");
    expect(html).toContain("New task");
    expect(html).not.toContain(">Review<");
  });

  it("hides Promote and Roll back on other clients' tasks", async () => {
    const { live } = await stagingLive("client");
    const others = { ...live, boardTasks: live.boardTasks!.filter((t) => t.taskId !== T.copy) };
    const cards = boardFromLive(others.staging, others.boardTasks, others.promotions, "client");
    const copy = cards.find((c) => c.taskId === T.copy)!;
    expect(copy.own).toBe(false);
    const html = board("client", others);
    expect((html.match(/>Promote</g) ?? []).length).toBe(2);
    const start = html.indexOf(`data-task="${T.copy}"`);
    const card = html.slice(start, html.indexOf("</article>", start));
    expect(card).toContain("Update the home page copy, banner and footer");
    expect(card).not.toContain(">Promote<");
    expect(card).not.toContain(">Roll back<");
    expect(card).toContain("Open in staging");
  });

  it("viewers see the board without New task or any action but Open in staging", async () => {
    const { live } = await stagingLive("viewer");
    const html = board("viewer", live, [], { newTaskOpen: true });
    expect(html).toContain('data-testid="tasks-board"');
    expect(html).not.toContain("New task");
    expect(html).not.toContain('data-testid="new-task"');
    expect(html).not.toContain(">Promote<");
    expect(html).not.toContain(">Roll back<");
    expect(column(html, "staging")).toContain("Rename the contact name column");
  });

  it("a promotion waiting for a developer: the heading and the reason; developers get Review, clients Withdraw", async () => {
    const c = clock();
    const api = new FakeApi({ role: "client", staging: true, now: c.now, integrationMs: STEP, promotionStepMs: STEP });
    const v = await promoteAndSettle(api, c, T.rename);
    expect(v.state).toBe("pending_approval");
    const { live } = await stagingLive("client", api);
    // requested from this board: the client may withdraw it
    const html = board("client", live, [], { requested: new Set([v.promotionId]) });
    const waiting = column(html, "waiting");
    expect(waiting).toContain("Production update pending approval");
    expect(waiting).toContain("Rename the contact name column");
    expect(waiting).toContain("Changes the database structure in a way that needs a developer.");
    expect(waiting).toContain("Withdraw");
    expect(html).not.toContain(">Review<");
    // not known to be theirs (requested elsewhere, or by a developer): no Withdraw
    expect(column(board("client", live), "waiting")).not.toContain("Withdraw");
    // the Overview's Needs you links the client to the board
    const items = pendingProductionItems(live, "client", ORG, PID);
    expect(items).toEqual([expect.objectContaining({ title: "Rename the contact name column", href: projectHref(ORG, PID, "tasks"), action: "Open Tasks" })]);
    expect(String(items[0]!.detail)).toContain("Production update pending approval. Changes the database structure");
    expect(pendingProductionItems(live, "viewer", ORG, PID)).toEqual([]);

    const dev = await stagingLive("developer", api);
    const devHtml = board("developer", dev.live);
    expect(devHtml).toContain(`href="${promotionHref(ORG, PID, v.promotionId)}"`);
    expect(devHtml).toMatch(/>Review</);
  });

  it("a promoted copy task goes Live", async () => {
    const c = clock();
    const api = new FakeApi({ role: "client", staging: true, now: c.now, integrationMs: STEP, promotionStepMs: STEP });
    expect((await promoteAndSettle(api, c, T.copy)).state).toBe("live");
    const { live } = await stagingLive("client", api);
    const html = board("client", live);
    expect(column(html, "live")).toContain("Update the home page copy, banner and footer");
    expect(column(html, "staging")).not.toContain("Update the home page copy");
  });

  it("promoted with the accept, it stays In staging while production releases, and a failed release says so", async () => {
    const c = clock();
    const api = new FakeApi({ role: "client", staging: true, now: c.now, integrationMs: STEP, promotionStepMs: STEP });
    api.failNextPromotionRelease = true;
    const r = await api.promoteTask(T.copy);
    let releasing = false;
    for (let i = 0; i < 30; i++) {
      const v = await api.getPromotion(ORG, r.promotionId);
      if (v.state === "releasing" && !releasing) {
        releasing = true;
        const { live } = await stagingLive("client", api);
        // the Worker's pair: landing promoted, promotion releasing
        expect(live.staging?.landings.find((l) => l.taskId === T.copy)).toMatchObject({ state: "promoted", promotion: { state: "releasing" } });
        const html = board("client", live);
        expect(column(html, "staging")).toContain("Update the home page copy");
        expect(column(html, "staging")).toContain("Going to production…");
        expect(column(html, "live")).not.toContain("Update the home page copy");
      }
      if (promotionSettled(v.state)) break;
      c.advance(STEP);
    }
    expect(releasing).toBe(true);
    const { live } = await stagingLive("client", api);
    expect(live.staging?.landings.find((l) => l.taskId === T.copy)).toMatchObject({ state: "promoted", promotion: { state: "release_failed" } });
    const html = board("client", live);
    const staging = column(html, "staging");
    expect(staging).toContain("Update the home page copy");
    expect(staging).toContain("Couldn't go live");
    expect(staging).toContain("The production update did not go live. Production still runs the previous version.");
    expect(column(html, "live")).not.toContain("Update the home page copy");
  });

  it("an open sheet the poll made stale says so instead of vanishing", async () => {
    const { live } = await stagingLive("client");
    // Roll back was open on the copy task; the task is now on its way to production (no roll back)
    const moved = { ...live, staging: { ...live.staging!, landings: live.staging!.landings.map((l) => (l.taskId === T.copy ? { ...l, state: "promoting" as const, promotion: { promotionId: "prm-x", state: "building" as const } } : l)) } } as LiveState;
    const html = board("client", moved, [], { initialSheet: { taskId: T.copy, kind: "rollback", submitting: false } });
    const start = html.indexOf(`data-task="${T.copy}"`);
    const card = text(html.slice(start, html.indexOf("</article>", start)));
    expect(card).toContain("This task changed while you were deciding (Going to production), so nothing was sent.");
    expect(card).not.toContain("Roll back '");
    // still allowed: the sheet itself
    const open = text(board("client", live, [], { initialSheet: { taskId: T.copy, kind: "rollback", submitting: false } }));
    expect(open).toContain("Roll back 'Update the home page copy, banner and footer'?");
    expect(open).not.toContain("This task changed");
    // its request on its way: never replaced by the notice
    expect(text(board("client", moved, [], { initialSheet: { taskId: T.copy, kind: "rollback", submitting: true } }))).not.toContain("This task changed");
  });
});

// ------------------------------------------------------------------------------- Promote sheet

describe("Promote sheet", () => {
  const sheet = (preview: PromotionPreview | undefined, previewError: unknown = null, error: unknown = null) => text(renderToString(createElement(PromoteSheetView, { title: "Add a phone field", preview, previewError, busy: false, error, onConfirm: noop, onCancel: noop })));

  it("lists the tasks that go together", () => {
    const html = sheet({ mode: "closure", goingWithout: [], landings: [{ landingId: "l1", taskId: "t1", title: "Rename the contact name column" }, { landingId: "l2", taskId: "t2", title: "Add a phone field" }] });
    expect(html).toContain("These go to production together:");
    expect(html).toContain("Rename the contact name column");
    expect(html).toContain("Add a phone field");
    expect(html).not.toContain("Going without");
  });

  it("alone: the tasks it goes without, with the platform's text", () => {
    const html = sheet({ mode: "alone", landings: [{ landingId: "l2", taskId: "t2", title: "Add a phone field" }], goingWithout: [{ landingId: "l1", taskId: "t1", title: "Copy", text: "Going to production without 'Copy' (still in staging)" }] });
    expect(html).toContain("Goes to production on its own:");
    expect(html).toContain("Going without:");
    expect(html).toContain("Going to production without 'Copy' (still in staging)");
  });

  it("Promote waits for the dry run; refusals in plain words", () => {
    const loading = renderToString(createElement(PromoteSheetView, { title: "x", preview: undefined, previewError: null, busy: false, error: null, onConfirm: noop, onCancel: noop }));
    expect(loading).toMatch(/<button[^>]*disabled=""[^>]*>Promote</);
    expect(text(loading)).toContain("Checking which tasks go with it…");
    expect(sheet(undefined, new ApiError(409, "staging_awaiting_baseline", "Staging starts after the owner's first production publish"))).toContain("Staging starts after the first production publish.");
    expect(promoteErrorText(new ApiError(409, "promotion_dependency_busy", "x", { taskId: "t", title: "Rename" }))).toBe("It has to go with 'Rename', which is not ready yet. Try again when it is.");
    expect(promoteErrorText(new ApiError(409, "promotion_in_progress", "x"))).toBe("This task is already on its way to production.");
    expect(sheet({ mode: "closure", goingWithout: [], landings: [] }, null, new ApiError(409, "not_landed", "x"))).toContain("still getting ready on staging");
  });

  it("the fake's dry run matches the promotion that follows", async () => {
    const api = new FakeApi({ role: "client", staging: true });
    const preview = await api.previewPromotion(T.phone);
    expect(preview.landings.map((l) => l.taskId)).toEqual([T.phone]);
    const r = await api.promoteTask(T.phone);
    expect(r.landings.map((l) => l.taskId)).toEqual([T.phone]);
  });
});

// ------------------------------------------------------------------------------------ New task

describe("New task", () => {
  const form = (mounts: readonly Mount[], values: NewTaskValues = EMPTY_TASK, over: Partial<Parameters<typeof NewTaskForm>[0]> = {}) =>
    renderToString(createElement(NewTaskForm, { mounts, values, errors: {}, formError: null, busy: false, onChange: noop, onSubmit: noop, onCancel: noop, ...over }));

  it("a client chooses no folders: a title and the request only (the owner's access settings decide them)", async () => {
    const api = new FakeApi({ role: "client", staging: true });
    const project = await api.getProject(ORG, PID);
    const html = form(project.mounts);
    expect(html).not.toContain('name="write"');
    expect(html).not.toContain('name="read"');
    expect(text(html)).not.toContain("Choose folders");
    expect(text(html)).toContain("What should the agent do?");
    expect(newTaskInput({ title: "Show hours", request: "Add them", write: [], read: null })).toEqual({ title: "Show hours", request: "Add them" });
    // nothing open to them for changes: said, and the button stays off
    const none = form(project.mounts.map((m) => ({ ...m, canStartTask: false })));
    expect(text(none)).toContain("There is no folder you can start a task in here.");
    expect(none).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("owners and developers may narrow the folders under a collapsed Choose folders", async () => {
    const api = new FakeApi({ role: "developer", staging: true });
    const project = await api.getProject(ORG, PID);
    const startable = project.mounts.filter((m) => m.canStartTask).map((m) => m.mountName);
    expect(startable.length).toBeGreaterThan(0);
    const html = form(project.mounts, EMPTY_TASK, { chooseFolders: true });
    expect(html).toMatch(/<details class="new-task-folders-choice" data-testid="new-task-folders"><summary>Choose folders<\/summary>/);
    expect([...html.matchAll(/name="write" value="([^"]+)"/g)].map((m) => m[1])).toEqual(startable);
    expect(text(html)).toContain("Left as is, the agent may change every folder you can start a task in");
    // the read list appears once a write folder is chosen, every other folder shown by default
    const chosen = form(project.mounts, { ...EMPTY_TASK, write: [startable[0]!] }, { chooseFolders: true });
    const read = [...chosen.matchAll(/<input[^>]*name="read"[^>]*value="([^"]+)"[^>]*>/g)].filter((m) => m[0].includes("checked")).map((m) => m[1]);
    expect(read.sort()).toEqual(project.mounts.map((m) => m.mountName).filter((m) => m !== startable[0]).sort());
  });

  it("refuses an empty title or no folder, in plain words", () => {
    expect(validateNewTask(EMPTY_TASK)).toEqual({ title: "Give the task a title." });
    expect(validateNewTask({ ...EMPTY_TASK, title: "Show hours" })).toEqual({});
    expect(validateNewTask({ ...EMPTY_TASK, title: "   ", write: ["website"] })).toEqual({ title: "Give the task a title." });
    expect(validateNewTask({ ...EMPTY_TASK, title: "x".repeat(201), write: ["website"] }).title).toBe("Keep the title to 200 characters or fewer.");
    expect(validateNewTask({ ...EMPTY_TASK, title: "ok", request: "x".repeat(16_001), write: ["website"] }).request).toBe("Keep the request to 16,000 characters or fewer.");
    expect(validateNewTask({ title: "Show hours", request: "", write: ["website"], read: null })).toEqual({});
    const html = form([{ mountName: "website", resourceId: "r", provider: "artifacts", resourceName: "Website", mode: "must-match-accepted", operations: ["read", "write"], canStartTask: true }], EMPTY_TASK, { errors: { title: "Give the task a title.", write: "There is no folder you can start a task in here. Ask your developer to open one for changes." } });
    expect(html).toContain('aria-invalid="true"');
    expect(text(html)).toContain("Give the task a title.");
    expect(text(html)).toContain("Ask your developer to open one for changes.");
  });

  it("sends readMounts only when changed; server refusals land on their field", () => {
    expect(newTaskInput({ title: " Show hours ", request: "", write: ["website"], read: null })).toEqual({ title: "Show hours", writeMounts: ["website"] });
    expect(newTaskInput({ title: "x", request: "Do it", write: ["website"], read: ["api", "website"] })).toEqual({ title: "x", request: "Do it", writeMounts: ["website"], readMounts: ["api"] });
    expect(newTaskServerError(new ApiError(400, "invalid_request", "title: must be 1 to 200 characters"))).toEqual({ field: "title", text: "Give the task a title of 1 to 200 characters." });
    expect(newTaskServerError(new ApiError(403, "mount_read_only", "mount api is read-only")).field).toBe("write");
    expect(newTaskServerError(new ApiError(404, "not_found", "mount x not found")).field).toBeUndefined();
  });

  it("never sends more than 32 read folders; the default is sent as none", () => {
    const mk = (n: number): Mount[] => Array.from({ length: n }, (_, i) => ({ mountName: `m${i}`, resourceId: `r${i}`, provider: "artifacts", resourceName: `M${i}`, mode: "must-match-accepted", operations: ["read"], canStartTask: i === 0 }));
    const mounts = mk(40);
    const all = mounts.map((m) => m.mountName);
    const v = (read: string[] | null): NewTaskValues => ({ title: "x", request: "", write: ["m0"], read });
    // the default chosen again (39 others, all checked): nothing sent, no error
    expect(validateNewTask(v(all), mounts)).toEqual({});
    expect(newTaskInput(v(all), mounts).readMounts).toBeUndefined();
    expect(newTaskInput(v(all.slice(1)), mounts).readMounts).toBeUndefined();
    // 33 of them: refused before sending, in plain words
    expect(validateNewTask(v(all.slice(1, 34)), mounts)).toEqual({ read: "Choose at most 32 folders to show." });
    // 32: sent
    expect(validateNewTask(v(all.slice(1, 33)), mounts)).toEqual({});
    expect(newTaskInput(v(all.slice(1, 33)), mounts).readMounts).toHaveLength(32);
    expect(newTaskServerError(new ApiError(400, "invalid_request", "readMounts: too many"))).toEqual({ field: "read", text: "Choose at most 32 folders to show." });
    expect(newTaskServerError(new ApiError(409, "resource_not_ready", "mount m0 is provisioning"))).toEqual({ field: "write", text: "One of these folders isn't ready yet. Try again in a few minutes." });
    const html = text(form(mounts, v(all.slice(1, 34)), { errors: { read: "Choose at most 32 folders to show." }, chooseFolders: true }));
    expect(html).toContain("Choose at most 32 folders to show.");
  });

  it("keeps a chosen read list consistent when a write folder is unchecked or checked", () => {
    const mounts: Mount[] = ["website", "api", "docs"].map((n) => ({ mountName: n, resourceId: `r-${n}`, provider: "artifacts" as const, resourceName: n, mode: "must-match-accepted" as const, operations: ["read", "write"] as Mount["operations"], canStartTask: true }));
    let got: NewTaskValues | null = null;
    const el = NewTaskForm({ mounts, values: { title: "x", request: "", write: ["website", "api"], read: ["docs"] }, errors: {}, formError: null, busy: false, chooseFolders: true, onChange: (nv) => (got = nv), onSubmit: noop, onCancel: noop });
    const find = (node: unknown, name: string, value: string): { props: { onChange: (e: { target: { checked: boolean } }) => void } } | null => {
      if (!node || typeof node !== "object") return null;
      const n = node as { props?: { name?: string; value?: string; children?: unknown } };
      if (n.props?.name === name && n.props?.value === value) return n as never;
      const kids = n.props?.children;
      for (const k of Array.isArray(kids) ? kids.flat(3) : [kids]) {
        const hit = find(k, name, value);
        if (hit) return hit;
      }
      return null;
    };
    // unchecking api as a write folder: it stays shown to the agent
    find(el, "write", "api")!.props.onChange({ target: { checked: false } });
    expect(got).toMatchObject({ write: ["website"], read: ["docs", "api"] });
    // checking docs as a write folder: it leaves the read list
    find(el, "write", "docs")!.props.onChange({ target: { checked: true } });
    expect(got).toMatchObject({ write: ["website", "api", "docs"], read: [] });
  });

  it("the button stays disabled while the request is on its way", () => {
    const mounts: Mount[] = [{ mountName: "website", resourceId: "r", provider: "artifacts", resourceName: "Website", mode: "must-match-accepted", operations: ["read", "write"], canStartTask: true }];
    const html = form(mounts, { title: "x", request: "", write: ["website"], read: null }, { busy: true });
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""[^>]*>Creating…</);
    expect(form(mounts, { title: "x", request: "", write: ["website"], read: null })).toMatch(/<button type="submit"(?![^>]*disabled)[^>]*>Create task</);
  });

  it("hands the task to the agent: cforge checkout with a copy button", async () => {
    const api = new FakeApi({ role: "client", staging: true });
    const task = await api.createTask(ORG, PID, { title: "Show opening hours!", request: "Add our hours", writeMounts: ["website"] });
    expect(checkoutDir(task.title)).toBe("show-opening-hours");
    expect(checkoutDir("???")).toBe("task");
    const html = renderToString(createElement(AgentHandoff, { task: handoffTask(task), ctx: { role: "client", staging: true, apiUrl: "https://app.example", email: "client@customer.example" }, onDone: noop }));
    expect(text(html)).toContain("Give this task to your agent");
    expect(html).toContain(`cforge checkout ${task.taskId} show-opening-hours`);
    expect(checkoutCommand(task)).toBe(`cforge checkout ${task.taskId} show-opening-hours`);
    expect(html).toContain("Copy the checkout command");
    expect(html).toContain('data-testid="handoff-copy-prompt"');
    // the new task is in Working on the board
    const { live } = await stagingLive("client", api);
    expect(column(board("client", live), "working")).toContain("Show opening hours!");
  });

  it("renders open on the board for clients, developers and owners", async () => {
    for (const role of ["client", "developer", "owner"] as const) {
      const { api, live } = await stagingLive(role);
      const project = await api.getProject(ORG, PID);
      const html = board(role, live, project.mounts, { newTaskOpen: true });
      expect(html).toContain('data-testid="new-task"');
    }
  });
});
