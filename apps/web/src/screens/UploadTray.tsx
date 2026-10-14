/**
 * The Files tab's upload tray and change status (spec §8, plan phase 3 Task 9): each file's
 * progress and state, each batch's one change in the status words of the plan, with a link to
 * its proposal. Pure views: the screen owns the queue and the polling.
 */
import type { FileChange } from "../api/types.js";
import type { Tone } from "../lib/model.js";
import { proposalHref } from "../lib/router.js";
import type { UploadBatch, UploadItem, UploadItemState } from "../lib/uploads.js";
import { codeMessage, Link, Pill } from "../ui.js";

/** A change's status in words (spec §8): "Adding…", "Checking", "Waiting for approval", "On staging", "Added", or the failure. */
export function changeStatus(c: Pick<FileChange, "state" | "error" | "note">): { label: string; tone: Tone } {
  switch (c.state) {
    case "applying":
      return { label: "Adding…", tone: "busy" };
    case "checking":
      return { label: "Checking", tone: "busy" };
    case "waiting_approval":
      return { label: "Waiting for approval", tone: "warn" };
    case "staged":
      return { label: "On staging", tone: "info" };
    case "added":
      return { label: c.note === "no_changes" ? "Added (nothing changed)" : "Added", tone: "good" };
    case "failed":
      return { label: c.error ? codeMessage(c.error.code, c.error.message) : "Nothing was added.", tone: "bad" };
    default:
      return { label: String(c.state), tone: "neutral" };
  }
}

export const isOpenChange = (c: Pick<FileChange, "state">) => c.state === "applying" || c.state === "checking" || c.state === "waiting_approval" || c.state === "staged";

/**
 * How often to re-read changes: every 1.5 s while one is being added or checked; every 15 s
 * while they only wait for someone's approval (that takes a person, not seconds); every 60 s while
 * they are only on staging (a promotion takes a person and a production release); null when none
 * is open.
 */
export function changePollMs(changes: ReadonlyArray<Pick<FileChange, "state">>): number | null {
  if (changes.some((c) => c.state === "applying" || c.state === "checking")) return 1500;
  if (changes.some((c) => c.state === "waiting_approval")) return 15_000;
  if (changes.some((c) => c.state === "staged")) return 60_000;
  return null;
}

/** One change's status: the words, the proposal link once there is one, and who acts while it waits. */
export function ChangeStatusLine({ org, pid, change }: { org: string; pid: string; change: FileChange }) {
  const s = changeStatus(change);
  return (
    <div className="change-status" data-state={change.state}>
      {change.state === "failed" ? (
        <span className="note-inline-bad small" role="alert">
          {s.label}
        </span>
      ) : (
        <Pill tone={s.tone}>{s.label}</Pill>
      )}
      {change.proposalId ? (
        <Link className="small" href={proposalHref(org, pid, change.proposalId)}>
          View the change
        </Link>
      ) : null}
      {change.state === "waiting_approval" ? <span className="muted small">It is added once someone with approval rights approves it.</span> : null}
      {change.state === "staged" ? <span className="muted small">It reaches the folder in production once its task is promoted from staging.</span> : null}
    </div>
  );
}

const ITEM_WORDS: Record<UploadItemState, string> = {
  queued: "Waiting",
  uploading: "Uploading",
  hashing: "Finishing",
  done: "Uploaded",
  failed: "Failed",
  canceled: "Canceled",
};

/** 0 to 100; an empty file is complete as soon as it is done. */
function percent(i: UploadItem): number {
  if (i.size === 0) return i.state === "done" ? 100 : 0;
  return Math.min(100, Math.round((i.sent / i.size) * 100));
}

function TrayItem({ item, onCancel, onRetry, onRemove }: { item: UploadItem; onCancel: (id: string) => void; onRetry: (id: string) => void; onRemove: (id: string) => void }) {
  const pct = percent(item);
  const running = item.state === "queued" || item.state === "uploading" || item.state === "hashing";
  return (
    <li className={`tray-item tray-item-${item.state}`}>
      <div className="tray-item-head">
        <span className="tray-path">{item.path}</span>
        <span className="tray-state small muted">
          {ITEM_WORDS[item.state]}
          {item.state === "uploading" ? ` ${pct}%` : ""}
        </span>
      </div>
      <div className="tray-bar" role="progressbar" aria-label={`Upload of ${item.path}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span className="tray-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {item.state === "failed" && item.error ? (
        <p className="note-inline-bad small" role="alert">
          {item.error}
        </p>
      ) : null}
      <div className="tray-actions">
        {running ? (
          <button type="button" className="btn btn-quiet btn-small" onClick={() => onCancel(item.id)}>
            Cancel
          </button>
        ) : null}
        {item.state === "failed" ? (
          <>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => onRetry(item.id)}>
              Retry
            </button>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => onRemove(item.id)}>
              Remove
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}

/** A batch is finished (dismissable) once it was refused, or its change was sent and is terminal or refused. */
export function batchFinished(b: UploadBatch, items: UploadItem[]): boolean {
  const mine = items.filter((i) => i.batchId === b.id);
  if (mine.some((i) => i.state === "queued" || i.state === "uploading" || i.state === "hashing")) return false;
  if (b.error) return true;
  if (b.change) return !isOpenChange(b.change);
  // every file canceled: nothing will be sent
  return mine.length === 0 || mine.every((i) => i.state === "canceled");
}

export interface UploadTrayViewProps {
  org: string;
  pid: string;
  items: UploadItem[];
  batches: UploadBatch[];
  onCancel: (itemId: string) => void;
  onRetry: (itemId: string) => void;
  onRemove: (itemId: string) => void;
  onDismiss: (batchId: string) => void;
  /** a batch whose change could not be sent (`sendError`): send it again with the same uploads */
  onResend: (batchId: string) => void;
}

/** The tray: one group per batch (an upload, or a single action with no items), newest last. */
export function UploadTrayView({ org, pid, items, batches, onCancel, onRetry, onRemove, onDismiss, onResend }: UploadTrayViewProps) {
  if (batches.length === 0) return null;
  return (
    <section className="tray" aria-label="Uploads and changes">
      <ul className="tray-batches">
        {batches.map((b) => {
          const mine = items.filter((i) => i.batchId === b.id);
          return (
            <li key={b.id} className="tray-batch" data-batch={b.id}>
              <div className="tray-batch-head">
                <span className="tray-title">{b.title}</span>
                {batchFinished(b, items) ? (
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => onDismiss(b.id)}>
                    Dismiss
                  </button>
                ) : null}
              </div>
              {b.error ? (
                <p className="note-inline-bad small" role="alert">
                  {b.error}
                </p>
              ) : null}
              {b.sendError !== undefined ? (
                <div className="tray-actions">
                  <p className="note-inline-bad small" role="alert">
                    The change could not be sent: {b.sendError}. The files are uploaded and kept.
                  </p>
                  <button type="button" className="btn btn-primary btn-small" onClick={() => onResend(b.id)}>
                    Send again
                  </button>
                </div>
              ) : null}
              {b.change ? <ChangeStatusLine org={org} pid={pid} change={b.change} /> : null}
              {mine.length > 0 ? (
                <ul className="tray-items">
                  {mine.map((i) => (
                    <TrayItem key={i.id} item={i} onCancel={onCancel} onRetry={onRetry} onRemove={onRemove} />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Open changes of this folder that this tab did not start (another tab, a teammate), above the tree. */
export function ChangeStatusList({ org, pid, changes }: { org: string; pid: string; changes: FileChange[] }) {
  if (changes.length === 0) return null;
  return (
    <section className="change-list" aria-label="Changes in progress">
      <ul>
        {changes.map((c) => (
          <li key={c.changeId}>
            <span className="tray-title">{c.title}</span>
            <ChangeStatusLine org={org} pid={pid} change={c} />
          </li>
        ))}
      </ul>
    </section>
  );
}
