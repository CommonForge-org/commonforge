import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashCanonicalSync, sha256HexSync } from '@commonforge-org/core';
import type { ReleaseBuildReceipt } from '@commonforge-org/runner-protocol';
import { World } from './helpers.js';
import { cloudflareRuntimeRecipeDigest, verifyCloudflareBuiltScheduling, type CloudflareReleaseEnvironment } from '../src/g1-cloudflare-verifier.js';

// Resolve the actual pinned Worker toolchain; no downloads and no optional fake fallback.
const require = createRequire(new URL('../../worker/package.json', import.meta.url));
const toolchain = dirname(require.resolve('workerd/package.json'));
const pin = { binary: join(toolchain, 'bin/workerd'), sha256: sha256HexSync(await readFile(join(toolchain, 'bin/workerd'))) };
const schema = join(toolchain, 'workerd.capnp');
let world: World;
let built: ReleaseBuildReceipt;
const recipe = { recipeId: 'scheduling-cloudflare', revision: 1, steps: [{ stepId: 'bundle', mountName: 'api', command: 'node build.mjs' }] };
const target = { targetId: 'api', kind: 'worker' as const, mountName: 'api', outputPath: 'dist', main: 'worker.mjs', workerName: 'cfapp-g1-scheduling' };
const environment: CloudflareReleaseEnvironment = { targets: [target], environment: {}, accountId: '0123456789abcdef0123456789abcdef', healthCheck: { targetId: 'api', path: '/version' } };
const prefix = 'org/org1/releases/rel-cloudflare-test/';
const readOutput = (path: string) => readFile(world.blobPath(`${prefix}api/${path}`));
const verify = (extra: Partial<Parameters<typeof verifyCloudflareBuiltScheduling>[0]> = {}) => verifyCloudflareBuiltScheduling({ pin, schema, recipe, environment, built, readOutput, ...extra });

beforeAll(async () => {
  world = await World.create();
  const fixture = await readFile(new URL('../../../fixtures/scheduling/worker.mjs', import.meta.url), 'utf8');
  const canonical = await world.canonical('res-api', {
    'worker.mjs': fixture,
    'wrangler.json': JSON.stringify({ compatibility_date: '2026-08-22' }),
    'build.mjs': "import{mkdirSync,readFileSync,writeFileSync}from'node:fs';mkdirSync('dist');writeFileSync('dist/worker.mjs',readFileSync('worker.mjs','utf8').replaceAll('export const ','const '));",
  });
  const result = await world.runner().execute(await world.delivery({ kind: 'release-build', releaseId: 'rel-cloudflare-test', acceptedVersionId: 'av-g1',
    sources: [{ resourceId: 'res-api', mountName: 'api', canonical: canonical.coords, sha: canonical.sha }], recipe, targets: [target], environment: {}, outputPrefix: prefix }));
  if (!result.ok) throw new Error(`actual release-build failed: ${JSON.stringify(result)}`);
  built = result.receipt as ReleaseBuildReceipt;
});
afterAll(() => world?.close());

describe('Cloudflare scheduling runtime (actual release-build + isolated workerd)', () => {
  it('executes all nine supervisor cases against exact immutable release output bytes', async () => {
    const result = await verify();
    expect(result.results).toHaveLength(9);
    expect(result.results.every(r => r.result === 'pass')).toBe(true);
    expect(result).toMatchObject({ engine: 'workerd', network: 'none', controlPlaneMounted: false, outputDigest: built.outputDigest });
    expect(result.runtimeRecipeDigest).toBe(hashCanonicalSync({ domain: 'cf.project-runtime/1', recipe, environment }));
    expect(result.verifierDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects corrupted build bytes, changed output receipts and an unpinned executable', async () => {
    await expect(verify({ readOutput: async () => new TextEncoder().encode('export default {}') })).rejects.toThrow('bytes mismatch');
    await expect(verify({ built: { ...built, outputDigest: '0'.repeat(64) } })).rejects.toThrow('digest mismatch');
    await expect(verify({ pin: { ...pin, sha256: '0'.repeat(64) } })).rejects.toThrow('supervisor pin');
  });
  it('refuses binding/migration emulation and binds environment changes to a different runtime', async () => {
    await expect(verify({ environment: { ...environment, migrations: [{}] } })).rejects.toThrow('migrations');
    await expect(verify({ environment: { ...environment, environment: { api: { vars: {}, kvNamespaces: [{}] } } } })).rejects.toThrow('bindings');
    expect(cloudflareRuntimeRecipeDigest(recipe, { ...environment, accountId: 'f'.repeat(32) })).not.toBe(cloudflareRuntimeRecipeDigest(recipe, environment));
  });
});
