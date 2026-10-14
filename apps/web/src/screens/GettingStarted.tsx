/**
 * "Getting started" (usability push): what a new owner or developer does next, from the
 * organization to the first client task live. Every step's state is read from the API
 * (`lib/onboarding.ts`); only "Hide" is remembered, per project in this browser.
 *
 * Also the short notes that explain which client path a project uses and why staging is waiting,
 * shown on the Tasks board, Client editions and the staging policy.
 */
import { useEffect, useId, useState } from "react";
import type { Role, StagingView } from "../api/types.js";
import { useApp, useLoad } from "../lib/hooks.js";
import { isDeveloperRole } from "../lib/model.js";
import { checklistComplete, projectChecklist, readDismissed, writeDismissed, type ChecklistStep } from "../lib/onboarding.js";
import { projectHref, settingsHref } from "../lib/router.js";
import { EmptyState, Icon } from "../primitives/index.js";
import { Link } from "../ui.js";
import { decisionCount, useProject } from "./project-data.js";

export interface GettingStartedViewProps {
  steps: ChecklistStep[];
  /** project checklists can be hidden; the organization's (no projects yet) cannot */
  onDismiss?: () => void;
  /** a step's action that is a button on this page (the organization's New project), by step id */
  onAction?: Partial<Record<ChecklistStep["id"], () => void>>;
  /** false: the page's one primary action is elsewhere (a decision waiting in Needs you) */
  primary?: boolean;
}

export function GettingStartedView({ steps, onDismiss, onAction = {}, primary: pagePrimary = true }: GettingStartedViewProps) {
  const titleId = useId();
  const done = steps.filter((s) => s.done).length;
  // the first open required step is the one to do now: its action is the page's primary button
  const next = steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done);
  return (
    <section className="getting-started" aria-labelledby={titleId} data-testid="getting-started">
      <div className="getting-started-head">
        <h2 id={titleId}>Getting started</h2>
        <span className="muted small" data-testid="getting-started-count">
          {done} of {steps.length} done
        </span>
        {onDismiss ? (
          <button type="button" className="btn btn-quiet btn-small getting-started-hide" onClick={onDismiss}>
            Hide
          </button>
        ) : null}
      </div>
      <ol className="getting-started-list">
        {steps.map((s, i) => {
          const primary = pagePrimary && s === next;
          const button = onAction[s.id];
          return (
            <li key={s.id} className={`gs-step ${s.done ? "gs-done" : ""} ${s === next ? "gs-next" : ""}`.replace(/\s+/g, " ").trim()} data-testid={`gs-${s.id}`} data-done={s.done ? "true" : "false"}>
              <span className="gs-mark" aria-hidden="true">
                {s.done ? <Icon name="check" size={14} strokeWidth={3} /> : i + 1}
              </span>
              <div className="gs-body">
                <div className="gs-title">
                  {s.title}
                  {s.done ? <span className="sr-only"> (done)</span> : null}
                  {s.optional && !s.done ? <span className="muted small"> · optional</span> : null}
                </div>
                <div className="muted small">{s.why}</div>
                {!s.done && s.note ? <div className="gs-note small">{s.note}</div> : null}
                {!s.done && s.docs ? (
                  <a className="small" href={s.docs.href} target="_blank" rel="noopener noreferrer">
                    {s.docs.label}
                    <Icon name="external" size={12} />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : null}
              </div>
              {!s.done && s.action ? (
                button ? (
                  <button type="button" className={`btn btn-small ${primary ? "btn-primary" : "btn-outline"}`} onClick={button}>
                    {s.action}
                  </button>
                ) : s.href ? (
                  <Link href={s.href} className={`btn btn-small ${primary ? "btn-primary" : "btn-outline"}`}>
                    {s.action}
                  </Link>
                ) : null
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const GS_POLL_MS = 10_000;

/** The folders and access reads poll only while the checklist can still show: not once hidden or complete. */
export function checklistPollMs(o: { dismissed: boolean; complete: boolean }): number | undefined {
  return o.dismissed || o.complete ? undefined : GS_POLL_MS;
}

/**
 * The project's checklist (owners and developers, on the Overview): hidden once every required
 * step is done, or when this viewer hid it. Reads the folders and the access list besides the
 * project poll, and stops reading them again once the checklist is complete.
 */
export function ProjectGettingStarted() {
  const { api } = useApp();
  const { org, pid, project, role, live } = useProject();
  const [dismissed, setDismissed] = useState(() => readDismissed(org, pid));
  const [complete, setComplete] = useState(false);
  const dev = isDeveloperRole(role);
  const poll = checklistPollMs({ dismissed, complete });
  // folders and grants change rarely: read them less often than the project poll
  const folders = useLoad(() => (dev && !dismissed ? api.listFolders(org, pid) : Promise.resolve(undefined)), `${org}/${pid}/gs-folders/${dismissed}`, poll);
  const access = useLoad(() => (dev && !dismissed ? api.getProjectAccess(org, pid) : Promise.resolve(undefined)), `${org}/${pid}/gs-access/${dismissed}`, poll);
  const steps = dev && !dismissed && live ? projectChecklist({ org, pid, project, folders: folders.data, access: access.data, releases: live.releases, staging: live.staging, tasks: live.tasks, promotions: live.promotions, proposals: live.proposals }) : null;
  // complete once the folders and access reads are in too (before that, the project stands in for them)
  const nowComplete = !!steps && folders.data !== undefined && access.data !== undefined && checklistComplete(steps);
  useEffect(() => {
    if (nowComplete) setComplete(true);
  }, [nowComplete]);
  if (!steps || !live) return null;
  if (checklistComplete(steps)) return null;
  return (
    <GettingStartedView
      steps={steps}
      // one primary per view (§6): a decision waiting in Needs you outranks the next setup step
      primary={decisionCount(live, role, project.policy?.approvalRoles) === 0}
      onDismiss={() => {
        writeDismissed(org, pid, true);
        setDismissed(true);
      }}
    />
  );
}

// ------------------------------------------------------------------------------ notes

/**
 * Staging waits for the owner's first production publish (`state: "awaiting_baseline"`): say so
 * plainly, with the way to publish for those who can. Null when staging is off or active.
 */
export function StagingBaselineNote({ staging, role, org, pid }: { staging: StagingView | undefined; role: Role; org: string; pid: string }) {
  if (!staging?.enabled || staging.state !== "awaiting_baseline") return null;
  const dev = isDeveloperRole(role);
  return (
    <div className="note note-warn small" role="note" data-testid="staging-baseline-note">
      <span>
        {dev ? "Staging starts after your first production publish. Until then, tasks wait and nothing is built." : "Staging starts after your developer's first production publish. Tasks you create wait until then."}
      </span>
      {dev ? (
        <Link href={projectHref(org, pid, "versions")} className="btn btn-quiet btn-small">
          Publish the current version
        </Link>
      ) : null}
    </div>
  );
}

/**
 * Which client path this project uses, in one line, with the setting that switches it (owners and
 * developers; the Policy tab is theirs). `staging`: the Tasks board; `editions`: Client editions.
 */
export function ClientPathNote({ mode, role, org, pid }: { mode: "staging" | "editions"; role: Role; org: string; pid: string }) {
  const dev = isDeveloperRole(role);
  return (
    <p className="muted small client-path" data-testid="client-path">
      {mode === "staging" ? "This project uses always-on staging: clients ask for changes as tasks." : "This project has no staging: clients work on an edition copy and send it back."}{" "}
      {dev ? (
        <Link href={settingsHref(org, pid, "policy")}>{mode === "staging" ? "Staging settings" : "Turn on staging"}</Link>
      ) : null}
    </p>
  );
}

/** The Tasks board's intro: the client path, why staging waits (if it does), and what to do on an empty board. */
export function TasksIntro({ staging, empty, role, org, pid }: { staging: StagingView | undefined; empty: boolean; role: Role; org: string; pid: string }) {
  const dev = isDeveloperRole(role);
  return (
    <>
      <ClientPathNote mode="staging" role={role} org={org} pid={pid} />
      <StagingBaselineNote staging={staging} role={role} org={org} pid={pid} />
      {empty ? (
        <EmptyState compact icon="layout" title="No tasks yet.">
          {dev
            ? "Your client (or you) clicks New task and describes a change. An agent works on it, it lands on the staging site, and you review it before it goes to production."
            : role === "viewer"
              ? "Tasks your team creates appear here, from staging to live."
              : "Click New task and describe the change you want. You try it on the staging site before it goes live."}
        </EmptyState>
      ) : null}
    </>
  );
}
