/**
 * `init-folder` (folders phase 4, rulings P4-1 and P4-3): a new folder's first version.
 *
 * - Builds ONE parentless commit in a fresh bare repository, without a working tree: each file is
 *   written with `hash-object -w` (mode 100644, top level only), the tree with `mktree`. Author
 *   is the job's; the committer is `CommonForge <noreply@commonforge.invalid>`; both dates are
 *   `commitTime`. The commit id is therefore a function of the job.
 * - Pushes it to canonical `refs/heads/main` with lease `absent` (`jobAllowedPushRefs`). Nothing
 *   is fetched, and no other ref is read or written.
 * - main already holds this commit (a retried job) → `already`; main holds anything else →
 *   `branch_not_empty` (not retried: the folder fails); the push failed with main still absent
 *   (busy, network, auth) → `provider_unavailable`, as `reconcile-ref` does.
 */
import { INIT_FOLDER_BRANCH_REF, type JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { remoteRef, scratchRepo } from './common.js';

export const INIT_FOLDER_COMMITTER = { name: 'CommonForge', email: 'noreply@commonforge.invalid' } as const;

export async function initFolder(ctx: JobContext<'init-folder'>): Promise<JobReceiptByKind['init-folder']> {
  const job = ctx.job;
  const dir = await scratchRepo(ctx, 'init-folder');
  const entries: string[] = [];
  for (const f of job.files) {
    const oid = (await ctx.git.ok(['hash-object', '-w', '--stdin'], dir, { input: Buffer.from(f.content, 'utf8') })).trim();
    entries.push(`100644 blob ${oid}\t${f.path}\0`);
  }
  const tree = (await ctx.git.ok(['mktree', '-z'], dir, { input: entries.join('') })).trim();
  // git's raw date format: no parsing ambiguity, whole seconds, UTC
  const date = `${Date.parse(job.commitTime) / 1000} +0000`;
  const env = {
    GIT_AUTHOR_NAME: job.author.name,
    GIT_AUTHOR_EMAIL: job.author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: INIT_FOLDER_COMMITTER.name,
    GIT_COMMITTER_EMAIL: INIT_FOLDER_COMMITTER.email,
    GIT_COMMITTER_DATE: date,
  };
  const commit = (await ctx.git.ok(['commit-tree', tree, '-m', job.message], dir, { env })).trim();

  const receipt = (status: 'created' | 'already'): JobReceiptByKind['init-folder'] => ({ jobId: ctx.jobId, resourceId: job.resourceId, commitSha: commit, status });
  const notEmpty = (observed: string) => new JobFailure('branch_not_empty', ctx.redact(`${INIT_FOLDER_BRANCH_REF} on ${job.canonical.namespace}/${job.canonical.repoName} already holds ${observed}`));

  const before = await remoteRef(ctx, dir, job.canonical, INIT_FOLDER_BRANCH_REF, 'write');
  if (before === commit) return receipt('already');
  if (before !== null) throw notEmpty(before);
  const outcome = await ctx.push({ coords: job.canonical, ref: INIT_FOLDER_BRANCH_REF, sha: commit, dir });
  if (outcome.status === 'pushed') return receipt('created');
  if (outcome.status === 'already') return receipt('already');
  if (outcome.observed !== null) throw notEmpty(outcome.observed);
  throw new JobFailure('provider_unavailable', ctx.redact(`creating ${INIT_FOLDER_BRANCH_REF} failed with it still absent: ${outcome.detail.slice(-1500)}`));
}
