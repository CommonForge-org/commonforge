import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localRevisionId, sha256HexSync, type RevisionId } from '@commonforge-org/core';
import { gitattributesLfsEntry, lfsPointer } from '@commonforge-org/runner-protocol';
import { World, type CanonicalRepo } from './helpers.js';

let w: World;
let site: CanonicalRepo;
let seq = 0;
const SHA = (s: string | Uint8Array) => sha256HexSync(typeof s === 'string' ? new TextEncoder().encode(s) : s);
const BIG = 'f'.repeat(64);
const ATTRS = '*.mp4 filter=lfs diff=lfs merge=lfs -text\n';

beforeAll(async () => {
  w = await World.create();
  site = await w.canonical('res-site', {
    'index.html': '<h1>v1</h1>\n',
    'config.json': '{"a":1}\n',
    '.gitattributes': ATTRS,
    'videos/old.mp4': lfsPointer('1'.repeat(64), 5_000_000),
    'docs/a.md': 'a\n',
    'docs/b.md': 'b\n',
  });
});
afterAll(() => w?.close());

/** LocalGitCoords.remoteUrl is a file:// URL naming the bare repo's directory. */
const gitDir = (repo: { remoteUrl: string }) => (repo.remoteUrl.startsWith('file:') ? fileURLToPath(repo.remoteUrl) : repo.remoteUrl);
function git(repo: { remoteUrl: string }, args: string[]): string {
  return execFileSync('git', ['--git-dir', gitDir(repo), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
/** `git show <ref>:<path>`, or null when the path does not exist there. */
function show(repo: { remoteUrl: string }, path: string, ref = 'refs/heads/main'): string | null {
  try {
    return git(repo, ['show', `${ref}:${path}`]);
  } catch {
    return null;
  }
}
function blobId(repo: { remoteUrl: string }, path: string, ref = 'refs/heads/main'): string {
  return git(repo, ['rev-parse', `${ref}:${path}`]).trim();
}
function changed(fork: { remoteUrl: string }): string[] {
  return git(fork, ['diff', '--no-renames', '--name-only', site.sha, 'refs/heads/main']).split('\n').filter(Boolean).sort();
}

async function stage(key: string, data: string | Uint8Array) {
  const p = w.blobPath(key);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data);
}

/** A small text put staged under the folder's staging prefix. */
async function smallPut(path: string, data: string, over: Record<string, unknown> = {}) {
  const stagingId = `lfs-s${++seq}`;
  const r2Key = `org/org1/lfs/res-site/obj/${stagingId}`;
  await stage(r2Key, data);
  return { put: path, stagingId, sha256: SHA(data), size: new TextEncoder().encode(data).length, binary: false, r2Key, ...over };
}
const bigPut = (path: string, size = 150_000_000, sha256 = BIG, binary = false) => ({ put: path, stagingId: `lfs-b${++seq}`, sha256, size, binary });

interface Receipt {
  candidate?: { candidateId: string; taskWorkspaceId: string; sha: string };
  changedPaths: Array<{ path: string; change: string; lfs: boolean; class: string }>;
  lfsObjects: Array<{ stagingId: string; sha256: string; size: number }>;
}

/** The R2 ops manifest the Worker writes (`opsManifest`): staged in the blob store, named by the job. */
async function manifest(changeId: string, ops: unknown[], over: { bytes?: string; sha256?: string; count?: number; stage?: boolean } = {}) {
  const r2Key = `org/org1/file-changes/${changeId}/ops-1.json`;
  const text = JSON.stringify(ops);
  if (over.stage !== false) await stage(r2Key, over.bytes ?? text);
  return { r2Key, sha256: over.sha256 ?? SHA(text), count: over.count ?? ops.length };
}

async function run(
  ops: unknown[],
  opts: { expectedHead?: RevisionId; threshold?: number; heads?: Record<string, RevisionId>; repo?: CanonicalRepo; manifest?: { bytes?: string; sha256?: string; count?: number; stage?: boolean } } = {},
) {
  const repo = opts.repo ?? site;
  const fork = await w.bareRepo('tasks', `ws-tw-af-${++seq}`);
  const job = {
    kind: 'apply-files' as const,
    changeId: `fc-${seq}`,
    target: { resourceId: repo.resource.resourceId, canonical: repo.coords, expectedHead: opts.expectedHead ?? repo.revision },
    candidateFork: { taskWorkspaceId: `tw-af-${seq}`, coords: fork },
    opsManifest: await manifest(`fc-${seq}`, ops, opts.manifest),
    author: { name: 'Dana Owner', email: 'dana@example.test' },
    title: 'Uploaded files',
    lfsThresholdBytes: opts.threshold ?? 1_048_576,
  };
  const heads = opts.heads;
  const runner = heads ? w.runner({ currentHeads: async () => heads }) : w.runner();
  const result = (await runner.execute(await w.delivery(job as never))) as { ok: true; receipt: Receipt } | { ok: false; code: string; detail: string };
  return { fork, result };
}
const ok = (r: Awaited<ReturnType<typeof run>>['result']): Receipt => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return (r as { receipt: Receipt }).receipt;
};
const byPath = (rc: Receipt) => Object.fromEntries(rc.changedPaths.map((c) => [c.path, { change: c.change, lfs: c.lfs, class: c.class }]));

describe('apply-files', () => {
  it('a large put becomes a pointer from the recorded hash, with an exact .gitattributes entry, authored by the uploader', async () => {
    const op = bigPut('Demo Videos/final cut.mov');
    const { fork, result } = await run([op]);
    const rc = ok(result);
    expect(show(fork, 'Demo Videos/final cut.mov')).toBe(lfsPointer(BIG, 150_000_000));
    expect(show(fork, '.gitattributes')).toBe(`${ATTRS}${gitattributesLfsEntry('Demo Videos/final cut.mov')}\n`);
    expect(rc.lfsObjects).toEqual([{ stagingId: op.stagingId, sha256: BIG, size: 150_000_000 }]);
    expect(byPath(rc)).toEqual({
      'Demo Videos/final cut.mov': { change: 'added', lfs: true, class: 'content' },
      '.gitattributes': { change: 'modified', lfs: false, class: 'content' },
    });
    expect(git(fork, ['log', '-1', '--format=%an <%ae>|%cn', 'refs/heads/main']).trim()).toBe('Dana Owner <dana@example.test>|CommonForge Runner');
    expect(git(fork, ['log', '-1', '--format=%s', 'refs/heads/main']).trim()).toBe('Uploaded files');
    expect(rc.candidate!.sha).toBe(git(fork, ['rev-parse', 'refs/heads/main']).trim());
    expect(rc.candidate!.taskWorkspaceId).toBe(`tw-af-${seq}`);
  });

  it('a put matching a .gitattributes pattern becomes a pointer without a new entry', async () => {
    const op = bigPut('clips/a.mp4', 2048, 'a'.repeat(64), true);
    const { fork, result } = await run([op]);
    const rc = ok(result);
    expect(show(fork, 'clips/a.mp4')).toBe(lfsPointer('a'.repeat(64), 2048));
    expect(show(fork, '.gitattributes')).toBe(ATTRS);
    expect(rc.changedPaths).toEqual([{ path: 'clips/a.mp4', change: 'added', lfs: true, class: 'content' }]);
    expect(rc.lfsObjects).toEqual([{ stagingId: op.stagingId, sha256: 'a'.repeat(64), size: 2048 }]);
  });

  it('a small text put is fetched, checked and written as a plain file', async () => {
    const op = await smallPut('notes/hello.txt', 'hello\n');
    const { fork, result } = await run([op]);
    const rc = ok(result);
    expect(show(fork, 'notes/hello.txt')).toBe('hello\n');
    expect(rc.changedPaths).toEqual([{ path: 'notes/hello.txt', change: 'added', lfs: false, class: 'code' }]);
    expect(rc.lfsObjects).toEqual([]);
    expect(changed(fork)).toEqual(['notes/hello.txt']);
  });

  it('an empty put is a plain empty file', async () => {
    const op = await smallPut('pkg/__init__.py', '');
    expect(op.size).toBe(0);
    const { fork, result } = await run([op]);
    const rc = ok(result);
    expect(show(fork, 'pkg/__init__.py')).toBe('');
    expect(rc.changedPaths).toEqual([{ path: 'pkg/__init__.py', change: 'added', lfs: false, class: 'code' }]);
    expect(rc.lfsObjects).toEqual([]);
  });

  it('hash_mismatch when the staged bytes differ from the recorded hash, size or text flag', async () => {
    const wrongHash = await smallPut('notes/x.txt', 'hello\n', { sha256: SHA('other\n') });
    expect((await run([wrongHash])).result).toMatchObject({ ok: false, code: 'hash_mismatch' });
    const wrongSize = await smallPut('notes/x.txt', 'hello\n', { size: 5 });
    expect((await run([wrongSize])).result).toMatchObject({ ok: false, code: 'hash_mismatch' });
    const bin = 'a\0b';
    const binary = await smallPut('notes/x.txt', bin);
    expect((await run([binary])).result).toMatchObject({ ok: false, code: 'hash_mismatch' });
  });

  it('a non-binary put over the threshold becomes a pointer', async () => {
    const op = bigPut('notes/six.txt', 6, 'b'.repeat(64));
    const { fork, result } = await run([op], { threshold: 5 });
    const rc = ok(result);
    expect(show(fork, 'notes/six.txt')).toBe(lfsPointer('b'.repeat(64), 6));
    expect(show(fork, '.gitattributes')).toBe(`${ATTRS}${gitattributesLfsEntry('notes/six.txt')}\n`);
    expect(rc.lfsObjects).toHaveLength(1);
  });

  it('edits check the blob the editor opened', async () => {
    const base = blobId(site.coords, 'config.json');
    const good = await run([{ edit: 'config.json', content: '{"a":2}\n', baseBlob: base }]);
    const rc = ok(good.result);
    expect(show(good.fork, 'config.json')).toBe('{"a":2}\n');
    expect(rc.changedPaths).toEqual([{ path: 'config.json', change: 'modified', lfs: false, class: 'code' }]);
    expect(changed(good.fork)).toEqual(['config.json']);

    expect((await run([{ edit: 'config.json', content: 'x\n', baseBlob: 'e'.repeat(40) }])).result).toMatchObject({ ok: false, code: 'file_changed' });
    expect((await run([{ edit: 'config.json', content: 'x\n', baseBlob: '' }])).result).toMatchObject({ ok: false, code: 'file_changed' });
    expect((await run([{ edit: 'nope.txt', content: 'x\n', baseBlob: base }])).result).toMatchObject({ ok: false, code: 'file_changed' });

    const created = await run([{ edit: 'new.txt', content: 'new\n', baseBlob: '' }]);
    expect(byPath(ok(created.result))).toEqual({ 'new.txt': { change: 'added', lfs: false, class: 'code' } });
    expect(show(created.fork, 'new.txt')).toBe('new\n');

    const pointer = blobId(site.coords, 'videos/old.mp4');
    expect((await run([{ edit: 'videos/old.mp4', content: 'x\n', baseBlob: pointer }])).result).toMatchObject({ ok: false, code: 'limit_exceeded' });
    // edits are text under the threshold (spec §6)
    expect((await run([{ edit: 'new.txt', content: 'too long\n', baseBlob: '' }], { threshold: 5 })).result).toMatchObject({ ok: false, code: 'limit_exceeded' });
  });

  it('deletes remove files and folders; a missing path is a no-op', async () => {
    const { fork, result } = await run([{ delete: 'docs' }]);
    const rc = ok(result);
    expect(byPath(rc)).toEqual({
      'docs/a.md': { change: 'deleted', lfs: false, class: 'code' },
      'docs/b.md': { change: 'deleted', lfs: false, class: 'code' },
    });
    expect(show(fork, 'docs/a.md')).toBeNull();
    expect(show(fork, 'index.html')).toBe('<h1>v1</h1>\n');

    const none = await run([{ delete: 'missing.txt' }]);
    const nrc = ok(none.result);
    expect(nrc.candidate).toBeUndefined();
    expect(nrc.changedPaths).toEqual([]);
    expect(await w.remoteSha(none.fork, 'refs/heads/main')).toBeNull();
  });

  it('moves files and folders; pointers move with their files', async () => {
    const m = await run([{ move: 'videos/old.mp4', to: 'media/old.mp4' }]);
    const rc = ok(m.result);
    expect(show(m.fork, 'media/old.mp4')).toBe(lfsPointer('1'.repeat(64), 5_000_000));
    expect(show(m.fork, '.gitattributes')).toBe(ATTRS);
    expect(byPath(rc)).toEqual({
      'videos/old.mp4': { change: 'deleted', lfs: true, class: 'content' },
      'media/old.mp4': { change: 'added', lfs: true, class: 'content' },
    });
    expect(rc.lfsObjects).toEqual([]);

    // a pointer moved where no pattern matches gets its exact entry
    const out = await run([{ move: 'videos/old.mp4', to: 'media/old.video' }]);
    ok(out.result);
    expect(show(out.fork, '.gitattributes')).toBe(`${ATTRS}${gitattributesLfsEntry('media/old.video')}\n`);

    const d = await run([{ move: 'docs', to: 'archive/docs' }]);
    expect(Object.keys(byPath(ok(d.result))).sort()).toEqual(['archive/docs/a.md', 'archive/docs/b.md', 'docs/a.md', 'docs/b.md']);
    expect(show(d.fork, 'archive/docs/b.md')).toBe('b\n');

    expect((await run([{ move: 'docs/a.md', to: 'docs/b.md' }])).result).toMatchObject({ ok: false, code: 'path_conflict' });
    expect((await run([{ move: 'docs', to: 'docs/sub' }])).result).toMatchObject({ ok: false, code: 'path_conflict' });
    expect((await run([{ move: 'nowhere.txt', to: 'elsewhere.txt' }])).result).toMatchObject({ ok: false, code: 'path_not_found' });
    // already applied (the destination exists): a no-op
    const again = await run([{ move: 'gone.txt', to: 'index.html' }]);
    expect(ok(again.result).candidate).toBeUndefined();
  });

  it('path_conflict for a file below a file or over a folder; a folder may be replaced once emptied', async () => {
    expect((await run([await smallPut('index.html/x.txt', 'x\n')])).result).toMatchObject({ ok: false, code: 'path_conflict' });
    expect((await run([await smallPut('docs', 'x\n')])).result).toMatchObject({ ok: false, code: 'path_conflict' });
    expect((await run([{ edit: 'docs', content: 'x\n', baseBlob: '' }])).result).toMatchObject({ ok: false, code: 'path_conflict' });
    expect((await run([{ move: 'index.html', to: 'docs' }])).result).toMatchObject({ ok: false, code: 'path_conflict' });

    const { fork, result } = await run([{ delete: 'docs' }, await smallPut('docs', 'now a file\n')]);
    const rc = ok(result);
    expect(show(fork, 'docs')).toBe('now a file\n');
    expect(Object.keys(byPath(rc)).sort()).toEqual(['docs', 'docs/a.md', 'docs/b.md']);
  });

  it('stale_base when the ledger head moved past expectedHead', async () => {
    const next = await w.advanceCanonical(site, { 'index.html': '<h1>v2</h1>\n' });
    const { fork, result } = await run([await smallPut('notes/a.txt', 'a\n')], { heads: { 'res-site': localRevisionId(site.coords.repoId, next) } });
    expect(result).toMatchObject({ ok: false, code: 'stale_base' });
    expect(await w.remoteSha(fork, 'refs/heads/main')).toBeNull();
  });

  it('tripwire: one commit on the base that changes only the operations’ paths (and .gitattributes for new entries)', async () => {
    const ops = [
      await smallPut('notes/t.txt', 't\n'),
      bigPut('raw/data.bin', 10, 'c'.repeat(64), true),
      { edit: 'config.json', content: '{"a":3}\n', baseBlob: blobId(site.coords, 'config.json') },
      { delete: 'docs/a.md' },
      { move: 'docs/b.md', to: 'notes/b.md' },
    ];
    const { fork, result } = await run(ops);
    const rc = ok(result);
    expect(git(fork, ['rev-parse', 'refs/heads/main^']).trim()).toBe(site.sha);
    expect(git(fork, ['rev-list', '--count', `${site.sha}..refs/heads/main`]).trim()).toBe('1');
    expect(changed(fork)).toEqual(['.gitattributes', 'config.json', 'docs/a.md', 'docs/b.md', 'notes/b.md', 'notes/t.txt', 'raw/data.bin']);
    expect(rc.changedPaths.map((c) => c.path).sort()).toEqual(changed(fork));
    expect(byPath(rc)['raw/data.bin']).toEqual({ change: 'added', lfs: true, class: 'content' });
    expect(byPath(rc)['.gitattributes']).toEqual({ change: 'modified', lfs: false, class: 'content' });
  });

  it('.gitattributes changed by the operations: its own content governs, and it is code', async () => {
    // an edit adding a pattern makes a later put of a small binary match it (no exact entry)
    const attrs = blobId(site.coords, '.gitattributes');
    const { fork, result } = await run([
      { edit: '.gitattributes', content: `${ATTRS}*.psd filter=lfs diff=lfs merge=lfs -text\n`, baseBlob: attrs },
      bigPut('art/cover.psd', 100, 'd'.repeat(64), true),
    ]);
    const rc = ok(result);
    expect(show(fork, '.gitattributes')).toBe(`${ATTRS}*.psd filter=lfs diff=lfs merge=lfs -text\n`);
    expect(byPath(rc)['.gitattributes']).toEqual({ change: 'modified', lfs: false, class: 'code' });

    // moving .gitattributes away: an entry needed later starts a fresh root file
    const moved = await run([{ move: '.gitattributes', to: 'old.gitattributes' }, bigPut('clips/b.mp4', 10, 'e'.repeat(64), true)]);
    ok(moved.result);
    expect(show(moved.fork, '.gitattributes')).toBe(`${gitattributesLfsEntry('clips/b.mp4')}\n`);
    expect(show(moved.fork, 'old.gitattributes')).toBe(ATTRS);

    // a put of .gitattributes is kept, and exact entries are appended to it
    const put = await run([await smallPut('.gitattributes', '*.wav filter=lfs diff=lfs merge=lfs -text\n'), bigPut('a/b.mov', 10, 'e'.repeat(64), true)]);
    ok(put.result);
    expect(show(put.fork, '.gitattributes')).toBe(`*.wav filter=lfs diff=lfs merge=lfs -text\n${gitattributesLfsEntry('a/b.mov')}\n`);
  });

  it('a small text put matching a pattern becomes a pointer without fetching the staged file', async () => {
    const text = 'not really a video\n';
    const op = { put: 'clips/x.mp4', stagingId: `lfs-u${++seq}`, sha256: SHA(text), size: text.length, binary: false, r2Key: `org/org1/lfs/res-site/obj/never-staged-${seq}` };
    const { fork, result } = await run([op]);
    const rc = ok(result);
    expect(show(fork, 'clips/x.mp4')).toBe(lfsPointer(SHA(text), text.length));
    expect(show(fork, '.gitattributes')).toBe(ATTRS);
    expect(rc.lfsObjects).toEqual([{ stagingId: op.stagingId, sha256: SHA(text), size: text.length }]);
    expect(rc.changedPaths).toEqual([{ path: 'clips/x.mp4', change: 'added', lfs: true, class: 'content' }]);
  });

  it('limit_exceeded when a pointer path is too long for an exact .gitattributes entry', async () => {
    const long = `${'A B C D E F G H/'.repeat(25)}x.mov`; // 405 characters, a 2,192-byte entry git ignores
    expect(long).toHaveLength(405);
    const put = await run([bigPut(long)]);
    expect(put.result).toMatchObject({ ok: false, code: 'limit_exceeded' });
    expect((put.result as { detail: string }).detail).toContain('too long to be stored in LFS');
    expect(await w.remoteSha(put.fork, 'refs/heads/main')).toBeNull();
    // a pointer moved there too
    const moved = await run([{ move: 'videos/old.mp4', to: long }]);
    expect(moved.result).toMatchObject({ ok: false, code: 'limit_exceeded' });
    // a pattern-matched long path needs no entry
    const matched = await run([bigPut(`${'A B C D E F G H/'.repeat(25)}x.mp4`)]);
    ok(matched.result);
  });

  it('exact entries follow the final .gitattributes, whatever the order of the operations', async () => {
    const attrs = blobId(site.coords, '.gitattributes');
    // the pattern that matched the put is removed later: the pointer gets its exact entry
    const removed = await run([bigPut('clips/a.mp4', 10, 'a'.repeat(64), true), { edit: '.gitattributes', content: '# none\n', baseBlob: attrs }]);
    ok(removed.result);
    expect(show(removed.fork, '.gitattributes')).toBe(`# none\n${gitattributesLfsEntry('clips/a.mp4')}\n`);
    expect(show(removed.fork, 'videos/old.mp4')).toBe(lfsPointer('1'.repeat(64), 5_000_000)); // base pointers are not this job's
    // a pattern added later covers the put: no exact entry
    const covered = await run([bigPut('a/b.mov', 10, 'b'.repeat(64), true), { edit: '.gitattributes', content: `${ATTRS}*.mov filter=lfs diff=lfs merge=lfs -text\n`, baseBlob: attrs }]);
    ok(covered.result);
    expect(show(covered.fork, '.gitattributes')).toBe(`${ATTRS}*.mov filter=lfs diff=lfs merge=lfs -text\n`);
  });

  it('path_conflict naming a base path a change cannot name (NFD, backslash)', async () => {
    const nfd = 'odd/cafe\u0301.md';
    // plumbing, so neither the file system nor core.precomposeUnicode normalizes the names
    const work = await w.workRepo({ 'odd/ok.md': 'ok\n', 'keep.txt': 'k\n' });
    for (const [path, data] of [[nfd, 'nfd\n'], ['slash/a\\b.txt', 'x\n']] as const) {
      const oid = (await w.git.ok(['hash-object', '-w', '--stdin'], work.path, { input: data })).trim();
      await w.git.ok(['-c', 'core.precomposeUnicode=false', 'update-index', '--add', '--cacheinfo', `100644,${oid},${path}`], work.path);
    }
    const who = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.test' };
    await w.git.ok(['-c', 'core.precomposeUnicode=false', 'commit', '-q', '-m', 'odd names'], work.path, { env: who }); // not w.commit: `add -A` would drop the entries
    const odd = await w.canonicalFrom('res-odd', work.path);
    expect(git(odd.coords, ['ls-tree', '-r', '-z', '--name-only', 'refs/heads/main']).split('\0')).toEqual(expect.arrayContaining([nfd, 'slash/a\\b.txt']));
    for (const op of [{ delete: 'odd' }, { move: 'odd', to: 'even' }, { delete: 'slash' }]) {
      const r = await run([op], { repo: odd });
      expect(r.result, JSON.stringify(op)).toMatchObject({ ok: false, code: 'path_conflict' });
      expect((r.result as { detail: string }).detail).toMatch(/cafe|a\\\\b/);
    }
    const fine = await run([{ delete: 'keep.txt' }], { repo: odd });
    expect(ok(fine.result).changedPaths).toEqual([{ path: 'keep.txt', change: 'deleted', lfs: false, class: 'code' }]);
  });

  it('only objects the commit still points to are promoted', async () => {
    const op = bigPut('tmp/a.mov', 10, 'e'.repeat(64), true);
    const keep = bigPut('keep/b.mov', 10, '9'.repeat(64), true);
    const { result } = await run([op, keep, { delete: 'tmp/a.mov' }]);
    expect(ok(result).lfsObjects).toEqual([{ stagingId: keep.stagingId, sha256: '9'.repeat(64), size: 10 }]);
  });
  it('reads its operations from the R2 manifest: a tampered, miscounted, invalid or missing manifest fails the job', async () => {
    const ops = [{ delete: 'docs/a.md' }];
    const good = await run(ops);
    expect(ok(good.result).changedPaths).toEqual([{ path: 'docs/a.md', change: 'deleted', lfs: false, class: 'code' }]);
    const tampered = await run(ops, { manifest: { bytes: JSON.stringify([{ delete: 'index.html' }]) } });
    expect(tampered.result).toMatchObject({ ok: false, code: 'scope_violation' });
    expect((tampered.result as { detail: string }).detail).toContain('sha256');
    const miscounted = await run(ops, { manifest: { count: 2 } });
    expect(miscounted.result).toMatchObject({ ok: false, code: 'scope_violation' });
    const invalid = [{ delete: '.git/config' }];
    expect((await run(invalid)).result).toMatchObject({ ok: false, code: 'scope_violation' });
    const missing = await run(ops, { manifest: { stage: false } });
    expect(missing.result).toMatchObject({ ok: false, code: 'provider_unavailable' });
    for (const r of [tampered, miscounted, missing]) expect(await w.remoteSha(r.fork, 'refs/heads/main')).toBeNull();
  });

  it('R7: replacing a code file that was not in LFS stays code, even with an LFS object; replacing an LFS file is content', async () => {
    const big = bigPut('index.html', 2_000_000);
    const code = await run([big]);
    expect(byPath(ok(code.result))['index.html']).toEqual({ change: 'modified', lfs: true, class: 'code' });
    expect(show(code.fork, 'index.html')).toBe(lfsPointer(BIG, 2_000_000));
    // the base version was already an LFS pointer: replacing it is content
    const lfs = await run([bigPut('videos/old.mp4', 6_000_000, 'b'.repeat(64), true)]);
    expect(byPath(ok(lfs.result))['videos/old.mp4']).toEqual({ change: 'modified', lfs: true, class: 'content' });
    // a new path is classified by what it is
    const added = await run([bigPut('assets/new.js', 2_000_000)]);
    expect(byPath(ok(added.result))['assets/new.js']).toEqual({ change: 'added', lfs: true, class: 'content' });
  });

  it('M3: limit_exceeded when the change would touch more than 5,000 paths; 5,000 is fine', async () => {
    const files: Record<string, string> = { 'extra/x.txt': 'x\n' };
    for (let i = 0; i < 5_000; i++) files[`many/f${String(i).padStart(4, '0')}.txt`] = `${i}\n`;
    const repo = await w.canonical('res-many', files);
    const fine = await run([{ delete: 'many' }], { repo });
    expect(ok(fine.result).changedPaths).toHaveLength(5_000);
    const over = await run([{ delete: 'many' }, { delete: 'extra' }], { repo });
    expect(over.result).toMatchObject({ ok: false, code: 'limit_exceeded' });
    expect((over.result as { detail: string }).detail).toContain('5001');
    expect(await w.remoteSha(over.fork, 'refs/heads/main')).toBeNull();
  }, 120_000);
});
