/**
 * Sent from staging (staging phase 3, spec §8 "Web"): what staging's emails and webhooks sent to the
 * capture sink, newest first, in the right-hand drawer. Headers arrive credential-free from the
 * Worker (`services/sink.ts`); bodies are shown as sent, monospace and collapsible, with a marker
 * when the Worker clipped them at 16 KiB.
 */
import type { Capture } from "../api/types.js";
import { relativeTime } from "../lib/model.js";
import { EmptyState, InspectorDrawer } from "../primitives/index.js";
import { SENT_DRAWER_ID, SENT_TOGGLE_ID } from "./StagingHeader.js";

function newestFirst(captures: readonly Capture[]): Capture[] {
  return [...captures].sort((a, b) => (Date.parse(b.receivedAt) || 0) - (Date.parse(a.receivedAt) || 0));
}

function CaptureItem({ c, now }: { c: Capture; now: Date }) {
  const headers = Object.entries(c.headers);
  return (
    <article className="capture" data-testid="capture">
      <header className="capture-head">
        <span className="capture-method mono">{c.method}</span>
        <span className="capture-path mono">{c.path || "/"}</span>
        <time className="capture-time muted small" dateTime={c.receivedAt} title={c.receivedAt}>
          {relativeTime(c.receivedAt, now)}
        </time>
      </header>
      {headers.length ? (
        <details className="capture-part">
          <summary>Headers · {headers.length}</summary>
          <dl className="capture-headers mono">
            {headers.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
      <details className="capture-part" open>
        <summary>
          Body
          {c.truncated ? <span className="capture-truncated"> · truncated</span> : null}
        </summary>
        {c.body ? <pre className="mono capture-body">{c.body}</pre> : <p className="muted small">Empty body.</p>}
        {c.truncated ? <p className="muted small">Only the first 16 KiB were kept.</p> : null}
      </details>
    </article>
  );
}

export function SentFromStaging({ open, captures, now = new Date(), onClose }: { open: boolean; captures: Capture[] | undefined; now?: Date; onClose: () => void }) {
  return (
    <InspectorDrawer open={open} onClose={onClose} sections={[]} title="Sent from staging" subtitle="Emails and webhooks" id={SENT_DRAWER_ID} closeLabel="Close Sent from staging" returnFocusId={SENT_TOGGLE_ID} testId="sent-from-staging">
      {captures === undefined ? (
        <p className="muted small">Could not read what staging sent. It will show here on the next refresh.</p>
      ) : captures.length === 0 ? (
        <EmptyState compact icon="mail" title="Nothing sent yet.">
          Emails and webhooks from staging are caught here and never delivered.
        </EmptyState>
      ) : (
        <div className="captures">
          {newestFirst(captures).map((c) => (
            <CaptureItem key={c.captureId} c={c} now={now} />
          ))}
        </div>
      )}
    </InspectorDrawer>
  );
}
