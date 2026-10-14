/**
 * Changes to file collections (`r2-assets` folders; spec 2026-10-07 §7, plan phase 3 P3-3..P3-5).
 * The Worker, not a runner job, applies them:
 *
 * 1. `files.assets.copy` copies one verified upload into the collection's content key
 *    `org/<org>/res/<rid>/obj/<sha256>` (`adoptVerified`: the source etag is pinned and the bytes are
 *    hashed again while they are piped). One step per object, so a 20 GB change never has to fit
 *    into one step invocation (P3-4). Each finished copy wakes the manifest step.
 * 2. `files.assets.manifest` (dispatched by `files.apply`) waits until every upload is verified and
 *    copied, creates the attempt's task with an R2 workspace, writes the new manifest from the base
 *    manifest and the operations, freezes the workspace, opens the proposal, records a synthetic
 *    receipt (every path `content`, so integration runs with no checks) and hands the change to
 *    the phase 2 landing (`files.land`, `files.accept`), which runs unchanged.
 *
 * Asset GC (Task 4 review): a copy that found its content key already there ("already copied")
 * does not refresh it, so a GC run that listed the old, unreferenced object can delete it before
 * the new manifest protects it. Two guards: every pass of the manifest step checks the content keys
 * again (a swept key is copied again), and after the manifest is written and the workspace frozen
 * (from then on every GC run keeps the manifest: it is young, and reachable through the live
 * workspace) the objects are checked once more while holding the GC's own lock (`gc/sweep`), so no
 * run that started before the manifest existed can still be deleting. A key missing then is copied
 * again before the change goes on.
 */
import {
  manifestId as toManifestId,
  parseRevisionId,
  resourceId as toResourceId,
  type AssetManifest,
  type AssetManifestEntry,
} from "@commonforge-org/core";
import { r2AssetKeys } from "@commonforge-org/provider-cloudflare";
import { APPLY_FILES_LIMITS, type ApplyFilesReceipt } from "@commonforge-org/runner-protocol";
import type { Services } from "../context.js";
import { recordEvent, userRef } from "./events.js";
import {
  abandonAttempt,
  attemptTask,
  changeOps,
  closeProposal,
  failChange,
  fileChangeProposalId,
  getFileChange,
  loadObjects,
  rejectionOf,
  stagingIdsOf,
  updateChange,
  type ChangeOp,
  type FileChangeRow,
} from "./file-changes.js";
import { dropChangeUploads, type LfsObjectRow } from "./lfs-store.js";
import { proposeTaskWorkspaces } from "./proposals.js";
import { isStagingProject } from "./staging-state.js";
import { enqueueStep, onStep, onStepFailed } from "./steps.js";
import { getTask, getWorkspaceRow, setTaskState } from "./tasks.js";

const RUNNER = { kind: "runner", id: "integration-runner" } as never;
/** The GC's lock (services/gc.ts `runGc`), held here only while the new manifest's objects are checked. */
const GC_LOCK = ["gc", "sweep"] as const;
const GC_CHECK_LEASE_MS = 60_000;
/** How long the manifest step waits for a GC run holding its lock. */
export const GC_WAIT_SECONDS = 30;
const GC_WAIT_REASON = "waiting for the asset GC run to finish";
/** Provider refusals of a copy that mean the upload is not what was verified. */
const COPY_REJECTIONS = ["asset_staging_missing", "asset_sha256_mismatch", "asset_size_mismatch"];
const DEFAULT_MIME = "application/octet-stream";
/**
 * The lease of an upload's copy lock: a queue consumer invocation runs at most 15 minutes, so a
 * copy still holding the lock after this is gone (its invocation was killed) and may be redone.
 */
export const COPY_LEASE_MS = 15 * 60_000;
/** The manifest step's delay after one of its uploads was swept just before the manifest was written. */
const COPY_SWEPT_RETRY_SECONDS = 5;

const contentKey = (fc: FileChangeRow, sha256: string) => r2AssetKeys.object(fc.org_id, fc.resource_id, sha256);

/** The content key holds this upload's bytes (as `adoptVerified` leaves it: sha256 metadata and the size). */
async function copied(svc: Services, fc: FileChangeRow, o: LfsObjectRow): Promise<boolean> {
  const h = await svc.env.COMMONFORGE_ASSETS.head(contentKey(fc, o.sha256!));
  return !!h && h.customMetadata?.sha256 === o.sha256 && h.size === o.size;
}

/** The uploads (one per staging id) whose content key is missing. */
async function missingCopies(svc: Services, fc: FileChangeRow, ids: readonly string[], objects: ReadonlyMap<string, LfsObjectRow>): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 16) {
    const chunk = ids.slice(i, i + 16);
    const ok = await Promise.all(chunk.map((id) => copied(svc, fc, objects.get(id)!)));
    chunk.forEach((id, j) => !ok[j] && out.push(id));
  }
  return out;
}

const enqueueCopies = async (svc: Services, fc: FileChangeRow, ids: readonly string[]) => {
  for (const stagingId of ids) await enqueueStep(svc, { type: "files.assets.copy", orgId: fc.org_id, changeId: fc.change_id, stagingId });
};

type Applied = { ok: true; entries: AssetManifestEntry[] } | { ok: false; code: string; detail: string };

/**
 * The new manifest's entries: the base entries with the operations applied in order. A put adds or
 * replaces a file; a delete removes a file or everything under a directory (nothing matching is
 * `file_missing`); a move re-paths a file or a directory (an existing destination file with other
 * bytes, or a path below a file or over a directory, is `path_exists`). A move whose source is gone
 * and whose destination exists is taken as done already (a re-applied attempt), as the runner does.
 */
export function applyOps(fc: FileChangeRow, base: readonly AssetManifestEntry[], ops: readonly ChangeOp[], objects: ReadonlyMap<string, LfsObjectRow>): Applied {
  const files = new Map<string, AssetManifestEntry>();
  // files below each directory, so "is it a folder" is one lookup (not a scan of every path)
  const dirs = new Map<string, number>();
  const ancestors = (p: string) => {
    const out: string[] = [];
    for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) out.push(p.slice(0, i));
    return out;
  };
  const set = (p: string, e: AssetManifestEntry) => {
    if (!files.has(p)) for (const d of ancestors(p)) dirs.set(d, (dirs.get(d) ?? 0) + 1);
    files.set(p, e);
  };
  const del = (p: string) => {
    if (!files.delete(p)) return;
    for (const d of ancestors(p)) {
      const n = dirs.get(d)! - 1;
      if (n === 0) dirs.delete(d);
      else dirs.set(d, n);
    }
  };
  for (const e of base) set(e.path as string, e);
  const isDir = (p: string) => dirs.has(p);
  const under = (p: string) => (files.has(p) ? [p] : isDir(p) ? [...files.keys()].filter((f) => f.startsWith(`${p}/`)) : []);
  const blocked = (p: string): string | null => {
    if (isDir(p)) return `${p} is a folder`;
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join("/");
      if (files.has(anc)) return `${anc} is a file, so ${p} cannot be created below it`;
    }
    return null;
  };
  for (const op of ops) {
    if ("put" in op) {
      const why = blocked(op.put);
      if (why) return { ok: false, code: "path_exists", detail: why };
      const o = objects.get(op.stagingId)!;
      set(op.put, { path: op.put, sha256: o.sha256!, size: o.size, mime: o.mime ?? DEFAULT_MIME, objectKey: contentKey(fc, o.sha256!), source: { kind: "upload", ref: op.stagingId } } as AssetManifestEntry);
    } else if ("delete" in op) {
      const paths = under(op.delete);
      if (paths.length === 0) return { ok: false, code: "file_missing", detail: `${op.delete} does not exist` };
      for (const p of paths) del(p);
    } else if ("move" in op) {
      const sources = under(op.move);
      if (sources.length === 0) {
        if (files.has(op.to) || isDir(op.to)) continue;
        return { ok: false, code: "file_missing", detail: `${op.move} does not exist` };
      }
      if (op.to === op.move || op.to.startsWith(`${op.move}/`)) return { ok: false, code: "path_exists", detail: `cannot move ${op.move} into itself` };
      const moves = sources.map((p) => ({ from: p, to: op.to + p.slice(op.move.length), entry: files.get(p)! }));
      for (const m of moves) {
        const there = files.get(m.to);
        if (there && there.sha256 !== m.entry.sha256) return { ok: false, code: "path_exists", detail: `${m.to} already exists` };
      }
      for (const m of moves) del(m.from);
      for (const m of moves) {
        const why = files.has(m.to) ? null : blocked(m.to);
        if (why) return { ok: false, code: "path_exists", detail: why };
        set(m.to, { ...m.entry, path: m.to } as AssetManifestEntry);
      }
    } else return { ok: false, code: "edit_unsupported", detail: `${op.edit}: files in a file collection are not edited in place` };
  }
  return { ok: true, entries: [...files.values()] };
}

/** The receipt `presentFileChange` and `files.land` read: every changed path, all of them content. */
export function assetReceipt(fc: FileChangeRow, base: Pick<AssetManifest, "entries">, next: Pick<AssetManifest, "entries">): ApplyFilesReceipt {
  const before = new Map(base.entries.map((e) => [e.path as string, e]));
  const after = new Map(next.entries.map((e) => [e.path as string, e]));
  const changedPaths: ApplyFilesReceipt["changedPaths"] = [];
  for (const p of [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const b = before.get(p);
    const a = after.get(p);
    if (b && a && b.sha256 === a.sha256 && b.mime === a.mime) continue;
    changedPaths.push({ path: p as never, change: !b ? "added" : !a ? "deleted" : "modified", lfs: false, class: "content" });
  }
  return { changedPaths, lfsObjects: [] } as unknown as ApplyFilesReceipt;
}

/**
 * The bytes a receipt may take in its `file_changes` row (D1 holds at most 2,000,000 per row, and
 * the row also holds the operations): 5,000 paths of up to 1,024 characters would not fit.
 */
export const MAX_RECEIPT_BYTES = 1_000_000;

/**
 * The new manifest's entries and the change's receipt, checked against the change limits before
 * anything is written: at most {@link APPLY_FILES_LIMITS}.maxChangedPaths changed paths, and a
 * receipt of at most {@link MAX_RECEIPT_BYTES}.
 */
export function planManifest(
  fc: FileChangeRow,
  base: Pick<AssetManifest, "entries">,
  ops: readonly ChangeOp[],
  objects: ReadonlyMap<string, LfsObjectRow>,
): { ok: true; entries: AssetManifestEntry[]; receipt: ApplyFilesReceipt; receiptJson: string } | { ok: false; code: string; detail: string } {
  const applied = applyOps(fc, base.entries, ops, objects);
  if (!applied.ok) return applied;
  const receipt = assetReceipt(fc, base, applied);
  const n = receipt.changedPaths.length;
  if (n > APPLY_FILES_LIMITS.maxChangedPaths) return { ok: false, code: "limit_exceeded", detail: `the change would touch ${n} paths; at most ${APPLY_FILES_LIMITS.maxChangedPaths} per change` };
  const receiptJson = JSON.stringify(receipt);
  if (new TextEncoder().encode(receiptJson).length > MAX_RECEIPT_BYTES) return { ok: false, code: "limit_exceeded", detail: `the change touches ${n} paths whose names are too long to record together; split it into smaller changes` };
  return { ok: true, entries: applied.entries, receipt, receiptJson };
}

/**
 * Queue step `files.assets.copy`: copy one verified upload into its content key, then wake the
 * manifest step (naming the upload, so a key swept again right after is noticed). A source that
 * is missing or whose bytes changed since the hash step fails the change `hash_mismatch`. A copy of
 * the same upload already running (its lock held) makes this one a no-op.
 */
onStep("files.assets.copy", async (svc, msg) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.org_id !== msg.orgId || fc.state !== "applying" || fc.proposal_id) return { done: true };
  const o = (await loadObjects(svc, fc.org_id, [msg.stagingId])).get(msg.stagingId);
  if (!o || o.resource_id !== fc.resource_id || o.state !== "verified" || !o.sha256 || !o.etag) return { done: true };
  // one copy per upload at a time: the manifest step enqueues a copy for every missing content key,
  // and a read sweep wakes it while a large copy is still running (nothing touches the change
  // meanwhile). The running copy wakes the manifest step when it ends.
  const out = await svc.gate.withLock("asset-copy", o.staging_id, COPY_LEASE_MS, async () => {
    try {
      await (await svc.assets(fc.org_id)).adoptVerified({ sourceKey: o.r2_key, etag: o.etag!, sha256: o.sha256!, size: o.size, mime: o.mime ?? DEFAULT_MIME, resourceId: toResourceId(fc.resource_id) });
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (typeof code === "string" && COPY_REJECTIONS.includes(code)) {
        await failChange(svc, fc, "hash_mismatch", `upload ${o.staging_id} does not match what was uploaded: its stored bytes changed after they were verified`);
        return false;
      }
      throw e;
    }
    return true;
  });
  if (out.locked || !out.value) return { done: true };
  await enqueueStep(svc, { type: "files.assets.manifest", orgId: fc.org_id, changeId: fc.change_id, copied: o.staging_id });
  return { done: true };
});

onStepFailed("files.assets.copy", async (svc, msg, reason) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.state !== "applying" || fc.proposal_id) return;
  await failChange(svc, fc, "provider_unavailable", reason);
});

/**
 * Queue step `files.assets.manifest`. Idempotent: every pass re-reads the change and does the next
 * missing thing (ids are deterministic per change and attempt, the manifest id per content).
 * Waiting for copies never retries the step (that would spend its attempts while large copies run):
 * the copies it enqueues wake it again, and a lost message is picked up by the read sweep
 * (`settleFileChange` re-enqueues `files.apply`).
 */
onStep("files.assets.manifest", async (svc, msg, attempt) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.org_id !== msg.orgId || fc.state !== "applying" || fc.proposal_id) return { done: true };
  const ops = changeOps(fc);
  const ids = stagingIdsOf(ops);
  const objects = await loadObjects(svc, fc.org_id, ids);
  const gone = ids.find((id) => objects.get(id)?.resource_id !== fc.resource_id);
  if (gone) {
    await failChange(svc, fc, "invalid_upload", `upload ${gone} is no longer available`);
    return { done: true };
  }
  const rejected = ids.find((id) => objects.get(id)!.state === "rejected");
  if (rejected) {
    const why = rejectionOf(objects.get(rejected)!.error);
    await failChange(svc, fc, why.code, `upload ${rejected} ${why.message}`);
    return { done: true };
  }
  // the hash step wakes the change once it verified the last one (lfs-hash.ts wakeFileChanges)
  if (ids.some((id) => objects.get(id)!.state !== "verified")) return { done: true };

  // copies: a wake-up from one copy waits for the others; it copies again only its own key, if that
  // was swept already (an old object a GC run listed before this change's manifest existed). A
  // redelivery (attempt > 1: a key swept before the manifest was written, below) copies whatever
  // is missing, as the message still names the copy that first woke it, not the swept upload
  const missing = await missingCopies(svc, fc, ids, objects);
  if (missing.length > 0) {
    await enqueueCopies(svc, fc, msg.copied === undefined || attempt > 1 ? missing : missing.filter((id) => id === msg.copied));
    return { done: true };
  }

  const row = fc.task_id ? fc : await attemptTask(svc, fc, "r2-assets");
  if (!row || row.attempt !== fc.attempt || !row.task_id || !row.task_workspace_id || !row.base_revision) return { done: true };
  let ws = await getWorkspaceRow(svc, row.task_workspace_id);
  const task = await getTask(svc, row.task_id);
  if (!ws || !task) return { done: true };
  const assets = await svc.assets(fc.org_id);
  const baseId = (parseRevisionId(ws.base_revision) as { manifestId: string }).manifestId;
  const base = await assets.readManifest(baseId, fc.resource_id);
  if (!base) {
    await failChange(svc, row, "manifest_missing", "the folder's accepted version is missing");
    return { done: true };
  }

  if (ws.state !== "frozen") {
    const applied = planManifest(row, base, ops, objects);
    if (!applied.ok) {
      await failChange(svc, row, applied.code, applied.detail);
      return { done: true };
    }
    if (applied.receipt.changedPaths.length === 0) {
      // nothing differs from the folder's version: nothing to propose
      if (!(await updateChange(svc, row, { receipt_json: applied.receiptJson, state: "added", error_code: "no_changes", error: null }, ["applying"]))) return { done: true };
      await abandonAttempt(svc, row, "canceled");
      // the uploads are referenced by nothing now (as when a change is added, proposals.ts landAcceptedFileChange)
      await dropChangeUploads(svc, fc.org_id, fc.change_id);
      await recordEvent(svc, { orgId: fc.org_id, projectId: fc.project_id, actor: RUNNER, action: "files.change_empty", subjectKind: "file_change", subjectId: fc.change_id, resourceIds: [fc.resource_id], detail: { changeId: fc.change_id, attempt: fc.attempt } });
      return { done: true };
    }
    let m: AssetManifest;
    try {
      m = await assets.writeManifest({ resourceId: toResourceId(fc.resource_id), parentManifestId: toManifestId(base.manifestId), entries: applied.entries });
    } catch (e) {
      if ((e as { code?: unknown }).code === "asset_object_missing") {
        const path = (e as { details?: { path?: unknown } }).details?.path;
        const entry = applied.entries.find((x) => x.path === path);
        const uploadKeys = new Set(ids.map((id) => contentKey(fc, objects.get(id)!.sha256!)));
        // one of this change's uploads swept since it was checked: the next pass finds it missing and
        // copies it again (a retry, so the step's attempt budget bounds it)
        if (entry && uploadKeys.has(entry.objectKey)) return { retry: true, delaySeconds: COPY_SWEPT_RETRY_SECONDS, reason: "a copied upload was swept before the manifest was written" };
        // an object of the folder's accepted version is gone: no pass of this change can bring it back
        await failChange(svc, row, "object_missing", `${typeof path === "string" ? path : "a file"} of the folder's current version is missing from storage`);
        return { done: true };
      }
      throw e;
    }
    const receipt = applied.receipt;
    // freeze: the manifest is now reachable through the live workspace (gc.ts reachableAssetManifests)
    const frozen = await svc.db
      .prepare("UPDATE task_workspaces SET asset_manifest_id = ?, state = 'frozen', updated_at = ? WHERE task_workspace_id = ? AND state = 'writable'")
      .bind(m.manifestId, svc.nowIso(), ws.task_workspace_id)
      .run();
    if ((frozen.meta.changes ?? 0) > 0) {
      await setTaskState(svc, task.task_id, "submitted");
      await recordEvent(svc, { orgId: fc.org_id, projectId: fc.project_id, actor: userRef(fc.user_id), action: "task.candidate_frozen", subjectKind: "workspace", subjectId: ws.task_workspace_id, resourceIds: [fc.resource_id], detail: { taskId: task.task_id, manifestId: m.manifestId, changedPaths: receipt.changedPaths.length, fileChangeId: fc.change_id } });
    }
    ws = (await getWorkspaceRow(svc, ws.task_workspace_id))!;
    if (ws.state !== "frozen" || !ws.asset_manifest_id) return { done: true };
  }
  const next = await assets.readManifest(ws.asset_manifest_id!, fc.resource_id);
  if (!next) throw new Error(`manifest ${ws.asset_manifest_id} of file change ${fc.change_id} is missing`);

  // the GC guard: with the GC's lock held no run is between its listing and its deletes, and every
  // later run keeps this manifest and its objects
  const check = await svc.gate.withLock(GC_LOCK[0], GC_LOCK[1], GC_CHECK_LEASE_MS, () => missingCopies(svc, row, ids, objects));
  if (check.locked) return { retry: true, delaySeconds: GC_WAIT_SECONDS, reason: GC_WAIT_REASON };
  if (check.value.length > 0) {
    await enqueueCopies(svc, row, check.value);
    return { done: true };
  }

  // staging mode (M7, ruling R9): as files.candidate does for a git change, the submitted task is
  // handed to staging.land (which stages git candidates only, as for an agent's asset-only task)
  if (await isStagingProject(svc, fc.org_id, fc.project_id)) await enqueueStep(svc, { type: "staging.land", orgId: fc.org_id, taskId: task.task_id });
  const proposalId = await fileChangeProposalId(fc.change_id, fc.attempt);
  await proposeTaskWorkspaces(svc, { orgId: fc.org_id, task: (await getTask(svc, task.task_id))!, proposalId, candidates: [], assetWs: [ws], actor: fc.user_id, detail: { fileChangeId: fc.change_id, attempt: fc.attempt } });
  // recorded before landing: files.land and the accept find the change by its proposal
  if (!(await updateChange(svc, row, { proposal_id: proposalId, receipt_json: JSON.stringify(assetReceipt(row, base, next)) }, ["applying"]))) {
    // the change failed or restarted meanwhile: this proposal belongs to nothing
    const now = await getFileChange(svc, fc.change_id);
    if (now && (now.attempt !== fc.attempt || now.state === "failed")) await closeProposal(svc, fc, proposalId, now.attempt !== fc.attempt ? "superseded" : "withdrawn");
    return { done: true };
  }
  // the proposal is prepared already (the Worker prepares asset manifests): land it
  await enqueueStep(svc, { type: "files.land", orgId: fc.org_id, changeId: fc.change_id });
  return { done: true };
});

onStepFailed("files.assets.manifest", async (svc, msg, reason) => {
  const fc = await getFileChange(svc, msg.changeId);
  if (!fc || fc.state !== "applying" || fc.proposal_id) return;
  // a long GC run is not the change's failure: wait for it with a fresh message (its lock is leased)
  if (reason === GC_WAIT_REASON) {
    await enqueueStep(svc, { type: "files.assets.manifest", orgId: fc.org_id, changeId: fc.change_id });
    return;
  }
  await failChange(svc, fc, "provider_unavailable", reason);
  // the step may have opened the attempt's proposal and then failed to record it on the change
  // (failChange closes only a recorded one): it can never be accepted now
  const now = await getFileChange(svc, fc.change_id);
  if (now && now.attempt === fc.attempt && now.state === "failed" && !now.proposal_id) await closeProposal(svc, fc, await fileChangeProposalId(fc.change_id, fc.attempt), "withdrawn");
});
