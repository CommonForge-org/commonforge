/** Resources: create (canonical repo / asset collection), list, inspect, adopt head, versions. */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { readJson } from "../lib/http.js";
import { isDeveloper, orgActor, presentResource, readableResource, resourceOps, writableResource } from "../middleware/authz.js";
import type { ResourceRow } from "../services/directory.js";
import { recordEvent, userRef } from "../services/events.js";
import { adoptBranchHead, createResource } from "../services/resources.js";

export const resourceRoutes = new Hono<AppEnv>();

const BranchSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/).refine((b) => !b.includes("..") && !b.endsWith("/") && !b.endsWith(".lock"), "invalid branch");

resourceRoutes.post("/orgs/:org/resources", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, z.object({ name: z.string().trim().min(1).max(128), provider: z.enum(["artifacts", "r2-assets"]), branch: BranchSchema.optional() }));
  const svc = c.get("svc");
  const r = await createResource(svc, actor, body, userRef(actor.userId));
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "resource.created", subjectKind: "resource", subjectId: r.resource_id, resourceIds: [r.resource_id], detail: { provider: r.provider, name: r.name } });
  return c.json(presentResource(r, actor.role), 201);
});

resourceRoutes.get("/orgs/:org/resources", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const rows =
    actor.role === "owner"
      ? await svc.db.prepare("SELECT * FROM resources WHERE org_id = ? ORDER BY name").bind(actor.orgId).all<ResourceRow>()
      : await svc.db
          .prepare(
            "SELECT r.* FROM resources r JOIN grants g ON g.org_id = r.org_id AND g.scope_kind = 'resource' AND g.scope_id = r.resource_id AND g.user_id = ? WHERE r.org_id = ? AND g.operations_json LIKE '%read%' ORDER BY r.name",
          )
          .bind(actor.userId, actor.orgId)
          .all<ResourceRow>();
  return c.json({ resources: rows.results.map((r) => presentResource(r, actor.role)) });
});

resourceRoutes.get("/orgs/:org/resources/:rid", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const r = await readableResource(svc, actor, c.req.param("rid"));
  const head = await svc.ledger(actor.orgId).getHead(r.resource_id);
  return c.json({ ...presentResource(r, actor.role), head, operations: await resourceOps(svc, actor, r.resource_id) });
});

/** Bind an empty canonical repo to the current head of its branch once content exists (genesis). */
resourceRoutes.post("/orgs/:org/resources/:rid/adopt-head", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const r = await writableResource(svc, actor, c.req.param("rid"));
  const revisionId = await adoptBranchHead(svc, r, userRef(actor.userId));
  await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "resource.head_bound", subjectKind: "resource", subjectId: r.resource_id, resourceIds: [r.resource_id], detail: { revisionId } });
  return c.json({ resourceId: r.resource_id, revisionId });
});

/** Accepted versions that touched this resource (newest first). */
resourceRoutes.get("/orgs/:org/resources/:rid/versions", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const r = await readableResource(svc, actor, c.req.param("rid"));
  const all = await svc.ledger(actor.orgId).listAcceptedVersions({ after: 0, limit: 500 });
  const versions = all
    .filter((v) => v.heads.some((h) => h.resourceId === r.resource_id))
    .reverse()
    .map((v) => ({
      acceptedVersionId: v.acceptedVersionId,
      sequence: v.sequence,
      kind: v.kind,
      proposalId: v.proposalId,
      proposalHash: v.proposalHash,
      acceptedAt: v.acceptedAt,
      head: v.heads.find((h) => h.resourceId === r.resource_id),
      ...(isDeveloper(actor.role) ? { actor: v.actor } : {}),
    }));
  return c.json({ resourceId: r.resource_id, versions });
});
