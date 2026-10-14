/** Proposals: create from a task, read (client and developer views share the hash), integrate. */
import { CandidateIdSchema, type CandidateRecord, type ProposalRecord } from "@commonforge-org/core";
import { presentCandidate } from "./candidates.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { conflict, forbidden, notFound, readJson } from "../lib/http.js";
import { canReadProject, canReadResource, canWriteResource, isDeveloper, orgActor, readableProject, seesCanonical, type OrgActor } from "../middleware/authz.js";
import { editionScopeForProposal, type EditionScope } from "../services/editions.js";
import { recordEvent, userRef } from "../services/events.js";
import { proposeTaskWorkspaces, proposalResourceIds, getProposalIndex, latestIntegration, latestIntegrationAttempt, type IntegrationAttemptView, type ProposalIndexRow } from "../services/proposals.js";
import { assertIntegrable, issueIntegration } from "../services/integration.js";
import { stagingPolicyOf } from "../services/staging-policy.js";
import { getTask, listWorkspaces } from "../services/tasks.js";

export const proposalRoutes = new Hono<AppEnv>();


/**
 * The proposal if the caller may see it: developers with project access; clients/viewers need read
 * on every changed resource. A proposal opened by a client edition return is also visible (and
 * approvable) through edition access alone: its returning client and any client holding a live
 * grant on that edition, without any canonical grant (Task 21 ruling I-1). That view is limited
 * to the edition's paths (`scope`).
 */
export async function visibleProposal(c: Context<AppEnv>, actor: OrgActor, proposalId: string): Promise<{ p: ProposalRecord; idx: ProposalIndexRow; scope: EditionScope | null }> {
  const svc = c.get("svc");
  const idx = await getProposalIndex(svc, actor.orgId, proposalId);
  if (!idx) throw notFound("proposal not found");
  const p = await svc.ledger(actor.orgId).getProposal(proposalId);
  if (!p) throw notFound("proposal not found");
  let canonical = await canReadProject(svc, actor, idx.project_id);
  for (const r of [...p.resourceChanges.map((x) => x.resourceId), ...p.assetManifestChanges.map((x) => x.resourceId)]) {
    if (canonical && !(await canReadResource(svc, actor, r))) canonical = false;
  }
  if (canonical) return { p, idx, scope: null };
  if (!isDeveloper(actor.role)) {
    const scope = await editionScopeForProposal(svc, actor, proposalId);
    if (scope) return { p, idx, scope };
  }
  throw notFound("proposal not found");
}

/** Paths of an edition-scoped view: mapped to edition paths; anything outside the edition is dropped. */
function scopedPaths(scope: EditionScope, resourceId: string, paths: readonly string[] | undefined): string[] {
  return (paths ?? []).map((x) => scope.toEditionPath(resourceId, x)).filter((x): x is string => x !== null);
}

proposalRoutes.post("/orgs/:org/proposals", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, z.object({ taskId: z.string().min(1), candidateIds: z.array(CandidateIdSchema).optional() }));
  const svc = c.get("svc");
  const task = await getTask(svc, body.taskId);
  if (!task || task.org_id !== actor.orgId) throw notFound("task not found");
  const project = await readableProject(svc, actor, task.project_id);
  // P42-2: in staging mode a task reaches main only through staging and its promotion (landings
  // make their own proposals in services/staging.ts, not through this route)
  if (stagingPolicyOf(project)) throw conflict("staging_proposal", "this project uses staging: promote the task instead");
  const ledger = svc.ledger(actor.orgId);
  const ws = await listWorkspaces(svc, task.task_id);
  const ids =
    body.candidateIds ??
    (await svc.db.prepare("SELECT candidate_id FROM task_candidates WHERE task_id = ? ORDER BY created_at").bind(task.task_id).all<{ candidate_id: string }>()).results.map((r) => r.candidate_id);
  const candidates: CandidateRecord[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const rec = await ledger.getCandidate(id);
    const own = await svc.db.prepare("SELECT 1 AS x FROM task_candidates WHERE candidate_id = ? AND task_id = ?").bind(id, task.task_id).first();
    if (!rec || !own) throw notFound(`candidate ${id} not found in this task`);
    if (rec.state !== "frozen" && rec.state !== "prepared") throw conflict("candidate_not_available", `candidate ${id} is ${rec.state}`);
    // one candidate per resource: the latest freeze wins when several exist
    if (seen.has(rec.candidate.resourceId)) candidates.splice(candidates.findIndex((x) => x.candidate.resourceId === rec.candidate.resourceId), 1);
    seen.add(rec.candidate.resourceId);
    candidates.push(rec);
  }
  const assetWs = ws.filter((w) => w.provider === "r2-assets" && w.state === "frozen" && w.asset_manifest_id);
  for (const r of [...candidates.map((x) => x.candidate.resourceId), ...assetWs.map((w) => w.resource_id)]) {
    if (!(await canWriteResource(svc, actor, r))) throw forbidden("no_write_grant", `no write grant on ${r}`);
  }
  const record = await proposeTaskWorkspaces(svc, { orgId: actor.orgId, task, proposalId: `prop-${crypto.randomUUID()}`, candidates, assetWs, actor: actor.userId });
  return c.json(await presentProposal(c, actor, record), 201);
});

proposalRoutes.get("/orgs/:org/proposals", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const svc = c.get("svc");
  const projectId = c.req.query("projectId");
  const rows = projectId
    ? await svc.db.prepare("SELECT proposal_id FROM proposals_index WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC").bind(actor.orgId, projectId).all<{ proposal_id: string }>()
    : await svc.db.prepare("SELECT proposal_id FROM proposals_index WHERE org_id = ? ORDER BY created_at DESC LIMIT 200").bind(actor.orgId).all<{ proposal_id: string }>();
  const out = [];
  for (const r of rows.results) {
    try {
      const { p, idx } = await visibleProposal(c, actor, r.proposal_id);
      out.push({ proposalId: p.proposalId, proposalHash: p.proposalHash, projectId: p.projectId, changeId: p.changeId, kind: idx.kind ?? null, state: p.state, createdAt: p.createdAt, updatedAt: p.updatedAt });
    } catch {
      /* not visible to this caller */
    }
  }
  return c.json({ proposals: out });
});

async function readableDeps(svc: AppEnv["Variables"]["svc"], actor: OrgActor, deps: ProposalRecord["readDependencies"]) {
  const out = [];
  for (const d of deps) out.push((await canReadResource(svc, actor, d.resourceId)) ? d : { redacted: true as const, mode: d.mode });
  return out;
}

/**
 * Re-review m1: a contract check names its producer and consumer resources. Since review C1 every
 * website-only proposal runs the contract, so a client who reads only the website would otherwise
 * learn the `api` resource id that `readDependencies` redacts: unreadable ids are left out.
 */
async function redactAttempt(svc: AppEnv["Variables"]["svc"], actor: OrgActor, a: IntegrationAttemptView | null): Promise<IntegrationAttemptView | null> {
  if (!a) return a;
  const contractChecks = [];
  for (const cc of a.contractChecks) {
    const { producerResource, consumerResource, ...rest } = cc;
    contractChecks.push({
      ...rest,
      ...(producerResource && (await canReadResource(svc, actor, producerResource)) ? { producerResource } : {}),
      ...(consumerResource && (await canReadResource(svc, actor, consumerResource)) ? { consumerResource } : {}),
    });
  }
  return { ...a, contractChecks };
}

async function presentProposal(c: Context<AppEnv>, actor: OrgActor, p: ProposalRecord, scope: EditionScope | null = null) {
  const svc = c.get("svc");
  const ledger = svc.ledger(actor.orgId);
  const heads = new Map((await ledger.listHeads()).map((h) => [h.resourceId as string, h.revisionId as string]));
  const stale = [
    ...p.resourceChanges.filter((x) => heads.get(x.resourceId) !== x.baseRevision).map((x) => x.resourceId),
    ...p.assetManifestChanges.filter((x) => heads.get(x.resourceId) !== `r2m:${x.baseManifestId}`).map((x) => x.resourceId),
  ];
  for (const d of p.readDependencies) {
    if (d.mode === "must-match-accepted" && heads.get(d.resourceId) !== d.revisionId && (await canReadResource(svc, actor, d.resourceId))) stale.push(d.resourceId);
  }
  const approvals = await ledger.listApprovals(p.proposalId);
  const integ = await latestIntegration(svc, actor.orgId, p.proposalId);
  const candidates = [];
  for (const rc of p.resourceChanges) {
    const rec = await ledger.getCandidate(rc.candidateId);
    if (rec) candidates.push(presentCandidate(rec.candidate, rec.state, rec.preparedReceiptId, actor.role === "owner"));
  }
  const view = {
    proposalId: p.proposalId,
    // AT-19: client and developer views carry the identical hash
    proposalHash: p.proposalHash,
    projectId: p.projectId,
    changeId: p.changeId,
    state: p.state,
    baseSnapshotId: p.baseSnapshotId,
    candidateSnapshotId: p.candidateSnapshotId,
    resourceChanges: p.resourceChanges,
    assetManifestChanges: p.assetManifestChanges,
    // M-9: dependencies on resources the caller cannot read are redacted
    readDependencies: await readableDeps(svc, actor, p.readDependencies),
    policyRevision: p.policyRevision,
    preparedReceipts: p.preparedReceipts,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    stale,
    approvals: approvals.map((a) => ({ approvalId: a.approvalId, role: a.role, approvedAt: a.approvedAt, proposalHash: a.proposalHash, approver: isDeveloper(actor.role) ? a.approver : { kind: a.approver.kind } })),
    integration: integ
      ? {
          jobId: integ.jobId,
          forCurrentHash: integ.receipt.evidence.proposalHash === p.proposalHash,
          integratedAt: integ.receipt.integratedAt,
          checks: integ.receipt.evidence.checks.map((x) => ({ checkId: x.checkId, result: x.result })),
          contractChecks: integ.receipt.evidence.contractChecks.map((x) => ({ contractId: x.contractId, result: x.result })),
          mergeOutcome: integ.receipt.evidence.mergeOutcome,
          ...(seesCanonical(actor.role) ? { results: integ.receipt.results } : {}),
        }
      : null,
    candidates,
    // the latest integrate run whatever its outcome (a failed run leaves `integration` unchanged)
    lastAttempt: await redactAttempt(svc, actor, await latestIntegrationAttempt(svc, actor.orgId, p.proposalId, p.proposalHash, seesCanonical(actor.role))),
  };
  if (!scope) return view;
  // edition-only client (I-1): file names, conflicts and evidence only inside the edition
  const merge = (m: { resourceId: string; conflictPaths?: string[] }) => ({ ...m, ...(m.conflictPaths ? { conflictPaths: scopedPaths(scope, m.resourceId, m.conflictPaths) } : {}) });
  const target = p.resourceChanges[0]?.resourceId as string | undefined;
  return {
    ...view,
    edition: { editionId: scope.editionId, name: scope.name },
    candidates: view.candidates.map((cand) => ({ ...cand, changedPaths: scopedPaths(scope, cand.resourceId, cand.changedPaths) })),
    integration: view.integration ? { ...view.integration, mergeOutcome: view.integration.mergeOutcome.map(merge) } : null,
    lastAttempt: view.lastAttempt
      ? { ...view.lastAttempt, mergeOutcome: view.lastAttempt.mergeOutcome.map(merge), conflictPaths: target ? scopedPaths(scope, target, view.lastAttempt.conflictPaths) : [] }
      : null,
  };
}

proposalRoutes.get("/orgs/:org/proposals/:id", async (c) => {
  const actor = await orgActor(c, c.req.param("org"));
  const { p, scope } = await visibleProposal(c, actor, c.req.param("id"));
  return c.json(await presentProposal(c, actor, p, scope));
});

/**
 * Request integration (runner `integrate`, services/integration.ts): merge the candidates onto the
 * expected heads, run the server-owned checks/contracts and sign evidence. Returns at once (202).
 * Landing proposals are refused (`staging_proposal`); promotion proposals get explicit merge bases.
 */
proposalRoutes.post("/orgs/:org/proposals/:id/integrate", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const svc = c.get("svc");
  const { p, idx } = await visibleProposal(c, actor, c.req.param("id"));
  assertIntegrable(p, idx);
  // M-8: integrate pushes integration refs into canonical repos: write grants, like accept
  for (const r of proposalResourceIds(p)) if (!(await canWriteResource(svc, actor, r))) throw forbidden("no_write_grant", `no write grant on ${r}`);
  const { jobId } = await issueIntegration(svc, userRef(actor.userId), p, idx);
  return c.json({ proposalId: p.proposalId, jobId, state: "queued" }, 202);
});

/** Moved to services/integration.ts (re-exported for existing imports). */
export { policyGaps } from "../services/integration.js";
