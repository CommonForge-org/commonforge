/**
 * `seed-workspace`: give a fresh `-tasks` repository its base commit (Artifacts cannot fork across
 * namespaces). Contract (runner-protocol README, Task 12 re-review):
 * - canonical is READ only; the task repo is written;
 * - exactly one refspec `<baseSha>:<ref>` with `--force-with-lease=<ref>:` (must not exist); never
 *   `--mirror`, never another ref, so no canonical service ref reaches a task repo;
 * - a lease failure where `ls-remote` shows `baseSha` is success (retries are idempotent);
 * - both tokens are revoked when the job ends (the credential session closes).
 */
import type { JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { fetchCommits, remoteRef, requirePushed, scratchRepo } from './common.js';

export async function seedWorkspace(ctx: JobContext<'seed-workspace'>): Promise<JobReceiptByKind['seed-workspace']> {
  const job = ctx.job;
  const dir = await scratchRepo(ctx, 'seed');
  const existing = await remoteRef(ctx, dir, job.taskFork, job.ref, 'write');
  if (existing !== null && existing !== job.baseSha) {
    throw new JobFailure('scope_violation', `${job.ref} in the task repository already holds ${existing}`);
  }
  if (existing === null) {
    await fetchCommits(ctx, dir, job.canonical, [job.baseSha], `base ${job.baseSha}`);
    const outcome = await ctx.push({ coords: job.taskFork, ref: job.ref, sha: job.baseSha, dir });
    requirePushed(ctx, outcome, `seeding ${job.ref}`);
  }
  return {
    jobId: ctx.jobId,
    taskWorkspaceId: job.taskWorkspaceId,
    resourceId: job.resourceId,
    ref: job.ref,
    sha: job.baseSha,
    seededAt: ctx.nowIso(),
  };
}
