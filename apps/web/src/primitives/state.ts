/**
 * Fixed state colours (docs/UX-POLISH.md §5) and the two progress rails. Pure: unit-tested directly.
 *
 * working teal · ready green · needs-decision amber · blocked/failed red · superseded grey.
 */
import type { Tone } from "../lib/model.js";

export type StateKind = "working" | "ready" | "decision" | "blocked" | "superseded" | "neutral";

/** The existing `Tone` vocabulary (lib/model.ts) on the fixed state palette. */
export function stateOfTone(tone: Tone): StateKind {
  switch (tone) {
    case "busy":
      return "working";
    case "good":
    case "info":
      return "ready";
    case "warn":
      return "decision";
    case "bad":
      return "blocked";
    case "muted":
      return "superseded";
    default:
      return "neutral";
  }
}

export const CLIENT_STEPS = ["Working", "Preview ready", "Approved", "Published", "Live"] as const;
export const DEVELOPER_STEPS = ["Request", "Work", "Check", "Review", "Approve", "Accept", "Publish", "Live"] as const;

export type RailVariant = "client" | "developer";

export interface RailPosition {
  /** index of the current step (the one in progress or waiting) */
  current: number;
  /** colour of the current step */
  state: StateKind;
  /** every step done, including the last (Live) */
  complete: boolean;
}

export type StepStatus = "done" | "current" | "todo";

export function stepStatus(i: number, pos: Pick<RailPosition, "current" | "complete">): StepStatus {
  if (pos.complete || i < pos.current) return "done";
  return i === pos.current ? "current" : "todo";
}

/** Extra facts the Change stage alone does not carry (release state lives in another service). */
export interface RailFacts {
  /** a release of the accepted version is deploying or being verified */
  publishing?: boolean;
  /** a release of the accepted version is live */
  live?: boolean;
  /**
   * Developer rail: the result can be looked at (a private preview of this identity is ready, or
   * there is nothing to preview). ReadyForReview then waits on Approve instead of Review.
   */
  reviewReady?: boolean;
  /** Developer rail: the release of the accepted version failed or needs recovery (Publish turns red) */
  publishFailed?: boolean;
  /** Developer rail: the release of the accepted version is publish-approved but not live yet */
  publishApproved?: boolean;
}

/**
 * Where a Change is on a rail, from its plan §A.6 stage (`ChangeStatus.stage` in lib/model.ts).
 * Client rail: Working → Preview ready → Approved → Published → Live.
 * Developer rail: Request → Work → Check → Review → Approve → Accept → Publish → Live.
 *
 * Developer decisions (UX-1 review M-3, settled in UX-4):
 * - NeedsResolution is amber ("decision") at Check, as in the approved storyboard mockup: the
 *   developer decides how to repair. Red stays on the failing evidence chip; a failed task is red.
 * - ReadyForReview is Review until there is something to look at (`reviewReady`: a preview of this
 *   identity is ready, or nothing to preview); then Approve is the current step, waiting for an
 *   approval of this exact identity. Approved → Accept; Accepted → Publish.
 */
export function railPosition(variant: RailVariant, stage: string, facts: RailFacts = {}): RailPosition {
  const blocked = stage === "NeedsResolution" || stage === "Failed";
  const stale = stage === "Stale";
  const closed = stage === "Rejected" || stage === "Superseded" || stage === "Canceled";
  if (variant === "client") {
    if (facts.live) return { current: 4, state: "ready", complete: true };
    if (facts.publishing) return { current: 3, state: "working", complete: false };
    // approved (and accepted, not yet publishing): the client's part is done, Approved waits on the developer
    if (stage === "Accepted" || stage === "Approved") return { current: 2, state: "working", complete: false };
    if (stage === "ReadyForReview") return { current: 1, state: "decision", complete: false };
    return { current: 0, state: blocked ? "blocked" : stale ? "decision" : closed ? "superseded" : "working", complete: false };
  }
  if (facts.live) return { current: 7, state: "ready", complete: true };
  if (facts.publishing) return { current: 6, state: "working", complete: false };
  if (facts.publishFailed) return { current: 6, state: "blocked", complete: false };
  if (facts.publishApproved) return { current: 6, state: "decision", complete: false };
  switch (stage) {
    case "Planned":
      return { current: 0, state: "working", complete: false };
    case "Running":
      return { current: 1, state: "working", complete: false };
    case "Submitted":
    case "Integrating":
    case "Validating":
      return { current: 2, state: "working", complete: false };
    case "NeedsResolution":
    case "Stale":
      return { current: 2, state: "decision", complete: false };
    case "Failed":
      return { current: 2, state: "blocked", complete: false };
    case "ReadyForReview":
      return { current: facts.reviewReady ? 4 : 3, state: "decision", complete: false };
    case "Approved":
      return { current: 5, state: "decision", complete: false };
    case "Accepted":
      return { current: 6, state: "decision", complete: false };
    default:
      return { current: 0, state: closed ? "superseded" : "neutral", complete: false };
  }
}

/** "Jordan Lee" → "JL", "client@customer.example" → "CL". */
export function initials(nameOrEmail: string): string {
  const base = nameOrEmail.includes("@") ? nameOrEmail.slice(0, nameOrEmail.indexOf("@")) : nameOrEmail;
  const words = base.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}
