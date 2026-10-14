/**
 * The "Needs you" stack (docs/UX-POLISH.md §2, research RC-04 minimal): what is waiting on the
 * viewer, newest first, each with one action. Not a full Decision Inbox (§9). One primary button per
 * view (§6): only the first item's action is primary, and none when the page's primary is elsewhere.
 */
import { useId, type ReactNode } from "react";
import { Link } from "../ui.js";
import { CountBadge } from "./Badge.js";
import { Icon } from "./icons.js";

export interface NeedsYouItem {
  key: string;
  title: string;
  /** one line: what is ready and what to do */
  detail: ReactNode;
  /** evidence line, e.g. "All checks passed · test data only" */
  evidence?: ReactNode;
  evidenceOk?: boolean;
  href: string;
  action: string;
}

export function NeedsYou({ items, emptyText = "Nothing is waiting on you.", max = 3, testId = "needs-you", primary = true }: { items: NeedsYouItem[]; emptyText?: string; max?: number; testId?: string; /** false: the page's one primary action is elsewhere */ primary?: boolean }) {
  const shown = items.slice(0, max);
  const titleId = useId();
  return (
    <section className="needs-you" aria-labelledby={titleId} data-testid={testId}>
      <div className="needs-you-head">
        <h2 id={titleId}>Needs you</h2>
        <CountBadge count={items.length} state="decision" />
      </div>
      {shown.map((it, i) => (
        <article key={it.key} className="needs-you-item">
          <div className="needs-you-title">{it.title}</div>
          <div className="needs-you-detail">{it.detail}</div>
          {it.evidence ? (
            <div className={`needs-you-evidence ${it.evidenceOk === false ? "is-bad" : "is-ok"}`}>
              <Icon name={it.evidenceOk === false ? "alert" : "check"} size={16} strokeWidth={2} />
              {it.evidence}
            </div>
          ) : null}
          <Link href={it.href} className={`btn ${primary && i === 0 ? "btn-primary" : "btn-outline"} btn-block`}>
            {it.action}
          </Link>
        </article>
      ))}
      <div className="needs-you-foot">{items.length === 0 ? emptyText : items.length > shown.length ? `${items.length - shown.length} more waiting.` : "Nothing else is waiting on you."}</div>
    </section>
  );
}
