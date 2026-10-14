/** Reading git trees and blobs without a working tree. */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkPath } from '@commonforge-org/core';
import { GitError, lsTree, type Git, type TreeFile } from './git.js';

/**
 * Contents of many blobs with one `git cat-file --batch`. Holds all of them in memory at once
 * (review M-1, accepted for P0: demo repos are small); stream in batches before large repos.
 */
export async function catFileBatch(git: Git, dir: string, oids: readonly string[]): Promise<Map<string, Uint8Array>> {
  const unique = [...new Set(oids)];
  const out = new Map<string, Uint8Array>();
  if (unique.length === 0) return out;
  const r = await git.runBytes(['cat-file', '--batch'], dir, { input: `${unique.join('\n')}\n` });
  if (r.code !== 0) throw new GitError(['cat-file', '--batch'], r);
  const buf = Buffer.from(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength);
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8');
    const [oid, type, sizeStr] = header.split(' ');
    if (type === 'missing' || sizeStr === undefined) throw new Error(`object ${oid} missing`);
    const size = Number(sizeStr);
    out.set(oid!, new Uint8Array(buf.subarray(nl + 1, nl + 1 + size)));
    pos = nl + 1 + size + 1;
  }
  return out;
}

/** One blob's bytes (`<rev>:<path>`), or null when absent. */
export async function readBlob(git: Git, dir: string, rev: string, path: string): Promise<Uint8Array | null> {
  const r = await git.runBytes(['cat-file', 'blob', `${rev}:${path}`], dir);
  return r.code === 0 ? r.stdout : null;
}

/**
 * Write the files of commit `sha` into `dest` (no `.git`, never a repository the runner pushes
 * from). Symlinks become plain files holding the link text (as with `core.symlinks=false`);
 * submodules are skipped; executable bits are kept.
 */
export async function exportTree(git: Git, dir: string, sha: string, dest: string): Promise<TreeFile[]> {
  const files = (await lsTree(git, dir, sha)).filter((f) => f.type === 'blob');
  const contents = await catFileBatch(git, dir, files.map((f) => f.oid));
  await mkdir(dest, { recursive: true });
  for (const f of files) {
    const p = checkPath(f.path);
    if (!p.ok || p.path !== f.path) throw new Error(`unsafe path in tree: ${JSON.stringify(f.path)}`);
    const abs = join(dest, ...f.path.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, contents.get(f.oid)!, { flag: 'wx' });
    if (f.mode === '100755') await chmod(abs, 0o755);
  }
  return files;
}
