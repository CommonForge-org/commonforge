/** Real Worker/D1/SQLite authority; source and runner transports are explicit test doubles. */
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { FakeRunner } from '../fakes/runner.js';
import { harness, ownerWithOrg, codeResource, projectWith } from '../helpers.js';

async function setup() {
  const h=harness();new FakeRunner(h);const o=await ownerWithOrg(h);
  const resource=await codeResource(h,o,'source',{'index.txt':'synthetic'});
  const pid=await projectWith(h,o,[{mountName:'source',resourceId:resource.resourceId}]);
  const path=`/api/orgs/${o.orgId}/projects/${pid}/native`;
  expect((await h.api('POST',path+'/enable',{token:o.token,body:{idempotencyKey:'enable'}})).status).toBe(201);
  const task=await h.api('POST',`/api/orgs/${o.orgId}/projects/${pid}/tasks`,{token:o.token,body:{title:'Bounded renewal',writeMounts:['source']}});
  await h.drainSteps();const taskId=task.body.taskId as string;
  const handoff=await h.api('POST',`/api/tasks/${taskId}/native/handoff`,{token:o.token,body:{agentId:'first-agent'}});
  const initial=await h.api('POST','/api/auth/task/verify',{body:{code:handoff.body.code}});expect(initial.status).toBe(200);
  const state=async()=>(await h.api('GET',path,{token:o.token})).body.state;
  const renewal=async(key='renew-1')=>({mandateId:initial.body.mandateId,revision:1,expectedGeneration:(await state()).generation,idempotencyKey:key,agentId:'replacement-agent'});
  return {h,o,pid,path,taskId,initial:initial.body,state,renewal};
}
describe('explicit bounded replacement renewal',()=>{
 it('renews into a fresh usable attempt/context, leaves prior authority revoked, and replays only unconsumed issuance',async()=>{
  const s=await setup(),ledger=s.h.services().ledger(s.o.orgId);
  const later=new Date(Date.now()+1800000).toISOString();
  await runInDurableObject(ledger,(instance)=>{instance.clockForTests=()=>later;});s.h.deps.now=()=>new Date(later);
  const state=await s.state();
  const rule={schemaVersion:1,organizationId:s.o.orgId,projectId:s.pid,id:'correction',revision:1,predecessor:null,author:s.o.userId,createdAt:later,kind:'rule',text:'Managers must retain a nonempty override reason.',rationale:'Persist the correction.',sources:[],confirmation:null,archived:false};
  const draft=await s.h.api('POST',s.path+'/commands',{token:s.o.token,body:{type:'draftKnowledge',record:rule,expectedGeneration:state.generation,idempotencyKey:'draft'}});expect(draft.status,JSON.stringify(draft.body)).toBe(200);
  const confirm=await s.h.api('POST',s.path+'/commands',{token:s.o.token,body:{type:'confirmKnowledge',id:rule.id,revision:1,decisionId:'confirm',explanation:'Owner correction',expectedGeneration:draft.body.state.generation,idempotencyKey:'confirm'}});expect(confirm.status).toBe(200);
  const body=await s.renewal();
  const [a,b]=await Promise.all([s.h.api('POST',`/api/tasks/${s.taskId}/native/renew`,{token:s.o.token,body}),s.h.api('POST',`/api/tasks/${s.taskId}/native/renew`,{token:s.o.token,body})]);
  expect([a.status,b.status].sort()).toEqual([200,201]);expect(a.body.code).toBe(b.body.code);expect(a.body.requiresFreshCheckout).toBe(true);
  expect((await s.h.api('GET',`/api/tasks/${s.taskId}/native/context`,{token:s.initial.leaseToken})).status).not.toBe(200);
  const changed=await s.h.api('POST',`/api/tasks/${s.taskId}/native/renew`,{token:s.o.token,body:{...body,agentId:'different'}});expect(changed.status).toBe(409);expect(changed.body.error.code).toBe('idempotency_conflict');
  const [one,two]=await Promise.all([s.h.api('POST','/api/auth/task/verify',{body:{code:a.body.code}}),s.h.api('POST','/api/auth/task/verify',{body:{code:a.body.code}})]);
  expect([one.status,two.status].sort()).toEqual([200,401]);const next=one.status===200?one:two;
  expect(next.body.attemptId).not.toBe(s.initial.attemptId);expect(next.body.mandateId).not.toBe(s.initial.mandateId);expect(next.body.context.digest).not.toBe(s.initial.context.digest);
  expect(next.body.context.packet.rules[0].text).toBe(rule.text);
  expect(Date.parse(next.body.expiresAt)-Date.parse(later)).toBe(3600000);
  expect(Date.parse(next.body.expiresAt)).toBeGreaterThan(Date.parse(s.initial.expiresAt));
  const beyondOld=new Date(Date.parse(s.initial.expiresAt)+1000).toISOString();
  await runInDurableObject(ledger,(instance)=>{instance.clockForTests=()=>beyondOld;});s.h.deps.now=()=>new Date(beyondOld);
  expect((await s.h.api('GET',`/api/tasks/${s.taskId}/native/context`,{token:next.body.leaseToken})).status).toBe(200);
  const consumed=await s.h.api('POST',`/api/tasks/${s.taskId}/native/renew`,{token:s.o.token,body});expect(consumed.status).toBe(409);
  const final=await s.state();expect(final.mandates.filter((m:{id:string})=>m.id===s.initial.mandateId).at(-1).revokedAt).not.toBeNull();expect(final.attempts.find((a:{id:string})=>a.id===s.initial.attemptId).status).toBe('revoked');
 });
 it('rejects public in-place renewal, agent-issued renewal, and stale competing issuance',async()=>{
  const s=await setup(),state=await s.state();
  const raw=await s.h.api('POST',s.path+'/commands',{token:s.o.token,body:{type:'renewMandate',id:s.initial.mandateId,revision:1,expiresAt:'2099-01-01T00:00:00Z',expectedGeneration:state.generation,idempotencyKey:'invalid-inplace'}});expect(raw.status).toBe(409);expect(raw.body.error.code).toBe('project_mode_unsupported');
  const body=await s.renewal();expect((await s.h.api('POST',`/api/tasks/${s.taskId}/native/renew`,{token:s.initial.leaseToken,body})).status).toBe(403);
  const [a,b]=await Promise.all([s.h.api('POST',`/api/tasks/${s.taskId}/native/renew`,{token:s.o.token,body}),s.h.api('POST',`/api/tasks/${s.taskId}/native/renew`,{token:s.o.token,body:{...body,idempotencyKey:'other'}})]);expect([a.status,b.status].sort()).toEqual([201,409]);
  const winner=a.status===201?a:b;expect((await s.h.api('POST','/api/auth/task/verify',{body:{code:winner.body.code}})).status).toBe(200);
 });
 it('can replace expired authority but cannot request an unbounded expiry or another task mandate',async()=>{
  const s=await setup(),ledger=s.h.services().ledger(s.o.orgId);
  const afterExpiry=new Date(Date.parse(s.initial.expiresAt)+1000).toISOString();
  await runInDurableObject(ledger,(instance)=>{instance.clockForTests=()=>afterExpiry;});s.h.deps.now=()=>new Date(afterExpiry);
  const body=await s.renewal();
  const unbounded=await s.h.api('POST',`/api/tasks/${s.taskId}/native/renew`,{token:s.o.token,body:{...body,expiresAt:'2099-01-01T00:00:00Z'}});expect(unbounded.status).toBe(400);
  const another=await s.h.api('POST',`/api/orgs/${s.o.orgId}/projects/${s.pid}/tasks`,{token:s.o.token,body:{title:'Different task',writeMounts:['source']}});await s.h.drainSteps();
  const wrong=await s.h.api('POST',`/api/tasks/${another.body.taskId}/native/renew`,{token:s.o.token,body});expect(wrong.status).toBe(409);
  const replacement=await s.h.api('POST',`/api/tasks/${s.taskId}/native/renew`,{token:s.o.token,body});expect(replacement.status,JSON.stringify(replacement.body)).toBe(201);
  const exchanged=await s.h.api('POST','/api/auth/task/verify',{body:{code:replacement.body.code}});expect(exchanged.status).toBe(200);
  expect(Date.parse(exchanged.body.expiresAt)-Date.parse(afterExpiry)).toBe(3600000);
  expect((await s.h.api('GET',`/api/tasks/${s.taskId}/native/context`,{token:exchanged.body.leaseToken})).status).toBe(200);
 });
 it('concurrent exchange of the initial handoff creates exactly one usable task lease',async()=>{
  const s=await setup();const issued=await s.h.api('POST',`/api/tasks/${s.taskId}/native/handoff`,{token:s.o.token,body:{agentId:'concurrent'}});
  const results=await Promise.all(Array.from({length:4},()=>s.h.api('POST','/api/auth/task/verify',{body:{code:issued.body.code}})));
  expect(results.filter(r=>r.status===200)).toHaveLength(1);expect(results.filter(r=>r.status===401)).toHaveLength(3);
  const good=results.find(r=>r.status===200)!;expect((await s.h.api('GET',`/api/tasks/${s.taskId}/native/context`,{token:good.body.leaseToken})).status).toBe(200);
 });
});
