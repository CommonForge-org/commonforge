/** Badges (a state, as a pill) and chips (a piece of evidence, as a dot + sentence). */
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";
import type { StateKind } from "./state.js";

const STATE_ICON: Partial<Record<StateKind, IconName>> = { ready: "check", decision: "alert", blocked: "cross" };

/**
 * A state badge on the fixed palette. `pulse` shows a live dot (working states); `icon` adds the
 * state's glyph so colour is never the only signal.
 */
export function Badge({ state, children, pulse, icon, size = "md", testId }: { state: StateKind; children?: ReactNode; pulse?: boolean; icon?: boolean; size?: "sm" | "md" | "lg"; testId?: string }) {
  const glyph = icon ? STATE_ICON[state] : undefined;
  return (
    <span className={`badge badge-${state} badge-${size}`} data-state={state} {...(testId ? { "data-testid": testId } : {})}>
      {pulse ? <span className="badge-dot pulse" aria-hidden="true" /> : glyph ? <Icon name={glyph} size={size === "lg" ? 16 : 14} strokeWidth={2.2} /> : <span className="badge-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export type ChipResult = "pass" | "fail" | "warn" | "pending" | "neutral";

const RESULT_STATE: Record<ChipResult, StateKind> = { pass: "ready", fail: "blocked", warn: "decision", pending: "working", neutral: "neutral" };
const RESULT_WORD: Record<ChipResult, string> = { pass: "passed", fail: "failed", warn: "needs attention", pending: "running", neutral: "" };

/** An evidence chip: "Merge clean · 3 repositories", "Contract quote failed", "Tests 14 of 14". */
export function Chip({ result = "neutral", children, testId, icon }: { result?: ChipResult; children?: ReactNode; testId?: string; icon?: IconName }) {
  const state = RESULT_STATE[result];
  return (
    <span className={`evidence-chip evidence-chip-${state}`} data-result={result} {...(testId ? { "data-testid": testId } : {})}>
      {icon ? <Icon name={icon} size={15} /> : <span className={`chip-dot ${result === "pending" ? "pulse" : ""}`} aria-hidden="true" />}
      <span>{children}</span>
      {RESULT_WORD[result] ? <span className="sr-only"> ({RESULT_WORD[result]})</span> : null}
    </span>
  );
}

/** A small count, e.g. on a nav item. Amber when it counts decisions. */
export function CountBadge({ count, state = "neutral", label }: { count: number; state?: StateKind; label?: string }) {
  if (count <= 0) return null;
  return (
    <span className={`count-badge count-badge-${state}`} {...(label ? { title: label } : {})}>
      {label ? <span className="sr-only">{label}</span> : null}
      <span aria-hidden={label ? true : undefined}>{count}</span>
    </span>
  );
}
