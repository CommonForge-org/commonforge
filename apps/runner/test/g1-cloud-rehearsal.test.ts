import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256HexSync } from '@commonforge-org/core';
import { G1CloudRehearsalConfigSchema, cloudFixtureFiles, cloudRehearsalContracts, cloudRehearsalPlan, type G1CloudRehearsalConfig } from '../src/g1-cloud-rehearsal.js';
import { createCloudflareSchedulingAdapter } from '../src/g1-cloudflare-source.js';
const require = createRequire(new URL('../../worker/package.json', import.meta.url));
const toolchain = dirname(require.resolve('workerd/package.json'));
const pin = { binary: join(toolchain,'bin/workerd'), sha256: sha256HexSync(await readFile(join(toolchain,'bin/workerd'))) };
const config: G1CloudRehearsalConfig = { schemaVersion:1,runId:'an21-test',apiUrl:'https://commonforge-ci-worker.example.workers.dev',accountId:'0'.repeat(32),organizationId:'o-0123456789ab',ownerSessionFile:'/not-read-by-plan',stateDirectory:'/not-written-by-plan',controlWorker:'commonforge-ci-worker',targetPrefix:'cfci',mutationsApproved:false,deploymentApproved:false,supervisorPort:8971,pin,schema:join(toolchain,'workerd.capnp') };
describe('dedicated G1 cloud rehearsal preparation',()=>{
 it('plans no network or provisioning and constrains the existing CI target',()=>{
  const plan=cloudRehearsalPlan(config);expect(plan.execution).toBe('planned-not-executed');expect(plan.releaseWorker).toBe('cfci-o-0123456789ab-g1-an21-test');expect(plan.noProvisioning).toBe(true);
  for(const apiUrl of ['https://commonforge-worker.example.workers.dev','http://commonforge-ci-worker.example.workers.dev','https://commonforge-ci-worker.example.workers.dev/api','https://evil.example'])expect(G1CloudRehearsalConfigSchema.safeParse({...config,apiUrl}).success).toBe(false);
  expect(G1CloudRehearsalConfigSchema.safeParse({...config,targetPrefix:'cfapp'}).success).toBe(false);
 });
 it('pins the exact complete release environment used by the verifier',()=>{
  const c=cloudRehearsalContracts(config);expect(c.environment).toEqual({targets:c.policy.release.targets,environment:c.policy.release.environment,healthCheck:c.policy.release.healthCheck,accountId:config.accountId});
  expect(c.policy.release.migrations).toEqual([]);expect(c.policy.release.targets).toHaveLength(1);expect(c.environment.environment.api).toEqual({vars:{APP_VERSION:'g1-synthetic-scheduling'},kvNamespaces:[]});
 });
 it('builds both actual deployable source variants and executes all nine scenarios in pinned isolated workerd',async()=>{
  const c=cloudRehearsalContracts(config),adapter=await createCloudflareSchedulingAdapter({pin,schema:config.schema,recipe:c.recipe,environment:c.environment});
  const revisions=[];
  for(const variant of ['initial','later'] as const){
   const files=await cloudFixtureFiles(variant);expect(files['build.mjs']).not.toContain('index.html');expect(files['worker.mjs']).toContain(`LIVE_VARIANT = '${variant}'`);expect(files['worker.mjs']).toContain('env.COMMONFORGE_RELEASE_ID');
   const result=await adapter.verify(Object.fromEntries(Object.entries(files).map(([path,text])=>[path,new TextEncoder().encode(text)])));
   expect(result.results).toHaveLength(9);expect(result.results.every(r=>r.result==='pass')).toBe(true);expect(result.network).toBe('none');expect(result.controlPlaneMounted).toBe(false);revisions.push(canonicalJson(files));
  }
  expect(revisions[0]).not.toBe(revisions[1]);
 });
});
