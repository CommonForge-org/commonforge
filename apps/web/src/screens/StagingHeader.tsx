/**
 * The staging header (staging phase 3, spec §8 "Web"): above the project tabs of a staging-mode
 * project only. The staging link (a new tab), when staging last changed, "Building…" while a staging
 * build runs, "Staging starts after your first production publish" (with the way to publish) while
 * staging waits for it,
 * Reset demo data (owner, developer, client) and the Sent from staging toggle with the number of
 * captures of the last 24 hours. Renders nothing when staging is off or not loaded yet.
 */
import { useState } from "react";
import type { Capture, Role, StagingView } from "../api/types.js";
import { isDeveloperRole, relativeTime } from "../lib/model.js";
import { Badge, ConfirmSheet, CountBadge, Icon } from "../primitives/index.js";
import { focusLater } from "../primitives/ConfirmSheet.js";
import { errorMessage, Link } from "../ui.js";

export const SENT_TOGGLE_ID = "cf-sent-toggle";
export const SENT_DRAWER_ID = "cf-sent";
const RESET_ID = "cf-staging-reset";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Captures received in the 24 hours before `now`. */
export function recentCaptureCount(captures: readonly Capture[] | undefined, now: Date = new Date()): number {
  if (!captures) return 0;
  const from = now.getTime() - DAY_MS;
  return captures.filter((c) => {
    const t = Date.parse(c.receivedAt);
    return !Number.isNaN(t) && t >= from;
  }).length;
}

/** The staging link only for an absolute `http:`/`https:` URL (never `javascript:`, `data:` or a malformed value); null otherwise. */
export function safeStagingUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url === "") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export function StagingHeader({ staging, role, captures, now = new Date(), onReset, onOpenSent, sentOpen, publishHref }: { staging: StagingView | undefined; role: Role; captures: Capture[] | undefined; now?: Date; onReset: () => Promise<void>; onOpenSent: () => void; sentOpen: boolean; /** owners and developers: where the first production publish is done (Versions), shown while staging waits for it */ publishHref?: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!staging?.enabled) return null;
  const awaiting = staging.state === "awaiting_baseline";
  const canReset = role !== "viewer";
  const recent = recentCaptureCount(captures, now);
  const url = safeStagingUrl(staging.url);
  const reset = () => {
    setBusy(true);
    setError(null);
    onReset().then(
      () => {
        setBusy(false);
        setConfirming(false);
        // the sheet is gone: focus goes back to the button that opened it
        focusLater(RESET_ID);
      },
      (e: unknown) => {
        setBusy(false);
        setError(e);
      },
    );
  };
  return (
    <section className="staging-bar" aria-label="Staging" data-testid="staging-header">
      <span className="staging-label">Staging</span>
      {awaiting ? (
        // the platform's state (API.md "Baseline"), said for the reader: who publishes, and where
        <span className="staging-fact" data-testid="staging-awaiting">
          {isDeveloperRole(role) ? "Staging starts after your first production publish." : "Staging starts after your developer's first production publish."}
          {isDeveloperRole(role) && publishHref ? (
            <>
              {" "}
              <Link href={publishHref}>Publish now</Link>
            </>
          ) : null}
        </span>
      ) : (
        <>
          {url ? (
            <a className="staging-link" href={url} target="_blank" rel="noopener noreferrer" title={url} data-testid="staging-link">
              Open staging site
              <Icon name="external" size={14} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
          {staging.current ? (
            <span className="staging-fact">
              Updated <time dateTime={staging.current.since}>{relativeTime(staging.current.since, now)}</time>
            </span>
          ) : null}
        </>
      )}
      {staging.building ? (
        <Badge state="working" pulse size="sm" testId="staging-building">
          Building…
        </Badge>
      ) : null}
      <span className="staging-spacer" />
      <div className="staging-actions">
        <button type="button" id={SENT_TOGGLE_ID} className={`btn btn-quiet btn-small ${sentOpen ? "is-on" : ""}`.trim()} aria-expanded={sentOpen} {...(sentOpen ? { "aria-controls": SENT_DRAWER_ID } : {})} onClick={onOpenSent} data-testid="staging-sent-toggle">
          <Icon name="mail" size={15} />
          Sent from staging
          <CountBadge count={recent} label={`${recent} sent in the last 24 hours`} />
        </button>
        {canReset && !confirming ? (
          <button type="button" id={RESET_ID} className="btn btn-quiet btn-small" onClick={() => setConfirming(true)} data-testid="staging-reset">
            Reset demo data
          </button>
        ) : null}
      </div>
      {canReset && confirming ? (
        <div className="staging-confirm">
          <ConfirmSheet
            title="Reset demo data?"
            does="Staging's database goes back to the demo data."
            doesNot="Production is not affected."
            confirmLabel="Reset demo data"
            busyLabel="Resetting…"
            busy={busy}
            onConfirm={reset}
            onCancel={() => {
              setConfirming(false);
              setError(null);
            }}
            returnFocusId={RESET_ID}
          >
            {error ? (
              <p className="note note-bad small" role="alert">
                {errorMessage(error, isDeveloperRole(role))}
              </p>
            ) : null}
          </ConfirmSheet>
        </div>
      ) : null}
    </section>
  );
}
