/**
 * The progress rail. Client: five dots (Working → Preview ready → Approved → Published → Live).
 * Developer: eight steps (Request → Work → Check → Review → Approve → Accept → Publish → Live).
 * The current step pulses (not under prefers-reduced-motion) and carries `aria-current="step"`.
 */
import type { ReactNode } from "react";
import { Icon } from "./icons.js";
import { CLIENT_STEPS, DEVELOPER_STEPS, stepStatus, type RailPosition, type RailVariant, type StateKind } from "./state.js";

/** Spoken state of the current step (`aria-current="step"` already says "current"). */
const CURRENT_WORD: Record<StateKind, string> = { working: "in progress", ready: "done", decision: "waiting for a decision", blocked: "blocked", superseded: "stopped: replaced", neutral: "in progress" };

export function StateRail({ variant, position, label = variant === "client" ? "Progress" : "Change progress", steps, testId, meta, stepTestIds }: { variant: RailVariant; position: RailPosition; label?: string; steps?: readonly string[]; testId?: string; /** optional detail under each step's label (who, when, a short hash) */ meta?: ReadonlyArray<ReactNode | undefined>; /** optional `data-testid` per step */ stepTestIds?: ReadonlyArray<string | undefined> }) {
  const names = steps ?? (variant === "client" ? CLIENT_STEPS : DEVELOPER_STEPS);
  return (
    <ol className={`rail rail-${variant}`} aria-label={label} {...(testId ? { "data-testid": testId } : {})}>
      {names.map((name, i) => {
        const status = stepStatus(i, position);
        const state = status === "current" ? position.state : status === "done" ? "ready" : "todo";
        return (
          <li key={name} className={`rail-step rail-${status} rail-state-${state}`} {...(status === "current" ? { "aria-current": "step" as const } : {})} {...(stepTestIds?.[i] ? { "data-testid": stepTestIds[i] } : {})}>
            {i > 0 ? <span className={`rail-line ${status === "todo" ? "" : "rail-line-done"}`} aria-hidden="true" /> : null}
            <span className={`rail-dot ${status === "current" && !position.complete ? "rail-pulse" : ""}`} aria-hidden="true">
              {variant === "developer" && status === "done" ? <Icon name="check" size={14} strokeWidth={3} /> : null}
            </span>
            <span className="rail-label">
              {name}
              <span className="sr-only"> ({status === "current" ? CURRENT_WORD[position.state] : status === "done" ? "done" : "not started"})</span>
            </span>
            {meta?.[i] ? <span className="rail-meta">{meta[i]}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
