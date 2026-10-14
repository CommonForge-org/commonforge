import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkEnvironment, createGit, parseAllowedCommand, pushWithLease, runIsolated, UnsupportedSchemaError, validateJsonSchema } from '../src/index.js';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'cf-runner-unit-'));
  dirs.push(d);
  return d;
};

describe('command allowlist', () => {
  it('accepts allowlisted shapes and refuses shells, metacharacters and traversal', () => {
    for (const ok of ['pnpm test', 'pnpm run typecheck', 'pnpm exec vitest run --reporter=dot', 'npm test', 'node scripts/sample.ts', 'pnpm install --frozen-lockfile', 'pnpm build']) {
      expect(parseAllowedCommand(ok), ok).toMatchObject({ ok: true });
    }
    for (const bad of [
      'bash -c id',
      'sh scripts/x.sh',
      'pnpm test; curl evil',
      'pnpm test && rm -rf /',
      'node $HOME/x.js',
      'node ../outside.js',
      'node /etc/passwd',
      'pnpm run `id`',
      "pnpm run 'a b'",
      'pnpm test | tee x',
      'curl https://example.com',
      'pnpm exec ../../bin/x',
      'node scripts/x.js --flag=../../etc',
      '',
    ]) {
      expect(parseAllowedCommand(bad), bad).toMatchObject({ ok: false });
    }
  });
});

describe('isolated execution', () => {
  it('gives the child only the minimal environment', async () => {
    const d = await tmp();
    process.env.CF_RUNNER_UNIT_SECRET = 'art_v2_x_should_never_reach_the_child_0000';
    try {
      const env = checkEnvironment({ path: process.env.PATH!, home: d, tmp: d }, { FOO: 'bar' });
      const r = await runIsolated({ argv: ['node', '-e', 'process.stdout.write(JSON.stringify(process.env))'], cwd: d, env, timeoutMs: 10_000 });
      const childEnv = JSON.parse(r.stdout) as Record<string, string>;
      expect(Object.keys(childEnv).sort()).toEqual(['CI', 'FOO', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'LANG', 'NO_COLOR', 'PATH', 'TMPDIR']);
      expect(r.stdout).not.toContain('should_never_reach');
    } finally {
      delete process.env.CF_RUNNER_UNIT_SECRET;
    }
  });

  it('kills the process group on timeout and caps output', async () => {
    const d = await tmp();
    const env = checkEnvironment({ path: process.env.PATH!, home: d, tmp: d });
    const t0 = Date.now();
    const r = await runIsolated({ argv: ['node', '-e', 'process.stdout.write("x".repeat(100000)); setInterval(()=>{}, 1000)'], cwd: d, env, timeoutMs: 500, maxOutputBytes: 1000 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
    expect(r.truncated).toBe(true);
  });
});

describe('JSON Schema subset', () => {
  it('validates the fixtures quote contract strictly', async () => {
    const schema = JSON.parse(await readFile(new URL('../../../fixtures/requirements/contracts/quote.schema.json', import.meta.url), 'utf8'));
    const quote = { quoteId: 'q-team-12-0a1b2c3d', customer: 'Acme', plan: 'team', seats: 12, currency: 'USD', unitPrice: 29, total: 348, validUntil: '2026-11-05', apiVersion: '1.0.0' };
    expect(validateJsonSchema(schema, quote)).toEqual([]);
    expect(validateJsonSchema(schema, { ...quote, breakdown: { gross: 1, discount: 0 } })).toEqual(['$.breakdown: is not declared in the contract']);
    expect(validateJsonSchema(schema, { ...quote, plan: 'gold', seats: 0 })).toHaveLength(2);
    expect(() => validateJsonSchema({ type: 'object', $ref: '#/x' }, {})).toThrow(UnsupportedSchemaError);
  });
});

describe('pushWithLease', () => {
  async function setup() {
    const d = await tmp();
    const git = createGit({ allowFile: true });
    const remote = join(d, 'remote.git');
    await git.ok(['init', '-q', '--bare', '-b', 'main', remote], d);
    const local = join(d, 'local');
    await mkdir(local);
    await git.ok(['init', '-q', '-b', 'main'], local);
    await writeFile(join(local, 'a.txt'), 'a\n');
    await git.ok(['add', '.'], local);
    await git.ok(['commit', '-q', '-m', 'a'], local, { env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const sha = (await git.ok(['rev-parse', 'HEAD'], local)).trim();
    return { d, git, remote, url: pathToFileURL(remote).href, local, sha };
  }

  it('retries receive-pack busy and succeeds', async () => {
    const s = await setup();
    const counter = join(s.d, 'count');
    await writeFile(join(s.remote, 'hooks', 'pre-receive'), `#!/bin/sh\nn=$(cat '${counter}' 2>/dev/null || echo 0)\necho $((n+1)) > '${counter}'\nif [ "$n" -lt 2 ]; then echo 'artifacts_git_receive_pack_busy' >&2; exit 1; fi\n`);
    await chmod(join(s.remote, 'hooks', 'pre-receive'), 0o755);
    const r = await pushWithLease({ git: s.git, dir: s.local, remote: s.url, sha: s.sha, ref: 'refs/commonforge/x/y', expected: null, baseDelayMs: 1 });
    expect(r).toEqual({ status: 'pushed' });
    expect((await readFile(counter, 'utf8')).trim()).toBe('3');
  });

  it('a lease failure where the ref already holds the sha is success; another sha is lease_failed; unmoved failure is failed', async () => {
    const s = await setup();
    await s.git.ok(['push', '-q', s.url, `${s.sha}:refs/heads/main`], s.local);
    // git itself reports "up to date" (exit 0) for an identical value; either way it is success
    expect((await pushWithLease({ git: s.git, dir: s.local, remote: s.url, sha: s.sha, ref: 'refs/heads/main', expected: null, baseDelayMs: 1 })).status).toMatch(/^(already|pushed)$/);
    const other = await s.git.ok(['commit-tree', '-m', 'o', `${s.sha}^{tree}`], s.local, { env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    const lease = await pushWithLease({ git: s.git, dir: s.local, remote: s.url, sha: other.trim(), ref: 'refs/heads/main', expected: null, baseDelayMs: 1 });
    expect(lease).toMatchObject({ status: 'lease_failed', observed: s.sha });
    await writeFile(join(s.remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho denied >&2\nexit 1\n');
    await chmod(join(s.remote, 'hooks', 'pre-receive'), 0o755);
    const failed = await pushWithLease({ git: s.git, dir: s.local, remote: s.url, sha: other.trim(), ref: 'refs/heads/main', expected: s.sha, baseDelayMs: 1 });
    expect(failed).toMatchObject({ status: 'failed', observed: s.sha });
  });
});

describe('git timeout (M-3)', () => {
  it('kills the whole git process group, helpers included', async () => {
    const d = await tmp();
    const pidFile = join(d, 'helper.pid');
    const fake = join(d, 'fake-git.sh');
    // stands in for git + a remote helper that would outlive a plain child kill
    await writeFile(fake, `#!/bin/sh\nsleep 300 &\necho $! > '${pidFile}'\nsleep 300\n`);
    await chmod(fake, 0o755);
    const git = createGit({ binary: fake, timeoutMs: 300 });
    const r = await git.run(['fetch'], d);
    expect(r.code).not.toBe(0);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
