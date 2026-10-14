/** A vertical timeline: one node per event or version, with an object icon and a state colour. */
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";
import type { StateKind } from "./state.js";

export interface TimelineItem {
  key: string;
  title: ReactNode;
  /** "2 min ago", "version 7" — never a raw timestamp in the default view */
  meta?: ReactNode;
  body?: ReactNode;
  icon?: IconName;
  state?: StateKind;
  /** emphasised node (e.g. the live version) */
  current?: boolean;
  aside?: ReactNode;
  /** extra class(es) on the item, e.g. `version` for the capture selectors */
  className?: string;
  testId?: string;
}

export function Timeline({ items, label, testId, className }: { items: TimelineItem[]; label: string; testId?: string; className?: string }) {
  return (
    <ol className={`timeline ${className ?? ""}`.trim()} aria-label={label} {...(testId ? { "data-testid": testId } : {})}>
      {items.map((it) => (
        <li key={it.key} className={["timeline-item", `timeline-${it.state ?? "neutral"}`, it.current ? "timeline-current" : "", it.className ?? ""].filter(Boolean).join(" ")} {...(it.current ? { "aria-current": "true" as const } : {})} {...(it.testId ? { "data-testid": it.testId } : {})}>
          <span className="timeline-node" aria-hidden="true">
            {it.icon ? <Icon name={it.icon} size={14} strokeWidth={2} /> : null}
          </span>
          <div className="timeline-content">
            <div className="timeline-title">{it.title}</div>
            {it.meta ? <div className="timeline-meta">{it.meta}</div> : null}
            {it.body}
          </div>
          {it.aside ? <div className="timeline-aside">{it.aside}</div> : null}
        </li>
      ))}
    </ol>
  );
}
