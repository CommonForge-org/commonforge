/**
 * The Promote sheet (staging phase 3, ruling P3-7): before a task goes to production the sheet asks
 * the Worker's dry run (`GET /api/tasks/:id/promote`) which tasks go with it and lists them ("These
 * go to production together:"), or, when the task goes alone, the tasks it leaves on staging
 * ("Going without: …" with the platform's text). Confirm sends the real request; errors are in plain
 * words.
 */
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import type { PromotionPreview } from "../api/types.js";
import { ConfirmSheet } from "../primitives/index.js";
import { errorMessage } from "../ui.js";

/** The Worker's promote refusals (API.md "Promotions") in plain words; anything else as every other error. */
export function promoteErrorText(e: unknown, developer = false): string {
  if (e instanceof ApiError) {
    const title = typeof e.details?.title === "string" ? e.details.title : null;
    switch (e.code) {
      case "staging_awaiting_baseline":
        return "Staging starts after the first production publish.";
      case "not_landed":
        return "This task is still getting ready on staging. Try again in a moment.";
      case "not_in_staging":
        return "This task is no longer on staging, so there is nothing to promote.";
      case "promotion_in_progress":
        return "This task is already on its way to production.";
      case "promotion_dependency_busy":
        return title ? `It has to go with '${title}', which is not ready yet. Try again when it is.` : "A task it has to go with is not ready yet. Try again when it is.";
      case "travel_with_left_staging":
        return "A task this one must travel with left staging. A developer needs to remove the link first.";
      case "staging_changed":
        return "Staging changed just now. Try again.";
      case "not_found":
        return "This task is not in a project with staging, or you cannot promote it.";
    }
  }
  return errorMessage(e, developer);
}

export interface PromoteSheetViewProps {
  title: string;
  /** the dry run; undefined while it loads */
  preview: PromotionPreview | undefined;
  /** the dry run failed (shown in plain words; Promote stays disabled) */
  previewError: unknown;
  busy: boolean;
  error: unknown;
  developer?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  returnFocusId?: string;
}

export function PromoteSheetView({ title, preview, previewError, busy, error, developer = false, onConfirm, onCancel, returnFocusId }: PromoteSheetViewProps) {
  const together = preview && preview.landings.length > 1;
  return (
    <ConfirmSheet
      title={`Promote '${title}' to production?`}
      does="Production gets these changes once the automatic checks pass. Some changes wait for a developer's approval first."
      doesNot="Staging keeps running as it is."
      confirmLabel="Promote"
      busyLabel="Promoting…"
      busy={busy}
      disabled={!preview || !!previewError}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...(returnFocusId ? { returnFocusId } : {})}
    >
      <div className="promote-sheet" data-testid="promote-sheet">
        {previewError ? (
          <p className="note note-bad small" role="alert">
            {promoteErrorText(previewError, developer)}
          </p>
        ) : !preview ? (
          <p className="muted small" role="status">
            Checking which tasks go with it…
          </p>
        ) : (
          <>
            <p className="small promote-lead">{together ? "These go to production together:" : preview.mode === "alone" ? "Goes to production on its own:" : "Goes to production:"}</p>
            <ul className="promote-list" data-testid="promote-set">
              {preview.landings.map((l) => (
                <li key={l.landingId}>{l.title}</li>
              ))}
            </ul>
            {preview.goingWithout.length ? (
              <>
                <p className="small promote-lead">Going without:</p>
                <ul className="promote-list promote-without" data-testid="promote-without">
                  {preview.goingWithout.map((l) => (
                    <li key={l.landingId}>{l.text}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        )}
        {error ? (
          <p className="note note-bad small" role="alert">
            {promoteErrorText(error, developer)}
          </p>
        ) : null}
      </div>
    </ConfirmSheet>
  );
}

/** The sheet with its dry run: loads the preview on open, Confirm calls `onPromote`. */
export function PromoteSheet({ title, loadPreview, onPromote, onDone, onCancel, developer = false, returnFocusId }: { title: string; loadPreview: () => Promise<PromotionPreview>; onPromote: () => Promise<void>; onDone: () => void; onCancel: () => void; developer?: boolean; returnFocusId?: string }) {
  const [preview, setPreview] = useState<PromotionPreview | undefined>(undefined);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    loadPreview().then(
      (p) => alive && setPreview(p),
      (e: unknown) => alive && setPreviewError(e),
    );
    return () => {
      alive = false;
    };
    // the dry run is read once per open sheet
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const confirm = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onPromote().then(
      () => {
        setBusy(false);
        onDone();
      },
      (e: unknown) => {
        setBusy(false);
        setError(e);
      },
    );
  };
  return <PromoteSheetView title={title} preview={preview} previewError={previewError} busy={busy} error={error} developer={developer} onConfirm={confirm} onCancel={onCancel} {...(returnFocusId ? { returnFocusId } : {})} />;
}
