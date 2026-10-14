/**
 * Approvals (plan §A.5 rule 6: approval ≠ acceptance ≠ release). An approval names the exact
 * `proposalHash` the approver reviewed (AT-19); a changed proposal has a new hash and needs a new
 * approval (AT-09, AT-11). Which roles count is server-owned project policy. The role recorded is
 * always the caller's own, so nobody creates a `clearance:*` approval here (staging phase 2);
 * landing and promotion proposals are refused outright.
 */
import { ProposalHashSchema } from "@commonforge-org/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { conflict, forbidden, readJson } from "../lib/http.js";
import { isDeveloper, orgActor } from "../middleware/authz.js";
import { newId } from "../lib/crypto.js";
import { recordEvent, userRef } from "../services/events.js";
import { approvalRoles, proposalResourceIds } from "../services/proposals.js";
import { assertUserAcceptable } from "../services/integration.js";
import { visibleProposal } from "./proposals.js";

export const approvalRoutes = new Hono<AppEnv>();

approvalRoutes.post("/orgs/:org/proposals/:id/approvals", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer", "client"]);
  const body = await readJson(c, z.object({ proposalHash: ProposalHashSchema }));
  const svc = c.get("svc");
  const { p, idx } = await visibleProposal(c, actor, c.req.param("id"));
  assertUserAcceptable(idx);
  const allowed = await approvalRoles(svc, actor.orgId, idx.project_id);
  if (!allowed.includes(actor.role)) throw forbidden("approval_role_not_allowed", `this project accepts approvals from: ${allowed.join(", ")}`);
  if (body.proposalHash !== p.proposalHash) throw conflict("proposal_hash_mismatch", "the proposal changed since you reviewed it; review the new version", { currentHash: p.proposalHash });
  if (p.state !== "open" && p.state !== "prepared") throw conflict("proposal_closed", `proposal is ${p.state}`);
  const approval = {
    approvalId: newId("appr", 10),
    proposalId: p.proposalId,
    proposalHash: p.proposalHash,
    approver: userRef(actor.userId),
    role: actor.role,
    approvedAt: svc.nowIso(),
  };
  await svc.ledger(actor.orgId).putApproval(actor.orgId, approval);
  await recordEvent(svc, { orgId: actor.orgId, projectId: idx.project_id, actor: userRef(actor.userId), action: "proposal.approved", subjectKind: "proposal", subjectId: p.proposalId, resourceIds: proposalResourceIds(p), detail: { role: actor.role, proposalHash: p.proposalHash }, clientVisible: true });
  return c.json(approval, 201);
});

approvalRoutes.get("/orgs/:org/proposals/:id/approvals", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const { p } = await visibleProposal(c, actor, c.req.param("id"));
  const list = await c.get("svc").ledger(actor.orgId).listApprovals(p.proposalId);
  return c.json({ approvals: list.map((a) => ({ ...a, approver: isDeveloper(actor.role) ? a.approver : { kind: a.approver.kind } })) });
});
