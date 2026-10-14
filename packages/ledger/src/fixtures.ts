/**
 * Deterministic fixture builders for ledger tests and the conformance scenarios.
 * Every value is built with core's typed constructors/schemas, so fixtures are valid wire data and
 * proposal hashes are real.
 */
import {
  AcceptInputSchema,
  ProposalRecordSchema,
  artRevisionId,
  candidateId,
  candidateRetentionRef,
  computeProposalHashSync,
  r2mRevisionId,
  sha256HexSync,
  type AcceptInput,
  type DependencyMode,
  type PrincipalRef,
  type ProposalRecord,
  type RevisionId,
} from '@commonforge-org/core';
import type { LedgerSeed } from './seed.js';

export const FIXTURE_ORG = 'org-1';
export const FIXTURE_PROJECT = 'proj-1';

/** Fixed timestamps: created < updated < prepared < approved < now. */
export const FIXTURE_TIME = {
  created: '2026-10-06T10:00:00.000Z',
  updated: '2026-10-06T11:00:00.000Z',
  prepared: '2026-10-06T11:30:00.000Z',
  approved: '2026-10-06T12:00:00.000Z',
  now: '2026-10-06T13:00:00.000Z',
  later: '2026-10-06T14:00:00.000Z',
} as const;

export const FIXTURE_ACTOR: PrincipalRef = { kind: 'service', id: 'svc-accept' };
export const FIXTURE_APPROVER: PrincipalRef = { kind: 'user', id: 'owner-1' };

/** A full 40-hex git sha derived from a label. */
export function fixtureSha(label: string): string {
  return sha256HexSync(`sha:${label}`).slice(0, 40);
}

/** An Artifacts revision of the resource's canonical repo derived from a label. */
export function fixtureRev(resourceId: string, label: string): RevisionId {
  return artRevisionId(`repo-${resourceId}`, fixtureSha(`${resourceId}:${label}`));
}

/** Base (seeded head) revision of a resource. */
export const baseRev = (resourceId: string): RevisionId => fixtureRev(resourceId, 'base');

/** Base (seeded head) manifest id of an R2 asset resource. */
export const baseManifest = (resourceId: string): string => sha256HexSync(`manifest:${resourceId}:base`);

export interface AcceptFixtureOptions {
  proposalId?: string;
  /** resources changed by the proposal (default `['r1']`); each is seeded at `baseRev(r)` with versionSeq 1 */
  resources?: string[];
  /**
   * R2 asset resources whose manifest the proposal replaces (default none); each is seeded at
   * `r2m:<baseManifest(r)>`. With `resources: []` the proposal is assets-only and its evidence has
   * an empty `mergeOutcome`, like an assets-only integrate run.
   */
  assetResources?: string[];
  /** read dependencies; their resources are seeded at `baseRev(r)` unless also changed */
  readDependencies?: Array<{ resourceId: string; revisionId: RevisionId; mode: DependencyMode }>;
  policyRevision?: number;
  idempotencyKey?: string;
  updatedAt?: string;
  approvedAt?: string;
  organizationId?: string;
  projectId?: string;
}

export interface AcceptFixture {
  seed: LedgerSeed;
  proposal: ProposalRecord;
  input: AcceptInput;
  /** candidate revision per resource (the new head on a fast-forward accept) */
  candidate: Record<string, RevisionId>;
}

/**
 * A prepared, approved, validated proposal whose candidates fast-forward the seeded heads.
 * `planCommit(tx, fixture.input, FIXTURE_TIME.now)` succeeds on a store seeded with `fixture.seed`.
 */
export function acceptFixture(opts: AcceptFixtureOptions = {}): AcceptFixture {
  const pid = opts.proposalId ?? 'prop-1';
  const resources = opts.resources ?? ['r1'];
  const policyRevision = opts.policyRevision ?? 1;
  const organizationId = opts.organizationId ?? FIXTURE_ORG;
  const projectId = opts.projectId ?? FIXTURE_PROJECT;
  const readDependencies = opts.readDependencies ?? [];
  const assetResources = opts.assetResources ?? [];

  const candidate: Record<string, RevisionId> = {};
  const resourceChanges = resources.map((r) => {
    const sha = fixtureSha(`${r}:${pid}:candidate`);
    const rev = artRevisionId(`repo-${r}`, sha);
    candidate[r] = rev;
    return { resourceId: r, baseRevision: baseRev(r), candidateId: candidateId(`ws-${pid}-${r}`, sha), candidateRevision: rev };
  });
  const assetManifestChanges = assetResources.map((r) => {
    const newManifestId = sha256HexSync(`manifest:${r}:${pid}`);
    candidate[r] = r2mRevisionId(newManifestId as never);
    return { resourceId: r, baseManifestId: baseManifest(r), newManifestId };
  });

  const hashed = {
    baseSnapshotId: sha256HexSync(`snap:base:${pid}`),
    candidateSnapshotId: sha256HexSync(`snap:candidate:${pid}`),
    resourceChanges,
    readDependencies,
    assetManifestChanges,
    policyRevision,
  };
  const proposalHash = computeProposalHashSync(hashed);
  const proposal = ProposalRecordSchema.parse({
    ...hashed,
    proposalId: pid,
    proposalHash,
    organizationId,
    projectId,
    changeId: `chg-${pid}`,
    state: 'prepared',
    preparedReceipts: [...resources, ...assetResources].map((r) => ({ resourceId: r, receiptId: `prep-${pid}-${r}` })),
    createdAt: FIXTURE_TIME.created,
    updatedAt: opts.updatedAt ?? FIXTURE_TIME.updated,
  });

  const preparedReceipts = resourceChanges.map((c) => ({
    receiptId: `prep-${pid}-${c.resourceId}`,
    jobId: `job-prep-${pid}-${c.resourceId}`,
    candidateId: c.candidateId,
    resourceId: c.resourceId,
    canonicalRef: candidateRetentionRef(c.candidateId),
    sha: fixtureSha(`${c.resourceId}:${pid}:candidate`),
    revisionId: c.candidateRevision,
    verifiedAssetObjects: [],
    preparedAt: FIXTURE_TIME.prepared,
  }));
  // the Worker's own "prepare" of an asset manifest change (its revision is the new manifest)
  for (const a of assetManifestChanges) {
    const cid = candidateId(`ws-${pid}-${a.resourceId}`, a.newManifestId);
    preparedReceipts.push({
      receiptId: `prep-${pid}-${a.resourceId}`,
      jobId: 'worker-asset-manifest',
      candidateId: cid,
      resourceId: a.resourceId,
      canonicalRef: candidateRetentionRef(cid),
      sha: a.newManifestId,
      revisionId: candidate[a.resourceId]!,
      verifiedAssetObjects: [],
      preparedAt: FIXTURE_TIME.prepared,
    });
  }

  const headResources = [...new Set([...resources, ...readDependencies.map((d) => d.resourceId)])];
  const seed: LedgerSeed = {
    heads: [
      ...headResources.map((r) => ({ organizationId, resourceId: r, revisionId: baseRev(r), versionSeq: 1 })),
      ...assetResources.map((r) => ({ organizationId, resourceId: r, revisionId: r2mRevisionId(baseManifest(r) as never), versionSeq: 1 })),
    ],
    proposals: [proposal],
    preparedReceipts,
    policyRevisions: [{ projectId, policyRevision }],
  };

  const input = AcceptInputSchema.parse({
    proposalId: pid,
    proposalHash,
    idempotencyKey: opts.idempotencyKey ?? `idem-${pid}`,
    expectedHeads: [
      ...resources.map((r) => ({ resourceId: r, revisionId: baseRev(r) })),
      ...assetResources.map((r) => ({ resourceId: r, revisionId: r2mRevisionId(baseManifest(r) as never) })),
    ],
    newHeads: [
      ...resourceChanges.map((c) => ({
        resourceId: c.resourceId,
        revisionId: c.candidateRevision,
        preparedReceiptId: `prep-${pid}-${c.resourceId}`,
      })),
      ...assetResources.map((r) => ({ resourceId: r, revisionId: candidate[r]!, preparedReceiptId: `prep-${pid}-${r}` })),
    ],
    readDependencies,
    approvals: [
      {
        approvalId: `appr-${pid}`,
        proposalId: pid,
        proposalHash,
        approver: FIXTURE_APPROVER,
        role: 'owner',
        approvedAt: opts.approvedAt ?? FIXTURE_TIME.approved,
      },
    ],
    policyRevision,
    evidence: [
      {
        evidenceId: `ev-${pid}`,
        proposalHash,
        snapshotId: hashed.candidateSnapshotId,
        runnerId: 'runner-1',
        runnerKind: 'sandbox',
        checks: [{ checkId: 'test', command: 'pnpm test', result: 'pass', startedAt: FIXTURE_TIME.prepared, endedAt: FIXTURE_TIME.prepared }],
        contractChecks: [],
        mergeOutcome: resources.map((r) => ({ resourceId: r, result: 'clean' })),
        producedAt: FIXTURE_TIME.prepared,
        signature: 'hmac-sha256:fixture',
      },
    ],
    actor: FIXTURE_ACTOR,
  });

  return { seed, proposal, input, candidate };
}

/** Merge seeds (later entries win for heads with the same resource). */
export function mergeSeeds(...seeds: LedgerSeed[]): LedgerSeed {
  return {
    heads: seeds.flatMap((s) => s.heads ?? []),
    proposals: seeds.flatMap((s) => s.proposals ?? []),
    preparedReceipts: seeds.flatMap((s) => s.preparedReceipts ?? []),
    integrationReceipts: seeds.flatMap((s) => s.integrationReceipts ?? []),
    policyRevisions: seeds.flatMap((s) => s.policyRevisions ?? []),
  };
}
