/**
 * `prepare-candidate` (plan §A.6 Prepared, §B.8): copy a frozen candidate from its task fork into
 * the canonical repository under its retention ref `refs/commonforge/candidates/<ws>/<sha>`, so
 * the candidate survives fork collection and `integrate` reads it from canonical only.
 *
 * Checks before anything is written (all `scope_violation`): the retention ref is absent or
 * already holds this sha (idempotent retry); the fetched commit's tree is the frozen `treeId`; the
 * candidate descends from its recorded base; and the paths it changes relative to that base are
 * exactly the frozen `changedPaths` (the Worker scope-checks those, so they must not lie).
 */
import { revisionCommitSha, type RevisionId } from '@commonforge-org/core';
import type { JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { fetchCommits, remoteRef, requirePushed, scratchRepo } from './common.js';

export async function prepareCandidate(ctx: JobContext<'prepare-candidate'>): Promise<JobReceiptByKind['prepare-candidate']> {
  const { candidate, canonical, retentionRef } = ctx.job;
  const dir = await scratchRepo(ctx, 'prepare');
  const existing = await remoteRef(ctx, dir, canonical, retentionRef, 'write');
  if (existing !== null && existing !== candidate.sha) {
    // a retention ref names its sha; another sha there is a conflicting claim no retry fixes
    throw new JobFailure('scope_violation', `${retentionRef} already holds ${existing}`);
  }
  if (existing === null) {
    await fetchCommits(ctx, dir, candidate.fork, [candidate.sha], `candidate ${candidate.sha}`);
    const tree = (await ctx.git.ok(['rev-parse', '--verify', '--end-of-options', `${candidate.sha}^{tree}`], dir)).trim();
    if (tree !== candidate.treeId) throw new JobFailure('scope_violation', `candidate tree ${tree} != frozen treeId ${candidate.treeId}`);

    const baseSha = revisionCommitSha(candidate.baseRevision as RevisionId);
    if (!baseSha) throw new JobFailure('scope_violation', `candidate base ${candidate.baseRevision} is not a git revision`);
    await fetchCommits(ctx, dir, canonical, [baseSha], `candidate base ${baseSha}`);
    if ((await ctx.git.run(['merge-base', '--is-ancestor', baseSha, candidate.sha], dir)).code !== 0) {
      throw new JobFailure('scope_violation', `candidate ${candidate.sha} does not descend from its base ${baseSha}`);
    }
    const changed = (await ctx.git.ok(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', baseSha, candidate.sha, '--'], dir))
      .split('\0')
      .filter(Boolean)
      .sort();
    const declared = [...new Set(candidate.changedPaths)].sort();
    if (changed.length !== declared.length || changed.some((p, i) => p !== declared[i])) {
      const extra = changed.filter((p) => !declared.includes(p)).slice(0, 20);
      throw new JobFailure('scope_violation', `candidate changes paths not in its frozen changedPaths: ${extra.join(', ') || '(declared paths unchanged)'}`);
    }

    const outcome = await ctx.push({ coords: canonical, ref: retentionRef, sha: candidate.sha, dir });
    requirePushed(ctx, outcome, `retaining ${candidate.candidateId}`);
  }
  return {
    receiptId: `rcpt-${ctx.jobId}`,
    jobId: ctx.jobId,
    candidateId: candidate.candidateId,
    resourceId: candidate.resourceId,
    canonicalRef: retentionRef,
    sha: candidate.sha,
    revisionId: ctx.revisionFor(canonical, candidate.sha),
    verifiedAssetObjects: [],
    preparedAt: ctx.nowIso(),
  };
}
