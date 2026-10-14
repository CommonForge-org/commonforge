/**
 * File changes (spec 2026-10-07 §6–§7): put / edit / delete / move operations on a git folder,
 * applied by the runner's `apply-files` job to the folder's accepted head in a fresh `-tasks`
 * repository, then frozen and proposed like any task candidate.
 *
 * The lifecycle mirrors an edition return (services/editions.ts):
 * - `files.apply` waits until every referenced upload is verified by the hash step (which wakes
 *   it), creates the attempt's task and workspace, provisions the empty task repo and issues the job;
 * - the job's result either ends the change (a failure, or no changes) or enqueues `files.candidate`;
 * - `files.candidate` freezes the candidate, opens the proposal (deterministic per change and
 *   attempt) and starts `candidate.prepare`.
 * Landing (integration, approval, accept, promotion) follows in `files.land` / `files.accept`.
 *
 * Staging mode (decision "Staging promotion and LFS": through promotion). In a staging-mode project
 * a git folder's change stops at staging like an agent task: `files.candidate` lands its task
 * (`staging.land`), prepares the candidate (staging builds merge prepared candidates only, and so
 * do promotions) and moves the change to `staged`; it opens no proposal of its own and is never
 * integrated, approved or accepted by itself. It reaches `main` only when a promotion accepts its
 * landing: the promotion's accept tail ({@link landPromotedFileChange}) promotes the LFS objects its
 * receipt named and the change is `added`. Its landing failing or rolled back fails it
 * (`staging_failed`, `staging_rolled_back`, through staging's {@link onLandingLeftStaging} hook);
 * a withdrawn or superseded promotion leaves it `staged`. A staged change never restarts on a
 * stale base (promotions rebuild on a moved `main` themselves). Changes that already had their own
 * proposal when this shipped finish on the old path; file collections (`r2-assets`) are not staged.
 *
 * A stale base (another change was accepted first) re-applies uploads, deletes and moves on the new
 * head, up to three attempts; a change with an edit fails `file_changed` instead.
 */
import { candidateId as toCandidateId, r2mRevisionId, sha256Hex, type ProposalRecord } from "@commonforge-org/core";
import { parseApplyFilesOps, type ApplyFilesOp, type ApplyFilesReceipt, type IntegrationJobInput } from "@commonforge-org/runner-protocol";
import { ChaosCrash, chaos } from "../chaos.js";
import type { Services } from "../context.js";
import { ApiError } from "../lib/http.js";
import { lfsSettings } from "../lib/lfs-config.js";
import { canWriteResource } from "../middleware/authz.js";
import { getMount, getProject, getResource, getRole, getUser, projectPolicy, type Role } from "./directory.js";
import { recordEvent, userRef } from "./events.js";
import { promoteObjects, touchObjects, type LfsObjectRow } from "./lfs-store.js";
import {
  SUPERSEDED_CODE,
  acceptInputFor,
  afterProposalAccepted,
  buildProposal,
  getProposalIndex,
  integrationPending,
  latestIntegration,
  latestIntegrationOutcome,
  landAcceptedFileChange,
  proposalResourceIds,
} from "./proposals.js";
import { issueIntegration } from "./integration.js";
import { getJob, issueJob, onRunnerResult, type RunnerJobRow } from "./runner-jobs.js";
import { projectSnapshot } from "./snapshot.js";
import { landingOfTask, landingParts, onLandingLeftStaging, rollbackTask, type LandingRow } from "./staging.js";
import { isStagingProject } from "./staging-state.js";
import { enqueueStep, onStep, onStepFailed, type StepMessage } from "./steps.js";
import { ensureFreshTaskRepo, liveCanonical } from "./task-repos.js";
import { getTask, getWorkspaceRow, newChangeId, setTaskState, setWorkspaceState, taskWorkspaceIdFor } from "./tasks.js";

export type FileChangeState = "applying" | "checking" | "waiting_approval" | "staged" | "added" | "failed";

/**
 * An operation as stored on the change (`ops_json`). Puts name the upload (the Worker fills in what
 * the runner needs from its row when it issues the job); an edit's content lives in the change's R2
 * edits object (`editsKey`), named here by its sha256 (a D1 row holds at most 2 MB, edits up to 16 MiB).
 */
export type ChangeOp = { put: string; stagingId: string } | { edit: string; contentSha256: string; baseBlob: string } | { delete: string } | { move: string; to: string };

/** Everything a change stores in R2 lives under this prefix (Task 10's expiry deletes it with the change). */
export const changePrefix = (orgId: string, changeId: string) => `org/${orgId}/file-changes/${changeId}/`;
/** The edit contents of a change: a JSON object mapping each content's sha256 to the content. */
export const editsKey = (orgId: string, changeId: string) => `${changePrefix(orgId, changeId)}edits.json`;
/** The resolved operations of one attempt (the job's `opsManifest`). */
export const opsManifestKey = (orgId: string, changeId: string, attempt: number) => `${changePrefix(orgId, changeId)}ops-${attempt}.json`;

export interface FileChangeRow {
  change_id: string;
  org_id: string;
  project_id: string;
  resource_id: string;
  mount_name: string;
  user_id: string;
  title: string;
  ops_json: string;
  has_edits: number;
  state: FileChangeState;
  attempt: number;
  task_id: string | null;
  task_workspace_id: string | null;
  job_id: string | null;
  base_revision: string | null;
  receipt_json: string | null;
  proposal_id: string | null;
  error_code: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  /** the creating request's key (POST …/changes `idempotencyKey`), if it sent one */
  idempotency_key?: string | null;
}

/** Uploads and moves re-apply on a newer head at most this many times in all (spec §7). */
export const MAX_FILE_CHANGE_ATTEMPTS = 3;
export const FILE_CHANGE_LOCK_MS = 120_000;
/**
 * States in which a change is still in flight (anything may still fail it): its uploads stay
 * referenced (GC never expires them), it is listed as open and settled when read or swept.
 * `staged` is on staging, waiting for a promotion (staging-mode projects).
 */
export const OPEN_FILE_CHANGE_STATES: readonly FileChangeState[] = ["applying", "checking", "waiting_approval", "staged"];
const OPEN: FileChangeState[] = [...OPEN_FILE_CHANGE_STATES];
/** {@link OPEN_FILE_CHANGE_STATES} as an SQL list. */
export const OPEN_FILE_CHANGE_STATES_SQL = `(${OPEN_FILE_CHANGE_STATES.map((s) => `'${s}'`).join(", ")})`;
const RUNNER = { kind: "runner", id: "integration-runner" } as never;

export async function getFileChange(svc: Services, changeId: string): Promise<FileChangeRow | null> {
  return svc.db.prepare("SELECT * FROM file_changes WHERE change_id = ?").bind(changeId).first<FileChangeRow>();
}

export const changeOps = (row: FileChangeRow) => JSON.parse(row.ops_json) as ChangeOp[];
export const changeReceipt = (row: FileChangeRow) => (row.receipt_json ? (JSON.parse(row.receipt_json) as ApplyFilesReceipt) : null);
export const stagingIdsOf = (ops: readonly ChangeOp[]) => [...new Set(ops.flatMap((op) => ("put" in op ? [op.stagingId] : [])))];

export type Patch = Partial<Pick<FileChangeRow, "state" | "job_id" | "receipt_json" | "proposal_id" | "error_code" | "error">>;

/** Update one attempt of a change (a late action of an earlier attempt changes nothing), optionally only from `from` states. */
export async function updateChange(svc: Services, row: Pick<FileChangeRow, "change_id" | "attempt">, patch: Patch, from?: FileChangeState[]): Promise<boolean> {
  const keys = Object.keys(patch) as Array<keyof Patch>;
  const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
  const where = from ? ` AND state IN (${from.map(() => "?").join(", ")})` : "";
  const r = await svc.db
    .prepare(`UPDATE file_changes SET ${sets} WHERE change_id = ? AND attempt = ?${where}`)
    .bind(...keys.map((k) => patch[k] ?? null), svc.nowIso(), row.change_id, row.attempt, ...(from ?? []))
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Rows of these objects in this org (D1 binds at most 100 parameters per statement). */
export async function loadObjects(svc: Services, orgId: string, ids: readonly string[]): Promise<Map<string, LfsObjectRow>> {
  const out = new Map<string, LfsObjectRow>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await svc.db
      .prepare(`SELECT * FROM lfs_objects WHERE org_id = ? AND staging_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(orgId, ...chunk)
      .all<LfsObjectRow>();
    for (const r of rows.results) out.set(r.staging_id, r);
  }
  return out;
}

// =============================================================================================
// Ending an attempt
// =============================================================================================

/** The attempt's workspace will never be used again (GC deletes the repo); its task ends. */
export async function abandonAttempt(svc: Services, row: FileChangeRow, taskState: "failed" | "canceled"): Promise<void> {
  if (row.task_workspace_id) {
    const ws = await getWorkspaceRow(svc, row.task_workspace_id);
    const ledger = svc.ledger(row.org_id);
    const handle = await ledger.getWorkspace(row.task_workspace_id);
    if (handle && handle.state !== "abandoned" && handle.state !== "collected" && handle.state !== "frozen") await ledger.putWorkspace(row.org_id, { ...handle, state: "abandoned" });
    if (ws && ws.state !== "frozen" && ws.state !== "collected") await setWorkspaceState(svc, ws.task_workspace_id, "abandoned");
  }
  if (row.task_id) await setTaskState(svc, row.task_id, taskState);
}

/** The change failed: the error is recorded, its workspace abandoned and its task failed. */
export async function failChange(svc: Services, row: FileChangeRow, code: string, detail: string): Promise<void> {
  if (!(await updateChange(svc, row, { state: "failed", error_code: code, error: detail.slice(0, 2000) }, OPEN))) return;
  // the attempt's proposal (if it got one) can never be accepted now
  const now = await getFileChange(svc, row.change_id);
  const proposalId = now?.attempt === row.attempt ? now.proposal_id : row.proposal_id;
  if (proposalId) await closeProposal(svc, row, proposalId, "withdrawn");
  await abandonAttempt(svc, row, "failed");
  // a failed change is final (nothing can revise it), so its landing leaves staging (plan P3-6)
  const taskId = now?.attempt === row.attempt ? (now.task_id ?? row.task_id) : row.task_id;
  if (taskId) await rollbackAttemptLanding(svc, row, taskId, { stagingOnly: true });
  await recordEvent(svc, {
    orgId: row.org_id,
    projectId: row.project_id,
    actor: RUNNER,
    action: "files.change_failed",
    subjectKind: "file_change",
    subjectId: row.change_id,
    resourceIds: [row.resource_id],
    detail: { changeId: row.change_id, attempt: row.attempt, code, detail: detail.slice(0, 1000), ...(proposalId ? { proposalId } : {}) },
  });
}

/**
 * Another change was accepted first: drop this attempt (its workspace abandoned, its task canceled)
 * and apply the operations again on the new head. The third attempt fails with `stale_base`. A
 * `staged` change is never restarted (its promotion rebuilds on a moved `main` itself).
 */
export async function restartAttempt(svc: Services, row: FileChangeRow): Promise<void> {
  if (row.attempt >= MAX_FILE_CHANGE_ATTEMPTS) {
    await failChange(svc, row, "stale_base", "another change was added first, three times");
    return;
  }
  const before = await getFileChange(svc, row.change_id);
  const proposalId = before?.attempt === row.attempt ? before.proposal_id : row.proposal_id;
  const r = await svc.db
    .prepare(
      "UPDATE file_changes SET attempt = attempt + 1, state = 'applying', task_id = NULL, task_workspace_id = NULL, job_id = NULL, base_revision = NULL, receipt_json = NULL, proposal_id = NULL, error_code = NULL, error = NULL, updated_at = ? WHERE change_id = ? AND attempt = ? AND state IN ('applying', 'checking', 'waiting_approval')",
    )
    .bind(svc.nowIso(), row.change_id, row.attempt)
    .run();
  if ((r.meta.changes ?? 0) === 0) return;
  // enqueued first: whatever fails below, the next attempt runs (files.apply adopts nothing of this one)
  await enqueueStep(svc, { type: "files.apply", orgId: row.org_id, changeId: row.change_id });
  if (proposalId) await closeProposal(svc, row, proposalId, "superseded");
  await abandonAttempt(svc, row, "canceled");
  // staging mode: the next attempt lands on its own; this attempt's landing leaves staging
  if (row.task_id) await rollbackAttemptLanding(svc, row, row.task_id);
  await recordEvent(svc, {
    orgId: row.org_id,
    projectId: row.project_id,
    actor: RUNNER,
    action: "files.change_reapplied",
    subjectKind: "file_change",
    subjectId: row.change_id,
    resourceIds: [row.resource_id],
    detail: { changeId: row.change_id, attempt: row.attempt + 1, ...(proposalId ? { supersededProposalId: proposalId } : {}) },
  });
}

/**
 * An abandoned attempt's open staging landing (if any) is rolled back. Best effort, never throws: if
 * it fails, the old landing stays in staging (next to the new attempt's, or a failed change's).
 * `stagingOnly`: skipped unless the project is in staging mode (failChange, which also runs for
 * changes outside staging). A landing already `rolling_back`, `rolled_back` or `failed` is left alone.
 */
async function rollbackAttemptLanding(svc: Services, row: FileChangeRow, taskId: string, opts: { stagingOnly?: boolean } = {}): Promise<void> {
  try {
    if (opts.stagingOnly && !(await isStagingProject(svc, row.org_id, row.project_id))) return;
    const open = await svc.db.prepare("SELECT 1 AS x FROM staging_landings WHERE org_id = ? AND task_id = ? AND state IN ('checking', 'landed')").bind(row.org_id, taskId).first();
    if (open) await rollbackTask(svc, row.org_id, taskId, row.user_id);
  } catch (e) {
    console.warn(`file change ${row.change_id}: staging landing of attempt ${row.attempt} not rolled back: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Another change was accepted first: uploads, deletes and moves re-apply; edits never re-run (spec §7). */
export async function staleBase(svc: Services, row: FileChangeRow): Promise<void> {
  if (row.has_edits) return failChange(svc, row, "file_changed", "another change was added first; open the file again");
  return restartAttempt(svc, row);
}

/**
 * Close an abandoned attempt's proposal (the ledger allows open|prepared → superseded|withdrawn), so
 * nobody accepts a version of the change that no longer exists. Best effort: an accepted or already
 * closed proposal stays as it is.
 */
export async function closeProposal(svc: Services, row: FileChangeRow, proposalId: string, state: "superseded" | "withdrawn"): Promise<void> {
  const ledger = svc.ledger(row.org_id);
  try {
    const p = await ledger.getProposal(proposalId);
    if (!p || (p.state !== "open" && p.state !== "prepared")) return;
    const now = svc.nowIso();
    await ledger.putProposal({ ...p, state, updatedAt: now > p.updatedAt ? now : p.updatedAt });
    await recordEvent(svc, {
      orgId: row.org_id,
      projectId: row.project_id,
      actor: RUNNER,
      action: `proposal.${state}`,
      subjectKind: "proposal",
      subjectId: proposalId,
      resourceIds: proposalResourceIds(p),
      detail: { fileChangeId: row.change_id, attempt: row.attempt },
      clientVisible: true,
    });
  } catch (e) {
    console.warn(`file change ${row.change_id}: proposal ${proposalId} not closed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// =============================================================================================
// Apply: the attempt's task → fresh task repo → apply-files job
// =============================================================================================

/**
 * The attempt's task and its one write workspace, as an edition return creates them: a snapshot of
 * the project at the accepted heads with the folder writable. Ids are deterministic per change and
 * attempt, and the rows and the change's pointers to them are written in one batch, so a retried
 * step adopts what an earlier delivery created. Null when the change failed instead.
 *
 * A file collection's attempt (`r2-assets`, services/asset-changes.ts) gets an R2 workspace instead:
 * writable at once (nothing to provision), its base the collection's accepted manifest `r2m:<id>`.
 */
export async function attemptTask(svc: Services, fc: FileChangeRow, provider: "artifacts" | "r2-assets" = "artifacts"): Promise<FileChangeRow | null> {
  const project = await getProject(svc.db, fc.org_id, fc.project_id);
  const mount = project ? await getMount(svc.db, fc.org_id, fc.project_id, fc.mount_name) : null;
  if (!project || !mount || mount.resource_id !== fc.resource_id) {
    await failChange(svc, fc, "folder_missing", "the folder is no longer part of this project");
    return null;
  }
  const snapshot = await projectSnapshot(svc, project, { writeMounts: new Set([fc.mount_name]) });
  const entry = snapshot.entries.find((e) => e.resourceId === fc.resource_id);
  if (!entry) {
    await failChange(svc, fc, "no_accepted_head", "the folder has no accepted version yet");
    return null;
  }
  const taskId = `task-${(await sha256Hex(`cf.file-change-task/1|${fc.change_id}|${fc.attempt}`)).slice(0, 32)}`;
  const wsId = taskWorkspaceIdFor(taskId, fc.resource_id);
  const now = svc.nowIso();
  await svc.db.batch([
    svc.db
      .prepare("INSERT OR IGNORE INTO tasks (task_id, org_id, project_id, change_id, title, request, state, snapshot_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(taskId, fc.org_id, fc.project_id, newChangeId(), fc.title, fc.title, provider === "artifacts" ? "provisioning" : "ready", JSON.stringify(snapshot), fc.user_id, now, now),
    svc.db
      .prepare("INSERT OR IGNORE INTO task_workspaces (task_workspace_id, task_id, org_id, resource_id, mount_name, provider, access, base_revision, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'write', ?, ?, ?, ?)")
      .bind(wsId, taskId, fc.org_id, fc.resource_id, fc.mount_name, provider, entry.revisionId, provider === "artifacts" ? "provisioning" : "writable", now, now),
    // the base is the workspace's (an earlier delivery's rows win over this snapshot)
    svc.db
      .prepare("UPDATE file_changes SET task_id = ?, task_workspace_id = ?, base_revision = (SELECT base_revision FROM task_workspaces WHERE task_workspace_id = ?), updated_at = ? WHERE change_id = ? AND attempt = ? AND task_id IS NULL")
      .bind(taskId, wsId, wsId, now, fc.change_id, fc.attempt),
  ]);
  return getFileChange(svc, fc.change_id);
}

/**
 * The operations as the runner gets them: each put filled from its upload's row (`sha256`, `size`,
 * `binary`, and `r2Key` only for small text files: the runner never fetches LFS objects), each edit
 * with its content from the change's R2 edits object; then checked with `parseApplyFilesOps`
 * (`limit_exceeded` when the runner would refuse them).
 */
async function resolveOps(
  svc: Services,
  fc: FileChangeRow,
  ops: readonly ChangeOp[],
  objects: ReadonlyMap<string, LfsObjectRow>,
  thresholdBytes: number,
): Promise<{ ok: true; ops: ApplyFilesOp[] } | { ok: false; code: string; detail: string }> {
  let contents: Record<string, string> = {};
  if (ops.some((op) => "edit" in op)) {
    const obj = await svc.env.COMMONFORGE_ASSETS.get(editsKey(fc.org_id, fc.change_id));
    if (!obj) return { ok: false, code: "provider_unavailable", detail: "the edited contents of this change are missing" };
    contents = (await obj.json()) as Record<string, string>;
  }
  const out: unknown[] = [];
  for (const op of ops) {
    if ("put" in op) {
      const o = objects.get(op.stagingId)!;
      const binary = o.binary === 1;
      out.push({ put: op.put, stagingId: op.stagingId, sha256: o.sha256!, size: o.size, binary, ...(o.size <= thresholdBytes && !binary ? { r2Key: o.r2_key } : {}) });
    } else if ("edit" in op) {
      const content = contents[op.contentSha256];
      if (typeof content !== "string" || (await sha256Hex(new TextEncoder().encode(content))) !== op.contentSha256) {
        return { ok: false, code: "provider_unavailable", detail: `the edited content of ${op.edit} is missing or damaged` };
      }
      out.push({ edit: op.edit, content, baseBlob: op.baseBlob });
    } else out.push(op);
  }
  try {
    return { ok: true, ops: parseApplyFilesOps(out, thresholdBytes) };
  } catch (e) {
    return { ok: false, code: "limit_exceeded", detail: (e instanceof Error ? e.message : String(e)).slice(0, 1000) };
  }
}

/**
 * Why the hash step (or a pinned read) rejected an upload, from the row's `error`: the code the
 * change fails with and a message naming what happened.
 */
export function rejectionOf(error: string | null): { code: string; message: string } {
  const e = error ?? "";
  if (e === "hash_mismatch") return { code: "hash_mismatch", message: "does not match what was uploaded: its bytes do not hash to the oid git-lfs claimed" };
  if (e === "size_mismatch") return { code: "size_mismatch", message: "does not match what was uploaded: its stored size differs from the declared size" };
  if (e === "missing") return { code: "upload_missing", message: "does not match what was uploaded: its bytes are missing from storage" };
  if (e === "object_changed") return { code: "object_changed", message: "does not match what was uploaded: its bytes were written again after they were verified" };
  if (e.startsWith("hash_failed")) return { code: "hash_failed", message: `could not be verified (${e.slice(0, 300)})` };
  return { code: "upload_rejected", message: `was rejected${e ? ` (${e.slice(0, 300)})` : ""}` };
}

onStep("files.apply", async (svc, msg) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.org_id !== msg.orgId || fc.state !== "applying" || fc.job_id) return { done: true };
  // a file collection's change takes the manifest path (services/asset-changes.ts); the rest is git-only
  if ((await getResource(svc.db, fc.org_id, fc.resource_id))?.provider === "r2-assets") {
    await enqueueStep(svc, { type: "files.assets.manifest", orgId: fc.org_id, changeId: fc.change_id });
    return { done: true };
  }
  const ops = changeOps(fc);
  const ids = stagingIdsOf(ops);
  const objects = await loadObjects(svc, fc.org_id, ids);
  // the route checked the objects; one deleted since (expired) or rejected by the hash step ends the change
  const missing = ids.find((id) => objects.get(id)?.resource_id !== fc.resource_id);
  if (missing) {
    await failChange(svc, fc, "invalid_upload", `upload ${missing} is no longer available`);
    return { done: true };
  }
  const rejected = ids.find((id) => objects.get(id)!.state === "rejected");
  if (rejected) {
    const why = rejectionOf(objects.get(rejected)!.error);
    await failChange(svc, fc, why.code, `upload ${rejected} ${why.message}`);
    return { done: true };
  }
  // the hash step wakes this change once it verified the last one (lfs-hash.ts wakeFileChanges)
  if (ids.some((id) => objects.get(id)!.state !== "verified")) return { done: true };

  // the resolved operations (the job's ops manifest), validated as the runner will validate them
  const { thresholdBytes } = lfsSettings(svc.env);
  const resolved = await resolveOps(svc, fc, ops, objects, thresholdBytes);
  if (!resolved.ok) {
    await failChange(svc, fc, resolved.code, resolved.detail);
    return { done: true };
  }
  const jobOps = resolved.ops;

  const row = fc.task_id ? fc : await attemptTask(svc, fc);
  if (!row || row.attempt !== fc.attempt || !row.task_workspace_id || !row.base_revision) return { done: true };
  const wsId = row.task_workspace_id;
  const out = await svc.gate.withLock("workspace", wsId, FILE_CHANGE_LOCK_MS, async () => {
    const again = await getFileChange(svc, row.change_id);
    if (!again || again.state !== "applying" || again.job_id || again.attempt !== row.attempt || again.task_workspace_id !== wsId || !again.base_revision) return;
    const handle = await ensureFreshTaskRepo(svc, {
      orgId: again.org_id,
      taskWorkspaceId: wsId,
      resourceId: again.resource_id,
      baseRevision: again.base_revision,
      description: `commonforge file change ${again.change_id} attempt ${again.attempt} resource ${again.resource_id}`,
    });
    const canonical = await liveCanonical(svc, again.org_id, again.resource_id);
    const user = await getUser(svc.db, again.user_id);
    if (!user) {
      await failChange(svc, again, "uploader_missing", "the person who made this change no longer exists");
      return;
    }
    // the operations travel as an R2 manifest (a queue message holds 128 KB), bound to the job by sha256 and count
    const manifestBytes = new TextEncoder().encode(JSON.stringify(jobOps));
    const manifestSha = await sha256Hex(manifestBytes);
    const manifestKey = opsManifestKey(again.org_id, again.change_id, again.attempt);
    await svc.env.COMMONFORGE_ASSETS.put(manifestKey, manifestBytes, { sha256: manifestSha, httpMetadata: { contentType: "application/json" } });
    await issueJob(
      svc,
      {
        kind: "apply-files",
        changeId: again.change_id,
        target: { resourceId: again.resource_id, canonical, expectedHead: again.base_revision },
        candidateFork: { taskWorkspaceId: wsId, coords: handle.coords },
        opsManifest: { r2Key: manifestKey, sha256: manifestSha, count: jobOps.length },
        author: { name: (user.display_name?.trim() || user.email).slice(0, 200), email: user.email },
        title: again.title,
        lfsThresholdBytes: thresholdBytes,
      } as IntegrationJobInput,
      {
        orgId: again.org_id,
        subject: `file-change:${again.change_id}`,
        lifetimeSeconds: 3600,
        // linked before the runner can answer, so the result finds its change
        beforeEnqueue: async (jobId) => void (await updateChange(svc, again, { job_id: jobId }, ["applying"])),
      },
    );
  });
  if (out.locked) return { retry: true, delaySeconds: 5, reason: "another step is provisioning this workspace" };
  return { done: true };
});

onStepFailed("files.apply", async (svc, msg, reason) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.state !== "applying" || fc.job_id) return;
  await failChange(svc, fc, "provider_unavailable", reason);
});

onRunnerResult("apply-files", async (svc, row: RunnerJobRow, job, result) => {
  if (job.kind !== "apply-files") return;
  const fc = await svc.db.prepare("SELECT * FROM file_changes WHERE job_id = ?").bind(row.job_id).first<FileChangeRow>();
  if (!fc || fc.state !== "applying") return;
  if (!result.ok) {
    // spec §7: edits never re-run (the file may have changed); uploads, deletes and moves do
    if (result.code === "stale_base") return staleBase(svc, fc);
    return failChange(svc, fc, result.code, result.detail);
  }
  const receipt = result.receipt as ApplyFilesReceipt;
  // the receipt must answer this attempt (parseRunnerResultForJob already bound it to the job)
  if (receipt.changeId !== fc.change_id || receipt.resourceId !== fc.resource_id || receipt.expectedHead !== fc.base_revision) {
    return failChange(svc, fc, "receipt_mismatch", "the runner receipt does not match this change");
  }
  // every object to promote is one of the change's puts, exactly as the hash step recorded it, and
  // one the runner had to store in LFS: binary, over the threshold, or (an LFS pattern matched its
  // path) reported as an LFS path. The operations are not in the signed job, so
  // parseRunnerResultForJob cannot check this.
  if (receipt.lfsObjects.length > 0) {
    const puts = new Map(
      (
        await svc.db
          .prepare("SELECT o.staging_id, o.sha256, o.size, o.binary FROM file_change_objects fo JOIN lfs_objects o ON o.staging_id = fo.staging_id AND o.org_id = ? WHERE fo.change_id = ?")
          .bind(fc.org_id, fc.change_id)
          .all<{ staging_id: string; sha256: string | null; size: number; binary: number | null }>()
      ).results.map((r) => [r.staging_id, r]),
    );
    const lfsPaths = new Set(receipt.changedPaths.filter((p) => p.lfs).map((p) => p.path as string));
    const putPaths = new Map<string, string[]>();
    for (const op of changeOps(fc)) if ("put" in op) putPaths.set(op.stagingId, [...(putPaths.get(op.stagingId) ?? []), op.put]);
    const realLfsPut = (id: string, r: { size: number; binary: number | null }) => r.binary === 1 || r.size > job.lfsThresholdBytes || (putPaths.get(id) ?? []).some((path) => lfsPaths.has(path));
    const foreign = receipt.lfsObjects.find((o) => {
      const r = puts.get(o.stagingId);
      return !r || r.sha256 !== o.sha256 || r.size !== o.size || !realLfsPut(o.stagingId, r);
    });
    if (foreign) return failChange(svc, fc, "receipt_mismatch", `the runner receipt names object ${foreign.stagingId}, which is not one of this change's LFS uploads`);
  }
  if (!(await updateChange(svc, fc, { receipt_json: JSON.stringify(receipt) }, ["applying"]))) return;
  if (!receipt.candidate) {
    // nothing differs from the folder's version: nothing to propose
    if (!(await updateChange(svc, fc, { state: "added", error_code: "no_changes", error: null }, ["applying"]))) return;
    await abandonAttempt(svc, fc, "canceled");
    await recordEvent(svc, { orgId: fc.org_id, projectId: fc.project_id, actor: RUNNER, action: "files.change_empty", subjectKind: "file_change", subjectId: fc.change_id, resourceIds: [fc.resource_id], detail: { changeId: fc.change_id, attempt: fc.attempt } });
    return;
  }
  await enqueueStep(svc, { type: "files.candidate", orgId: fc.org_id, changeId: fc.change_id });
});

// =============================================================================================
// Candidate: freeze → proposal → prepare
// =============================================================================================

/** Deterministic per change and attempt, so a retried step finds the proposal it already opened. */
export async function fileChangeProposalId(changeId: string, attempt: number): Promise<string> {
  return `prop-fc-${(await sha256Hex(`cf.file-change-proposal/1|${changeId}|${attempt}`)).slice(0, 32)}`;
}

/**
 * Queue step `files.candidate`: freeze the runner's candidate exactly like an agent's
 * (`freezeCandidate`: HEAD check, write tokens revoked, changed paths computed server-side), open
 * the proposal, then prepare the candidate. Idempotent per attempt.
 */
onStep("files.candidate", async (svc, msg) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.state !== "applying" || !fc.receipt_json || !fc.task_id || !fc.task_workspace_id) return { done: true };
  const receipt = changeReceipt(fc)!;
  if (!receipt.candidate) return { done: true };
  const task = await getTask(svc, fc.task_id);
  const ws = await getWorkspaceRow(svc, fc.task_workspace_id);
  if (!task || !ws) return { done: true };
  const ledger = svc.ledger(fc.org_id);
  const candidateId = toCandidateId(fc.task_workspace_id, receipt.candidate.sha);
  let rec = await ledger.getCandidate(candidateId);
  if (!rec) {
    if (ws.state === "writable") await setWorkspaceState(svc, ws.task_workspace_id, "freezing", { from: "writable" });
    const handle = await ledger.getWorkspace(ws.task_workspace_id);
    if (!handle) throw new Error("file change workspace is not recorded in the ledger");
    let candidate;
    try {
      candidate = await svc.provider().freezeCandidate({ ...handle, state: "writable" }, { expectedSha: receipt.candidate.sha, submitter: userRef(fc.user_id), tool: "commonforge-files" });
    } catch (e) {
      await setWorkspaceState(svc, ws.task_workspace_id, "writable", { from: "freezing" });
      throw e;
    }
    const now = svc.nowIso();
    await ledger.putCandidate(fc.org_id, { candidate, state: "frozen", preparedReceiptId: null, updatedAt: now });
    await ledger.putWorkspace(fc.org_id, { ...handle, state: "frozen" });
    await setWorkspaceState(svc, ws.task_workspace_id, "frozen");
    await svc.db
      .prepare("INSERT OR IGNORE INTO task_candidates (candidate_id, task_id, org_id, resource_id, task_workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(candidate.candidateId, task.task_id, task.org_id, candidate.resourceId, ws.task_workspace_id, now)
      .run();
    await setTaskState(svc, task.task_id, "submitted");
    await recordEvent(svc, { orgId: fc.org_id, projectId: fc.project_id, actor: userRef(fc.user_id), action: "task.candidate_frozen", subjectKind: "candidate", subjectId: candidate.candidateId, resourceIds: [candidate.resourceId], detail: { taskId: task.task_id, sha: candidate.sha, changedPaths: candidate.changedPaths.length, fileChangeId: fc.change_id } });
    rec = (await ledger.getCandidate(candidateId))!;
  }
  // staging mode (M7, ruling R9): like a task frozen through the candidates route, the attempt's
  // submitted task lands in staging (staging.land is idempotent and a no-op once the task moved on)
  const staging = await isStagingProject(svc, fc.org_id, fc.project_id);
  if (staging) await enqueueStep(svc, { type: "staging.land", orgId: fc.org_id, taskId: task.task_id });
  const proposalId = await fileChangeProposalId(fc.change_id, fc.attempt);
  // ...and stops there: it reaches main through a promotion (an attempt that already opened its own
  // proposal, before this rule shipped, finishes on the old path)
  if (staging && !fc.proposal_id && !(await ledger.getProposal(proposalId))) {
    await stageChange(svc, fc, rec);
    return { done: true };
  }
  if (!(await ledger.getProposal(proposalId))) {
    const built = await buildProposal(svc, (await getTask(svc, task.task_id))!, proposalId, [rec], []);
    await ledger.putProposal(built.record);
    await svc.db
      .prepare("INSERT OR IGNORE INTO proposals_index (proposal_id, org_id, project_id, task_id, base_snapshot_json, candidate_snapshot_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(proposalId, fc.org_id, fc.project_id, task.task_id, JSON.stringify(built.baseSnapshot), JSON.stringify(built.candidateSnapshot), fc.user_id, svc.nowIso())
      .run();
    await recordEvent(svc, {
      orgId: fc.org_id,
      projectId: fc.project_id,
      actor: userRef(fc.user_id),
      action: "proposal.created",
      subjectKind: "proposal",
      subjectId: proposalId,
      resourceIds: proposalResourceIds(built.record),
      detail: { proposalHash: built.record.proposalHash, changeId: task.change_id, fileChangeId: fc.change_id, attempt: fc.attempt },
      clientVisible: true,
      clientDetail: { proposalHash: built.record.proposalHash },
    });
  }
  // recorded before the candidate is prepared: landing (after prepare) finds the change by its proposal
  if (!(await updateChange(svc, fc, { proposal_id: proposalId }, ["applying"]))) {
    // the change failed or restarted meanwhile: this proposal belongs to nothing
    const now = await getFileChange(svc, fc.change_id);
    if (now && (now.attempt !== fc.attempt || now.state === "failed")) await closeProposal(svc, fc, proposalId, now.attempt !== fc.attempt ? "superseded" : "withdrawn");
    return { done: true };
  }
  if (rec.state === "frozen") await enqueueStep(svc, { type: "candidate.prepare", orgId: fc.org_id, candidateId: rec.candidate.candidateId });
  // prepared already (a retried delivery): the prepare step's landing hook may have run before the proposal existed
  else await enqueueStep(svc, { type: "files.land", orgId: fc.org_id, changeId: fc.change_id });
  return { done: true };
});

/**
 * A staging-mode change after its candidate is frozen (its task's `staging.land` is enqueued): the
 * candidate is prepared (the staging build merges, and a promotion integrates, prepared candidates
 * only; `candidate.prepare` lands nothing for a `staged` change) and the change is `staged`. A
 * change that failed meanwhile stays failed: `staging.land` rolls back a landing it makes for the
 * failed task.
 */
async function stageChange(svc: Services, fc: FileChangeRow, rec: { state: string; candidate: { candidateId: string } }): Promise<void> {
  if (rec.state === "frozen") await enqueueStep(svc, { type: "candidate.prepare", orgId: fc.org_id, candidateId: rec.candidate.candidateId });
  if (!(await updateChange(svc, fc, { state: "staged", error_code: null, error: null }, ["applying"]))) return;
  await recordEvent(svc, {
    orgId: fc.org_id,
    projectId: fc.project_id,
    actor: RUNNER,
    action: "files.change_staged",
    subjectKind: "file_change",
    subjectId: fc.change_id,
    resourceIds: [fc.resource_id],
    detail: { changeId: fc.change_id, attempt: fc.attempt, taskId: fc.task_id },
  });
}

onStepFailed("files.candidate", async (svc, msg, reason) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.state !== "applying" || fc.proposal_id) return;
  await failChange(svc, fc, "freeze_failed", reason);
});

// =============================================================================================
// Landing: integrate (content: no checks; code: the policy's) → the uploader's approval → accept
// =============================================================================================

class LandRaced extends Error {}

/**
 * Queue step `files.land` (enqueued by `candidate.prepare` once the change's candidate is
 * prepared): issue the proposal's integration, with the project's checks only when a changed path
 * is code (spec §7; the runner's classes are trusted, ruling R4), and move the change to
 * `checking`. The state changes just before the job is enqueued, so its result always finds the
 * change in `checking`; a concurrent delivery that lost the race drops its unsent job.
 */
onStep("files.land", async (svc, msg) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.org_id !== msg.orgId || fc.state !== "applying" || !fc.proposal_id || !fc.receipt_json) return { done: true };
  const p = await svc.ledger(fc.org_id).getProposal(fc.proposal_id);
  const idx = await getProposalIndex(svc, fc.org_id, fc.proposal_id);
  if (!p || !idx) return { done: true };
  if (p.state === "open") return { retry: true, delaySeconds: 5, reason: "waiting for the candidate to be prepared" };
  // accepted by a person before it landed on its own: finish the landing
  if (p.state === "accepted") {
    await landAcceptedFileChange(svc, { orgId: fc.org_id, proposalId: p.proposalId });
    return { done: true };
  }
  if (p.state !== "prepared") {
    await failChange(svc, fc, "proposal_closed", `the proposal is ${p.state}`);
    return { done: true };
  }
  const code = changeReceipt(fc)!.changedPaths.some((x) => x.class === "code");
  let issued: string | null = null;
  let sent = false;
  try {
    await issueIntegration(svc, userRef(fc.user_id), p, idx, {
      checks: code ? "policy" : "none",
      beforeEnqueue: async (jobId) => {
        if (!(await updateChange(svc, fc, { state: "checking" }, ["applying"]))) {
          await svc.db.prepare("DELETE FROM runner_jobs WHERE job_id = ? AND status = 'queued'").bind(jobId).run();
          throw new LandRaced();
        }
        issued = jobId;
      },
      onSent: () => {
        sent = true;
      },
    });
  } catch (e) {
    if (e instanceof LandRaced) return { done: true };
    if (e instanceof ApiError) {
      if (e.code === "expected_head_stale") await staleBase(svc, fc);
      else await failChange(svc, fc, e.code, e.message);
      return { done: true };
    }
    if (issued && !sent) {
      // the job was never sent: back to applying, and the unsent job never counts as the latest attempt
      await svc.db.prepare("UPDATE runner_jobs SET status = 'failed', result_json = ? WHERE job_id = ? AND status = 'queued'").bind(JSON.stringify({ jobId: issued, ok: false, code: SUPERSEDED_CODE, detail: "the job was never sent" }), issued).run();
      await updateChange(svc, fc, { state: "applying" }, ["checking"]);
    }
    throw e;
  }
  return { done: true };
});

onStepFailed("files.land", async (svc, msg, reason) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.state !== "applying" || !fc.proposal_id) return;
  // still waiting for the candidate: candidate.prepare lands it when it is prepared (or fails it)
  if ((await svc.ledger(fc.org_id).getProposal(fc.proposal_id))?.state !== "prepared") return;
  await failChange(svc, fc, "provider_unavailable", reason);
});

/**
 * Ruling R6 (spec §7, "Owners are listed by default, and developers only if the policy lists
 * them"): the uploader's own automatic approval counts for the roles the project's policy lists
 * explicitly, and only owners when it lists none. (`approvalRoles()`, the approve route's default,
 * stays as it is.)
 */
async function uploaderApprovalRoles(svc: Services, orgId: string, projectId: string): Promise<Role[]> {
  const project = await getProject(svc.db, orgId, projectId);
  const roles = project ? projectPolicy(project).approvalRoles : undefined;
  return roles && roles.length > 0 ? roles : ["owner"];
}

/** A head the proposal was made on (or a must-match-accepted dependency) has moved: accept would refuse it. */
async function proposalBaseMoved(svc: Services, orgId: string, p: ProposalRecord): Promise<boolean> {
  const ledger = svc.ledger(orgId);
  const head = async (rid: string) => (await ledger.getHead(rid))?.revisionId ?? null;
  for (const c of p.resourceChanges) if ((await head(c.resourceId)) !== c.baseRevision) return true;
  for (const c of p.assetManifestChanges) if ((await head(c.resourceId)) !== (c.baseManifestId === null ? null : r2mRevisionId(c.baseManifestId))) return true;
  for (const d of p.readDependencies) if (d.mode === "must-match-accepted" && (await head(d.resourceId)) !== d.revisionId) return true;
  return false;
}

/** Accept refusals after which a file change landing through the proposal is applied again. */
export const FILE_CHANGE_RESTART_CODES: readonly string[] = ["expected_head_stale", "dependency_stale", "policy_revision_stale"];

/**
 * The accept route was refused for a moved head (`expected_head_stale`, `dependency_stale`): a file
 * change landing through this proposal re-applies on the new head (edits fail `file_changed`). For
 * a changed policy (`policy_revision_stale`, ruling R8) every change re-applies, edits too: no file
 * changed, and each edit's baseBlob still guards it.
 */
export async function restartStaleFileChange(svc: Services, orgId: string, proposalId: string, code: string): Promise<void> {
  if (!FILE_CHANGE_RESTART_CODES.includes(code)) return;
  const fc = await svc.db.prepare("SELECT * FROM file_changes WHERE org_id = ? AND proposal_id = ? AND state IN ('checking', 'waiting_approval')").bind(orgId, proposalId).first<FileChangeRow>();
  if (!fc) return;
  if (code === "policy_revision_stale") await restartAttempt(svc, fc);
  else await staleBase(svc, fc);
}

/** Deterministic per change and attempt: a retried delivery finds the approval it recorded. */
async function uploaderApprovalId(changeId: string, attempt: number): Promise<string> {
  return `apr-fc-${(await sha256Hex(`cf.file-change-approval/1|${changeId}|${attempt}`)).slice(0, 32)}`;
}

/**
 * Queue step `files.accept` (enqueued by the integrate result applier, `integrationOk` and the
 * failure's code): a failed integration fails the change (a stale base re-applies it); otherwise the uploader's approval is recorded when their role is in the project's
 * `approvalRoles` (else the change waits for a listed role's approval, and the accept route lands
 * it) and the proposal is accepted under a per-attempt idempotency key. A moved head re-applies
 * the change (edits fail `file_changed`).
 */
onStep("files.accept", async (svc, msg, attempt) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.org_id !== msg.orgId || fc.state !== "checking" || !fc.proposal_id) return { done: true };
  const orgId = fc.org_id;
  const ledger = svc.ledger(orgId);
  const p = await ledger.getProposal(fc.proposal_id);
  if (!p) return { done: true };
  // accepted already (by a person, or by an earlier delivery interrupted before its landing tail)
  if (p.state === "accepted") {
    await landAcceptedFileChange(svc, { orgId, proposalId: p.proposalId, userId: fc.user_id });
    return { done: true };
  }
  if (p.state !== "prepared") {
    await failChange(svc, fc, "proposal_closed", `the proposal is ${p.state}`);
    return { done: true };
  }
  // the accept route's window: the runner reported success, the ledger has no receipt yet
  if ((await integrationPending(svc, orgId, p.proposalId)) === "applying") return { retry: true, delaySeconds: 3, reason: "the validation result is still being recorded" };
  // the message says how the run ended; the job ledger is read again, so a late message of an
  // earlier attempt (another proposal) never decides this one: while this proposal's run is still
  // going, its own result continues the change
  const outcome = await latestIntegrationOutcome(svc, orgId, p.proposalId);
  if (!outcome) return { done: true };
  if (!outcome.ok) {
    if (outcome.code === "stale_base") await staleBase(svc, fc);
    else await failChange(svc, fc, outcome.code ?? "check_failed", outcome.detail ?? msg.detail ?? "the project's checks failed");
    return { done: true };
  }
  // a run that reported success with an unmet required check (the ledger's rule: it would refuse
  // the accept as evidence_missing) is the check failure it is
  const integ = await latestIntegration(svc, orgId, p.proposalId);
  const unmet = integ?.receipt.evidence.proposalHash === p.proposalHash ? integ.receipt.evidence.checks.find((c) => c.result !== "pass" && c.required !== false) : undefined;
  if (unmet) {
    await failChange(svc, fc, "check_failed", `check ${unmet.checkId}: ${unmet.result}`);
    return { done: true };
  }

  // the uploader still holds write on the folder (a grant revoked since the upload ends the change)
  const role = await getRole(svc.db, orgId, fc.user_id);
  const actor = role ? { orgId, userId: fc.user_id, role } : null;
  if (!actor || (actor.role !== "owner" && actor.role !== "developer") || !(await canWriteResource(svc, actor, fc.resource_id))) {
    await failChange(svc, fc, "no_write_grant", "the person who made this change can no longer write to this folder");
    return { done: true };
  }
  if (!(await uploaderApprovalRoles(svc, orgId, fc.project_id)).includes(actor.role)) {
    if (await updateChange(svc, fc, { state: "waiting_approval" }, ["checking"])) {
      await recordEvent(svc, { orgId, projectId: fc.project_id, actor: RUNNER, action: "files.change_waiting_approval", subjectKind: "file_change", subjectId: fc.change_id, resourceIds: [fc.resource_id], detail: { changeId: fc.change_id, attempt: fc.attempt, proposalId: p.proposalId } });
    }
    return { done: true };
  }
  const approvals = await ledger.listApprovals(p.proposalId);
  if (!approvals.some((a) => a.approver.id === fc.user_id && a.proposalHash === p.proposalHash)) {
    const approval = { approvalId: await uploaderApprovalId(fc.change_id, fc.attempt), proposalId: p.proposalId, proposalHash: p.proposalHash, approver: userRef(fc.user_id), role: actor.role, approvedAt: svc.nowIso() };
    await ledger.putApproval(orgId, approval);
    await recordEvent(svc, { orgId, projectId: fc.project_id, actor: userRef(fc.user_id), action: "proposal.approved", subjectKind: "proposal", subjectId: p.proposalId, resourceIds: proposalResourceIds(p), detail: { role: actor.role, proposalHash: p.proposalHash, fileChangeId: fc.change_id }, clientVisible: true });
  }

  let input;
  try {
    input = await acceptInputFor(svc, p, `${orgId}:fc:${fc.change_id}:${fc.attempt}`, userRef(fc.user_id));
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    await failChange(svc, fc, e.code, e.message);
    return { done: true };
  }
  const decision = await ledger.accept(input);
  if (decision.ok) {
    // chaos: the accept committed, the landing tail never ran (1st delivery); the retry finishes it
    if (attempt <= 1 && chaos(svc.env, "after_file_change_accept_before_landing", fc.change_id)) throw new ChaosCrash("after_file_change_accept_before_landing");
    await afterProposalAccepted(svc, { orgId, p, projectId: fc.project_id, userId: fc.user_id, acceptedVersionId: decision.acceptedVersionId, replayed: decision.replayed });
    return { done: true };
  }
  if (decision.code === "expected_head_stale" || decision.code === "dependency_stale") {
    await staleBase(svc, fc);
    return { done: true };
  }
  // R8: the project's policy changed since the proposal was made: apply again under the new one
  // (edits too: no file changed, and their baseBlob still guards them)
  if (decision.code === "policy_revision_stale") {
    await restartAttempt(svc, fc);
    return { done: true };
  }
  // accepted by a person between our read and our accept
  if ((await ledger.getProposal(p.proposalId))?.state === "accepted") {
    await landAcceptedFileChange(svc, { orgId, proposalId: p.proposalId, userId: fc.user_id });
    return { done: true };
  }
  await failChange(svc, fc, decision.code, decision.detail ?? decision.code);
  return { done: true };
});

onStepFailed("files.accept", async (svc, msg, reason) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.state !== "checking") return;
  await failChange(svc, fc, "provider_unavailable", reason);
});

/** An open change untouched this long is looked at again when it is read (a step may have been lost). */
export const FILE_CHANGE_STUCK_MS = 2 * 60_000;

/**
 * Called when a change is read: a change whose job the GC closed (expired without a result) is
 * failed, as an edition return's `settle` (GC does not run result appliers). A change in
 * `checking` or `waiting_approval` whose proposal is accepted finishes landing; one waiting for an
 * approval whose base moved re-applies (edits fail `file_changed`). An open change that
 * has not moved for {@link FILE_CHANGE_STUCK_MS} gets its next step enqueued again (every step
 * re-reads its change and is a no-op when there is nothing to do):
 * - `applying` with a proposal: `files.land` (waits for the candidate to be prepared);
 * - `applying` without a job: `files.apply` (a file collection's change has none: its manifest step);
 * - `applying` with a receipt naming a candidate and no proposal: `files.candidate`;
 * - `checking` whose latest integration has ended (or expired): `files.accept` with its outcome.
 */
export async function settleFileChange(svc: Services, row: FileChangeRow): Promise<FileChangeRow> {
  if (row.state === "applying" && row.job_id && !row.receipt_json) {
    const job = await getJob(svc, row.job_id);
    const result = job?.status === "failed" && job.result_json ? (JSON.parse(job.result_json) as { code?: string; detail?: string }) : null;
    if (result?.code === "job_expired") {
      await failChange(svc, row, "job_expired", result.detail ?? "the job expired without a result");
      return (await getFileChange(svc, row.change_id))!;
    }
  }
  if (row.state === "staged") return settleStagedChange(svc, row);
  // checked on every read (they are states, not lost steps): an accepted proposal whose landing tail
  // was interrupted, and a change waiting for an approval whose base moved (it can never be accepted)
  if ((row.state === "checking" || row.state === "waiting_approval") && row.proposal_id) {
    const p = await svc.ledger(row.org_id).getProposal(row.proposal_id);
    if (p?.state === "accepted") {
      await landAcceptedFileChange(svc, { orgId: row.org_id, proposalId: p.proposalId });
      return (await getFileChange(svc, row.change_id))!;
    }
    if (row.state === "waiting_approval" && p && (p.state === "open" || p.state === "prepared") && (await proposalBaseMoved(svc, row.org_id, p))) {
      await staleBase(svc, row);
      return (await getFileChange(svc, row.change_id))!;
    }
  }
  if (!OPEN.includes(row.state) || svc.now().getTime() - Date.parse(row.updated_at) < FILE_CHANGE_STUCK_MS) return row;
  const orgId = row.org_id;
  const changeId = row.change_id;
  let step: StepMessage | null = null;
  if (row.state === "applying") {
    if (row.proposal_id) step = { type: "files.land", orgId, changeId };
    else if (!row.job_id) step = { type: "files.apply", orgId, changeId };
    else if (changeReceipt(row)?.candidate) step = { type: "files.candidate", orgId, changeId };
  } else if (row.state === "checking" && row.proposal_id) {
    const outcome = await latestIntegrationOutcome(svc, orgId, row.proposal_id);
    if (outcome) step = { type: "files.accept", orgId, changeId, integrationOk: outcome.ok, ...(outcome.code ? { code: outcome.code } : {}), ...(outcome.detail ? { detail: outcome.detail.slice(0, 1000) } : {}) };
  }
  if (!step) return row;
  // touched, so the next read within the window does not enqueue it again
  if (!(await updateChange(svc, row, {}, [row.state]))) return row;
  await enqueueStep(svc, step);
  return (await getFileChange(svc, changeId))!;
}

// =============================================================================================
// Staging mode: a staged change follows its landing
// =============================================================================================

/** What the uploader reads when a staged change leaves staging (composed here, never runner text). */
export const STAGED_CHANGE_TEXT = {
  failed: "This change was dropped from staging, so it did not reach production. Make the change again.",
  rolledBack: "This change was taken out of staging, so it did not reach production.",
} as const;

/** A change that failed because staging dropped its landing: a promotion that accepts that landing anyway (review M5) still adds it. */
const STAGING_FAILED = "staging_failed";

/**
 * A promotion accepted the landing that carries `taskId` into `main` (the promotion's accept tail,
 * and again when its release starts; a staged change's read and GC sweep): the change staged through
 * that task promotes the LFS objects its runner receipt named and becomes `added` (event
 * `files.change_added`, once). Also a change failed `staging_failed` (its landing failed after the
 * promotion's set guard, and the accept took it anyway). Idempotent; false when no such change.
 */
export async function landPromotedFileChange(svc: Services, a: { orgId: string; taskId: string; promotionId?: string; acceptedVersionId?: string | null }): Promise<boolean> {
  const fc = await svc.db
    .prepare("SELECT * FROM file_changes WHERE org_id = ? AND task_id = ? AND (state = 'staged' OR (state = 'failed' AND error_code = ?))")
    .bind(a.orgId, a.taskId, STAGING_FAILED)
    .first<FileChangeRow>();
  if (!fc) return false;
  const receipt = changeReceipt(fc);
  const ids = (receipt?.lfsObjects ?? []).map((o) => o.stagingId);
  await promoteObjects(svc, a.orgId, ids);
  // main now has pointers to these objects: one that is gone or not verified is served as a
  // missing pointer (never expected: GC keeps them while the landing is claimed; review I1)
  const rows = await loadObjects(svc, a.orgId, ids);
  const missing = ids.filter((id) => rows.get(id)?.state !== "verified" || rows.get(id)?.accepted_at === null);
  if (missing.length) console.error(`file change ${fc.change_id}: promoted to main, but LFS objects are missing or unverified: ${missing.slice(0, 20).join(", ")}`);
  const r = await svc.db
    .prepare("UPDATE file_changes SET state = 'added', error_code = NULL, error = NULL, updated_at = ? WHERE change_id = ? AND attempt = ? AND task_id = ? AND (state = 'staged' OR (state = 'failed' AND error_code = ?))")
    .bind(svc.nowIso(), fc.change_id, fc.attempt, a.taskId, STAGING_FAILED)
    .run();
  if ((r.meta.changes ?? 0) === 0) return true;
  if (missing.length) {
    await recordEvent(svc, {
      orgId: a.orgId,
      projectId: fc.project_id,
      actor: { kind: "service", id: "promotion-service" } as never,
      action: "files.change_objects_missing",
      subjectKind: "file_change",
      subjectId: fc.change_id,
      resourceIds: [fc.resource_id],
      detail: { changeId: fc.change_id, taskId: a.taskId, missing: missing.slice(0, 200), count: missing.length, ...(a.promotionId ? { promotionId: a.promotionId } : {}) },
    });
  }
  await recordEvent(svc, {
    orgId: a.orgId,
    projectId: fc.project_id,
    actor: { kind: "service", id: "promotion-service" } as never,
    action: "files.change_added",
    subjectKind: "file_change",
    subjectId: fc.change_id,
    resourceIds: [fc.resource_id],
    detail: {
      changeId: fc.change_id,
      attempt: fc.attempt,
      taskId: a.taskId,
      ...(a.promotionId ? { promotionId: a.promotionId } : {}),
      ...(a.acceptedVersionId ? { acceptedVersionId: a.acceptedVersionId } : {}),
      objects: receipt?.lfsObjects?.length ?? 0,
    },
  });
  return true;
}

/**
 * Staging's hook: a landing failed or was rolled back, so every change staged through one of its
 * parts can never reach `main` and fails (`staging_failed` with the landing's platform text, or
 * `staging_rolled_back`). failChange's own rollback (plan P3-6) finds the landing already out of
 * staging, so nothing loops. Changes that are not `staged` (failed already, or on the old path)
 * are left alone.
 */
async function failStagedChanges(svc: Services, l: LandingRow, state: "failed" | "rolled_back", reason?: { code: string; text: string }): Promise<void> {
  for (const part of await landingParts(svc, l)) {
    const fc = await svc.db.prepare("SELECT * FROM file_changes WHERE org_id = ? AND task_id = ? AND state = 'staged'").bind(l.org_id, part.taskId).first<FileChangeRow>();
    if (!fc) continue;
    if (state === "failed") {
      // a promotion that is accepting may still add it (review M5): its uploads' expiry starts now,
      // and GC keeps them while the landing is claimed (gc.ts UNNEEDED)
      await touchObjects(svc, fc.org_id, stagingIdsOf(changeOps(fc)));
      await failChange(svc, fc, STAGING_FAILED, reason?.text ? `${STAGED_CHANGE_TEXT.failed} (${reason.text})` : STAGED_CHANGE_TEXT.failed);
    } else await failChange(svc, fc, "staging_rolled_back", STAGED_CHANGE_TEXT.rolledBack);
  }
}
onLandingLeftStaging(failStagedChanges);

/** A staged change whose task has no landing this long after its candidate was frozen: staging never took it (`staging.land` kept failing). */
export const STAGED_LAND_DEADLINE_MS = 6 * 3600_000;

/**
 * A `staged` change when it is read or swept (repairs, never a second path): its landing promoted →
 * the promotion's tail ({@link landPromotedFileChange}); failed or rolled back → failed (the hook
 * did not run); no landing yet and idle for {@link FILE_CHANGE_STUCK_MS} → `staging.land` again,
 * and after {@link STAGED_LAND_DEADLINE_MS} failed `staging_land_failed`. A landing in staging
 * (`checking`, `landed`, `rolling_back`, `promoting`) leaves it as it is.
 */
async function settleStagedChange(svc: Services, row: FileChangeRow): Promise<FileChangeRow> {
  if (!row.task_id) return row;
  const l = await landingOfTask(svc, row.org_id, row.task_id);
  if (l?.state === "promoted") await landPromotedFileChange(svc, { orgId: row.org_id, taskId: row.task_id });
  else if (l?.state === "failed") await failStagedChanges(svc, l, "failed", l.reason ? { code: l.reason_code ?? "failed", text: l.reason } : undefined);
  else if (l?.state === "rolled_back") await failStagedChanges(svc, l, "rolled_back");
  else if (!l) {
    const idle = svc.now().getTime() - Date.parse(row.updated_at);
    // staged right after its candidate was frozen (task_candidates is written by the freeze)
    const staged = (await svc.db.prepare("SELECT MIN(created_at) AS t FROM task_candidates WHERE task_id = ?").bind(row.task_id).first<{ t: string | null }>())?.t ?? row.created_at;
    if (svc.now().getTime() - Date.parse(staged) > STAGED_LAND_DEADLINE_MS) await failChange(svc, row, "staging_land_failed", STAGED_CHANGE_TEXT.failed);
    else if (idle >= FILE_CHANGE_STUCK_MS && (await updateChange(svc, row, {}, ["staged"]))) await enqueueStep(svc, { type: "staging.land", orgId: row.org_id, taskId: row.task_id });
  } else return row;
  return (await getFileChange(svc, row.change_id))!;
}

// =============================================================================================
// Presentation
// =============================================================================================

export function presentFileChange(row: FileChangeRow) {
  const receipt = changeReceipt(row);
  return {
    changeId: row.change_id,
    projectId: row.project_id,
    mountName: row.mount_name,
    title: row.title,
    state: row.state,
    attempt: row.attempt,
    proposalId: row.proposal_id,
    /** the attempt's task (staging-mode projects: the task to promote from staging), once there is one */
    taskId: row.task_id,
    ...(row.state === "failed" ? { error: { code: row.error_code ?? "failed", message: row.error ?? row.error_code ?? "the change failed" } } : {}),
    ...(row.error_code === "no_changes" ? { note: "no_changes" } : {}),
    ...(receipt ? { changedPaths: receipt.changedPaths } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
