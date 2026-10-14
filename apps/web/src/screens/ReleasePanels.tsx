/**
 * Task 22 panels on the proposal review: the private preview (token-gated link on the preview
 * origin, fixture data only) and the Publish decision (prepare release → publish approval →
 * deploy → `/version` check). Pure views: the container (ProposalReview) loads and acts.
 *
 * Approval ≠ acceptance ≠ publishing: Publish is only available for an accepted version, needs its
 * own publish approval (owner by default), and a failed deploy shows "Approved, not live" while
 * the previous release stays live.
 */
import type { PreviewView, ReleaseList, ReleaseView, Role } from "../api/types.js";
import { formatTime, isDeveloperRole } from "../lib/model.js";
import { Icon, type InspectorSection } from "../primitives/index.js";
import { Card, ErrorNote, Pill } from "../ui.js";
import { useInspectorSections } from "./project-data.js";

// ------------------------------------------------------------------------------------- preview

export interface PreviewPanelProps {
  /** newest first; undefined while loading */
  previews: PreviewView[] | undefined;
  /** why a new preview cannot be built now (null: it can) */
  blockedWhy: string | null;
  onRequest: () => void;
  busy: boolean;
  error: unknown;
}

const PREVIEW_FAIL: Record<string, string> = {
  check_failed: "The preview build failed",
  scope_violation: "The preview build tried something it is not allowed to",
  provider_unavailable: "The preview runner was unavailable",
  job_expired: "The preview build ran out of time",
};

export function PreviewCard({ role, preview }: { role: Role; preview?: PreviewPanelProps | undefined }) {
  const developer = isDeveloperRole(role);
  const latest = preview?.previews?.[0];
  return (
    <Card title="Private preview" className="preview-card">
      <p className="small">A token-gated preview of this exact combination. Orders, payments and emails in it go to test fixtures, never to production.</p>
      {!preview || preview.previews === undefined ? <div className="muted small">Loading preview…</div> : null}
      {latest?.state === "ready" && latest.url ? (
        <>
          <a className="btn" href={latest.url} target="_blank" rel="noopener noreferrer" data-testid="open-preview">
            Open preview
          </a>
          <div className="muted small">
            {latest.forCurrentHash === false ? "Built for an earlier version of this proposal. " : ""}
            Link expires {latest.expiresAt ? formatTime(latest.expiresAt) : "soon"}. Do not forward it: anyone with the link can open the preview until then.
          </div>
        </>
      ) : null}
      {latest && (latest.state === "queued" || latest.state === "building") ? (
        <div className="small" role="status">
          <span className="pulse" aria-hidden="true" /> Building the preview in an isolated sandbox…
        </div>
      ) : null}
      {latest?.state === "failed" ? (
        <div className="small bad-text">
          {PREVIEW_FAIL[latest.error?.code ?? ""] ?? "The preview could not be built"}.{developer && latest.error?.detail ? <pre className="log-tail">{latest.error.detail}</pre> : null}
        </div>
      ) : null}
      {latest?.state === "expired" || latest?.state === "revoked" ? <div className="muted small">The last preview link {latest.state === "expired" ? "expired" : "was revoked"}.</div> : null}
      {preview?.previews && preview.previews.length === 0 && !developer ? <div className="muted small">No preview yet. Your developer can build one.</div> : null}
      {developer && preview ? (
        <>
          <button type="button" className={`btn ${latest?.state === "ready" ? "btn-quiet" : ""}`} disabled={!!preview.blockedWhy || preview.busy || latest?.state === "queued" || latest?.state === "building"} onClick={preview.onRequest}>
            {preview.busy ? "Starting…" : latest ? "Build a new preview" : "Build preview"}
          </button>
          {preview.blockedWhy ? <div className="muted small">{preview.blockedWhy}</div> : null}
          <ErrorNote error={preview.error} />
        </>
      ) : null}
      <p className="muted small">Previews are served from a separate preview site (all previews share it). They never see your CommonForge session.</p>
    </Card>
  );
}

// ------------------------------------------------------------------------------------- publish

export interface PublishPanelProps {
  /** undefined while loading */
  releases: ReleaseList | undefined;
  /** the accepted version this proposal produced (null: unknown) */
  acceptedVersionId: string | null;
  onPrepare: () => void;
  onApprove: (release: ReleaseView) => void;
  onDeploy: (release: ReleaseView) => void;
  /** owner: mark a release that needs recovery as recovered (after checking production) */
  onRecover?: (release: ReleaseView) => void;
  busy: "prepare" | "approve" | "deploy" | "recover" | null;
  error: unknown;
}

/**
 * The release that publishes this proposal's accepted version (newest first). Unknown version:
 * none (never guess: the newest release may be another version's, e.g. the one live today).
 */
export function releaseFor(list: ReleaseList | undefined, acceptedVersionId: string | null): ReleaseView | null {
  if (!list || !acceptedVersionId) return null;
  return list.releases.find((r) => r.acceptedVersionId === acceptedVersionId) ?? null;
}

export function publishTrail(accepted: boolean, release: ReleaseView | null): string {
  if (!accepted) return "Not published";
  if (!release) return "Not published yet";
  if (release.live) return `Live · ${formatTime(release.updatedAt)}`;
  return release.status;
}

export function PublishStep({ role, accepted, publish, versionLabel, current = false }: { role: Role; accepted: boolean; publish?: PublishPanelProps | undefined; /** e.g. "Version 4" (UX-2 numbering) */ versionLabel?: string | undefined; /** UX-4: Publish is the storyboard's current step */ current?: boolean }) {
  const developer = isDeveloperRole(role);
  const rel = releaseFor(publish?.releases, publish?.acceptedVersionId ?? null);
  const liveId = publish?.releases?.live?.releaseId ?? null;
  const pill = !accepted || !rel ? <Pill tone="muted">Not live</Pill> : rel.live ? <Pill tone="good">Live</Pill> : rel.publishApproved ? <Pill tone="warn">{rel.status}</Pill> : <Pill tone="neutral">{rel.status}</Pill>;
  const busy = publish?.busy ?? null;
  return (
    <li className={["step", rel?.live ? "step-done" : !accepted ? "step-disabled" : "", current && !rel?.live ? "step-current" : ""].filter(Boolean).join(" ")} data-testid="step-publish">
      <div className="step-head">
        <span className="step-num">{rel?.live ? <Icon name="check" size={13} strokeWidth={3} /> : "3"}</span>
        <strong>Publish</strong>
        {pill}
      </div>
      <p className="small">A separate publish approval deploys an accepted version to production. Accepting never publishes.</p>
      {!accepted ? (
        <>
          <button type="button" className="btn" disabled>
            Publish to production
          </button>
          <div className="muted small">Available after this change is accepted.</div>
        </>
      ) : !publish || publish.releases === undefined ? (
        <div className="muted small">Loading release…</div>
      ) : !rel ? (
        developer ? (
          <>
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={publish.onPrepare}>
              {busy === "prepare" ? "Preparing…" : "Prepare release"}
            </button>
            <div className="muted small">Builds this accepted version in the sandbox. Nothing is deployed until a publish approval.</div>
          </>
        ) : (
          <div className="muted small">Not published yet.</div>
        )
      ) : (
        <ReleaseControls role={role} rel={rel} liveId={liveId} publish={publish} versionLabel={versionLabel} />
      )}
      <ErrorNote error={publish?.error ?? null} />
    </li>
  );
}

/**
 * One release's record and its next action: approve publishing (owner), publish / retry
 * (developers), the honest problem states (failed, partly deployed, rolled back, recovery
 * required) and the live targets. Shared by the proposal's Publish step and Versions' "Publish
 * this version" (UX-3).
 */
export function ReleaseControls({ role, rel, liveId, publish, versionLabel }: { role: Role; rel: ReleaseView; liveId: string | null; publish: PublishPanelProps; /** e.g. "version 7"; default "this accepted version" */ versionLabel?: string | undefined }) {
  const developer = isDeveloperRole(role);
  const busy = publish.busy;
  // UX-POLISH §6: release, version and output ids live in the developer inspector, not the card
  useInspectorSections(developer ? releaseInspector(rel, liveId) : null, `release|${rel.releaseId}|${rel.outputDigest ?? ""}|${liveId ?? ""}`);
  return (
    <>
      <div className="record small" data-testid="release-record">
        Release for {versionLabel ?? "this accepted version"}
        {rel.outputDigest ? <span className="muted"> · built</span> : null}
        {liveId && liveId !== rel.releaseId ? <div className="muted">Production still runs the previous release.</div> : null}
      </div>
      {rel.buildState === "building" ? <div className="small" role="status">Building the release…</div> : null}
      {rel.buildState === "failed" ? <div className="small bad-text">The release build failed{rel.error?.code ? ` (${rel.error.code})` : ""}.</div> : null}
      {rel.buildState === "failed" && developer ? (
        <button type="button" className="btn" disabled={busy !== null} onClick={publish.onPrepare}>
          Prepare again
        </button>
      ) : null}
      {rel.state === "prepared" ? (
        role === "owner" ? (
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => publish.onApprove(rel)}>
            {busy === "approve" ? "Approving…" : "Approve publishing this release"}
          </button>
        ) : (
          <div className="muted small">Waiting for a publish approval.</div>
        )
      ) : null}
      {developer && rel.targets?.length ? (
        <details className="small">
          <summary>What the approval covers</summary>
          <ul>
            {rel.targets.map((t) => (
              <li key={t.targetId}>
                <code>{t.workerName}</code> ({t.kind}, {t.files} files, digest <code>{t.digest.slice(0, 12)}</code>): compatibility {t.config.compatibilityDate}
                {t.config.compatibilityFlags.length ? ` [${t.config.compatibilityFlags.join(", ")}]` : ""}; vars {Object.keys(t.config.vars).join(", ") || "none"}; KV {t.config.kvNamespaces.map((k) => `${k.binding}=${k.id.slice(0, 8)}…`).join(", ") || "none"}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {rel.publishApproved && !rel.live && ["publish_approved", "failed", "recovery_required", "partial"].includes(rel.state) && rel.rollback?.state !== "running" && rel.rollback?.state !== "verifying" && developer ? (
        <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => publish.onDeploy(rel)}>
          {busy === "deploy" ? "Publishing…" : rel.state === "publish_approved" ? "Publish to production" : rel.state === "partial" ? "Retry to finish publishing" : "Retry publish"}
        </button>
      ) : null}
      {rel.state === "deploying" || rel.state === "health_verification" ? (
        <div className="small" role="status">
          <span className="pulse" aria-hidden="true" /> {rel.state === "deploying" ? "Deploying…" : "Checking the live version…"}
        </div>
      ) : null}
      {(rel.state === "failed" || rel.state === "partial" || rel.state === "recovery_required") && rel.buildState === "built" ? (
        <div className={`small ${rel.state === "failed" ? "warn-text" : "bad-text"}`} data-testid="release-problem">
          {rel.status}.{" "}
          {rel.state === "partial"
            ? "Some targets were updated, others not; publish again to finish."
            : rel.state === "recovery_required"
              ? rel.rollback?.state === "running" || rel.rollback?.state === "verifying"
                ? "It deployed but did not pass its check; production is being rolled back to the previous release."
                : "It deployed but could not be verified, and production could not be restored automatically. Production may be running this release unverified."
              : rel.rollback?.state === "done"
                ? "It deployed but did not pass its check, so production was rolled back: the previous release is live again."
                : "Nothing was changed: the previous release is still live."}
          {developer && rel.error?.detail ? <pre className="log-tail">{rel.error.detail}</pre> : null}
        </div>
      ) : null}
      {role === "owner" && publish.onRecover && (rel.state === "recovery_required" || rel.state === "partial") && rel.rollback?.state !== "running" && rel.rollback?.state !== "verifying" ? (
        <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => publish.onRecover!(rel)}>
          {busy === "recover" ? "Marking…" : "I checked production: mark recovered"}
        </button>
      ) : null}
      {rel.live ? (
        <ul className="small">
          {rel.deployments.map((d) => (
            <li key={d.targetId}>
              {d.workerName}
              {d.url ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={d.url} target="_blank" rel="noopener noreferrer">
                    open
                  </a>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** The release's identities for the inspector drawer (developers), with copy buttons. */
export function releaseInspector(rel: ReleaseView, liveId: string | null): InspectorSection[] {
  const rows: InspectorSection["rows"] = [
    { label: "Release", value: rel.releaseId, copy: rel.releaseId },
    { label: "Accepted version", value: rel.acceptedVersionId, copy: rel.acceptedVersionId },
    { label: "State", value: `${rel.state} · build ${rel.buildState} · attempts ${rel.deployAttempts}` },
  ];
  if (rel.outputDigest) rows.push({ label: "Output digest", value: rel.outputDigest, copy: rel.outputDigest });
  rows.push({ label: "Environment digest", value: rel.envDigest, copy: rel.envDigest });
  if (liveId) rows.push({ label: "Live release", value: liveId, copy: liveId });
  return [{ title: "Release", rows }];
}
