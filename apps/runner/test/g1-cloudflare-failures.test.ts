/** Actual isolated build/workerd failures; no cloud deployment or simulated success. */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { sha256HexSync } from '@commonforge-org/core';
import { createCloudflareSchedulingAdapter } from '../src/g1-cloudflare-source.js';
const require=createRequire(new URL('../../worker/package.json',import.meta.url));
const toolchain=dirname(require.resolve('workerd/package.json'));
it('records isolated build and workerd startup errors without retaining candidate diagnostics',async()=>{
  const adapter=await createCloudflareSchedulingAdapter({pin:{binary:join(toolchain,'bin/workerd'),sha256:sha256HexSync(await readFile(join(toolchain,'bin/workerd')))},schema:join(toolchain,'workerd.capnp'),recipe:{recipeId:'test',revision:1,steps:[{stepId:'build',mountName:'api',command:'node build.mjs'}]},environment:{targets:[{targetId:'api',kind:'worker',mountName:'api',outputPath:'dist',main:'worker.mjs',workerName:'cfapp-g1-test'}],environment:{},accountId:'0'.repeat(32),healthCheck:{targetId:'api',path:'/version'}}});
  const encode=(s:string)=>new TextEncoder().encode(s);
  const files=(build:string)=>({'worker.mjs':encode('export default { broken syntax'),'build.mjs':encode(build),'wrangler.json':encode('{"compatibility_date":"2026-08-22"}')});
  for(const build of ["throw Error('candidate-private-diagnostic');", "import{mkdirSync,copyFileSync}from'node:fs';mkdirSync('dist');copyFileSync('worker.mjs','dist/worker.mjs');"]){
    const result=await adapter.verify(files(build));expect(result.results).toHaveLength(9);expect(result.results.every(r=>r.result==='error')).toBe(true);expect(JSON.stringify(result)).not.toContain('candidate-private-diagnostic');
  }
});
