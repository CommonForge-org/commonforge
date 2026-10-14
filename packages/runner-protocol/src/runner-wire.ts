/**
 * Runner <-> Worker wire helpers (Task 14 additions; all additive):
 *
 * - {@link jobAllowedPushRefs} (review M-9): the exact refs a job may push, per repository. The
 *   runner refuses any other push, and an egress proxy can enforce the same list, because
 *   Artifacts tokens are repository-wide (no ref scoping).
 * - {@link parseRunnerResultForJob} (review M-8): parse a runner result AND bind its receipt to
 *   the signed job's fields, so a result for another job, proposal, ref or sha is refused.
 * - The delivery, revoke and result-post shapes the runner uses with the Worker.
 */
import { z } from 'zod';
import { candidateId, canonicalJson, revisionCommitSha, type RepoCoords, type RevisionId } from '@commonforge-org/core';
import { RunnerProtocolError } from './errors.js';
import { EvidenceKeyWireSchema } from './evidence.js';
import { INIT_FOLDER_BRANCH_REF, STAGING_REF, stagingBuildRef, parseRunnerResult, SignedJobSchema, type IntegrationJob, type IntegrationJobKind, type ReleaseBuildReceipt, type RunnerResult, type SignedJob } from './jobs.js';
import { releaseOutputDigest, releaseTargetDigest } from './release.js';
import { APPLY_FILES_BRANCH_REF } from './apply-files.js';

/** Branch a `build-edition` job writes in its `-editions` repository. */
export const EDITION_BRANCH_REF = 'refs/heads/main';
/** Branch an `edition-return` job creates in its fresh task fork. */
export const EDITION_RETURN_BRANCH_REF = 'refs/heads/main';

export interface AllowedPush {
  coords: RepoCoords;
  ref: string;
  /**
   * `absent`: the ref must not exist (lease `<ref>:`); `expected`: lease on `expectedSha`;
   * `observed`: lease on the value `ls-remote` showed just before the push
   */
  lease: 'absent' | 'expected' | 'observed';
  /** for `expected` leases: the sha the ref must hold (null = must not exist) */
  expectedSha?: string | null;
}

/**
 * Every ref push a job may perform. Nothing else may ever be pushed by a runner:
 * - prepare-candidate: canonical `retentionRef` (must not exist);
 * - integrate: each target's canonical `integrationRef` (unique per job; must not exist); none for
 *   an assets-only job (no targets);
 * - reconcile-ref: canonical `ref` leased on `expectedCurrentSha`;
 * - seed-workspace: the task repo `ref` (must not exist);
 * - build-edition: the edition repo's `refs/heads/main` (leased on the observed value: a rebuild
 *   replaces the previous edition);
 * - edition-return, apply-files: the fresh candidate fork's `refs/heads/main` (must not exist);
 * - staging-build: each target's canonical `refs/commonforge/staging-builds/<buildId>` (must not
 *   exist; an identical sha counts as done) and `refs/commonforge/staging`, leased on the observed
 *   value (each build replaces the previous staging commit; main is never pushed);
 * - init-folder: canonical `refs/heads/main` (must not exist: a folder's first commit only);
 * - preview-build, export, inventory, release-build, release-deploy: none.
 */
export function jobAllowedPushRefs(job: IntegrationJob): AllowedPush[] {
  switch (job.kind) {
    case 'prepare-candidate':
      return [{ coords: job.canonical, ref: job.retentionRef, lease: 'absent' }];
    case 'integrate':
      return job.targets.map((t) => ({ coords: t.canonical, ref: job.integrationRef, lease: 'absent' as const }));
    case 'reconcile-ref':
      return [{ coords: job.canonical, ref: job.ref, lease: 'expected', expectedSha: job.expectedCurrentSha }];
    case 'seed-workspace':
      return [{ coords: job.taskFork, ref: job.ref, lease: 'absent' }];
    case 'build-edition':
      return [{ coords: job.editionRepo, ref: EDITION_BRANCH_REF, lease: 'observed' }];
    case 'edition-return':
      return [{ coords: job.candidateFork.coords, ref: EDITION_RETURN_BRANCH_REF, lease: 'absent' }];
    case 'apply-files':
      return [{ coords: job.candidateFork.coords, ref: APPLY_FILES_BRANCH_REF, lease: 'absent' }];
    case 'staging-build':
      return job.targets.flatMap((t) => [
        { coords: t.canonical, ref: stagingBuildRef(job.buildId), lease: 'absent' as const },
        { coords: t.canonical, ref: STAGING_REF, lease: 'observed' as const },
      ]);
    case 'init-folder':
      return [{ coords: job.canonical, ref: INIT_FOLDER_BRANCH_REF, lease: 'absent' }];
    case 'preview-build':
    case 'export':
    case 'inventory':
    case 'release-build':
    case 'release-deploy':
      return [];
  }
}

// =============================================================================================
// Wire shapes
// =============================================================================================

/**
 * What the Worker hands a runner: the signed job (verify it; never trust it unverified) and,
 * for jobs that produce evidence, the per-job evidence key (`evidenceKeyToWire`). The evidence
 * key is a secret bound to `signedJob.jobId`; never log it.
 */
export const RunnerJobDeliverySchema = z
  .object({
    signedJob: z.record(z.string(), z.unknown()),
    evidenceKey: EvidenceKeyWireSchema.optional(),
  })
  .strict();
export type RunnerJobDelivery = z.infer<typeof RunnerJobDeliverySchema>;

/** `POST <credentialBroker>/revoke`: revoke a token minted for this job (best effort; TTL bounds it anyway). */
export const RunnerCredentialRevokeRequestSchema = z.object({ signedJob: SignedJobSchema, tokenId: z.string().min(1) });
export type RunnerCredentialRevokeRequest = z.infer<typeof RunnerCredentialRevokeRequestSchema>;

/**
 * `POST /api/runner/results`: the signed job (so the Worker can verify it statelessly) and the
 * redacted result. The Worker verifies the job signature, then {@link parseRunnerResultForJob},
 * then `verifyEvidence`, and applies each jobId once.
 */
export interface RunnerResultPost {
  signedJob: SignedJob;
  result: RunnerResult;
}

// =============================================================================================
// parseRunnerResultForJob
// =============================================================================================

function mismatch(detail: string): never {
  throw new RunnerProtocolError('invalid_job', `runner result does not match its job: ${detail}`);
}

const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

const commitOf = (r: string) => revisionCommitSha(r as RevisionId);

/**
 * Parse a runner result for a signed job and bind the receipt to the job: same jobId, and the
 * receipt's identifying fields (candidate, refs, shas, proposal, targets, ids, R2 keys under the
 * sink prefix) equal what the job asked for. Throws `RunnerProtocolError('invalid_job')`.
 */
export function parseRunnerResultForJob<K extends IntegrationJobKind>(
  signedJob: Pick<SignedJob, 'jobId'> & { job: Extract<IntegrationJob, { kind: K }> },
  value: unknown,
): RunnerResult<K> {
  const job = signedJob.job as IntegrationJob;
  let result: RunnerResult<K>;
  try {
    result = parseRunnerResult(job.kind as K, value);
  } catch (e) {
    throw new RunnerProtocolError('invalid_job', `malformed runner result: ${(e as Error).message}`);
  }
  if (result.jobId !== signedJob.jobId) mismatch(`jobId ${result.jobId} != ${signedJob.jobId}`);
  if (!result.ok) return result;
  const r = result.receipt as Record<string, unknown> & { jobId?: string };
  if (r.jobId !== undefined && r.jobId !== signedJob.jobId) mismatch('receipt jobId');
  switch (job.kind) {
    case 'prepare-candidate': {
      const p = r as { candidateId: string; resourceId: string; canonicalRef: string; sha: string; revisionId: string };
      if (p.candidateId !== job.candidate.candidateId) mismatch('candidateId');
      if (p.resourceId !== job.candidate.resourceId) mismatch('resourceId');
      if (p.canonicalRef !== job.retentionRef) mismatch('canonicalRef');
      if (p.sha !== job.candidate.sha || commitOf(p.revisionId) !== job.candidate.sha) mismatch('sha');
      break;
    }
    case 'integrate': {
      const p = r as {
        proposalId: string;
        results: Array<{ resourceId: string; integrationRef: string; sha: string; revisionId: string; expectedHead: string }>;
        evidence: {
          proposalHash: string;
          snapshotId: string;
          mergeOutcome: Array<{ resourceId: string; result: string }>;
          checks: Array<{ checkId: string; required?: boolean }>;
        };
      };
      if (p.proposalId !== job.proposalId) mismatch('proposalId');
      if (!sameSet(p.results.map((x) => x.resourceId), job.targets.map((t) => t.resourceId)) || p.results.length !== job.targets.length) mismatch('target set');
      for (const x of p.results) {
        const t = job.targets.find((y) => y.resourceId === x.resourceId)!;
        if (x.integrationRef !== job.integrationRef) mismatch('integrationRef');
        if (x.expectedHead !== t.expectedHead) mismatch('expectedHead');
        if (commitOf(x.revisionId) !== x.sha) mismatch('revisionId');
      }
      if (p.evidence.proposalHash !== job.proposalHash) mismatch('evidence proposalHash');
      if (p.evidence.snapshotId !== job.candidateSnapshotId) mismatch('evidence snapshotId (must be the candidate snapshot)');
      // a successful integration is clean for exactly the job's targets
      const clean = p.evidence.mergeOutcome.filter((o) => o.result === 'clean').map((o) => o.resourceId);
      if (!sameSet(clean, job.targets.map((t) => t.resourceId)) || clean.length !== p.evidence.mergeOutcome.length) mismatch('evidence mergeOutcome');
      // the evidence reports exactly the job's checks, and required-ness comes from the signed job's
      // policy: a present `required` must equal `CheckSpec.required`. An absent flag reads as
      // required (stricter than or equal to the policy), so runners that predate the flag still verify.
      const specs = new Map(job.checks.map((c) => [c.checkId as string, c.required]));
      const ids = p.evidence.checks.map((c) => c.checkId);
      if (!sameSet(ids, [...specs.keys()]) || ids.length !== specs.size) mismatch('evidence checks (must be exactly the job checks)');
      for (const c of p.evidence.checks) {
        if (c.required !== undefined && c.required !== specs.get(c.checkId)) mismatch(`evidence check ${c.checkId}: required must match the job's CheckSpec`);
      }
      break;
    }
    case 'reconcile-ref': {
      const p = r as { ref: string; targetSha: string; resourceId?: string };
      if (p.ref !== job.ref || p.targetSha !== job.targetSha) mismatch('ref/targetSha');
      if (job.resourceId !== undefined && p.resourceId !== job.resourceId) mismatch('resourceId');
      break;
    }
    case 'seed-workspace': {
      const p = r as { taskWorkspaceId: string; resourceId: string; ref: string; sha: string };
      if (p.taskWorkspaceId !== job.taskWorkspaceId || p.resourceId !== job.resourceId || p.ref !== job.ref || p.sha !== job.baseSha) mismatch('seed fields');
      break;
    }
    case 'build-edition': {
      const p = r as { editionId: string; sha: string; revisionId: string };
      if (p.editionId !== job.editionId) mismatch('editionId');
      if (commitOf(p.revisionId) !== p.sha) mismatch('revisionId');
      break;
    }
    case 'edition-return': {
      const p = r as { editionId: string; resourceId: string; expectedHead: string; candidate?: { taskWorkspaceId: string; candidateId: string; sha: string } };
      if (p.editionId !== job.edition.editionId) mismatch('editionId');
      if (p.resourceId !== job.target.resourceId || p.expectedHead !== job.target.expectedHead) mismatch('target');
      if (p.candidate && p.candidate.taskWorkspaceId !== job.candidateFork.taskWorkspaceId) mismatch('candidate workspace');
      if (p.candidate && p.candidate.candidateId !== candidateId(job.candidateFork.taskWorkspaceId, p.candidate.sha)) mismatch('candidateId');
      break;
    }
    case 'apply-files': {
      const p = r as {
        changeId: string;
        resourceId: string;
        expectedHead: string;
        candidate?: { taskWorkspaceId: string; candidateId: string; sha: string };
        lfsObjects: Array<{ stagingId: string; sha256: string; size: number }>;
      };
      if (p.changeId !== job.changeId) mismatch('changeId');
      if (p.resourceId !== job.target.resourceId || p.expectedHead !== job.target.expectedHead) mismatch('target');
      if (p.candidate && p.candidate.taskWorkspaceId !== job.candidateFork.taskWorkspaceId) mismatch('candidate workspace');
      if (p.candidate && p.candidate.candidateId !== candidateId(job.candidateFork.taskWorkspaceId, p.candidate.sha)) mismatch('candidateId');
      // nothing committed, nothing to promote; that every promoted object is one of the change's
      // puts (as recorded) is checked by the Worker, which holds the resolved operations
      if (!p.candidate && p.lfsObjects.length > 0) mismatch('lfsObjects without a candidate');
      break;
    }
    case 'export': {
      const p = r as { exportId: string; snapshotId: string; items: Array<{ r2Key: string }> };
      if (p.exportId !== job.exportId || p.snapshotId !== job.snapshotId) mismatch('export ids');
      for (const it of p.items) if (!it.r2Key.startsWith(job.sink.r2Prefix)) mismatch(`r2Key outside sink: ${it.r2Key}`);
      break;
    }
    case 'preview-build': {
      const p = r as { previewId: string; integrationSha: Record<string, string>; recipe: { recipeId: string; revision: number } };
      if (p.previewId !== job.previewId) mismatch('previewId');
      if (canonicalJson(p.integrationSha) !== canonicalJson(job.integrationSha)) mismatch('integrationSha');
      if (p.recipe.recipeId !== job.recipe.recipeId || p.recipe.revision !== job.recipe.revision) mismatch('recipe');
      break;
    }
    case 'inventory': {
      const p = r as { intakeId: string };
      if (p.intakeId !== job.intakeId) mismatch('intakeId');
      break;
    }
    case 'release-build': {
      const p = r as unknown as ReleaseBuildReceipt;
      if (p.releaseId !== job.releaseId) mismatch('releaseId');
      if (!sameSet(p.targets.map((t) => t.targetId), job.targets.map((t) => t.targetId)) || p.targets.length !== job.targets.length) mismatch('target set');
      for (const t of p.targets) {
        if (t.digest !== releaseTargetDigest(t.files, t.config, t.dataFiles ?? [])) mismatch(`target ${t.targetId} digest`);
        if (t.config.vars.COMMONFORGE_RELEASE_ID !== job.releaseId) mismatch(`target ${t.targetId} release var`);
      }
      if (p.outputDigest !== releaseOutputDigest(p.targets)) mismatch('outputDigest');
      break;
    }
    case 'release-deploy': {
      const p = r as { releaseId: string; outputDigest: string; deployments: Array<{ targetId: string; workerName: string }> };
      if (p.releaseId !== job.releaseId || p.outputDigest !== job.outputDigest) mismatch('release identity');
      if (p.deployments.length !== job.targets.length) mismatch('deployment set');
      for (const d of p.deployments) {
        const t = job.targets.find((x) => x.targetId === d.targetId);
        if (!t || t.workerName !== d.workerName) mismatch(`deployment ${d.targetId}`);
      }
      break;
    }
    case 'staging-build': {
      const p = r as { buildId: string; results: Array<{ resourceId: string; sha: string; revisionId: string }> };
      if (p.buildId !== job.buildId) mismatch('buildId');
      const want = job.targets.map((t) => t.resourceId);
      if (p.results.length !== want.length || p.results.some((x, i) => x.resourceId !== want[i])) mismatch('staging result resources');
      for (const x of p.results) if (commitOf(x.revisionId) !== x.sha) mismatch('revisionId');
      break;
    }
    case 'init-folder': {
      // the commit itself is checked by the Worker against canonical main (log head, no parent)
      const p = r as { resourceId: string };
      if (p.resourceId !== job.resourceId) mismatch('resourceId');
      break;
    }
  }
  return result;
}
