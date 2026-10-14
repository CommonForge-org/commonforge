/**
 * Restore (plan §B.9, FR-12): a forward head under CAS to a revision that was previously accepted
 * for that resource; history is never rewritten. Per resource (the ledger restores one head at a
 * time; a multi-resource "restore this version" is one request per resource).
 */
import { RevisionIdSchema } from "@commonforge-org/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { ApiError, readJson } from "../lib/http.js";
import { orgActor, writableResource } from "../middleware/authz.js";
import { recordEvent, userRef } from "../services/events.js";

export const restoreRoutes = new Hono<AppEnv>();

restoreRoutes.post("/orgs/:org/resources/:rid/restore", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, z.object({ expectedHead: RevisionIdSchema, targetRevision: RevisionIdSchema, idempotencyKey: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/) }));
  const svc = c.get("svc");
  const r = await writableResource(svc, actor, c.req.param("rid"));
  const d = await svc.ledger(actor.orgId).restore({
    organizationId: actor.orgId,
    resourceId: r.resource_id,
    expectedHead: body.expectedHead,
    targetRevision: body.targetRevision,
    idempotencyKey: `${actor.orgId}:${body.idempotencyKey}`,
    actor: userRef(actor.userId),
  });
  if (!d.ok) throw new ApiError(409, d.code, d.detail ?? d.code, d.resourceId ? { resourceId: d.resourceId } : undefined);
  if (!d.replayed) await recordEvent(svc, { orgId: actor.orgId, actor: userRef(actor.userId), action: "resource.restored", subjectKind: "resource", subjectId: r.resource_id, resourceIds: [r.resource_id], detail: { targetRevision: body.targetRevision, acceptedVersionId: d.acceptedVersionId }, clientVisible: true });
  return c.json({ resourceId: r.resource_id, acceptedVersionId: d.acceptedVersionId, replayed: d.replayed, headRevisionId: body.targetRevision });
});
