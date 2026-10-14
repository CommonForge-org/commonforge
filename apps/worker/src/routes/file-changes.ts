/**
 * File changes (spec 2026-10-07 §9): owners, and developers with write on a folder, put
 * uploaded files, edit small text files, delete and move paths in one change. A git folder's change
 * is applied by the runner (`apply-files`, services/file-changes.ts); a file collection's (no edits)
 * by the Worker, which writes its new manifest (services/asset-changes.ts). Either becomes an
 * ordinary proposal.
 */
import { sha256Hex } from "@commonforge-org/core";
import { APPLY_FILES_LIMITS } from "@commonforge-org/runner-protocol";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { newId } from "../lib/crypto.js";
import { ApiError, badRequest, forbidden, notFound, readJson } from "../lib/http.js";
import { canReadResource, canWriteResource, isDeveloper, orgActor, readableMount, readableProject } from "../middleware/authz.js";
import { recordEvent, userRef } from "../services/events.js";
import { editsKey, getFileChange, loadObjects, OPEN_FILE_CHANGE_STATES, OPEN_FILE_CHANGE_STATES_SQL, presentFileChange, settleFileChange, stagingIdsOf, type ChangeOp, type FileChangeRow } from "../services/file-changes.js";
import { touchObjects } from "../services/lfs-store.js";
import { enqueueStep } from "../services/steps.js";
import { uploadPath } from "./uploads.js";

export const fileChangeRoutes = new Hono<AppEnv>();

const OpInput = z.union([
  z.object({ put: z.string(), stagingId: z.string().min(1).max(128) }).strict(),
  z.object({ edit: z.string(), content: z.string(), baseBlob: z.string() }).strict(),
  z.object({ delete: z.string() }).strict(),
  z.object({ move: z.string(), to: z.string() }).strict(),
]);
const ChangeBody = z.object({
  ops: z.array(OpInput).min(1),
  title: z.string().trim().min(1).max(200).optional(),
  /** a repeat with the same key by the same user answers the change it made (see the route) */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "1 to 128 letters, digits, _ or -").optional(),
});
/** Read first, so the operation limit answers 413 before the full parse could answer 400. */
const LooseBody = z.object({ ops: z.array(z.unknown()) }).passthrough();

/** ops_json lives in one D1 row (at most 2 MB); edit contents are kept in R2 (editsKey). */
const MAX_OPS_JSON_BYTES = 1_900_000;

const enc = new TextEncoder();
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/** "Uploaded 30 files to videos/2026", "Edited config.json", "Changed 3 files". */
function defaultTitle(ops: readonly ChangeOp[], mountName: string): string {
  const puts = ops.flatMap((op) => ("put" in op ? [op.put] : []));
  if (puts.length === ops.length) {
    let dir = parentOf(puts[0]!);
    for (const p of puts) while (dir !== "" && !p.startsWith(`${dir}/`)) dir = parentOf(dir);
    return `Uploaded ${puts.length} ${puts.length === 1 ? "file" : "files"} to ${dir || mountName}`.slice(0, 200);
  }
  if (ops.length === 1 && "edit" in ops[0]!) return `Edited ${ops[0].edit}`.slice(0, 200);
  return `Changed ${ops.length} ${ops.length === 1 ? "file" : "files"}`;
}

fileChangeRoutes.post("/orgs/:org/projects/:pid/folders/:mount/changes", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const { mount, resource } = await readableMount(svc, actor, c.req.param("pid"), c.req.param("mount"));
  if (!(await canWriteResource(svc, actor, resource.resource_id))) throw forbidden("no_write_grant", "no write grant on this folder");

  const loose = await readJson(c, LooseBody);
  if (loose.ops.length > APPLY_FILES_LIMITS.maxOps) throw new ApiError(413, "too_many_operations", `a change has at most ${APPLY_FILES_LIMITS.maxOps} operations`);
  const parsed = ChangeBody.safeParse(loose);
  if (!parsed.success) throw badRequest("invalid_request", parsed.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  const body = parsed.data;
  // a file collection holds whole files: replace them by uploading (plan phase 3, P3-5)
  if (resource.provider === "r2-assets" && body.ops.some((op) => "edit" in op)) throw badRequest("edit_unsupported", "files in a file collection are not edited in place; upload the new version");

  // every path is normalized, relative, at most 1,024 characters and never protected (uploadPath);
  // edit contents go to the change's R2 edits object, named in ops_json by their sha256
  const contents: Record<string, string> = {};
  let editBytes = 0;
  const ops: ChangeOp[] = [];
  for (const op of body.ops) {
    if ("put" in op) ops.push({ put: uploadPath(op.put), stagingId: op.stagingId });
    else if ("edit" in op) {
      if (op.baseBlob !== "" && !/^[0-9a-f]{40}$/.test(op.baseBlob)) throw badRequest("invalid_request", "baseBlob is '' (a new file) or the 40-hex blob id from GET …/file");
      const bytes = enc.encode(op.content);
      if (bytes.length > APPLY_FILES_LIMITS.maxEditBytes || op.content.includes("\0")) {
        throw new ApiError(413, "edit_too_large", `edits are text (no NUL) of at most ${APPLY_FILES_LIMITS.maxEditBytes} bytes; upload larger or binary files`);
      }
      editBytes += bytes.length;
      if (editBytes > APPLY_FILES_LIMITS.maxEditTotalBytes) throw new ApiError(413, "edits_too_large", `the edits of one change are at most ${APPLY_FILES_LIMITS.maxEditTotalBytes} bytes together; split the change`);
      const contentSha256 = await sha256Hex(bytes);
      contents[contentSha256] = op.content;
      ops.push({ edit: uploadPath(op.edit), contentSha256, baseBlob: op.baseBlob });
    } else if ("delete" in op) ops.push({ delete: uploadPath(op.delete) });
    else ops.push({ move: uploadPath(op.move), to: uploadPath(op.to) });
  }

  // a repeat of a request whose reply was lost (or that is still running): the same user's key
  // answers its change, before the uploads are checked (they may be added by now). Only the
  // folder and the operations must match; the title is not compared.
  const opsJson = JSON.stringify(ops);
  const key = body.idempotencyKey;
  const repeat = async () => {
    if (key === undefined) return null;
    const known = await svc.db.prepare("SELECT * FROM file_changes WHERE org_id = ? AND user_id = ? AND idempotency_key = ?").bind(actor.orgId, actor.userId, key).first<FileChangeRow>();
    if (!known) return null;
    if (known.project_id !== mount.project_id || known.mount_name !== mount.mount_name || known.ops_json !== opsJson) {
      throw new ApiError(409, "idempotency_key_reused", "this idempotency key was used for another change; use a new key for a new change");
    }
    return c.json(presentFileChange(known), 202);
  };
  const known = await repeat();
  if (known) return known;

  // the uploads: this folder's, the caller's own (not an agent's), finished, not rejected, not added already
  const ids = stagingIdsOf(ops);
  const objects = await loadObjects(svc, actor.orgId, ids);
  for (const id of ids) {
    const o = objects.get(id);
    if (!o || o.resource_id !== resource.resource_id || o.user_id !== actor.userId || o.task_id !== null) throw badRequest("invalid_upload", `upload ${id} is not one of your uploads to this folder`);
    if (o.state === "rejected") throw badRequest("invalid_upload", `upload ${id} was refused: ${o.error ?? "its content did not verify"}`);
    if (o.state === "uploading") throw badRequest("invalid_upload", `upload ${id} is not complete`);
    // re-uploading is how the same bytes are put again
    if (o.accepted_at !== null) throw badRequest("invalid_upload", `upload ${id} was added already; upload the file again`);
  }
  // per put operation, as parseApplyFilesOps counts them (one upload may be put at several paths)
  const total = ops.reduce((n, op) => n + ("put" in op ? objects.get(op.stagingId)!.size : 0), 0);
  if (total > APPLY_FILES_LIMITS.maxChangeBytes) throw new ApiError(413, "change_too_large", `a change puts at most ${APPLY_FILES_LIMITS.maxChangeBytes} bytes`);
  // (only paths remain in ops_json: 1,000 moves of two 1,024-character paths could still pass a D1 row)
  if (enc.encode(opsJson).length > MAX_OPS_JSON_BYTES) throw new ApiError(413, "change_too_large", "the operations of one change are too large together; split the change");

  const changeId = newId("fc", 12);
  const hasEdits = ops.some((op) => "edit" in op);
  if (hasEdits) {
    const data = enc.encode(JSON.stringify(contents));
    await svc.env.COMMONFORGE_ASSETS.put(editsKey(actor.orgId, changeId), data, { sha256: await sha256Hex(data), httpMetadata: { contentType: "application/json" } });
  }
  const title = body.title ?? defaultTitle(ops, mount.mount_name);
  const now = svc.nowIso();
  const objectRows = [];
  // at most 100 bound parameters per statement: 45 rows of two
  for (let i = 0; i < ids.length; i += 45) {
    const chunk = ids.slice(i, i + 45);
    objectRows.push(
      svc.db.prepare(`INSERT OR IGNORE INTO file_change_objects (change_id, staging_id) VALUES ${chunk.map(() => "(?, ?)").join(", ")}`).bind(...chunk.flatMap((id) => [changeId, id])),
    );
  }
  try {
    await svc.db.batch([
      svc.db
        .prepare(
          "INSERT INTO file_changes (change_id, org_id, project_id, resource_id, mount_name, user_id, title, ops_json, has_edits, state, attempt, created_at, updated_at, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'applying', 1, ?, ?, ?)",
        )
        .bind(changeId, actor.orgId, mount.project_id, resource.resource_id, mount.mount_name, actor.userId, title, opsJson, hasEdits ? 1 : 0, now, now, key ?? null),
      ...objectRows,
    ]);
  } catch (e) {
    // the same key's request made its change meanwhile (the batch is one transaction: nothing of this one stays)
    const won = key !== undefined && /UNIQUE constraint failed/.test(e instanceof Error ? e.message : String(e)) ? await repeat() : null;
    if (!won) throw e;
    if (hasEdits) await svc.env.COMMONFORGE_ASSETS.delete(editsKey(actor.orgId, changeId));
    return won;
  }
  await touchObjects(svc, actor.orgId, ids);
  await enqueueStep(svc, { type: "files.apply", orgId: actor.orgId, changeId });
  await recordEvent(svc, {
    orgId: actor.orgId,
    projectId: mount.project_id,
    actor: userRef(actor.userId),
    action: "files.change_created",
    subjectKind: "file_change",
    subjectId: changeId,
    resourceIds: [resource.resource_id],
    detail: { changeId, mountName: mount.mount_name, title, operations: ops.length, uploads: ids.length, hasEdits },
  });
  return c.json(presentFileChange((await getFileChange(svc, changeId))!), 202);
});

/** The uploader, and owners and developers who can read the folder; anyone else gets 404. */
fileChangeRoutes.get("/orgs/:org/file-changes/:changeId", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const fc = await getFileChange(svc, c.req.param("changeId"));
  if (!fc || fc.org_id !== actor.orgId) throw notFound("change not found");
  const visible = fc.user_id === actor.userId || (isDeveloper(actor.role) && (await canReadResource(svc, actor, fc.resource_id)));
  if (!visible) throw notFound("change not found");
  return c.json(presentFileChange(await settleFileChange(svc, fc)));
});

/** Terminal changes stay in the list this long after they ended. */
const RECENT_MS = 24 * 3_600_000;
/** Open changes listed at most (all of them are listed, whatever the limit). */
const MAX_OPEN = 100;
/** Open rows passed through settleFileChange per list request (the rest are presented as stored). */
const MAX_SETTLES = 10;

/**
 * The Files tab's list: every open change on folders the caller can read (up to 100, whatever the
 * limit), plus terminal changes of the last 24 hours (anyone's for owners, the caller's own for
 * developers) up to the limit, newest first.
 * Owners and developers who can read the project; clients and viewers get 403.
 */
fileChangeRoutes.get("/orgs/:org/projects/:pid/file-changes", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const pid = c.req.param("pid");
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? 20 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw badRequest("invalid_request", "limit is an integer from 1 to 50");
  const mountName = c.req.query("mount");

  // the folders whose changes the caller may see: the named mount's, or every readable one ever changed here
  let resourceIds: string[];
  if (mountName !== undefined) resourceIds = [(await readableMount(svc, actor, pid, mountName)).resource.resource_id];
  else {
    await readableProject(svc, actor, pid);
    const changed = (await svc.db.prepare("SELECT DISTINCT resource_id FROM file_changes WHERE org_id = ? AND project_id = ?").bind(actor.orgId, pid).all<{ resource_id: string }>()).results;
    resourceIds = [];
    for (const r of changed) if (await canReadResource(svc, actor, r.resource_id)) resourceIds.push(r.resource_id);
  }
  if (resourceIds.length === 0) return c.json({ changes: [] });

  const since = new Date(svc.now().getTime() - RECENT_MS).toISOString();
  const own = actor.role === "owner" ? "" : " AND user_id = ?";
  const binds: unknown[] = [actor.orgId, pid];
  // one JSON parameter however many folders (D1 allows 100 bound parameters)
  const where = ["resource_id IN (SELECT value FROM json_each(?))"];
  binds.push(JSON.stringify(resourceIds));
  if (mountName !== undefined) {
    where.push("mount_name = ?");
    binds.push(mountName.normalize("NFC"));
  }
  const select = (cond: string, extra: unknown[], n: number) =>
    svc.db
      .prepare(`SELECT * FROM file_changes WHERE org_id = ? AND project_id = ? AND ${where.join(" AND ")} AND ${cond} ORDER BY created_at DESC, change_id DESC LIMIT ?`)
      .bind(...binds, ...extra, n)
      .all<FileChangeRow>();
  // open changes are always listed (however old, up to MAX_OPEN); terminal ones fill the rest of the limit
  const open = (await select(`state IN ${OPEN_FILE_CHANGE_STATES_SQL}`, [], MAX_OPEN)).results;
  const rest = limit > open.length ? (await select(`state NOT IN ${OPEN_FILE_CHANGE_STATES_SQL} AND updated_at >= ?${own}`, [since, ...(own ? [actor.userId] : [])], limit - open.length)).results : [];
  const rows = [...open, ...rest].sort((a, b) => (a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1) : a.change_id < b.change_id ? 1 : a.change_id > b.change_id ? -1 : 0));
  let settles = 0;
  const changes = [];
  for (const row of rows) {
    const open = OPEN_FILE_CHANGE_STATES.includes(row.state);
    changes.push(presentFileChange(open && settles++ < MAX_SETTLES ? await settleFileChange(svc, row) : row));
  }
  return c.json({ changes });
});
