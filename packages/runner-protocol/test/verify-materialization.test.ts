/**
 * materialize + verifyMaterialization against a temp dir and REAL git, through the node io adapter.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeAssetManifestIdSync,
  localRevisionId,
  r2mRevisionId,
  sha256HexSync,
  type AssetManifest,
  type MaterializationPlan,
  type ResourceId,
} from '@commonforge-org/core';
import { WORKSPACE_JSON_PATH, isPersistingCredentialHelper, materialize, validatePlan, planMaterialization, verifyMaterialization, type MaterializationAuthorization } from '../src/index.js';
import { createNodeIo } from '../src/node/index.js';
import { localCoords, snapshot, workspaceHandle } from './fixtures.js';

const res = (s: string) => s as ResourceId;
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;
delete GIT_ENV.GIT_INDEX_FILE;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function makeRepo(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return git(dir, 'rev-parse', 'HEAD');
}

const assetBytes = new TextEncoder().encode('PNG-ish bytes');
function assetManifest(): AssetManifest {
  const entries = [
    { path: 'img/logo.png', sha256: sha256HexSync(assetBytes), size: assetBytes.length, mime: 'image/png', objectKey: `org/org1/res/res-assets/obj/${sha256HexSync(assetBytes)}` },
  ];
  const manifestId = computeAssetManifestIdSync({ resourceId: 'res-assets', parentManifestId: null, entries });
  return { manifestId, resourceId: res('res-assets'), parentManifestId: null, entries, createdAt: '2026-10-06T00:00:00.000Z' };
}

let tmp: string;
let root: string;
let plan: MaterializationPlan;
let siteSha: string;
let libSha: string;
const io = () =>
  createNodeIo({
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    fetchObject: async ({ entry }) => {
      if (entry.sha256 !== sha256HexSync(assetBytes)) throw new Error('unknown object');
      return assetBytes;
    },
  });

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cf-rp-'));
  const forkDir = join(tmp, 'remotes', 'site-fork');
  const libDir = join(tmp, 'remotes', 'lib');
  siteSha = makeRepo(forkDir, { 'index.html': '<h1>site</h1>', 'src/app.js': 'export {}' });
  libSha = makeRepo(libDir, { 'README.md': '# lib' });
  // Move the fork's branch on: the plan pins the older base sha, so HEAD must be detached at it.
  writeFileSync(join(forkDir, 'later.txt'), 'later');
  git(forkDir, 'add', '-A');
  git(forkDir, 'commit', '-q', '-m', 'later');
  root = join(tmp, 'ws');
  const manifest = assetManifest();
  const snap = snapshot([
    { resourceId: res('res-site'), revisionId: localRevisionId('site', siteSha), mode: 'pinned-reference', mountName: 'site', operations: ['read', 'write'] },
    { resourceId: res('res-lib'), revisionId: localRevisionId('lib', libSha), mode: 'pinned-reference', mountName: 'lib', operations: ['read'] },
    { resourceId: res('res-assets'), revisionId: r2mRevisionId(manifest.manifestId), mode: 'pinned-reference', mountName: 'assets', operations: ['read'] },
  ]);
  const authz: MaterializationAuthorization = {
    principal: { kind: 'agent', id: 'agent-1' },
    workspaceRoot: root,
    grants: [
      { resourceId: res('res-site'), operations: ['read', 'write'], coords: localCoords('site', join(tmp, 'remotes', 'site-canonical')) },
      { resourceId: res('res-lib'), operations: ['read'], coords: localCoords('lib', libDir) },
      { resourceId: res('res-assets'), operations: ['read'], coords: { kind: 'r2-assets', bucket: 'b', prefix: 'org/org1/res/res-assets/', manifestId: manifest.manifestId }, manifest },
    ],
    context: { request: 'demo', roles: [], rules: [], validationCommands: [] },
  };
  plan = planMaterialization(snap, [workspaceHandle('res-site', 'site', siteSha, localCoords('site-fork', forkDir))], authz);
  await materialize(plan, io());
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const codes = async () => (await verifyMaterialization(plan, io())).problems.map((p) => `${p.code}:${p.path}`);

describe('materialize + verifyMaterialization (real git)', () => {
  it('accepts a correct layout', async () => {
    const r = await verifyMaterialization(plan, io());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(git(join(root, 'site'), 'rev-parse', 'HEAD')).toBe(siteSha);
    expect(git(join(root, 'lib'), 'rev-parse', 'HEAD')).toBe(libSha);
    expect(readFileSync(join(root, 'assets', 'img', 'logo.png'), 'utf8')).toBe('PNG-ish bytes');
    const ws = JSON.parse(readFileSync(join(root, WORKSPACE_JSON_PATH), 'utf8'));
    expect(ws.mounts.find((m: { mountName: string }) => m.mountName === 'site').writable).toBe(true);
  });

  it('read-only mounts refuse pushes; writable mounts push to the fork', async () => {
    expect(() => git(join(root, 'lib'), 'push', 'origin', 'HEAD:refs/heads/x')).toThrow();
    git(join(root, 'site'), 'push', '-q', 'origin', 'HEAD:refs/commonforge/checkpoints/1');
  });

  it('rejects a symlink mount', async () => {
    const elsewhere = join(tmp, 'elsewhere');
    renameSync(join(root, 'lib'), elsewhere);
    symlinkSync(elsewhere, join(root, 'lib'));
    expect(await codes()).toContain('symlink_mount:lib');
  });

  it('rejects a symlinked .commonforge directory', async () => {
    renameSync(join(root, '.commonforge'), join(tmp, 'cf'));
    symlinkSync(join(tmp, 'cf'), join(root, '.commonforge'));
    expect(await codes()).toContain('symlink_mount:.commonforge');
  });

  it('rejects unadmitted root entries (file and dir), but admits extras when asked', async () => {
    writeFileSync(join(root, 'evil.txt'), 'x');
    mkdirSync(join(root, '.vibecontrol'));
    const c = await codes();
    expect(c).toContain('unadmitted_root_entry:evil.txt');
    expect(c).toContain('unadmitted_root_entry:.vibecontrol');
    const r = await verifyMaterialization(plan, io(), { admitRootEntries: ['.vibecontrol', 'evil.txt'] });
    expect(r.ok).toBe(true);
  });

  it('rejects HEAD != pinned sha', async () => {
    writeFileSync(join(root, 'site', 'new.txt'), 'n');
    git(join(root, 'site'), 'add', '-A');
    git(join(root, 'site'), 'commit', '-q', '-m', 'drift');
    expect(await codes()).toContain('head_mismatch:site');
  });

  it('rejects a mount with no repository of its own', async () => {
    rmSync(join(root, 'lib', '.git'), { recursive: true, force: true });
    expect(await codes()).toContain('not_a_repository:lib');
  });

  it('rejects a missing mount', async () => {
    rmSync(join(root, 'lib'), { recursive: true, force: true });
    expect(await codes()).toContain('missing_mount:lib');
  });

  it('rejects writable flags that disagree with the plan', async () => {
    const p = join(root, WORKSPACE_JSON_PATH);
    const ws = JSON.parse(readFileSync(p, 'utf8'));
    ws.mounts.find((m: { mountName: string }) => m.mountName === 'lib').writable = true;
    writeFileSync(p, JSON.stringify(ws));
    expect(await codes()).toContain(`context_file_mismatch:${WORKSPACE_JSON_PATH}`);
  });

  it('rejects a read-only mount that has been made pushable', async () => {
    git(join(root, 'lib'), 'remote', 'set-url', '--push', 'origin', `file://${join(tmp, 'remotes', 'lib')}`);
    expect(await codes()).toContain('read_only_mount_pushable:lib');
  });

  it('rejects an origin pointing somewhere else', async () => {
    git(join(root, 'site'), 'remote', 'set-url', 'origin', `file://${join(tmp, 'remotes', 'lib')}`);
    expect(await codes()).toContain('origin_mismatch:site');
  });

  it('rejects a token stored in git config', async () => {
    git(join(root, 'site'), 'config', 'http.extraHeader', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz');
    expect(await codes()).toContain('secret_in_git_config:site');
  });

  it('rejects tampered or symlinked assets', async () => {
    writeFileSync(join(root, 'assets', 'img', 'logo.png'), 'tampered');
    expect(await codes()).toContain('asset_mismatch:assets/img/logo.png');
    rmSync(join(root, 'assets', 'img', 'logo.png'));
    symlinkSync('/etc/hostname', join(root, 'assets', 'img', 'logo.png'));
    expect(await codes()).toContain('asset_mismatch:assets/img/logo.png');
  });

  it('materialize refuses a non-empty workspace root', async () => {
    await expect(materialize(plan, io())).rejects.toMatchObject({ code: 'workspace_not_empty' });
  });

  it('materialize refuses an object whose bytes do not match the manifest', async () => {
    const root2 = join(tmp, 'ws2');
    const bad = createNodeIo({ fetchObject: async () => new TextEncoder().encode('evil') });
    await expect(materialize(
        {
          workspaceRoot: root2,
          mounts: plan.mounts.filter((m) => m.source.kind === 'assets'),
          contextFiles: plan.contextFiles.filter((f) => !f.path.endsWith('-publication.json')),
        },
        bad,
      )).rejects.toMatchObject({
      code: 'asset_hash_mismatch',
    });
  });

  describe('review fixes (I-1, M-1, M-5)', () => {
    const hookPlan = (r: string): MaterializationPlan => ({
      ...plan,
      workspaceRoot: r,
      contextFiles: [...plan.contextFiles, { path: 'site/.git/hooks/post-commit', content: '#!/bin/sh\ntouch /tmp/pwn\n' }],
    });

    it('a plan may only write the planned .commonforge files (materialize and verify)', async () => {
      await expect(materialize(hookPlan(join(tmp, 'ws-hook')), io())).rejects.toMatchObject({ code: 'invalid_plan' });
      const r = await verifyMaterialization(hookPlan(root), io());
      expect(r.ok).toBe(false);
      expect(r.problems[0]).toMatchObject({ code: 'invalid_plan' });
      const stray = { ...plan, workspaceRoot: join(tmp, 'ws-x'), contextFiles: [...plan.contextFiles, { path: '.commonforge/extra.json', content: '{}' }] };
      expect(() => validatePlan(stray)).toThrow(/invalid_plan/);
      const dup = { ...plan, contextFiles: [...plan.contextFiles, plan.contextFiles[0]!] };
      expect(() => validatePlan(dup)).toThrow(/duplicate context file/);
    });

    it('rejects duplicate mount names and a relative root before touching the filesystem', async () => {
      const dup = { ...plan, workspaceRoot: join(tmp, 'ws-dup'), mounts: [...plan.mounts, plan.mounts[0]!] };
      await expect(materialize(dup, io())).rejects.toMatchObject({ code: 'invalid_plan' });
      expect(() => readFileSync(join(tmp, 'ws-dup'))).toThrow();
      await expect(materialize({ ...plan, workspaceRoot: 'rel/ws' }, io())).rejects.toMatchObject({ code: 'invalid_plan' });
    });

    it('flags extra files in .commonforge', async () => {
      writeFileSync(join(root, '.commonforge', 'evil.json'), '{}');
      expect(await codes()).toContain('unadmitted_context_entry:.commonforge/evil.json');
    });

    it('flags non-sample hooks', async () => {
      writeFileSync(join(root, 'site', '.git', 'hooks', 'post-commit'), '#!/bin/sh\n', { mode: 0o755 });
      expect(await codes()).toContain('git_hook_present:site/.git/hooks/post-commit');
    });

    it('flags core.hooksPath, core.fsmonitor and include.* in a mount config, without running fsmonitor', async () => {
      const marker = join(tmp, 'FSMON_RAN');
      git(join(root, 'site'), 'config', 'core.hooksPath', '/nonexistent');
      git(join(root, 'lib'), 'config', 'core.fsmonitor', `touch ${marker}; false`);
      git(join(root, 'lib'), 'config', 'includeIf.gitdir:/.path', '/dev/null');
      const c = await codes();
      expect(c).toContain('unsafe_git_config:site');
      expect(c.filter((x) => x === 'unsafe_git_config:lib')).toHaveLength(2);
      expect(() => readFileSync(marker)).toThrow();
    });

    it('judges a credential helper by its command, not by substrings of its path (I-1)', async () => {
      const site = join(root, 'site');
      const url = 'https://acct.artifacts.cloudflare.net/git/ns-tasks/ws-1.git';
      git(site, 'config', '--add', `credential.${url}.helper`, '');
      git(site, 'config', '--add', `credential.${url}.helper`, '/nix/store/abc-nodejs-22/bin/node /srv/app-store/cforge/dist/index.js credential-helper --task t-1');
      git(site, 'config', `credential.${url}.useHttpPath`, 'true');
      expect(await codes()).toEqual([]);
      git(site, 'config', '--add', `credential.${url}.helper`, '/usr/lib/git-core/git-credential-store --file=/tmp/x');
      expect(await codes()).toContain('unsafe_git_config:site');
    });

    it('detects tokens behind include.path and in a credential store file', async () => {
      const site = join(root, 'site');
      writeFileSync(join(site, '.git', 'extra.cfg'), `[http]\n\textraHeader = Authorization: Bearer art_v1_${'a'.repeat(40)}\n`);
      git(site, 'config', 'include.path', 'extra.cfg');
      let c = await codes();
      expect(c).toContain('secret_in_git_config:site');
      expect(c).toContain('unsafe_git_config:site');
      git(site, 'config', '--unset', 'include.path');
      writeFileSync(join(site, '.git', 'credentials'), `https://x:art_v1_${'b'.repeat(40)}@host\n`);
      git(site, 'config', 'credential.helper', 'store --file=.git/credentials');
      c = await codes();
      expect(c).toContain('secret_in_git_config:site');
      expect(c).toContain('unsafe_git_config:site');
    });
  });
});


describe('isPersistingCredentialHelper', () => {
  it.each([
    ['', false],
    ['/nix/store/abc-nodejs/bin/node /opt/cforge/dist/index.js credential-helper --task t', false],
    ['/opt/my\\ store/node cli.js credential-helper', false],
    ["/usr/bin/node '/home/u/store/cforge.js' credential-helper", false],
    ['cforge', false],
    ['store', true],
    ['store --file=.git/credentials', true],
    ['cache --timeout 300', true],
    ['/usr/lib/git-core/git-credential-store', true],
    ['git-credential-cache', true],
    ['osxkeychain', true],
    ['manager-core', true],
    ['!f() { echo password=x; }; f', true],
    ["'/opt/x/git-credential-store' --file y", true],
  ])('%j → %s', (value, unsafe) => {
    expect(isPersistingCredentialHelper(value)).toBe(unsafe);
  });
});
