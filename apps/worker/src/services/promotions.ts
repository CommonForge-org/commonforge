/**
 * Promotions (staging phase 2, spec 2026-10-07 §7): a task that is live on staging goes to
 * production with the earlier landings it depends on (`promotionSet`). The promotion builds a
 * proposal on the current `main` (promotion-proposal.ts), integrates it (the runner `integrate` job
 * with explicit merge bases), gates it (promotion-gate.ts) and clears it: by itself (`self` level),
 * by an owner who asked for it, or by a developer's approval. A cleared promotion is accepted
 * into `main` through the ledger with its clearance and released to production (Task 8).
 *
 * `promotion.advance` drives one promotion like `staging.advance` drives a build: each call re-reads
 * the row and does the next missing thing, under the promotion's own lock (B4: one chain per
 * promotion; promotions of a project step in parallel), and every write is a compare-and-set on the
 * state, so a step that dies half way is repaired by the next one.
 *
 * Parallel promotions (phase 2b). Promotions of one project run at the same time when their landing
 * sets are disjoint: `promotion_landings` holds each in-flight promotion's landings (B1; a partial
 * unique index makes "a landing is in at most one in-flight promotion" a D1 invariant), written in
 * the request batch and released in the batch that ends or accepts the promotion. Only the steps
 * that move `main` and production take turns (B2): entering `accepting` (from `cleared`) and
 * `retry-release` are a compare-and-set that the index `promotions_production_claim` refuses while
 * another promotion of the project is `accepting` or `releasing`; the claim is held until the
 * release ends, so releases go out in accept order. A `cleared` promotion that cannot take
 * production ends its chain (`production_busy`, B3) and waits in clearance order (`cleared_at`,
 * kept when a clearance carries); whoever ends a production claim nudges the first in line
 * ({@link nudgeProductionQueue}), and GC nudges silent ones. Before taking production, a promotion
 * whose proposal was built on an older `main` rebuilds; the first in line does so as soon as the
 * holder's accept moved `main` (while it releases), so the rebuild overlaps the release. Any
 * rebuild because `main` moved counts toward {@link MAX_REBUILDS} only when something other than
 * this project's promotions moved it (`promotion_rebuilds` counts the others; the 6 h deadline
 * bounds them, with the "production kept changing" text).
 *
 * | state              | step action                                                                |
 * |--------------------|----------------------------------------------------------------------------|
 * | `requested`        | build the promotion proposal on `main`, issue its integrate job → building |
 * |                    | (mode `alone` no longer covered by the checks → widened first)              |
 * | `building`         | wait for the receipt for the proposal hash; main moved → requested;        |
 * |                    | mode `alone` and a conflict or failed check → widened once → requested     |
 * | `gating`           | gate; carry or write a clearance → cleared, else → pending_approval        |
 * | `pending_approval` | the chain ends; approve / send back / a policy change start the next step  |
 * | `cleared`          | a policy change → requested; the set guard; earlier in line → the chain    |
 * |                    | ends (waits); main moved → requested (also while production is busy);      |
 * |                    | production busy → the chain ends; else takes production → accepting        |
 * | `accepting`        | ledger accept (clearance as approval); main moved → requested; → releasing |
 * | `releasing`        | prepare, clearance publish approval, deploy (migrations first) → live      |
 * | `release_failed`   | the chain ends; `retry-release` (owner/developer) → releasing              |
 *
 * The machine states (requested, building, gating) are bounded: 6 h from `machine_since` (set when
 * the promotion enters `requested` from anywhere else), at most {@link MAX_REBUILDS} rebuilds
 * because `main` moved, and at most {@link MAX_JOB_ATTEMPTS} integrate jobs reissued per proposal
 * hash. `accepting` is bounded by {@link ACCEPT_DEADLINE_MS} from taking production (`claimed_at`);
 * `releasing` by {@link RELEASE_DEADLINE_MS} from `machine_since`, which marks the release round
 * (set on entering `releasing` and on every retry-release).
 *
 * Accept and release (Task 8). The accept is the ledger's (`planCommit`): the promotion proposal,
 * its integration result for the current hash, and the clearance (honoured while the row is
 * `cleared`/`accepting`), under the idempotency key `<org>:promotion:<id>:<proposalId>`. A step
 * that dies after the accept committed finds the proposal `accepted` in the ledger and continues
 * from the accepted version (never a second accept). At accept (R10) the landings become
 * `promoted` (one batch with the row), their landing proposals `superseded`, the candidates
 * `accepted`, and staging is rebuilt without them (main has them now). What else `main` gained is
 * recorded before the row moves on (and again when the release starts): every part's task promotes
 * its LFS objects, and a file change staged through a part is `added` ({@link promoteLandedWork};
 * in staging-mode projects uploads and edits reach `main` only this way). The production release runs
 * as the promotion service on behalf of the clearer ({@link releaseActor}): the clearer may be a
 * client (self clearance) who can call no release route; the clearance itself is the publish
 * approval (`approvePublishByClearance`, honoured only while this promotion is `releasing` that
 * release), and only when everything it brings to production new was cleared by promotions
 * ({@link unclearedVersions}; otherwise `release_needs_publish_approval` and an owner publishes). A
 * release that does not go live leaves `main` as it is (R10): `release_failed`, retried by an owner
 * or developer (a fresh prepare of the latest accepted version), or `live` once any production
 * release containing its version goes live.
 *
 * Alone-first (B8, promotion-alone.ts): a promotion whose project's required checks cover every
 * resource the task changes starts with only the task and its travel-with chain (mode `alone`) and
 * names the earlier overlapping landings it goes without; an alone build that conflicts or fails a
 * required check or contract widens once to the closure ({@link widenPromotion}: the extra
 * landings are claimed in one batch with the row, the clearance is void, the build and the gate
 * run again on the widened set) and the client reads what it needs.
 *
 * Clearances (ruling P2-1): a clearance is bound to `clearanceKey` over the set's landing proposal
 * hashes. A rebuild (main moved, policy changed) keeps the clearance fields; `gating` carries the
 * clearance to the new proposal when the key is unchanged, the new level is no stricter than the
 * clearance covers (`developer` covers every level, `classifier` `classify` and `self`, `self` only `self`), and the clearer may still
 * clear it (review M3).
 *
 * Approvers (review M2) mirror ordinary approvals: an owner or developer clears only while their role
 * is in the project's `approvalRoles` (owners are not implicitly approvers; the default roles
 * include both).
 *
 * Landings and their claims move together with the promotion row (one D1 batch) when a promotion
 * starts, is accepted or ends, so a crash never leaves landings `promoting` without an in-flight
 * promotion that claims them; {@link repairPromotingLandings} (on request and in GC) fixes older
 * leftovers.
 *
 * Reasons: `reason` is platform-composed text (or a developer's send-back note, written for the
 * client); `detail` and `gate_json` are for owners and developers only.
 */
import { clearanceKey, revisionCommitSha, riskState, type AcceptedProjectVersion, type FrozenCandidate, type PrincipalRef, type PromotionLevel, type ProposalRecord } from "@commonforge-org/core";
import type { Services } from "../context.js";
import { newId } from "../lib/crypto.js";
import { ApiError, conflict, forbidden } from "../lib/http.js";
import { canReadProject, canReadResource } from "../middleware/authz.js";
import { getProject, getRole, listMounts, projectPolicy, type ProjectRow, type Role } from "./directory.js";
import { recordEvent, userRef } from "./events.js";
import type { StepOutcome } from "./intake.js";
import { issueIntegration } from "./integration.js";
import { aloneFirstApplies, assertLinksInStaging, goingWithoutText, landingResources, needsBeingPromotedText, needsNotReadyText, needsText, promotionParts, promotionSets, travelWithAddedText } from "./promotion-alone.js";
import { notConfiguredEvidence, runClassifier, type ClassifierEvidence } from "./classifier.js";
import { gatePromotion, gateReasonText } from "./promotion-gate.js";
import { buildRiskInput } from "./promotion-risk-input.js";
import { buildPromotionProposal, supersedePromotionProposal } from "./promotion-proposal.js";
import { acceptInputFor, approvalRoles, getProposalIndex, latestIntegration, latestIntegrationAttempt, proposalResourceIds } from "./proposals.js";
import { approvePublishByClearance, deployRelease, getLive, getRelease, onProductionLive, prepareRelease, sweepStaleReleases, type ReleaseActor, type ReleaseRow } from "./releases.js";
import { landPromotedFileChange } from "./file-changes.js";
import { promoteTask } from "./lfs-store.js";
import { closeLandingProposals, IN_STAGING, landingOfTask, landingParts, onPromotingLandingFailed, onPromotingLandingRevised, recordLandingEvent, requestBuild, type LandingRow } from "./staging.js";
import { getBaseline } from "./staging-baseline.js";
import { stagingPolicyOf, type StagingPolicy } from "./staging-policy.js";
import type { ReleasePolicy } from "./release-policy.js";
import { enqueueStep, MAX_STEP_ATTEMPTS, onStep, onStepFailed } from "./steps.js";
import type { TaskRow } from "./tasks.js";

export type PromotionState = "requested" | "building" | "gating" | "pending_approval" | "cleared" | "accepting" | "releasing" | "live" | "failed" | "release_failed" | "sent_back" | "superseded" | "withdrawn";
export type ClearanceKind = "self" | "classifier" | "developer";

export interface PromotionRow {
  promotion_id: string;
  org_id: string;
  project_id: string;
  target_landing_id: string;
  /** ordered landing ids of the set */
  landings_json: string;
  /** the parts' landing proposal hashes, in set order (the clearance key input) */
  proposal_hashes_json: string;
  proposal_id: string | null;
  proposal_hash: string | null;
  integrate_job_id: string | null;
  merge_bases_json: string | null;
  state: PromotionState;
  level: PromotionLevel | null;
  gate_json: string | null;
  clearance_kind: ClearanceKind | null;
  clearance_key: string | null;
  cleared_by: string | null;
  cleared_at: string | null;
  /** a `classifier` clearance's evidence (JSON), kept and voided with the clearance (P3-11); developers only */
  clearance_evidence_json: string | null;
  policy_revision: number | null;
  accepted_version_id: string | null;
  release_id: string | null;
  reason_code: string | null;
  reason: string | null;
  detail: string | null;
  requested_by: string;
  created_at: string;
  updated_at: string;
  /** when it last entered `requested` from outside the machine states (the deadline's start) */
  machine_since: string | null;
  /** rebuilds because `main` moved by something other than this project's promotions (capped) */
  rebuilds: number;
  /** rebuilds because only this project's promotions moved `main` (not capped; the deadline bounds them) */
  promotion_rebuilds: number;
  /** integrate jobs reissued for the current proposal hash */
  job_attempts: number;
  /** heartbeat of its `promotion.advance` chain, written by every step run; NULL once the chain ended */
  chain_at: string | null;
  /** when it last took production (entered `accepting`): the accept deadline's start */
  claimed_at: string | null;
  /** B8: `alone` (the target and its travel-with chain, widened once on a failed build) or `closure` */
  mode: PromotionMode;
  /** `[{ landingId, taskId, title }]`: earlier overlapping landings an alone promotion leaves in staging */
  going_without_json: string;
  /** `[{ landingId, taskId, title }]`: landings an alone promotion added when it widened */
  needs_json: string;
}

export type PromotionMode = "alone" | "closure";
type NamedLanding = { landingId: string; taskId: string; title: string };

/** The promotion service as an actor (events, integrate requests). */
export const PROMOTION_SERVICE = { kind: "service", id: "promotion-service" } as never;

/** What clients and viewers read when a promotion stops: composed here, never runner text. */
export const PROMOTION_REASONS = {
  conflict: "Conflicts with production.",
  check: "A required check failed when combined with production.",
  build: "The promotion could not be built on production. A developer needs to check it.",
  stopped: "The promotion stopped before it finished. Try promoting again.",
  changed: "Staging changed while the promotion was requested. Try promoting again.",
  unstable: "Production kept changing; promote again.",
  landingFailed: "A task in this promotion left staging. Promote again.",
  revised: "A task in this promotion was revised. Promote again once the revision is live on staging.",
  off: "Staging was turned off for this project.",
  accept: "The promotion could not be accepted into production. A developer needs to check it.",
  releaseFailed: "The production update did not go live. Production still runs the previous version.",
  migrationFailed: "A database migration failed; production was not changed.",
  migrationUnknown: "A database update did not confirm; a developer is checking production.",
  needsPublishApproval: "Production has other changes waiting for an owner's approval.",
  productionBusy: "Waiting for another update to reach production.",
  withdrawn: "Withdrawn",
  checksChanged: "The project's checks changed while the promotion was built. Promote again.",
  travelWithLeft: "A task this one must travel with left staging. A developer needs to remove the link first.",
} as const;

/** States the step works through by itself (bounded); the rest wait for people or Task 8. */
const MACHINE: PromotionState[] = ["requested", "building", "gating"];
/** Before accepting starts: the states a promotion can be failed, sent back or superseded from by anyone. */
const BEFORE_ACCEPT: PromotionState[] = [...MACHINE, "pending_approval", "cleared"];
/** In flight: not ended. Its landings are claimed (`promotion_landings`, active) until it is accepted or ends. */
export const IN_FLIGHT: PromotionState[] = ["requested", "building", "gating", "pending_approval", "cleared", "accepting", "releasing"];
/** Holding production (the index `promotions_production_claim`, B2): from the accept until the release ends. */
export const PRODUCTION: PromotionState[] = ["accepting", "releasing"];
/** Accepted into production (or taking it): no longer withdrawn; a failed release is retried. */
const ACCEPTED: PromotionState[] = [...PRODUCTION, "release_failed", "live"];
/** A promotion that stays in the machine states this long (from `machine_since`) fails. */
export const PROMOTION_DEADLINE_MS = 6 * 3600_000;
/** Rebuilds because `main` moved, per promotion. */
export const MAX_REBUILDS = 10;
/** Integrate jobs reissued (expired, transient failure) per proposal hash. */
export const MAX_JOB_ATTEMPTS = 10;
/** `accepting` that has not accepted this long after the clearance fails; the accept itself is one ledger call. */
export const ACCEPT_DEADLINE_MS = 3600_000;
/**
 * `releasing` that is neither live nor failed after this long (from entering it or the retry) is
 * `release_failed`. Longer than the release system's own bounds (build job 1 h, deploy job 30 min,
 * lost deploys swept after 30 min).
 */
export const RELEASE_DEADLINE_MS = 2 * 3600_000;
const LOCK_MS = 10 * 60_000;

type Next = { done: true } | { wait: number; reason: string };
const DONE = { done: true } as const;
const wait = (seconds: number, reason: string): Next => ({ wait: seconds, reason });
type Reason = { code: string; text: string; detail?: string };

export async function getPromotion(svc: Services, promotionId: string): Promise<PromotionRow | null> {
  return svc.db.prepare("SELECT * FROM promotions WHERE promotion_id = ?").bind(promotionId).first<PromotionRow>();
}

type Patch = Partial<Omit<PromotionRow, "promotion_id" | "org_id" | "project_id" | "created_at" | "updated_at" | "requested_by" | "target_landing_id" | "landings_json" | "chain_at">>;

function updateSql(svc: Services, promotionId: string, from: PromotionState[], patch: Patch, now: string, hash?: string | null) {
  const keys = Object.keys(patch) as Array<keyof Patch>;
  return svc.db
    .prepare(`UPDATE promotions SET ${keys.map((k) => `${k} = ?`).join(", ")}${keys.length ? ", " : ""}updated_at = ? WHERE promotion_id = ? AND state IN (${from.map(() => "?").join(", ")})${hash !== undefined ? " AND proposal_hash IS ?" : ""}`)
    .bind(...keys.map((k) => patch[k] ?? null), now, promotionId, ...from, ...(hash !== undefined ? [hash] : []));
}

/**
 * Compare-and-set: apply `patch` only while the promotion is in one of `from` (and, when `hash` is
 * given, still on that proposal hash). Returns whether it moved.
 */
async function setPromotion(svc: Services, promotionId: string, from: PromotionState[], patch: Patch, hash?: string | null): Promise<boolean> {
  const r = await updateSql(svc, promotionId, from, patch, svc.nowIso(), hash).run();
  return (r.meta.changes ?? 0) > 0;
}

const jsonList = (json: string | null): string[] => {
  try {
    const v: unknown = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};
export const promotionLandingIds = (p: Pick<PromotionRow, "landings_json">): string[] => jsonList(p.landings_json);

async function event(svc: Services, p: PromotionRow, action: string, code: string, actor: unknown = PROMOTION_SERVICE, extra: Record<string, unknown> = {}): Promise<void> {
  await recordEvent(svc, {
    orgId: p.org_id,
    projectId: p.project_id,
    actor: actor as never,
    action,
    subjectKind: "promotion",
    subjectId: p.promotion_id,
    detail: { promotionId: p.promotion_id, code, ...extra },
    clientVisible: true,
    // codes only: clients read reasons through the promotion view
    clientDetail: { promotionId: p.promotion_id, code },
  });
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** A chain whose heartbeat is younger than this is running (step waits are at most 30 s). */
export const CHAIN_FRESH_MS = 60_000;
/** GC nudges an in-flight promotion whose chain has been silent this long (a lost chain). */
export const CHAIN_LOST_MS = 5 * 60_000;

const chainFresh = (svc: Services, chainAt: string | null) => chainAt !== null && svc.now().getTime() - Date.parse(chainAt) < CHAIN_FRESH_MS;

/**
 * Ask the promotion's chain to look again (approve, retry-release, a policy change, a blocked
 * request, a revision waiting on it, production released). Only when no chain is running (review
 * I1: `enqueueStep` does not dedupe; a running chain re-reads the row at its next step anyway): its
 * heartbeat is NULL (the chain ended) or older than {@link CHAIN_FRESH_MS} (lost). The heartbeat is
 * taken by a compare-and-set before the step is enqueued, so two nudges in a row (a request and the
 * production queue, say) start one chain, not two.
 */
async function nudge(svc: Services, p: Pick<PromotionRow, "org_id" | "promotion_id">): Promise<void> {
  const now = svc.now();
  const r = await svc.db
    .prepare("UPDATE promotions SET chain_at = ? WHERE promotion_id = ? AND (chain_at IS NULL OR chain_at < ?)")
    .bind(now.toISOString(), p.promotion_id, new Date(now.getTime() - CHAIN_FRESH_MS).toISOString())
    .run();
  if ((r.meta.changes ?? 0) === 0) return;
  await enqueueStep(svc, { type: "promotion.advance", orgId: p.org_id, promotionId: p.promotion_id });
}

/**
 * GC (review M2): in-flight promotions that work by themselves (not `pending_approval`) whose chain
 * has been silent for {@link CHAIN_LOST_MS} get a step (a `cleared` one waiting for production looks
 * again). Returns how many were nudged.
 */
export async function nudgeStalePromotions(svc: Services, orgId: string): Promise<number> {
  const before = new Date(svc.now().getTime() - CHAIN_LOST_MS).toISOString();
  const rows = (
    await svc.db
      // a cleared promotion waiting for production is the queue's (below): only the first in line looks again
      .prepare("SELECT org_id, promotion_id FROM promotions WHERE org_id = ? AND state IN ('requested', 'building', 'gating', 'cleared', 'accepting', 'releasing') AND NOT (state = 'cleared' AND reason_code IS 'production_busy') AND COALESCE(chain_at, updated_at) < ?")
      .bind(orgId, before)
      .all<Pick<PromotionRow, "org_id" | "promotion_id">>()
  ).results;
  for (const r of rows) await nudge(svc, r);
  // projects whose production is free while cleared promotions wait (a lost queue nudge)
  const projects = (await svc.db.prepare("SELECT DISTINCT project_id FROM promotions WHERE org_id = ? AND state = 'cleared'").bind(orgId).all<{ project_id: string }>()).results;
  for (const pr of projects) await nudgeProductionQueue(svc, orgId, pr.project_id);
  return rows.length;
}

/**
 * A policy change (PUT …/policy): promotions whose chain has ended get a step, which rebuilds them
 * on the new policy (the gate decides whether a clearance still covers the set): `pending_approval`
 * and `cleared` promotions waiting for production. A running chain compares revisions itself (and
 * the ledger refuses a stale one at accept); `releasing` no longer depends on the promotion policy.
 */
export async function nudgePromotions(svc: Services, orgId: string, projectId: string): Promise<void> {
  const rows = (await svc.db.prepare("SELECT org_id, promotion_id FROM promotions WHERE org_id = ? AND project_id = ? AND state IN ('pending_approval', 'cleared')").bind(orgId, projectId).all<Pick<PromotionRow, "org_id" | "promotion_id">>()).results;
  for (const r of rows) await nudge(svc, r);
}

/**
 * The production line (B3): promotions holding a clearance on their way to production — `cleared`,
 * or rebuilding (`requested`, `building`, `gating`) with the clearance they carry — in clearance
 * order (`cleared_at`, kept when a clearance carries; then the id).
 */
const IN_LINE = `state IN ('requested', 'building', 'gating', 'cleared') AND clearance_kind IS NOT NULL AND cleared_at IS NOT NULL`;

/** The promotion of the project holding production (`accepting`/`releasing`), if any. */
async function productionHolder(svc: Services, orgId: string, projectId: string): Promise<Pick<PromotionRow, "org_id" | "promotion_id" | "state"> | null> {
  return svc.db.prepare(`SELECT org_id, promotion_id, state FROM promotions WHERE org_id = ? AND project_id = ? AND state IN (${placeholders(PRODUCTION.length)}) LIMIT 1`).bind(orgId, projectId, ...PRODUCTION).first<Pick<PromotionRow, "org_id" | "promotion_id" | "state">>();
}

/**
 * Production may have become free (a release ended, a promotion left the line), or its holder has
 * moved `main` (it is `releasing`): the first promotion in line gets a step if it waits in `cleared`
 * with no chain running. With production free it takes production; while the holder releases it
 * rebuilds on the new `main` if its proposal is older (see {@link startAccept}), so it is ready when
 * the release ends. A first in line that is still rebuilding goes on by itself.
 */
export async function nudgeProductionQueue(svc: Services, orgId: string, projectId: string): Promise<void> {
  const holder = await productionHolder(svc, orgId, projectId);
  if (holder && holder.state !== "releasing") return;
  const first = await svc.db
    .prepare(`SELECT org_id, promotion_id, state, chain_at, proposal_id FROM promotions WHERE org_id = ? AND project_id = ? AND ${IN_LINE} ORDER BY cleared_at, promotion_id LIMIT 1`)
    .bind(orgId, projectId)
    .first<Pick<PromotionRow, "org_id" | "promotion_id" | "state" | "chain_at" | "proposal_id">>();
  if (first?.state !== "cleared" || chainFresh(svc, first.chain_at)) return;
  // production busy: only a proposal built on an older `main` has work to do (else its step would wait again)
  if (holder && !(await builtOnOlderMain(svc, orgId, first.proposal_id ? await svc.ledger(orgId).getProposal(first.proposal_id) : null))) return;
  await nudge(svc, first);
}

/** Whether a proposal was built on an older `main`: a changed resource's head is no longer its base. */
async function builtOnOlderMain(svc: Services, orgId: string, proposal: Pick<ProposalRecord, "resourceChanges"> | null): Promise<boolean> {
  const ledger = svc.ledger(orgId);
  for (const rc of proposal?.resourceChanges ?? []) if ((await ledger.getHead(rc.resourceId))?.revisionId !== rc.baseRevision) return true;
  return false;
}

/** The in-flight promotion that claims a landing (B1), if any. */
export async function holderOf(svc: Services, landingId: string): Promise<string | null> {
  return (await svc.db.prepare("SELECT promotion_id FROM promotion_landings WHERE landing_id = ? AND active = 1").bind(landingId).first<{ promotion_id: string }>())?.promotion_id ?? null;
}

// ------------------------------------------------------------------------------ the set and its parts

export { promotionParts };

/**
 * `promoting` landings that no in-flight promotion claims (left by an older crash) go back to
 * `landed`, and claims of promotions that ended are released. Per project, or every project of the
 * org (GC). Returns how many landings and claims moved.
 */
export async function repairPromotingLandings(svc: Services, orgId: string, projectId?: string): Promise<number> {
  const rows = (
    await svc.db
      .prepare(`SELECT * FROM staging_landings WHERE org_id = ? AND state = 'promoting'${projectId ? " AND project_id = ?" : ""}`)
      .bind(orgId, ...(projectId ? [projectId] : []))
      .all<LandingRow>()
  ).results;
  let n = 0;
  for (const l of rows) {
    // one statement: a promotion inserted concurrently (its batch claims the landing) keeps it
    const r = await svc.db
      .prepare(
        `UPDATE staging_landings SET state = 'landed', reason_code = NULL, reason = NULL, detail = NULL, updated_at = ? WHERE landing_id = ? AND state = 'promoting' AND NOT EXISTS (SELECT 1 FROM promotion_landings c JOIN promotions p ON p.promotion_id = c.promotion_id WHERE c.landing_id = ? AND c.active = 1 AND p.state IN (${placeholders(IN_FLIGHT.length)}))`,
      )
      .bind(svc.nowIso(), l.landing_id, l.landing_id, ...IN_FLIGHT)
      .run();
    if ((r.meta.changes ?? 0) > 0) {
      await recordLandingEvent(svc, l, "landed");
      n++;
    }
  }
  // claims of ended promotions (every ending batch releases them; this only fixes older leftovers)
  const c = await svc.db
    .prepare(`UPDATE promotion_landings SET active = 0 WHERE active = 1 AND org_id = ?${projectId ? " AND project_id = ?" : ""} AND promotion_id IN (SELECT promotion_id FROM promotions WHERE org_id = ? AND state NOT IN (${placeholders(IN_FLIGHT.length)}))`)
    .bind(orgId, ...(projectId ? [projectId] : []), orgId, ...IN_FLIGHT)
    .run();
  return n + (c.meta.changes ?? 0);
}

// ------------------------------------------------------------------------------ request

type SetLanding = LandingRow & { title: string };

/**
 * Why a set cannot be promoted now (B1): the target is already being promoted
 * (`promotion_in_progress`, naming its promotion), an earlier landing of the set is claimed by
 * another promotion (`promotion_dependency_busy`, naming it and the task) or is not live on staging
 * yet (`promotion_dependency_busy`, naming the task). The holder is nudged (its chain may have been
 * lost: a refused request is how a lost promotion still reaches its deadline). Null when every
 * landing of the set is `landed`.
 */
async function setBusy(svc: Services, target: LandingRow, set: SetLanding[], nudgeHolder = true): Promise<ApiError | null> {
  const t = set.find((l) => l.landing_id === target.landing_id);
  if (t?.state === "promoting" || (!t && target.state === "promoting")) {
    const holder = await holderOf(svc, target.landing_id);
    if (holder && nudgeHolder) await nudge(svc, { org_id: target.org_id, promotion_id: holder });
    return new ApiError(409, "promotion_in_progress", "this task is already being promoted", holder ? { promotionId: holder } : undefined);
  }
  const busy = set.find((l) => l.state !== "landed");
  if (!busy) return null;
  if (busy.state === "promoting") {
    const holder = await holderOf(svc, busy.landing_id);
    if (holder && nudgeHolder) await nudge(svc, { org_id: target.org_id, promotion_id: holder });
    return new ApiError(409, "promotion_dependency_busy", `'${busy.title}' is being promoted; wait until it finishes`, { ...(holder ? { promotionId: holder } : {}), taskId: busy.task_id, title: busy.title });
  }
  return new ApiError(409, "promotion_dependency_busy", "a task this one depends on is not live on staging yet; wait until it is", { taskId: busy.task_id, title: busy.title });
}

/**
 * The insert was refused although no landing of the set looks busy (a concurrent claim, a claim
 * row left behind): the promotion that claims a landing of the set is nudged and named, like
 * {@link setBusy}. Null when no landing of the set is claimed.
 */
async function claimedBy(svc: Services, target: LandingRow, set: SetLanding[]): Promise<ApiError | null> {
  for (const l of set) {
    const holder = await holderOf(svc, l.landing_id);
    if (!holder) continue;
    await nudge(svc, { org_id: target.org_id, promotion_id: holder });
    if (l.landing_id === target.landing_id) return new ApiError(409, "promotion_in_progress", "this task is already being promoted", { promotionId: holder });
    return new ApiError(409, "promotion_dependency_busy", `'${l.title}' is being promoted; wait until it finishes`, { promotionId: holder, taskId: l.task_id, title: l.title });
  }
  return null;
}

/** What promoting a task would take now: the set, its mode and the landings it goes without ({@link planPromotion}). */
export interface PromotionPlan {
  project: ProjectRow;
  target: LandingRow;
  mode: PromotionMode;
  /** landing ids of the set, in order */
  ids: string[];
  set: SetLanding[];
  going: NamedLanding[];
  /** landings it goes without that another promotion is promoting now (their text says so) */
  promotingNow: Set<string>;
}

/**
 * The set a promotion of `task` takes now, computed exactly as {@link requestPromotion} does
 * (ruling P3-7: the Promote sheet's dry run, `GET /api/tasks/:id/promote`). Throws the same errors
 * (`staging_awaiting_baseline`, `not_in_staging`, `not_landed`, `promotion_in_progress`,
 * `promotion_dependency_busy`, the travel-with codes). `dryRun`: no writes at all (no repair of
 * leftover `promoting` landings, which `POST` does first, so it counts those as `landed` as the
 * repair would make them; and no nudge of a holder it names).
 */
export async function planPromotion(svc: Services, task: TaskRow, opts: { dryRun?: boolean } = {}): Promise<PromotionPlan> {
  const orgId = task.org_id;
  const nudgeHolder = !opts.dryRun;
  const project = await getProject(svc.db, orgId, task.project_id);
  if (!project || !stagingPolicyOf(project)) throw new ApiError(404, "not_found", "this project has no staging");
  // B6: nothing is promoted before the owner's first production publish of `main`
  if (!(await getBaseline(svc, orgId, task.project_id))) throw conflict("staging_awaiting_baseline", "Staging starts after the owner's first production publish");
  // the task's own landing, or the one it joined as a revision (R6)
  const found = await landingOfTask(svc, orgId, task.task_id, IN_STAGING);
  if (!found) throw conflict("not_in_staging", "this task is not in staging");
  // the dry run writes nothing, so it cannot repair: a `promoting` landing that no in-flight
  // promotion claims (an older crash; POST's repairPromotingLandings puts it back) counts as `landed`
  const orphans = opts.dryRun ? await orphanPromotingLandings(svc, orgId, task.project_id) : new Set<string>();
  const asRepaired = <T extends { landing_id: string; state: LandingRow["state"] }>(l: T): T => (orphans.has(l.landing_id) ? { ...l, state: "landed" } : l);
  const target = asRepaired(found);
  if (target.state === "promoting") throw (await setBusy(svc, target, [], nudgeHolder))!;
  if (target.state !== "landed") throw conflict("not_landed", "this task is not live on staging yet");
  // the sets over every landing in staging: one of the promoted set that is not `landed` cannot be promoted now
  const sets = await promotionSets(svc, orgId, task.project_id, target.landing_id);
  const changed = new Set(sets.alone.flatMap((id) => [...(sets.changes.get(id) ?? [])]));
  const mode: PromotionMode = sets.closure.length > sets.alone.length && aloneFirstApplies(projectPolicy(project), changed, await listMounts(svc.db, orgId, task.project_id)) ? "alone" : "closure";
  const ids = mode === "alone" ? sets.alone : sets.closure;
  // B9: only the links of the set promoted now (a widen checks the closure's)
  assertLinksInStaging(sets, ids);
  const going: NamedLanding[] = mode === "alone" ? sets.closure.filter((id) => !sets.alone.includes(id)).map((id) => ({ landingId: id, ...(sets.titles.get(id) ?? { taskId: "", title: "" }) })) : [];
  const promotingNow = new Set(sets.open.filter((l) => asRepaired(l).state === "promoting").map((l) => l.landing_id));
  const set = (await readSetLandings(svc, ids)).map(asRepaired);
  const refused = await setBusy(svc, target, set, nudgeHolder);
  if (refused) throw refused;
  return { project, target, mode, ids, set, going, promotingNow };
}

/** `promoting` landings of a project that no in-flight promotion claims: what {@link repairPromotingLandings} would put back to `landed`. */
async function orphanPromotingLandings(svc: Services, orgId: string, projectId: string): Promise<Set<string>> {
  const rows = await svc.db
    .prepare(
      `SELECT l.landing_id FROM staging_landings l WHERE l.org_id = ? AND l.project_id = ? AND l.state = 'promoting' AND NOT EXISTS (SELECT 1 FROM promotion_landings c JOIN promotions p ON p.promotion_id = c.promotion_id WHERE c.landing_id = l.landing_id AND c.active = 1 AND p.state IN (${placeholders(IN_FLIGHT.length)}))`,
    )
    .bind(orgId, projectId, ...IN_FLIGHT)
    .all<{ landing_id: string }>();
  return new Set(rows.results.map((r) => r.landing_id));
}

/** The set's landings with their task titles, in set order. */
async function readSetLandings(svc: Services, ids: string[]): Promise<SetLanding[]> {
  const rows = (await svc.db.prepare(`SELECT l.*, t.title FROM staging_landings l JOIN tasks t ON t.task_id = l.task_id WHERE l.landing_id IN (${placeholders(ids.length)})`).bind(...ids).all<SetLanding>()).results;
  return ids.map((id) => rows.find((l) => l.landing_id === id)).filter((l): l is SetLanding => !!l);
}

/** `GET /api/tasks/:id/promote` (P3-7): what `POST` would promote now, without writing anything. */
export async function previewPromotion(svc: Services, task: TaskRow): Promise<{ landings: Array<NamedLanding>; mode: PromotionMode; goingWithout: Array<NamedLanding & { text: string }> }> {
  const plan = await planPromotion(svc, task, { dryRun: true });
  return {
    landings: plan.set.map((l) => ({ landingId: l.landing_id, taskId: l.task_id, title: l.title })),
    mode: plan.mode,
    goingWithout: plan.going.map((g) => ({ ...g, text: goingWithoutText(g.title, plan.promotingNow.has(g.landingId)) })),
  };
}

/**
 * `POST /api/tasks/:id/promote` (authorization is the route's): the task's `landed` landing and the
 * earlier landed landings it shares a path with become one promotion (`requested`), its landings
 * `promoting` and claimed by it (one batch), and its `promotion.advance` chain starts. Promotions of
 * a project run in parallel on disjoint sets (B1): a set landing another promotion claims refuses
 * the request ({@link setBusy}).
 *
 * Alone-first (B8): when the closure is larger than the alone set (the target and its travel-with
 * chain) and the project's required checks cover every resource the alone set changes, the
 * promotion takes only the alone set (mode `alone`); the landings it goes without are named in the
 * response and the view. A failed alone build widens once ({@link widenPromotion}).
 */
export async function requestPromotion(
  svc: Services,
  task: TaskRow,
  userId: string,
): Promise<{ promotionId: string; landings: Array<{ landingId: string; taskId: string }>; mode: PromotionMode; goingWithout: Array<NamedLanding & { text: string }> }> {
  await repairPromotingLandings(svc, task.org_id, task.project_id);
  const { project, target, mode, ids, set, going, promotingNow } = await planPromotion(svc, task);
  const orgId = task.org_id;
  const readSet = () => readSetLandings(svc, ids);

  const promotionId = newId("prm", 10);
  const now = svc.nowIso();
  let inserted: number;
  try {
    // the row, its landings and their claims in one transaction: the insert happens only while every
    // landing of the set is `landed`; the landings move and are claimed only when the row exists
    const [ins] = await svc.db.batch([
      svc.db
        .prepare(
          `INSERT INTO promotions (promotion_id, org_id, project_id, target_landing_id, landings_json, state, policy_revision, requested_by, created_at, updated_at, machine_since, mode, going_without_json) SELECT ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM staging_landings WHERE landing_id IN (${placeholders(ids.length)}) AND state = 'landed') = ?`,
        )
        .bind(promotionId, orgId, task.project_id, target.landing_id, JSON.stringify(ids), project.policy_revision, userId, now, now, now, mode, JSON.stringify(going), ...ids, ids.length),
      svc.db.prepare(`UPDATE staging_landings SET state = 'promoting', reason_code = NULL, reason = NULL, detail = NULL, updated_at = ? WHERE landing_id IN (${placeholders(ids.length)}) AND state = 'landed' AND EXISTS (SELECT 1 FROM promotions WHERE promotion_id = ?)`).bind(now, ...ids, promotionId),
      svc.db
        .prepare("INSERT INTO promotion_landings (promotion_id, landing_id, org_id, project_id, active, created_at) SELECT ?, value, ?, ?, 1, ? FROM json_each(?) WHERE EXISTS (SELECT 1 FROM promotions WHERE promotion_id = ?)")
        .bind(promotionId, orgId, task.project_id, now, JSON.stringify(ids), promotionId),
    ]);
    inserted = ins!.meta.changes ?? 0;
  } catch (e) {
    // a landing of the set was claimed concurrently (promotion_landings_one_active)
    if (!/UNIQUE/i.test(String((e as Error)?.message))) throw e;
    inserted = 0;
  }
  if (inserted === 0) throw (await setBusy(svc, target, await readSet())) ?? (await claimedBy(svc, target, await readSet())) ?? conflict("staging_changed", "staging changed while the promotion was requested; try again");
  for (const l of set) await recordLandingEvent(svc, l, "promoting");
  const p = (await getPromotion(svc, promotionId))!;
  await event(svc, p, "promotion.requested", "requested", userRef(userId), { landings: ids, mode, ...(going.length ? { goingWithout: going.map((g) => g.landingId) } : {}) });
  await nudge(svc, p);
  return { promotionId, landings: set.map((l) => ({ landingId: l.landing_id, taskId: l.task_id })), mode, goingWithout: going.map((g) => ({ ...g, text: goingWithoutText(g.title, promotingNow.has(g.landingId)) })) };
}

// ------------------------------------------------------------------------------ ending a promotion

/**
 * End a promotion (failed, sent back, superseded) from one of `from` — and, with `hash`, only while
 * it is still on that proposal hash: the row, the set's `promoting` landings it claims (back to
 * `landed`, except `keep`) and its claims (released) move in one batch; then its proposal is closed,
 * the event recorded, and the production line looks again (it may have held production or been
 * first in line).
 */
async function endPromotion(svc: Services, p: PromotionRow, from: PromotionState[], patch: Patch & { state: PromotionState }, ev: { action: string; code: string; actor?: unknown; extra?: Record<string, unknown> }, opts: { hash?: string | null; keep?: string } = {}): Promise<boolean> {
  // the set as `p` lists it and every landing it claims now (a widen may have added some since `p` was read)
  const claimed = (await svc.db.prepare("SELECT landing_id FROM promotion_landings WHERE promotion_id = ? AND active = 1").bind(p.promotion_id).all<{ landing_id: string }>()).results.map((r) => r.landing_id);
  const ids = [...new Set([...promotionLandingIds(p), ...claimed])].filter((id) => id !== opts.keep);
  let before = ids.length ? (await svc.db.prepare(`SELECT * FROM staging_landings WHERE landing_id IN (${placeholders(ids.length)}) AND state = 'promoting'`).bind(...ids).all<LandingRow>()).results : [];
  const now = svc.nowIso();
  const stmts = [updateSql(svc, p.promotion_id, from, patch, now, opts.hash)];
  // only when this batch's update ended the promotion (its state and this write's time)
  const ended = `EXISTS (SELECT 1 FROM promotions WHERE promotion_id = ? AND state = ? AND updated_at = ?)`;
  // the landings this promotion claims at the batch (before the claims are released, below), so one
  // a widen added after `p` was read goes back too
  stmts.push(svc.db.prepare(`UPDATE staging_landings SET state = 'landed', reason_code = NULL, reason = NULL, detail = NULL, updated_at = ? WHERE state = 'promoting' AND landing_id IS NOT ? AND landing_id IN (SELECT landing_id FROM promotion_landings WHERE promotion_id = ? AND active = 1) AND ${ended}`).bind(now, opts.keep ?? null, p.promotion_id, p.promotion_id, patch.state, now));
  stmts.push(svc.db.prepare(`UPDATE promotion_landings SET active = 0 WHERE promotion_id = ? AND active = 1 AND ${ended}`).bind(p.promotion_id, p.promotion_id, patch.state, now));
  const [upd] = await svc.db.batch(stmts);
  if ((upd!.meta.changes ?? 0) === 0) return false;
  // `before` was read outside the batch: only the landings that are `landed` now get the event
  if (before.length) {
    const moved = new Set((await svc.db.prepare(`SELECT landing_id FROM staging_landings WHERE landing_id IN (${placeholders(before.length)}) AND state = 'landed' AND updated_at = ?`).bind(...before.map((l) => l.landing_id), now).all<{ landing_id: string }>()).results.map((r) => r.landing_id));
    before = before.filter((l) => moved.has(l.landing_id));
  }
  for (const l of before) await recordLandingEvent(svc, l, "landed");
  // the proposal the row names now (a build may have recorded a newer one since `p` was read), and the one `p` named
  const current = (await getPromotion(svc, p.promotion_id))?.proposal_id ?? null;
  for (const id of new Set([p.proposal_id, current])) if (id) await supersedePromotionProposal(svc, p.org_id, id);
  await event(svc, p, ev.action, ev.code, ev.actor ?? PROMOTION_SERVICE, ev.extra ?? {});
  await nudgeProductionQueue(svc, p.org_id, p.project_id);
  return true;
}

const VOID_CLEARANCE = { clearance_kind: null, clearance_key: null, cleared_by: null, cleared_at: null, clearance_evidence_json: null } as const;

/** The promotion fails (from one of `from`): landings back to `landed`, its proposal closed. */
async function failPromotion(svc: Services, p: PromotionRow, from: PromotionState[], reason: Reason): Promise<boolean> {
  return endPromotion(svc, p, from, { state: "failed", reason_code: reason.code, reason: reason.text, detail: reason.detail?.slice(0, 4000) ?? null }, { action: "promotion.failed", code: reason.code, extra: reason.detail ? { reason: reason.text, detail: reason.detail.slice(0, 2000) } : { reason: reason.text } });
}

/**
 * Supersede a promotion before it is accepted (a landing of its set left staging; Task 9: a new
 * revision of a landing in the set): the clearance is void, the other landings go back to
 * `landed` (`keep` stays as it is), its proposal is closed. The requester can promote again.
 * `from` defaults to the states before accepting; only the accept step itself passes `accepting`
 * (under the promotion lock, before its ledger accept).
 */
export async function supersedePromotion(svc: Services, p: PromotionRow, reason: Reason, keep?: string, from: PromotionState[] = BEFORE_ACCEPT): Promise<boolean> {
  return endPromotion(svc, p, from, { state: "superseded", reason_code: reason.code, reason: reason.text, detail: reason.detail ?? null, ...VOID_CLEARANCE }, { action: "promotion.superseded", code: reason.code }, keep ? { keep } : {});
}

/**
 * The set guard: every landing of the set must still be `promoting` and claimed by this promotion
 * (B1: the active `promotion_landings` row is its own). Otherwise the promotion is
 * superseded (`landing_failed`, from one of `from`) — this also covers a staging hook call that was
 * lost. Called before building, gating, entering `accepting` and the ledger accept. Returns whether
 * the set is intact.
 */
export async function promotionSetIntact(svc: Services, p: PromotionRow, from: PromotionState[] = BEFORE_ACCEPT): Promise<boolean> {
  const ids = promotionLandingIds(p);
  const rows = ids.length
    ? (
        await svc.db
          .prepare(`SELECT l.landing_id, l.state, c.promotion_id AS holder FROM staging_landings l LEFT JOIN promotion_landings c ON c.landing_id = l.landing_id AND c.active = 1 WHERE l.landing_id IN (${placeholders(ids.length)}) AND l.org_id = ? AND l.project_id = ?`)
          .bind(...ids, p.org_id, p.project_id)
          .all<{ landing_id: string; state: string; holder: string | null }>()
      ).results
    : [];
  const gone = ids.find((id) => {
    const r = rows.find((x) => x.landing_id === id);
    return r?.state !== "promoting" || r.holder !== p.promotion_id;
  });
  if (ids.length > 0 && !gone) return true;
  await supersedePromotion(svc, p, { code: "landing_failed", text: PROMOTION_REASONS.landingFailed, detail: gone ? `landing ${gone} is no longer promoting with this promotion` : "the promotion lists no landings" }, undefined, from);
  return false;
}

/**
 * B9, the link guard: every travel-with link of a landing in the set must point inside the set or to
 * a promoted landing (`main` has it). A link written while the promotion was requested (the request
 * read the sets before it) or one whose supersede was lost to a crash is enforced here, before
 * every build and before taking production: a link to a landing outside the set supersedes the
 * promotion (`travel_with_added`; promoting again takes the link), a link to a landing that left
 * staging fails it (`travel_with_left_staging`). Returns whether the promotion may go on.
 */
async function travelWithIntact(svc: Services, p: PromotionRow, from: PromotionState[]): Promise<boolean> {
  const ids = promotionLandingIds(p);
  if (ids.length === 0) return true;
  const rows = (
    await svc.db
      .prepare(`SELECT k.landing_id, k.with_landing_id, w.state, t.title FROM staging_landing_links k LEFT JOIN staging_landings w ON w.landing_id = k.with_landing_id LEFT JOIN tasks t ON t.task_id = w.task_id WHERE k.landing_id IN (${placeholders(ids.length)}) ORDER BY k.created_at, k.with_landing_id`)
      .bind(...ids)
      .all<{ landing_id: string; with_landing_id: string; state: string | null; title: string | null }>()
  ).results;
  const outside = rows.filter((r) => !ids.includes(r.with_landing_id) && r.state !== "promoted");
  const departed = outside.find((r) => r.state === null || !(IN_STAGING as readonly string[]).includes(r.state));
  if (departed) {
    await failPromotion(svc, p, from, { code: "travel_with_left_staging", text: PROMOTION_REASONS.travelWithLeft, detail: `landing ${departed.landing_id} must travel with ${departed.with_landing_id}, which is ${departed.state ?? "missing"}` });
    return false;
  }
  const missing = outside[0];
  if (!missing) return true;
  await supersedePromotion(svc, p, { code: "travel_with_added", text: travelWithAddedText(missing.title ?? ""), detail: `landing ${missing.landing_id} must travel with ${missing.with_landing_id}, which the promotion does not include` }, undefined, from);
  return false;
}

// staging failed a `promoting` landing (its change is no longer available): its promotion is superseded
onPromotingLandingFailed(async (svc, l) => {
  const holder = await holderOf(svc, l.landing_id);
  const p = holder ? await getPromotion(svc, holder) : null;
  if (p && BEFORE_ACCEPT.includes(p.state)) await supersedePromotion(svc, p, { code: "landing_failed", text: PROMOTION_REASONS.landingFailed, detail: `landing ${l.landing_id} failed in staging` }, l.landing_id);
});

/**
 * A revision is about to join a `promoting` landing (Task 9): a promotion of it that has not started
 * accepting is superseded (clearance void, every landing back to `landed`; the requester promotes
 * again); one that is accepting makes the revision wait (false). A leftover `promoting` landing no
 * promotion lists is repaired.
 */
onPromotingLandingRevised(async (svc, l) => {
  const holder = await holderOf(svc, l.landing_id);
  const p = holder ? await getPromotion(svc, holder) : null;
  if (!p || !IN_FLIGHT.includes(p.state)) {
    await repairPromotingLandings(svc, l.org_id, l.project_id);
    return true;
  }
  if (!BEFORE_ACCEPT.includes(p.state)) {
    await nudge(svc, p); // its chain may have been lost: the revision waits on it
    return false;
  }
  await supersedePromotion(svc, p, { code: "landing_revised", text: PROMOTION_REASONS.revised, detail: `landing ${l.landing_id} has a new revision` });
  return true;
});

/**
 * Start over from `requested` (main moved, the policy changed): a new proposal is built on the
 * current `main`. The clearance fields are kept; `gating` decides whether the clearance carries
 * over (ruling P2-1). `stale` (main moved by something other than this project's promotions, see
 * {@link rebuildMainMoved}; the other rebuilds from `accepting`) counts toward {@link MAX_REBUILDS};
 * past it the promotion fails. `byPromotions` counts `promotion_rebuilds` instead. Entering
 * `requested` after a person acted (from `pending_approval` or `cleared`) restarts the deadline;
 * from the machine states and `accepting` it keeps running (an approval restarts it too). Does not enqueue a step (the
 * caller's chain goes on). Returns whether the promotion moved (rebuilt or failed).
 */
export async function rebuildPromotion(svc: Services, promotionId: string, from: PromotionState[], opts: { stale?: boolean; byPromotions?: boolean } = {}): Promise<boolean> {
  const p = await getPromotion(svc, promotionId);
  if (!p || !from.includes(p.state)) return false;
  if (opts.stale && p.rebuilds >= MAX_REBUILDS) return failPromotion(svc, p, from, { code: "promotion_rebuild_limit", text: PROMOTION_REASONS.unstable, detail: `main moved ${p.rebuilds} times while the promotion was built` });
  const now = svc.nowIso();
  const r = await svc.db
    .prepare(
      `UPDATE promotions SET state = 'requested', level = NULL, gate_json = NULL, reason_code = NULL, reason = NULL, detail = NULL, rebuilds = rebuilds + ?, promotion_rebuilds = promotion_rebuilds + ?, machine_since = CASE WHEN state IN ('requested', 'building', 'gating', 'accepting') THEN COALESCE(machine_since, ?) ELSE ? END, updated_at = ? WHERE promotion_id = ? AND state IN (${placeholders(from.length)})`,
    )
    .bind(opts.stale ? 1 : 0, opts.byPromotions ? 1 : 0, now, now, now, promotionId, ...from)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Rebuild because `main` moved under the proposal (ruling I1, fix round 1): the rebuild counts toward
 * {@link MAX_REBUILDS} only when something other than this project's promotions moved it
 * ({@link movedOnlyByPromotions}); a promotion is never failed for other promotions' accepts (the
 * 6 h machine deadline still bounds it).
 */
async function rebuildMainMoved(svc: Services, p: PromotionRow, from: PromotionState[], proposal: Pick<ProposalRecord, "resourceChanges"> | null): Promise<boolean> {
  const byPromotions = await movedOnlyByPromotions(svc, p.org_id, p.project_id, proposal);
  return rebuildPromotion(svc, p.promotion_id, from, byPromotions ? { byPromotions: true } : { stale: true });
}

/** Is `proposalId` a promotion proposal of this project (its accepts were cleared by promotions)? */
async function isPromotionProposal(svc: Services, orgId: string, projectId: string, proposalId: string, cache?: Map<string, boolean>): Promise<boolean> {
  if (cache?.has(proposalId)) return cache.get(proposalId)!;
  const idx = await getProposalIndex(svc, orgId, proposalId);
  const yes = idx?.kind === "promotion" && idx.project_id === projectId;
  cache?.set(proposalId, yes);
  return yes;
}

/**
 * Per changed resource of the proposal: every accepted version after the one that set its
 * `baseRevision`, up to the head, is an accept of a promotion proposal of this project. False
 * without a proposal, when a base revision is not found among the accepted versions, or when any
 * other change (a direct accept, a restore) moved the resource.
 */
async function movedOnlyByPromotions(svc: Services, orgId: string, projectId: string, proposal: Pick<ProposalRecord, "resourceChanges"> | null): Promise<boolean> {
  if (!proposal || proposal.resourceChanges.length === 0) return false;
  const ledger = svc.ledger(orgId);
  const cache = new Map<string, boolean>();
  for (const rc of proposal.resourceChanges) {
    const rid = rc.resourceId as string;
    const head = await ledger.getHead(rid);
    if (!head || head.revisionId === rc.baseRevision) continue;
    const mine = await versionsTouching(svc, orgId, new Set([rid]), Number.MAX_SAFE_INTEGER);
    let start = -1;
    for (let i = mine.length - 1; i >= 0; i--) {
      if (mine[i]!.heads.some((h) => h.resourceId === rid && h.revisionId === rc.baseRevision)) {
        start = i;
        break;
      }
    }
    if (start < 0) return false;
    for (const v of mine.slice(start + 1)) {
      if (!(v.kind === "accept" && v.proposalId && (await isPromotionProposal(svc, orgId, projectId, v.proposalId, cache)))) return false;
    }
  }
  return true;
}

// ------------------------------------------------------------------------------ clearances

/** Which gate levels a clearance kind covers (P2-1). */
export function clearanceCovers(kind: ClearanceKind, level: PromotionLevel): boolean {
  if (kind === "developer") return true;
  if (kind === "classifier") return level === "self" || level === "classify";
  return level === "self";
}

/** May `userId` give a developer clearance in this project now? Owner or developer, and in `approvalRoles` (M2). */
async function mayClearAsDeveloper(svc: Services, orgId: string, projectId: string, role: Role | null): Promise<boolean> {
  return (role === "owner" || role === "developer") && (await approvalRoles(svc, orgId, projectId)).includes(role);
}

/** Does an earlier clearance's clearer still qualify (review M3)? A member; for `developer`, {@link mayClearAsDeveloper}; else still reading the project. */
async function clearerStillQualifies(svc: Services, p: PromotionRow, kind: ClearanceKind, clearedBy: string): Promise<boolean> {
  const role = await getRole(svc.db, p.org_id, clearedBy);
  if (!role) return false;
  if (kind === "developer") return mayClearAsDeveloper(svc, p.org_id, p.project_id, role);
  return role === "owner" || role === "developer" || (await canReadProject(svc, { orgId: p.org_id, userId: clearedBy, role }, p.project_id));
}

/**
 * Write a clearance for the promotion's current proposal and move the row to `cleared` (from one
 * of `from`, still on the proposal hash the caller read). Order: the ledger approval first
 * (approver = the clearer, role `clearance:<kind>`, never dated before the proposal's last
 * mutation), then the row. A step that dies in between left an approval that does not count yet
 * (the row is not `cleared`); the next run finds that approval and only moves the row. Returns
 * whether the row moved. A carried clearance keeps its `cleared_at` (the line order, B3). A
 * `classifier` clearance keeps the evidence it was written on (`evidence`, else the carried row's).
 */
async function writeClearance(svc: Services, p: PromotionRow, from: PromotionState[], c: { kind: ClearanceKind; clearedBy: string; key: string; carried?: boolean; evidence?: ClassifierEvidence; patch?: Patch }): Promise<boolean> {
  const ledger = svc.ledger(p.org_id);
  const proposal = p.proposal_id ? await ledger.getProposal(p.proposal_id) : null;
  if (!proposal || proposal.proposalHash !== p.proposal_hash) throw conflict("promotion_changed", "the promotion's proposal changed; reload it");
  const role = `clearance:${c.kind}`;
  const existing = (await ledger.listApprovals(proposal.proposalId)).find((a) => a.role === role && a.approver.id === c.clearedBy && a.proposalHash === proposal.proposalHash && a.approvedAt >= proposal.updatedAt);
  if (!existing) {
    const now = svc.nowIso();
    // a rewritten proposal's updatedAt may be a millisecond ahead of now (promotion-proposal.ts)
    await ledger.putApproval(p.org_id, { approvalId: newId("clr", 10), proposalId: proposal.proposalId, proposalHash: proposal.proposalHash, approver: userRef(c.clearedBy), role, approvedAt: now > proposal.updatedAt ? now : proposal.updatedAt });
  }
  // a carried clearance keeps its time: the promotion keeps its place in the production line (B3)
  const clearedAt = c.carried && p.cleared_at ? p.cleared_at : svc.nowIso();
  const evidence = c.kind !== "classifier" ? null : c.evidence ? JSON.stringify(c.evidence) : c.carried ? p.clearance_evidence_json : null;
  const moved = await setPromotion(svc, p.promotion_id, from, { ...c.patch, state: "cleared", clearance_kind: c.kind, clearance_key: c.key, cleared_by: c.clearedBy, cleared_at: clearedAt, clearance_evidence_json: evidence, reason_code: null, reason: null, detail: null }, p.proposal_hash);
  if (moved) await event(svc, p, "promotion.cleared", c.kind, c.kind === "developer" && !c.carried ? userRef(c.clearedBy) : PROMOTION_SERVICE, { kind: c.kind, clearedBy: c.clearedBy, proposalId: proposal.proposalId, ...(c.carried ? { carried: true } : {}) });
  return moved;
}

/** A stored clearance evidence, or null when absent or not JSON (the gate validates it before trusting it). */
function parseEvidence(json: string | null): ClassifierEvidence | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ClassifierEvidence;
  } catch {
    return null;
  }
}

const keyOf = (p: PromotionRow) => clearanceKey({ proposalHashes: jsonList(p.proposal_hashes_json) });

// ------------------------------------------------------------------------------ approve, send back, withdraw

/**
 * A developer clears a promotion that waits for approval (owner/developer in the project's
 * `approvalRoles`), bound to the proposal hash `p` was read with: a promotion rebuilt meanwhile is
 * refused (`promotion_changed`). Starts the next step (exactly one chain: the chain ended in
 * `pending_approval`). The actor must read every resource the promotion changes, the rule of the
 * developer view (`403 promotion_not_visible`, {@link seesWholePromotion}).
 */
export async function approvePromotion(svc: Services, p: PromotionRow, actor: { userId: string; role: Role }): Promise<PromotionRow> {
  if (!(await mayClearAsDeveloper(svc, p.org_id, p.project_id, actor.role))) throw forbidden("approval_role_not_allowed", "this project does not accept approvals from your role");
  if (!(await seesWholePromotion(svc, p, actor))) throw notVisibleError();
  if (p.state !== "pending_approval") throw conflict("promotion_not_pending", `the promotion is ${p.state}, not waiting for approval`);
  // a person acted: the machine deadline restarts (a rebuild from accepting keeps it)
  if (!(await writeClearance(svc, p, ["pending_approval"], { kind: "developer", clearedBy: actor.userId, key: keyOf(p), patch: { machine_since: svc.nowIso() } }))) throw conflict("promotion_changed", "the promotion changed since you read it; reload it");
  await nudge(svc, p);
  return (await getPromotion(svc, p.promotion_id))!;
}

/**
 * Send a promotion back to staging (owner/developer), before Task 8 starts accepting, bound to the
 * proposal hash `p` was read with: the clearance is void (the row is no longer `cleared`, so its
 * ledger approval no longer counts), the landings are `landed` again (same batch), and the
 * developer's note is the reason the client reads. Like approving, it needs read on every resource
 * the promotion changes (`403 promotion_not_visible`, {@link seesWholePromotion}).
 */
export async function sendBackPromotion(svc: Services, p: PromotionRow, actor: { userId: string; role: Role }, note: string): Promise<PromotionRow> {
  const userId = actor.userId;
  if (!(await seesWholePromotion(svc, p, actor))) throw notVisibleError();
  if (p.state !== "pending_approval" && p.state !== "cleared") throw conflict("promotion_not_pending", `the promotion is ${p.state}; it can no longer be sent back`);
  const moved = await endPromotion(svc, p, ["pending_approval", "cleared"], { state: "sent_back", reason_code: "sent_back", reason: note, detail: null, ...VOID_CLEARANCE }, { action: "promotion.sent_back", code: "sent_back", actor: userRef(userId), extra: { note } }, { hash: p.proposal_hash });
  if (!moved) throw conflict("promotion_changed", "the promotion changed since you read it; reload it");
  return (await getPromotion(svc, p.promotion_id))!;
}

const acceptedError = () => conflict("promotion_accepted", "this promotion was accepted into production; a failed release is retried, not withdrawn");
const notInFlightError = (state: PromotionState) => conflict("promotion_not_in_flight", `the promotion is ${state}; it is no longer in flight`);

/**
 * Withdraw a promotion before it is accepted (B5): its requester, an owner or a developer. From any
 * state before `accepting`, whatever proposal it is on (no hash binding): through
 * {@link endPromotion}, so the landings go back to `landed`, the claims are released, the proposal
 * is closed and the clearance is void in the same way as a send-back. The compare-and-set excludes
 * `accepting` and later, so a withdraw and the step's `cleared → accepting` claim cannot both win;
 * when the accept won, the caller reads `409 promotion_accepted` and nothing was changed. A running
 * integrate job is not cancelled: its receipt lands on a closed proposal nothing reads.
 */
export async function withdrawPromotion(svc: Services, p: PromotionRow, actor: { userId: string; role: Role }): Promise<PromotionRow> {
  if (actor.role !== "owner" && actor.role !== "developer" && p.requested_by !== actor.userId) throw forbidden("not_promotion_requester", "only the client who requested this promotion, an owner or a developer can withdraw it");
  if (ACCEPTED.includes(p.state)) throw acceptedError();
  if (!BEFORE_ACCEPT.includes(p.state)) throw notInFlightError(p.state);
  const moved = await endPromotion(svc, p, BEFORE_ACCEPT, { state: "withdrawn", reason_code: "withdrawn", reason: PROMOTION_REASONS.withdrawn, detail: null, ...VOID_CLEARANCE }, { action: "promotion.withdrawn", code: "withdrawn", actor: userRef(actor.userId) });
  if (!moved) {
    const now = await getPromotion(svc, p.promotion_id);
    if (now && ACCEPTED.includes(now.state)) throw acceptedError();
    if (now && !IN_FLIGHT.includes(now.state)) throw notInFlightError(now.state);
    throw conflict("promotion_changed", "the promotion changed since you read it; reload it");
  }
  return (await getPromotion(svc, p.promotion_id))!;
}

// ------------------------------------------------------------------------------ the step

/** `requested`: build the promotion proposal on `main` and issue its integrate job → `building`. */
async function startBuild(svc: Services, p: PromotionRow, project: ProjectRow): Promise<Next> {
  if (!(await promotionSetIntact(svc, p))) return DONE;
  if (!(await travelWithIntact(svc, p, ["requested"]))) return DONE;
  // B8: every (re)build of an alone promotion checks that alone-first still applies (the owner may
  // have changed the checks since the request); else it widens before anything is accepted
  if (p.mode === "alone" && !aloneFirstApplies(projectPolicy(project), await landingResources(svc, p.org_id, promotionLandingIds(p)), await listMounts(svc.db, p.org_id, p.project_id))) {
    return widenPromotion(svc, p, { code: "policy_changed", text: PROMOTION_REASONS.checksChanged, detail: "the project's required checks no longer cover every resource the task changes" }, "requested");
  }
  const ledger = svc.ledger(p.org_id);
  const parts = [];
  for (const part of await promotionParts(svc, promotionLandingIds(p))) {
    const lp = await ledger.getProposal(part.proposalId);
    if (!lp) {
      await failPromotion(svc, p, ["requested"], { code: "promotion_part_missing", text: PROMOTION_REASONS.build, detail: `landing proposal ${part.proposalId} is missing` });
      return DONE;
    }
    parts.push({ proposalId: part.proposalId, proposalHash: lp.proposalHash });
  }
  let built;
  try {
    built = await buildPromotionProposal(svc, { project, promotionId: p.promotion_id, parts, requestedBy: p.requested_by, supersedes: p.proposal_id });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    await failPromotion(svc, p, ["requested"], { code: e.code, text: PROMOTION_REASONS.build, detail: e.message });
    return DONE;
  }
  const hash = built.record.proposalHash;
  const recorded = await setPromotion(svc, p.promotion_id, ["requested"], {
    proposal_id: built.proposalId,
    proposal_hash: hash,
    proposal_hashes_json: JSON.stringify(parts.map((x) => x.proposalHash)),
    merge_bases_json: JSON.stringify(built.mergeBases),
    policy_revision: built.record.policyRevision,
    // the reissue cap is per proposal hash
    job_attempts: p.proposal_hash === hash ? p.job_attempts : 0,
  });
  if (!recorded) {
    // the promotion ended (or moved to another proposal) meanwhile: the proposal just built is not its proposal
    const now = await getPromotion(svc, p.promotion_id);
    if (!now || !IN_FLIGHT.includes(now.state) || now.proposal_id !== built.proposalId) await supersedePromotionProposal(svc, p.org_id, built.proposalId);
    return wait(1, "the promotion moved on");
  }
  const idx = await getProposalIndex(svc, p.org_id, built.proposalId);
  if (!idx) return wait(3, "promotion proposal not indexed yet");
  let jobId: string;
  try {
    ({ jobId } = await issueIntegration(svc, PROMOTION_SERVICE, built.record, idx, {
      jobKey: `promotion:${p.promotion_id}:${hash}`,
      // the job is linked to the promotion before it can run
      beforeEnqueue: async (id) => void (await svc.db.prepare("UPDATE promotions SET integrate_job_id = ?, updated_at = ? WHERE promotion_id = ? AND state = 'requested'").bind(id, svc.nowIso(), p.promotion_id).run()),
    }));
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    // main moved between the build and the job: the next run builds on the new main
    if (e.code === "expected_head_stale") {
      await rebuildMainMoved(svc, p, ["requested"], built.record);
      return wait(1, "main moved; rebuilding the promotion");
    }
    await failPromotion(svc, p, ["requested"], { code: e.code, text: PROMOTION_REASONS.build, detail: e.message });
    return DONE;
  }
  await setPromotion(svc, p.promotion_id, ["requested"], { state: "building", integrate_job_id: jobId });
  return wait(10, "promotion build running");
}

/** Integrate failures that only need a fresh job (a provider hiccup, a receipt the ledger never recorded). */
const RETRY_CODES = new Set(["provider_unavailable", "receipt_not_recorded"]);

/**
 * `building`: wait for the integration receipt of the proposal **hash** (whoever asked for the job:
 * a developer may integrate a promotion proposal too). A failure ends the promotion, except a stale
 * base (main moved → rebuild) and transient failures or an expired job (a fresh job, capped).
 */
async function watchBuild(svc: Services, p: PromotionRow): Promise<Next> {
  const ledger = svc.ledger(p.org_id);
  const proposal = p.proposal_id ? await ledger.getProposal(p.proposal_id) : null;
  if (!proposal || proposal.proposalHash !== p.proposal_hash || (proposal.state !== "prepared" && proposal.state !== "open")) {
    await rebuildPromotion(svc, p.promotion_id, ["building"]);
    return wait(1, "the promotion proposal changed; rebuilding");
  }
  const integ = await latestIntegration(svc, p.org_id, proposal.proposalId);
  if (integ && integ.receipt.evidence.proposalHash === p.proposal_hash) {
    await setPromotion(svc, p.promotion_id, ["building"], { state: "gating", level: null, gate_json: null, reason_code: null, reason: null, detail: null });
    return wait(1, "promotion built; gating");
  }
  const attempt = await latestIntegrationAttempt(svc, p.org_id, proposal.proposalId, proposal.proposalHash, true);
  let jobKey = `promotion:${p.promotion_id}:${proposal.proposalHash}`;
  if (attempt?.forCurrentHash) {
    if (attempt.state === "queued" && !attempt.expired) return wait(10, "promotion build running");
    if (attempt.state === "applying" || attempt.state === "succeeded") return wait(5, "promotion build result being recorded");
    if (attempt.state === "failed") {
      const code = attempt.code ?? "integrate_failed";
      const detail = attempt.detail ?? code;
      if (code === "stale_base" || code === "expected_head_stale") {
        await rebuildMainMoved(svc, p, ["building"], proposal);
        return wait(1, "main moved; rebuilding the promotion");
      }
      if (code === "textual_conflict") {
        // the paths are for developers (detail); clients read the platform's sentence (review M5)
        const paths = attempt.conflictPaths.slice(0, 50).join(", ");
        const reason = { code, text: PROMOTION_REASONS.conflict, detail: paths ? `conflicting paths: ${paths}\n${detail}` : detail };
        // B8: an alone build that does not merge widens once to the earlier tasks it overlaps
        if (p.mode === "alone") return widenPromotion(svc, p, reason);
        await failPromotion(svc, p, ["building"], reason);
        return DONE;
      }
      if (code === "check_failed" || code === "contract_failed") {
        const reason = { code, text: PROMOTION_REASONS.check, detail };
        if (p.mode === "alone") return widenPromotion(svc, p, reason);
        await failPromotion(svc, p, ["building"], reason);
        return DONE;
      }
      if (!RETRY_CODES.has(code)) {
        await failPromotion(svc, p, ["building"], { code, text: PROMOTION_REASONS.build, detail });
        return DONE;
      }
      // a job that answered (or D1 marked succeeded) is never reused for the retry
      jobKey = `${jobKey}:retry-${attempt.jobId ?? "x"}`;
    }
  }
  // no job for this hash, an expired one, or a transient failure: (re)issue, at most MAX_JOB_ATTEMPTS times
  if (p.job_attempts >= MAX_JOB_ATTEMPTS) {
    await failPromotion(svc, p, ["building"], { code: "promotion_job_limit", text: PROMOTION_REASONS.build, detail: `the promotion build was retried ${p.job_attempts} times (last: ${attempt?.code ?? (attempt?.expired ? "expired" : "no job")})` });
    return DONE;
  }
  const idx = await getProposalIndex(svc, p.org_id, proposal.proposalId);
  if (!idx) return wait(3, "promotion proposal not indexed yet");
  try {
    const { jobId, reused } = await issueIntegration(svc, PROMOTION_SERVICE, proposal, idx, { jobKey, beforeEnqueue: async (id) => void (await svc.db.prepare("UPDATE promotions SET integrate_job_id = ?, updated_at = ? WHERE promotion_id = ? AND state = 'building'").bind(id, svc.nowIso(), p.promotion_id).run()) });
    await svc.db.prepare(`UPDATE promotions SET integrate_job_id = ?, job_attempts = job_attempts + ? WHERE promotion_id = ? AND state = 'building'`).bind(jobId, reused ? 0 : 1, p.promotion_id).run();
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.code === "expected_head_stale") {
      await rebuildMainMoved(svc, p, ["building"], proposal);
      return wait(1, "main moved; rebuilding the promotion");
    }
    await failPromotion(svc, p, ["building"], { code: e.code, text: PROMOTION_REASONS.build, detail: e.message });
    return DONE;
  }
  return wait(10, "promotion build running");
}

/**
 * B8: an alone build failed (`failure`: a textual conflict, a failed required check or contract).
 * The promotion widens **once** to the closure recomputed now (mode `closure`; a closure promotion
 * never widens): the extra landings are claimed and move to `promoting` in one batch with the row
 * (back to `requested`, the clearance void: the set and so its key change, and the gate decides
 * again on the widened build). The alone attempt's proposal is closed first, so the widened build
 * gets a proposal of its own. The client reads `needs` and "Needs '<title>'; promoting them
 * together."; the alone failure stays in `detail` for developers. Not a rebuild because `main`
 * moved (no cap counted); the machine deadline keeps running.
 *
 * Also from `requested` (`from`), when alone-first no longer applies at a (re)build
 * (`policy_changed`): then a closure that adds nothing only switches the mode.
 *
 * Fails as today (`failure`) when the closure adds nothing (the alone set is the closure now) or
 * cannot be promoted (a travel-with link of the closure to a landing that left staging), and with
 * `promotion_dependency_busy` naming the tasks when a landing it needs is not `landed` (not live on
 * staging yet, or claimed by another promotion, which is nudged) — never promoted without it.
 */
async function widenPromotion(svc: Services, p: PromotionRow, failure: Reason, from: "building" | "requested" = "building"): Promise<Next> {
  const fail = async (r: Reason): Promise<Next> => {
    await failPromotion(svc, p, [from], r);
    return DONE;
  };
  if (!(await promotionSetIntact(svc, p, [from]))) return DONE;
  let sets;
  try {
    sets = await promotionSets(svc, p.org_id, p.project_id, p.target_landing_id);
    assertLinksInStaging(sets, sets.closure);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return fail({ ...failure, detail: `${failure.detail ?? failure.code}\nnot widened: ${e.code}: ${e.message}` });
  }
  const current = promotionLandingIds(p);
  const extra = sets.closure.filter((id) => !current.includes(id));
  if (extra.length === 0) {
    if (from === "building") return fail(failure);
    // nothing left to go without: a closure promotion now
    await setPromotion(svc, p.promotion_id, ["requested"], { mode: "closure", going_without_json: "[]" });
    return wait(1, "alone-first no longer applies; the set is the closure");
  }
  const named = (id: string): NamedLanding => ({ landingId: id, ...(sets.titles.get(id) ?? { taskId: "", title: "" }) });
  const aloneFailure = `${from === "building" ? "alone build failed" : "alone-first no longer applies"} (${failure.code}): ${failure.detail ?? failure.code}`;
  /**
   * a landing it needs is not `landed` (read now): the promotion fails, naming them — the ones not
   * live on staging yet first, else the ones another promotion holds (nudged)
   */
  const busy = async (): Promise<Next> => {
    const rows = (await svc.db.prepare(`SELECT landing_id, state FROM staging_landings WHERE landing_id IN (${placeholders(extra.length)})`).bind(...extra).all<{ landing_id: string; state: string }>()).results;
    const held: string[] = [];
    const notReady: string[] = [];
    const notes: string[] = [];
    for (const id of extra) {
      const state = rows.find((r) => r.landing_id === id)?.state ?? "missing";
      const holder = await holderOf(svc, id);
      if (holder && holder !== p.promotion_id) {
        held.push(id);
        notes.push(`${id} held by ${holder}`);
        await nudge(svc, { org_id: p.org_id, promotion_id: holder });
      } else if (state !== "landed") {
        notReady.push(id);
        notes.push(`${id} ${state}`);
      }
    }
    const text = notReady.length || !held.length ? needsNotReadyText((notReady.length ? notReady : extra).map((id) => named(id).title)) : needsBeingPromotedText(held.map((id) => named(id).title));
    return fail({ code: "promotion_dependency_busy", text, detail: `${aloneFailure}; busy: ${notes.join(", ") || "a landing it needs was claimed meanwhile"}` });
  };
  if (sets.open.some((l) => extra.includes(l.landing_id) && l.state !== "landed")) return busy();

  const seqOf = new Map(sets.open.map((l) => [l.landing_id, l.seq]));
  const landings = [...new Set([...current, ...sets.closure])].sort((a, b) => (seqOf.get(a) ?? 0) - (seqOf.get(b) ?? 0));
  const needs = extra.map(named);
  // the alone attempt's proposal is closed: the widened build is a new proposal
  if (p.proposal_id) await supersedePromotionProposal(svc, p.org_id, p.proposal_id);
  const now = svc.nowIso();
  const widened = "EXISTS (SELECT 1 FROM promotions WHERE promotion_id = ? AND state = 'requested' AND mode = 'closure' AND updated_at = ?)";
  let moved: boolean;
  try {
    const [upd] = await svc.db.batch([
      svc.db
        .prepare(
          `UPDATE promotions SET state = 'requested', mode = 'closure', landings_json = ?, needs_json = ?, going_without_json = '[]', level = NULL, gate_json = NULL, reason_code = 'needs_dependencies', reason = ?, detail = ?, clearance_kind = NULL, clearance_key = NULL, cleared_by = NULL, cleared_at = NULL, clearance_evidence_json = NULL, job_attempts = 0, updated_at = ? WHERE promotion_id = ? AND state = ? AND mode = 'alone' AND proposal_hash IS ? AND (SELECT COUNT(*) FROM staging_landings WHERE landing_id IN (${placeholders(extra.length)}) AND state = 'landed') = ?`,
        )
        .bind(JSON.stringify(landings), JSON.stringify(needs), needsText(needs.map((n) => n.title)), aloneFailure.slice(0, 4000), now, p.promotion_id, from, p.proposal_hash, ...extra, extra.length),
      svc.db.prepare(`INSERT INTO promotion_landings (promotion_id, landing_id, org_id, project_id, active, created_at) SELECT ?, value, ?, ?, 1, ? FROM json_each(?) WHERE ${widened}`).bind(p.promotion_id, p.org_id, p.project_id, now, JSON.stringify(extra), p.promotion_id, now),
      svc.db.prepare(`UPDATE staging_landings SET state = 'promoting', reason_code = NULL, reason = NULL, detail = NULL, updated_at = ? WHERE landing_id IN (${placeholders(extra.length)}) AND state = 'landed' AND ${widened}`).bind(now, ...extra, p.promotion_id, now),
    ]);
    moved = (upd!.meta.changes ?? 0) > 0;
  } catch (e) {
    // a landing it needs was claimed concurrently (promotion_landings_one_active)
    if (!/UNIQUE/i.test(String((e as Error)?.message))) throw e;
    moved = false;
  }
  if (!moved) {
    const after = await getPromotion(svc, p.promotion_id);
    if (!after || after.state !== from || after.mode !== "alone" || after.proposal_hash !== p.proposal_hash) return wait(1, "the promotion moved on");
    return busy();
  }
  await event(svc, p, "promotion.widened", "needs_dependencies", PROMOTION_SERVICE, { needs: needs.map((n) => n.taskId), landings, failure: failure.code });
  for (const l of sets.open) if (extra.includes(l.landing_id)) await recordLandingEvent(svc, l, "promoting");
  return wait(1, "widened to the earlier tasks it needs");
}

/**
 * `gating`: the gate on the integration result. A clearance from an earlier build carries over
 * (P2-1, M3); else `self` clears by itself (by the requester), a `classify` level the risk
 * classifier cleared clears as `classifier` (by the requester, P3-4), an owner's request clears as
 * `developer` (when owners are approvers, M2), and everything else waits for a developer (the
 * chain ends). A `gate_error` (a read failed) is gated once more before anyone is asked; the
 * classifier is asked at most once per gating (its failures are `classifier_unavailable`), and not
 * at all when a carried clearance already covers a `classify` level.
 */
async function gate(svc: Services, p: PromotionRow, project: ProjectRow, policy: { staging: StagingPolicy; release: ReleasePolicy }): Promise<Next> {
  // the proposal was built on another policy (a missed nudge): rebuild before anyone is asked
  if (p.policy_revision !== project.policy_revision) {
    await rebuildPromotion(svc, p.promotion_id, ["gating"]);
    return wait(1, "the policy changed; rebuilding the promotion");
  }
  if (!(await promotionSetIntact(svc, p))) return DONE;
  const ledger = svc.ledger(p.org_id);
  const proposal = p.proposal_id ? await ledger.getProposal(p.proposal_id) : null;
  const integ = proposal ? await latestIntegration(svc, p.org_id, proposal.proposalId) : null;
  if (!proposal || !integ || integ.receipt.evidence.proposalHash !== p.proposal_hash) {
    await setPromotion(svc, p.promotion_id, ["gating"], { state: "building" });
    return wait(1, "promotion result not recorded; back to building");
  }
  const candidates: FrozenCandidate[] = [];
  for (const rc of proposal.resourceChanges) {
    const rec = await ledger.getCandidate(rc.candidateId);
    if (!rec) {
      await failPromotion(svc, p, ["gating"], { code: "candidate_missing", text: PROMOTION_REASONS.build, detail: `candidate ${rc.candidateId} is missing` });
      return DONE;
    }
    candidates.push(rec.candidate);
  }
  const resourceByMount = new Map((await listMounts(svc.db, p.org_id, p.project_id)).map((m) => [m.mount_name, m.resource_id]));
  const heads = new Map<string, string>();
  const results = new Map<string, string>();
  for (const r of integ.receipt.results) {
    const head = revisionCommitSha(r.expectedHead);
    const result = revisionCommitSha(r.revisionId);
    if (head) heads.set(r.resourceId, head);
    if (result) results.set(r.resourceId, result);
  }
  const key = keyOf(p);
  const carryable = !!(p.clearance_kind && p.cleared_by && p.clearance_key === key && (await clearerStillQualifies(svc, p, p.clearance_kind, p.cleared_by)));
  const { provider, threshold } = policy.staging.promotion.classifier;
  const evidence = integ.receipt.evidence;
  const classify = async (perPath: Array<{ path: string; level: PromotionLevel }>): Promise<ClassifierEvidence> => {
    if (provider === "none") return notConfiguredEvidence(threshold);
    const input = await buildRiskInput(svc, { project, staging: policy.staging, release: policy.release, landingIds: promotionLandingIds(p), candidates, perPath, resourceByMount, heads, results, evidence });
    const s = riskState(input.parts);
    // P3-11: an input that is not the complete change is never sent (input_incomplete)
    return runClassifier(svc.deps.classifier(svc.env, provider), { ...s, truncated: s.truncated || input.notRead > 0, omittedFiles: s.omittedFiles + input.notRead, incomplete: [...s.incomplete, ...input.incomplete] }, threshold);
  };
  // a carried clearance that covers classify: developer as is; classifier with the evidence it was written on (re-checked by the gate)
  const carried = !carryable || !clearanceCovers(p.clearance_kind!, "classify") ? undefined : p.clearance_kind === "developer" ? ({ kind: "developer" } as const) : { kind: "classifier" as const, evidence: parseEvidence(p.clearance_evidence_json) };
  const g = await gatePromotion(svc, {
    project,
    staging: policy.staging,
    release: policy.release,
    candidates,
    resourceByMount,
    heads,
    results,
    classify: ({ perPath }) => classify(perPath),
    carried,
  });
  const gateJson = JSON.stringify({ pathLevel: g.pathLevel, perPath: g.perPath, veto: g.veto, classifier: g.classifier, reasonCode: g.reasonCode });
  if (g.reasonCode === "gate_error" && p.reason_code !== "gate_error") {
    // a transient read error: gate once more before asking a developer (the marker resets on every build)
    await setPromotion(svc, p.promotion_id, ["gating"], { level: g.level, gate_json: gateJson, reason_code: "gate_error" });
    return wait(15, "the promotion gate could not read the change; gating again");
  }
  const gated: Patch = { level: g.level, gate_json: gateJson };
  // evidence the classifier just gave (asked again) replaces the carried clearance's
  const fresh = g.classifier.asked && g.classifier.cleared ? g.classifier.evidence : undefined;
  if (carryable && clearanceCovers(p.clearance_kind!, g.level)) {
    await writeClearance(svc, p, ["gating"], { kind: p.clearance_kind!, clearedBy: p.cleared_by!, key, carried: true, evidence: fresh, patch: gated });
    return wait(1, "clearance carried over");
  }
  if (g.level === "self") {
    await writeClearance(svc, p, ["gating"], { kind: "self", clearedBy: p.requested_by, key, patch: gated });
    return wait(1, "cleared");
  }
  if (g.level === "classify" && g.classifier.cleared) {
    await writeClearance(svc, p, ["gating"], { kind: "classifier", clearedBy: p.requested_by, key, evidence: g.classifier.evidence, patch: gated });
    return wait(1, "cleared by the risk classifier");
  }
  if ((await getRole(svc.db, p.org_id, p.requested_by)) === "owner" && (await mayClearAsDeveloper(svc, p.org_id, p.project_id, "owner"))) {
    await writeClearance(svc, p, ["gating"], { kind: "developer", clearedBy: p.requested_by, key, patch: gated });
    return wait(1, "cleared");
  }
  // an earlier clearance that does not cover this set any more is void
  const code = g.reasonCode === "self" ? "developer_paths" : g.reasonCode === "classifier" || g.reasonCode === "carried" ? "classifier_unavailable" : g.reasonCode;
  // developers read why the classifier could not answer (P3-6, P3-11): its error code and reasons
  const ev = g.classifier.evidence;
  const detail = ev?.error ? `classifier: ${ev.error}${ev.incomplete?.length ? ` (${ev.incomplete.join(", ")})` : ""}` : null;
  const moved = await setPromotion(svc, p.promotion_id, ["gating"], { ...gated, state: "pending_approval", reason_code: code, reason: gateReasonText(code, g.classifier), detail, ...VOID_CLEARANCE });
  if (moved) await event(svc, p, "promotion.pending_approval", code, PROMOTION_SERVICE, { level: g.level, proposalId: proposal.proposalId });
  // the chain ends: approve, send back and a policy change start the next step
  return DONE;
}

// ------------------------------------------------------------------------------ accept (Task 8)

/**
 * `cleared`: take production (B2, B3), then the accept. In order: the set guard; a promotion earlier
 * in the production line (clearance order) → wait (the chain ends, `production_busy`); the proposal
 * built on an older `main` → rebuild ({@link rebuildMainMoved}: not counted when only promotions
 * moved it; the clearance carries by key), even while another promotion releases, so the first in
 * line is ready when production frees; a promotion holding production → wait (whoever frees
 * production, or moves `main` by entering `releasing`, nudges the first in line); else the claim —
 * `cleared → accepting` bound to the proposal hash, refused by the index
 * `promotions_production_claim` while another promotion of the project holds production — and the
 * accept.
 */
async function startAccept(svc: Services, p: PromotionRow): Promise<Next> {
  if (!(await promotionSetIntact(svc, p))) return DONE;
  if (!(await travelWithIntact(svc, p, ["cleared"]))) return DONE;
  const ahead = p.cleared_at
    ? await svc.db
        .prepare(`SELECT 1 AS x FROM promotions WHERE org_id = ? AND project_id = ? AND promotion_id != ? AND ${IN_LINE} AND (cleared_at < ? OR (cleared_at = ? AND promotion_id < ?)) LIMIT 1`)
        .bind(p.org_id, p.project_id, p.promotion_id, p.cleared_at, p.cleared_at, p.promotion_id)
        .first<{ x: number }>()
    : null;
  if (ahead) return waitForProduction(svc, p);
  // first in line: rebuild on a moved `main` now, even while another promotion releases (its accept
  // already moved `main`), so production does not sit idle through this rebuild once it is free
  const proposal = p.proposal_id ? await svc.ledger(p.org_id).getProposal(p.proposal_id) : null;
  if (await builtOnOlderMain(svc, p.org_id, proposal)) {
    await rebuildMainMoved(svc, p, ["cleared"], proposal);
    return wait(1, "main moved while waiting; rebuilding");
  }
  if (await productionHolder(svc, p.org_id, p.project_id)) return waitForProduction(svc, p);
  let claimed: boolean;
  try {
    claimed = await setPromotion(svc, p.promotion_id, ["cleared"], { state: "accepting", claimed_at: svc.nowIso(), reason_code: null, reason: null }, p.proposal_hash);
  } catch (e) {
    if (!/UNIQUE/i.test(String((e as Error)?.message))) throw e;
    return waitForProduction(svc, p);
  }
  if (!claimed) return wait(1, "the promotion moved on");
  return acceptPromotion(svc, (await getPromotion(svc, p.promotion_id))!);
}

/** A `cleared` promotion waits for production (B3): `production_busy`, and the chain ends. */
async function waitForProduction(svc: Services, p: PromotionRow): Promise<Next> {
  if (p.reason_code !== "production_busy") await setPromotion(svc, p.promotion_id, ["cleared"], { reason_code: "production_busy", reason: PROMOTION_REASONS.productionBusy }, p.proposal_hash);
  return DONE;
}

/**
 * The accepted version the ledger recorded for a proposal (null when none): the version that set a
 * changed resource's current head when nothing moved it since (one lookup), else a scan.
 */
async function acceptedVersionOf(svc: Services, orgId: string, proposal: ProposalRecord): Promise<string | null> {
  const ledger = svc.ledger(orgId);
  const proposalId = proposal.proposalId;
  for (const rid of new Set(proposal.resourceChanges.map((c) => c.resourceId as string))) {
    const head = await ledger.getHead(rid);
    const v = head?.acceptedVersionId ? await ledger.getAcceptedVersion(head.acceptedVersionId) : null;
    if (v?.proposalId === proposalId) return v.acceptedVersionId;
  }
  let found: string | null = null;
  for (let after = 0; ; ) {
    const page = await ledger.listAcceptedVersions({ after, limit: 500 });
    for (const v of page) if (v.proposalId === proposalId) found = v.acceptedVersionId;
    if (page.length < 500) break;
    after = page[page.length - 1]!.sequence;
  }
  return found;
}

/**
 * `accepting`: the ledger accept of the promotion proposal with its clearance (approver = the
 * clearer, actor = the clearer). Idempotent across retries: a proposal the ledger already accepted
 * (the step died after the commit) continues from its accepted version. Refusals: `main` moved
 * (`expected_head_stale`, `dependency_stale`) → rebuild (counted; the clearance carries by key);
 * `policy_revision_stale` → rebuild (the gate decides whether the clearance still covers the set);
 * anything else → `failed`.
 */
async function acceptPromotion(svc: Services, p: PromotionRow): Promise<Next> {
  const ledger = svc.ledger(p.org_id);
  const proposal = p.proposal_id ? await ledger.getProposal(p.proposal_id) : null;
  if (!proposal || proposal.proposalHash !== p.proposal_hash) {
    await failPromotion(svc, p, ["accepting"], { code: "promotion_changed", text: PROMOTION_REASONS.accept, detail: `the promotion proposal ${p.proposal_id ?? "(none)"} is missing or has another hash` });
    return DONE;
  }
  // from taking production (a cleared promotion may have waited for it long before)
  const late = svc.now().getTime() - Date.parse(p.claimed_at ?? p.cleared_at ?? p.updated_at) > ACCEPT_DEADLINE_MS;
  if (proposal.state === "accepted") {
    const version = await acceptedVersionOf(svc, p.org_id, proposal);
    if (version) return finishAccept(svc, p, proposal, version);
    // the ledger says accepted but lists no version for it (never expected): bounded like the accept
    if (!late) return wait(5, "the accepted version is not listed yet");
    // main has the change (the proposal is accepted): the landings are promoted, and the release is
    // left to a retry (it prepares the latest version under the clearance rules); review M1
    await acceptedWithoutVersion(svc, p, proposal);
    return DONE;
  }
  if (late) {
    await failPromotion(svc, p, ["accepting"], { code: "promotion_timed_out", text: PROMOTION_REASONS.stopped, detail: `not accepted ${ACCEPT_DEADLINE_MS / 60_000} min after it took production` });
    return DONE;
  }
  if (proposal.state === "open") {
    // new content since it was cleared (never expected): build it again
    await rebuildPromotion(svc, p.promotion_id, ["accepting"], { stale: true });
    return wait(1, "the promotion proposal changed; rebuilding");
  }
  if (proposal.state !== "prepared") {
    await failPromotion(svc, p, ["accepting"], { code: "promotion_proposal_closed", text: PROMOTION_REASONS.accept, detail: `the promotion proposal is ${proposal.state}` });
    return DONE;
  }
  // nothing is accepted yet: a landing that left staging still ends the promotion
  if (!(await promotionSetIntact(svc, p, ["accepting"]))) return DONE;
  const clearedBy = p.cleared_by ?? p.requested_by;
  let decision;
  try {
    decision = await ledger.accept(await acceptInputFor(svc, proposal, `${p.org_id}:promotion:${p.promotion_id}:${proposal.proposalId}`, userRef(clearedBy)));
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.code === "integration_required") {
      await rebuildPromotion(svc, p.promotion_id, ["accepting"], { stale: true });
      return wait(1, "the promotion build is missing; rebuilding");
    }
    await failPromotion(svc, p, ["accepting"], { code: e.code, text: PROMOTION_REASONS.accept, detail: e.message });
    return DONE;
  }
  if (!decision.ok) {
    if (decision.code === "expected_head_stale" || decision.code === "dependency_stale") {
      await rebuildMainMoved(svc, p, ["accepting"], proposal);
      return wait(1, "main moved; rebuilding the promotion");
    }
    if (decision.code === "policy_revision_stale") {
      await rebuildPromotion(svc, p.promotion_id, ["accepting"], { stale: true });
      return wait(1, "the policy changed; rebuilding the promotion");
    }
    // a concurrent accept of the same proposal (never expected): the next run reads the ledger
    if (decision.code === "proposal_not_prepared" && (await ledger.getProposal(proposal.proposalId))?.state === "accepted") return wait(1, "the proposal was accepted");
    await failPromotion(svc, p, ["accepting"], { code: decision.code, text: PROMOTION_REASONS.accept, detail: decision.detail ?? decision.code });
    return DONE;
  }
  return finishAccept(svc, p, proposal, decision.acceptedVersionId);
}

/**
 * The accept committed (here, or in a step that died after it): the ledger bookkeeping first
 * (idempotent: candidates `accepted`, the landings' proposals `superseded`, the `proposal.accepted`
 * event once), then one batch — the row `releasing` with the accepted version, the landings
 * `promoted` (R10) — then staging is rebuilt without them.
 */
async function finishAccept(svc: Services, p: PromotionRow, proposal: ProposalRecord, acceptedVersionId: string): Promise<Next> {
  const ledger = svc.ledger(p.org_id);
  for (const rc of proposal.resourceChanges) {
    const rec = await ledger.getCandidate(rc.candidateId);
    if (rec && rec.state === "prepared") await ledger.putCandidate(p.org_id, { ...rec, state: "accepted", updatedAt: svc.nowIso() });
  }
  const ids = promotionLandingIds(p);
  const landings = ids.length ? (await svc.db.prepare(`SELECT * FROM staging_landings WHERE landing_id IN (${placeholders(ids.length)})`).bind(...ids).all<LandingRow>()).results : [];
  for (const l of landings) await closeLandingProposals(svc, l, "superseded");
  // before the row moves on: a step that dies here repeats it (and `releasing` repeats it again)
  await promoteLandedWork(svc, p, proposal, acceptedVersionId);
  if (!(await eventRecorded(svc, p.org_id, "proposal.accepted", proposal.proposalId))) {
    await recordEvent(svc, { orgId: p.org_id, projectId: p.project_id, actor: releaseActor(p).principal, action: "proposal.accepted", subjectKind: "proposal", subjectId: proposal.proposalId, resourceIds: proposalResourceIds(proposal), detail: { acceptedVersionId, proposalHash: proposal.proposalHash, promotionId: p.promotion_id }, clientVisible: true, clientDetail: { promotionId: p.promotion_id } });
  }
  const now = svc.nowIso();
  const stmts = [updateSql(svc, p.promotion_id, ["accepting"], { state: "releasing", accepted_version_id: acceptedVersionId, release_id: null, machine_since: now, reason_code: null, reason: null, detail: null }, now)];
  if (ids.length) {
    const ours = `EXISTS (SELECT 1 FROM promotions WHERE promotion_id = ? AND state = 'releasing' AND accepted_version_id = ?)`;
    stmts.push(
      svc.db.prepare(`UPDATE staging_landings SET state = 'promoted', reason_code = NULL, reason = NULL, detail = NULL, updated_at = ? WHERE landing_id IN (${placeholders(ids.length)}) AND state = 'promoting' AND ${ours}`).bind(now, ...ids, p.promotion_id, acceptedVersionId),
      // staging dropped it after the set guard, but its change is in main now (review M5)
      svc.db
        .prepare(`UPDATE staging_landings SET state = 'promoted', reason_code = 'promoted_after_staging_failure', reason = ?, updated_at = ? WHERE landing_id IN (${placeholders(ids.length)}) AND state = 'failed' AND ${ours}`)
        .bind(LANDING_PROMOTED_AFTER_FAILURE, now, ...ids, p.promotion_id, acceptedVersionId),
    );
  }
  // the landings are in `main`: their claims end with the accept (B1)
  stmts.push(svc.db.prepare(`UPDATE promotion_landings SET active = 0 WHERE promotion_id = ? AND active = 1 AND EXISTS (SELECT 1 FROM promotions WHERE promotion_id = ? AND state = 'releasing' AND accepted_version_id = ?)`).bind(p.promotion_id, p.promotion_id, acceptedVersionId));
  const [upd] = await svc.db.batch(stmts);
  if ((upd!.meta.changes ?? 0) === 0) return wait(1, "the promotion moved on");
  // the landings this batch moved (review M4)
  const moved = ids.length ? (await svc.db.prepare(`SELECT * FROM staging_landings WHERE landing_id IN (${placeholders(ids.length)}) AND state = 'promoted' AND updated_at = ?`).bind(...ids, now).all<LandingRow>()).results : [];
  for (const l of moved) await recordLandingEvent(svc, l, "promoted", l.reason_code ? { code: l.reason_code, text: l.reason ?? LANDING_PROMOTED_AFTER_FAILURE } : undefined);
  await recordAccepted(svc, (await getPromotion(svc, p.promotion_id))!);
  await dropPromotedFromStaging(svc, p);
  return wait(1, "accepted; releasing production");
}

/** The ledger accepted the proposal but names no accepted version for it, past the deadline: `release_failed` (developers read `detail`). */
async function acceptedWithoutVersion(svc: Services, p: PromotionRow, proposal: ProposalRecord): Promise<void> {
  const ids = promotionLandingIds(p);
  const landings = ids.length ? (await svc.db.prepare(`SELECT * FROM staging_landings WHERE landing_id IN (${placeholders(ids.length)})`).bind(...ids).all<LandingRow>()).results : [];
  for (const l of landings) await closeLandingProposals(svc, l, "superseded");
  await promoteLandedWork(svc, p, proposal, null);
  const now = svc.nowIso();
  const detail = `proposal ${proposal.proposalId} is accepted, but no accepted version names it (accepted_version_missing); retry the release`;
  const stmts = [updateSql(svc, p.promotion_id, ["accepting"], { state: "release_failed", accepted_version_id: null, release_id: null, reason_code: "accepted_version_missing", reason: PROMOTION_REASONS.releaseFailed, detail }, now)];
  if (ids.length) stmts.push(svc.db.prepare(`UPDATE staging_landings SET state = 'promoted', reason_code = NULL, reason = NULL, detail = NULL, updated_at = ? WHERE landing_id IN (${placeholders(ids.length)}) AND state IN ('promoting', 'failed') AND EXISTS (SELECT 1 FROM promotions WHERE promotion_id = ? AND state = 'release_failed' AND updated_at = ?)`).bind(now, ...ids, p.promotion_id, now));
  stmts.push(svc.db.prepare(`UPDATE promotion_landings SET active = 0 WHERE promotion_id = ? AND active = 1 AND EXISTS (SELECT 1 FROM promotions WHERE promotion_id = ? AND state = 'release_failed' AND updated_at = ?)`).bind(p.promotion_id, p.promotion_id, now));
  const [upd] = await svc.db.batch(stmts);
  if ((upd!.meta.changes ?? 0) === 0) return;
  for (const l of landings) if (l.state === "promoting" || l.state === "failed") await recordLandingEvent(svc, l, "promoted");
  await event(svc, p, "promotion.release_failed", "accepted_version_missing", PROMOTION_SERVICE, { channel: "production", reason: PROMOTION_REASONS.releaseFailed, detail });
  await dropPromotedFromStaging(svc, p);
}

/**
 * What `main` gained with the accept, outside the ledger (the task-proposal accept does the same in
 * `afterProposalAccepted`): for every part of every landing in the promotion,
 * - the part's task promotes its verified LFS objects (`promoteTask`, also the ones the hash step
 *   verifies later) in the resources both its landing proposal and the promotion proposal change
 *   (the promotion proposal's alone when the landing proposal is missing);
 * - a file change staged through that task is `added`, with the LFS objects its receipt named
 *   ({@link landPromotedFileChange}).
 * Idempotent: run from the accept tail before the row moves on, again when the release starts (a
 * step that died after the accept), and a staged change's read or GC sweep repairs its own part.
 */
async function promoteLandedWork(svc: Services, p: PromotionRow, proposal: Pick<ProposalRecord, "resourceChanges">, acceptedVersionId: string | null): Promise<void> {
  const ledger = svc.ledger(p.org_id);
  const changed = new Set(proposal.resourceChanges.map((c) => c.resourceId as string));
  const ids = promotionLandingIds(p);
  const landings = ids.length ? (await svc.db.prepare(`SELECT * FROM staging_landings WHERE landing_id IN (${placeholders(ids.length)})`).bind(...ids).all<LandingRow>()).results : [];
  for (const l of landings) {
    for (const part of await landingParts(svc, l)) {
      const lp = await ledger.getProposal(part.proposalId);
      const resources = lp ? [...new Set(lp.resourceChanges.map((c) => c.resourceId as string))].filter((r) => changed.has(r)) : [...changed];
      if (resources.length) await promoteTask(svc, p.org_id, part.taskId, resources);
      await landPromotedFileChange(svc, { orgId: p.org_id, taskId: part.taskId, promotionId: p.promotion_id, acceptedVersionId });
    }
  }
}

const LANDING_PROMOTED_AFTER_FAILURE = "This task reached production with its promotion, although staging had dropped it meanwhile.";

/** `promotion.accepted`, once per promotion (after the accept, and again from `releasing` if a step died before it). */
async function recordAccepted(svc: Services, p: PromotionRow): Promise<void> {
  if (await eventRecorded(svc, p.org_id, "promotion.accepted", p.promotion_id)) return;
  await event(svc, p, "promotion.accepted", "accepted", PROMOTION_SERVICE, { acceptedVersionId: p.accepted_version_id, proposalId: p.proposal_id, clearedBy: p.cleared_by });
}

async function eventRecorded(svc: Services, orgId: string, action: string, subjectId: string): Promise<boolean> {
  return !!(await svc.db.prepare("SELECT 1 AS x FROM events WHERE org_id = ? AND action = ? AND subject_id = ? LIMIT 1").bind(orgId, action, subjectId).first<{ x: number }>());
}

/**
 * Staging drops the promoted landings: when the project's newest staging build (queued, running or
 * live) still lists one of them, a new build is requested (it lists only landings in staging, on
 * the new `main`). Idempotent: called after the accept and again when releasing starts (a step
 * that died in between).
 */
async function dropPromotedFromStaging(svc: Services, p: PromotionRow): Promise<void> {
  const ids = promotionLandingIds(p);
  const newest = await svc.db
    .prepare("SELECT landings_json FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'merging', 'building', 'deploying', 'live') ORDER BY seq DESC LIMIT 1")
    .bind(p.org_id, p.project_id)
    .first<{ landings_json: string }>();
  if (!newest || !jsonList(newest.landings_json).some((id) => ids.includes(id))) return;
  const project = await getProject(svc.db, p.org_id, p.project_id);
  if (!project || !stagingPolicyOf(project)) return;
  await requestBuild(svc, p.org_id, p.project_id, p.requested_by);
}

// ------------------------------------------------------------------------------ release (Task 8)

/**
 * Who runs the production release: the promotion service, on behalf of the user who cleared the
 * promotion. The release functions check no roles (the release routes do, and a client can call
 * none of them); the clearer's session is never used or elevated. Events name the service with
 * `onBehalfOf`; the release's `created_by` is the clearer.
 */
export function releaseActor(p: Pick<PromotionRow, "org_id" | "cleared_by" | "requested_by">): ReleaseActor & { principal: PrincipalRef } {
  const userId = p.cleared_by ?? p.requested_by;
  return { orgId: p.org_id, userId, principal: { kind: "service", id: "promotion-service", onBehalfOf: { kind: "user", id: userId } } as PrincipalRef };
}

/** Prepare the release: the accepted version first; a later accept (which contains it) → the latest. */
async function prepareFor(svc: Services, p: PromotionRow): Promise<ReleaseRow> {
  const actor = releaseActor(p);
  try {
    return (await prepareRelease(svc, actor, p.project_id, { acceptedVersionId: p.accepted_version_id ?? undefined })).release;
  } catch (e) {
    if (e instanceof ApiError && e.code === "accepted_version_stale") return (await prepareRelease(svc, actor, p.project_id, {})).release;
    throw e;
  }
}

/** The release did not go live: `release_failed` with the platform's text (main keeps the change, R10). */
async function releaseFailed(svc: Services, p: PromotionRow, code: string, detail: string | null): Promise<boolean> {
  const text = code === "release_needs_publish_approval" ? PROMOTION_REASONS.needsPublishApproval : code === "migration_state_unknown" ? PROMOTION_REASONS.migrationUnknown : code.startsWith("migration_") || code === "production_migration_changed" ? PROMOTION_REASONS.migrationFailed : PROMOTION_REASONS.releaseFailed;
  const moved = await setPromotion(svc, p.promotion_id, ["releasing"], { state: "release_failed", reason_code: code, reason: text, detail: detail?.slice(0, 4000) ?? null });
  if (moved) await event(svc, p, "promotion.release_failed", code, PROMOTION_SERVICE, { channel: "production", releaseId: p.release_id, reason: text, ...(detail ? { detail: detail.slice(0, 2000) } : {}) });
  return moved;
}

/** Production is live with a release that contains this promotion's accepted version: the promotion is `live`. */
async function markLive(svc: Services, p: PromotionRow, rel: ReleaseRow, from: PromotionState[] = ["releasing"]): Promise<Next> {
  if (!(await setPromotion(svc, p.promotion_id, from, { state: "live", release_id: rel.release_id, reason_code: null, reason: null, detail: null }))) return DONE;
  await event(svc, p, "promotion.live", "live", PROMOTION_SERVICE, { channel: "production", releaseId: rel.release_id, acceptedVersionId: rel.accepted_version_id });
  return DONE;
}

/** Every accepted version of the org (in sequence order) whose heads touch one of `resources`, up to `maxSeq`. */
async function versionsTouching(svc: Services, orgId: string, resources: Set<string>, maxSeq: number): Promise<AcceptedProjectVersion[]> {
  const ledger = svc.ledger(orgId);
  const out: AcceptedProjectVersion[] = [];
  for (let after = 0; ; ) {
    const page = await ledger.listAcceptedVersions({ after, limit: 500 });
    for (const v of page) {
      if (v.sequence > maxSeq) return out;
      if (v.heads.some((h) => resources.has(h.resourceId))) out.push(v);
    }
    if (page.length < 500) return out;
    after = page[page.length - 1]!.sequence;
  }
}

/**
 * The production release that is live now, when it contains the promotion's change (review M-a,
 * round 3). Decided per resource from the revisions, not by version sequence (a release is labelled
 * with the latest version touching its sources but built from heads read earlier): for every
 * resource the promotion's accepted version set that the live release builds from, the live
 * release's source revision must be that revision or a descendant of it along accepted heads — a
 * chain of later accepted versions each moving that resource's head from the previous revision
 * (`previousRevisionId`), with no `restore` of it in between. Null when the live release builds from
 * none of the promotion's resources.
 */
async function liveContaining(svc: Services, p: PromotionRow): Promise<ReleaseRow | null> {
  if (!p.accepted_version_id) return null;
  const live = await getLive(svc, p.org_id, p.project_id, "production");
  if (!live) return null;
  const rel = await getRelease(svc, p.org_id, live.release_id);
  if (!rel) return null;
  const ledger = svc.ledger(p.org_id);
  const mine = await ledger.getAcceptedVersion(p.accepted_version_id);
  if (!mine) return null;
  const liveSources = JSON.parse(rel.sources_json) as Record<string, string>;
  const heads = mine.heads.filter((h) => liveSources[h.resourceId] !== undefined);
  if (heads.length === 0) return null;
  const later = (await versionsTouching(svc, p.org_id, new Set(heads.map((h) => h.resourceId as string)), Number.MAX_SAFE_INTEGER)).filter((v) => v.sequence > mine.sequence);
  for (const h of heads) {
    const target = liveSources[h.resourceId]!;
    let current: string = h.revisionId;
    for (const v of later) {
      if (current === target) break;
      const vh = v.heads.find((x) => x.resourceId === h.resourceId);
      if (!vh) continue;
      if (v.kind === "restore") break; // a restore may take the resource back before the promotion
      if (vh.previousRevisionId === current) current = vh.revisionId;
    }
    if (current !== target) return null;
  }
  return rel;
}

/**
 * Review C1/N1: the accepted versions a release would newly bring to production that no promotion
 * of this project cleared. Per source resource of the release: every accepted version touching it
 * after the revision the live production release has for it, up to the released revision, must be
 * an accept of a promotion proposal of this project (`proposals_index.kind = 'promotion'`, same
 * project). While nothing is live in production, a resource starts at the owner baseline's revision
 * for it (B7: owner-published, so known). A resource the start point does not have (a new or
 * re-pointed mount, missing from the live release or the baseline) is checked from its beginning: a
 * resource mounted after the baseline needs one owner publish approval first. Returns the offending
 * versions (empty: the clearance may publish this release).
 */
async function unclearedVersions(svc: Services, rel: ReleaseRow): Promise<string[]> {
  const ledger = svc.ledger(rel.org_id);
  const sources = JSON.parse(rel.sources_json) as Record<string, string>;
  const target = await ledger.getAcceptedVersion(rel.accepted_version_id);
  if (!target) return [rel.accepted_version_id];
  const live = await getLive(svc, rel.org_id, rel.project_id, "production");
  const liveRel = live ? await getRelease(svc, rel.org_id, live.release_id) : null;
  const liveSources = liveRel ? (JSON.parse(liveRel.sources_json) as Record<string, string>) : {};
  const baseline = await getBaseline(svc, rel.org_id, rel.project_id);
  const baselineSources = baseline ? (JSON.parse(baseline.sources_json) as Record<string, string>) : {};
  const versions = await versionsTouching(svc, rel.org_id, new Set(Object.keys(sources)), target.sequence);
  const cleared = new Map<string, boolean>();
  const isCleared = (proposalId: string) => isPromotionProposal(svc, rel.org_id, rel.project_id, proposalId, cleared);
  const out = new Set<string>();
  for (const resourceId of Object.keys(sources)) {
    const mine = versions.filter((v) => v.heads.some((h) => h.resourceId === resourceId));
    // the baseline counts only while nothing is live: a resource the live release lacks starts at its beginning
    const startRev = liveRel ? liveSources[resourceId] : baselineSources[resourceId];
    // after the last version that set the live (else the baseline's) revision; from the beginning when it has no revision for the resource
    let start = 0;
    if (startRev !== undefined) {
      for (let i = mine.length - 1; i >= 0; i--) {
        if (mine[i]!.heads.some((h) => h.resourceId === resourceId && h.revisionId === startRev)) {
          start = i + 1;
          break;
        }
      }
    }
    for (const v of mine.slice(start)) {
      if (v.kind === "accept" && v.proposalId && (await isCleared(v.proposalId))) continue;
      out.add(`${v.acceptedVersionId} (${v.kind}${v.proposalId ? ` of ${v.proposalId}` : ""}, resource ${resourceId})`);
    }
  }
  return [...out];
}

// review M6: production went live (any path, an owner's release included) with a version that
// contains a failed promotion's version: that promotion is live
onProductionLive(async (svc, rel) => {
  const rows = (await svc.db.prepare("SELECT * FROM promotions WHERE org_id = ? AND project_id = ? AND state = 'release_failed' AND accepted_version_id IS NOT NULL").bind(rel.org_id, rel.project_id).all<PromotionRow>()).results;
  for (const p of rows) if ((await liveContaining(svc, p))?.release_id === rel.release_id) await markLive(svc, p, rel, ["release_failed"]);
  // an owner's release may have ended while production was free: the first in line looks again
  await nudgeProductionQueue(svc, rel.org_id, rel.project_id);
});

/**
 * `releasing`: prepare the production release (as the promotion service), approve its publish with
 * the clearance, deploy it (migrations first, Task 4) and follow it to `live` or `release_failed`.
 * One deploy per round: the round is `machine_since` (entering `releasing`, or a retry), part of
 * the deploy's idempotency key, so a retried step never deploys twice and a retry-release deploys
 * again even when it prepares the same release.
 */
async function releasePromotion(svc: Services, p: PromotionRow): Promise<Next> {
  // production already runs a release that contains this promotion's version (any path): live (M6)
  const live = await liveContaining(svc, p);
  if (live) return markLive(svc, p, live);
  if (!p.release_id) {
    // repairs of a step that died after the accept (each idempotent)
    const proposal = p.proposal_id ? await svc.ledger(p.org_id).getProposal(p.proposal_id) : null;
    if (proposal?.state === "accepted") await promoteLandedWork(svc, p, proposal, p.accepted_version_id);
    await recordAccepted(svc, p);
    await dropPromotedFromStaging(svc, p);
    let prepared: ReleaseRow;
    try {
      prepared = await prepareFor(svc, p);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.status >= 500 && svc.now().getTime() - Date.parse(p.machine_since ?? p.updated_at) <= RELEASE_DEADLINE_MS) return wait(30, `the production release cannot be prepared yet (${e.code})`);
      await releaseFailed(svc, p, e.code, e.message);
      return DONE;
    }
    await setPromotion(svc, p.promotion_id, ["releasing"], { release_id: prepared.release_id });
    return wait(5, "production release building");
  }
  const rel = await getRelease(svc, p.org_id, p.release_id);
  if (!rel) {
    await releaseFailed(svc, p, "release_missing", `release ${p.release_id} is missing`);
    return DONE;
  }
  if (rel.state === "live") return markLive(svc, p, rel);
  if (svc.now().getTime() - Date.parse(p.machine_since ?? p.updated_at) > RELEASE_DEADLINE_MS) {
    await releaseFailed(svc, p, "promotion_release_timed_out", `release ${rel.release_id} not live after ${RELEASE_DEADLINE_MS / 3600_000} h (state ${rel.state}${rel.error_code ? `, ${rel.error_code}` : ""})`);
    return DONE;
  }
  if (rel.build_state === "building") return wait(10, "production release building");
  if (rel.build_state === "failed") {
    await releaseFailed(svc, p, rel.error_code ?? "release_build_failed", rel.error);
    return DONE;
  }
  const key = `promotion:${p.promotion_id}:${rel.release_id}:${p.machine_since ?? p.updated_at}`;
  const requested = await svc.db.prepare("SELECT 1 AS x FROM release_deploy_requests WHERE org_id = ? AND idempotency_key = ?").bind(p.org_id, key).first<{ x: number }>();
  if (!requested) {
    // a clearance publishes only what was cleared (review C1): everything new in production must come from promotions
    const uncleared = await unclearedVersions(svc, rel);
    if (uncleared.length > 0) {
      await releaseFailed(svc, p, "release_needs_publish_approval", `production would also get accepted versions no promotion cleared: ${uncleared.slice(0, 20).join(", ")}${uncleared.length > 20 ? ", …" : ""}; an owner publishes release ${rel.release_id} (or a later one) through the release routes`);
      return DONE;
    }
    try {
      // the clearance is the publish approval (also for a reused release: a retry may prepare the same one)
      await approvePublishByClearance(svc, rel, { promotionId: p.promotion_id, kind: p.clearance_kind ?? "developer", clearedBy: p.cleared_by ?? p.requested_by });
      await deployRelease(svc, releaseActor(p), (await getRelease(svc, p.org_id, rel.release_id))!, key);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code === "deploy_in_progress") return wait(15, "another production deploy is in progress");
      if (e.code === "already_live") return wait(1, "the release is live");
      // transient (provider, migrations that sent nothing): the same round tries again, until the deadline
      if (e.status >= 500) return wait(30, `the production deploy cannot start yet (${e.code})`);
      await releaseFailed(svc, p, e.code, e.message);
      return DONE;
    }
    return wait(10, "production deploying");
  }
  switch (rel.state) {
    case "deploying":
    case "health_verification":
      // a lost deploy job must not hold the promotion until its deadline
      await sweepStaleReleases(svc, p.org_id, p.project_id, "production");
      return wait(10, "production deploying");
    case "failed":
    case "partial":
    case "recovery_required":
      if (rel.rollback_state === "running" || rel.rollback_state === "verifying") return wait(10, "production rolling back to the previous release");
      await releaseFailed(svc, p, rel.error_code ?? `release_${rel.state}`, rel.error ?? rel.state);
      return DONE;
    default:
      return wait(5, "production deploy starting");
  }
}

/**
 * `POST …/promotions/:id/retry-release` (owner/developer; authorization is the route's):
 * `release_failed` → `releasing` with a fresh prepare (the latest accepted version when a later
 * accept exists) and a new deploy round. Retrying takes production (B2): refused with `409
 * production_busy` (naming the holder, which is nudged) while another promotion of the project
 * accepts or releases.
 */
export async function retryPromotionRelease(svc: Services, p: PromotionRow, userId: string): Promise<PromotionRow> {
  if (p.state !== "release_failed") throw conflict("promotion_not_release_failed", `the promotion is ${p.state}; only a failed release can be retried`);
  let moved: boolean;
  try {
    // takes production ahead of `cleared` promotions waiting in line (not through the line): an owner
    // or developer releases what is already in `main`, which the waiting promotions build on anyway
    moved = await setPromotion(svc, p.promotion_id, ["release_failed"], { state: "releasing", release_id: null, reason_code: null, reason: null, detail: null, machine_since: svc.nowIso() });
  } catch (e) {
    if (!/UNIQUE/i.test(String((e as Error)?.message))) throw e;
    const holder = await productionHolder(svc, p.org_id, p.project_id);
    if (holder) await nudge(svc, holder);
    throw new ApiError(409, "production_busy", "another promotion is updating production; retry when it finishes", holder ? { promotionId: holder.promotion_id } : undefined);
  }
  if (!moved) throw conflict("promotion_changed", "the promotion changed since you read it; reload it");
  await event(svc, p, "promotion.release_retried", "release_retried", userRef(userId), { channel: "production", previousReleaseId: p.release_id });
  await nudge(svc, p);
  return (await getPromotion(svc, p.promotion_id))!;
}

async function next(svc: Services, promotionId: string): Promise<Next> {
  const p = await getPromotion(svc, promotionId);
  if (!p || !IN_FLIGHT.includes(p.state)) return DONE;
  // accepting and releasing finish what they started (even when staging was turned off meanwhile)
  if (p.state === "accepting") return acceptPromotion(svc, p);
  if (p.state === "releasing") return releasePromotion(svc, p);
  const project = await getProject(svc.db, p.org_id, p.project_id);
  const policy = project ? stagingPolicyOf(project) : null;
  if (!project || !policy) {
    await failPromotion(svc, p, BEFORE_ACCEPT, { code: "staging_not_configured", text: PROMOTION_REASONS.off });
    return DONE;
  }
  if (MACHINE.includes(p.state) && svc.now().getTime() - Date.parse(p.machine_since ?? p.created_at) > PROMOTION_DEADLINE_MS) {
    // other promotions' accepts kept moving main under it (uncounted rebuilds): production kept changing
    const text = p.promotion_rebuilds > 0 ? PROMOTION_REASONS.unstable : PROMOTION_REASONS.stopped;
    await failPromotion(svc, p, [p.state], { code: "promotion_timed_out", text, detail: `not cleared after ${PROMOTION_DEADLINE_MS / 3600_000} h (state ${p.state}; ${p.promotion_rebuilds} rebuilds after other promotions' accepts)` });
    return DONE;
  }
  // a policy change while waiting for a developer or before accepting: rebuild on the new policy
  if ((p.state === "pending_approval" || p.state === "cleared") && p.policy_revision !== project.policy_revision) {
    await rebuildPromotion(svc, p.promotion_id, [p.state]);
    return wait(1, "the policy changed; rebuilding the promotion");
  }
  switch (p.state) {
    case "requested":
      return startBuild(svc, p, project);
    case "building":
      return watchBuild(svc, p);
    case "gating":
      return gate(svc, p, project, policy);
    case "cleared":
      return startAccept(svc, p);
    default:
      // pending_approval: approve and send back are routes
      return DONE;
  }
}

/**
 * `promotion.advance`: one promotion, one next step per call, under the promotion's own lock (B4;
 * promotions of a project step in parallel, production is taken by the claim). One chain per
 * promotion (review I1): every run writes the heartbeat `chain_at`; a chain that ends clears it (so
 * the next nudge starts one); a step that finds the lock held while the heartbeat is fresh is a
 * second chain and ends. A run that moved the promotion (out of production, out of the production
 * line) or ended its chain lets the first promotion in line look again ({@link nudgeProductionQueue}).
 */
export async function advancePromotion(svc: Services, orgId: string, promotionId: string, attempt = 1): Promise<StepOutcome> {
  const p = await getPromotion(svc, promotionId);
  if (!p || p.org_id !== orgId || !IN_FLIGHT.includes(p.state)) return { done: true };
  const beat = (at: string | null) => svc.db.prepare("UPDATE promotions SET chain_at = ? WHERE promotion_id = ?").bind(at, promotionId).run();
  const out = await svc.gate.withLock("promotion", promotionId, LOCK_MS, async () => {
    await beat(svc.nowIso());
    const n = await next(svc, promotionId);
    if ("done" in n) await beat(null);
    return n;
  });
  if (out.locked) {
    const now = await svc.db.prepare("SELECT chain_at FROM promotions WHERE promotion_id = ?").bind(promotionId).first<{ chain_at: string | null }>();
    if (now && chainFresh(svc, now.chain_at)) return { done: true }; // another chain of this promotion runs
  } else {
    const after = await svc.db.prepare("SELECT state FROM promotions WHERE promotion_id = ?").bind(promotionId).first<{ state: PromotionState }>();
    if ("done" in out.value || after?.state !== p.state) await nudgeProductionQueue(svc, orgId, p.project_id);
  }
  const n: Next = out.locked ? wait(3, "another step of this promotion holds its lock") : out.value;
  if ("done" in n) return { done: true };
  // waiting on the runner can outlast the step's attempts: continue in a fresh step
  if (attempt >= MAX_STEP_ATTEMPTS - 1) {
    await enqueueStep(svc, { type: "promotion.advance", orgId, promotionId });
    return { done: true };
  }
  return { retry: true, delaySeconds: n.wait, reason: n.reason };
}

onStep("promotion.advance", (svc, msg, attempt) => advancePromotion(svc, msg.orgId, msg.promotionId, attempt));
onStepFailed("promotion.advance", async (svc, msg, reason) => {
  const p = await getPromotion(svc, msg.promotionId);
  if (!p || p.org_id !== msg.orgId) return;
  // a release that keeps throwing: retryable by an owner or developer (main already has the change)
  if (p.state === "releasing") {
    if (await releaseFailed(svc, p, "promotion_step_failed", reason)) await nudgeProductionQueue(svc, p.org_id, p.project_id);
    return;
  }
  // only the states the step works through by itself; people own the others. `accepting` is never
  // failed here (the accept may have committed): its next step (a refused request nudges it) finds out.
  await failPromotion(svc, p, MACHINE, { code: "promotion_step_failed", text: PROMOTION_REASONS.stopped, detail: reason });
});

// ------------------------------------------------------------------------------ view

const namedList = (json: string | null): NamedLanding[] => {
  try {
    const v: unknown = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? v.filter((x): x is NamedLanding => !!x && typeof x === "object").map((x) => ({ landingId: String(x.landingId), taskId: String(x.taskId), title: String(x.title) })) : [];
  } catch {
    return [];
  }
};

/** The resource ids a task snapshot names, or null when the snapshot is not readable (callers then treat the resources as not all seen). */
function snapshotResourceIds(json: string): string[] | null {
  try {
    const v = JSON.parse(json) as { entries?: unknown };
    if (!Array.isArray(v?.entries)) return null;
    return v.entries.map((e) => String((e as { resourceId?: unknown })?.resourceId ?? ""));
  } catch {
    return null;
  }
}
/** Stands for an unreadable snapshot in a resource list (never a real resource id). */
const MALFORMED = "\u0000malformed";

/**
 * Whether `actor` reads every resource promotion `p` changes (AT-16; the rule the developer view
 * uses, see {@link promotionViews}): owners always; developers with read on every resource of the
 * promotion proposal (before one exists: every resource its landings' tasks' snapshots name; an
 * unreadable snapshot counts as not seen); never clients or viewers.
 */
export async function seesWholePromotion(svc: Services, p: PromotionRow, actor: { userId: string; role: Role }): Promise<boolean> {
  if (actor.role === "owner") return true;
  if (actor.role !== "developer") return false;
  const proposal = p.proposal_id ? await svc.ledger(p.org_id).getProposal(p.proposal_id) : null;
  let resources: string[];
  if (proposal) resources = proposalResourceIds(proposal);
  else {
    resources = [];
    for (const id of promotionLandingIds(p)) {
      const l = await svc.db.prepare("SELECT landing_id, task_id, proposal_id FROM staging_landings WHERE landing_id = ?").bind(id).first<Pick<LandingRow, "landing_id" | "task_id" | "proposal_id">>();
      if (!l) continue;
      for (const part of await landingParts(svc, l)) {
        const t = await svc.db.prepare("SELECT snapshot_json FROM tasks WHERE task_id = ?").bind(part.taskId).first<{ snapshot_json: string }>();
        if (!t?.snapshot_json) continue;
        const ids = snapshotResourceIds(t.snapshot_json);
        if (!ids) return false;
        resources.push(...ids);
      }
    }
  }
  for (const r of new Set(resources)) if (!(await canReadResource(svc, { orgId: p.org_id, userId: actor.userId, role: actor.role }, r))) return false;
  return true;
}

const notVisibleError = () => forbidden("promotion_not_visible", "you cannot read every folder this promotion changes, so you cannot approve it or send it back");

/**
 * Promotions as `viewer` reads them, batched (review of Task 4: a list of 100 reads its landings,
 * parts and task texts with a few `IN (…)` statements, not per row).
 *
 * Clients and viewers: state, landings, level and the reason (only when they asked for it or own a
 * landing in the set); never the gate, raw errors or proposal ids. Owners, and developers who can
 * read every resource the promotion proposal changes (before a proposal exists: every resource
 * its tasks' snapshots name; the rule `canSeeTask`/`approverSees` use, AT-16): everything, plus
 * each landing's request and parts. `full` (`GET /promotions/:id` only) adds what the review
 * screen needs from the ledger: the per-resource head/result revision ids and the checks.
 */
async function promotionViews(svc: Services, ps: readonly PromotionRow[], viewer: { userId: string; role: Role }, opts: { full: boolean }) {
  if (!ps.length) return [];
  const orgId = ps[0]!.org_id;
  const json = (xs: Iterable<string>) => JSON.stringify([...new Set(xs)]);
  const all = <T>(sql: string, ...binds: unknown[]) => svc.db.prepare(sql).bind(...binds).all<T>().then((r) => r.results);
  // the landings of every promotion, and the landings they go without that are being promoted now (M2)
  const landingIds = ps.flatMap((p) => promotionLandingIds(p));
  const landingRows = await all<LandingRow & { title: string }>("SELECT l.*, t.title FROM staging_landings l JOIN tasks t ON t.task_id = l.task_id WHERE l.landing_id IN (SELECT value FROM json_each(?))", json(landingIds));
  const landingById = new Map(landingRows.map((l) => [l.landing_id, l]));
  const goingIds = ps.flatMap((p) => namedList(p.going_without_json).map((g) => g.landingId));
  const goingPromoting = new Set(goingIds.length ? (await all<{ landing_id: string }>("SELECT landing_id FROM staging_landings WHERE landing_id IN (SELECT value FROM json_each(?)) AND state = 'promoting'", json(goingIds))).map((r) => r.landing_id) : []);
  const developer = viewer.role === "owner" || viewer.role === "developer";
  // developers: each landing's parts, and the request, title and snapshot of every task they name
  const partsOf = new Map<string, Array<{ part: number; taskId: string }>>();
  const tasks = new Map<string, { title: string; request: string; snapshot_json: string }>();
  if (developer && landingRows.length) {
    for (const r of await all<{ landing_id: string; part: number; task_id: string }>("SELECT landing_id, part, task_id FROM staging_landing_parts WHERE landing_id IN (SELECT value FROM json_each(?)) ORDER BY landing_id, part", json(landingRows.map((l) => l.landing_id)))) {
      partsOf.set(r.landing_id, [...(partsOf.get(r.landing_id) ?? []), { part: r.part, taskId: r.task_id }]);
    }
    // like landingParts: a landing without a part-1 row is its own task's proposal
    for (const l of landingRows) {
      const parts = partsOf.get(l.landing_id) ?? [];
      if (!parts.some((x) => x.part === 1)) parts.unshift({ part: 1, taskId: l.task_id });
      partsOf.set(l.landing_id, parts);
    }
    const taskIds = landingRows.flatMap((l) => [l.task_id, ...partsOf.get(l.landing_id)!.map((x) => x.taskId)]);
    for (const t of await all<{ task_id: string; title: string; request: string; snapshot_json: string }>("SELECT task_id, title, request, snapshot_json FROM tasks WHERE task_id IN (SELECT value FROM json_each(?))", json(taskIds))) tasks.set(t.task_id, t);
  }
  // AT-16: a developer reads the developer view only with read on every resource of the promotion
  const readable = new Map<string, Promise<boolean>>();
  const canRead = (resourceId: string) => {
    if (!readable.has(resourceId)) readable.set(resourceId, canReadResource(svc, { orgId, userId: viewer.userId, role: viewer.role }, resourceId));
    return readable.get(resourceId)!;
  };
  const ledger = svc.ledger(orgId);
  const proposals = new Map<string, Promise<ProposalRecord | null>>();
  const proposalOf = (id: string) => {
    if (!proposals.has(id)) proposals.set(id, ledger.getProposal(id));
    return proposals.get(id)!;
  };
  const seesAll = async (p: PromotionRow, rows: Array<LandingRow & { title: string }>): Promise<boolean> => {
    if (viewer.role === "owner") return true;
    if (viewer.role !== "developer") return false;
    const proposal = p.proposal_id ? await proposalOf(p.proposal_id) : null;
    const resources = proposal
      ? proposalResourceIds(proposal)
      : rows.flatMap((l) =>
          partsOf.get(l.landing_id)!.flatMap((x) => {
            const snap = tasks.get(x.taskId)?.snapshot_json;
            return snap ? (snapshotResourceIds(snap) ?? [MALFORMED]) : [];
          }),
        );
    if (resources.includes(MALFORMED)) return false;
    for (const r of new Set(resources)) if (!(await canRead(r))) return false;
    return true;
  };
  const mounts = opts.full ? await listMounts(svc.db, orgId, ps[0]!.project_id) : [];
  const out = [];
  for (const p of ps) {
    const rows = promotionLandingIds(p).map((id) => landingById.get(id)).filter((l): l is LandingRow & { title: string } => !!l);
    const full = await seesAll(p, rows);
    const own = full || p.requested_by === viewer.userId || rows.some((l) => l.created_by === viewer.userId);
    const going = namedList(p.going_without_json);
    const base = {
      promotionId: p.promotion_id,
      state: p.state,
      landings: rows.map((l) => ({ landingId: l.landing_id, taskId: l.task_id, title: l.title, state: l.state })),
      level: p.level,
      reasonCode: own ? p.reason_code : null,
      reason: own ? p.reason : null,
      // cleared, waiting while another promotion accepts or releases (B3)
      waitingForProduction: p.state === "cleared" && p.reason_code === "production_busy",
      // B8: alone-first (task titles, which every project reader sees in GET …/staging)
      mode: p.mode,
      goingWithout: going.map((g) => ({ ...g, text: goingWithoutText(g.title, goingPromoting.has(g.landingId)) })),
      needs: namedList(p.needs_json),
    };
    if (!full) {
      out.push(base);
      continue;
    }
    let gateView: unknown = null;
    try {
      gateView = p.gate_json ? JSON.parse(p.gate_json) : null;
    } catch {
      gateView = null;
    }
    const landings = rows.map((l, i) => ({ ...base.landings[i]!, request: tasks.get(l.task_id)?.request ?? "", parts: partsOf.get(l.landing_id)!.map((x) => ({ part: x.part, taskId: x.taskId, title: tasks.get(x.taskId)?.title ?? "" })) }));
    // the review screen (P3-10): the per-resource `main` head and result revisions of the
    // integration for the current proposal hash, and its checks (GET /promotions/:id only)
    let review = {};
    if (opts.full) {
      const integ = p.proposal_id ? await latestIntegration(svc, orgId, p.proposal_id) : null;
      const receipt = integ && p.proposal_hash && integ.receipt.evidence.proposalHash === p.proposal_hash ? integ.receipt : null;
      review = {
        resources: (receipt?.results ?? []).map((r) => ({ resourceId: r.resourceId as string, mountName: mounts.find((m) => m.resource_id === r.resourceId)?.mount_name ?? null, head: r.expectedHead as string, result: r.revisionId as string })),
        checks: receipt ? { checks: receipt.evidence.checks, contractChecks: receipt.evidence.contractChecks, mergeOutcome: receipt.evidence.mergeOutcome } : null,
      };
    }
    out.push({
      ...base,
      landings,
      ...review,
      targetLandingId: p.target_landing_id,
      proposalId: p.proposal_id,
      proposalHash: p.proposal_hash,
      gate: gateView,
      detail: p.detail,
      clearance: p.clearance_kind ? { kind: p.clearance_kind, clearedBy: p.cleared_by, clearedAt: p.cleared_at } : null,
      acceptedVersionId: p.accepted_version_id,
      releaseId: p.release_id,
      requestedBy: p.requested_by,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
    });
  }
  return out;
}

/** A promotion as `viewer` reads it ({@link promotionViews}), with the review screen's resources and checks for those who get the developer view. */
export async function promotionView(svc: Services, p: PromotionRow, viewer: { userId: string; role: Role }) {
  return (await promotionViews(svc, [p], viewer, { full: true }))[0]!;
}

/** Promotion states a list may filter by. */
export const PROMOTION_STATES: readonly PromotionState[] = ["requested", "building", "gating", "pending_approval", "cleared", "accepting", "releasing", "live", "failed", "release_failed", "sent_back", "superseded", "withdrawn"];
/** At most this many promotions per list, newest first. */
export const PROMOTION_LIST_LIMIT = 100;

/**
 * `GET …/projects/:pid/promotions` (P3-8; authorization of the project is the route's): the
 * project's promotions newest first (at most {@link PROMOTION_LIST_LIMIT}), optionally only those in
 * `states`. Owners and developers: every promotion (the developer view only with read on every
 * resource it changes). Clients: only promotions they requested or with a landing they created,
 * client view. No row carries `resources` or `checks` (only `GET /promotions/:id` does).
 */
export async function listPromotions(svc: Services, orgId: string, projectId: string, viewer: { userId: string; role: Role }, states?: readonly PromotionState[]) {
  const developer = viewer.role === "owner" || viewer.role === "developer";
  const where = ["p.org_id = ?", "p.project_id = ?"];
  const binds: unknown[] = [orgId, projectId];
  if (states?.length) {
    where.push(`p.state IN (${placeholders(states.length)})`);
    binds.push(...states);
  }
  if (!developer) {
    where.push("(p.requested_by = ? OR EXISTS (SELECT 1 FROM json_each(p.landings_json) j JOIN staging_landings l ON l.landing_id = j.value WHERE l.created_by = ?))");
    binds.push(viewer.userId, viewer.userId);
  }
  const rows = (await svc.db.prepare(`SELECT p.* FROM promotions p WHERE ${where.join(" AND ")} ORDER BY p.created_at DESC, p.rowid DESC LIMIT ${PROMOTION_LIST_LIMIT}`).bind(...binds).all<PromotionRow>()).results;
  // batched; without the review screen's resources and checks (GET /promotions/:id has them)
  return promotionViews(svc, rows, viewer, { full: false });
}
