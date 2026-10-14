/**
 * A confirm sheet: says what an action does and does not do, with one primary action and Cancel.
 * Inline (not modal), so it stays next to the thing it confirms; focus moves to it on mount,
 * Escape cancels, and Cancel/Escape give focus back to `returnFocusId`. Carries the `confirm` class the capture selectors target.
 */
import { useEffect, useRef, type ReactNode } from "react";

/**
 * Focus the element with this id once the current render has settled: the trigger that opened a
 * sheet is often re-mounted only after the sheet unmounts.
 */
export function focusLater(id: string | undefined): void {
  if (!id || typeof document === "undefined") return;
  setTimeout(() => document.getElementById(id)?.focus(), 0);
}

export function ConfirmSheet({ title, does, doesNot, confirmLabel, busyLabel, busy = false, disabled = false, onConfirm, onCancel, tone = "decision", returnFocusId, children }: { title?: ReactNode; does?: ReactNode; doesNot?: ReactNode; confirmLabel: string; busyLabel?: string; busy?: boolean; /** the primary action is unavailable (not busy): e.g. the form is not valid yet */ disabled?: boolean; onConfirm: () => void; onCancel: () => void; tone?: "decision" | "blocked"; /** element to focus after Cancel or Escape (usually the trigger) */ returnFocusId?: string; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const cancel = () => {
    onCancel();
    focusLater(returnFocusId);
  };
  return (
    <div
      ref={ref}
      className={`confirm confirm-${tone}`}
      role="group"
      aria-label={typeof title === "string" ? title : confirmLabel}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
      }}
    >
      {title ? <div className="confirm-title">{title}</div> : null}
      {children}
      {does || doesNot ? (
        <ul className="confirm-facts small">
          {does ? <li className="confirm-does">{does}</li> : null}
          {doesNot ? <li className="confirm-does-not">{doesNot}</li> : null}
        </ul>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="btn btn-primary btn-small" disabled={busy || disabled} onClick={onConfirm}>
          {busy ? (busyLabel ?? `${confirmLabel}…`) : confirmLabel}
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
