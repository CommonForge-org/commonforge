/** Actual API and DO SQLite transaction; synthetic historical-source seed and signed runner double. */
import { runInDurableObject } from 'cloudflare:test';
import { describe,it,expect,vi } from 'vitest';
import { canonicalJson, computeProjectManifestHash, hashCanonicalSync } from '@commonforge-org/core';
import { signScenarioResult, verifyScenarioRequest } from '@commonforge-org/runner-protocol';
import { SqliteLedgerStore } from '../../src/ledger/sqlite-store.js';
import { harness,ownerWithOrg,codeResource,projectWith } from '../helpers.js';

describe('native recovery API and SQLite boundary',()=>{
 it('prepares exact historical refs, verifies current scenarios, atomically restores and safely retries',async()=>{
  const h=harness(),o=await ownerWithOrg(h),source=await codeResource(h,o,'source',{'index.txt':'synthetic old'}),pid=await projectWith(h,o,[{mountName:'source',resourceId:source.resourceId}]),path=`/api/orgs/${o.orgId}/projects/${pid}/native`;
  h.envOverrides.COMMONFORGE_SCENARIO_RUNNER_URL='https://native-verifier.example.com';
  const enabled=await h.api('POST',path+'/enable',{token:o.token,body:{idempotencyKey:'enable'}});expect(enabled.status).toBe(201);const target=enabled.body.state.manifests[0].hash;
  const ledger=h.services().ledger(o.orgId),current=source.revisionId.replace(/[a-f0-9]{40}$/,'b'.repeat(40));
  // Seed an already-accepted later source revision, using actual history tables. This is NOT provider execution evidence.
  await runInDurableObject(ledger,(_instance,ctx)=>{
   const store=new SqliteLedgerStore(ctx.storage);store.seed({heads:[{resourceId:source.resourceId,revisionId:current as never,versionSeq:2}]});store.transactionSync(tx=>{const s=JSON.parse(tx.getNativeProjectJson(pid)!);s.sourceHeads=[{resourceId:source.resourceId,revisionId:current}];const m={...s.manifests[0],id:'synthetic-later',sequence:1,parent:target,sourceHeads:s.sourceHeads};delete m.hash;s.manifests.push({...m,hash:computeProjectManifestHash(m)});tx.putNativeProjectJson(pid,o.orgId,s.generation,canonicalJson(s));});
  });
  let s=(await h.api('GET',path,{token:o.token})).body.state;const now=h.services().nowIso(),common={schemaVersion:1 as const,organizationId:o.orgId,projectId:pid,author:o.userId,createdAt:now};
  const scenario={...common,id:'current-check',revision:1,predecessor:null,title:'Current corrected requirement',given:'Current corrected input',when:'Recovery runs',then:'Current behavior remains',ruleRefs:[],required:true,method:'automated',verifierDigest:'a'.repeat(64),confirmation:null,archived:false};
  s=(await h.api('POST',path+'/commands',{token:o.token,body:{type:'draftScenario',record:scenario,expectedGeneration:s.generation,idempotencyKey:'draft'}})).body.state;
  s=(await h.api('POST',path+'/commands',{token:o.token,body:{type:'confirmScenario',id:scenario.id,revision:1,decisionId:'confirm',explanation:'Current requirements apply to old source',expectedGeneration:s.generation,idempotencyKey:'confirm'}})).body.state;const knowledge=s.knowledgeHead;
  let runs=0;const original=globalThis.fetch;
  const mock=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
   const url=String(input);if(!url.startsWith('https://native-verifier.example.com'))return original(input,init);
   if(url.endsWith('/capabilities'))return Response.json({protocolVersion:1,runtimeRecipeDigest:'c'.repeat(64)});
   const request=await verifyScenarioRequest(JSON.parse(String(init!.body)),h.services().jobKey());runs++;expect(request.sourceHeads).toEqual([{resourceId:source.resourceId,revisionId:source.revisionId}]);expect(request.requiredScenarios[0]!.revision).toBe(2);
   const evidence=request.requiredScenarios.map(q=>({...common,id:'signed-'+request.runId,createdAt:request.issuedAt,envelopeDigest:request.envelopeDigest,buildDigest:request.buildDigest,runtimeRecipeDigest:request.runtimeRecipeDigest,scenarioId:q.id,scenarioRevision:q.revision,verifierDigest:q.verifierDigest,method:'automated' as const,result:'pass' as const,runId:request.runId,actor:'signed-runner-double',startedAt:request.issuedAt,completedAt:request.issuedAt,provenance:'runner-verified' as const,supersedes:null,attachments:[],summary:'Signed protocol double; no runtime claim'}));
   return Response.json(await signScenarioResult({protocolVersion:1,requestDigest:hashCanonicalSync(request),runId:request.runId,evidence,completedAt:request.issuedAt,execution:'bubblewrap-linux-http',network:'none',controlPlaneMounted:false},h.services().jobKey()));
  });
  try{
   const prepared=await h.api('POST',path+'/recoveries',{token:o.token,body:{manifestHash:target,expectedGeneration:s.generation,idempotencyKey:'recovery'}});expect(prepared.status,JSON.stringify(prepared.body)).toBe(201);s=prepared.body.state;const p=prepared.body.proposal;expect(p.envelope.innerProposalId).toBeNull();expect(p.envelope.expectedKnowledgeHead).toBe(knowledge);
   const decision={...common,id:'approve',envelopeDigest:p.digest,innerProposalHash:null,action:'approve',explanation:'Reviewed historical source under current requirements',authorityRevision:1};s=(await h.api('POST',path+'/commands',{token:o.token,body:{type:'recordDecision',record:decision,expectedGeneration:s.generation,idempotencyKey:'approve'}})).body.state;
   const premature=await h.api('POST',path+'/commands',{token:o.token,body:{type:'accept',proposalId:p.id,decisionId:decision.id,expectedGeneration:s.generation,idempotencyKey:'premature'}});expect(premature.status).toBe(409);expect(premature.body.error.code).toBe('scenario_evidence_missing');
   const verified=await h.api('POST',path+`/proposals/${p.id}/verify`,{token:o.token,body:{idempotencyKey:'verify'}});expect(verified.status,JSON.stringify(verified.body)).toBe(200);expect(runs).toBe(1);s=verified.body.state;
   const snapshot=()=>runInDurableObject(ledger,(_instance,ctx)=>Object.fromEntries(['heads','head_history','accepted_versions','audit','outbox','idempotency','native_projects'].map(table=>[table,ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray()])));
   const before=await snapshot();await runInDurableObject(ledger,(_instance,ctx)=>ctx.storage.sql.exec("CREATE TRIGGER recovery_fail BEFORE UPDATE ON native_projects BEGIN SELECT RAISE(ABORT,'injected recovery persistence failure'); END"));
   const command={type:'accept',proposalId:p.id,decisionId:decision.id,expectedGeneration:s.generation,idempotencyKey:'accept-recovery'};
   const failed=await h.api('POST',path+'/commands',{token:o.token,body:command});expect(failed.status).toBeGreaterThanOrEqual(400);expect(await snapshot()).toEqual(before);
   await runInDurableObject(ledger,(_instance,ctx)=>ctx.storage.sql.exec('DROP TRIGGER recovery_fail'));
   const accepted=await h.api('POST',path+'/commands',{token:o.token,body:command});expect(accepted.status,JSON.stringify(accepted.body)).toBe(200);expect(accepted.body.state.sourceHeads).toEqual([{resourceId:source.resourceId,revisionId:source.revisionId}]);expect(accepted.body.state.knowledgeHead).toBe(knowledge);expect(accepted.body.state.manifests.at(-1).behavior).toBe('verified');expect((await ledger.getHead(source.resourceId))!.revisionId).toBe(source.revisionId);
   const replay=await h.api('POST',path+'/commands',{token:o.token,body:command});expect(replay.status).toBe(200);expect(replay.body.replayed).toBe(true);expect(replay.body.acceptedVersionId).toBe(accepted.body.acceptedVersionId);expect(replay.body.state.manifests).toHaveLength(accepted.body.state.manifests.length);
   const repeatPrepare=await h.api('POST',path+'/recoveries',{token:o.token,body:{manifestHash:target,expectedGeneration:prepared.body.state.generation-1,idempotencyKey:'recovery'}});expect(repeatPrepare.body.replayed).toBe(true);expect(repeatPrepare.body.proposal.digest).toBe(p.digest);
  }finally{mock.mockRestore();}
 });
});
