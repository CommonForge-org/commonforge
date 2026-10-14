import { describe, expect, it } from 'vitest';
import { artRevisionId, candidateRetentionRef, type ResourceId } from '@commonforge-org/core';
import {
  EDITION_BRANCH_REF,
  IntegrationJobSchema,
  verifySignedJob,
  RunnerJobDeliverySchema,
  deriveEvidenceKey,
  evidenceKeyToWire,
  jobAllowedPushRefs,
  jobIntegrationRef,
  parseRunnerResultForJob,
  signEvidence,
  signJob,
  type IntegrationJob,
  type SignedJob,
} from '../src/index.js';
import { KEY_A, PROPOSAL_HASH, PROPOSAL_ID, artifactsCoords, frozenCandidate, prepareJob, sha, snapshot } from './fixtures.js';

const res = (s: string) => s as ResourceId;
const NOW = '2026-10-06T00:00:00.000Z';
const CANDIDATE_SNAPSHOT = 'e'.repeat(64);

async function signed(job: IntegrationJob, jobId: string): Promise<SignedJob> {
  return signJob({ job, jobId, issuedAt: NOW, expiresAt: '2026-10-06T00:30:00.000Z', credentialBroker: 'https://w.example/api/runner/credential' }, KEY_A);
}

function integrateJob(jobId: string): IntegrationJob {
  return {
    kind: 'integrate',
    proposalId: PROPOSAL_ID,
    proposalHash: PROPOSAL_HASH,
    baseSnapshot: snapshot([
      { resourceId: res('res-site'), revisionId: artRevisionId('site', sha('b')), mode: 'must-match-accepted', mountName: 'site', operations: ['read', 'write'] },
    ]),
    candidateSnapshotId: CANDIDATE_SNAPSHOT as never,
    candidates: [frozenCandidate()],
    targets: [{ resourceId: res('res-site'), canonical: artifactsCoords('site'), expectedHead: artRevisionId('site', sha('b')) }],
    integrationRef: jobIntegrationRef(PROPOSAL_ID, jobId),
    checks: [],
    contracts: [],
  };
}

describe('jobAllowedPushRefs', () => {
  it('lists exactly the refs each kind may push', () => {
    const prep = prepareJob() as Extract<IntegrationJob, { kind: 'prepare-candidate' }>;
    expect(jobAllowedPushRefs(prep)).toEqual([{ coords: prep.canonical, ref: candidateRetentionRef(prep.candidate.candidateId), lease: 'absent' }]);
    const int = integrateJob('job-1');
    expect(jobAllowedPushRefs(int).map((p) => p.ref)).toEqual(['refs/commonforge/integrations/prop-1/job-1']);
    expect(
      jobAllowedPushRefs({ kind: 'reconcile-ref', canonical: artifactsCoords('site'), ref: 'refs/heads/main', targetSha: sha('a'), expectedCurrentSha: sha('b') }),
    ).toEqual([{ coords: artifactsCoords('site'), ref: 'refs/heads/main', lease: 'expected', expectedSha: sha('b') }]);
    expect(
      jobAllowedPushRefs({
        kind: 'build-edition',
        editionId: 'ed-1',
        sources: [{ resourceId: res('res-site'), canonical: artifactsCoords('site'), sha: sha('a'), canonicalPathPrefix: '', editionPathPrefix: '', include: ['**'] }],
        exclude: [],
        editionRepo: artifactsCoords('ed-1', 'commonforge-org1-editions'),
      })[0]!.ref,
    ).toBe(EDITION_BRANCH_REF);
    expect(jobAllowedPushRefs({ kind: 'inventory', intakeId: 'i-1', upload: { r2Key: 'k' }, limits: { maxFiles: 1, maxTotalBytes: 1, maxCompressionRatio: 100 } })).toEqual([]);
  });
});

describe('parseRunnerResultForJob', () => {
  it('accepts a prepare receipt that matches the job and refuses one that does not', async () => {
    const sj = await signed(prepareJob(), 'job-p');
    const job = sj.job as Extract<IntegrationJob, { kind: 'prepare-candidate' }>;
    const receipt = {
      receiptId: 'r-1',
      jobId: 'job-p',
      candidateId: job.candidate.candidateId,
      resourceId: job.candidate.resourceId,
      canonicalRef: job.retentionRef,
      sha: job.candidate.sha,
      revisionId: artRevisionId('site', job.candidate.sha),
      verifiedAssetObjects: [],
      preparedAt: NOW,
    };
    expect(parseRunnerResultForJob(sj as never, { jobId: 'job-p', ok: true, receipt }).ok).toBe(true);
    expect(() => parseRunnerResultForJob(sj as never, { jobId: 'job-other', ok: true, receipt })).toThrow(/jobId/);
    expect(() => parseRunnerResultForJob(sj as never, { jobId: 'job-p', ok: true, receipt: { ...receipt, canonicalRef: 'refs/heads/main' } })).toThrow(/canonicalRef/);
    expect(() => parseRunnerResultForJob(sj as never, { jobId: 'job-p', ok: true, receipt: { ...receipt, sha: sha('e'), revisionId: artRevisionId('site', sha('e')) } })).toThrow(/sha/);
    expect(parseRunnerResultForJob(sj as never, { jobId: 'job-p', ok: false, code: 'stale_base', detail: 'x' }).ok).toBe(false);
    expect(() => parseRunnerResultForJob(sj as never, { jobId: 'job-p', ok: true, receipt: { nope: 1 } })).toThrow(/malformed/);
  });

  it('binds integrate receipts to proposal, targets, integrationRef and evidence', async () => {
    const sj = await signed(integrateJob('job-i'), 'job-i');
    const job = sj.job as Extract<IntegrationJob, { kind: 'integrate' }>;
    const evidence = await signEvidence(
      {
        evidenceId: 'ev-1',
        proposalHash: job.proposalHash,
        snapshotId: job.candidateSnapshotId,
        runnerId: 'r',
        runnerKind: 'node-runner',
        checks: [],
        contractChecks: [],
        mergeOutcome: [{ resourceId: 'res-site' as ResourceId, result: 'clean' }],
        producedAt: NOW,
      },
      await deriveEvidenceKey(KEY_A, 'job-i'),
      { jobId: 'job-i' },
    );
    const ok = {
      jobId: 'job-i',
      ok: true,
      receipt: {
        jobId: 'job-i',
        proposalId: job.proposalId,
        results: [{ resourceId: 'res-site', integrationRef: job.integrationRef, sha: sha('f'), revisionId: artRevisionId('site', sha('f')), expectedHead: job.targets[0]!.expectedHead }],
        evidence,
        integratedAt: NOW,
      },
    };
    expect(parseRunnerResultForJob(sj as never, ok).ok).toBe(true);
    const wrongRef = structuredClone(ok);
    wrongRef.receipt.results[0]!.integrationRef = 'refs/commonforge/integrations/prop-1/other';
    expect(() => parseRunnerResultForJob(sj as never, wrongRef)).toThrow(/integrationRef/);
    const noTargets = structuredClone(ok);
    noTargets.receipt.results = [];
    expect(() => parseRunnerResultForJob(sj as never, noTargets)).toThrow(/target set/);
    // evidence bound to the base snapshot instead of the candidate snapshot is refused (C-1)
    const baseBound = structuredClone(ok);
    baseBound.receipt.evidence = { ...evidence, snapshotId: job.baseSnapshot.snapshotId };
    expect(() => parseRunnerResultForJob(sj as never, baseBound)).toThrow(/candidate snapshot/);
  });

  it('binds an assets-only integrate receipt: no results, an empty mergeOutcome, the job checks', async () => {
    const base = integrateJob('job-a') as Extract<IntegrationJob, { kind: 'integrate' }>;
    const assetsOnly = {
      ...base,
      candidates: [],
      targets: [],
      assetChanges: [{ resourceId: res('res-brand'), baseManifestId: 'a'.repeat(64), newManifestId: 'b'.repeat(64) }],
      references: [{ resourceId: res('res-site'), coords: artifactsCoords('site') }],
      checks: [{ checkId: 'test', mountName: 'site', command: 'pnpm test', timeoutSeconds: 600, required: true }],
    } as unknown as IntegrationJob;
    const sj = await signed(assetsOnly, 'job-a');
    const job = sj.job as Extract<IntegrationJob, { kind: 'integrate' }>;
    const evidence = await signEvidence(
      {
        evidenceId: 'ev-a',
        proposalHash: job.proposalHash,
        snapshotId: job.candidateSnapshotId,
        runnerId: 'r',
        runnerKind: 'node-runner',
        checks: [{ checkId: 'test', command: 'pnpm test', result: 'pass', required: true, startedAt: NOW, endedAt: NOW }],
        contractChecks: [],
        mergeOutcome: [],
        producedAt: NOW,
      },
      await deriveEvidenceKey(KEY_A, 'job-a'),
      { jobId: 'job-a' },
    );
    const ok = { jobId: 'job-a', ok: true, receipt: { jobId: 'job-a', proposalId: job.proposalId, results: [] as unknown[], evidence, integratedAt: NOW } };
    expect(parseRunnerResultForJob(sj as never, ok).ok).toBe(true);
    // a result or merge outcome for a resource the job never targeted is refused
    const extra = structuredClone(ok);
    extra.receipt.results = [{ resourceId: 'res-site', integrationRef: job.integrationRef, sha: sha('f'), revisionId: artRevisionId('site', sha('f')), expectedHead: artRevisionId('site', sha('b')) }];
    expect(() => parseRunnerResultForJob(sj as never, extra)).toThrow(/target set/);
    const merged = structuredClone(ok);
    merged.receipt.evidence = { ...evidence, mergeOutcome: [{ resourceId: res('res-brand'), result: 'clean' }] };
    expect(() => parseRunnerResultForJob(sj as never, merged)).toThrow(/mergeOutcome/);
    // the checks must still be exactly the job's
    const noChecks = structuredClone(ok);
    noChecks.receipt.evidence = { ...evidence, checks: [] };
    expect(() => parseRunnerResultForJob(sj as never, noChecks)).toThrow(/exactly the job checks/);
  });

  it('binds integrate evidence checks to the job checks and their required flag (follow-up I-3)', async () => {
    const base = integrateJob('job-ck') as Extract<IntegrationJob, { kind: 'integrate' }>;
    const withChecks = {
      ...base,
      checks: [
        { checkId: 'test', mountName: 'site', command: 'pnpm test', timeoutSeconds: 600, required: true },
        { checkId: 'lint', mountName: 'site', command: 'pnpm lint', timeoutSeconds: 600, required: false },
      ],
    } as IntegrationJob;
    const sj = await signed(withChecks, 'job-ck');
    const job = sj.job as Extract<IntegrationJob, { kind: 'integrate' }>;
    const check = (checkId: string, extra: Record<string, unknown> = {}) => ({ checkId, result: 'pass', startedAt: NOW, endedAt: NOW, ...extra });
    const result = (checks: unknown[]) => ({
      jobId: 'job-ck',
      ok: true,
      receipt: {
        jobId: 'job-ck',
        proposalId: job.proposalId,
        results: [{ resourceId: 'res-site', integrationRef: job.integrationRef, sha: sha('f'), revisionId: artRevisionId('site', sha('f')), expectedHead: job.targets[0]!.expectedHead }],
        evidence: {
          evidenceId: 'ev-ck',
          proposalHash: job.proposalHash,
          snapshotId: job.candidateSnapshotId,
          runnerId: 'r',
          runnerKind: 'node-runner',
          checks,
          contractChecks: [],
          mergeOutcome: [{ resourceId: 'res-site', result: 'clean' }],
          producedAt: NOW,
          signature: 'hs256:k:00',
        },
        integratedAt: NOW,
      },
    });
    // exact flags, and absent flags (runners that predate `required`) verify
    expect(parseRunnerResultForJob(sj as never, result([check('test', { required: true }), check('lint', { required: false, result: 'fail' })])).ok).toBe(true);
    expect(parseRunnerResultForJob(sj as never, result([check('test'), check('lint')])).ok).toBe(true);
    // a policy-required check may not be reported optional, nor an optional one required
    expect(() => parseRunnerResultForJob(sj as never, result([check('test', { required: false }), check('lint')]))).toThrow(/test: required must match/);
    expect(() => parseRunnerResultForJob(sj as never, result([check('test'), check('lint', { required: true })]))).toThrow(/lint: required must match/);
    // missing, extra or duplicated checks
    expect(() => parseRunnerResultForJob(sj as never, result([check('test')]))).toThrow(/exactly the job checks/);
    expect(() => parseRunnerResultForJob(sj as never, result([check('test'), check('lint'), check('extra')]))).toThrow(/exactly the job checks/);
    expect(() => parseRunnerResultForJob(sj as never, result([check('test'), check('test'), check('lint')]))).toThrow(/exactly the job checks/);
  });

  it('binds an edition-return candidateId to the candidate fork workspace and sha (M-2)', async () => {
    const job = {
      kind: 'edition-return' as const,
      edition: {
        editionId: 'ed-1',
        policyRevision: 1,
        sourceReleaseId: 'rel-1' as never,
        exportedSnapshotId: snapshot([]).snapshotId,
        inventory: [],
        mappings: [{ editionPathPrefix: '', resourceId: res('res-site'), canonicalPathPrefix: '', writable: true }],
        canonicalBases: [{ resourceId: res('res-site'), revisionId: artRevisionId('site', sha('b')) }],
        allowedAssetNamespaces: [],
        contractVersions: {},
        protectedPaths: [],
      },
      upload: { r2Key: 'k.zip', mode: 'partial' as const },
      target: { resourceId: res('res-site'), canonical: artifactsCoords('site'), expectedHead: artRevisionId('site', sha('b')) },
      candidateFork: { taskWorkspaceId: 'tw-ret' as never, coords: artifactsCoords('site-tw-ret', 'commonforge-org1-tasks') },
    };
    const sj = await signed(job, 'job-er');
    const receipt = (cid: string) => ({
      jobId: 'job-er',
      ok: true,
      receipt: { jobId: 'job-er', editionId: 'ed-1', resourceId: 'res-site', candidate: { candidateId: cid, taskWorkspaceId: 'tw-ret', sha: sha('f') }, expectedHead: job.target.expectedHead, allowed: [], blocked: [], returnedAt: NOW },
    });
    expect(parseRunnerResultForJob(sj as never, receipt(`cand:tw-ret:${sha('f')}`)).ok).toBe(true);
    expect(() => parseRunnerResultForJob(sj as never, receipt(`cand:tw-ret:${sha('e')}`))).toThrow(/candidateId/);
  });
});

describe('integrate candidateSnapshotId (C-1)', () => {
  it('is required and covered by the job signature', async () => {
    const job = integrateJob('job-c1') as Record<string, unknown>;
    const { candidateSnapshotId: _drop, ...without } = job;
    expect(IntegrationJobSchema.safeParse(without).success).toBe(false);
    const sj = await signed(job as never, 'job-c1');
    expect((await verifySignedJob(sj, [KEY_A], { now: Date.parse(NOW) })).ok).toBe(true);
    const tampered = { ...sj, job: { ...sj.job, candidateSnapshotId: 'f'.repeat(64) } };
    expect(await verifySignedJob(tampered, [KEY_A], { now: Date.parse(NOW) })).toMatchObject({ ok: false, reason: 'bad_signature' });
  });
});

describe('RunnerJobDeliverySchema', () => {
  it('carries a signed job and an optional evidence key, nothing else', async () => {
    const sj = await signed(prepareJob(), 'job-d');
    const key = evidenceKeyToWire(await deriveEvidenceKey(KEY_A, 'job-d'));
    expect(RunnerJobDeliverySchema.parse({ signedJob: sj, evidenceKey: key }).evidenceKey?.jobId).toBe('job-d');
    expect(() => RunnerJobDeliverySchema.parse({ signedJob: sj, token: 'x' })).toThrow();
  });
});
