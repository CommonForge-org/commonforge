import { describe,expect,it } from 'vitest';
import { computeProjectProposalHash,sha256HexSync } from '@commonforge-org/core';
import { exportProjectBundle } from '@commonforge-org/ledger';
import { harness,ownerWithOrg,projectWith } from '../helpers.js';
import { exportNativePayloads,nativePayloadKey,putNativePayload,readNativePayload,deleteNativePayload } from '../../src/services/native-payloads.js';
async function setup(){const h=harness();const o=await ownerWithOrg(h);const pid=await projectWith(h,o,[]);const path=`/api/orgs/${o.orgId}/projects/${pid}/native`;expect((await h.api('POST',path+'/enable',{token:o.token,body:{idempotencyKey:'enable'}})).status).toBe(201);return {h,o,pid,path};}
const content=new TextEncoder().encode('Synthetic retained observation');const digest=sha256HexSync(content);
async function manualProposal(s:Awaited<ReturnType<typeof setup>>){
 const now=s.h.services().nowIso();const common={schemaVersion:1,organizationId:s.o.orgId,projectId:s.pid,author:s.o.userId,createdAt:now};let state=(await s.h.api('GET',s.path,{token:s.o.token})).body.state;
 const command=async(type:string,extra:Record<string,unknown>)=>{const result=await s.h.api('POST',s.path+'/commands',{token:s.o.token,body:{type,expectedGeneration:state.generation,idempotencyKey:type+':'+state.generation,...extra}});expect(result.status,JSON.stringify(result.body)).toBe(200);state=result.body.state;return state;};
 await command('draftScenario',{record:{...common,id:'scenario',revision:1,predecessor:null,title:'Manual example',given:'A request',when:'Reviewed',then:'Expected behavior observed',ruleRefs:[],required:true,method:'manual',verifierDigest:'a'.repeat(64),confirmation:null,archived:false}});await command('confirmScenario',{id:'scenario',revision:1,decisionId:'confirm',explanation:'Required manual check'});
 const envelope={schemaVersion:1,organizationId:s.o.orgId,projectId:s.pid,domain:'cf.project-proposal/1',outcome:null,attemptId:null,mandateId:null,mandateRevision:null,contextDigest:null,innerProposalId:null,innerProposalHash:null,sourceHeads:[],runtimeRecipeDigest:'b'.repeat(64),buildDigest:'c'.repeat(64),expectedParent:state.manifests.at(-1).hash,expectedKnowledgeHead:state.knowledgeHead,policyRevision:state.policyRevision,proposedKnowledge:[],proposedScenarios:[],requiredScenarios:[{id:'scenario',revision:2,verifierDigest:'a'.repeat(64),method:'manual'}],recovery:null,effects:[]};const proposal={...common,id:'proposal',envelope,digest:computeProjectProposalHash(envelope as never)};await command('prepareProposal',{record:proposal});
 const evidence={...common,id:'evidence',envelopeDigest:proposal.digest,buildDigest:envelope.buildDigest,runtimeRecipeDigest:envelope.runtimeRecipeDigest,scenarioId:'scenario',scenarioRevision:2,verifierDigest:'a'.repeat(64),method:'manual',result:'pass',runId:'human-observation',actor:s.o.userId,startedAt:now,completedAt:now,provenance:'human-attested',supersedes:null,attachments:[{digest,size:content.byteLength,mediaType:'text/plain'}],summary:'Observed synthetic example'};
 return {common,proposal,evidence,getState:()=>state,command};
}
describe('native evidence payload retention',()=>{
 it('uploads scoped digest bytes, replays and verifies download and full-payload export',async()=>{
 const s=await setup();const path=s.path+'/attachments/'+digest;
 const put=await s.h.api('PUT',path,{token:s.o.token,raw:content,headers:{'content-type':'text/plain'}});expect(put.status,JSON.stringify(put.body)).toBe(201);
 const repeat=await s.h.api('PUT',path,{token:s.o.token,raw:content,headers:{'content-type':'text/plain'}});expect(repeat.status).toBe(200);expect(repeat.body.replayed).toBe(true);
 const get=await s.h.api('GET',path,{token:s.o.token});expect(get.status).toBe(200);expect(get.body).toBe('Synthetic retained observation');expect(get.headers.get('x-commonforge-sha256')).toBe(digest);
 const p=await manualProposal(s);await p.command('recordEvidence',{record:p.evidence});const state=p.getState();const payloads=await exportNativePayloads(s.h.services(),s.o.orgId,s.pid,state);const bundle=exportProjectBundle(state,payloads);expect(bundle.completeness.missingAttachments).toEqual([]);expect(bundle.payloads[0]?.digest).toBe(digest);
 });
 it('rejects missing attachments at evidence transaction and refuses deletion once referenced',async()=>{
 const s=await setup();const p=await manualProposal(s);const record=await s.h.api('POST',s.path+'/commands',{token:s.o.token,body:{type:'recordEvidence',record:p.evidence,expectedGeneration:p.getState().generation,idempotencyKey:'missing'}});expect(record.status).toBe(409);expect(record.body.error.code).toBe('scenario_evidence_invalid');
 await putNativePayload(s.h.services(),s.o.orgId,s.pid,s.o.userId,digest,content,'text/plain');await p.command('recordEvidence',{record:p.evidence});const del=await s.h.api('DELETE',s.path+'/attachments/'+digest,{token:s.o.token});expect(del.status).toBe(409);expect(del.body.error.code).toBe('revision_conflict');expect((await readNativePayload(s.h.services(),s.o.orgId,s.pid,digest)).content).toEqual(content);
 });
 it('tombstones an unreferenced payload and rejects concurrent future reference or resurrection',async()=>{
 const s=await setup();await putNativePayload(s.h.services(),s.o.orgId,s.pid,s.o.userId,digest,content,'text/plain');expect((await deleteNativePayload(s.h.services(),s.o.orgId,s.pid,s.o.userId,digest)).deleted).toBe(true);await expect(readNativePayload(s.h.services(),s.o.orgId,s.pid,digest)).rejects.toThrow(/not found/);await expect(putNativePayload(s.h.services(),s.o.orgId,s.pid,s.o.userId,digest,content,'text/plain')).rejects.toThrow(/deleted/);
 const p=await manualProposal(s);const result=await s.h.api('POST',s.path+'/commands',{token:s.o.token,body:{type:'recordEvidence',record:p.evidence,expectedGeneration:p.getState().generation,idempotencyKey:'deleted'}});expect(result.status).toBe(409);
 });
 it('a delete racing before first registration permanently excludes evidence attachment loss',async()=>{
 const s=await setup();await deleteNativePayload(s.h.services(),s.o.orgId,s.pid,s.o.userId,digest);await expect(putNativePayload(s.h.services(),s.o.orgId,s.pid,s.o.userId,digest,content,'text/plain')).rejects.toThrow(/deleted/);const raw=await s.h.services().ledger(s.o.orgId).getNativePayload(s.pid,digest);expect(JSON.parse(raw!).state).toBe('deleted');
 });
 it('R2 failure does not register, missing/corrupt bytes fail integrity, and deletion retry completes cleanup',async()=>{
 const s=await setup();const svc=s.h.services();const original=svc.env.COMMONFORGE_ASSETS;svc.env={...svc.env,COMMONFORGE_ASSETS:{put:async()=>{throw new Error('injected put outage');}} as unknown as R2Bucket};await expect(putNativePayload(svc,s.o.orgId,s.pid,s.o.userId,digest,content,'text/plain')).rejects.toThrow('injected put outage');expect(await svc.ledger(s.o.orgId).getNativePayload(s.pid,digest)).toBeNull();svc.env={...svc.env,COMMONFORGE_ASSETS:original};
 await putNativePayload(svc,s.o.orgId,s.pid,s.o.userId,digest,content,'text/plain');await original.put(nativePayloadKey(s.o.orgId,s.pid,digest),'corrupt');await expect(readNativePayload(svc,s.o.orgId,s.pid,digest)).rejects.toThrow(/integrity/);await original.delete(nativePayloadKey(s.o.orgId,s.pid,digest));await expect(readNativePayload(svc,s.o.orgId,s.pid,digest)).rejects.toThrow(/unavailable/);
 await putNativePayload(svc,s.o.orgId,s.pid,s.o.userId,digest,content,'text/plain');svc.env={...svc.env,COMMONFORGE_ASSETS:{delete:async()=>{throw new Error('injected delete outage');}} as unknown as R2Bucket};await expect(deleteNativePayload(svc,s.o.orgId,s.pid,s.o.userId,digest)).rejects.toThrow('injected delete outage');expect(JSON.parse((await svc.ledger(s.o.orgId).getNativePayload(s.pid,digest))!).state).toBe('deleted');svc.env={...svc.env,COMMONFORGE_ASSETS:original};await deleteNativePayload(svc,s.o.orgId,s.pid,s.o.userId,digest);expect(await original.get(nativePayloadKey(s.o.orgId,s.pid,digest))).toBeNull();
 });
 it('denies cross-organization reads and oversize/mismatched uploads',async()=>{
 const s=await setup();await putNativePayload(s.h.services(),s.o.orgId,s.pid,s.o.userId,digest,content,'text/plain');const other=await ownerWithOrg(s.h);expect((await s.h.api('GET',s.path+'/attachments/'+digest,{token:other.token})).status).toBe(404);
 expect((await s.h.api('PUT',s.path+'/attachments/'+'f'.repeat(64),{token:s.o.token,raw:content,headers:{'content-type':'text/plain'}})).status).toBe(409);const tooBig=new Uint8Array(1048577);expect((await s.h.api('PUT',s.path+'/attachments/'+digest,{token:s.o.token,raw:tooBig,headers:{'content-type':'application/octet-stream'}})).status).toBe(413);
 });
});
