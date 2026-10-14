/**
 * Task 22: release-build (immutable outputs + digests) and release-deploy (pinned wrangler, stored
 * outputs only, credential only in the wrangler process, digests rechecked before any upload).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { releaseOutputDigest, releaseTargetDigest, type ReleaseBuildReceipt } from '@commonforge-org/runner-protocol';
import { World, type CanonicalRepo } from './helpers.js';
import { isTransientApiFailure } from '../src/jobs/release-deploy.js';

let w: World;
let site: CanonicalRepo;
let api: CanonicalRepo;
let fakeWrangler: string;
let logDir: string;

const DEPLOY_TOKEN = 'cfat_test_deploy_token_0123456789abcdef';

beforeAll(async () => {
  w = await World.create();
  site = await w.canonical('res-website', {
    'wrangler.jsonc': '{\n  // site\n  "name": "from-source-ignored",\n  "compatibility_date": "2026-08-22",\n  "assets": { "directory": "./dist", "not_found_handling": "single-page-application" },\n  "build": { "command": "curl evil" },\n}\n',
    'scripts/build.mjs': "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\nwriteFileSync('dist/index.html', `<p>${process.env.VITE_QUOTE_API_URL}</p>\\n`);\nwriteFileSync('wrangler.jsonc', '{\"compatibility_date\":\"2020-01-01\",\"vars\":{\"EVIL\":\"1\"}}');\n",
  });
  api = await w.canonical('res-api', {
    'wrangler.jsonc': '{ "name": "x", "main": "src/index.ts", "compatibility_date": "2026-08-22", "vars": { "APP_VERSION": "1.1.0" } }\n',
    'scripts/bundle.mjs': "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\nwriteFileSync('dist/index.js', 'export default { fetch() { return new Response(\"v\"); } };\\n');\n",
  });
  logDir = w.dir('wrangler-log');
  await mkdir(logDir, { recursive: true });
  fakeWrangler = join(logDir, 'fake-wrangler.mjs');
  // records argv, the generated config and whether it saw the token; fails on demand
  await writeFile(
    fakeWrangler,
    `import { readFileSync, writeFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
const log = process.env.FAKE_WRANGLER_LOG + '/' + cfg.name + '.json';
writeFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cfg, token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID }));
if (process.env.FAKE_WRANGLER_504 === cfg.name) {
  const n = process.env.FAKE_WRANGLER_LOG + '/' + cfg.name + '.504';
  let seen = 0; try { seen = Number(readFileSync(n, 'utf8')); } catch {}
  writeFileSync(n, String(seen + 1));
  if (seen < Number(process.env.FAKE_WRANGLER_504_TIMES ?? '1')) { console.error('X [ERROR] Received a malformed response from the API\\n\\n  GET /accounts/x/workers/services/' + cfg.name + ' -> 504 Gateway Timeout'); process.exit(1); }
}
if (process.env.FAKE_WRANGLER_FAIL === cfg.name) { console.error('Authentication error [code: 10000] token ' + process.env.CLOUDFLARE_API_TOKEN); process.exit(1); }
console.log('Uploaded ' + cfg.name + '\\nDeployed ' + cfg.name + ' triggers\\n  https://' + cfg.name + '.demo.workers.dev\\nCurrent Version ID: 0f1e2d3c-1111-2222-3333-444455556666');
`,
  );
});
afterAll(() => w?.close());

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const releaseId = 'rel-test-1';
const prefix = `org/o-1/releases/${releaseId}/`;

function buildJob() {
  return {
    kind: 'release-build' as const,
    releaseId,
    acceptedVersionId: 'av-7',
    sources: [
      { resourceId: 'res-website', mountName: 'website', canonical: site.coords, sha: site.sha },
      { resourceId: 'res-api', mountName: 'api', canonical: api.coords, sha: api.sha },
    ],
    recipe: {
      recipeId: 'release',
      revision: 3,
      steps: [
        { stepId: 'api', mountName: 'api', command: 'node scripts/bundle.mjs' },
        { stepId: 'site', mountName: 'website', command: 'node scripts/build.mjs', env: { VITE_QUOTE_API_URL: 'https://cfapp-o-1-api.demo.workers.dev' } },
      ],
    },
    targets: [
      { targetId: 'api', kind: 'worker' as const, mountName: 'api', outputPath: 'dist', main: 'index.js', workerName: 'cfapp-o-1-api' },
      { targetId: 'website', kind: 'assets' as const, mountName: 'website', outputPath: 'dist', workerName: 'cfapp-o-1-website' },
    ],
    environment: { api: { vars: { APP_VERSION: '1.1.0-prod' }, kvNamespaces: [{ binding: 'ORDERS', id: 'ffffffffffffffffffffffffffffffff' }] } },
    outputPrefix: prefix,
  };
}

let built: ReleaseBuildReceipt;

describe('release-build', () => {
  it('stores immutable outputs and binds them into target and output digests', async () => {
    const r = await w.runner().execute(await w.delivery(buildJob()));
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    built = r.receipt as ReleaseBuildReceipt;
    const apiT = built.targets.find((t) => t.targetId === 'api')!;
    const siteT = built.targets.find((t) => t.targetId === 'website')!;
    // source config read BEFORE the build ran (the build rewrote wrangler.jsonc); build.command ignored
    expect(siteT.config).toEqual({ compatibilityDate: '2026-08-22', compatibilityFlags: [], vars: { COMMONFORGE_RELEASE_ID: releaseId }, notFoundHandling: 'single-page-application', kvNamespaces: [] });
    // server-owned environment wins over source vars and supplies production bindings
    expect(apiT.config.vars).toEqual({ APP_VERSION: '1.1.0-prod', COMMONFORGE_RELEASE_ID: releaseId });
    expect(apiT.config.kvNamespaces).toEqual([{ binding: 'ORDERS', id: 'ffffffffffffffffffffffffffffffff' }]);
    expect(apiT.digest).toBe(releaseTargetDigest(apiT.files, apiT.config));
    expect(built.outputDigest).toBe(releaseOutputDigest(built.targets));
    expect(await readFile(w.blobPath(`${prefix}website/index.html`), 'utf8')).toBe('<p>https://cfapp-o-1-api.demo.workers.dev</p>\n');
    expect(await readFile(w.blobPath(`${prefix}api/index.js`), 'utf8')).toContain('export default');
  });

  it('AT-33: a different recipe environment is a different output identity', async () => {
    const j = buildJob();
    j.releaseId = 'rel-test-2';
    j.outputPrefix = 'org/o-1/releases/rel-test-2/';
    j.environment.api.vars.APP_VERSION = '1.2.0-prod';
    const r = await w.runner().execute(await w.delivery(j));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.receipt as ReleaseBuildReceipt).outputDigest).not.toBe(built.outputDigest);
  });
});

function deployJob(receipt: ReleaseBuildReceipt) {
  const targets = buildJob().targets;
  return {
    kind: 'release-deploy' as const,
    releaseId,
    outputDigest: receipt.outputDigest,
    outputPrefix: prefix,
    accountId: ACCOUNT,
    targets: receipt.targets.map((t) => {
      const spec = targets.find((x) => x.targetId === t.targetId)!;
      return { targetId: t.targetId, kind: spec.kind, workerName: spec.workerName, ...(spec.main ? { main: spec.main } : {}), digest: t.digest, files: t.files, config: t.config };
    }),
  };
}

const deployRunner = (env: Record<string, string> = {}) =>
  w.runner({
    deploy: {
      wrangler: [process.execPath, fakeWrangler],
      credentialEnv: async () => ({ CLOUDFLARE_API_TOKEN: DEPLOY_TOKEN }),
      env: { FAKE_WRANGLER_LOG: logDir, ...env },
      retryDelaysMs: [1, 1],
    },
  });

describe('release-deploy', () => {
  it('deploys the stored outputs with a data-only config and the token only in wrangler', async () => {
    const r = await deployRunner().execute(await w.delivery(deployJob(built)));
    expect(r).toMatchObject({ ok: true, receipt: { releaseId, outputDigest: built.outputDigest } });
    if (!r.ok) return;
    expect(r.receipt).toMatchObject({
      deployments: [
        { targetId: 'api', workerName: 'cfapp-o-1-api', versionId: '0f1e2d3c-1111-2222-3333-444455556666', url: 'https://cfapp-o-1-api.demo.workers.dev' },
        { targetId: 'website', workerName: 'cfapp-o-1-website' },
      ],
    });
    const apiLog = JSON.parse(await readFile(join(logDir, 'cfapp-o-1-api.json'), 'utf8'));
    expect(apiLog.token).toBe(DEPLOY_TOKEN);
    expect(apiLog.account).toBe(ACCOUNT);
    expect(apiLog.cfg).toMatchObject({ name: 'cfapp-o-1-api', no_bundle: true, main: 'out/index.js', vars: { APP_VERSION: '1.1.0-prod', COMMONFORGE_RELEASE_ID: releaseId }, kv_namespaces: [{ binding: 'ORDERS', id: 'ffffffffffffffffffffffffffffffff' }] });
    expect(apiLog.cfg.build).toBeUndefined();
    const siteLog = JSON.parse(await readFile(join(logDir, 'cfapp-o-1-website.json'), 'utf8'));
    expect(siteLog.cfg).toMatchObject({ assets: { directory: 'out', not_found_handling: 'single-page-application' } });
    expect(JSON.stringify(r)).not.toContain(DEPLOY_TOKEN);
  });

  it('refuses outputs that differ from what was built and approved (AT-33/AT-34)', async () => {
    const tampered = deployJob(built);
    tampered.targets[0] = { ...tampered.targets[0]!, files: tampered.targets[0]!.files.map((f) => ({ ...f, sha256: 'a'.repeat(64) })) };
    const r = await deployRunner().execute(await w.delivery(tampered));
    expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
    // a stored object swapped after the build is caught too
    await writeFile(w.blobPath(`${prefix}website/index.html`), '<p>swapped</p>\n');
    const r2 = await deployRunner().execute(await w.delivery(deployJob(built)));
    expect(r2).toMatchObject({ ok: false, code: 'scope_violation' });
    await writeFile(w.blobPath(`${prefix}website/index.html`), '<p>https://cfapp-o-1-api.demo.workers.dev</p>\n');
  });

  it('a failing deploy reports partial progress and never leaks the token', async () => {
    const r = await deployRunner({ FAKE_WRANGLER_FAIL: 'cfapp-o-1-website' }).execute(await w.delivery(deployJob(built)));
    expect(r).toMatchObject({ ok: false, code: 'provider_unavailable' });
    if (r.ok) return;
    expect(r.detail.startsWith('partial: api\n')).toBe(true);
    expect(r.detail).not.toContain(DEPLOY_TOKEN);
  });

  it('a deploy the Cloudflare API answered with a 5xx is run again (at most twice); other failures are not', async () => {
    const counter = join(logDir, 'cfapp-o-1-website.504');
    await rm(counter, { force: true });
    const r = await deployRunner({ FAKE_WRANGLER_504: 'cfapp-o-1-website', FAKE_WRANGLER_504_TIMES: '2' }).execute(await w.delivery(deployJob(built)));
    expect(r).toMatchObject({ ok: true });
    expect(await readFile(counter, 'utf8')).toBe('3');
    await rm(counter, { force: true });
    const r2 = await deployRunner({ FAKE_WRANGLER_504: 'cfapp-o-1-website', FAKE_WRANGLER_504_TIMES: '3' }).execute(await w.delivery(deployJob(built)));
    expect(r2).toMatchObject({ ok: false, code: 'provider_unavailable' });
    if (!r2.ok) expect(r2.detail).toMatch(/partial: api\n.*-> 504 Gateway Timeout/s);
    expect(await readFile(counter, 'utf8')).toBe('3');
    expect(isTransientApiFailure('Authentication error [code: 10000]')).toBe(false);
    expect(isTransientApiFailure('  POST /accounts/a/workers/scripts/x/versions -> 504 Gateway Timeout')).toBe(true);
    expect(isTransientApiFailure('  PUT /accounts/a/workers/scripts/x -> 400 Bad Request')).toBe(false);
  });

  it('without a pinned wrangler the job fails closed', async () => {
    const r = await w.runner().execute(await w.delivery(deployJob(built)));
    expect(r).toMatchObject({ ok: false, code: 'provider_unavailable' });
  });
});

describe('release with D1 and data files (staging)', () => {
  const D1 = { binding: 'DB', id: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' };
  const dataPrefix = 'org/o-1/releases/rel-data-1/';

  function dataBuildJob(releaseId: string) {
    return {
      kind: 'release-build' as const,
      releaseId,
      acceptedVersionId: 'staging-b-1',
      sources: [{ resourceId: 'res-api-data', mountName: 'api', canonical: dataApi.coords, sha: dataApi.sha }],
      recipe: { recipeId: 'release', revision: 1, steps: [{ stepId: 'api', mountName: 'api', command: 'node scripts/bundle.mjs' }] },
      targets: [{ targetId: 'api', kind: 'worker' as const, mountName: 'api', outputPath: 'dist', main: 'index.js', workerName: 'cfapp-o-1-api-staging' }],
      environment: { api: { vars: {}, kvNamespaces: [], d1Databases: [D1], data: ['migrations', 'seed/contacts.sql'] } },
      outputPrefix: `org/o-1/releases/${releaseId}/`,
    };
  }

  let dataApi: CanonicalRepo;
  beforeAll(async () => {
    dataApi = await w.canonical('res-api-data', {
      'wrangler.jsonc': '{ "name": "x", "main": "src/index.js", "compatibility_date": "2026-08-22" }',
      'scripts/bundle.mjs': "import { mkdirSync, copyFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\ncopyFileSync('src/index.js', 'dist/index.js');\n",
      'src/index.js': "export default { fetch() { return new Response('ok') } }\n",
      'migrations/0001_init.sql': 'CREATE TABLE contacts (id INTEGER PRIMARY KEY);\n',
      'seed/contacts.sql': 'INSERT INTO contacts (id) VALUES (1);\n',
    });
  });

  it('release-build copies data files under <target>/__data and binds staging D1 in the config', async () => {
    const r = await w.runner().execute(await w.delivery(dataBuildJob('rel-data-1')));
    expect(r.ok ? 'ok' : (r as { detail: string }).detail).toBe('ok');
    if (!r.ok) return;
    const receipt = r.receipt as ReleaseBuildReceipt;
    const t = receipt.targets[0]!;
    expect(t.dataFiles!.map((f) => f.path)).toEqual(['migrations/0001_init.sql', 'seed/contacts.sql']);
    expect(t.config.d1Databases).toEqual([D1]);
    expect(t.files.map((f) => f.path)).toEqual(['index.js']);
    expect(t.digest).toBe(releaseTargetDigest(t.files, t.config, t.dataFiles));
    expect(await readFile(w.blobPath(`${dataPrefix}api/__data/migrations/0001_init.sql`), 'utf8')).toContain('CREATE TABLE contacts');
    expect(await readFile(w.blobPath(`${dataPrefix}api/__data/seed/contacts.sql`), 'utf8')).toContain('INSERT INTO contacts');
  });

  it('a data path that does not exist fails the build', async () => {
    const j = dataBuildJob('rel-data-3');
    j.environment.api.data = ['migrations/nope'];
    const r = await w.runner().execute(await w.delivery(j));
    expect(r).toMatchObject({ ok: false, code: 'check_failed' });
  });

  // the staging capture sink is a workers.dev Worker on the same account (Cloudflare error 1042 without the flag)
  it('environment compatibilityFlags are added to the source flags, dropping a conflicting no_ flag', async () => {
    const flagged = await w.canonical('res-api-flags', {
      'wrangler.jsonc': '{ "name": "x", "main": "src/index.js", "compatibility_date": "2026-08-22", "compatibility_flags": ["nodejs_compat", "no_global_fetch_strictly_public"] }',
      'scripts/bundle.mjs': "import { mkdirSync, copyFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\ncopyFileSync('src/index.js', 'dist/index.js');\n",
      'src/index.js': 'export default {}\n',
    });
    const job = (releaseId: string, compatibilityFlags?: ['global_fetch_strictly_public']) => ({
      ...dataBuildJob(releaseId),
      sources: [{ resourceId: 'res-api-flags', mountName: 'api', canonical: flagged.coords, sha: flagged.sha }],
      environment: { api: { vars: {}, kvNamespaces: [], ...(compatibilityFlags ? { compatibilityFlags } : {}) } },
    });
    const withFlag = await w.runner().execute(await w.delivery(job('rel-flags-1', ['global_fetch_strictly_public'])));
    expect(withFlag.ok ? 'ok' : (withFlag as { detail: string }).detail).toBe('ok');
    if (!withFlag.ok) return;
    const t = (withFlag.receipt as ReleaseBuildReceipt).targets[0]!;
    expect(t.config.compatibilityFlags).toEqual(['nodejs_compat', 'global_fetch_strictly_public']);
    expect(t.digest).toBe(releaseTargetDigest(t.files, t.config, t.dataFiles));
    const without = await w.runner().execute(await w.delivery(job('rel-flags-2')));
    if (!without.ok) throw new Error((without as { detail: string }).detail);
    expect((without.receipt as ReleaseBuildReceipt).targets[0]!.config.compatibilityFlags).toEqual(['nodejs_compat', 'no_global_fetch_strictly_public']);
  });

  it('an environment flag the source already sets is listed once', async () => {
    const dup = await w.canonical('res-api-flags-dup', {
      'wrangler.jsonc': '{ "name": "x", "main": "src/index.js", "compatibility_date": "2026-08-22", "compatibility_flags": ["global_fetch_strictly_public", "nodejs_compat"] }',
      'scripts/bundle.mjs': "import { mkdirSync, copyFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\ncopyFileSync('src/index.js', 'dist/index.js');\n",
      'src/index.js': 'export default {}\n',
    });
    const j = { ...dataBuildJob('rel-flags-3'), sources: [{ resourceId: 'res-api-flags-dup', mountName: 'api', canonical: dup.coords, sha: dup.sha }], environment: { api: { vars: {}, kvNamespaces: [], compatibilityFlags: ['global_fetch_strictly_public' as const] } } };
    const r = await w.runner().execute(await w.delivery(j));
    if (!r.ok) throw new Error((r as { detail: string }).detail);
    expect((r.receipt as ReleaseBuildReceipt).targets[0]!.config.compatibilityFlags).toEqual(['global_fetch_strictly_public', 'nodejs_compat']);
  });

  // review I1: data files are read before the recipe; a build step can never add or edit a migration
  for (const [label, step] of [
    ['adds a migration', "writeFileSync('migrations/9999_x.sql', 'DROP TABLE contacts;')"],
    ['edits a migration', "writeFileSync('migrations/0001_init.sql', 'DROP TABLE contacts;')"],
  ] as const) {
    it(`a recipe that ${label} fails the build (and nothing it wrote is a data file)`, { timeout: 30_000 }, async () => {
      const resourceId = `res-api-gen-${label.split(' ')[0]}`;
      const repo = await w.canonical(resourceId, {
        'wrangler.jsonc': '{ "name": "x", "main": "src/index.js", "compatibility_date": "2026-08-22" }',
        'scripts/bundle.mjs': `import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\ncopyFileSync('src/index.js', 'dist/index.js');\n${step};\n`,
        'src/index.js': 'export default {}\n',
        'migrations/0001_init.sql': 'CREATE TABLE contacts (id INTEGER PRIMARY KEY);\n',
      });
      const releaseId = `rel-gen-${label.split(' ')[0]}`;
      const j = { ...dataBuildJob(releaseId), sources: [{ resourceId, mountName: 'api', canonical: repo.coords, sha: repo.sha }] };
      j.environment.api.data = ['migrations'];
      const r = await w.runner().execute(await w.delivery(j));
      expect(r).toMatchObject({ ok: false, code: 'check_failed' });
      expect((r as { detail: string }).detail).toContain('the recipe changed its data files');
      await expect(readFile(w.blobPath(`org/o-1/releases/${releaseId}/api/__data/migrations/9999_x.sql`), 'utf8')).rejects.toThrow();
      await expect(readFile(w.blobPath(`org/o-1/releases/${releaseId}/api/__data/migrations/0001_init.sql`), 'utf8')).rejects.toThrow();
    });
  }

  // writes 501 files and builds: slow under turbo's parallel load (vitest's 5 s default is too tight)
  it('refuses more than 500 data files per target', { timeout: 30_000 }, async () => {
    const many: Record<string, string> = {
      'wrangler.jsonc': '{ "name": "x", "main": "src/index.js", "compatibility_date": "2026-08-22" }',
      'scripts/bundle.mjs': "import { mkdirSync, copyFileSync } from 'node:fs';\nmkdirSync('dist', { recursive: true });\ncopyFileSync('src/index.js', 'dist/index.js');\n",
      'src/index.js': 'export default {}\n',
    };
    for (let i = 0; i < 501; i++) many[`migrations/${String(i).padStart(4, '0')}.sql`] = `SELECT ${i};\n`;
    const big = await w.canonical('res-api-many', many);
    const j = { ...dataBuildJob('rel-data-4'), sources: [{ resourceId: 'res-api-many', mountName: 'api', canonical: big.coords, sha: big.sha }] };
    j.environment.api.data = ['migrations'];
    const r = await w.runner().execute(await w.delivery(j));
    expect(r).toMatchObject({ ok: false, code: 'check_failed' });
    expect((r as { detail: string }).detail).toContain('more than 500 data files');
  });

  it('release-deploy writes d1_databases into the wrangler config and verifies the data files', async () => {
    const b = await w.runner().execute(await w.delivery(dataBuildJob('rel-data-2')));
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const receipt = b.receipt as ReleaseBuildReceipt;
    const t = receipt.targets[0]!;
    const job = {
      kind: 'release-deploy' as const,
      releaseId: 'rel-data-2',
      outputDigest: receipt.outputDigest,
      outputPrefix: 'org/o-1/releases/rel-data-2/',
      accountId: ACCOUNT,
      targets: [{ targetId: 'api', kind: 'worker' as const, workerName: 'cfapp-o-1-api-staging', main: 'index.js', digest: t.digest, files: t.files, config: t.config, dataFiles: t.dataFiles }],
    };
    const r = await deployRunner().execute(await w.delivery(job));
    expect(r).toMatchObject({ ok: true });
    const cfg = JSON.parse(await readFile(join(logDir, 'cfapp-o-1-api-staging.json'), 'utf8')).cfg;
    expect(cfg.d1_databases).toEqual([{ binding: 'DB', database_id: D1.id, database_name: 'DB' }]);
    // a stored data file swapped after the build is refused before any upload
    await writeFile(w.blobPath('org/o-1/releases/rel-data-2/api/__data/seed/contacts.sql'), 'DROP TABLE contacts;\n');
    const r2 = await deployRunner().execute(await w.delivery(job));
    expect(r2).toMatchObject({ ok: false, code: 'scope_violation' });
    // a dropped dataFiles list no longer matches the recorded digest
    const r3 = await deployRunner().execute(await w.delivery({ ...job, targets: [{ ...job.targets[0]!, dataFiles: undefined }] }));
    expect(r3).toMatchObject({ ok: false, code: 'scope_violation' });
  });
});
