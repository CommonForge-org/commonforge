/**
 * Isolated private previews (Task 22). See services/previews.ts and API.md "Previews".
 *
 * Previews are requested per proposal (its latest integration for the current hash), built by a
 * runner `preview-build` job in the Sandbox, and served by the dedicated preview Worker on its own
 * origin. The link (with the per-preview expiring token) is only returned to callers who can see
 * the proposal.
 */
import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { conflict, forbidden, notFound } from "../lib/http.js";
import { canWriteResource, isDeveloper, orgActor } from "../middleware/authz.js";
import { getPreview, presentPreview, requestPreview, revokePreview, type PreviewRow } from "../services/previews.js";
import { proposalResourceIds } from "../services/proposals.js";
import { isStagingProject } from "../services/staging-state.js";
import { visibleProposal } from "./proposals.js";

export const previewsRoutes = new Hono<AppEnv>();

/** Request a preview: owners and developers with write grants on the changed resources (it runs their code). */
previewsRoutes.post("/orgs/:org/proposals/:id/previews", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const { p, idx } = await visibleProposal(c, actor, c.req.param("id"));
  // P42-2: staging is the project's shared preview; previews made before staging was turned on stay readable
  if (await isStagingProject(svc, actor.orgId, idx.project_id)) throw conflict("staging_mode", "staging replaces previews in this project");
  for (const r of proposalResourceIds(p)) if (!(await canWriteResource(svc, actor, r))) throw forbidden("no_write_grant", `no write grant on ${r}`);
  const pv = await requestPreview(svc, actor, p, idx);
  return c.json(await presentPreview(svc, pv, { developer: true, currentHash: p.proposalHash }), 202);
});

/** Previews of a proposal, newest first: everyone who can see the proposal (clients review previews too). */
previewsRoutes.get("/orgs/:org/proposals/:id/previews", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const { p } = await visibleProposal(c, actor, c.req.param("id"));
  const rows = await svc.db.prepare("SELECT * FROM previews WHERE org_id = ? AND proposal_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 20").bind(actor.orgId, p.proposalId).all<PreviewRow>();
  const previews = [];
  for (const r of rows.results) previews.push(await presentPreview(svc, r, { developer: isDeveloper(actor.role), currentHash: p.proposalHash }));
  return c.json({ previews });
});

async function visiblePreview(c: Parameters<typeof orgActor>[0], actor: Awaited<ReturnType<typeof orgActor>>, previewId: string) {
  const pv = await getPreview(c.get("svc"), actor.orgId, previewId);
  if (!pv) throw notFound("preview not found");
  const { p } = await visibleProposal(c, actor, pv.proposal_id); // 404 for callers who cannot see the proposal
  return { pv, p };
}

previewsRoutes.get("/orgs/:org/previews/:pvid", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const { pv, p } = await visiblePreview(c, actor, c.req.param("pvid"));
  return c.json(await presentPreview(c.get("svc"), pv, { developer: isDeveloper(actor.role), currentHash: p.proposalHash }));
});

/** Revoke a preview link at once (the preview Worker refuses it from the next request on). */
previewsRoutes.delete("/orgs/:org/previews/:pvid", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const { pv, p } = await visiblePreview(c, actor, c.req.param("pvid"));
  if (pv.revoked_at === null) await revokePreview(svc, pv, actor.userId);
  return c.json(await presentPreview(svc, (await getPreview(svc, actor.orgId, pv.preview_id))!, { developer: true, currentHash: p.proposalHash }));
});
