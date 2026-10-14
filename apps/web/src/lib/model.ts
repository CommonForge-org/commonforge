/**
 * Pure presentation logic: status derivation (plan §A.6), "Needs your decision", accept blockers,
 * concurrency lanes, revision labels and a small line diff. No React, no I/O: unit-tested directly.
 */
import type { EventView, LandingState, PromotionState, PromotionView, Proposal, ProposalSummary, Provider, Role, StagingLanding, TaskSummary } from "../api/types.js";

// --------------------------------------------------------------------------------- formatting

export function isDeveloperRole(role: Role): boolean {
  return role === "owner" || role === "developer";
}

export function providerLabel(provider: Provider | string): string {
  if (provider === "artifacts") return "Artifacts repository";
  if (provider === "r2-assets") return "R2 asset collection";
  return provider;
}

export function providerKind(provider: Provider | string): "code" | "assets" {
  return provider === "r2-assets" ? "assets" : "code";
}

/** `art:<repo>:<sha>` → `a1b2c3d`, `r2m:<manifest>` → `manifest 1a2b3c4d`. */
export function revisionLabel(revision: string | null | undefined): string {
  if (!revision) return "—";
  const [kind, ...rest] = revision.split(":");
  // O-1: clients get opaque `rev-<16 hex>` labels instead of raw revision ids
  if (revision.startsWith("rev-")) return shortCode(revision.slice(4));
  if (kind === "art" && rest.length >= 2) return shortCode(rest[rest.length - 1] ?? "");
  if (kind === "r2m" && rest.length >= 1) return `manifest ${shortCode(rest[0] ?? "")}`;
  if (kind === "cand" && rest.length >= 2) return `candidate ${shortCode(rest[rest.length - 1] ?? "")}`;
  return revision.length > 16 ? `${revision.slice(0, 16)}…` : revision;
}

/**
 * The one short form of every hash-like identity (review codes, revisions, manifests, snapshots,
 * build digests): the first 12 characters in groups of four, short enough to read aloud.
 */
export function shortCode(hash: string): string {
  return groupHash(hash.slice(0, 12)).join(" ");
}

/** 64 hex chars → 16 groups of 4, so two people can read it aloud and compare. */
export function groupHash(hash: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < hash.length; i += 4) out.push(hash.slice(i, i + 4));
  return out;
}

export function shortId(id: string, keep = 8): string {
  const i = id.indexOf("-");
  const body = i >= 0 ? id.slice(i + 1) : id;
  return `${i >= 0 ? id.slice(0, i + 1) : ""}${body.slice(0, keep)}`;
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * "just now", "5 min ago", "yesterday", "3 weeks ago"; future times "in 40 min". Never an ISO
 * timestamp in the default view (docs/UX-POLISH.md §6).
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "some time ago";
  const sec = Math.round((now.getTime() - t) / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.floor(d / 7)} weeks ago`;
  if (d < 365) return `${Math.floor(d / 30)} months ago`;
  return "over a year ago";
}

export function formatTime(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "some time ago";
  const ahead = Math.round((t - now.getTime()) / 60_000);
  if (ahead >= 1) return ahead < 60 ? `in ${ahead} min` : ahead < 48 * 60 ? `in ${Math.round(ahead / 60)} ${Math.round(ahead / 60) === 1 ? "hour" : "hours"}` : `in ${Math.round(ahead / 1440)} days`;
  return relativeTime(iso, now);
}

/** A fresh key, `<prefix><sep><random>`. File changes take only [A-Za-z0-9_-]: pass `sep` "-" and such a prefix. */
export function newIdempotencyKey(prefix: string, sep = ":"): string {
  const rnd = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}${sep}${rnd}`;
}

/** A key for POST …/changes (1 to 128 of [A-Za-z0-9_-]). */
export const newFileChangeKey = () => newIdempotencyKey("fc", "-");

/**
 * The idempotency key of one change the user means to make: the same while they retry the same
 * request (an error, then Save or Confirm again), a new one once it went through or the request
 * differs (another folder, other operations or contents).
 */
export class RetryKey {
  private last: { sig: string; key: string } | null = null;
  constructor(private readonly fresh: () => string = newFileChangeKey) {}
  /** the key for this request (`sig` names it: folder, operations, contents) */
  for(sig: string): string {
    if (this.last?.sig !== sig) this.last = { sig, key: this.fresh() };
    return this.last.key;
  }
  /** the request went through: the next one is a new change */
  done(): void {
    this.last = null;
  }
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

// ------------------------------------------------------------------------------ plain language

function words(id: string): string {
  return id.replace(/[-_.]+/g, " ").trim();
}

function cap(s: string): string {
  const t = s.replace(/\b(api|ui|url|css|html|sql|cli)\b/gi, (m) => m.toUpperCase());
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** "website-build" → "Website builds"; "api-tests" → "Api tests pass"; else the id in words. */
export function checkLabel(checkId: string): string {
  const w = words(checkId);
  if (/\bbuild$/i.test(w)) return `${cap(w.replace(/\s*build$/i, ""))} builds`.trim();
  if (/\btests?$/i.test(w)) return `${cap(w.replace(/\s*tests?$/i, ""))} tests pass`.trim();
  if (/\blint$/i.test(w)) return `${cap(w.replace(/\s*lint$/i, ""))} passes lint`.trim();
  return cap(w);
}

/** "quote-schema" between API and Website → "API and Website agree on the quote format". */
export function contractLabel(contractId: string, producer?: string, consumer?: string): string {
  const subject = words(contractId).replace(/\s*(schema|contract)$/i, "");
  const what = subject ? `the ${subject} format` : "their contract";
  if (producer && consumer && producer !== consumer) return `${producer} and ${consumer} agree on ${what}`;
  if (producer) return `${producer} keeps ${what}`;
  return `Agreement on ${what}`;
}

const CODE_SENTENCE: Record<string, string> = {
  contract_failed: "The parts of the project no longer agree with each other",
  check_failed: "A required check failed",
  textual_conflict: "Two changes edit the same lines of the same file",
  stale_base: "Another change was accepted first, so this result is based on an older version",
  asset_conflict: "Two changes replace the same asset",
  scope_violation: "The change touches something it was not allowed to",
  runner_failed: "The validation run itself failed",
  timeout: "Validation took too long and was stopped",
  // re-review R3: the run passed but its result never reached the ledger; the server reports it failed
  receipt_not_recorded: "The validation result could not be recorded. Validate again",
};

export function failureSentence(code: string | null | undefined): string {
  if (!code) return "Validation failed";
  return CODE_SENTENCE[code] ?? `Validation failed (${words(code)})`;
}

// ------------------------------------------------------------------------------- validation

export type Verdict = "not-run" | "running" | "passed" | "failed" | "outdated";

/** Failure codes that mean "the run never produced a result" rather than "validation failed". */
const EXPIRY_CODES: ReadonlySet<string> = new Set(["job_expired", "timeout"]);

export interface ValidationItem {
  kind: "merge" | "contract" | "check";
  id: string;
  /** plain-language label */
  label: string;
  result: "pass" | "fail" | "skipped";
  /** conflict paths for merges */
  paths?: string[];
}

export interface ValidationSummary {
  verdict: Verdict;
  /** the runner's failure code (failed runs) */
  code: string | null;
  /** plain-language failures */
  failures: string[];
  /** every merge / contract / check of the attempt, in plain language */
  items: ValidationItem[];
  /** the run expired without an answer */
  expired: boolean;
}

/**
 * Validation from the server's view: `lastAttempt` (any outcome) first, then `integration` (the
 * latest successful receipt). A failed run leaves `integration` unchanged on the server, so the
 * attempt decides.
 */
export function validationSummary(p: Pick<Proposal, "integration" | "lastAttempt">, nameOf: (rid: string) => string = (r) => r): ValidationSummary {
  const a = p.lastAttempt ?? null;
  const integ = p.integration;
  const none = (verdict: Verdict, expired = false): ValidationSummary => ({ verdict, code: null, failures: [], items: [], expired });
  if (a && a.state === "queued" && !a.expired) return none("running");
  // review I1: the runner finished, the ledger has not recorded the receipt yet: still validating
  if (a && a.state === "applying") return none("running");
  // Task 20 review n-4: a run that expired (never answered, or closed by GC as job_expired/timeout)
  // is not a validation result: it must not mask an earlier passing run
  const expiredRun = !!a && ((a.state === "queued" && a.expired) || (a.state === "failed" && EXPIRY_CODES.has(a.code ?? "")));
  const source = a && a.state !== "queued" && !expiredRun ? a : null;
  if (!source && !integ) return none("not-run", expiredRun);
  const forCurrent = source ? source.forCurrentHash : integ!.forCurrentHash;
  const merge = source ? source.mergeOutcome : integ!.mergeOutcome;
  const contracts = source ? source.contractChecks.map((c) => ({ contractId: c.contractId, result: c.result, producer: c.producerResource, consumer: c.consumerResource })) : integ!.contractChecks.map((c) => ({ contractId: c.contractId, result: c.result as string, producer: undefined as string | undefined, consumer: undefined as string | undefined }));
  const checks = source ? source.checks : integ!.checks;
  const items: ValidationItem[] = [
    ...merge.map((m): ValidationItem => ({
      kind: "merge",
      id: m.resourceId,
      label: m.result === "clean" ? `${nameOf(m.resourceId)} merges cleanly` : m.result === "textual-conflict" ? `${nameOf(m.resourceId)}: two changes edit the same lines` : m.result === "stale-base" ? `${nameOf(m.resourceId)} moved on since this was made` : `${nameOf(m.resourceId)}: two changes replace the same asset`,
      result: m.result === "clean" ? "pass" : "fail",
      ...(m.conflictPaths?.length ? { paths: m.conflictPaths } : {}),
    })),
    ...contracts.map((c): ValidationItem => ({ kind: "contract", id: c.contractId, label: contractLabel(c.contractId, c.producer ? nameOf(c.producer) : undefined, c.consumer ? nameOf(c.consumer) : undefined), result: c.result === "pass" ? "pass" : "fail" })),
    ...checks.map((c): ValidationItem => ({ kind: "check", id: c.checkId, label: checkLabel(c.checkId), result: c.result === "pass" ? "pass" : c.result === "skipped" ? "skipped" : "fail" })),
  ];
  if (!forCurrent) return { ...none("outdated"), items };
  const failed = items.filter((i) => i.result === "fail");
  const code = source?.state === "failed" ? source.code : null;
  const failures = failed.map((i) => (i.kind === "contract" ? (i.label.includes(" agree on ") ? i.label.replace(" agree on ", " do not agree on ") + " yet" : `${i.label}: failed`) : i.kind === "check" ? `${i.label.replace(/ pass$/, "")}: failed` : i.label + (i.paths ? ` (${i.paths.join(", ")})` : "")));
  if (source?.state === "failed" && failures.length === 0) failures.push(failureSentence(code));
  const verdict: Verdict = source?.state === "failed" || failed.length ? "failed" : "passed";
  return { verdict, code, failures, items, expired: false };
}

export function currentApprovals(p: Pick<Proposal, "approvals" | "proposalHash">) {
  return p.approvals.filter((a) => a.proposalHash === p.proposalHash);
}

const CLOSED: ReadonlySet<string> = new Set(["accepted", "rejected", "superseded", "withdrawn"]);

export function isClosed(state: string): boolean {
  return CLOSED.has(state);
}

/**
 * Does the proposal change git resources? Assets-only proposals (only R2 manifests) are validated
 * like any other — the runner runs the project's checks against the code at the proposal's base (follow-up
 * Task 23) — but they have nothing to merge or preview.
 */
export function hasCodeChanges(p: Pick<Proposal, "resourceChanges">): boolean {
  return p.resourceChanges.length > 0;
}

/** Why Accept is not available yet (empty = it is). The ledger re-checks all of this at commit. */
export function acceptBlockers(p: Proposal, replaced = false): string[] {
  const out: string[] = [];
  if (p.state === "accepted") return ["Already accepted"];
  if (isClosed(p.state)) return [`Proposal is ${p.state}`];
  if (replaced) return ["A newer proposal replaced this one"];
  if (p.state !== "prepared") out.push("Candidates are still being prepared");
  if (p.stale.length) out.push("A base moved since this proposal was made (stale)");
  const v = validationSummary(p);
  if (v.verdict === "not-run") out.push("Validation has not run");
  if (v.verdict === "running") out.push("Validation is running");
  if (v.verdict === "outdated") out.push("Validation was for an earlier proposal identity");
  if (v.verdict === "failed") out.push("Validation failed");
  if (currentApprovals(p).length === 0) out.push("No approval for this identity yet");
  return out;
}

/** Is the result ready for a reviewer? Every proposal, assets-only included, needs a passing validation. */
function validated(p: Proposal): boolean {
  return validationSummary(p).verdict === "passed";
}

/**
 * The "Needs your decision" rule (plan §C.3: a badge, not a full Decision Inbox). Only the latest
 * proposal of a Change can need a decision: older ones were replaced (`replaced`).
 */
export function needsDecision(p: Proposal, role: Role, replaced = false): boolean {
  if (replaced || isClosed(p.state) || role === "viewer" || p.stale.length) return false;
  if (role === "client") return validated(p) && !currentApprovals(p).some((a) => a.role === "client");
  // owners and developers decide to validate, to resolve, or to accept
  return p.state === "prepared" && validationSummary(p).verdict !== "running";
}

// ------------------------------------------------------------------------------ change status

export type Tone = "neutral" | "busy" | "info" | "good" | "warn" | "bad" | "muted";

export interface ChangeStatus {
  label: string;
  tone: Tone;
  /** plan §A.6 Change state this maps to */
  stage: string;
}

export function proposalStatus(p: Proposal, replaced = false): ChangeStatus {
  if (p.state === "accepted") return { label: "Accepted", tone: "good", stage: "Accepted" };
  if (isClosed(p.state)) return { label: cap(p.state), tone: "muted", stage: "Rejected" };
  if (replaced) return { label: "Replaced by a newer proposal", tone: "muted", stage: "Superseded" };
  if (p.stale.length) return { label: "Stale — base moved", tone: "warn", stage: "Stale" };
  const v = validationSummary(p);
  if (v.verdict === "running") return { label: "Validating", tone: "busy", stage: "Integrating" };
  if (p.state === "open") return { label: "Preparing candidates", tone: "busy", stage: "Submitted" };
  if (v.verdict === "not-run") return { label: v.expired ? "Validation expired, run again" : "Ready to validate", tone: v.expired ? "warn" : "neutral", stage: "Submitted" };
  if (v.verdict === "outdated") return { label: "Needs re-validation", tone: "warn", stage: "Validating" };
  if (v.verdict === "failed") return { label: "Needs resolution", tone: "bad", stage: "NeedsResolution" };
  if (currentApprovals(p).length) return { label: "Approved", tone: "good", stage: "Approved" };
  return { label: "Ready for review", tone: "info", stage: "ReadyForReview" };
}

/** Status from a proposal summary alone (closed proposals are not fetched in full). */
export function summaryStatus(state: string): ChangeStatus {
  if (state === "accepted") return { label: "Accepted", tone: "good", stage: "Accepted" };
  if (isClosed(state)) return { label: cap(state), tone: "muted", stage: "Rejected" };
  return { label: "Checking…", tone: "muted", stage: "Submitted" };
}

export function taskStatus(state: TaskSummary["state"] | string): ChangeStatus {
  switch (state) {
    case "provisioning":
      return { label: "Preparing workspace", tone: "busy", stage: "Planned" };
    case "ready":
      return { label: "Waiting for an agent", tone: "neutral", stage: "Planned" };
    case "running":
      return { label: "Agent working", tone: "busy", stage: "Running" };
    case "submitted":
      return { label: "Submitted", tone: "info", stage: "Submitted" };
    case "failed":
      return { label: "Failed", tone: "bad", stage: "Failed" };
    default:
      return { label: cap(String(state)), tone: "muted", stage: "Canceled" };
  }
}

export interface ChangeRow {
  changeId: string;
  title: string;
  tasks: TaskSummary[];
  /** newest first; [0] is the latest proposal, the others were replaced by it */
  proposals: ProposalSummary[];
  updatedAt: string;
}

/** Group tasks (developers only) and proposals by Change; newest activity first. */
export function groupChanges(tasks: TaskSummary[], proposals: ProposalSummary[]): ChangeRow[] {
  const map = new Map<string, ChangeRow>();
  const row = (changeId: string): ChangeRow => {
    let r = map.get(changeId);
    if (!r) {
      r = { changeId, title: "", tasks: [], proposals: [], updatedAt: "" };
      map.set(changeId, r);
    }
    return r;
  };
  for (const t of tasks) {
    const r = row(t.changeId);
    r.tasks.push(t);
    if (!r.title) r.title = t.title;
    if (t.createdAt > r.updatedAt) r.updatedAt = t.createdAt;
  }
  for (const p of proposals) {
    const r = row(p.changeId);
    r.proposals.push(p);
    if (p.updatedAt > r.updatedAt) r.updatedAt = p.updatedAt;
  }
  for (const r of map.values()) {
    r.proposals.sort(newestFirst);
    if (!r.title) r.title = `Change ${shortId(r.changeId)}`;
  }
  return [...map.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/**
 * Newest CREATED first (Task 20 review n-3): `updatedAt` is the ledger's last mutation, so an older
 * proposal that finishes preparing late must not count as the latest. Falls back to `updatedAt`
 * only for servers that do not send `createdAt`.
 */
export function newestFirst(a: Pick<ProposalSummary, "createdAt" | "updatedAt" | "proposalId">, b: Pick<ProposalSummary, "createdAt" | "updatedAt" | "proposalId">): number {
  const ka = a.createdAt ?? a.updatedAt;
  const kb = b.createdAt ?? b.updatedAt;
  return ka < kb ? 1 : ka > kb ? -1 : a.proposalId < b.proposalId ? 1 : -1;
}

/** The latest proposal id of each Change; every other proposal of that Change was replaced. */
export function latestPerChange(proposals: ProposalSummary[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of [...proposals].sort(newestFirst)) if (!out.has(p.changeId)) out.set(p.changeId, p.proposalId);
  return out;
}

export function isReplaced(p: { proposalId: string; changeId: string; state: string }, latest: Map<string, string>): boolean {
  const id = latest.get(p.changeId);
  return p.state !== "accepted" && id !== undefined && id !== p.proposalId;
}

// ------------------------------------------------------------------------------- stale reasons

export interface StaleReason {
  resourceId: string;
  /** the accepted proposal that moved the resource, when the log shows it */
  byProposalId: string | null;
  at: string | null;
}

/** For each stale resource: which accepted proposal (if visible) moved it, and when. */
export function staleReasons(p: Proposal, events: EventView[], resourcesOf: (proposalId: string) => string[] | undefined): StaleReason[] {
  const accepted = events.filter((e) => e.action === "proposal.accepted" && e.subject.id !== p.proposalId && e.at >= p.createdAt);
  return p.stale.map((rid) => {
    const hit = [...accepted].reverse().find((e) => resourcesOf(e.subject.id)?.includes(rid));
    return { resourceId: rid, byProposalId: hit?.subject.id ?? null, at: hit?.at ?? null };
  });
}

// --------------------------------------------------------------------------- concurrency lanes

export type LaneMarkKind = "submitted" | "failed" | "passed" | "accepted" | "stale";

export interface LaneMark {
  at: number;
  kind: LaneMarkKind;
  label: string;
}

export interface Lane {
  /** unique per lane: the task id of an agent lane, `session:<id>` for a client edition session */
  key: string;
  /**
   * `agent`: a developer's agent task (from `task.started`). `session`: a client edition session
   * (from `edition.session_started`; UX-6): the client, or a tool working for them, edits a working
   * copy and sends it back, which opens a task and a proposal like an agent's.
   */
  kind: "agent" | "session";
  /** the agent's task; for a session, the task of its latest return (null until it sends one back) */
  taskId: string | null;
  /** sessions: the edition session id */
  sessionId?: string;
  /** sessions: who started it (a user id) */
  actorId?: string;
  /** sessions: the tool named on the latest return ("claude"), if any */
  tool?: string;
  /** sessions: when the latest edited copy was sent back */
  returnedAt?: number;
  changeId: string | null;
  title: string;
  startedAt: number;
  /** last candidate freeze (a session: also a return that ended without one); null while still working */
  frozenAt: number | null;
  freezes: number;
  marks: LaneMark[];
}

export interface Lanes {
  lanes: Lane[];
  start: number;
  end: number;
  /** the longest stretch with the highest number of sessions (agents and client updates) working at once */
  peak: { count: number; from: number; to: number } | null;
}

/**
 * A client session that never sent anything back stops counting as working after this long: the
 * server keeps sessions open (no close event), so an abandoned one would otherwise "work" forever.
 */
export const SESSION_ACTIVE_MS = 2 * 60 * 60 * 1000;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Lanes from `task.started` / `task.candidate_frozen` (the AT-05 overlap evidence), plus one lane
 * per client edition session (UX-6) from `edition.session_started` / `edition.returned` and the
 * freeze of the return's task. A renewed lease emits another `task.started`; the lane keeps its
 * first start. `proposalChange` maps a proposal id to its Change, so validation and acceptance
 * events land on the right lane. A session that never sent anything back is shown only while it is
 * younger than `SESSION_ACTIVE_MS`.
 */
export function concurrencyLanes(events: EventView[], tasks: TaskSummary[], now: number, proposalChange: (proposalId: string) => string | undefined = () => undefined): Lanes {
  const byTask = new Map(tasks.map((t) => [t.taskId, t]));
  const lanes = new Map<string, Lane>();
  /** a return's task → its session lane; a return id → its session lane */
  const laneOfTask = new Map<string, Lane>();
  const laneOfReturn = new Map<string, Lane>();
  const lanesOfChange = (changeId: string | undefined) => (changeId ? [...lanes.values()].filter((l) => l.changeId === changeId) : []);
  for (const e of events) {
    const at = Date.parse(e.at);
    if (e.action === "task.started") {
      if (!lanes.has(e.subject.id) && !laneOfTask.has(e.subject.id)) {
        const t = byTask.get(e.subject.id);
        lanes.set(e.subject.id, { key: e.subject.id, kind: "agent", taskId: e.subject.id, changeId: t?.changeId ?? null, title: t?.title ?? shortId(e.subject.id), startedAt: at, frozenAt: null, freezes: 0, marks: [] });
      }
    } else if (e.action === "edition.session_started") {
      const sid = str(e.detail?.sessionId);
      if (!sid || lanes.has(`session:${sid}`)) continue;
      lanes.set(`session:${sid}`, { key: `session:${sid}`, kind: "session", taskId: null, sessionId: sid, ...(e.actor.id ? { actorId: e.actor.id } : {}), changeId: null, title: str(e.detail?.title) ?? "Client update", startedAt: at, frozenAt: null, freezes: 0, marks: [] });
    } else if (e.action === "edition.returned") {
      const sid = str(e.detail?.sessionId);
      const lane = sid ? lanes.get(`session:${sid}`) : undefined;
      if (!lane) continue;
      const taskId = str(e.detail?.taskId);
      const rid = str(e.detail?.returnId);
      const tool = str(e.detail?.tool);
      lane.returnedAt = at;
      lane.marks.push({ at, kind: "submitted", label: "Sent back an edited copy" });
      if (tool) lane.tool = tool;
      if (rid) laneOfReturn.set(rid, lane);
      if (taskId) {
        lane.taskId = taskId;
        lane.changeId = byTask.get(taskId)?.changeId ?? lane.changeId;
        laneOfTask.set(taskId, lane);
        // working again until this return's candidate is frozen (or the return fails)
        lane.frozenAt = null;
      } else lane.frozenAt = at;
    } else if (e.action === "edition.return_failed" || e.action === "edition.return_empty") {
      const rid = str(e.detail?.returnId);
      const lane = rid ? laneOfReturn.get(rid) : undefined;
      if (!lane) continue;
      lane.frozenAt = Math.max(lane.frozenAt ?? 0, at);
      lane.marks.push({ at, kind: "failed", label: e.action === "edition.return_empty" ? "The returned copy had no changes" : "The returned copy could not be used" });
    } else if (e.action === "task.candidate_frozen") {
      const taskId = str(e.detail?.taskId);
      const lane = taskId ? (laneOfTask.get(taskId) ?? lanes.get(taskId)) : undefined;
      if (lane) {
        lane.frozenAt = Math.max(lane.frozenAt ?? 0, at);
        lane.freezes++;
        lane.marks.push({ at, kind: "submitted", label: "Submitted a candidate" });
      }
    } else if (e.action === "proposal.integration_failed" || e.action === "proposal.integrated" || e.action === "proposal.accepted") {
      const kind: LaneMarkKind = e.action === "proposal.integration_failed" ? "failed" : e.action === "proposal.integrated" ? "passed" : "accepted";
      const label = kind === "failed" ? "Validation found a problem" : kind === "passed" ? "Validation passed" : "Accepted";
      for (const l of lanesOfChange(proposalChange(e.subject.id))) l.marks.push({ at, kind, label });
    }
  }
  for (const [key, l] of lanes) {
    if (l.kind !== "session" || l.frozenAt !== null) continue;
    if (l.returnedAt === undefined) {
      // never sent back: active only while recent
      if (now - l.startedAt > SESSION_ACTIVE_MS) lanes.delete(key);
      continue;
    }
    // the return's task ended without a freeze event we saw (failed, canceled): the lane ends at the return
    const t = l.taskId ? byTask.get(l.taskId) : undefined;
    if (t && t.state !== "provisioning" && t.state !== "running") l.frozenAt = l.returnedAt;
  }
  const list = [...lanes.values()].sort((a, b) => a.startedAt - b.startedAt);
  if (!list.length) return { lanes: [], start: now, end: now, peak: null };
  const start = Math.min(...list.map((l) => l.startedAt));
  const end = Math.max(now, ...list.map((l) => l.frozenAt ?? now), ...list.flatMap((l) => l.marks.map((m) => m.at)));
  // sweep: +1 at start, −1 at last freeze (or now)
  const edges = list.flatMap((l) => [
    { t: l.startedAt, d: 1 },
    { t: l.frozenAt ?? now, d: -1 },
  ]);
  edges.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let peak: Lanes["peak"] = null;
  for (let i = 0; i < edges.length; i++) {
    cur += edges[i]!.d;
    const next = edges[i + 1]?.t;
    if (next === undefined || next <= edges[i]!.t) continue;
    if (cur >= 2 && (!peak || cur > peak.count || (cur === peak.count && next - edges[i]!.t > peak.to - peak.from))) peak = { count: cur, from: edges[i]!.t, to: next };
  }
  return { lanes: list, start, end, peak };
}

/**
 * Whether a lane is working now. An agent lane: its task is running or provisioning (a lane whose
 * task is not listed works until its first freeze). A session lane: no edited copy sent back yet, or
 * the latest return's task is still being turned into a candidate.
 */
export function laneWorking(lane: Lane, tasks: TaskSummary[]): boolean {
  const task = lane.taskId ? tasks.find((t) => t.taskId === lane.taskId) : undefined;
  if (lane.kind === "session") {
    if (lane.frozenAt !== null) return false;
    return !task || task.state === "running" || task.state === "provisioning";
  }
  return task ? task.state === "running" || task.state === "provisioning" : lane.frozenAt === null;
}

/** Add an amber "went stale" mark to the lanes of a Change whose latest proposal is stale. */
export function markStale(lanes: Lanes, changeId: string, at: number, label: string): void {
  for (const l of lanes.lanes) if (l.changeId === changeId) l.marks.push({ at, kind: "stale", label });
}

// ------------------------------------------------------------------------------------- diff

export type DiffOp = { op: "same" | "add" | "del"; text: string };

/** Line diff (LCS). Inputs over ~4M cell comparisons fall back to "all removed / all added". */
export function lineDiff(before: string, after: string): DiffOp[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // trim common prefix/suffix first: most edits are small
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const out: DiffOp[] = a.slice(0, pre).map((text) => ({ op: "same", text }));
  if (am.length * bm.length > 4_000_000) {
    for (const text of am) out.push({ op: "del", text });
    for (const text of bm) out.push({ op: "add", text });
  } else {
    const n = am.length;
    const m = bm.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      const row = lcs[i]!;
      const next = lcs[i + 1]!;
      for (let j = m - 1; j >= 0; j--) row[j] = am[i] === bm[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        out.push({ op: "same", text: am[i]! });
        i++;
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "del", text: am[i++]! });
      else out.push({ op: "add", text: bm[j++]! });
    }
    while (i < n) out.push({ op: "del", text: am[i++]! });
    while (j < m) out.push({ op: "add", text: bm[j++]! });
  }
  for (const text of a.slice(a.length - suf)) out.push({ op: "same", text });
  return out;
}

/** Collapse long unchanged runs to `context` lines around each change. */
export function collapseDiff(ops: DiffOp[], context = 3): Array<DiffOp | { op: "skip"; count: number }> {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out: Array<DiffOp | { op: "skip"; count: number }> = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: "skip", count: skipped });
      skipped = 0;
      out.push(o);
    } else skipped++;
  });
  if (skipped) out.push({ op: "skip", count: skipped });
  return out;
}

/** Extensions of files that are not text: images, media, archives, databases, compiled code, fonts, office documents. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|ico|heic|psd|mp4|mov|webm|mkv|avi|mp3|wav|ogg|flac|m4a|aac|zip|gz|tgz|bz2|xz|zst|7z|rar|tar|jar|war|apk|pdf|woff2?|ttf|otf|eot|wasm|bin|exe|dll|so|dylib|o|a|class|pyc|sqlite3?|db|parquet|docx?|xlsx?|pptx?)$/i;

export function looksLikeText(path: string): boolean {
  return !BINARY_EXT.test(path);
}

export function looksLikeImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(path);
}

// ------------------------------------------------------------------- Tasks board (staging phase 3)

/** The board's four columns (Working · In staging · Waiting for approval · Live). */
export type BoardColumn = "working" | "staging" | "waiting" | "live";
/** Where a task sits: a column, the collapsed "Rolled back" list, or off the board (null). */
export type BoardPlace = BoardColumn | "rolled_back" | null;

/** Promotion states from the request until production took it (Worker `IN_FLIGHT`, without `pending_approval`, which has its own column). */
const PROMOTION_GOING: readonly PromotionState[] = ["requested", "building", "gating", "cleared", "accepting", "releasing"];

type TaskFact = Pick<TaskSummary, "state"> | null | undefined;
type LandingFact = Pick<StagingLanding, "state"> & { reason?: string | null };
type PromotionFact = Pick<PromotionView, "state"> & { reason?: string | null; waitingForProduction?: boolean };

/**
 * The column of a task from its task state, its newest landing and that landing's newest promotion.
 * Working: no landing yet (the agent has not submitted, or its submit is on the way). In staging:
 * landing `checking`/`landed`/`failed`/`rolling_back`, with no promotion, one that is on its way
 * (`requested` … `releasing`) or one that ended without going live. Waiting for approval: promotion
 * `pending_approval`. Live: promotion `live`, or a `promoted` landing without a promotion. The
 * Worker moves the landings to `promoted` with the accept (`finishAccept`), while production is
 * still `releasing`, and keeps them `promoted` when the release fails (`release_failed`, retried):
 * such a landing stays In staging until its promotion is `live`. A rolled-back landing leaves the
 * columns; a canceled task without a landing is not shown.
 */
export function boardColumn(task: TaskFact, landing: LandingFact | null | undefined, promotion: PromotionFact | null | undefined): BoardPlace {
  if (landing) {
    if (landing.state === "rolled_back") return "rolled_back";
    if (landing.state === "promoted") return !promotion || promotion.state === "live" ? "live" : "staging";
    if (landing.state === "landed" || landing.state === "promoting") {
      if (promotion?.state === "pending_approval") return "waiting";
      if (promotion?.state === "live") return "live";
    }
    return "staging";
  }
  if (!task || task.state === "canceled") return null;
  return "working";
}

export interface CardState {
  /** the plain state line */
  line: string;
  tone: Tone;
  /** the platform's reason (or a developer's send-back note), when there is one */
  reason: string | null;
  /** the card's heading line above the title (waiting cards: "Production update pending approval") */
  heading: string | null;
  /** a promotion is on its way to production (requested … releasing) */
  going: boolean;
}

export const PENDING_PRODUCTION_HEADING = "Production update pending approval";

/** The card's state line, tone and reason for the same facts as {@link boardColumn}. */
export function cardState(task: TaskFact, landing: LandingFact | null | undefined, promotion: PromotionFact | null | undefined): CardState {
  const s = (line: string, tone: Tone, reason: string | null = null, extra: Partial<CardState> = {}): CardState => ({ line, tone, reason, heading: null, going: false, ...extra });
  if (!landing) {
    switch (task?.state) {
      case "provisioning":
        return s("Getting the workspace ready…", "busy");
      case "ready":
        return s("Ready for your agent", "neutral");
      case "running":
        return s("The agent is working", "busy");
      case "submitted":
        return s("Going to staging…", "busy");
      case "failed":
        return s("The task stopped before it finished", "bad");
      default:
        return s("Canceled", "muted");
    }
  }
  const landingReason = landing.reason ?? null;
  switch (landing.state as LandingState) {
    case "checking":
      return s("Getting ready on staging…", "busy");
    case "failed":
      return s("Couldn't land", "bad", landingReason);
    case "rolling_back":
      return s("Rolling back…", "busy");
    case "rolled_back":
      return s("Rolled back", "muted");
    case "promoted":
      // in `main`; live once production is (releasing, or a failed release that is retried, before)
      if (!promotion || promotion.state === "live") return s("Live", "good");
      break;
    default:
      break;
  }
  // landed, promoting, or promoted while production releases: the newest promotion decides
  const reason = promotion?.reason ?? null;
  if (!promotion) return landing.state === "promoting" ? s("Going to production…", "busy", null, { going: true }) : s("Live on staging", "info");
  if (PROMOTION_GOING.includes(promotion.state)) return s("Going to production…", "busy", reason, { going: true });
  switch (promotion.state) {
    case "pending_approval":
      return s("Waiting for a developer's approval", "warn", reason, { heading: PENDING_PRODUCTION_HEADING });
    case "live":
      return s("Live", "good");
    case "failed":
    case "release_failed":
      return s("Couldn't go live", "bad", reason);
    case "sent_back":
      return s("Sent back to staging", "warn", reason);
    case "withdrawn":
      return s("Live on staging · promotion withdrawn", "info");
    default:
      // superseded (a revision replaced it): back to plain staging
      return s("Live on staging", "info");
  }
}

/** Promote: live on staging and no promotion on its way or waiting. */
export function canPromoteLanding(landing: Pick<StagingLanding, "state"> | null | undefined, promotion: Pick<PromotionView, "state"> | null | undefined): boolean {
  if (landing?.state !== "landed") return false;
  return !promotion || !(PROMOTION_GOING.includes(promotion.state) || promotion.state === "pending_approval" || promotion.state === "release_failed");
}

/** Roll back: on staging (getting ready or live there) and not being promoted (Worker: `promotion_in_progress`). */
export function canRollBackLanding(landing: Pick<StagingLanding, "state"> | null | undefined, promotion: Pick<PromotionView, "state"> | null | undefined): boolean {
  if (landing?.state !== "landed" && landing?.state !== "checking") return false;
  return !promotion || !(PROMOTION_GOING.includes(promotion.state) || promotion.state === "pending_approval" || promotion.state === "release_failed");
}

/** Worker `BEFORE_ACCEPT`: the states a promotion can be withdrawn from. */
const WITHDRAWABLE: readonly PromotionState[] = ["requested", "building", "gating", "pending_approval", "cleared"];

/** Withdraw: the promotion is not accepted yet (Worker `withdrawPromotion`: any state before `accepting`). */
export function canWithdrawPromotion(promotion: Pick<PromotionView, "state"> | null | undefined): boolean {
  return !!promotion && WITHDRAWABLE.includes(promotion.state);
}

/** A promotion state the Promote follow-up stops polling at: ended, live, or waiting for a person. */
export function promotionSettled(state: PromotionState): boolean {
  return !PROMOTION_GOING.includes(state);
}

/**
 * Whether the board stops following a promotion it requested (it polls `GET /promotions/:id` every
 * 3 s to bridge the gap until the project poll names it): it settled; the project poll shows it in
 * the same state (the poll carries it from here); or it waits on something slow — cleared while
 * another promotion holds production, or releasing — that the project poll follows well enough.
 */
export function stopFollowing(followed: Pick<PromotionView, "state" | "waitingForProduction">, polled: Pick<PromotionView, "state"> | null | undefined): boolean {
  if (promotionSettled(followed.state)) return true;
  if (polled && polled.state === followed.state) return true;
  return (followed.state === "cleared" && followed.waitingForProduction) || followed.state === "releasing";
}

/**
 * The followed copy of a promotion the board shows instead of the project poll's: always while it
 * is followed; once following stopped, only until the project poll names the promotion or a poll
 * read after the stop arrives (the polled row wins from then on, so a later approval is not hidden
 * behind a stale copy).
 */
export function followedOverlay<P extends Pick<PromotionView, "promotionId">>(followed: P | null, o: { following: boolean; polled: boolean; pollAt: number; stoppedAt: number | null }): P | null {
  if (!followed) return null;
  if (o.following) return followed;
  if (o.polled) return null;
  if (o.stoppedAt !== null && o.pollAt > o.stoppedAt) return null;
  return followed;
}

export interface BoardCard {
  /** the task the card stands for (a landing's own task) */
  taskId: string;
  title: string;
  task: TaskSummary | null;
  landing: StagingLanding | null;
  /** the landing's newest promotion: the full view when readable, else its state from the staging view */
  promotion: (Pick<PromotionView, "promotionId" | "state"> & Partial<PromotionView>) | null;
  /** the viewer may act on it as its creator (clients: their own tasks; owners and developers: every task) */
  own: boolean;
  /** revision tasks staging could not add to this landing (`staging.revision_dropped`): shown muted on the card */
  droppedRevisions: Array<{ taskId: string; title: string }>;
  place: BoardPlace;
  state: CardState;
  createdAt: string;
}

/**
 * The board's cards from the tasks the viewer can list, the staging view's landings (newest first)
 * and the promotions the viewer can read. One card per landing (its task, with its revisions'
 * tasks folded in through `parts`) and one per task that has no landing yet. `own`: "all" for
 * owners and developers; a client passes the ids of the tasks they created (their task list).
 *
 * `dropped` (task id → landing id, from `staging.revision_dropped` events): a revision task whose
 * part staging dropped (Worker `dropNewParts`) is `submitted` with no landing and no part, forever;
 * it is not a Working card but a muted line on its landing's card ("couldn't be added to staging").
 * A dropped revision that is in a landing's parts again, or has its own landing, is shown as usual.
 * The task list carries no `revisesTaskId`, so the event is the only link back to the landing.
 */
export function boardCards(tasks: readonly TaskSummary[], landings: readonly StagingLanding[], promotions: readonly PromotionView[], own: "all" | ReadonlySet<string>, dropped: ReadonlyMap<string, string> = new Map()): BoardCard[] {
  const byPromotion = new Map(promotions.map((p) => [p.promotionId, p]));
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const seen = new Set<string>();
  const out: BoardCard[] = [];
  const ordered = [...landings].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const isOwn = (taskId: string) => own === "all" || own.has(taskId);
  for (const l of ordered) {
    // an older landing of a task that landed again, or a revision's part already shown
    if (seen.has(l.taskId)) continue;
    seen.add(l.taskId);
    for (const part of l.parts ?? []) seen.add(part.taskId);
    const view = l.promotion ? byPromotion.get(l.promotion.promotionId) : undefined;
    const promotion = l.promotion ? (view ?? { promotionId: l.promotion.promotionId, state: l.promotion.state }) : null;
    const task = taskById.get(l.taskId) ?? null;
    out.push({ taskId: l.taskId, title: task?.title || l.title, task, landing: l, promotion, own: isOwn(l.taskId), droppedRevisions: [], place: boardColumn(task, l, promotion), state: cardState(task, l, promotion), createdAt: l.createdAt });
  }
  const byLanding = new Map(out.map((c) => [c.landing!.landingId, c]));
  for (const t of tasks) {
    if (seen.has(t.taskId)) continue;
    const droppedFrom = t.state === "submitted" ? dropped.get(t.taskId) : undefined;
    if (droppedFrom !== undefined) {
      byLanding.get(droppedFrom)?.droppedRevisions.push({ taskId: t.taskId, title: t.title });
      continue;
    }
    const place = boardColumn(t, null, null);
    if (place === null) continue;
    out.push({ taskId: t.taskId, title: t.title, task: t, landing: null, promotion: null, own: isOwn(t.taskId), droppedRevisions: [], place, state: cardState(t, null, null), createdAt: t.createdAt });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Revision tasks staging dropped from a landing: task id → landing id, from `staging.revision_dropped` events. */
export function droppedRevisions(events: readonly Pick<EventView, "action" | "subject" | "detail">[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.action !== "staging.revision_dropped") continue;
    const landingId = e.detail?.landingId;
    if (typeof landingId === "string" && landingId) out.set(e.subject.id, landingId);
  }
  return out;
}
