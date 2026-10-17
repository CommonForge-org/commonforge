/** Actual namespace startup failure and retry; no mocked isolation success. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256HexSync } from '@commonforge-org/core';
import { verifySchedulingCandidate } from '../src/g1-local-verifier.js';
import { startLocalScenarioBridge, SCHEDULING_RUNTIME_RECIPE_DIGEST } from '../src/g1-local-bridge.js';
import { signScenarioRequest, verifyScenarioResult, scenarioBuildDigest } from '@commonforge-org/runner-protocol';
import { schedulingVerifierDigest } from '../src/g1-local-verifier.js';

describe('durable scenario execution failures', () => {
  it('records syntax/startup errors after namespace startup and signs complete errors before a passing retry', async () => {
    const bad = Buffer.from('export default { broken syntax');
    let bytes = bad;
    const dir = await mkdtemp(join(tmpdir(),'cf-failed-candidate-'));
    await writeFile(join(dir,'worker.mjs'),bad);
    const key = { kid:'failure-test', secret:'f'.repeat(64) };
    const verifierDigest=await schedulingVerifierDigest();
    const bridge=await startLocalScenarioBridge({jobKey:key,readCandidate:async()=>bytes,resources:[]});
    try {
      const result=await verifySchedulingCandidate(dir);
      expect(result.sourceDigest).toBe(sha256HexSync(bad));
      expect(result.results).toHaveLength(9);expect(result.results.every(r=>r.result==='error')).toBe(true);
      const sourceHeads=[{resourceId:'source',revisionId:'art:repo:'+ 'a'.repeat(40)}];
      const issue=(runId:string)=>({protocolVersion:1 as const,organizationId:'org',projectId:'project',runId,envelopeDigest:'a'.repeat(64),buildDigest:scenarioBuildDigest(sourceHeads),runtimeRecipeDigest:SCHEDULING_RUNTIME_RECIPE_DIGEST,sourceHeads,requiredScenarios:[{id:'cutoff-before',revision:1,verifierDigest,method:'automated' as const}],issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
      const request=issue('failed-run');
      // Select an actual trusted scenario identity advertised by this bridge.
      const caps=await (await fetch(bridge.url+'/capabilities')).json() as {scenarioIds:string[]};request.requiredScenarios[0]!.id=caps.scenarioIds[0]!;
      const dispatch=async(q:typeof request)=>fetch(bridge.url+'/verify',{method:'POST',body:JSON.stringify(await signScenarioRequest(q,key))});
      const first=await dispatch(request);expect(first.status).toBe(200);
      const failed=await verifyScenarioResult(await first.json(),key,request);expect(failed.evidence[0]!.result).toBe('error');
      expect(JSON.stringify(failed)).not.toContain('broken syntax');
      bytes=Buffer.from(await readFile(new URL('../../../fixtures/scheduling/worker.mjs',import.meta.url)));
      const repeated=await dispatch(request);expect((await verifyScenarioResult(await repeated.json(),key,request)).evidence[0]!.result).toBe('error');
      const retry={...issue('fresh-run'),requiredScenarios:request.requiredScenarios};
      const passed=await dispatch(retry);expect((await verifyScenarioResult(await passed.json(),key,retry)).evidence[0]!.result).toBe('pass');
    } finally {await bridge.close();await rm(dir,{recursive:true,force:true});}
  });
  it('records a candidate startup timeout as errors only after isolated supervisor startup',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'cf-startup-timeout-'));
    try {await writeFile(join(dir,'worker.mjs'),'while(true){};export default {};');const result=await verifySchedulingCandidate(dir);expect(result.results.every(r=>r.result==='error')).toBe(true);expect(result.results[0]!.detail).toContain('timed out');}
    finally{await rm(dir,{recursive:true,force:true});}
  },10000);

});
