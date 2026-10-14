/**
 * Pure presentation logic for the client flow (docs/UX-POLISH.md §3): plain-language times, the
 * return summary and blocked reasons, the review chip, the next step on the client rail, one
 * numbered project history across resources, and what is live. No React, no I/O: unit-tested.
 */
import type { EditionReturn, Proposal, ReleaseList, VersionEntry } from "../api/types.js";
import { validationSummary } from "./model.js";

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ----------------------------------------------------------------------------------- time

/** Plain-language times live in model.ts (formatTime uses them everywhere); re-exported here. */
export { relativeTime } from "./model.js";

// --------------------------------------------------------------------------------- return

/** "2 files changed · 0 blocked" (the 1:30 hero line). */
export function returnSummary(r: Pick<EditionReturn, "changes" | "blocked">): { changed: number; blocked: number; text: string } {
  const changed = r.changes.length;
  const blocked = r.blocked.length;
  return { changed, blocked, text: `${plural(changed, "file")} changed · ${blocked} blocked` };
}

const BLOCKED_WHY: Record<string, string> = {
  protected: "your developer protects this file",
  read_only: "this working copy lets you read it but not change it",
  not_mapped: "it is not part of this working copy",
  path_escape: "it is outside the working copy folder",
  case_collision: "another file has the same name in different upper or lower case",
  path_conflict: "it clashes with a file or folder of the same name",
};

/** One sentence: what was not taken over, and why. */
export function blockedSentence(b: { path: string; reason: string }): string {
  return `${b.path} was not taken over: ${BLOCKED_WHY[b.reason] ?? "your developer's rules do not allow it"}.`;
}

/** "Ask the developer": a prefilled message in the viewer's own mail app (no recipient is invented). */
export function askDeveloperHref(subject: string, body: string): string {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

// --------------------------------------------------------------------------------- review

export interface ClientChecks {
  kind: "passed" | "decision" | "running" | "waiting";
  label: string;
  state: "ready" | "decision" | "working" | "neutral";
  /** one plain sentence: what it means and who acts */
  detail: string;
}

/** Failure codes a client gets a specific sentence for (API.md `lastAttempt.code`). */
const CLIENT_FAILURE: Record<string, string> = {
  receipt_not_recorded: "The check result was lost. Your developer will run the checks again.",
  integration_superseded: "A newer check replaced this one. Your developer will run the checks again.",
  stale_base: "Out of date: a newer change was accepted first. Your developer will bring this up to date.",
};

/**
 * The client review chip: green "Checks passed" or amber "Needs a developer decision", with one
 * sentence for every integration state (Task 23: `applying`, `receipt_not_recorded`,
 * `integration_superseded`, a moved base or policy reference).
 */
export function clientChecks(p: Pick<Proposal, "integration" | "lastAttempt" | "stale" | "state">): ClientChecks {
  const decision = (detail: string): ClientChecks => ({ kind: "decision", label: "Needs a developer decision", state: "decision", detail });
  if (p.stale.length) return decision(CLIENT_FAILURE.stale_base!);
  const a = p.lastAttempt;
  if (a?.state === "applying") return { kind: "running", label: "Recording the check result", state: "working", detail: "The checks finished. Their result is being recorded." };
  const v = validationSummary(p);
  if (v.verdict === "failed") return decision(CLIENT_FAILURE[v.code ?? ""] ?? "The checks found a problem. Your developer decides how to fix it.");
  if (v.verdict === "outdated") return decision("The last check was for an earlier version of this result. Your developer will check it again.");
  if (v.verdict === "passed") return { kind: "passed", label: "Checks passed", state: "ready", detail: "Your developer's checks passed on the combined result." };
  if (v.verdict === "running") return { kind: "running", label: "Checking the result", state: "working", detail: "Your developer's checks are running on the combined result." };
  return { kind: "waiting", label: "Checks have not run yet", state: "neutral", detail: "Your developer runs the checks before you approve." };
}

/** What happens next, for a client (viewers are never asked to act), at a Change stage (`ChangeStatus.stage`). */
export function clientNextStep(stage: string, facts: { live?: boolean; publishing?: boolean } = {}, role: "client" | "viewer" = "client"): string {
  if (facts.live) return "Live on your site.";
  if (facts.publishing) return "Publishing to your live site now.";
  if (stage === "ReadyForReview") return role === "viewer" ? "Waiting for approval." : "Next: you review and approve. Your developer publishes.";
  if (stage === "Approved" || stage === "Accepted") return "Your developer will publish.";
  if (stage === "NeedsResolution" || stage === "Failed") return "Your developer is fixing a problem the checks found.";
  if (stage === "Stale") return "Your developer is bringing this up to date.";
  return role === "viewer" ? "In progress." : "Nothing for you yet.";
}

// ------------------------------------------------------------------------------- versions

export interface ProjectVersion {
  /** 1 = the import; counts forward, a restore is a new number */
  number: number;
  kind: "import" | "accept" | "restore";
  /** every accepted version id this project version stands for (the import merges one per resource) */
  ids: string[];
  proposalId: string | null;
  at: string;
  /** resource names it changed, in project order */
  resources: string[];
  /** per resource: the revision it points at */
  heads: Array<{ resourceId: string; revisionId: string }>;
}

const isImport = (e: VersionEntry) => e.kind === "bind" || (e.kind === "accept" && !e.proposalId);

/**
 * One numbered history for the project. Each resource keeps its own accepted history; a change
 * across several resources is one accepted version of all of them. The genesis binds that follow
 * each other at the start are the import, Version 1.
 * Numbers come from what the viewer can read: a client without read on a resource misses its
 * versions and may number later versions lower than the developer does (UX-2 review m4; a
 * server-side project version number would fix that).
 */
export function projectVersions(perResource: Array<{ resourceId: string; name: string; versions: VersionEntry[] }>): ProjectVersion[] {
  const order = new Map(perResource.map((r, i) => [r.resourceId, i]));
  const groups = new Map<string, { seq: number; e: VersionEntry; rids: Set<string>; heads: Array<{ resourceId: string; revisionId: string }> }>();
  for (const r of perResource) {
    for (const e of r.versions) {
      let g = groups.get(e.acceptedVersionId);
      if (!g) groups.set(e.acceptedVersionId, (g = { seq: e.sequence, e, rids: new Set(), heads: [] }));
      g.rids.add(r.resourceId);
      if (e.head) g.heads.push(e.head);
    }
  }
  const nameOf = new Map(perResource.map((r) => [r.resourceId, r.name]));
  const sorted = [...groups.entries()].sort((a, b) => a[1].seq - b[1].seq);
  const out: ProjectVersion[] = [];
  for (const [id, g] of sorted) {
    const kind: ProjectVersion["kind"] = isImport(g.e) ? "import" : g.e.kind === "restore" ? "restore" : "accept";
    const prev = out[out.length - 1];
    if (kind === "import" && prev && prev.kind === "import" && prev.number === 1 && out.length === 1) {
      prev.ids.push(id);
      for (const rid of g.rids) if (!prev.resources.includes(nameOf.get(rid)!)) prev.resources.push(nameOf.get(rid)!);
      prev.heads.push(...g.heads);
      if (g.e.acceptedAt > prev.at) prev.at = g.e.acceptedAt;
      continue;
    }
    const rids = [...g.rids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    out.push({ number: out.length + 1, kind, ids: [id], proposalId: g.e.proposalId, at: g.e.acceptedAt, resources: rids.map((r) => nameOf.get(r)!), heads: g.heads });
  }
  return out.reverse();
}

export function versionById(pv: ProjectVersion[], acceptedVersionId: string | null | undefined): ProjectVersion | null {
  if (!acceptedVersionId) return null;
  return pv.find((x) => x.ids.includes(acceptedVersionId)) ?? null;
}

export function versionOfProposal(pv: ProjectVersion[], proposalId: string): ProjectVersion | null {
  return pv.find((x) => x.proposalId === proposalId) ?? null;
}

function joinAnd(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** "Quote breakdown", "Restored an earlier API", "First version, imported". */
export function versionSummary(v: ProjectVersion, titleOf: (proposalId: string) => string | null): string {
  if (v.kind === "import") return v.number === 1 ? "First version, imported" : `Imported ${joinAnd(v.resources)}`;
  if (v.kind === "restore") return `Restored an earlier ${joinAnd(v.resources)}`;
  return (v.proposalId ? titleOf(v.proposalId) : null) ?? `Changes to ${joinAnd(v.resources)}`;
}

// ----------------------------------------------------------------------------------- live

/**
 * Is the change of version `v` live, given the live version's number? Releases build the whole
 * project at a version, so a later live version still carries `v`'s change, unless a restore
 * between them (after `v`, up to the live version) brought one of `v`'s resources back to an
 * earlier state. Shared by the Overview and the client review (UX-2 review m2).
 */
export function isVersionLive(pv: ProjectVersion[], v: ProjectVersion, liveNumber: number | null): boolean {
  if (liveNumber == null || liveNumber < v.number) return false;
  const touched = new Set(v.heads.map((h) => h.resourceId));
  return !pv.some((x) => x.kind === "restore" && x.number > v.number && x.number <= liveNumber && x.heads.some((h) => touched.has(h.resourceId)));
}

/**
 * Per resource, the accepted version id that is live: its newest entry at or before the live
 * version, whether or not the live version itself touched that resource (UX-2 review m1).
 */
export function liveHeadPerResource(perResource: Array<{ resourceId: string; versions: VersionEntry[] }>, pv: ProjectVersion[], liveNumber: number | null): Map<string, string> {
  const out = new Map<string, string>();
  if (liveNumber == null) return out;
  for (const r of perResource) {
    let best: { n: number; id: string } | null = null;
    for (const e of r.versions) {
      const n = versionById(pv, e.acceptedVersionId)?.number;
      if (n != null && n <= liveNumber && (!best || n > best.n)) best = { n, id: e.acceptedVersionId };
    }
    if (best) out.set(r.resourceId, best.id);
  }
  return out;
}

export interface ReleaseFacts {
  live: boolean;
  publishing: boolean;
  /** false: the release service is not readable (or not loaded), so live-ness is unknown */
  known: boolean;
}

/** Is the version a proposal became live, or being published? (Overview and client review.) */
export function proposalReleaseFacts(history: { versions: ProjectVersion[]; releases: ReleaseList | undefined } | undefined, proposalId: string): ReleaseFacts {
  if (!history?.releases) return { live: false, publishing: false, known: false };
  const v = versionOfProposal(history.versions, proposalId);
  if (!v) return { live: false, publishing: false, known: true };
  const site = liveSite(history.releases, history.versions);
  if (isVersionLive(history.versions, v, site?.number ?? null)) return { live: true, publishing: false, known: true };
  const rel = history.releases.releases.find((r) => v.ids.includes(r.acceptedVersionId));
  return { live: false, publishing: !!rel && (rel.state === "deploying" || rel.state === "health_verification"), known: true };
}

export interface LiveSite {
  /** the live project version's number (null: not in the visible history) */
  number: number | null;
  since: string;
  /** the website's address (or the first deployment with one) */
  url: string | null;
}

export function liveSite(list: ReleaseList | undefined, pv: ProjectVersion[]): LiveSite | null {
  if (!list?.live) return null;
  const rel = list.releases.find((r) => r.releaseId === list.live!.releaseId);
  const deps = rel?.deployments ?? [];
  const url = deps.find((d) => d.targetId === "website" && d.url)?.url ?? deps.find((d) => d.url)?.url ?? null;
  return { number: versionById(pv, list.live.acceptedVersionId)?.number ?? null, since: list.live.since, url };
}

// ------------------------------------------------------------------------------- editions

export type EditionIcon = "globe" | "layout" | "mail" | "edition";

/** The three demo editions get their own icon and promise; anything else the generic hand-over. */
export function editionLook(name: string): { icon: EditionIcon; blurb: string } {
  if (/e-?mail/i.test(name)) return { icon: "mail", blurb: "The words and images in the emails your customers receive." };
  if (/portal|interface|app/i.test(name)) return { icon: "layout", blurb: "The screens your customers use after they sign in." };
  if (/web|site|page/i.test(name)) return { icon: "globe", blurb: "The public pages of your site: text, layout and images." };
  return { icon: "edition", blurb: "The part of the project your developer handed over for you to edit." };
}
