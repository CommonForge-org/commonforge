import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256HexSync } from '@commonforge-org/core';
import { createCloudflareSchedulingAdapter } from '../src/g1-cloudflare-source.js';
const require = createRequire(new URL('../../worker/package.json', import.meta.url));
const toolchain = dirname(require.resolve('workerd/package.json'));
const pin = { binary: join(toolchain, 'bin/workerd'), sha256: sha256HexSync(await readFile(join(toolchain, 'bin/workerd'))) };
const recipe = { recipeId: 'scheduling', revision: 1, steps: [{ stepId: 'bundle', mountName: 'api', command: 'node build.mjs' }] };
const environment = { targets: [{ targetId: 'api', kind: 'worker' as const, mountName: 'api', outputPath: 'dist', main: 'worker.mjs', workerName: 'cfapp-g1-scheduling' }],
  environment: {}, accountId: '0'.repeat(32), healthCheck: { targetId: 'api', path: '/version' } };
const adapter = await createCloudflareSchedulingAdapter({ pin, schema: join(toolchain, 'workerd.capnp'), recipe, environment });
const encode = (s: string) => new TextEncoder().encode(s);
const module = await readFile(new URL('../../../fixtures/scheduling/worker.mjs', import.meta.url), 'utf8');
const build = "import{mkdirSync,readFileSync,writeFileSync}from'node:fs';mkdirSync('dist');writeFileSync('dist/worker.mjs',readFileSync('worker.mjs','utf8').replaceAll('export const ','const '));";
const files = (worker = module, builder = build) => ({ 'worker.mjs': encode(worker), 'build.mjs': encode(builder), 'wrangler.json': encode('{"compatibility_date":"2026-08-22"}') });
const cleanup: string[] = [];
afterAll(async () => { for (const path of cleanup) await rm(path, { recursive: true, force: true }); });
describe('trusted source-to-Cloudflare adapter', () => {
  it('really executes candidate build then workerd checks; candidate tests cannot weaken it', async () => {
    const good = await adapter.verify(files());
    expect(good.results.every(r => r.result === 'pass')).toBe(true);
    expect(good.verifierDigest).toBe(adapter.verifierDigest);
    const bad = await adapter.verify(files('export default {fetch(){return Response.json({allowed:true,override:null})}}'));
    expect(bad.results.some(r => r.result === 'fail')).toBe(true);
  });
  it('isolates build and runtime from controlling paths and network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'commonforge-control-key-')); cleanup.push(root);
    const secret = join(root, 'key'); await writeFile(secret, 'control-supervisor-secret');
    const guardedBuild = `import{existsSync}from'node:fs';import{networkInterfaces}from'node:os';if(existsSync(${JSON.stringify(secret)})||Object.values(networkInterfaces()).flat().some(x=>x&&!x.internal))process.exit(5);${build}`;
    // Runtime global fetch is explicitly deny-all as well as having no host network namespace.
    const guardedModule = module.replace('export default', 'const candidate =') + '\nexport default {async fetch(request,env){try{await fetch("http://127.0.0.1:1/control");return Response.json({allowed:false,code:"network_leak"})}catch{}if(Object.values(env).includes("control-supervisor-secret"))throw Error("leak");return candidate.fetch(request,env)}};';
    const result = await adapter.verify(files(guardedModule, guardedBuild));
    expect(result.results.every(r => r.result === 'pass')).toBe(true);
  });
  it('refuses symlink outputs, extra deployment modules and unsupported recipes', async () => {
    await expect(adapter.verify(files(module, "import{mkdirSync,symlinkSync}from'node:fs';mkdirSync('dist');symlinkSync('../worker.mjs','dist/worker.mjs');"))).rejects.toThrow();
    await expect(adapter.verify(files(module, build + "writeFileSync('dist/extra.mjs','export default {}');"))).rejects.toThrow('one bundled');
    await expect(createCloudflareSchedulingAdapter({ pin, schema: join(toolchain, 'workerd.capnp'), recipe: { ...recipe, steps: [{ ...recipe.steps[0]!, command: 'curl example.test' }] }, environment })).rejects.toThrow('one node');
  });
});
