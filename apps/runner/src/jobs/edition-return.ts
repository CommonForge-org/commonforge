/**
 * `edition-return` (plan §B.13, AT-27/28/29): turn a client's returned edition ZIP into a candidate
 * in a fresh task fork, without the client ever touching canonical.
 *
 * 1. Stale check: the ledger head (when provided) must equal `target.expectedHead`.
 * 2. Read the upload from object storage and unzip it in memory with the safe reader: traversal,
 *    absolute paths, symlinks, special files, duplicates, case collisions, zip bombs and lying
 *    headers fail the whole return (`scope_violation`); nothing is ever extracted to disk.
 * 3. `diffAgainstInventory` + `mapEditionDelta` (core): only writable, unprotected, mapped paths of
 *    the target resource are allowed; everything else is reported as blocked, nothing is dropped.
 * 4. Apply the allowed changes to the target's tree at `expectedHead` without a working tree (a
 *    temporary index). A change whose base content no longer matches canonical at expectedHead
 *    (the file moved on since the edition was built) is a `textual_conflict` listing the paths.
 * 5. Push the single resulting commit to the fresh candidate fork's `refs/heads/main` with a
 *    must-not-exist lease (canonical is read only for this job).
 */
import { join } from 'node:path';
import {
  candidateId,
  caseFoldKey,
  CoreError,
  diffAgainstInventory,
  mapEditionDelta,
  revisionCommitSha,
  sha256HexSync,
  type BlockedChange,
  type MappedChange,
  type RevisionId,
} from '@commonforge-org/core';
import { EDITION_RETURN_BRANCH_REF, type JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { lsTree, RUNNER_IDENTITY_ENV } from '../git.js';
import { catFileBatch } from '../tree.js';
import { readZip, ZipError } from '../zip.js';
import { fetchCommits, requirePushed, scratchRepo } from './common.js';

/** Limits for returned editions (a client return is small source, never media). */
export const EDITION_RETURN_LIMITS = { maxFiles: 10_000, maxTotalBytes: 256 * 1024 * 1024, maxCompressionRatio: 100 };

export async function editionReturn(ctx: JobContext<'edition-return'>): Promise<JobReceiptByKind['edition-return']> {
  const { edition, upload, target, candidateFork } = ctx.job;
  const head = await ctx.currentHead(target.resourceId);
  if (head !== undefined && head !== target.expectedHead) {
    throw new JobFailure('stale_base', `${target.resourceId}: ledger head is ${head ?? 'none'}, expected ${target.expectedHead}`);
  }

  const bytes = await ctx.blobs().get(upload.r2Key);
  if (!bytes) throw new JobFailure('provider_unavailable', `upload ${upload.r2Key} not found`);
  let zip;
  try {
    zip = readZip(bytes, EDITION_RETURN_LIMITS);
  } catch (e) {
    if (e instanceof ZipError) throw new JobFailure('scope_violation', `upload refused (${e.reason}): ${e.message}`);
    throw e;
  }
  if (zip.rejected.length > 0) {
    throw new JobFailure('scope_violation', `upload refused: ${zip.rejected.slice(0, 20).map((r) => `${r.path} (${r.reason})`).join(', ')}`);
  }
  const content = new Map(zip.entries.map((e) => [e.path, e.data]));

  let mapped: { allowed: MappedChange[]; blocked: BlockedChange[] };
  try {
    const delta = diffAgainstInventory(
      edition.inventory,
      zip.entries.map((e) => ({ path: e.path, sha256: sha256HexSync(e.data) })),
      upload.mode,
      upload.deletions ?? [],
    );
    mapped = mapEditionDelta(delta, edition);
  } catch (e) {
    if (e instanceof CoreError) throw new JobFailure('scope_violation', `invalid edition return: ${e.message}`);
    throw e;
  }
  let allowed = mapped.allowed.filter((a) => a.resourceId === target.resourceId);
  // changes for resources this job cannot write are reported, never applied
  const blocked: BlockedChange[] = [...mapped.blocked, ...mapped.allowed.filter((a) => a.resourceId !== target.resourceId).map((a) => ({ path: a.editionPath, reason: 'not_mapped' as const }))];
  const sortBlocked = () => blocked.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  sortBlocked();
  const receipt = (candidate?: { sha: string }): JobReceiptByKind['edition-return'] => ({
    jobId: ctx.jobId,
    editionId: edition.editionId,
    resourceId: target.resourceId,
    ...(candidate ? { candidate: { candidateId: candidateId(candidateFork.taskWorkspaceId, candidate.sha), taskWorkspaceId: candidateFork.taskWorkspaceId, sha: candidate.sha } } : {}),
    expectedHead: target.expectedHead,
    allowed,
    blocked,
    returnedAt: ctx.nowIso(),
  });
  if (allowed.length === 0) return receipt();

  // apply onto the target at expectedHead (canonical read only)
  const baseSha = revisionCommitSha(target.expectedHead as RevisionId)!;
  const dir = await scratchRepo(ctx, 'edition-return');
  await fetchCommits(ctx, dir, target.canonical, [baseSha], `expected head ${baseSha}`);
  const tree = new Map((await lsTree(ctx.git, dir, baseSha)).map((f) => [f.path, f]));
  // Review M-2/I-2: a new path may not land on (or differ only by case from) an existing canonical
  // file that the edition does not publish. Reported as `not_mapped`, exactly like a path outside
  // the edition, so a return can never probe which unpublished files exist or what they contain.
  // Re-review R-1: nor may it be a file where the tree has a folder (`tests` over `tests/…`), or sit
  // below an existing file (`secret/notes.md/x`): git would silently drop the other entries.
  const folded = new Set([...tree.keys()].map((p) => caseFoldKey(p)));
  const foldedDirs = new Set<string>();
  const exactDirs = new Set<string>();
  for (const p of tree.keys()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      exactDirs.add(parts.slice(0, i).join('/'));
      foldedDirs.add(caseFoldKey(parts.slice(0, i).join('/')));
    }
  }
  const unpublishedHit = (p: string) => {
    const f = caseFoldKey(p);
    if (tree.has(p) || folded.has(f) || foldedDirs.has(f)) return true;
    const parts = f.split('/');
    const exact = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join('/');
      if (folded.has(anc)) return true; // below an existing file
      if (foldedDirs.has(anc) && !exactDirs.has(exact.slice(0, i).join('/'))) return true; // a folder's case variant
    }
    return false;
  };
  const refusedFolds = new Set<string>();
  allowed = allowed.filter((a) => {
    if ((a.kind === 'added' || a.kind === 'renamed') && unpublishedHit(a.canonicalPath)) {
      blocked.push({ path: a.editionPath, reason: 'not_mapped' });
      if (a.kind === 'renamed') blocked.push({ path: a.oldEditionPath!, reason: 'not_mapped' });
      refusedFolds.add(caseFoldKey(a.canonicalPath));
      return false;
    }
    return true;
  });
  // never delete the published file whose replacement was refused
  allowed = allowed.filter((a) => {
    if (a.kind === 'deleted' && refusedFolds.has(caseFoldKey(a.canonicalPath))) {
      blocked.push({ path: a.editionPath, reason: 'not_mapped' });
      return false;
    }
    return true;
  });
  sortBlocked();
  if (allowed.length === 0) return receipt();
  const touched = allowed.flatMap((a) => [a.canonicalPath, ...(a.oldCanonicalPath ? [a.oldCanonicalPath] : [])]);
  const blobs = await catFileBatch(ctx.git, dir, touched.map((p) => tree.get(p)).filter((f) => f?.type === 'blob').map((f) => f!.oid));
  const currentHash = (path: string): string | null => {
    const f = tree.get(path);
    if (!f) return null;
    const b = blobs.get(f.oid);
    return b ? sha256HexSync(b) : `non-file:${f.mode}`;
  };

  const ZERO = '0'.repeat(baseSha.length);
  const conflicts: string[] = [];
  const ops: string[] = [];
  const write = async (path: string, editionPath: string) => {
    const data = content.get(editionPath);
    if (!data) throw new JobFailure('scope_violation', `returned content for ${editionPath} is missing`);
    const oid = (await ctx.git.ok(['hash-object', '-w', '--stdin'], dir, { input: data })).trim();
    const mode = tree.get(path)?.mode === '100755' ? '100755' : '100644';
    ops.push(`${mode} ${oid}\t${path}\0`);
  };
  for (const a of allowed) {
    const now = currentHash(a.canonicalPath);
    switch (a.kind) {
      case 'modified':
        if (now !== a.previousSha256) conflicts.push(a.canonicalPath);
        else await write(a.canonicalPath, a.editionPath);
        break;
      case 'added':
        if (now !== null && now !== a.sha256) conflicts.push(a.canonicalPath);
        else await write(a.canonicalPath, a.editionPath);
        break;
      case 'deleted':
        if (now === null) break;
        if (now !== a.previousSha256) conflicts.push(a.canonicalPath);
        else ops.push(`0 ${ZERO}\t${a.canonicalPath}\0`);
        break;
      case 'renamed': {
        const old = currentHash(a.oldCanonicalPath!);
        if (old !== a.previousSha256 || (now !== null && now !== a.sha256)) conflicts.push(a.oldCanonicalPath!);
        else {
          ops.push(`0 ${ZERO}\t${a.oldCanonicalPath}\0`);
          await write(a.canonicalPath, a.editionPath);
        }
        break;
      }
    }
  }
  if (conflicts.length > 0) {
    throw new JobFailure('textual_conflict', `${target.resourceId}: conflict in ${[...new Set(conflicts)].sort().join(', ')} (changed in canonical since the edition was built)`);
  }
  const indexEnv = { GIT_INDEX_FILE: join(await ctx.scratch('edition-return-index'), 'index') };
  await ctx.git.ok(['read-tree', baseSha], dir, { env: indexEnv });
  await ctx.git.ok(['update-index', '-z', '--index-info'], dir, { env: indexEnv, input: ops.join('') });
  const newTree = (await ctx.git.ok(['write-tree'], dir, { env: indexEnv })).trim();
  const baseTree = (await ctx.git.ok(['rev-parse', `${baseSha}^{tree}`], dir)).trim();
  if (newTree === baseTree) return receipt();
  // Tripwire (re-review R-1): the candidate may differ from the base only in the allowed paths;
  // anything else (an entry git dropped or replaced on its own) fails the job, nothing is pushed.
  const allowedPaths = new Set(allowed.flatMap((a) => [a.canonicalPath, ...(a.oldCanonicalPath ? [a.oldCanonicalPath] : [])]));
  const changed = (await ctx.git.ok(['diff-tree', '-r', '-z', '--no-renames', '--name-only', baseTree, newTree], dir)).split('\0').filter(Boolean);
  const stray = changed.filter((p) => !allowedPaths.has(p));
  if (stray.length > 0) throw new JobFailure('scope_violation', `the candidate would change ${stray.length} path(s) outside the allowed changes`);
  const msg = `edition return ${edition.editionId}\n\njob ${ctx.jobId}\n`;
  const sha = (await ctx.git.ok(['commit-tree', newTree, '-p', baseSha, '-m', msg], dir, { env: RUNNER_IDENTITY_ENV(ctx.commitDate()) })).trim();
  const outcome = await ctx.push({ coords: candidateFork.coords, ref: EDITION_RETURN_BRANCH_REF, sha, dir });
  requirePushed(ctx, outcome, `pushing the edition return candidate`);
  return receipt({ sha });
}
