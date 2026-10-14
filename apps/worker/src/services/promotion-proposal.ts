/**
 * The promotion proposal (staging phase 2, R2): one proposal per promotion, built from the current
 * `main` heads plus every candidate of the promotion set (all parts of all landings, in order).
 *
 * - Each resource change names the **main head** as its `baseRevision` (accept checks the heads);
 *   the candidate's own (staging) base travels in `mergeBases`, so the promotion build applies only
 *   the candidate's own edits (runner `integrate` with explicit merge bases, R3).
 * - The candidates were prepared when they landed; the proposal is `prepared` at once.
 * - The id is derived from the promotion and the base snapshot: a rebuild while `main` has not
 *   moved is the same proposal (reused as recorded, approvals stay valid); after `main` moved it is
 *   a new proposal, and the previous one is superseded (`supersedes`). A proposal for this base
 *   that is already closed (heads restored to an earlier base) is never reused: the next rebuild
 *   number on that base gives a fresh id.
 * - It is accepted only by the promotion service: the accept and approvals routes refuse it, and
 *   `acceptInputFor` takes its new heads only from its own integration result (never a fast-forward
 *   to a staging-based candidate).
 */
import {
  ChangeIdSchema,
  ProposalRecordSchema,
  artRevisionId,
  computeProposalHash,
  computeSnapshotId,
  revisionCommitSha,
  sha256Hex,
  type CandidateRecord,
  type ProjectSnapshot,
  type ProposalRecord,
  type ReadDependency,
  type ResourceChange,
} from "@commonforge-org/core";
import type { Services } from "../context.js";
import { conflict } from "../lib/http.js";
import { getResource, resourceCoords, type ProjectRow } from "./directory.js";
import { recordEvent, userRef } from "./events.js";
import { getProposalIndex, proposalResourceIds, withPolicyReferences, type BuiltProposal } from "./proposals.js";
import { projectSnapshot } from "./snapshot.js";

/** One part of a landing in the set: its staging proposal and the hash the promotion recorded for it. */
export interface PromotionPart {
  proposalId: string;
  proposalHash: string;
}

export interface PromotionProposalInput {
  project: ProjectRow;
  promotionId: string;
  /** every part of every landing in the set, in landing then part order */
  parts: PromotionPart[];
  /** the promotion's requester (`proposals_index.created_by`, event actor) */
  requestedBy: string;
  /** the promotion's previous proposal (a rebuild after `main` moved): superseded once the new one is recorded */
  supersedes?: string | null;
}

export interface BuiltPromotionProposal extends BuiltProposal {
  proposalId: string;
  /** candidateId → the candidate's own base commit (its staging base); the promotion build's merge bases */
  mergeBases: Record<string, string>;
}

/** The stable change id of a promotion's proposals (every rebuild of one promotion is the same change). */
export const promotionChangeId = (promotionId: string) => ChangeIdSchema.parse(`chg-pro-${promotionId}`);

/**
 * Build **and record** the promotion proposal (ledger record + `proposals_index` row with
 * `kind = 'promotion'`, `promotion_id`, no task). Idempotent: an existing record with the same id
 * and the same content is returned unchanged.
 */
export async function buildPromotionProposal(svc: Services, input: PromotionProposalInput): Promise<BuiltPromotionProposal> {
  const { project, promotionId } = input;
  const orgId = project.org_id;
  const ledger = svc.ledger(orgId);
  const changeId = promotionChangeId(promotionId);
  const candidates: CandidateRecord[] = [];
  for (const part of input.parts) {
    const lp = await ledger.getProposal(part.proposalId);
    if (!lp || lp.projectId !== project.project_id) throw conflict("promotion_part_missing", `landing proposal ${part.proposalId} not found`);
    if (lp.proposalHash !== part.proposalHash) throw conflict("promotion_part_changed", `landing proposal ${part.proposalId} changed since the promotion was requested`);
    for (const rc of lp.resourceChanges) {
      const rec = await ledger.getCandidate(rc.candidateId);
      if (!rec || rec.state !== "prepared" || !rec.preparedReceiptId) throw conflict("promotion_candidate_not_prepared", `candidate ${rc.candidateId} is ${rec?.state ?? "missing"}, not prepared`);
      candidates.push(rec);
    }
  }
  if (candidates.length === 0) throw conflict("nothing_to_promote", "the promotion set has no git changes");

  // main heads (never staging), plus the policy's reference mounts exactly as buildProposal does
  const base = await withPolicyReferences(svc, project, await projectSnapshot(svc, project));
  const heads = new Map(base.entries.map((e) => [e.resourceId as string, e.revisionId as string]));
  const resourceChanges: ResourceChange[] = [];
  const mergeBases: Record<string, string> = {};
  const newRevision = new Map<string, string>();
  for (const c of candidates) {
    const rid = c.candidate.resourceId as string;
    const head = heads.get(rid);
    if (!head) throw conflict("resource_not_ready", `resource ${rid} is not a mount of the project or has no accepted head`);
    const r = await getResource(svc.db, orgId, rid);
    const coords = r ? resourceCoords(r) : null;
    if (!coords || coords.kind !== "artifacts") throw conflict("resource_not_ready", `resource ${rid} has no canonical repository`);
    const mergeBase = revisionCommitSha(c.candidate.baseRevision);
    if (!mergeBase) throw conflict("promotion_base_unsupported", `candidate ${c.candidate.candidateId} has no git base`);
    const candidateRevision = artRevisionId(coords.repoId, c.candidate.sha);
    resourceChanges.push({ resourceId: c.candidate.resourceId, baseRevision: head as ResourceChange["baseRevision"], candidateId: c.candidate.candidateId, candidateRevision });
    mergeBases[c.candidate.candidateId] = mergeBase;
    newRevision.set(rid, candidateRevision); // the last candidate of a resource wins
  }
  const readDependencies: ReadDependency[] = base.entries.filter((e) => !newRevision.has(e.resourceId)).map((e) => ({ resourceId: e.resourceId, revisionId: e.revisionId, mode: e.mode }));
  const candEntries = base.entries.map((e) => (newRevision.has(e.resourceId) ? { ...e, revisionId: newRevision.get(e.resourceId)! as typeof e.revisionId } : e));
  const snapBody = { projectId: base.projectId, organizationId: base.organizationId, membershipRevision: base.membershipRevision, policyRevision: base.policyRevision, entries: candEntries };
  const now = svc.nowIso();
  const candidateSnapshot = { ...snapBody, snapshotId: await computeSnapshotId(snapBody), createdAt: now } as ProjectSnapshot;
  const hashInput = { baseSnapshotId: base.snapshotId, candidateSnapshotId: candidateSnapshot.snapshotId, resourceChanges, readDependencies, assetManifestChanges: [], policyRevision: project.policy_revision };
  const proposalHash = await computeProposalHash(hashInput);
  const preparedReceipts = candidates.map((c) => ({ resourceId: c.candidate.resourceId, receiptId: c.preparedReceiptId! }));

  // the first id of this promotion on this base that is not closed (a restore can move the heads
  // back to a base whose proposal was superseded or accepted: that one is never reused)
  let proposalId = "";
  let existing: ProposalRecord | null = null;
  for (let n = 0; ; n++) {
    if (n >= MAX_REBUILDS_PER_BASE) throw conflict("promotion_rebuild_limit", `promotion ${promotionId} was rebuilt on this base too often`);
    proposalId = await promotionProposalId(promotionId, base.snapshotId, n);
    existing = await ledger.getProposal(proposalId);
    if (!existing || existing.state === "open" || existing.state === "prepared") break;
  }
  const idx = await getProposalIndex(svc, orgId, proposalId);
  if (existing && existing.proposalHash === proposalHash && idx) {
    // the same promotion on the same main: reuse the recorded proposal (its createdAt/updatedAt are immutable inputs of approvals)
    await supersede(svc, input, proposalId);
    return { proposalId, record: existing, baseSnapshot: JSON.parse(idx.base_snapshot_json) as ProjectSnapshot, candidateSnapshot: JSON.parse(idx.candidate_snapshot_json) as ProjectSnapshot, mergeBases };
  }
  let record: ProposalRecord = ProposalRecordSchema.parse({
    proposalId,
    proposalHash,
    organizationId: orgId,
    projectId: project.project_id,
    changeId,
    ...hashInput,
    state: "prepared",
    preparedReceipts,
    // a rewrite (the parts' content differs from an earlier build with the same id) keeps the
    // record's creation time and must advance updatedAt (the ledger refuses hashed changes otherwise)
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing && existing.updatedAt >= now ? new Date(Date.parse(existing.updatedAt) + 1).toISOString() : now,
  });
  if (!existing || existing.proposalHash !== proposalHash) record = await ledger.putProposal(record);
  else record = existing;
  const indexed = await svc.db
    .prepare("INSERT OR IGNORE INTO proposals_index (proposal_id, org_id, project_id, task_id, base_snapshot_json, candidate_snapshot_json, created_by, created_at, kind, promotion_id) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'promotion', ?)")
    .bind(proposalId, orgId, project.project_id, JSON.stringify(base), JSON.stringify(candidateSnapshot), input.requestedBy, now, promotionId)
    .run();
  if ((indexed.meta.changes ?? 0) === 0) {
    await svc.db.prepare("UPDATE proposals_index SET base_snapshot_json = ?, candidate_snapshot_json = ? WHERE org_id = ? AND proposal_id = ?").bind(JSON.stringify(base), JSON.stringify(candidateSnapshot), orgId, proposalId).run();
  } else {
    await recordEvent(svc, {
      orgId,
      projectId: project.project_id,
      actor: userRef(input.requestedBy),
      action: "proposal.created",
      subjectKind: "proposal",
      subjectId: proposalId,
      resourceIds: proposalResourceIds(record),
      detail: { proposalHash: record.proposalHash, changeId, promotionId },
    });
  }
  await supersede(svc, input, proposalId);
  return { proposalId, record, baseSnapshot: base, candidateSnapshot, mergeBases };
}

/** Rebuilds of one promotion on one base whose earlier proposal was closed (a guard, never reached in practice). */
const MAX_REBUILDS_PER_BASE = 20;

/** `prop-pro-<32 hex>` from the promotion, the base snapshot and the rebuild number on that base (0 first). */
async function promotionProposalId(promotionId: string, baseSnapshotId: string, n: number): Promise<string> {
  return `prop-pro-${(await sha256Hex(`cf.promotion-proposal/1|${promotionId}|${baseSnapshotId}${n > 0 ? `|${n}` : ""}`)).slice(0, 32)}`;
}

async function supersede(svc: Services, input: PromotionProposalInput, current: string): Promise<void> {
  if (input.supersedes && input.supersedes !== current) await supersedePromotionProposal(svc, input.project.org_id, input.supersedes);
}

/**
 * Close a promotion's earlier proposal (`prepared`/`open` → `superseded`; hashed content and
 * `updatedAt` unchanged). Only promotion proposals; a closed one is left as it is. Returns whether
 * it changed anything.
 */
export async function supersedePromotionProposal(svc: Services, orgId: string, proposalId: string): Promise<boolean> {
  const idx = await getProposalIndex(svc, orgId, proposalId);
  if (!idx || idx.kind !== "promotion") return false;
  const ledger = svc.ledger(orgId);
  const p = await ledger.getProposal(proposalId);
  if (!p || (p.state !== "open" && p.state !== "prepared")) return false;
  await ledger.putProposal({ ...p, state: "superseded" });
  await recordEvent(svc, { orgId, projectId: idx.project_id, actor: { kind: "service", id: "promotion-service" } as never, action: "proposal.superseded", subjectKind: "proposal", subjectId: proposalId, resourceIds: proposalResourceIds(p), detail: { promotionId: idx.promotion_id } });
  return true;
}
