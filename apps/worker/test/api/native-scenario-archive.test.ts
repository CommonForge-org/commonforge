/** Actual Worker/SQLite persistence; no source provider/runner execution is claimed. */
import { evictDurableObject } from 'cloudflare:test';
import { describe,it,expect } from 'vitest';
import { currentConfirmed } from '@commonforge-org/core';
import { harness,ownerWithOrg,projectWith } from '../helpers.js';
describe('native scenario archive API',()=>{
 it('persists a distinct archival revision and stale-evidence knowledge head across eviction',async()=>{
  const h=harness(),owner=await ownerWithOrg(h),pid=await projectWith(h,owner,[]),root=`/api/orgs/${owner.orgId}/projects/${pid}/native`;
  let response=await h.api('POST',root+'/enable',{token:owner.token,body:{idempotencyKey:'enable-archive'}});expect(response.status).toBe(201);let state=response.body.state;
  const record={schemaVersion:1,organizationId:owner.orgId,projectId:pid,id:'retired-example',author:owner.userId,createdAt:h.services().nowIso(),revision:1,predecessor:null,title:'Old manual example',given:'Synthetic input',when:'Requested',then:'Observed outcome',ruleRefs:[],required:true,method:'manual',verifierDigest:'a'.repeat(64),confirmation:null,archived:false};
  for(const body of [{type:'draftScenario',record},{type:'confirmScenario',id:record.id,revision:1,decisionId:'confirm-example',explanation:'Owner confirmed'}]){
   response=await h.api('POST',root+'/commands',{token:owner.token,body:{...body,expectedGeneration:state.generation,idempotencyKey:body.type}});expect(response.status,JSON.stringify(response.body)).toBe(200);state=response.body.state;
  }
  const prior=state.knowledgeHead;
  const archive={type:'archiveScenario',id:record.id,revision:2,decisionId:'archive-example',explanation:'Behavioral requirement retired deliberately',expectedGeneration:state.generation,idempotencyKey:'archive-example'};
  response=await h.api('POST',root+'/commands',{token:owner.token,body:archive});expect(response.status,JSON.stringify(response.body)).toBe(200);
  expect(response.body.state.knowledgeHead).not.toBe(prior);expect(response.body.state.manifests.at(-1).behavior).toBe('outstanding');
  await evictDurableObject(h.services().ledger(owner.orgId));
  const reloaded=await h.api('GET',root,{token:owner.token});expect(reloaded.status).toBe(200);
  expect(reloaded.body.state.scenarios).toHaveLength(3);expect(reloaded.body.state.scenarios.at(-1)).toMatchObject({revision:3,archived:true,confirmation:{actor:owner.userId,decisionId:'archive-example'}});
  expect(currentConfirmed(reloaded.body.state.scenarios)).toEqual([]);
  const retry=await h.api('POST',root+'/commands',{token:owner.token,body:archive});expect(retry.status).toBe(200);expect(retry.body.replayed).toBe(true);expect(retry.body.state.scenarios).toHaveLength(3);
 });
});
