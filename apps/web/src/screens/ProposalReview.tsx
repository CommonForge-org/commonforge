/**
 * Proposal review: one immutable proposalHash, two layouts.
 * - Developers: the Change storyboard (UX-4, ChangeStoryboard.tsx): the eight-step rail with the
 *   current step expanded, the Review Brief, three separate decisions (Approve, Accept, Publish),
 *   the Release Receipt, the agents, the full diff; ids and hashes in the inspector.
 * - Clients: what changes for them, a short checklist, a short review code (full code on demand,
 *   identical to the developer's), Approve, and the technical details collapsed.
 * Validation comes from the server's `lastAttempt` (any outcome) and `integration` (last pass).
 */
import { useEffect, useRef, useState } from "react";
import type { AcceptedHeadView, Project, Proposal, ProposalKind, Role } from "../api/types.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import {
  acceptBlockers,
  currentApprovals,
  failureSentence,
  formatTime,
  groupHash,
  hasCodeChanges,
  isClosed,
  isDeveloperRole,
  isReplaced,
  looksLikeText,
  needsDecision,
  newIdempotencyKey,
  newestFirst,
  proposalStatus,
  providerLabel,
  revisionLabel,
  shortCode,
  shortId,
  validationSummary,
  type ValidationItem,
  type ValidationSummary,
} from "../lib/model.js";
import { projectHref, promotionHref, proposalHref } from "../lib/router.js";
import { clientChecks, liveSite, proposalReleaseFacts, versionById, versionOfProposal } from "../lib/client-flow.js";
import { Badge, Icon, railPosition, SiteThumb, StateRail, type RailPosition } from "../primitives/index.js";
import { Card, DecisionBadge, ErrorNote, Link, Loading, Pill, ResultMark } from "../ui.js";
import { ChangeStoryboard, type StoryData } from "./ChangeStoryboard.js";
import { FileDiff, plural } from "./FileDiff.js";
import { changeContext, clientChangeTitle, joinAnd, resourceName, StaleCallout, type ChangeContext } from "./Changes.js";
import { useProjectHistory } from "./client-data.js";
import { mountNameOf, POLL_MS, routedProposal, useProject, type LiveState } from "./project-data.js";
import { PublishStep, publishTrail, releaseFor, type PreviewPanelProps, type PublishPanelProps } from "./ReleasePanels.js";

export { shortCode };

// ----------------------------------------------------------------------------------- banners

export function BlockedBanner({ v, developer, detail, replaced = false }: { v: ValidationSummary; developer: boolean; detail?: string | undefined; replaced?: boolean }) {
  return (
    <div className="banner banner-bad" role="alert" data-testid="blocked-banner">
      <div className="banner-title">
        <Icon name="alert" size={18} strokeWidth={2.2} /> {replaced ? "This version was blocked." : "Not safe to accept yet."} {failureSentence(v.code)}.</div>
      <ul>
        {v.failures.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <div className="banner-foot">Trusted validation stopped it before acceptance. Production is unchanged.{replaced ? " A newer proposal replaced it." : ""}</div>
      {developer && detail ? (
        <details className="banner-detail">
          <summary>Runner output</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function FixedBanner({ p, fixedItems }: { p: Proposal; fixedItems: string[] }) {
  return (
    <div className="banner banner-good" role="status" data-testid="fixed-banner">
      <div className="banner-title">
        <Icon name="check" size={18} strokeWidth={2.4} /> Fixed. This new version passes what failed before.
      </div>
      {fixedItems.length ? (
        <ul>
          {fixedItems.map((f) => (
            <li key={f}>✓ {f}</li>
          ))}
        </ul>
      ) : null}
      <div className="banner-foot">
        New review code <code>{shortCode(p.proposalHash)}</code>; approvals of the earlier version do not carry over.
      </div>
    </div>
  );
}

export function RunningBanner() {
  return (
    <div className="banner banner-busy" role="status">
      <span className="pulse" aria-hidden="true" /> Validating: the integration runner is combining the changes with the accepted versions and running the project's checks.
    </div>
  );
}

/** "Approved by client → Accepted as version … → Published (or Approved, not live)": three separate records. */
export function DecisionTrail({ p, acceptedVersionId, developer, publish, versionNumber = null }: { p: Proposal; acceptedVersionId: string | null; developer: boolean; publish?: PublishPanelProps | undefined; /** UX-2's project-wide number of the accepted version (ids stay in the inspector) */ versionNumber?: number | null }) {
  const approvals = currentApprovals(p);
  const a = approvals[approvals.length - 1];
  if (!a && p.state !== "accepted") return null;
  return (
    <ol className="trail" aria-label="Decision trail" data-testid="decision-trail">
      <li className={a ? "trail-done" : ""}>{a ? `Approved by ${a.role} · ${formatTime(a.approvedAt)}` : "Not approved"}</li>
      <li className={p.state === "accepted" ? "trail-done" : ""}>{p.state === "accepted" ? `Accepted as ${developer && acceptedVersionId && versionNumber ? `version ${versionNumber}` : "a new version"}` : "Not accepted yet"}</li>
      {(() => {
        const rel = p.state === "accepted" ? releaseFor(publish?.releases, publish?.acceptedVersionId ?? acceptedVersionId) : null;
        return <li className={rel?.live ? "trail-done" : "trail-off"}>{publishTrail(p.state === "accepted", rel)}</li>;
      })()}
    </ol>
  );
}

// ------------------------------------------------------------------------------------ outcome

export function OutcomeView({ p, project, title, v }: { p: Proposal; project: Project; title: string | null; v: ValidationSummary }) {
  const files = p.candidates.reduce((n, c) => n + c.changedPaths.length, 0);
  const code = [...new Set(p.resourceChanges.map((r) => resourceName(project, r.resourceId)))];
  const assets = [...new Set(p.assetManifestChanges.map((a) => resourceName(project, a.resourceId)))];
  const checks = v.items.filter((i) => i.kind !== "merge");
  return (
    <Card title="Outcome" className="outcome">
      {title ? <p className="outcome-request">“{title}”</p> : null}
      <ul className="outcome-list">
        {code.length ? (
          <li>
            Changes {plural(files, "file")} in {joinAnd(code)}.
          </li>
        ) : null}
        {assets.length ? <li>Updates media in {joinAnd(assets)} (stored in R2, outside Git).</li> : null}
        {v.verdict === "passed" ? <li className="good-text">Validation passed: {plural(checks.filter((i) => i.result === "pass").length, "check")} on the combined result.</li> : null}
        {v.verdict === "not-run" ? <li>{v.expired ? "Validation expired, run again." : "Not validated yet. The combined result has to pass the project's checks before it can be accepted."}</li> : null}
        {v.verdict === "outdated" ? <li className="warn-text">The last validation was for an earlier version of this proposal and does not count.</li> : null}
        {p.state === "accepted" ? <li className="good-text">Accepted. Production is unchanged until a release is published.</li> : null}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------------------------- diffs

function ChangedPath({ path, conflict, diff }: { path: string; conflict: boolean; diff: { mount: string; base: string; candidate: string } | null }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={`path ${conflict ? "path-conflict" : ""}`}>
      <div className="path-row">
        <code>{path}</code>
        {conflict ? <Pill tone="bad">Conflict</Pill> : null}
        {diff ? (
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide diff" : "Show diff"}
          </button>
        ) : null}
      </div>
      {open && diff ? <FileDiff mount={diff.mount} path={path} base={diff.base} candidate={diff.candidate} /> : null}
    </li>
  );
}

export function ResourceChangesView({ p, project, developer }: { p: Proposal; project: Project; developer: boolean }) {
  const v = validationSummary(p);
  const merges = new Map(v.items.filter((i) => i.kind === "merge").map((i) => [i.id, i]));
  const integrated = new Map((p.integration?.forCurrentHash ? p.integration.results : undefined)?.map((r) => [r.resourceId, r.revisionId]) ?? []);
  return (
    <Card title={developer ? "Changes by resource" : "Changed files"} aside={<span className="muted small">{plural(p.resourceChanges.length + p.assetManifestChanges.length, "resource")}</span>}>
      {p.resourceChanges.map((rc) => {
        const cand = p.candidates.find((c) => c.candidateId === rc.candidateId);
        const m = merges.get(rc.resourceId);
        const conflicts = new Set(m?.paths ?? []);
        const mount = mountNameOf(project, rc.resourceId);
        const after = integrated.get(rc.resourceId) ?? rc.candidateRevision;
        return (
          <section key={rc.resourceId} className="rc" data-testid="resource-change">
            <header className="rc-head">
              <div>
                <strong>{resourceName(project, rc.resourceId)}</strong> {developer ? <span className="muted small">{providerLabel("artifacts")}</span> : null}
              </div>
              {m ? <ResultMark result={m.result === "pass" ? "clean" : "textual-conflict"} /> : null}
            </header>
            {developer ? (
              <p className="rc-revs small">
                <code title={rc.baseRevision}>{revisionLabel(rc.baseRevision)}</code> → <code title={after}>{revisionLabel(after)}</code>
                {cand?.tool ? <span className="muted"> · by {cand.submitter.kind} using {cand.tool}</span> : null}
                {cand ? <span className="muted"> · submitted {formatTime(cand.frozenAt)}</span> : null}
              </p>
            ) : null}
            <ul className="paths">
              {(cand?.changedPaths ?? []).map((path) => (
                <ChangedPath key={path} path={path} conflict={conflicts.has(path)} diff={developer && looksLikeText(path) ? { mount, base: rc.baseRevision, candidate: after } : null} />
              ))}
            </ul>
          </section>
        );
      })}
      {p.assetManifestChanges.map((ac) => (
        <section key={ac.resourceId} className="rc" data-testid="resource-change">
          <header className="rc-head">
            <div>
              <strong>{resourceName(project, ac.resourceId)}</strong> <span className="muted small">{providerLabel("r2-assets")}</span>
            </div>
          </header>
          <p className="small">
            New asset manifest
            {developer ? (
              <>
                {" "}
                <code>{ac.baseManifestId ? shortCode(ac.baseManifestId) : "none"}</code> → <code>{shortCode(ac.newManifestId)}</code>
              </>
            ) : null}
            . Asset bytes are immutable objects in R2; accepting moves the manifest pointer only.
          </p>
        </section>
      ))}
      {developer && p.readDependencies.length ? (
        <p className="muted small deps">
          Built against:{" "}
          {p.readDependencies
            .map((d) => ("redacted" in d ? "a resource you cannot see" : `${resourceName(project, d.resourceId)} at ${revisionLabel(d.revisionId)} (${d.mode === "pinned-reference" ? "pinned" : "must match accepted"})`))
            .join("; ")}
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------------- evidence

function itemKind(i: ValidationItem): string {
  return i.kind === "merge" ? "Merge" : i.kind === "contract" ? "Contract" : "Check";
}

export function EvidenceView({ p, v, developer, onValidate, validateBusy, validateError }: { p: Proposal; v: ValidationSummary; developer: boolean; onValidate: () => void; validateBusy: boolean; validateError: unknown }) {
  const codeChanges = hasCodeChanges(p);
  const running = v.verdict === "running";
  const canValidate = developer && p.state === "prepared" && !p.stale.length && !running;
  const a = p.lastAttempt;
  const action =
    developer && !isClosed(p.state) ? (
      <button type="button" className={`btn ${v.verdict === "not-run" || v.verdict === "outdated" ? "btn-primary" : "btn-quiet"} btn-small`} disabled={!canValidate || validateBusy} onClick={onValidate}>
        {running ? "Validating…" : a || p.integration ? "Validate again" : "Run validation"}
      </button>
    ) : null;
  return (
    <Card title="Validation evidence" aside={action}>
      <ErrorNote error={validateError} />
      {!codeChanges ? <p className="muted small">This proposal changes assets only: there is nothing to merge, and validation runs the project's checks against the code this proposal was based on.</p> : null}
      {running ? (
        <p className="muted">Waiting for the integration runner…</p>
      ) : v.items.length === 0 && v.verdict === "passed" ? (
        <p className="muted">Validation passed for this exact identity. The project has no checks or contracts to run.</p>
      ) : v.items.length === 0 ? (
        <p className="muted">{p.state === "open" ? "Waiting for every candidate to be prepared." : v.expired ? "Validation expired, run again: the last run ended without an answer." : "No validation has run for this proposal yet."}</p>
      ) : (
        <>
          <p className="small">
            {a?.completedAt ? `Runner evidence from ${formatTime(a.completedAt)}` : p.integration ? `Runner evidence from ${formatTime(p.integration.integratedAt)}` : "Runner evidence"} ·{" "}
            {v.verdict !== "outdated" ? <span className="good-text">for this exact identity</span> : <span className="warn-text">for an earlier identity: does not count</span>}
            {developer && a?.jobId ? <span className="muted"> · job {shortId(a.jobId, 10)}</span> : null}
          </p>
          <table className="evidence">
            <thead>
              <tr>
                <th scope="col">What was checked</th>
                <th scope="col">Result</th>
              </tr>
            </thead>
            <tbody>
              {v.items.map((i) => (
                <tr key={`${i.kind}-${i.id}`} className={i.result === "fail" ? "row-fail" : ""}>
                  <td>
                    {i.label}
                    {developer && i.kind !== "merge" ? (
                      <span className="muted small">
                        {" "}
                        · {itemKind(i)} <code>{i.id}</code>
                      </span>
                    ) : null}
                    {i.paths?.length ? <div className="muted small">{i.paths.join(", ")}</div> : null}
                  </td>
                  <td>
                    <ResultMark result={i.result} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Checks and contracts come from project policy, never from files in the change. Evidence is signed by the integration runner; agent output never counts as evidence.</p>
        </>
      )}
    </Card>
  );
}


// ---------------------------------------------------------------------------------- decisions

export interface DecisionProps {
  p: Proposal;
  role: Role;
  replaced: boolean;
  onApprove: () => void;
  approveBusy: boolean;
  approveError: unknown;
  onAccept: () => void;
  acceptBusy: boolean;
  acceptError: unknown;
  acceptedVersionId: string | null;
  /** Task 22: the release service (absent: still loading) */
  publish?: PublishPanelProps | undefined;
}

/** UX-4: which decision is the storyboard's current step (its button is the one primary action). */
export type DecisionStep = "approve" | "accept" | "publish" | "live" | "request" | "work" | "check" | "review";

function canApproveNow(p: Proposal, role: Role, replaced: boolean): { ok: boolean; why: string | null } {
  if (role === "viewer" || isClosed(p.state)) return { ok: false, why: null };
  if (replaced) return { ok: false, why: "A newer proposal replaced this one." };
  if (p.stale.length) return { ok: false, why: "This proposal is stale." };
  if (validationSummary(p).verdict !== "passed") return { ok: false, why: "Available after validation passes." };
  if (p.state !== "prepared") return { ok: false, why: "Still being prepared." };
  return { ok: true, why: null };
}

export function DecisionsView({ p, role, replaced, onApprove, approveBusy, approveError, onAccept, acceptBusy, acceptError, acceptedVersionId, publish, current = null, versionNumber = null }: DecisionProps & { current?: DecisionStep | null; versionNumber?: number | null }) {
  const developer = isDeveloperRole(role);
  const approvals = currentApprovals(p);
  const earlier = p.approvals.length - approvals.length;
  const closed = isClosed(p.state);
  const mine = approvals.some((a) => a.role === role);
  const approve = canApproveNow(p, role, replaced);
  const blockers = acceptBlockers(p, replaced);
  return (
    <ol className="steps decision-steps" aria-label="Decisions" data-testid="decision-rail">
      <li className={["step", approvals.length ? "step-done" : "", current === "approve" ? "step-current" : ""].filter(Boolean).join(" ")} data-testid="step-approve">
        <div className="step-head">
          <span className="step-num">{approvals.length ? <Icon name="check" size={13} strokeWidth={3} /> : "1"}</span>
          <strong>Approve</strong>
          {approvals.length ? <Pill tone="good">{plural(approvals.length, "approval")}</Pill> : null}
        </div>
        <p className="small">The client (or a reviewer) confirms this exact result.</p>
        {approvals.map((a) => (
          <div key={a.approvalId} className="record small">
            Approved by {a.role} · {formatTime(a.approvedAt)}
          </div>
        ))}
        {earlier > 0 ? <div className="muted small">{plural(earlier, "earlier approval")} for a different identity no longer count.</div> : null}
        {role !== "viewer" && !closed ? (
          <button type="button" className={current === "approve" && !mine ? "btn btn-primary" : "btn"} disabled={!approve.ok || approveBusy} onClick={onApprove}>
            {approveBusy ? "Approving…" : mine ? "Approve again" : "Approve this result"}
          </button>
        ) : null}
        {approve.why ? <div className="muted small">{approve.why}</div> : null}
        <ErrorNote error={approveError} />
      </li>
      <li className={["step", p.state === "accepted" ? "step-done" : "", current === "accept" ? "step-current" : ""].filter(Boolean).join(" ")} data-testid="step-accept">
        <div className="step-head">
          <span className="step-num">{p.state === "accepted" ? <Icon name="check" size={13} strokeWidth={3} /> : "2"}</span>
          <strong>Accept</strong>
          {p.state === "accepted" ? <Pill tone="good">Accepted</Pill> : null}
        </div>
        <p className="small">A developer records the new accepted version. The ledger re-checks heads, identity, approvals and evidence at that moment.</p>
        {p.state === "accepted" || acceptedVersionId ? <div className="record small">{versionNumber ? `New version ${versionNumber} recorded in the ledger` : "New version recorded in the ledger"}</div> : null}
        {developer && p.state !== "accepted" && !closed ? (
          <>
            <button type="button" className={current === "accept" ? "btn btn-primary" : "btn"} disabled={blockers.length > 0 || acceptBusy} onClick={onAccept}>
              {acceptBusy ? "Accepting…" : "Accept as new version"}
            </button>
            {blockers.length ? (
              <ul className="blockers small">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
        {!developer && p.state !== "accepted" ? <div className="muted small">Done by the developer after approval.</div> : null}
        <ErrorNote error={acceptError} />
      </li>
      <PublishStep role={role} accepted={p.state === "accepted"} versionLabel={versionNumber ? `Version ${versionNumber}` : undefined} current={current === "publish" || current === "live"} publish={publish ? { ...publish, acceptedVersionId: publish.acceptedVersionId ?? acceptedVersionId } : undefined} />
    </ol>
  );
}

// ----------------------------------------------------------------------------- client layout

/** The review code: short to read aloud, the full code on demand (identical for every role). */
export function ReviewCode({ hash }: { hash: string }) {
  const [full, setFull] = useState(false);
  return (
    <div className="review-code" data-testid="proposal-hash" data-hash={hash}>
      <div className="hash-label">Review code</div>
      <code className="review-code-value">{full ? groupHash(hash).join(" ") : shortCode(hash)}</code>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => setFull(!full)}>
        {full ? "Show short code" : "Show full code"}
      </button>
      <p className="muted small">Your developer sees the same code for this exact result. If the codes match, you are both looking at the same thing.</p>
    </div>
  );
}

/**
 * The review screen's title. n-5: a client's title names the areas of *this* proposal (as its body
 * does), even when a newer proposal of the same Change touches different areas; developers see the
 * Change's task title.
 */
export function reviewTitle(role: Role, project: Project, p: Proposal, cx: ChangeContext | null): string {
  if (!isDeveloperRole(role)) return clientChangeTitle(project, p, p.changeId);
  return cx ? cx.titleOf(p.changeId) : `Update ${shortId(p.changeId)}`;
}

/**
 * Before / after (the 5:00 hero): what is live now beside the private preview of this result. The
 * pages are drawn as skeletons (the CSP is 'self' and previews run on their own origin, so neither
 * can be embedded); the links open the real ones.
 */
export function BeforeAfter({ preview, liveUrl }: { preview?: PreviewPanelProps | undefined; liveUrl: string | null }) {
  const latest = preview?.previews?.[0];
  const ready = latest?.state === "ready" && latest.url;
  return (
    <section className="card before-after" data-testid="preview-before-after" aria-labelledby="ba-title">
      <header className="card-head">
        <h2 id="ba-title">Before and after</h2>
        <Badge state="neutral" size="sm">
          Test data only
        </Badge>
      </header>
      <div className="ba-grid">
        <figure className="ba-side">
          <SiteThumb size="hero" accent={!!liveUrl} />
          <figcaption>
            <span className="ba-label">Live site now</span>
            {liveUrl ? (
              <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="small">
                Open the live site
              </a>
            ) : (
              <span className="muted small">Not published yet</span>
            )}
          </figcaption>
        </figure>
        <span className="ba-arrow" aria-hidden="true">
          <Icon name="arrow" size={22} />
        </span>
        <figure className="ba-side ba-after">
          <SiteThumb size="hero" accent={!!liveUrl} tone="after" />
          <figcaption>
            <span className="ba-label">With this update</span>
            {ready ? (
              <a className="btn btn-small" href={latest.url!} target="_blank" rel="noopener noreferrer" data-testid="open-preview">
                <Icon name="external" size={15} /> Open preview
              </a>
            ) : !preview || preview.previews === undefined ? (
              <span className="muted small">Loading preview…</span>
            ) : latest && (latest.state === "queued" || latest.state === "building") ? (
              <span className="small" role="status">
                <span className="pulse" aria-hidden="true" /> Building a private preview…
              </span>
            ) : latest?.state === "failed" ? (
              <span className="small warn-text">The preview could not be built. Your developer can try again.</span>
            ) : latest?.state === "expired" || latest?.state === "revoked" ? (
              <span className="muted small">The preview link {latest.state === "expired" ? "expired" : "was revoked"}. Your developer can build a new one.</span>
            ) : (
              <span className="muted small">No preview yet. Your developer builds one.</span>
            )}
          </figcaption>
        </figure>
      </div>
      {ready ? (
        <p className="muted small">
          {latest.forCurrentHash === false ? "Built for an earlier version of this result. " : ""}
          The link expires {latest.expiresAt ? formatTime(latest.expiresAt) : "soon"}. Do not forward it: anyone with the link can open the preview until then.
        </p>
      ) : null}
      <p className="muted small">Previews run on a separate site with test data: orders, payments and emails never reach production.</p>
    </section>
  );
}

/** Where the client's decision stands: You approve → your developer accepts → your developer publishes. */
export function decisionPosition(p: Proposal, facts: { live?: boolean; publishing?: boolean }): RailPosition {
  if (facts.live) return { current: 2, state: "ready", complete: true };
  if (p.state === "accepted") return { current: 2, state: "working", complete: false };
  if (currentApprovals(p).some((a) => a.role === "client")) return { current: 1, state: "working", complete: false };
  if (isClosed(p.state)) return { current: 0, state: "superseded", complete: false };
  return { current: 0, state: needsDecision(p, "client") ? "decision" : "neutral", complete: false };
}

export function clientDecisionLine(p: Proposal, facts: { live?: boolean; publishing?: boolean }): string {
  if (facts.live) return "Live on your site.";
  if (facts.publishing) return "Your developer is publishing it to your live site now.";
  if (p.state === "accepted") return "Accepted as a new version. Your developer will publish it to your live site.";
  if (currentApprovals(p).some((a) => a.role === "client")) return "You approved it. Your developer will publish: they accept it as a new version, then publish it to your live site.";
  return "Your developer will publish. After you approve, they accept it as a new version and publish it to your live site.";
}

export function ClientReviewView({ p, project, v, decisions, replaced, preview, liveUrl = null, release = null }: { p: Proposal; project: Project; v: ValidationSummary; decisions: Omit<DecisionProps, "p" | "role" | "replaced">; replaced: boolean; preview?: PreviewPanelProps | undefined; liveUrl?: string | null; release?: { live: boolean; publishing: boolean } | null }) {
  const areas = [...new Set([...p.resourceChanges, ...p.assetManifestChanges].map((r) => resourceName(project, r.resourceId)))];
  const current = currentApprovals(p);
  const mine = current.some((a) => a.role === "client");
  const approve = canApproveNow(p, "client", replaced);
  const checks = v.items;
  const chip = clientChecks(p);
  const facts = { live: !!release?.live, publishing: !!release?.publishing };
  return (
    <div className="client-review">
      <div className="client-main">
        <Card title="What changes for you" className="client-outcome">
          <p className="client-lede">This update changes the {joinAnd(areas)}.</p>
          <div className="client-checks">
            <Badge state={chip.state} icon size="lg" testId="checks-chip" pulse={chip.kind === "running"}>
              {chip.label}
            </Badge>
            <span className="muted small">{chip.detail}</span>
          </div>
          {checks.length ? (
            <ul className="checklist" aria-label="Checks">
              {checks.map((i) => (
                <li key={`${i.kind}-${i.id}`} className={`check-${i.result}`}>
                  <span aria-hidden="true">{i.result === "pass" ? "✓" : i.result === "fail" ? "✕" : "–"}</span> {i.label}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
        <BeforeAfter preview={preview} liveUrl={liveUrl} />
        <details className="tech-details">
          <summary>Show details</summary>
          <ResourceChangesView p={p} project={project} developer={false} />
        </details>
      </div>
      <aside className="client-side">
        <Card title="Your decision">
          <ReviewCode hash={p.proposalHash} />
          {current.map((a) => (
            <div key={a.approvalId} className="record small">
              Approved by {a.role} · {formatTime(a.approvedAt)}
            </div>
          ))}
          {!isClosed(p.state) ? (
            <button type="button" className={`btn ${mine ? "btn-quiet" : "btn-primary"} btn-wide`} disabled={!approve.ok || decisions.approveBusy} onClick={decisions.onApprove}>
              {decisions.approveBusy ? "Approving…" : mine ? "Approve again" : "Approve this result"}
            </button>
          ) : null}
          {approve.why ? <div className="muted small">{approve.why}</div> : null}
          <ErrorNote error={decisions.approveError} />
          <StateRail variant="client" label="Decision" steps={["Approve", "Accept", "Publish"]} position={decisionPosition(p, facts)} meta={["You", "Your developer", "Your developer"]} testId="decision-rail" />
          <p className="next-line client-publish-line">
            <Icon name="human" size={16} /> {clientDecisionLine(p, facts)}
          </p>
        </Card>
      </aside>
    </div>
  );
}

// -------------------------------------------------------------------------------------- screen

export interface ReviewViewProps {
  p: Proposal;
  project: Project;
  role: Role;
  org: string;
  pid: string;
  title: string;
  /** the newer proposal of the same Change, when this one was replaced */
  newerProposalId: string | null;
  /** the proposal this one replaced, when it is loaded */
  previous: Proposal | null;
  cx: ChangeContext | null;
  decisions: Omit<DecisionProps, "p" | "role" | "replaced">;
  validate: { onValidate: () => void; busy: boolean; error: unknown };
  /** Task 22: private preview (absent: still loading) */
  preview?: PreviewPanelProps | undefined;
  /** UX-2: the live site's address for the client's before / after (null: nothing live or unknown) */
  liveUrl?: string | null;
  /** UX-2: clients learn whether this result is live from the project history (shared with the Overview) */
  clientRelease?: { live: boolean; publishing: boolean } | null;
  /** UX-4: what the developer storyboard reads besides the proposal (version numbers, members, heads) */
  story?: StoryData | undefined;
  /** staging mode: a landing or promotion proposal, decided elsewhere (the Worker refuses decisions on it) */
  routed?: RoutedProposal | null | undefined;
}

/** A landing (`staging`) or promotion proposal, with its promotion's review screen when the project poll knows it. */
export interface RoutedProposal {
  kind: ProposalKind;
  promotionHref: string | null;
}

/**
 * Whether the proposal is a landing or promotion proposal (from the project poll's summaries), and
 * for a promotion proposal the review screen of the promotion that built it, when it is known.
 */
export function routedProposalInfo(live: Pick<LiveState, "proposals" | "promotions" | "pendingPromotions"> | undefined, proposalId: string, org: string, pid: string): RoutedProposal | null {
  if (!live || !routedProposal(live, proposalId)) return null;
  const kind = live.proposals.find((x) => x.proposalId === proposalId)!.kind!;
  const promotion = kind === "promotion" ? [...(live.pendingPromotions ?? []), ...(live.promotions ?? [])].find((x) => x.proposalId === proposalId) : undefined;
  return { kind, promotionHref: promotion ? promotionHref(org, pid, promotion.promotionId) : null };
}

/**
 * A landing or promotion proposal opened directly: what it is and where it is decided, with its
 * changed files. No decision is offered here (the Worker refuses `staging_proposal` and
 * `promotion_proposal`).
 */
export function RoutedProposalView({ p, project, role, org, pid, title, routed }: ReviewViewProps & { routed: RoutedProposal }) {
  const developer = isDeveloperRole(role);
  return (
    <div className="review">
      <div className="crumbs">
        <Link href={projectHref(org, pid, "changes")}>Changes</Link> <span aria-hidden="true">/</span> <span className="muted">Review</span>
      </div>
      <header className="review-head">
        <div>
          <h2 className="review-title">{title}</h2>
          <div className="review-sub">
            <Pill tone="info">{routed.kind === "staging" ? "On staging" : "Promotion"}</Pill>
          </div>
        </div>
      </header>
      <div className="note" role="note" data-testid="routed-proposal-note">
        {routed.kind === "staging" ? (
          <>This puts a task on staging. It is not decided here: the task goes to production when it is promoted from the Tasks board. </>
        ) : (
          <>This production update is decided on its review screen, not here. </>
        )}
        {routed.kind === "promotion" && routed.promotionHref && developer ? (
          <Link href={routed.promotionHref}>Open the production update</Link>
        ) : (
          <Link href={projectHref(org, pid, "tasks")}>Open Tasks</Link>
        )}
      </div>
      <ResourceChangesView p={p} project={project} developer={developer} />
    </div>
  );
}

/** Developers get the Change storyboard (UX-4); clients the client review (UX-2). Same proposal, same hash. */
export function ProposalReviewView(props: ReviewViewProps) {
  const { p, project, role, org, pid, title, newerProposalId } = props;
  if (props.routed) return <RoutedProposalView {...props} routed={props.routed} />;
  if (isDeveloperRole(role)) return <ChangeStoryboard {...props} />;
  const replaced = newerProposalId !== null && p.state !== "accepted";
  const status = proposalStatus(p, replaced);
  const nameOf = (rid: string) => resourceName(project, rid);
  const v = validationSummary(p, nameOf);
  const prev = props.previous ? validationSummary(props.previous, nameOf) : null;
  const fixedItems = prev && prev.verdict === "failed" && v.verdict === "passed" ? prev.items.filter((i) => i.result === "fail").map((i) => i.label) : [];
  const facts = props.clientRelease ?? { live: false, publishing: false };
  // a replaced proposal stays where it stopped, greyed out (superseded)
  const railAt = railPosition("client", replaced ? proposalStatus(p).stage : status.stage, facts);
  const rail = replaced ? { ...railAt, state: "superseded" as const } : railAt;
  const cx = props.cx;
  return (
    <div className="review">
      <div className="crumbs">
        <Link href={projectHref(org, pid, "changes")}>Changes</Link> <span aria-hidden="true">/</span> <span className="muted">Review</span>
      </div>
      <header className="review-head">
        <div>
          <h2 className="review-title">{title}</h2>
          <div className="review-sub">
            <Pill tone={status.tone}>{status.label}</Pill>
            {needsDecision(p, role, replaced) ? <DecisionBadge /> : null}
          </div>
        </div>
      </header>
      <StateRail variant="client" position={rail} />
      {replaced ? (
        <div className="note note-warn">
          A newer proposal replaced this one. <Link href={proposalHref(org, pid, newerProposalId!)}>Review the latest</Link>
        </div>
      ) : null}
      {!replaced && p.stale.length && cx ? <StaleCallout p={p} cx={cx} org={org} pid={pid} /> : null}
      {v.verdict === "running" ? <RunningBanner /> : null}
      {v.verdict === "failed" ? <BlockedBanner v={v} developer={false} replaced={replaced} /> : null}
      {fixedItems.length && !replaced ? <FixedBanner p={p} fixedItems={fixedItems} /> : null}
      <DecisionTrail p={p} acceptedVersionId={props.decisions.acceptedVersionId} developer={false} publish={props.decisions.publish} />
      <ClientReviewView p={p} project={project} v={v} decisions={props.decisions} replaced={replaced} preview={props.preview} liveUrl={props.liveUrl ?? null} release={p.state === "accepted" ? facts : null} />
    </div>
  );
}

/**
 * Why a preview cannot be built now (previews show the integrated result for the current identity).
 * `stagingMode`: the Worker refuses previews in a staging-mode project (staging phase 4-2, P42-2).
 */
export function previewBlocked(p: Proposal, stagingMode = false): string | null {
  if (stagingMode) return "Staging replaces previews in this project.";
  if (!hasCodeChanges(p)) return "Asset-only changes have nothing to preview.";
  if (!p.integration?.forCurrentHash) return "Available after validation has run for this version.";
  return null;
}

export function ProposalReview({ proposalId }: { proposalId: string }) {
  const { api } = useApp();
  const { org, pid, project, role, live, reloadLive } = useProject();
  const proposal = useLoad(() => api.getProposal(org, proposalId), `${org}/${proposalId}`, POLL_MS);
  const [acceptedVersionId, setAcceptedVersionId] = useState<string | null>(null);
  // one key per proposal view: a retry after a lost response replays instead of accepting twice
  const acceptKey = useRef(newIdempotencyKey(`accept:${proposalId}`));
  const p = proposal.data;
  // the proposal this one replaced (same Change, next older), for the "Fixed" banner
  const siblings = p && live ? live.proposals.filter((x) => x.changeId === p.changeId).sort(newestFirst) : [];
  const idx = siblings.findIndex((x) => x.proposalId === proposalId);
  const previousId = idx >= 0 ? (siblings[idx + 1]?.proposalId ?? null) : null;
  const previous = useLoad(() => (previousId ? api.getProposal(org, previousId) : Promise.resolve(null)), `${org}/prev/${previousId ?? "none"}`);
  const refresh = () => {
    proposal.reload();
    reloadLive();
    history.reload();
  };
  const approve = useAction(async (hash: string) => {
    await api.approve(org, proposalId, hash);
    refresh();
  });
  const accept = useAction(async () => {
    const r = await api.accept(org, proposalId, acceptKey.current);
    setAcceptedVersionId(r.acceptedVersionId);
    refresh();
  });
  const validate = useAction(async () => {
    await api.integrate(org, proposalId);
    refresh();
  });
  // Task 22: previews of this proposal, and the release service for its accepted version
  const previews = useLoad(() => api.listPreviews(org, proposalId), `${org}/previews/${proposalId}`, POLL_MS);
  const accepted = p?.state === "accepted";
  // UX-2: the client's live site and, once accepted, which version this proposal became (a client's
  // events carry no version id); developers get the version from the accept result or its event
  // UX-4: developers read it too, for the project-wide version numbers (ids stay in the inspector)
  const history = useProjectHistory(`review-${role}`, POLL_MS * 2);
  const dev = isDeveloperRole(role);
  // UX-4: who asked (members) and the canonical ref state of each touched resource, developers only
  const members = useLoad(() => (dev ? api.listMembers(org).catch(() => undefined) : Promise.resolve(undefined)), `${org}/members/${dev ? "on" : "off"}`);
  const touchedKey = p ? [...new Set([...p.resourceChanges.map((r) => r.resourceId), ...p.readDependencies.flatMap((d) => ("redacted" in d ? [] : [d.resourceId]))])].join(",") : "";
  const heads = useLoad(
    async () => {
      if (!dev || !touchedKey) return undefined;
      const ids = touchedKey.split(",");
      const got = await Promise.all(ids.map((rid) => api.getResource(org, rid).then((r) => r.head, () => null)));
      return Object.fromEntries(ids.map((rid, i) => [rid, got[i] ?? null])) as Record<string, AcceptedHeadView | null>;
    },
    `${org}/heads/${touchedKey}/${p?.state ?? ""}`,
  );
  const releases = useLoad(() => (accepted ? api.listReleases(org, pid) : Promise.resolve(undefined)), `${org}/releases/${pid}/${accepted ? "on" : "off"}`, accepted ? POLL_MS : undefined);
  const requestPreview = useAction(async () => {
    await api.requestPreview(org, proposalId);
    previews.reload();
  });
  const [publishBusy, setPublishBusy] = useState<PublishPanelProps["busy"]>(null);
  const deployKeys = useRef(new Map<string, string>());
  const publishAction = useAction(async (step: Exclude<PublishPanelProps["busy"], null>, releaseId?: string, outputDigest?: string) => {
    setPublishBusy(step);
    try {
      if (step === "prepare") await api.prepareRelease(org, pid);
      else if (step === "recover") await api.recoverRelease(org, releaseId!, "checked production by hand in the review screen");
      else if (step === "approve") await api.approvePublish(org, releaseId!, outputDigest!);
      else {
        // one key per release attempt view: a lost response replays instead of deploying twice
        const k = `${releaseId}:${outputDigest}`;
        if (!deployKeys.current.has(k)) deployKeys.current.set(k, newIdempotencyKey(`deploy:${releaseId}`));
        await api.deployRelease(org, releaseId!, deployKeys.current.get(k)!);
        deployKeys.current.delete(k);
      }
      releases.reload();
      reloadLive();
      history.reload();
    } finally {
      setPublishBusy(null);
    }
  });

  // the project's live state may predate this proposal (opened right after it was submitted): until the
  // next poll it is not "replaced" by the older one the live state still calls latest; refresh now
  const liveKnows = !!live && live.proposals.some((x) => x.proposalId === proposalId);
  const liveBehind = !!live && !!p && !liveKnows;
  useEffect(() => {
    if (liveBehind) reloadLive();
  }, [liveBehind, reloadLive]);

  if (proposal.error && !p) return <ErrorNote error={proposal.error} onRetry={proposal.reload} />;
  if (!p) return <Loading what="Loading proposal" />;
  const cx = live ? changeContext(live, project, role) : null;
  const latestId = liveKnows ? live?.latest.get(p.changeId) : undefined;
  const newerProposalId = latestId && latestId !== p.proposalId ? latestId : null;
  const title = reviewTitle(role, project, p, cx);
  const acceptedEvent = live?.events.find((e) => e.action === "proposal.accepted" && e.subject.id === p.proposalId);
  const recordedVersion = typeof acceptedEvent?.detail?.acceptedVersionId === "string" ? acceptedEvent.detail.acceptedVersionId : history.data && p.state === "accepted" ? (versionOfProposal(history.data.versions, p.proposalId)?.ids[0] ?? null) : null;
  const liveUrl = history.data ? (liveSite(history.data.releases, history.data.versions)?.url ?? null) : null;
  const clientRelease = history.data && p.state === "accepted" ? proposalReleaseFacts(history.data, p.proposalId) : null;
  return (
    <ProposalReviewView
      p={p}
      project={project}
      role={role}
      org={org}
      pid={pid}
      title={title}
      newerProposalId={live && liveKnows && isReplaced(p, live.latest) ? newerProposalId : null}
      previous={previous.data ?? null}
      cx={cx}
      decisions={{
        onApprove: () => void approve.run(p.proposalHash),
        approveBusy: approve.busy,
        approveError: approve.error,
        onAccept: () => void accept.run(),
        acceptBusy: accept.busy,
        acceptError: accept.error,
        acceptedVersionId: acceptedVersionId ?? recordedVersion,
        publish: {
          releases: releases.data,
          acceptedVersionId: acceptedVersionId ?? recordedVersion,
          onPrepare: () => void publishAction.run("prepare"),
          onApprove: (r) => void publishAction.run("approve", r.releaseId, r.outputDigest ?? ""),
          onDeploy: (r) => void publishAction.run("deploy", r.releaseId, r.outputDigest ?? ""),
          onRecover: (r) => void publishAction.run("recover", r.releaseId),
          busy: publishBusy,
          error: publishAction.error,
        },
      }}
      liveUrl={liveUrl}
      clientRelease={clientRelease}
      routed={routedProposalInfo(live, p.proposalId, org, pid)}
      story={{
        versionOf: (id) => (history.data && id ? (versionById(history.data.versions, id)?.number ?? null) : null),
        ...(members.data ? { members: members.data } : {}),
        ...(heads.data ? { heads: heads.data } : {}),
      }}
      validate={{ onValidate: () => void validate.run(), busy: validate.busy, error: validate.error }}
      preview={{
        previews: previews.data,
        blockedWhy: previewBlocked(p, !!live?.staging?.enabled),
        onRequest: () => void requestPreview.run(),
        busy: requestPreview.busy,
        error: requestPreview.error ?? previews.error,
      }}
    />
  );
}
