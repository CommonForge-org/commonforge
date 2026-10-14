/**
 * A promotion's review (staging phase 3, Task 8; owners and developers): the tasks going to
 * production together, why it needs a developer, the level of every changed path with its rule, the
 * migration veto, what the automatic review answered, the checks on production, and the diff of
 * every changed file between `main` and the promotion's result (built in the browser, P3-10).
 * Approve, Send back to staging (a note the client reads word for word) and Withdraw, each disabled
 * with the reason when the state no longer allows it. The screen polls while open.
 *
 * A developer without read on every folder the promotion changes gets the client view from the
 * Worker (no gate, no diff): the screen says so and offers no action.
 */
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import type { MemberView, Project, PromotionLevel, PromotionState, PromotionView, RiskEvidence, RiskIncompleteReason, RiskQuestionId, Role } from "../api/types.js";
import { RISK_QUESTION_IDS } from "../api/types.js";
import { useApp, useLoad } from "../lib/hooks.js";
import { formatTime, isDeveloperRole, relativeTime, type Tone } from "../lib/model.js";
import { projectHref } from "../lib/router.js";
import { ConfirmSheet } from "../primitives/index.js";
import { Card, ErrorNote, errorMessage, Link, Loading, Pill, ResultMark } from "../ui.js";
import { joinAnd, resourceName } from "./Changes.js";
import { FileDiff, noDiffReason, plural } from "./FileDiff.js";
import { POLL_MS, useProject } from "./project-data.js";

// ------------------------------------------------------------------------------------ words

const STATE_LABEL: Record<PromotionState, { label: string; tone: Tone }> = {
  requested: { label: "Requested", tone: "busy" },
  building: { label: "Building on production", tone: "busy" },
  gating: { label: "Being checked", tone: "busy" },
  pending_approval: { label: "Waiting for your approval", tone: "warn" },
  cleared: { label: "Cleared, going to production", tone: "busy" },
  accepting: { label: "Going to production", tone: "busy" },
  releasing: { label: "Going to production", tone: "busy" },
  live: { label: "Live", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  release_failed: { label: "Couldn't go live", tone: "bad" },
  sent_back: { label: "Sent back to staging", tone: "muted" },
  superseded: { label: "Replaced", tone: "muted" },
  withdrawn: { label: "Withdrawn", tone: "muted" },
};

export function promotionStateLabel(p: Pick<PromotionView, "state" | "waitingForProduction">): { label: string; tone: Tone } {
  if (p.state === "cleared" && p.waitingForProduction) return { label: "Cleared, waiting for production", tone: "info" };
  return STATE_LABEL[p.state];
}

export const LEVEL_LABEL: Record<PromotionLevel, string> = { self: "Client releases", classify: "Automatic review", developer: "Developer review" };

const PROVIDER_LABEL: Record<string, string> = { jev: "Jev (TypeSafe)", "openai-decisions": "OpenAI Decisions", none: "None" };

const QUESTION_LABEL: Record<RiskQuestionId, string> = {
  risk: "How risky is the change?",
  migration: "What does it do to the database?",
  apiChange: "Does it change the API?",
  authOrPayments: "Does it touch sign-in or payments?",
  addressedToReviewer: "Does it contain text addressed to a reviewer?",
};

const INCOMPLETE_TEXT: Record<RiskIncompleteReason, string> = {
  diff_truncated: "a file's changes were too long to show in full",
  files_omitted: "some changed files did not fit",
  file_not_read: "a changed file could not be read",
  binary_file: "a binary file is in a folder the automatic review covers",
  too_many_files: "more than 200 files changed",
  file_too_large: "a file is over 1 MiB",
  read_limit: "more than 4 MiB had to be read",
};

/** Why the classifier did not see the complete change (P3-11), in plain words. */
export function incompleteText(reasons: readonly RiskIncompleteReason[]): string {
  return joinAnd(reasons.map((r) => INCOMPLETE_TEXT[r] ?? r));
}

/** The classifier's error code in plain words. */
export function classifierErrorText(ev: Pick<RiskEvidence, "error" | "incomplete">): string {
  switch (ev.error) {
    case "not_configured":
      return "The automatic review is not set up for this project.";
    case "timeout":
      return "The automatic review was not available (timeout).";
    case "http_error":
      return "The automatic review was not available (the service answered with an error).";
    case "refused":
      return "The automatic review refused to answer.";
    case "malformed":
      return "The automatic review's answer could not be read.";
    case "input_too_large":
      return "The automatic review was not asked: the change is too large for it.";
    case "input_incomplete":
      return `The automatic review was not asked: it could not see the complete change${ev.incomplete?.length ? ` (${incompleteText(ev.incomplete)})` : ""}.`;
    default:
      return "The automatic review was not available.";
  }
}

/** A gate that failed closed (a read failed): its veto statement is a stand-in, not a finding. */
export const GATE_ERROR_TEXT = "The checks could not be read; a developer needs to review this.";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const thresholdPct = (x: number) => `${Math.round(x * 1000) / 10}%`;

// ---------------------------------------------------------------------------------- actions

const ENDED_WHY: Partial<Record<PromotionState, string>> = {
  requested: "It is still being built and checked.",
  building: "It is still being built and checked.",
  gating: "It is still being built and checked.",
  accepting: "It is going to production now.",
  releasing: "It is going to production now.",
  live: "It is live in production; there is nothing left to decide.",
  failed: "It failed; the client can promote the task again.",
  release_failed: "It is already in production's history; a failed release is retried, not decided again.",
  sent_back: "It was sent back to staging.",
  superseded: "A newer promotion replaced it.",
  withdrawn: "It was withdrawn.",
};

const BEFORE_ACCEPT: PromotionState[] = ["requested", "building", "gating", "pending_approval", "cleared"];

export interface ActionGate {
  ok: boolean;
  why: string | null;
}

/** What the viewer may do with the promotion now (the Worker's state and role rules), with the reason when not. */
export function promotionActions(state: PromotionState, role: Role, approvalRoles: readonly Role[] | undefined): { approve: ActionGate; sendBack: ActionGate; withdraw: ActionGate } {
  const yes = { ok: true, why: null };
  const no = (why: string) => ({ ok: false, why });
  const roleOk = !approvalRoles || approvalRoles.includes(role);
  const approve =
    state !== "pending_approval" ? no(state === "cleared" ? "It is already cleared." : (ENDED_WHY[state] ?? "It is not waiting for approval.")) : roleOk ? yes : no(`This project's policy does not accept approvals from ${role === "owner" ? "owners" : "developers"}.`);
  const sendBack = state === "pending_approval" || state === "cleared" ? yes : no(ENDED_WHY[state] ?? "It can no longer be sent back.");
  const withdraw = BEFORE_ACCEPT.includes(state) ? yes : ["accepting", "releasing", "release_failed", "live"].includes(state) ? no("It was accepted into production, so it can't be withdrawn.") : no(ENDED_WHY[state] ?? "It already ended.");
  return { approve, sendBack, withdraw };
}

/** States the promotion no longer leaves: the review screen stops polling (a failed release is retried, so it keeps polling). */
const ENDED: readonly PromotionState[] = ["live", "failed", "sent_back", "superseded", "withdrawn"];

/** How often the review screen re-reads the promotion in this state (undefined: never, it ended). */
export function reviewPollMs(state: PromotionState): number | undefined {
  return ENDED.includes(state) ? undefined : POLL_MS;
}

/** What the Approve confirmation says goes to production; database changes only when migration files changed. */
export function approveDoes(p: PromotionView, project: Project): string {
  const titles = joinAnd(p.landings.map((l) => `'${l.title}'`)) || "This update";
  const folders = joinAnd((p.resources ?? []).map((r) => r.mountName ?? resourceName(project, r.resourceId)));
  const g = p.gate;
  const db = !g ? "" : g.reasonCode === "gate_error" ? ", with any database changes applied first" : g.veto.kind !== "none" ? ", with database changes applied first" : "";
  return `${titles} ${p.landings.length === 1 ? "goes" : "go"} to production${folders ? ` (${folders})` : ""}${db}.`;
}

/** The developer view (owners, developers with read on every folder it changes): only it carries `requestedBy`. */
export function hasDeveloperView(p: PromotionView): boolean {
  return p.requestedBy !== undefined;
}

export interface PromotionReviewActions {
  approve: () => Promise<unknown>;
  sendBack: (note: string) => Promise<unknown>;
  withdraw: () => Promise<unknown>;
}

const NOOP_ACTIONS: PromotionReviewActions = { approve: () => Promise.resolve(), sendBack: () => Promise.resolve(), withdraw: () => Promise.resolve() };

const NOTE_MAX = 2000;

// --------------------------------------------------------------------------------- sections

function personLabel(id: string | undefined, members: MemberView[] | undefined, me: string | undefined): string {
  if (!id) return "someone";
  if (id === me) return "you";
  return members?.find((m) => m.userId === id)?.email ?? id;
}

function Tasks({ p }: { p: PromotionView }) {
  return (
    <Card title={p.landings.length === 1 ? "The task" : `${p.landings.length} tasks go to production together`} testId="promotion-tasks">
      <ul className="promotion-tasks">
        {p.landings.map((l) => (
          <li key={l.landingId}>
            <strong>{l.title}</strong>
            {l.request ? <p className="promotion-request small">{l.request}</p> : null}
            {l.parts && l.parts.length > 1 ? (
              <ol className="promotion-parts small muted">
                {l.parts.map((x) => (
                  <li key={x.part}>
                    Part {x.part}: {x.title}
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ))}
      </ul>
      {p.goingWithout.length ? <p className="muted small">Going to production without: {joinAnd(p.goingWithout.map((g) => `'${g.title}'`))} (still on staging).</p> : null}
      {p.needs.length ? <p className="muted small">Added because it needs them: {joinAnd(p.needs.map((g) => `'${g.title}'`))}.</p> : null}
    </Card>
  );
}

function rulePatterns(project: Project, rule: number): string | null {
  const rules = (project.policy?.staging as { promotion?: { rules?: Array<{ paths?: string[] }> } } | undefined)?.promotion?.rules;
  const paths = rules?.[rule]?.paths;
  return Array.isArray(paths) ? paths.join(", ") : null;
}

/** Changed folders mounted under more than one name: their files are listed once per name (the strictest rule applies). */
function multiNamed(p: PromotionView, project: Project): Array<{ name: string; mounts: string[] }> {
  const g = p.gate;
  if (!g) return [];
  const changed = new Set(g.perPath.map((x) => x.path.split("/")[0]));
  const byResource = new Map<string, string[]>();
  for (const m of project.mounts) byResource.set(m.resourceId, [...(byResource.get(m.resourceId) ?? []), m.mountName]);
  const out: Array<{ name: string; mounts: string[] }> = [];
  for (const [rid, mounts] of byResource) {
    if (mounts.length > 1 && mounts.some((m) => changed.has(m))) out.push({ name: resourceName(project, rid), mounts });
  }
  return out;
}

function Paths({ p, project }: { p: PromotionView; project: Project }) {
  const g = p.gate;
  const multi = multiNamed(p, project);
  return (
    <Card title="Paths" testId="promotion-paths" aside={g ? <span className="muted small">strictest: {LEVEL_LABEL[g.pathLevel]}</span> : undefined}>
      {!g ? (
        <p className="muted small">The level of each changed file shows once the promotion has been checked.</p>
      ) : g.perPath.length === 0 ? (
        <p className="muted small">No path levels were recorded.</p>
      ) : (
        <table className="promotion-paths-table small">
          <thead>
            <tr>
              <th scope="col">Path</th>
              <th scope="col">Level</th>
              <th scope="col">Rule</th>
            </tr>
          </thead>
          <tbody>
            {g.perPath.map((x) => (
              <tr key={x.path} className={x.level === "self" ? "" : `promotion-level-${x.level}`}>
                <td>
                  <code>{x.path}</code>
                </td>
                <td>{LEVEL_LABEL[x.level]}</td>
                <td>{x.rule === null ? <span>No rule matches</span> : <span title={rulePatterns(project, x.rule) ?? undefined}>Rule {x.rule + 1}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {multi.map((m) => (
        <p key={m.name} className="muted small">
          {m.name} is in the project under more than one name ({joinAnd(m.mounts)}), so each of its files is listed once per name; the strictest level applies.
        </p>
      ))}
    </Card>
  );
}

function Veto({ p }: { p: PromotionView }) {
  const v = p.gate?.veto;
  if (!v) return null;
  return (
    <Card title="Database changes" testId="promotion-veto">
      {p.gate?.reasonCode === "gate_error" ? (
        <p className="small">{GATE_ERROR_TEXT}</p>
      ) : v.kind === "none" ? (
        <p className="small">No migration files changed.</p>
      ) : v.kind === "additive" ? (
        <p className="small">Additive only: every statement only adds to the database.</p>
      ) : (
        <>
          <p className="small">
            <Pill tone="bad">Not provably additive</Pill> A developer must approve these statements:
          </p>
          <ul className="promotion-veto">
            {v.offending.map((o, i) => (
              <li key={i}>
                <div className="muted small">
                  <code>{o.file}</code>
                </div>
                <code className="promotion-statement">{o.statement}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function EvidenceTable({ ev }: { ev: RiskEvidence }) {
  if (!ev.answers || !ev.safeProbability) return null;
  return (
    <table className="promotion-answers small">
      <thead>
        <tr>
          <th scope="col">Question</th>
          <th scope="col">Answer</th>
          <th scope="col">Safe</th>
          <th scope="col">Threshold</th>
          <th scope="col">Result</th>
        </tr>
      </thead>
      <tbody>
        {RISK_QUESTION_IDS.filter((q) => ev.answers![q]).map((q) => {
          const safe = ev.safeProbability![q] ?? 0;
          const pass = safe >= ev.threshold;
          return (
            <tr key={q}>
              <td>{QUESTION_LABEL[q]}</td>
              <td>{ev.answers![q].choice}</td>
              <td>{pct(safe)}</td>
              <td>needs {thresholdPct(ev.threshold)}</td>
              <td>{pass ? <Pill tone="good">Passed</Pill> : <Pill tone="bad">Below</Pill>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EvidenceFacts({ ev }: { ev: RiskEvidence }) {
  return (
    <p className="muted small">
      {PROVIDER_LABEL[ev.provider] ?? ev.provider}
      {ev.model ? (
        <>
          {" "}
          · model <code>{ev.model}</code>
        </>
      ) : null}
      {ev.latencyMs !== null ? ` · Answered in ${(ev.latencyMs / 1000).toFixed(1)} s` : ""}
      {ev.truncated ? ` · The input was shortened to fit${ev.omittedFiles ? ` (${plural(ev.omittedFiles, "file")} left out)` : ""}` : ""}
    </p>
  );
}

function AutomaticReview({ p }: { p: PromotionView }) {
  const g = p.gate;
  if (!g) return null;
  const c = g.classifier;
  const ev = c.evidence;
  let head: string;
  if (g.reasonCode === "gate_error") head = GATE_ERROR_TEXT;
  else if (c.reason === "not_needed") head = g.veto.kind === "destructive" ? "Not asked: the database change needs a developer." : g.pathLevel === "developer" ? "Not asked: some files always need a developer." : "Not needed: the client may release every changed file.";
  else if (c.reason === "carried") head = c.cleared ? "Cleared earlier by the automatic review" : "Not asked again: a developer's approval from an earlier build still covers this change.";
  else if (c.reason === "cleared") head = "Cleared by the automatic review";
  else if (c.reason === "declined") head = "Not confident enough: a developer decides.";
  else if (c.reason === "not_configured") head = ev ? classifierErrorText(ev) : "The automatic review is not set up for this project.";
  else head = ev ? classifierErrorText(ev) : "The automatic review was not available.";
  return (
    <Card title="Automatic review" testId="promotion-classifier">
      <p className="small">
        {c.cleared ? <Pill tone="good">Cleared</Pill> : null} {head}
      </p>
      {ev && (c.reason === "cleared" || c.reason === "declined" || c.reason === "carried") ? (
        <>
          <EvidenceTable ev={ev} />
          <EvidenceFacts ev={ev} />
        </>
      ) : ev && ev.error && ev.error !== "not_configured" ? (
        <EvidenceFacts ev={ev} />
      ) : null}
    </Card>
  );
}

function Checks({ p, project }: { p: PromotionView; project: Project }) {
  const ch = p.checks;
  return (
    <Card title="Checks on production" testId="promotion-checks">
      {!ch ? (
        <p className="muted small">Checks show once the promotion has been built on production.</p>
      ) : (
        <ul className="promotion-check-list small">
          {ch.mergeOutcome.map((m) => (
            <li key={`m-${m.resourceId}`}>
              <ResultMark result={m.result} /> merge into {resourceName(project, m.resourceId)}
              {m.conflictPaths?.length ? <span className="muted"> ({m.conflictPaths.join(", ")})</span> : null}
            </li>
          ))}
          {ch.checks.map((x) => (
            <li key={`c-${x.checkId}`}>
              <ResultMark result={x.result} /> <code>{x.checkId}</code>
            </li>
          ))}
          {ch.contractChecks.map((x) => (
            <li key={`k-${x.contractId}`}>
              <ResultMark result={x.result} /> contract <code>{x.contractId}</code>
            </li>
          ))}
          {ch.checks.length + ch.contractChecks.length + ch.mergeOutcome.length === 0 ? <li className="muted">No checks ran.</li> : null}
        </ul>
      )}
    </Card>
  );
}

const EXPANDED_MAX = 50;

function DiffPath({ path, mount, base, candidate, initiallyOpen }: { path: string; mount: string; base: string; candidate: string; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const skip = noDiffReason(path);
  return (
    <li className="path">
      <div className="path-row">
        <code>{path}</code>
        {skip ? (
          <span className="muted small">{skip}</span>
        ) : (
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide diff" : "Show diff"}
          </button>
        )}
      </div>
      {open && !skip ? <FileDiff mount={mount} path={path} base={base} candidate={candidate} /> : null}
    </li>
  );
}

function Diff({ p, project }: { p: PromotionView; project: Project }) {
  const [more, setMore] = useState(false);
  const resources = p.resources ?? [];
  const perPath = p.gate?.perPath ?? [];
  const groups = resources.map((r) => ({ r, paths: r.mountName ? perPath.filter((x) => x.path.startsWith(`${r.mountName}/`)).map((x) => x.path.slice(r.mountName!.length + 1)) : [] }));
  const total = groups.reduce((n, g) => n + g.paths.length, 0);
  let index = 0;
  return (
    <Card title="Diff" testId="promotion-diff" aside={total ? <span className="muted small">{plural(total, "file")}, production → this promotion</span> : undefined}>
      {resources.length === 0 ? (
        <p className="muted small">The diff shows once the promotion has been built on production.</p>
      ) : (
        groups.map(({ r, paths }) => (
          <section key={r.resourceId} className="rc">
            <header className="rc-head">
              <strong>{r.mountName ?? resourceName(project, r.resourceId)}</strong>
            </header>
            {!r.mountName ? (
              <p className="muted small">This folder is not mounted in the project, so its files can't be shown here.</p>
            ) : !p.gate ? (
              <p className="muted small">The changed files show once the promotion has been checked.</p>
            ) : paths.length === 0 ? (
              <p className="muted small">No changed paths were recorded for this folder.</p>
            ) : (
              <ul className="paths">
                {paths.map((path) => {
                  const i = index++;
                  if (i >= EXPANDED_MAX && !more) return null;
                  return <DiffPath key={path} path={path} mount={r.mountName!} base={r.head} candidate={r.result} initiallyOpen={i < EXPANDED_MAX} />;
                })}
              </ul>
            )}
          </section>
        ))
      )}
      {total > EXPANDED_MAX && !more ? (
        <button type="button" className="btn btn-outline btn-small" onClick={() => setMore(true)}>
          Show {plural(total - EXPANDED_MAX, "more file")}
        </button>
      ) : null}
    </Card>
  );
}

type Sheet = "approve" | "sendBack" | "withdraw" | null;

function Actions({ p, project, role, actions }: { p: PromotionView; project: Project; role: Role; actions: PromotionReviewActions }) {
  const [sheet, setSheet] = useState<Sheet>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const gates = promotionActions(p.state, role, project.policy?.approvalRoles);
  const run = (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    fn().then(
      () => {
        setBusy(false);
        setSheet(null);
        setNote("");
      },
      (e: unknown) => {
        setBusy(false);
        setError(e);
      },
    );
  };
  const close = () => {
    setSheet(null);
    setError(null);
  };
  const errorLine = error ? (
    <p className="note note-bad small" role="alert">
      {errorMessage(error, true)}
    </p>
  ) : null;
  const trimmed = note.trim();
  const button = (id: string, label: string, gate: ActionGate, open: Sheet, cls: string) => (
    <div className="promotion-action">
      <button type="button" id={id} className={`btn ${cls} btn-small`} disabled={!gate.ok} onClick={() => setSheet(open)} {...(gate.why ? { "aria-describedby": `${id}-why` } : {})}>
        {label}
      </button>
      {gate.why ? (
        <span id={`${id}-why`} className="muted small">
          {gate.why}
        </span>
      ) : null}
    </div>
  );
  return (
    <Card title="Decision" testId="promotion-actions">
      {sheet === null ? (
        <div className="promotion-actions">
          {button("promotion-approve", "Approve", gates.approve, "approve", "btn-primary")}
          {button("promotion-send-back", "Send back to staging", gates.sendBack, "sendBack", "btn-outline")}
          {button("promotion-withdraw", "Withdraw", gates.withdraw, "withdraw", "btn-quiet")}
        </div>
      ) : null}
      {sheet === "approve" ? (
        <ConfirmSheet
          title="Approve this production update?"
          does={approveDoes(p, project)}
          doesNot="Nothing else on staging goes with it."
          confirmLabel="Approve"
          busyLabel="Approving…"
          busy={busy}
          onConfirm={() => run(actions.approve)}
          onCancel={close}
          returnFocusId="promotion-approve"
        >
          {errorLine}
        </ConfirmSheet>
      ) : null}
      {sheet === "sendBack" ? (
        <ConfirmSheet
          title="Send this update back to staging?"
          does="The tasks stay on staging and the client can change them and promote again."
          doesNot="Production is not changed."
          confirmLabel="Send back"
          busyLabel="Sending back…"
          busy={busy}
          disabled={trimmed.length < 1 || trimmed.length > NOTE_MAX}
          tone="blocked"
          onConfirm={() => run(() => actions.sendBack(trimmed))}
          onCancel={close}
          returnFocusId="promotion-send-back"
        >
          <label className="field">
            <span className="field-label">Note for the client</span>
            <textarea value={note} rows={4} maxLength={NOTE_MAX} aria-describedby="send-back-hint" onChange={(e) => setNote(e.target.value)} />
            <span id="send-back-hint" className="muted small">
              The client sees this note word for word. {trimmed.length}/{NOTE_MAX}
            </span>
          </label>
          {errorLine}
        </ConfirmSheet>
      ) : null}
      {sheet === "withdraw" ? (
        <ConfirmSheet
          title="Withdraw this production update?"
          does="The update stops and its tasks stay on staging. They can be promoted again later."
          doesNot="Production is not changed."
          confirmLabel="Withdraw"
          busyLabel="Withdrawing…"
          busy={busy}
          onConfirm={() => run(actions.withdraw)}
          onCancel={close}
          returnFocusId="promotion-withdraw"
        >
          {errorLine}
        </ConfirmSheet>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------------------------- page

export interface PromotionReviewViewProps {
  p: PromotionView;
  project: Project;
  role: Role;
  org: string;
  pid: string;
  members?: MemberView[] | undefined;
  me?: string | undefined;
  actions?: PromotionReviewActions;
  now?: Date;
}

export function PromotionReviewView({ p, project, role, org, pid, members, me, actions = NOOP_ACTIONS, now = new Date() }: PromotionReviewViewProps) {
  const st = promotionStateLabel(p);
  const dev = hasDeveloperView(p);
  return (
    <section className="promotion-review" data-testid="promotion-review">
      <header className="project-head promotion-head">
        <div>
          <h1>Production update</h1>
          <p className="muted small">
            {dev ? `Requested by ${personLabel(p.requestedBy, members, me)}${p.createdAt ? ` ${relativeTime(p.createdAt, now)}` : ""}` : null}
            {dev && p.level ? ` · ${LEVEL_LABEL[p.level]}` : null}
          </p>
        </div>
        <Pill tone={st.tone}>{st.label}</Pill>
      </header>
      {!dev ? (
        <>
          <p className="note note-warn" role="note">
            You can't review this promotion: you don't have access to every folder it changes.
          </p>
          <Tasks p={p} />
          <p className="small">
            <Link href={projectHref(org, pid, "tasks")}>Back to Tasks</Link>
          </p>
        </>
      ) : (
        <>
          {p.reason || p.detail || p.clearance ? (
            <Card title={p.state === "pending_approval" ? "Why it needs you" : "Where it stands"} testId="promotion-why">
              {p.reason ? <p>{p.reason}</p> : null}
              {p.clearance ? (
                <p className="small">
                  Cleared by {p.clearance.kind === "self" ? "the client (every changed file may be released by the client)" : p.clearance.kind === "classifier" ? "the automatic review" : personLabel(p.clearance.clearedBy, members, me)} {relativeTime(p.clearance.clearedAt, now)}.
                </p>
              ) : null}
              {p.detail ? (
                <p className="muted small">
                  Detail: <code>{p.detail}</code>
                </p>
              ) : null}
            </Card>
          ) : null}
          <Tasks p={p} />
          <Actions p={p} project={project} role={role} actions={actions} />
          <Paths p={p} project={project} />
          <Veto p={p} />
          <AutomaticReview p={p} />
          <Checks p={p} project={project} />
          <Diff p={p} project={project} />
          {p.updatedAt ? <p className="muted small">Updated {formatTime(p.updatedAt)}</p> : null}
        </>
      )}
    </section>
  );
}

/** The route's screen: reads the promotion, polls while open, and runs the decisions. */
export function PromotionReview({ promotionId }: { promotionId: string }) {
  const { api, me } = useApp();
  const { org, pid, project, role, live, reloadLive, setInspector } = useProject();
  const [pollMs, setPollMs] = useState<number | undefined>(POLL_MS);
  const p = useLoad(() => api.getPromotion(org, promotionId), `${org}/${promotionId}`, pollMs);
  const view = p.data;
  // the screen polls while open, until the promotion ended (an action's reload still re-reads it)
  const nextPoll = view ? reviewPollMs(view.state) : POLL_MS;
  useEffect(() => setPollMs(nextPoll), [nextPoll]);
  useEffect(() => {
    if (!setInspector || !view || !hasDeveloperView(view)) return;
    const ev = view.gate?.classifier.evidence;
    setInspector("promotion", [
      {
        title: "Promotion",
        rows: [
          { label: "Promotion", value: view.promotionId, copy: view.promotionId },
          ...(view.proposalId ? [{ label: "Proposal", value: view.proposalId, copy: view.proposalId }] : []),
          ...(view.proposalHash ? [{ label: "Proposal hash", value: view.proposalHash, copy: view.proposalHash }] : []),
          ...(ev?.inputDigest ? [{ label: "Classifier input", value: ev.inputDigest, copy: ev.inputDigest }] : []),
          ...(view.acceptedVersionId ? [{ label: "Accepted version", value: view.acceptedVersionId, copy: view.acceptedVersionId }] : []),
          ...(view.releaseId ? [{ label: "Release", value: view.releaseId, copy: view.releaseId }] : []),
        ],
      },
    ]);
    return () => setInspector("promotion", null);
  }, [setInspector, view]);
  if (p.error && !view) return <ErrorNote error={p.error} onRetry={p.reload} />;
  if (!view) return <Loading what="Opening the promotion" />;
  const after = () => {
    p.reload();
    reloadLive();
  };
  const actions: PromotionReviewActions = {
    approve: () => api.approvePromotion(org, promotionId).finally(after),
    sendBack: (note) => api.sendBackPromotion(org, promotionId, note).finally(after),
    withdraw: () => api.withdrawPromotion(org, promotionId).finally(after),
  };
  return <PromotionReviewView p={view} project={project} role={role} org={org} pid={pid} members={live?.members} me={me?.user.userId} actions={actions} />;
}

/** Owners and developers get the review; everyone else the not-found screen. */
export function PromotionRoute({ promotionId, role }: { promotionId: string; role: Role }) {
  if (!isDeveloperRole(role)) return <ErrorNote error={new ApiError(404, "not_found", "This page does not exist or you do not have access.")} />;
  return <PromotionReview promotionId={promotionId} />;
}
