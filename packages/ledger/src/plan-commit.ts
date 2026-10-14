/**
 * `planCommit` (plan §B.9): the conditional-acceptance invariants, synchronous and side-effect free
 * over `LedgerTx` reads. The adapter applies `writes` with `applyWrites` in the same transaction
 * (or calls `executeCommit`, which does both).
 *
 * Checks, in order (the first failure is returned, so the order defines which code wins):
 *  1. input structure and `now` — structural errors throw `LedgerInputError` (caller bug, HTTP 400)
 *  2. proposal lookup — unknown → `proposal_not_prepared`; `now < proposal.updatedAt` throws
 *     `LedgerInputError`. The proposal is read first because its organization scopes idempotency keys.
 *  3. idempotency — same key + same request (+ scope `accept`) in the proposal's organization
 *     replays the original acceptedVersionId; same key with anything else → `idempotency_key_conflict`
 *  4. `proposal_not_prepared` — proposal not in state `prepared`
 *  5. `proposal_hash_mismatch` — input hash ≠ recorded hash; recorded content no longer hashes to
 *     its hash; input policyRevision/readDependencies differ from the hashed ones; newHeads /
 *     expectedHeads are not exactly one entry per resource the proposal changes
 *  6. `policy_revision_stale` — project's current policy revision ≠ the proposal's (none recorded = 0)
 *  7. `approval_invalid` — no approvals, or any approval malformed, for another proposal or hash,
 *     approved before the proposal's last mutation (`approvedAt < updatedAt`), or dated after `now`.
 *     *Who* may approve is the consuming app's semantics; it filters approvals before calling.
 *  8. `expected_head_stale` — a resource not bound to the proposal's organization, or whose current
 *     head ≠ expected head (or no head)
 *  9. `dependency_stale` — a `must-match-accepted` read dependency ≠ current head (AT-10);
 *     `pinned-reference` dependencies are never checked
 * 10. `receipt_missing` — every candidate of a changed resource needs a PreparedReceipt recorded on
 *     the proposal and present in the store; the new head must be either the single candidate
 *     revision whose base is the expected head (fast-forward), or a result of the proposal's
 *     integration receipt on top of the expected head *whose own evidence names the current
 *     proposal hash* (a receipt left over from earlier proposal content never qualifies). Asset
 *     changes: the receipt's revision must be `r2m:<newManifestId>` and the base manifest must be
 *     the expected head (else `expected_head_stale`).
 * 11. `evidence_missing` — see `checkEvidence`. The signature is only checked for *presence*:
 *     verifying the runner HMAC needs the job key and WebCrypto (async), so the consuming app
 *     verifies signatures before recording receipts/evidence and before calling `planCommit`.
 */
import {
  AcceptInputSchema,
  ApprovalRefSchema,
  ProposalRecordSchema,
  ValidationEvidenceSchema,
  canonicalJson,
  computeProposalHashSync,
  r2mRevisionId,
  type AcceptInput,
  type AcceptedHead,
  type AcceptedProjectVersion,
  type AssetManifestChange,
  type IsoUtcTimestamp,
  type ProposalRecord,
  type ResourceChange,
  type ResourceId,
  type RevisionId,
  type ValidationEvidence,
} from '@commonforge-org/core';
import { z } from 'zod';
import { applyWrites } from './apply-writes.js';
import { LedgerInputError, refuse, type CommitDecision } from './decision.js';
import {
  auditEvent,
  canonicalSet,
  checkIdempotency,
  checkResourceOrganization,
  nextAcceptedVersion,
  parseNow,
  reconcileRefEvent,
  requestHash,
} from './internal.js';
import type { LedgerTx, LedgerWrite } from './store.js';

/** Request-hash domain tag for accept idempotency records. */
export const ACCEPT_REQUEST_TAG = 'cf.ledger.accept/1';

/** Approvals and evidence are parsed per item so a malformed one refuses instead of throwing. */
const AcceptInputEnvelopeSchema = AcceptInputSchema.extend({
  approvals: z.array(z.unknown()),
  evidence: z.array(z.unknown()),
});
type AcceptEnvelope = z.infer<typeof AcceptInputEnvelopeSchema>;

type ChangeSpec = { kind: 'git'; changes: ResourceChange[] } | { kind: 'asset'; change: AssetManifestChange };

/** sha256 over the canonical accept request (key excluded; set-like arrays order-independent). */
export function acceptRequestHash(input: AcceptEnvelope): string {
  return requestHash(ACCEPT_REQUEST_TAG, {
    proposalId: input.proposalId,
    proposalHash: input.proposalHash,
    expectedHeads: canonicalSet(input.expectedHeads),
    newHeads: canonicalSet(input.newHeads),
    readDependencies: canonicalSet(input.readDependencies),
    approvals: canonicalSet(input.approvals),
    policyRevision: input.policyRevision,
    evidence: canonicalSet(input.evidence),
    actor: input.actor,
  });
}

export function planCommit(tx: LedgerTx, input: AcceptInput, now: string): CommitDecision {
  // 1. structure
  const parsed = AcceptInputEnvelopeSchema.safeParse(input);
  if (!parsed.success) throw new LedgerInputError(`invalid AcceptInput: ${parsed.error.message}`);
  const req = parsed.data;
  const at = parseNow(now);

  // 2. the proposal is read first: its organization scopes the idempotency key
  const stored = tx.getProposal(req.proposalId);
  if (!stored) return refuse('proposal_not_prepared', `proposal ${req.proposalId} is not recorded`);
  const proposalParse = ProposalRecordSchema.safeParse(stored);
  if (!proposalParse.success) throw new Error(`ledger store returned a malformed proposal ${req.proposalId}: ${proposalParse.error.message}`);
  const proposal = proposalParse.data;
  const organizationId = proposal.organizationId;
  if (at < proposal.updatedAt) {
    throw new LedgerInputError(`now (${at}) is earlier than the proposal's last mutation (${proposal.updatedAt})`);
  }

  // 3. idempotency
  const hash = acceptRequestHash(req);
  const replay = checkIdempotency(tx, organizationId, req.idempotencyKey, 'accept', hash);
  if (replay) return replay;

  // 4. proposal state
  if (proposal.state !== 'prepared') {
    return refuse('proposal_not_prepared', `proposal ${req.proposalId} is ${proposal.state}, not prepared`);
  }

  // 5. proposal identity
  const identity = checkProposalIdentity(req, proposal);
  if (!identity.ok) return identity.refusal;
  const { changes, expected, newHeads } = identity;
  const resources = [...changes.keys()].sort();

  // 6. policy
  const currentPolicy = tx.getCurrentPolicyRevision(proposal.projectId) ?? 0;
  if (currentPolicy !== proposal.policyRevision) {
    return refuse('policy_revision_stale', `proposal was made under policy revision ${proposal.policyRevision}; current is ${currentPolicy}`);
  }

  // 7. approvals
  const approvalRefusal = checkApprovals(req, proposal, at);
  if (approvalRefusal) return approvalRefusal;

  // 8. expected heads (and the resource belongs to the proposal's organization)
  const currentHeads = new Map<ResourceId, AcceptedHead>();
  for (const r of resources) {
    const foreign = checkResourceOrganization(tx, r, organizationId);
    if (foreign) return foreign;
    const head = tx.getHead(r);
    const want = expected.get(r)!;
    if (!head) return refuse('expected_head_stale', `resource has no accepted head; expected ${want}`, r);
    if (head.revisionId !== want) return refuse('expected_head_stale', `head is ${head.revisionId}, expected ${want}`, r);
    currentHeads.set(r, head);
  }

  // 9. read dependencies (AT-10)
  for (const dep of [...req.readDependencies].sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0))) {
    if (dep.mode !== 'must-match-accepted') continue;
    const head = tx.getHead(dep.resourceId);
    if (!head || head.revisionId !== dep.revisionId) {
      return refuse('dependency_stale', `must-match-accepted dependency on ${dep.revisionId}; head is ${head?.revisionId ?? 'absent'}`, dep.resourceId);
    }
  }

  // 10. receipts: the new head is a prepared candidate or the recorded integration commit
  const receipts = checkReceipts(tx, proposal, changes, expected, newHeads, resources);
  if (!receipts.ok) return receipts.refusal;

  // 11. evidence
  const evidenceRefusal = checkEvidence(req, proposal, changes, resources, receipts.integrationEvidence);
  if (evidenceRefusal) return evidenceRefusal;

  // ---- plan writes ----
  const { sequence, acceptedVersionId } = nextAcceptedVersion(tx, organizationId);
  const writes: LedgerWrite[] = [];
  const versionHeads: AcceptedProjectVersion['heads'] = [];
  for (const r of resources) {
    const prev = currentHeads.get(r)!;
    const next: AcceptedHead = {
      resourceId: r,
      revisionId: newHeads.get(r)!.revisionId,
      versionSeq: prev.versionSeq + 1,
      acceptedVersionId,
      acceptedAt: at,
      reconciliation: 'pending',
    };
    writes.push({ op: 'setHead', head: next });
    versionHeads.push({ resourceId: r, revisionId: next.revisionId, previousRevisionId: prev.revisionId, versionSeq: next.versionSeq });
  }
  writes.push({ op: 'putProposal', proposal: { ...proposal, state: 'accepted' } });
  writes.push({
    op: 'putAcceptedVersion',
    version: {
      acceptedVersionId,
      organizationId,
      sequence,
      kind: 'accept',
      proposalId: proposal.proposalId,
      proposalHash: proposal.proposalHash,
      heads: versionHeads,
      actor: req.actor,
      acceptedAt: at,
    },
  });
  writes.push({
    op: 'putIdempotency',
    organizationId,
    record: { key: req.idempotencyKey, scope: 'accept', requestHash: hash, acceptedVersionId, createdAt: at },
  });
  for (const h of versionHeads) {
    writes.push({
      op: 'appendOutbox',
      event: reconcileRefEvent(organizationId, h.resourceId, h.revisionId, h.previousRevisionId, acceptedVersionId, at),
    });
  }
  writes.push({
    op: 'appendAudit',
    event: auditEvent({
      organizationId,
      at,
      actor: req.actor,
      action: 'proposal.accepted',
      subject: { kind: 'proposal', id: proposal.proposalId },
      proposalHash: proposal.proposalHash,
      avId: acceptedVersionId,
      detail: { sequence, heads: versionHeads },
    }),
  });
  return { ok: true, acceptedVersionId, writes };
}

/** Plan and, on a fresh acceptance, apply the writes. Call inside one store transaction. */
export function executeCommit(tx: LedgerTx, input: AcceptInput, now: string): CommitDecision {
  const d = planCommit(tx, input, now);
  if (d.ok && !d.replayed) applyWrites(tx, d.writes);
  return d;
}

// ---------------------------------------------------------------------------------------------

type IdentityResult =
  | { ok: false; refusal: CommitDecision }
  | {
      ok: true;
      changes: Map<ResourceId, ChangeSpec>;
      expected: Map<ResourceId, RevisionId>;
      newHeads: Map<ResourceId, AcceptEnvelope['newHeads'][number]>;
    };

function checkProposalIdentity(req: AcceptEnvelope, proposal: ProposalRecord): IdentityResult {
  const mismatch = (detail: string, r?: ResourceId): IdentityResult => ({ ok: false, refusal: refuse('proposal_hash_mismatch', detail, r) });

  if (req.proposalHash !== proposal.proposalHash) return mismatch('input proposalHash differs from the recorded proposal');
  let recomputed: string;
  try {
    recomputed = computeProposalHashSync(proposal);
  } catch {
    recomputed = '';
  }
  if (recomputed !== proposal.proposalHash) return mismatch('recorded proposal content does not match its hash');
  if (req.policyRevision !== proposal.policyRevision) return mismatch('input policyRevision differs from the hashed proposal');

  const inDeps = req.readDependencies.map((d) => canonicalJson(d)).sort();
  const propDeps = proposal.readDependencies.map((d) => canonicalJson(d)).sort();
  if (new Set(inDeps).size !== inDeps.length || canonicalJson(inDeps) !== canonicalJson(propDeps)) {
    return mismatch('input readDependencies differ from the hashed proposal');
  }

  const changes = new Map<ResourceId, ChangeSpec>();
  for (const c of proposal.resourceChanges) {
    const prev = changes.get(c.resourceId);
    if (prev && prev.kind !== 'git') return mismatch('resource has both git and asset changes', c.resourceId);
    if (prev) prev.changes.push(c);
    else changes.set(c.resourceId, { kind: 'git', changes: [c] });
  }
  for (const a of proposal.assetManifestChanges) {
    if (changes.has(a.resourceId)) return mismatch('resource has more than one asset/git change', a.resourceId);
    changes.set(a.resourceId, { kind: 'asset', change: a });
  }
  if (changes.size === 0) return mismatch('proposal changes no resources');

  const expected = new Map<ResourceId, RevisionId>();
  for (const e of req.expectedHeads) {
    if (expected.has(e.resourceId)) return mismatch('duplicate expectedHeads entry', e.resourceId);
    if (!changes.has(e.resourceId)) return mismatch('expectedHeads names a resource the proposal does not change', e.resourceId);
    expected.set(e.resourceId, e.revisionId);
  }
  const newHeads = new Map<ResourceId, AcceptEnvelope['newHeads'][number]>();
  for (const n of req.newHeads) {
    if (newHeads.has(n.resourceId)) return mismatch('duplicate newHeads entry', n.resourceId);
    if (!changes.has(n.resourceId)) return mismatch('newHeads names a resource the proposal does not change', n.resourceId);
    newHeads.set(n.resourceId, n);
  }
  for (const r of [...changes.keys()].sort()) {
    if (!expected.has(r) || !newHeads.has(r)) return mismatch('proposal changes a resource missing from expectedHeads/newHeads', r);
  }
  return { ok: true, changes, expected, newHeads };
}

function checkApprovals(req: AcceptEnvelope, proposal: ProposalRecord, now: IsoUtcTimestamp): CommitDecision | undefined {
  if (req.approvals.length === 0) return refuse('approval_invalid', 'no approvals');
  for (const raw of req.approvals) {
    const r = ApprovalRefSchema.safeParse(raw);
    if (!r.success) return refuse('approval_invalid', 'malformed approval');
    const a = r.data;
    if (a.proposalId !== req.proposalId) return refuse('approval_invalid', `approval ${a.approvalId} is for proposal ${a.proposalId}`);
    if (a.proposalHash !== req.proposalHash) return refuse('approval_invalid', `approval ${a.approvalId} is for a different proposal hash`);
    // both are schema-validated UTC ISO with millisecond precision, so string order is time order
    if (a.approvedAt < proposal.updatedAt) {
      return refuse('approval_invalid', `approval ${a.approvalId} (${a.approvedAt}) predates the proposal's last mutation (${proposal.updatedAt})`);
    }
    if (a.approvedAt > now) return refuse('approval_invalid', `approval ${a.approvalId} is dated in the future (${a.approvedAt} > ${now})`);
  }
  return undefined;
}

type ReceiptResult =
  | { ok: false; refusal: CommitDecision }
  | {
      ok: true;
      /** resources accepted via the integration commit → that receipt's own (signed) evidence */
      integrationEvidence: Map<ResourceId, ValidationEvidence>;
    };

function checkReceipts(
  tx: LedgerTx,
  proposal: ProposalRecord,
  changes: Map<ResourceId, ChangeSpec>,
  expected: Map<ResourceId, RevisionId>,
  newHeads: Map<ResourceId, AcceptEnvelope['newHeads'][number]>,
  resources: ResourceId[],
): ReceiptResult {
  const no = (detail: string, r: ResourceId, code: 'receipt_missing' | 'expected_head_stale' = 'receipt_missing'): ReceiptResult => ({
    ok: false,
    refusal: refuse(code, detail, r),
  });
  const recorded = (r: ResourceId) => proposal.preparedReceipts.filter((p) => p.resourceId === r).map((p) => p.receiptId);
  let integration: ReturnType<LedgerTx['getIntegrationReceipt']> | undefined;
  const integrationReceipt = () => {
    if (integration === undefined) integration = tx.getIntegrationReceipt(proposal.proposalId);
    return integration && integration.proposalId === proposal.proposalId ? integration : null;
  };
  const integrationEvidence = new Map<ResourceId, ValidationEvidence>();

  for (const r of resources) {
    const spec = changes.get(r)!;
    const want = expected.get(r)!;
    const nh = newHeads.get(r)!;
    const ids = recorded(r);
    if (!ids.includes(nh.preparedReceiptId)) return no(`receipt ${nh.preparedReceiptId} is not recorded on the proposal`, r);
    const receipts = ids.map((id) => tx.getPreparedReceipt(id)).filter((x) => x !== null && x.resourceId === r);
    const named = receipts.find((x) => x!.receiptId === nh.preparedReceiptId);
    if (!named) return no(`receipt ${nh.preparedReceiptId} is not in the ledger`, r);

    if (spec.kind === 'asset') {
      const target = r2mRevisionId(spec.change.newManifestId);
      if (named.revisionId !== target || nh.revisionId !== target) return no('asset receipt/new head do not match the proposal manifest', r);
      if (spec.change.baseManifestId === null || r2mRevisionId(spec.change.baseManifestId) !== want) {
        return no('asset change base manifest is not the expected head (bind asset resources with planBindHead first)', r, 'expected_head_stale');
      }
      continue;
    }

    for (const c of spec.changes) {
      const ok = receipts.some((x) => x!.candidateId === c.candidateId && x!.revisionId === c.candidateRevision);
      if (!ok) return no(`candidate ${c.candidateId} has no prepared receipt`, r);
    }
    const only = spec.changes.length === 1 ? spec.changes[0]! : undefined;
    const fastForward = only !== undefined && nh.revisionId === only.candidateRevision && only.baseRevision === want;
    if (fastForward) continue;

    // Integration path: the commit must come from an integrate run of *this* proposal content
    // (receipt evidence names the current hash) on top of the expected head.
    const ir = integrationReceipt();
    const result = ir?.results.find((x) => x.resourceId === r && x.revisionId === nh.revisionId && x.expectedHead === want);
    if (!ir || !result) return no(`new head ${nh.revisionId} is neither a fast-forward candidate nor an integration commit on ${want}`, r);
    if (ir.evidence.proposalHash !== proposal.proposalHash) {
      return no(`integration receipt ${ir.jobId} was produced for a different proposal hash`, r);
    }
    integrationEvidence.set(r, ir.evidence);
  }
  return { ok: true, integrationEvidence };
}

/**
 * Evidence rules (M5/I-1):
 * - Input items that do not parse (incl. missing signature) or name another proposal hash are ignored.
 * - Every *relevant* item (this proposal hash, plus the integration receipts' own evidence) must be
 *   for the proposal's candidate snapshot and fully passing: every required check passed, no failed contract
 *   check, no non-clean merge outcome. One failing item refuses even if another item passes.
 * - A resource accepted via an integration commit is judged by that receipt's evidence (it must
 *   report a clean merge for the resource); other git resources need a clean merge outcome in
 *   some relevant input item.
 * - Asset changes need no merge outcome. An assets-only proposal (follow-up Task 23) is accepted on
 *   the evidence of an integrate run with no git targets (`mergeOutcome: []`): it still needs one
 *   relevant item, i.e. signed evidence for this hash (which covers `assetManifestChanges`) and the
 *   candidate snapshot, with its checks and contracts passing.
 * A required check must `pass`: `fail` and `skipped` both refuse. A check with `required: false`
 * is recorded but never refuses (absent `required` means required, so evidence from runners that
 * predate the flag keeps refusing on any failure). Whether `required` matches the policy is the
 * verifier's job (runner-protocol `parseRunnerResultForJob` binds it to the signed job).
 */
function checkEvidence(
  req: AcceptEnvelope,
  proposal: ProposalRecord,
  changes: Map<ResourceId, ChangeSpec>,
  resources: ResourceId[],
  integrationEvidence: Map<ResourceId, ValidationEvidence>,
): CommitDecision | undefined {
  const fromInput: ValidationEvidence[] = [];
  for (const raw of req.evidence) {
    const r = ValidationEvidenceSchema.safeParse(raw);
    if (r.success && r.data.proposalHash === req.proposalHash) fromInput.push(r.data);
  }
  const relevant = [...fromInput, ...integrationEvidence.values()];
  if (relevant.length === 0) return refuse('evidence_missing', 'no signed validation evidence for this proposal hash');
  for (const e of relevant) {
    if (e.snapshotId !== proposal.candidateSnapshotId) {
      return refuse('evidence_missing', `evidence ${e.evidenceId} is for snapshot ${e.snapshotId}, not the proposal's candidate snapshot`);
    }
    const unmet = e.checks.find((c) => c.result !== 'pass' && c.required !== false);
    if (unmet) return refuse('evidence_missing', `evidence ${e.evidenceId} has a ${unmet.result === 'fail' ? 'failed' : 'skipped'} required check ${unmet.checkId}`);
    if (e.contractChecks.some((c) => c.result === 'fail')) return refuse('evidence_missing', `evidence ${e.evidenceId} has a failed contract check`);
    const bad = e.mergeOutcome.find((m) => m.result !== 'clean');
    if (bad) return refuse('evidence_missing', `evidence ${e.evidenceId} reports a ${bad.result} merge`, bad.resourceId);
  }
  for (const r of resources) {
    if (changes.get(r)!.kind !== 'git') continue;
    const pool = integrationEvidence.has(r) ? [integrationEvidence.get(r)!] : fromInput;
    if (!pool.some((e) => e.mergeOutcome.some((m) => m.resourceId === r && m.result === 'clean'))) {
      return refuse('evidence_missing', 'no evidence of a clean merge for this resource', r);
    }
  }
  return undefined;
}
