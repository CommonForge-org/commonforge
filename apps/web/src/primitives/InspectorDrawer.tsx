/**
 * The developer inspector (docs/UX-POLISH.md §4): a right-hand, togglable drawer that holds the
 * technical detail (ids, hashes, revisions, ledger codes) in a mono font, each value with a copy
 * button. Non-modal: the page stays usable. Keyboard: the header toggle has `aria-expanded` and
 * `aria-controls`; opening moves focus into the drawer, Escape inside it closes it and returns
 * focus to the toggle.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons.js";

export interface InspectorRow {
  label: string;
  value: ReactNode;
  /** the text the copy button writes (omit: no copy button) */
  copy?: string;
  /** render the value in the mono font (default true) */
  mono?: boolean;
  tone?: "plain" | "bad" | "good" | "warn";
}

export interface InspectorSection {
  title: string;
  rows: InspectorRow[];
}

export const INSPECTOR_ID = "cf-inspector";
export const INSPECTOR_TOGGLE_ID = "cf-inspector-toggle";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn copy-btn"
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      title={copied ? "Copied" : "Copy"}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}

export function InspectorRows({ rows }: { rows: InspectorRow[] }) {
  return (
    <dl className="inspector-rows">
      {rows.map((r) => (
        <div key={r.label} className={`inspector-row inspector-${r.tone ?? "plain"}`}>
          <dt>{r.label}</dt>
          <dd className={r.mono === false ? "" : "mono"}>
            <span className="inspector-value">{r.value}</span>
            {r.copy ? <CopyButton text={r.copy} label={r.label} /> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The right-hand drawer. Defaults are the developer inspector's; another drawer in the same column
 * (Sent from staging) passes its own `title`, `id`, `closeLabel` and the toggle to refocus on close.
 */
export function InspectorDrawer({ open, onClose, sections, children, subtitle = "Technical detail", title = "Inspector", id = INSPECTOR_ID, closeLabel = "Close inspector", returnFocusId = INSPECTOR_TOGGLE_ID, testId }: { open: boolean; onClose: () => void; sections: InspectorSection[]; children?: ReactNode; subtitle?: string; title?: string; id?: string; closeLabel?: string; returnFocusId?: string; testId?: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) heading.current?.focus();
    wasOpen.current = open;
  }, [open]);
  if (!open) return null;
  const close = () => {
    onClose();
    // give focus back to the toggle that opened the drawer
    if (typeof document !== "undefined") document.getElementById(returnFocusId)?.focus();
  };
  return (
    <aside
      id={id}
      className="inspector"
      aria-labelledby={`${id}-title`}
      {...(testId ? { "data-testid": testId } : {})}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          close();
        }
      }}
    >
      <header className="inspector-head">
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <span className="muted small">{subtitle}</span>
        <button type="button" className="icon-btn" aria-label={closeLabel} onClick={close}>
          <Icon name="close" size={16} />
        </button>
      </header>
      {sections.map((s, i) => (
        <section key={`${i}-${s.title}`} className="inspector-section" aria-label={s.title}>
          <h3>{s.title}</h3>
          <InspectorRows rows={s.rows} />
        </section>
      ))}
      {children}
    </aside>
  );
}

/** The header button that shows or hides the drawer. */
export function InspectorToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" id={INSPECTOR_TOGGLE_ID} className={`btn btn-quiet inspector-toggle ${open ? "is-on" : ""}`} aria-expanded={open} {...(open ? { "aria-controls": INSPECTOR_ID } : {})} onClick={onToggle}>
      <Icon name="inspector" size={16} strokeWidth={2} />
      Inspector
    </button>
  );
}
