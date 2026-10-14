import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256HexSync } from '@commonforge-org/core';
import { World, type CanonicalRepo } from './helpers.js';

const run = promisify(execFile);
let w: World;
let canary: Record<string, string>;
let canon: CanonicalRepo;

beforeAll(async () => {
  w = await World.create();
  const script = fileURLToPath(new URL('../../../fixtures/canary/scripts/make-canary-repo.sh', import.meta.url));
  const { stdout } = await run('bash', [script, w.dir('canary')], { env: { PATH: process.env.PATH! } });
  canary = Object.fromEntries(stdout.split('\n').filter((l) => l.startsWith('CANARY_')).map((l) => l.split(/=(.*)/s).slice(0, 2) as [string, string]));
  canon = await w.canonicalFrom('res-quote', canary.CANARY_REPO!);
  expect(canon.sha).toBe(canary.CANARY_HEAD);
}, 60_000);
afterAll(() => w?.close());

/** Every object an edition repo serves, as text (contents + listing). */
async function everything(remoteUrl: string): Promise<{ text: string; commits: number; objects: number }> {
  const clone = w.dir('client-clone');
  await w.git.ok(['clone', '-q', '--bare', '--mirror', remoteUrl, clone], w.root);
  const log = await w.git.ok(['log', '-p', '--all', '--format=%H %an %s'], clone);
  const objs = await w.git.ok(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'], clone);
  const ids = objs.split('\n').filter(Boolean).map((l) => l.split(' ')[0]!);
  const contents = (await w.git.runBytes(['cat-file', '--batch'], clone, { input: `${ids.join('\n')}\n` })).stdout;
  const trees = await w.git.ok(['ls-tree', '-r', '--name-only', 'refs/heads/main'], clone);
  return { text: `${log}\n${Buffer.from(contents).toString('latin1')}\n${trees}`, commits: objs.split('\n').filter((l) => l.endsWith(' commit')).length, objects: ids.length };
}

const job = (editionRepo: Awaited<ReturnType<World['bareRepo']>>, include = ['**'], exclude?: string[]) => ({
  kind: 'build-edition' as const,
  editionId: 'ed-quote',
  sources: [{ resourceId: 'res-quote', canonical: canon.coords, sha: canon.sha, canonicalPathPrefix: '', editionPathPrefix: 'quote', include }],
  ...(exclude ? { exclude } : {}),
  editionRepo,
});

describe('build-edition (AT-26)', () => {
  it('builds a single fresh commit from the allowlist; the canary secret, hidden module and old history are absent', async () => {
    const edition = await w.bareRepo('editions', 'ed-quote');
    // a decoy .env on HEAD too: excluded by the default **/.env* rule
    const d = await w.delivery(job(edition));
    const r = await w.runner({ canaries: [canary.CANARY_SECRET_VALUE!, canary.CANARY_HIDDEN_MARKER!] }).execute(d);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const receipt = r.receipt as { sha: string; inventory: Array<{ editionPath: string; sha256: string; size: number }> };
    expect(receipt.inventory.map((i) => i.editionPath)).toEqual(['quote/.gitignore', 'quote/README.md', 'quote/src/quote.ts']);
    expect(await w.remoteRefs(edition)).toEqual({ 'refs/heads/main': receipt.sha });

    const served = await everything(edition.remoteUrl);
    expect(served.commits).toBe(1);
    for (const needle of [canary.CANARY_SECRET_VALUE!, canary.CANARY_HIDDEN_MARKER!, 'hidden-module', canary.CANARY_SECRET_COMMIT!, 'Demo Client Dev', 'DATABASE_URL']) {
      expect(served.text, needle).not.toContain(needle);
    }
    // the old secret-bearing commit cannot be fetched from the edition
    const probe = w.dir('probe');
    await w.git.ok(['init', '-q', '--bare', probe], w.root);
    expect((await w.git.run(['fetch', '-q', edition.remoteUrl, canary.CANARY_SECRET_COMMIT!], probe)).code).not.toBe(0);
    // inventory hashes match the served bytes
    const readme = await w.git.ok(['--git-dir', decodeURIComponent(new URL(edition.remoteUrl).pathname), 'show', `${receipt.sha}:quote/README.md`], w.root);
    expect(receipt.inventory[1]!.sha256).toBe(sha256HexSync(readme));
    w.assertTokensHygiene(JSON.stringify(r));
    // canonical was only read; the edition repo written
    expect(w.worker.issued.filter((t) => t.jobId === d.signedJob.jobId).map((t) => `${t.repo}:${t.access}`).sort()).toEqual(['ed-quote:write', 'res-quote:read']);
  });

  it('applies include/exclude globs and strips .env files; a rebuild replaces the previous edition', async () => {
    const edition = await w.bareRepo('editions', 'ed-quote2');
    const withEnv = await w.canonical('res-env', { 'src/a.ts': 'a\n', 'src/.env.local': 'SECRET=1\n', 'src/b.test.ts': 'b\n', 'docs/x.md': 'x\n' });
    const mk = (include: string[], exclude?: string[]) => ({
      kind: 'build-edition' as const,
      editionId: 'ed-env',
      sources: [{ resourceId: 'res-env', canonical: withEnv.coords, sha: withEnv.sha, canonicalPathPrefix: 'src', editionPathPrefix: '', include }],
      ...(exclude ? { exclude } : {}),
      editionRepo: edition,
    });
    const r1 = await w.runner().execute(await w.delivery(mk(['src/**'])));
    expect(r1.ok && (r1.receipt as { inventory: Array<{ editionPath: string }> }).inventory.map((i) => i.editionPath)).toEqual(['a.ts', 'b.test.ts']);
    const r2 = await w.runner().execute(await w.delivery(mk(['src/**'], ['**/.env*', '**/*.test.ts'])));
    expect(r2.ok && (r2.receipt as { inventory: Array<{ editionPath: string }> }).inventory.map((i) => i.editionPath)).toEqual(['a.ts']);
    expect(await w.remoteSha(edition, 'refs/heads/main')).toBe(r2.ok ? (r2.receipt as { sha: string }).sha : null);
  });

  it('refuses to publish when a configured canary string is in a selected file', async () => {
    const edition = await w.bareRepo('editions', 'ed-quote3');
    const r = await w.runner({ canaries: ['per-seat list prices'] }).execute(await w.delivery(job(edition)));
    expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
    expect(await w.remoteRefs(edition)).toEqual({});
  });
});
