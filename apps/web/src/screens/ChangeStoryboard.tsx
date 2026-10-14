/**
 * The developer Change storyboard (UX-4, mockup `docs/design/mockups/developer-change-storyboard`):
 * title and who asked; the eight-step rail with the current step expanded as a card (evidence
 * chips, the "Production is unchanged" trust badge, one plain explanation, one primary action);
 * the Review Brief (requested outcome → what changed per resource → verified → not verified → your
 * decision); the three separate decisions with the identical review code; the Release Receipt; the
 * agents on this change; the full diff one click deeper. Every id, hash and code lives in the
 * inspector drawer.
 */
import { useState, type ReactNode } from "react";
import type { AcceptedHeadView, MemberView, Proposal } from "../api/types.js";
import { currentApprovals, failureSentence, formatTime, groupHash, hasCodeChanges, needsDecision, proposalStatus, revisionLabel, validationSummary, type ValidationSummary } from "../lib/model.js";
import { projectHref, proposalHref } from "../lib/router.js";
import {
  agentCards,
  candidateLines,
  canonicalRefs,
  decisionSentence,
  evidenceChips,
  evidenceJson,
  ledgerCodes,
  notVerifiedLines,
  releaseReceipt,
  repairBrief,
  rollingBack,
  supersededRelease,
  requestedBy,
  resourceCards,
  stepKey,
  STEP_KEYS,
  storyPosition,
  verifiedLines,
  type EvidenceChipModel,
  type StepKey,
  type StoryFacts,
} from "../lib/storyboard.js";
import { Badge, Chip, Icon, stateOfTone, StateRail, type InspectorSection } from "../primitives/index.js";
import { Card, ErrorNote, Link } from "../ui.js";
import { joinAnd, resourceName, StaleCallout } from "./Changes.js";
import { mountNameOf, useInspectorSections } from "./project-data.js";
import { DecisionsView, DecisionTrail, FixedBanner, ResourceChangesView, shortCode, type ReviewViewProps } from "./ProposalReview.js";
import { PreviewCard, releaseFor, type PreviewPanelProps } from "./ReleasePanels.js";

/** What the storyboard reads besides the review's own props (all optional: tests may omit them). */
export interface StoryData {
  /** UX-2's project-wide version number of an accepted version id */
  versionOf?: (acceptedVersionId: string | null | undefined) => number | null;
  /** org members (owners and developers may list them): names who asked for the change */
  members?: MemberView[];
  /** each touched resource's accepted head (canonical ref state for the inspector) */
  heads?: Record<string, AcceptedHeadView | null>;
}

function TrustBadge() {
  return (
    <span className="badge badge-ready badge-md trust-badge">
      <Icon name="lock" size={14} strokeWidth={2.2} /> Production is unchanged
    </span>
  );
}

function EvidenceChips({ chips }: { chips: EvidenceChipModel[] }) {
  if (!chips.length) return null;
  return (
    <div className="story-chips">
      {chips.map((c) => (
        <Chip key={c.key} result={c.result} {...(c.testId ? { testId: c.testId } : {})}>
          {c.lead}
          {c.code ? (
            <>
              {" "}
              <code className="chip-code">{c.code}</code>
            </>
          ) : null}
          {c.after ? ` ${c.after}` : ""}
          {c.cause ? ` · ${c.cause}` : ""}
        </Chip>
      ))}
    </div>
  );
}

/** The expanded current step: one card, one primary action. */
function StepCard({ tone, title, eyebrow, chips, children, actions, testId, trust = true }: { tone: "decision" | "working" | "ready" | "blocked" | "neutral"; title: string; eyebrow: string; chips?: EvidenceChipModel[]; children?: ReactNode; actions?: ReactNode; testId?: string; trust?: boolean }) {
  return (
    <section className={`story-step story-step-${tone}`} aria-labelledby="story-step-title" {...(testId ? { "data-testid": testId } : {})}>
      <div className="story-step-head">
        <div>
          <div className="eyebrow story-eyebrow">{eyebrow}</div>
          <h2 id="story-step-title">{title}</h2>
        </div>
        {trust ? <TrustBadge /> : null}
      </div>
      {chips ? <EvidenceChips chips={chips} /> : null}
      {children}
      {actions ? <div className="story-actions">{actions}</div> : null}
    </section>
  );
}

function CopyAction({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState<null | "ok" | "fail">(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-primary btn-lg"
        onClick={() =>
          void (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error("no clipboard"))).then(
            () => setDone("ok"),
            () => setDone("fail"),
          )
        }
      >
        <Icon name="repair" size={16} strokeWidth={2.2} /> {label}
      </button>
      {/* always mounted, so screen readers announce the confirmation when it is filled in */}
      <span className="small muted" role="status" aria-live="polite">
        {done === "ok" ? "Copied. Paste it into the agent's session; its resubmission becomes a new proposal." : done === "fail" ? "Copying is not available here: open the runner output and copy it by hand." : ""}
      </span>
    </>
  );
}

function RunnerOutput({ detail }: { detail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-lg" aria-expanded={open} aria-controls="runner-output" onClick={() => setOpen(!open)}>
        {open ? "Hide runner output" : "Open runner output"}
      </button>
      {open ? (
        <pre id="runner-output" className="log-tail story-runner-output">
          {detail}
        </pre>
      ) : null}
    </>
  );
}

const STEP_EYEBROW = (key: StepKey, label: string) => `Step ${STEP_KEYS.indexOf(key) + 1} of 8 · ${label}`;

interface CurrentStepProps extends ReviewViewProps {
  step: StepKey;
  v: ValidationSummary;
  facts: StoryFacts;
  chips: EvidenceChipModel[];
  replaced: boolean;
  decisionCard: ReactNode;
}

function CurrentStep(props: CurrentStepProps) {
  const { p, step, v, chips, replaced, title, org, pid } = props;
  const status = proposalStatus(p, replaced);
  const nameOf = (rid: string) => resourceName(props.project, rid);
  const eyebrow = STEP_EYEBROW(step, status.label);
  const running = v.verdict === "running";
  const canValidate = p.state === "prepared" && !p.stale.length && !running && !replaced;
  const validateBtn = (
    <button type="button" className="btn btn-primary btn-lg" disabled={!canValidate || props.validate.busy} onClick={props.validate.onValidate}>
      {props.validate.busy ? "Starting…" : p.lastAttempt || p.integration ? "Validate again" : "Run validation"}
    </button>
  );

  if (step === "request" || step === "work") {
    return (
      <StepCard tone="working" title={p.state === "open" ? "Work: candidates are still being prepared" : "Work: agents are working"} eyebrow={eyebrow}>
        <p className="story-explain">The agents work in their own isolated workspaces. Nothing is combined or checked until every candidate is submitted and prepared.</p>
      </StepCard>
    );
  }

  if (step === "check") {
    if (p.stale.length && props.cx && !replaced) {
      return (
        <StepCard tone="decision" title="Check: a base moved on, so this result cannot be accepted" eyebrow={eyebrow}>
          <StaleCallout p={p} cx={props.cx} org={org} pid={pid} />
        </StepCard>
      );
    }
    if (v.verdict === "failed") {
      const merges = v.items.filter((i) => i.kind === "merge");
      const cleanMerge = merges.length > 0 && merges.every((m) => m.result === "pass");
      const rerun = ["receipt_not_recorded", "runner_failed", "provider_unavailable", "timeout"].includes(v.code ?? "");
      const detail = p.lastAttempt?.detail;
      const contract = v.code === "contract_failed";
      const rebuild = v.code === "stale_base";
      // the Change's agent task is running again: a repair is on its way
      const repairing = !replaced && !!props.cx?.live.tasks.some((t) => t.changeId === p.changeId && (t.state === "running" || t.state === "provisioning"));
      return (
        <StepCard
          // a replaced failed version keeps its red outline (it was blocked), without the amber decision
          tone={replaced ? "blocked" : "decision"}
          testId="blocked-banner"
          title={contract ? "Check: the combined app is not ready" : rebuild ? "Check: another change was accepted first" : `Check: ${failureSentence(v.code).toLowerCase().replace(/\.$/, "")}`}
          eyebrow={eyebrow}
          chips={chips}
          actions={
            <>
              {replaced ? null : rerun ? validateBtn : <CopyAction text={repairBrief(p, v, title, nameOf)} label={rebuild ? "Copy rebuild brief for the agent" : "Copy repair brief for the agent"} />}
              {detail ? <RunnerOutput detail={detail} /> : null}
            </>
          }
        >
          <p className="story-lead" {...(replaced ? {} : { role: "alert" })}>
            {replaced ? "This version was blocked. " : "Not safe to accept yet. "}
            {failureSentence(v.code)}.
          </p>
          <p className="story-explain">
            {cleanMerge ? `Git merged the ${merges.length === 1 ? "candidate" : `${merges.length} candidates`} without conflicts, but ` : ""}
            {v.failures.join("; ")}
            {v.failures.length ? "." : ""}
            {cleanMerge && contract ? " A clean merge is not proof the application works; the contract is." : ""}
          </p>
          <p className="story-explain">
            Accept is blocked: trusted validation stopped it before acceptance.{replaced ? " A newer proposal replaced it." : rerun ? " Validate again to get a recorded result." : rebuild ? " Rebuild it on the latest version: that makes a new proposal, validated again." : " Repair it, and the resubmission is validated again as a new proposal."}
          </p>
          {repairing ? (
            <p className="story-explain story-repairing" role="status">
              <span className="pulse" aria-hidden="true" /> An agent on this change is working again; when it submits, its result becomes a new proposal and is validated again.
            </p>
          ) : null}
        </StepCard>
      );
    }
    return (
      <StepCard
        tone={running ? "working" : "decision"}
        title={running ? "Check: validating the combined result" : v.verdict === "outdated" ? "Check: the last validation was for an earlier version" : v.expired ? "Check: validation expired, run it again" : "Check: not validated yet"}
        eyebrow={eyebrow}
        chips={chips}
        actions={running ? null : validateBtn}
      >
        {running ? (
          <p className="story-explain" role="status">
            <span className="pulse" aria-hidden="true" /> Validating: the integration runner is combining the changes with the accepted versions and running the project's checks.
          </p>
        ) : (
          <p className="story-explain">
            {hasCodeChanges(p) ? "The runner merges every candidate with the accepted versions, then runs the project's checks and contracts on the combined result." : "This proposal changes assets only: there is nothing to merge, and validation runs the project's checks against the code it was based on."} Checks and contracts come from project policy, never from files in the change.
          </p>
        )}
        <ErrorNote error={props.validate.error} />
      </StepCard>
    );
  }

  if (step === "review") {
    return <ReviewStep {...props} eyebrow={eyebrow} />;
  }

  // approve, accept, publish, live: the three decisions are the expanded step
  return <>{props.decisionCard}</>;
}

function ReviewStep(props: CurrentStepProps & { eyebrow: string }) {
  const { chips, eyebrow } = props;
  const preview: PreviewPanelProps | undefined = props.preview;
  const latest = preview?.previews?.[0];
  const building = latest?.state === "queued" || latest?.state === "building";
  return (
    <StepCard
      tone="decision"
      title="Review: build a private preview for the client"
      eyebrow={eyebrow}
      chips={chips}
      actions={
        preview ? (
          <>
            <button type="button" className="btn btn-primary btn-lg" disabled={!!preview.blockedWhy || preview.busy || building} onClick={preview.onRequest}>
              {preview.busy ? "Starting…" : latest ? "Build a new preview" : "Build preview"}
            </button>
            {building ? (
              <span className="small" role="status">
                <span className="pulse" aria-hidden="true" /> Building the preview in an isolated sandbox…
              </span>
            ) : null}
            {preview.blockedWhy ? <span className="muted small">{preview.blockedWhy}</span> : null}
          </>
        ) : (
          <span className="muted small">Loading preview…</span>
        )
      }
    >
      <p className="story-explain">Every check passed for this exact identity. A private preview lets the client try it with test data: orders, payments and emails in it go to test fixtures, never to production.</p>
      {latest?.state === "failed" ? <p className="small bad-text">The last preview could not be built. Build a new one.</p> : null}
      {latest?.state === "expired" || latest?.state === "revoked" ? <p className="muted small">The last preview link {latest.state === "expired" ? "expired" : "was revoked"}.</p> : null}
      <ErrorNote error={preview?.error ?? null} />
    </StepCard>
  );
}

// -------------------------------------------------------------------------- decisions (rail)

/** Approve → Accept → Publish with the identical review code: expanded when it is the current step. */
function DecisionBlock({ props, step, current, facts }: { props: ReviewViewProps & { story?: StoryData | undefined }; step: StepKey; current: boolean; facts: StoryFacts }) {
  const { p, role } = props;
  const v = validationSummary(p);
  const versionOf = props.story?.versionOf;
  const accepted = props.decisions.acceptedVersionId;
  const vNum = versionOf ? versionOf(accepted) : null;
  const approvals = currentApprovals(p);
  const rel = facts.release;
  const title =
    step === "approve"
      ? "Approve: waiting for an approval of this exact result"
      : step === "accept"
        ? `Accept: approved by ${joinAnd([...new Set(approvals.map((a) => a.role))])}, ready to become a new version`
        : step === "publish"
          ? rel?.live
            ? "Publish: live"
            : rollingBack(rel)
              ? "Publish: not verified, rolling back"
              : rel && (rel.state === "failed" || rel.state === "partial" || rel.state === "recovery_required")
                ? `Publish: ${rel.status}`
                : `Publish: ${vNum ? `version ${vNum}` : "the new version"} is accepted, not live`
          : supersededRelease(rel)
            ? `Live: ${vNum ? `version ${vNum}` : "this version"} was live; a newer release replaced it`
            : `Live: ${vNum ? `version ${vNum}` : "this version"} is running in production`;
  const code = (
    <div className="story-code" data-testid="proposal-hash" data-hash={p.proposalHash}>
      <span className="story-code-label">Review code</span>
      <code>{shortCode(p.proposalHash)}</code>
      <span className="badge badge-working badge-sm">same for client</span>
    </div>
  );
  const body = (
    <>
      <div className="story-decision-top">
        <DecisionTrail p={p} acceptedVersionId={accepted} developer versionNumber={vNum} publish={props.decisions.publish} />
        {code}
      </div>
      <DecisionsView p={p} role={role} replaced={facts.replaced} {...props.decisions} current={current ? step : null} versionNumber={vNum} />
    </>
  );
  if (!current) {
    return (
      <Card title="Decisions" className="story-decisions" aside={<span className="muted small">Three separate records. Approving is not accepting, and accepting is not publishing.</span>}>
        {body}
      </Card>
    );
  }
  const tone = supersededRelease(rel) ? "neutral" : step === "live" ? "ready" : rollingBack(rel) ? "working" : rel && !rel.live && (rel.state === "failed" || rel.state === "partial" || rel.state === "recovery_required") ? "blocked" : "decision";
  return (
    <StepCard tone={tone} title={title} eyebrow={STEP_EYEBROW(step, supersededRelease(rel) ? "Replaced by a newer release" : step === "live" ? "Live" : rel?.status ?? proposalStatus(p).label)} trust={!rel?.live && !supersededRelease(rel)}>
      <p className="story-explain">{decisionSentence(step, p, v, facts)} Approving is not accepting, and accepting is not publishing: three separate records.</p>
      {body}
    </StepCard>
  );
}

// ---------------------------------------------------------------------------------- review brief

function ReviewBrief({ p, v, outcome, nameOf, step, facts }: { p: Proposal; v: ValidationSummary; outcome: string; nameOf: (rid: string) => string; step: StepKey; facts: StoryFacts }) {
  const cards = resourceCards(p, nameOf);
  const verified = verifiedLines(v, p.resourceChanges.length);
  const notVerified = notVerifiedLines(p, v, nameOf);
  return (
    <section className="card story-brief" aria-labelledby="brief-title" data-testid="review-brief">
      <h2 id="brief-title">Review brief</h2>
      <div className="brief-grid">
        <div className="brief-block">
          <h3 className="eyebrow">Requested outcome</h3>
          <p>{outcome}</p>
        </div>
        <div className="brief-block">
          <h3 className="eyebrow">Verified</h3>
          {verified.length ? (
            <ul className="evidence brief-verified">
              {verified.map((l, i) => (
                <li key={i} className={l.ok ? "" : "bad-text"}>
                  {l.code ? (
                    <>
                      Contract <code>{l.code}</code>
                    </>
                  ) : null}
                  {l.text}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{v.verdict === "running" ? "Validation is running." : "Nothing yet: validation has not run for this identity."}</p>
          )}
        </div>
      </div>
      <div className="brief-block">
        <h3 className="eyebrow">What changed</h3>
        <div className="brief-resources">
          {cards.map((c) => (
            <div key={c.resourceId} className={`brief-resource ${c.protected ? "brief-resource-protected" : ""}`} data-testid="brief-resource">
              <div className="brief-resource-name">
                <Icon name={c.kind === "assets" ? "assets" : "repo"} size={16} /> {c.name}
              </div>
              <div className="muted small">{c.summary}</div>
              {c.protected ? (
                <div className="brief-protected small">
                  <Icon name="alert" size={14} strokeWidth={2.2} /> {c.protected}
                </div>
              ) : null}
              {c.by ? <div className="muted small">{c.by}</div> : null}
            </div>
          ))}
        </div>
      </div>
      <div className="brief-grid">
        <div className="brief-block">
          <h3 className="eyebrow">Not verified</h3>
          <ul className="brief-list muted">
            {notVerified.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
        <div className="brief-block">
          <h3 className="eyebrow">Your decision</h3>
          <p className="muted">{decisionSentence(step, p, v, facts)}</p>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------- release receipt

function ReleaseReceipt({ p, facts, versionOf, acceptedVersionId, live }: { p: Proposal; facts: StoryFacts; versionOf: (id: string | null | undefined) => number | null; acceptedVersionId: string | null; live: { acceptedVersionId: string } | null }) {
  const r = releaseReceipt(p, facts.release, { versionOf, acceptedVersionId, live });
  return (
    <section className="card receipt" data-testid="release-receipt" data-state={r.state} aria-labelledby="receipt-title">
      <header className="card-head">
        <h2 id="receipt-title">Release receipt</h2>
        <Badge state={r.badge} icon size="md" testId="receipt-state">
          {r.label}
        </Badge>
      </header>
      <dl className="receipt-rows">
        {r.rows.map((row) => (
          <div key={row.label} className={`receipt-row ${row.tone ? `receipt-${row.tone}` : ""}`}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="muted small">Accepting never publishes: production changes only through a published release. Full digests and ids are in the inspector.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------- agents

function AgentsOnChange({ p, props, now }: { p: Proposal; props: ReviewViewProps; now: number }) {
  const live = props.cx?.live;
  const cards = live ? agentCards(p, live.tasks, live.events, (rid) => resourceName(props.project, rid), now) : [];
  if (!cards.length) return null;
  return (
    <section className="story-agents" aria-labelledby="agents-title">
      <h2 id="agents-title" className="eyebrow">
        Agents on this change
      </h2>
      <div className="agent-cards">
        {cards.map((c) => (
          <article key={c.key} className="agent-card" data-testid="agent-card">
            <div className="agent-card-head">
              <span className={`agent-avatar ${c.role === "client edition" ? "agent-avatar-human" : ""}`} aria-hidden="true">
                <Icon name={c.role === "client edition" ? "human" : "agent"} size={16} strokeWidth={2} />
              </span>
              <strong>
                {c.who} · {c.role}
              </strong>
              <span className={`agent-status agent-status-${c.status.state}`}>
                {c.status.state === "working" ? <span className="pulse" aria-hidden="true" /> : null}
                {c.status.label}
              </span>
            </div>
            <div className="small">{c.title}</div>
            <div className="muted small">
              {c.detail}
              {c.elapsed ? ` · ${c.elapsed}` : ""}
            </div>
          </article>
        ))}
      </div>
      <p className="muted small">Agent sessions are not recorded by the platform, so there is no transcript to open; their submissions and the runner's evidence are in the inspector.</p>
    </section>
  );
}

// ------------------------------------------------------------------------------------- inspector

function openFullDiff() {
  if (typeof document === "undefined") return;
  const d = document.getElementById("full-diff") as HTMLDetailsElement | null;
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** A Blob download (robust for large evidence, unlike a data: URL). */
function downloadJson(json: string, name: string) {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Everything technical about the change, for the inspector drawer (developers). */
export function changeInspector(p: Proposal, props: { project: ReviewViewProps["project"]; replaced: boolean; heads?: Record<string, AcceptedHeadView | null> | undefined }): InspectorSection[] {
  const mountOf = (rid: string) => mountNameOf(props.project, rid);
  const a = p.lastAttempt;
  const v = validationSummary(p, (rid) => resourceName(props.project, rid));
  const codes = ledgerCodes(p);
  const providerOf = (rid: string) => {
    const m = props.project.mounts.find((x) => x.resourceId === rid);
    return m ? (m.provider === "r2-assets" ? "R2 assets" : "Artifacts") : "";
  };
  const pinned = p.resourceChanges.length + p.assetManifestChanges.length + p.readDependencies.length;
  const workspaces = new Set(p.candidates.map((c) => c.taskWorkspaceId).filter(Boolean)).size;
  const contracts = v.items.filter((i) => i.kind === "contract");
  const checks = v.items.filter((i) => i.kind === "check" && i.result !== "skipped");
  const merges = v.items.filter((i) => i.kind === "merge");
  const json = evidenceJson(p);
  return [
    {
      title: "Change",
      rows: [
        {
          label: "Proposal",
          value: (
            <>
              #{shortCode(p.proposalHash)} <span className="badge badge-working badge-sm">same for client</span>
            </>
          ),
          copy: p.proposalHash,
        },
        { label: "Proposal hash", value: groupHash(p.proposalHash).join(" "), copy: p.proposalHash },
        { label: "Proposal id", value: p.proposalId, copy: p.proposalId },
        { label: "Change id", value: p.changeId, copy: p.changeId },
        { label: "State", value: `${p.state} · policy revision ${p.policyRevision}` },
        { label: "Base snapshot", value: `snapshot ${shortCode(p.baseSnapshotId)} · ${pinned} resources pinned`, copy: p.baseSnapshotId },
        { label: "Candidate snapshot", value: `snapshot ${shortCode(p.candidateSnapshotId)}`, copy: p.candidateSnapshotId },
      ],
    },
    {
      title: "Candidates",
      rows: [
        ...candidateLines(p, mountOf, providerOf),
        ...p.candidates.map((c) => ({ label: `${mountOf(c.resourceId)} submitted`, value: `${c.submitter.kind}${c.submitter.id ? ` ${c.submitter.id}` : ""}${c.tool ? ` · ${c.tool}` : ""} · ${formatTime(c.frozenAt)}`, ...(c.submitter.id ? { copy: c.submitter.id } : {}) })),
      ],
    },
    { title: "Tokens (policy)", rows: [{ label: "Write access", value: workspaces ? `${workspaces} task ${workspaces === 1 ? "fork" : "forks"}; by policy, a freeze revokes their write tokens (not observed here)` : "no task forks (assets or an edition return)", mono: false }] },
    {
      title: "Last integration",
      rows: a
        ? [
            { label: "Merge", value: merges.length ? merges.map((m) => `${mountOf(m.id)} ${m.result === "pass" ? "clean" : "conflict"}`).join(" · ") : "nothing to merge", tone: merges.some((m) => m.result !== "pass") ? ("bad" as const) : "plain" },
            ...contracts.map((c) => ({ label: `Contract ${c.id}`, value: c.result === "pass" ? "PASS" : "FAIL", tone: c.result === "pass" ? ("good" as const) : ("bad" as const) })),
            { label: "Checks", value: `${checks.filter((c) => c.result === "pass").length}/${checks.length}${checks.length ? ` · ${checks.map((c) => c.id).join(", ")}` : ""}` },
            { label: "Runner", value: `${a.state}${a.code ? ` · ${a.code}` : ""}${a.forCurrentHash ? "" : " · earlier identity"} · ${a.signedEvidence ? "signed evidence" : "no signed evidence"}${a.completedAt ? ` · ${formatTime(a.completedAt)}` : ""}`, tone: a.state === "failed" ? ("bad" as const) : "plain" },
            ...(a.jobId ? [{ label: "Job", value: a.jobId, copy: a.jobId }] : []),
            ...(a.evidenceId ? [{ label: "Evidence", value: a.evidenceId, copy: a.evidenceId }] : []),
          ]
        : [{ label: "Attempt", value: "none yet" }],
    },
    {
      title: "Ledger",
      rows: [
        {
          label: "Accept",
          value: p.state === "accepted" ? "accepted" : p.state !== "prepared" && p.state !== "open" ? `closed: ${p.state}` : codes.length ? `refused now: ${codes.join(", ")}` : "allowed",
          tone: codes.length ? ("warn" as const) : ("good" as const),
        },
        ...(props.replaced ? [{ label: "Change", value: "a newer proposal replaced this one", mono: false }] : []),
      ],
    },
    {
      title: "Canonical refs",
      rows: [
        { label: "Accepted heads", value: canonicalRefs(p, props.heads, mountOf) },
        ...p.resourceChanges.map((rc) => ({ label: `${mountOf(rc.resourceId)} base`, value: revisionLabel(rc.baseRevision), copy: rc.baseRevision })),
      ],
    },
    {
      title: "Evidence and diff",
      rows: [
        {
          label: "Evidence",
          mono: false,
          value: (
            <button type="button" className="link-btn" onClick={() => downloadJson(json, `evidence-${p.proposalId}.json`)}>
              Download evidence JSON
            </button>
          ),
        },
        {
          label: "Diff",
          mono: false,
          value: (
            <button type="button" className="link-btn" onClick={openFullDiff}>
              Open full diff
            </button>
          ),
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------------------- page

export function ChangeStoryboard(props: ReviewViewProps & { story?: StoryData | undefined; now?: number | undefined }) {
  const { p, project, role, org, pid, title, newerProposalId, previous, cx } = props;
  const now = props.now ?? Date.now();
  const replaced = newerProposalId !== null && p.state !== "accepted";
  const nameOf = (rid: string) => resourceName(project, rid);
  const v = validationSummary(p, nameOf);
  const prev = previous ? validationSummary(previous, nameOf) : null;
  const fixedItems = prev && prev.verdict === "failed" && v.verdict === "passed" ? prev.items.filter((i) => i.result === "fail").map((i) => i.label) : [];
  const publish = props.decisions.publish;
  const acceptedVersionId = publish?.acceptedVersionId ?? props.decisions.acceptedVersionId;
  const release = p.state === "accepted" ? releaseFor(publish?.releases, acceptedVersionId) : null;
  const latestPreview = props.preview?.previews?.[0];
  const facts: StoryFacts = { replaced, previewReady: latestPreview?.state === "ready" && latestPreview.forCurrentHash !== false, release };
  const pos = storyPosition(p, facts);
  const step = stepKey(pos);
  const chips = evidenceChips(p, v, project, nameOf);
  const versionOf = props.story?.versionOf ?? (() => null);
  const status = proposalStatus(p, replaced);
  const decide = needsDecision(p, role, replaced);
  const row = cx?.rows.find((r) => r.changeId === p.changeId);
  const taskCount = row?.tasks.length ?? 0;
  const areas = [...new Set([...p.resourceChanges, ...p.assetManifestChanges].map((r) => nameOf(r.resourceId)))];
  const asked = cx ? requestedBy(p, cx.live.tasks, cx.live.events, props.story?.members) : "Requested by a developer";
  const decisionsCurrent = step === "approve" || step === "accept" || step === "publish" || step === "live";
  // the three decisions are the expanded step from Approve on; before that they sit lower, as a plain card
  const decisionBlock = <DecisionBlock props={props} step={step} current={decisionsCurrent && !replaced && (p.state === "prepared" || p.state === "accepted")} facts={facts} />;
  const receiptState = p.state === "accepted" ? releaseReceipt(p, release, { versionOf, acceptedVersionId, live: publish?.releases?.live ?? null }) : null;
  const headBadge = decide ? (
    <Badge state="decision" icon size="lg" testId="story-status">
      Needs your decision
    </Badge>
  ) : receiptState ? (
    <Badge state={receiptState.badge} icon size="lg" testId="story-status">
      {receiptState.label}
    </Badge>
  ) : (
    <Badge state={replaced ? "superseded" : stateOfTone(status.tone)} icon size="lg" testId="story-status">
      {status.label}
    </Badge>
  );
  useInspectorSections(changeInspector(p, { project, replaced, heads: props.story?.heads }), `story|${p.proposalId}|${p.proposalHash}|${p.state}|${p.lastAttempt?.state}|${p.approvals.length}|${replaced}|${props.story?.heads ? Object.values(props.story.heads).map((h) => h?.reconciliation).join(",") : "-"}`);
  const showReceipt = p.state === "accepted" || (!replaced && v.verdict === "passed");
  // Review hosts the preview controls in its card; from Approve on they sit beside the receipt
  const showPreviewCard = decisionsCurrent && hasCodeChanges(p) && !replaced;
  return (
    <div className="review storyboard">
      <header className="story-head">
        <div className="story-title">
          <Link href={projectHref(org, pid, "changes")} className="back-link">
            ← All changes
          </Link>
          <h1 className="review-title">{title}</h1>
          <div className="story-sub muted">
            {asked}
            {taskCount ? ` · ${taskCount === 1 ? "1 task" : `${taskCount} tasks`}` : ""}
            {areas.length ? ` · ${areas.join(", ")}` : ""}
          </div>
        </div>
        {headBadge}
      </header>
      <StateRail variant="developer" position={pos} testId="change-rail" />
      {replaced ? (
        <div className="note note-warn">
          A newer proposal replaced this one. <Link href={proposalHref(org, pid, newerProposalId!)}>Review the latest</Link>
        </div>
      ) : null}
      {fixedItems.length && !replaced ? <FixedBanner p={p} fixedItems={fixedItems} /> : null}
      <CurrentStep {...props} step={step} v={v} facts={facts} chips={chips} replaced={replaced} decisionCard={decisionBlock} />
      <ReviewBrief p={p} v={v} outcome={title} nameOf={nameOf} step={step} facts={facts} />
      {showReceipt || showPreviewCard ? (
        <div className="story-pair">
          {showReceipt ? <ReleaseReceipt p={p} facts={facts} versionOf={versionOf} acceptedVersionId={acceptedVersionId} live={publish?.releases?.live ?? null} /> : null}
          {showPreviewCard ? <PreviewCard role={role} preview={props.preview} /> : null}
        </div>
      ) : null}
      {decisionsCurrent ? null : decisionBlock}
      <AgentsOnChange p={p} props={props} now={now} />
      <details id="full-diff" className="card full-diff">
        <summary>
          Full diff · {p.candidates.reduce((n, c) => n + c.changedPaths.length, 0)} files in {areas.length === 1 ? "1 resource" : `${areas.length} resources`}
        </summary>
        <ResourceChangesView p={p} project={project} developer />
      </details>
    </div>
  );
}
