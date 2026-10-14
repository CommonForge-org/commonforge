/**
 * Always-on staging (spec 2026-10-07 §4–§5). A submitted task in a staging-mode project lands: its
 * proposal is its change set, a `staging_landings` row orders it, and a `staging_builds` row (main
 * shas + ordered landings) is merged by the runner (`staging-build`), built and deployed as a
 * `staging` release with its own D1/KV, migrations and seed. `staging.advance` drives one build:
 * each call re-reads the build and does the next missing thing (the steps idiom), under a
 * per-project lock, and only one build of a project is ever past `queued` — the only place staging
 * D1/KV are created or reset. A failed build leaves the previous staging live; production, main and
 * every ledger head are never touched.
 *
 * Reasons: a landing's `reason` is text the platform composes itself (what clients and viewers
 * see); `detail` keeps the raw runner/release error for owners and developers only, since it can
 * name repositories and namespaces.
 */
import { parseRevisionId, revisionCommitSha, sha256Hex, stagingWorkerName, type RepoCoords } from "@commonforge-org/core";
import type { IntegrationJob, IntegrationJobInput, RunnerResult, StagingBuildReceipt } from "@commonforge-org/runner-protocol";
import type { Services } from "../context.js";
import { newId } from "../lib/crypto.js";
import { ApiError, conflict } from "../lib/http.js";
import { repoInfoCoords } from "./artifacts.js";
import { getProject, getResource, listMounts, resourceCoords, type ProjectRow } from "./directory.js";
import { recordEvent, userRef } from "./events.js";
import type { StepOutcome } from "./intake.js";
import { buildProposal, getProposalIndex, proposalResourceIds } from "./proposals.js";
import { getRelease, onProductionLive, prepareStagingRelease, RELEASE_SERVICE, startStagingDeploy, sweepStaleReleases, type ReleaseRow } from "./releases.js";
import { getJob, issueJob, onRunnerResult, RESULT_GRACE_MS, type RunnerJobRow } from "./runner-jobs.js";
import { ensureSink } from "./sink.js";
import { establishBaseline, getBaseline } from "./staging-baseline.js";
import { applyStagingData, deleteRetired, ensureStagingResources, resetStagingResources, stagingMigrationsNeedReset } from "./staging-data.js";
import { stagingPolicyOf } from "./staging-policy.js";
import { DeployApiError } from "./deploy-api.js";
import { currentStaging } from "./staging-state.js";
import { enqueueStep, MAX_STEP_ATTEMPTS, onStep, onStepFailed } from "./steps.js";
import { getTask, type TaskRow } from "./tasks.js";

/**
 * `promoting` (staging phase 2, P2-5): in a promotion that is in flight; still in staging (every
 * filter that means "in staging" or "open" includes it). `promoted`: accepted into `main` by its
 * promotion (R10: at accept, not when production goes live); no longer in staging — the next
 * staging build starts from `main`, which has it.
 */
export type LandingState = "checking" | "landed" | "failed" | "rolling_back" | "rolled_back" | "promoting" | "promoted";
/** Landings that are in staging: built into every staging build, open for their task. */
export const IN_STAGING: readonly LandingState[] = ["checking", "landed", "promoting"];
export interface LandingRow {
  landing_id: string;
  org_id: string;
  project_id: string;
  task_id: string;
  proposal_id: string;
  seq: number;
  state: LandingState;
  reason_code: string | null;
  /** platform-composed text (safe for clients) */
  reason: string | null;
  /** raw runner/release error (owners and developers only) */
  detail: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
export type BuildState = "queued" | "merging" | "building" | "deploying" | "live" | "failed" | "superseded";
export interface BuildRow {
  build_id: string;
  org_id: string;
  project_id: string;
  seq: number;
  landings_json: string;
  reset: 0 | 1;
  state: BuildState;
  merge_job_id: string | null;
  staging_json: string | null;
  release_id: string | null;
  error_code: string | null;
  error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
type Shas = Record<string, { sha: string; revisionId: string }>;
/** `paths`: the conflicting paths of a merge conflict (for the revision texts). */
type Reason = { code: string; text: string; detail?: string; paths?: string };

/** What clients and viewers read: composed here, never runner or provider text. */
export const REASONS = {
  conflict: (paths: string) => `Conflicts with staging in ${paths}. Start a new task from the current staging.`,
  merge: "Staging could not combine this task with the other changes. Start a new task from the current staging; if it keeps failing, ask a developer.",
  build: "The staging build failed.",
  data: "A migration or the demo data did not apply. Reset staging data or fix the migration.",
  deploy: (previousLive: boolean) => `The staging deploy failed.${previousLive ? " The previous staging is still live." : ""}`,
  deployUnverified: "The staging deploy failed and could not be undone automatically. A developer needs to check staging.",
  deployNotStarted: "The staging deploy could not start. A developer needs to check the staging setup.",
  stopped: "The staging build stopped before it finished. Start a new task from the current staging.",
  off: "Staging was turned off for this project.",
  withdrawn: "This task's change is no longer available to staging. Start a new task from the current staging.",
  notPrepared: "This task's change could not be prepared for staging. Start a new task from the current staging.",
  rollbackUnfinished: "Removing this task from staging did not finish; it is still in staging. Try again.",
  conflictsWithProduction: "Conflicts with a change now in production. Start a new task from the current staging.",
  revisionConflict: (paths: string) => `This revision conflicts with staging in ${paths}. The task stays in staging without it; revise it again from the current staging.`,
  revisionDropped: "This revision could not be added to staging. The task stays in staging without it; revise it again.",
  revisionWithoutOriginal: "The task this revises is no longer in staging, so this revision landed on its own, without it.",
  revisionAlone: "The task this revises was still being accepted into production after 2 hours, so this revision landed on its own.",
  awaitingBaseline: "Waiting for the owner's first production publish.",
} as const;

/** Long enough for the slowest branch (a reset: create D1/KV, prepare; data: every migration and seed). */
const LOCK_MS = 10 * 60_000;
/** A build that has not finished after this long is failed (nothing it waits for answers any more). */
export const BUILD_DEADLINE_MS = 6 * 3600_000;
/** A landing whose candidate is still not prepared after this long is dropped from staging. */
export const PREPARE_DEADLINE_MS = 60 * 60_000;
const ACTIVE: BuildState[] = ["queued", "merging", "building", "deploying"];

type Next = { done: true } | { wait: number; reason: string };
const DONE = { done: true } as const;
const wait = (seconds: number, reason: string): Next => ({ wait: seconds, reason });

async function build(svc: Services, buildId: string): Promise<BuildRow | null> {
  return svc.db.prepare("SELECT * FROM staging_builds WHERE build_id = ?").bind(buildId).first<BuildRow>();
}
async function landing(svc: Services, landingId: string): Promise<LandingRow | null> {
  return svc.db.prepare("SELECT * FROM staging_landings WHERE landing_id = ?").bind(landingId).first<LandingRow>();
}
async function landingsOf(svc: Services, ids: string[]): Promise<LandingRow[]> {
  const out: LandingRow[] = [];
  for (const id of ids) {
    const l = await landing(svc, id);
    if (l) out.push(l);
  }
  return out;
}
/** A landing's parts in part order (part 1 falls back to the landing row when its part row is missing). */
export async function landingParts(svc: Services, l: Pick<LandingRow, "landing_id" | "task_id" | "proposal_id">): Promise<Array<{ part: number; taskId: string; proposalId: string }>> {
  const rows = (await svc.db.prepare("SELECT part, task_id, proposal_id FROM staging_landing_parts WHERE landing_id = ? ORDER BY part").bind(l.landing_id).all<{ part: number; task_id: string; proposal_id: string }>()).results;
  const out = rows.map((r) => ({ part: r.part, taskId: r.task_id, proposalId: r.proposal_id }));
  if (!out.some((x) => x.part === 1)) out.unshift({ part: 1, taskId: l.task_id, proposalId: l.proposal_id });
  return out;
}

/**
 * The newest landing that carries the task: its own (part 1) or one it joined as a revision (a
 * later part; staging phase 2, R6). `states` limits the landings considered.
 */
export async function landingOfTask(svc: Services, orgId: string, taskId: string, states?: readonly LandingState[]): Promise<LandingRow | null> {
  return svc.db
    .prepare(
      `SELECT l.* FROM staging_landings l WHERE l.org_id = ? AND (l.task_id = ? OR EXISTS (SELECT 1 FROM staging_landing_parts p WHERE p.landing_id = l.landing_id AND p.task_id = ?))${states ? ` AND l.state IN (${states.map(() => "?").join(", ")})` : ""} ORDER BY l.seq DESC LIMIT 1`,
    )
    .bind(orgId, taskId, taskId, ...(states ?? []))
    .first<LandingRow>();
}

/** Every candidate of every part of a landing; null while a part's proposal is not recorded. */
async function partCandidates(svc: Services, l: LandingRow): Promise<Array<{ candidateId: string; resourceId: string }> | null> {
  const ledger = svc.ledger(l.org_id);
  const out: Array<{ candidateId: string; resourceId: string }> = [];
  for (const part of await landingParts(svc, l)) {
    const p = await ledger.getProposal(part.proposalId);
    if (!p) return null;
    for (const c of p.resourceChanges) out.push({ candidateId: c.candidateId as string, resourceId: c.resourceId as string });
  }
  return out;
}

/** What the build's `staging-build` job merged: its target resources and, per landing, the candidate ids (null: no merge job). */
type Merged = { resources: Set<string>; landings: Map<string, Set<string>> };
async function mergedCandidates(svc: Services, b: BuildRow): Promise<Merged | null> {
  const job = b.merge_job_id ? await getJob(svc, b.merge_job_id) : null;
  if (!job) return null;
  const out: Merged = { resources: new Set(), landings: new Map() };
  try {
    const j = (JSON.parse(job.signed_json) as { job?: { targets?: Array<{ resourceId: string; landings?: Array<{ landingId: string; candidates: Array<{ candidateId: string }> }> }> } }).job;
    for (const t of j?.targets ?? []) {
      out.resources.add(t.resourceId);
      for (const l of t.landings ?? []) for (const c of l.candidates) out.landings.set(l.landingId, (out.landings.get(l.landingId) ?? new Set()).add(c.candidateId));
    }
  } catch {
    return null;
  }
  return out;
}

/**
 * The landings of the staging builds this landing's parts were seeded from (`tasks.staging_build_id`
 * of each part's task, by id). A revision is applied in its landing's position but may build on
 * landings that come later (ruling I1b): they are its landing's extra predecessors in
 * `promotionSet` (`after`). The landing itself is left out.
 */
export async function baseLandings(svc: Services, l: LandingRow): Promise<string[]> {
  const out = new Set<string>();
  for (const part of await landingParts(svc, l)) {
    const b = await svc.db
      .prepare("SELECT b.* FROM tasks t JOIN staging_builds b ON b.build_id = t.staging_build_id WHERE t.task_id = ? AND b.org_id = ? AND b.project_id = ?")
      .bind(part.taskId, l.org_id, l.project_id)
      .first<BuildRow>();
    for (const id of b ? idsOf(b) : []) if (id !== l.landing_id) out.add(id);
  }
  return [...out];
}

const partCount = async (svc: Services, landingId: string): Promise<number> =>
  (await svc.db.prepare("SELECT COUNT(*) AS n FROM staging_landing_parts WHERE landing_id = ?").bind(landingId).first<{ n: number }>())?.n ?? 0;

/**
 * Did the build's merge include every part the landing has now (candidates of the resources it
 * builds)? A revision appended after the merge started is not in it: the landing stays `checking`
 * for the next build. `covers` is true when the build has no merge job (nothing to compare: Phase 1
 * behaviour). `parts` is the landing's part count read first: a transition that relies on
 * `covers` is conditional on it (a part appended meanwhile keeps the landing `checking`).
 */
async function mergeCovers(svc: Services, merged: Merged | null, l: LandingRow): Promise<{ covers: boolean; parts: number }> {
  const parts = await partCount(svc, l.landing_id);
  if (!merged) return { covers: true, parts };
  const want = await partCandidates(svc, l);
  const got = merged.landings.get(l.landing_id);
  return { covers: !!want && want.every((c) => !merged.resources.has(c.resourceId) || (got?.has(c.candidateId) ?? false)), parts };
}

/** The parts of a landing that are live (all their candidates in the live build's merge); null when that cannot be told. */
async function liveParts(svc: Services, l: LandingRow): Promise<Set<number> | null> {
  const cur = await currentStaging(svc, l.org_id, l.project_id);
  const liveBuild = cur ? await build(svc, cur.buildId) : null;
  const merged = liveBuild ? await mergedCandidates(svc, liveBuild) : null;
  if (!merged) return null;
  const got = merged.landings.get(l.landing_id) ?? new Set<string>();
  const ledger = svc.ledger(l.org_id);
  const out = new Set<number>();
  for (const part of await landingParts(svc, l)) {
    const p = await ledger.getProposal(part.proposalId);
    if (p && p.resourceChanges.every((c) => !merged.resources.has(c.resourceId as string) || got.has(c.candidateId as string))) out.add(part.part);
  }
  return out;
}

/**
 * `checking` → `landed` only while the landing still has `parts` parts (the count its coverage was
 * read with). Keeps the landing's reason (a revision that landed on its own says why). Exported
 * for tests.
 */
export async function markLandedIfParts(svc: Services, l: LandingRow, parts: number): Promise<boolean> {
  const r = await svc.db
    .prepare("UPDATE staging_landings SET state = 'landed', updated_at = ? WHERE landing_id = ? AND state = 'checking' AND (SELECT COUNT(*) FROM staging_landing_parts WHERE landing_id = ?) = ?")
    .bind(svc.nowIso(), l.landing_id, l.landing_id, parts)
    .run();
  if ((r.meta.changes ?? 0) === 0) return false;
  await recordLandingEvent(svc, l, "landed", l.reason_code && l.reason ? { code: l.reason_code, text: l.reason } : undefined);
  return true;
}

/**
 * A build failed while the landing was `checking` only because of revision parts that were never
 * live (ruling I1a): those parts are dropped — their rows removed, their proposals withdrawn, the
 * revision tasks told why — and the landing is `landed` again with its live parts (only while it
 * still has `parts` parts). Never fails parts that are live because of a revision. Returns whether
 * it dropped anything.
 */
async function dropNewParts(svc: Services, l: LandingRow, parts: number, reason: Reason): Promise<boolean> {
  const live = await liveParts(svc, l);
  if (!live || live.size === 0) return false;
  const dropped = (await landingParts(svc, l)).filter((x) => !live.has(x.part));
  if (dropped.length === 0) return false;
  const now = svc.nowIso();
  const [, upd] = await svc.db.batch([
    svc.db
      .prepare(`DELETE FROM staging_landing_parts WHERE landing_id = ? AND part IN (${dropped.map(() => "?").join(", ")}) AND EXISTS (SELECT 1 FROM staging_landings WHERE landing_id = ? AND state = 'checking') AND (SELECT COUNT(*) FROM staging_landing_parts WHERE landing_id = ?) = ?`)
      .bind(l.landing_id, ...dropped.map((x) => x.part), l.landing_id, l.landing_id, parts),
    svc.db
      .prepare("UPDATE staging_landings SET state = 'landed', reason_code = NULL, reason = NULL, detail = NULL, updated_at = ? WHERE landing_id = ? AND state = 'checking' AND (SELECT COUNT(*) FROM staging_landing_parts WHERE landing_id = ?) = ?")
      .bind(now, l.landing_id, l.landing_id, parts - dropped.length),
  ]);
  if ((upd!.meta.changes ?? 0) === 0) return false;
  await recordLandingEvent(svc, l, "landed");
  const ledger = svc.ledger(l.org_id);
  const text = reason.paths ? REASONS.revisionConflict(reason.paths) : REASONS.revisionDropped;
  for (const x of dropped) {
    const p = await ledger.getProposal(x.proposalId);
    if (p && (p.state === "open" || p.state === "prepared")) {
      await ledger.putProposal({ ...p, state: "withdrawn" });
      await recordEvent(svc, { orgId: l.org_id, projectId: l.project_id, actor: RELEASE_SERVICE, action: "proposal.withdrawn", subjectKind: "proposal", subjectId: x.proposalId, resourceIds: proposalResourceIds(p), detail: { landingId: l.landing_id, staging: true } });
    }
    await recordEvent(svc, {
      orgId: l.org_id,
      projectId: l.project_id,
      actor: RELEASE_SERVICE,
      action: REVISION_DROPPED,
      subjectKind: "task",
      subjectId: x.taskId,
      detail: { landingId: l.landing_id, part: x.part, code: reason.code, reason: text, ...(reason.detail ? { detail: reason.detail.slice(0, 2000) } : {}) },
      clientVisible: true,
      clientDetail: { landingId: l.landing_id, code: reason.code },
    });
  }
  return true;
}

/** The event that tells a revision's task it did not join its landing (and keeps a retried land step from appending it again). */
const REVISION_DROPPED = "staging.revision_dropped";

const idsOf = (b: BuildRow): string[] => {
  try {
    const v: unknown = JSON.parse(b.landings_json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

async function setBuild(svc: Services, buildId: string, from: BuildState[], patch: Partial<Pick<BuildRow, "state" | "staging_json" | "release_id" | "error_code" | "error" | "reset" | "landings_json">>): Promise<boolean> {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  const r = await svc.db
    .prepare(`UPDATE staging_builds SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE build_id = ? AND state IN (${from.map(() => "?").join(", ")})`)
    .bind(...keys.map((k) => patch[k] ?? null), svc.nowIso(), buildId, ...from)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

const ACTION: Record<LandingState, string> = {
  checking: "staging.landing_checking",
  landed: "staging.landed",
  failed: "staging.landing_failed",
  rolling_back: "staging.rolling_back",
  rolled_back: "staging.rolled_back",
  promoting: "staging.promoting",
  promoted: "staging.promoted",
};

/** Move a landing from one of `from` (compare-and-set), with its event. Returns whether it moved. */
export async function setLanding(svc: Services, l: LandingRow, from: LandingState[], state: LandingState, reason?: Reason, opts: { parts?: number } = {}): Promise<boolean> {
  // `parts`: only while the landing has that many parts (no revision appended since the caller looked)
  const r = await svc.db
    .prepare(`UPDATE staging_landings SET state = ?, reason_code = ?, reason = ?, detail = ?, updated_at = ? WHERE landing_id = ? AND state IN (${from.map(() => "?").join(", ")})${opts.parts !== undefined ? " AND (SELECT COUNT(*) FROM staging_landing_parts WHERE landing_id = ?) = ?" : ""}`)
    .bind(state, reason?.code ?? null, reason?.text ?? null, reason?.detail?.slice(0, 4000) ?? null, svc.nowIso(), l.landing_id, ...from, ...(opts.parts !== undefined ? [l.landing_id, opts.parts] : []))
    .run();
  if ((r.meta.changes ?? 0) === 0) return false;
  await recordLandingEvent(svc, l, state, reason);
  if (l.state === "promoting" && state === "failed") await promotingLandingFailed?.(svc, l);
  // the landing left staging for good: its change can never reach main through it (Phase 1 deferred finding)
  if (state === "failed" || state === "rolled_back") {
    await closeLandingProposals(svc, l, "withdrawn");
    // best effort (the landing has moved; a staged file change's read and GC sweep repair a miss)
    try {
      await landingLeftStaging?.(svc, l, state, reason);
    } catch (e) {
      console.warn(`staging: landing ${l.landing_id} left staging, its staged file changes were not failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return true;
}

/**
 * Close every part's landing proposal (`prop-stg-*`) of a landing that left staging: `withdrawn`
 * when it failed or was rolled back, `superseded` when a promotion accepted it into `main`
 * (staging phase 2). Only `open`/`prepared` proposals move (both edges are allowed by core's
 * `PROPOSAL_TRANSITIONS`; hashed content and `updatedAt` unchanged); a closed one stays as it is.
 * Idempotent.
 */
export async function closeLandingProposals(svc: Services, l: Pick<LandingRow, "org_id" | "project_id" | "landing_id" | "proposal_id">, state: "withdrawn" | "superseded"): Promise<void> {
  const parts = (await svc.db.prepare("SELECT proposal_id FROM staging_landing_parts WHERE landing_id = ? ORDER BY part").bind(l.landing_id).all<{ proposal_id: string }>()).results.map((r) => r.proposal_id);
  const ledger = svc.ledger(l.org_id);
  for (const id of new Set([l.proposal_id, ...parts])) {
    const idx = await getProposalIndex(svc, l.org_id, id);
    if (idx && idx.kind !== "staging") continue; // only landing proposals
    const p = await ledger.getProposal(id);
    if (!p || (p.state !== "open" && p.state !== "prepared")) continue;
    await ledger.putProposal({ ...p, state });
    await recordEvent(svc, { orgId: l.org_id, projectId: l.project_id, actor: RELEASE_SERVICE, action: `proposal.${state}`, subjectKind: "proposal", subjectId: id, resourceIds: proposalResourceIds(p), detail: { landingId: l.landing_id, staging: true } });
  }
}

/** The event of a landing move (for moves written in a batch elsewhere, e.g. promotions). */
export async function recordLandingEvent(svc: Services, l: LandingRow, state: LandingState, reason?: Reason): Promise<void> {
  await recordEvent(svc, {
    orgId: l.org_id,
    projectId: l.project_id,
    actor: RELEASE_SERVICE,
    action: ACTION[state],
    subjectKind: "task",
    subjectId: l.task_id,
    detail: { landingId: l.landing_id, ...(reason ? { code: reason.code, reason: reason.text, ...(reason.detail ? { detail: reason.detail.slice(0, 2000) } : {}) } : {}) },
    clientVisible: true,
    // clients may read other clients' landing events: codes only (the view gives each their own reason)
    clientDetail: { landingId: l.landing_id, ...(reason ? { code: reason.code } : {}) },
  });
}

/**
 * Called when staging fails a `promoting` landing (its change is no longer available): the
 * promotion service registers the handler that supersedes the in-flight promotion containing it
 * (a hook, so this module does not import the promotion service).
 */
let promotingLandingFailed: ((svc: Services, l: LandingRow) => Promise<void>) | null = null;
export function onPromotingLandingFailed(fn: (svc: Services, l: LandingRow) => Promise<void>): void {
  promotingLandingFailed = fn;
}

/**
 * Called when a landing fails or is rolled back (it left staging for good): the file change service
 * registers the handler that fails the file changes staged through its parts (a hook, so this
 * module does not import the file change service, which imports it).
 */
let landingLeftStaging: ((svc: Services, l: LandingRow, state: "failed" | "rolled_back", reason?: Reason) => Promise<void>) | null = null;
export function onLandingLeftStaging(fn: (svc: Services, l: LandingRow, state: "failed" | "rolled_back", reason?: Reason) => Promise<void>): void {
  landingLeftStaging = fn;
}

/**
 * Called when a revision is about to join a `promoting` landing: the promotion service ends the
 * promotion when it has not started accepting (and repairs a leftover `promoting` landing).
 * Resolves true when the landing may have left `promoting` (look again), false to wait (accepting).
 */
let promotingLandingRevised: ((svc: Services, l: LandingRow) => Promise<boolean>) | null = null;
export function onPromotingLandingRevised(fn: (svc: Services, l: LandingRow) => Promise<boolean>): void {
  promotingLandingRevised = fn;
}

function stagingOf(project: ProjectRow | null) {
  const s = project ? stagingPolicyOf(project) : null;
  if (!s) throw conflict("staging_not_configured", "this project has no staging (owner: add a staging section to the policy)");
  return s;
}

/** `staging_json` entries that are well-formed; anything else falls back to the head. */
function validShas(json: string | null): Shas {
  let v: unknown;
  try {
    v = json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Shas = {};
  for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
    const x = e as { sha?: unknown; revisionId?: unknown } | null;
    if (x && typeof x === "object" && typeof x.sha === "string" && typeof x.revisionId === "string") out[k] = { sha: x.sha, revisionId: x.revisionId };
  }
  return out;
}

/** Git mounts staging builds from: everything the (staging or release) recipe and the targets read; sha from `shas`, else the head. */
async function stagingSources(svc: Services, project: ProjectRow, shas: Shas) {
  const { staging, release } = stagingOf(project);
  const recipe = staging.recipe ?? release.recipe;
  const needed = new Set<string>([...recipe.steps.map((s) => s.mountName as string), ...release.targets.map((t) => t.mountName as string)]);
  const mounts = await listMounts(svc.db, project.org_id, project.project_id);
  const ledger = svc.ledger(project.org_id);
  const out: Array<{ resourceId: string; mountName: string; canonical: RepoCoords; sha: string; revisionId: string }> = [];
  for (const mountName of [...needed].sort()) {
    const m = mounts.find((x) => x.mount_name === mountName);
    if (!m) throw conflict("release_mount_missing", `the release recipe needs mount ${mountName}, which this project does not have`);
    const head = await ledger.getHead(m.resource_id);
    if (!head) throw conflict("resource_not_ready", `mount ${mountName} has no accepted version yet`);
    const rev = parseRevisionId(head.revisionId);
    if (rev.kind !== "art") throw conflict("release_mount_unsupported", `mount ${mountName} is not a git resource`);
    const r = await getResource(svc.db, project.org_id, m.resource_id);
    const coords = r ? resourceCoords(r) : null;
    if (!coords || coords.kind !== "artifacts") throw conflict("resource_not_ready", `no canonical repository for ${mountName}`);
    const info = await svc.transport.getRepo(coords.namespace, coords.repoName);
    if (!info || info.id !== coords.repoId) throw conflict("repo_mismatch", `canonical repository of ${mountName} changed`);
    const staged = shas[m.resource_id];
    out.push({ resourceId: m.resource_id, mountName, canonical: repoInfoCoords(coords.namespace, info), sha: staged?.sha ?? (rev as { sha: string }).sha, revisionId: staged?.revisionId ?? head.revisionId });
  }
  return out;
}

async function captureUrl(svc: Services, orgId: string, projectId: string): Promise<string> {
  const base = (svc.env.COMMONFORGE_PUBLIC_URL || svc.env.COMMONFORGE_APP_URL).replace(/\/$/, "");
  return `${base}/api/sink/${await ensureSink(svc, orgId, projectId)}`;
}

/**
 * The waiting reason goes once a build lists the landings (every build lists every `checking`
 * landing), in any state: a landing a build already carried must not keep it.
 */
async function clearAwaitingBaseline(svc: Services, orgId: string, projectId: string): Promise<void> {
  await svc.db
    .prepare("UPDATE staging_landings SET reason_code = NULL, reason = NULL, updated_at = ? WHERE org_id = ? AND project_id = ? AND reason_code = 'awaiting_baseline'")
    .bind(svc.nowIso(), orgId, projectId)
    .run();
}

/**
 * Landings that waited for the owner baseline (B6) get their build once it exists. State-based, not
 * "just established": a kick that failed or was cut short (the reason is cleared only after the
 * build is requested) is repeated by the next production go-live, policy save or GC run. A no-op
 * without a baseline or without waiting landings.
 */
export async function kickAfterBaseline(svc: Services, orgId: string, projectId: string): Promise<void> {
  if (!(await getBaseline(svc, orgId, projectId))) return;
  const waiting = (await svc.db.prepare("SELECT * FROM staging_landings WHERE org_id = ? AND project_id = ? AND reason_code = 'awaiting_baseline' ORDER BY seq").bind(orgId, projectId).all<LandingRow>()).results;
  if (waiting.length === 0) return;
  for (const l of waiting) {
    if (l.state === "checking" && !(await buildListing(svc, l))) {
      await requestBuild(svc, orgId, projectId, l.created_by); // clears the reasons itself
      return;
    }
  }
  await clearAwaitingBaseline(svc, orgId, projectId);
}

/** GC (and the hooks below): establish the baseline when it can be, then kick waiting landings. */
export async function settleBaseline(svc: Services, orgId: string, projectId: string): Promise<void> {
  if (await establishBaseline(svc, orgId, projectId)) await kickAfterBaseline(svc, orgId, projectId);
}

/** GC: every project of the org with landings still waiting for the baseline. */
export async function settleWaitingBaselines(svc: Services, orgId: string): Promise<void> {
  const rows = (await svc.db.prepare("SELECT DISTINCT project_id FROM staging_landings WHERE org_id = ? AND reason_code = 'awaiting_baseline'").bind(orgId).all<{ project_id: string }>()).results;
  for (const r of rows) await settleBaseline(svc, orgId, r.project_id);
}

// the owner's production publish that makes production equal `main` starts staging (B6)
onProductionLive((svc, rel) => settleBaseline(svc, rel.org_id, rel.project_id));

/**
 * A `queued` build of every landing that is in staging — `checking`, `landed` or `promoting` (in
 * `seq` order; never `rolling_back`, `rolled_back`, `failed` or `promoted`), and its
 * `staging.advance` step. Only the newest queued
 * build of a project runs; older queued ones are superseded. Null (nothing built) until the
 * project has its owner baseline (B6).
 */
export async function requestBuild(svc: Services, orgId: string, projectId: string, userId: string, opts: { reset?: boolean } = {}): Promise<string | null> {
  if (!(await establishBaseline(svc, orgId, projectId))) return null;
  const ids = (await svc.db.prepare("SELECT landing_id FROM staging_landings WHERE org_id = ? AND project_id = ? AND state IN ('checking', 'landed', 'promoting') ORDER BY seq").bind(orgId, projectId).all<{ landing_id: string }>()).results.map((r) => r.landing_id);
  const buildId = newId("stg", 12);
  for (let attempt = 0; ; attempt++) {
    const now = svc.nowIso();
    try {
      await svc.db
        .prepare(
          // a reset still queued is carried into this build (this one supersedes it)
          "INSERT INTO staging_builds (build_id, org_id, project_id, seq, landings_json, reset, state, created_by, created_at, updated_at) VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM staging_builds WHERE org_id = ? AND project_id = ?), ?, CASE WHEN ? = 1 OR EXISTS (SELECT 1 FROM staging_builds WHERE org_id = ? AND project_id = ? AND state = 'queued' AND reset = 1) THEN 1 ELSE 0 END, 'queued', ?, ?, ?)",
        )
        .bind(buildId, orgId, projectId, orgId, projectId, JSON.stringify(ids), opts.reset ? 1 : 0, orgId, projectId, userId, now, now)
        .run();
      break;
    } catch (e) {
      // two requests took the same seq: take the next one
      if (attempt >= 4 || !/UNIQUE/i.test(String((e as Error)?.message))) throw e;
    }
  }
  // the build lists every `checking` landing: none waits for the baseline any more
  await clearAwaitingBaseline(svc, orgId, projectId);
  await enqueueStep(svc, { type: "staging.advance", orgId, buildId });
  return buildId;
}

/** Does a queued or in-flight build of the project list this landing? */
async function buildListing(svc: Services, l: Pick<LandingRow, "org_id" | "project_id" | "landing_id">): Promise<boolean> {
  return !!(await svc.db
    .prepare("SELECT 1 FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'merging', 'building', 'deploying') AND instr(landings_json, ?) > 0")
    .bind(l.org_id, l.project_id, JSON.stringify(l.landing_id))
    .first());
}

/** The landing goes `rolling_back` and a build without it is requested; false when it was not open (already taken out). */
async function rollbackLanding(svc: Services, l: LandingRow, userId: string): Promise<boolean> {
  if (!(await setLanding(svc, l, ["checking", "landed"], "rolling_back"))) return false;
  await requestBuild(svc, l.org_id, l.project_id, userId);
  return true;
}

/** A failed or canceled task's `checking` landing that no build lists yet: left by a `land` that died before it re-read the task. */
async function rollbackUnbuilt(svc: Services, orgId: string, taskId: string, userId: string): Promise<void> {
  const l = await svc.db.prepare("SELECT * FROM staging_landings WHERE org_id = ? AND task_id = ? AND state = 'checking'").bind(orgId, taskId).first<LandingRow>();
  if (l && !(await buildListing(svc, l))) await rollbackLanding(svc, l, userId);
}

/**
 * `staging.land`: a submitted task in a staging-mode project becomes a landing. Needs no lock: the
 * proposal id is deterministic, one open landing per task is a unique index, and a seq taken
 * concurrently is retried. A `checking` landing that no build lists (a step that died after the
 * insert) gets its build here. A landing created for a task that failed or was canceled meanwhile
 * (after the state was read; its rollback may have looked before the landing existed) is rolled
 * back, also on a redelivery after a step that died in between.
 */
export async function land(svc: Services, orgId: string, taskId: string, attempt = 1): Promise<StepOutcome> {
  const task = await getTask(svc, taskId);
  if (!task || task.org_id !== orgId) return { done: true };
  if (task.state !== "submitted") {
    if (task.state === "failed" || task.state === "canceled") await rollbackUnbuilt(svc, orgId, taskId, task.created_by);
    return { done: true };
  }
  const project = await getProject(svc.db, orgId, task.project_id);
  if (!project || !stagingPolicyOf(project)) return { done: true };
  const openLanding = () => svc.db.prepare("SELECT * FROM staging_landings WHERE org_id = ? AND task_id = ? AND state IN ('checking', 'landed', 'rolling_back', 'promoting')").bind(orgId, taskId).first<LandingRow>();
  const proposalId = `prop-stg-${(await sha256Hex(`cf.staging-land/1|${taskId}`)).slice(0, 32)}`;
  const open = await openLanding();
  if (open) {
    // repairs (review I1): part 1 and the index row of a landing whose step died half way
    await svc.db.prepare(PART_ONE_SQL).bind(open.landing_id).run();
    if (!(await getProposalIndex(svc, orgId, open.proposal_id))) {
      const r = await ensureLandingProposal(svc, task, open.proposal_id);
      if (r) return r;
    }
    if (open.state === "checking" && !(await buildListing(svc, open))) await requestBuild(svc, orgId, task.project_id, task.created_by);
    return { done: true };
  }
  let alone: Reason | null = null;
  if (task.revises_task_id) {
    const out = await landRevision(svc, task, proposalId, attempt);
    // else the revised landing left staging (or the wait ran out): this revision lands on its own
    if (!("alone" in out)) return out;
    alone = out.alone;
  }
  const r = await ensureLandingProposal(svc, task, proposalId);
  if (r) return r;
  // before the owner baseline (B6) the landing waits, saying so, and nothing is built
  const waiting: Reason | null = (await establishBaseline(svc, orgId, task.project_id)) ? null : { code: "awaiting_baseline", text: REASONS.awaitingBaseline };
  const reason = waiting ?? alone;
  for (let attempt = 0; attempt < 5; attempt++) {
    const landingId = newId("lnd", 12);
    const now = svc.nowIso();
    // OR IGNORE: another open landing of this task (unique index) or a seq taken concurrently (unique).
    // The landing and its first part (phase 2, R6: revisions append further parts) commit together.
    const [ins] = await svc.db.batch([
      svc.db
        .prepare(
          "INSERT OR IGNORE INTO staging_landings (landing_id, org_id, project_id, task_id, proposal_id, seq, state, created_by, created_at, updated_at, reason_code, reason) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM staging_landings WHERE org_id = ? AND project_id = ?), 'checking', ?, ?, ?, ?, ?)",
        )
        .bind(landingId, orgId, task.project_id, taskId, proposalId, orgId, task.project_id, task.created_by, now, now, reason?.code ?? null, reason?.text ?? null),
      svc.db.prepare(PART_ONE_SQL).bind(landingId),
    ]);
    if ((ins!.meta.changes ?? 0) > 0) {
      await recordEvent(svc, { orgId, projectId: task.project_id, actor: RELEASE_SERVICE, action: ACTION.checking, subjectKind: "task", subjectId: taskId, detail: { landingId, ...(reason ? { code: reason.code, reason: reason.text } : {}) }, clientVisible: true, clientDetail: { landingId, ...(reason ? { code: reason.code } : {}) } });
      // the task failed or was canceled after it was read above: whoever ended it may have looked for
      // a landing before this one existed (failChange, plan P3-6), so this landing leaves staging now
      const after = await getTask(svc, taskId);
      if (after && after.state !== "submitted") {
        const l = await landing(svc, landingId);
        if (l) await rollbackLanding(svc, l, task.created_by);
        return { done: true };
      }
      // the baseline may have been established since the check above: then this landing builds now
      await requestBuild(svc, orgId, task.project_id, task.created_by);
      return { done: true };
    }
    if (await openLanding()) return { done: true }; // a concurrent step landed it
  }
  return { retry: true, delaySeconds: 1, reason: "staging landing order is contended" };
}

/** Retry later, or (near the step's last attempt) continue in a fresh step: waiting can outlast the attempts. */
async function waitToLand(svc: Services, task: TaskRow, attempt: number, delaySeconds: number, reason: string): Promise<StepOutcome> {
  if (attempt < MAX_STEP_ATTEMPTS - 1) return { retry: true, delaySeconds, reason };
  await enqueueStep(svc, { type: "staging.land", orgId: task.org_id, taskId: task.task_id });
  return { done: true };
}

/** How long a revision waits for its landing to leave `promoting`/`rolling_back`, from the submit (the task's newest candidate). */
export const REVISION_WAIT_MS = 2 * 3600_000;

/**
 * A revision (staging phase 2, R6): the follow-up task's proposal joins the landing of the task it
 * revises as its next part; the landing goes `checking` until a build with it is live.
 *
 * A revision is applied in its landing's position (its `seq`), although it was seeded from a later
 * staging build: its change set is the diff from that build's commit, so it may depend on landings
 * that come after its landing. Promotion sets take this into account (`promotionSet`'s `after`,
 * from {@link baseLandings}); a build that fails because of it drops the new part, never the live
 * ones ({@link dropNewParts}).
 *
 * Returns `{ alone }` when the revision lands as a landing of its own: the revised landing is no
 * longer in staging — `promoted` (main has it; no reason), `failed`/`rolled_back` (reason
 * `revision_without_original`) — or it is still `promoting`/`rolling_back` {@link REVISION_WAIT_MS}
 * after the submit (reason `revision_landed_alone`). A landing in a promotion that has not started
 * accepting ends that promotion first (superseded, its clearance void); while one is accepting the
 * revision waits (and nudges it). Idempotent per task: a part is appended at most once (keyed by
 * task id), and never again after a build dropped it.
 */
async function landRevision(svc: Services, task: TaskRow, proposalId: string, attempt: number): Promise<StepOutcome | { alone: Reason | null }> {
  const orgId = task.org_id;
  if (await svc.db.prepare("SELECT 1 FROM events WHERE org_id = ? AND action = ? AND subject_id = ? LIMIT 1").bind(orgId, REVISION_DROPPED, task.task_id).first()) return { done: true };
  const submitted = (await svc.db.prepare("SELECT MAX(created_at) AS t FROM task_candidates WHERE task_id = ?").bind(task.task_id).first<{ t: string | null }>())?.t ?? task.updated_at;
  const late = svc.now().getTime() - Date.parse(submitted) > REVISION_WAIT_MS;
  // a retried step: the part is there; only a lost build request is repaired
  const joined = await svc.db
    .prepare("SELECT l.* FROM staging_landing_parts p JOIN staging_landings l ON l.landing_id = p.landing_id WHERE p.task_id = ? AND l.org_id = ? ORDER BY l.seq DESC LIMIT 1")
    .bind(task.task_id, orgId)
    .first<LandingRow>();
  if (joined) {
    if (joined.state === "checking" && !(await buildCarries(svc, joined))) await requestBuild(svc, orgId, joined.project_id, task.created_by);
    return { done: true };
  }
  for (let round = 0; round < 3; round++) {
    const target = await landingOfTask(svc, orgId, task.revises_task_id!);
    if (!target || target.project_id !== task.project_id || target.state === "promoted") return { alone: null };
    if (target.state === "failed" || target.state === "rolled_back") return { alone: { code: "revision_without_original", text: REASONS.revisionWithoutOriginal } };
    if (target.state === "rolling_back" || target.state === "promoting") {
      if (late) return { alone: { code: "revision_landed_alone", text: REASONS.revisionAlone } };
      if (target.state === "rolling_back") return waitToLand(svc, task, attempt, 10, "the revised task is leaving staging");
      if (!(await promotingLandingRevised?.(svc, target))) return waitToLand(svc, task, attempt, 10, "the revised task is being accepted into production");
      continue; // its promotion ended: look again
    }
    const r = await ensureLandingProposal(svc, task, proposalId);
    if (r) return r;
    const now = svc.nowIso();
    // one transaction: part 1 (repair), the new part (only while the landing is in staging and the
    // task is no part of any landing yet), and the landing back to `checking` when this write added it
    const [, ins] = await svc.db.batch([
      svc.db.prepare(PART_ONE_SQL).bind(target.landing_id),
      svc.db
        .prepare(
          "INSERT OR IGNORE INTO staging_landing_parts (landing_id, part, task_id, proposal_id, created_at) SELECT ?, (SELECT COALESCE(MAX(part), 0) + 1 FROM staging_landing_parts WHERE landing_id = ?), ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM staging_landing_parts WHERE task_id = ?) AND EXISTS (SELECT 1 FROM staging_landings WHERE landing_id = ? AND state IN ('checking', 'landed'))",
        )
        .bind(target.landing_id, target.landing_id, task.task_id, proposalId, now, task.task_id, target.landing_id),
      svc.db
        .prepare("UPDATE staging_landings SET state = 'checking', reason_code = NULL, reason = NULL, detail = NULL, updated_at = ? WHERE landing_id = ? AND state IN ('checking', 'landed') AND EXISTS (SELECT 1 FROM staging_landing_parts WHERE landing_id = ? AND task_id = ? AND created_at = ?)")
        .bind(now, target.landing_id, target.landing_id, task.task_id, now),
    ]);
    if ((ins!.meta.changes ?? 0) > 0) {
      const part = (await svc.db.prepare("SELECT part FROM staging_landing_parts WHERE landing_id = ? AND task_id = ?").bind(target.landing_id, task.task_id).first<{ part: number }>())!.part;
      await recordEvent(svc, {
        orgId,
        projectId: target.project_id,
        actor: RELEASE_SERVICE,
        action: ACTION.checking,
        subjectKind: "task",
        subjectId: target.task_id,
        detail: { landingId: target.landing_id, part, revisionTaskId: task.task_id },
        clientVisible: true,
        clientDetail: { landingId: target.landing_id, part },
      });
      await requestBuild(svc, orgId, target.project_id, task.created_by);
      return { done: true };
    }
    // a concurrent step appended it, or the landing moved meanwhile: look again
    if (await svc.db.prepare("SELECT 1 FROM staging_landing_parts WHERE task_id = ?").bind(task.task_id).first()) return { done: true };
  }
  return waitToLand(svc, task, attempt, 1, "the revised landing is changing");
}

/** Will a build put every part of this `checking` landing live: a queued build listing it, or a running one whose merge has them all? */
async function buildCarries(svc: Services, l: LandingRow): Promise<boolean> {
  const builds = (await svc.db.prepare("SELECT * FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'merging', 'building', 'deploying') AND instr(landings_json, ?) > 0").bind(l.org_id, l.project_id, JSON.stringify(l.landing_id)).all<BuildRow>()).results;
  for (const b of builds) if (b.state === "queued" || (await mergeCovers(svc, await mergedCandidates(svc, b), l)).covers) return true;
  return false;
}

/** A landing's first part, from the landing row (a no-op when the landing is missing or part 1 exists). */
const PART_ONE_SQL = "INSERT OR IGNORE INTO staging_landing_parts (landing_id, part, task_id, proposal_id, created_at) SELECT landing_id, 1, task_id, proposal_id, created_at FROM staging_landings WHERE landing_id = ?";

/**
 * The task's landing proposal in the ledger and its `proposals_index` row (kind `staging`); either
 * may be missing after a step died between the two writes (review I1). Returns a step outcome when
 * the landing cannot go on (yet), else null.
 */
async function ensureLandingProposal(svc: Services, task: TaskRow, proposalId: string): Promise<StepOutcome | null> {
  const orgId = task.org_id;
  const ledger = svc.ledger(orgId);
  const existing = await ledger.getProposal(proposalId);
  if (existing && (await getProposalIndex(svc, orgId, proposalId))) return null;
  const cands = (await svc.db.prepare("SELECT candidate_id FROM task_candidates WHERE task_id = ? ORDER BY candidate_id").bind(task.task_id).all<{ candidate_id: string }>()).results;
  const records = [];
  for (const c of cands) {
    const rec = await ledger.getCandidate(c.candidate_id);
    if (!rec) return { retry: true, delaySeconds: 3, reason: "candidate not recorded yet" };
    records.push(rec);
  }
  if (records.length === 0) return { done: true }; // nothing git-based to stage
  const built = await buildProposal(svc, task, proposalId, records, []);
  if (!existing) await ledger.putProposal(built.record);
  else if (existing.baseSnapshotId !== built.record.baseSnapshotId || existing.candidateSnapshotId !== built.record.candidateSnapshotId) {
    // the snapshots cannot be rebuilt as recorded (heads of a policy reference moved): the index stays missing
    console.warn(`staging: cannot rebuild the index row of ${proposalId} (snapshots changed)`);
    return null;
  }
  const record = existing ?? built.record;
  const indexed = await svc.db
    .prepare("INSERT OR IGNORE INTO proposals_index (proposal_id, org_id, project_id, task_id, base_snapshot_json, candidate_snapshot_json, created_by, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staging')")
    .bind(proposalId, orgId, task.project_id, task.task_id, JSON.stringify(built.baseSnapshot), JSON.stringify(built.candidateSnapshot), task.created_by, svc.nowIso())
    .run();
  // two concurrent steps (two workspaces frozen together): only the one that indexed it records the event
  if ((indexed.meta.changes ?? 0) > 0) await recordEvent(svc, {
    orgId,
    projectId: task.project_id,
    actor: userRef(task.created_by),
    action: "proposal.created",
    subjectKind: "proposal",
    subjectId: proposalId,
    resourceIds: proposalResourceIds(record),
    detail: { proposalHash: record.proposalHash, changeId: task.change_id, taskId: task.task_id, staging: true },
    clientVisible: true,
    clientDetail: { proposalHash: record.proposalHash, staging: true },
  });
  return null;
}

/**
 * The build failed: its `checking` landings (only `blame` when one landing is to blame) fail with
 * `reason`; the previous staging stays live. A rollback this build was carrying out is undone
 * (unless a newer build will carry it out); landings that were only waiting on this build get a
 * build of their own.
 */
async function failBuild(svc: Services, b: BuildRow, reason: Reason, blame?: string): Promise<void> {
  if (!(await setBuild(svc, b.build_id, ACTIVE, { state: "failed", error_code: reason.code, error: (reason.detail ?? reason.text).slice(0, 4000) }))) return;
  await recordEvent(svc, {
    orgId: b.org_id,
    projectId: b.project_id,
    actor: RELEASE_SERVICE,
    action: "staging.build_failed",
    subjectKind: "project",
    subjectId: b.project_id,
    detail: { buildId: b.build_id, code: reason.code, reason: reason.text, ...(reason.detail ? { detail: reason.detail.slice(0, 2000) } : {}) },
    clientVisible: true,
    clientDetail: { code: reason.code },
  });
  const ls = await landingsOf(svc, idsOf(b));
  const merged = await mergedCandidates(svc, b);
  let rebuild = false;
  for (const l of ls) {
    if (blame && l.landing_id !== blame) continue;
    if (blame && (l.state === "landed" || l.state === "promoting")) {
      // a landing that is live no longer merges (main moved under it, e.g. after a promotion): it
      // fails, its proposals are withdrawn (setLanding); a promotion of it is superseded by the
      // promoting-landing hook. Only when every part is live (a new part would be `checking`).
      const count = await partCount(svc, l.landing_id);
      const live = await liveParts(svc, l);
      const all = await landingParts(svc, l);
      if (live && !all.every((x) => live.has(x.part))) continue;
      if (await setLanding(svc, l, [l.state], "failed", { code: "conflicts_with_production", text: REASONS.conflictsWithProduction, detail: reason.detail ?? reason.text }, { parts: count })) rebuild = true;
      continue;
    }
    if (l.state !== "checking") continue;
    const c = await mergeCovers(svc, merged, l);
    // not blamed and with a revision the build did not merge: the next build decides
    if (!blame && !c.covers) continue;
    // checking only because of revisions that were never live: drop those, never the live parts
    if (await dropNewParts(svc, l, c.parts, reason)) {
      rebuild = true;
      continue;
    }
    await setLanding(svc, l, ["checking"], "failed", reason, { parts: c.parts });
  }
  const newer = await svc.db.prepare("SELECT 1 FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'merging', 'building', 'deploying') AND seq > ?").bind(b.org_id, b.project_id, b.seq).first();
  if (newer) return; // the newer build reflects every later rollback and landing
  const inBuild = new Set(ls.map((l) => l.landing_id));
  // a rollback this build was carrying out: the landing stays in staging only if the live build has it
  const cur = await currentStaging(svc, b.org_id, b.project_id);
  const liveBuild = cur ? await build(svc, cur.buildId) : null;
  const live = new Set(liveBuild ? idsOf(liveBuild) : []);
  const rolling = (await svc.db.prepare("SELECT * FROM staging_landings WHERE org_id = ? AND project_id = ? AND state = 'rolling_back'").bind(b.org_id, b.project_id).all<LandingRow>()).results;
  for (const l of rolling) {
    if (inBuild.has(l.landing_id)) continue;
    if (live.has(l.landing_id)) await setLanding(svc, l, ["rolling_back"], "landed", { code: "rollback_unfinished", text: REASONS.rollbackUnfinished, detail: reason.detail ?? reason.text });
    else await setLanding(svc, l, ["rolling_back"], "rolled_back"); // never live: it is not in staging
  }
  if (rebuild || (blame && ls.some((l) => l.state === "checking" && l.landing_id !== blame))) {
    if (await stagingStuck(svc, b)) {
      await recordEvent(svc, { orgId: b.org_id, projectId: b.project_id, actor: RELEASE_SERVICE, action: "staging.stuck", subjectKind: "project", subjectId: b.project_id, detail: { buildId: b.build_id, failedBuilds: STUCK_AFTER, code: reason.code, ...(reason.detail ? { detail: reason.detail.slice(0, 2000) } : {}) } });
      return;
    }
    await requestBuild(svc, b.org_id, b.project_id, b.created_by, { reset: !!b.reset });
  }
}

/** Failed builds in a row after which a failing build requests no further build by itself (`staging.stuck`, developers only). */
export const STUCK_AFTER = 5;

/** Are the project's last {@link STUCK_AFTER} builds up to `b` (superseded ones aside) all failed? */
async function stagingStuck(svc: Services, b: BuildRow): Promise<boolean> {
  const rows = (await svc.db.prepare("SELECT state FROM staging_builds WHERE org_id = ? AND project_id = ? AND seq <= ? AND state != 'superseded' ORDER BY seq DESC LIMIT ?").bind(b.org_id, b.project_id, b.seq, STUCK_AFTER).all<{ state: string }>()).results;
  return rows.length >= STUCK_AFTER && rows.every((r) => r.state === "failed");
}

/** A staging-build result (from the applier, or from the stored result when the applier did not finish). */
async function applyMergeResult(svc: Services, b: BuildRow, jobId: string, result: RunnerResult): Promise<void> {
  if (b.merge_job_id !== jobId || b.state !== "merging") return;
  if (!result.ok) {
    const blame = result.code === "textual_conflict" ? /^landing (\S+)/.exec(result.detail)?.[1] : undefined;
    const paths = (/: (.*)$/m.exec(result.detail)?.[1] ?? "").slice(0, 500);
    if (blame && idsOf(b).includes(blame) && paths) await failBuild(svc, b, { code: result.code, text: REASONS.conflict(paths), detail: result.detail, paths }, blame);
    else await failBuild(svc, b, { code: result.code, text: REASONS.merge, detail: result.detail });
    return;
  }
  // the receipt's shas are authoritative (multi-target pushes are not atomic): never re-read the ref
  const receipt = result.receipt as StagingBuildReceipt;
  const shas: Shas = Object.fromEntries(receipt.results.map((r) => [r.resourceId, { sha: r.sha, revisionId: r.revisionId }]));
  // the build's own `staging.advance` chain (polling `merging`) picks it up: one chain per build
  await setBuild(svc, b.build_id, ["merging"], { state: "building", staging_json: JSON.stringify(shas) });
}

onRunnerResult("staging-build", async (svc, row: RunnerJobRow, job: IntegrationJob, result: RunnerResult) => {
  if (job.kind !== "staging-build") return;
  const b = await build(svc, job.buildId);
  if (!b || b.org_id !== row.org_id) return;
  await applyMergeResult(svc, b, row.job_id, result);
});

/** `queued`: supersede or wait, check every landing's candidates, issue the `staging-build` job. */
async function startMerge(svc: Services, b: BuildRow, project: ProjectRow): Promise<Next> {
  // any newer build (whatever its state) makes this one obsolete; a reset asked for here is carried over
  const newest = await svc.db
    .prepare("SELECT * FROM staging_builds WHERE org_id = ? AND project_id = ? AND state != 'superseded' AND seq > ? ORDER BY seq DESC LIMIT 1")
    .bind(b.org_id, b.project_id, b.seq)
    .first<BuildRow>();
  if (newest) {
    if (b.reset && !newest.reset) {
      const carried = newest.state === "queued" && (await setBuild(svc, newest.build_id, ["queued"], { reset: 1 }));
      if (!carried) await requestBuild(svc, b.org_id, b.project_id, b.created_by, { reset: true });
    }
    await setBuild(svc, b.build_id, ["queued"], { state: "superseded" });
    return DONE;
  }
  // one build past `queued` per project: the serialization point for staging D1/KV
  const busy = await svc.db.prepare("SELECT * FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('merging', 'building', 'deploying') AND build_id != ?").bind(b.org_id, b.project_id, b.build_id).first<BuildRow>();
  if (busy) {
    // a build whose chain was lost must not hold staging until its own step notices
    if (svc.now().getTime() - Date.parse(busy.created_at) > BUILD_DEADLINE_MS) {
      await failBuild(svc, busy, { code: "staging_build_timed_out", text: REASONS.stopped, detail: `no result after ${BUILD_DEADLINE_MS / 3600_000} h (state ${busy.state})` });
      return wait(1, "a stuck staging build was failed");
    }
    return wait(5, "another staging build is in progress");
  }
  const ledger = svc.ledger(b.org_id);
  const now = svc.now().getTime();
  // landings that failed, were rolled back or promoted since the build was requested are left out
  const ls = (await landingsOf(svc, idsOf(b))).filter((l) => IN_STAGING.includes(l.state));
  const landings: Array<{ landingId: string; candidates: Array<{ resourceId: string; candidateId: string; sha: string; baseSha: string }> }> = [];
  let pending: string | null = null;
  for (const l of ls) {
    // every part (the task and its revisions, R6) in part order, each candidate with its own staging base
    const changes = [];
    let missing = false;
    for (const part of await landingParts(svc, l)) {
      const p = await ledger.getProposal(part.proposalId);
      if (!p) missing = true;
      else changes.push(...p.resourceChanges);
    }
    if (missing) {
      pending = "landing proposal not recorded yet";
      continue;
    }
    const candidates = [];
    let drop: string | null = null;
    for (const c of changes) {
      const rec = await ledger.getCandidate(c.candidateId);
      const base = rec ? revisionCommitSha(rec.candidate.baseRevision) : null;
      if (!rec || !base || rec.state === "rejected" || rec.state === "superseded") {
        drop = REASONS.withdrawn;
        break;
      }
      if (rec.state === "frozen") {
        if (now - Date.parse(rec.updatedAt) > PREPARE_DEADLINE_MS) {
          drop = REASONS.notPrepared;
          break;
        }
        pending = `candidate ${c.candidateId} is not prepared yet`;
        continue;
      }
      candidates.push({ resourceId: c.resourceId as string, candidateId: c.candidateId as string, sha: rec.candidate.sha, baseSha: base });
    }
    if (drop) {
      await setLanding(svc, l, ["checking", "landed", "promoting"], "failed", { code: "candidate_unavailable", text: drop });
      continue;
    }
    landings.push({ landingId: l.landing_id, candidates });
  }
  if (pending) return wait(3, pending);
  // every release mount is merged (even untouched ones), so staging_json names a sha for each
  const sources = await stagingSources(svc, project, {});
  const targets = sources.map((s) => ({
    resourceId: s.resourceId,
    canonical: s.canonical,
    mainSha: s.sha,
    landings: landings
      .map((l) => ({ landingId: l.landingId, candidates: l.candidates.filter((c) => c.resourceId === s.resourceId).map(({ resourceId: _r, ...c }) => c) }))
      .filter((l) => l.candidates.length > 0),
  }));
  const ids = landings.map((l) => l.landingId);
  await issueJob(svc, { kind: "staging-build", buildId: b.build_id, targets } as IntegrationJobInput, {
    orgId: b.org_id,
    subject: `staging:${b.build_id}`,
    lifetimeSeconds: 3600,
    beforeEnqueue: async (jobId) =>
      void (await svc.db.prepare("UPDATE staging_builds SET merge_job_id = ?, landings_json = ?, state = 'merging', updated_at = ? WHERE build_id = ? AND state = 'queued'").bind(jobId, JSON.stringify(ids), svc.nowIso(), b.build_id).run()),
  });
  return wait(10, "staging merge running");
}

/** `merging`: the applier moves the build on; a stored result it did not apply is applied here, a lost job fails the build. */
async function watchMerge(svc: Services, b: BuildRow): Promise<Next> {
  const job = b.merge_job_id ? await getJob(svc, b.merge_job_id) : null;
  if (!job) {
    await failBuild(svc, b, { code: "staging_merge_lost", text: REASONS.merge, detail: "the staging-build job record is missing" });
    return DONE;
  }
  if (job.status !== "queued" && job.result_json) {
    // the stored result (the applier has not run, or threw): apply it and keep this chain going
    await applyMergeResult(svc, b, job.job_id, JSON.parse(job.result_json) as RunnerResult);
    return wait(1, "staging merge applied");
  }
  if (job.status === "queued" && job.expires_at + RESULT_GRACE_MS < svc.now().getTime()) {
    await failBuild(svc, b, { code: "staging_merge_lost", text: REASONS.merge, detail: "the staging-build job ended without a result" });
    return DONE;
  }
  return wait(10, "staging merge running");
}

/** `building`: prepare the staging release (fresh data on reset), wait for it, apply data, deploy. */
async function buildAndDeploy(svc: Services, b: BuildRow, project: ProjectRow): Promise<Next> {
  const policy = stagingOf(project);
  const resetVersion = `staging-${b.build_id}-r`;
  if (!b.release_id) {
    const shas = validShas(b.staging_json);
    let rel: ReleaseRow;
    if (b.reset) {
      // a reset release already prepared (a retried step) is reused rather than resetting twice
      const prior = await svc.db
        .prepare("SELECT release_id FROM releases WHERE org_id = ? AND project_id = ? AND channel = 'staging' AND accepted_version_id = ? AND build_state != 'failed'")
        .bind(b.org_id, b.project_id, resetVersion)
        .first<{ release_id: string }>();
      const resources = prior ? [] : await resetStagingResources(svc, project, policy.staging);
      rel = await prepareStagingRelease(svc, { orgId: b.org_id, projectId: b.project_id, userId: b.created_by, buildId: `${b.build_id}-r`, sources: await stagingSources(svc, project, shas), staging: policy.staging, release: policy.release, resources, captureUrl: await captureUrl(svc, b.org_id, b.project_id) });
      if (!prior) await recordEvent(svc, { orgId: b.org_id, projectId: b.project_id, actor: RELEASE_SERVICE, action: "staging.reset", subjectKind: "project", subjectId: b.project_id, detail: { buildId: b.build_id, releaseId: rel.release_id }, clientVisible: true, clientDetail: {} });
    } else {
      const resources = await ensureStagingResources(svc, project, policy.staging);
      rel = await prepareStagingRelease(svc, { orgId: b.org_id, projectId: b.project_id, userId: b.created_by, buildId: b.build_id, sources: await stagingSources(svc, project, shas), staging: policy.staging, release: policy.release, resources, captureUrl: await captureUrl(svc, b.org_id, b.project_id) });
    }
    await setBuild(svc, b.build_id, ["building"], { release_id: rel.release_id });
    return wait(5, "staging release building");
  }
  const rel = await getRelease(svc, b.org_id, b.release_id);
  if (!rel) {
    await failBuild(svc, b, { code: "staging_release_missing", text: REASONS.build, detail: `release ${b.release_id} is missing` });
    return DONE;
  }
  if (rel.build_state === "failed") {
    await failBuild(svc, b, { code: rel.error_code ?? "build_failed", text: REASONS.build, detail: rel.error ?? "the release build failed" });
    return DONE;
  }
  if (rel.build_state !== "built") return wait(5, "staging release building");
  if (rel.state === "publish_approved" && rel.deploy_attempts === 0) {
    const receipt = JSON.parse(rel.build_receipt_json!);
    if (rel.accepted_version_id !== resetVersion && (b.reset || (await stagingMigrationsNeedReset(svc, project, receipt, policy.staging)))) {
      // the migrations rewrote history (or a reset was asked for): fresh data, and a release bound to it
      await setBuild(svc, b.build_id, ["building"], { reset: 1, release_id: null });
      return wait(1, "staging data needs a reset");
    }
    try {
      await applyStagingData(svc, { org_id: b.org_id, project_id: b.project_id, output_prefix: `org/${b.org_id}/releases/${rel.release_id}/` }, receipt, policy.staging);
    } catch (e) {
      // a transient Cloudflare answer (5xx, 429, no response) retries: applied migrations are
      // recorded per file, so the next attempt continues; the build deadline bounds the retries
      if (e instanceof DeployApiError && e.transient) return wait(15, "staging data: the provider is unavailable, retrying");
      await failBuild(svc, b, { code: "staging_data_failed", text: REASONS.data, detail: String((e as Error)?.message ?? e) });
      return DONE;
    }
    try {
      await startStagingDeploy(svc, rel, b.created_by);
    } catch (e) {
      if (e instanceof ApiError && e.code === "deploy_in_progress") return wait(10, "another staging deploy is in progress");
      await failBuild(svc, b, { code: e instanceof ApiError ? e.code : "deploy_not_started", text: REASONS.deployNotStarted, detail: String((e as Error)?.message ?? e) });
      return DONE;
    }
  }
  await setBuild(svc, b.build_id, ["building"], { state: "deploying" });
  return wait(10, "staging deploying");
}

/** `deploying`: live → landings land, rolled-back ones leave, retired data is deleted; failed → the previous staging stays. */
async function watchDeploy(svc: Services, b: BuildRow): Promise<Next> {
  const rel = b.release_id ? await getRelease(svc, b.org_id, b.release_id) : null;
  if (!rel) {
    await failBuild(svc, b, { code: "staging_release_missing", text: REASONS.deployUnverified, detail: `release ${b.release_id} is missing` });
    return DONE;
  }
  if (rel.state === "live") {
    // landings first (idempotent), then the build: a step that dies in between retries this branch
    // with the build still `deploying`, never leaving a live build whose landings stay `checking`
    const inBuild = new Set(idsOf(b));
    const merged = await mergedCandidates(svc, b);
    const open = (await svc.db.prepare("SELECT * FROM staging_landings WHERE org_id = ? AND project_id = ? AND state IN ('checking', 'rolling_back')").bind(b.org_id, b.project_id).all<LandingRow>()).results;
    let unmerged = false;
    for (const l of open) {
      if (l.state === "checking" && inBuild.has(l.landing_id)) {
        // a revision appended after this build's merge: still checking until a build with it is live
        const c = await mergeCovers(svc, merged, l);
        if (!c.covers || !(await markLandedIfParts(svc, l, c.parts))) unmerged = true;
      }
      if (l.state === "rolling_back" && !inBuild.has(l.landing_id)) await setLanding(svc, l, ["rolling_back"], "rolled_back");
    }
    if (!(await setBuild(svc, b.build_id, ["deploying"], { state: "live" }))) return DONE;
    if (unmerged && !(await svc.db.prepare("SELECT 1 FROM staging_builds WHERE org_id = ? AND project_id = ? AND state = 'queued' AND seq > ?").bind(b.org_id, b.project_id, b.seq).first())) await requestBuild(svc, b.org_id, b.project_id, b.created_by);
    await deleteRetired(svc, b.org_id, b.project_id);
    return DONE;
  }
  if (rel.state === "recovery_required" && (rel.rollback_state === "running" || rel.rollback_state === "verifying")) return wait(10, "staging rolling back to the previous release");
  if (rel.state === "failed" || rel.state === "partial") {
    const previous = !!(await currentStaging(svc, b.org_id, b.project_id));
    await failBuild(svc, b, { code: rel.error_code ?? "deploy_failed", text: REASONS.deploy(previous), detail: rel.error ?? rel.state });
    return DONE;
  }
  if (rel.state === "recovery_required") {
    await failBuild(svc, b, { code: rel.error_code ?? "deploy_unverified", text: REASONS.deployUnverified, detail: rel.error ?? rel.state });
    return DONE;
  }
  // a lost deploy job must not hold staging forever
  await sweepStaleReleases(svc, b.org_id, b.project_id, "staging");
  return wait(10, "staging deploying");
}

async function next(svc: Services, buildId: string): Promise<Next> {
  const b = await build(svc, buildId);
  if (!b || !ACTIVE.includes(b.state)) return DONE;
  if (svc.now().getTime() - Date.parse(b.created_at) > BUILD_DEADLINE_MS) {
    await failBuild(svc, b, { code: "staging_build_timed_out", text: REASONS.stopped, detail: `no result after ${BUILD_DEADLINE_MS / 3600_000} h (state ${b.state})` });
    return DONE;
  }
  const project = await getProject(svc.db, b.org_id, b.project_id);
  if (!project || !stagingPolicyOf(project)) {
    await failBuild(svc, b, { code: "staging_not_configured", text: REASONS.off });
    return DONE;
  }
  switch (b.state) {
    case "queued":
      return startMerge(svc, b, project);
    case "merging":
      return watchMerge(svc, b);
    case "building":
      return buildAndDeploy(svc, b, project);
    case "deploying":
      return watchDeploy(svc, b);
    default:
      return DONE;
  }
}

/** `staging.advance`: one build, one next step per call, under the project's staging lock. */
export async function advance(svc: Services, orgId: string, buildId: string, attempt = 1): Promise<StepOutcome> {
  const b = await build(svc, buildId);
  if (!b || b.org_id !== orgId || !ACTIVE.includes(b.state)) return { done: true };
  const out = await svc.gate.withLock("staging", `${orgId}:${b.project_id}`, LOCK_MS, () => next(svc, buildId));
  const n: Next = out.locked ? wait(3, "another staging step holds this project") : out.value;
  if ("done" in n) return { done: true };
  // waiting on the runner or a deploy can outlast the step's attempts: continue in a fresh step
  if (attempt >= MAX_STEP_ATTEMPTS - 1) {
    await enqueueStep(svc, { type: "staging.advance", orgId, buildId });
    return { done: true };
  }
  return { retry: true, delaySeconds: n.wait, reason: n.reason };
}

onStep("staging.land", (svc, msg, attempt) => land(svc, msg.orgId, msg.taskId, attempt));
onStep("staging.advance", (svc, msg, attempt) => advance(svc, msg.orgId, msg.buildId, attempt));

onStepFailed("staging.land", async (svc, msg, reason) => {
  const task = await getTask(svc, msg.taskId);
  if (!task || task.org_id !== msg.orgId) return;
  await recordEvent(svc, { orgId: task.org_id, projectId: task.project_id, actor: RELEASE_SERVICE, action: "staging.land_failed", subjectKind: "task", subjectId: task.task_id, detail: { reason }, clientVisible: true, clientDetail: { code: "land_failed" } });
});
onStepFailed("staging.advance", async (svc, msg, reason) => {
  const b = await build(svc, msg.buildId);
  if (!b || b.org_id !== msg.orgId || !ACTIVE.includes(b.state)) return;
  await failBuild(svc, b, { code: "staging_step_failed", text: REASONS.stopped, detail: reason });
});

/**
 * Take a task out of staging: its landing goes `rolling_back` and a build without it is requested.
 * A `promoting` landing is in staging but cannot leave while its promotion is in flight (a developer
 * sends the promotion back first). Before the owner baseline (B6) a waiting landing was never built:
 * it leaves at once (`rolled_back`; no build, null).
 */
export async function rollbackTask(svc: Services, orgId: string, taskId: string, userId: string): Promise<string | null> {
  // the task's own landing or the one it joined as a revision: every part leaves together
  const l = await landingOfTask(svc, orgId, taskId, IN_STAGING);
  if (l?.state === "promoting") throw conflict("promotion_in_progress", "this task is being promoted to production; a developer can send the promotion back first");
  if (!l) throw conflict("not_in_staging", "this task is not in staging");
  if (l.state === "checking" && !(await establishBaseline(svc, orgId, l.project_id)) && !(await buildListing(svc, l))) {
    if (!(await setLanding(svc, l, ["checking"], "rolled_back"))) throw conflict("not_in_staging", "this task is not in staging");
    // the baseline arrived meanwhile: a build without it replaces any build that listed it
    return (await getBaseline(svc, orgId, l.project_id)) ? requestBuild(svc, orgId, l.project_id, userId) : null;
  }
  if (!(await setLanding(svc, l, ["checking", "landed"], "rolling_back"))) throw conflict("not_in_staging", "this task is not in staging");
  return requestBuild(svc, orgId, l.project_id, userId);
}

/** Rebuild staging on fresh D1/KV (migrations and demo data from scratch); refused before the owner baseline (B6). */
export async function resetStaging(svc: Services, orgId: string, projectId: string, userId: string): Promise<string | null> {
  stagingOf(await getProject(svc.db, orgId, projectId));
  if (!(await establishBaseline(svc, orgId, projectId))) throw conflict("staging_awaiting_baseline", "Staging starts after the owner's first production publish");
  return requestBuild(svc, orgId, projectId, userId, { reset: true });
}

/** The project's staging as a reader sees it: clients and viewers get their own landings' platform text only. */
export async function stagingView(svc: Services, orgId: string, projectId: string, viewer: { userId: string; role: string }) {
  const project = await getProject(svc.db, orgId, projectId);
  const s = project ? stagingPolicyOf(project) : null;
  if (!s) return { enabled: false, url: null, current: null, building: false, landings: [] };
  const cur = await currentStaging(svc, orgId, projectId);
  // B6: a GET never writes, so only an established baseline counts here
  const baseline = await getBaseline(svc, orgId, projectId);
  const building = !!(await svc.db.prepare("SELECT 1 FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'merging', 'building', 'deploying')").bind(orgId, projectId).first());
  const health = s.release.targets.find((t) => t.targetId === s.release.healthCheck.targetId);
  const account = svc.env.COMMONFORGE_DEPLOY_ACCOUNT_ID || svc.env.CF_ACCOUNT_ID;
  const sub = health && account ? await svc.deps.deployApi(svc.env).workersSubdomain(account).catch(() => null) : null;
  let url: string | null = null;
  try {
    url = sub && health ? `https://${stagingWorkerName(health.workerName)}.${sub}.workers.dev` : null;
  } catch {
    url = null;
  }
  const rows = (await svc.db.prepare("SELECT l.*, t.title FROM staging_landings l JOIN tasks t ON t.task_id = l.task_id WHERE l.org_id = ? AND l.project_id = ? ORDER BY l.seq DESC LIMIT 100").bind(orgId, projectId).all<LandingRow & { title: string }>()).results;
  const developer = viewer.role === "owner" || viewer.role === "developer";
  const own = (l: LandingRow) => developer || l.created_by === viewer.userId;
  // staging phase 2: each landing's newest promotion (id and state; the promotion view has the rest)
  const promotionOf = new Map<string, { promotionId: string; state: string }>();
  const promos = (await svc.db.prepare("SELECT promotion_id, state, landings_json FROM promotions WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200").bind(orgId, projectId).all<{ promotion_id: string; state: string; landings_json: string }>()).results;
  for (const pr of promos) {
    let ids: unknown;
    try {
      ids = JSON.parse(pr.landings_json);
    } catch {
      ids = [];
    }
    for (const id of Array.isArray(ids) ? ids : []) if (typeof id === "string" && !promotionOf.has(id)) promotionOf.set(id, { promotionId: pr.promotion_id, state: pr.state });
  }
  // staging phase 2 (R6): each landing's parts (the task and its revisions), for those who see its reasons
  const partsOf = new Map<string, Array<{ part: number; taskId: string }>>();
  const partRows = (await svc.db.prepare("SELECT p.landing_id, p.part, p.task_id FROM staging_landing_parts p JOIN staging_landings l ON l.landing_id = p.landing_id WHERE l.org_id = ? AND l.project_id = ? ORDER BY p.landing_id, p.part").bind(orgId, projectId).all<{ landing_id: string; part: number; task_id: string }>()).results;
  for (const r of partRows) partsOf.set(r.landing_id, [...(partsOf.get(r.landing_id) ?? []), { part: r.part, taskId: r.task_id }]);
  // staging phase 2b (B9): travel-with links, for owners and developers
  const travels = new Map<string, string[]>();
  if (developer) {
    const links = (await svc.db.prepare("SELECT landing_id, with_landing_id FROM staging_landing_links WHERE org_id = ? AND project_id = ? ORDER BY created_at, with_landing_id").bind(orgId, projectId).all<{ landing_id: string; with_landing_id: string }>()).results;
    for (const r of links) travels.set(r.landing_id, [...(travels.get(r.landing_id) ?? []), r.with_landing_id]);
  }
  return {
    enabled: true,
    state: baseline ? "active" : "awaiting_baseline",
    stateText: baseline ? null : REASONS.awaitingBaseline,
    baseline: baseline ? { ...(developer ? { releaseId: baseline.release_id } : {}), since: baseline.established_at } : null,
    url,
    current: cur ? { buildId: cur.buildId, since: cur.since } : null,
    building,
    landings: rows.map((l) => ({
      landingId: l.landing_id,
      taskId: l.task_id,
      title: l.title,
      state: l.state,
      reasonCode: own(l) ? l.reason_code : null,
      reason: own(l) ? l.reason : null,
      ...(developer ? { detail: l.detail } : {}),
      promotion: promotionOf.get(l.landing_id) ?? null,
      ...(own(l) ? { parts: partsOf.get(l.landing_id) ?? [{ part: 1, taskId: l.task_id }] } : {}),
      ...(developer ? { travelsWith: travels.get(l.landing_id) ?? [] } : {}),
      createdBy: l.created_by,
      createdAt: l.created_at,
    })),
  };
}

export function assertStagingProject(project: ProjectRow | null): asserts project is ProjectRow {
  if (!project || !stagingPolicyOf(project)) throw new ApiError(404, "not_found", "this project has no staging");
}
