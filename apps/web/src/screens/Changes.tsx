/**
 * Changes: every Change with its live status, the agents working on it, and what happened.
 * - "Agents at work" is a coordination timeline: one lane per agent task (agent tool, task, the
 *   resources it writes), from `task.started` to its last candidate, with markers for validation
 *   failures and passes, acceptance, and the moment a Change went stale because another was
 *   accepted first.
 * - Stale Changes get a callout that says why, that nothing was overwritten, and what to do next.
 * - Activity is grouped by Change, with named actors and the approve → accept trail.
 * - Outside staging, owners and developers start a New task here and hand it to an agent; each task
 *   says where its agent is, and once it is submitted, Make proposal turns its work into a proposal
 *   (Worker `POST /orgs/:org/proposals`), which is then validated and accepted as usual.
 */
import { useCallback, useState } from "react";
import type { CreateTaskInput, EventView, MemberView, Project, Proposal, ProposalKind, Role, TaskSummary, TaskView } from "../api/types.js";
import { agentLine, openForAgent } from "../lib/handoff.js";
import { useApp } from "../lib/hooks.js";
import { storyPosition, supersededRelease } from "../lib/storyboard.js";
import type { Tone } from "../lib/model.js";
import { releaseFor } from "./ReleasePanels.js";
import {
  concurrencyLanes,
  failureSentence,
  formatTime,
  groupChanges,
  isClosed,
  isDeveloperRole,
  isReplaced,
  laneWorking,
  markStale,
  needsDecision,
  proposalStatus,
  shortId,
  staleReasons,
  summaryStatus,
  taskStatus,
  type ChangeRow,
  type Lane,
  type LaneMark,
  type Lanes,
  type StaleReason,
} from "../lib/model.js";
import { navigate, promotionHref, proposalHref } from "../lib/router.js";
import { duration } from "../lib/storyboard.js";
import { DEVELOPER_STEPS, EmptyState, Icon, railPosition, StateRail, type RailPosition } from "../primitives/index.js";
import { Card, DecisionBadge, errorMessage, Link, Loading, Pill } from "../ui.js";
import { TaskHandoffLoader, useHandoffContext, type HandoffContext } from "./AgentHandoff.js";
import { NewTaskSheet } from "./NewTaskSheet.js";
import { mountNameOf, policyStaging, routedProposal, useProject, type LiveState } from "./project-data.js";


function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

export function joinAnd(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

export function resourceName(project: Project, rid: string): string {
  return project.mounts.find((m) => m.resourceId === rid)?.resourceName ?? mountNameOf(project, rid);
}

export function proposalResources(p: Proposal): string[] {
  return [...new Set([...p.resourceChanges.map((r) => r.resourceId), ...p.assetManifestChanges.map((a) => a.resourceId)])];
}

export function changeAreas(project: Project, p: Proposal | undefined): string[] {
  return p ? proposalResources(p).map((id) => resourceName(project, id)) : [];
}

/** Clients never see task titles: name the Change by the areas it affects. */
export function clientChangeTitle(project: Project, p: Proposal | undefined, changeId: string): string {
  const areas = changeAreas(project, p);
  return areas.length ? `Update to ${joinAnd(areas)}` : `Update ${shortId(changeId)}`;
}

/** A stable colour per resource, so two lanes that write the same resource share a chip colour. */
export function ResourceChip({ project, resourceId }: { project: Project; resourceId: string }) {
  const i = Math.max(0, project.mounts.findIndex((m) => m.resourceId === resourceId));
  return <span className={`chip chip-${i % 6}`}>{resourceName(project, resourceId)}</span>;
}

/** Everything the Changes screen derives from the live state, shared by its parts. */
export interface ChangeContext {
  project: Project;
  role: Role;
  live: LiveState;
  rows: ChangeRow[];
  titleOf: (changeId: string) => string;
  latestOf: (changeId: string) => Proposal | undefined;
  changeOfProposal: (proposalId: string) => string | undefined;
  staleOf: (p: Proposal) => StaleReason[];
}

export function changeContext(live: LiveState, project: Project, role: Role): ChangeContext {
  const rows = groupChanges(live.tasks, live.proposals);
  const byChange = new Map(rows.map((r) => [r.changeId, r]));
  const changeOfProposal = (id: string) => live.proposals.find((p) => p.proposalId === id)?.changeId;
  const latestOf = (changeId: string) => {
    const id = live.latest.get(changeId);
    return id ? live.details[id] : undefined;
  };
  const titleOf = (changeId: string) => (isDeveloperRole(role) && byChange.get(changeId)?.tasks.length ? byChange.get(changeId)!.title : clientChangeTitle(project, latestOf(changeId), changeId));
  const resourcesOf = (proposalId: string) => {
    const d = live.details[proposalId];
    return d ? proposalResources(d) : undefined;
  };
  return { project, role, live, rows, titleOf, latestOf, changeOfProposal, staleOf: (p) => staleReasons(p, live.events, resourcesOf) };
}

// ------------------------------------------------------------------------------- positions

/**
 * The developer step of a Change, from the same helper as the storyboard (UX-4 review I-2), with
 * the release facts of the project's release list. Previews are not read per proposal here, so a
 * result ready for review stays at Review in the list (the storyboard moves on to Approve once a
 * preview is ready).
 */
export function changePosition(cx: ChangeContext, p: Proposal): { pos: RailPosition; label: string; tone: Tone } {
  const replaced = isReplaced(p, cx.live.latest);
  const accepted = cx.live.events.find((e) => e.action === "proposal.accepted" && e.subject.id === p.proposalId);
  const acceptedVersionId = typeof accepted?.detail?.acceptedVersionId === "string" ? accepted.detail.acceptedVersionId : null;
  const release = p.state === "accepted" ? releaseFor(cx.live.releases, acceptedVersionId) : null;
  const pos = storyPosition(p, { replaced, previewReady: false, release });
  const status = proposalStatus(p, replaced);
  if (!release) return { pos, label: status.label, tone: status.tone };
  if (release.live) return { pos, label: "Live", tone: "good" };
  if (supersededRelease(release)) return { pos, label: "Was live, replaced by a newer release", tone: "muted" };
  return { pos, label: release.status, tone: pos.state === "blocked" ? "bad" : pos.state === "working" ? "busy" : "warn" };
}

// ------------------------------------------------------------------------------------- lanes

const MARK_GLYPH: Record<LaneMark["kind"], string> = { submitted: "", failed: "✕", passed: "✓", accepted: "✓", stale: "!" };

/** "claude" → "Claude" */
function toolName(tool: string): string {
  return `${tool[0]!.toUpperCase()}${tool.slice(1)}`;
}

/**
 * Who a lane is: the agent ("Claude agent"), or for a client edition session the person who started
 * it (their email from the member list, else "Client") and the tool named on their return.
 */
export function laneWho(lane: Lane, cx: ChangeContext, tool: string | undefined): string {
  if (lane.kind === "agent") return tool ? `${toolName(tool)} agent` : "Agent";
  const who = personName(lane.actorId, "client", { members: cx.live.members }, true) ?? "Client";
  const t = lane.tool ?? tool;
  return t ? `${who} · ${toolName(t)}` : who;
}

/**
 * One swim lane (UX-4): a card with the avatar (an agent, or the client for an edition session,
 * UX-6), the task or session title, the Change's current step on the developer rail and the elapsed
 * time, beside its bar on the shared time axis. The card opens the Change once there is one (agent
 * sessions are not recorded, so there is no transcript to open).
 */
function LaneRow({ lane, pct, width, now, cx, org, pid }: { lane: Lane; pct: (t: number) => string; width: (a: number, b: number) => string; now: number; cx: ChangeContext; org: string; pid: string }) {
  const task = lane.taskId ? cx.live.tasks.find((t) => t.taskId === lane.taskId) : undefined;
  const session = lane.kind === "session";
  const st = task && !session ? taskStatus(task.state) : null;
  const latest = lane.changeId ? cx.latestOf(lane.changeId) : undefined;
  const latestId = lane.changeId ? cx.live.latest.get(lane.changeId) : undefined;
  const tool = latest?.candidates.find((c) => c.tool)?.tool;
  const created = lane.taskId ? cx.live.events.find((e) => e.action === "task.created" && e.subject.id === lane.taskId) : undefined;
  const writeMounts = Array.isArray(created?.detail?.writeMounts) ? (created.detail.writeMounts as string[]) : [];
  const resources = latest ? proposalResources(latest) : writeMounts.map((m) => cx.project.mounts.find((x) => x.mountName === m)?.resourceId).filter((x): x is string => !!x);
  const working = laneWorking(lane, cx.live.tasks);
  // a task working again (a second lease, e.g. a repair) runs until now
  const end = working ? now : (lane.frozenAt ?? now);
  // the Change's step: its latest proposal when there is one, else the task (Work while an agent runs)
  const fallback = session
    ? lane.returnedAt === undefined
      ? { label: "Editing a working copy", tone: "busy" as const, stage: "Running" }
      : working
        ? { label: "Checking the edited copy", tone: "busy" as const, stage: "Running" }
        : { label: "Sent back", tone: "neutral" as const, stage: "Submitted" }
    : (st ?? { label: "Planned", tone: "neutral" as const, stage: "Planned" });
  const { pos, label } = latest ? changePosition(cx, latest) : { pos: railPosition("developer", fallback.stage), label: fallback.label };
  const stepLabel = `${pos.complete ? "Live" : (DEVELOPER_STEPS[pos.current] ?? "Request")} · ${label}`;
  const elapsed = duration(Math.max(end, lane.startedAt) - lane.startedAt);
  const sessionPill = session ? (working ? <Pill tone="busy">{lane.returnedAt === undefined ? "Editing" : "Checking"}</Pill> : <Pill tone="good">Sent back</Pill>) : null;
  const body = (
    <>
      <span className={`lane-avatar ${session ? "lane-avatar-client" : ""}`.trim()} data-state={working ? "working" : pos.state} aria-hidden="true">
        <Icon name={session ? "human" : "agent"} size={16} strokeWidth={2} />
      </span>
      <span className="lane-text">
        <span className="lane-agent">
          {session ? "Client update" : laneWho(lane, cx, tool)}
          {st ? <Pill tone={st.tone}>{st.label}</Pill> : sessionPill}
        </span>
        <span className="lane-title">{lane.title}</span>
        <span className={`lane-step lane-step-${pos.state}`}>{stepLabel}</span>
        <span className="lane-meta">
          <span className="lane-elapsed" title={working ? "working for" : session ? "from start to the last returned copy" : "from start to last submission"}>{elapsed}</span>
          {session ? <span className="lane-who">{laneWho(lane, cx, tool)}</span> : null}
          <span className="lane-chips">
            {resources.map((r) => (
              <ResourceChip key={r} project={cx.project} resourceId={r} />
            ))}
          </span>
        </span>
      </span>
    </>
  );
  const what = session ? "client update" : "change";
  return (
    <div className="lane" data-testid="lane" data-kind={lane.kind}>
      {latestId ? (
        <Link className="lane-card" href={proposalHref(org, pid, latestId)} ariaLabel={`Open ${what}: ${lane.title}, ${stepLabel}`}>
          {body}
        </Link>
      ) : (
        <div className="lane-card">{body}</div>
      )}
      <div className="lane-track">
        <div className={`lane-bar ${working ? "lane-bar-live" : ""} ${session ? "lane-bar-client" : ""}`.trim()} style={{ left: pct(lane.startedAt), width: width(lane.startedAt, Math.max(end, lane.startedAt)) }} title={`started ${clock(lane.startedAt)}${lane.frozenAt ? `, last submitted ${clock(lane.frozenAt)}` : ", still working"}`} />
        {lane.marks.map((m, i) => (
          <span key={i} className={`lane-mark lane-mark-${m.kind}`} style={{ left: pct(m.at) }} title={`${m.label} · ${clock(m.at)} UTC`}>
            {MARK_GLYPH[m.kind]}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Lanes working now: agents and client edition sessions alike (UX-6). */
export function workingCount(lanes: Lanes, cx: ChangeContext): number {
  return lanes.lanes.filter((l) => laneWorking(l, cx.live.tasks)).length;
}

export function LanesView({ lanes, now, cx, org = "", pid = "" }: { lanes: Lanes; now: number; cx: ChangeContext; org?: string; pid?: string }) {
  if (lanes.lanes.length === 0) return <EmptyState compact icon="agent" title="No one has started work yet.">Agent sessions appear here when they take a task lease, and client updates when the client starts one.</EmptyState>;
  const span = Math.max(1, lanes.end - lanes.start);
  const pct = (t: number) => `${(((t - lanes.start) / span) * 100).toFixed(2)}%`;
  const width = (a: number, b: number) => `${Math.max(0.8, ((b - a) / span) * 100).toFixed(2)}%`;
  const workingNow = workingCount(lanes, cx);
  const sessions = lanes.lanes.filter((l) => l.kind === "session").length;
  return (
    <div className="lanes" data-testid="lanes">
      <div className="lanes-summary">
        {lanes.peak ? (
          <span>
            <strong>Up to {lanes.peak.count} sessions at once</strong> for {duration(lanes.peak.to - lanes.peak.from)}, each in its own isolated workspace{sessions ? ` (${sessions === 1 ? "one is a client update" : `${sessions} are client updates`})` : ""}.
          </span>
        ) : (
          <span>Sessions ran one after another.</span>
        )}
        <span className="lanes-now">
          {workingNow > 0 ? <span className="pulse" aria-hidden="true" /> : null} {workingNow} working now
        </span>
      </div>
      <div className="lanes-chart">
        {lanes.peak ? (
          <div className="lanes-overlay" aria-hidden="true">
            <div className="lanes-overlap" style={{ left: pct(lanes.peak.from), width: width(lanes.peak.from, lanes.peak.to) }} />
          </div>
        ) : null}
        {lanes.lanes.map((l) => (
          <LaneRow key={l.key} lane={l} pct={pct} width={width} now={now} cx={cx} org={org} pid={pid} />
        ))}
      </div>
      <div className="lanes-axis muted small">
        <span title={`${clock(lanes.start)} UTC`}>{formatTime(new Date(lanes.start).toISOString(), new Date(now))}</span>
        <span title={`${clock(lanes.end)} UTC`}>{lanes.end >= now - 1000 ? "now" : formatTime(new Date(lanes.end).toISOString(), new Date(now))}</span>
      </div>
      <div className="lanes-key muted small">
        <span className="lanes-legend">
          <span className="lane-mark-inline lane-mark-submitted" /> submitted or sent back <span className="lane-mark-inline lane-mark-failed">✕</span> validation failed <span className="lane-mark-inline lane-mark-passed">✓</span> passed <span className="lane-mark-inline lane-mark-accepted">✓</span> accepted <span className="lane-mark-inline lane-mark-stale">!</span> went stale
        </span>
      </div>
    </div>
  );
}

/** Lanes plus stale markers, ready to draw. */
export function buildLanes(cx: ChangeContext, now: number): Lanes {
  const lanes = concurrencyLanes(cx.live.events, cx.live.tasks, now, cx.changeOfProposal);
  for (const r of cx.rows) {
    const p = cx.latestOf(r.changeId);
    if (!p || !p.stale.length) continue;
    for (const s of cx.staleOf(p)) {
      if (!s.at) continue;
      const by = s.byProposalId ? cx.changeOfProposal(s.byProposalId) : undefined;
      markStale(lanes, r.changeId, Date.parse(s.at), `Went stale: ${resourceName(cx.project, s.resourceId)} moved on when ${by ? `“${cx.titleOf(by)}”` : "another change"} was accepted`);
    }
  }
  return lanes;
}

// ------------------------------------------------------------------------------------- stale

/** Why a proposal is stale, that nothing was overwritten, and the next step. */
export function StaleCallout({ p, cx, org, pid }: { p: Proposal; cx: ChangeContext; org: string; pid: string }) {
  const reasons = cx.staleOf(p);
  const first = reasons[0];
  const by = first?.byProposalId ?? null;
  const byChange = by ? cx.changeOfProposal(by) : undefined;
  const moved = joinAnd([...new Set(reasons.map((r) => resourceName(cx.project, r.resourceId)))]);
  return (
    <div className="callout callout-warn" data-testid="stale-callout">
      <strong>Stale: {moved} moved on.</strong>{" "}
      {by && byChange ? (
        <>
          “<Link href={proposalHref(org, pid, by)}>{cx.titleOf(byChange)}</Link>” was accepted {first?.at ? formatTime(first.at) : "first"}.{" "}
        </>
      ) : (
        <>Another change was accepted first. </>
      )}
      This proposal was built on the older version, so it cannot be accepted. Nothing was overwritten.{" "}
      <span className="callout-next">{isDeveloperRole(cx.role) ? "Next: ask the agent to rebuild it on the latest version; that makes a new proposal." : "Next: your developer rebuilds it on the latest version and sends it to you again."}</span>
    </div>
  );
}

// ------------------------------------------------------------------------------------- rows

/** Staging mode's proposal kinds as the Changes list labels them. */
export const PROPOSAL_KIND_LABEL: Record<ProposalKind, string> = { staging: "On staging", promotion: "Promotion" };

/**
 * What the Changes screen can do with tasks outside staging (owners and developers): start one,
 * hand one to an agent, and make a proposal from a submitted one. Absent: the list only shows.
 */
export interface ChangesTaskActions {
  createTask: (input: CreateTaskInput) => Promise<TaskView>;
  getTask: (taskId: string) => Promise<TaskView>;
  createProposal: (taskId: string) => Promise<Proposal>;
  /** something changed: read the project again */
  changed: () => void;
  handoff: HandoffContext;
}

/**
 * Make proposal is offered for submitted work while its Change has no proposal, or its latest
 * one was closed without being accepted (rejected, withdrawn, superseded): `POST …/proposals`
 * takes the task's frozen candidates again (409 `candidate_not_available` when they are spent).
 */
export function mayMakeProposal(row: Pick<ChangeRow, "proposals">): boolean {
  const latest = row.proposals[0];
  return !latest || (isClosed(latest.state) && latest.state !== "accepted");
}

/** One task of a Change (developers): its state, where its agent is, and what can be done now. */
export function ChangeTaskItem({ task, row, org, pid, now, actions, onHandoff }: { task: TaskSummary; row: ChangeRow; org: string; pid: string; now: number; actions?: ChangesTaskActions | undefined; onHandoff?: ((taskId: string) => void) | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const st = taskStatus(task.state);
  const agent = agentLine(task, new Date(now));
  const canHandoff = !!actions && !!onHandoff && openForAgent(task.state);
  const canPropose = !!actions && task.state === "submitted" && mayMakeProposal(row);
  const propose = () => {
    if (!actions || busy) return;
    setBusy(true);
    setError(null);
    actions.createProposal(task.taskId).then(
      (p) => {
        setBusy(false);
        actions.changed();
        navigate(proposalHref(org, pid, p.proposalId));
      },
      (e: unknown) => {
        setBusy(false);
        setError(e);
      },
    );
  };
  return (
    <li data-testid="change-task" data-task={task.taskId}>
      <Pill tone={st.tone}>{st.label}</Pill> <span className="small">{task.title}</span>
      {agent ? (
        <span className="change-task-agent muted small" data-testid="change-task-agent">
          {" "}
          · {agent.text}
        </span>
      ) : null}
      {canPropose ? <span className="muted small"> · The agent submitted its work. Make a proposal to review it.</span> : null}
      {canHandoff || canPropose ? (
        <span className="change-task-actions">
          {canHandoff ? (
            <button type="button" className="btn btn-quiet btn-small" onClick={() => onHandoff!(task.taskId)} data-testid="change-task-handoff">
              Give to agent
            </button>
          ) : null}
          {canPropose ? (
            <button type="button" className="btn btn-outline btn-small" onClick={propose} disabled={busy} data-testid="change-task-propose">
              {busy ? "Making proposal…" : "Make proposal"}
            </button>
          ) : null}
        </span>
      ) : null}
      {error ? (
        <p className="note note-bad small" role="alert">
          {errorMessage(error, true)}
        </p>
      ) : null}
    </li>
  );
}

export function ChangeRowView({ row, cx, org, pid, primary = true, now = Date.now(), taskActions, onHandoff }: { row: ChangeRow; cx: ChangeContext; org: string; pid: string; /** one primary per view (§6): only the first row waiting on the viewer */ primary?: boolean; now?: number; taskActions?: ChangesTaskActions | undefined; onHandoff?: ((taskId: string) => void) | undefined }) {
  const summary = row.proposals[0];
  const latest = cx.latestOf(row.changeId);
  const base = latest ? proposalStatus(latest, isReplaced(latest, cx.live.latest)) : summary ? summaryStatus(summary.state) : row.tasks[0] ? taskStatus(row.tasks[0].state) : { label: "Planned", tone: "neutral" as const, stage: "Planned" };
  const devPos = isDeveloperRole(cx.role) && latest ? changePosition(cx, latest) : null;
  const status = devPos ? { ...base, label: devPos.label, tone: devPos.tone } : base;
  const dev = isDeveloperRole(cx.role);
  // landing and promotion proposals (staging mode) are labelled, never decided here; a promotion's
  // opens its review screen for developers
  const kind = summary?.kind ?? null;
  const decide = latest && !routedProposal(cx.live, latest.proposalId) ? needsDecision(latest, cx.role) : false;
  const promotion = dev && kind === "promotion" && summary ? [...(cx.live.pendingPromotions ?? []), ...(cx.live.promotions ?? [])].find((x) => x.proposalId === summary.proposalId) : undefined;
  const href = summary ? (promotion ? promotionHref(org, pid, promotion.promotionId) : proposalHref(org, pid, summary.proposalId)) : null;
  return (
    <li className={`change ${latest?.stale.length ? "change-stale" : ""}`} data-testid="change-row">
      <div className="change-main">
        <div className="change-title">
          <strong>{cx.titleOf(row.changeId)}</strong>
          <Pill tone={status.tone}>{status.label}</Pill>
          {kind ? <Pill tone="info">{PROPOSAL_KIND_LABEL[kind]}</Pill> : null}
          {decide ? <DecisionBadge /> : null}
        </div>
        <div className="change-meta muted small">
          {latest ? (
            <span className="lane-chips">
              {proposalResources(latest).map((r) => (
                <ResourceChip key={r} project={cx.project} resourceId={r} />
              ))}
            </span>
          ) : null}
          {dev && row.tasks.length ? <span>{row.tasks.length === 1 ? "1 agent task" : `${row.tasks.length} agent tasks`}</span> : null}
          {row.proposals.length > 1 ? <span>{row.proposals.length} proposals (latest shown)</span> : null}
          <span>updated {formatTime(row.updatedAt)}</span>
        </div>
        <StateRail variant={dev ? "developer" : "client"} position={devPos ? devPos.pos : railPosition(dev ? "developer" : "client", status.stage)} />
        {latest?.stale.length ? <StaleCallout p={latest} cx={cx} org={org} pid={pid} /> : null}
        {dev && row.tasks.length ? (
          <ul className="change-tasks">
            {row.tasks.map((t) => (
              <ChangeTaskItem key={t.taskId} task={t} row={row} org={org} pid={pid} now={now} actions={taskActions} onHandoff={onHandoff} />
            ))}
          </ul>
        ) : null}
      </div>
      <div className="change-actions">
        {href ? (
          <Link className={`btn ${decide ? (primary ? "btn-primary" : "btn-outline") : "btn-quiet"}`} href={href}>
            {decide ? "Review result" : promotion ? "Open review" : "Open"}
          </Link>
        ) : (
          <span className="muted small">No proposal yet</span>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------------- activity

export interface ActivityItem {
  seq: number;
  at: string;
  text: string;
  tone: "plain" | "decision" | "good" | "bad";
  proposalId: string | null;
  /** the same line this many times in a row (collapsed); 1 when alone */
  times?: number;
}

/** Who the viewer is and who the organization's people are (developers only), to name actors. */
export interface People {
  me?: string | undefined;
  members?: MemberView[] | undefined;
}

function cap(s: string): string {
  return `${s[0]!.toUpperCase()}${s.slice(1)}`;
}

/**
 * A person by name: "You", their email (developers read the member list), else their role.
 * `null` when the viewer cannot know who it was: clients get events without actor ids, so a
 * guess ("Your developer") could credit the client's own approval to someone else (UX-5 review I-1).
 */
export function personName(id: string | undefined, role: unknown, people: People, dev: boolean): string | null {
  if (id && people.me === id) return "You";
  const m = id ? people.members?.find((x) => x.userId === id) : undefined;
  if (m) return m.email;
  if (typeof role === "string") return role === "client" ? (dev ? "The client" : "Client") : dev ? cap(role) : "Your developer";
  return dev ? "A developer" : null;
}

function actorName(e: EventView, tool: string | undefined, people: People, dev: boolean): string | null {
  if (e.actor.kind === "agent") return tool ? `${cap(tool)} agent` : "An agent";
  if (e.actor.kind === "runner") return "The integration runner";
  if (e.actor.kind === "user") return personName(e.actor.id, e.detail?.role, people, dev);
  return "The platform";
}

/**
 * One plain sentence per event, with a named actor. Plumbing (credentials, grants, outbox,
 * workspace provisioning) is not shown: the default view never prints a raw action or an id.
 */
export function activityText(e: EventView, tool: string | undefined, dev: boolean, people: People = {}): ActivityItem | null {
  const who = actorName(e, tool, people, dev);
  const prop = e.subject.kind === "proposal" ? e.subject.id : null;
  const item = (text: string, tone: ActivityItem["tone"] = "plain"): ActivityItem => ({ seq: e.seq, at: e.at, text, tone, proposalId: prop });
  const devOnly = (text: string, tone: ActivityItem["tone"] = "plain") => (dev ? item(text, tone) : null);
  /** "<who> <did>", or the actor-less sentence when the viewer cannot know who it was */
  const by = (did: string, without: string) => (who ? `${who} ${did}` : without);
  const staging = e.detail?.channel === "staging";
  switch (e.action) {
    case "task.created":
      return item(by("created the task", "The task was created"));
    case "task.started":
      return item(by("started work", "Work started"));
    case "task.candidate_frozen":
      return item(by("submitted a candidate", "A candidate was submitted"));
    case "task.lease_released":
      return item(by("finished its session", "A session finished"));
    case "task.abandoned":
      return item(by("stopped without submitting", "Work stopped without a submission"), "bad");
    case "proposal.created":
      return item("Proposal created for review");
    case "proposal.integration_requested":
      return item(by("started validation", "Validation started"));
    case "proposal.integrated":
      return item("Validation passed", "good");
    case "proposal.integration_failed":
      return item(`Validation blocked it: ${failureSentence(typeof e.detail?.code === "string" ? e.detail.code : null).toLowerCase()}`, "bad");
    case "proposal.integration_rejected":
      return devOnly("A validation result was rejected (not for this proposal)", "bad");
    case "proposal.integration_superseded":
      return devOnly("An older validation run was replaced by a newer one");
    case "proposal.approved":
      return item(by("approved", "Approved"), "decision");
    case "proposal.accepted":
      return item(by("accepted it as a new version", "Accepted as a new version"), "decision");
    case "preview.requested":
      return item(by("asked for a private preview", "A private preview was requested"));
    case "preview.ready":
      return item("Private preview ready", "good");
    case "preview.revoked":
      return item("Private preview turned off");
    case "resource.restored":
      return item(by("restored an earlier version", "An earlier version was restored"), "decision");
    // a staging release (detail.channel "staging") is never described as production
    case "release.prepare_requested":
      return devOnly(staging ? by("prepared a staging release", "A staging release was prepared") : by("prepared a release", "A release was prepared"));
    case "release.prepared":
      return devOnly(staging ? "Staging release built" : "Release built");
    case "release.publish_approved":
      return devOnly(by("approved publishing", "Publishing was approved"), "decision");
    case "release.deploy_requested":
      return devOnly(staging ? by("started the staging deploy", "The staging deploy started") : by("started the deploy", "The deploy started"));
    case "release.live":
      return item(staging ? "Live on staging" : "Live in production", "good");
    case "release.deploy_failed":
    case "release.deploy_lost":
      return devOnly(staging ? "The staging deploy failed; staging kept the previous version" : "The deploy failed; production kept the previous release", "bad");
    case "release.rolled_back":
      return devOnly(staging ? "Staging rolled back to the previous version" : "Rolled back to the previous release", "bad");
    case "export.requested":
      return item(by("exported the project", "The project was exported"));
    case "intake.requested":
      return devOnly(by("added files to check", "Files were added to check"));
    case "intake.confirmed":
      return devOnly(by("confirmed the files to add", "The files to add were confirmed"), "decision");
    case "intake.imported":
      return devOnly(by("imported a repository", "A repository was imported"));
    case "intake.included_anyway":
      return devOnly(by("included blocked files after inspecting them", "Blocked files were included after inspection"), "decision");
    case "edition.session_started":
      return item(by("started an update", "An update was started"));
    case "edition.returned":
      return item(by("sent back an edited copy", "An edited copy was sent back"));
    default:
      return null;
  }
}

export interface ActivityGroup {
  key: string;
  title: string;
  proposalId: string | null;
  items: ActivityItem[];
}

export function groupActivity(cx: ChangeContext, maxGroups = 5, perGroup = 5, me?: string): ActivityGroup[] {
  const people: People = { me, members: cx.live.members };
  const taskChange = new Map(cx.live.tasks.map((t: TaskSummary) => [t.taskId, t.changeId]));
  const groups = new Map<string, ActivityGroup & { last: number }>();
  const dev = isDeveloperRole(cx.role);
  for (const e of cx.live.events) {
    let changeId: string | undefined;
    if (e.subject.kind === "task") changeId = taskChange.get(e.subject.id);
    else if (typeof e.detail?.taskId === "string") changeId = taskChange.get(e.detail.taskId);
    else if (e.subject.kind === "proposal") changeId = cx.changeOfProposal(e.subject.id);
    const latest = changeId ? cx.latestOf(changeId) : undefined;
    const it = activityText(e, latest?.candidates.find((c) => c.tool)?.tool, dev, people);
    if (!it) continue;
    const key = changeId ?? "project";
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, title: changeId ? cx.titleOf(changeId) : "Project", proposalId: changeId ? (cx.live.latest.get(changeId) ?? null) : null, items: [], last: 0 }));
    g.items.push(it);
    g.last = Math.max(g.last, e.seq);
  }
  return [...groups.values()]
    .sort((a, b) => b.last - a.last)
    .slice(0, maxGroups)
    .map(({ last: _l, ...g }) => ({ ...g, items: pickItems(g.items, perGroup) }));
}

/** Newest first; decisions and validation results are always kept, plain steps fill the rest. */
function pickItems(items: ActivityItem[], max: number): ActivityItem[] {
  const newest = collapseRepeats([...items].reverse());
  const keep = new Set(newest.filter((i) => i.tone !== "plain").slice(0, max).map((i) => i.seq));
  for (const i of newest) if (keep.size < max) keep.add(i.seq);
  return newest.filter((i) => keep.has(i.seq));
}

/** Consecutive identical lines become one ("… ×2"), keeping the newest time. */
export function collapseRepeats(items: ActivityItem[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const i of items) {
    const last = out[out.length - 1];
    if (last && last.text === i.text && last.tone === i.tone) last.times = (last.times ?? 1) + 1;
    else out.push({ ...i });
  }
  return out;
}

/** An activity line with its repeat count. */
export function activityLine(i: ActivityItem): string {
  return i.times && i.times > 1 ? `${i.text} ×${i.times}` : i.text;
}

export function ActivityView({ groups, now, org, pid }: { groups: ActivityGroup[]; now: Date; org: string; pid: string }) {
  if (!groups.length) return <EmptyState compact icon="activity" title="No activity yet." />;
  return (
    <div className="activity">
      {groups.map((g) => (
        <section key={g.key} className="activity-group">
          <h3>{g.proposalId ? <Link href={proposalHref(org, pid, g.proposalId)}>{g.title}</Link> : g.title}</h3>
          <ol>
            {g.items.map((i) => (
              <li key={i.seq} className={`activity-${i.tone}`}>
                <span className="activity-what">{activityLine(i)}</span>
                <span className="muted small">{formatTime(i.at, now)}</span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------------------- page

export function ChangesView({ live, project, role, org, pid, now, me, taskActions, newTaskOpen = false, handoffOpen = null }: { live: LiveState; project: Project; role: Role; org: string; pid: string; now: number; /** the viewer's user id: their own events read "You" */ me?: string | undefined; /** outside staging, owners and developers: New task, the hand-off and Make proposal */ taskActions?: ChangesTaskActions | undefined; /** tests: New task starts open */ newTaskOpen?: boolean; /** tests: this task's hand-off starts open */ handoffOpen?: string | null }) {
  const cx = changeContext(live, project, role);
  const dev = isDeveloperRole(role);
  const [creating, setCreating] = useState(newTaskOpen && !!taskActions);
  const [handingOff, setHandingOff] = useState<string | null>(taskActions ? handoffOpen : null);
  const onHandoff = taskActions
    ? (taskId: string) => {
        setCreating(false);
        setHandingOff(taskId);
      }
    : undefined;
  const firstDecision = cx.rows.find((r) => {
    const p = cx.latestOf(r.changeId);
    return p && !routedProposal(live, p.proposalId) ? needsDecision(p, role) : false;
  })?.changeId;
  return (
    <div className="changes">
      <div className="changes-main">
        {dev ? (
          <Card title="Agents at work" aside={<span className="muted small">live · refreshes every few seconds</span>}>
            <LanesView lanes={buildLanes(cx, now)} now={now} cx={cx} org={org} pid={pid} />
          </Card>
        ) : null}
        {taskActions && creating ? (
          <NewTaskSheet
            mounts={project.mounts}
            developer={dev}
            onCreate={taskActions.createTask}
            onCreated={() => taskActions.changed()}
            onClose={() => setCreating(false)}
            handoff={taskActions.handoff}
          />
        ) : null}
        {taskActions && handingOff && !creating ? <TaskHandoffLoader key={handingOff} taskId={handingOff} ctx={taskActions.handoff} load={taskActions.getTask} onDone={() => setHandingOff(null)} /> : null}
        <Card
          title="Changes"
          aside={
            taskActions && !creating && !handingOff ? (
              <button type="button" className="btn btn-primary btn-small" onClick={() => setCreating(true)} data-testid="new-task-open">
                <Icon name="plus" size={15} />
                New task
              </button>
            ) : undefined
          }
        >
          {taskActions ? <p className="muted small changes-task-note">Start a task for a coding agent. When the agent submits, make a proposal from it here, then validate and accept it.</p> : null}
          {cx.rows.length === 0 ? (
            <EmptyState compact icon="changes" title={dev ? "No changes yet." : "No updates yet. Start one when you're ready."}>
              {live.staging?.enabled
                ? "In this project, changes start as tasks on the Tasks board."
                : dev
                  ? "A change appears here when an agent submits a task's work or a client sends an edited copy back."
                  : "When you send an edited copy back, it shows here for your review."}
            </EmptyState>
          ) : (
            <ul className="change-list">
              {cx.rows.map((r) => (
                <ChangeRowView key={r.changeId} row={r} cx={cx} org={org} pid={pid} primary={r.changeId === firstDecision} now={now} taskActions={taskActions} onHandoff={onHandoff} />
              ))}
            </ul>
          )}
        </Card>
      </div>
      <aside className="changes-side">
        <Card title="What happened">
          <ActivityView groups={groupActivity(cx, 5, 5, me)} now={new Date(now)} org={org} pid={pid} />
        </Card>
      </aside>
    </div>
  );
}

/** Outside staging (the policy, or the poll, says so), owners and developers start and hand off tasks here. */
export function changesTaskMode(live: Pick<LiveState, "staging">, project: Project, role: Role): boolean {
  return isDeveloperRole(role) && !live.staging?.enabled && policyStaging(project) !== true;
}

export function ChangesScreen() {
  const { org, pid, project, role, live, reloadLive } = useProject();
  const { api, me } = useApp();
  const handoff = useHandoffContext(role, false);
  // stable, so an open hand-off is not read again on every poll
  const getTask = useCallback((taskId: string) => api.getTask(taskId), [api]);
  if (!live) return <Loading what="Loading changes" />;
  const taskActions: ChangesTaskActions | undefined = changesTaskMode(live, project, role)
    ? {
        createTask: (input) => api.createTask(org, pid, input),
        getTask,
        createProposal: (taskId) => api.createProposal(org, taskId),
        changed: reloadLive,
        handoff,
      }
    : undefined;
  return <ChangesView live={live} project={project} role={role} org={org} pid={pid} now={Date.now()} me={me?.user.userId} taskActions={taskActions} />;
}
