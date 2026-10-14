// apps/worker/src/routes/lfs.ts
/**
 * The Git LFS server (spec 2026-10-07 §5): `/api/lfs/<org>/<resourceId>/info/lfs/…`, the standard
 * batch API with the basic transfer adapter. Credentials: HTTP Basic whose password is a session
 * (`cfs_`) or task lease (`cfl_`) token, or a Bearer token. Uploads go straight to R2 through a
 * presigned PUT for one key; downloads stream through the Worker. `locks/verify` answers an empty
 * list with the same credentials (spike Limits 1: git-lfs calls it before every push).
 */
import { APPLY_FILES_LIMITS } from "@commonforge-org/runner-protocol";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.js";
import { lfsEndpointUrl, presignTtlSeconds } from "../lib/lfs-config.js";
import { CREATE_ONLY_HEADERS, presignR2, r2PresignConfig } from "../lib/presign.js";
import { canReadResource, canWriteResource, isDeveloper, type OrgActor } from "../middleware/authz.js";
import { resolveLease, resolveSession } from "../services/auth.js";
import { toErrorResponse } from "../lib/http.js";
import { getResource, getRole } from "../services/directory.js";
import { enqueueHash, verifiedObjectBody } from "../services/lfs-hash.js";
import { acceptedObject, createLfsObject, findPendingLfsUpload, markUploaded, servableObject } from "../services/lfs-store.js";

export const lfsRoutes = new Hono<AppEnv>();

const LFS_TYPE = "application/vnd.git-lfs+json";
const OID_RE = /^[0-9a-f]{64}$/;

class LfsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const lfsJson = (c: Context<AppEnv>, body: unknown, status = 200) => c.body(JSON.stringify(body), status as never, { "content-type": LFS_TYPE, "cache-control": "no-store" });
/** git-lfs's default `lfs.transfer.batchSize`: bounds the D1 queries one request can cause (about 4 per object). */
const MAX_BATCH_OBJECTS = 100;

lfsRoutes.onError((e, c) => {
  if (e instanceof LfsError) {
    const headers: Record<string, string> = { "content-type": LFS_TYPE, "cache-control": "no-store" };
    // git-lfs reads `LFS-Authenticate` (falling back to `WWW-Authenticate`); sending only the former keeps browsers from prompting for and caching Basic credentials on the API origin
    if (e.status === 401) headers["lfs-authenticate"] = 'Basic realm="CommonForge"';
    return c.body(JSON.stringify({ message: e.message }), e.status as never, headers);
  }
  return toErrorResponse(c, e);
});

interface LfsCaller {
  actor: OrgActor;
  /** set for agents: the task whose workspaces bound what they may touch */
  taskId: string | null;
  canWrite: boolean;
  /** may download verified objects nobody accepted yet */
  staged: boolean;
}

function credential(c: Context<AppEnv>): string | null {
  const h = c.req.header("authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(h);
  if (bearer) return bearer[1]!;
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(h);
  if (!basic) return null;
  try {
    const decoded = atob(basic[1]!);
    const i = decoded.indexOf(":");
    return i >= 0 ? decoded.slice(i + 1) : null;
  } catch {
    return null;
  }
}

async function caller(c: Context<AppEnv>): Promise<LfsCaller & { resourceId: string }> {
  const svc = c.get("svc");
  const orgId = c.req.param("org")!;
  const resourceId = c.req.param("rid")!;
  const token = credential(c);
  const notFound = () => new LfsError(404, "repository not found");
  if (!token) throw new LfsError(401, "credentials required");
  let actor: OrgActor;
  let taskId: string | null = null;
  if (token.startsWith("cfs_")) {
    const user = await resolveSession(svc, token);
    if (!user) throw new LfsError(401, "credentials required");
    const role = await getRole(svc.db, orgId, user.user_id);
    if (!role) throw notFound();
    actor = { orgId, userId: user.user_id, role };
  } else if (token.startsWith("cfl_")) {
    const lease = await resolveLease(svc, token);
    if (!lease) throw new LfsError(401, "credentials required");
    if (lease.org_id !== orgId) throw notFound();
    const role = await getRole(svc.db, orgId, lease.lease_holder);
    if (!role || !isDeveloper(role)) throw new LfsError(403, "the lease holder is no longer a developer of this organization");
    actor = { orgId, userId: lease.lease_holder, role, agentTaskId: lease.task_id };
    taskId = lease.task_id;
  } else throw new LfsError(401, "credentials required");
  const resource = await getResource(svc.db, orgId, resourceId);
  if (!resource || resource.provider !== "artifacts" || !(await canReadResource(svc, actor, resourceId))) throw notFound();
  if (taskId) {
    const ws = await svc.db.prepare("SELECT access, state FROM task_workspaces WHERE task_id = ? AND resource_id = ?").bind(taskId, resourceId).first<{ access: string; state: string }>();
    // reads work in any state but abandoned; writes need a live (writable) workspace
    if (!ws || ws.state === "abandoned") throw notFound();
    return { actor, taskId, resourceId, canWrite: ws.access === "write" && ws.state === "writable" && (await canWriteResource(svc, actor, resourceId)), staged: true };
  }
  return { actor, taskId: null, resourceId, canWrite: isDeveloper(actor.role) && (await canWriteResource(svc, actor, resourceId)), staged: isDeveloper(actor.role) };
}

const base = (c: Context<AppEnv>) => lfsEndpointUrl(c.get("svc").env, c.req.param("org")!, c.req.param("rid")!);

lfsRoutes.post("/lfs/:org/:rid/info/lfs/objects/batch", async (c) => {
  const who = await caller(c);
  const svc = c.get("svc");
  let body: { operation?: unknown; objects?: unknown; hash_algo?: unknown };
  try {
    body = await c.req.json();
  } catch {
    throw new LfsError(400, "malformed JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new LfsError(422, "malformed batch request");
  if (body.hash_algo !== undefined && body.hash_algo !== "sha256") throw new LfsError(422, "only sha256 is supported");
  if ((body.operation !== "upload" && body.operation !== "download") || !Array.isArray(body.objects) || body.objects.length > 1000) throw new LfsError(422, "malformed batch request");
  if (body.objects.length > MAX_BATCH_OBJECTS) throw new LfsError(413, `at most ${MAX_BATCH_OBJECTS} objects per batch`);
  const auth = c.req.header("authorization")!;
  const objects: unknown[] = [];
  if (body.operation === "upload") {
    if (!who.canWrite) throw new LfsError(403, "no write access to this folder");
    const cfg = r2PresignConfig(svc.env);
    if (!cfg) throw new LfsError(503, "LFS uploads are not configured on this server");
    for (const raw of body.objects as Array<{ oid?: unknown; size?: unknown }>) {
      const oid = String(raw?.oid ?? "");
      const size = raw?.size;
      if (!OID_RE.test(oid) || typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > APPLY_FILES_LIMITS.maxFileBytes) {
        objects.push({ oid, size, error: { code: 422, message: `invalid oid or size (files are at most ${APPLY_FILES_LIMITS.maxFileBytes} bytes)` } });
        continue;
      }
      const accepted = await acceptedObject(svc, who.actor.orgId, who.resourceId, oid);
      if (accepted && accepted.size === size) {
        objects.push({ oid, size });
        continue;
      }
      const pending = await findPendingLfsUpload(svc, { orgId: who.actor.orgId, resourceId: who.resourceId, oid, userId: who.actor.userId, taskId: who.taskId });
      // upload URLs only create (`if-none-match: *` is signed): a pending upload whose key already
      // holds bytes (a push interrupted between PUT and verify) gets a fresh key instead
      const row =
        pending && pending.size === size && !(await svc.env.COMMONFORGE_ASSETS.head(pending.r2_key))
          ? pending
          : await createLfsObject(svc, { orgId: who.actor.orgId, resourceId: who.resourceId, size, source: "lfs", userId: who.actor.userId, taskId: who.taskId, claimedOid: oid, state: "uploading" });
      const ttl = presignTtlSeconds(size);
      objects.push({
        oid,
        size,
        authenticated: true,
        actions: {
          upload: { href: await presignR2(cfg, row.r2_key, "PUT", ttl, svc.now(), CREATE_ONLY_HEADERS), header: { "If-None-Match": "*" }, expires_in: ttl },
          verify: { href: `${base(c)}/verify`, header: { Authorization: auth }, expires_in: ttl },
        },
      });
    }
  } else {
    for (const raw of body.objects as Array<{ oid?: unknown; size?: unknown }>) {
      const oid = String(raw?.oid ?? "");
      const row = OID_RE.test(oid) ? await servableObject(svc, { orgId: who.actor.orgId, resourceId: who.resourceId, oid, staged: who.staged, ...(who.taskId ? { taskId: who.taskId } : {}) }) : null;
      if (!row) {
        objects.push({ oid, size: raw?.size, error: { code: 404, message: "object not found" } });
        continue;
      }
      objects.push({ oid, size: row.size, authenticated: true, actions: { download: { href: `${base(c)}/objects/${oid}`, header: { Authorization: auth }, expires_in: 3600 } } });
    }
  }
  return lfsJson(c, { transfer: "basic", hash_algo: "sha256", objects });
});

lfsRoutes.post("/lfs/:org/:rid/info/lfs/verify", async (c) => {
  const who = await caller(c);
  if (!who.canWrite) throw new LfsError(403, "no write access to this folder");
  const svc = c.get("svc");
  const body = (await c.req.json().catch(() => null)) as { oid?: unknown; size?: unknown } | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new LfsError(422, "invalid oid or size");
  const oid = String(body?.oid ?? "");
  if (!OID_RE.test(oid) || typeof body?.size !== "number") throw new LfsError(422, "invalid oid or size");
  const pending = await findPendingLfsUpload(svc, { orgId: who.actor.orgId, resourceId: who.resourceId, oid, userId: who.actor.userId, taskId: who.taskId });
  if (!pending) {
    // a retried verify of the caller's own upload that already went through answers 200 again
    const done = await svc.db
      .prepare("SELECT 1 AS x FROM lfs_objects WHERE org_id = ? AND resource_id = ? AND claimed_oid = ? AND source = 'lfs' AND user_id = ? AND task_id IS ? AND state IN ('uploaded', 'verified') LIMIT 1")
      .bind(who.actor.orgId, who.resourceId, oid, who.actor.userId, who.taskId)
      .first();
    if (done) return lfsJson(c, {});
    throw new LfsError(404, "no upload of this object is pending");
  }
  const head = await svc.env.COMMONFORGE_ASSETS.head(pending.r2_key);
  if (!head) throw new LfsError(422, "the object was not uploaded");
  if (head.size !== body.size || pending.size !== body.size) throw new LfsError(422, "size mismatch");
  if (await markUploaded(svc, pending.staging_id)) await enqueueHash(svc, who.actor.orgId, pending.staging_id);
  return lfsJson(c, {});
});

lfsRoutes.get("/lfs/:org/:rid/info/lfs/objects/:oid", async (c) => {
  const who = await caller(c);
  const svc = c.get("svc");
  const oid = c.req.param("oid");
  const row = OID_RE.test(oid) ? await servableObject(svc, { orgId: who.actor.orgId, resourceId: who.resourceId, oid, staged: who.staged, ...(who.taskId ? { taskId: who.taskId } : {}) }) : null;
  if (!row) throw new LfsError(404, "object not found");
  // only the bytes the hash step verified (a key written again since is rejected, never served)
  const obj = await verifiedObjectBody(svc, row);
  if (!obj) throw new LfsError(404, "object not found");
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(obj.size),
      "x-content-type-options": "nosniff",
      "content-disposition": "attachment",
      "cache-control": "private, no-store",
    },
  });
});

lfsRoutes.post("/lfs/:org/:rid/info/lfs/locks/verify", async (c) => {
  const who = await caller(c);
  if (!who.canWrite) throw new LfsError(403, "no write access to this folder");
  return lfsJson(c, { ours: [], theirs: [] });
});

lfsRoutes.all("/lfs/:org/:rid/info/lfs/locks/*", async (c) => {
  await caller(c);
  throw new LfsError(404, "file locking is not supported");
});
lfsRoutes.all("/lfs/:org/:rid/info/lfs/locks", async (c) => {
  await caller(c);
  throw new LfsError(404, "file locking is not supported");
});
