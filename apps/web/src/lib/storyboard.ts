/**
 * The developer Change storyboard (UX-4, mockup `developer-change-storyboard`): pure derivations
 * from a proposal, its release and its Change. No React, no I/O: unit-tested directly.
 *
 * Everything here comes from data the Worker already returns: nothing is assumed or decorative.
 * Where the platform has no data (agent transcripts, a repair dispatcher), the storyboard says so
 * instead of offering a button.
 */
import type { AcceptedHeadView, EventView, MemberView, Project, Proposal, ReleaseView, TaskSummary } from "../api/types.js";
import { DEVELOPER_STEPS, railPosition, type RailPosition } from "../primitives/state.js";
import { basename, currentApprovals, failureSentence, hasCodeChanges, shortCode, isClosed, proposalStatus, revisionLabel, validationSummary, type ValidationSummary } from "./model.js";

export type StepKey = "request" | "work" | "check" | "review" | "approve" | "accept" | "publish" | "live";
export const STEP_KEYS: readonly StepKey[] = ["request", "work", "check", "review", "approve", "accept", "publish", "live"];

/** What the storyboard knows besides the proposal itself. */
export interface StoryFacts {
  /** a newer proposal of the same Change replaced this one */
  replaced: boolean;
  /** a private preview of this exact identity is ready */
  previewReady: boolean;
  /** the release of this proposal's accepted version (null: none, or not accepted) */
  release: ReleaseView | null;
}

const PUBLISH_PROBLEM: ReadonlySet<string> = new Set(["failed", "partial", "recovery_required"]);

/** Where the Change stands on the eight-step rail. */
export function storyPosition(p: Proposal, facts: StoryFacts): RailPosition {
  // a closed (withdrawn, rejected) proposal stays where it stopped, greyed out, like a replaced one
  const closed = isClosed(p.state) && p.state !== "accepted";
  // candidates still being prepared: the agents' Work is not finished yet (review m-3)
  if (p.state === "open") return { current: 1, state: facts.replaced ? "superseded" : "working", complete: false };
  const rel = facts.release;
  // review I-1: this release was live and a newer one replaced it: Live, greyed out
  if (rel && !rel.live && rel.state === "live") return { current: 7, state: "superseded", complete: false };
  const stage = proposalStatus(closed ? { ...p, state: "prepared" } : p).stage;
  const rolling = rollingBack(rel);
  const pos = railPosition("developer", stage, {
    live: !!rel?.live,
    publishing: rel?.state === "deploying" || rel?.state === "health_verification" || rolling,
    publishFailed: !!rel && !rel.live && !rolling && (PUBLISH_PROBLEM.has(rel.state) || rel.buildState === "failed"),
    publishApproved: !!rel && !rel.live && rel.state === "publish_approved",
    reviewReady: facts.previewReady || !hasCodeChanges(p),
  });
  return facts.replaced || closed ? { ...pos, state: "superseded" } : pos;
}

/** Production is being rolled back to the previous release (the server says "Not verified, rolling back"). */
export function rollingBack(rel: ReleaseView | null | undefined): boolean {
  return rel?.rollback?.state === "running" || rel?.rollback?.state === "verifying";
}

/** This proposal's release was live and a newer release has replaced it in production. */
export function supersededRelease(rel: ReleaseView | null | undefined): boolean {
  return !!rel && !rel.live && rel.state === "live";
}

export function stepKey(pos: RailPosition): StepKey {
  return pos.complete ? "live" : (STEP_KEYS[pos.current] ?? "request");
}

export function stepName(key: StepKey): string {
  return DEVELOPER_STEPS[STEP_KEYS.indexOf(key)] ?? key;
}

// ------------------------------------------------------------------------------ evidence chips

export interface EvidenceChipModel {
  key: string;
  result: "pass" | "fail" | "warn" | "pending" | "neutral";
  /** e.g. "Merge clean · 3 repositories" */
  lead: string;
  /** a contract or check id shown in the mono font */
  code?: string;
  /** what follows the code, e.g. "failed" */
  after?: string;
  /** one plain-language cause */
  cause?: string;
  testId?: string;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The evidence of the last validation as chips: merge, each contract, the checks, the scope. A
 * failing contract carries `contract-fail-chip` (the 4:00 hero) and one plain cause.
 */
export function evidenceChips(p: Proposal, v: ValidationSummary, project: Project, nameOf: (rid: string) => string): EvidenceChipModel[] {
  if (v.verdict === "running") return [{ key: "running", result: "pending", lead: "The integration runner is combining the candidates and running the checks" }];
  if (v.verdict === "not-run" || v.items.length === 0) {
    if (v.verdict === "passed") return [{ key: "passed", result: "pass", lead: "Validation passed · the project has no checks or contracts" }, ...scopeChip(p, project)];
    return [{ key: "not-run", result: "neutral", lead: v.expired ? "The last validation expired without an answer" : "Not validated yet" }, ...scopeChip(p, project)];
  }
  const out: EvidenceChipModel[] = [];
  const merges = v.items.filter((i) => i.kind === "merge");
  if (merges.length) {
    const bad = merges.filter((m) => m.result !== "pass");
    out.push(bad.length ? { key: "merge", result: "fail", lead: `Merge conflict in ${bad.map((b) => nameOf(b.id)).join(", ")}`, ...(bad[0]?.paths?.length ? { cause: bad[0].paths.join(", ") } : {}) } : { key: "merge", result: "pass", lead: `Merge clean · ${plural(merges.length, "repository", "repositories")}` });
  } else if (!hasCodeChanges(p)) out.push({ key: "merge", result: "neutral", lead: "Nothing to merge · assets only" });
  const contracts = p.lastAttempt?.contractChecks ?? [];
  let failTagged = false;
  for (const c of v.items.filter((i) => i.kind === "contract")) {
    const wire = contracts.find((x) => x.contractId === c.id);
    const producer = wire?.producerResource ? nameOf(wire.producerResource) : null;
    const consumer = wire?.consumerResource ? nameOf(wire.consumerResource) : null;
    if (c.result === "fail") {
      const cause = producer && consumer ? `${producer} response no longer matches what ${consumer} expects` : "the parts of the project no longer agree on it";
      out.push({ key: `contract-${c.id}`, result: "fail", lead: "Contract", code: c.id, after: "failed", cause, ...(failTagged ? {} : { testId: "contract-fail-chip" }) });
      failTagged = true;
    } else out.push({ key: `contract-${c.id}`, result: "pass", lead: "Contract", code: c.id, after: "holds" });
  }
  const checks = v.items.filter((i) => i.kind === "check");
  if (checks.length) {
    const ran = checks.filter((c) => c.result !== "skipped");
    const passed = ran.filter((c) => c.result === "pass").length;
    const skipped = checks.length - ran.length;
    out.push({ key: "checks", result: passed === ran.length ? "pass" : "fail", lead: `Checks ${passed} of ${ran.length}${skipped ? ` · ${skipped} skipped` : ""}` });
  }
  return [...out, ...scopeChip(p, project, v)];
}

/**
 * Scope from data: every candidate is on a resource the project mounts for writing (agents only get
 * tokens on task forks of those), and the runner did not stop the run as a scope violation.
 */
function scopeChip(p: Proposal, project: Project, v?: ValidationSummary): EvidenceChipModel[] {
  if (v?.code === "scope_violation") return [{ key: "scope", result: "fail", lead: "Scope: the run tried something it is not allowed to" }];
  const writable = new Set(project.mounts.filter((m) => m.operations.includes("write")).map((m) => m.resourceId));
  const touched = [...p.resourceChanges.map((r) => r.resourceId), ...p.assetManifestChanges.map((a) => a.resourceId)];
  if (!touched.length) return [];
  const outside = touched.filter((r) => !writable.has(r));
  return outside.length ? [{ key: "scope", result: "warn", lead: `Scope: ${plural(outside.length, "resource")} not writable in this project` }] : [{ key: "scope", result: "pass", lead: "Scope: every edit is in a writable resource" }];
}

// --------------------------------------------------------------------------------- review brief

export interface ResourceCardModel {
  resourceId: string;
  name: string;
  kind: "code" | "assets";
  /** "3 files · index.html, quote.ts, quote.test.ts" or "New asset manifest" */
  summary: string;
  /** who made it: "Claude agent", "Client edition" */
  by: string | null;
  /** amber protected-surface flag, e.g. "Protected surface: API contract quote-schema" */
  protected: string | null;
}

/** Who submitted a candidate, in words. Edition returns are submitted by a person (the client). */
export function submitterLabel(c: { submitter: { kind: string }; tool?: string | undefined }): string {
  if (c.submitter.kind === "agent") return c.tool ? `${c.tool[0]!.toUpperCase()}${c.tool.slice(1)} agent` : "Agent";
  if (c.submitter.kind === "user") return c.tool && c.tool !== "edition-zip" ? `Client edition, edited in ${c.tool[0]!.toUpperCase()}${c.tool.slice(1)}` : "Client edition";
  return c.submitter.kind;
}

const CONTRACT_PATH = /(^|\/)contracts?\/|\.schema\.json$/i;

/**
 * What changed, one card per resource. A resource is a protected surface when it produces a
 * contract the project checks (its response shape is what others rely on), or when the change
 * edits a contract definition file.
 */
export function resourceCards(p: Proposal, nameOf: (rid: string) => string): ResourceCardModel[] {
  const producers = new Map<string, string[]>();
  for (const c of p.lastAttempt?.contractChecks ?? []) if (c.producerResource) producers.set(c.producerResource, [...(producers.get(c.producerResource) ?? []), c.contractId]);
  const code = p.resourceChanges.map((rc): ResourceCardModel => {
    const cand = p.candidates.find((c) => c.candidateId === rc.candidateId);
    const paths = cand?.changedPaths ?? [];
    const names = paths.map(basename);
    const shown = names.slice(0, 3).join(", ") + (names.length > 3 ? ` and ${names.length - 3} more` : "");
    const contracts = producers.get(rc.resourceId);
    const editsContract = paths.some((x) => CONTRACT_PATH.test(x));
    return {
      resourceId: rc.resourceId,
      name: nameOf(rc.resourceId),
      kind: "code",
      summary: paths.length ? `${plural(paths.length, "file")} · ${shown}` : "Changed",
      by: cand ? submitterLabel(cand) : null,
      protected: contracts ? `Protected surface: produces the ${contracts.join(", ")} contract` : editsContract ? "Protected surface: edits a contract definition" : null,
    };
  });
  const assets = p.assetManifestChanges.map((ac): ResourceCardModel => ({ resourceId: ac.resourceId, name: nameOf(ac.resourceId), kind: "assets", summary: "New asset manifest · files stay in R2, outside Git", by: null, protected: null }));
  return [...code, ...assets];
}

/** Verified: one line per merge, contract and check, from the runner's signed evidence. */
export function verifiedLines(v: ValidationSummary, candidates: number): Array<{ text: string; ok: boolean; code?: string }> {
  if (v.verdict === "running" || v.verdict === "not-run") return [];
  const out: Array<{ text: string; ok: boolean; code?: string }> = [];
  const merges = v.items.filter((i) => i.kind === "merge");
  if (merges.length) out.push({ text: `Merge of ${plural(candidates, "candidate")}: ${merges.every((m) => m.result === "pass") ? "clean" : "conflict"}`, ok: merges.every((m) => m.result === "pass") });
  for (const i of v.items) {
    if (i.kind === "contract") out.push({ text: `: ${i.result === "pass" ? "holds" : "fails"}`, code: i.id, ok: i.result === "pass" });
    else if (i.kind === "check" && i.result !== "skipped") out.push({ text: `${i.label.replace(/ pass$/, "")}: ${i.result === "pass" ? "pass" : "fail"}`, ok: i.result === "pass" });
  }
  if (v.verdict === "outdated") out.push({ text: "These results are for an earlier identity and do not count", ok: false });
  return out;
}

/** Not verified: what the runner did not (or cannot) check for this result. */
export function notVerifiedLines(p: Proposal, v: ValidationSummary, nameOf: (rid: string) => string): string[] {
  const out: string[] = [];
  if (v.verdict === "not-run" || v.verdict === "running") out.push("Nothing yet: validation has not finished for this identity.");
  const skipped = v.items.filter((i) => i.kind === "check" && i.result === "skipped").map((i) => i.label.replace(/ pass$/, ""));
  if (skipped.length) out.push(`Skipped, nothing they cover changed: ${skipped.join(", ")}.`);
  if (p.assetManifestChanges.length) out.push(`The new files in ${[...new Set(p.assetManifestChanges.map((a) => nameOf(a.resourceId)))].join(", ")} are not checked by the runner; look at them in the preview.`);
  if (hasCodeChanges(p) && !currentApprovals(p).length && p.state !== "accepted") out.push("How it looks and feels: a person still has to try the preview.");
  out.push("Agents' own test claims never count as evidence; only the runner's signed results do.");
  return out;
}

/** Your decision: what the developer decides at this step, in one or two sentences. */
export function decisionSentence(step: StepKey, p: Proposal, v: ValidationSummary, facts: StoryFacts): string {
  if (facts.replaced) return "Nothing to decide here: a newer proposal replaced this one. Review the latest.";
  if (p.stale.length || v.code === "stale_base") return "Rebuild it on the latest version: this result cannot be accepted. Accept and publish stay locked.";
  if (isClosed(p.state) && p.state !== "accepted") return `Nothing to decide: this proposal is ${p.state}.`;
  switch (step) {
    case "request":
    case "work":
      return "Nothing yet: wait for the agents to submit their candidates.";
    case "check":
      if (v.verdict === "failed") return "Repair is required before review. Accept and publish stay locked until every check passes and the result is approved.";
      if (v.verdict === "running") return "Wait for the runner. Nothing is accepted until its evidence passes.";
      return "Run validation: the combined result has to pass the project's checks and contracts before anyone reviews it.";
    case "review":
      return "Build a private preview so the result can be tried with test data. Then it waits for an approval of this exact identity.";
    case "approve":
      return "An approval of this exact identity is next: the client approves the preview, or you approve it yourself. Accept stays locked until then.";
    case "accept":
      return "Accept records a new version in the ledger. It does not publish: production is unchanged until a separate publish approval.";
    case "publish":
      if (rollingBack(facts.release)) return "The release did not pass its check: production is being rolled back to the previous release. Wait for the rollback to finish.";
      return facts.release?.state === "publish_approved" ? "Publishing is approved but not live. Publish to production when you are ready." : "Publishing is a separate decision: prepare a release, get its publish approval, then publish.";
    case "live":
      return supersededRelease(facts.release) ? "Nothing to decide: this version was live, and a newer release has replaced it in production." : "Nothing to decide: this version is live and its health check passed.";
  }
}

// ----------------------------------------------------------------------------- repair handover

/**
 * A plain-text brief for the developer's repair agent (copied to the clipboard): there is no
 * repair dispatcher in the platform, so the honest action is a handover the developer pastes into
 * the agent's session. Its resubmission becomes a new proposal and is validated again.
 */
export function repairBrief(p: Proposal, v: ValidationSummary, title: string, nameOf: (rid: string) => string): string {
  const rebuild = v.code === "stale_base" || p.stale.length > 0;
  const lines = [`${rebuild ? "Rebuild" : "Repair"}: ${title}`, "", `${failureSentence(v.code)}.`, ...v.failures.map((f) => `- ${f}`)];
  const touched = [...new Set(p.candidates.map((c) => `${nameOf(c.resourceId)}: ${c.changedPaths.join(", ")}`))];
  if (touched.length) lines.push("", "Changed in this proposal:", ...touched.map((t) => `- ${t}`));
  if (p.lastAttempt?.detail) lines.push("", "Runner output:", p.lastAttempt.detail);
  lines.push("", rebuild ? "Rebuild these changes on the latest accepted version and submit again. The new submission becomes a new proposal and runs the same checks and contracts." : "Fix it on the current accepted version and submit again. The new submission becomes a new proposal and runs the same checks and contracts.");
  return lines.join("\n");
}

// -------------------------------------------------------------------------------------- agents

export interface AgentCardModel {
  key: string;
  /** "Claude agent", "Client edition" */
  who: string;
  /** "developer" / "client edition" */
  role: string;
  title: string;
  status: { label: string; state: "working" | "ready" | "blocked" | "neutral" };
  /** "6 min 12 s" (null: unknown) */
  elapsed: string | null;
  detail: string;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * The agents (and people) on this Change: one card per agent task, from its `task.started` to its
 * last candidate (or now), plus one per edition return. Transcripts are not recorded by the
 * platform, so no card links to one.
 */
export function agentCards(p: Proposal, tasks: TaskSummary[], events: EventView[], nameOf: (rid: string) => string, now: number): AgentCardModel[] {
  const mine = tasks.filter((t) => t.changeId === p.changeId);
  const cards: AgentCardModel[] = mine.map((t) => {
    const started = events.find((e) => e.action === "task.started" && e.subject.id === t.taskId);
    const frozen = events.filter((e) => e.action === "task.candidate_frozen" && e.detail?.taskId === t.taskId);
    const last = frozen.length ? Math.max(...frozen.map((e) => Date.parse(e.at))) : null;
    const cands = p.candidates.filter((c) => c.submitter.kind === "agent" && (c.submitter.id ?? "").startsWith(`${t.taskId}:`));
    const tool = cands.find((c) => c.tool)?.tool;
    const files = cands.reduce((n, c) => n + c.changedPaths.length, 0);
    const res = [...new Set(cands.map((c) => nameOf(c.resourceId)))];
    const running = t.state === "running" || t.state === "provisioning";
    const end = running || last === null ? now : last;
    return {
      key: t.taskId,
      who: tool ? `${tool[0]!.toUpperCase()}${tool.slice(1)} agent` : "Agent",
      role: "developer",
      title: t.title,
      status: running ? { label: "Working", state: "working" } : t.state === "failed" ? { label: "Failed", state: "blocked" } : t.state === "submitted" ? { label: "Submitted", state: "ready" } : { label: "Waiting for an agent", state: "neutral" },
      elapsed: started ? duration(end - Date.parse(started.at)) : null,
      detail: res.length ? `${plural(files, "file")} in ${res.join(" + ")}${frozen.length > 1 ? ` · ${frozen.length} submissions` : ""}` : `${frozen.length ? plural(frozen.length, "submission") : "No submission yet"}`,
    };
  });
  const people = p.candidates.filter((c) => c.submitter.kind === "user");
  if (people.length) {
    const files = people.reduce((n, c) => n + c.changedPaths.length, 0);
    const tool = people.find((c) => c.tool && c.tool !== "edition-zip")?.tool;
    cards.push({
      key: "edition",
      who: "Client",
      role: "client edition",
      title: tool ? `Edited in ${tool[0]!.toUpperCase()}${tool.slice(1)}` : "Edited their working copy",
      status: { label: "Returned", state: "ready" },
      elapsed: null,
      detail: `${plural(files, "file")} taken over in ${[...new Set(people.map((c) => nameOf(c.resourceId)))].join(" + ")}`,
    });
  }
  return cards;
}

/** "Requested by dev@agency.example (developer)": the person who created the Change's first task. */
export function requestedBy(p: Proposal, tasks: TaskSummary[], events: EventView[], members: MemberView[] | undefined): string {
  const taskIds = new Set(tasks.filter((t) => t.changeId === p.changeId).map((t) => t.taskId));
  const created = events.find((e) => e.action === "task.created" && taskIds.has(e.subject.id));
  const fromEdition = p.candidates.some((c) => c.submitter.kind === "user");
  const id = created?.actor.id;
  const m = id ? members?.find((x) => x.userId === id) : undefined;
  if (m) return `Requested by ${m.email} (${m.role})`;
  if (created) return "Requested by a developer";
  if (fromEdition) return "Requested by the client";
  return "Requested by a developer";
}

// --------------------------------------------------------------------------- release receipt

export type ReceiptState = "ready-for-review" | "approved-not-accepted" | "accepted" | "release-pending" | "approved-not-live" | "publishing" | "rolling-back" | "failed" | "live" | "superseded";

export interface ReceiptModel {
  state: ReceiptState;
  /** "Ready for review", "Approved, not live", "Deployment failed", "Live", … */
  label: string;
  badge: "ready" | "decision" | "blocked" | "working" | "neutral";
  rows: Array<{ label: string; value: string; tone?: "good" | "bad" | "warn" }>;
}

/**
 * The Release Receipt (research P07): one card that binds the accepted version, the build digest,
 * the target, the version observed live, and health. Badges per the brief: "Ready for review",
 * "Approved, not live", "Deployment failed", "Live".
 */
export function releaseReceipt(p: Proposal, rel: ReleaseView | null, opts: { versionOf: (acceptedVersionId: string | null | undefined) => number | null; acceptedVersionId: string | null; live: { acceptedVersionId: string } | null; now?: Date }): ReceiptModel {
  const vNum = opts.versionOf(rel?.acceptedVersionId ?? opts.acceptedVersionId);
  const versionText = p.state === "accepted" ? (vNum ? `Version ${vNum}` : "Accepted (a new version)") : "Not accepted yet";
  const liveNum = opts.live ? opts.versionOf(opts.live.acceptedVersionId) : null;
  const mine = rel?.acceptedVersionId ?? opts.acceptedVersionId;
  const isThis = !!opts.live && !!mine && opts.live.acceptedVersionId === mine;
  // review I-1: name the live release by where it stands relative to this one
  const relation = liveNum && vNum ? (liveNum > vNum ? "a newer release" : "the previous release") : p.state === "accepted" ? "another release" : "the release live today";
  const observed = !opts.live ? "Nothing is live yet" : isThis ? `${liveNum ? `Version ${liveNum}` : "This version"} (this release)` : `${liveNum ? `Version ${liveNum}` : "Another version"} (${relation})`;
  const digest = rel?.outputDigest ? `built · ${shortCode(rel.outputDigest)}` : rel?.buildState === "building" ? "building…" : rel?.buildState === "failed" ? "build failed" : "not built yet";
  const targets = rel?.deployments.length ? rel.deployments.map((d) => d.targetId).join(", ") : rel?.targets?.length ? rel.targets.map((t) => t.targetId).join(", ") : "set when a release is prepared";
  const health = rel?.health ? (rel.health.ok ? "Healthy · version check passed" : "Version check failed") : rel?.live ? "Healthy" : "Not checked yet";
  const rows: ReceiptModel["rows"] = [
    { label: "Accepted version", value: versionText },
    { label: "Build", value: digest, ...(rel?.buildState === "failed" ? { tone: "bad" as const } : {}) },
    { label: "Target", value: targets },
    { label: "Observed live", value: observed, ...(isThis ? { tone: "good" as const } : {}) },
    { label: "Health", value: health, ...(rel?.health ? { tone: rel.health.ok ? ("good" as const) : ("bad" as const) } : {}) },
  ];
  if (p.state !== "accepted") return currentApprovals(p).length ? { state: "approved-not-accepted", label: "Approved, not accepted", badge: "decision", rows } : { state: "ready-for-review", label: "Ready for review", badge: "decision", rows };
  if (!rel) return { state: "accepted", label: "Accepted, not published", badge: "neutral", rows };
  if (rel.live) return { state: "live", label: "Live", badge: "ready", rows };
  if (supersededRelease(rel)) return { state: "superseded", label: "Was live, replaced by a newer release", badge: "neutral", rows };
  if (rollingBack(rel)) return { state: "rolling-back", label: rel.status || "Not verified, rolling back", badge: "working", rows };
  if (rel.state === "deploying" || rel.state === "health_verification") return { state: "publishing", label: rel.state === "deploying" ? "Deploying" : "Checking the live version", badge: "working", rows };
  if (PUBLISH_PROBLEM.has(rel.state) || rel.buildState === "failed") return { state: "failed", label: rel.buildState === "failed" ? "Build failed" : rel.rollback?.state === "done" ? "Deployment failed · previous release live again" : "Deployment failed", badge: "blocked", rows };
  if (rel.publishApproved) return { state: "approved-not-live", label: "Approved, not live", badge: "decision", rows };
  return { state: "release-pending", label: rel.status || "Waiting for a publish approval", badge: "neutral", rows };
}

// ------------------------------------------------------------------------------ ledger codes

/**
 * What accept would answer right now, as the Worker's refusal codes (API.md, routes/proposals.ts),
 * for the inspector. Accepted or closed proposals have no code: the inspector says so in words.
 */
export function ledgerCodes(p: Proposal): string[] {
  if (isClosed(p.state)) return [];
  if (p.state !== "prepared") return ["proposal_not_prepared"];
  const out = new Set<string>();
  const written = new Set([...p.resourceChanges.map((r) => r.resourceId), ...p.assetManifestChanges.map((a) => a.resourceId)]);
  for (const rid of p.stale) out.add(written.has(rid) ? "expected_head_stale" : "dependency_stale");
  const v = validationSummary(p);
  if (p.lastAttempt?.state === "applying") out.add("integration_applying");
  else if (v.verdict === "failed" && v.code === "receipt_not_recorded") out.add("receipt_not_recorded");
  else if (v.verdict !== "passed") out.add("evidence_missing");
  if (!currentApprovals(p).length) out.add("approval_invalid");
  return [...out];
}

/** "website 1a2b3c4 · frozen" lines for the inspector. */
export function candidateLines(p: Proposal, mountOf: (rid: string) => string, providerOf: (rid: string) => string = () => ""): Array<{ label: string; value: string; copy: string }> {
  const label = (rid: string) => (providerOf(rid) ? `${mountOf(rid)} · ${providerOf(rid)}` : mountOf(rid));
  return [
    ...p.resourceChanges.map((rc) => {
      const c = p.candidates.find((x) => x.candidateId === rc.candidateId);
      return { label: label(rc.resourceId), value: `${revisionLabel(rc.candidateRevision)} · ${c?.state === "prepared" ? "frozen, prepared" : (c?.state ?? "frozen")}`, copy: rc.candidateRevision };
    }),
    ...p.assetManifestChanges.map((ac) => ({ label: label(ac.resourceId), value: `manifest ${shortCode(ac.newManifestId)} · frozen`, copy: ac.newManifestId })),
  ];
}

/** "website · api · requirements: synced" from each touched resource's accepted head. */
export function canonicalRefs(p: Proposal, heads: Record<string, AcceptedHeadView | null> | undefined, mountOf: (rid: string) => string): string {
  if (!heads) return "loading…";
  const ids = [...new Set([...p.resourceChanges.map((r) => r.resourceId), ...p.readDependencies.flatMap((d) => ("redacted" in d ? [] : [d.resourceId]))])].filter((r) => r in heads);
  if (!ids.length) return "no Git resources";
  const groups = new Map<string, string[]>();
  for (const r of ids) {
    const state = heads[r]?.reconciliation ?? "no accepted head";
    groups.set(state, [...(groups.get(state) ?? []), mountOf(r)]);
  }
  return [...groups.entries()].map(([state, names]) => `${names.join(" · ")}: ${state}`).join("; ");
}

/** The validation evidence as JSON (the inspector's "Download evidence JSON"). */
export function evidenceJson(p: Proposal): string {
  return JSON.stringify({ proposalId: p.proposalId, proposalHash: p.proposalHash, changeId: p.changeId, baseSnapshotId: p.baseSnapshotId, candidateSnapshotId: p.candidateSnapshotId, lastAttempt: p.lastAttempt, integration: p.integration }, null, 2);
}
