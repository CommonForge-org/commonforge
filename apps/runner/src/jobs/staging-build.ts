/**
 * staging-build (spec 2026-10-07 §5): main + each landing's change set, in landing order. A
 * landing's change set is the diff from the commit its task started from (`baseSha`, usually an
 * earlier staging commit) to its candidate, so it is applied with that commit as the explicit
 * merge base: only the task's own edits move, never other tasks' work it happened to start on.
 * The result is pushed to refs/commonforge/staging-builds/<buildId> and then refs/commonforge/staging; main is never touched.
 */
import { candidateRetentionRef, type RepoCoords, type ResourceId } from '@commonforge-org/core';
import { STAGING_REF, stagingBuildRef, type JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { fetchRef, RUNNER_IDENTITY_ENV } from '../git.js';
import { fetchCommits, requirePushed, scratchRepo } from './common.js';

export async function stagingBuild(ctx: JobContext<'staging-build'>): Promise<JobReceiptByKind['staging-build']> {
  const job = ctx.job;
  const merged: Array<{ resourceId: ResourceId; dir: string; sha: string; coords: RepoCoords }> = [];
  for (const t of job.targets) {
    const dir = await scratchRepo(ctx, `staging-${t.resourceId}`);
    const env = await ctx.writeEnv(t.canonical);
    await fetchCommits(ctx, dir, t.canonical, [t.mainSha], `main ${t.mainSha}`);
    let current: string = t.mainSha;
    for (const l of t.landings) {
      for (const c of l.candidates) {
        const fetched = await fetchRef(ctx.git, dir, t.canonical.remoteUrl, candidateRetentionRef(c.candidateId), env);
        if (fetched !== c.sha) throw new JobFailure('provider_unavailable', `candidate ${c.candidateId} is not retained in canonical; prepare it first`);
        await fetchCommits(ctx, dir, t.canonical, [c.baseSha], `base ${c.baseSha} of ${c.candidateId}`);
        const mt = await ctx.git.run(['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', `--merge-base=${c.baseSha}`, current, c.sha], dir);
        const parts = mt.stdout.split('\0').filter(Boolean);
        if (mt.code === 1) throw new JobFailure('textual_conflict', ctx.redact(`landing ${l.landingId} conflicts in ${t.resourceId}: ${[...new Set(parts.slice(1))].sort().join(', ')}`));
        if (mt.code !== 0 || !parts[0]) throw new JobFailure('provider_unavailable', ctx.redact(`staging merge of ${c.candidateId} failed: ${mt.stderr.trim()}`));
        const msg = `staging ${l.landingId}\n\nbuild ${job.buildId}\ncandidate ${c.candidateId}\njob ${ctx.jobId}\n`;
        current = (await ctx.git.ok(['commit-tree', parts[0], '-p', current, '-p', c.sha, '-m', msg], dir, { env: RUNNER_IDENTITY_ENV(ctx.commitDate()) })).trim();
      }
    }
    merged.push({ resourceId: t.resourceId, dir, sha: current, coords: t.canonical });
  }
  // every target's per-build ref first (absent lease; an identical sha on retry counts as done), then every
  // target's moving staging ref, so a refused build ref never leaves any staging ref moved while the job fails
  for (const m of merged) requirePushed(ctx, await ctx.push({ coords: m.coords, ref: stagingBuildRef(job.buildId), sha: m.sha, dir: m.dir }), `staging build ref push to ${m.resourceId}`);
  for (const m of merged) requirePushed(ctx, await ctx.push({ coords: m.coords, ref: STAGING_REF, sha: m.sha, dir: m.dir }), `staging push to ${m.resourceId}`);
  return { jobId: ctx.jobId, buildId: job.buildId, results: merged.map((m) => ({ resourceId: m.resourceId, sha: m.sha, revisionId: ctx.revisionFor(m.coords, m.sha) })), builtAt: ctx.nowIso() };
}
