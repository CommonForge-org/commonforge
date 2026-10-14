/** Activity (D1 app events) and the ledger audit trail. */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { parseQuery } from "../lib/http.js";
import { canReadProject, canReadResource, isDeveloper, orgActor } from "../middleware/authz.js";
import { editionScopeForProposal, editionUse, type EditionScope } from "../services/editions.js";

export const eventRoutes = new Hono<AppEnv>();

const Page = z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(500).default(100), projectId: z.string().optional() });

/**
 * Activity filtered by the caller's grants (§F: every read checks the resource grant):
 * - owners see everything;
 * - everyone else sees an event only if they can read its project (when it has one) and **every**
 *   resource it names; org-level events naming no resource are owner-only;
 * - clients and viewers additionally see only client-visible events, with `clientDetail` (codes and
 *   paths, never raw runner output) instead of `detail`, and the actor reduced to its kind;
 * - editions (Task 21): a non-developer sees an `edition` event only with use of that edition
 *   (review M-6); events of a proposal opened by an edition return are visible through edition
 *   use alone (ruling I-1), with paths limited to the edition.
 */
eventRoutes.get("/orgs/:org/events", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const q = parseQuery(c, Page);
  const svc = c.get("svc");
  const dev = isDeveloper(actor.role);
  const owner = actor.role === "owner";
  const rows = await svc.db
    .prepare(`SELECT * FROM events WHERE org_id = ? AND seq > ?${q.projectId ? " AND project_id = ?" : ""}${dev ? "" : " AND client_visible = 1"} ORDER BY seq LIMIT ?`)
    .bind(actor.orgId, q.after, ...(q.projectId ? [q.projectId] : []), q.limit)
    .all<{ seq: number; project_id: string | null; at: string; actor_json: string; action: string; subject_kind: string; subject_id: string; detail_json: string | null; resource_ids: string; client_detail_json: string | null }>();
  const projectOk = new Map<string, boolean>();
  const resourceOk = new Map<string, boolean>();
  const editionOk = new Map<string, boolean>();
  const scopes = new Map<string, EditionScope | null>();
  const out = [];
  for (const r of rows.results) {
    let scope: EditionScope | null = null;
    if (!owner && !dev && r.subject_kind === "edition") {
      if (!editionOk.has(r.subject_id)) editionOk.set(r.subject_id, await editionUse(svc, actor, r.subject_id));
      if (!editionOk.get(r.subject_id)) continue;
    } else if (!owner) {
      const resources = JSON.parse(r.resource_ids) as string[];
      if (!r.project_id && resources.length === 0) continue;
      if (r.project_id && !projectOk.has(r.project_id)) projectOk.set(r.project_id, await canReadProject(svc, actor, r.project_id));
      let ok = projectOk.get(r.project_id ?? "") ?? !r.project_id;
      for (const id of resources) {
        if (!resourceOk.has(id)) resourceOk.set(id, await canReadResource(svc, actor, id));
        if (!resourceOk.get(id)) ok = false;
      }
      if (!ok && !dev && r.subject_kind === "proposal") {
        if (!scopes.has(r.subject_id)) scopes.set(r.subject_id, await editionScopeForProposal(svc, actor, r.subject_id));
        scope = scopes.get(r.subject_id) ?? null;
        ok = !!scope;
      }
      if (!ok) continue;
    }
    const actorRef = JSON.parse(r.actor_json) as { kind: string; id: string };
    let detail = dev ? r.detail_json : r.client_detail_json;
    if (scope && detail) {
      const d = JSON.parse(detail) as { conflictPaths?: string[] };
      const rid = (JSON.parse(r.resource_ids) as string[])[0] ?? "";
      if (d.conflictPaths) d.conflictPaths = d.conflictPaths.map((x) => scope!.toEditionPath(rid, x)).filter((x): x is string => x !== null);
      detail = JSON.stringify(d);
    }
    out.push({
      seq: r.seq,
      at: r.at,
      projectId: r.project_id,
      action: r.action,
      subject: { kind: r.subject_kind, id: r.subject_id },
      actor: dev ? actorRef : { kind: actorRef.kind },
      ...(detail ? { detail: JSON.parse(detail) as unknown } : {}),
    });
  }
  return c.json({ events: out, next: rows.results.length ? rows.results[rows.results.length - 1]!.seq : q.after });
});

/** Ledger audit (accepts, restores, binds, dead letters): org-wide and unfiltered, so owners only (I-3). */
eventRoutes.get("/orgs/:org/audit", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner"]);
  const q = parseQuery(c, Page);
  const rows = await c.get("svc").ledger(actor.orgId).listAudit({ after: q.after, limit: q.limit });
  return c.json({ audit: rows.map((r) => ({ seq: r.seq, ...r.event, ...(r.detailJson ? { detail: JSON.parse(r.detailJson) as unknown } : {}) })), next: rows.length ? rows[rows.length - 1]!.seq : q.after });
});
