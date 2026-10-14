/**
 * Setting up a new folder (folders phase 4, rulings P4-1 to P4-3, P4-9): its first version.
 *
 * A new folder has no version, so the change path (snapshot → `apply-files` → candidate →
 * integrate → accept) cannot make its first commit. Like a URL import, the first version is
 * genesis: the runner's `init-folder` job puts ONE parentless commit (`.gitattributes`,
 * `.lfsconfig`, `README.md`) on canonical `main`, and the Worker binds it as the ledger head. No
 * proposal, no checks, no staging landing.
 *
 * - `startFolderInit` records a `folder_inits` row (`pending`, the commit time fixed to the
 *   request's whole second) and queues `folders.init`.
 * - `folders.init` issues the job (one open job per setup; `attempts` counts them), or, finding its
 *   job finished, applies the outcome (a result whose applier did not finish, or a job GC closed).
 * - The result: canonical `main` must hold exactly the reported commit with no parent (as
 *   `adoptBranchHead` reads it); then `bindHead` (unless that commit is already the head), the
 *   resource `active`, the row `done`. The commit id is a function of the job (P4-3), and every job
 *   of a setup carries the first job's content (`first_commit_json`) and the row's commit time, so
 *   a retried job answers `already` with the same commit.
 * - Failures: `provider_unavailable` and `job_expired` are tried again, up to
 *   {@link MAX_FOLDER_INIT_ATTEMPTS} jobs; anything else (`branch_not_empty`, `init_mismatch`, …)
 *   and the last attempt fail the row and the resource (`resources.error` says why).
 * - GC re-queues a `pending` setup idle for {@link FOLDER_INIT_STALE_MS} with no running job;
 *   `retryFolderInit` starts a failed setup over (same commit time: a commit that made it to `main`
 *   meanwhile is found as `already`).
 */
import { artRevisionId } from "@commonforge-org/core";
import { defaultGitattributes, type InitFolderReceipt, type IntegrationJobInput, type RunnerResult } from "@commonforge-org/runner-protocol";
import type { Services } from "../context.js";
import { conflict } from "../lib/http.js";
import { lfsEndpointUrl } from "../lib/lfs-config.js";
import { getResource, getUser, resourceCoords, type UserRow } from "./directory.js";
import { recordEvent, userRef } from "./events.js";
import { bindHead } from "./resources.js";
import { getJob, issueJob, onRunnerResult } from "./runner-jobs.js";
import { enqueueStep, onStep, onStepFailed } from "./steps.js";
import { liveCanonical } from "./task-repos.js";

/** Jobs per setup (queue retries and GC re-queues included); Try again starts the count over. */
export const MAX_FOLDER_INIT_ATTEMPTS = 3;
/** A `pending` setup idle this long, with no running job, is re-queued by GC. */
export const FOLDER_INIT_STALE_MS = 15 * 60_000;
/** The job's lifetime: a few files and one push (a lost job is noticed by GC after it ends). */
const FOLDER_INIT_JOB_SECONDS = 600;
/** Runner failures worth another job; anything else fails the setup at once. */
const RETRYABLE = new Set(["provider_unavailable", "job_expired"]);

const RUNNER = { kind: "runner", id: "integration-runner" } as never;

export interface FolderInitRow {
  org_id: string;
  resource_id: string;
  project_id: string;
  mount_name: string;
  requested_by: string;
  commit_time: string;
  state: "pending" | "done" | "failed";
  attempts: number;
  job_id: string | null;
  commit_sha: string | null;
  /** {@link FirstCommit} of the first job issued: every later job (and Try again) reuses it */
  first_commit_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** The first commit's files (Global Constraints "First commit contents"), byte for byte the same for the same folder. */
export function firstCommitFiles(name: string, lfsUrl: string): Array<{ path: string; content: string }> {
  return [
    { path: ".gitattributes", content: defaultGitattributes() },
    { path: ".lfsconfig", content: `[lfs]\n\turl = ${lfsUrl}\n` },
    { path: "README.md", content: `# ${name}\n` },
  ];
}

/** What the first commit is made of besides its time: fixed by the first job, reused by every later one (P4-3). */
export interface FirstCommit {
  files: Array<{ path: string; content: string }>;
  author: { name: string; email: string };
  message: string;
}

/** The creator as a commit identity: no `<`, `>`, newline or NUL (the job schema refuses them), trimmed. */
export function commitAuthor(user: Pick<UserRow, "email" | "display_name">): { name: string; email: string } {
  const clean = (s: string, max: number) => s.replace(/[<>\r\n\0]/g, "").trim().slice(0, max).trim();
  const email = clean(user.email, 320);
  return { name: clean(user.display_name ?? "", 200) || email.slice(0, 200).trim() || "CommonForge user", email: email.length >= 3 ? email : "unknown@commonforge.invalid" };
}

export async function getFolderInit(svc: Services, orgId: string, resourceId: string): Promise<FolderInitRow | null> {
  return svc.db.prepare("SELECT * FROM folder_inits WHERE org_id = ? AND resource_id = ?").bind(orgId, resourceId).first<FolderInitRow>();
}

/** Record the setup of a folder just created (resource `empty`, mount attached) and queue its first job. */
export async function startFolderInit(svc: Services, s: { orgId: string; resourceId: string; projectId: string; mountName: string; requestedBy: string }): Promise<void> {
  const now = svc.now().getTime();
  // whole seconds, UTC: the job's commitTime (its commit id depends on it, P4-3)
  const commitTime = new Date(Math.floor(now / 1000) * 1000).toISOString();
  const iso = new Date(now).toISOString();
  await svc.db
    .prepare("INSERT INTO folder_inits (org_id, resource_id, project_id, mount_name, requested_by, commit_time, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)")
    .bind(s.orgId, s.resourceId, s.projectId, s.mountName, s.requestedBy, commitTime, iso, iso)
    .run();
  await enqueueStep(svc, { type: "folders.init", orgId: s.orgId, resourceId: s.resourceId });
}

/** Another step issued this attempt's job first. */
class Raced extends Error {}

onStep("folders.init", async (svc, msg) => {
  const row = await getFolderInit(svc, msg.orgId, msg.resourceId);
  if (!row || row.state !== "pending") return { done: true };
  if (row.job_id) {
    const job = await getJob(svc, row.job_id);
    // its result moves the setup on
    if (job?.status === "queued" && job.expires_at > svc.now().getTime()) return { done: true };
    if (job && job.status !== "queued" && job.result_json) await settleFolderInit(svc, row, JSON.parse(job.result_json) as RunnerResult);
    else await failedAttempt(svc, row, "job_expired", "the setup job ended without a result");
    return { done: true };
  }
  if (row.attempts >= MAX_FOLDER_INIT_ATTEMPTS) {
    await failFolderInit(svc, row, "gave_up", `no first version after ${row.attempts} attempts`);
    return { done: true };
  }
  const r = await getResource(svc.db, row.org_id, row.resource_id);
  if (!r || r.provider !== "artifacts") {
    await failFolderInit(svc, row, "not_artifacts", "the folder is not a git folder");
    return { done: true };
  }
  // the first job fixes the content; a later one (a retried attempt, Try again) must make the very
  // same commit, whatever changed since (the creator's name, COMMONFORGE_PUBLIC_URL, the defaults)
  let content: FirstCommit;
  if (row.first_commit_json) content = JSON.parse(row.first_commit_json) as FirstCommit;
  else {
    const user = await getUser(svc.db, row.requested_by);
    if (!user) {
      await failFolderInit(svc, row, "requester_missing", "the person who added this folder no longer exists");
      return { done: true };
    }
    content = { files: firstCommitFiles(r.name, lfsEndpointUrl(svc.env, row.org_id, row.resource_id)), author: commitAuthor(user), message: `Create folder ${r.name}` };
  }
  const canonical = await liveCanonical(svc, row.org_id, row.resource_id);
  const job = { kind: "init-folder", resourceId: row.resource_id, canonical, ...content, commitTime: row.commit_time } as IntegrationJobInput;
  try {
    await issueJob(svc, job, {
      orgId: row.org_id,
      subject: `folder-init:${row.resource_id}`,
      lifetimeSeconds: FOLDER_INIT_JOB_SECONDS,
      jobKey: `folder-init:${row.resource_id}:${row.created_at}:${row.attempts + 1}`,
      // linked (and counted) before the runner can answer; a concurrent step that got here first wins.
      // The content is recorded only now: the job was signed, so COMMONFORGE_PUBLIC_URL (in `.lfsconfig`) is valid.
      beforeEnqueue: async (jobId) => {
        const upd = await svc.db
          .prepare(
            "UPDATE folder_inits SET job_id = ?, attempts = attempts + 1, first_commit_json = COALESCE(first_commit_json, ?), updated_at = ? WHERE org_id = ? AND resource_id = ? AND state = 'pending' AND job_id IS NULL AND attempts = ?",
          )
          .bind(jobId, JSON.stringify(content), svc.nowIso(), row.org_id, row.resource_id, row.attempts)
          .run();
        if ((upd.meta.changes ?? 0) === 0) throw new Raced();
      },
    });
  } catch (e) {
    if (!(e instanceof Raced)) throw e;
  }
  return { done: true };
});

onStepFailed("folders.init", async (svc, msg, reason) => {
  const row = await getFolderInit(svc, msg.orgId, msg.resourceId);
  if (!row || row.state !== "pending") return;
  await failFolderInit(svc, row, "setup_failed", reason);
});

onRunnerResult("init-folder", async (svc, jobRow, _job, result) => {
  const row = await svc.db.prepare("SELECT * FROM folder_inits WHERE org_id = ? AND job_id = ?").bind(jobRow.org_id, jobRow.job_id).first<FolderInitRow>();
  if (!row || row.state !== "pending") return;
  try {
    await settleFolderInit(svc, row, result);
  } catch (e) {
    // the result is stored: the step applies it again (and GC re-queues it if this enqueue fails too)
    console.error(`folder setup ${row.resource_id}: applying the result failed: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
    await enqueueStep(svc, { type: "folders.init", orgId: row.org_id, resourceId: row.resource_id });
  }
});

/** Apply the outcome of the row's current job. Idempotent: every write is guarded on the row's job. */
async function settleFolderInit(svc: Services, row: FolderInitRow, result: RunnerResult): Promise<void> {
  if (!result.ok) return failedAttempt(svc, row, result.code, result.detail);
  const receipt = result.receipt as InitFolderReceipt;
  const r = await getResource(svc.db, row.org_id, row.resource_id);
  const coords = r ? resourceCoords(r) : null;
  if (!r || !coords || coords.kind !== "artifacts") return failFolderInit(svc, row, "not_artifacts", "the folder has no canonical repository");
  // the receipt is the runner's word: canonical main must hold exactly that commit, with no parent
  const [head] = await svc.transport.log(coords.namespace, coords.repoName, { ref: "main", limit: 1 });
  if (receipt.resourceId !== row.resource_id || !head || head.hash !== receipt.commitSha || head.parents.length > 0) {
    const found = head ? `${head.hash}${head.parents.length > 0 ? " (with a parent)" : ""}` : "nothing";
    return failFolderInit(svc, row, "init_mismatch", `the runner reported ${receipt.commitSha}; canonical main holds ${found}`);
  }
  // already bound to this commit (a replay of this bind, or `adopt-head` by someone else): nothing to
  // bind; bound to anything else: not this setup's first version
  const revisionId = artRevisionId(coords.repoId, receipt.commitSha);
  const bound = await svc.ledger(row.org_id).getHead(row.resource_id);
  if (bound && bound.revisionId !== revisionId) return failFolderInit(svc, row, "init_mismatch", `the folder's version is already ${bound.revisionId}`);
  if (!bound) await bindHead(svc, row.org_id, row.resource_id, revisionId, userRef(row.requested_by));
  const now = svc.nowIso();
  const [done] = await svc.db.batch([
    svc.db
      .prepare("UPDATE folder_inits SET state = 'done', commit_sha = ?, error = NULL, updated_at = ? WHERE org_id = ? AND resource_id = ? AND state = 'pending' AND job_id IS ?")
      .bind(receipt.commitSha, now, row.org_id, row.resource_id, row.job_id),
    svc.db.prepare("UPDATE resources SET state = 'active', error = NULL, updated_at = ? WHERE org_id = ? AND resource_id = ? AND state IN ('empty', 'active')").bind(now, row.org_id, row.resource_id),
  ]);
  if ((done!.meta.changes ?? 0) === 0) return;
  await recordEvent(svc, {
    orgId: row.org_id,
    projectId: row.project_id,
    actor: RUNNER,
    action: "resource.initialized",
    subjectKind: "resource",
    subjectId: row.resource_id,
    resourceIds: [row.resource_id],
    detail: { mountName: row.mount_name, commitSha: receipt.commitSha },
  });
}

/** A job that did not make the first version: another one if the failure is retryable and attempts remain. */
async function failedAttempt(svc: Services, row: FolderInitRow, code: string, detail: string): Promise<void> {
  if (!RETRYABLE.has(code) || row.attempts >= MAX_FOLDER_INIT_ATTEMPTS) return failFolderInit(svc, row, code, detail);
  const upd = await svc.db
    .prepare("UPDATE folder_inits SET job_id = NULL, error = ?, updated_at = ? WHERE org_id = ? AND resource_id = ? AND state = 'pending' AND job_id IS ?")
    .bind(`${code}: ${detail}`.slice(0, 1000), svc.nowIso(), row.org_id, row.resource_id, row.job_id)
    .run();
  if ((upd.meta.changes ?? 0) > 0) await enqueueStep(svc, { type: "folders.init", orgId: row.org_id, resourceId: row.resource_id });
}

const REASONS: Record<string, string> = {
  branch_not_empty: "its repository already holds a different first version",
  init_mismatch: "the first version the runner reported is not the one in its repository",
  requester_missing: "the person who added it no longer exists",
};

/** The setup failed: the row and the resource say why; Try again ({@link retryFolderInit}) starts over. */
async function failFolderInit(svc: Services, row: FolderInitRow, code: string, detail: string): Promise<void> {
  const now = svc.nowIso();
  const message = `Setting up this folder failed: ${REASONS[code] ?? detail.slice(0, 300)}`;
  const [failed] = await svc.db.batch([
    svc.db
      .prepare("UPDATE folder_inits SET state = 'failed', error = ?, updated_at = ? WHERE org_id = ? AND resource_id = ? AND state = 'pending' AND job_id IS ? AND attempts = ?")
      .bind(`${code}: ${detail}`.slice(0, 1000), now, row.org_id, row.resource_id, row.job_id, row.attempts),
    svc.db.prepare("UPDATE resources SET state = 'failed', error = ?, updated_at = ? WHERE org_id = ? AND resource_id = ? AND state = 'empty'").bind(message, now, row.org_id, row.resource_id),
  ]);
  if ((failed!.meta.changes ?? 0) === 0) return;
  await recordEvent(svc, {
    orgId: row.org_id,
    projectId: row.project_id,
    actor: RUNNER,
    action: "resource.init_failed",
    subjectKind: "resource",
    subjectId: row.resource_id,
    resourceIds: [row.resource_id],
    detail: { mountName: row.mount_name, code, detail: detail.slice(0, 1000), attempts: row.attempts },
  });
}

/** Try again (P4-9): only a failed setup; attempts start over, the resource is `empty` again. */
export async function retryFolderInit(svc: Services, orgId: string, resourceId: string): Promise<void> {
  const now = svc.nowIso();
  const upd = await svc.db
    .prepare("UPDATE folder_inits SET state = 'pending', attempts = 0, job_id = NULL, commit_sha = NULL, error = NULL, updated_at = ? WHERE org_id = ? AND resource_id = ? AND state = 'failed'")
    .bind(now, orgId, resourceId)
    .run();
  if ((upd.meta.changes ?? 0) === 0) throw conflict("setup_not_failed", "this folder's setup has not failed");
  await svc.db.prepare("UPDATE resources SET state = 'empty', error = NULL, updated_at = ? WHERE org_id = ? AND resource_id = ? AND state = 'failed'").bind(now, orgId, resourceId).run();
  await enqueueStep(svc, { type: "folders.init", orgId, resourceId });
}

/**
 * GC: `pending` setups idle for {@link FOLDER_INIT_STALE_MS} whose job is not running (none, or
 * ended or expired without its outcome applied) get `folders.init` again. The guarded touch makes
 * it once per pass (and per {@link FOLDER_INIT_STALE_MS}). Returns how many were re-queued.
 */
export async function requeueStaleFolderInits(svc: Services, orgId: string, limit = 100): Promise<number> {
  const now = svc.now().getTime();
  const rows = await svc.db
    .prepare(
      "SELECT f.resource_id, f.updated_at FROM folder_inits f WHERE f.org_id = ? AND f.state = 'pending' AND f.updated_at < ? AND NOT EXISTS (SELECT 1 FROM runner_jobs j WHERE j.job_id = f.job_id AND j.status = 'queued' AND j.expires_at > ?) ORDER BY f.updated_at, f.resource_id LIMIT ?",
    )
    .bind(orgId, new Date(now - FOLDER_INIT_STALE_MS).toISOString(), now, limit)
    .all<{ resource_id: string; updated_at: string }>();
  let n = 0;
  for (const r of rows.results) {
    const touch = await svc.db
      .prepare("UPDATE folder_inits SET updated_at = ? WHERE org_id = ? AND resource_id = ? AND state = 'pending' AND updated_at = ?")
      .bind(svc.nowIso(), orgId, r.resource_id, r.updated_at)
      .run();
    if ((touch.meta.changes ?? 0) === 0) continue;
    await enqueueStep(svc, { type: "folders.init", orgId, resourceId: r.resource_id });
    n++;
  }
  return n;
}
