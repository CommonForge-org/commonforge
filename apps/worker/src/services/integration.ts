/**
 * The runner `integrate` job of a proposal (shared by the integrate route and the promotion
 * service): merge the candidates onto the expected heads (the proposal's bases — stale-base policy
 * is refuse, §C.2), run the server-owned checks/contracts, push
 * `refs/commonforge/integrations/<proposalId>/<jobId>` and sign evidence.
 *
 * - One target per changed resource, `expectedHead` = its current head; every change on it must
 *   name that head as its base (else `expected_head_stale`). Candidates in proposal order.
 * - Promotion proposals (`kind = 'promotion'`) also carry `mergeBases`: each candidate's own
 *   recorded base (`revisionCommitSha(candidate.baseRevision)`, computed here, never read from the
 *   promotions row), so the runner applies only the candidate's own edits (staging phase 2, R3).
 * - Landing proposals (`kind = 'staging'`) are never integrated: their bases are staging commits;
 *   they reach `main` only through a promotion.
 * - An assets-only proposal (follow-up Task 23) gets the same job with no candidates and no
 *   targets, only `assetChanges`.
 * - `checks: "none"` runs no checks or contracts: a content-only file change landing on its own
 *   (spec 2026-10-07 §7, folders and uploads); everything else runs the server-owned policy.
 */
import { jobIntegrationRef, type IntegrationJobInput } from "@commonforge-org/runner-protocol";
import { parseRevisionId, r2mRevisionId, revisionCommitSha, type FrozenCandidate, type PrincipalRef, type ProjectSnapshot, type ProposalRecord, type RepoCoords } from "@commonforge-org/core";
import type { Services } from "../context.js";
import { conflict } from "../lib/http.js";
import { repoInfoCoords } from "./artifacts.js";
import { getProject, getResource, projectPolicy, resourceCoords, type ProjectPolicy } from "./directory.js";
import { recordEvent } from "./events.js";
import { proposalResourceIds, type ProposalIndexRow } from "./proposals.js";
import { issueJob } from "./runner-jobs.js";

/** The client-facing text of the refusal to integrate, accept or approve a landing proposal. */
export const STAGING_PROPOSAL_TEXT = "Promote this task from staging instead";

/** Refusals that do not depend on heads or repositories (checked before authorization details). */
export function assertIntegrable(p: ProposalRecord, idx: ProposalIndexRow): void {
  if (idx.kind === "staging") throw conflict("staging_proposal", STAGING_PROPOSAL_TEXT);
  if (p.state !== "prepared") throw conflict("proposal_not_prepared", `proposal is ${p.state}; wait until every candidate is prepared`);
  if (p.resourceChanges.length === 0 && p.assetManifestChanges.length === 0) throw conflict("nothing_to_integrate", "the proposal changes nothing");
}

/**
 * Landing and promotion proposals never go through the accept or approvals routes (P2-2): a
 * landing reaches `main` only through a promotion, and a promotion proposal is accepted only by the
 * promotion service with its clearance.
 */
export function assertUserAcceptable(idx: ProposalIndexRow): void {
  if (idx.kind === "staging") throw conflict("staging_proposal", STAGING_PROPOSAL_TEXT);
  if (idx.kind === "promotion") throw conflict("promotion_proposal", "a promotion proposal is approved and accepted only through its promotion");
}

export interface IssueIntegrationOptions {
  /**
   * Dedupe key of the job (`runner_jobs.job_key`). When given, an earlier job with this key that
   * is still queued (not expired) or succeeded, and was issued for this proposal id *and hash*, is
   * returned instead of issuing a new one (idempotent retries of a step). Include the proposal hash
   * in the key (e.g. `promotion:<id>:<proposalHash>`): a job for another hash is never reused, but
   * a key without it would make every rewrite issue a fresh job under the same key. Default: a
   * hash of the job body, which is bound to the fresh job id, so every call issues a new job.
   */
  jobKey?: string;
  /** runs after the job is recorded and before it is enqueued (link the job id to its subject first) */
  beforeEnqueue?: (jobId: string) => Promise<void>;
  /** runs once the job was enqueued (a fresh job only) */
  onSent?: (jobId: string) => void;
  /** `"none"`: no checks or contracts (a content-only file change). Default `"policy"`. */
  checks?: "policy" | "none";
}

/** Issue (or, with `opts.jobKey`, rejoin) the integrate job of a proposal. Authorization is the caller's. */
export async function issueIntegration(svc: Services, actor: PrincipalRef, p: ProposalRecord, idx: ProposalIndexRow, opts: IssueIntegrationOptions = {}): Promise<{ jobId: string; reused: boolean }> {
  assertIntegrable(p, idx);
  const orgId = idx.org_id;
  if (opts.jobKey) {
    const prior = await svc.db
      .prepare("SELECT job_id, status, expires_at, signed_json FROM runner_jobs WHERE org_id = ? AND job_key = ? AND kind = 'integrate' ORDER BY issued_at DESC, rowid DESC LIMIT 1")
      .bind(orgId, opts.jobKey)
      .first<{ job_id: string; status: string; expires_at: number; signed_json: string }>();
    // review I2: only a job for this very proposal content (a rewritten proposal keeps its id)
    const job = prior ? (JSON.parse(prior.signed_json) as { job: { proposalId?: string; proposalHash?: string } }).job : null;
    const same = !!job && job.proposalId === p.proposalId && job.proposalHash === p.proposalHash;
    if (prior && same && (prior.status === "succeeded" || (prior.status === "queued" && prior.expires_at > svc.now().getTime()))) return { jobId: prior.job_id, reused: true };
  }
  const promotion = idx.kind === "promotion";
  const ledger = svc.ledger(orgId);
  const candidates: FrozenCandidate[] = [];
  const mergeBases: Record<string, string> = {};
  const targets: Array<{ resourceId: string; canonical: RepoCoords; expectedHead: string }> = [];
  for (const rc of p.resourceChanges) {
    const head = await ledger.getHead(rc.resourceId);
    if (!head || head.revisionId !== rc.baseRevision) throw conflict("expected_head_stale", `resource ${rc.resourceId} moved since the proposal was made`, { resourceId: rc.resourceId });
    const rec = await ledger.getCandidate(rc.candidateId);
    if (!rec) throw conflict("candidate_missing", `candidate ${rc.candidateId} not found`);
    candidates.push(rec.candidate);
    if (promotion) {
      const base = revisionCommitSha(rec.candidate.baseRevision);
      if (!base) throw conflict("promotion_base_unsupported", `candidate ${rc.candidateId} has no git base`);
      mergeBases[rc.candidateId] = base;
    }
    // one target per resource (a promotion has several changes on one resource)
    if (targets.some((t) => t.resourceId === rc.resourceId)) continue;
    const r = await getResource(svc.db, orgId, rc.resourceId);
    const coords = r ? resourceCoords(r) : null;
    if (!coords || coords.kind !== "artifacts") throw conflict("resource_not_ready", "no canonical repository");
    const info = await svc.transport.getRepo(coords.namespace, coords.repoName);
    if (!info || info.id !== coords.repoId) throw conflict("repo_mismatch", "canonical repository changed");
    targets.push({ resourceId: rc.resourceId, canonical: repoInfoCoords(coords.namespace, info), expectedHead: rc.baseRevision });
  }
  // asset changes are validated with the rest (no merge: the manifest replaces the head at accept)
  for (const a of p.assetManifestChanges) {
    const head = await ledger.getHead(a.resourceId);
    if (!head || a.baseManifestId === null || head.revisionId !== r2mRevisionId(a.baseManifestId)) throw conflict("expected_head_stale", `resource ${a.resourceId} moved since the proposal was made`, { resourceId: a.resourceId });
  }
  const project = await getProject(svc.db, orgId, idx.project_id);
  const policy = project ? projectPolicy(project) : {};
  const baseSnapshot = JSON.parse(idx.base_snapshot_json) as ProjectSnapshot;
  const candidateSnapshot = JSON.parse(idx.candidate_snapshot_json) as ProjectSnapshot;
  // N-1: every other git entry of the snapshot is a read-only reference (canonical, pinned by the
  // snapshot's sha; runner-only read access per §F) so checks/contracts on those mounts can run
  const targetIds = new Set(targets.map((t) => t.resourceId));
  const references: Array<{ resourceId: string; coords: RepoCoords }> = [];
  for (const e of baseSnapshot.entries) {
    if (targetIds.has(e.resourceId) || parseRevisionId(e.revisionId).kind !== "art") continue;
    const r = await getResource(svc.db, orgId, e.resourceId);
    const coords = r ? resourceCoords(r) : null;
    if (!coords || coords.kind !== "artifacts") continue;
    const info = await svc.transport.getRepo(coords.namespace, coords.repoName);
    if (!info || info.id !== coords.repoId) throw conflict("repo_mismatch", `canonical repository of ${e.resourceId} changed`);
    references.push({ resourceId: e.resourceId, coords: repoInfoCoords(coords.namespace, info) });
  }
  // review C1: every policy check and contract must be evaluable on this proposal's snapshot (the
  // proposal pins the mounts they need, services/proposals.ts withPolicyReferences). Never drop one
  // silently: a dropped contract leaves no trace in the evidence the ledger judges at accept. (A
  // content-only file change runs none, so there is nothing to evaluate.)
  const withChecks = opts.checks !== "none";
  const unevaluable = withChecks ? policyGaps(policy, baseSnapshot) : [];
  if (unevaluable.length > 0) {
    throw conflict("policy_unevaluable", `the project policy cannot be evaluated on this proposal: ${unevaluable.join("; ")}. Re-propose after fixing the policy or the mounts.`, { unevaluable });
  }
  const job = await issueJob(
    svc,
    (jobId) =>
      ({
        kind: "integrate",
        proposalId: p.proposalId,
        proposalHash: p.proposalHash,
        baseSnapshot,
        // the snapshot the evidence must be signed for (signature-covered; the ledger checks it)
        candidateSnapshotId: candidateSnapshot.snapshotId,
        candidates,
        targets,
        // assets-only jobs only: a mixed job stays byte-identical to what older runners verify (review M-1)
        ...(targets.length === 0 ? { assetChanges: p.assetManifestChanges } : {}),
        ...(references.length > 0 ? { references } : {}),
        integrationRef: jobIntegrationRef(p.proposalId, jobId),
        // server-owned policy only: repository files never become checks (AT-18/AT-38); `gatesAlone`
        // is the promotion service's (B8), never sent: jobs stay byte-identical for runners
        checks: withChecks ? (policy.checks ?? []).map(({ gatesAlone: _gatesAlone, ...c }) => c) : [],
        contracts: (withChecks ? (policy.contracts ?? []) : []) as never,
        // promotion builds only: ordinary jobs stay byte-identical to what older runners verify
        ...(promotion ? { mergeBases } : {}),
      }) as IntegrationJobInput,
    { orgId, subject: `proposal:${p.proposalId}`, lifetimeSeconds: 3600, ...(opts.jobKey ? { jobKey: opts.jobKey } : {}), ...(opts.beforeEnqueue ? { beforeEnqueue: opts.beforeEnqueue } : {}) },
  );
  opts.onSent?.(job.jobId);
  await recordEvent(svc, { orgId, projectId: idx.project_id, actor, action: "proposal.integration_requested", subjectKind: "proposal", subjectId: p.proposalId, resourceIds: proposalResourceIds(p), detail: { jobId: job.jobId } });
  return { jobId: job.jobId, reused: false };
}

/** Policy checks/contracts whose mounts or resources are not in the snapshot (review C1: fail closed). */
export function policyGaps(policy: ProjectPolicy, snapshot: ProjectSnapshot): string[] {
  const mounts = new Set(snapshot.entries.map((e) => e.mountName as string));
  const resources = new Set(snapshot.entries.map((e) => e.resourceId as string));
  const out: string[] = [];
  for (const ch of policy.checks ?? []) if (!mounts.has(ch.mountName)) out.push(`check ${ch.checkId}: mount ${ch.mountName} is not in the snapshot`);
  for (const raw of policy.contracts ?? []) {
    const ct = raw as { contractId: string; producerOutput: { mountName: string }; schema: { resourceId: string }; consumerResource: string };
    if (!mounts.has(ct.producerOutput.mountName)) out.push(`contract ${ct.contractId}: producer mount ${ct.producerOutput.mountName} is not in the snapshot`);
    if (!resources.has(ct.schema.resourceId)) out.push(`contract ${ct.contractId}: schema resource ${ct.schema.resourceId} is not in the snapshot`);
    if (!resources.has(ct.consumerResource)) out.push(`contract ${ct.contractId}: consumer resource ${ct.consumerResource} is not in the snapshot`);
  }
  return out;
}
