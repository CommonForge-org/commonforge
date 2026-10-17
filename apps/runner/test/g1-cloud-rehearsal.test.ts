import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createGit, RUNNER_IDENTITY_ENV, type Git } from '../src/git.js';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256HexSync } from '@commonforge-org/core';
import { G1CloudRehearsalConfigSchema, cloudFixtureFiles, cloudRehearsalContracts, cloudRehearsalPlan, pushResumableCloudSource, requireFreshCloudProjectName, type CloudSourcePushCheckpoint, type G1CloudRehearsalConfig } from '../src/g1-cloud-rehearsal.js';
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

async function localSource() {
 const root=await mkdtemp(join(tmpdir(),'g1-live-resume-')),seed=join(root,'seed'),remote=join(root,'remote.git'),git=createGit({allowFile:true});
 await mkdir(seed);await git.ok(['init','-q','-b','main'],seed);await writeFile(join(seed,'seed.txt'),'base');await git.ok(['add','.'],seed);await git.ok(['commit','-q','-m','base'],seed,{env:RUNNER_IDENTITY_ENV(new Date().toISOString())});
 await git.ok(['clone','-q','--bare',seed,remote],root);
 return {root,git,remoteUrl:pathToFileURL(remote).href};
}
describe('live source push continuation with real Git',()=>{
 it('fails closed on a name match without an owned checkpoint',()=>{
  expect(()=>requireFreshCloudProjectName([{name:'existing'}],'existing')).toThrow('name-only adoption');
  expect(()=>requireFreshCloudProjectName([{name:'different'}],'new')).not.toThrow();
 });
 it('resumes a push that landed before the client received success, even if the local workspace is gone',async()=>{
  const local=await localSource();let saved:CloudSourcePushCheckpoint={};let commits=0,pushes=0;
  const git:Git={...local.git,async ok(args,cwd,options){if(args[0]==='commit')commits++;if(args[0]==='push'){pushes++;const output=await local.git.ok(args,cwd,options);throw new Error('injected disconnect after actual landed push');}return local.git.ok(args,cwd,options);}};
  try{
   const cycle:CloudSourcePushCheckpoint={},files={'worker.mjs':'export default {};\n','build.mjs':'// trusted builder\n','wrangler.json':'{}'};
   const persist=async()=>{saved=JSON.parse(JSON.stringify(cycle));};
   await expect(pushResumableCloudSource({cycle,files,label:'initial',checkpointDirectory:local.root,remoteUrl:local.remoteUrl,credentialSecret:'synthetic-file-transport',git,persist})).rejects.toThrow('disconnect');
   expect(saved.intendedSha).toMatch(/^[a-f0-9]{40}$/);expect(saved.sha).toBeUndefined();expect(saved.workspace).toBeTruthy();expect(saved.expectedRemoteSha).not.toBe(saved.intendedSha);
   const observed=(await local.git.ok(['ls-remote',local.remoteUrl,'refs/heads/main'],local.root)).trim().split(/\s+/)[0];expect(observed).toBe(saved.intendedSha);
   await rm(saved.workspace!,{recursive:true,force:true});
   const resumed={...saved};const result=await pushResumableCloudSource({cycle:resumed,files,label:'initial',checkpointDirectory:local.root,remoteUrl:local.remoteUrl,credentialSecret:'synthetic-file-transport',git,persist:async()=>{saved=JSON.parse(JSON.stringify(resumed));}});
   expect(result).toBe(observed);expect(saved.sha).toBe(observed);expect(commits).toBe(1);expect(pushes).toBe(1);
  }finally{await rm(local.root,{recursive:true,force:true});}
 });
 it('continues after the local commit landed before its intent checkpoint was saved',async()=>{
  const local=await localSource();let saved:CloudSourcePushCheckpoint={},commits=0;const cycle:CloudSourcePushCheckpoint={};
  const git:Git={...local.git,async ok(args,cwd,options){if(args[0]==='commit')commits++;return local.git.ok(args,cwd,options);}};
  const files={'worker.mjs':'export default {};\n'};
  try{
   await expect(pushResumableCloudSource({cycle,files,label:'initial',checkpointDirectory:local.root,remoteUrl:local.remoteUrl,credentialSecret:'synthetic-file-transport',git,persist:async()=>{if(cycle.intendedSha)throw new Error('injected crash before intent save');saved=JSON.parse(JSON.stringify(cycle));}})).rejects.toThrow('before intent save');
   expect(saved.intendedSha).toBeUndefined();expect(saved.workspace).toBeTruthy();
   const resumed={...saved};const sha=await pushResumableCloudSource({cycle:resumed,files,label:'initial',checkpointDirectory:local.root,remoteUrl:local.remoteUrl,credentialSecret:'synthetic-file-transport',git,persist:async()=>{saved=JSON.parse(JSON.stringify(resumed));}});
   expect(commits).toBe(1);expect(saved.sha).toBe(sha);expect((await local.git.ok(['ls-remote',local.remoteUrl,'refs/heads/main'],local.root)).split(/\s+/)[0]).toBe(sha);
  }finally{await rm(local.root,{recursive:true,force:true});}
 });
 it('retains intended commit before an unlanded push and refuses a later foreign remote change',async()=>{
  const local=await localSource();let saved:CloudSourcePushCheckpoint={};const cycle:CloudSourcePushCheckpoint={};
  const git:Git={...local.git,async ok(args,cwd,options){if(args[0]==='push')throw new Error('injected failure before push');return local.git.ok(args,cwd,options);}};
  const files={'worker.mjs':'export default {};\n'};
  try{
   await expect(pushResumableCloudSource({cycle,files,label:'initial',checkpointDirectory:local.root,remoteUrl:local.remoteUrl,credentialSecret:'synthetic-file-transport',git,persist:async()=>{saved=JSON.parse(JSON.stringify(cycle));}})).rejects.toThrow('before push');
   const foreign=join(local.root,'foreign');await local.git.ok(['clone','-q',local.remoteUrl,foreign],local.root);await writeFile(join(foreign,'foreign.txt'),'separate actor');await local.git.ok(['add','.'],foreign);await local.git.ok(['commit','-q','-m','foreign'],foreign,{env:RUNNER_IDENTITY_ENV(new Date().toISOString())});await local.git.ok(['push','-q','origin','HEAD:refs/heads/main'],foreign);
   await expect(pushResumableCloudSource({cycle:{...saved},files,label:'initial',checkpointDirectory:local.root,remoteUrl:local.remoteUrl,credentialSecret:'synthetic-file-transport',git:local.git,persist:async()=>{}})).rejects.toThrow('refuse to overwrite');
  }finally{await rm(local.root,{recursive:true,force:true});}
 });
});
