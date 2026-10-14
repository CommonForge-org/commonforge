/**
 * Overview, the landing page.
 * - Clients (UX-2, mockup `docs/design/mockups/client-overview`): "Your <project>" with what is
 *   live, Start an update and Open the live site; the Needs you stack; updates in progress on the
 *   five-dot rail with the next step; recent versions; the trust line.
 * - Developers (UX-1 scaffold, UX-4 builds it out): updates on the eight-step rail and Needs you.
 */
import type { Project, Proposal, Role } from "../api/types.js";
import { clientNextStep, liveSite, proposalReleaseFacts, relativeTime, returnSummary, versionSummary, type LiveSite, type ProjectVersion } from "../lib/client-flow.js";
import { isClosed, isDeveloperRole, isReplaced, needsDecision, PENDING_PRODUCTION_HEADING, proposalStatus, summaryStatus, taskStatus, validationSummary } from "../lib/model.js";
import { projectHref, promotionHref, proposalHref } from "../lib/router.js";
import { Badge, EmptyState, Icon, NeedsYou, railPosition, SiteThumb, StateRail, type NeedsYouItem, type RailPosition } from "../primitives/index.js";
import { Link, Loading } from "../ui.js";
import { changeContext, type ChangeContext } from "./Changes.js";
import { useClientUpdates, useProjectHistory, type ClientUpdates, type ProjectHistory } from "./client-data.js";
import { StartUpdateButton } from "./Editions.js";
import { ProjectGettingStarted } from "./GettingStarted.js";
import { pendingPromotionsFor, POLL_MS, routedProposal, useProject, type LiveState } from "./project-data.js";
import { boardFromLive } from "./TasksBoard.js";

function needsYouItems(cx: ChangeContext, org: string, pid: string): NeedsYouItem[] {
  const client = !isDeveloperRole(cx.role);
  const out: NeedsYouItem[] = [];
  for (const r of cx.rows) {
    const p = cx.latestOf(r.changeId);
    if (!p || routedProposal(cx.live, p.proposalId) || !needsDecision(p, cx.role, isReplaced(p, cx.live.latest))) continue;
    const v = validationSummary(p);
    out.push({
      key: p.proposalId,
      title: cx.titleOf(r.changeId),
      detail: client ? "Preview is ready. Try it, then approve the result." : v.verdict === "failed" ? "Validation found a problem. Decide how to resolve it." : v.verdict === "passed" ? "Validated. Review it, then accept it as a new version." : "Ready to validate.",
      ...(v.verdict === "passed" ? { evidence: client ? "All checks passed · test data only" : "All checks passed", evidenceOk: true } : v.verdict === "failed" ? { evidence: "Checks found a problem", evidenceOk: false } : {}),
      href: proposalHref(org, pid, p.proposalId),
      action: "Review result",
    });
  }
  return out;
}

/**
 * A client's tasks whose production update waits for a developer (staging mode): one Needs you item
 * each, linking to the Tasks board, with the platform's reason.
 */
export function pendingProductionItems(live: LiveState, role: Role, org: string, pid: string): NeedsYouItem[] {
  if (role !== "client") return [];
  return boardFromLive(live.staging, live.boardTasks, live.promotions, role)
    .filter((c) => c.own && c.place === "waiting")
    .map((c) => ({ key: `promotion-${c.promotion?.promotionId ?? c.taskId}`, title: c.title, detail: `${PENDING_PRODUCTION_HEADING}. ${c.state.reason ?? "A developer reviews it before it goes live."}`, href: projectHref(org, pid, "tasks"), action: "Open Tasks" }));
}

/** A promotion's one-line name: its first task, "and N more" when there are others. */
export function promotionTitle(p: { landings: ReadonlyArray<{ title: string }> }): string {
  const [first, ...rest] = p.landings;
  if (!first) return "Production update";
  return rest.length ? `${first.title} and ${rest.length} more` : first.title;
}

/**
 * Developers: one Needs you item per promotion waiting for a developer (staging mode), linking to
 * its review screen, with the platform's reason.
 */
export function promotionNeedsYouItems(live: LiveState, role: Role, org: string, pid: string, approvalRoles: readonly Role[] | undefined): NeedsYouItem[] {
  return pendingPromotionsFor(live, role, approvalRoles).map((p) => ({
    key: `promotion-${p.promotionId}`,
    title: promotionTitle(p),
    detail: `Production update waiting for your approval. ${p.reason ?? "A developer reviews it before it goes live."}`,
    href: promotionHref(org, pid, p.promotionId),
    action: "Review",
  }));
}

function nextLine(p: Proposal | undefined, role: Role): string {
  if (!p) return "Agents are working on it.";
  const st = proposalStatus(p);
  if (!isDeveloperRole(role)) {
    if (st.stage === "ReadyForReview") return "Next: you review and approve. Your developer publishes.";
    if (st.stage === "Approved" || st.stage === "Accepted") return "Next: your developer publishes.";
    return "Nothing for you yet.";
  }
  if (st.stage === "NeedsResolution") return "Next: resolve what validation found.";
  if (st.stage === "ReadyForReview") return "Next: waiting for an approval.";
  if (st.stage === "Approved") return "Next: accept it as a new version.";
  return `Now: ${st.label.toLowerCase()}.`;
}

export function OverviewView({ live, project, role, org, pid }: { live: LiveState; project: Project; role: Role; org: string; pid: string }) {
  const cx = changeContext(live, project, role);
  const variant = isDeveloperRole(role) ? "developer" : "client";
  const open = cx.rows.filter((r) => {
    const p = cx.latestOf(r.changeId);
    return p ? !isClosed(p.state) : r.proposals[0] ? !isClosed(r.proposals[0].state) : true;
  });
  return (
    <div className="overview">
      <section className="overview-main" aria-labelledby="updates-title">
        <div className="section-head">
          <h2 id="updates-title">Updates in progress</h2>
          <Link href={projectHref(org, pid, "changes")}>All changes</Link>
        </div>
        {open.length === 0 ? (
          <EmptyState title="No updates yet. Start one when you're ready." icon="changes" />
        ) : (
          <div className="stack">
            {open.map((r) => {
              const p = cx.latestOf(r.changeId);
              const status = p ? proposalStatus(p, isReplaced(p, live.latest)) : r.proposals[0] ? summaryStatus(r.proposals[0].state) : r.tasks[0] ? taskStatus(r.tasks[0].state) : { label: "Planned", tone: "neutral" as const, stage: "Planned" };
              return (
                <article key={r.changeId} className="update-card">
                  <div className="update-card-text">
                    <div className="update-card-title">{p ? <Link href={proposalHref(org, pid, p.proposalId)}>{cx.titleOf(r.changeId)}</Link> : cx.titleOf(r.changeId)}</div>
                    <div className="muted small">{status.label}</div>
                  </div>
                  <StateRail variant={variant} position={railPosition(variant, status.stage)} />
                  <div className="update-card-next muted small">{nextLine(p, role)}</div>
                </article>
              );
            })}
          </div>
        )}
      </section>
      <aside className="overview-side">
        <NeedsYou items={[...promotionNeedsYouItems(live, role, org, pid, project.policy?.approvalRoles), ...needsYouItems(cx, org, pid)]} />
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------------------ client

export interface ClientUpdateRow {
  key: string;
  title: string;
  href: string | null;
  meta: string;
  rail: RailPosition;
  next: string;
}

/**
 * What a client sees in "Updates in progress": the latest proposal of each open Change, accepted
 * ones until they are live, and the client's own returns still being prepared.
 */
export function clientUpdateRows(cx: ChangeContext, org: string, pid: string, history: ProjectHistory | undefined, updates: ClientUpdates | undefined, now: Date = new Date()): ClientUpdateRow[] {
  const viewer = cx.role === "viewer" ? "viewer" : "client";
  const out: ClientUpdateRow[] = [];
  for (const r of cx.rows) {
    const p = cx.latestOf(r.changeId);
    if (!p) continue;
    if (isClosed(p.state) && p.state !== "accepted") continue;
    const rf = p.state === "accepted" ? proposalReleaseFacts(history, p.proposalId) : { live: false, publishing: false, known: true };
    if (rf.live) continue;
    // without read on the release service an accepted update would never count as live: it leaves the list (review m3)
    if (p.state === "accepted" && history && !rf.known) continue;
    const facts = { live: rf.live, publishing: rf.publishing };
    const st = proposalStatus(p, isReplaced(p, cx.live.latest));
    const mine = updates?.byProposal.get(p.proposalId);
    const files = p.candidates.reduce((n, c) => n + c.changedPaths.length, 0) + p.assetManifestChanges.length;
    const who = mine ? `Started by you · ${returnSummary(mine.ret).text}` : `From your developer · ${files} ${files === 1 ? "file" : "files"} changed`;
    out.push({ key: r.changeId, title: mine?.session.title || cx.titleOf(r.changeId), href: proposalHref(org, pid, p.proposalId), meta: `${who} · updated ${relativeTime(p.updatedAt, now)}`, rail: railPosition("client", st.stage, facts), next: clientNextStep(st.stage, facts, viewer) });
  }
  // the client's own returns that have no proposal yet
  for (const s of updates?.sessions ?? []) {
    const pending = s.returns.find((x) => !x.proposalId && (x.state === "queued" || x.state === "running" || x.state === "freezing"));
    if (!pending) continue;
    out.push({ key: s.sessionId, title: s.title, href: null, meta: `Started by you · preparing your change · sent ${relativeTime(pending.createdAt, now)}`, rail: railPosition("client", "Submitted"), next: clientNextStep("Submitted", {}, viewer) });
  }
  return out;
}

export interface ClientOverviewProps {
  project: Project;
  org: string;
  pid: string;
  live: LiveState;
  history: ProjectHistory | undefined;
  updates: ClientUpdates | undefined;
  /** client or viewer: viewers only look (no Start an update, no approve, no restore) */
  role?: Role;
  now?: Date;
}

function HeroStatus({ site, latest, now }: { site: LiveSite | null; latest: ProjectVersion | undefined; now: Date }) {
  if (site) {
    return (
      <div className="co-hero-status">
        <Badge state="ready">Live</Badge>
        <span className="muted small">
          {site.number != null ? `Version ${site.number} · ` : ""}published {relativeTime(site.since, now)}
        </span>
      </div>
    );
  }
  return (
    <div className="co-hero-status">
      <Badge state="neutral">Not live yet</Badge>
      <span className="muted small">{latest ? `Version ${latest.number} · accepted ${relativeTime(latest.at, now)}` : "Nothing has been published yet"}</span>
    </div>
  );
}

export function ClientOverviewView({ project, org, pid, live, history, updates, role = "client", now = new Date() }: ClientOverviewProps) {
  const cx = changeContext(live, project, role);
  // a staging-mode project takes client changes as tasks on the Tasks board, never edition updates (P42-2)
  const canStart = role === "client" && !live.staging?.enabled;
  const versions = history?.versions ?? [];
  const site = liveSite(history?.releases, versions);
  const rows = clientUpdateRows(cx, org, pid, history, updates, now);
  const recent = versions.slice(0, 3);
  const waiting = [...pendingProductionItems(live, role, org, pid), ...needsYouItems(cx, org, pid)];
  const titleOf = (proposalId: string) => {
    const mine = updates?.byProposal.get(proposalId)?.session.title;
    if (mine) return mine;
    const changeId = cx.changeOfProposal(proposalId);
    return changeId ? cx.titleOf(changeId) : null;
  };
  return (
    <div className="client-overview">
      <div className="co-top">
        <section className="co-hero" aria-labelledby="co-hero-title">
          <div className="co-hero-text">
            <HeroStatus site={site} latest={versions[0]} now={now} />
            <h1 id="co-hero-title">Your {project.name}</h1>
            <p className="co-hero-lede">{canStart ? "Everything customers use today. Start an update to change pages in your own tools, test it privately, and send it for approval." : "Everything customers use today, and the updates on their way."}</p>
            <div className="co-hero-actions">
              {/* one primary per view (§6): a result waiting on the client outranks starting another update */}
              {canStart ? <StartUpdateButton quiet={waiting.length > 0} /> : null}
              {site?.url ? (
                <a className="btn btn-outline" href={site.url} target="_blank" rel="noopener noreferrer">
                  Open the live site
                </a>
              ) : null}
            </div>
          </div>
          <SiteThumb size="hero" accent={!!site} />
        </section>
        <NeedsYou items={waiting} />
      </div>

      <section className="co-section" aria-labelledby="co-updates-title">
        <div className="section-head">
          <h2 id="co-updates-title">Updates in progress</h2>
          <Link href={projectHref(org, pid, "changes")}>All changes</Link>
        </div>
        {rows.length === 0 ? (
          <EmptyState title="No updates yet. Start one when you're ready." icon="changes">
            When you send an edited copy back, it shows here with where it is and what happens next.
          </EmptyState>
        ) : (
          <div className="stack">
            {rows.map((r) => (
              <article key={r.key} className="update-card">
                <div className="update-card-text">
                  <div className="update-card-title">{r.href ? <Link href={r.href}>{r.title}</Link> : r.title}</div>
                  <div className="muted small">{r.meta}</div>
                </div>
                <StateRail variant="client" position={r.rail} />
                <div className="update-card-next muted small">{r.next}</div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="co-section" aria-labelledby="co-versions-title">
        <div className="section-head">
          <h2 id="co-versions-title">Recent versions</h2>
          <Link href={projectHref(org, pid, "versions")}>All versions</Link>
        </div>
        {recent.length === 0 ? (
          <EmptyState compact icon="versions" title="No versions yet. Your developer imports the project first." />
        ) : (
          <div className="co-versions">
            {recent.map((v, i) => {
              const isLive = site?.number === v.number;
              return (
                <article key={v.ids[0]} className={`co-version ${isLive ? "co-version-live" : ""}`.trim()}>
                  <SiteThumb size="card" accent={isLive} />
                  <div className="co-version-head">
                    <span className="co-version-name">Version {v.number}</span>
                    {isLive ? (
                      <span className="co-version-live-label">Live</span>
                    ) : i === 0 ? (
                      <span className="muted small">Current</span>
                    ) : (
                      canStart ? (
                        <Link href={projectHref(org, pid, "versions", { version: v.ids[0] })} className="small">
                          Ask to restore
                        </Link>
                      ) : null
                    )}
                  </div>
                  <div className="muted small">
                    {versionSummary(v, titleOf)} · {relativeTime(v.at, now)}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <p className="trust-line">
        <Icon name="lock" size={16} strokeWidth={2} />
        You work on a copy. The production repository and its history are never shared with your account or your tools.
      </p>
    </div>
  );
}

function ClientOverview() {
  const { org, pid, project, live, role } = useProject();
  const history = useProjectHistory("overview", POLL_MS * 2);
  const updates = useClientUpdates(POLL_MS * 2);
  if (!live) return <Loading what="Loading overview" />;
  return <ClientOverviewView project={project} org={org} pid={pid} live={live} history={history.data} updates={updates.data} role={role} />;
}

export function OverviewScreen() {
  const { org, pid, project, role, live } = useProject();
  if (!isDeveloperRole(role)) return <ClientOverview />;
  if (!live) return <Loading what="Loading overview" />;
  return (
    <>
      <ProjectGettingStarted />
      <OverviewView live={live} project={project} role={role} org={org} pid={pid} />
    </>
  );
}
