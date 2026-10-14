/**
 * Staging routes (spec 2026-10-07): the capture sink staging's webhook/email vars point at, and the
 * project's views of what staging did, and landing, rolling back and resetting staging
 * (services/staging.ts, whose step and runner-result handlers this import registers), and the
 * developers' travel-with links between landings (services/travel-with.ts).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { notFound, readJson } from "../lib/http.js";
import { canReadProject, canSeeTask, isDeveloper, orgActor, requireUser } from "../middleware/authz.js";
import { getProject, getRole } from "../services/directory.js";
import { addTravelWith, orgLanding, removeTravelWith } from "../services/travel-with.js";
import { capture, listCaptures } from "../services/sink.js";
import { assertStagingProject, resetStaging, rollbackTask, stagingView } from "../services/staging.js";
import { getTask } from "../services/tasks.js";

export const stagingRoutes = new Hono<AppEnv>();

// ------------------------------------------------------------------------------ capture sink (public)

/** Public by design: the token in the path is the credential; no session, no orgActor. */
async function sinkHandler(c: Context<AppEnv>) {
  const token = c.req.param("token")!;
  const path = c.req.path.slice(`/api/sink/${token}`.length);
  await capture(c.get("svc"), token, c.req.raw, path, c.req.header("cf-connecting-ip") ?? null);
  return c.json({ ok: true }, 202);
}
stagingRoutes.all("/sink/:token/*", sinkHandler);
stagingRoutes.all("/sink/:token", sinkHandler);

// ------------------------------------------------------------------------------ sent from staging

/** What staging sent to the sink (anyone who can read the project), newest first. */
stagingRoutes.get("/orgs/:org/projects/:pid/staging/sent", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  if (!(await canReadProject(svc, actor, c.req.param("pid")))) throw notFound("project not found");
  return c.json({ captures: await listCaptures(svc, actor.orgId, c.req.param("pid")) });
});

// ------------------------------------------------------------------------------ landing, rollback, reset

/** The project's staging: URL, the live build, and every landing (clients see their own landings' reasons only). */
stagingRoutes.get("/orgs/:org/projects/:pid/staging", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  if (!(await canReadProject(svc, actor, c.req.param("pid")))) throw notFound("project not found");
  return c.json(await stagingView(svc, actor.orgId, c.req.param("pid"), actor));
});

/** Rebuild staging on fresh D1/KV (migrations and demo data from scratch). */
stagingRoutes.post("/orgs/:org/projects/:pid/staging/reset", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer", "client"]);
  const svc = c.get("svc");
  if (!(await canReadProject(svc, actor, c.req.param("pid")))) throw notFound("project not found");
  assertStagingProject(await getProject(svc.db, actor.orgId, c.req.param("pid")));
  return c.json({ buildId: await resetStaging(svc, actor.orgId, c.req.param("pid"), actor.userId) }, 202);
});

/** Take a task out of staging (owners, developers who can see it, or the client who created it). */
stagingRoutes.post("/tasks/:id/rollback", async (c) => {
  const user = requireUser(c);
  const svc = c.get("svc");
  const task = await getTask(svc, c.req.param("id"));
  if (!task) throw notFound("task not found");
  const role = await getRole(svc.db, task.org_id, user.userId);
  if (!role || (!isDeveloper(role) && role !== "client")) throw notFound("task not found");
  // canSeeTask: a client only for a task they created, while the project is in staging mode
  if (!(await canSeeTask(svc, { orgId: task.org_id, userId: user.userId, role }, task))) throw notFound("task not found");
  assertStagingProject(await getProject(svc.db, task.org_id, task.project_id));
  return c.json({ buildId: await rollbackTask(svc, task.org_id, task.task_id, user.userId) }, 202);
});

// ------------------------------------------------------------------------------ travel-with (B9)

/** A landing of the org whose project the actor can read (404 otherwise). */
async function readableLanding(c: Context<AppEnv>, actor: Awaited<ReturnType<typeof orgActor>>, landingId: string) {
  const svc = c.get("svc");
  const l = await orgLanding(svc, actor.orgId, landingId);
  if (!(await canReadProject(svc, actor, l.project_id))) throw notFound("landing not found");
  return l;
}

/** Owners and developers: this landing goes to production only together with an earlier one (`{ landingId }`). */
stagingRoutes.post("/orgs/:org/staging/landings/:id/travel-with", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, z.object({ landingId: z.string().min(1).max(200) }));
  const l = await readableLanding(c, actor, c.req.param("id"));
  return c.json(await addTravelWith(c.get("svc"), l, body.landingId, actor.userId), 201);
});

/** Owners and developers: remove a travel-with link. */
stagingRoutes.delete("/orgs/:org/staging/landings/:id/travel-with/:withLandingId", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const l = await readableLanding(c, actor, c.req.param("id"));
  await removeTravelWith(c.get("svc"), l, c.req.param("withLandingId"), actor.userId);
  return c.body(null, 204);
});
