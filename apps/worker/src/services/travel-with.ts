/**
 * Travel-with links (staging phase 2b, B9): a developer declares that a landing goes to production
 * only together with an earlier one (`staging_landing_links`). `promotionSet` and `aloneSet` treat a
 * link as a forced predecessor (promotion-alone.ts). A link added while the landing is in a
 * promotion that lacks the linked landing ends that promotion before it can be accepted (the
 * requester promotes again, now with the link); once that promotion accepts, the link is refused.
 */
import type { Services } from "../context.js";
import { ApiError, conflict, notFound } from "../lib/http.js";
import { recordEvent, userRef } from "./events.js";
import { getPromotion, holderOf, IN_FLIGHT, PRODUCTION, promotionLandingIds, supersedePromotion } from "./promotions.js";
import { travelWithAddedText } from "./promotion-alone.js";
import { IN_STAGING, type LandingRow } from "./staging.js";

/** At most this many travel-with links per landing. */
export const MAX_TRAVEL_WITH = 20;

export { travelWithAddedText };

/** A landing of the org (404 otherwise); the route checks the reader may see its project. */
export async function orgLanding(svc: Services, orgId: string, landingId: string): Promise<LandingRow> {
  const l = await svc.db.prepare("SELECT * FROM staging_landings WHERE org_id = ? AND landing_id = ?").bind(orgId, landingId).first<LandingRow>();
  if (!l) throw notFound("landing not found");
  return l;
}

const inFlightError = (promotionId: string) => new ApiError(409, "travel_with_in_flight", "this task is being released to production without that task; link it after the release", { promotionId });

/**
 * A developer declares that `l` must travel with the earlier landing `withLandingId` (same project,
 * lower `seq`, both in staging; at most {@link MAX_TRAVEL_WITH} per landing, enforced by the insert
 * itself). Idempotent.
 *
 * The link is written first, then the promotion holding `l` is looked at (a promotion requested
 * after the write sees the link): one whose set lacks the linked landing is superseded while it is
 * before `accepting` (`travel_with_added`); one that already took production refuses the link
 * (`409 travel_with_in_flight`, naming it; the link this call wrote is removed).
 */
export async function addTravelWith(svc: Services, l: LandingRow, withLandingId: string, userId: string): Promise<{ landingId: string; withLandingId: string }> {
  const w = await svc.db.prepare("SELECT l.*, t.title FROM staging_landings l JOIN tasks t ON t.task_id = l.task_id WHERE l.org_id = ? AND l.project_id = ? AND l.landing_id = ?").bind(l.org_id, l.project_id, withLandingId).first<LandingRow & { title: string }>();
  if (!w) throw notFound("landing not found");
  if (w.seq >= l.seq) throw conflict("travel_with_not_earlier", "a task can only travel with an earlier task in staging");
  if (!IN_STAGING.includes(l.state) || !IN_STAGING.includes(w.state)) throw conflict("not_in_staging", "both tasks must be in staging");
  const r = await svc.db
    .prepare(
      "INSERT OR IGNORE INTO staging_landing_links (landing_id, with_landing_id, org_id, project_id, created_by, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM staging_landing_links WHERE landing_id = ?) < ?",
    )
    .bind(l.landing_id, withLandingId, l.org_id, l.project_id, userId, svc.nowIso(), l.landing_id, MAX_TRAVEL_WITH)
    .run();
  const wrote = (r.meta.changes ?? 0) > 0;
  if (!wrote && !(await svc.db.prepare("SELECT 1 FROM staging_landing_links WHERE landing_id = ? AND with_landing_id = ?").bind(l.landing_id, withLandingId).first())) {
    throw conflict("travel_with_limit", `a task travels with at most ${MAX_TRAVEL_WITH} others`);
  }
  // the promotion holding the landing now (claims are written with the promotion row)
  const holder = await holderOf(svc, l.landing_id);
  const p = holder ? await getPromotion(svc, holder) : null;
  if (p && IN_FLIGHT.includes(p.state) && !promotionLandingIds(p).includes(withLandingId)) {
    const refuse = async () => {
      if (wrote) await svc.db.prepare("DELETE FROM staging_landing_links WHERE landing_id = ? AND with_landing_id = ?").bind(l.landing_id, withLandingId).run();
      throw inFlightError(p.promotion_id);
    };
    if (PRODUCTION.includes(p.state)) await refuse();
    const ended = await supersedePromotion(svc, p, { code: "travel_with_added", text: travelWithAddedText(w.title), detail: `landing ${l.landing_id} must travel with ${withLandingId}, which the promotion does not include` });
    if (!ended) {
      // it moved meanwhile: refused only when it took production
      const now = await getPromotion(svc, p.promotion_id);
      if (now && PRODUCTION.includes(now.state)) await refuse();
    }
  }
  if (wrote) {
    await recordEvent(svc, { orgId: l.org_id, projectId: l.project_id, actor: userRef(userId), action: "staging.travel_with", subjectKind: "landing", subjectId: l.landing_id, detail: { landingId: l.landing_id, withLandingId, linked: true } });
  }
  return { landingId: l.landing_id, withLandingId };
}

/** Remove a travel-with link (idempotent). */
export async function removeTravelWith(svc: Services, l: LandingRow, withLandingId: string, userId: string): Promise<void> {
  const r = await svc.db.prepare("DELETE FROM staging_landing_links WHERE landing_id = ? AND with_landing_id = ?").bind(l.landing_id, withLandingId).run();
  if ((r.meta.changes ?? 0) > 0) {
    await recordEvent(svc, { orgId: l.org_id, projectId: l.project_id, actor: userRef(userId), action: "staging.travel_with", subjectKind: "landing", subjectId: l.landing_id, detail: { landingId: l.landing_id, withLandingId, linked: false } });
  }
}
