/**
 * Promotion routes (staging phase 2, spec 2026-10-07 §7): promote a task that is live on staging,
 * read a promotion, withdraw it before it is accepted (its requester, owners and developers), and
 * (owners and developers) approve it, send it back, or retry its production
 * release (services/promotions.ts, whose `promotion.advance` step handler this import registers).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Services } from "../context.js";
import { badRequest, forbidden, notFound, parseQuery, readJson } from "../lib/http.js";
import { canReadProject, canSeeTask, canWriteResource, isDeveloper, orgActor, readableProject, requireUser, type OrgActor } from "../middleware/authz.js";
import { getProject, getRole, listMounts, projectPolicy } from "../services/directory.js";
import { approvePromotion, getPromotion, listPromotions, previewPromotion, PROMOTION_STATES, promotionView, requestPromotion, retryPromotionRelease, sendBackPromotion, withdrawPromotion, type PromotionState } from "../services/promotions.js";
import { assertStagingProject } from "../services/staging.js";
import { getTask } from "../services/tasks.js";

export const promotionRoutes = new Hono<AppEnv>();

/** The task a caller may promote (the client who created it, or an owner/developer who can see it), in a staging-mode project; else 404. */
async function promotableTask(c: Context<AppEnv>) {
  const user = requireUser(c);
  const svc = c.get("svc");
  const task = await getTask(svc, c.req.param("id")!);
  if (!task) throw notFound("task not found");
  const role = await getRole(svc.db, task.org_id, user.userId);
  // provider errors (their text can name repositories) reach a client as a plain message
  c.set("plainProviderErrors", !role || !isDeveloper(role));
  if (!role || (!isDeveloper(role) && role !== "client")) throw notFound("task not found");
  // canSeeTask: a client only for a task they created, while the project is in staging mode
  if (!(await canSeeTask(svc, { orgId: task.org_id, userId: user.userId, role }, task))) throw notFound("task not found");
  assertStagingProject(await getProject(svc.db, task.org_id, task.project_id));
  return task;
}

/** Promote a landed task (the client who created it, or an owner/developer who can see it). Body `{}`. */
promotionRoutes.post("/tasks/:id/promote", async (c) => {
  const task = await promotableTask(c);
  return c.json(await requestPromotion(c.get("svc"), task, requireUser(c).userId), 202);
});

/** The dry run (P3-7): what `POST` would promote now (set, mode, landings it goes without), writing nothing. */
promotionRoutes.get("/tasks/:id/promote", async (c) => {
  const task = await promotableTask(c);
  return c.json(await previewPromotion(c.get("svc"), task));
});

/**
 * The project's promotions (P3-8), newest first, at most 100; `?state=a,b` filters by state.
 * Owners and developers: all, developer view (a developer without read on every resource a
 * promotion changes gets the client view of it). Clients: those they requested or with a landing
 * they created, client view. Viewers: 403. Rows carry no `resources`/`checks` (GET …/promotions/:id does).
 */
promotionRoutes.get("/orgs/:org/projects/:pid/promotions", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer", "client"]);
  c.set("plainProviderErrors", !isDeveloper(actor.role));
  const q = parseQuery(c, z.object({ state: z.string().max(400).optional() }));
  const states = q.state === undefined || q.state === "" ? undefined : q.state.split(",").map((x) => x.trim());
  const bad = states?.find((x) => !PROMOTION_STATES.includes(x as PromotionState));
  if (bad !== undefined) throw badRequest("invalid_request", `state: unknown promotion state '${bad.slice(0, 40)}'`);
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  return c.json({ promotions: await listPromotions(svc, actor.orgId, project.project_id, actor, states as PromotionState[] | undefined) });
});

/** The promotion as the caller may read it (404 unless they can read its project). */
async function readablePromotion(svc: Services, actor: OrgActor, promotionId: string) {
  const p = await getPromotion(svc, promotionId);
  if (!p || p.org_id !== actor.orgId || !(await canReadProject(svc, actor, p.project_id))) throw notFound("promotion not found");
  return p;
}

promotionRoutes.get("/orgs/:org/promotions/:id", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  c.set("plainProviderErrors", !isDeveloper(actor.role));
  const svc = c.get("svc");
  return c.json(await promotionView(svc, await readablePromotion(svc, actor, c.req.param("id")), actor));
});

/** A developer clears a promotion that waits for approval (`pending_approval` → `cleared`; the role must be in the project's `approvalRoles`). */
promotionRoutes.post("/orgs/:org/promotions/:id/approve", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const p = await readablePromotion(svc, actor, c.req.param("id"));
  return c.json(await promotionView(svc, await approvePromotion(svc, p, actor), actor));
});

/** Send a promotion back to staging with a note for the client (`pending_approval`/`cleared` → `sent_back`). */
promotionRoutes.post("/orgs/:org/promotions/:id/send-back", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, z.object({ note: z.string().trim().min(1).max(2000) }));
  const svc = c.get("svc");
  const p = await readablePromotion(svc, actor, c.req.param("id"));
  return c.json(await promotionView(svc, await sendBackPromotion(svc, p, actor, body.note), actor));
});

/**
 * Withdraw a promotion before it is accepted (`requested` … `cleared` → `withdrawn`): the client who
 * requested it, or an owner or developer who can read its project. Body `{}`.
 */
promotionRoutes.post("/orgs/:org/promotions/:id/withdraw", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  c.set("plainProviderErrors", !isDeveloper(actor.role));
  await readJson(c, z.object({}));
  const svc = c.get("svc");
  const p = await readablePromotion(svc, actor, c.req.param("id"));
  return c.json(await promotionView(svc, await withdrawPromotion(svc, p, actor), actor));
});

/**
 * Retry a promotion's production release (`release_failed` → `releasing`): a fresh prepare of the
 * latest accepted version and a new deploy, run by the promotion service. Owners and developers with
 * write on every resource the release deploys from and on the promotion's resources (like the
 * release deploy route).
 */
promotionRoutes.post("/orgs/:org/promotions/:id/retry-release", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const p = await readablePromotion(svc, actor, c.req.param("id"));
  // write on every resource the release deploys from (the mounts its recipe and targets name), like the deploy route
  const project = await getProject(svc.db, actor.orgId, p.project_id);
  const release = (project ? projectPolicy(project).release : undefined) as { recipe?: { steps?: Array<{ mountName?: string }> }; targets?: Array<{ mountName?: string }> } | undefined;
  const names = new Set([...(release?.recipe?.steps ?? []), ...(release?.targets ?? [])].map((x) => x.mountName));
  const proposal = p.proposal_id ? await svc.ledger(actor.orgId).getProposal(p.proposal_id) : null;
  const resources = new Set([...(await listMounts(svc.db, actor.orgId, p.project_id)).filter((m) => names.has(m.mount_name)).map((m) => m.resource_id), ...(proposal?.resourceChanges.map((x) => x.resourceId as string) ?? [])]);
  for (const r of resources) {
    if (!(await canWriteResource(svc, actor, r))) throw forbidden("no_write_grant", `no write grant on ${r}`);
  }
  return c.json(await promotionView(svc, await retryPromotionRelease(svc, p, actor.userId), actor));
});
