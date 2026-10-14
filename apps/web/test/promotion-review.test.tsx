/**
 * The developer's promotion review (staging phase 3, Task 8): server-rendered with views from the
 * fixture's staging demo, plus Needs you, the decision count and the Changes labels.
 */
import { createElement, type ReactNode } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FakeApi, FIXTURE_ORG as ORG, FIXTURE_PROJECT as PID, FIXTURE_PROPOSALS as PROPS, FIXTURE_STAGING_TASKS as T } from "../src/api/fake.js";
import type { Project, PromotionView, Role } from "../src/api/types.js";
import { AppContext } from "../src/lib/hooks.js";
import { promotionSettled } from "../src/lib/model.js";
import { promotionHref } from "../src/lib/router.js";
import { ChangesView, changeContext } from "../src/screens/Changes.js";
import { DIFF_MAX_BYTES, noDiffReason, unshownContent } from "../src/screens/FileDiff.js";
import { OverviewView, promotionNeedsYouItems, promotionTitle } from "../src/screens/Overview.js";
import { decisionCount, loadLive, pendingPromotionsFor, ProjectContext, type LiveState } from "../src/screens/project-data.js";
import { approveDoes, incompleteText, promotionActions, PromotionReviewView, PromotionRoute, reviewPollMs } from "../src/screens/PromotionReview.js";
import { ProposalReviewView, routedProposalInfo } from "../src/screens/ProposalReview.js";

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/\s+/g, " ");

function clock(start = Date.parse("2026-10-11T12:00:00.000Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
const STEP = 1000;

function demo(role: Role = "client") {
  const c = clock();
  const api = new FakeApi({ role, staging: true, now: c.now, integrationMs: STEP, promotionStepMs: STEP });
  return { api, c };
}

async function as<X>(api: FakeApi, role: Role, f: () => Promise<X>): Promise<X> {
  const before = api.role;
  api.role = role;
  try {
    return await f();
  } finally {
    api.role = before;
  }
}

/** The client promotes a demo task; poll until it waits for a person or ends; the developer's view of it. */
async function promoted(api: FakeApi, c: ReturnType<typeof clock>, taskId: string): Promise<PromotionView> {
  const r = await as(api, "client", () => api.promoteTask(taskId));
  for (let i = 0; i < 30; i++) {
    const v = await api.getPromotion(ORG, r.promotionId);
    if (promotionSettled(v.state)) return as(api, "developer", () => api.getPromotion(ORG, r.promotionId));
    c.advance(STEP);
  }
  throw new Error("the promotion never settled");
}

function wrap(api: FakeApi, project: Project, role: Role, children: ReactNode) {
  return createElement(
    AppContext.Provider,
    { value: { api, fixture: api, me: null, refreshMe: async () => {} } },
    createElement(ProjectContext.Provider, { value: { org: ORG, pid: PID, role, project, live: undefined, reloadLive: () => {} } }, children),
  );
}

async function review(api: FakeApi, p: PromotionView, role: Role = "developer"): Promise<string> {
  const project = await as(api, role, () => api.getProject(ORG, PID));
  return render(wrap(api, project, role, createElement(PromotionReviewView, { p, project, role, org: ORG, pid: PID, now: new Date("2026-10-11T12:30:00.000Z") })));
}

describe("promotion review", () => {
  it("the column rename: tasks with their request, paths with levels and rule numbers, the veto statement, actions open", async () => {
    const { api, c } = demo();
    const p = await promoted(api, c, T.rename);
    expect(p.state).toBe("pending_approval");
    const html = await review(api, p);
    const t = text(html);
    expect(t).toContain("Rename the contact name column");
    expect(t).toContain("Rename the contacts table's name column to full_name");
    expect(t).toContain("Changes the database structure in a way that needs a developer.");
    expect(t).toContain("Waiting for your approval");
    // paths: mount/path → level → rule (1-based)
    expect(html).toContain('data-testid="promotion-paths"');
    expect(t).toMatch(/api\/migrations\/0003_rename_contact_name\.sql Automatic review Rule 2/);
    expect(t).toMatch(/api\/src\/contacts\.ts Automatic review Rule 2/);
    // the veto: kind, file and statement (monospace)
    expect(t).toContain("Not provably additive");
    expect(html).toMatch(/<code[^>]*>ALTER TABLE contacts RENAME COLUMN name TO full_name<\/code>/);
    // the classifier was not asked
    expect(t).toContain("Not asked: the database change needs a developer.");
    // checks, merge outcome
    expect(html).toContain('data-testid="promotion-checks"');
    expect(t).toContain("Clean merge");
    // diff per resource, between main and the result
    expect(html).toContain('data-testid="promotion-diff"');
    expect(t).toContain("migrations/0003_rename_contact_name.sql");
    // actions open
    expect(html).toMatch(/<button[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*>Send back to staging<\/button>/);
    expect(html).toMatch(/<button[^>]*>Withdraw<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Approve/);
  });

  it("the phone field: the automatic review's answers with safe probability vs the threshold, provider, model and latency", async () => {
    const { api, c } = demo();
    api.classifierOutcome = "clear";
    const p = await promoted(api, c, T.phone);
    expect(p.state).toBe("live");
    const t = text(await review(api, p));
    expect(t).toContain("Jev (TypeSafe)");
    expect(t).toContain("jev-1.13.0");
    expect(t).toContain("Cleared by the automatic review");
    expect(t).toMatch(/needs 90%/);
    const ev = p.gate!.classifier.evidence!;
    for (const q of Object.keys(ev.safeProbability!)) expect(t).toContain(`${(ev.safeProbability![q]! * 100).toFixed(1)}%`);
    expect(t).toContain("How risky is the change? low");
    expect(t).toMatch(/Passed/);
    expect(t).toContain("Answered in 1.8 s");
    expect(t).toContain("Live");
  });

  it("a declined answer is marked as not clearing", async () => {
    const { api, c } = demo();
    api.classifierOutcome = "risk";
    const p = await promoted(api, c, T.phone);
    const t = text(await review(api, p));
    expect(t).toContain("The automatic review could not confirm this change is low risk.");
    expect(t).toContain("Not confident enough");
    expect(t).toMatch(/How risky is the change\? low 60.0% needs 90% Below/);
  });

  it("errors in plain words: a timeout, and an incomplete input with its reasons", async () => {
    const a = demo();
    a.api.classifierOutcome = "unavailable";
    const t1 = text(await review(a.api, await promoted(a.api, a.c, T.phone)));
    expect(t1).toContain("The automatic review was not available (timeout).");
    expect(t1).not.toContain("needs 90%");

    const b = demo();
    b.api.classifierOutcome = "incomplete";
    const t2 = text(await review(b.api, await promoted(b.api, b.c, T.phone)));
    expect(t2).toContain("The automatic review was not asked: it could not see the complete change (a changed file could not be read).");
    expect(incompleteText(["diff_truncated", "binary_file", "read_limit"])).toBe("a file's changes were too long to show in full, a binary file is in a folder the automatic review covers and more than 4 MiB had to be read");
  });

  it("a carried classifier clearance shows 'Cleared earlier by the automatic review' with its evidence", async () => {
    const { api, c } = demo();
    api.classifierOutcome = "clear";
    await as(api, "client", () => api.promoteTask(T.copy));
    const p = await promoted(api, c, T.phone);
    expect(p.gate?.classifier.reason).toBe("carried");
    const t = text(await review(api, p));
    expect(t).toContain("Cleared earlier by the automatic review");
    expect(t).toMatch(/needs 90%/);
  });

  it("a carried developer clearance says the earlier approval still covers it", () => {
    const html = render(
      createElement(PromotionReviewView, {
        p: { ...fakeView(), gate: { pathLevel: "classify", perPath: [], veto: { kind: "none", offending: [] }, classifier: { asked: false, cleared: false, reason: "carried" }, reasonCode: "carried" } },
        project: { projectId: PID, name: "Customer Portal", membershipRevision: 1, policyRevision: 1, mounts: [] },
        role: "developer",
        org: ORG,
        pid: PID,
      }),
    );
    expect(text(html)).toContain("Not asked again: a developer's approval from an earlier build still covers this change.");
  });

  it("a developer without read on every folder gets the client view and cannot review it", async () => {
    const { api, c } = demo();
    const r = await as(api, "client", () => api.promoteTask(T.rename));
    for (let i = 0; i < 10; i++) {
      await api.getPromotion(ORG, r.promotionId);
      c.advance(STEP);
    }
    const apiFolder = (await as(api, "owner", () => api.getProject(ORG, PID))).mounts.find((m) => m.mountName === "api")!.resourceId;
    await as(api, "owner", () => api.putProjectAccess(ORG, PID, { userId: "u-developer", level: "write", folders: { [apiFolder]: "none" } }));
    const p = await as(api, "developer", () => api.getPromotion(ORG, r.promotionId));
    expect(p.gate).toBeUndefined();
    const html = await review(api, p);
    expect(text(html)).toContain("You can't review this promotion: you don't have access to every folder it changes.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('data-testid="promotion-paths"');
  });

  it("actions are disabled with an explanation when the state no longer allows them", async () => {
    expect(promotionActions("pending_approval", "developer", ["owner", "developer"])).toMatchObject({ approve: { ok: true }, sendBack: { ok: true }, withdraw: { ok: true } });
    expect(promotionActions("cleared", "developer", ["owner", "developer"])).toMatchObject({ approve: { ok: false }, sendBack: { ok: true }, withdraw: { ok: true } });
    const live = promotionActions("live", "developer", ["owner", "developer"]);
    expect(live.approve).toEqual({ ok: false, why: "It is live in production; there is nothing left to decide." });
    expect(live.withdraw.ok).toBe(false);
    expect(promotionActions("pending_approval", "developer", ["owner", "client"]).approve).toEqual({ ok: false, why: "This project's policy does not accept approvals from developers." });
    const { api, c } = demo();
    const p = await promoted(api, c, T.copy);
    const html = await review(api, p);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Approve<\/button>/);
    expect(text(html)).toContain("It is live in production; there is nothing left to decide.");
  });

  it("binary and LFS files are noted, not diffed", () => {
    expect(noDiffReason("website/logo.png")).toBe("Binary file; its contents are not shown.");
    expect(noDiffReason("src/index.ts")).toBeNull();
    expect(unshownContent("a\0b")).toBe("Binary file; its contents are not shown.");
    expect(unshownContent("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n")).toBe("Stored in LFS; its contents are not shown.");
    expect(unshownContent("hello")).toBeNull();
  });

  it("a client or viewer visiting the route gets the not-found screen", () => {
    for (const role of ["client", "viewer"] as const) {
      const html = render(createElement(PromotionRoute, { promotionId: "prm-x", role }));
      expect(text(html)).toContain("This page does not exist or you do not have access.");
    }
  });
});

describe("pending promotions for developers", () => {
  async function liveOf(api: FakeApi, role: Role): Promise<LiveState> {
    return as(api, role, async () => loadLive(api, ORG, PID, role, { project: await api.getProject(ORG, PID) }));
  }

  it("Needs you lists each pending promotion for developers, linking to its review; decisionCount includes them", async () => {
    const { api, c } = demo();
    const before = decisionCount(await liveOf(api, "developer"), "developer", undefined);
    const p = await promoted(api, c, T.rename);
    const live = await liveOf(api, "developer");
    expect(live.pendingPromotions?.map((x) => x.promotionId)).toEqual([p.promotionId]);
    const items = promotionNeedsYouItems(live, "developer", ORG, PID, undefined);
    expect(items).toEqual([expect.objectContaining({ title: "Rename the contact name column", href: promotionHref(ORG, PID, p.promotionId), action: "Review" })]);
    expect(items[0]!.detail).toContain("Changes the database structure in a way that needs a developer.");
    // the promotion counts once: its proposal (kind promotion) is not a proposal decision
    expect(decisionCount(live, "developer", undefined)).toBe(before + 1);
    const project = await as(api, "developer", () => api.getProject(ORG, PID));
    const html = render(createElement(OverviewView, { live, project, role: "developer", org: ORG, pid: PID }));
    expect(html).toContain(promotionHref(ORG, PID, p.promotionId));
    // clients get no such item (theirs is "Production update pending approval")
    expect(promotionNeedsYouItems(await liveOf(api, "client"), "client", ORG, PID, undefined)).toEqual([]);
  });

  it("Changes labels landing and promotion proposals and links a promotion to its review", async () => {
    const { api, c } = demo();
    const p = await promoted(api, c, T.rename);
    const live = await liveOf(api, "developer");
    const project = await as(api, "developer", () => api.getProject(ORG, PID));
    // the fake has no landing proposals: mark an ordinary one as a landing (`kind: "staging"`)
    const ordinary = live.proposals.find((x) => !x.kind)!;
    const marked: LiveState = { ...live, proposals: live.proposals.map((x) => (x === ordinary ? { ...x, kind: "staging" as const } : x)) };
    const html = render(createElement(ChangesView, { live: marked, project, role: "developer", org: ORG, pid: PID, now: Date.now() }));
    const t = text(html);
    expect(t).toContain("On staging");
    expect(t).toContain("Promotion");
    expect(html).toContain(`href="${promotionHref(ORG, PID, p.promotionId)}"`);
  });
});

describe("Task 8 review", () => {
  async function liveOf(api: FakeApi, role: Role): Promise<LiveState> {
    return as(api, role, async () => loadLive(api, ORG, PID, role, { project: await api.getProject(ORG, PID) }));
  }
  const noop = () => {};
  const emptyProject: Project = { projectId: PID, name: "Customer Portal", membershipRevision: 1, policyRevision: 1, mounts: [] };

  it("a landing or promotion proposal opened directly offers no decision; a promotion's links to its review", async () => {
    const api = new FakeApi({ role: "owner" });
    for (const role of ["client", "owner"] as const) {
      api.role = role;
      const p = await api.getProposal(ORG, PROPS.quoteRepaired);
      const project = await api.getProject(ORG, PID);
      const live = await loadLive(api, ORG, PID, role);
      const cx = changeContext(live, project, role);
      const base = {
        p,
        project,
        role,
        org: ORG,
        pid: PID,
        title: cx.titleOf(p.changeId),
        newerProposalId: null,
        previous: null,
        cx,
        decisions: { onApprove: noop, approveBusy: false, approveError: null, onAccept: noop, acceptBusy: false, acceptError: null, acceptedVersionId: null },
        validate: { onValidate: noop, busy: false, error: null },
      };
      for (const routed of [
        { kind: "promotion" as const, promotionHref: "/o/x/p/y/promotions/prm-1" },
        { kind: "promotion" as const, promotionHref: null },
        { kind: "staging" as const, promotionHref: null },
      ]) {
        const html = render(createElement(ProposalReviewView, { ...base, routed }));
        const t = text(html);
        expect(t).not.toContain("Needs your decision");
        expect(html).not.toMatch(/<button[^>]*>(Approve this result|Approve again|Accept as new version|Validate)/);
        if (routed.kind === "staging") expect(t).toContain("This puts a task on staging. It is not decided here");
        else expect(t).toContain("This production update is decided on its review screen");
        if (routed.promotionHref && role === "owner") expect(html).toContain(`href="${routed.promotionHref}"`);
        else expect(html).not.toContain("/promotions/");
      }
    }
  });

  it("routedProposalInfo names the kind and, for a promotion the project poll knows, its review screen", async () => {
    const { api, c } = demo();
    const p = await promoted(api, c, T.rename);
    const live = await liveOf(api, "developer");
    const withKind: LiveState = { ...live, proposals: [...live.proposals, { proposalId: p.proposalId!, proposalHash: "h", projectId: PID, changeId: "chg-x", state: "open", kind: "promotion", updatedAt: "2026-10-11T12:00:00.000Z" }] };
    expect(routedProposalInfo(withKind, p.proposalId!, ORG, PID)).toEqual({ kind: "promotion", promotionHref: promotionHref(ORG, PID, p.promotionId) });
    expect(routedProposalInfo(withKind, PROPS.quoteRepaired, ORG, PID)).toBeNull();
    expect(routedProposalInfo(undefined, p.proposalId!, ORG, PID)).toBeNull();
  });

  it("a gate error says the checks could not be read instead of the stand-in veto statement", () => {
    const html = render(
      createElement(PromotionReviewView, {
        p: {
          ...fakeView(),
          state: "pending_approval",
          clearance: null,
          reasonCode: "gate_error",
          reason: "Needs a developer's review.",
          gate: { pathLevel: "classify", perPath: [{ path: "api/src/index.ts", level: "classify", rule: 1 }], veto: { kind: "destructive", offending: [{ file: "(gate)", statement: "(migrations could not be checked)" }] }, classifier: { asked: false, cleared: false, reason: "not_needed" }, reasonCode: "gate_error" },
        },
        project: emptyProject,
        role: "developer",
        org: ORG,
        pid: PID,
      }),
    );
    const t = text(html);
    expect(t).toContain("The checks could not be read; a developer needs to review this.");
    expect(t).not.toContain("(migrations could not be checked)");
    expect(t).not.toContain("Not provably additive");
    expect(t).not.toContain("Not asked");
  });

  it("between the build and the check, the diff says the files show once checked; a folder under two names is explained", () => {
    const project: Project = {
      ...emptyProject,
      mounts: [
        { mountName: "api", resourceId: "res-a", resourceName: "API" } as Project["mounts"][number],
        { mountName: "backend", resourceId: "res-a", resourceName: "API" } as Project["mounts"][number],
      ],
    };
    const before = text(render(createElement(PromotionReviewView, { p: { ...fakeView(), state: "gating", clearance: null, gate: null, resources: [{ resourceId: "res-a", mountName: "api", head: "r1", result: "r2" }] }, project, role: "developer", org: ORG, pid: PID })));
    expect(before).toContain("The changed files show once the promotion has been checked.");
    expect(before).not.toContain("No changed paths were recorded");
    const after = text(
      render(
        wrap(new FakeApi({ role: "developer" }), project, "developer", createElement(PromotionReviewView, {
          p: { ...fakeView(), gate: { pathLevel: "classify", perPath: [{ path: "api/src/a.ts", level: "classify", rule: 1 }, { path: "backend/src/a.ts", level: "developer", rule: null }], veto: { kind: "none", offending: [] }, classifier: { asked: true, cleared: true, reason: "cleared" }, reasonCode: "classifier" }, resources: [{ resourceId: "res-a", mountName: "api", head: "r1", result: "r2" }] },
          project,
          role: "developer",
          org: ORG,
          pid: PID,
        })),
      ),
    );
    expect(after).toContain("API is in the project under more than one name (api and backend)");
  });

  it("Needs you and the decision count include a pending promotion only when the viewer's role may approve", async () => {
    const { api, c } = demo();
    await promoted(api, c, T.rename);
    const live = await liveOf(api, "developer");
    expect(pendingPromotionsFor(live, "developer", ["owner", "developer"])).toHaveLength(1);
    expect(pendingPromotionsFor(live, "developer", undefined)).toHaveLength(1);
    expect(pendingPromotionsFor(live, "developer", ["owner", "client"])).toEqual([]);
    expect(decisionCount(live, "developer", ["owner", "client"])).toBe(decisionCount(live, "developer", ["owner", "developer"]) - 1);
    expect(promotionNeedsYouItems(live, "developer", ORG, PID, ["owner", "client"])).toEqual([]);
    const project = await as(api, "developer", () => api.getProject(ORG, PID));
    const restricted: Project = { ...project, policy: { ...project.policy!, approvalRoles: ["owner", "client"] } };
    const html = render(createElement(OverviewView, { live, project: restricted, role: "developer", org: ORG, pid: PID }));
    expect(html).not.toContain("/promotions/");
  });

  it("a promotion's title never says '-1 more'", () => {
    expect(promotionTitle({ landings: [] })).toBe("Production update");
    expect(promotionTitle({ landings: [{ title: "A" }] })).toBe("A");
    expect(promotionTitle({ landings: [{ title: "A" }, { title: "B" }] })).toBe("A and 1 more");
  });

  it("the Approve confirmation mentions database changes only when migrations changed", () => {
    const g = (kind: "none" | "additive" | "destructive", reasonCode: "developer_paths" | "migration_destructive" | "gate_error" = "developer_paths") => ({ ...fakeView(), gate: { pathLevel: "developer" as const, perPath: [], veto: { kind, offending: [] }, classifier: { asked: false, cleared: false, reason: "not_needed" as const }, reasonCode } });
    expect(approveDoes(g("none"), emptyProject)).not.toContain("database");
    expect(approveDoes(g("additive"), emptyProject)).toContain("with database changes applied first");
    expect(approveDoes(g("destructive", "migration_destructive"), emptyProject)).toContain("with database changes applied first");
    expect(approveDoes(g("destructive", "gate_error"), emptyProject)).toContain("with any database changes applied first");
    expect(approveDoes({ ...fakeView(), gate: null }, emptyProject)).not.toContain("database");
  });

  it("the review screen stops polling once the promotion ended", () => {
    for (const s of ["live", "failed", "sent_back", "superseded", "withdrawn"] as const) expect(reviewPollMs(s)).toBeUndefined();
    for (const s of ["requested", "building", "gating", "pending_approval", "cleared", "accepting", "releasing", "release_failed"] as const) expect(reviewPollMs(s)).toBeGreaterThan(0);
  });

  it("archives, databases and other binaries are not diffed; oversized files are not diffed line by line", () => {
    for (const path of ["lib/app.jar", "data/app.sqlite", "data/app.sqlite3", "data/local.db", "pkg/mod.wasm", "dist/a.zip", "dist/a.tar.gz", "dist/a.7z", "bin/tool.exe", "lib/x.so", "a.class", "font.eot", "doc.docx", "img.avif"]) expect(noDiffReason(path)).not.toBeNull();
    for (const path of ["src/index.ts", "migrations/0002_phone.sql", "README.md", "website/logo.svg", "data/seed.json"]) expect(noDiffReason(path)).toBeNull();
    expect(DIFF_MAX_BYTES).toBe(1024 * 1024);
  });
});

function fakeView(): PromotionView {
  return {
    promotionId: "prm-1",
    state: "cleared",
    landings: [{ landingId: "lnd-1", taskId: "task-1", title: "Add a phone field", state: "promoting", request: "Add a phone field.", parts: [{ part: 1, taskId: "task-1", title: "Add a phone field" }] }],
    level: "classify",
    reasonCode: null,
    reason: null,
    waitingForProduction: false,
    mode: "closure",
    goingWithout: [],
    needs: [],
    targetLandingId: "lnd-1",
    proposalId: null,
    proposalHash: null,
    gate: null,
    detail: null,
    clearance: { kind: "developer", clearedBy: "u-developer", clearedAt: "2026-10-11T12:00:00.000Z" },
    acceptedVersionId: null,
    releaseId: null,
    requestedBy: "u-client",
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    resources: [],
    checks: null,
  };
}
