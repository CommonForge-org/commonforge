/**
 * The gated release service (Task 22). See services/releases.ts and API.md "Releases".
 *
 * prepare (owner/developer) → publish approval (policy `publishRoles`, default owner) → deploy
 * (owner/developer with write grants; needs a matching publish approval) → `/version` health
 * check → live pointer. Accepting a proposal never deploys.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { badRequest, conflict, forbidden, notFound, readJson } from "../lib/http.js";
import { canReadResource, canWriteResource, isDeveloper, orgActor, readableProject, type OrgActor } from "../middleware/authz.js";
import { MAX_ORG_D1, MAX_ORG_KV, orgWorkerPrefix } from "../services/deploy-targets.js";
import { recordEvent, userRef } from "../services/events.js";
import { listProductionMigrations, resolveProductionMigration } from "../services/production-data.js";
import { approvePublish, deployRelease, markRecovered, getLive, getRelease, prepareRelease, presentRelease, type ReleaseRow } from "../services/releases.js";

export const releasesRoutes = new Hono<AppEnv>();

const IdempotencyKeySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);

/** Clients and viewers see a release only with read on every resource it is built from. */
async function visibleRelease(c: Context<AppEnv>, actor: OrgActor, releaseId: string): Promise<ReleaseRow> {
  const svc = c.get("svc");
  const rel = await getRelease(svc, actor.orgId, releaseId);
  if (!rel) throw notFound("release not found");
  await readableProject(svc, actor, rel.project_id);
  for (const r of Object.keys(JSON.parse(rel.sources_json) as object)) if (!(await canReadResource(svc, actor, r))) throw notFound("release not found");
  return rel;
}

/** prepareRelease: binds {acceptedVersionId, recipe revision, envDigest} and starts the build. */
releasesRoutes.post("/orgs/:org/projects/:pid/releases", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const body = await readJson(c, z.object({ acceptedVersionId: z.string().min(1).max(128).optional() }));
  const project = await readableProject(svc, actor, c.req.param("pid"));
  const { release, created } = await prepareRelease(svc, actor, project.project_id, body);
  return c.json({ ...(await presentRelease(svc, release, true)), created }, created ? 202 : 200);
});

releasesRoutes.get("/orgs/:org/projects/:pid/releases", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  const rows = await svc.db.prepare("SELECT * FROM releases WHERE org_id = ? AND project_id = ? AND channel = 'production' ORDER BY created_at DESC, rowid DESC LIMIT 50").bind(actor.orgId, project.project_id).all<ReleaseRow>();
  const releases = [];
  for (const r of rows.results) {
    try {
      releases.push(await presentRelease(svc, await visibleRelease(c, actor, r.release_id), isDeveloper(actor.role)));
    } catch {
      /* not visible to this caller */
    }
  }
  const live = await getLive(svc, actor.orgId, project.project_id);
  return c.json({ releases, live: live && releases.some((r) => r.releaseId === live.release_id) ? { releaseId: live.release_id, acceptedVersionId: live.accepted_version_id, outputDigest: live.output_digest, since: live.since } : null });
});

releasesRoutes.get("/orgs/:org/projects/:pid/releases/live", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const project = await readableProject(svc, actor, c.req.param("pid"));
  const live = await getLive(svc, actor.orgId, project.project_id);
  if (!live) return c.json({ live: null });
  const rel = await visibleRelease(c, actor, live.release_id);
  return c.json({ live: await presentRelease(svc, rel, isDeveloper(actor.role)) });
});

releasesRoutes.get("/orgs/:org/releases/:rid", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const rel = await visibleRelease(c, actor, c.req.param("rid"));
  return c.json(await presentRelease(c.get("svc"), rel, isDeveloper(actor.role)));
});

/** approvePublish: a separate record (≠ proposal approval ≠ acceptance), role-checked, bound to the output digest. */
releasesRoutes.post("/orgs/:org/releases/:rid/publish-approvals", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer", "client"]);
  const body = await readJson(c, z.object({ outputDigest: z.string().regex(/^[0-9a-f]{64}$/) }));
  const svc = c.get("svc");
  const rel = await visibleRelease(c, actor, c.req.param("rid"));
  return c.json(await approvePublish(svc, actor, rel, body), 201);
});

releasesRoutes.get("/orgs/:org/releases/:rid/publish-approvals", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const rel = await visibleRelease(c, actor, c.req.param("rid"));
  const rows = await svc.db.prepare("SELECT approval_id, output_digest, env_digest, approver, role, approved_at FROM release_publish_approvals WHERE release_id = ? ORDER BY approved_at").bind(rel.release_id).all<Record<string, string>>();
  return c.json({
    approvals: rows.results.map((a) => ({ approvalId: a.approval_id, outputDigest: a.output_digest, envDigest: a.env_digest, role: a.role, approvedAt: a.approved_at, ...(isDeveloper(actor.role) ? { approver: a.approver } : {}) })),
  });
});

/**
 * Owner action (review R-1): mark a release that needs recovery as recovered after checking
 * production by hand. It stops blocking the project and can be deployed again (retry).
 */
releasesRoutes.post("/orgs/:org/releases/:rid/recover", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const body = await readJson(c, z.object({ note: z.string().trim().min(3).max(500) }));
  const svc = c.get("svc");
  const rel = await visibleRelease(c, actor, c.req.param("rid"));
  await markRecovered(svc, actor, rel, body.note);
  return c.json(await presentRelease(svc, (await getRelease(svc, actor.orgId, rel.release_id))!, true));
});

/** deploy (and retry after a failure): needs a matching publish approval; idempotent per key. */
releasesRoutes.post("/orgs/:org/releases/:rid/deploy", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, z.object({ idempotencyKey: IdempotencyKeySchema }));
  const svc = c.get("svc");
  const rel = await visibleRelease(c, actor, c.req.param("rid"));
  for (const r of Object.keys(JSON.parse(rel.sources_json) as object)) if (!(await canWriteResource(svc, actor, r))) throw forbidden("no_write_grant", `no write grant on ${r}`);
  const r = await deployRelease(svc, actor, rel, body.idempotencyKey);
  return c.json({ ...r, release: await presentRelease(svc, (await getRelease(svc, actor.orgId, rel.release_id))!, true) }, r.replayed ? 200 : 202);
});

/**
 * Production resources the platform creates for an org's releases (review C-1b): KV namespaces
 * and (staging phase 2) D1 databases. A release policy may bind only these; each is created on the
 * deploy account with the deploy token and named `<deployPrefix>-<orgId>-<name>`. Owner only.
 */
releasesRoutes.post("/orgs/:org/deploy-resources", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const body = await readJson(c, z.object({ kind: z.enum(["kv", "d1"]), name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/) }));
  const svc = c.get("svc");
  const existing = await svc.db.prepare("SELECT resource_id FROM org_deploy_resources WHERE org_id = ? AND kind = ? AND name = ?").bind(actor.orgId, body.kind, body.name).first<{ resource_id: string }>();
  if (existing) {
    if (existing.resource_id.startsWith("pending:")) throw conflict("deploy_resource_pending", "this resource is being created; retry shortly");
    return c.json({ kind: body.kind, name: body.name, id: existing.resource_id, created: false });
  }
  // review m-b: a per-org cap, and a placeholder row claims the name BEFORE the API call, so two
  // concurrent creates cannot both create a namespace (the loser hits the primary key)
  const count = await svc.db.prepare("SELECT COUNT(*) AS n FROM org_deploy_resources WHERE org_id = ? AND kind = ?").bind(actor.orgId, body.kind).first<{ n: number }>();
  const cap = body.kind === "d1" ? { n: MAX_ORG_D1, what: "D1 databases" } : { n: MAX_ORG_KV, what: "KV namespaces" };
  if ((count?.n ?? 0) >= cap.n) throw conflict("quota_exceeded", `an organization can have at most ${cap.n} ${cap.what}`);
  const placeholder = `pending:${crypto.randomUUID()}`;
  const claimed = await svc.db
    .prepare("INSERT INTO org_deploy_resources (org_id, kind, name, resource_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(actor.orgId, body.kind, body.name, placeholder, actor.userId, svc.nowIso())
    .run();
  if ((claimed.meta.changes ?? 0) === 0) throw conflict("deploy_resource_pending", "this resource is being created; retry shortly");
  const accountId = svc.env.COMMONFORGE_DEPLOY_ACCOUNT_ID || svc.env.CF_ACCOUNT_ID;
  const title = `${orgWorkerPrefix(svc.env, actor.orgId)}${body.name}`;
  let ns: { id: string };
  try {
    const deployApi = svc.deps.deployApi(svc.env);
    ns = body.kind === "d1" ? await deployApi.createD1Database(accountId, title) : await deployApi.createKvNamespace(accountId, title);
  } catch (e) {
    await svc.db.prepare("DELETE FROM org_deploy_resources WHERE resource_id = ?").bind(placeholder).run();
    throw e;
  }
  await svc.db.prepare("UPDATE org_deploy_resources SET resource_id = ? WHERE resource_id = ?").bind(ns.id, placeholder).run();
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "deploy_resource.created", subjectKind: "project", subjectId: actor.orgId, detail: { kind: body.kind, name: body.name, title } });
  return c.json({ kind: body.kind, name: body.name, id: ns.id, title, created: true }, 201);
});

releasesRoutes.get("/orgs/:org/deploy-resources", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const rows = await svc.db.prepare("SELECT kind, name, resource_id, created_at FROM org_deploy_resources WHERE org_id = ? ORDER BY kind, name").bind(actor.orgId).all<{ kind: string; name: string; resource_id: string; created_at: string }>();
  return c.json({ workerPrefix: orgWorkerPrefix(svc.env, actor.orgId), resources: rows.results.map((r) => ({ kind: r.kind, name: r.name, id: r.resource_id, createdAt: r.created_at })) });
});

/**
 * Owner action (staging phase 2, review I2): a production migration that was sent without a
 * definite answer blocks every deploy needing its database. After checking the database by hand,
 * the owner records whether it ran (`applied: true`, never run again) or not (`false`, the next
 * deploy runs it).
 */
releasesRoutes.post("/orgs/:org/production-migrations/resolve", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const body = await readJson(c, z.object({ resourceId: z.string().min(1).max(64), key: z.string().min(1).max(512), applied: z.boolean() }));
  const svc = c.get("svc");
  const r = await resolveProductionMigration(svc, actor.orgId, body);
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "production_migration.resolved", subjectKind: "org", subjectId: actor.orgId, detail: { resourceId: body.resourceId, key: body.key, applied: body.applied } });
  return c.json({ resourceId: body.resourceId, key: body.key, ...r });
});

/** Production migration records of the org (`?state=applying`: those an owner must resolve). */
releasesRoutes.get("/orgs/:org/production-migrations", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const state = z.enum(["applying", "applied"]).optional().safeParse(c.req.query("state") || undefined);
  if (!state.success) throw badRequest("invalid_request", "state must be applying or applied");
  return c.json({ migrations: await listProductionMigrations(c.get("svc"), actor.orgId, state.data) });
});
