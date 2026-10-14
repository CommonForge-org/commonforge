/**
 * `apply-files` (spec 2026-10-07 §6): apply put / edit / delete / move operations to a folder at
 * its base version and push one commit, authored by the uploader, to a fresh task repository.
 *
 * - The operations come as an R2 manifest (`opsManifest`: a queue message holds 128 KB): read
 *   through the job's blob scope, checked against its sha256 and count and parsed with
 *   `parseApplyFilesOps` (`scope_violation` otherwise; `provider_unavailable` when it is missing).
 * - The runner never downloads LFS objects (spec §2): a put of a large, binary or LFS-pattern file
 *   writes the pointer from the sha256 and size the platform's hash step recorded. Only small text
 *   files are fetched (and their hash checked: `hash_mismatch`).
 * - Every pointer this job writes (puts and move destinations) whose path no pattern of the final
 *   root `.gitattributes` (as the operations leave it) matches gets an exact-path entry in the same
 *   commit. A path whose entry git would ignore (2,048 bytes or more) fails with `limit_exceeded`,
 *   so a pointer is never committed untracked.
 * - Edits check the file's current blob against the blob the editor opened (`file_changed`); they
 *   are text under the LFS threshold, and a file stored in LFS is never edited in place
 *   (`limit_exceeded`).
 * - Deletes of missing paths and moves already applied are no-ops, so re-applying an upload or
 *   move on a newer head is idempotent.
 * - A file can never be placed below a file or over a folder (`path_conflict`); a move of a
 *   missing path with no destination is `path_not_found`.
 * - A delete or move that would name a base path no change can carry (NFD, `\`, …) fails with
 *   `path_conflict` naming it.
 * - Tripwire: the commit differs from the base only in the paths the operations name (put and edit
 *   paths, everything under delete and move sources, move destinations) and `.gitattributes`.
 * - At most `APPLY_FILES_LIMITS.maxChangedPaths` (5,000) changed paths (`limit_exceeded`).
 * - Classes (spec §7): an LFS path is content, others by extension; replacing a code file that was
 *   not stored in LFS stays code even when the new version is an LFS pointer (ruling R7).
 */
import { join } from 'node:path';
import { candidateId, isNormalizedPath, revisionCommitSha, sha256HexSync, type RevisionId } from '@commonforge-org/core';
import {
  APPLY_FILES_BRANCH_REF,
  APPLY_FILES_LIMITS,
  classifyPath,
  gitattributesLfsEntry,
  LFS_POINTER_MAX_BYTES,
  lfsAttributesMatcher,
  lfsEntryFits,
  lfsPointer,
  looksBinary,
  parseApplyFilesOps,
  parseLfsPointer,
  type ApplyFilesOp,
  type JobReceiptByKind,
} from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { RUNNER_IDENTITY_ENV, type TreeFile } from '../git.js';
import { catFileBatch } from '../tree.js';
import { fetchCommits, requirePushed, scratchRepo } from './common.js';

interface Entry {
  mode: string;
  oid: string;
}

type Receipt = JobReceiptByKind['apply-files'];

const ATTRS = '.gitattributes';

/** Regular-file mode for a written file: executables stay executable, anything else (a symlink) becomes a plain file. */
const fileMode = (prev: Entry | undefined) => (prev?.mode === '100755' ? '100755' : '100644');

/** `git ls-tree -r -l -z` of a commit: entries plus blob sizes (`null` for submodules). */
async function lsTreeSized(ctx: JobContext<'apply-files'>, dir: string, rev: string): Promise<Array<TreeFile & { size: number | null }>> {
  const out = await ctx.git.ok(['ls-tree', '-r', '-l', '-z', '--full-tree', '--end-of-options', rev], dir);
  const files: Array<TreeFile & { size: number | null }> = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, oid, size] = rec.slice(0, tab).split(/ +/);
    files.push({ mode: mode!, type: type as TreeFile['type'], oid: oid!, path: rec.slice(tab + 1), size: size === '-' || size === undefined ? null : Number(size) });
  }
  return files;
}

/**
 * The tree being edited: blobs by path plus a count of entries below every folder, so "is this a
 * folder" is O(1). Submodules (`special`) are never touched but still occupy their path.
 */
class Tree {
  readonly files: Map<string, Entry>;
  readonly #below = new Map<string, number>();

  constructor(
    files: Map<string, Entry>,
    readonly special: ReadonlySet<string>,
  ) {
    this.files = new Map(files);
    for (const p of [...files.keys(), ...special]) this.#count(p, 1);
  }

  #count(path: string, d: number) {
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
      const dir = path.slice(0, i);
      this.#below.set(dir, (this.#below.get(dir) ?? 0) + d);
    }
  }

  get(path: string) {
    return this.files.get(path);
  }
  set(path: string, e: Entry) {
    if (!this.files.has(path)) this.#count(path, 1);
    this.files.set(path, e);
  }
  delete(path: string) {
    if (this.files.delete(path)) this.#count(path, -1);
  }
  isFolder(path: string) {
    return (this.#below.get(path) ?? 0) > 0;
  }
  /** the file itself, or every file below the folder */
  under(path: string): string[] {
    if (this.files.has(path)) return [path];
    if (!this.isFolder(path)) return [];
    const prefix = `${path}/`;
    return [...this.files.keys()].filter((p) => p.startsWith(prefix));
  }
  /** a new file may be written at `path`: not over a folder (or submodule), not below a file */
  placeable(path: string) {
    if (this.special.has(path) || this.isFolder(path)) throw new JobFailure('path_conflict', `${path} is a folder`);
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
      const anc = path.slice(0, i);
      if (this.files.has(anc) || this.special.has(anc)) throw new JobFailure('path_conflict', `${anc} is a file, so ${path} cannot be created below it`);
    }
  }
}

/** The job's operations: the R2 manifest it names, exactly as the Worker recorded it. */
async function readOps(ctx: JobContext<'apply-files'>): Promise<ApplyFilesOp[]> {
  const { opsManifest, lfsThresholdBytes } = ctx.job;
  const bytes = await ctx.blobs().get(opsManifest.r2Key);
  if (!bytes) throw new JobFailure('provider_unavailable', `the operations manifest ${opsManifest.r2Key} is missing`);
  if (sha256HexSync(bytes) !== opsManifest.sha256) throw new JobFailure('scope_violation', 'the operations manifest does not match the job (sha256)');
  let ops: ApplyFilesOp[];
  try {
    ops = parseApplyFilesOps(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), lfsThresholdBytes);
  } catch (e) {
    throw new JobFailure('scope_violation', `the operations manifest is invalid: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`);
  }
  if (ops.length !== opsManifest.count) throw new JobFailure('scope_violation', `the operations manifest has ${ops.length} operations, the job says ${opsManifest.count}`);
  return ops;
}

export async function applyFiles(ctx: JobContext<'apply-files'>): Promise<Receipt> {
  const { target, candidateFork, author, title, lfsThresholdBytes, changeId } = ctx.job;
  const head = await ctx.currentHead(target.resourceId);
  if (head !== undefined && head !== target.expectedHead) {
    throw new JobFailure('stale_base', `${target.resourceId}: ledger head is ${head ?? 'none'}, expected ${target.expectedHead}`);
  }
  const ops = await readOps(ctx);
  const baseSha = revisionCommitSha(target.expectedHead as RevisionId)!;
  const dir = await scratchRepo(ctx, 'apply-files');
  await fetchCommits(ctx, dir, target.canonical, [baseSha], `base ${baseSha}`);
  const listing = await lsTreeSized(ctx, dir, baseSha);
  const base = new Map<string, Entry>(listing.filter((f) => f.type === 'blob').map((f) => [f.path, { mode: f.mode, oid: f.oid }]));
  const tree = new Tree(base, new Set(listing.filter((f) => f.type !== 'blob').map((f) => f.path)));

  // blob sizes (base listing + what we write), so pointer checks never read a blob over 200 bytes
  const sizes = new Map<string, number>();
  for (const f of listing) if (f.size !== null) sizes.set(f.oid, f.size);
  const pointer = new Map<string, boolean>();
  /** decide "is an LFS pointer" for many blobs with one `cat-file --batch` */
  const primePointers = async (oids: Iterable<string>) => {
    const read: string[] = [];
    for (const oid of new Set(oids)) {
      if (pointer.has(oid)) continue;
      const size = sizes.get(oid);
      if (size !== undefined && size > LFS_POINTER_MAX_BYTES) pointer.set(oid, false);
      else read.push(oid);
    }
    if (read.length === 0) return;
    const blobs = await catFileBatch(ctx.git, dir, read);
    const dec = new TextDecoder();
    for (const oid of read) {
      const b = blobs.get(oid);
      pointer.set(oid, b !== undefined && b.length <= LFS_POINTER_MAX_BYTES && parseLfsPointer(dec.decode(b)) !== null);
    }
  };
  const isPointer = async (oid: string): Promise<boolean> => {
    await primePointers([oid]);
    return pointer.get(oid)!;
  };
  const write = async (data: string | Uint8Array) => {
    const oid = (await ctx.git.ok(['hash-object', '-w', '--stdin'], dir, { input: data })).trim();
    sizes.set(oid, typeof data === 'string' ? new TextEncoder().encode(data).length : data.length);
    return oid;
  };
  const readBlob = (oid: string) => ctx.git.ok(['cat-file', 'blob', oid], dir);

  // the root .gitattributes as the operations leave it (exact entries are added at the end)
  let attrsText = base.has(ATTRS) ? await readBlob(base.get(ATTRS)!.oid) : '';
  let attrsByOps = false;
  let isLfs = lfsAttributesMatcher(attrsText);
  /** after an operation wrote, moved or removed the root .gitattributes */
  const refreshAttrs = async () => {
    const e = tree.get(ATTRS);
    attrsText = e ? await readBlob(e.oid) : '';
    attrsByOps = true;
    isLfs = lfsAttributesMatcher(attrsText);
  };
  const lfsObjects = new Map<string, { stagingId: string; sha256: string; size: number; oid: string }>();
  /** paths this job wrote a pointer to (puts and move destinations), in order */
  const ours = new Set<string>();
  // tripwire: the paths the operations name (exact) and the folders/files they remove or move (with everything below)
  const exact = new Set<string>([ATTRS]);
  const prefixes = new Set<string>();
  /** a delete or move may only name paths a change can carry (the receipt's RelativePathSchema) */
  const nameable = (paths: readonly string[]) => {
    const bad = paths.find((p) => !isNormalizedPath(p));
    if (bad !== undefined) throw new JobFailure('path_conflict', `${JSON.stringify(bad)} cannot be changed here: it is not a normalized path (rename it with git first)`);
  };

  for (const op of ops) {
    if ('put' in op) {
      exact.add(op.put);
      tree.placeable(op.put);
      const small = op.size <= lfsThresholdBytes && !op.binary;
      let oid: string;
      if (op.put !== ATTRS && (!small || isLfs(op.put))) {
        oid = await write(lfsPointer(op.sha256, op.size));
        pointer.set(oid, true);
        lfsObjects.set(op.stagingId, { stagingId: op.stagingId, sha256: op.sha256, size: op.size, oid });
        ours.add(op.put);
      } else {
        // .gitattributes itself is never stored in LFS
        if (!small || op.r2Key === undefined) throw new JobFailure('limit_exceeded', `${op.put} must be a small text file`);
        const bytes = await ctx.blobs().get(op.r2Key);
        if (!bytes) throw new JobFailure('provider_unavailable', `staged object ${op.stagingId} not found`);
        if (bytes.length !== op.size || sha256HexSync(bytes) !== op.sha256 || looksBinary(bytes)) {
          throw new JobFailure('hash_mismatch', `${op.put}: the staged file does not match what the platform verified`);
        }
        oid = await write(bytes);
      }
      tree.set(op.put, { mode: fileMode(tree.get(op.put)), oid });
      if (op.put === ATTRS) await refreshAttrs();
    } else if ('edit' in op) {
      exact.add(op.edit);
      const cur = tree.get(op.edit);
      if (op.baseBlob === '' ? cur !== undefined : cur?.oid !== op.baseBlob) throw new JobFailure('file_changed', `${op.edit} changed since it was opened`);
      if (cur && (await isPointer(cur.oid))) throw new JobFailure('limit_exceeded', `${op.edit} is stored in LFS and cannot be edited in place`);
      if (new TextEncoder().encode(op.content).length > lfsThresholdBytes) throw new JobFailure('limit_exceeded', `${op.edit}: edits are text under the LFS threshold`);
      if (!cur) tree.placeable(op.edit);
      tree.set(op.edit, { mode: fileMode(cur), oid: await write(op.content) });
      if (op.edit === ATTRS) await refreshAttrs();
    } else if ('delete' in op) {
      prefixes.add(op.delete);
      const paths = tree.under(op.delete);
      nameable(paths);
      for (const p of paths) tree.delete(p);
      if (paths.includes(ATTRS)) await refreshAttrs();
    } else {
      prefixes.add(op.move);
      const sources = tree.under(op.move);
      if (sources.length === 0) {
        if (tree.get(op.to) || tree.isFolder(op.to)) continue; // already moved (re-apply)
        throw new JobFailure('path_not_found', `${op.move} does not exist`);
      }
      nameable(sources);
      if (op.to === op.move || op.to.startsWith(`${op.move}/`)) throw new JobFailure('path_conflict', `cannot move ${op.move} into itself`);
      const moves = sources.map((p) => ({ from: p, to: op.to + p.slice(op.move.length), entry: tree.get(p)! }));
      for (const m of moves) {
        const existing = tree.get(m.to);
        if (existing && existing.oid !== m.entry.oid) throw new JobFailure('path_conflict', `${m.to} already exists`);
      }
      for (const m of moves) tree.delete(m.from);
      for (const m of moves) {
        tree.placeable(m.to);
        tree.set(m.to, m.entry);
        exact.add(m.to);
      }
      if (sources.includes(ATTRS) || moves.some((m) => m.to === ATTRS)) await refreshAttrs();
      await primePointers(moves.map((m) => m.entry.oid));
      for (const m of moves) if (pointer.get(m.entry.oid)) ours.add(m.to);
    }
  }

  // exact entries, decided against the final .gitattributes: every pointer this job wrote that is
  // still in the tree and that no pattern matches (whatever the order of the operations)
  const live = [...ours].filter((p) => tree.get(p) !== undefined);
  await primePointers(live.map((p) => tree.get(p)!.oid));
  const pointers = live.filter((p) => pointer.get(tree.get(p)!.oid));
  const entries = pointers.filter((p) => !isLfs(p)).map((p) => gitattributesLfsEntry(p));
  let finalAttrs = attrsText;
  if (entries.length > 0) {
    finalAttrs = `${attrsText}${attrsText && !attrsText.endsWith('\n') ? '\n' : ''}${entries.join('\n')}\n`;
    const prev = tree.get(ATTRS);
    if (!prev) tree.placeable(ATTRS);
    tree.set(ATTRS, { mode: fileMode(prev), oid: await write(finalAttrs) });
  }
  // a pointer git would not track (an exact entry of 2,048 bytes or more is ignored) is never committed
  const tracked = lfsAttributesMatcher(finalAttrs);
  for (const p of pointers) {
    if (tracked(p)) continue;
    throw new JobFailure('limit_exceeded', lfsEntryFits(p) ? `${p}: no .gitattributes entry stores this path in LFS` : `${p}: the path is too long to be stored in LFS`);
  }

  // the new tree: the base plus exactly the differences (removals first, so a folder can become a file)
  const ZERO = '0'.repeat(baseSha.length);
  const index: string[] = [];
  for (const p of base.keys()) if (!tree.files.has(p)) index.push(`0 ${ZERO}\t${p}\0`);
  for (const [p, e] of tree.files) {
    const b = base.get(p);
    if (!b || b.oid !== e.oid || b.mode !== e.mode) index.push(`${e.mode} ${e.oid}\t${p}\0`);
  }
  const finalOids = new Set([...tree.files.values()].map((e) => e.oid));
  const receipt = (candidate?: { sha: string }, changedPaths: Receipt['changedPaths'] = []): Receipt => ({
    jobId: ctx.jobId,
    changeId,
    resourceId: target.resourceId,
    expectedHead: target.expectedHead,
    ...(candidate ? { candidate: { candidateId: candidateId(candidateFork.taskWorkspaceId, candidate.sha), taskWorkspaceId: candidateFork.taskWorkspaceId, sha: candidate.sha } } : {}),
    changedPaths,
    // only objects the commit still points to are promoted
    lfsObjects: candidate ? [...lfsObjects.values()].filter((o) => finalOids.has(o.oid)).map(({ stagingId, sha256, size }) => ({ stagingId, sha256, size })) : [],
    appliedAt: ctx.nowIso(),
  });
  if (index.length === 0) return receipt();
  const indexEnv = { GIT_INDEX_FILE: join(await ctx.scratch('apply-files-index'), 'index') };
  await ctx.git.ok(['read-tree', baseSha], dir, { env: indexEnv });
  await ctx.git.ok(['update-index', '-z', '--index-info'], dir, { env: indexEnv, input: index.join('') });
  const newTree = (await ctx.git.ok(['write-tree'], dir, { env: indexEnv })).trim();
  const baseTree = (await ctx.git.ok(['rev-parse', `${baseSha}^{tree}`], dir)).trim();
  if (newTree === baseTree) return receipt();

  // changed paths, classified (spec §7); tripwire: only the paths the operations name
  const named = (path: string) => {
    if (exact.has(path)) return true;
    for (let q = path; ; ) {
      if (prefixes.has(q)) return true;
      const i = q.lastIndexOf('/');
      if (i < 0) return false;
      q = q.slice(0, i);
    }
  };
  const raw = (await ctx.git.ok(['diff-tree', '-r', '-z', '--no-renames', '--name-status', baseTree, newTree], dir)).split('\0').filter(Boolean);
  const pairs: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push({ status: raw[i]!, path: raw[i + 1]! });
  for (const { path } of pairs) if (!named(path)) throw new JobFailure('scope_violation', `the commit would change ${path}, which no operation named`);
  if (pairs.length > APPLY_FILES_LIMITS.maxChangedPaths) {
    throw new JobFailure('limit_exceeded', `the change would touch ${pairs.length} paths; at most ${APPLY_FILES_LIMITS.maxChangedPaths} per change`);
  }
  await primePointers(pairs.flatMap(({ status, path }) => (status === 'A' ? [tree.get(path)!.oid] : status === 'D' ? [base.get(path)!.oid] : [base.get(path)!.oid, tree.get(path)!.oid])));
  const changedPaths: Receipt['changedPaths'] = [];
  for (const { status, path } of pairs) {
    const change = status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified';
    const lfs = change === 'deleted' ? await isPointer(base.get(path)!.oid) : await isPointer(tree.get(path)!.oid);
    // R7: a code file that was not in LFS, replaced (even by an LFS object), is a code change
    const replacesCode = change === 'modified' && classifyPath(path, false) === 'code' && !(await isPointer(base.get(path)!.oid));
    const cls = path === ATTRS && !attrsByOps ? 'content' : replacesCode ? 'code' : classifyPath(path, lfs);
    changedPaths.push({ path, change, lfs, class: cls });
  }
  const env = { ...RUNNER_IDENTITY_ENV(ctx.commitDate()), GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email };
  const sha = (await ctx.git.ok(['commit-tree', newTree, '-p', baseSha, '-m', `${title}\n\nchange ${changeId}, job ${ctx.jobId}\n`], dir, { env })).trim();
  const outcome = await ctx.push({ coords: candidateFork.coords, ref: APPLY_FILES_BRANCH_REF, sha, dir });
  requirePushed(ctx, outcome, 'pushing the file change');
  return receipt({ sha }, changedPaths);
}
