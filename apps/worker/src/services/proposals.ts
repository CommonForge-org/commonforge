/**
 * Proposals (plan §A.5, §B.9): a Change Packet over frozen candidates and asset manifest changes,
 * identified by `proposalHash` (core `computeProposalHash`). The ledger holds the record; D1 keeps
 * the full snapshots and an index by project/task.
 *
 * - Git candidates are prepared by a runner `prepare-candidate` job (queue step); asset manifests
 *   are "prepared" by the Worker itself (objects were HEAD-verified when the manifest was written).
 * - A proposal turns `prepared` when every change has a prepared receipt.
 * - `integrate` runs in the runner; its receipt (with HMAC-verified evidence bound to the proposal
 *   hash) is recorded in the ledger when the result arrives.
 */
import {
  PreparedReceiptSchema,
  ProjectSnapshotSchema,
  ProposalRecordSchema,
  artRevisionId,
  candidateId as toCandidateId,
  candidateRetentionRef,
  computeProposalHash,
  computeSnapshotId,
  parseRevisionId,
  r2mRevisionId,
  type AcceptInput,
  type ApprovalRef,
  type CandidateRecord,
  type IntegrationReceipt,
  type PreparedReceipt,
  type ProjectSnapshot,
  type ProposalRecord,
  type ResourceChange,
  type AssetManifestChange,
  type ReadDependency,
  type PrincipalRef,
  type ValidationEvidence,
  type FrozenCandidate,
  type RepoCoords,
} from "@commonforge-org/core";
import { jobIntegrationRef, type IntegrationJobInput, type SignedJob } from "@commonforge-org/runner-protocol";
import type { Services } from "../context.js";
import { conflict } from "../lib/http.js";
import { repoInfoCoords } from "./artifacts.js";
import { getProject, getResource, getRole, listMounts, projectPolicy, resourceCoords, type ProjectPolicy, type ProjectRow, type Role } from "./directory.js";
import { projectSnapshot } from "./snapshot.js";
import { canReadProject, canReadResource } from "../middleware/authz.js";
import { editionScopeForProposal } from "./editions.js";
import { recordEvent, userRef } from "./events.js";
import { dropChangeUploads, promoteObjects, promoteTask } from "./lfs-store.js";
import { issueJob, onRunnerResult, type RunnerJobRow } from "./runner-jobs.js";
import { enqueueStep } from "./steps.js";
import { taskSnapshot, type TaskRow, type WorkspaceRow } from "./tasks.js";

/** Every resource a proposal changes: its git and asset changes, not its read dependencies (event visibility needs read on all of them). */
export function proposalResourceIds(p: Pick<ProposalRecord, "resourceChanges" | "assetManifestChanges" | "readDependencies">): string[] {
  return [...new Set([...p.resourceChanges.map((x) => x.resourceId), ...p.assetManifestChanges.map((x) => x.resourceId)])];
}

export interface ProposalIndexRow {
  proposal_id: string;
  org_id: string;
  project_id: string;
  task_id: string | null;
  base_snapshot_json: string;
  candidate_snapshot_json: string;
  created_by: string;
  created_at: string;
  /** `staging`: a landing proposal (prop-stg-*); `promotion`: a promotion proposal (prop-pro-*); null: ordinary */
  kind: "staging" | "promotion" | null;
  promotion_id: string | null;
}

export async function getProposalIndex(svc: Services, orgId: string, proposalId: string): Promise<ProposalIndexRow | null> {
  return svc.db.prepare("SELECT * FROM proposals_index WHERE org_id = ? AND proposal_id = ?").bind(orgId, proposalId).first<ProposalIndexRow>();
}

/**
 * The Worker's own "prepare" for an asset manifest change (objects verified by writeManifest).
 * The receipt is write-once in the ledger and every proposal of the task re-records it, so it must
 * be deterministic: `preparedAt` is the freeze time (a frozen workspace's `updated_at`), never the
 * proposal's creation time (Task 23: a second proposal failed with `ledger_conflict`).
 */
export function assetReceipt(ws: WorkspaceRow): PreparedReceipt {
  const manifestId = ws.asset_manifest_id!;
  const cid = toCandidateId(ws.task_workspace_id, manifestId);
  return PreparedReceiptSchema.parse({
    receiptId: `rcpt-asset-${ws.task_workspace_id}-${manifestId.slice(0, 16)}`,
    jobId: "worker-asset-manifest",
    candidateId: cid,
    resourceId: ws.resource_id,
    canonicalRef: candidateRetentionRef(cid),
    sha: manifestId,
    revisionId: r2mRevisionId(manifestId),
    verifiedAssetObjects: [],
    preparedAt: ws.updated_at,
  });
}

/** The mounts the project policy's checks and contracts need (by mount name). */
export async function policyMounts(svc: Services, project: ProjectRow): Promise<Set<string>> {
  const policy = projectPolicy(project);
  const mounts = await listMounts(svc.db, project.org_id, project.project_id);
  const byResource = new Map(mounts.map((m) => [m.resource_id, m.mount_name]));
  const need = new Set<string>();
  for (const ch of policy.checks ?? []) need.add(ch.mountName);
  for (const raw of policy.contracts ?? []) {
    const ct = raw as { producerOutput: { mountName: string }; schema: { resourceId: string }; consumerResource: string };
    need.add(ct.producerOutput.mountName);
    for (const rid of [ct.schema.resourceId, ct.consumerResource]) {
      const m = byResource.get(rid);
      if (m) need.add(m);
    }
  }
  return need;
}

/**
 * Review C1 (Task 23): a proposal's base snapshot also holds every mount the project policy's checks
 * and contracts need, pinned at its accepted head when the proposal is made (read-only). Re-review
 * R1: they are `must-match-accepted`, so once a pinned producer, schema or consumer moves the ledger
 * refuses the proposal at accept with `dependency_stale` (no write skew: an accepted pair is always
 * one some contract run saw); re-proposing re-pins them. Integrate turns them into runner-only references, so a task
 * that does not mount the contract's producer (a website-only or logo-only task, a client edition
 * return) is still contract-checked against the exact producer revision bound into the candidate
 * snapshot (and so into the evidence and the proposal hash). Agents and clients get no credential
 * for them: the broker and materialization read the *task* snapshot.
 */
export async function withPolicyReferences(svc: Services, project: ProjectRow, base: ProjectSnapshot): Promise<ProjectSnapshot> {
  const have = new Set(base.entries.map((e) => e.mountName as string));
  const missing = new Set([...(await policyMounts(svc, project))].filter((m) => !have.has(m)));
  if (missing.size === 0) return base;
  const extra = (await projectSnapshot(svc, project, { onlyMounts: missing, writeMounts: new Set() })).entries.map((e) => ({ ...e, mode: "must-match-accepted" as const, operations: ["read" as const] }));
  if (extra.length === 0) return base;
  const body = { projectId: base.projectId, organizationId: base.organizationId, membershipRevision: base.membershipRevision, policyRevision: base.policyRevision, entries: [...base.entries, ...extra] };
  return ProjectSnapshotSchema.parse({ ...body, snapshotId: await computeSnapshotId(body), createdAt: base.createdAt });
}

export interface BuiltProposal {
  record: ProposalRecord;
  baseSnapshot: ProjectSnapshot;
  candidateSnapshot: ProjectSnapshot;
}

/**
 * Build the proposal for a task from its frozen git candidates and its asset manifests. The base is
 * the task's pinned snapshot; the candidate snapshot replaces each changed entry's revision.
 */
export async function buildProposal(
  svc: Services,
  task: TaskRow,
  proposalId: string,
  candidates: CandidateRecord[],
  assetWorkspaces: WorkspaceRow[],
): Promise<BuiltProposal> {
  const project = await getProject(svc.db, task.org_id, task.project_id);
  if (!project) throw conflict("project_missing", "project not found");
  const base = await withPolicyReferences(svc, project, taskSnapshot(task));
  const resourceChanges: ResourceChange[] = [];
  const assetManifestChanges: AssetManifestChange[] = [];
  const newRevision = new Map<string, string>();
  for (const c of candidates) {
    const r = await getResource(svc.db, task.org_id, c.candidate.resourceId);
    const coords = r ? resourceCoords(r) : null;
    if (!coords || coords.kind !== "artifacts") throw conflict("resource_not_ready", `resource ${c.candidate.resourceId} has no canonical repository`);
    const candidateRevision = artRevisionId(coords.repoId, c.candidate.sha);
    resourceChanges.push({ resourceId: c.candidate.resourceId, baseRevision: c.candidate.baseRevision, candidateId: c.candidate.candidateId, candidateRevision });
    newRevision.set(c.candidate.resourceId, candidateRevision);
  }
  for (const w of assetWorkspaces) {
    const baseManifest = (parseRevisionId(w.base_revision) as { manifestId: string }).manifestId;
    assetManifestChanges.push({ resourceId: w.resource_id, baseManifestId: baseManifest, newManifestId: w.asset_manifest_id! } as AssetManifestChange);
    newRevision.set(w.resource_id, r2mRevisionId(w.asset_manifest_id!));
  }
  if (newRevision.size === 0) throw conflict("nothing_to_propose", "the task has no frozen candidate or asset change");
  const readDependencies: ReadDependency[] = base.entries.filter((e) => !newRevision.has(e.resourceId)).map((e) => ({ resourceId: e.resourceId, revisionId: e.revisionId, mode: e.mode }));
  const candEntries = base.entries.map((e) => (newRevision.has(e.resourceId) ? { ...e, revisionId: newRevision.get(e.resourceId)! as typeof e.revisionId } : e));
  const snapBody = { projectId: base.projectId, organizationId: base.organizationId, membershipRevision: base.membershipRevision, policyRevision: base.policyRevision, entries: candEntries };
  const now = svc.nowIso();
  const candidateSnapshot = { ...snapBody, snapshotId: await computeSnapshotId(snapBody), createdAt: now } as ProjectSnapshot;
  // the proposal is made under the project's *current* policy revision (stale policy → refused at accept)
  const policyRevision = project.policy_revision;
  const hashInput = { baseSnapshotId: base.snapshotId, candidateSnapshotId: candidateSnapshot.snapshotId, resourceChanges, readDependencies, assetManifestChanges, policyRevision };
  const proposalHash = await computeProposalHash(hashInput);
  const preparedReceipts: ProposalRecord["preparedReceipts"] = [];
  for (const c of candidates) if (c.preparedReceiptId) preparedReceipts.push({ resourceId: c.candidate.resourceId, receiptId: c.preparedReceiptId });
  for (const w of assetWorkspaces) preparedReceipts.push({ resourceId: w.resource_id as never, receiptId: assetReceipt(w).receiptId });
  const total = resourceChanges.length + assetManifestChanges.length;
  const record = ProposalRecordSchema.parse({
    proposalId,
    proposalHash,
    organizationId: task.org_id,
    projectId: task.project_id,
    changeId: task.change_id,
    ...hashInput,
    state: preparedReceipts.length === total ? "prepared" : "open",
    preparedReceipts,
    createdAt: now,
    updatedAt: now,
  });
  return { record, baseSnapshot: base, candidateSnapshot };
}

/**
 * Open a proposal over a task's frozen candidates and asset workspaces (the body of
 * `POST /orgs/:org/proposals`, also used by a file collection's change, services/asset-changes.ts):
 * the asset receipts are recorded once, then the ledger record, the `proposals_index` row and the
 * `proposal.created` event. Idempotent on the proposal id: an existing proposal is returned as is.
 */
export async function proposeTaskWorkspaces(
  svc: Services,
  a: { orgId: string; task: TaskRow; proposalId: string; candidates: CandidateRecord[]; assetWs: WorkspaceRow[]; actor: string; detail?: Record<string, unknown> },
): Promise<ProposalRecord> {
  const ledger = svc.ledger(a.orgId);
  const existing = await ledger.getProposal(a.proposalId);
  if (existing) return existing;
  const built = await buildProposal(svc, a.task, a.proposalId, a.candidates, a.assetWs);
  // review m5: the asset receipt is write-once and every proposal of the task names it; record it
  // only once (its content may not be reproducible: a GC sweep bumps the row's updated_at)
  for (const w of a.assetWs) {
    const r = assetReceipt(w);
    if (!(await ledger.getPreparedReceipt(r.receiptId))) await ledger.recordPreparedReceipt(a.orgId, r);
  }
  await ledger.putProposal(built.record);
  await svc.db
    .prepare("INSERT OR IGNORE INTO proposals_index (proposal_id, org_id, project_id, task_id, base_snapshot_json, candidate_snapshot_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(a.proposalId, a.orgId, a.task.project_id, a.task.task_id, JSON.stringify(built.baseSnapshot), JSON.stringify(built.candidateSnapshot), a.actor, svc.nowIso())
    .run();
  await recordEvent(svc, {
    orgId: a.orgId,
    projectId: a.task.project_id,
    actor: userRef(a.actor),
    action: "proposal.created",
    subjectKind: "proposal",
    subjectId: a.proposalId,
    resourceIds: proposalResourceIds(built.record),
    detail: { proposalHash: built.record.proposalHash, changeId: a.task.change_id, ...(a.detail ?? {}) },
    clientVisible: true,
    clientDetail: { proposalHash: built.record.proposalHash },
  });
  return built.record;
}

/** Attach a newly prepared candidate's receipt to the open proposals that contain it. */
export async function attachReceipt(svc: Services, orgId: string, taskId: string, candidateId: string, resourceId: string, receiptId: string): Promise<void> {
  const ledger = svc.ledger(orgId);
  const rows = await svc.db.prepare("SELECT proposal_id FROM proposals_index WHERE org_id = ? AND task_id = ?").bind(orgId, taskId).all<{ proposal_id: string }>();
  for (const { proposal_id } of rows.results) {
    const p = await ledger.getProposal(proposal_id);
    if (!p || (p.state !== "open" && p.state !== "prepared")) continue;
    if (!p.resourceChanges.some((c) => c.candidateId === candidateId)) continue;
    if (p.preparedReceipts.some((r) => r.receiptId === receiptId)) continue;
    const preparedReceipts = [...p.preparedReceipts, { resourceId: resourceId as never, receiptId }];
    const total = p.resourceChanges.length + p.assetManifestChanges.length;
    // preparedReceipts are not hashed: updatedAt stays, so approvals stay valid
    await ledger.putProposal({ ...p, preparedReceipts, state: preparedReceipts.length >= total ? "prepared" : "open" });
  }
}

/** Approval roles from server-owned policy (never from repository files). */
export async function approvalRoles(svc: Services, orgId: string, projectId: string): Promise<Role[]> {
  const project = await getProject(svc.db, orgId, projectId);
  const roles = project ? projectPolicy(project).approvalRoles : undefined;
  return roles && roles.length > 0 ? roles : ["owner", "developer", "client"];
}

/**
 * Approvals whose approver is still a member in an allowed role (current authorization, FR-11).
 *
 * Clearances (staging phase 2): an approval whose role is `clearance:<kind>` is written only by the
 * promotion service. It counts only for a promotion proposal, and only while a `promotions` row
 * names this proposal and hash, is `cleared`/`accepting` with that clearance kind, and was cleared
 * by the approver (who must still be a member, and for a non-developer still read the project; the
 * `approvalRoles` filter does not apply). A
 * promotion proposal counts *only* clearances; any other proposal ignores clearances.
 */
export async function currentApprovals(svc: Services, orgId: string, projectId: string, approvals: ApprovalRef[], proposal?: ProposalRecord): Promise<ApprovalRef[]> {
  const proposalId = proposal?.proposalId ?? approvals[0]?.proposalId;
  const promotion = proposalId ? (await getProposalIndex(svc, orgId, proposalId))?.kind === "promotion" : false;
  const allowed = await approvalRoles(svc, orgId, projectId);
  const out: ApprovalRef[] = [];
  for (const a of approvals) {
    if (a.role.startsWith(CLEARANCE_ROLE_PREFIX)) {
      if (promotion && (await clearanceHonoured(svc, orgId, projectId, a))) out.push(a);
      continue;
    }
    if (promotion) continue;
    const role = await getRole(svc.db, orgId, a.approver.id);
    if (!role || !allowed.includes(role) || !allowed.includes(a.role as Role)) continue;
    // Task 21 re-review m-2: a client's approval counts only while the client can still see the
    // proposal (canonical read, or the edition access it approved through)
    if (proposal && role !== "owner" && role !== "developer" && !(await approverSees(svc, { orgId, userId: a.approver.id, role }, proposal))) continue;
    out.push(a);
  }
  return out;
}

/** Role prefix of the promotion service's typed approvals (`clearance:self|classifier|developer`). */
export const CLEARANCE_ROLE_PREFIX = "clearance:";

async function clearanceHonoured(svc: Services, orgId: string, projectId: string, a: ApprovalRef): Promise<boolean> {
  const role = await getRole(svc.db, orgId, a.approver.id);
  if (!role) return false;
  // a client's self clearance counts only while the client can still read the project
  if (role !== "owner" && role !== "developer" && !(await canReadProject(svc, { orgId, userId: a.approver.id, role }, projectId))) return false;
  const row = await svc.db
    .prepare("SELECT 1 AS x FROM promotions WHERE org_id = ? AND project_id = ? AND proposal_id = ? AND proposal_hash = ? AND state IN ('cleared', 'accepting') AND clearance_kind = ? AND cleared_by = ?")
    .bind(orgId, projectId, a.proposalId, a.proposalHash, a.role.slice(CLEARANCE_ROLE_PREFIX.length), a.approver.id)
    .first<{ x: number }>();
  return !!row;
}

async function approverSees(svc: Services, actor: { orgId: string; userId: string; role: Role }, p: ProposalRecord): Promise<boolean> {
  let canonical = await canReadProject(svc, actor, p.projectId);
  for (const r of proposalResourceIds(p)) if (canonical && !(await canReadResource(svc, actor, r))) canonical = false;
  return canonical || (await editionScopeForProposal(svc, actor, p.proposalId)) !== null;
}

/** Latest successful integrate receipt for this proposal (from D1 job results). */
export async function latestIntegration(svc: Services, orgId: string, proposalId: string): Promise<{ jobId: string; receipt: IntegrationReceipt } | null> {
  // review I1: the ledger is the authority. D1 marks a job `succeeded` before the applier records
  // the receipt; reading D1 let Accept run in that window (409 receipt_missing).
  const receipt = await svc.ledger(orgId).getIntegrationReceipt(proposalId);
  return receipt ? { jobId: receipt.jobId, receipt } : null;
}

/**
 * Re-review R3: how long a result D1 marks `succeeded` may wait for its ledger receipt. The runner
 * retries its result POST for about 16 s; past this the attempt reads `failed` with
 * `receipt_not_recorded` ("Validate again"), never a permanent `applying`. A late replay that does
 * record the receipt turns it `succeeded` again (the ledger is the authority).
 */
export const APPLYING_GRACE_MS = 2 * 60_000;

/** An integrate job superseded by a newer one, or finished after the proposal closed (R3): never "the latest attempt". */
export const SUPERSEDED_CODE = "integration_superseded";

interface AttemptRow {
  job_id: string;
  status: "queued" | "succeeded" | "failed";
  signed_json: string;
  result_json: string | null;
  issued_at: number;
  expires_at: number;
  completed_at: number | null;
}

/** The newest integrate job of a proposal that was not superseded (re-review R3). */
async function latestAttemptRow(svc: Services, orgId: string, proposalId: string): Promise<AttemptRow | null> {
  const rows = await svc.db
    .prepare("SELECT job_id, status, signed_json, result_json, issued_at, expires_at, completed_at FROM runner_jobs WHERE org_id = ? AND subject = ? AND kind = 'integrate' ORDER BY issued_at DESC, rowid DESC LIMIT 20")
    .bind(orgId, `proposal:${proposalId}`)
    .all<AttemptRow>();
  const superseded = (r: AttemptRow) => r.status === "failed" && !!r.result_json && (JSON.parse(r.result_json) as { code?: string }).code === SUPERSEDED_CODE;
  return rows.results.find((r) => !superseded(r)) ?? rows.results[0] ?? null;
}

/** `applying` (within the grace), `not_recorded` (past it) or null, for a job D1 says succeeded. */
function receiptPending(svc: Services, row: AttemptRow, receiptJobId: string | undefined): "applying" | "not_recorded" | null {
  if (row.status !== "succeeded" || receiptJobId === row.job_id) return null;
  return row.completed_at !== null && svc.now().getTime() - row.completed_at > APPLYING_GRACE_MS ? "not_recorded" : "applying";
}

/** The latest integrate attempt succeeded in D1 but its receipt is not in the ledger (yet, or past the grace). */
export async function integrationPending(svc: Services, orgId: string, proposalId: string): Promise<"applying" | "not_recorded" | null> {
  const row = await latestAttemptRow(svc, orgId, proposalId);
  if (!row || row.status !== "succeeded") return null;
  return receiptPending(svc, row, (await svc.ledger(orgId).getIntegrationReceipt(proposalId))?.jobId);
}

/**
 * The outcome of a proposal's latest integrate attempt, as a landing file change takes it
 * (`files.accept`); null while it runs or its receipt is being recorded. A job that expired queued
 * is `job_expired`; a success whose receipt never reached the ledger is `receipt_not_recorded`.
 */
export async function latestIntegrationOutcome(svc: Services, orgId: string, proposalId: string): Promise<{ ok: boolean; code?: string; detail?: string } | null> {
  const row = await latestAttemptRow(svc, orgId, proposalId);
  if (!row) return null;
  if (row.status === "queued") return row.expires_at < svc.now().getTime() ? { ok: false, code: "job_expired", detail: "the integration job expired without a result" } : null;
  if (row.status === "succeeded") {
    const pending = receiptPending(svc, row, (await svc.ledger(orgId).getIntegrationReceipt(proposalId))?.jobId);
    if (pending === "applying") return null;
    if (pending === "not_recorded") return { ok: false, code: "receipt_not_recorded", detail: "the runner reported success, but the integration receipt was never recorded" };
    return { ok: true };
  }
  const result = row.result_json ? (JSON.parse(row.result_json) as { code?: string; detail?: string }) : null;
  if (result?.code === SUPERSEDED_CODE) return null;
  return { ok: false, code: result?.code ?? "integration_failed", detail: result?.detail ?? "the integration failed" };
}

/**
 * The latest integration attempt of a proposal, whatever its outcome (Task 20 review C-1): the
 * review screen must show a failed run (contract, conflict, check) as clearly as a passing one.
 * Read from the runner job ledger in D1: the signed job says which proposal hash it was for; the
 * result is the stored `RunnerResult` (failure evidence was HMAC-verified when it was recorded).
 * `canonical` callers (owners, developers) also get the job id, the runner's detail text and the
 * evidence id; everyone else gets codes, names and paths only (API.md I-3).
 */
export interface IntegrationAttemptView {
  /** `applying`: the runner reported success; the ledger has not recorded the receipt yet (review I1) */
  state: "queued" | "applying" | "succeeded" | "failed";
  /** queued past its expiry: the runner never answered */
  expired: boolean;
  forCurrentHash: boolean;
  requestedAt: string;
  completedAt: string | null;
  code: string | null;
  checks: Array<{ checkId: string; result: string }>;
  /** producer/consumer ids are left out for callers who cannot read them (re-review m1) */
  contractChecks: Array<{ contractId: string; result: string; producerResource?: string; consumerResource?: string }>;
  mergeOutcome: Array<{ resourceId: string; result: string; conflictPaths?: string[] }>;
  conflictPaths: string[];
  signedEvidence: boolean;
  jobId?: string;
  detail?: string;
  evidenceId?: string;
}

export async function latestIntegrationAttempt(svc: Services, orgId: string, proposalId: string, currentHash: string, canonical: boolean): Promise<IntegrationAttemptView | null> {
  const row = await latestAttemptRow(svc, orgId, proposalId);
  if (!row) return null;
  const job = (JSON.parse(row.signed_json) as { job: { proposalHash?: string } }).job;
  const result = row.result_json ? (JSON.parse(row.result_json) as { ok: boolean; code?: string; detail?: string; evidence?: ValidationEvidence; receipt?: IntegrationReceipt }) : null;
  const evidence = result ? (result.ok ? result.receipt?.evidence : result.evidence) : undefined;
  const mergeOutcome = (evidence?.mergeOutcome ?? []).map((m) => ({ resourceId: m.resourceId as string, result: m.result, ...(m.conflictPaths ? { conflictPaths: m.conflictPaths as string[] } : {}) }));
  const pending = row.status === "succeeded" ? receiptPending(svc, row, (await svc.ledger(orgId).getIntegrationReceipt(proposalId))?.jobId) : null;
  return {
    state: pending === "applying" ? "applying" : pending === "not_recorded" ? "failed" : row.status,
    expired: row.status === "queued" && row.expires_at < svc.now().getTime(),
    forCurrentHash: job.proposalHash === currentHash,
    requestedAt: new Date(row.issued_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    code: pending === "not_recorded" ? "receipt_not_recorded" : result && !result.ok ? (result.code ?? null) : null,
    checks: (evidence?.checks ?? []).map((c) => ({ checkId: c.checkId as string, result: c.result })),
    contractChecks: (evidence?.contractChecks ?? []).map((c) => ({ contractId: c.contractId as string, result: c.result, producerResource: c.producerResource as string, consumerResource: c.consumerResource as string })),
    mergeOutcome,
    conflictPaths: mergeOutcome.flatMap((m) => m.conflictPaths ?? []).slice(0, 200),
    signedEvidence: !!evidence,
    ...(canonical
      ? {
          jobId: row.job_id,
          ...(pending === "not_recorded" ? { detail: "the runner reported success, but the integration receipt was never recorded in the ledger; validate again" } : result && !result.ok && result.detail ? { detail: result.detail.slice(0, 4000) } : {}),
          ...(evidence ? { evidenceId: evidence.evidenceId as string } : {}),
        }
      : {}),
  };
}

/**
 * The `AcceptInput` for a proposal: expected heads are the bases the reviewers saw; new heads are
 * the integration commits (when the integrate run of *this* proposal hash produced them) or the
 * fast-forward candidate revisions; approvals are filtered by current authorization.
 *
 * One expected head and one new head per resource (a promotion proposal has several changes on one
 * resource): the new head is the integration result, the prepared receipt that of the resource's
 * last candidate. A promotion proposal is accepted only on its own integration result (P2-2): its
 * changes name the main head as their base, so a single staging-based candidate would otherwise
 * pass the ledger's fast-forward rule and carry other landings into `main`.
 */
export async function acceptInputFor(svc: Services, p: ProposalRecord, idempotencyKey: string, actor: PrincipalRef): Promise<AcceptInput> {
  const ledger = svc.ledger(p.organizationId);
  const promotion = (await getProposalIndex(svc, p.organizationId, p.proposalId))?.kind === "promotion";
  const integ = await latestIntegration(svc, p.organizationId, p.proposalId);
  const integration = integ && integ.receipt.evidence.proposalHash === p.proposalHash ? integ.receipt : null;
  if (promotion && !integration) throw conflict("integration_required", "a promotion is accepted only on its own integration result for the current proposal hash");
  const expectedHeads: AcceptInput["expectedHeads"] = [];
  const newHeads: AcceptInput["newHeads"] = [];
  const receiptFor = (resourceId: string) => p.preparedReceipts.filter((r) => r.resourceId === resourceId).map((r) => r.receiptId);
  const byResource = new Map<string, ResourceChange[]>();
  for (const c of p.resourceChanges) byResource.set(c.resourceId, [...(byResource.get(c.resourceId) ?? []), c]);
  for (const [resourceId, changes] of byResource) {
    const result = integration?.results.find((r) => r.resourceId === resourceId);
    if (!result && (promotion || changes.length > 1)) throw conflict("integration_required", `resource ${resourceId} has no integration result for the current proposal hash`);
    const receipts = receiptFor(resourceId);
    const last = changes[changes.length - 1]!;
    const rec = await ledger.getCandidate(last.candidateId);
    const preparedReceiptId = rec?.preparedReceiptId && receipts.includes(rec.preparedReceiptId) ? rec.preparedReceiptId : receipts[0];
    if (!preparedReceiptId) throw conflict("proposal_not_prepared", `candidate ${last.candidateId} is not prepared yet`);
    expectedHeads.push({ resourceId: last.resourceId, revisionId: result?.expectedHead ?? changes[0]!.baseRevision });
    newHeads.push({ resourceId: last.resourceId, revisionId: result?.revisionId ?? last.candidateRevision, preparedReceiptId: preparedReceiptId as never });
  }
  for (const a of p.assetManifestChanges) {
    const receiptId = receiptFor(a.resourceId)[0];
    if (!receiptId) throw conflict("proposal_not_prepared", `asset change for ${a.resourceId} is not prepared`);
    expectedHeads.push({ resourceId: a.resourceId, revisionId: r2mRevisionId(a.baseManifestId!) });
    newHeads.push({ resourceId: a.resourceId, revisionId: r2mRevisionId(a.newManifestId), preparedReceiptId: receiptId as never });
  }
  const approvals = await currentApprovals(svc, p.organizationId, p.projectId, await ledger.listApprovals(p.proposalId), p);
  return {
    proposalId: p.proposalId,
    proposalHash: p.proposalHash,
    idempotencyKey,
    expectedHeads,
    newHeads,
    readDependencies: p.readDependencies,
    approvals,
    policyRevision: p.policyRevision,
    evidence: integration ? [integration.evidence] : [],
    actor,
  };
}

/**
 * What follows an accepted proposal (the accept route, and a file change accepting itself):
 * - the candidates are marked accepted and `proposal.accepted` is recorded (not on a replay);
 * - LFS objects are promoted (spec 2026-10-07 §7): a file change's proposal promotes the objects
 *   its runner receipt named and the change becomes `added` (event `files.change_added`); any other
 *   proposal promotes its task's verified objects in the changed resources, and through
 *   `lfs_task_promotions` also the ones the hash step verifies later.
 * Promotion is idempotent and runs on a replay too, so a retried accept repairs an interrupted one.
 */
export async function afterProposalAccepted(
  svc: Services,
  a: { orgId: string; p: ProposalRecord; projectId: string; userId: string; acceptedVersionId: string; replayed: boolean },
): Promise<void> {
  const { orgId, p } = a;
  const ledger = svc.ledger(orgId);
  if (!a.replayed) {
    for (const rc of p.resourceChanges) {
      const rec = await ledger.getCandidate(rc.candidateId);
      if (rec && rec.state === "prepared") await ledger.putCandidate(orgId, { ...rec, state: "accepted", updatedAt: svc.nowIso() });
    }
    await recordEvent(svc, { orgId, projectId: a.projectId, actor: userRef(a.userId), action: "proposal.accepted", subjectKind: "proposal", subjectId: p.proposalId, resourceIds: proposalResourceIds(p), detail: { acceptedVersionId: a.acceptedVersionId, proposalHash: p.proposalHash }, clientVisible: true });
  }
  if (await landAcceptedFileChange(svc, { orgId, proposalId: p.proposalId, userId: a.userId, acceptedVersionId: a.acceptedVersionId })) return;
  const idx = await getProposalIndex(svc, orgId, p.proposalId);
  if (idx?.task_id) await promoteTask(svc, orgId, idx.task_id, proposalResourceIds(p));
}

/**
 * The landing tail of a file change whose proposal is accepted: promote the LFS objects its runner
 * receipt named (a file collection's change instead drops its staged uploads), then `added` (event `files.change_added`, once). Idempotent, and needs nothing from
 * the accept itself, so it also repairs a change whose accept committed but whose landing was
 * interrupted (`files.accept`'s retry, the read sweep). False when no file change has this proposal.
 */
export async function landAcceptedFileChange(svc: Services, a: { orgId: string; proposalId: string; userId?: string; acceptedVersionId?: string }): Promise<boolean> {
  const fc = await svc.db
    .prepare("SELECT f.change_id, f.attempt, f.resource_id, f.project_id, f.receipt_json, r.provider FROM file_changes f LEFT JOIN resources r ON r.org_id = f.org_id AND r.resource_id = f.resource_id WHERE f.org_id = ? AND f.proposal_id = ?")
    .bind(a.orgId, a.proposalId)
    .first<{ change_id: string; attempt: number; resource_id: string; project_id: string; receipt_json: string | null; provider: string | null }>();
  if (!fc) return false;
  const receipt = fc.receipt_json ? (JSON.parse(fc.receipt_json) as { lfsObjects?: Array<{ stagingId: string }> }) : null;
  if (fc.provider === "r2-assets") {
    // a file collection's uploads were copied to their content keys (plan phase 3, P3-3): the staged
    // LFS rows and keys are referenced by nothing now, unless another open change still names them
    await dropChangeUploads(svc, a.orgId, fc.change_id);
  } else await promoteObjects(svc, a.orgId, (receipt?.lfsObjects ?? []).map((o) => o.stagingId));
  const r = await svc.db
    .prepare("UPDATE file_changes SET state = 'added', updated_at = ? WHERE change_id = ? AND attempt = ? AND proposal_id = ? AND state IN ('applying', 'checking', 'waiting_approval')")
    .bind(svc.nowIso(), fc.change_id, fc.attempt, a.proposalId)
    .run();
  if ((r.meta.changes ?? 0) === 0) return true;
  await recordEvent(svc, {
    orgId: a.orgId,
    projectId: fc.project_id,
    actor: a.userId ? userRef(a.userId) : ({ kind: "service", id: "worker" } as PrincipalRef),
    action: "files.change_added",
    subjectKind: "file_change",
    subjectId: fc.change_id,
    resourceIds: [fc.resource_id],
    detail: { changeId: fc.change_id, attempt: fc.attempt, proposalId: a.proposalId, ...(a.acceptedVersionId ? { acceptedVersionId: a.acceptedVersionId } : {}), objects: receipt?.lfsObjects?.length ?? 0 },
  });
  return true;
}

/** `integrate` results nobody waits for: record the (already HMAC-verified) receipt in the ledger. */
onRunnerResult("integrate", async (svc, row: RunnerJobRow, job, result) => {
  if (job.kind !== "integrate") return;
  const idx = await getProposalIndex(svc, row.org_id, job.proposalId);
  // assets-only jobs have no targets: their asset changes name the resources (event visibility)
  const resourceIds = [...job.targets.map((t) => t.resourceId as string), ...(job.assetChanges ?? []).map((a) => a.resourceId as string)];
  if (!result.ok) {
    await recordEvent(svc, { orgId: row.org_id, projectId: idx?.project_id ?? null, actor: { kind: "runner", id: "integration-runner" } as PrincipalRef, action: "proposal.integration_failed", subjectKind: "proposal", subjectId: job.proposalId, resourceIds, detail: { jobId: row.job_id, code: result.code, detail: result.detail.slice(0, 1000) }, clientVisible: true, clientDetail: { code: result.code, conflictPaths: (result.evidence?.mergeOutcome ?? []).flatMap((m) => m.conflictPaths ?? []).slice(0, 200) } });
    await landFileChange(svc, row.org_id, job.proposalId, { integrationOk: false, code: result.code, detail: result.detail.slice(0, 1000) });
    return;
  }
  // re-review R3: an older job finishing after a newer one was issued never overwrites the newer state
  const latest = await latestAttemptRow(svc, row.org_id, job.proposalId);
  if (latest && latest.job_id !== row.job_id && latest.issued_at >= row.issued_at) {
    await markSuperseded(svc, row, job.proposalId, idx?.project_id ?? null, resourceIds, `a newer integration (${latest.job_id}) was requested for this proposal`);
    return;
  }
  const receipt = result.receipt as IntegrationReceipt;
  // the receipt must answer this job: same proposal, same ref, targets and expected heads
  const targets = new Map(job.targets.map((t) => [t.resourceId as string, t.expectedHead as string]));
  // evidence must be for the proposal's candidate snapshot (the ledger checks it again at accept)
  const proposal = await svc.ledger(row.org_id).getProposal(job.proposalId);
  const sane =
    !!proposal &&
    receipt.proposalId === job.proposalId &&
    receipt.evidence.proposalHash === job.proposalHash &&
    receipt.evidence.snapshotId === proposal.candidateSnapshotId &&
    receipt.results.every((r) => targets.get(r.resourceId) === r.expectedHead && r.integrationRef === job.integrationRef);
  if (!sane) {
    // review I1: a receipt the control plane refuses is a failed run, never a silent "succeeded"
    await svc.db
      .prepare("UPDATE runner_jobs SET status = 'failed', result_json = ? WHERE job_id = ? AND status = 'succeeded'")
      .bind(JSON.stringify({ jobId: row.job_id, ok: false, code: "integration_rejected", detail: "the control plane refused the integration receipt (proposal, refs, expected heads or evidence snapshot differ from the job)" }), row.job_id)
      .run();
    await recordEvent(svc, { orgId: row.org_id, projectId: idx?.project_id ?? null, actor: { kind: "runner", id: "integration-runner" } as PrincipalRef, action: "proposal.integration_rejected", subjectKind: "proposal", subjectId: job.proposalId, resourceIds, detail: { jobId: row.job_id } });
    // a refused receipt is a failed run: a landing file change would otherwise wait in `checking` forever
    await landFileChange(svc, row.org_id, job.proposalId, { integrationOk: false, code: "integration_rejected", detail: "the control plane refused the integration receipt" });
    return;
  }
  try {
    await svc.ledger(row.org_id).recordIntegrationReceipt(row.org_id, receipt);
  } catch (e) {
    // the proposal was accepted or closed meanwhile (its receipts are frozen): nothing to apply.
    // Anything else is rethrown (review I1): the result POST fails, the runner retries, and the
    // replay re-applies (runner-jobs.ts) until the ledger has the receipt.
    const msg = e instanceof Error ? e.message : String(e);
    // R3: likewise a receipt older than the recorded one. Both are terminal: the job is marked
    // superseded (so it is never "applying"), and the runner's retry is a plain replay.
    if (/^ledger_conflict: .*(receipts are frozen|is older than the recorded)/.test(msg)) {
      console.warn(`integration receipt not recorded: ${msg}`);
      await markSuperseded(svc, row, job.proposalId, idx?.project_id ?? null, resourceIds, msg.slice(0, 500));
      return;
    }
    throw e;
  }
  if (!(await integratedEventRecorded(svc, row.org_id, job.proposalId, row.job_id))) {
    await recordEvent(svc, { orgId: row.org_id, projectId: idx?.project_id ?? null, actor: { kind: "runner", id: "integration-runner" } as PrincipalRef, action: "proposal.integrated", subjectKind: "proposal", subjectId: job.proposalId, resourceIds, detail: { jobId: row.job_id, checks: receipt.evidence.checks.map((c) => ({ checkId: c.checkId, result: c.result })) }, clientVisible: true, clientDetail: { checks: receipt.evidence.checks.map((c) => ({ checkId: c.checkId, result: c.result })) } });
  }
  // also on a replay (the event was recorded before): the step is a no-op once the change moved on
  await landFileChange(svc, row.org_id, job.proposalId, { integrationOk: true });
});

/** A file change landing through this proposal (state `checking`) continues with `files.accept`. */
async function landFileChange(svc: Services, orgId: string, proposalId: string, outcome: { integrationOk: boolean; code?: string; detail?: string }): Promise<void> {
  const fc = await svc.db.prepare("SELECT change_id FROM file_changes WHERE org_id = ? AND proposal_id = ? AND state = 'checking'").bind(orgId, proposalId).first<{ change_id: string }>();
  if (fc) await enqueueStep(svc, { type: "files.accept", orgId, changeId: fc.change_id, ...outcome });
}

async function markSuperseded(svc: Services, row: RunnerJobRow, proposalId: string, projectId: string | null, resourceIds: string[], why: string): Promise<void> {
  await svc.db
    .prepare("UPDATE runner_jobs SET status = 'failed', result_json = ? WHERE job_id = ? AND status = 'succeeded'")
    .bind(JSON.stringify({ jobId: row.job_id, ok: false, code: SUPERSEDED_CODE, detail: why }), row.job_id)
    .run();
  await recordEvent(svc, { orgId: row.org_id, projectId, actor: { kind: "runner", id: "integration-runner" } as PrincipalRef, action: "proposal.integration_superseded", subjectKind: "proposal", subjectId: proposalId, resourceIds, detail: { jobId: row.job_id, reason: why } });
}

async function integratedEventRecorded(svc: Services, orgId: string, proposalId: string, jobId: string): Promise<boolean> {
  const r = await svc.db
    .prepare("SELECT 1 AS x FROM events WHERE org_id = ? AND action = 'proposal.integrated' AND subject_id = ? AND detail_json LIKE ? LIMIT 1")
    .bind(orgId, proposalId, `%"jobId":"${jobId}"%`)
    .first<{ x: number }>();
  return !!r;
}
