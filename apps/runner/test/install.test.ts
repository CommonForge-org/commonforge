/**
 * Follow-up to Task 22: integrate checks run with no network in the Sandbox, so the runner installs
 * each mount's dependencies itself (install.ts) before the checks. Proven here with the real
 * fixtures (fixtures/README.md): the website's contract test imports the api source, which
 * resolves `hono` from `api/node_modules`, so it passes only when the api sibling is installed too.
 *
 * Needs the npm registry (or a warm pnpm store) like the monorepo install itself. The shared store
 * below only speeds up repeated runs.
 */
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  candidateRetentionRef,
  computeSnapshotIdSync,
  sha256HexSync,
  type ContractSpec,
  type FrozenCandidate,
  type SnapshotEntry,
} from '@commonforge-org/core';
import { jobIntegrationRef, verifyEvidence, type IntegrationJobInput } from '@commonforge-org/runner-protocol';
import { installArgv, registryNerfDart } from '../src/install.js';
import { KEY, World, type CanonicalRepo } from './helpers.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const STORE = join(tmpdir(), 'commonforge-runner-test-pnpm-store');
const CONTRACT_CHECK = 'pnpm exec vitest run tests/quote-contract.test.ts';

/** The tracked files of a fixture, as the canonical repo would hold them. */
async function fixtureFiles(name: string): Promise<Record<string, Uint8Array>> {
  const list = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard', `fixtures/${name}`], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
  const files: Record<string, Uint8Array> = {};
  for (const p of list) files[p.slice(`fixtures/${name}/`.length)] = new Uint8Array(await readFile(join(REPO, p)));
  return files;
}

let w: World;
let api: CanonicalRepo;
let website: CanonicalRepo;
let reqs: CanonicalRepo;
let breakdown: FrozenCandidate;
let schemaFix: FrozenCandidate;
let seq = 0;

const quoteContract: ContractSpec = {
  contractId: 'quote',
  version: '1',
  producerResource: 'res-api' as never,
  consumerResource: 'res-website' as never,
  schema: { resourceId: 'res-requirements' as never, path: 'contracts/quote.schema.json' },
  // the documented demo policy (apps/demo-agents/README.md)
  producerOutput: { mountName: 'api', command: 'node scripts/quote-sample.ts' },
};

async function prepare(c: CanonicalRepo, candidate: FrozenCandidate): Promise<void> {
  const r = await w.runner().execute(await w.delivery({ kind: 'prepare-candidate', candidate, canonical: c.coords, retentionRef: candidateRetentionRef(candidate.candidateId) }));
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

/** integrate `candidates` into `targets`; every other fixture mount is a pinned reference. */
function job(targets: CanonicalRepo[], candidates: FrozenCandidate[], opts: { contracts?: boolean; checks?: Array<{ checkId: string; mountName: string; command: string }> } = {}) {
  const jobId = `job-inst-${++seq}`;
  const proposalId = `prop-inst-${seq}`;
  const mount = (c: CanonicalRepo) => (c === api ? 'api' : c === website ? 'website' : 'requirements');
  const refs = [api, website, reqs].filter((c) => !targets.includes(c));
  const entries: SnapshotEntry[] = [
    ...targets.map((t) => ({ resourceId: t.resource.resourceId, revisionId: t.revision, mode: 'must-match-accepted' as const, mountName: mount(t), operations: ['read' as const, 'write' as const] })),
    ...refs.map((r) => ({ resourceId: r.resource.resourceId, revisionId: r.revision, mode: 'pinned-reference' as const, mountName: mount(r), operations: ['read' as const] })),
  ];
  const snap = { projectId: 'proj-1', organizationId: 'org1', membershipRevision: 1, policyRevision: 1, entries };
  return {
    jobId,
    job: {
      kind: 'integrate',
      proposalId,
      proposalHash: sha256HexSync(`proposal:${proposalId}`),
      baseSnapshot: { ...snap, snapshotId: computeSnapshotIdSync(snap), createdAt: new Date().toISOString() },
      candidateSnapshotId: sha256HexSync(`candidate-snapshot:${proposalId}`),
      candidates,
      targets: targets.map((t) => ({ resourceId: t.resource.resourceId, canonical: t.coords, expectedHead: t.revision })),
      references: refs.map((r) => ({ resourceId: r.resource.resourceId, coords: r.coords })),
      integrationRef: jobIntegrationRef(proposalId, jobId),
      checks: (opts.checks ?? [{ checkId: 'quote-contract', mountName: 'website', command: CONTRACT_CHECK }]).map((c) => ({ timeoutSeconds: 300, required: true, ...c })),
      contracts: opts.contracts === false ? [] : [quoteContract],
    } as IntegrationJobInput,
  };
}

beforeAll(async () => {
  w = await World.create();
  api = await w.canonical('res-api', await fixtureFiles('api'));
  website = await w.canonical('res-website', await fixtureFiles('website'));
  reqs = await w.canonical('res-requirements', await fixtureFiles('requirements'));
  // plan §C.1 row 7: the api adds `breakdown` (fixtures/scripts/check-standalone.sh does the same edit)
  const pricing = await readFile(join(REPO, 'fixtures/api/src/pricing.ts'), 'utf8');
  breakdown = (await w.candidate(api, { 'src/pricing.ts': pricing.replace('    apiVersion,\n', '    apiVersion,\n    breakdown: { gross, discount: roundCents(gross - total) },\n') }, 'inst-breakdown')).candidate;
  const schema = JSON.parse(await readFile(join(REPO, 'fixtures/requirements/contracts/quote.schema.json'), 'utf8'));
  schema.properties.breakdown = { type: 'object', additionalProperties: false, required: ['gross', 'discount'], properties: { gross: { type: 'number' }, discount: { type: 'number' } } };
  schemaFix = (await w.candidate(reqs, { 'contracts/quote.schema.json': JSON.stringify(schema, null, 2) }, 'inst-schema')).candidate;
  await prepare(api, breakdown);
  await prepare(reqs, schemaFix);
}, 120_000);
afterAll(() => w?.close());

describe('integrate: runner-controlled dependency install (fixtures contract check)', { timeout: 300_000 }, () => {
  const runner = () => w.runner({ commands: { unsafeSameUid: true, install: { storeDir: STORE } } });

  it('the website contract test needs the api sibling installed: an uninstalled api cannot even be loaded', async () => {
    // an api that declares no dependencies is not installed, so `hono` is missing for app.ts
    const pkg = JSON.parse(new TextDecoder().decode((await fixtureFiles('api'))['package.json']!));
    delete pkg.dependencies;
    delete pkg.devDependencies;
    // (the fixture's pnpm-workspace.yaml would make the mount a workspace, which is always installed)
    const bare = (await w.candidate(api, { 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'pnpm-workspace.yaml': null }, 'inst-bare')).candidate;
    await prepare(api, bare);
    const { job: j, jobId } = job([api], [bare], { contracts: false });
    const r = await runner().execute(await w.delivery(j, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'check_failed' });
    if (r.ok) return;
    expect(r.detail).toContain('check quote-contract');
    expect(r.detail).toMatch(/hono/);
  });

  it('attempt 1 fails the fixture contract test: the api adds `breakdown`, the schema does not declare it', async () => {
    const { job: j, jobId } = job([api], [breakdown], { contracts: false });
    const r = await runner().execute(await w.delivery(j, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'check_failed' });
    if (r.ok) return;
    // the website's own contract test ran (both siblings installed) and failed on the contract itself
    expect(r.detail).toContain('check quote-contract');
    expect(r.detail).toContain('is not declared in the contract');
    expect(r.detail).not.toMatch(/ERR_PNPM|Cannot find (package|module)/);
  });

  it('attempt 1 with the documented demo policy (check + runner contract): contract_failed, both recorded', async () => {
    const { job: j, jobId } = job([api], [breakdown]);
    const r = await runner().execute(await w.delivery(j, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'contract_failed' });
    if (r.ok) return;
    expect(r.detail).toContain('$.breakdown: is not declared in the contract');
    const ev = await verifyEvidence(r.evidence, [KEY], { jobId });
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    expect(ev.evidence.checks).toMatchObject([{ checkId: 'quote-contract', result: 'fail', required: true }]);
    expect(ev.evidence.contractChecks).toMatchObject([{ contractId: 'quote', result: 'fail' }]);
    expect(Object.keys(await w.remoteRefs(api.coords)).some((k) => k.includes(jobId))).toBe(false);
  });

  it('attempt 2 passes once the requirements candidate declares `breakdown`', async () => {
    const { job: j, jobId } = job([api, reqs], [breakdown, schemaFix]);
    const r = await runner().execute(await w.delivery(j, { jobId }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const ev = await verifyEvidence((r.receipt as { evidence: unknown }).evidence, [KEY], { jobId });
    expect(ev.ok && ev.evidence.checks).toMatchObject([{ checkId: 'quote-contract', result: 'pass', command: CONTRACT_CHECK }]);
    expect(ev.ok && ev.evidence.contractChecks).toMatchObject([{ contractId: 'quote', result: 'pass' }]);
    // what was pushed is the merge, never the installed checkout
    const sha = (r.receipt as { results: Array<{ resourceId: string; sha: string }> }).results.find((x) => x.resourceId === 'res-api')!.sha;
    const tree = await w.git.ok(['--git-dir', decodeURIComponent(new URL(api.coords.remoteUrl).pathname), 'ls-tree', '-r', '--name-only', sha], w.root);
    expect(tree).not.toContain('node_modules');
  });

  it('a mount that declares dependencies without a committed lockfile fails before any check runs', async () => {
    const noLock = (await w.candidate(website, { 'pnpm-lock.yaml': null, 'scripts/ran.mjs': "console.log('ran')\n" }, 'inst-nolock')).candidate;
    await prepare(website, noLock);
    const { job: j, jobId } = job([website], [noLock], { contracts: false, checks: [{ checkId: 'ran', mountName: 'website', command: 'node scripts/ran.mjs' }] });
    const r = await runner().execute(await w.delivery(j, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'check_failed' });
    if (r.ok) return;
    expect(r.detail).toMatch(/mount website (declares dependencies|is a pnpm workspace) but has no committed pnpm-lock.yaml/);
    const ev = await verifyEvidence(r.evidence, [KEY], { jobId });
    expect(ev.ok && ev.evidence.checks).toEqual([]); // no check ran
  });

  it('runs no candidate code during the install: no lifecycle scripts, no pnpmfile, no packageManager switch', async () => {
    const pkg = JSON.parse(new TextDecoder().decode((await fixtureFiles('api'))['package.json']!));
    pkg.scripts = { ...pkg.scripts, preinstall: 'node marker.mjs pre', postinstall: 'node marker.mjs post', prepare: 'node marker.mjs prepare' };
    pkg.packageManager = 'pnpm@9.15.0';
    const marker = "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran-' + process.argv[2], 'x');\n";
    const hostile = (
      await w.candidate(
        api,
        {
          'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
          'marker.mjs': marker,
          '.pnpmfile.cjs': "require('node:fs').writeFileSync('ran-pnpmfile', 'x'); module.exports = { hooks: {} };\n",
          '.pnpmfile.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync('ran-pnpmfile-mjs', 'x');\nexport const hooks = {};\n",
          'scripts/no-markers.mjs': "import { readdirSync } from 'node:fs';\nconst ran = readdirSync('.').filter((f) => f.startsWith('ran-'));\nif (ran.length) { console.error('ran: ' + ran.join(',')); process.exit(1); }\nconsole.log(readdirSync('node_modules').includes('hono') ? 'installed' : 'missing');\n",
        },
        'inst-hostile',
      )
    ).candidate;
    await prepare(api, hostile);
    const { job: j, jobId } = job([api], [hostile], { contracts: false, checks: [{ checkId: 'markers', mountName: 'api', command: 'node scripts/no-markers.mjs' }] });
    const r = await runner().execute(await w.delivery(j, { jobId }));
    // scripts and packageManager are not part of the lockfile, so it is still frozen-valid; nothing of them ran
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('CLI: --npm-key-file must hold a per-job hex key (the Sandbox writes it root-only)', async () => {
    const { writeFile } = await import('node:fs/promises');
    const { main } = await import('../src/main.js');
    const bad = join(w.root, 'npm-key-bad');
    const good = join(w.root, 'npm-key-good');
    await writeFile(bad, 'not a key');
    await writeFile(good, 'ab'.repeat(32));
    let err = '';
    const io = { stdin: async () => '{}', stdout: () => undefined, stderr: (t: string) => void (err += t), env: {} };
    const args = ['run', '-', '--no-post', '--credentials', 'egress', '--blobs', w.dir('npm-blobs'), '--work-dir', w.dir('npm-work')];
    expect(await main([...args, '--npm-key-file', bad], io)).toBe(2);
    expect(err).toContain('malformed npm key file');
    expect(await main([...args, '--npm-key-file', good], io)).toBe(1); // accepted; the empty job itself fails
  });

  it('builds the exact install argv (policy on the command line) and the npmrc auth key for the registry', () => {
    expect(installArgv({ minimumReleaseAge: 1440, minimumReleaseAgeExclude: ['@cloudflare/workers-types@5.20261006.1', 'hono@4.13.13'] })).toEqual([
      'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--config.pm-on-fail=ignore', '--no-runtime', '--no-trust-lockfile',
      '--config.minimum-release-age=1440',
      '--config.minimum-release-age-exclude=@cloudflare/workers-types@5.20261006.1',
      '--config.minimum-release-age-exclude=hono@4.13.13',
    ]);
    // an empty list still names one entry, or pnpm would apply the candidate's own excludes
    expect(installArgv({ minimumReleaseAge: 0, minimumReleaseAgeExclude: [] }).at(-1)).toBe('--config.minimum-release-age-exclude=@commonforge-org/no-release-age-exclusions@0.0.0');
    expect(() => installArgv({ minimumReleaseAge: 1, minimumReleaseAgeExclude: ['a b@1'] })).toThrow(/invalid/);
    expect(registryNerfDart('http://registry.npmjs.org/')).toBe('//registry.npmjs.org/');
    expect(registryNerfDart('http://127.0.0.1:4873')).toBe('//127.0.0.1:4873/');
  });

  it('m-1: the candidate cannot relax the runner policy (pnpm-workspace.yaml minimumReleaseAge 0, trustLockfile, excludes)', async () => {
    const relax = (await w.candidate(api, { 'pnpm-workspace.yaml': "minimumReleaseAge: 0\ntrustLockfile: true\nminimumReleaseAgeExclude:\n  - '@cloudflare/workers-types@5.20261006.1'\n" }, 'inst-relax')).candidate;
    await prepare(api, relax);
    const { job: j, jobId } = job([api], [relax], { contracts: false, checks: [{ checkId: 'ran', mountName: 'api', command: 'node scripts/quote-sample.ts' }] });
    // the runner's policy: every package must be ~190 years old, and nothing is exempt
    const strict = w.runner({ commands: { unsafeSameUid: true, install: { storeDir: STORE, policy: { minimumReleaseAge: 100_000_000, minimumReleaseAgeExclude: [] } } } });
    const r = await strict.execute(await w.delivery(j, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'check_failed' });
    if (r.ok) return;
    expect(r.detail).toContain('dependency install for mount api');
    expect(r.detail).toContain('within the minimumReleaseAge cutoff');
  });

  it('m-3: a mount that is a pnpm workspace is installed even when its root package.json declares nothing', async () => {
    // a workspace whose package depends on hono (from the warm store); lockfile generated here
    const gen = join(w.root, 'ws-gen');
    const files: Record<string, string> = {
      'package.json': '{ "name": "ws-root", "private": true }\n',
      'pnpm-workspace.yaml': 'packages:\n  - pkg\n',
      'pkg/package.json': '{ "name": "ws-pkg", "private": true, "type": "module", "dependencies": { "hono": "4.13.13" } }\n',
      'pkg/check.mjs': "await import('hono');\nconsole.log('hono loads');\n",
    };
    const { mkdir: mk, writeFile: wf } = await import('node:fs/promises');
    for (const [p, c] of Object.entries(files)) {
      await mk(join(gen, ...p.split('/').slice(0, -1)), { recursive: true });
      await wf(join(gen, p), c);
    }
    execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--prefer-offline'], { cwd: gen, env: { ...process.env, PNPM_CONFIG_STORE_DIR: STORE }, stdio: 'ignore' });
    files['pnpm-lock.yaml'] = await readFile(join(gen, 'pnpm-lock.yaml'), 'utf8');
    const repo = await w.canonical('res-ws', { 'seed.txt': 'x\n' });
    const add = (await w.candidate(repo, files, 'inst-ws')).candidate;
    await prepare(repo, add);
    const jobId = `job-inst-ws-${++seq}`;
    const entries: SnapshotEntry[] = [{ resourceId: repo.resource.resourceId, revisionId: repo.revision, mode: 'must-match-accepted', mountName: 'tools', operations: ['read', 'write'] }];
    const snap = { projectId: 'proj-1', organizationId: 'org1', membershipRevision: 1, policyRevision: 1, entries };
    const j = {
      kind: 'integrate', proposalId: `prop-${jobId}`, proposalHash: sha256HexSync(jobId),
      baseSnapshot: { ...snap, snapshotId: computeSnapshotIdSync(snap), createdAt: new Date().toISOString() },
      candidateSnapshotId: sha256HexSync(`cs:${jobId}`), candidates: [add],
      targets: [{ resourceId: repo.resource.resourceId, canonical: repo.coords, expectedHead: repo.revision }],
      integrationRef: jobIntegrationRef(`prop-${jobId}`, jobId),
      checks: [{ checkId: 'ws', mountName: 'tools', command: 'node pkg/check.mjs', timeoutSeconds: 120, required: true }], contracts: [],
    } as IntegrationJobInput;
    const r = await runner().execute(await w.delivery(j, { jobId }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

/**
 * As root (the Sandbox shape): the install runs as the check uid with network; the checks then run
 * as the check uid in a network namespace without routes (`--check-network none`). Run with
 * `sudo` to exercise it; skipped otherwise.
 */
describe.skipIf(process.getuid?.() !== 0)('as root: install as the check uid, checks offline', { timeout: 300_000 }, () => {
  it('the contract check passes offline after the install; a network probe in a check fails', async () => {
    // node and pnpm the check uid can execute (the caller's toolchain may sit in a private home)
    const bin = await mkdtemp(join(tmpdir(), 'cf-check-bin-'));
    await chmod(bin, 0o755);
    const pnpmPath = execFileSync('sh', ['-c', 'readlink -f "$(command -v pnpm)"'], { encoding: 'utf8' }).trim();
    await copyFile(process.execPath, join(bin, 'node'));
    await copyFile(pnpmPath, join(bin, 'pnpm'));
    await chmod(join(bin, 'node'), 0o755);
    await chmod(join(bin, 'pnpm'), 0o755);
    const checks = await mkdtemp(join(tmpdir(), 'cf-checks-root-'));
    await chmod(checks, 0o711);
    const probe = (await w.candidate(website, { 'scripts/net-probe.mjs': "try { await fetch('https://registry.npmjs.org/', { signal: AbortSignal.timeout(5000) }); console.error('network reachable'); process.exit(1); } catch (e) { console.log('offline: ' + (e.cause?.code ?? e.message)); }\n" }, 'inst-probe')).candidate;
    await prepare(website, probe);
    const { job: j, jobId } = job([api, reqs, website], [breakdown, schemaFix, probe], {
      checks: [
        { checkId: 'quote-contract', mountName: 'website', command: CONTRACT_CHECK },
        { checkId: 'offline', mountName: 'website', command: 'node scripts/net-probe.mjs' },
      ],
    });
    const r = await w
      .runner({ checksDir: checks, commands: { uid: 65534, gid: 65534, network: 'none', path: `${bin}:/usr/bin:/bin` } })
      .execute(await w.delivery(j, { jobId }));
    await rm(bin, { recursive: true, force: true });
    await rm(checks, { recursive: true, force: true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const ev = await verifyEvidence((r.receipt as { evidence: unknown }).evidence, [KEY], { jobId });
    expect(ev.ok && ev.evidence.checks.map((c) => [c.checkId, c.result])).toEqual([
      ['quote-contract', 'pass'],
      ['offline', 'pass'],
    ]);
  });
});

