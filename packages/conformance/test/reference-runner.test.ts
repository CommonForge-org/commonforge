import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { computeSnapshotIdSync, localRevisionId } from '@commonforge-org/core';
import { verifyEvidence } from '@commonforge-org/runner-protocol';
import {
  commitFiles,
  createReferenceRunner,
  createSeedRepo,
  createTempDir,
  fileUrl,
  gitBlobOid,
  gitOk,
  nodeGitRunner,
  removeDir,
} from '../src/provider.js';

const git = nodeGitRunner();
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await removeDir(d);
});

describe('reference runner', () => {
  it('gitBlobOid matches git hash-object', async () => {
    expect(await gitBlobOid(new TextEncoder().encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('reconcile-ref: a failed push with the ref unmoved is provider_unavailable, not diverged', async () => {
    const root = await createTempDir();
    dirs.push(root);
    const seed = await createSeedRepo(git, join(root, 'seed'), { 'a.txt': 'a\n' });
    const target = await commitFiles(git, seed.path, { 'a.txt': 'b\n' }, 'target');
    const canonical = join(root, 'canonical.git');
    await gitOk(git, ['clone', '-q', '--bare', seed.path, canonical], root);
    await gitOk(git, ['update-ref', 'refs/heads/main', seed.sha], canonical);
    await gitOk(git, ['update-ref', 'refs/commonforge/candidates/ws-x/' + target, target], canonical);
    // every push is refused (stands in for receive-pack busy / network failure)
    await writeFile(join(canonical, 'hooks', 'pre-receive'), '#!/bin/sh\necho busy >&2\nexit 1\n');
    await chmod(join(canonical, 'hooks', 'pre-receive'), 0o755);
    await gitOk(git, ['config', 'core.hooksPath', join(canonical, 'hooks')], canonical);

    const { submit } = createReferenceRunner({ git, workDir: join(root, 'runner') });
    const coords = { kind: 'local-git' as const, namespace: 'unit-canonical', repoName: 'c', repoId: 'c', remoteUrl: fileUrl(canonical) };
    const out = await submit({ kind: 'reconcile-ref', canonical: coords, ref: 'refs/heads/main', targetSha: target, expectedCurrentSha: seed.sha });
    expect(out).toMatchObject({ ok: false, code: 'provider_unavailable' });
  });

  it('integrate: an assets-only job pushes nothing and signs evidence with an empty merge outcome', async () => {
    const root = await createTempDir();
    dirs.push(root);
    const seed = await createSeedRepo(git, join(root, 'seed'), { 'a.txt': 'a\n' });
    const canonical = join(root, 'canonical.git');
    await gitOk(git, ['clone', '-q', '--bare', seed.path, canonical], root);
    const refsBefore = await gitOk(git, ['for-each-ref', '--format=%(refname) %(objectname)'], canonical);
    const runner = createReferenceRunner({ git, workDir: join(root, 'runner') });
    const coords = { kind: 'local-git' as const, namespace: 'unit-canonical', repoName: 'c', repoId: 'c', remoteUrl: fileUrl(canonical) };
    const snapshotEntries = [{ resourceId: 'res-site', revisionId: localRevisionId('c', seed.sha), mode: 'pinned-reference', mountName: 'site', operations: ['read'] }];
    const snap = { projectId: 'p-1', organizationId: 'org1', membershipRevision: 1, policyRevision: 1, entries: snapshotEntries };
    const job = {
      kind: 'integrate' as const,
      proposalId: 'prop-1',
      proposalHash: 'd'.repeat(64),
      baseSnapshot: { ...snap, snapshotId: computeSnapshotIdSync(snap as never), createdAt: '2026-10-06T00:00:00.000Z' },
      candidateSnapshotId: 'c'.repeat(64),
      candidates: [],
      targets: [],
      assetChanges: [{ resourceId: 'res-brand', baseManifestId: 'e'.repeat(64), newManifestId: 'f'.repeat(64) }],
      references: [{ resourceId: 'res-site', coords }],
      integrationRef: 'refs/commonforge/integrations/prop-1/ref-job-1',
      checks: [],
      contracts: [],
    };
    const out = (await runner.submit(job)) as { ok: true; receipt: { results: unknown[]; evidence: { mergeOutcome: unknown[]; proposalHash: string; snapshotId: string } } };
    expect(out).toMatchObject({ ok: true, receipt: { results: [], evidence: { mergeOutcome: [], proposalHash: job.proposalHash, snapshotId: job.candidateSnapshotId } } });
    expect(await verifyEvidence(out.receipt.evidence, [runner.jobKey], { jobId: 'ref-job-1' })).toMatchObject({ ok: true });
    expect(await gitOk(git, ['for-each-ref', '--format=%(refname) %(objectname)'], canonical)).toBe(refsBefore);
    // neither git targets nor asset changes: the job is malformed
    await expect(runner.submit({ ...job, assetChanges: [] })).rejects.toThrow(/git targets or asset changes/);
  });

  it('seed-workspace: pushes exactly <baseSha>:<ref> once, is idempotent, and refuses a different existing sha', async () => {
    const root = await createTempDir();
    dirs.push(root);
    const seed = await createSeedRepo(git, join(root, 'seed'), { 'a.txt': 'a\n' });
    const other = await commitFiles(git, seed.path, { 'a.txt': 'b\n' }, 'later');
    const canonical = join(root, 'canonical.git');
    await gitOk(git, ['clone', '-q', '--bare', seed.path, canonical], root);
    await gitOk(git, ['update-ref', 'refs/commonforge/candidates/ws-o/' + other, other], canonical);
    const task = join(root, 'ws-1.git');
    await gitOk(git, ['init', '-q', '--bare', task], root);
    const { submit } = createReferenceRunner({ git, workDir: join(root, 'runner') });
    const job = {
      kind: 'seed-workspace' as const,
      taskWorkspaceId: 'tw-1',
      resourceId: 'res-1',
      canonical: { kind: 'local-git' as const, namespace: 'unit-canonical', repoName: 'c', repoId: 'c', remoteUrl: fileUrl(canonical) },
      baseSha: seed.sha,
      taskFork: { kind: 'local-git' as const, namespace: 'unit-tasks', repoName: 'ws-1', repoId: 'ws-1', remoteUrl: fileUrl(task) },
      ref: 'refs/heads/main',
    };
    expect(await submit(job)).toMatchObject({ ok: true, receipt: { sha: seed.sha, ref: 'refs/heads/main' } });
    expect(await submit(job)).toMatchObject({ ok: true });
    const refs = (await gitOk(git, ['for-each-ref', '--format=%(refname) %(objectname)'], task)).trim();
    expect(refs).toBe(`refs/heads/main ${seed.sha}`);
    expect(await submit({ ...job, baseSha: other })).toMatchObject({ ok: false, code: 'scope_violation' });
  });
});
