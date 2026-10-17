/** Actual Git snapshot, HTTP signed request, isolated build/workerd, signed result.
 * This is a local production-runtime bridge check, not a deployed Cloudflare release. */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashCanonicalSync, sha256HexSync } from '@commonforge-org/core';
import { scenarioBuildDigest, signScenarioRequest, verifyScenarioResult, type ScenarioVerificationRequest } from '@commonforge-org/runner-protocol';
import { KEY, World } from './helpers.js';
import { startLocalScenarioBridge } from '../src/g1-local-bridge.js';
import { createCloudflareSchedulingAdapter } from '../src/g1-cloudflare-source.js';
const require = createRequire(new URL('../../worker/package.json', import.meta.url));
const toolchain = dirname(require.resolve('workerd/package.json'));
const recipe = { recipeId: 'scheduling', revision: 1, steps: [{ stepId: 'bundle', mountName: 'api', command: 'node build.mjs' }] };
const environment = { targets: [{ targetId: 'api', kind: 'worker' as const, mountName: 'api', outputPath: 'dist', main: 'worker.mjs', workerName: 'cfapp-g1-scheduling' }], environment: {}, accountId: '0'.repeat(32), healthCheck: { targetId: 'api', path: '/version' } };
let world: World;
let bridge: Awaited<ReturnType<typeof startLocalScenarioBridge>>;
let request: ScenarioVerificationRequest;
beforeAll(async () => {
  world = await World.create();
  const canonical = await world.canonical('res-api', {
    'worker.mjs': await readFile(new URL('../../../fixtures/scheduling/worker.mjs', import.meta.url), 'utf8'),
    'build.mjs': "import{mkdirSync,readFileSync,writeFileSync}from'node:fs';mkdirSync('dist');writeFileSync('dist/worker.mjs',readFileSync('worker.mjs','utf8').replaceAll('export const ','const '));",
    'wrangler.json': '{"compatibility_date":"2026-08-22"}',
  });
  const runtime = await createCloudflareSchedulingAdapter({ pin: { binary: join(toolchain, 'bin/workerd'), sha256: sha256HexSync(await readFile(join(toolchain, 'bin/workerd'))) }, schema: join(toolchain, 'workerd.capnp'), recipe, environment });
  bridge = await startLocalScenarioBridge({ provider: world.provider, jobKey: KEY, runtime, resources: [{ organizationId: 'org1', projectId: 'project1', resourceId: 'res-api' }] });
  const now = new Date().toISOString();
  const sourceHeads = [{ resourceId: 'res-api', revisionId: canonical.revision }];
  request = { protocolVersion: 1, organizationId: 'org1', projectId: 'project1', runId: 'workerd-bridge-run', envelopeDigest: 'a'.repeat(64), sourceHeads, buildDigest: scenarioBuildDigest(sourceHeads), runtimeRecipeDigest: runtime.runtimeRecipeDigest,
    requiredScenarios: runtime.scenarioIds.map(id => ({ id, revision: 1, verifierDigest: runtime.verifierDigest, method: 'automated' })), issuedAt: now, expiresAt: new Date(Date.parse(now) + 120000).toISOString() };
});
afterAll(async () => { await bridge?.close(); await world?.close(); });
const submit = async (r: ScenarioVerificationRequest) => fetch(`${bridge.url}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signScenarioRequest(r, KEY)) });
describe('signed actual Git/workerd source workflow', () => {
  it('binds all real results to exact revision, trusted verifier and release-compatible runtime', async () => {
    const response = await submit(request);
    expect(response.status).toBe(200);
    const signed = await response.json();
    const verified = await verifyScenarioResult(signed, KEY, request);
    expect(verified.evidence).toHaveLength(9);
    expect(verified.evidence.every(e => e.result === 'pass' && e.provenance === 'runner-verified')).toBe(true);
    expect(request.runtimeRecipeDigest).toBe(hashCanonicalSync({ domain: 'cf.project-runtime/1', recipe, environment }));
    const retry = await submit(request);
    expect(await retry.json()).toEqual(signed);
  });
  it('refuses caller-selected runtime and cross-project source even with valid signing key', async () => {
    expect((await submit({ ...request, runId: 'wrong-runtime', runtimeRecipeDigest: '0'.repeat(64) })).status).toBe(422);
    expect((await submit({ ...request, runId: 'wrong-project', projectId: 'another-project' })).status).toBe(403);
  });
});
