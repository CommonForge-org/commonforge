/**
 * Lease-authenticated reads of a task's R2 asset mounts (API.md "Tasks": `GET /api/tasks/:id/assets/file`).
 *
 * `cforge checkout` materializes asset mounts object by object. The project file browser
 * (`GET /api/orgs/:org/projects/:pid/file`) is a user route, so an agent holding only the task lease
 * needs this route. It is deliberately narrow:
 * - **agent only**: the caller must present the current lease token of exactly this task (users get
 *   `403 lease_required`, other tasks' leases 404, expired or released leases 401);
 * - the task must be `running`, and the lease holder must still be able to read the resource;
 * - only mounts named in the **task snapshot** whose pinned revision is an asset manifest (`r2m:`);
 * - the manifest is chosen server-side: the snapshot's pinned manifest (default), or with
 *   `source=workspace` the task's own asset workspace manifest (written mounts only). The caller
 *   never names a revision;
 * - only paths listed in that manifest; the object is streamed from R2 with its sha256.
 */
import { checkPath, parseRevisionId } from "@commonforge-org/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { badRequest, conflict, notFound, parseQuery } from "../lib/http.js";
import { canReadResource, taskActor } from "../middleware/authz.js";
import { getTask, listWorkspaces, taskSnapshot } from "../services/tasks.js";

export const taskAssetRoutes = new Hono<AppEnv>();

const FileQuery = z.object({
  mount: z.string().min(1).max(128),
  path: z.string().min(1).max(4096),
  source: z.enum(["snapshot", "workspace"]).default("snapshot"),
});

/** Asset workspaces whose manifest may be read: not failed, abandoned or collected. */
const READABLE_WORKSPACE_STATES = new Set(["writable", "freezing", "frozen"]);

taskAssetRoutes.get("/tasks/:id/assets/file", async (c) => {
  const svc = c.get("svc");
  const task = await getTask(svc, c.req.param("id"));
  if (!task) throw notFound("task not found");
  // agent principals only: a user (even the lease holder) gets 403 lease_required
  const actor = await taskActor(c, task, { allowUser: false });
  const q = parseQuery(c, FileQuery);
  if (task.state !== "running") throw conflict("task_not_running", `task is ${task.state}`);

  const entry = taskSnapshot(task).entries.find((e) => e.mountName === q.mount);
  if (!entry || !(await canReadResource(svc, actor, entry.resourceId))) throw notFound("mount not in this task");
  const rev = parseRevisionId(entry.revisionId);
  if (rev.kind !== "r2m") throw badRequest("not_assets", `mount ${q.mount} is not an asset mount`);
  const checked = checkPath(q.path);
  if (!checked.ok) throw badRequest("invalid_path", "invalid path");

  let manifestId: string = rev.manifestId;
  if (q.source === "workspace") {
    const ws = (await listWorkspaces(svc, task.task_id)).find((w) => w.mount_name === q.mount && w.provider === "r2-assets" && w.access === "write");
    if (!ws || ws.resource_id !== entry.resourceId || !READABLE_WORKSPACE_STATES.has(ws.state)) throw notFound("no asset workspace for this mount");
    manifestId = ws.asset_manifest_id ?? manifestId;
  }
  const manifest = await (await svc.assets(task.org_id)).readManifest(manifestId, entry.resourceId);
  if (!manifest) throw notFound("manifest not found");
  const item = manifest.entries.find((e) => e.path === checked.path);
  if (!item) throw notFound("file not found");
  const obj = await svc.env.COMMONFORGE_ASSETS.get(item.objectKey);
  if (!obj) throw notFound("object missing");
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": "attachment",
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-length": String(item.size),
      "x-commonforge-revision": `r2m:${manifest.manifestId}`,
      "x-commonforge-sha256": item.sha256,
    },
  });
});
