/**
 * Integration runner job protocol (plan §B.8): the `IntegrationJob` union, the `SignedJob`
 * envelope, `RunnerResult`, receipts for the job kinds core does not know, the credential broker
 * wire shapes and the broker's per-kind repository access policy.
 *
 * Jobs carry coordinates only. Credentials are never part of a job: the runner asks
 * `credentialBroker` for short-lived tokens, presenting the signed job.
 */
import { z } from 'zod';
import {
  AssetManifestChangeSchema,
  AssetManifestSchema,
  BuildRecipeSchema,
  CandidateIdSchema,
  CheckSpecSchema,
  ContractSpecSchema,
  EditionInventoryEntrySchema,
  EditionManifestServerSideSchema,
  EditionReturnReceiptSchema,
  ExportReceiptSchema,
  ExportSinkSchema,
  FrozenCandidateSchema,
  GitRefSchema,
  GitShaSchema,
  IdSegmentSchema,
  IntegrationReceiptSchema,
  MountNameSchema,
  NonNegativeIntSchema,
  OperationSchema,
  PathPrefixSchema,
  PositiveIntSchema,
  PreparedReceiptSchema,
  PreviewReceiptSchema,
  ProjectSnapshotSchema,
  ProposalHashSchema,
  ProposalIdSchema,
  ReconcileResultSchema,
  RelativePathSchema,
  SeedWorkspaceReceiptSchema,
  RemoteUrlSchema,
  RepoCoordsSchema,
  ResourceIdSchema,
  RevisionIdSchema,
  RunnerFailureCodeSchema,
  Sha256HexSchema,
  SnapshotIdSchema,
  TaskWorkspaceIdSchema,
  TimestampSchema,
  ValidationEvidenceSchema,
  candidateRetentionRef,
  hasAlwaysProtectedSegment,
  integrationJobRef,
  parseCandidateId,
  revisionCommitSha,
  type RepoCoords,
  type RunnerJobKind,
  type RunnerReceiptByKind,
} from '@commonforge-org/core';
import { APPLY_FILES_LIMITS } from './apply-files.js';
import { RunnerProtocolError } from './errors.js';
import { KID_RE } from './hmac.js';

// =============================================================================================
// Helpers
// =============================================================================================

/**
 * Loose "might be the same repository" test (kind+namespace+repoId OR remoteUrl). Conservative,
 * so it is used only where two repos MUST differ (e.g. a task fork vs canonical). Never use it to
 * grant access; use {@link sameRepoIdentity}.
 */
export function mayBeSameRepo(a: RepoCoords, b: RepoCoords): boolean {
  return (a.kind === b.kind && a.namespace === b.namespace && a.repoId === b.repoId) || a.remoteUrl === b.remoteUrl;
}

/** Strict identity used for credential decisions: kind, namespace, repoId AND remoteUrl all equal. */
export function sameRepoIdentity(a: RepoCoords, b: RepoCoords): boolean {
  return a.kind === b.kind && a.namespace === b.namespace && a.repoId === b.repoId && a.remoteUrl === b.remoteUrl;
}

/** The role a repository plays for a job; decides which Artifacts namespace it must live in. */
export type RepoRole = 'canonical' | 'task-fork' | 'edition' | 'reference';

/** Namespace suffix (`commonforge-<orgId>-canonical|tasks|editions`, plan §A.7) per role. */
const ROLE_NAMESPACE: Record<RepoRole, 'canonical' | 'tasks' | 'editions'> = {
  canonical: 'canonical',
  reference: 'canonical',
  'task-fork': 'tasks',
  edition: 'editions',
};

/** `canonical` | `tasks` | `editions` from the namespace suffix, or null when it has none. */
export function namespaceKind(coords: RepoCoords): 'canonical' | 'tasks' | 'editions' | null {
  const m = /-(canonical|tasks|editions)$/.exec(coords.namespace);
  return m ? (m[1] as 'canonical' | 'tasks' | 'editions') : null;
}

/**
 * True when `coords` may play `role`. Artifacts repos must live in the role's namespace exactly;
 * local-git repos may use any namespace without a role suffix (dev/test), but never another role's.
 */
export function namespaceFitsRole(coords: RepoCoords, role: RepoRole): boolean {
  const ns = namespaceKind(coords);
  if (coords.kind === 'artifacts') return ns === ROLE_NAMESPACE[role];
  return ns === null || ns === ROLE_NAMESPACE[role];
}

/**
 * Ref an `integrate` job pushes its result to: unique per job, because concurrent pushes to the
 * same new ref are refused by Artifacts (spike S3). `refs/commonforge/integrations/<proposalId>/<jobId>`.
 * Nothing may push the bare (deprecated) `integrationRef(proposalId)` from core, or this namespace would
 * conflict. Same value as core's `integrationJobRef`, with a `RunnerProtocolError('invalid_job')`.
 */
export function jobIntegrationRef(proposalId: string, jobId: string): string {
  try {
    return integrationJobRef(proposalId, jobId);
  } catch {
    throw new RunnerProtocolError('invalid_job', `invalid integration ref ${JSON.stringify(`refs/commonforge/integrations/${proposalId}/${jobId}`)}`);
  }
}

const isCommitRevision = (r: string) => revisionCommitSha(r as never) !== null;

// =============================================================================================
// Job kinds
// =============================================================================================

/**
 * Every job kind: core's `RunnerJobKind` plus `build-edition` (fresh edition repo from an
 * allowlist, plan §F/AT-26) and `inventory` (deterministic ZIP intake listing, Task 16).
 */
export const INTEGRATION_JOB_KINDS = [
  'prepare-candidate',
  'integrate',
  'reconcile-ref',
  'preview-build',
  'export',
  'edition-return',
  'build-edition',
  'inventory',
  'seed-workspace',
  'release-build',
  'release-deploy',
  'apply-files',
  'staging-build',
  'init-folder',
] as const;
export const IntegrationJobKindSchema = z.enum(INTEGRATION_JOB_KINDS);
export type IntegrationJobKind = z.infer<typeof IntegrationJobKindSchema>;

// Compile-time guard: core's kinds are a subset of ours.
const _coreKindsCovered: readonly IntegrationJobKind[] = [] as RunnerJobKind[];
void _coreKindsCovered;

// =============================================================================================
// Job schemas
// =============================================================================================

/** Object-store key prefix: relative, `/`-separated, ending in `/`, no `..`. */
export const OutputPrefixSchema = z
  .string()
  .min(2)
  .max(512)
  .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)+$/, 'expected a relative key prefix ending in /')
  .refine((s) => !s.split('/').includes('..'), 'no .. segments');

/** A Workers script name. */
export const WorkerNameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'invalid Worker name');

/**
 * A Worker a release may deploy: never one of the platform's own (`commonforge*`). The control
 * plane additionally forces `<deployPrefix>-<orgId>-` (Task 22 review C-1).
 */
export const ReleaseWorkerNameSchema = WorkerNameSchema.refine((n) => !n.startsWith('commonforge'), 'commonforge* Worker names belong to the platform');

export const PrepareCandidateJobSchema = z
  .object({
    kind: z.literal('prepare-candidate'),
    candidate: FrozenCandidateSchema,
    /** canonical repository that retains the candidate objects */
    canonical: RepoCoordsSchema,
    /** must equal `candidateRetentionRef(candidate.candidateId)` */
    retentionRef: GitRefSchema,
  })
  .superRefine((j, ctx) => {
    const parsed = parseCandidateId(j.candidate.candidateId);
    if (parsed.sha !== j.candidate.sha || parsed.taskWorkspaceId !== j.candidate.taskWorkspaceId) {
      ctx.addIssue({ code: 'custom', message: 'candidateId does not match candidate sha/workspace', path: ['candidate', 'candidateId'] });
    }
    if (j.retentionRef !== candidateRetentionRef(j.candidate.candidateId)) {
      ctx.addIssue({ code: 'custom', message: 'retentionRef must be the candidate retention ref', path: ['retentionRef'] });
    }
    if (mayBeSameRepo(j.canonical, j.candidate.fork)) {
      ctx.addIssue({ code: 'custom', message: 'canonical repo must differ from the task fork', path: ['canonical'] });
    }
  });

export const IntegrationTargetSchema = z.object({
  resourceId: ResourceIdSchema,
  canonical: RepoCoordsSchema,
  /** ledger head the merge must start from; a different current head → `stale_base` */
  expectedHead: RevisionIdSchema.refine(isCommitRevision, 'expectedHead must be a git revision'),
});

export const IntegrateJobSchema = z
  .object({
    kind: z.literal('integrate'),
    proposalId: ProposalIdSchema,
    /** bound into the produced ValidationEvidence */
    proposalHash: ProposalHashSchema,
    /** the proposal's BASE snapshot: must-match-accepted entries pin the heads the merge starts from */
    baseSnapshot: ProjectSnapshotSchema,
    /**
     * The proposal's candidate snapshot (Task 16 review C-1). Integration evidence is bound to it
     * (`ValidationEvidence.snapshotId`), because the ledger checks evidence against the proposal's
     * candidate snapshot. Signed with the rest of the job.
     */
    candidateSnapshotId: SnapshotIdSchema,
    /**
     * Git candidates and their targets. Both are empty for an **assets-only** proposal (follow-up
     * Task 23): the job then merges and pushes nothing, runs the policy checks and contracts against
     * the snapshot's git mounts (all references) and signs evidence with an empty `mergeOutcome`.
     */
    candidates: z.array(FrozenCandidateSchema),
    targets: z.array(IntegrationTargetSchema),
    /**
     * The proposal's asset manifest changes (signature-covered), for **assets-only** jobs only:
     * present and non-empty exactly when `targets` is empty. A mixed proposal's job carries targets
     * and no `assetChanges`, byte-identical to jobs from before the field existed (runners that
     * predate it strip unknown fields, which would break the job's signature). Evidence binds the
     * manifests through `proposalHash` (core `computeProposalHash` covers `assetManifestChanges`).
     */
    assetChanges: z.array(AssetManifestChangeSchema).optional(),
    /** read-only repositories needed for checks/contracts (reference mounts) */
    references: z.array(z.object({ resourceId: ResourceIdSchema, coords: RepoCoordsSchema })).optional(),
    /** `jobIntegrationRef(proposalId, jobId)`; bound to the envelope jobId by SignedJobSchema */
    integrationRef: GitRefSchema,
    checks: z.array(CheckSpecSchema).default([]),
    contracts: z.array(ContractSpecSchema).default([]),
    /**
     * Promotion builds: each candidate's own base commit (usually a staging commit). When present,
     * every candidate is applied with its base as the explicit merge base and committed with a
     * single parent (only its own edits reach the target); no candidate is skipped as "already
     * contained". Absent: the ordinary two-parent merge, unchanged.
     */
    mergeBases: z.record(CandidateIdSchema, GitShaSchema).optional(),
  })
  .superRefine((j, ctx) => {
    if (j.mergeBases !== undefined) {
      const ids = new Set(j.candidates.map((c) => c.candidateId as string));
      for (const c of j.candidates) {
        const id = c.candidateId as string;
        if (!Object.hasOwn(j.mergeBases, id)) ctx.addIssue({ code: 'custom', message: `mergeBases lacks candidate ${id}`, path: ['mergeBases'] });
        else {
          // a malformed or non-git baseRevision is an issue, never a throw (revisionCommitSha throws on those)
          let want: string | null = null;
          try {
            want = revisionCommitSha(c.baseRevision as never);
          } catch {
            want = null;
          }
          if (want === null || j.mergeBases[c.candidateId] !== want) {
            ctx.addIssue({ code: 'custom', message: `mergeBases for ${id} must equal the candidate's recorded git base`, path: ['mergeBases', id] });
          }
        }
      }
      for (const k of Object.keys(j.mergeBases)) if (!ids.has(k)) ctx.addIssue({ code: 'custom', message: `mergeBases names unknown candidate ${k}`, path: ['mergeBases', k] });
    }
    const targets = new Set(j.targets.map((t) => t.resourceId as string));
    if (targets.size !== j.targets.length) ctx.addIssue({ code: 'custom', message: 'duplicate target resource', path: ['targets'] });
    const assets = j.assetChanges ?? [];
    // targets may be empty iff the proposal has asset changes; candidates and targets come together
    if (j.targets.length === 0 && assets.length === 0) ctx.addIssue({ code: 'custom', message: 'an integrate job needs git targets or asset changes', path: ['targets'] });
    if ((j.candidates.length === 0) !== (j.targets.length === 0)) ctx.addIssue({ code: 'custom', message: 'candidates and targets must both be empty or both be non-empty', path: ['candidates'] });
    const assetIds = new Set(assets.map((a) => a.resourceId as string));
    if (assetIds.size !== assets.length) ctx.addIssue({ code: 'custom', message: 'duplicate asset change resource', path: ['assetChanges'] });
    if (j.targets.length > 0 && j.assetChanges !== undefined) ctx.addIssue({ code: 'custom', message: 'assetChanges is only for assets-only jobs (no git targets)', path: ['assetChanges'] });
    j.candidates.forEach((c, i) => {
      if (!targets.has(c.resourceId)) {
        ctx.addIssue({ code: 'custom', message: `candidate resource ${c.resourceId} has no target`, path: ['candidates', i] });
      }
    });
    const prefix = `refs/commonforge/integrations/${j.proposalId}/`;
    const rest = j.integrationRef.startsWith(prefix) ? j.integrationRef.slice(prefix.length) : '';
    if (!rest || rest.includes('/')) {
      ctx.addIssue({ code: 'custom', message: `integrationRef must be ${prefix}<jobId>`, path: ['integrationRef'] });
    }
    const mounts = new Set(j.baseSnapshot.entries.map((e) => e.mountName));
    j.checks.forEach((c, i) => {
      if (!mounts.has(c.mountName)) ctx.addIssue({ code: 'custom', message: `unknown mount ${c.mountName}`, path: ['checks', i, 'mountName'] });
    });
    j.contracts.forEach((c, i) => {
      if (!mounts.has(c.producerOutput.mountName)) {
        ctx.addIssue({ code: 'custom', message: `unknown mount ${c.producerOutput.mountName}`, path: ['contracts', i] });
      }
    });
  });

export const ReconcileRefJobSchema = z.object({
  kind: z.literal('reconcile-ref'),
  resourceId: ResourceIdSchema.optional(),
  canonical: RepoCoordsSchema,
  /** a branch ref, normally `refs/heads/main`; updated with --force-with-lease */
  ref: GitRefSchema.refine((r) => r.startsWith('refs/heads/'), 'reconcile-ref only updates refs/heads/*'),
  targetSha: GitShaSchema,
  /** lease: the sha the ref must currently have (null: must not exist) */
  expectedCurrentSha: GitShaSchema.nullable(),
});

export const PreviewBuildJobSchema = z
  .object({
    kind: z.literal('preview-build'),
    previewId: IdSegmentSchema,
    integrationSha: z.record(ResourceIdSchema, GitShaSchema),
    /** where each mount's integration sha is fetched from (read-only) */
    sources: z.array(z.object({ resourceId: ResourceIdSchema, mountName: MountNameSchema, canonical: RepoCoordsSchema })).min(1),
    recipe: BuildRecipeSchema,
    ttlSeconds: z.number().int().min(60).max(7 * 86_400).optional(),
    /**
     * Object-store prefix the outputs are written under (Task 22: `org/<org>/previews/<previewId>/`,
     * the only prefix the Worker lets this job write). The static site goes to `<prefix>site/`,
     * each bundle to `<prefix>bundles/<name>/`. Default (dev runners): `previews/<previewId>/`.
     */
    outputPrefix: OutputPrefixSchema.optional(),
    /**
     * Server-side bundles the preview host runs (Task 22: the api Worker bundle, run with fixture
     * bindings only). Each directory is published like the static output.
     */
    bundles: z.array(z.object({ name: IdSegmentSchema, mountName: MountNameSchema, path: PathPrefixSchema })).max(4).optional(),
  })
  .superRefine((j, ctx) => {
    const mounts = new Set(j.sources.map((s) => s.mountName as string));
    (j.bundles ?? []).forEach((b, i) => {
      if (!mounts.has(b.mountName)) ctx.addIssue({ code: 'custom', message: `unknown mount ${b.mountName}`, path: ['bundles', i] });
    });
    if (j.outputPrefix !== undefined && !j.outputPrefix.endsWith(`previews/${j.previewId}/`)) {
      ctx.addIssue({ code: 'custom', message: 'outputPrefix must end with previews/<previewId>/', path: ['outputPrefix'] });
    }
    if (mounts.size !== j.sources.length) ctx.addIssue({ code: 'custom', message: 'duplicate mount', path: ['sources'] });
    j.sources.forEach((s, i) => {
      if (!(s.resourceId in j.integrationSha)) ctx.addIssue({ code: 'custom', message: 'source without integrationSha', path: ['sources', i] });
    });
    j.recipe.steps.forEach((s, i) => {
      if (!mounts.has(s.mountName)) ctx.addIssue({ code: 'custom', message: `unknown mount ${s.mountName}`, path: ['recipe', 'steps', i] });
    });
  });

export const KvBindingSchema = z.object({ binding: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), id: z.string().regex(/^[0-9a-f]{32}$/) });
export const D1BindingSchema = z.object({
  binding: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
});
export type D1Binding = z.infer<typeof D1BindingSchema>;

/** Server-owned production environment of one release target (part of the release's envDigest). */
export const ReleaseTargetEnvironmentSchema = z.object({
  vars: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4096)).default({}),
  kvNamespaces: z.array(KvBindingSchema).max(16).default([]),
  /** D1 databases bound to the target (staging: platform-created per project; production: org-owned, `deploy-resources` kind d1) */
  d1Databases: z.array(D1BindingSchema).max(8).optional(),
  /** files or directories, relative to the target's mount, copied into the build output's data area (`<target>/__data/`): migrations, seed (production: migrations folders only) */
  data: z.array(RelativePathSchema).max(200).optional(),
  /**
   * compatibility flags added to the source's own (server-set, staging only): a staging Worker whose
   * capture vars point at the platform sink needs `global_fetch_strictly_public`, because Cloudflare
   * refuses a Worker's fetch to another workers.dev Worker on the same account (error 1042)
   */
  compatibilityFlags: z.array(z.enum(['global_fetch_strictly_public'])).max(4).optional(),
});
export type ReleaseTargetEnvironment = z.infer<typeof ReleaseTargetEnvironmentSchema>;

/** Release (Task 22): one deployable unit of a release, built from one mount. */
export const ReleaseTargetSchema = z.object({
  targetId: IdSegmentSchema,
  /** `worker`: a bundled Worker module (no further bundling at deploy); `assets`: a static-assets-only Worker */
  kind: z.enum(['worker', 'assets']),
  mountName: MountNameSchema,
  /** mount-relative build output directory */
  outputPath: PathPrefixSchema,
  /** `worker` targets: the entry module inside `outputPath` */
  main: RelativePathSchema.optional(),
  /** the production Worker this target is deployed as (server-owned; never taken from the source) */
  workerName: ReleaseWorkerNameSchema,
});
export type ReleaseTarget = z.infer<typeof ReleaseTargetSchema>;

/**
 * Deploy configuration of a target: data only, nothing that executes. `vars` come from the
 * source's `wrangler.jsonc` (read before any build step ran) overlaid with the server-owned
 * release environment; `COMMONFORGE_RELEASE_ID` is always set to the release.
 */
export const ReleaseTargetConfigSchema = z.object({
  compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  compatibilityFlags: z.array(z.string().regex(/^[a-z0-9_]{1,64}$/)).max(32).default([]),
  vars: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4096)).default({}),
  notFoundHandling: z.enum(['single-page-application', '404-page', 'none']).optional(),
  /** production KV bindings: server-owned environment only (never from the source) */
  kvNamespaces: z.array(KvBindingSchema).max(16).default([]),
  /** D1 bindings: server-owned environment only; omitted (not empty) when there are none, so older digests stay valid */
  d1Databases: z.array(D1BindingSchema).max(8).optional(),
});
export type ReleaseTargetConfig = z.infer<typeof ReleaseTargetConfigSchema>;

export const ReleaseFileSchema = z.object({ path: RelativePathSchema, sha256: Sha256HexSchema, size: NonNegativeIntSchema });
export type ReleaseFile = z.infer<typeof ReleaseFileSchema>;

/**
 * Build the release outputs at the accepted shas (read only), with the server-owned recipe, and
 * store them under `outputPrefix<targetId>/`. The receipt carries every file's sha256, each
 * target's digest and the `outputDigest` the publish approval binds (AT-33). No token, no deploy.
 */
export const ReleaseBuildJobSchema = z
  .object({
    kind: z.literal('release-build'),
    releaseId: IdSegmentSchema,
    acceptedVersionId: IdSegmentSchema,
    sources: z.array(z.object({ resourceId: ResourceIdSchema, mountName: MountNameSchema, canonical: RepoCoordsSchema, sha: GitShaSchema })).min(1),
    recipe: BuildRecipeSchema,
    targets: z.array(ReleaseTargetSchema).min(1).max(8),
    /** server-owned production environment per targetId (vars overlay + bindings; part of the envDigest) */
    environment: z.record(z.string(), ReleaseTargetEnvironmentSchema).default({}),
    /** `org/<org>/releases/<releaseId>/` */
    outputPrefix: OutputPrefixSchema,
  })
  .superRefine((j, ctx) => {
    const mounts = new Set(j.sources.map((s) => s.mountName as string));
    if (mounts.size !== j.sources.length) ctx.addIssue({ code: 'custom', message: 'duplicate mount', path: ['sources'] });
    j.recipe.steps.forEach((s, i) => {
      if (!mounts.has(s.mountName)) ctx.addIssue({ code: 'custom', message: `unknown mount ${s.mountName}`, path: ['recipe', 'steps', i] });
    });
    const ids = new Set<string>();
    j.targets.forEach((t, i) => {
      if (!mounts.has(t.mountName)) ctx.addIssue({ code: 'custom', message: `unknown mount ${t.mountName}`, path: ['targets', i] });
      if (ids.has(t.targetId)) ctx.addIssue({ code: 'custom', message: 'duplicate targetId', path: ['targets', i] });
      ids.add(t.targetId);
      if (t.kind === 'worker' && !t.main) ctx.addIssue({ code: 'custom', message: 'worker targets need main', path: ['targets', i, 'main'] });
    });
    if (!j.outputPrefix.endsWith(`releases/${j.releaseId}/`)) ctx.addIssue({ code: 'custom', message: 'outputPrefix must end with releases/<releaseId>/', path: ['outputPrefix'] });
    // D1 bindings and data files belong to a target of this job. Production targets may carry them
    // too (staging phase 2, R8): the Worker, which builds the job, binds only org-owned D1 there and
    // derives production data from the declared migrations folders only (never a seed).
    for (const [targetId, env] of Object.entries(j.environment)) {
      if (!(env.d1Databases?.length || env.data?.length)) continue;
      if (!j.targets.some((x) => x.targetId === targetId)) ctx.addIssue({ code: 'custom', message: 'd1Databases and data are allowed only for a target of this job', path: ['environment', targetId] });
    }
  });

/** Staging Workers are `<production workerName>-staging`; only they may be seeded or reset (the Worker enforces it). */
export const STAGING_WORKER_SUFFIX = '-staging';
export const isStagingWorkerName = (workerName: string): boolean => workerName.endsWith(STAGING_WORKER_SUFFIX);

/**
 * Deploy a built release with `wrangler deploy` (the runner's pinned wrangler, never the
 * candidate's), from the stored outputs only: each file is fetched and checked against its sha256
 * and the target digest before anything is uploaded, and no candidate code runs. The account token
 * is never part of the job: the Sandbox egress gateway injects it for this job kind only, or a
 * broker-mode runner fetches it from `POST /api/runner/deploy-credential` for its wrangler child only.
 */
export const ReleaseDeployJobSchema = z
  .object({
    kind: z.literal('release-deploy'),
    releaseId: IdSegmentSchema,
    outputDigest: Sha256HexSchema,
    outputPrefix: OutputPrefixSchema,
    /** the Cloudflare account the targets are deployed to */
    accountId: z.string().regex(/^[0-9a-f]{32}$/),
    targets: z
      .array(
        z.object({
          targetId: IdSegmentSchema,
          kind: z.enum(['worker', 'assets']),
          workerName: ReleaseWorkerNameSchema,
          main: RelativePathSchema.optional(),
          digest: Sha256HexSchema,
          files: z.array(ReleaseFileSchema).min(1).max(5_000),
          config: ReleaseTargetConfigSchema,
          /** data files stored under `<target>/__data/` (not deployed; read by the Worker); part of the digest when present */
          dataFiles: z.array(ReleaseFileSchema).max(500).optional(),
        }),
      )
      .min(1)
      .max(8),
  })
  .superRefine((j, ctx) => {
    if (!j.outputPrefix.endsWith(`releases/${j.releaseId}/`)) ctx.addIssue({ code: 'custom', message: 'outputPrefix must end with releases/<releaseId>/', path: ['outputPrefix'] });
    j.targets.forEach((t, i) => {
      if (t.kind === 'worker' && (!t.main || !t.files.some((f) => f.path === t.main))) ctx.addIssue({ code: 'custom', message: 'worker target main must be one of its files', path: ['targets', i, 'main'] });
      if (t.config.vars.COMMONFORGE_RELEASE_ID !== j.releaseId) ctx.addIssue({ code: 'custom', message: 'vars.COMMONFORGE_RELEASE_ID must be the releaseId', path: ['targets', i, 'config', 'vars'] });
    });
  });

export const ExportJobSchema = z.object({
  kind: z.literal('export'),
  exportId: IdSegmentSchema,
  snapshotId: SnapshotIdSchema,
  resources: z.array(
    z.object({
      resourceId: ResourceIdSchema,
      coords: RepoCoordsSchema,
      sha: GitShaSchema,
      historyMode: z.enum(['full', 'snapshot-only']).optional(),
    }),
  ),
  manifests: z.array(AssetManifestSchema),
  sink: ExportSinkSchema,
});

export const EditionReturnJobSchema = z
  .object({
    kind: z.literal('edition-return'),
    edition: EditionManifestServerSideSchema,
    upload: z.object({
      r2Key: z.string().min(1).max(1024),
      mode: z.enum(['full', 'partial']),
      deletions: z.array(z.string().min(1)).optional(),
    }),
    target: IntegrationTargetSchema,
    /** fresh task fork (tasks namespace) the resulting candidate is pushed to */
    candidateFork: z.object({ taskWorkspaceId: TaskWorkspaceIdSchema, coords: RepoCoordsSchema }),
  })
  .superRefine((j, ctx) => {
    if (mayBeSameRepo(j.target.canonical, j.candidateFork.coords)) {
      ctx.addIssue({ code: 'custom', message: 'candidate fork must differ from canonical', path: ['candidateFork'] });
    }
  });

/** A path an `apply-files` operation names: normalized, at most 1,024 characters, never protected (`.git`, …). */
const OpPathSchema = RelativePathSchema.max(1024).refine((p) => !hasAlwaysProtectedSegment(p), 'path is protected');

/** One `apply-files` operation (spec 2026-10-07 §6), applied in order. */
export const ApplyFilesOpSchema = z.union([
  /** a verified staged object: sha256, size and binary come from the hash step; r2Key only for small non-binary files (the runner never downloads LFS objects) */
  z
    .object({
      put: OpPathSchema,
      stagingId: IdSegmentSchema,
      sha256: Sha256HexSchema,
      size: NonNegativeIntSchema.max(APPLY_FILES_LIMITS.maxFileBytes),
      binary: z.boolean(),
      r2Key: z.string().min(1).max(1024).optional(),
    })
    .strict(),
  /** baseBlob: the git blob id the editor opened ('' = the file must not exist yet) */
  z.object({ edit: OpPathSchema, content: z.string(), baseBlob: z.union([GitShaSchema, z.literal('')]) }).strict(),
  z.object({ delete: OpPathSchema }).strict(),
  /** a folder moves everything under it */
  z.object({ move: OpPathSchema, to: OpPathSchema }).strict(),
]);
export type ApplyFilesOp = z.infer<typeof ApplyFilesOpSchema>;

/** The `apply-files` operations as one JSON array (the R2 ops manifest the job names). */
const ApplyFilesOpsSchema = z.array(ApplyFilesOpSchema).min(1).max(APPLY_FILES_LIMITS.maxOps);

/**
 * Parse and validate the resolved operations of an `apply-files` job (its R2 ops manifest): the
 * per-op schema (normalized, unprotected paths of at most 1,024 characters), `r2Key` given exactly
 * for small text puts (`size <= lfsThresholdBytes && !binary`), at most 20 GB of puts, edits text
 * (no NUL) of at most 1 MiB each and 16 MiB together. Throws on anything invalid.
 */
export function parseApplyFilesOps(json: unknown, lfsThresholdBytes: number): ApplyFilesOp[] {
  const ops = ApplyFilesOpsSchema.parse(json);
  const enc = new TextEncoder();
  let total = 0;
  let edits = 0;
  ops.forEach((op, i) => {
    if ('put' in op) {
      total += op.size;
      const small = op.size <= lfsThresholdBytes && !op.binary;
      if (small !== (op.r2Key !== undefined)) throw new Error(`ops[${i}]: r2Key is given exactly for small text files`);
    }
    if ('edit' in op) {
      const n = enc.encode(op.content).length;
      if (n > APPLY_FILES_LIMITS.maxEditBytes || op.content.includes('\0')) throw new Error(`ops[${i}]: edits are text under 1 MiB`);
      edits += n;
    }
  });
  if (total > APPLY_FILES_LIMITS.maxChangeBytes) throw new Error('the change is over 20 GB');
  if (edits > APPLY_FILES_LIMITS.maxEditTotalBytes) throw new Error('the edits of the change are over 16 MiB together');
  return ops;
}

/**
 * `apply-files` (spec 2026-10-07 §6): apply uploads, edits, deletes and moves to a folder at its
 * base version and push one commit, authored by the uploader, to a fresh task repository. Canonical
 * is READ only. The operations are not inline (a queue message holds 128 KB): the Worker stores the
 * resolved operations as an R2 manifest (`opsManifest`), which the runner reads through its blob
 * scope, checks against `sha256` and `count`, and parses with {@link parseApplyFilesOps}. Puts
 * stored in LFS carry no `r2Key`: the runner writes their pointer from the recorded sha256 and size;
 * only small text files are fetched.
 */
export const ApplyFilesJobSchema = z
  .object({
    kind: z.literal('apply-files'),
    changeId: IdSegmentSchema,
    target: IntegrationTargetSchema,
    /** fresh task repository (tasks namespace) the resulting candidate is pushed to */
    candidateFork: z.object({ taskWorkspaceId: TaskWorkspaceIdSchema, coords: RepoCoordsSchema }),
    /** the resolved operations (a JSON array), applied in order */
    opsManifest: z.object({ r2Key: z.string().min(1).max(1024), sha256: Sha256HexSchema, count: z.number().int().min(1).max(APPLY_FILES_LIMITS.maxOps) }).strict(),
    /** the uploader: the commit author */
    author: z.object({ name: z.string().min(1).max(200), email: z.string().min(3).max(320) }),
    title: z.string().min(1).max(200),
    lfsThresholdBytes: PositiveIntSchema,
  })
  // strict: operations never travel inline (a stray `ops` is refused, not silently dropped)
  .strict()
  .superRefine((j, ctx) => {
    if (mayBeSameRepo(j.target.canonical, j.candidateFork.coords)) {
      ctx.addIssue({ code: 'custom', message: 'candidate fork must differ from canonical', path: ['candidateFork'] });
    }
    if (j.candidateFork.coords.kind === 'artifacts' && j.candidateFork.coords.repoName !== `ws-${j.candidateFork.taskWorkspaceId}`) {
      ctx.addIssue({ code: 'custom', message: 'Artifacts task repo must be named ws-<taskWorkspaceId>', path: ['candidateFork', 'coords', 'repoName'] });
    }
  });

/** Minimal: a fresh edition repo (git init + allowed files + one commit) built from canonical shas. */
export const BuildEditionJobSchema = z
  .object({
    kind: z.literal('build-edition'),
    editionId: IdSegmentSchema,
    sources: z
      .array(
        z.object({
          resourceId: ResourceIdSchema,
          canonical: RepoCoordsSchema,
          sha: GitShaSchema,
          /** resource-relative prefix copied from ('' = whole resource) */
          canonicalPathPrefix: PathPrefixSchema,
          /** edition-relative prefix written to ('' = edition root) */
          editionPathPrefix: PathPrefixSchema,
          /** read allowlist: canonical-path globs (core `matchesPathPattern`) */
          include: z.array(z.string().min(1)).min(1),
        }),
      )
      .min(1),
    /** always-excluded globs (applied after include) */
    exclude: z.array(z.string().min(1)).default(['**/.env*']),
    /** the `-editions` namespace repository written by this job */
    editionRepo: RepoCoordsSchema,
  })
  .superRefine((j, ctx) => {
    j.sources.forEach((s, i) => {
      if (mayBeSameRepo(s.canonical, j.editionRepo)) ctx.addIssue({ code: 'custom', message: 'edition repo must differ from sources', path: ['sources', i] });
    });
  });

/**
 * Seed a fresh task repository with the base commit (addition to plan §B.8: Artifacts `fork()`
 * cannot cross namespaces, so a `-tasks` repo is created empty and seeded here). Canonical is
 * READ only; the task repo is written. Runner contract:
 * - fetch `baseSha` from `canonical` into a scratch bare repo;
 * - push exactly one refspec `<baseSha>:<ref>` to `taskFork` with `--force-with-lease=<ref>:`
 *   (the ref must not exist yet); never `--mirror` and never any other ref, so canonical
 *   service refs (other workspaces' candidates) never reach a task repo;
 * - on a lease failure, `ls-remote <ref>`: equal to `baseSha` means already seeded (idempotent
 *   success), anything else fails the job.
 */
export const SeedWorkspaceJobSchema = z
  .object({
    kind: z.literal('seed-workspace'),
    taskWorkspaceId: TaskWorkspaceIdSchema,
    resourceId: ResourceIdSchema,
    /** canonical repository the base commit is fetched from (read only) */
    canonical: RepoCoordsSchema,
    baseSha: GitShaSchema,
    /** the fresh task repository (`-tasks` namespace) */
    taskFork: RepoCoordsSchema,
    /** branch of the task repository to create, e.g. `refs/heads/main` */
    ref: GitRefSchema.refine((r) => r.startsWith('refs/heads/'), 'seed-workspace only creates refs/heads/*'),
  })
  .superRefine((j, ctx) => {
    if (mayBeSameRepo(j.canonical, j.taskFork)) {
      ctx.addIssue({ code: 'custom', message: 'task fork must differ from canonical', path: ['taskFork'] });
    }
    if (j.taskFork.kind === 'artifacts' && j.taskFork.repoName !== `ws-${j.taskWorkspaceId}`) {
      ctx.addIssue({ code: 'custom', message: 'Artifacts task repo must be named ws-<taskWorkspaceId>', path: ['taskFork', 'repoName'] });
    }
  });

/** Minimal: deterministic listing of an uploaded ZIP (no execution, no extraction to a repo). */
export const InventoryJobSchema = z.object({
  kind: z.literal('inventory'),
  intakeId: IdSegmentSchema,
  upload: z.object({ r2Key: z.string().min(1).max(1024), sha256: Sha256HexSchema.optional(), size: NonNegativeIntSchema.optional() }),
  limits: z.object({
    maxFiles: PositiveIntSchema.default(10_000),
    maxTotalBytes: PositiveIntSchema.default(1024 * 1024 * 1024),
    /** uncompressed/compressed ratio above which the archive is refused (zip bomb) */
    maxCompressionRatio: z.number().positive().default(100),
  }),
});

/** The ref a `staging-build` job pushes in each target's canonical repository. Never `main`. */
export const STAGING_REF = 'refs/commonforge/staging';

/** Per-build ref (lease `absent`): keeps every staging commit a task may have been seeded from reachable. */
export const stagingBuildRef = (buildId: string): string => `refs/commonforge/staging-builds/${buildId}`;

/**
 * Build the staging tree for each target: `mainSha` plus every landing's change set, in order. A
 * candidate's change set is the diff from its own `baseSha` (usually an earlier staging commit)
 * to its commit, so only the task's own edits are applied. The result is pushed to
 * {@link STAGING_REF}; main is never touched.
 */
export const StagingBuildJobSchema = z.object({
  kind: z.literal('staging-build'),
  buildId: IdSegmentSchema,
  targets: z
    .array(
      z.object({
        resourceId: ResourceIdSchema,
        canonical: RepoCoordsSchema,
        mainSha: GitShaSchema,
        landings: z.array(
          z.object({
            landingId: IdSegmentSchema,
            candidates: z.array(z.object({ candidateId: CandidateIdSchema, sha: GitShaSchema, baseSha: GitShaSchema })).min(1),
          }),
        ),
      }),
    )
    .min(1)
    .max(16),
});
export type StagingBuildJob = z.infer<typeof StagingBuildJobSchema>;

/** Bounds of an `init-folder` job: a few small platform-written files. */
export const INIT_FOLDER_LIMITS = { maxFiles: 8, maxFileBytes: 65_536 } as const;

/** The branch an `init-folder` job creates in canonical (must not exist yet). */
export const INIT_FOLDER_BRANCH_REF = 'refs/heads/main';

/** A commit identity part: no `<`, `>`, newline or NUL, which git would strip or refuse (the commit id must be the job's). */
const IdentityPartSchema = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((s) => !/[<>\n\0]/.test(s) && s.trim() === s, 'no <, >, newline or NUL, no surrounding spaces');

/**
 * `init-folder` (folders phase 4, ruling P4-1): a new folder's first version. The runner builds ONE
 * parentless commit holding exactly `files` (top level, mode 100644), authored by `author`,
 * committed by `CommonForge <noreply@commonforge.invalid>`, both dated `commitTime`, and pushes it
 * to canonical `refs/heads/main`, which must not exist. The commit id is a function of the job
 * (P4-3), so a retry finds its own commit there (`already`); anything else there fails
 * `branch_not_empty`. The Worker then binds it as the ledger's genesis head.
 */
export const InitFolderJobSchema = z
  .object({
    kind: z.literal('init-folder'),
    resourceId: ResourceIdSchema,
    canonical: RepoCoordsSchema,
    /** top-level files only: a normalized, unprotected name of at most 1,024 characters (the Worker's `uploadPath` rules) and no `/` */
    files: z
      .array(z.object({ path: OpPathSchema.refine((p) => !p.includes('/'), 'top-level files only'), content: z.string() }).strict())
      .min(1)
      .max(INIT_FOLDER_LIMITS.maxFiles),
    author: z.object({ name: IdentityPartSchema(1, 200), email: IdentityPartSchema(3, 320) }).strict(),
    /** author and committer time: whole seconds (`…:SS.000Z`) */
    commitTime: TimestampSchema.refine((t) => t.endsWith('.000Z'), 'commitTime must be whole seconds'),
    message: z.string().min(1).max(1000).refine((m) => !m.includes('\0'), 'no NUL'),
  })
  .strict()
  .superRefine((j, ctx) => {
    const enc = new TextEncoder();
    const seen = new Set<string>();
    j.files.forEach((f, i) => {
      if (seen.has(f.path)) ctx.addIssue({ code: 'custom', message: `duplicate path ${f.path}`, path: ['files', i, 'path'] });
      seen.add(f.path);
      if (enc.encode(f.content).length > INIT_FOLDER_LIMITS.maxFileBytes) ctx.addIssue({ code: 'custom', message: 'a file is over 64 KiB', path: ['files', i, 'content'] });
    });
  });

const IntegrationJobUnionSchema = z.discriminatedUnion('kind', [
  PrepareCandidateJobSchema,
  IntegrateJobSchema,
  ReconcileRefJobSchema,
  PreviewBuildJobSchema,
  ExportJobSchema,
  EditionReturnJobSchema,
  BuildEditionJobSchema,
  InventoryJobSchema,
  SeedWorkspaceJobSchema,
  ReleaseBuildJobSchema,
  ReleaseDeployJobSchema,
  ApplyFilesJobSchema,
  StagingBuildJobSchema,
  InitFolderJobSchema,
]);
export type IntegrationJob = z.infer<typeof IntegrationJobUnionSchema>;
export type IntegrationJobInput = z.input<typeof IntegrationJobUnionSchema>;

/**
 * Every job, plus cross-kind repository invariants: each repo a job names sits in the namespace of
 * its role (so no job kind can smuggle a canonical repo in as an edition repo or task fork), and
 * no two entries are "maybe the same repo" without being strictly identical.
 */
export const IntegrationJobSchema = IntegrationJobUnionSchema.superRefine((job, ctx) => {
  const access = jobRepoAccess(job);
  for (const a of access) {
    if (!namespaceFitsRole(a.coords, a.role)) {
      ctx.addIssue({ code: 'custom', message: `${a.coords.namespace}/${a.coords.repoName} cannot be a ${a.role} repository` });
    }
  }
  for (let i = 0; i < access.length; i++) {
    for (let k = i + 1; k < access.length; k++) {
      if (mayBeSameRepo(access[i]!.coords, access[k]!.coords) && !sameRepoIdentity(access[i]!.coords, access[k]!.coords)) {
        ctx.addIssue({ code: 'custom', message: `ambiguous repository identity: ${access[i]!.coords.remoteUrl} / ${access[k]!.coords.remoteUrl}` });
      }
    }
  }
});
export type JobOfKind<K extends IntegrationJobKind> = Extract<IntegrationJob, { kind: K }>;

// =============================================================================================
// SignedJob envelope
// =============================================================================================

/** The credential broker endpoint: http(s), no embedded credentials. */
export const BrokerUrlSchema = RemoteUrlSchema.refine((s) => /^https?:/.test(s), 'credentialBroker must be an http(s) URL');

const envelopeShape = {
  job: IntegrationJobSchema,
  jobId: IdSegmentSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  credentialBroker: BrokerUrlSchema,
};

type EnvelopeLike = { job: IntegrationJob; jobId: string; issuedAt: string; expiresAt: string };

function envelopeChecks(e: EnvelopeLike, ctx: z.RefinementCtx): void {
  if (Date.parse(e.expiresAt) <= Date.parse(e.issuedAt)) {
    ctx.addIssue({ code: 'custom', message: 'expiresAt must be after issuedAt', path: ['expiresAt'] });
  }
  if (e.job.kind === 'integrate') {
    let expected: string | null = null;
    try {
      expected = jobIntegrationRef(e.job.proposalId, e.jobId);
    } catch {
      /* reported below */
    }
    if (e.job.integrationRef !== expected) {
      ctx.addIssue({ code: 'custom', message: 'integrationRef must embed the jobId', path: ['job', 'integrationRef'] });
    }
  }
}

/** What the issuer fills in before signing. */
export const UnsignedJobSchema = z.object(envelopeShape).strict().superRefine(envelopeChecks);
export type UnsignedJob = z.infer<typeof UnsignedJobSchema>;
export type UnsignedJobInput = z.input<typeof UnsignedJobSchema>;

/**
 * Plan §B.8 `SignedJob` plus `kid` (key id, for rotation). `sig` = lowercase hex
 * HMAC-SHA256(key[kid], canonicalJson({$t: 'cf.signed-job/1', ...every field except sig})).
 * Unknown top-level fields are refused.
 */
export const SignedJobSchema = z
  .object({
    ...envelopeShape,
    kid: z.string().regex(KID_RE),
    sig: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine(envelopeChecks);
export type SignedJob = z.infer<typeof SignedJobSchema>;

// =============================================================================================
// Receipts for kinds core does not define
// =============================================================================================

export const EditionBuildReceiptSchema = z.object({
  jobId: IdSegmentSchema,
  editionId: IdSegmentSchema,
  /** the single commit of the fresh edition repo */
  sha: GitShaSchema,
  revisionId: RevisionIdSchema,
  inventory: z.array(EditionInventoryEntrySchema),
  builtAt: TimestampSchema,
});
export type EditionBuildReceipt = z.infer<typeof EditionBuildReceiptSchema>;

export const InventoryRejectReasonSchema = z.enum([
  'path_escape',
  'invalid_path',
  'symlink',
  'special_file',
  'duplicate',
  'case_collision',
  'too_many_files',
  'too_large',
  'ratio_exceeded',
]);

export const InventoryReceiptSchema = z.object({
  jobId: IdSegmentSchema,
  intakeId: IdSegmentSchema,
  entries: z.array(z.object({ path: RelativePathSchema, size: NonNegativeIntSchema, sha256: Sha256HexSchema })),
  /** raw (possibly hostile) archive paths and why they were refused */
  rejected: z.array(z.object({ path: z.string().max(4096), reason: InventoryRejectReasonSchema })),
  totalBytes: NonNegativeIntSchema,
  inventoriedAt: TimestampSchema,
});
export type InventoryReceipt = z.infer<typeof InventoryReceiptSchema>;

export const ReleaseBuildReceiptSchema = z.object({
  jobId: IdSegmentSchema,
  releaseId: IdSegmentSchema,
  /** sha256 over canonical JSON of `[{targetId, digest}]` sorted by targetId */
  outputDigest: Sha256HexSchema,
  targets: z.array(
    z.object({
      targetId: IdSegmentSchema,
      /** sha256 over canonical JSON of `{files (sorted by path), config, dataFiles when present}` */
      digest: Sha256HexSchema,
      files: z.array(ReleaseFileSchema),
      config: ReleaseTargetConfigSchema,
      /** files copied to `<target>/__data/<path>` (migrations, seed); omitted when there are none */
      dataFiles: z.array(ReleaseFileSchema).max(500).optional(),
    }),
  ),
  builtAt: TimestampSchema,
});
export type ReleaseBuildReceipt = z.infer<typeof ReleaseBuildReceiptSchema>;

export const ReleaseDeployReceiptSchema = z.object({
  jobId: IdSegmentSchema,
  releaseId: IdSegmentSchema,
  outputDigest: Sha256HexSchema,
  deployments: z.array(
    z.object({
      targetId: IdSegmentSchema,
      workerName: WorkerNameSchema,
      /** the Workers version id wrangler reported (null if it printed none) */
      versionId: z.string().max(128).nullable(),
      /** the workers.dev URL wrangler reported, if any */
      url: z.url().nullable(),
    }),
  ),
  deployedAt: TimestampSchema,
});
export type ReleaseDeployReceipt = z.infer<typeof ReleaseDeployReceiptSchema>;

/** Result of `apply-files` (spec 2026-10-07 §6). */
export const ApplyFilesReceiptSchema = z.object({
  jobId: IdSegmentSchema,
  changeId: IdSegmentSchema,
  resourceId: ResourceIdSchema,
  expectedHead: RevisionIdSchema,
  /** absent: the operations changed nothing */
  candidate: z.object({ candidateId: CandidateIdSchema, taskWorkspaceId: TaskWorkspaceIdSchema, sha: GitShaSchema }).optional(),
  /** every changed path, classified (spec §7); a job changing more fails `limit_exceeded` */
  changedPaths: z
    .array(z.object({ path: RelativePathSchema, change: z.enum(['added', 'modified', 'deleted']), lfs: z.boolean(), class: z.enum(['code', 'content']) }))
    .max(APPLY_FILES_LIMITS.maxChangedPaths),
  /** LFS objects the commit points to (promoted when the change is accepted) */
  lfsObjects: z.array(z.object({ stagingId: IdSegmentSchema, sha256: Sha256HexSchema, size: NonNegativeIntSchema })),
  appliedAt: TimestampSchema,
});
export type ApplyFilesReceipt = z.infer<typeof ApplyFilesReceiptSchema>;
export const StagingBuildReceiptSchema = z.object({
  jobId: IdSegmentSchema,
  buildId: IdSegmentSchema,
  results: z.array(z.object({ resourceId: ResourceIdSchema, sha: GitShaSchema, revisionId: RevisionIdSchema })),
  builtAt: TimestampSchema,
});
export type StagingBuildReceipt = z.infer<typeof StagingBuildReceiptSchema>;

/** Result of `init-folder`: the first commit, now on canonical main; `already` = a retry found it there. */
export const InitFolderReceiptSchema = z.object({
  jobId: IdSegmentSchema,
  resourceId: ResourceIdSchema,
  commitSha: GitShaSchema,
  status: z.enum(['created', 'already']),
});
export type InitFolderReceipt = z.infer<typeof InitFolderReceiptSchema>;

/** Receipt produced by each job kind (core's map plus the runner-protocol kinds). */
export interface JobReceiptByKind extends RunnerReceiptByKind {
  'build-edition': EditionBuildReceipt;
  inventory: InventoryReceipt;
  'release-build': ReleaseBuildReceipt;
  'release-deploy': ReleaseDeployReceipt;
  'apply-files': ApplyFilesReceipt;
  'staging-build': StagingBuildReceipt;
  'init-folder': InitFolderReceipt;
}

export const RECEIPT_SCHEMAS = {
  'prepare-candidate': PreparedReceiptSchema,
  integrate: IntegrationReceiptSchema,
  'reconcile-ref': ReconcileResultSchema,
  'preview-build': PreviewReceiptSchema,
  export: ExportReceiptSchema,
  'edition-return': EditionReturnReceiptSchema,
  'build-edition': EditionBuildReceiptSchema,
  inventory: InventoryReceiptSchema,
  'seed-workspace': SeedWorkspaceReceiptSchema,
  'release-build': ReleaseBuildReceiptSchema,
  'release-deploy': ReleaseDeployReceiptSchema,
  'apply-files': ApplyFilesReceiptSchema,
  'staging-build': StagingBuildReceiptSchema,
  'init-folder': InitFolderReceiptSchema,
} as const satisfies { [K in IntegrationJobKind]: z.ZodType<JobReceiptByKind[K]> };

// =============================================================================================
// RunnerResult
// =============================================================================================

export const RunnerFailureSchema = z.object({
  jobId: IdSegmentSchema,
  ok: z.literal(false),
  code: RunnerFailureCodeSchema,
  /** human-readable; runners must pass it through `redact` */
  detail: z.string().max(16_384),
  evidence: ValidationEvidenceSchema.optional(),
});
export type RunnerFailure = z.infer<typeof RunnerFailureSchema>;

const AnyReceiptSchema = z.union([
  PreparedReceiptSchema,
  IntegrationReceiptSchema,
  ReconcileResultSchema,
  PreviewReceiptSchema,
  ExportReceiptSchema,
  EditionReturnReceiptSchema,
  EditionBuildReceiptSchema,
  InventoryReceiptSchema,
  SeedWorkspaceReceiptSchema,
  ReleaseBuildReceiptSchema,
  ReleaseDeployReceiptSchema,
  ApplyFilesReceiptSchema,
  StagingBuildReceiptSchema,
  InitFolderReceiptSchema,
]);

/** Plan §B.8 RunnerResult (kind-agnostic). Prefer {@link parseRunnerResult} when the kind is known. */
export const RunnerResultSchema = z.union([
  z.object({ jobId: IdSegmentSchema, ok: z.literal(true), receipt: AnyReceiptSchema }),
  RunnerFailureSchema,
]);

export type RunnerResult<K extends IntegrationJobKind = IntegrationJobKind> =
  | { jobId: string; ok: true; receipt: JobReceiptByKind[K] }
  | RunnerFailure;

/** Parse a runner result for a known job kind; the receipt must be that kind's receipt. */
export function parseRunnerResult<K extends IntegrationJobKind>(kind: K, value: unknown): RunnerResult<K> {
  if (value && typeof value === 'object' && (value as { ok?: unknown }).ok === false) return RunnerFailureSchema.parse(value);
  const schema = z
    .object({ jobId: IdSegmentSchema, ok: z.literal(true), receipt: RECEIPT_SCHEMAS[kind] as unknown as z.ZodType<JobReceiptByKind[K]> })
    .superRefine((r, ctx) => {
      const receiptJobId = (r.receipt as { jobId?: string }).jobId;
      if (receiptJobId !== undefined && receiptJobId !== r.jobId) {
        ctx.addIssue({ code: 'custom', message: 'receipt jobId differs from result jobId', path: ['receipt', 'jobId'] });
      }
    });
  return schema.parse(value) as RunnerResult<K>;
}

// =============================================================================================
// Credential broker (plan §B.8; spike S3 shape)
// =============================================================================================

export const RunnerCredentialRequestSchema = z.object({
  signedJob: SignedJobSchema,
  repo: RepoCoordsSchema,
  access: OperationSchema,
});
export type RunnerCredentialRequest = z.infer<typeof RunnerCredentialRequestSchema>;

/** Contains a secret: never log or persist. Revoke `tokenId` when the job ends. */
export const RunnerCredentialResponseSchema = z.object({
  token: z.string().min(1),
  tokenId: z.string().min(1),
  expiresAt: TimestampSchema,
  remoteUrl: RemoteUrlSchema,
});
export type RunnerCredentialResponse = z.infer<typeof RunnerCredentialResponseSchema>;

export interface RepoAccess {
  coords: RepoCoords;
  access: 'read' | 'write';
  role: RepoRole;
}

/** Job kinds that may write a canonical repository (plan §B.8). */
export const CANONICAL_WRITE_KINDS = ['prepare-candidate', 'integrate', 'reconcile-ref', 'staging-build', 'init-folder'] as const satisfies readonly IntegrationJobKind[];

/**
 * Repositories a job may obtain tokens for (the broker's policy), each tagged with its role.
 * Canonical write access exists only for `prepare-candidate`, `integrate`, `reconcile-ref`, `staging-build`
 * and `init-folder` (which may only create canonical main);
 * `build-edition` writes only its `-editions` repo and `edition-return` / `apply-files` only their
 * fresh task fork.
 * Entries are deduplicated by strict identity; the same repo under two roles keeps the stronger
 * access (and is refused by IntegrationJobSchema if the roles conflict).
 */
export function jobRepoAccess(job: IntegrationJob): RepoAccess[] {
  const out: RepoAccess[] = [];
  const add = (coords: RepoCoords, access: 'read' | 'write', role: RepoRole) => {
    const existing = out.find((a) => sameRepoIdentity(a.coords, coords) && a.role === role);
    if (!existing) out.push({ coords, access, role });
    else if (access === 'write') existing.access = 'write';
  };
  switch (job.kind) {
    case 'prepare-candidate':
      add(job.candidate.fork, 'read', 'task-fork');
      add(job.canonical, 'write', 'canonical');
      break;
    case 'integrate':
      for (const r of job.references ?? []) add(r.coords, 'read', 'reference');
      for (const t of job.targets) add(t.canonical, 'write', 'canonical');
      break;
    case 'reconcile-ref':
      add(job.canonical, 'write', 'canonical');
      break;
    case 'preview-build':
      for (const s of job.sources) add(s.canonical, 'read', 'canonical');
      break;
    case 'export':
      for (const r of job.resources) add(r.coords, 'read', 'canonical');
      break;
    case 'build-edition':
      for (const s of job.sources) add(s.canonical, 'read', 'canonical');
      add(job.editionRepo, 'write', 'edition');
      break;
    case 'edition-return':
    case 'apply-files':
      add(job.target.canonical, 'read', 'canonical');
      add(job.candidateFork.coords, 'write', 'task-fork');
      break;
    case 'inventory':
      break;
    case 'seed-workspace':
      add(job.canonical, 'read', 'canonical');
      add(job.taskFork, 'write', 'task-fork');
      break;
    case 'release-build':
      for (const s of job.sources) add(s.canonical, 'read', 'canonical');
      break;
    case 'release-deploy':
      // deploys stored outputs only: no repository access at all
      break;
    case 'staging-build':
      for (const t of job.targets) add(t.canonical, 'write', 'canonical');
      break;
    case 'init-folder':
      add(job.canonical, 'write', 'canonical');
      break;
  }
  if (!(CANONICAL_WRITE_KINDS as readonly string[]).includes(job.kind)) {
    for (const a of out) if (a.role === 'canonical' && a.access === 'write') a.access = 'read';
  }
  return out;
}

export type CredentialAuthorization =
  | { ok: true; coords: RepoCoords; access: 'read' | 'write'; role: RepoRole }
  | {
      ok: false;
      reason: 'repo_not_in_job' | 'identity_mismatch' | 'access_exceeds_job' | 'namespace_role_mismatch';
      detail: string;
    };

/**
 * Pure broker decision for a runner credential request, given a job ALREADY verified with
 * `verifySignedJob` (use its returned `signedJob`, never a re-parse of the raw body). The
 * requested repo must strictly match a repo the job names (kind+namespace+repoId+remoteUrl), the
 * requested access may not exceed the job's, and the repo must sit in its role's namespace. On
 * success the JOB's coordinates are returned; the broker mints for those, never for the request's.
 */
export function authorizeCredentialRequest(
  verifiedJob: { readonly job: IntegrationJob },
  request: { readonly repo: RepoCoords; readonly access: 'read' | 'write' },
): CredentialAuthorization {
  const entries = jobRepoAccess(verifiedJob.job);
  const exact = entries.filter((e) => sameRepoIdentity(e.coords, request.repo));
  if (exact.length === 0) {
    const partial = entries.find((e) => mayBeSameRepo(e.coords, request.repo));
    return partial
      ? { ok: false, reason: 'identity_mismatch', detail: `requested repo only partially matches ${partial.coords.namespace}/${partial.coords.repoId}` }
      : { ok: false, reason: 'repo_not_in_job', detail: `${verifiedJob.job.kind} job does not name this repository` };
  }
  const entry = exact.find((e) => e.access === 'write') ?? exact[0]!;
  if (request.access === 'write' && entry.access !== 'write') {
    return { ok: false, reason: 'access_exceeds_job', detail: `${verifiedJob.job.kind} job grants ${entry.role} read only` };
  }
  if (!namespaceFitsRole(entry.coords, entry.role)) {
    return { ok: false, reason: 'namespace_role_mismatch', detail: `${entry.coords.namespace} is not a ${entry.role} namespace` };
  }
  return { ok: true, coords: entry.coords, access: request.access, role: entry.role };
}
