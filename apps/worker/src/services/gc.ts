/**
 * Scheduled garbage collection and sweeps (plan §C.2 "fork cleanup = alarm-driven sweep every
 * 10 min with a 1 h grace", §F "Orphaned candidates/assets", §0.3 A2/A6/A9).
 *
 * Runs from the cron trigger (wrangler.jsonc, every 10 minutes). One run at a time: the whole run
 * holds the OpsGate lock `gc/sweep` (single-flight; a crashed run frees it when the lease ends).
 * Every phase is idempotent and failures are isolated per org and per phase.
 *
 * 1. Runner jobs past `expiresAt` + result grace without a result are closed (`job_expired`) and
 *    the tokens minted for them revoked.
 * 2. `running` tasks with no live lease (expired or released) and no activity for
 *    {@link ABANDON_AFTER_SECONDS} (7 days) are canceled; `ready` tasks are never canceled.
 *    Writable workspaces (task repos and read-only reference copies, N-4) of canceled, failed or
 *    submitted tasks are marked `abandoned` (D1 + ledger) and every token on them is revoked.
 * 3. Task repos are deleted (`collectWorkspace`) once older than the grace period when they are
 *    `abandoned`, or `frozen` with every candidate past `frozen` (the prepared candidate is retained
 *    in canonical, so the fork is no longer needed; the grace counts from the freeze, so a fork
 *    frozen long before its prepare finished goes on the first run after it). An abandoned task
 *    repo whose branch moved past its seeded base (pushed but never frozen work) is kept for
 *    {@link UNFROZEN_WORK_GRACE_SECONDS} more instead. Workspaces whose provisioning failed or got
 *    stuck may have left a repo, or a ghost name that only materializes later (A9: a create that
 *    answered 500): their recorded name is looked up and deleted on every run until a window ends.
 * 4. Stale canonical write tokens are revoked (`revokeStaleCanonicalWriteTokens`).
 * 5. Heads: the D1 `resource_heads` projection is refreshed, and heads still not `synced` some
 *    minutes after acceptance get a fresh `reconcile-ref` request leasing on the previous head
 *    (backstop for dead-lettered or lost outbox events; A6: events are never relied on). `pending`
 *    heads are re-requested every run, `diverged` ones with exponential backoff counted from the
 *    observed divergence.
 * 6. Assets: the reachable set is computed from the ledger and D1 (every accepted version's
 *    manifests, open proposals, live task workspaces, exports) no earlier than the run start, then
 *    `R2AssetProvider.collectUnreachable` deletes unreachable objects older than the grace period
 *    (re-listing manifests written during the run before deleting).
 * 7. LFS and file changes (`collectLfs`, the last phase of an org pass: its R2/D1 work is the most
 *    expendable, and every kind is capped at 100 rows, the settle sweep at 50): unfinished uploads
 *    (24 h) are aborted and dropped; uploads stuck in `uploaded` for 15 minutes (a lost hash step)
 *    get `lfs.hash` again, at most 3 times, then are rejected `hash_failed: gave up`; unaccepted
 *    LFS objects expire `COMMONFORGE_STAGING_TTL_DAYS` after their last use unless an open file
 *    change or a live task needs them (accepted objects are never deleted here); R2 artifacts of
 *    finished file changes and of orphaned change prefixes are deleted (the rows stay as history);
 *    open file changes idle for 2 minutes are settled (the read-time recovery, for changes nobody reads);
 *    verified objects without a pointer oid (verified before migration 0013) get one, 500 per pass.
 *    (Before it, folders phase 4: a new folder's setup still `pending` after 15 minutes with no
 *    running job gets `folders.init` again, `folderInitRequeued`.)
 */
import { nudgeStalePromotions, repairPromotingLandings } from "./promotions.js";
import { sweepStaleReleases } from "./releases.js";
import { lfsSettings, UNFINISHED_UPLOAD_TTL_HOURS } from "../lib/lfs-config.js";
import { FILE_CHANGE_STUCK_MS, OPEN_FILE_CHANGE_STATES_SQL, settleFileChange, type FileChangeRow } from "./file-changes.js";
import { enqueueHash, pointerOidOf, wakeFileChanges } from "./lfs-hash.js";
import { sweepCaptures } from "./sink.js";
import { settleWaitingBaselines } from "./staging.js";
import {
  parseRevisionId,
  type ProjectSnapshot,
  type TaskWorkspaceHandle,
  type TaskWorkspaceState,
} from "@commonforge-org/core";
import { taskWorkspaceRepoName } from "@commonforge-org/provider-cloudflare";
import type { Services } from "../context.js";
import type { ResourceRow } from "./directory.js";
import { recordEvent } from "./events.js";
import { reconcileRequest, refreshHeadProjections, SERVICE_ACTOR } from "./outbox-consumer.js";
import { RESULT_GRACE_MS, revokeJobTokens } from "./runner-jobs.js";
import { requeueStaleFolderInits } from "./folder-init.js";
import { refreshTaskState, revokeWorkspaceWriteTokens, setWorkspaceState, type TaskState, type WorkspaceRow } from "./tasks.js";

/** Task repos are deleted this long after they became collectable (plan §C.2: 1 h). */
export const GC_GRACE_SECONDS = 3600;
/** Cron cadence (wrangler.jsonc `*\/10 * * * *`). */
export const GC_SWEEP_INTERVAL_SECONDS = 600;
/** Lease of the single-flight lock (below the 15 min limit of a cron invocation). */
export const GC_LOCK_MS = 14 * 60_000;
/** A `running` task with no live lease and no activity for this long is canceled (controller ruling: 7 d). */
export const ABANDON_AFTER_SECONDS = 7 * 24 * 3600;
/** An abandoned task repo holding pushed-but-unfrozen commits is kept this long after abandonment. */
export const UNFROZEN_WORK_GRACE_SECONDS = 7 * 24 * 3600;
/** A run stops starting new org passes after this long (the lock lease is {@link GC_LOCK_MS}). */
export const GC_RUN_BUDGET_MS = 10 * 60_000;
/** A failed workspace's recorded repo name is checked for a late (ghost) repo this long. */
export const GHOST_WINDOW_SECONDS = 24 * 3600;
/** A workspace still `provisioning` after this long is failed (its step was lost). */
export const STUCK_PROVISIONING_SECONDS = 6 * 3600;
/** A head not `synced` this long after acceptance gets a fresh reconcile request. */
export const RECONCILE_STALE_SECONDS = 600;
/** At most this many repo deletions per org per run (bounded control-plane use, A9). */
export const MAX_COLLECT_PER_ORG = 200;

export interface GcOptions {
  /** restrict the pass to these organizations (default: every org in the directory) */
  orgs?: readonly string[];
  graceSeconds?: number;
  abandonAfterSeconds?: number;
  unfrozenWorkGraceSeconds?: number;
  /** wall-clock budget for starting org passes (default {@link GC_RUN_BUDGET_MS}) */
  runBudgetMs?: number;
  ghostWindowSeconds?: number;
  stuckProvisioningSeconds?: number;
  reconcileStaleSeconds?: number;
}

export interface GcReport {
  skipped?: "locked";
  startedAt: string;
  orgs: number;
  expiredJobs: number;
  canceledTasks: string[];
  abandonedWorkspaces: string[];
  collectedWorkspaces: string[];
  /** failed/stuck workspaces whose repo name was resolved (deleted or confirmed absent past the window) */
  sweptGhosts: string[];
  revokedTokens: number;
  reconcileRequests: number;
  deletedAssets: string[];
  /** staging ids of unfinished uploads (older than 24 h) that were aborted and dropped */
  lfsUploadsAborted: string[];
  /** staging ids of unaccepted LFS objects (past the staging TTL) whose bytes and row were deleted */
  lfsObjectsExpired: string[];
  /** uploads stuck in `uploaded` whose hash step was enqueued again */
  lfsHashesRetried: string[];
  /** uploads rejected after {@link MAX_HASH_ATTEMPTS} retries */
  lfsHashesGivenUp: string[];
  /** change ids whose R2 artifacts (ops manifests, edits) were deleted: finished changes past the staging TTL, and orphaned prefixes */
  fileChangeArtifactsDeleted: string[];
  /** open file changes the sweep ran `settleFileChange` on */
  fileChangesSettled: number;
  /** verified LFS objects whose missing pointer oid was filled in */
  lfsPointerBackfill: number;
  /** stale `pending` folder setups whose `folders.init` step was queued again (folders phase 4) */
  folderInitRequeued: number;
  errors: string[];
}

type SweepRow = WorkspaceRow & { swept_at: string | null; task_state: TaskState; task_updated_at: string; project_id: string };

/** Run one GC pass unless another one holds the lock. */
export async function runGc(svc: Services, opts: GcOptions = {}): Promise<GcReport> {
  const startedAt = svc.nowIso();
  const r = await svc.gate.withLock("gc", "sweep", GC_LOCK_MS, () => gcPass(svc, opts, startedAt));
  if (r.locked) return { ...emptyReport(startedAt), skipped: "locked" };
  return r.value;
}

function emptyReport(startedAt: string): GcReport {
  return { startedAt, orgs: 0, expiredJobs: 0, canceledTasks: [], abandonedWorkspaces: [], collectedWorkspaces: [], sweptGhosts: [], revokedTokens: 0, reconcileRequests: 0, deletedAssets: [], lfsUploadsAborted: [], lfsObjectsExpired: [], lfsHashesRetried: [], lfsHashesGivenUp: [], fileChangeArtifactsDeleted: [], fileChangesSettled: 0, lfsPointerBackfill: 0, folderInitRequeued: 0, errors: [] };
}

async function gcPass(svc: Services, opts: GcOptions, startedAt: string): Promise<GcReport> {
  const report = emptyReport(startedAt);
  const phase = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      const msg = `${name}: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`;
      report.errors.push(msg);
      console.error(`gc ${msg}`);
    }
  };
  await phase("runner-jobs", () => expireRunnerJobs(svc, report));
  const orgs = (await svc.db.prepare("SELECT org_id FROM orgs ORDER BY org_id").all<{ org_id: string }>()).results.filter((o) => !opts.orgs || opts.orgs.includes(o.org_id));
  report.orgs = orgs.length;
  const deadline = Date.now() + (opts.runBudgetMs ?? GC_RUN_BUDGET_MS);
  for (const { org_id: org } of orgs) {
    // M-3: never start an org pass that could outlive the lock lease (collectUnreachable must run serialized)
    if (Date.now() > deadline) {
      report.errors.push(`deadline: run budget spent, ${org} and later orgs wait for the next run`);
      break;
    }
    await phase(`${org}/tasks`, () => abandonStale(svc, org, opts, report));
    await phase(`${org}/workspaces`, () => sweepWorkspaces(svc, org, opts, report));
    await phase(`${org}/tokens`, () => revokeStaleTokens(svc, org, report));
    await phase(`${org}/heads`, () => sweepHeads(svc, org, opts, report));
    await phase(`${org}/assets`, () => collectAssets(svc, org, opts, report));
    // Task 22 review R-1: deploys/rollbacks whose job ended without a result release the project lock
    await phase(`${org}/releases`, async () => void (await sweepStaleReleases(svc, org)));
    // staging phase 2: `promoting` landings no in-flight promotion claims go back to `landed` (and
    // claims of ended promotions are released); in-flight promotions whose step chain went silent
    // get a step (a lost chain), and the first promotion waiting for a free production looks again
    await phase(`${org}/promotions`, async () => {
      await repairPromotingLandings(svc, org);
      await nudgeStalePromotions(svc, org);
    });
    // staging phase 2b (B6): landings still waiting for the owner baseline get their build once it
    // exists (a kick on go-live or policy save that failed is repeated here)
    await phase(`${org}/staging-baseline`, () => settleWaitingBaselines(svc, org));
    // folders phase 4: a new folder's setup whose step chain went silent gets `folders.init` again
    await phase(`${org}/folder-inits`, async () => void (report.folderInitRequeued += await requeueStaleFolderInits(svc, org)));
    // last: the most expendable work (capped per kind) never delays the phases above
    await phase(`${org}/lfs`, () => collectLfs(svc, org, report));
  }
  // staging capture sink: captures are kept 7 days (global, not per org)
  await phase("staging-captures", () => sweepCaptures(svc));
  console.log(
    `gc: orgs=${report.orgs} jobs=${report.expiredJobs} canceled=${report.canceledTasks.length} abandoned=${report.abandonedWorkspaces.length} collected=${report.collectedWorkspaces.length} ghosts=${report.sweptGhosts.length} tokens=${report.revokedTokens} reconcile=${report.reconcileRequests} assets=${report.deletedAssets.length} lfsUploadsAborted=${report.lfsUploadsAborted.length} lfsObjectsExpired=${report.lfsObjectsExpired.length} lfsHashesRetried=${report.lfsHashesRetried.length} lfsHashesGivenUp=${report.lfsHashesGivenUp.length} fileChangeArtifacts=${report.fileChangeArtifactsDeleted.length} fileChangesSettled=${report.fileChangesSettled} lfsPointerBackfill=${report.lfsPointerBackfill} folderInitRequeued=${report.folderInitRequeued} errors=${report.errors.length}`,
  );
  return report;
}

const ageSeconds = (svc: Services, iso: string | number) => (svc.now().getTime() - (typeof iso === "number" ? iso : Date.parse(iso))) / 1000;

// ------------------------------------------------------------------------------------- 1. runner jobs

async function expireRunnerJobs(svc: Services, report: GcReport): Promise<void> {
  const cutoff = svc.now().getTime() - RESULT_GRACE_MS;
  const rows = (await svc.db.prepare("SELECT job_id FROM runner_jobs WHERE status = 'queued' AND expires_at < ? LIMIT 500").bind(cutoff).all<{ job_id: string }>()).results;
  for (const { job_id } of rows) {
    const result = { jobId: job_id, ok: false, code: "job_expired", detail: "the job expired without a result (closed by GC)" };
    const upd = await svc.db
      .prepare("UPDATE runner_jobs SET status = 'failed', result_json = ?, completed_at = ? WHERE job_id = ? AND status = 'queued'")
      .bind(JSON.stringify(result), svc.now().getTime(), job_id)
      .run();
    if ((upd.meta.changes ?? 0) === 0) continue;
    report.expiredJobs++;
    await revokeJobTokens(svc, job_id);
  }
}

// ------------------------------------------------------------------------------------- 2. stale tasks

async function sweepRows(svc: Services, org: string): Promise<SweepRow[]> {
  return (
    await svc.db
      .prepare(
        "SELECT w.*, t.state AS task_state, t.updated_at AS task_updated_at, t.project_id FROM task_workspaces w JOIN tasks t ON t.task_id = w.task_id WHERE w.org_id = ? AND w.provider = 'artifacts' AND w.swept_at IS NULL AND w.state IN ('writable', 'frozen', 'abandoned', 'collected', 'provisioning', 'failed') ORDER BY w.updated_at",
      )
      .bind(org)
      .all<SweepRow>()
  ).results;
}

async function abandonStale(svc: Services, org: string, opts: GcOptions, report: GcReport): Promise<void> {
  const abandonAfter = opts.abandonAfterSeconds ?? ABANDON_AFTER_SECONDS;
  const nowMs = svc.now().getTime();
  const tasks = (
    await svc.db
      .prepare("SELECT task_id, project_id, state, lease_expires_at, lease_generation, updated_at FROM tasks WHERE org_id = ? AND state = 'running'")
      .bind(org)
      .all<{ task_id: string; project_id: string; state: TaskState; lease_expires_at: number | null; lease_generation: number; updated_at: string }>()
  ).results;
  for (const t of tasks) {
    if (t.lease_expires_at !== null && t.lease_expires_at > nowMs) continue; // live lease
    const lastActivity = Math.max(t.lease_expires_at ?? 0, Date.parse(t.updated_at));
    if ((nowMs - lastActivity) / 1000 <= abandonAfter) continue;
    const upd = await svc.db
      .prepare(
        "UPDATE tasks SET state = 'canceled', lease_hash = NULL, lease_expires_at = NULL, lease_generation = lease_generation + 1, updated_at = ? WHERE task_id = ? AND state = ? AND lease_generation = ?",
      )
      .bind(svc.nowIso(), t.task_id, t.state, t.lease_generation)
      .run();
    if ((upd.meta.changes ?? 0) === 0) continue;
    report.canceledTasks.push(t.task_id);
    const ws = (await svc.db.prepare("SELECT resource_id FROM task_workspaces WHERE task_id = ?").bind(t.task_id).all<{ resource_id: string }>()).results;
    await recordEvent(svc, {
      orgId: org,
      projectId: t.project_id,
      actor: SERVICE_ACTOR as never,
      action: "task.abandoned",
      subjectKind: "task",
      subjectId: t.task_id,
      resourceIds: ws.map((w) => w.resource_id),
      detail: { reason: "no live lease", idleSeconds: Math.round((nowMs - lastActivity) / 1000) },
    });
  }
  // Writable copies of tasks that can never use them again (N-4: reference copies included).
  for (const w of await sweepRows(svc, org)) {
    if (w.state !== "writable" || !["canceled", "failed", "submitted"].includes(w.task_state)) continue;
    try {
      await revokeWorkspaceWriteTokens(svc, org, [w], ["read", "write"]);
      const handle = await svc.ledger(org).getWorkspace(w.task_workspace_id);
      if (handle && handle.state === "writable") await svc.ledger(org).putWorkspace(org, { ...handle, state: "abandoned" });
      if (await setWorkspaceState(svc, w.task_workspace_id, "abandoned", { from: "writable" })) report.abandonedWorkspaces.push(w.task_workspace_id);
    } catch (e) {
      report.errors.push(`${org}/abandon ${w.task_workspace_id}: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    }
  }
}

// ------------------------------------------------------------------------------------- 3. task repos

async function sweepWorkspaces(svc: Services, org: string, opts: GcOptions, report: GcReport): Promise<void> {
  const grace = opts.graceSeconds ?? GC_GRACE_SECONDS;
  const ghostWindow = opts.ghostWindowSeconds ?? GHOST_WINDOW_SECONDS;
  const stuck = opts.stuckProvisioningSeconds ?? STUCK_PROVISIONING_SECONDS;
  let budget = MAX_COLLECT_PER_ORG;
  for (const w of await sweepRows(svc, org)) {
    if (budget <= 0) break;
    const age = ageSeconds(svc, w.updated_at);
    try {
      switch (w.state) {
        case "abandoned": {
          if (age <= grace) break;
          if (age <= (opts.unfrozenWorkGraceSeconds ?? UNFROZEN_WORK_GRACE_SECONDS) && (await hasUnfrozenWork(svc, org, w))) break;
          budget--;
          await collect(svc, org, w, ["abandoned", "collected"], report);
          break;
        }
        case "frozen": {
          if (age <= grace) break;
          const states = await candidateStates(svc, org, w.task_workspace_id);
          // the fork is still needed while a candidate waits for prepare-candidate
          if (states.length === 0 || states.includes("frozen")) break;
          budget--;
          const retained = states.some((s) => s === "prepared" || s === "accepted");
          await collect(svc, org, w, retained ? ["retained", "collected"] : ["collected"], report);
          break;
        }
        case "collected":
          // collected elsewhere (reference copies at submit): confirm the repo is gone
          if (await ghost(svc, org, w, 0, report)) budget--;
          break;
        case "provisioning":
          if (age <= stuck) break;
          if (await setWorkspaceState(svc, w.task_workspace_id, "failed", { error: "provisioning did not finish (failed by GC)", from: "provisioning" })) {
            await refreshTaskState(svc, w.task_id);
          }
          break;
        case "failed":
          if (await ghost(svc, org, w, ghostWindow, report)) budget--;
          break;
        default:
          break;
      }
    } catch (e) {
      report.errors.push(`${org}/workspace ${w.task_workspace_id}: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    }
  }
}

async function candidateStates(svc: Services, org: string, taskWorkspaceId: string): Promise<string[]> {
  const ids = (await svc.db.prepare("SELECT candidate_id FROM task_candidates WHERE task_workspace_id = ?").bind(taskWorkspaceId).all<{ candidate_id: string }>()).results;
  const out: string[] = [];
  for (const { candidate_id } of ids) {
    const rec = await svc.ledger(org).getCandidate(candidate_id);
    out.push(rec?.state ?? "frozen"); // unknown to the ledger: keep the fork
  }
  return out;
}

/** Delete the task repo through the provider (repo-id checked), then record the ledger path and D1. */
async function collect(svc: Services, org: string, w: SweepRow, path: TaskWorkspaceState[], report: GcReport): Promise<void> {
  const ledger = svc.ledger(org);
  let handle: TaskWorkspaceHandle | null = await ledger.getWorkspace(w.task_workspace_id);
  if (!handle) {
    await ghost(svc, org, w, 0, report);
    return;
  }
  // a reference copy abandoned in D1 only (ledger write failed earlier) is still writable there
  if (handle.state === "writable") path = ["abandoned", ...path.filter((s) => s !== "abandoned")];
  await svc.provider().collectWorkspace(handle);
  for (const s of path) {
    if (handle.state === s || handle.state === "collected") continue;
    handle = { ...handle, state: s };
    await ledger.putWorkspace(org, handle);
  }
  await markSwept(svc, w, "collected");
  report.collectedWorkspaces.push(w.task_workspace_id);
}

/**
 * Name-based cleanup for workspaces without a usable handle: delete the recorded repo name when a
 * repo exists under it; once none has appeared for `windowSeconds`, stop looking.
 */
async function ghost(svc: Services, org: string, w: SweepRow, windowSeconds: number, report: GcReport): Promise<boolean> {
  const ns = svc.provider().namespace(org, "tasks");
  const name = taskWorkspaceRepoName(w.task_workspace_id);
  const info = await svc.transport.getRepo(ns, name);
  if (info) {
    await svc.transport.deleteRepo(ns, name);
    await markSwept(svc, w, w.state);
    report.sweptGhosts.push(w.task_workspace_id);
    return true;
  }
  if (ageSeconds(svc, w.updated_at) > windowSeconds) {
    await markSwept(svc, w, w.state);
    if (w.state !== "collected") report.sweptGhosts.push(w.task_workspace_id);
  }
  return false;
}

/** I-2: a written task repo whose branch moved past its seeded base holds work nobody froze. */
async function hasUnfrozenWork(svc: Services, org: string, w: SweepRow): Promise<boolean> {
  if (w.access !== "write") return false;
  const handle = await svc.ledger(org).getWorkspace(w.task_workspace_id);
  if (!handle || handle.coords.kind !== "artifacts") return false;
  const info = await svc.transport.getRepo(handle.coords.namespace, handle.coords.repoName);
  if (!info) return false;
  const [c] = await svc.transport.log(handle.coords.namespace, handle.coords.repoName, { ref: info.defaultBranch, limit: 1 });
  const base = parseRevisionId(w.base_revision);
  return c !== undefined && (base.kind !== "art" || c.hash !== base.sha);
}

async function markSwept(svc: Services, w: SweepRow, state: string): Promise<void> {
  await svc.db
    .prepare("UPDATE task_workspaces SET state = ?, swept_at = ?, updated_at = ? WHERE task_workspace_id = ? AND swept_at IS NULL")
    .bind(state, svc.nowIso(), svc.nowIso(), w.task_workspace_id)
    .run();
}

// ------------------------------------------------------------------------------------- 4. tokens

async function artifactsResources(svc: Services, org: string): Promise<ResourceRow[]> {
  return (await svc.db.prepare("SELECT * FROM resources WHERE org_id = ? AND provider = 'artifacts' AND coords_json IS NOT NULL").bind(org).all<ResourceRow>()).results;
}

async function revokeStaleTokens(svc: Services, org: string, report: GcReport): Promise<void> {
  const provider = svc.provider();
  for (const r of await artifactsResources(svc, org)) {
    report.revokedTokens += await provider.revokeStaleCanonicalWriteTokens(org, r.resource_id);
  }
}

// ------------------------------------------------------------------------------------- 5. heads

async function sweepHeads(svc: Services, org: string, opts: GcOptions, report: GcReport): Promise<void> {
  const ledger = svc.ledger(org);
  if ((await ledger.getOrganization()) === null) return; // nothing accepted yet
  const heads = await ledger.listHeads();
  await refreshHeadProjections(
    svc,
    org,
    heads.map((h) => h.resourceId),
    heads,
  );
  const stale = opts.reconcileStaleSeconds ?? RECONCILE_STALE_SECONDS;
  const bucket = Math.floor(svc.now().getTime() / (GC_SWEEP_INTERVAL_SECONDS * 1000));
  for (const h of heads) {
    if (h.reconciliation === "synced" || ageSeconds(svc, h.acceptedAt) <= stale) continue;
    if (h.reconciliation === "diverged") {
      // M-5: a diverged head (often a permanent provider problem) is re-requested with backoff:
      // runs 1, 2, 4, 8, … after the divergence was observed (N-2; acceptance if unknown)
      const rs = await ledger.getRefState(h.resourceId);
      const since = rs && rs.state === "diverged" && rs.revisionId === h.revisionId ? rs.observedAt : h.acceptedAt;
      const runs = Math.max(1, Math.floor(ageSeconds(svc, since) / GC_SWEEP_INTERVAL_SECONDS));
      if ((runs & (runs - 1)) !== 0) continue;
    }
    // lease on the previous head (the ledger's own event did the same)
    const version = h.acceptedVersionId ? await ledger.getAcceptedVersion(h.acceptedVersionId) : null;
    const previous = version?.heads.find((x) => x.resourceId === h.resourceId)?.previousRevisionId ?? null;
    const req = reconcileRequest(org, h, `sweep:${bucket}`, svc.now(), previous);
    if (!req) continue;
    await svc.deps.outboxQueue(svc.env).send(req);
    report.reconcileRequests++;
  }
}

// ------------------------------------------------------------------------------------- 6. assets

const manifestOf = (revisionId: string | null | undefined): string | null => {
  if (!revisionId) return null;
  try {
    const p = parseRevisionId(revisionId);
    return p.kind === "r2m" ? p.manifestId : null;
  } catch {
    return null;
  }
};

/** Every manifest the ledger or D1 still needs; objects are protected through their manifests. */
export async function reachableAssetManifests(svc: Services, org: string): Promise<Set<string>> {
  const out = new Set<string>();
  const add = (rev: string | null | undefined) => {
    const m = manifestOf(rev);
    if (m) out.add(m);
  };
  const ledger = svc.ledger(org);
  // every accepted version (restore may target any of them) and the current heads
  for (let after = 0; ; ) {
    const page = await ledger.listAcceptedVersions({ after, limit: 500 });
    for (const v of page) for (const h of v.heads) (add(h.revisionId), add(h.previousRevisionId));
    if (page.length < 500) break;
    after = page[page.length - 1]!.sequence;
  }
  for (const h of await ledger.listHeads()) add(h.revisionId);
  // retained candidates: manifests of open/prepared proposals
  for (const p of await ledger.listProposals()) {
    if (p.state !== "open" && p.state !== "prepared") continue;
    for (const c of p.assetManifestChanges) {
      out.add(c.newManifestId);
      if (c.baseManifestId) out.add(c.baseManifestId);
    }
  }
  // active task workspaces
  const ws = await svc.db
    .prepare(
      "SELECT w.asset_manifest_id, w.base_revision FROM task_workspaces w JOIN tasks t ON t.task_id = w.task_id WHERE w.org_id = ? AND w.provider = 'r2-assets' AND t.state NOT IN ('failed', 'canceled')",
    )
    .bind(org)
    .all<{ asset_manifest_id: string | null; base_revision: string }>();
  for (const w of ws.results) {
    if (w.asset_manifest_id) out.add(w.asset_manifest_id);
    add(w.base_revision);
  }
  // exports
  const ex = await svc.db.prepare("SELECT snapshot_json, receipt_json FROM exports WHERE org_id = ?").bind(org).all<{ snapshot_json: string; receipt_json: string | null }>();
  for (const e of ex.results) {
    for (const entry of (JSON.parse(e.snapshot_json) as ProjectSnapshot).entries ?? []) add(entry.revisionId);
    const receipt = e.receipt_json ? (JSON.parse(e.receipt_json) as { items?: Array<{ kind?: string; manifestId?: string }> }) : null;
    for (const item of receipt?.items ?? []) if (item.kind === "asset-manifest" && item.manifestId) out.add(item.manifestId);
  }
  return out;
}

async function collectAssets(svc: Services, org: string, opts: GcOptions, report: GcReport): Promise<void> {
  const n = await svc.db.prepare("SELECT count(*) AS n FROM resources WHERE org_id = ? AND provider = 'r2-assets'").bind(org).first<{ n: number }>();
  const staged = await svc.db.prepare("SELECT count(*) AS n FROM task_workspaces WHERE org_id = ? AND provider = 'r2-assets'").bind(org).first<{ n: number }>();
  if (!n?.n && !staged?.n) return;
  // the run start for this org: the reachable set is computed after it (Task 13 re-review)
  const now = svc.nowIso();
  const reachable = await reachableAssetManifests(svc, org);
  const assets = await svc.assets(org);
  const { deleted } = await assets.collectUnreachable({ reachable, graceSeconds: opts.graceSeconds ?? GC_GRACE_SECONDS, now });
  report.deletedAssets.push(...deleted);
}

// ------------------------------------------------------------------------------------- 7. LFS and file changes

/** Each kind of LFS/file-change work handles at most this many rows per org per pass. */
export const MAX_LFS_PER_PASS = 100;
/** At most this many verified objects get their missing pointer oid per org per pass (cheap: no R2). */
export const MAX_POINTER_BACKFILL_PER_PASS = 500;
/** At most this many open file changes are settled per org per pass. */
export const MAX_SETTLE_PER_PASS = 50;
/** An upload `uploaded` (verify/complete done) this long without a hash result lost its step. */
export const HASH_STUCK_MS = 15 * 60_000;
/** The GC re-enqueues a stuck hash step at most this many times, then rejects the upload. */
export const MAX_HASH_ATTEMPTS = 3;
/** Pages of change prefixes (1000 each) looked at per org per pass. */
const MAX_PREFIX_PAGES = 10;
/** An R2 prefix without a change row is an orphan (a failed insert) once its objects are this old. */
const ORPHAN_PREFIX_SECONDS = 24 * 3600;
/** D1 allows 100 bound parameters per statement. */
const IN_BATCH = 90;

const errMsg = (e: unknown) => (e instanceof Error ? e.message.slice(0, 300) : String(e));
const isoAgo = (svc: Services, seconds: number) => new Date(svc.now().getTime() - seconds * 1000).toISOString();

async function collectLfs(svc: Services, org: string, report: GcReport): Promise<void> {
  // independent steps: one failing does not skip the rest (the phase wrapper records what is thrown)
  const failures: string[] = [];
  for (const [name, fn] of [
    ["uploads", () => abortUnfinishedUploads(svc, org, report)],
    ["hash-retry", () => retryStuckHashes(svc, org, report)],
    ["objects", () => expireUnacceptedObjects(svc, org, report)],
    ["pointer-backfill", () => backfillPointerOids(svc, org, report)],
    ["change-artifacts", () => deleteFileChangeArtifacts(svc, org, report)],
    ["change-sweep", () => sweepOpenFileChanges(svc, org, report)],
  ] as const) {
    try {
      await fn();
    } catch (e) {
      failures.push(`${name}: ${errMsg(e)}`);
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
}

interface LfsGcRow {
  staging_id: string;
  r2_key: string;
  state: string;
  source: "browser" | "lfs";
  upload_id: string | null;
}

/**
 * Row first, bytes second (Task 10 fix round): a leaked R2 key is harmless, a row (possibly one that
 * became accepted) without its bytes is permanent loss. So the row is dropped by a statement that
 * re-checks everything the select decided on, and the key goes only when that statement deleted it.
 * A failed key delete leaks the key and is reported.
 */
async function bestEffort(report: GcReport, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    report.errors.push(`${what}: ${errMsg(e)}`);
  }
}

/** One unfinished upload (`uploading` for over 24 h): drop the row, then abort the multipart upload / delete the key. */
export async function abortUnfinishedUpload(svc: Services, org: string, r: LfsGcRow, cutoffIso: string, report: GcReport): Promise<boolean> {
  // still `uploading` and still old: an upload completed meanwhile keeps its row and bytes
  const del = await svc.db.prepare("DELETE FROM lfs_objects WHERE staging_id = ? AND org_id = ? AND state = 'uploading' AND created_at < ?").bind(r.staging_id, org, cutoffIso).run();
  if ((del.meta.changes ?? 0) === 0) return false;
  report.lfsUploadsAborted.push(r.staging_id);
  const bucket = svc.env.COMMONFORGE_ASSETS;
  if (r.source === "browser") {
    if (r.upload_id) await bucket.resumeMultipartUpload(r.r2_key, r.upload_id).abort().catch(() => undefined);
    // an empty file has no multipart upload; a complete that lost the race may have written its empty object
    else await bestEffort(report, `${org}/lfs-upload ${r.staging_id} (key ${r.r2_key} leaked)`, () => bucket.delete(r.r2_key));
  } else {
    await bestEffort(report, `${org}/lfs-upload ${r.staging_id} (key ${r.r2_key} leaked)`, () => bucket.delete(r.r2_key));
  }
  return true;
}

/** `uploading` for over 24 h: browser rows abort their multipart upload (errors ignored; an empty file's row loses its key if any), git-lfs rows lose their key if any. */
async function abortUnfinishedUploads(svc: Services, org: string, report: GcReport): Promise<void> {
  const cutoff = isoAgo(svc, UNFINISHED_UPLOAD_TTL_HOURS * 3600);
  const rows = await svc.db
    .prepare("SELECT staging_id, r2_key, state, source, upload_id FROM lfs_objects WHERE org_id = ? AND state = 'uploading' AND created_at < ? ORDER BY created_at, staging_id LIMIT ?")
    .bind(org, cutoff, MAX_LFS_PER_PASS)
    .all<LfsGcRow>();
  // each row is handled once per pass, and its row is gone before anything that can fail, so a failing key never holds the batch back
  for (const r of rows.results) await bestEffort(report, `${org}/lfs-upload ${r.staging_id}`, () => abortUnfinishedUpload(svc, org, r, cutoff, report));
}

/**
 * Uploads `uploaded` for {@link HASH_STUCK_MS} (the hash step never reported: a lost message, or
 * retries that ended without `onStepFailed`): `lfs.hash` is enqueued again, at most
 * {@link MAX_HASH_ATTEMPTS} times (counted in `hash_attempts`; each try restarts the clock); after
 * that the upload is rejected `hash_failed: gave up` and the folder's waiting changes are woken.
 * Every update is guarded on the state and count read, so a hash that finishes meanwhile wins.
 */
async function retryStuckHashes(svc: Services, org: string, report: GcReport): Promise<void> {
  const cutoff = new Date(svc.now().getTime() - HASH_STUCK_MS).toISOString();
  const rows = await svc.db
    .prepare("SELECT staging_id, resource_id, hash_attempts FROM lfs_objects WHERE org_id = ? AND state = 'uploaded' AND updated_at < ? ORDER BY updated_at, staging_id LIMIT ?")
    .bind(org, cutoff, MAX_LFS_PER_PASS)
    .all<{ staging_id: string; resource_id: string; hash_attempts: number }>();
  for (const r of rows.results) {
    await bestEffort(report, `${org}/lfs-hash ${r.staging_id}`, async () => {
      if (r.hash_attempts < MAX_HASH_ATTEMPTS) {
        const up = await svc.db
          .prepare("UPDATE lfs_objects SET hash_attempts = hash_attempts + 1, updated_at = ? WHERE staging_id = ? AND org_id = ? AND state = 'uploaded' AND hash_attempts = ?")
          .bind(svc.nowIso(), r.staging_id, org, r.hash_attempts)
          .run();
        if ((up.meta.changes ?? 0) === 0) return;
        report.lfsHashesRetried.push(r.staging_id);
        await enqueueHash(svc, org, r.staging_id);
        return;
      }
      const gaveUp = await svc.db
        .prepare("UPDATE lfs_objects SET state = 'rejected', error = ?, updated_at = ? WHERE staging_id = ? AND org_id = ? AND state = 'uploaded' AND hash_attempts = ?")
        .bind(`hash_failed: gave up after ${MAX_HASH_ATTEMPTS} retries`, svc.nowIso(), r.staging_id, org, r.hash_attempts)
        .run();
      if ((gaveUp.meta.changes ?? 0) === 0) return;
      report.lfsHashesGivenUp.push(r.staging_id);
      await wakeFileChanges(svc, org, r.resource_id);
    });
  }
}

/** unfinished file changes (`staged` too: on staging, waiting for a promotion) */
const OPEN_CHANGE_STATES = OPEN_FILE_CHANGE_STATES_SQL;
const LIVE_TASK_STATES = "('provisioning', 'ready', 'running', 'submitted')";
/**
 * The task's staging landing (its own, or one it joined as a part) is claimed by an in-flight
 * promotion (`promotion_landings.active`): the promotion may still accept it into `main`, and its
 * accept tail accepts the objects before the claim is released (same batch order as the accept).
 */
const claimedTask = (task: string) =>
  `EXISTS (SELECT 1 FROM promotion_landings pl JOIN staging_landings l ON l.landing_id = pl.landing_id WHERE pl.active = 1 AND (l.task_id = ${task} OR EXISTS (SELECT 1 FROM staging_landing_parts sp WHERE sp.landing_id = l.landing_id AND sp.task_id = ${task})))`;
/**
 * An unaccepted object nothing in flight needs: no open change references it; no change failed
 * `staging_failed` references it while its task's landing is claimed by a promotion (staging dropped
 * the landing while the promotion was accepting: the accept adds the change anyway, review I1); its
 * task (if any) is not live, nor in a claimed landing.
 */
const UNNEEDED = `o.accepted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM file_change_objects x JOIN file_changes c ON c.change_id = x.change_id WHERE x.staging_id = o.staging_id AND (c.state IN ${OPEN_CHANGE_STATES} OR (c.state = 'failed' AND c.error_code = 'staging_failed' AND c.task_id IS NOT NULL AND ${claimedTask("c.task_id")})))
  AND (o.task_id IS NULL OR NOT (EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = o.task_id AND t.state IN ${LIVE_TASK_STATES}) OR ${claimedTask("o.task_id")}))`;

/**
 * One unaccepted object: the row goes first, by a statement that re-checks state, age, acceptance
 * and the open change / live task conditions; only a deleted row releases the bytes. An object that
 * was referenced, touched or accepted since the select keeps both.
 */
export async function expireUnacceptedObject(svc: Services, org: string, r: LfsGcRow, cutoffIso: string, report: GcReport): Promise<boolean> {
  const del = await svc.db
    .prepare(`DELETE FROM lfs_objects AS o WHERE o.staging_id = ? AND o.org_id = ? AND o.state IN ('uploaded', 'verified', 'rejected') AND o.last_used_at < ? AND ${UNNEEDED}`)
    .bind(r.staging_id, org, cutoffIso)
    .run();
  if ((del.meta.changes ?? 0) === 0) return false;
  report.lfsObjectsExpired.push(r.staging_id);
  const bucket = svc.env.COMMONFORGE_ASSETS;
  // rejected while still uploading: the multipart upload is still open at R2 (best effort)
  if (r.state === "rejected" && r.upload_id) await bucket.resumeMultipartUpload(r.r2_key, r.upload_id).abort().catch(() => undefined);
  // a rejected object's bytes may still be there (a hash_failed step leaves them); delete is idempotent
  await bestEffort(report, `${org}/lfs-object ${r.staging_id} (key ${r.r2_key} leaked)`, () => bucket.delete(r.r2_key));
  return true;
}

/** uploaded/verified/rejected, never accepted, unused for the staging TTL and needed by nobody. */
async function expireUnacceptedObjects(svc: Services, org: string, report: GcReport): Promise<void> {
  const { stagingTtlDays } = lfsSettings(svc.env);
  const cutoff = isoAgo(svc, stagingTtlDays * 86400);
  const rows = await svc.db
    .prepare(`SELECT o.staging_id, o.r2_key, o.state, o.source, o.upload_id FROM lfs_objects o WHERE o.org_id = ? AND o.state IN ('uploaded', 'verified', 'rejected') AND o.last_used_at < ? AND ${UNNEEDED} ORDER BY o.last_used_at, o.staging_id LIMIT ?`)
    .bind(org, cutoff, MAX_LFS_PER_PASS)
    .all<LfsGcRow>();
  for (const r of rows.results) await bestEffort(report, `${org}/lfs-object ${r.staging_id}`, () => expireUnacceptedObject(svc, org, r, cutoff, report));
}

/**
 * Verified objects without a pointer oid (verified before migration 0013): computed from the sha256
 * and size already recorded, nothing is read. One statement per pass (the oids go in as one JSON
 * parameter: D1 binds at most 100); it re-checks that each row is still verified, with the same
 * hash, and still has no oid.
 */
async function backfillPointerOids(svc: Services, org: string, report: GcReport): Promise<void> {
  const rows = (
    await svc.db
      .prepare("SELECT staging_id, sha256, size FROM lfs_objects WHERE org_id = ? AND state = 'verified' AND pointer_oid IS NULL AND sha256 IS NOT NULL ORDER BY staging_id LIMIT ?")
      .bind(org, MAX_POINTER_BACKFILL_PER_PASS)
      .all<{ staging_id: string; sha256: string; size: number }>()
  ).results;
  if (rows.length === 0) return;
  const fills: Array<{ id: string; sha: string; p: string }> = [];
  for (const r of rows) fills.push({ id: r.staging_id, sha: r.sha256, p: await pointerOidOf(r.sha256, r.size) });
  const json = JSON.stringify(fills);
  const match = "SELECT json_extract(j.value, '$.p') FROM json_each(?) j WHERE json_extract(j.value, '$.id') = o.staging_id AND json_extract(j.value, '$.sha') = o.sha256";
  const up = await svc.db
    .prepare(`UPDATE lfs_objects AS o SET pointer_oid = (${match}) WHERE o.org_id = ? AND o.state = 'verified' AND o.pointer_oid IS NULL AND EXISTS (${match})`)
    .bind(json, org, json)
    .run();
  report.lfsPointerBackfill += up.meta.changes ?? 0;
}

/** Delete every object under `prefix` (listed page by page, deleted in batches of 1000). */
async function deletePrefix(svc: Services, prefix: string): Promise<void> {
  const bucket = svc.env.COMMONFORGE_ASSETS;
  for (;;) {
    // no cursor: what was deleted is gone from the next listing
    const page = await bucket.list({ prefix, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    if (!page.truncated) return;
  }
}

/**
 * R2 artifacts of file changes (`org/<org>/file-changes/<changeId>/`): deleted for changes in a
 * terminal state past the staging TTL, and for prefixes without a change row whose objects are all
 * over 24 h old (a failed insert). The rows stay as history. The change ids come from listing the
 * prefixes (a finished change's prefix is gone after its pass, so the listing only holds live ones).
 */
async function deleteFileChangeArtifacts(svc: Services, org: string, report: GcReport): Promise<void> {
  const bucket = svc.env.COMMONFORGE_ASSETS;
  const root = `org/${org}/file-changes/`;
  const { stagingTtlDays } = lfsSettings(svc.env);
  const ttlCutoff = isoAgo(svc, stagingTtlDays * 86400);
  const orphanCutoff = svc.now().getTime() - ORPHAN_PREFIX_SECONDS * 1000;
  let cursor: string | undefined;
  let budget = MAX_LFS_PER_PASS;
  for (let page = 0; page < MAX_PREFIX_PAGES && budget > 0; page++) {
    const listed = await bucket.list({ prefix: root, delimiter: "/", limit: 1000, ...(cursor ? { cursor } : {}) });
    const ids = listed.delimitedPrefixes.map((p) => p.slice(root.length, -1)).filter(Boolean);
    for (let i = 0; i < ids.length && budget > 0; i += IN_BATCH) {
      const chunk = ids.slice(i, i + IN_BATCH);
      const rows = await svc.db
        .prepare(`SELECT change_id, state, updated_at FROM file_changes WHERE org_id = ? AND change_id IN (${chunk.map(() => "?").join(",")})`)
        .bind(org, ...chunk)
        .all<{ change_id: string; state: string; updated_at: string }>();
      const byId = new Map(rows.results.map((r) => [r.change_id, r]));
      for (const id of chunk) {
        if (budget <= 0) break;
        try {
          const r = byId.get(id);
          if (r) {
            if ((r.state !== "added" && r.state !== "failed") || r.updated_at >= ttlCutoff) continue;
          } else if (!(await prefixOlderThan(svc, `${root}${id}/`, orphanCutoff))) {
            continue;
          }
          await deletePrefix(svc, `${root}${id}/`);
          report.fileChangeArtifactsDeleted.push(id);
          budget--;
        } catch (e) {
          report.errors.push(`${org}/file-change-artifacts ${id}: ${errMsg(e)}`);
        }
      }
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
}

/** Every object under the prefix was uploaded before `cutoff` (ms); an empty prefix counts. */
async function prefixOlderThan(svc: Services, prefix: string, cutoff: number): Promise<boolean> {
  let cursor: string | undefined;
  do {
    const page = await svc.env.COMMONFORGE_ASSETS.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (page.objects.some((o) => o.uploaded.getTime() >= cutoff)) return false;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return true;
}

/** The states the sweep rotates through (`staged` rows have their own sweep: they wait for people, not steps). */
const MOVING_CHANGE_STATES = "('applying', 'checking', 'waiting_approval')";

/**
 * Open file changes idle for {@link FILE_CHANGE_STUCK_MS} get their read-time recovery, whether or
 * not anybody reads them. `staged` changes are swept apart ({@link sweepStagedFileChanges}), so
 * changes waiting days for a promotion never take this budget.
 */
async function sweepOpenFileChanges(svc: Services, org: string, report: GcReport): Promise<void> {
  const rows = await svc.db
    .prepare(`SELECT * FROM file_changes WHERE org_id = ? AND state IN ${MOVING_CHANGE_STATES} AND updated_at < ? ORDER BY updated_at, change_id LIMIT ?`)
    .bind(org, new Date(svc.now().getTime() - FILE_CHANGE_STUCK_MS).toISOString(), MAX_SETTLE_PER_PASS)
    .all<FileChangeRow>();
  for (const row of rows.results) {
    report.fileChangesSettled++;
    try {
      await settleFileChange(svc, row);
    } catch (e) {
      report.errors.push(`${org}/file-change ${row.change_id}: ${errMsg(e)}`);
    }
    // Rotation: a change the sweep looked at (and that nothing else touched) is marked by bumping its
    // updated_at, so the oldest-first selection moves on to the next ones next pass instead of
    // meeting the same 100 forever. updated_at only drives the stuck check (the same touch settle
    // itself makes when it enqueues a step) and the displayed "updated"; guarded on the value read.
    await bestEffort(report, `${org}/file-change ${row.change_id} (rotation)`, () =>
      svc.db.prepare(`UPDATE file_changes SET updated_at = ? WHERE change_id = ? AND updated_at = ? AND state IN ${MOVING_CHANGE_STATES}`).bind(svc.nowIso(), row.change_id, row.updated_at).run(),
    );
  }
  await sweepStagedFileChanges(svc, org, report);
}

/**
 * `staged` changes that need a repair: their task has no landing in staging (`checking`, `landed`,
 * `rolling_back`, `promoting`) — it was promoted, failed or rolled back while the hook or the accept
 * tail did not finish them, or staging never took it. Healthy staged changes are not selected, so
 * nothing is rewritten (no rotation: their `updated_at` stays what the client saw), and they have a
 * budget of their own ({@link MAX_SETTLE_PER_PASS}).
 */
async function sweepStagedFileChanges(svc: Services, org: string, report: GcReport): Promise<void> {
  const inStaging = (task: string) =>
    `EXISTS (SELECT 1 FROM staging_landings l WHERE l.org_id = c.org_id AND l.state IN ('checking', 'landed', 'rolling_back', 'promoting') AND (l.task_id = ${task} OR EXISTS (SELECT 1 FROM staging_landing_parts sp WHERE sp.landing_id = l.landing_id AND sp.task_id = ${task})))`;
  const rows = await svc.db
    .prepare(`SELECT c.* FROM file_changes c WHERE c.org_id = ? AND c.state = 'staged' AND c.task_id IS NOT NULL AND NOT ${inStaging("c.task_id")} ORDER BY c.updated_at, c.change_id LIMIT ?`)
    .bind(org, MAX_SETTLE_PER_PASS)
    .all<FileChangeRow>();
  for (const row of rows.results) {
    report.fileChangesSettled++;
    try {
      await settleFileChange(svc, row);
    } catch (e) {
      report.errors.push(`${org}/file-change ${row.change_id}: ${errMsg(e)}`);
    }
  }
}
