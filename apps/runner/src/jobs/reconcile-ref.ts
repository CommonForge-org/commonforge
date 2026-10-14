/**
 * `reconcile-ref` (plan §A.6 canonical ref projection): move canonical `ref` (normally
 * `refs/heads/main`) to the ledger head with `--force-with-lease=<ref>:<expectedCurrentSha>`.
 *
 * - already at `targetSha` → `synced` without pushing;
 * - push succeeded (or a retried push already landed) → `synced`;
 * - the ref holds something other than both the target and the lease → `diverged` (a concurrent
 *   writer moved it; the ledger stays authoritative and a later job re-syncs);
 * - the push failed and the ref is unmoved (busy, network, auth, expiry) → `provider_unavailable`,
 *   never `diverged` (review M-2).
 * The target commit must already be in canonical (retention/integration refs), so nothing is
 * fetched from anywhere else.
 */
import type { JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { fetchCommits, remoteRef, scratchRepo } from './common.js';

export async function reconcileRef(ctx: JobContext<'reconcile-ref'>): Promise<JobReceiptByKind['reconcile-ref']> {
  const { canonical, ref, targetSha, expectedCurrentSha } = ctx.job;
  const dir = await scratchRepo(ctx, 'reconcile');
  const result = (observedSha: string | null): JobReceiptByKind['reconcile-ref'] => ({
    jobId: ctx.jobId,
    ...(ctx.job.resourceId ? { resourceId: ctx.job.resourceId } : {}),
    ref,
    targetSha,
    observedSha,
    status: observedSha === targetSha ? 'synced' : 'diverged',
    reconciledAt: ctx.nowIso(),
  });
  const before = await remoteRef(ctx, dir, canonical, ref, 'write');
  if (before === targetSha) return result(before);
  if (before !== expectedCurrentSha) return result(before);
  await fetchCommits(ctx, dir, canonical, [targetSha], `target ${targetSha} (not retained in canonical)`);
  const outcome = await ctx.push({ coords: canonical, ref, sha: targetSha, dir });
  if (outcome.status === 'pushed' || outcome.status === 'already') return result(targetSha);
  if (outcome.status === 'lease_failed') return result(outcome.observed);
  if (outcome.observed !== expectedCurrentSha && outcome.observed !== targetSha) return result(outcome.observed);
  throw new JobFailure('provider_unavailable', ctx.redact(`reconcile push failed with ${ref} unmoved: ${'detail' in outcome ? outcome.detail.slice(-1500) : ''}`));
}
