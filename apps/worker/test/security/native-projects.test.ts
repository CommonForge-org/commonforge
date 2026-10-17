import { describe,expect,it } from 'vitest';
import { computeProjectProposalHash } from '@commonforge-org/core';
import { FakeRunner } from '../fakes/runner.js';
import { harness,ownerWithOrg,codeResource,projectWith } from '../helpers.js';
async function setup(){const h=harness();const runner=new FakeRunner(h);const o=await ownerWithOrg(h);const code=await codeResource(h,o,'source',{'index.txt':'synthetic'});const pid=await projectWith(h,o,[{mountName:'source',resourceId:code.resourceId}]);const path=`/api/orgs/${o.orgId}/projects/${pid}/native`;const enable=await h.api('POST',path+'/enable',{token:o.token,body:{idempotencyKey:'enable'}});expect(enable.status,JSON.stringify(enable.body)).toBe(201);return {h,runner,o,code,pid,path};}
async function task(s:Awaited<ReturnType<typeof setup>>,title:string){const t=await s.h.api('POST',`/api/orgs/${s.o.orgId}/projects/${s.pid}/tasks`,{token:s.o.token,body:{title,writeMounts:['source']}});expect(t.status,JSON.stringify(t.body)).toBe(201);await s.h.drainSteps();return t.body.taskId as string;}
async function handoff(s:Awaited<ReturnType<typeof setup>>,taskId:string){const issued=await s.h.api('POST',`/api/tasks/${taskId}/native/handoff`,{token:s.o.token,body:{agentId:'same-external-agent'}});expect(issued.status,JSON.stringify(issued.body)).toBe(201);const exchanged=await s.h.api('POST','/api/auth/task/verify',{body:{code:issued.body.code}});expect(exchanged.status,JSON.stringify(exchanged.body)).toBe(200);return {...exchanged.body,code:issued.body.code};}
describe('native task boundaries',()=>{
 it('single-use exchange, cross-task context denial, mandate revocation and expiry',async()=>{
 const s=await setup();const a=await task(s,'Task A'),b=await task(s,'Task B');const credential=await handoff(s,a);
 expect((await s.h.api('POST','/api/auth/task/verify',{body:{code:credential.code}})).status).toBe(401);
 expect((await s.h.api('GET',`/api/tasks/${b}/native/context`,{token:credential.leaseToken})).status).not.toBe(200);
 const context=await s.h.api('GET',`/api/tasks/${a}/native/context`,{token:credential.leaseToken});expect(context.status,JSON.stringify(context.body)).toBe(200);
 const state=(await s.h.api('GET',s.path,{token:s.o.token})).body.state;
 const revoked=await s.h.api('POST',s.path+'/commands',{token:s.o.token,body:{type:'revokeMandate',id:credential.mandateId,revision:1,expectedGeneration:state.generation,idempotencyKey:'revoke'}});expect(revoked.status,JSON.stringify(revoked.body)).toBe(200);
 expect((await s.h.api('GET',`/api/tasks/${a}/native/context`,{token:credential.leaseToken})).status).not.toBe(200);
 const next=await handoff(s,b);const time=s.h.deps.now();s.h.deps.now=()=>new Date(time.getTime()+3600001);expect((await s.h.api('GET',`/api/tasks/${b}/native/context`,{token:next.leaseToken})).status).not.toBe(200);
 });
 it('a token cannot prepare another task attempt even when external agent labels match',async()=>{
 const s=await setup();const a=await task(s,'Task A'),b=await task(s,'Task B');const ca=await handoff(s,a),cb=await handoff(s,b);const state=(await s.h.api('GET',s.path,{token:s.o.token})).body.state;
 const envelope={schemaVersion:1,organizationId:s.o.orgId,projectId:s.pid,domain:'cf.project-proposal/1',outcome:null,attemptId:cb.attemptId,mandateId:cb.mandateId,mandateRevision:1,contextDigest:cb.context.digest,innerProposalId:null,innerProposalHash:null,sourceHeads:state.sourceHeads,runtimeRecipeDigest:'a'.repeat(64),buildDigest:'b'.repeat(64),expectedParent:state.manifests.at(-1).hash,expectedKnowledgeHead:state.knowledgeHead,policyRevision:state.policyRevision,proposedKnowledge:[],proposedScenarios:[],requiredScenarios:[],recovery:null,effects:[]};
 const record={schemaVersion:1,organizationId:s.o.orgId,projectId:s.pid,id:'cross-attempt',author:ca.agentId,createdAt:s.h.services().nowIso(),envelope,digest:computeProjectProposalHash(envelope as never)};
 const attempt=await s.h.api('POST',`/api/tasks/${a}/native/commands`,{token:ca.leaseToken,body:{type:'prepareProposal',expectedGeneration:state.generation,idempotencyKey:'cross-attempt',record}});expect(attempt.status,JSON.stringify(attempt.body)).toBe(403);
 });
 it('refuses raw source envelopes even when they name the authenticated attempt',async()=>{
 const s=await setup();const id=await task(s,'Dedicated source path');const credential=await handoff(s,id);const state=(await s.h.api('GET',s.path,{token:s.o.token})).body.state;
 const envelope={schemaVersion:1,organizationId:s.o.orgId,projectId:s.pid,domain:'cf.project-proposal/1',outcome:null,attemptId:credential.attemptId,mandateId:credential.mandateId,mandateRevision:1,contextDigest:credential.context.digest,innerProposalId:'foreign-task-inner',innerProposalHash:'f'.repeat(64),sourceHeads:state.sourceHeads,runtimeRecipeDigest:'a'.repeat(64),buildDigest:'b'.repeat(64),expectedParent:state.manifests.at(-1).hash,expectedKnowledgeHead:state.knowledgeHead,policyRevision:state.policyRevision,proposedKnowledge:[],proposedScenarios:[],requiredScenarios:[],recovery:null,effects:[]};
 const record={schemaVersion:1,organizationId:s.o.orgId,projectId:s.pid,id:'raw-source',author:credential.agentId,createdAt:s.h.services().nowIso(),envelope,digest:computeProjectProposalHash(envelope as never)};
 const result=await s.h.api('POST',`/api/tasks/${id}/native/commands`,{token:credential.leaseToken,body:{type:'prepareProposal',record,expectedGeneration:state.generation,idempotencyKey:'raw-source'}});expect(result.status,JSON.stringify(result.body)).toBe(403);expect(result.body.error.code).toBe('mandate_scope_denied');
 });

});
