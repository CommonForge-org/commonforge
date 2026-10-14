/**
 * Behavior the conformance suite does not cover: token expiry, the reference-transaction guard,
 * freeze lock contention, renames, persistence across instances, input fences, the HTTP-front
 * authorization check and git isolation.
 */
import { rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  changeId,
  localRevisionId,
  type FreezeInput,
  type ResourceRef,
  type TaskWorkspaceHandle,
  type WorkspaceGrant,
} from '@commonforge-org/core';
import { AgentCheckout, createSeedRepo, createTempDir, gitOk, nodeGitRunner, removeDir } from '@commonforge-org/conformance/provider';
import { FileExportStore, LocalGitProvider, PACKAGE_NAME, parseNameStatus, parseNumstat } from '../src/index.js';

const git = nodeGitRunner();
const ORG = 'org-unit';
const grant = (ops: WorkspaceGrant['operations'], ttlSeconds = 3600): WorkspaceGrant => ({
  principal: { kind: 'agent', id: 'agent-unit' },
  operations: ops,
  ttlSeconds,
  leaseGeneration: 1,
});
const freeze = (sha: string): FreezeInput => ({ expectedSha: sha, submitter: { kind: 'agent', id: 'agent-unit' } });
const text = (b: Uint8Array | null) => (b === null ? null : new TextDecoder().decode(b));

let dir = '';
let root = '';
let seedSha = '';
let seedPath = '';
let seq = 0;
const scratch = (label: string) => join(dir, `${++seq}-${label}`);

beforeEach(async () => {
  dir = await createTempDir('cf-local-git-unit-');
  root = join(dir, 'root');
  const seed = await createSeedRepo(git, join(dir, 'seed'), { 'README.md': 'hello\n', 'src/a.txt': 'a\nb\nc\nd\ne\nf\n', 'src/deep/b.txt': 'b\n' });
  seedSha = seed.sha;
  seedPath = seed.path;
});
afterEach(async () => {
  await removeDir(dir);
});

async function setup(options: Partial<Parameters<typeof LocalGitProvider.open>[0]> = {}) {
  const provider = await LocalGitProvider.open({ root, ...options });
  const resource = await provider.createCanonicalResource({ organizationId: ORG, resourceId: 'res-unit', source: seedPath });
  const base = localRevisionId(resource.coords.kind === 'local-git' ? resource.coords.repoId : '', seedSha);
  return { provider, resource, base };
}

async function workspace(provider: LocalGitProvider, resource: ResourceRef, base: ReturnType<typeof localRevisionId>, n = 'x') {
  return provider.createIsolatedChange({ resource, baseRevision: base, taskId: `task-${n}`, organizationId: ORG, changeId: changeId(`change-${n}`), purpose: 'agent-task' });
}

async function agentCheckout(provider: LocalGitProvider, handle: TaskWorkspaceHandle, ttl = 3600, now?: Date) {
  const p = now ? await LocalGitProvider.open({ root, now: () => now }) : provider;
  const cred = await p.issueWorkspaceCredential(handle, grant(['read', 'write'], ttl));
  const agentGit = nodeGitRunner(LocalGitProvider.credentialGitEnv(cred));
  return { cred, agentGit, checkout: await AgentCheckout.clone(agentGit, cred.remoteUrl, scratch('agent')) };
}

describe(PACKAGE_NAME, () => {
  it('refuses a push with an expired credential and accepts a live one', async () => {
    const { provider, resource, base } = await setup();
    const ws = await workspace(provider, resource, base);
    const expired = await agentCheckout(provider, ws, 60, new Date(Date.now() - 2 * 3600_000));
    await expired.checkout.commit({ 'x.txt': 'x\n' }, 'x');
    const r = await expired.checkout.push();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('credential expired');

    const live = await agentCheckout(provider, ws);
    await live.checkout.commit({ 'y.txt': 'y\n' }, 'y');
    expect((await live.checkout.push()).code).toBe(0);
  });

  it('refuses --atomic pushes (Artifacts parity) and the service credential on task repos', async () => {
    const { provider, resource, base } = await setup();
    const ws = await workspace(provider, resource, base);
    const { checkout } = await agentCheckout(provider, ws);
    await checkout.commit({ 'x.txt': 'x\n' }, 'x');
    const atomic = await checkout.git(['push', '--atomic', 'origin', 'HEAD:refs/heads/main'], checkout.dir);
    expect(atomic.code).not.toBe(0);
    expect(atomic.stderr).toMatch(/atomic/);
    const service = nodeGitRunner(await provider.serviceGitEnv());
    const r = await service(['push', ws.coords.remoteUrl, 'HEAD:refs/heads/main'], checkout.dir);
    expect(r.code).not.toBe(0);
  });

  it('the reference-transaction guard alone refuses pushes to a frozen workspace', async () => {
    const { provider, resource, base } = await setup();
    const ws = await workspace(provider, resource, base);
    const { checkout } = await agentCheckout(provider, ws);
    const repo = fileURLToPath(ws.coords.remoteUrl);
    await unlink(join(repo, 'commonforge', 'hooks', 'pre-receive'));
    await writeFile(join(repo, 'commonforge', 'frozen'), 'test\n');
    await checkout.commit({ 'x.txt': 'x\n' }, 'x');
    const r = await checkout.push();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('workspace is frozen');
    expect((await gitOk(git, ['rev-parse', 'refs/heads/main'], repo)).trim()).toBe(seedSha);
  });

  it('freeze refuses while a push holds the branch lock and rolls back the marker', async () => {
    const { provider, resource, base } = await setup({ freezeLockTimeoutMs: 50 });
    const ws = await workspace(provider, resource, base);
    const repo = fileURLToPath(ws.coords.remoteUrl);
    await writeFile(join(repo, 'refs', 'heads', 'main.lock'), `${seedSha}\n`);
    await expect(provider.freezeCandidate(ws, freeze(seedSha))).rejects.toMatchObject({ code: 'candidate_moved_during_freeze' });
    await rm(join(repo, 'refs', 'heads', 'main.lock'));
    // the old write token was revoked; a fresh one works because the workspace is still writable
    const { checkout } = await agentCheckout(provider, ws);
    await checkout.commit({ 'x.txt': 'x\n' }, 'x');
    expect((await checkout.push()).code).toBe(0);
  });

  it('compare reports renames; freeze lists both rename paths', async () => {
    const { provider, resource, base } = await setup();
    const ws = await workspace(provider, resource, base);
    const { checkout } = await agentCheckout(provider, ws);
    await gitOk(checkout.git, ['mv', 'src/a.txt', 'src/renamed.txt'], checkout.dir);
    const sha = await checkout.commit({ 'src/renamed.txt': 'a\nb\nc\nd\ne\nf\ng\n' }, 'rename');
    expect((await checkout.push()).code).toBe(0);
    const cmp = await provider.compare(resource, base, localRevisionId(ws.coords.repoId, sha));
    expect(cmp.files).toEqual([{ path: 'src/renamed.txt', status: 'renamed', oldPath: 'src/a.txt', binary: false, additions: 1, deletions: 0 }]);
    const frozen = await provider.freezeCandidate(ws, freeze(sha));
    expect(frozen.changedPaths).toEqual(['src/a.txt', 'src/renamed.txt']);
  });

  it('persists workspace state and the service credential across instances', async () => {
    const { provider, resource, base } = await setup();
    const ws = await workspace(provider, resource, base);
    await provider.freezeCandidate(ws, freeze(seedSha));
    const again = await LocalGitProvider.open({ root });
    expect(await again.serviceToken()).toBe(await provider.serviceToken());
    await expect(again.issueWorkspaceCredential(ws, grant(['read', 'write']))).rejects.toMatchObject({ code: 'workspace_not_writable' });
    expect((await again.issueWorkspaceCredential(ws, grant(['read']))).scope).toBe('read');
    expect(await again.openCanonicalResource(ORG, 'res-unit')).toEqual(resource);
    expect(await again.openCanonicalResource('org-other', 'res-unit')).toBeNull();
  });

  it('fences inputs: foreign revisions, bad paths, duplicate resources, canonical handles', async () => {
    const { provider, resource, base } = await setup();
    const other = await provider.createCanonicalResource({ organizationId: ORG, resourceId: 'res-other', source: seedPath });
    const otherRev = localRevisionId('res-other', seedSha);
    await expect(provider.readFile(resource, otherRev, 'README.md')).rejects.toMatchObject({ code: 'revision_mismatch' });
    await expect(provider.readFile(resource, `art:res-unit:${seedSha}` as typeof base, 'README.md')).rejects.toMatchObject({ code: 'revision_mismatch' });
    await expect(provider.readFile(resource, base, '../etc/passwd')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(provider.readFile(resource, localRevisionId('res-unit', 'f'.repeat(40)), 'README.md')).rejects.toMatchObject({ code: 'not_found' });
    await expect(provider.createCanonicalResource({ organizationId: ORG, resourceId: 'res-unit' })).rejects.toMatchObject({ code: 'already_exists' });
    await expect(provider.readFile({ ...resource, coords: other.coords }, base, 'README.md')).rejects.toMatchObject({ code: 'not_found' });
    const ws = await workspace(provider, resource, base);
    const canonicalHandle = { ...ws, coords: resource.coords } as TaskWorkspaceHandle;
    await expect(provider.collectWorkspace(canonicalHandle)).rejects.toMatchObject({ code: 'canonical_namespace_refused' });
    await expect(provider.freezeCandidate(canonicalHandle, freeze(seedSha))).rejects.toMatchObject({ code: 'canonical_namespace_refused' });
    const spoofed = { ...ws, coords: { ...ws.coords, remoteUrl: other.coords.kind === 'local-git' ? other.coords.remoteUrl : '' } };
    await expect(provider.issueWorkspaceCredential(spoofed, grant(['read']))).rejects.toMatchObject({ code: 'namespace_refused' });
    await expect(new FileExportStore(dir).put('../escape', new Uint8Array())).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('reads trees and files by path; resolves ref, candidate and accepted selectors', async () => {
    const acceptedHead = async () => localRevisionId('res-unit', seedSha);
    const { provider, resource, base } = await setup({ acceptedHead });
    expect((await provider.listTree(resource, base, 'src')).map((e) => [e.path, e.type])).toEqual([
      ['src/a.txt', 'file'],
      ['src/deep', 'dir'],
    ]);
    expect(await provider.listTree(resource, base, 'README.md')).toEqual([]);
    expect(await provider.listTree(resource, base, 'nope')).toEqual([]);
    expect(await provider.readFile(resource, base, 'src')).toBeNull();
    expect(text(await provider.readFile(resource, base, 'src/deep/b.txt'))).toBe('b\n');
    expect((await provider.resolveRevision(resource, { kind: 'ref', ref: 'refs/heads/main' })).contentId).toBe(seedSha);
    await expect(provider.resolveRevision(resource, { kind: 'ref', ref: 'refs/heads/nope' })).rejects.toMatchObject({ code: 'ref_unresolved' });
    expect((await provider.resolveRevision(resource, { kind: 'accepted' })).revisionId).toBe(base);
    const ws = await workspace(provider, resource, base);
    const { checkout } = await agentCheckout(provider, ws);
    const sha = await checkout.commit({ 'z.txt': 'z\n' }, 'z');
    expect((await checkout.push()).code).toBe(0);
    const frozen = await provider.freezeCandidate(ws, freeze(sha));
    const resolved = await provider.resolveRevision(resource, { kind: 'candidate', candidateId: frozen.candidateId });
    expect(resolved).toMatchObject({ contentId: sha, revisionId: localRevisionId(ws.coords.repoId, sha), coords: ws.coords });
    await provider.collectWorkspace(ws);
    await provider.collectWorkspace(ws); // idempotent
    await expect(provider.resolveRevision(resource, { kind: 'candidate', candidateId: frozen.candidateId })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('authorizeGitRequest mirrors the push guard for an HTTP front', async () => {
    const { provider, resource, base } = await setup();
    const ws = await workspace(provider, resource, base);
    const c = resource.coords.kind === 'local-git' ? resource.coords : ws.coords;
    const write = await provider.issueWorkspaceCredential(ws, grant(['read', 'write']));
    const read = await provider.issueWorkspaceCredential(ws, grant(['read']));
    const service = await provider.serviceToken();
    const ask = (coords: typeof c, secret: string | null, operation: 'read' | 'write') =>
      provider.authorizeGitRequest({ namespace: coords.namespace, repoName: coords.repoName, secret, operation });
    expect(await ask(c, service, 'write')).toBe(true);
    expect(await ask(c, write.secret, 'read')).toBe(false);
    expect(await ask(ws.coords, write.secret, 'write')).toBe(true);
    expect(await ask(ws.coords, read.secret, 'write')).toBe(false);
    expect(await ask(ws.coords, read.secret, 'read')).toBe(true);
    expect(await ask(ws.coords, service, 'write')).toBe(false);
    expect(await ask(ws.coords, null, 'read')).toBe(false);
    await provider.freezeCandidate(ws, freeze(seedSha));
    expect(await ask(ws.coords, write.secret, 'write')).toBe(false);
    expect(await ask(ws.coords, read.secret, 'read')).toBe(true);
    await provider.collectWorkspace(ws);
    expect(await ask(ws.coords, read.secret, 'read')).toBe(false);
  });

  it('ignores inherited git environment and the caller global config', async () => {
    const hostile = join(dir, 'hostile.gitconfig');
    await writeFile(hostile, '[init]\n\tdefaultBranch = trunk\n[core]\n\thooksPath = /nonexistent\n');
    const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_DIR: process.env.GIT_DIR };
    process.env.GIT_CONFIG_GLOBAL = hostile;
    process.env.GIT_DIR = join(dir, 'not-a-repo');
    try {
      const { provider, resource, base } = await setup();
      expect(text(await provider.readFile(resource, base, 'README.md'))).toBe('hello\n');
      const ws = await workspace(provider, resource, base);
      const repo = fileURLToPath(ws.coords.remoteUrl);
      expect((await gitOk(git, ['symbolic-ref', 'HEAD'], repo)).trim()).toBe('refs/heads/main');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('refuses option injection and unsafe transports in createCanonicalResource', async () => {
    const provider = await LocalGitProvider.open({ root });
    const marker = (n: string) => join(dir, `PWN-${n}`);
    const attempts: Array<[string, string | undefined]> = [
      [`--upload-pack=touch ${marker('1')};`, 'HEAD'],
      ['/nonexistent', `--upload-pack=touch ${marker('2')};x`],
      [`ext::sh -c touch% ${marker('3')}`, 'HEAD'],
      [seedPath, '-x'],
      [seedPath, 'main'],
    ];
    for (const [i, [source, sourceRef]] of attempts.entries()) {
      await expect(provider.createCanonicalResource({ organizationId: ORG, resourceId: `res-inj-${i}`, source, sourceRef })).rejects.toMatchObject({
        code: expect.stringMatching(/^(invalid_input|git_failed)$/),
      });
    }
    for (const n of ['1', '2', '3']) await expect(stat(marker(n))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(provider.createCanonicalResource({ organizationId: ORG, resourceId: 'res-inj-b', source: seedPath, branch: '-x' })).rejects.toMatchObject({ code: 'invalid_input' });
    // the accepted forms still work
    const bySha = await provider.createCanonicalResource({ organizationId: ORG, resourceId: 'res-sha', source: seedPath, sourceRef: seedSha });
    expect((await provider.resolveRevision(bySha, { kind: 'ref', ref: 'refs/heads/main' })).contentId).toBe(seedSha);
  });

  it('reports a corrupt registry record with a code', async () => {
    const { provider, resource, base } = await setup();
    await writeFile(join(root, '.commonforge', 'repos', 'res-unit.json'), '{not json');
    await expect(provider.readFile(resource, base, 'README.md')).rejects.toMatchObject({ code: 'state_corrupt' });
  });

  it('prepareForAcceptance refuses a collected workspace before submitting', async () => {
    const { provider, resource, base } = await setup();
    const ws = await workspace(provider, resource, base);
    const frozen = await provider.freezeCandidate(ws, freeze(seedSha));
    await provider.collectWorkspace(ws);
    let submitted = false;
    const submit = (async () => {
      submitted = true;
      throw new Error('must not be called');
    }) as unknown as Parameters<LocalGitProvider['prepareForAcceptance']>[1];
    await expect(provider.prepareForAcceptance(frozen, submit)).rejects.toMatchObject({ code: 'workspace_collected' });
    expect(submitted).toBe(false);
  });

  it('maintain() packs refs past the guard; plain token-less pack-refs is refused', async () => {
    const { provider, resource } = await setup();
    const repo = fileURLToPath(resource.coords.kind === 'local-git' ? resource.coords.remoteUrl : '');
    expect((await git(['pack-refs', '--all'], repo)).code).not.toBe(0);
    expect(await provider.maintain()).toContain(`${resource.coords.kind === 'local-git' ? resource.coords.namespace : ''}/res-unit`);
    expect((await gitOk(git, ['for-each-ref', '--format=%(refname)'], repo)).trim()).toBe('refs/heads/main');
  });

  it('parses -z diff output including renames and paths with tabs', () => {
    expect(parseNameStatus('M\0a b\0R090\0old\0new\0D\0x\0')).toEqual([
      { path: 'a b', status: 'modified' },
      { path: 'new', status: 'renamed', oldPath: 'old' },
      { path: 'x', status: 'deleted' },
    ]);
    const stats = parseNumstat('1\t2\ttab\there\x00-\t-\tbin\x003\t0\t\x00old\x00new\x00');
    expect(stats.get('tab\there')).toEqual({ binary: false, additions: 1, deletions: 2 });
    expect(stats.get('bin')).toEqual({ binary: true });
    expect(stats.get('new')).toEqual({ binary: false, additions: 3, deletions: 0 });
  });
});

