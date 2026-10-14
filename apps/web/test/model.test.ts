import { describe, expect, it } from "vitest";
import type { EventView, Proposal } from "../src/api/types.js";
import {
  acceptBlockers,
  collapseDiff,
  concurrencyLanes,
  laneWorking,
  SESSION_ACTIVE_MS,
  groupChanges,
  groupHash,
  isReplaced,
  latestPerChange,
  lineDiff,
  needsDecision,
  newFileChangeKey,
  proposalStatus,
  RetryKey,
  revisionLabel,
  summaryStatus,
  taskStatus,
  validationSummary,
} from "../src/lib/model.js";

const HASH = "a".repeat(64);

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    proposalId: "prop-1",
    proposalHash: HASH,
    projectId: "p-1",
    changeId: "chg-1",
    state: "prepared",
    baseSnapshotId: "b".repeat(64),
    candidateSnapshotId: "c".repeat(64),
    resourceChanges: [{ resourceId: "res-w", baseRevision: "art:w:1111111", candidateId: "cand:tw-1:2222222", candidateRevision: "art:w:2222222" }],
    assetManifestChanges: [],
    readDependencies: [],
    policyRevision: 1,
    preparedReceipts: [],
    createdAt: "2026-10-06T10:00:00.000Z",
    updatedAt: "2026-10-06T10:00:00.000Z",
    stale: [],
    approvals: [],
    integration: null,
    candidates: [],
    lastAttempt: null,
    ...over,
  };
}

const passed = { jobId: "job-1", forCurrentHash: true, integratedAt: "2026-10-06T10:01:00.000Z", checks: [{ checkId: "tests", result: "pass" as const }], contractChecks: [{ contractId: "quote-schema", result: "pass" as const }], mergeOutcome: [{ resourceId: "res-w", result: "clean" as const }] };
const failed = { ...passed, contractChecks: [{ contractId: "quote-schema", result: "fail" as const }], mergeOutcome: [{ resourceId: "res-w", result: "textual-conflict" as const, conflictPaths: ["tests/quote.test.ts"] }] };
const attempt = (over: Partial<NonNullable<Proposal["lastAttempt"]>> = {}): NonNullable<Proposal["lastAttempt"]> => ({
  state: "failed",
  expired: false,
  forCurrentHash: true,
  requestedAt: "2026-10-06T10:00:30.000Z",
  completedAt: "2026-10-06T10:01:00.000Z",
  code: "contract_failed",
  checks: [{ checkId: "website-build", result: "pass" }],
  contractChecks: [{ contractId: "quote-schema", result: "fail", producerResource: "res-a", consumerResource: "res-w" }],
  mergeOutcome: [{ resourceId: "res-w", result: "clean" }],
  conflictPaths: [],
  signedEvidence: true,
  ...over,
});
const approval = (hash = HASH, role = "client") => ({ approvalId: "apr-1", role, approvedAt: "2026-10-06T10:02:00.000Z", proposalHash: hash, approver: { kind: "user" } });

describe("labels", () => {
  it("shortens revisions without hiding their kind", () => {
    expect(revisionLabel(`art:website:${"f".repeat(40)}`)).toBe("ffff ffff ffff");
    // UX-5: one short form everywhere: 12 characters in groups of four
    expect(revisionLabel(`r2m:${"9".repeat(64)}`)).toBe("manifest 9999 9999 9999");
    expect(revisionLabel(null)).toBe("—");
  });

  it("groups a proposal hash in 16 groups of 4", () => {
    const g = groupHash("0123456789abcdef".repeat(4));
    expect(g).toHaveLength(16);
    expect(g.join("")).toBe("0123456789abcdef".repeat(4));
  });
});

describe("validation and decisions", () => {
  it("summarises failures in plain words (conflict paths, contract)", () => {
    const v = validationSummary(proposal({ integration: failed }), () => "Website");
    expect(v.verdict).toBe("failed");
    expect(v.failures).toEqual(["Website: two changes edit the same lines (tests/quote.test.ts)", "Agreement on the quote format: failed"]);
  });

  it("C-1: a failed last attempt with no successful integration is a failure, in plain words", () => {
    const names: Record<string, string> = { "res-a": "API", "res-w": "Website" };
    const v = validationSummary(proposal({ integration: null, lastAttempt: attempt() }), (r) => names[r] ?? r);
    expect(v.verdict).toBe("failed");
    expect(v.code).toBe("contract_failed");
    expect(v.failures).toEqual(["API and Website do not agree on the quote format yet"]);
    expect(v.items.map((i) => i.label)).toEqual(["Website merges cleanly", "API and Website agree on the quote format", "Website builds"]);
    expect(proposalStatus(proposal({ lastAttempt: attempt() })).stage).toBe("NeedsResolution");
  });

  it("C-1: a failure with no evidence still blocks, with the code as the reason", () => {
    const v = validationSummary(proposal({ lastAttempt: attempt({ code: "textual_conflict", checks: [], contractChecks: [], mergeOutcome: [], signedEvidence: false }) }));
    expect(v.verdict).toBe("failed");
    expect(v.failures).toEqual(["Two changes edit the same lines of the same file"]);
  });

  it("C-1: a queued attempt is running; an expired one is not", () => {
    expect(validationSummary(proposal({ lastAttempt: attempt({ state: "queued", completedAt: null, code: null }) })).verdict).toBe("running");
    expect(proposalStatus(proposal({ lastAttempt: attempt({ state: "queued", code: null }) })).stage).toBe("Integrating");
    const expired = validationSummary(proposal({ lastAttempt: attempt({ state: "queued", expired: true, code: null }) }));
    expect(expired).toMatchObject({ verdict: "not-run", expired: true });
    // a later failure wins over an earlier successful integration
    expect(validationSummary(proposal({ integration: passed, lastAttempt: attempt() })).verdict).toBe("failed");
  });

  it("review I1: an attempt being applied (runner done, ledger not yet) is running and blocks Accept", () => {
    const p = proposal({ integration: null, lastAttempt: attempt({ state: "applying", code: null }) });
    expect(validationSummary(p).verdict).toBe("running");
    expect(acceptBlockers(p)).toContain("Validation is running");
  });

  it("treats evidence for an earlier hash as outdated", () => {
    expect(validationSummary(proposal({ integration: { ...passed, forCurrentHash: false } })).verdict).toBe("outdated");
  });

  it("lists every accept blocker; approval must be for the current hash", () => {
    expect(acceptBlockers(proposal())).toEqual(["Validation has not run", "No approval for this identity yet"]);
    expect(acceptBlockers(proposal({ integration: passed, approvals: [approval("b".repeat(64))] }))).toEqual(["No approval for this identity yet"]);
    expect(acceptBlockers(proposal({ integration: passed, approvals: [approval()] }))).toEqual([]);
    expect(acceptBlockers(proposal({ integration: passed, approvals: [approval()], stale: ["res-w"] }))).toContain("A base moved since this proposal was made (stale)");
    expect(acceptBlockers(proposal({ state: "open" }))).toContain("Candidates are still being prepared");
  });

  it("asks a client to decide only on a validated, unapproved, current result", () => {
    expect(needsDecision(proposal(), "client")).toBe(false);
    expect(needsDecision(proposal({ integration: passed }), "client")).toBe(true);
    expect(needsDecision(proposal({ integration: passed, approvals: [approval()] }), "client")).toBe(false);
    expect(needsDecision(proposal({ integration: passed, approvals: [approval("b".repeat(64))] }), "client")).toBe(true);
    expect(needsDecision(proposal({ integration: passed, stale: ["res-w"] }), "client")).toBe(false);
    expect(needsDecision(proposal({ integration: passed }), "viewer")).toBe(false);
  });

  it("asks developers to decide on prepared proposals, not closed or preparing ones", () => {
    expect(needsDecision(proposal(), "developer")).toBe(true);
    expect(needsDecision(proposal({ state: "open" }), "owner")).toBe(false);
    expect(needsDecision(proposal({ state: "accepted" }), "owner")).toBe(false);
  });
});

describe("assets-only proposals (follow-up Task 23)", () => {
  const logo = { resourceChanges: [], assetManifestChanges: [{ resourceId: "res-brand", baseManifestId: "e".repeat(64), newManifestId: "f".repeat(64) }] };
  const assetsPassed = { ...passed, mergeOutcome: [] };

  it("need a passing validation like any proposal before review, approval and accept", () => {
    expect(acceptBlockers(proposal({ ...logo, approvals: [approval()] }))).toEqual(["Validation has not run"]);
    expect(proposalStatus(proposal(logo)).label).toBe("Ready to validate");
    expect(needsDecision(proposal(logo), "client")).toBe(false);
    expect(needsDecision(proposal(logo), "developer")).toBe(true);
    // an assets-only run has an empty merge outcome; it passes on its checks and contracts
    expect(validationSummary(proposal({ ...logo, integration: assetsPassed })).verdict).toBe("passed");
    expect(acceptBlockers(proposal({ ...logo, integration: assetsPassed, approvals: [approval()] }))).toEqual([]);
    expect(needsDecision(proposal({ ...logo, integration: assetsPassed }), "client")).toBe(true);
    expect(proposalStatus(proposal({ ...logo, integration: assetsPassed })).stage).toBe("ReadyForReview");
  });

  it("a failed required check blocks them", () => {
    const run = attempt({ code: "check_failed", checks: [{ checkId: "website-tests", result: "fail" }], contractChecks: [], mergeOutcome: [] });
    const p = proposal({ ...logo, lastAttempt: run, approvals: [approval()] });
    expect(validationSummary(p)).toMatchObject({ verdict: "failed", code: "check_failed" });
    expect(acceptBlockers(p)).toEqual(["Validation failed"]);
    expect(proposalStatus(p).stage).toBe("NeedsResolution");
  });
});

describe("status (plan §A.6)", () => {
  it("maps proposals onto Change states", () => {
    expect(proposalStatus(proposal({ state: "open" })).stage).toBe("Submitted");
    expect(proposalStatus(proposal()).label).toBe("Ready to validate");
    expect(proposalStatus(proposal(), true).stage).toBe("Superseded");
    expect(proposalStatus(proposal({ integration: failed })).stage).toBe("NeedsResolution");
    expect(proposalStatus(proposal({ integration: passed })).stage).toBe("ReadyForReview");
    expect(proposalStatus(proposal({ integration: passed, approvals: [approval()] })).stage).toBe("Approved");
    expect(proposalStatus(proposal({ state: "accepted" })).stage).toBe("Accepted");
    expect(proposalStatus(proposal({ stale: ["res-w"] })).stage).toBe("Stale");
    expect(summaryStatus("superseded").label).toBe("Superseded");
    expect(taskStatus("running")).toMatchObject({ stage: "Running", tone: "busy" });
  });

  it("I-3: only the latest proposal of a Change counts; older ones were replaced", () => {
    const sum = (id: string, changeId: string, updatedAt: string, state = "prepared" as const) => ({ proposalId: id, proposalHash: HASH, projectId: "p-1", changeId, state, updatedAt });
    const latest = latestPerChange([sum("prop-1", "chg-a", "2026-10-06T10:00:00.000Z"), sum("prop-2", "chg-a", "2026-10-06T11:00:00.000Z"), sum("prop-3", "chg-b", "2026-10-06T09:00:00.000Z")]);
    expect([...latest.entries()]).toEqual([["chg-a", "prop-2"], ["chg-b", "prop-3"]]);
    expect(isReplaced({ proposalId: "prop-1", changeId: "chg-a", state: "prepared" }, latest)).toBe(true);
    expect(isReplaced({ proposalId: "prop-2", changeId: "chg-a", state: "prepared" }, latest)).toBe(false);
    expect(needsDecision(proposal({ proposalId: "prop-1", integration: passed }), "developer", true)).toBe(false);
  });

  it("groups tasks and proposals by Change, newest first", () => {
    const rows = groupChanges(
      [
        { taskId: "task-1", title: "Quote breakdown", state: "submitted", changeId: "chg-a", createdAt: "2026-10-06T09:00:00.000Z" },
        { taskId: "task-2", title: "Brand refresh", state: "running", changeId: "chg-b", createdAt: "2026-10-06T09:01:00.000Z" },
      ],
      [{ proposalId: "prop-1", proposalHash: HASH, projectId: "p-1", changeId: "chg-a", state: "prepared", updatedAt: "2026-10-06T10:00:00.000Z" }],
    );
    expect(rows.map((r) => r.changeId)).toEqual(["chg-a", "chg-b"]);
    expect(rows[0]!.title).toBe("Quote breakdown");
    expect(rows[0]!.proposals).toHaveLength(1);
  });
});

describe("concurrency lanes (AT-05 evidence)", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 6, 10, min)).toISOString();
  const e = (seq: number, min: number, action: string, id: string, taskId?: string): EventView => ({ seq, at: at(min), projectId: "p-1", action, subject: { kind: action === "task.started" ? "task" : "candidate", id }, actor: { kind: "agent" }, ...(taskId ? { detail: { taskId } } : {}) });

  it("finds the window where every agent was working", () => {
    const lanes = concurrencyLanes([e(1, 0, "task.started", "t1"), e(2, 1, "task.started", "t2"), e(3, 2, "task.started", "t3"), e(4, 6, "task.candidate_frozen", "c1", "t1"), e(5, 8, "task.candidate_frozen", "c2", "t2")], [], Date.parse(at(10)));
    expect(lanes.lanes).toHaveLength(3);
    expect(lanes.peak).toEqual({ count: 3, from: Date.parse(at(2)), to: Date.parse(at(6)) });
    expect(lanes.lanes[2]!.frozenAt).toBeNull();
  });

  it("reports no overlap when agents ran one after another", () => {
    const lanes = concurrencyLanes([e(1, 0, "task.started", "t1"), e(2, 1, "task.candidate_frozen", "c1", "t1"), e(3, 2, "task.started", "t2"), e(4, 3, "task.candidate_frozen", "c2", "t2")], [], Date.parse(at(5)));
    expect(lanes.peak).toBeNull();
  });
});

describe("lanes: renewals and partial overlap (m-3, m-4)", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 6, 10, min)).toISOString();
  const e = (seq: number, min: number, action: string, id: string, taskId?: string): EventView => ({ seq, at: at(min), projectId: "p-1", action, subject: { kind: action === "task.started" ? "task" : "candidate", id }, actor: { kind: "agent" }, ...(taskId ? { detail: { taskId } } : {}) });

  it("keeps a lane's first start when the lease is renewed", () => {
    const l = concurrencyLanes([e(1, 0, "task.started", "t1"), e(2, 3, "task.candidate_frozen", "c1", "t1"), e(3, 5, "task.started", "t1")], [], Date.parse(at(8)));
    expect(l.lanes[0]!.startedAt).toBe(Date.parse(at(0)));
    expect(l.lanes[0]!.freezes).toBe(1);
  });

  it("reports the peak concurrency even when a fourth task runs later", () => {
    const l = concurrencyLanes(
      [e(1, 0, "task.started", "t1"), e(2, 1, "task.started", "t2"), e(3, 2, "task.started", "t3"), e(4, 6, "task.candidate_frozen", "c1", "t1"), e(5, 7, "task.candidate_frozen", "c2", "t2"), e(6, 8, "task.candidate_frozen", "c3", "t3"), e(7, 20, "task.started", "t4"), e(8, 22, "task.candidate_frozen", "c4", "t4")],
      [],
      Date.parse(at(30)),
    );
    expect(l.peak).toEqual({ count: 3, from: Date.parse(at(2)), to: Date.parse(at(6)) });
  });

  it("places validation and acceptance markers on the lanes of their Change", () => {
    const tasks = [{ taskId: "t1", title: "Quote", state: "submitted" as const, changeId: "chg-a", createdAt: at(0) }];
    const ev: EventView[] = [e(1, 0, "task.started", "t1"), { seq: 2, at: at(4), projectId: "p-1", action: "proposal.integration_failed", subject: { kind: "proposal", id: "prop-1" }, actor: { kind: "runner" } }];
    const l = concurrencyLanes(ev, tasks, Date.parse(at(5)), (id) => (id === "prop-1" ? "chg-a" : undefined));
    expect(l.lanes[0]!.marks.map((m) => m.kind)).toEqual(["failed"]);
  });
});

describe("lanes: client edition sessions (UX-6)", () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 6, 10, min)).toISOString();
  const ev = (seq: number, min: number, action: string, detail: Record<string, unknown>, subject = "t"): EventView => ({ seq, at: at(min), projectId: "p-1", action, subject: { kind: action.startsWith("task.") ? "task" : "edition", id: subject }, actor: { kind: "user", id: "u-client" }, detail });
  const started = (seq: number, min: number, id: string): EventView => ({ seq, at: at(min), projectId: "p-1", action: "task.started", subject: { kind: "task", id }, actor: { kind: "agent" } });

  it("counts an edition session as a lane, so three concurrent sessions read as three", () => {
    const tasks = [{ taskId: "t-ret", title: "Client update: Copy", state: "provisioning" as const, changeId: "chg-b", createdAt: at(5) }];
    const l = concurrencyLanes(
      [started(1, 0, "t1"), started(2, 1, "t2"), ev(3, 1, "edition.session_started", { sessionId: "eds-1", title: "Copy" }), ev(4, 5, "edition.returned", { sessionId: "eds-1", returnId: "edr-1", taskId: "t-ret", tool: "claude" })],
      tasks,
      Date.parse(at(8)),
    );
    expect(l.lanes.map((x) => x.kind)).toEqual(["agent", "agent", "session"]);
    const s = l.lanes[2]!;
    expect(s).toMatchObject({ key: "session:eds-1", sessionId: "eds-1", actorId: "u-client", title: "Copy", taskId: "t-ret", changeId: "chg-b", tool: "claude", frozenAt: null });
    expect(l.peak?.count).toBe(3);
    expect(laneWorking(s, tasks)).toBe(true);
  });

  it("ends a session lane at the freeze of its return's candidate, and never doubles it with a task lane", () => {
    const tasks = [{ taskId: "t-ret", title: "Client update: Copy", state: "submitted" as const, changeId: "chg-b", createdAt: at(5) }];
    const l = concurrencyLanes(
      [ev(1, 1, "edition.session_started", { sessionId: "eds-1", title: "Copy" }), ev(2, 5, "edition.returned", { sessionId: "eds-1", taskId: "t-ret" }), started(3, 5, "t-ret"), ev(4, 6, "task.candidate_frozen", { taskId: "t-ret" }, "cand")],
      tasks,
      Date.parse(at(8)),
    );
    expect(l.lanes).toHaveLength(1);
    expect(l.lanes[0]!.frozenAt).toBe(Date.parse(at(6)));
    expect(l.lanes[0]!.marks.map((m) => m.kind)).toEqual(["submitted", "submitted"]);
    expect(laneWorking(l.lanes[0]!, tasks)).toBe(false);
  });

  it("a failed return ends the lane; an unreturned session stops showing once it is old", () => {
    const failed = concurrencyLanes([ev(1, 1, "edition.session_started", { sessionId: "eds-1" }), ev(2, 5, "edition.returned", { sessionId: "eds-1", returnId: "edr-1", taskId: "t-ret" }), ev(3, 6, "edition.return_failed", { returnId: "edr-1", code: "stale_base" })], [], Date.parse(at(8)));
    expect(failed.lanes[0]!.frozenAt).toBe(Date.parse(at(6)));
    expect(failed.lanes[0]!.title).toBe("Client update");
    expect(failed.lanes[0]!.marks.map((m) => m.kind)).toEqual(["submitted", "failed"]);
    const fresh = concurrencyLanes([ev(1, 1, "edition.session_started", { sessionId: "eds-2", title: "Hero" })], [], Date.parse(at(30)));
    expect(laneWorking(fresh.lanes[0]!, [])).toBe(true);
    const old = concurrencyLanes([ev(1, 1, "edition.session_started", { sessionId: "eds-2", title: "Hero" })], [], Date.parse(at(1)) + SESSION_ACTIVE_MS + 1);
    expect(old.lanes).toHaveLength(0);
  });
});

describe("line diff", () => {
  it("marks added and removed lines and keeps the rest", () => {
    const ops = lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(ops).toEqual([
      { op: "same", text: "a" },
      { op: "del", text: "b" },
      { op: "add", text: "B" },
      { op: "same", text: "c" },
      { op: "same", text: "d" },
      { op: "add", text: "e" },
    ]);
  });

  it("treats a missing side as a new or deleted file", () => {
    expect(lineDiff("", "x\ny").every((o) => o.op === "add")).toBe(true);
    expect(lineDiff("x", "").every((o) => o.op === "del")).toBe(true);
  });

  it("collapses long unchanged runs around changes", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 15", "LINE 15");
    const c = collapseDiff(lineDiff(before, after), 2);
    expect(c[0]).toEqual({ op: "skip", count: 13 });
    expect(c.filter((o) => o.op === "add")).toHaveLength(1);
    expect(c[c.length - 1]).toEqual({ op: "skip", count: 12 });
  });
});

describe("file change idempotency keys (final review 3)", () => {
  it("newFileChangeKey fits the Worker's rule and differs every time", () => {
    const a = newFileChangeKey();
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(newFileChangeKey()).not.toBe(a);
  });

  it("RetryKey: the same key while the same request is retried; a new one for another request or once it went through", () => {
    let n = 0;
    const k = new RetryKey(() => `k${++n}`);
    expect(k.for("delete a")).toBe("k1");
    expect(k.for("delete a")).toBe("k1"); // retried after an error
    expect(k.for("delete b")).toBe("k2"); // another request
    expect(k.for("delete b")).toBe("k2");
    k.done();
    expect(k.for("delete b")).toBe("k3"); // made again, on purpose
  });
});
