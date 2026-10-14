/**
 * Alone-first promotion and travel-with links (staging phase 2b, B8 and B9).
 *
 * A promotion first tries the task **alone** (the target plus the landings a developer said it must
 * travel with, `aloneSet`) instead of the overlap closure (`promotionSet`) when the project's
 * required checks cover every resource the alone set changes: then a broken combination is caught by
 * a check (or by the merge) and the promotion widens once to the closure (promotions.ts). Without
 * that coverage nothing would catch it, so the promotion takes the closure from the start.
 *
 * Travel-with links (`staging_landing_links`) are forced predecessors in both sets: a landing goes
 * to production only together with each earlier landing it is linked to. A link to a landing that
 * left staging (failed, rolled back) refuses the promotion until a developer deletes it; a link to a
 * promoted landing is satisfied (`main` has it).
 */
import { aloneSet, promotionSet } from "@commonforge-org/core";
import type { Services } from "../context.js";
import { ApiError } from "../lib/http.js";
import { listMounts, type ProjectPolicy } from "./directory.js";
import { baseLandings, type LandingRow } from "./staging.js";

/**
 * B8: alone-first applies when the alone set changes at least one resource and every resource it
 * changes is the resource of the mount of at least one **required** policy check (`required`
 * defaults to true) that the owner marked `gatesAlone` (it builds or tests that code; absent means
 * false). Contracts do not count.
 */
export function aloneFirstApplies(policy: Pick<ProjectPolicy, "checks">, changedResources: ReadonlySet<string>, mounts: ReadonlyArray<{ mount_name: string; resource_id: string }>): boolean {
  if (changedResources.size === 0) return false;
  const covered = new Set<string>();
  for (const c of policy.checks ?? []) {
    if (c.required === false || c.gatesAlone !== true) continue;
    for (const m of mounts) if (m.mount_name === c.mountName) covered.add(m.resource_id);
  }
  return [...changedResources].every((r) => covered.has(r));
}

/** Every part of the given landings, in landing then part order (part 1 falls back to the landing row). */
export async function promotionParts(svc: Services, landingIds: string[]): Promise<Array<{ landingId: string; part: number; proposalId: string }>> {
  const out: Array<{ landingId: string; part: number; proposalId: string }> = [];
  for (const id of landingIds) {
    const rows = (await svc.db.prepare("SELECT landing_id, part, proposal_id FROM staging_landing_parts WHERE landing_id = ? ORDER BY part").bind(id).all<{ landing_id: string; part: number; proposal_id: string }>()).results;
    if (rows.length > 0) for (const r of rows) out.push({ landingId: r.landing_id, part: r.part, proposalId: r.proposal_id });
    else {
      const l = await svc.db.prepare("SELECT proposal_id FROM staging_landings WHERE landing_id = ?").bind(id).first<{ proposal_id: string }>();
      if (l) out.push({ landingId: id, part: 1, proposalId: l.proposal_id });
    }
  }
  return out;
}

/** `<mount>/<path>` of every changed path of every part of a landing (under every mount name of the resource), and the resources it changes. */
async function landingChanges(svc: Services, orgId: string, landingId: string, mountsOf: Map<string, string[]>): Promise<{ paths: string[]; resources: Set<string> }> {
  const ledger = svc.ledger(orgId);
  const paths = new Set<string>();
  const resources = new Set<string>();
  for (const part of await promotionParts(svc, [landingId])) {
    const lp = await ledger.getProposal(part.proposalId);
    for (const rc of lp?.resourceChanges ?? []) {
      resources.add(rc.resourceId as string);
      const rec = await ledger.getCandidate(rc.candidateId);
      for (const path of rec?.candidate.changedPaths ?? []) for (const m of mountsOf.get(rc.resourceId) ?? []) paths.add(`${m}/${path}`);
    }
  }
  return { paths: [...paths], resources };
}

/** The resources the given landings change (every part's proposal). */
export async function landingResources(svc: Services, orgId: string, landingIds: string[]): Promise<Set<string>> {
  const ledger = svc.ledger(orgId);
  const out = new Set<string>();
  for (const part of await promotionParts(svc, landingIds)) for (const rc of (await ledger.getProposal(part.proposalId))?.resourceChanges ?? []) out.add(rc.resourceId as string);
  return out;
}

/** Landing states that left staging for good: a travel-with link to one blocks the promotion (B9). */
const LEFT_STAGING = ["failed", "rolling_back", "rolled_back"];

/** The travel-with links of a project, by landing (`landing_id` → `with_landing_id`s). */
export async function travelLinks(svc: Services, orgId: string, projectId: string): Promise<Map<string, string[]>> {
  const rows = (await svc.db.prepare("SELECT landing_id, with_landing_id FROM staging_landing_links WHERE org_id = ? AND project_id = ? ORDER BY created_at, with_landing_id").bind(orgId, projectId).all<{ landing_id: string; with_landing_id: string }>()).results;
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.landing_id, [...(out.get(r.landing_id) ?? []), r.with_landing_id]);
  return out;
}

export interface PromotionSets {
  /** the project's landings in staging (`checking`, `landed`, `promoting`), in `seq` order */
  open: LandingRow[];
  /** the overlap closure (today's set), in `seq` order */
  closure: string[];
  /** the target and its travel-with chain, in `seq` order */
  alone: string[];
  /** the resources each open landing changes */
  changes: Map<string, Set<string>>;
  /** each open landing's task and title */
  titles: Map<string, { taskId: string; title: string }>;
  /** travel-with links of open landings to a landing that left staging (or is gone) */
  departed: Array<{ landingId: string; withLandingId: string }>;
}

/**
 * B9: a landing of `ids` (the set being promoted) linked to a landing that left staging refuses
 * the promotion (`409 travel_with_left_staging`) until a developer deletes the link.
 */
export function assertLinksInStaging(sets: Pick<PromotionSets, "departed">, ids: readonly string[]): void {
  const d = sets.departed.find((x) => ids.includes(x.landingId));
  if (d) throw new ApiError(409, "travel_with_left_staging", "a task this one must travel with left staging; a developer removes the link (or promotes it again) first", { landingId: d.landingId, withLandingId: d.withLandingId });
}

/**
 * The closure and the alone set of `targetLandingId` over the project's landings in staging, with
 * the staging-base predecessors (`after`, Task 9) and the travel-with links whose earlier landing is
 * in staging (`with`), and the links to landings that left staging (`departed`; the caller refuses
 * the set it promotes with {@link assertLinksInStaging}). Used by the request and the widen.
 */
export async function promotionSets(svc: Services, orgId: string, projectId: string, targetLandingId: string): Promise<PromotionSets> {
  const open = (await svc.db.prepare("SELECT * FROM staging_landings WHERE org_id = ? AND project_id = ? AND state IN ('checking', 'landed', 'promoting') ORDER BY seq").bind(orgId, projectId).all<LandingRow>()).results;
  const mountsOf = new Map<string, string[]>();
  for (const m of await listMounts(svc.db, orgId, projectId)) mountsOf.set(m.resource_id, [...(mountsOf.get(m.resource_id) ?? []), m.mount_name]);
  const links = await travelLinks(svc, orgId, projectId);
  const openIds = new Set(open.map((l) => l.landing_id));
  const changes = new Map<string, Set<string>>();
  const input = [];
  // a landing's revisions may build on later landings (the staging builds they were seeded from): those are predecessors too
  for (const l of open) {
    const c = await landingChanges(svc, orgId, l.landing_id, mountsOf);
    changes.set(l.landing_id, c.resources);
    input.push({ landingId: l.landing_id, seq: l.seq, paths: c.paths, after: await baseLandings(svc, l), with: (links.get(l.landing_id) ?? []).filter((id) => openIds.has(id)) });
  }
  const closure = promotionSet(input, targetLandingId);
  const alone = aloneSet(input, targetLandingId);
  // links of open landings to a landing that is not open: satisfied when it was promoted, else departed
  const departed: Array<{ landingId: string; withLandingId: string }> = [];
  for (const id of openIds) {
    for (const w of (links.get(id) ?? []).filter((x) => !openIds.has(x))) {
      const row = await svc.db.prepare("SELECT state FROM staging_landings WHERE landing_id = ?").bind(w).first<{ state: string }>();
      if (!row || LEFT_STAGING.includes(row.state)) departed.push({ landingId: id, withLandingId: w });
    }
  }
  const titles = new Map<string, { taskId: string; title: string }>();
  if (open.length) {
    const rows = (await svc.db.prepare(`SELECT l.landing_id, t.task_id, t.title FROM staging_landings l JOIN tasks t ON t.task_id = l.task_id WHERE l.org_id = ? AND l.project_id = ? AND l.state IN ('checking', 'landed', 'promoting')`).bind(orgId, projectId).all<{ landing_id: string; task_id: string; title: string }>()).results;
    for (const r of rows) titles.set(r.landing_id, { taskId: r.task_id, title: r.title });
  }
  return { open, closure, alone, changes, titles, departed };
}

/** The client text for a landing a promotion goes without (B8). */
export const goingWithoutText = (title: string, promoting = false) => `Going to production without '${title}' (${promoting ? "being promoted separately" : "still in staging"})`;
/** The client text of a promotion ended because a developer linked one of its tasks to a task it lacks (B9). */
export const travelWithAddedText = (title: string) => `A developer linked this task to '${title}'; promote again.`;
/** The reason a widened promotion shows (B8). */
export const needsText = (titles: string[]) => `Needs ${titles.map((t) => `'${t}'`).join(", ")}; promoting them together.`;
/** The reason a widen that needs a landing another promotion holds fails with (B8). */
export const needsBeingPromotedText = (titles: string[]) => `Needs ${titles.map((t) => `'${t}'`).join(", ")}, which is being promoted now; promote again once it is live.`;
/** The reason a widen that needs a landing not ready for production fails with (B8). */
export const needsNotReadyText = (titles: string[]) => `Needs ${titles.map((t) => `'${t}'`).join(", ")}, which is not ready for production yet. Promote again once it is live on staging.`;
