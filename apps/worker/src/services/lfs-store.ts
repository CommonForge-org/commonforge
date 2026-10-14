// apps/worker/src/services/lfs-store.ts
/**
 * LFS objects (spec 2026-10-07 §4): one row per stored object. An object is usable once the hash
 * step verified it; it is "accepted" (served to everyone with read) once a change that references
 * it is accepted. Agents' objects are promoted per task (lfs_task_promotions), including objects
 * whose hash is verified only after the accept.
 */
import type { Services } from "../context.js";
import { newId } from "../lib/crypto.js";
import { lfsObjectKey } from "../lib/lfs-config.js";
import { OPEN_FILE_CHANGE_STATES_SQL } from "./file-changes.js";

export type LfsState = "uploading" | "uploaded" | "verified" | "rejected";

export interface LfsObjectRow {
  staging_id: string;
  org_id: string;
  resource_id: string;
  r2_key: string;
  size: number;
  claimed_oid: string | null;
  sha256: string | null;
  binary: number | null;
  /** the R2 etag of the bytes the hash step verified (pinned by every reader) */
  etag: string | null;
  /** the git blob id of this object's LFS pointer text (plan phase 3, P3-2); NULL until verified */
  pointer_oid: string | null;
  /** GC re-enqueues of the hash step for an object stuck in `uploaded` */
  hash_attempts: number;
  state: LfsState;
  accepted_at: string | null;
  source: "browser" | "lfs";
  user_id: string;
  task_id: string | null;
  upload_id: string | null;
  path: string | null;
  mime: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string;
}

export interface NewLfsObject {
  orgId: string;
  resourceId: string;
  size: number;
  source: "browser" | "lfs";
  userId: string;
  taskId?: string | null;
  claimedOid?: string | null;
  uploadId?: string | null;
  path?: string | null;
  mime?: string | null;
  state: "uploading";
  /** browser uploads pick their id before the R2 multipart upload exists (its key needs it) */
  stagingId?: string;
}

export async function createLfsObject(svc: Services, o: NewLfsObject): Promise<LfsObjectRow> {
  const stagingId = o.stagingId ?? newId("lfs", 12);
  const now = svc.nowIso();
  await svc.db
    .prepare(
      "INSERT INTO lfs_objects (staging_id, org_id, resource_id, r2_key, size, claimed_oid, state, source, user_id, task_id, upload_id, path, mime, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(stagingId, o.orgId, o.resourceId, lfsObjectKey(o.orgId, o.resourceId, stagingId), o.size, o.claimedOid ?? null, o.state, o.source, o.userId, o.taskId ?? null, o.uploadId ?? null, o.path ?? null, o.mime ?? null, now, now, now)
    .run();
  return (await getLfsObject(svc, o.orgId, stagingId))!;
}

export async function getLfsObject(svc: Services, orgId: string, stagingId: string): Promise<LfsObjectRow | null> {
  return svc.db.prepare("SELECT * FROM lfs_objects WHERE staging_id = ? AND org_id = ?").bind(stagingId, orgId).first<LfsObjectRow>();
}

export async function markUploaded(svc: Services, stagingId: string): Promise<boolean> {
  const r = await svc.db.prepare("UPDATE lfs_objects SET state = 'uploaded', updated_at = ? WHERE staging_id = ? AND state = 'uploading'").bind(svc.nowIso(), stagingId).run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * uploaded → verified with the platform's hash, the R2 etag of the bytes it hashed and the git blob
 * id of its pointer text, in one statement. An object of a promoted task is
 * accepted at once, but only if it was created at or before the promotion (an agent cannot upload
 * under the same task after its proposal was accepted and get auto-accepted).
 */
export async function markVerified(svc: Services, stagingId: string, sha256: string, binary: boolean, etag: string, pointerOid: string): Promise<boolean> {
  const r = await svc.db
    .prepare(
      "UPDATE lfs_objects SET state = 'verified', sha256 = ?, binary = ?, etag = ?, pointer_oid = ?, updated_at = ?, accepted_at = (SELECT p.accepted_at FROM lfs_task_promotions p WHERE p.org_id = lfs_objects.org_id AND p.task_id = lfs_objects.task_id AND p.resource_id = lfs_objects.resource_id AND lfs_objects.created_at <= p.accepted_at) WHERE staging_id = ? AND state = 'uploaded'",
    )
    .bind(sha256, binary ? 1 : 0, etag, pointerOid, svc.nowIso(), stagingId)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

export async function markRejected(svc: Services, stagingId: string, reason: string): Promise<void> {
  await svc.db.prepare("UPDATE lfs_objects SET state = 'rejected', error = ?, updated_at = ? WHERE staging_id = ? AND state IN ('uploading', 'uploaded')").bind(reason.slice(0, 500), svc.nowIso(), stagingId).run();
}

/**
 * The verified object's bytes changed after the hash step (its key was written again, e.g. through
 * a presigned PUT that had not expired): it is rejected, whether accepted or not, and never served
 * again. Nothing is deleted here (GC handles rejected rows). Only the etag that was pinned counts.
 */
export async function markChanged(svc: Services, stagingId: string, etag: string): Promise<boolean> {
  const r = await svc.db
    .prepare("UPDATE lfs_objects SET state = 'rejected', error = 'object_changed', updated_at = ? WHERE staging_id = ? AND state = 'verified' AND etag = ?")
    .bind(svc.nowIso(), stagingId, etag)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** The caller's unfinished git-lfs upload of `oid` (user uploads have no task; agents match their task). */
export async function findPendingLfsUpload(svc: Services, q: { orgId: string; resourceId: string; oid: string; userId: string; taskId: string | null }): Promise<LfsObjectRow | null> {
  return svc.db
    .prepare(
      "SELECT * FROM lfs_objects WHERE org_id = ? AND resource_id = ? AND claimed_oid = ? AND source = 'lfs' AND state = 'uploading' AND user_id = ? AND task_id IS ? ORDER BY created_at DESC LIMIT 1",
    )
    .bind(q.orgId, q.resourceId, q.oid, q.userId, q.taskId)
    .first<LfsObjectRow>();
}

/** A verified, accepted object with this oid in this folder. */
export async function acceptedObject(svc: Services, orgId: string, resourceId: string, oid: string): Promise<LfsObjectRow | null> {
  return svc.db
    .prepare("SELECT * FROM lfs_objects WHERE org_id = ? AND resource_id = ? AND sha256 = ? AND state = 'verified' AND accepted_at IS NOT NULL ORDER BY accepted_at LIMIT 1")
    .bind(orgId, resourceId, oid)
    .first<LfsObjectRow>();
}

/**
 * The object a reader may download: an accepted one, or (when `staged` is allowed: owners and
 * developers; agents with `taskId` only for their own task's objects) a verified unaccepted one.
 */
export async function servableObject(svc: Services, q: { orgId: string; resourceId: string; oid: string; staged: boolean; taskId?: string }): Promise<LfsObjectRow | null> {
  const accepted = await acceptedObject(svc, q.orgId, q.resourceId, q.oid);
  if (accepted || !q.staged) return accepted;
  if (q.taskId !== undefined) {
    return svc.db
      .prepare("SELECT * FROM lfs_objects WHERE org_id = ? AND resource_id = ? AND sha256 = ? AND state = 'verified' AND task_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(q.orgId, q.resourceId, q.oid, q.taskId)
      .first<LfsObjectRow>();
  }
  return svc.db
    .prepare("SELECT * FROM lfs_objects WHERE org_id = ? AND resource_id = ? AND sha256 = ? AND state = 'verified' ORDER BY created_at DESC LIMIT 1")
    .bind(q.orgId, q.resourceId, q.oid)
    .first<LfsObjectRow>();
}

/**
 * The verified objects whose pointer text has one of these git blob ids (tree entries), by blob id.
 * Accepted ones only unless `staged`; when a blob id has several rows the accepted one wins, then
 * the newest. Pointers to objects CommonForge never received are simply absent.
 */
export async function pointerObjects(svc: Services, q: { orgId: string; resourceId: string; oids: readonly string[]; staged: boolean }): Promise<Map<string, LfsObjectRow>> {
  const out = new Map<string, LfsObjectRow>();
  const oids = [...new Set(q.oids)];
  // a folder listing can name many files: 90 per statement (D1 binds at most 100 parameters)
  for (let i = 0; i < oids.length; i += 90) {
    const chunk = oids.slice(i, i + 90);
    const rows = (
      await svc.db
        .prepare(
          `SELECT * FROM lfs_objects WHERE org_id = ? AND resource_id = ? AND state = 'verified'${q.staged ? "" : " AND accepted_at IS NOT NULL"} AND pointer_oid IN (${chunk.map(() => "?").join(", ")}) ORDER BY (accepted_at IS NULL), created_at DESC`,
        )
        .bind(q.orgId, q.resourceId, ...chunk)
        .all<LfsObjectRow>()
    ).results;
    // ordered best first: the first row seen for a blob id is the one served
    for (const r of rows) if (!out.has(r.pointer_oid!)) out.set(r.pointer_oid!, r);
  }
  return out;
}

/**
 * Delete these unaccepted objects, rows first and bytes second (as the GC does: a leaked key is
 * harmless, a row without its bytes is not). Accepted rows, and other orgs' ids, are skipped.
 * Returns the rows deleted.
 */
export async function dropObjects(svc: Services, orgId: string, stagingIds: readonly string[]): Promise<number> {
  const ids = [...new Set(stagingIds)];
  let n = 0;
  // 90 per statement (D1 binds at most 100 parameters)
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const gone = (
      await svc.db
        .prepare(`DELETE FROM lfs_objects WHERE org_id = ? AND accepted_at IS NULL AND staging_id IN (${chunk.map(() => "?").join(", ")}) RETURNING r2_key`)
        .bind(orgId, ...chunk)
        .all<{ r2_key: string }>()
    ).results;
    if (gone.length) await svc.env.COMMONFORGE_ASSETS.delete(gone.map((r) => r.r2_key));
    n += gone.length;
  }
  return n;
}

/**
 * Drop a file collection's change's staged uploads (copied to their content keys, or not needed):
 * every one no other open change names. Returns the rows deleted.
 */
export async function dropChangeUploads(svc: Services, orgId: string, changeId: string): Promise<number> {
  const ids = (
    await svc.db
      .prepare(
        `SELECT fo.staging_id FROM file_change_objects fo WHERE fo.change_id = ? AND NOT EXISTS (SELECT 1 FROM file_change_objects o2 JOIN file_changes f2 ON f2.change_id = o2.change_id WHERE o2.staging_id = fo.staging_id AND f2.change_id != fo.change_id AND f2.state IN ${OPEN_FILE_CHANGE_STATES_SQL})`,
      )
      .bind(changeId)
      .all<{ staging_id: string }>()
  ).results.map((r) => r.staging_id);
  return dropObjects(svc, orgId, ids);
}

/** Accept these (verified) objects: an accepted file change named them. Returns rows changed. */
export async function promoteObjects(svc: Services, orgId: string, stagingIds: readonly string[]): Promise<number> {
  const now = svc.nowIso();
  const ids = [...new Set(stagingIds)];
  // up to 1,000 objects per change: 90 per statement (D1 binds at most 100 parameters), one batch
  const stmts = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    stmts.push(
      svc.db
        .prepare(`UPDATE lfs_objects SET accepted_at = ? WHERE org_id = ? AND state = 'verified' AND accepted_at IS NULL AND staging_id IN (${chunk.map(() => "?").join(", ")})`)
        .bind(now, orgId, ...chunk),
    );
  }
  if (stmts.length === 0) return 0;
  const results = await svc.db.batch(stmts);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

/** Accept an agent task's objects in these resources (its proposal was accepted). */
export async function promoteTask(svc: Services, orgId: string, taskId: string, resourceIds: readonly string[]): Promise<number> {
  const now = svc.nowIso();
  let n = 0;
  for (const rid of resourceIds) {
    await svc.db.prepare("INSERT OR IGNORE INTO lfs_task_promotions (org_id, task_id, resource_id, accepted_at) VALUES (?, ?, ?, ?)").bind(orgId, taskId, rid, now).run();
    const r = await svc.db
      .prepare("UPDATE lfs_objects SET accepted_at = ? WHERE org_id = ? AND task_id = ? AND resource_id = ? AND state = 'verified' AND accepted_at IS NULL AND created_at <= (SELECT accepted_at FROM lfs_task_promotions WHERE task_id = ? AND resource_id = ? AND org_id = ?)")
      .bind(now, orgId, taskId, rid, taskId, rid, orgId)
      .run();
    n += r.meta.changes ?? 0;
  }
  return n;
}

/** A change uses these objects now (expiry counts from the last use). */
export async function touchObjects(svc: Services, orgId: string, stagingIds: readonly string[]): Promise<void> {
  const now = svc.nowIso();
  // up to 1,000 objects per change: 90 per statement (D1 binds at most 100 parameters)
  for (let i = 0; i < stagingIds.length; i += 90) {
    const chunk = stagingIds.slice(i, i + 90);
    await svc.db
      .prepare(`UPDATE lfs_objects SET last_used_at = ? WHERE org_id = ? AND staging_id IN (${chunk.map(() => "?").join(", ")})`)
      .bind(now, orgId, ...chunk)
      .run();
  }
}
