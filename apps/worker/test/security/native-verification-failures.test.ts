/** Actual Worker/SQLite authorization; historical source seed and capabilities are explicit doubles. */
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, computeProjectManifestHash, computeProjectProposalHash, hashCanonicalSync } from '@commonforge-org/core';
import { signScenarioResult, verifyScenarioRequest } from '@commonforge-org/runner-protocol';
import { SqliteLedgerStore } from '../../src/ledger/sqlite-store.js';
import { putGrant } from '../../src/services/directory.js';
import { harness, ownerWithOrg, member, codeResource, projectWith } from '../helpers.js';

async function fixture() {
  const h = harness(), owner = await ownerWithOrg(h), dev = await member(h, owner, 'developer');
  const source = await codeResource(h, owner, 'source', { 'index.txt': 'historical' });
  const pid = await projectWith(h, owner, [{ mountName: 'source', resourceId: source.resourceId }]);
  const path = `/api/orgs/${owner.orgId}/projects/${pid}/native`, ledger = h.services().ledger(owner.orgId);
  for (const [scopeKind, scopeId] of [['project', pid], ['resource', source.resourceId]] as const) await putGrant(h.services().db, { orgId: owner.orgId, userId: dev.userId, scopeKind, scopeId, operations: ['read'], grantedBy: owner.userId, now: h.services().nowIso() });
  const enabled = await h.api('POST', path + '/enable', { token: owner.token, body: { idempotencyKey: 'enable' } });
  expect(enabled.status).toBe(201);
  const target = enabled.body.state.manifests[0].hash, current = source.revisionId.replace(/[a-f0-9]{40}$/, 'b'.repeat(40));
  await runInDurableObject(ledger, (_instance, ctx) => {
    const store = new SqliteLedgerStore(ctx.storage);
    store.seed({ heads: [{ resourceId: source.resourceId, revisionId: current as never, versionSeq: 2 }] });
    store.transactionSync(tx => {
      const s = JSON.parse(tx.getNativeProjectJson(pid)!);
      s.sourceHeads = [{ resourceId: source.resourceId, revisionId: current }];
      const m = { ...s.manifests[0], id: 'later-source', sequence: 1, parent: target, sourceHeads: s.sourceHeads }; delete m.hash;
      s.manifests.push({ ...m, hash: computeProjectManifestHash(m) });
      tx.putNativeProjectJson(pid, owner.orgId, s.generation, canonicalJson(s));
    });
  });
  h.envOverrides.COMMONFORGE_SCENARIO_RUNNER_URL = 'https://recovery-verifier.example.com';
  return { h, owner, dev, source, pid, path, ledger, target, current };
}

describe('native verification terminal failures and retries',()=>{
 it('persists unestablished failures, refuses false results, and retains error evidence after passing supersession',async()=>{
  const {h,owner,path,pid,ledger,target}=await fixture();
  let state=(await h.api('GET',path,{token:owner.token})).body.state;
  const now=h.services().nowIso(),common={schemaVersion:1,organizationId:owner.orgId,projectId:pid,author:owner.userId,createdAt:now};
  const scenario={...common,id:'required-behavior',revision:1,predecessor:null,title:'Current requirement',given:'Input',when:'Run',then:'Expected',ruleRefs:[],required:true,method:'automated',verifierDigest:'a'.repeat(64),confirmation:null,archived:false};
  state=(await h.api('POST',path+'/commands',{token:owner.token,body:{type:'draftScenario',expectedGeneration:state.generation,idempotencyKey:'draft',record:scenario}})).body.state;
  state=(await h.api('POST',path+'/commands',{token:owner.token,body:{type:'confirmScenario',expectedGeneration:state.generation,idempotencyKey:'confirm',id:scenario.id,revision:1,decisionId:'confirm',explanation:'Current requirement'}})).body.state;
  let mode:'transport'|'invalid'|'error'|'pass'|'correct'='transport',calls=0;
  const original=globalThis.fetch,mock=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    if(!String(input).startsWith('https://recovery-verifier.example.com'))return original(input,init);
    if(String(input).endsWith('/capabilities'))return Response.json({protocolVersion:1,runtimeRecipeDigest:'c'.repeat(64)});
    calls++;if(mode==='transport')throw Error('private source coordinates must not persist');if(mode==='invalid')return Response.json({private:'malformed runner data'});
    const request=await verifyScenarioRequest(JSON.parse(String(init!.body)),h.services().jobKey());
    if(mode==='correct'){
      let s=JSON.parse((await ledger.getNativeProject(pid))!);const at=h.services().nowIso();
      s=JSON.parse(await ledger.nativeCommand(owner.orgId,pid,{type:'draftKnowledge',expectedGeneration:s.generation,idempotencyKey:'during-run-draft',record:{...common,createdAt:at,id:'during-run-correction',revision:1,predecessor:null,kind:'rule',text:'Current corrected rule',rationale:'Correction during dispatch',sources:[],confirmation:null,archived:false}},owner.userId)).state;
      await ledger.nativeCommand(owner.orgId,pid,{type:'confirmKnowledge',expectedGeneration:s.generation,idempotencyKey:'during-run-confirm',id:'during-run-correction',revision:1,decisionId:'during-run-decision',explanation:'Correction persists'},owner.userId);
    }
    const evidence=request.requiredScenarios.map(q=>({...common,id:'ev-'+request.runId,createdAt:request.issuedAt,envelopeDigest:request.envelopeDigest,buildDigest:request.buildDigest,runtimeRecipeDigest:request.runtimeRecipeDigest,scenarioId:q.id,scenarioRevision:q.revision,verifierDigest:q.verifierDigest,method:'automated' as const,result:mode==='error'?'error' as const:'pass' as const,runId:request.runId,actor:'signed-test-runner',startedAt:request.issuedAt,completedAt:request.issuedAt,provenance:'runner-verified' as const,supersedes:null,attachments:[],summary:'Signed protocol double; not actual runner execution'}));
    return Response.json(await signScenarioResult({protocolVersion:1,requestDigest:hashCanonicalSync(request),runId:request.runId,evidence:evidence as never,completedAt:request.issuedAt,execution:'bubblewrap-linux-http',network:'none',controlPlaneMounted:false},h.services().jobKey()));
  });
  try{
    const prepared=await h.api('POST',path+'/recoveries',{token:owner.token,body:{manifestHash:target,expectedGeneration:state.generation,idempotencyKey:'recovery'}});expect(prepared.status).toBe(201);const proposal=prepared.body.proposal;
    const verify=(key:string)=>h.api('POST',`${path}/proposals/${encodeURIComponent(proposal.id)}/verify`,{token:owner.token,body:{idempotencyKey:key}});
    const first=await verify('transport');expect(first.status).toBe(200);expect(first.body).toMatchObject({status:'error',execution:'not-established',evidence:[],failure:{code:'transport_unavailable'}});expect(JSON.stringify(first.body)).not.toContain('private source coordinates');
    mode='pass';const replay=await verify('transport');expect(replay.body.runId).toBe(first.body.runId);expect(replay.body.execution).toBe('not-established');expect(calls).toBe(1);
    mode='invalid';expect((await verify('invalid')).body.failure.code).toBe('result_invalid');
    mode='error';const failed=await verify('candidate-error');expect(failed.body.evidence[0].result).toBe('error');
    mode='pass';const passed=await verify('candidate-retry');expect(passed.body.evidence[0].supersedes).toBe(failed.body.evidence[0].id);expect(passed.body.evidence[0].result).toBe('pass');
    const history=await h.api('GET',`${path}/proposals/${encodeURIComponent(proposal.id)}/verifications?limit=2`,{token:owner.token});expect(history.body.items).toHaveLength(2);expect(history.body.nextCursor).toBe(2);
    const second=await h.api('GET',`${path}/proposals/${encodeURIComponent(proposal.id)}/verifications?limit=2&cursor=2`,{token:owner.token});expect(second.body.items).toHaveLength(2);expect([...history.body.items,...second.body.items].filter(j=>j.execution==='not-established')).toHaveLength(2);
    expect((await ledger.getNativeProject(pid))).toContain(failed.body.evidence[0].id);
    h.envOverrides.COMMONFORGE_SCENARIO_RUNNER_URL='http://invalid-verifier.example.com';
    const noConfiguration=await verify('invalid-configuration');expect(noConfiguration.body.execution).toBe('not-established');expect(noConfiguration.body.failure.code).toBe('transport_unavailable');
    h.envOverrides.COMMONFORGE_SCENARIO_RUNNER_URL='https://recovery-verifier.example.com';
    await runInDurableObject(ledger,(_instance,ctx)=>{const store=new SqliteLedgerStore(ctx.storage);store.transactionSync(tx=>{const s=JSON.parse(tx.getNativeProjectJson(pid)!);s.authorities.push({principalId:'other-task-agent',role:'agent',revision:1,active:true});tx.putNativeProjectJson(pid,owner.orgId,s.generation,canonicalJson(s));});});
    await expect(Promise.resolve(ledger.listNativeVerifications(owner.orgId,pid,'other-task-agent',[proposal.digest],0,50))).rejects.toThrow(/authority_denied/);
    mode='correct';const stale=await verify('correction-during-run');expect(stale.body.status).toBe('stale');expect(stale.body.execution).toBe('bubblewrap-linux-http');expect(stale.body.evidence[0].result).toBe('pass');
    const authoritative=JSON.parse((await ledger.getNativeProject(pid))!);expect(authoritative.evidence.some((e:any)=>e.runId===stale.body.runId)).toBe(false);
    const beforeReplay=calls;const staleReplay=await verify('correction-during-run');expect(staleReplay.body.status).toBe('stale');expect(staleReplay.body.runId).toBe(stale.body.runId);expect(calls).toBe(beforeReplay);

  }finally{mock.mockRestore();}
 });
});
