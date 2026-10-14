import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import * as S from './schemas.js';
import { computeAssetManifestId, computeAssetManifestIdSync } from './manifest.js';

const G = (c: string) => c.repeat(40);
const H = (c: string) => c.repeat(64);
const T = '2026-10-06T12:00:00.000Z';
const principal = { kind: 'agent', id: 'agent-a', onBehalfOf: { kind: 'user', id: 'u1' } };
const artCoords = { kind: 'artifacts', namespace: 'commonforge-o1-tasks', repoName: 'web-ws1', repoId: 'repo-ws1', remoteUrl: 'https://artifacts.example/o1/web-ws1.git' };
const resourceRef = { organizationId: 'o1', resourceId: 'web', provider: 'artifacts', authority: 'commonforge_ledger', coords: artCoords };
const frozen = {
  candidateId: `cand:ws1:${G('b')}`, taskWorkspaceId: 'ws1', fork: artCoords, resourceId: 'web', baseRevision: `art:web:${G('a')}`,
  sha: G('b'), treeId: G('c'), frozenAt: T, submitter: principal, changedPaths: ['src/a.ts'],
};
const evidence = {
  evidenceId: 'ev1', proposalHash: H('1'), snapshotId: H('2'), runnerId: 'run1', runnerKind: 'sandbox',
  checks: [{ checkId: 'test', command: 'pnpm test', result: 'pass', startedAt: T, endedAt: T }],
  contractChecks: [{ contractId: 'quote', producerResource: 'api', consumerResource: 'web', result: 'fail', detail: 'missing field' }],
  mergeOutcome: [{ resourceId: 'web', result: 'clean' }],
  producedAt: T, signature: 'hmac',
};
const manifestBody = {
  resourceId: 'brand', parentManifestId: null,
  entries: [{ path: 'logo.png', sha256: H('7'), size: 100, mime: 'image/png', objectKey: `org/o1/res/brand/obj/${H('7')}` }],
};

/** [name, schema, valid sample] — each must round-trip through parse unchanged. */
const samples: Array<[string, z.ZodType, unknown]> = [
  ['ProviderCapabilities', S.ProviderCapabilitiesSchema, { kind: 'artifacts', immutableRevisions: true, retainedHistory: true, gitTransport: true, writableCandidates: true, conditionalAccept: true, externalReview: false, binaryAssets: false, maxBlobBytes: 33554432, maxRepoBytes: null }],
  ['PrincipalRef', S.PrincipalRefSchema, principal],
  ['ResourceRef', S.ResourceRefSchema, resourceRef],
  ['GitHubCoords', S.GitHubCoordsSchema, { kind: 'github-connected', owner: 'octo', repo: 'site', targetRef: 'refs/heads/main', installationId: 5 }],
  ['AssetManifestCoords', S.AssetManifestCoordsSchema, { kind: 'r2-assets', bucket: 'cf-assets', prefix: 'org/o1/res/brand/', manifestId: null }],
  ['LegacyStorageCoords', S.LegacyStorageCoordsSchema, { kind: 'legacy-vc-storage', projectId: 'p1', version: '12' }],
  ['RevisionSelector', S.RevisionSelectorSchema, { kind: 'candidate', candidateId: `cand:ws1:${G('b')}` }],
  ['ResolvedRevision', S.ResolvedRevisionSchema, { resourceId: 'web', revisionId: `art:web:${G('a')}`, provider: 'artifacts', coords: artCoords, contentId: G('a'), treeId: G('c'), resolvedAt: T, reconciliation: 'pending' }],
  ['TreeEntry', S.TreeEntrySchema, { path: 'src/a.ts', type: 'file', mode: '100644', oid: G('d'), size: 12 }],
  ['ProjectSnapshot', S.ProjectSnapshotSchema, { snapshotId: H('2'), projectId: 'p1', organizationId: 'o1', membershipRevision: 1, policyRevision: 1, entries: [{ resourceId: 'web', revisionId: `art:web:${G('a')}`, mode: 'must-match-accepted', mountName: 'café', operations: ['read', 'write'] }], createdAt: T }],
  ['MaterializationPlan', S.MaterializationPlanSchema, { workspaceRoot: '/tmp/ws', mounts: [{ mountName: 'website', resourceId: 'web', revisionId: `art:web:${G('a')}`, source: { kind: 'git', remoteUrl: 'https://x.example/r.git', sha: G('a'), credential: 'helper' }, writable: true, taskWorkspaceId: 'ws1' }], contextFiles: [{ path: '.commonforge/PROJECT-CONTEXT.md', content: '# ctx' }] }],
  ['CreateIsolatedChangeInput', S.CreateIsolatedChangeInputSchema, { resource: resourceRef, baseRevision: `art:web:${G('a')}`, taskId: 't1', organizationId: 'o1', changeId: 'c1', purpose: 'agent-task' }],
  ['TaskWorkspaceHandle', S.TaskWorkspaceHandleSchema, { taskWorkspaceId: 'ws1', resourceId: 'web', baseRevision: `art:web:${G('a')}`, provider: 'artifacts', coords: artCoords, state: 'writable' }],
  ['WorkspaceGrant', S.WorkspaceGrantSchema, { principal, operations: ['write'], ttlSeconds: 3600, leaseGeneration: 2 }],
  ['WorkspaceGrant with lease', S.WorkspaceGrantSchema, { principal, operations: ['write'], ttlSeconds: 3600, leaseGeneration: 2, leaseExpiresAt: T }],
  ['SeedWorkspaceReceipt', S.SeedWorkspaceReceiptSchema, { jobId: 'j1', taskWorkspaceId: 'ws1', resourceId: 'web', ref: 'refs/heads/main', sha: G('a'), seededAt: T }],
  ['WorkspaceCredential', S.WorkspaceCredentialSchema, { tokenId: 'tok1', secret: 's3cr3t', scope: 'write', expiresAt: T, remoteUrl: 'https://x.example/r.git' }],
  ['FreezeInput', S.FreezeInputSchema, { expectedSha: G('b'), submitter: principal, tool: 'claude' }],
  ['FrozenCandidate', S.FrozenCandidateSchema, frozen],
  ['CompareResult', S.CompareResultSchema, { base: `art:web:${G('a')}`, candidate: `art:web:${G('b')}`, sameTree: false, files: [{ path: 'b.ts', status: 'renamed', oldPath: 'a.ts', binary: false, additions: 1, deletions: 0 }], patchRef: 'org/o1/patch/1' }],
  ['ValidationEvidence', S.ValidationEvidenceSchema, evidence],
  ['CheckSpec', S.CheckSpecSchema, { checkId: 'test', mountName: 'website', command: 'pnpm test', timeoutSeconds: 600, required: true }],
  ['ContractSpec', S.ContractSpecSchema, { contractId: 'quote', version: '1', producerResource: 'api', consumerResource: 'web', schema: { resourceId: 'req', path: 'contracts/quote.json' }, producerOutput: { mountName: 'api', command: 'node sample.js' } }],
  ['BuildRecipe', S.BuildRecipeSchema, { recipeId: 'site', revision: 1, steps: [{ stepId: 'build', mountName: 'website', command: 'pnpm build' }], output: { mountName: 'website', path: 'dist' } }],
  ['PreparedReceipt', S.PreparedReceiptSchema, { receiptId: 'pr1', jobId: 'j1', candidateId: `cand:ws1:${G('b')}`, resourceId: 'web', canonicalRef: `refs/commonforge/candidates/ws1/${G('b')}`, sha: G('b'), revisionId: `art:web:${G('b')}`, verifiedAssetObjects: [], preparedAt: T }],
  ['IntegrationReceipt', S.IntegrationReceiptSchema, { jobId: 'j2', proposalId: 'prop1', results: [{ resourceId: 'web', integrationRef: 'refs/commonforge/integrations/prop1', sha: G('e'), revisionId: `art:web:${G('e')}`, expectedHead: `art:web:${G('a')}` }], evidence, integratedAt: T }],
  ['ReconcileResult', S.ReconcileResultSchema, { jobId: 'j3', resourceId: 'web', ref: 'refs/heads/main', targetSha: G('e'), observedSha: null, status: 'diverged', reconciledAt: T }],
  ['PreviewReceipt', S.PreviewReceiptSchema, { jobId: 'j4', previewId: 'pv1', url: 'https://preview.example/pv1', integrationSha: { web: G('e') }, recipe: { recipeId: 'site', revision: 1 }, readyAt: T, expiresAt: T }],
  ['ExportSink', S.ExportSinkSchema, { kind: 'r2', r2Prefix: 'org/o1/exports/x/' }],
  ['ExportReceipt', S.ExportReceiptSchema, { exportId: 'x1', snapshotId: H('2'), items: [
    { resourceId: 'web', kind: 'git-bundle', r2Key: 'k1', sha256: H('3'), headSha: G('a'), historyMode: 'full' },
    { resourceId: 'brand', kind: 'asset-manifest', r2Key: 'k2', manifestId: H('4'), objects: 1, bytes: 100 },
    { kind: 'project-structure', r2Key: 'k3' },
  ], createdAt: T }],
  ['ReadGrant', S.ReadGrantSchema, { principal, organizationId: 'o1', resourceId: 'brand', purpose: 'preview', expiresAt: T }],
  ['EditionReturnReceipt', S.EditionReturnReceiptSchema, { jobId: 'j5', editionId: 'ed1', resourceId: 'web', candidate: { candidateId: `cand:ws2:${G('f')}`, taskWorkspaceId: 'ws2', sha: G('f') }, expectedHead: `art:web:${G('a')}`, allowed: [], blocked: [{ path: 'package.json', reason: 'protected' }], returnedAt: T }],
  ['ApprovalRef', S.ApprovalRefSchema, { approvalId: 'ap1', proposalId: 'prop1', proposalHash: H('1'), approver: { kind: 'user', id: 'u1' }, role: 'owner', approvedAt: T }],
  ['AcceptInput', S.AcceptInputSchema, { proposalId: 'prop1', proposalHash: H('1'), idempotencyKey: 'k1', expectedHeads: [{ resourceId: 'web', revisionId: `art:web:${G('a')}` }], newHeads: [{ resourceId: 'web', revisionId: `art:web:${G('e')}`, preparedReceiptId: 'pr1' }], readDependencies: [{ resourceId: 'req', revisionId: `art:req:${G('1')}`, mode: 'pinned-reference' }], approvals: [], policyRevision: 1, evidence: [evidence], actor: { kind: 'service', id: 'svc' } }],
  ['RestoreInput', S.RestoreInputSchema, { resourceId: 'web', expectedHead: `art:web:${G('e')}`, targetRevision: `art:web:${G('a')}`, idempotencyKey: 'k2', actor: { kind: 'user', id: 'u1' } }],
  ['AcceptedHead', S.AcceptedHeadSchema, { resourceId: 'web', revisionId: `art:web:${G('a')}`, versionSeq: 1, acceptedVersionId: null, acceptedAt: T, reconciliation: 'synced' }],
  ['ProposalRecord', S.ProposalRecordSchema, { proposalId: 'prop1', proposalHash: H('1'), organizationId: 'o1', projectId: 'p1', changeId: 'c1', baseSnapshotId: H('2'), candidateSnapshotId: H('3'), resourceChanges: [{ resourceId: 'web', baseRevision: `art:web:${G('a')}`, candidateId: `cand:ws1:${G('b')}`, candidateRevision: `art:web:${G('b')}` }], readDependencies: [], assetManifestChanges: [{ resourceId: 'brand', baseManifestId: null, newManifestId: H('4') }], policyRevision: 1, state: 'prepared', preparedReceipts: [{ resourceId: 'web', receiptId: 'pr1' }], createdAt: T, updatedAt: T }],
  ['IdempotencyRecord', S.IdempotencyRecordSchema, { key: 'k1', scope: 'accept', requestHash: H('5'), acceptedVersionId: 'av-7', createdAt: T }],
  ['AcceptedProjectVersion', S.AcceptedProjectVersionSchema, { acceptedVersionId: 'av-7', organizationId: 'o1', sequence: 7, kind: 'accept', proposalId: 'prop1', proposalHash: H('1'), heads: [{ resourceId: 'web', revisionId: `art:web:${G('e')}`, previousRevisionId: `art:web:${G('a')}`, versionSeq: 2 }], actor: { kind: 'service', id: 'svc' }, acceptedAt: T }],
  ['OutboxEvent', S.OutboxEventSchema, { eventId: 'e1', organizationId: 'o1', dedupeKey: 'reconcile:web:av-7', createdAt: T, attempts: 0, deliveredAt: null, kind: 'reconcile-ref', payload: { resourceId: 'web', targetRevision: `art:web:${G('e')}`, expectedCurrent: `art:web:${G('a')}`, acceptedVersionId: 'av-7' } }],
  ['AuditEvent', S.AuditEventSchema, { auditId: 'a1', organizationId: 'o1', at: T, actor: principal, action: 'proposal.accepted', subject: { kind: 'proposal', id: 'prop1' }, proposalHash: H('1'), detail: { n: 1 } }],
  ['EditionManifestServerSide', S.EditionManifestServerSideSchema, { editionId: 'ed1', policyRevision: 1, sourceReleaseId: 'rel1', exportedSnapshotId: H('2'), inventory: [{ editionPath: 'index.html', sha256: H('1'), size: 3 }], mappings: [{ editionPathPrefix: '', resourceId: 'web', canonicalPathPrefix: 'public', writable: true }], canonicalBases: [{ resourceId: 'web', revisionId: `art:web:${G('a')}` }], editionRepo: { ...artCoords, namespace: 'commonforge-o1-editions' }, allowedAssetNamespaces: ['brand'], contractVersions: { quote: '1' }, protectedPaths: ['package.json'] }],
  ['MappedChange', S.MappedChangeSchema, { resourceId: 'web', baseRevision: `art:web:${G('a')}`, kind: 'added', editionPath: 'x.html', canonicalPath: 'public/x.html', sha256: H('1') }],
];

describe('schema round-trips', () => {
  it.each(samples)('%s parses and survives JSON round-trip', (_name, schema, sample) => {
    const parsed = schema.parse(sample);
    expect(parsed).toEqual(sample);
    expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('AssetManifest round-trips with a computed manifestId', async () => {
    const manifestId = await computeAssetManifestId(manifestBody);
    const m = { ...manifestBody, manifestId, createdAt: T };
    expect(S.AssetManifestSchema.parse(m)).toEqual(m);
    // order-independent over entries, sensitive to parent
    const two = { ...manifestBody, entries: [...manifestBody.entries, { ...manifestBody.entries[0]!, path: 'a.png' }] };
    const twoRev = { ...two, entries: [...two.entries].reverse() };
    expect(await computeAssetManifestId(two)).toBe(await computeAssetManifestId(twoRev));
    expect(await computeAssetManifestId({ ...manifestBody, parentManifestId: H('9') })).not.toBe(manifestId);
  });

  it('toIsoUtc produces a valid timestamp that sorts chronologically', () => {
    const a = S.toIsoUtc(new Date(Date.UTC(2026, 9, 6, 12, 0, 0, 0)));
    const b = S.toIsoUtc(new Date(Date.UTC(2026, 9, 6, 12, 0, 0, 500)));
    expect(S.IsoUtcTimestampSchema.parse(a)).toBe('2026-10-06T12:00:00.000Z');
    expect(a < b).toBe(true);
  });

  it('computeAssetManifestId ignores unknown entry keys', async () => {
    const extra = { ...manifestBody, entries: [{ ...manifestBody.entries[0]!, dbRowId: 42 } as (typeof manifestBody.entries)[number]] };
    expect(await computeAssetManifestId(extra)).toBe(await computeAssetManifestId(manifestBody));
    expect(computeAssetManifestIdSync(extra)).toBe(await computeAssetManifestId(manifestBody));
  });

  it('accepts canonical remote URLs and absolute workspace roots', () => {
    for (const u of ['https://h.example/r.git', 'http://127.0.0.1:8080/git/ns/r.git', 'file:///tmp/repos/r.git', 'file:///C:/repos/r.git']) {
      expect(S.RemoteUrlSchema.safeParse(u).success, u).toBe(true);
    }
    for (const r of ['/tmp/ws', '/', 'C:\\ws', 'D:/work/ws']) {
      expect(S.MaterializationPlanSchema.safeParse({ workspaceRoot: r, mounts: [], contextFiles: [] }).success, r).toBe(true);
    }
  });

  it('a git mount may carry its LFS URL: https, or http on loopback', () => {
    const plan = samples.find(([n]) => n === 'MaterializationPlan')![2] as S.MaterializationPlan;
    const withLfs = (lfsUrl: string) => ({ ...plan, mounts: [{ ...plan.mounts[0]!, source: { ...plan.mounts[0]!.source, lfsUrl } }] });
    for (const u of ['https://cf.example/api/lfs/o1/web/info/lfs', 'http://127.0.0.1:8799/api/lfs/o1/web/info/lfs', 'http://localhost:8787/api/lfs/o1/web/info/lfs']) {
      const r = S.MaterializationPlanSchema.safeParse(withLfs(u));
      expect(r.success, u).toBe(true);
      expect(r.success && r.data.mounts[0]!.source.kind === 'git' && r.data.mounts[0]!.source.lfsUrl).toBe(u);
    }
    for (const u of ['http://cf.example/api/lfs/o1/web/info/lfs', 'file:///tmp/lfs', 'https://x:tok@cf.example/info/lfs', 'https://cf.example/info/lfs?x=1', ' https://cf.example/info/lfs', '/api/lfs/o1/web/info/lfs']) {
      expect(S.MaterializationPlanSchema.safeParse(withLfs(u)).success, u).toBe(false);
    }
  });

  it('CheckResult.required is optional and never added by parsing (signed evidence stays byte-identical)', () => {
    const c = { checkId: 'c', result: 'fail', startedAt: T, endedAt: T };
    expect(S.CheckResultSchema.parse(c)).toEqual(c);
    expect(S.CheckResultSchema.parse({ ...c, required: false })).toEqual({ ...c, required: false });
  });

  it('bind is a version kind and an idempotency scope', () => {
    const v = samples.find(([n]) => n === 'AcceptedProjectVersion')![2] as Record<string, unknown>;
    expect(S.AcceptedProjectVersionSchema.parse({ ...v, kind: 'bind', proposalId: null, proposalHash: null }).kind).toBe('bind');
    expect(S.IdempotencyScopeSchema.parse('bind')).toBe('bind');
  });

  it('provider error codes include the freeze codes', () => {
    for (const c of S.FreezeErrorCodeSchema.options) expect(S.ProviderErrorCodeSchema.options).toContain(c);
  });

  it('applies defaults', () => {
    expect(S.CheckSpecSchema.parse({ checkId: 'c', mountName: 'm', command: 'x' })).toMatchObject({ timeoutSeconds: 600, required: true });
    const em = S.EditionManifestServerSideSchema.parse({ ...samples.find(([n]) => n === 'EditionManifestServerSide')![2] as object, protectedPaths: undefined });
    expect(em.protectedPaths).toEqual([]);
  });
});

describe('schema rejections', () => {
  it.each<[string, z.ZodType, unknown]>([
    ['ResourceRef with mismatched coords kind', S.ResourceRefSchema, { ...resourceRef, provider: 'local-git' }],
    ['remote URL with credentials', S.ArtifactsCoordsSchema, { ...artCoords, remoteUrl: 'https://x:tok@h.example/r.git' }],
    ['non-normalized path', S.TreeEntrySchema, { path: 'a/../b', type: 'file' }],
    ['dot-prefixed mount name', S.SnapshotEntrySchema, { resourceId: 'web', revisionId: `art:web:${G('a')}`, mode: 'pinned-reference', mountName: '.commonforge', operations: ['read'] }],
    ['mount name with slash', S.SnapshotEntrySchema, { resourceId: 'web', revisionId: `art:web:${G('a')}`, mode: 'pinned-reference', mountName: 'a/b', operations: ['read'] }],
    ['duplicate mount names', S.ProjectSnapshotSchema, { snapshotId: H('2'), projectId: 'p1', organizationId: 'o1', membershipRevision: 1, policyRevision: 1, createdAt: T, entries: [
      { resourceId: 'a', revisionId: `art:a:${G('a')}`, mode: 'pinned-reference', mountName: 'm', operations: ['read'] },
      { resourceId: 'b', revisionId: `art:b:${G('b')}`, mode: 'pinned-reference', mountName: 'm', operations: ['read'] }] }],
    ['abbreviated sha', S.FreezeInputSchema, { expectedSha: 'abc123', submitter: principal }],
    ['git ref with colon', S.GitRefSchema, 'refs/commonforge/candidates/cand:ws:abc'],
    ['ttl below Artifacts minimum', S.WorkspaceGrantSchema, { principal, operations: ['read'], ttlSeconds: 30, leaseGeneration: 0 }],
    ['unknown outbox kind', S.OutboxEventSchema, { eventId: 'e', organizationId: 'o', dedupeKey: 'd', createdAt: T, kind: 'nope', payload: {} }],
    ['bad timestamp', S.AcceptedHeadSchema, { resourceId: 'web', revisionId: `art:web:${G('a')}`, versionSeq: 1, acceptedVersionId: null, acceptedAt: 'yesterday', reconciliation: 'synced' }],
    ['timestamp with offset', S.ApprovalRefSchema, { approvalId: 'ap1', proposalId: 'prop1', proposalHash: H('1'), approver: { kind: 'user', id: 'u1' }, role: 'owner', approvedAt: '2026-10-06T14:00:00.000+02:00' }],
    ['timestamp without millis', S.AcceptedHeadSchema, { resourceId: 'web', revisionId: `art:web:${G('a')}`, versionSeq: 1, acceptedVersionId: null, acceptedAt: '2026-10-06T12:00:00Z', reconciliation: 'synced' }],
    ['frozen candidate without fork', S.FrozenCandidateSchema, { ...frozen, fork: undefined }],
    ...[' https://h.example/r.git', 'https://h.example/r.git ', 'HTTPS://h.example/r.git', 'https://h.example/r\n.git', 'https://h.example/r\t.git', 'https:\\\\h.example\\r.git', 'https://h.example/a b.git', 'https:/h.example/r.git', 'ftp://h.example/r.git', 'file:/tmp/r.git']
      .map((u): [string, z.ZodType, unknown] => [`remote URL ${JSON.stringify(u)}`, S.RemoteUrlSchema, u]),
    ...['ws', './ws', '', '/tmp/../etc', '/tmp/./ws', '/tmp/ws\u0000', 'C:ws']
      .map((r): [string, z.ZodType, unknown] => [`workspaceRoot ${JSON.stringify(r)}`, S.MaterializationPlanSchema, { workspaceRoot: r, mounts: [], contextFiles: [] }]),
    ['versionSeq zero', S.AcceptedHeadSchema, { resourceId: 'web', revisionId: `art:web:${G('a')}`, versionSeq: 0, acceptedVersionId: null, acceptedAt: T, reconciliation: 'synced' }],
  ])('rejects %s', (_n, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
