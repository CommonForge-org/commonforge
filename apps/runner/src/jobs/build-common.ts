/**
 * Shared by `preview-build` and `release-build` (Task 22): materialize sources read-only at
 * pinned shas into an exported check tree, run the server-owned recipe steps as isolated
 * allowlisted commands (check uid, clean environment plus the step's non-secret env), and read
 * output directories without ever following a link out of the checkout.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { checkPath, type BuildRecipe, type RepoCoords } from '@commonforge-org/core';
import type { IntegrationJobKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { exportTree } from '../tree.js';
import { fetchCommits, scratchRepo } from './common.js';

export const MAX_FILES = 5_000;
export const MAX_BYTES = 200 * 1024 * 1024;
export const STEP_TIMEOUT_MS = 15 * 60_000;

export const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
};

export const contentTypeOf = (path: string) => CONTENT_TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

export interface BuildSource {
  resourceId: string;
  mountName: string;
  canonical: RepoCoords;
  sha: string;
}

/** Export every source at its sha into a fresh check tree (no `.git`); `runRecipe` hands it to the check uid. */
export async function materializeForBuild<K extends IntegrationJobKind>(ctx: JobContext<K>, label: string, sources: readonly BuildSource[]): Promise<string> {
  ctx.assertCheckIsolation();
  const root = await ctx.checkScratch(label);
  for (const s of sources) {
    const dir = await scratchRepo(ctx, `${label}-${s.mountName}`);
    await fetchCommits(ctx, dir, s.canonical, [s.sha], `${s.resourceId}@${s.sha}`);
    await exportTree(ctx.git, dir, s.sha, join(root, s.mountName));
  }
  return root;
}

/** Read a mount file from the materialized tree before any step ran (null if absent). Never follows links. */
export async function readSourceFile(root: string, mountName: string, path: string): Promise<string | null> {
  const p = checkPath(path);
  if (!p.ok) return null;
  const fh = await open(join(root, mountName, p.path), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

/** Run each recipe step; a refused command is `scope_violation`, a failing one `check_failed` (redacted tail). */
export async function runRecipe<K extends IntegrationJobKind>(ctx: JobContext<K>, root: string, recipe: BuildRecipe): Promise<void> {
  await ctx.prepareCheckDir(root);
  for (const step of recipe.steps) {
    ctx.assertNotExpired();
    const run = await ctx.runCommand(step.command, join(root, step.mountName), STEP_TIMEOUT_MS, step.env ?? {});
    if ('refused' in run) throw new JobFailure('scope_violation', `recipe step ${step.stepId}: ${run.refused}`);
    if (run.exitCode !== 0 || run.timedOut) {
      const tail = (run.stderr || run.stdout).slice(-2000);
      throw new JobFailure('check_failed', `recipe step ${step.stepId} (${step.command}) failed: exit ${run.exitCode ?? run.signal}\n${tail}`);
    }
  }
}

/**
 * Read the recipe output without ever following a link out of the checkout (review I-3). All
 * check processes are dead by now (runCommand reaps them), so the tree is static:
 * - the mount and every component of the output path must be real directories: the realpath of
 *   the output dir must equal the plain join of the mount's realpath and the path segments;
 * - directories are only entered when readdir reports a real directory (symlinks are skipped);
 * - with `allowFile`, the path may name a single regular file (returned with an empty `path`);
 * - files are opened with O_NOFOLLOW and must be regular files with a single link (a hard link
 *   could alias a file outside the checkout) and, with a check uid, owned by it — or, with
 *   `ownedBy: 'runner'`, by the runner itself: files read before `runRecipe` hands the tree to the
 *   check uid (release-build's data files; staging Phase 4-1 found that requiring the check uid
 *   there failed every release with migrations, `… is not a plain file of the build`).
 */
export async function collectOutput<K extends IntegrationJobKind>(ctx: JobContext<K>, root: string, mountName: string, outPath: string, opts: { allowFile?: boolean; ownedBy?: 'check' | 'runner' } = {}): Promise<Array<{ path: string; data: Uint8Array }>> {
  const mountDir = join(root, mountName);
  const ml = await lstat(mountDir).catch(() => null);
  if (!ml || ml.isSymbolicLink() || !ml.isDirectory()) throw new JobFailure('scope_violation', `mount ${mountName} is no longer a directory`);
  const segments = outPath.split('/').filter(Boolean);
  const expected = join(await realpath(mountDir), ...segments);
  if ((await realpath(mountDir)) !== join(await realpath(root), mountName)) throw new JobFailure('scope_violation', `mount ${mountName} escapes the checkout`);
  let real: string;
  try {
    real = await realpath(join(mountDir, ...segments));
  } catch {
    throw new JobFailure('check_failed', `recipe output ${mountName}/${outPath} was not produced`);
  }
  if (real !== expected) throw new JobFailure('scope_violation', `recipe output ${mountName}/${outPath} resolves outside the checkout`);
  const realStat = await lstat(real);
  const isSingleFile = opts.allowFile === true && realStat.isFile();
  if (!realStat.isDirectory() && !isSingleFile) throw new JobFailure('check_failed', `recipe output ${mountName}/${outPath} is not a directory${opts.allowFile ? ' or a file' : ''}`);

  // no check uid configured (tests opt into the same uid): ownership is not checked, as before
  const uid = ctx.services.commands.uid === undefined ? undefined : opts.ownedBy === 'runner' ? process.getuid?.() : ctx.services.commands.uid;
  const out: Array<{ path: string; data: Uint8Array }> = [];
  let bytes = 0;
  const readOne = async (abs: string, label: string): Promise<Uint8Array> => {
    const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!fh) throw new JobFailure('scope_violation', `preview output ${label} could not be opened safely`);
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.nlink !== 1 || (uid !== undefined && st.uid !== uid)) {
        throw new JobFailure('scope_violation', `preview output ${label} is not a plain file of the build`);
      }
      bytes += st.size;
      if (out.length + 1 > MAX_FILES || bytes > MAX_BYTES) throw new JobFailure('check_failed', 'preview output exceeds the size limits');
      return new Uint8Array(await fh.readFile());
    } finally {
      await fh.close();
    }
  };
  // a single file (not a directory) is returned with an empty relative path
  if (isSingleFile) {
    out.push({ path: '', data: await readOne(real, outPath) });
    return out;
  }
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, childRel);
        continue;
      }
      if (!e.isFile()) continue; // symlinks, devices, sockets are never published
      const p = checkPath(childRel);
      if (!p.ok) continue;
      out.push({ path: p.path, data: await readOne(abs, childRel) });
    }
  };
  await walk(real, '');
  return out;
}
