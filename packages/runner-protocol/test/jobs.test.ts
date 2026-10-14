import { describe, expect, it } from 'vitest';
import { artRevisionId, candidateId, canonicalJson, sha256HexSync, type ResourceId } from '@commonforge-org/core';
import {
  INTEGRATION_JOB_KINDS,
  IntegrationJobSchema,
  RunnerResultSchema,
  ReleaseTargetEnvironmentSchema,
  SignedJobSchema,
  jobIntegrationRef,
  authorizeCredentialRequest,
  jobRepoAccess,
  mayBeSameRepo,
  sameRepoIdentity,
  parseRunnerResult,
  signJob,
  type IntegrationJob,
  jobAllowedPushRefs,
  defaultMaxLifetimeSeconds,
  parseRunnerResultForJob,
  releaseOutputDigest,
  releaseTargetDigest,
  parseApplyFilesOps,
  type ApplyFilesOp,
  STAGING_REF,
  stagingBuildRef,
  isStagingWorkerName,
  defaultGitattributes,
  CANONICAL_WRITE_KINDS,
} from '../src/index.js';
import { KEY_A, PROPOSAL_HASH, PROPOSAL_ID, artifactsCoords, frozenCandidate, prepareJob, sha, snapshot } from './fixtures.js';

const res = (s: string) => s as ResourceId;

function integrateJob(jobId = 'job-int-1'): IntegrationJob {
  const cand = frozenCandidate();
  return {
    kind: 'integrate',
    proposalId: PROPOSAL_ID,
    proposalHash: PROPOSAL_HASH,
    baseSnapshot: snapshot([
      { resourceId: res('res-site'), revisionId: artRevisionId('site', sha('b')), mode: 'pinned-reference', mountName: 'site', operations: ['read', 'write'] },
    ]),
    candidateSnapshotId: 'c'.repeat(64) as never,
    candidates: [cand],
    targets: [{ resourceId: res('res-site'), canonical: artifactsCoords('site'), expectedHead: artRevisionId('site', sha('b')) }],
    integrationRef: jobIntegrationRef(PROPOSAL_ID, jobId),
    checks: [{ checkId: 'test', mountName: 'site', command: 'pnpm test', timeoutSeconds: 600, required: true }],
    contracts: [],
  };
}

const allJobs = (): IntegrationJob[] => [
  prepareJob(),
  integrateJob(),
  { kind: 'reconcile-ref', resourceId: res('res-site'), canonical: artifactsCoords('site'), ref: 'refs/heads/main', targetSha: sha('a'), expectedCurrentSha: null },
  {
    kind: 'preview-build',
    previewId: 'pv-1',
    integrationSha: { [res('res-site')]: sha('a') },
    sources: [{ resourceId: res('res-site'), mountName: 'site', canonical: artifactsCoords('site') }],
    recipe: { recipeId: 'site', revision: 1, steps: [{ stepId: 'build', mountName: 'site', command: 'pnpm build' }] },
  },
  {
    kind: 'export',
    exportId: 'exp-1',
    snapshotId: snapshot([]).snapshotId,
    resources: [{ resourceId: res('res-site'), coords: artifactsCoords('site'), sha: sha('a') }],
    manifests: [],
    sink: { kind: 'r2', r2Prefix: 'org/org1/exports/exp-1/' },
  },
  {
    kind: 'build-edition',
    editionId: 'ed-1',
    sources: [{ resourceId: res('res-site'), canonical: artifactsCoords('site'), sha: sha('a'), canonicalPathPrefix: 'public', editionPathPrefix: 'site', include: ['**'] }],
    exclude: ['.env*'],
    editionRepo: artifactsCoords('ed-1', 'commonforge-org1-editions'),
  },
  {
    kind: 'edition-return',
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
    upload: { r2Key: 'org/org1/intake/up-1.zip', mode: 'partial' },
    target: { resourceId: res('res-site'), canonical: artifactsCoords('site'), expectedHead: artRevisionId('site', sha('b')) },
    candidateFork: { taskWorkspaceId: 'tw-ret-1' as never, coords: artifactsCoords('site-tw-ret-1', 'commonforge-org1-tasks') },
  },
  {
    kind: 'inventory',
    intakeId: 'in-1',
    upload: { r2Key: 'org/org1/intake/in-1.zip', sha256: 'e'.repeat(64), size: 1024 },
    limits: { maxFiles: 10_000, maxTotalBytes: 100 * 1024 * 1024, maxCompressionRatio: 100 },
  },
  seedJob(),
  releaseBuildJob(),
  releaseDeployJob(),
  applyFilesJob(),
  stagingBuildJob(),
  initFolderJob(),
];

function initFolderJob(): Extract<IntegrationJob, { kind: 'init-folder' }> {
  return {
    kind: 'init-folder',
    resourceId: res('res-site'),
    canonical: artifactsCoords('site'),
    files: [
      { path: '.gitattributes', content: defaultGitattributes() },
      { path: '.lfsconfig', content: '[lfs]\n\turl = https://cf.example/api/lfs/org1/res-site/info/lfs\n' },
      { path: 'README.md', content: '# Docs\n' },
    ],
    author: { name: 'Dana Owner', email: 'dana@example.test' },
    commitTime: '2026-10-11T09:30:00.000Z',
    message: 'Create folder Docs',
  };
}

const STAGED = 'org/org1/lfs/res-site/obj/lfs-small';

const OPS_KEY = 'org/org1/file-changes/fc-1/ops-1.json';

function applyFilesOps(): ApplyFilesOp[] {
  return [
    { put: 'Demo Videos/final cut.mov', stagingId: 'lfs-big', sha256: 'f'.repeat(64), size: 150_000_000, binary: true },
    { put: 'notes/hello.txt', stagingId: 'lfs-small', sha256: 'e'.repeat(64), size: 6, binary: false, r2Key: STAGED },
    { edit: 'config.json', content: '{"a":2}\n', baseBlob: sha('c') },
    { delete: 'docs/old.md' },
    { move: 'img', to: 'assets/img' },
  ];
}

function applyFilesJob(): Extract<IntegrationJob, { kind: 'apply-files' }> {
  return {
    kind: 'apply-files',
    changeId: 'fc-1',
    target: { resourceId: res('res-site'), canonical: artifactsCoords('site'), expectedHead: artRevisionId('site', sha('b')) },
    candidateFork: { taskWorkspaceId: 'tw-af-1' as never, coords: artifactsCoords('ws-tw-af-1', 'commonforge-org1-tasks') },
    opsManifest: { r2Key: OPS_KEY, sha256: 'a'.repeat(64), count: 5 },
    author: { name: 'Dana Owner', email: 'dana@example.test' },
    title: 'Uploaded files',
    lfsThresholdBytes: 1_048_576,
  };
}

function stagingBuildJob(): IntegrationJob {
  return {
    kind: 'staging-build',
    buildId: 'b-1',
    targets: [
      {
        resourceId: res('res-site'),
        canonical: artifactsCoords('site'),
        mainSha: sha('a'),
        landings: [{ landingId: 'l-1', candidates: [{ candidateId: candidateId('tw-1', sha('c')), sha: sha('c'), baseSha: sha('a') }] }],
      },
    ],
  };
}

function releaseBuildJob(): Extract<IntegrationJob, { kind: 'release-build' }> {
  return {
    kind: 'release-build',
    releaseId: 'rel-1',
    acceptedVersionId: 'av-1',
    sources: [{ resourceId: res('res-site'), mountName: 'site', canonical: artifactsCoords('site'), sha: sha('a') }],
    recipe: { recipeId: 'site', revision: 2, steps: [{ stepId: 'build', mountName: 'site', command: 'pnpm build', env: { VITE_QUOTE_API_URL: 'https://api.example' } }] },
    targets: [{ targetId: 'site', kind: 'assets', mountName: 'site', outputPath: 'dist', workerName: 'demo-site' }],
    environment: { site: { vars: { MODE: 'prod' }, kvNamespaces: [] } },
    outputPrefix: 'org/org1/releases/rel-1/',
  };
}

const CONFIG = { compatibilityDate: '2026-08-22', compatibilityFlags: [], vars: { COMMONFORGE_RELEASE_ID: 'rel-1' }, kvNamespaces: [] };
const FILES = [{ path: 'index.html', sha256: 'f'.repeat(64), size: 10 }];

function releaseDeployJob(): Extract<IntegrationJob, { kind: 'release-deploy' }> {
  const digest = releaseTargetDigest(FILES, CONFIG);
  return {
    kind: 'release-deploy',
    releaseId: 'rel-1',
    outputDigest: releaseOutputDigest([{ targetId: 'site', digest }]),
    outputPrefix: 'org/org1/releases/rel-1/',
    accountId: '0'.repeat(32),
    targets: [{ targetId: 'site', kind: 'assets', workerName: 'demo-site', digest, files: FILES, config: CONFIG }],
  };
}

describe('release jobs (Task 22)', () => {
  it('release-build reads canonical only; release-deploy touches no repository and pushes nothing', () => {
    expect(jobRepoAccess(releaseBuildJob()).map((a) => [a.coords.repoName, a.access])).toEqual([['site', 'read']]);
    expect(jobRepoAccess(releaseDeployJob())).toEqual([]);
    expect(jobAllowedPushRefs(releaseBuildJob())).toEqual([]);
    expect(jobAllowedPushRefs(releaseDeployJob())).toEqual([]);
    expect(defaultMaxLifetimeSeconds('release-deploy')).toBe(3_600);
  });

  it('refuses prefixes outside the release, worker targets without main, and deploys without the release var', () => {
    expect(IntegrationJobSchema.safeParse({ ...releaseBuildJob(), outputPrefix: 'org/org1/releases/rel-2/' }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...releaseBuildJob(), outputPrefix: '../x/' }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...releaseBuildJob(), targets: [{ targetId: 'api', kind: 'worker', mountName: 'site', outputPath: 'dist', workerName: 'demo-api' }] }).success).toBe(false);
    const d = releaseDeployJob();
    expect(IntegrationJobSchema.safeParse({ ...d, targets: [{ ...d.targets[0]!, config: { ...CONFIG, vars: {} } }] }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...releaseBuildJob(), recipe: { ...releaseBuildJob().recipe, steps: [{ stepId: 'b', mountName: 'site', command: 'x', env: { 'lower-case': 'x' } }] } }).success).toBe(false);
  });

  it('old digests still verify: empty d1Databases and dataFiles do not change a target digest', () => {
    const files = [{ path: 'index.js', sha256: 'a'.repeat(64), size: 1 }];
    const config = { compatibilityDate: '2026-08-22', compatibilityFlags: [], vars: { COMMONFORGE_RELEASE_ID: 'rel-1' }, kvNamespaces: [] };
    const before = releaseTargetDigest(files, config);
    // the exact object hashed before D1/data existed
    expect(before).toBe(sha256HexSync(new TextEncoder().encode(canonicalJson({ $t: 'cf.release-target/1', files, config }))));
    expect(releaseTargetDigest(files, { ...config, d1Databases: [] }, [])).toBe(before);
    expect(releaseTargetDigest(files, { ...config, d1Databases: [{ binding: 'DB', id: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' }] })).not.toBe(before);
    expect(releaseTargetDigest(files, config, [{ path: 'migrations/0001.sql', sha256: 'b'.repeat(64), size: 2 }])).not.toBe(before);
  });

  it('parses old receipts and jobs without the new fields, and binds dataFiles and d1Databases into the recomputed digest', () => {
    const d1 = [{ binding: 'DB', id: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' }];
    const dataFiles = [{ path: 'migrations/0001.sql', sha256: 'b'.repeat(64), size: 2 }];
    const job = releaseBuildJob();
    const config = { ...CONFIG, d1Databases: d1 };
    const t = { targetId: 'site', digest: releaseTargetDigest(FILES, config, dataFiles), files: FILES, config, dataFiles };
    const receipt = { jobId: 'job-rb', releaseId: 'rel-1', outputDigest: releaseOutputDigest([t]), targets: [t], builtAt: '2026-10-06T00:00:00.000Z' };
    expect(parseRunnerResultForJob({ jobId: 'job-rb', job }, { jobId: 'job-rb', ok: true, receipt }).ok).toBe(true);
    // dropping dataFiles from the receipt no longer matches the digest
    expect(() => parseRunnerResultForJob({ jobId: 'job-rb', job }, { jobId: 'job-rb', ok: true, receipt: { ...receipt, targets: [{ ...t, dataFiles: undefined }] } })).toThrow(/digest/);
    // schema limits
    expect(ReleaseTargetEnvironmentSchema.safeParse({ vars: {}, kvNamespaces: [], d1Databases: [{ binding: 'db', id: d1[0]!.id }] }).success).toBe(false);
    expect(ReleaseTargetEnvironmentSchema.safeParse({ vars: {}, kvNamespaces: [], d1Databases: [{ binding: 'DB', id: 'x' }] }).success).toBe(false);
    expect(ReleaseTargetEnvironmentSchema.safeParse({ vars: {}, kvNamespaces: [], data: ['migrations', 'seed/a.sql'] }).success).toBe(true);
    expect(ReleaseTargetEnvironmentSchema.safeParse({ vars: {}, kvNamespaces: [], data: ['../x'] }).success).toBe(false);
    // a deploy job carries dataFiles per target and verifies the digest over them
    const dj = releaseDeployJob();
    const ddigest = releaseTargetDigest(FILES, config, dataFiles);
    const withData = { ...dj, outputDigest: releaseOutputDigest([{ targetId: 'site', digest: ddigest }]), targets: [{ ...dj.targets[0]!, workerName: 'demo-site-staging', digest: ddigest, config, dataFiles }] };
    expect(IntegrationJobSchema.safeParse(withData).success).toBe(true);
  });

  it('D1 bindings and data files are allowed on production targets too (staging phase 2, R8: the Worker restricts production data to migrations folders)', () => {
    const d1 = [{ binding: 'DB', id: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' }];
    const dataFiles = [{ path: 'migrations/0001.sql', sha256: 'b'.repeat(64), size: 2 }];
    // release-build: environment d1Databases / data for any target, never for an unknown target
    const b = releaseBuildJob();
    const staged = { ...b, targets: [{ ...b.targets[0]!, workerName: 'demo-site-staging' }] };
    for (const env of [{ d1Databases: d1 }, { data: ['migrations'] }]) {
      expect(IntegrationJobSchema.safeParse({ ...b, environment: { site: { vars: {}, kvNamespaces: [], ...env } } }).success).toBe(true);
      expect(IntegrationJobSchema.safeParse({ ...staged, environment: { site: { vars: {}, kvNamespaces: [], ...env } } }).success).toBe(true);
      expect(IntegrationJobSchema.safeParse({ ...b, environment: { other: { vars: {}, kvNamespaces: [], ...env } } }).success).toBe(false);
      expect(IntegrationJobSchema.safeParse({ ...staged, environment: { other: { vars: {}, kvNamespaces: [], ...env } } }).success).toBe(false);
    }
    // empty lists carry nothing and stay allowed
    expect(IntegrationJobSchema.safeParse({ ...b, environment: { site: { vars: {}, kvNamespaces: [], d1Databases: [], data: [] } } }).success).toBe(true);
    // release-deploy: config.d1Databases / dataFiles for production and staging targets
    const dj = releaseDeployJob();
    const deployWith = (workerName: string, config: typeof CONFIG & { d1Databases?: typeof d1 }, files?: typeof dataFiles) => {
      const digest = releaseTargetDigest(FILES, config, files ?? []);
      return { ...dj, outputDigest: releaseOutputDigest([{ targetId: 'site', digest }]), targets: [{ ...dj.targets[0]!, workerName, digest, config, ...(files ? { dataFiles: files } : {}) }] };
    };
    expect(IntegrationJobSchema.safeParse(deployWith('demo-site', { ...CONFIG, d1Databases: d1 })).success).toBe(true);
    expect(IntegrationJobSchema.safeParse(deployWith('demo-site', CONFIG, dataFiles)).success).toBe(true);
    expect(IntegrationJobSchema.safeParse(deployWith('demo-site', { ...CONFIG, d1Databases: d1 }, dataFiles)).success).toBe(true);
    expect(IntegrationJobSchema.safeParse(deployWith('demo-site-staging', { ...CONFIG, d1Databases: d1 }, dataFiles)).success).toBe(true);
    expect(IntegrationJobSchema.safeParse(deployWith('demo-site', CONFIG)).success).toBe(true);
    expect(isStagingWorkerName('demo-site-staging')).toBe(true);
    expect(isStagingWorkerName('demo-site')).toBe(false);
  });

  it('binds receipts to the job: digests are recomputed, the release id and targets must match', () => {
    const job = releaseBuildJob();
    const config = { ...CONFIG };
    const t = { targetId: 'site', digest: releaseTargetDigest(FILES, config), files: FILES, config };
    const receipt = { jobId: 'job-rb', releaseId: 'rel-1', outputDigest: releaseOutputDigest([t]), targets: [t], builtAt: '2026-10-06T00:00:00.000Z' };
    expect(parseRunnerResultForJob({ jobId: 'job-rb', job }, { jobId: 'job-rb', ok: true, receipt }).ok).toBe(true);
    expect(() => parseRunnerResultForJob({ jobId: 'job-rb', job }, { jobId: 'job-rb', ok: true, receipt: { ...receipt, outputDigest: 'a'.repeat(64) } })).toThrow(/outputDigest/);
    expect(() => parseRunnerResultForJob({ jobId: 'job-rb', job }, { jobId: 'job-rb', ok: true, receipt: { ...receipt, targets: [{ ...t, digest: 'a'.repeat(64) }] } })).toThrow(/digest/);
    const dj = releaseDeployJob();
    const dr = { jobId: 'job-rd', releaseId: 'rel-1', outputDigest: dj.outputDigest, deployments: [{ targetId: 'site', workerName: 'demo-site', versionId: null, url: null }], deployedAt: '2026-10-06T00:00:00.000Z' };
    expect(parseRunnerResultForJob({ jobId: 'job-rd', job: dj }, { jobId: 'job-rd', ok: true, receipt: dr }).ok).toBe(true);
    expect(() => parseRunnerResultForJob({ jobId: 'job-rd', job: dj }, { jobId: 'job-rd', ok: true, receipt: { ...dr, deployments: [{ ...dr.deployments[0]!, workerName: 'other' }] } })).toThrow();
  });
});

function seedJob(): Extract<IntegrationJob, { kind: 'seed-workspace' }> {
  return {
    kind: 'seed-workspace',
    taskWorkspaceId: 'tw-seed-1' as never,
    resourceId: res('res-site'),
    canonical: artifactsCoords('site'),
    baseSha: sha('a'),
    taskFork: artifactsCoords('ws-tw-seed-1', 'commonforge-org1-tasks'),
    ref: 'refs/heads/main',
  };
}

describe('apply-files job', () => {
  type Op = ApplyFilesOp;
  const T = 1_048_576;
  const ok = (ops: Op[]) => {
    try {
      parseApplyFilesOps(ops, T);
      return true;
    } catch {
      return false;
    }
  };
  const big = applyFilesOps()[0] as Extract<Op, { put: string }>;
  const small = applyFilesOps()[1] as Extract<Op, { put: string }>;

  it('parses the resolved operations of the ops manifest', () => {
    expect(parseApplyFilesOps(applyFilesOps(), T)).toEqual(applyFilesOps());
    expect(() => parseApplyFilesOps([], T)).toThrow();
    expect(() => parseApplyFilesOps({ ops: applyFilesOps() }, T)).toThrow();
    expect(() => parseApplyFilesOps([{ put: 'a.txt' }], T)).toThrow();
    expect(() => parseApplyFilesOps([{ delete: 'a', extra: 1 }], T)).toThrow();
  });

  it('refuses a small text put without r2Key and a large put with one (against the job threshold)', () => {
    const { r2Key: _r, ...smallNoKey } = small;
    expect(ok([smallNoKey])).toBe(false);
    expect(ok([{ ...big, r2Key: STAGED }])).toBe(false);
    // a small binary put is stored in LFS: no r2Key
    expect(ok([{ ...smallNoKey, binary: true }])).toBe(true);
    expect(ok([{ ...small, binary: true }])).toBe(false);
    // the threshold is the job's: under a 4-byte threshold the 6-byte text file is an LFS put
    expect(() => parseApplyFilesOps([small], 4)).toThrow(/r2Key/);
    expect(parseApplyFilesOps([smallNoKey], 4)).toHaveLength(1);
  });

  it('refuses protected and malformed paths', () => {
    expect(ok([{ delete: '.git/config' }])).toBe(false);
    expect(ok([{ move: 'a', to: 'x/.commonforge/y' }])).toBe(false);
    expect(ok([{ delete: '../x' }])).toBe(false);
    expect(ok([{ delete: 'a/'.repeat(600) + 'b' }])).toBe(false);
  });

  it('refuses an edit containing NUL or over 1 MiB, and edits over 16 MiB together', () => {
    expect(ok([{ edit: 'a.txt', content: 'a\0b', baseBlob: '' }])).toBe(false);
    expect(ok([{ edit: 'a.txt', content: 'x'.repeat(1_048_577), baseBlob: '' }])).toBe(false);
    expect(ok([{ edit: 'a.txt', content: 'x'.repeat(1_048_576), baseBlob: '' }])).toBe(true);
    const edits = (n: number) => Array.from({ length: n }, (_, i) => ({ edit: `e${i}.txt`, content: 'x'.repeat(1_048_576), baseBlob: '' }));
    expect(ok(edits(16))).toBe(true);
    expect(() => parseApplyFilesOps([...edits(16), { edit: 'one-more.txt', content: 'x', baseBlob: '' }], T)).toThrow(/16 MiB/);
  });

  it('refuses 1,001 ops, puts totaling over 20 GB, a file over 5 GB; the job: a count of 1..1,000 and a fork that is canonical or misnamed', () => {
    const ops = Array.from({ length: 1001 }, (_, i) => ({ delete: `f${i}.txt` }));
    expect(ok(ops)).toBe(false);
    expect(ok(ops.slice(0, 1000))).toBe(true);
    const fiveGb = (i: number) => ({ ...big, put: `v${i}.mov`, stagingId: `s${i}`, size: 5_000_000_000 });
    expect(ok([0, 1, 2, 3].map(fiveGb))).toBe(true);
    expect(ok([0, 1, 2, 3, 4].map(fiveGb))).toBe(false);
    expect(ok([{ ...big, size: 5_000_000_001 }])).toBe(false);
    const j = applyFilesJob();
    expect(IntegrationJobSchema.safeParse(j).success).toBe(true);
    expect(IntegrationJobSchema.safeParse({ ...j, opsManifest: { ...j.opsManifest, count: 0 } }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, opsManifest: { ...j.opsManifest, count: 1001 } }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, opsManifest: { ...j.opsManifest, sha256: 'xyz' } }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, opsManifest: { ...j.opsManifest, r2Key: 'k'.repeat(1025) } }).success).toBe(false);
    // the operations never travel inline
    expect(IntegrationJobSchema.safeParse({ ...j, ops: applyFilesOps() }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, candidateFork: { ...j.candidateFork, coords: artifactsCoords('site') } }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, candidateFork: { ...j.candidateFork, coords: artifactsCoords('ws-other', 'commonforge-org1-tasks') } }).success).toBe(false);
  });

  it('reads canonical, writes only its fresh task repo, and pushes only its main branch (must not exist)', () => {
    const j = applyFilesJob();
    expect(jobRepoAccess(j).map((a) => [a.coords.repoName, a.access, a.role])).toEqual([
      ['site', 'read', 'canonical'],
      ['ws-tw-af-1', 'write', 'task-fork'],
    ]);
    expect(jobAllowedPushRefs(j)).toEqual([{ coords: j.candidateFork.coords, ref: 'refs/heads/main', lease: 'absent' }]);
    expect(defaultMaxLifetimeSeconds('apply-files')).toBe(86_400);
  });

  const receipt = () => ({
    jobId: 'job-af',
    changeId: 'fc-1',
    resourceId: 'res-site',
    expectedHead: artRevisionId('site', sha('b')),
    candidate: { candidateId: candidateId('tw-af-1', sha('d')), taskWorkspaceId: 'tw-af-1', sha: sha('d') },
    changedPaths: [{ path: 'Demo Videos/final cut.mov', change: 'added', lfs: true, class: 'content' }],
    lfsObjects: [{ stagingId: 'lfs-big', sha256: 'f'.repeat(64), size: 150_000_000 }],
    appliedAt: '2026-10-07T00:00:00.000Z',
  });
  const parse = (r: unknown) => parseRunnerResultForJob({ jobId: 'job-af', job: applyFilesJob() }, { jobId: 'job-af', ok: true, receipt: r });

  it('binds its receipt to the job', () => {
    expect(parse(receipt()).ok).toBe(true);
    const { candidate: _c, ...noCandidate } = receipt();
    expect(parse({ ...noCandidate, changedPaths: [], lfsObjects: [] }).ok).toBe(true);
    // nothing was committed, so nothing can be promoted
    expect(() => parse({ ...noCandidate, changedPaths: [], lfsObjects: receipt().lfsObjects })).toThrow(/lfsObjects/);
    // lfsObjects ⊆ the change's puts is the Worker's check (it holds the resolved operations)
    expect(parse({ ...receipt(), lfsObjects: [{ stagingId: 'lfs-other', sha256: 'f'.repeat(64), size: 150_000_000 }] }).ok).toBe(true);
    expect(() => parse({ ...receipt(), changeId: 'fc-2' })).toThrow(/changeId/);
    expect(() => parse({ ...receipt(), resourceId: 'res-api' })).toThrow(/target/);
    expect(() => parse({ ...receipt(), expectedHead: artRevisionId('site', sha('a')) })).toThrow(/target/);
    expect(() => parse({ ...receipt(), candidate: { ...receipt().candidate, taskWorkspaceId: 'tw-x' } })).toThrow(/candidate workspace/);
    expect(() => parse({ ...receipt(), candidate: { ...receipt().candidate, candidateId: candidateId('tw-af-1', sha('e')) } })).toThrow(/candidateId/);
    expect(() => parse({ ...receipt(), changedPaths: [{ path: '../x', change: 'added', lfs: false, class: 'code' }] })).toThrow();
    // at most 5,000 changed paths (the runner fails limit_exceeded first)
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f/${i}.txt`, change: 'deleted' as const, lfs: false, class: 'code' as const }));
    expect(parse({ ...receipt(), lfsObjects: [], changedPaths: many(5_000) }).ok).toBe(true);
    expect(() => parse({ ...receipt(), lfsObjects: [], changedPaths: many(5_001) })).toThrow();
  });
});

describe('seed-workspace job', () => {
  it('grants canonical read and task-fork write only', () => {
    expect(jobRepoAccess(seedJob()).map((a) => [a.coords.repoName, a.access, a.role])).toEqual([
      ['site', 'read', 'canonical'],
      ['ws-tw-seed-1', 'write', 'task-fork'],
    ]);
    const job = { job: seedJob() };
    expect(authorizeCredentialRequest(job, { repo: artifactsCoords('site'), access: 'write' })).toMatchObject({ ok: false, reason: 'access_exceeds_job' });
    expect(authorizeCredentialRequest(job, { repo: artifactsCoords('site'), access: 'read' })).toMatchObject({ ok: true, role: 'canonical' });
    expect(authorizeCredentialRequest(job, { repo: artifactsCoords('ws-tw-seed-1', 'commonforge-org1-tasks'), access: 'write' })).toMatchObject({ ok: true, role: 'task-fork' });
  });

  it('refuses a task fork in the canonical namespace, the canonical repo as fork, a misnamed fork and non-branch refs', () => {
    const bad = [
      { ...seedJob(), taskFork: artifactsCoords('ws-tw-seed-1') },
      { ...seedJob(), taskFork: { ...artifactsCoords('site', 'commonforge-org1-tasks') } },
      { ...seedJob(), taskFork: artifactsCoords('ws-other', 'commonforge-org1-tasks') },
      { ...seedJob(), ref: 'refs/commonforge/candidates/a/b' },
      { ...seedJob(), canonical: artifactsCoords('site', 'commonforge-org1-tasks') },
      { ...seedJob(), baseSha: 'abc' },
    ];
    for (const j of bad) expect(IntegrationJobSchema.safeParse(j).success, JSON.stringify(j.taskFork)).toBe(false);
  });

  it('parses its receipt', () => {
    const r = parseRunnerResult('seed-workspace', {
      jobId: 'j1',
      ok: true,
      receipt: { jobId: 'j1', taskWorkspaceId: 'tw-seed-1', resourceId: 'res-site', ref: 'refs/heads/main', sha: sha('a'), seededAt: '2026-10-06T00:00:00.000Z' },
    });
    expect(r.ok).toBe(true);
  });
});

describe('IntegrationJob schemas', () => {
  it('accepts one valid job of every kind', () => {
    const jobs = allJobs();
    expect(jobs.map((j) => j.kind).sort()).toEqual([...INTEGRATION_JOB_KINDS].sort());
    for (const j of jobs) expect(IntegrationJobSchema.parse(j)).toEqual(j);
  });

  it('prepare-candidate retentionRef must be the candidate retention ref', () => {
    const j = { ...prepareJob(), retentionRef: 'refs/commonforge/candidates/other/x' };
    expect(IntegrationJobSchema.safeParse(j).success).toBe(false);
  });

  it('prepare-candidate refuses a canonical repo in the tasks namespace equal to the fork', () => {
    const j = prepareJob() as Extract<IntegrationJob, { kind: 'prepare-candidate' }>;
    expect(IntegrationJobSchema.safeParse({ ...j, canonical: j.candidate.fork }).success).toBe(false);
  });

  it('integrate: candidates need a target, targets are unique, refs are per proposal', () => {
    const j = integrateJob() as Extract<IntegrationJob, { kind: 'integrate' }>;
    expect(IntegrationJobSchema.safeParse({ ...j, targets: [] }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, candidates: [] }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, targets: [j.targets[0], j.targets[0]] }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, integrationRef: 'refs/commonforge/integrations/other/job-int-1' }).success).toBe(false);
    const other = frozenCandidate({ candidateId: candidateId('tw-2', sha('f')), taskWorkspaceId: 'tw-2' as never, sha: sha('f'), resourceId: res('res-api') });
    expect(IntegrationJobSchema.safeParse({ ...j, candidates: [...j.candidates, other] }).success).toBe(false);
  });

  it('integrate: targets may be empty iff the job carries asset changes (assets-only proposals)', () => {
    const j = integrateJob() as Extract<IntegrationJob, { kind: 'integrate' }>;
    const logo = { resourceId: res('res-brand'), baseManifestId: 'a'.repeat(64) as never, newManifestId: 'b'.repeat(64) as never };
    const assetsOnly = { ...j, candidates: [], targets: [], assetChanges: [logo] };
    expect(IntegrationJobSchema.safeParse(assetsOnly).success).toBe(true);
    // neither git targets nor asset changes: nothing to validate
    expect(IntegrationJobSchema.safeParse({ ...j, candidates: [], targets: [] }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, candidates: [], targets: [], assetChanges: [] }).success).toBe(false);
    // candidates and targets come together
    expect(IntegrationJobSchema.safeParse({ ...assetsOnly, candidates: j.candidates }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...assetsOnly, targets: j.targets }).success).toBe(false);
    // asset changes are unique; jobs with git targets (mixed proposals too) never carry them
    expect(IntegrationJobSchema.safeParse({ ...assetsOnly, assetChanges: [logo, logo] }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, assetChanges: [logo] }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, assetChanges: [] }).success).toBe(false);
    // jobs without the field parse unchanged (additive)
    expect(IntegrationJobSchema.parse(j)).not.toHaveProperty('assetChanges');
    // no canonical write and no push for an assets-only job; references stay read-only
    const parsed = IntegrationJobSchema.parse({ ...assetsOnly, references: [{ resourceId: res('res-site'), coords: artifactsCoords('site') }] });
    expect(jobRepoAccess(parsed)).toEqual([{ coords: artifactsCoords('site'), access: 'read', role: 'reference' }]);
    expect(jobAllowedPushRefs(parsed)).toEqual([]);
    expect(authorizeCredentialRequest({ job: parsed }, { repo: artifactsCoords('site'), access: 'write' })).toMatchObject({ ok: false, reason: 'access_exceeds_job' });
  });

  it('reconcile-ref only targets branch refs', () => {
    const base = allJobs()[2]!;
    expect(IntegrationJobSchema.safeParse({ ...base, ref: 'refs/commonforge/candidates/a/b' }).success).toBe(false);
  });

  it('build-edition and inventory enforce paths and limits', () => {
    const be = allJobs()[5] as Extract<IntegrationJob, { kind: 'build-edition' }>;
    expect(IntegrationJobSchema.safeParse({ ...be, sources: [{ ...be.sources[0]!, editionPathPrefix: '../x' }] }).success).toBe(false);
    const inv = allJobs()[7] as Extract<IntegrationJob, { kind: 'inventory' }>;
    expect(IntegrationJobSchema.safeParse({ ...inv, limits: { ...inv.limits, maxCompressionRatio: 0 } }).success).toBe(false);
  });

  it('jobs can never carry a credential-bearing URL', () => {
    const j = prepareJob() as Extract<IntegrationJob, { kind: 'prepare-candidate' }>;
    const bad = { ...j, canonical: { ...j.canonical, remoteUrl: 'https://u:tok@host/r.git' } };
    expect(IntegrationJobSchema.safeParse(bad).success).toBe(false);
  });
});

describe('SignedJob binding', () => {
  it('integrate integrationRef must embed the envelope jobId', async () => {
    const env = { jobId: 'job-int-1', issuedAt: '2026-10-06T10:00:00.000Z', expiresAt: '2026-10-06T10:10:00.000Z', credentialBroker: 'https://a.test/b' };
    const s = await signJob({ ...env, job: integrateJob('job-int-1') }, KEY_A);
    expect(SignedJobSchema.safeParse(s).success).toBe(true);
    await expect(signJob({ ...env, job: integrateJob('job-other') }, KEY_A)).rejects.toMatchObject({ code: 'invalid_job' });
  });

  it('jobIntegrationRef is unique per job and a valid ref', () => {
    expect(jobIntegrationRef(PROPOSAL_ID, 'job-1')).toBe('refs/commonforge/integrations/prop-1/job-1');
    expect(jobIntegrationRef(PROPOSAL_ID, 'job-1')).not.toBe(jobIntegrationRef(PROPOSAL_ID, 'job-2'));
  });
});

describe('jobRepoAccess (broker policy)', () => {
  it('grants canonical write only for prepare-candidate, integrate, reconcile-ref, staging-build and init-folder', () => {
    const byKind = Object.fromEntries(allJobs().map((j) => [j.kind, jobRepoAccess(j)]));
    const canonicalWrites = (k: string) =>
      byKind[k]!.filter((a) => a.access === 'write' && a.coords.namespace === 'commonforge-org1-canonical').length;
    expect(canonicalWrites('prepare-candidate')).toBe(1);
    expect(canonicalWrites('integrate')).toBe(1);
    expect(canonicalWrites('reconcile-ref')).toBe(1);
    expect(canonicalWrites('init-folder')).toBe(1);
    for (const k of ['preview-build', 'export', 'build-edition', 'edition-return', 'inventory', 'apply-files']) expect(canonicalWrites(k), k).toBe(0);
    expect(byKind['prepare-candidate']).toContainEqual({ coords: frozenCandidate().fork, access: 'read', role: 'task-fork' });
    expect(byKind['build-edition']).toContainEqual({ coords: artifactsCoords('ed-1', 'commonforge-org1-editions'), access: 'write', role: 'edition' });
    expect(byKind['edition-return']).toContainEqual({ coords: artifactsCoords('site-tw-ret-1', 'commonforge-org1-tasks'), access: 'write', role: 'task-fork' });
    expect(byKind['inventory']).toEqual([]);
  });
});

describe('RunnerResult', () => {
  it('parses a success per kind and a failure', () => {
    const ok = {
      jobId: 'job-1',
      ok: true,
      receipt: {
        ref: 'refs/heads/main',
        targetSha: sha('a'),
        observedSha: sha('a'),
        status: 'synced',
        reconciledAt: '2026-10-06T10:00:00.000Z',
      },
    };
    expect(parseRunnerResult('reconcile-ref', ok)).toMatchObject({ ok: true });
    expect(() => parseRunnerResult('integrate', ok)).toThrow();
    const fail = { jobId: 'job-1', ok: false, code: 'stale_base', detail: 'head moved' };
    expect(RunnerResultSchema.parse(fail)).toEqual(fail);
    expect(parseRunnerResult('integrate', fail)).toEqual(fail);
    expect(RunnerResultSchema.safeParse({ ...fail, code: 'nope' }).success).toBe(false);
  });

  it('parses inventory and build-edition receipts', () => {
    const inv = {
      jobId: 'job-1',
      ok: true,
      receipt: {
        jobId: 'job-1',
        intakeId: 'in-1',
        entries: [{ path: 'src/index.ts', size: 10, sha256: 'a'.repeat(64) }],
        rejected: [{ path: '../evil', reason: 'path_escape' }],
        totalBytes: 10,
        inventoriedAt: '2026-10-06T10:00:00.000Z',
      },
    };
    expect(parseRunnerResult('inventory', inv)).toMatchObject({ ok: true });
    const be = {
      jobId: 'job-2',
      ok: true,
      receipt: {
        jobId: 'job-2',
        editionId: 'ed-1',
        sha: sha('a'),
        revisionId: artRevisionId('ed-1', sha('a')),
        inventory: [{ editionPath: 'site/index.html', sha256: 'b'.repeat(64), size: 3 }],
        builtAt: '2026-10-06T10:00:00.000Z',
      },
    };
    expect(parseRunnerResult('build-edition', be)).toMatchObject({ ok: true });
  });
});

describe('repository identity and roles (I-2)', () => {
  const site = artifactsCoords('site');

  it('strict identity needs kind, namespace, repoId AND url; the loose test is only for must-differ', () => {
    const urlOnly = { ...site, repoId: 'other-site' };
    const idOnly = { ...site, remoteUrl: 'https://evil.test/git/site.git' };
    expect(mayBeSameRepo(site, urlOnly)).toBe(true);
    expect(mayBeSameRepo(site, idOnly)).toBe(true);
    expect(sameRepoIdentity(site, urlOnly)).toBe(false);
    expect(sameRepoIdentity(site, idOnly)).toBe(false);
    expect(sameRepoIdentity(site, { ...site })).toBe(true);
  });

  it('build-edition may not write a canonical or task repo; edition-return may only write a task fork', () => {
    const be = allJobs()[5] as Extract<IntegrationJob, { kind: 'build-edition' }>;
    expect(IntegrationJobSchema.safeParse({ ...be, editionRepo: artifactsCoords('lib') }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...be, editionRepo: artifactsCoords('lib', 'commonforge-org1-tasks') }).success).toBe(false);
    const er = allJobs()[6] as Extract<IntegrationJob, { kind: 'edition-return' }>;
    expect(IntegrationJobSchema.safeParse({ ...er, candidateFork: { ...er.candidateFork, coords: artifactsCoords('lib') } }).success).toBe(false);
    expect(
      IntegrationJobSchema.safeParse({ ...er, candidateFork: { ...er.candidateFork, coords: artifactsCoords('x', 'commonforge-org1-editions') } }).success,
    ).toBe(false);
  });

  it('prepare-candidate canonical must be in the canonical namespace and the fork in tasks', () => {
    const j = prepareJob() as Extract<IntegrationJob, { kind: 'prepare-candidate' }>;
    expect(IntegrationJobSchema.safeParse({ ...j, canonical: artifactsCoords('site', 'commonforge-org1-editions') }).success).toBe(false);
  });

  it('refuses jobs naming two repos that only partially match', () => {
    const j = integrateJob() as Extract<IntegrationJob, { kind: 'integrate' }>;
    const confusing = { resourceId: res('res-lib'), coords: { ...site, repoId: 'lib' } };
    expect(IntegrationJobSchema.safeParse({ ...j, references: [confusing] }).success).toBe(false);
  });
});

describe('authorizeCredentialRequest (I-2)', () => {
  const site = artifactsCoords('site');
  const canonicalWriters = new Set(['prepare-candidate', 'integrate', 'reconcile-ref', 'staging-build', 'init-folder']);

  it('grants canonical write only to prepare-candidate, integrate, reconcile-ref, staging-build and init-folder', () => {
    expect([...CANONICAL_WRITE_KINDS].sort()).toEqual([...canonicalWriters].sort());
    for (const job of allJobs()) {
      const r = authorizeCredentialRequest({ job }, { repo: site, access: 'write' });
      expect(r.ok, job.kind).toBe(canonicalWriters.has(job.kind));
      if (r.ok) expect(r).toMatchObject({ role: 'canonical', access: 'write' });
      else expect(['access_exceeds_job', 'repo_not_in_job']).toContain(r.reason);
    }
  });

  it('grants reads of named repos and writes of the edition / task-fork repos', () => {
    const [prep, , , , , be, er] = allJobs();
    expect(authorizeCredentialRequest({ job: prep! }, { repo: frozenCandidate().fork, access: 'read' })).toMatchObject({ ok: true, role: 'task-fork' });
    expect(authorizeCredentialRequest({ job: prep! }, { repo: frozenCandidate().fork, access: 'write' })).toMatchObject({ ok: false, reason: 'access_exceeds_job' });
    expect(authorizeCredentialRequest({ job: be! }, { repo: artifactsCoords('ed-1', 'commonforge-org1-editions'), access: 'write' })).toMatchObject({ ok: true, role: 'edition' });
    expect(authorizeCredentialRequest({ job: er! }, { repo: artifactsCoords('site-tw-ret-1', 'commonforge-org1-tasks'), access: 'write' })).toMatchObject({ ok: true, role: 'task-fork' });
  });

  it('refuses url-only and id-only matches and returns the JOB coordinates, never the request', () => {
    const job = prepareJob();
    expect(authorizeCredentialRequest({ job }, { repo: { ...site, repoId: 'other' }, access: 'write' })).toMatchObject({ ok: false, reason: 'identity_mismatch' });
    expect(authorizeCredentialRequest({ job }, { repo: { ...site, remoteUrl: 'https://evil.test/x.git' }, access: 'write' })).toMatchObject({
      ok: false,
      reason: 'identity_mismatch',
    });
    expect(authorizeCredentialRequest({ job }, { repo: artifactsCoords('unrelated'), access: 'read' })).toMatchObject({ ok: false, reason: 'repo_not_in_job' });
    const req = { ...site };
    const r = authorizeCredentialRequest({ job }, { repo: req, access: 'write' });
    expect(r.ok && r.coords).toBe((job as Extract<IntegrationJob, { kind: 'prepare-candidate' }>).canonical);
    expect(r.ok && r.coords).not.toBe(req);
  });
});

describe('integrate mergeBases', () => {
  const asInt = () => integrateJob() as Extract<IntegrationJob, { kind: 'integrate' }>;
  const bases = (j: ReturnType<typeof asInt>) => Object.fromEntries(j.candidates.map((c) => [c.candidateId, sha('b')]));
  it('needs one entry per candidate, nothing else', () => {
    const j = asInt();
    expect(IntegrationJobSchema.safeParse({ ...j, mergeBases: bases(j) }).success).toBe(true);
    // the base must be the candidate's recorded base
    expect(IntegrationJobSchema.safeParse({ ...j, mergeBases: Object.fromEntries(j.candidates.map((c) => [c.candidateId, 'd'.repeat(40)])) }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, mergeBases: Object.fromEntries(j.candidates.map((c) => [c.candidateId, 'not-a-sha'])) }).success).toBe(false);
    // a malformed or non-git base is refused, never thrown on
    for (const bad of ['garbage', '', 'r2m:m-1', 'art:site:zzzz']) {
      const bj = { ...j, candidates: [{ ...j.candidates[0]!, baseRevision: bad }], mergeBases: bases(j) };
      expect(() => IntegrationJobSchema.safeParse(bj)).not.toThrow();
      expect(IntegrationJobSchema.safeParse(bj).success).toBe(false);
    }
    // two candidates, one entry missing
    const other = frozenCandidate({ candidateId: candidateId('tw-2', sha('f')), taskWorkspaceId: 'tw-2' as never, sha: sha('f') });
    const two = { ...j, candidates: [...j.candidates, other] };
    expect(IntegrationJobSchema.safeParse({ ...two, mergeBases: bases(j) }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...two, mergeBases: { ...bases(j), [other.candidateId]: bases(j)[j.candidates[0]!.candidateId]! } }).success).toBe(true);
    expect(IntegrationJobSchema.safeParse({ ...two, mergeBases: { ...bases(j), ['__proto__']: sha('b') } }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, mergeBases: {} }).success).toBe(false);
    expect(IntegrationJobSchema.safeParse({ ...j, mergeBases: { ...bases(j), ['cand:x:' + 'b'.repeat(40)]: 'c'.repeat(40) } }).success).toBe(false);
  });
});

describe('staging-build per-build ref', () => {
  it('may push refs/commonforge/staging-builds/<buildId> (absent) besides refs/commonforge/staging (observed)', () => {
    const job = stagingBuildJob() as Extract<IntegrationJob, { kind: 'staging-build' }>;
    const refs = jobAllowedPushRefs(job).map((p) => [p.ref, p.lease]);
    expect(refs).toContainEqual(['refs/commonforge/staging', 'observed']);
    expect(refs).toContainEqual([stagingBuildRef(job.buildId), 'absent']);
    expect(stagingBuildRef('b-1')).toBe('refs/commonforge/staging-builds/b-1');
  });
});

describe('staging-build job', () => {
  const stagingJob = stagingBuildJob;
  const target = () => (stagingJob() as Extract<IntegrationJob, { kind: 'staging-build' }>).targets[0]!;

  it('is a canonical write that pushes only the per-build ref (absent lease) and refs/commonforge/staging (observed lease) and a 1 h lifetime', () => {
    const job = stagingJob();
    expect(IntegrationJobSchema.safeParse(job).success).toBe(true);
    expect(jobRepoAccess(job).map((a) => [a.coords.repoName, a.access, a.role])).toEqual([['site', 'write', 'canonical']]);
    expect(jobAllowedPushRefs(job)).toEqual([
      { coords: target().canonical, ref: 'refs/commonforge/staging-builds/b-1', lease: 'absent' },
      { coords: target().canonical, ref: STAGING_REF, lease: 'observed' },
    ]);
    expect(STAGING_REF).toBe('refs/commonforge/staging');
    expect(defaultMaxLifetimeSeconds('staging-build')).toBe(3_600);
  });

  it('binds the receipt to the job: build id and the same resources in the same order', () => {
    const job = stagingJob();
    const signedJob = { jobId: 'job-stg-1', job } as never;
    const good = { jobId: 'job-stg-1', ok: true, receipt: { jobId: 'job-stg-1', buildId: 'b-1', results: [{ resourceId: 'res-site', sha: sha('d'), revisionId: artRevisionId('site', sha('d')) }], builtAt: '2026-10-07T00:00:00.000Z' } };
    expect(parseRunnerResultForJob(signedJob, good).ok).toBe(true);
    expect(() => parseRunnerResultForJob(signedJob, { ...good, receipt: { ...good.receipt, buildId: 'b-2' } })).toThrow(/buildId/);
    expect(() => parseRunnerResultForJob(signedJob, { ...good, receipt: { ...good.receipt, results: [] } })).toThrow(/resources/);
    expect(() => parseRunnerResultForJob(signedJob, { ...good, receipt: { ...good.receipt, results: [{ ...good.receipt.results[0]!, revisionId: artRevisionId('site', sha('e')) }] } })).toThrow(/revisionId/);
  });
});

describe('init-folder job (folders phase 4)', () => {
  const ok = (j: unknown) => IntegrationJobSchema.safeParse(j).success;
  const withFiles = (files: unknown) => ({ ...initFolderJob(), files });
  const file = (path: string, content = 'x\n') => ({ path, content });

  it('accepts the first commit of a folder and is strict', () => {
    const j = initFolderJob();
    expect(IntegrationJobSchema.parse(j)).toEqual(j);
    expect(ok({ ...j, parent: sha('a') })).toBe(false);
    expect(ok({ ...j, author: { ...j.author, extra: 1 } })).toBe(false);
    expect(ok(withFiles([{ ...file('a.txt'), mode: '100755' }]))).toBe(false);
    // the canonical repository must be a canonical one
    expect(ok({ ...j, canonical: artifactsCoords('site', 'commonforge-org1-tasks') })).toBe(false);
  });

  it('refuses too many files, a file over 64 KiB, bad, nested or duplicate paths, no files, and a time that is not whole-second ISO', () => {
    expect(ok(withFiles(Array.from({ length: 8 }, (_, i) => file(`f${i}.txt`))))).toBe(true);
    expect(ok(withFiles(Array.from({ length: 9 }, (_, i) => file(`f${i}.txt`))))).toBe(false);
    expect(ok(withFiles([file('big.txt', 'x'.repeat(65_536))]))).toBe(true);
    expect(ok(withFiles([file('big.txt', 'x'.repeat(65_537))]))).toBe(false);
    // bytes, not characters
    expect(ok(withFiles([file('big.txt', 'é'.repeat(32_769))]))).toBe(false);
    for (const bad of ['', '../x', '/abs', 'a\\b', 'docs/readme.md', '.git', '.commonforge', 'a'.repeat(1025), 'e\u0301.txt']) {
      expect(ok(withFiles([file(bad)])), JSON.stringify(bad)).toBe(false);
    }
    expect(ok(withFiles([file('README.md'), file('README.md')]))).toBe(false);
    expect(ok(withFiles([]))).toBe(false);
    for (const t of ['2026-10-11T09:30:00.500Z', '2026-10-11T09:30:00Z', '2026-10-11 09:30:00', '2026-10-11T09:30:00.000+02:00', 'yesterday']) {
      expect(ok({ ...initFolderJob(), commitTime: t }), t).toBe(false);
    }
    expect(ok({ ...initFolderJob(), message: '' })).toBe(false);
    expect(ok({ ...initFolderJob(), author: { name: 'Eve <evil@x>', email: 'e@x.test' } })).toBe(false);
    expect(ok({ ...initFolderJob(), author: { name: 'Eve', email: 'e@x.test>\nX' } })).toBe(false);
  });

  it('writes canonical only, pushes only main (must not exist), with a 1 h lifetime', () => {
    const j = initFolderJob();
    expect(jobRepoAccess(j)).toEqual([{ coords: j.canonical, access: 'write', role: 'canonical' }]);
    expect(jobAllowedPushRefs(j)).toEqual([{ coords: j.canonical, ref: 'refs/heads/main', lease: 'absent' }]);
    expect(CANONICAL_WRITE_KINDS).toContain('init-folder');
    expect(defaultMaxLifetimeSeconds('init-folder')).toBe(3_600);
  });

  const receipt = (over: Record<string, unknown> = {}) => ({ jobId: 'job-if', resourceId: 'res-site', commitSha: sha('d'), status: 'created', ...over });
  const parse = (r: unknown) => parseRunnerResultForJob({ jobId: 'job-if', job: initFolderJob() }, { jobId: 'job-if', ok: true, receipt: r });

  it('binds its receipt to the job', () => {
    expect(parse(receipt()).ok).toBe(true);
    expect(parse(receipt({ status: 'already' })).ok).toBe(true);
    expect(() => parse(receipt({ status: 'synced' }))).toThrow();
    expect(() => parse(receipt({ commitSha: 'abc' }))).toThrow();
    expect(() => parse(receipt({ resourceId: 'res-other' }))).toThrow(/resourceId/);
    expect(() => parse(receipt({ jobId: 'job-other' }))).toThrow();
    expect(parseRunnerResult('init-folder', { jobId: 'j', ok: false, code: 'branch_not_empty', detail: 'main exists' })).toMatchObject({ ok: false, code: 'branch_not_empty' });
  });
});
