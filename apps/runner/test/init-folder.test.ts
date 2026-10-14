import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalGitCoords } from '@commonforge-org/core';
import { defaultGitattributes } from '@commonforge-org/runner-protocol';
import { JobContext, staticCredentials } from '../src/index.js';
import { createGit, KeyedMutex, type Git } from '../src/git.js';
import { initFolder } from '../src/jobs/init-folder.js';
import { linuxProcessOps } from '../src/procs.js';
import { World } from './helpers.js';

let w: World;

beforeAll(async () => {
  w = await World.create();
});
afterAll(() => w?.close());

const COMMIT_TIME = '2026-10-11T09:30:00.000Z';
const EPOCH = Date.parse(COMMIT_TIME) / 1000;
const FILES = [
  { path: 'README.md', content: '# Brand Assets\n' },
  { path: '.gitattributes', content: defaultGitattributes() },
  { path: '.lfsconfig', content: '[lfs]\n\turl = https://cf.example/api/lfs/org1/res-brand/info/lfs\n' },
];

const job = (canonical: LocalGitCoords) => ({
  kind: 'init-folder' as const,
  resourceId: 'res-brand',
  canonical,
  files: FILES,
  author: { name: 'Dana Owner', email: 'dana@example.test' },
  commitTime: COMMIT_TIME,
  message: 'Create folder Brand Assets',
});

const gitDir = (c: LocalGitCoords) => ['--git-dir', fileURLToPath(c.remoteUrl)];

describe('init-folder', () => {
  it('pushes one parentless commit of exactly the files, by the author, committed by CommonForge at commitTime', async () => {
    const canonical = await w.bareRepo('canonical', 'brand');
    const r = await w.runner().execute(await w.delivery(job(canonical)));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const receipt = r.receipt as { jobId: string; resourceId: string; commitSha: string; status: string };
    expect(receipt).toMatchObject({ resourceId: 'res-brand', status: 'created' });
    expect(receipt.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await w.remoteRefs(canonical)).toEqual({ 'refs/heads/main': receipt.commitSha });
    expect(await w.parents(canonical, receipt.commitSha)).toEqual([]);

    const tree = await w.git.ok([...gitDir(canonical), 'ls-tree', '-r', receipt.commitSha], w.root);
    expect(tree.trim().split('\n').map((l) => l.split(/\s+/).slice(0, 2).join(' ') + ' ' + l.split('\t')[1])).toEqual([
      '100644 blob .gitattributes',
      '100644 blob .lfsconfig',
      '100644 blob README.md',
    ]);
    for (const f of FILES) expect(await w.showFile(canonical, receipt.commitSha, f.path)).toBe(f.content);

    const raw = await w.git.ok([...gitDir(canonical), 'cat-file', 'commit', receipt.commitSha], w.root);
    expect(raw).toContain(`\nauthor Dana Owner <dana@example.test> ${EPOCH} +0000\n`);
    expect(raw).toContain(`\ncommitter CommonForge <noreply@commonforge.invalid> ${EPOCH} +0000\n`);
    expect(raw.endsWith('\n\nCreate folder Brand Assets\n')).toBe(true);
    expect(raw).not.toMatch(/^parent /m);

    // tokens: canonical write only, every one revoked
    const issued = w.worker.issued.filter((t) => t.jobId === r.jobId);
    expect(issued.length).toBeGreaterThan(0);
    for (const t of issued) expect([t.repo, t.access]).toEqual(['brand', 'write']);
    w.assertTokensHygiene(JSON.stringify(r));
  });

  it('is deterministic: the same job again answers already with the same commit', async () => {
    const canonical = await w.bareRepo('canonical', 'brand-retry');
    const first = await w.runner().execute(await w.delivery(job(canonical)));
    const second = await w.runner().execute(await w.delivery(job(canonical)));
    expect(first).toMatchObject({ ok: true, receipt: { status: 'created' } });
    expect(second).toMatchObject({ ok: true, receipt: { status: 'already' } });
    const sha = (first as { receipt: { commitSha: string } }).receipt.commitSha;
    expect((second as { receipt: { commitSha: string } }).receipt.commitSha).toBe(sha);
    expect(await w.remoteRefs(canonical)).toEqual({ 'refs/heads/main': sha });
  });

  it('fails branch_not_empty when main holds another commit, and pushes nothing', async () => {
    const canonical = await w.bareRepo('canonical', 'brand-taken');
    const other = await w.workRepo({ 'other.txt': 'x\n' });
    await w.git.ok(['push', '-q', canonical.remoteUrl, 'HEAD:refs/heads/main'], other.path);
    const r = await w.runner().execute(await w.delivery(job(canonical)));
    expect(r).toMatchObject({ ok: false, code: 'branch_not_empty' });
    expect(await w.remoteRefs(canonical)).toEqual({ 'refs/heads/main': other.sha });
  });

  it('a failed push with main still absent is provider_unavailable (retryable)', async () => {
    const canonical = await w.bareRepo('canonical', 'brand-busy');
    const hook = join(fileURLToPath(canonical.remoteUrl), 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\necho "artifacts_git_receive_pack_busy" >&2\nexit 1\n');
    await chmod(hook, 0o755);
    const r = await w.runner({ push: { attempts: 2, baseDelayMs: 1 } }).execute(await w.delivery(job(canonical)));
    expect(r).toMatchObject({ ok: false, code: 'provider_unavailable' });
    expect(await w.remoteRefs(canonical)).toEqual({});
  });

  it('reads and pushes nothing but canonical refs/heads/main', async () => {
    const canonical = await w.bareRepo('canonical', 'brand-scope');
    const calls: string[][] = [];
    const real = createGit({ allowFile: true });
    const git: Git = {
      run: (args, cwd, o) => (calls.push([...args]), real.run(args, cwd, o)),
      runBytes: (args, cwd, o) => (calls.push([...args]), real.runBytes(args, cwd, o)),
      ok: (args, cwd, o) => (calls.push([...args]), real.ok(args, cwd, o)),
    };
    const d = await w.delivery(job(canonical));
    const ctx = new JobContext<'init-folder'>(
      d.signedJob,
      w.dir('ctx'),
      staticCredentials(() => ({})).open(d.signedJob),
      { git, pushMutex: new KeyedMutex(), runnerId: 'r', runnerKind: 'node-runner', commands: {}, checksRoot: w.dir('checks'), procs: linuxProcessOps, push: {}, canaries: [], now: () => new Date(), log: () => undefined },
      null,
      [],
    );
    const pushes: Array<{ ref: string; repo: string }> = [];
    const push = ctx.push.bind(ctx);
    ctx.push = (req) => (pushes.push({ ref: req.ref, repo: req.coords.repoName }), push(req));
    const receipt = await initFolder(ctx);
    expect(receipt.status).toBe('created');
    expect(pushes).toEqual([{ ref: 'refs/heads/main', repo: 'brand-scope' }]);
    // no fetch at all; every remote command names canonical and only refs/heads/main
    expect(calls.filter((a) => a.includes('fetch'))).toEqual([]);
    const remote = calls.filter((a) => a.includes('ls-remote') || a.includes('push'));
    expect(remote.length).toBeGreaterThan(0);
    for (const a of remote) {
      expect(a).toContain(canonical.remoteUrl);
      expect(a[a.length - 1]).toMatch(/(^|:)refs\/heads\/main$/);
    }
  });
});
