/**
 * Browser uploads (spec 2026-10-07 §9): R2 multipart through the Worker binding, straight to the
 * object's final key. Owners and developers with write on a folder (a git folder or a file
 * collection) start an upload; only the
 * uploader continues it. Completing it starts the hash step; the object is usable once verified.
 * An empty file has no parts and no multipart upload: completing it with `parts: []` writes the
 * empty object at its key.
 */
import { checkPath, hasAlwaysProtectedSegment } from "@commonforge-org/core";
import { APPLY_FILES_LIMITS } from "@commonforge-org/runner-protocol";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Services } from "../context.js";
import { newId } from "../lib/crypto.js";
import { ApiError, badRequest, conflict, forbidden, notFound, readJson } from "../lib/http.js";
import { lfsObjectKey, lfsSettings, UNFINISHED_UPLOAD_TTL_HOURS } from "../lib/lfs-config.js";
import { canWriteResource, orgActor, readableMount } from "../middleware/authz.js";
import { enqueueHash } from "../services/lfs-hash.js";
import { createLfsObject, getLfsObject, markUploaded, type LfsObjectRow } from "../services/lfs-store.js";

export const uploadRoutes = new Hono<AppEnv>();

const MAX_PATH_CHARS = 1024;
// the schema's bound is loose on purpose: `uploadPath` is the one place that answers invalid_path
const StartBody = z.object({ path: z.string().min(1).max(4096), size: z.number().int(), mime: z.string().min(1).max(255) });

/** A path a file may be uploaded to: normalized, relative, at most 1,024 characters, never under `.git` (or other protected segments). */
export function uploadPath(raw: string): string {
  if (raw.length > MAX_PATH_CHARS) throw badRequest("invalid_path", "invalid file path");
  const r = checkPath(raw);
  if (!r.ok || r.path !== raw || hasAlwaysProtectedSegment(raw)) throw badRequest("invalid_path", "invalid file path");
  return r.path;
}

const partCount = (size: number, partSize: number) => Math.ceil(size / partSize);
const partLength = (row: LfsObjectRow, n: number, partSize: number) => (n < partCount(row.size, partSize) ? partSize : row.size - (partCount(row.size, partSize) - 1) * partSize);

uploadRoutes.post("/orgs/:org/projects/:pid/folders/:mount/uploads", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, StartBody);
  const svc = c.get("svc");
  const { resource } = await readableMount(svc, actor, c.req.param("pid"), c.req.param("mount"));
  if (!(await canWriteResource(svc, actor, resource.resource_id))) throw forbidden("no_write_grant", "no write grant on this folder");
  const path = uploadPath(body.path);
  if (body.size < 0) throw badRequest("invalid_size", "an upload's size is at least 0 bytes");
  if (body.size > APPLY_FILES_LIMITS.maxFileBytes) throw new ApiError(413, "file_too_large", `files are limited to ${APPLY_FILES_LIMITS.maxFileBytes} bytes`);
  const { uploadPartBytes } = lfsSettings(svc.env);
  if (partCount(body.size, uploadPartBytes) > 10_000) throw new ApiError(413, "file_too_large", "too many parts");
  const stagingId = newId("lfs", 12);
  // an empty file has no parts: no multipart upload (complete writes the empty object)
  const mp = body.size === 0 ? null : await svc.env.COMMONFORGE_ASSETS.createMultipartUpload(lfsObjectKey(actor.orgId, resource.resource_id, stagingId), { httpMetadata: { contentType: body.mime } });
  let row: LfsObjectRow;
  try {
    row = await createLfsObject(svc, { stagingId, orgId: actor.orgId, resourceId: resource.resource_id, size: body.size, source: "browser", userId: actor.userId, uploadId: mp?.uploadId ?? null, path, mime: body.mime, state: "uploading" });
  } catch (e) {
    await mp?.abort().catch(() => undefined);
    throw e;
  }
  return c.json(
    { uploadId: row.staging_id, partSize: uploadPartBytes, parts: partCount(body.size, uploadPartBytes), expiresAt: new Date(svc.now().getTime() + UNFINISHED_UPLOAD_TTL_HOURS * 3600_000).toISOString() },
    201,
  );
});

/** The caller's own browser upload (anyone else: 404). */
async function ownUpload(c: Context<AppEnv>): Promise<LfsObjectRow> {
  const actor = await orgActor(c, c.req.param("org")!);
  const row = await getLfsObject(c.get("svc"), actor.orgId, c.req.param("uploadId")!);
  if (!row || row.source !== "browser" || row.user_id !== actor.userId) throw notFound("upload not found");
  return row;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** R2 says the multipart upload is gone: aborted, completed or never existed. */
const noSuchUpload = (e: unknown) => /NoSuchUpload|10024|does not exist/i.test(errText(e));
/** R2 refuses the completion because of what the client sent: unknown etags or undersized parts. */
const incompleteUpload = (e: unknown) => /10025|10011|InvalidPart|EntityTooSmall/i.test(errText(e));

/** R2 multipart errors: an unknown or finished upload is the caller's 404, everything else is ours. */
function r2Error(e: unknown): never {
  if (noSuchUpload(e)) throw notFound("upload not found");
  throw e;
}

uploadRoutes.put("/orgs/:org/uploads/:uploadId/parts/:n", async (c) => {
  const row = await ownUpload(c);
  const svc = c.get("svc");
  if (row.state !== "uploading") throw conflict("upload_finished", "this upload is finished");
  const { uploadPartBytes } = lfsSettings(svc.env);
  const n = Number(c.req.param("n"));
  // an empty file (no multipart upload) has no part to take
  if (!Number.isInteger(n) || n < 1 || n > partCount(row.size, uploadPartBytes)) throw badRequest("invalid_part", "invalid part number");
  if (!row.upload_id) throw conflict("upload_finished", "this upload is finished");
  const len = Number(c.req.header("content-length"));
  if (!Number.isFinite(len) || len < 0) throw new ApiError(411, "length_required", "content-length is required");
  if (len > uploadPartBytes) throw new ApiError(413, "part_too_large", `parts are at most ${uploadPartBytes} bytes`);
  if (len !== partLength(row, n, uploadPartBytes)) throw badRequest("part_size_mismatch", `part ${n} must be ${partLength(row, n, uploadPartBytes)} bytes`);
  // the body must be exactly content-length bytes: a short or long body errors the fixed-length stream
  const fixed = new FixedLengthStream(len);
  const piping = (c.req.raw.body ?? new ReadableStream<Uint8Array>({ start: (ctl) => ctl.close() })).pipeTo(fixed.writable);
  const [uploaded, piped] = await Promise.allSettled([svc.env.COMMONFORGE_ASSETS.resumeMultipartUpload(row.r2_key, row.upload_id).uploadPart(n, fixed.readable), piping]);
  if (uploaded.status === "rejected" && noSuchUpload(uploaded.reason)) throw notFound("upload not found");
  const shortOrLong = piped.status === "rejected" || (uploaded.status === "rejected" && /FixedLengthStream/i.test(errText(uploaded.reason)));
  if (shortOrLong) throw badRequest("part_size_mismatch", `part ${n} must be exactly ${len} bytes, as content-length says`);
  if (uploaded.status === "rejected") throw uploaded.reason;
  return c.json({ etag: uploaded.value.etag });
});

/** The object is whole at its key: (re)start the hash step and answer; a retry after a lost 200 lands here. */
async function finishedUpload(svc: Services, row: LfsObjectRow) {
  const head = await svc.env.COMMONFORGE_ASSETS.head(row.r2_key);
  if (!head || head.size !== row.size) throw notFound("upload not found");
  if (row.state === "uploading") await markUploaded(svc, row.staging_id);
  await enqueueHash(svc, row.org_id, row.staging_id);
  return { stagingId: row.staging_id, size: row.size };
}

uploadRoutes.post("/orgs/:org/uploads/:uploadId/complete", async (c) => {
  const row = await ownUpload(c);
  const svc = c.get("svc");
  const body = await readJson(c, z.object({ parts: z.array(z.object({ n: z.number().int().positive(), etag: z.string().min(1).max(256) })).max(10_000) }));
  if (row.state === "uploaded" || row.state === "verified") return c.json(await finishedUpload(svc, row));
  if (row.state !== "uploading") throw notFound("upload not found");
  const count = partCount(row.size, lfsSettings(svc.env).uploadPartBytes);
  if (body.parts.length !== count || body.parts.some((p, i) => p.n !== i + 1)) throw badRequest("parts_mismatch", count === 0 ? "an empty file has no parts" : `expected parts 1..${count} in order`);
  if (row.size === 0) {
    // the empty object, written at its key (again, on a retry); then as any finished upload
    await svc.env.COMMONFORGE_ASSETS.put(row.r2_key, new Uint8Array(0), { httpMetadata: { contentType: row.mime ?? "application/octet-stream" } });
    if (!(await markUploaded(svc, row.staging_id))) {
      // canceled or collected meanwhile: the row is gone (or finished by a concurrent complete)
      const now = await getLfsObject(svc, row.org_id, row.staging_id);
      if (!now || (now.state !== "uploaded" && now.state !== "verified")) {
        if (!now) await svc.env.COMMONFORGE_ASSETS.delete(row.r2_key);
        throw notFound("upload not found");
      }
    }
    await enqueueHash(svc, row.org_id, row.staging_id);
    return c.json({ stagingId: row.staging_id, size: 0 });
  }
  if (!row.upload_id) throw notFound("upload not found");
  let size: number;
  try {
    const obj = await svc.env.COMMONFORGE_ASSETS.resumeMultipartUpload(row.r2_key, row.upload_id).complete(body.parts.map((p) => ({ partNumber: p.n, etag: p.etag })));
    size = obj.size;
  } catch (e) {
    // completed earlier (the 200 was lost): the object is already at its key
    if (noSuchUpload(e)) return c.json(await finishedUpload(svc, row));
    // the row stays `uploading`: the client re-sends the missing parts and completes again
    if (incompleteUpload(e)) throw badRequest("upload_incomplete", "the parts do not match what was uploaded (unknown etag or a part below the minimum size)");
    throw e;
  }
  if (size !== row.size) {
    await svc.env.COMMONFORGE_ASSETS.delete(row.r2_key);
    await svc.db.prepare("DELETE FROM lfs_objects WHERE staging_id = ?").bind(row.staging_id).run();
    throw badRequest("size_mismatch", `the upload is ${size} bytes, not ${row.size}`);
  }
  await markUploaded(svc, row.staging_id);
  await enqueueHash(svc, row.org_id, row.staging_id);
  return c.json({ stagingId: row.staging_id, size });
});

uploadRoutes.get("/orgs/:org/uploads/:uploadId", async (c) => {
  const row = await ownUpload(c);
  return c.json({ stagingId: row.staging_id, state: row.state, size: row.size, sha256: row.sha256, path: row.path, ...(row.error ? { error: row.error } : {}) });
});

uploadRoutes.delete("/orgs/:org/uploads/:uploadId", async (c) => {
  const row = await ownUpload(c);
  const svc = c.get("svc");
  if (row.state === "uploading" && row.upload_id) {
    // an R2 failure (other than "already gone") answers 500 and keeps the row, so the client retries
    await svc.env.COMMONFORGE_ASSETS.resumeMultipartUpload(row.r2_key, row.upload_id).abort().catch((e) => {
      if (!noSuchUpload(e)) throw e;
    });
    await svc.db.prepare("DELETE FROM lfs_objects WHERE staging_id = ? AND state = 'uploading'").bind(row.staging_id).run();
  } else if (row.state === "uploading") {
    // an empty file: no multipart upload; a complete racing this may have written the empty object
    const del = await svc.db.prepare("DELETE FROM lfs_objects WHERE staging_id = ? AND state = 'uploading'").bind(row.staging_id).run();
    if ((del.meta.changes ?? 0) > 0) await svc.env.COMMONFORGE_ASSETS.delete(row.r2_key);
  }
  return c.body(null, 204);
});
