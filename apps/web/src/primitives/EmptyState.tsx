/** Empty states and first-run, written for the person reading them ("No updates yet. Start one when you're ready."). */
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";

export function EmptyState({ icon = "inbox", title, children, action, compact }: { icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={`empty-state ${compact ? "empty-compact" : ""}`.trim()}>
      <span className="empty-icon" aria-hidden="true">
        <Icon name={icon} size={compact ? 18 : 22} />
      </span>
      <div className="empty-body">
        <p className="empty-title">{title}</p>
        {children ? <div className="empty-text">{children}</div> : null}
        {action ? <div className="empty-action">{action}</div> : null}
      </div>
    </div>
  );
}
