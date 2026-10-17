import { evictDurableObject } from 'cloudflare:test';
import { describe,expect,it } from 'vitest';
import { acceptFixture } from '@commonforge-org/ledger';
import { harness,ownerWithOrg,projectWith,codeResource } from '../helpers.js';
const root=(org:string,pid:string)=>`/api/orgs/${org}/projects/${pid}/native`;
describe('native project authoritative API',()=>{
 it('enables explicitly, replays and rejects stale competing writers',async()=>{
 const h=harness();const o=await ownerWithOrg(h);const code=await codeResource(h,o,'source',{'index.txt':'synthetic'});const pid=await projectWith(h,o,[{mountName:'source',resourceId:code.resourceId}]);const path=root(o.orgId,pid);
 const before=await h.api('GET',path,{token:o.token});expect(before.body.state).toBeNull();const enabled=await h.api('POST',path+'/enable',{token:o.token,body:{idempotencyKey:'enable'}});expect(enabled.status,JSON.stringify(enabled.body)).toBe(201);expect(enabled.body.state.manifests[0].behavior).toBe('historical-unverified');
 const now=h.services().nowIso();const record={schemaVersion:1,organizationId:o.orgId,projectId:pid,id:'rule',author:o.userId,createdAt:now,revision:1,predecessor:null,kind:'rule',text:'Retain override reasons.',rationale:'Synthetic auditability',sources:[],confirmation:null,archived:false};
 const draft={type:'draftKnowledge',expectedGeneration:0,idempotencyKey:'draft',record};const d=await h.api('POST',path+'/commands',{token:o.token,body:draft});expect(d.status,JSON.stringify(d.body)).toBe(200);const replay=await h.api('POST',path+'/commands',{token:o.token,body:draft});expect(replay.body.replayed).toBe(true);
 const confirmation={type:'confirmKnowledge',expectedGeneration:1,idempotencyKey:'confirm',id:'rule',revision:1,decisionId:'decision',explanation:'Owner confirmed'};
 const a=await h.api('POST',path+'/commands',{token:o.token,body:confirmation});const b=await h.api('POST',path+'/commands',{token:o.token,body:{...confirmation,idempotencyKey:'competing',decisionId:'other'}});expect([a.status,b.status].sort()).toEqual([200,409]);
 const winner=a.status===200?a:b;expect(winner.body.state.manifests.at(-1).behavior).toBe('outstanding');const persisted=await h.api('GET',path,{token:o.token});expect(persisted.body.state.knowledge).toHaveLength(2);expect(persisted.body.state.knowledgeHead).toBe(winner.body.state.knowledgeHead);
 const oldApi=await h.api('POST',`/api/orgs/${o.orgId}/resources/${code.resourceId}/restore`,{token:o.token,body:{expectedHead:code.revisionId,targetRevision:code.revisionId,idempotencyKey:'legacy-restore'}});expect(oldApi.status).toBe(409);expect(oldApi.body.error.code).toBe('project_mode_unsupported');
 const legacy=acceptFixture({organizationId:o.orgId,projectId:pid,resources:[code.resourceId],policyRevision:0});await h.services().ledger(o.orgId).putProposal(legacy.proposal);await expect(Promise.resolve(h.services().ledger(o.orgId).accept(legacy.input))).rejects.toThrow(/project_mode_unsupported/);
 const bind=await h.api('POST',`/api/orgs/${o.orgId}/resources/${code.resourceId}/adopt-head`,{token:o.token});expect(bind.status).toBe(409);expect(bind.body.error.code).toBe('project_mode_unsupported');
 });
 it('rejects enablement with an in-flight task',async()=>{
 const {provisionedTask}=await import('../helpers.js');const h=harness();const t=await provisionedTask(h);const enabled=await h.api('POST',root(t.o.orgId,t.pid)+'/enable',{token:t.o.token,body:{idempotencyKey:'enable'}});expect(enabled.status).toBe(409);expect(enabled.body.error.code).toBe('project_mode_unsupported');
 });
 it('confirmed knowledge survives durable object eviction without a pending source outbox',async()=>{
 const h=harness();const o=await ownerWithOrg(h);const pid=await projectWith(h,o,[]);const path=root(o.orgId,pid);
 expect((await h.api('POST',path+'/enable',{token:o.token,body:{idempotencyKey:'enable-empty'}})).status).toBe(201);
 const record={schemaVersion:1,organizationId:o.orgId,projectId:pid,id:'rule',author:o.userId,createdAt:h.services().nowIso(),revision:1,predecessor:null,kind:'rule',text:'Retain reasons.',rationale:'Continuity',sources:[],confirmation:null,archived:false};
 expect((await h.api('POST',path+'/commands',{token:o.token,body:{type:'draftKnowledge',expectedGeneration:0,idempotencyKey:'draft-empty',record}})).status).toBe(200);
 const confirmed=await h.api('POST',path+'/commands',{token:o.token,body:{type:'confirmKnowledge',expectedGeneration:1,idempotencyKey:'confirm-empty',id:'rule',revision:1,decisionId:'confirm',explanation:'Confirmed'}});expect(confirmed.status).toBe(200);
 await evictDurableObject(h.services().ledger(o.orgId));
 const restored=await h.api('GET',path,{token:o.token});expect(restored.body.state.knowledgeHead).toBe(confirmed.body.state.knowledgeHead);expect(restored.body.state.knowledge).toEqual(confirmed.body.state.knowledge);
 });

});

it('round-trips native history through the API without importing authority or confirmed requirements',async()=>{
 const h=harness(),o=await ownerWithOrg(h),pid=await projectWith(h,o,[]),path=`/api/orgs/${o.orgId}/projects/${pid}/native`;
 await h.api('POST',path+'/enable',{token:o.token,body:{idempotencyKey:'enable-portable'}});
 let state=(await h.api('GET',path,{token:o.token})).body.state;
 const draft={schemaVersion:1,organizationId:o.orgId,projectId:pid,id:'portable-rule',author:o.userId,createdAt:h.services().nowIso(),revision:1,predecessor:null,kind:'rule',text:'Retain every override reason.',rationale:'Synthetic portable requirement',sources:[],confirmation:null,archived:false};
 state=(await h.api('POST',path+'/commands',{token:o.token,body:{type:'draftKnowledge',record:draft,expectedGeneration:state.generation,idempotencyKey:'portable-draft'}})).body.state;
 state=(await h.api('POST',path+'/commands',{token:o.token,body:{type:'confirmKnowledge',id:draft.id,revision:1,decisionId:'portable-confirm',explanation:'Owner confirms portable requirement',expectedGeneration:state.generation,idempotencyKey:'portable-confirm'}})).body.state;
 const exported=await h.api('GET',path+'/bundle?includePayloads=1',{token:o.token});expect(exported.status).toBe(200);expect(exported.body.bundle.history.knowledge).toHaveLength(2);
 const imported=await h.api('POST',`/api/orgs/${o.orgId}/native/import`,{token:o.token,body:{name:'Imported understanding',idempotencyKey:'portable-import',bundle:exported.body.bundle}});expect(imported.status,JSON.stringify(imported.body)).toBe(201);
 expect(imported.body.requiresLocalConfirmation).toBe(true);expect(imported.body.state.knowledge).toHaveLength(1);expect(imported.body.state.knowledge[0].confirmation).toBeNull();expect(imported.body.state.decisions).toHaveLength(0);expect(imported.body.state.evidence).toHaveLength(0);expect(imported.body.state.sourceHeads).toHaveLength(0);
 const roundtrip=await h.api('GET',`/api/orgs/${o.orgId}/projects/${imported.body.projectId}/native/bundle`,{token:o.token});expect(roundtrip.status).toBe(200);expect(roundtrip.body.importedHistory).toEqual(exported.body.bundle);expect(roundtrip.body.bundle.completeness.completeBackup).toBe(false);
});

it('serializes simultaneous confirmations so exactly one stale-generation writer wins',async()=>{
 const h=harness();const o=await ownerWithOrg(h);const pid=await projectWith(h,o,[]);const path=root(o.orgId,pid);expect((await h.api('POST',path+'/enable',{token:o.token,body:{idempotencyKey:'enable-concurrent'}})).status).toBe(201);
 const record={schemaVersion:1,organizationId:o.orgId,projectId:pid,id:'concurrent-rule',author:o.userId,createdAt:h.services().nowIso(),revision:1,predecessor:null,kind:'rule',text:'One confirmed revision.',rationale:'Concurrent CAS',sources:[],confirmation:null,archived:false};expect((await h.api('POST',path+'/commands',{token:o.token,body:{type:'draftKnowledge',record,expectedGeneration:0,idempotencyKey:'draft-concurrent'}})).status).toBe(200);
 const [a,b]=await Promise.all(['left','right'].map(side=>h.api('POST',path+'/commands',{token:o.token,body:{type:'confirmKnowledge',id:record.id,revision:1,decisionId:side,explanation:'Concurrent confirmation',expectedGeneration:1,idempotencyKey:side}})));
 expect([a!.status,b!.status].sort()).toEqual([200,409]);const state=(await h.api('GET',path,{token:o.token})).body.state;expect(state.knowledge).toHaveLength(2);expect(state.generation).toBe(2);expect(state.manifests).toHaveLength(2);
 });
