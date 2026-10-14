/**
 * `build-edition` (plan §F "Client source/history disclosure", AT-26): a fresh-history edition
 * repository built from canonical shas and an explicit allowlist.
 *
 * - Canonical repos are read only; only the `-editions` repo is written.
 * - Files are selected by `include` globs on canonical paths under `canonicalPathPrefix`, then
 *   `exclude` globs (default `**\/.env*`) and the always-protected segments (`.git`,
 *   `.commonforge`, `.vibecontrol`) remove files; symlinks and submodules are never copied.
 * - The edition is built without a working tree in a brand-new bare repository: only the selected
 *   blobs are copied in (`hash-object -w`), one tree, ONE parentless commit. Nothing of canonical
 *   history, other refs or other objects can be in it.
 * - Before pushing, the runner asserts the repository holds exactly that commit, its trees and the
 *   selected blobs (no stray object), and that no configured canary string occurs in any path or
 *   blob. Any violation fails the job (`scope_violation`) and nothing is pushed.
 * - Push `refs/heads/main` leased on the value observed just before (a rebuild replaces it).
 */
import { join } from 'node:path';
import { checkPath, hasAlwaysProtectedSegment, isWithinPrefix, matchesPathPattern, sha256HexSync } from '@commonforge-org/core';
import { EDITION_BRANCH_REF, type JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { lsTree, RUNNER_IDENTITY_ENV } from '../git.js';
import { catFileBatch } from '../tree.js';
import { fetchCommits, requirePushed, scratchRepo } from './common.js';

interface Selected {
  editionPath: string;
  mode: '100644' | '100755';
  oid: string;
  bytes: Uint8Array;
}

export async function buildEdition(ctx: JobContext<'build-edition'>): Promise<JobReceiptByKind['build-edition']> {
  const job = ctx.job;
  const selected = new Map<string, Selected>();
  for (const s of job.sources) {
    const src = await scratchRepo(ctx, `edition-src-${s.resourceId}`);
    await fetchCommits(ctx, src, s.canonical, [s.sha], `edition source ${s.resourceId}@${s.sha}`);
    const picked: Array<{ path: string; editionPath: string; mode: Selected['mode']; oid: string }> = [];
    for (const f of await lsTree(ctx.git, src, s.sha)) {
      if (f.type !== 'blob' || (f.mode !== '100644' && f.mode !== '100755')) continue; // no symlinks, no submodules
      if (!isWithinPrefix(f.path, s.canonicalPathPrefix)) continue;
      if (!s.include.some((p) => matchesPathPattern(f.path, p))) continue;
      const rel = s.canonicalPathPrefix === '' ? f.path : f.path.slice(s.canonicalPathPrefix.length + 1);
      const ep = checkPath([s.editionPathPrefix, rel].filter(Boolean).join('/'));
      if (!ep.ok) throw new JobFailure('scope_violation', `edition path for ${f.path} is invalid (${ep.violation})`);
      if (job.exclude.some((p) => matchesPathPattern(f.path, p) || matchesPathPattern(ep.path, p))) continue;
      if (hasAlwaysProtectedSegment(f.path) || hasAlwaysProtectedSegment(ep.path)) continue;
      if (selected.has(ep.path) || picked.some((x) => x.editionPath === ep.path)) throw new JobFailure('scope_violation', `two sources map to edition path ${ep.path}`);
      picked.push({ path: f.path, editionPath: ep.path, mode: f.mode, oid: f.oid });
    }
    const contents = await catFileBatch(ctx.git, src, picked.map((p) => p.oid));
    for (const p of picked) selected.set(p.editionPath, { editionPath: p.editionPath, mode: p.mode, oid: p.oid, bytes: contents.get(p.oid)! });
  }

  // fresh repository: only the selected blobs, one tree, one parentless commit
  const ed = await scratchRepo(ctx, 'edition');
  for (const f of selected.values()) {
    const oid = (await ctx.git.ok(['hash-object', '-w', '--stdin'], ed, { input: f.bytes })).trim();
    if (oid !== f.oid) throw new JobFailure('provider_unavailable', `blob copy mismatch for ${f.editionPath}`);
  }
  const indexEnv = { GIT_INDEX_FILE: join(await ctx.scratch('edition-index'), 'index') };
  const entries = [...selected.values()].sort((a, b) => (a.editionPath < b.editionPath ? -1 : 1));
  await ctx.git.ok(['update-index', '--add', '-z', '--index-info'], ed, { env: indexEnv, input: entries.map((e) => `${e.mode} ${e.oid}\t${e.editionPath}\0`).join('') });
  const tree = (await ctx.git.ok(['write-tree'], ed, { env: indexEnv })).trim();
  const commit = (await ctx.git.ok(['commit-tree', tree, '-m', `CommonForge edition ${job.editionId}`], ed, { env: RUNNER_IDENTITY_ENV(ctx.commitDate()) })).trim();

  await assertFreshEdition(ctx, ed, commit, entries);

  const outcome = await ctx.push({ coords: job.editionRepo, ref: EDITION_BRANCH_REF, sha: commit, dir: ed });
  requirePushed(ctx, outcome, `publishing edition ${job.editionId}`);
  return {
    jobId: ctx.jobId,
    editionId: job.editionId,
    sha: commit,
    revisionId: ctx.revisionFor(job.editionRepo, commit),
    inventory: entries.map((e) => ({ editionPath: e.editionPath, sha256: sha256HexSync(e.bytes), size: e.bytes.length })),
    builtAt: ctx.nowIso(),
  };
}

/** The AT-26 tripwire: exactly one commit, no stray objects, only selected blobs, no canary. */
async function assertFreshEdition(ctx: JobContext<'build-edition'>, dir: string, commit: string, entries: Selected[]): Promise<void> {
  const reachable = (await ctx.git.ok(['rev-list', '--objects', commit], dir)).split('\n').filter(Boolean).map((l) => l.split(' ')[0]!);
  const all = (await ctx.git.ok(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'], dir)).split('\n').filter(Boolean);
  const allOids = new Set(all.map((l) => l.split(' ')[0]!));
  const commits = all.filter((l) => l.endsWith(' commit'));
  if (commits.length !== 1 || allOids.size !== new Set(reachable).size || reachable.some((o) => !allOids.has(o))) {
    throw new JobFailure('scope_violation', `edition repository is not a single fresh commit (${commits.length} commits, ${allOids.size} objects, ${reachable.length} reachable)`);
  }
  const allowedBlobs = new Set(entries.map((e) => e.oid));
  for (const l of all) {
    const [oid, type] = l.split(' ');
    if (type === 'blob' && !allowedBlobs.has(oid!)) throw new JobFailure('scope_violation', `edition holds an unselected blob ${oid}`);
  }
  if ((await ctx.git.run(['rev-parse', '--verify', '-q', `${commit}^`], dir)).code === 0) throw new JobFailure('scope_violation', 'edition commit has a parent');
  const canaries = ctx.services.canaries.filter((c) => c.length > 0);
  if (canaries.length > 0) {
    for (const e of entries) {
      const text = Buffer.from(e.bytes).toString('latin1');
      const hit = canaries.find((c) => text.includes(c) || e.editionPath.includes(c));
      if (hit) throw new JobFailure('scope_violation', `edition file ${e.editionPath} contains a canary string`);
    }
  }
}
