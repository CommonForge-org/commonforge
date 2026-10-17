import { describe,expect,it } from 'vitest';
import { computeProjectManifestHash,computeProjectProposalHash,createProjectState,type ProjectState } from '@commonforge-org/core';
import { scenarioBuildDigest } from '@commonforge-org/runner-protocol';
import { assertNativeRelease,nativeBindingStatement,nativeReleaseObservation,nativeReleaseSubject,nativeRuntimeRecipeDigest,presentNativeRelease } from '../../src/services/native-release.js';
import { deployRelease,prepareRelease,type ReleaseRow } from '../../src/services/releases.js';
import { harness,provisionedTask,waitUntil } from '../helpers.js';
import { orgKv,releasePolicy } from '../release-fixtures.js';
const now='2026-10-17T12:00:00.000Z';
const source={resourceId:'source',revisionId:'opaque-git-revision'};
const recipe={revision:1,steps:[]};
const environment={targets:[],environment:{},healthCheck:null,accountId:'synthetic-account'};
function fixture():ProjectState {
 const s=createProjectState('org','project');s.sourceHeads=[source];s.policyRevision=1;s.authorities=[{principalId:'owner',role:'owner',revision:1,active:true}];
 const e={domain:'cf.project-proposal/1' as const,schemaVersion:1 as const,organizationId:s.organizationId,projectId:s.projectId,outcome:null,attemptId:'attempt',mandateId:'mandate',mandateRevision:1,contextDigest:'a'.repeat(64),innerProposalId:'inner',innerProposalHash:'b'.repeat(64),sourceHeads:[source],runtimeRecipeDigest:nativeRuntimeRecipeDigest(recipe,environment),buildDigest:scenarioBuildDigest([source]),expectedParent:null,expectedKnowledgeHead:s.knowledgeHead,policyRevision:1,proposedKnowledge:[],proposedScenarios:[],requiredScenarios:[],recovery:null,effects:[]};
 s.proposals.push({schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id:'proposal',author:'owner',createdAt:now,envelope:e,digest:computeProjectProposalHash(e)});
 const m={schemaVersion:1 as const,organizationId:s.organizationId,projectId:s.projectId,id:'manifest',author:'owner',createdAt:now,sequence:0,parent:null,sourceHeads:[source],knowledgeHead:s.knowledgeHead,knowledgeGeneration:0,envelopeDigest:s.proposals[0]!.digest,decisionId:'decision',evidenceIds:[],behavior:'verified' as const};s.manifests.push({...m,hash:computeProjectManifestHash(m)});return s;
}
describe('native release identity and observation',()=>{
 it('binds accepted manifest, exact sources and runtime separately from deployment outputs',()=>{
 const s=fixture();const b=nativeReleaseSubject(s,{source:source.revisionId},recipe,environment);expect(b.manifestHash).toBe(s.manifests[0]!.hash);expect(b.verifiedSourceDigest).toBe(scenarioBuildDigest([source]));expect(b.runtimeRecipeDigest).toBe(nativeRuntimeRecipeDigest(recipe,environment));
 expect(()=>nativeReleaseSubject(s,{source:'changed'},recipe,environment)).toThrow(/sources/);expect(()=>nativeReleaseSubject(s,{source:source.revisionId},{...recipe,revision:2},environment)).toThrow(/runtime/);expect(()=>nativeReleaseSubject(s,{source:source.revisionId},recipe,{...environment,accountId:'other'})).toThrow(/runtime/);
 });
 it('refuses historical genesis, knowledge outstanding, changed policy and stale knowledge',()=>{
 for(const behavior of ['outstanding','historical-unverified'] as const){const s=fixture();s.manifests[0]!.behavior=behavior;expect(()=>nativeReleaseSubject(s,{source:source.revisionId},recipe,environment)).toThrow(/verified accepted/);}
 const stale=fixture();stale.knowledgeHead='e'.repeat(64);expect(()=>nativeReleaseSubject(stale,{source:source.revisionId},recipe,environment)).toThrow(/current knowledge/);const changed=fixture();changed.policyRevision++;expect(()=>nativeReleaseSubject(changed,{source:source.revisionId},recipe,environment)).toThrow(/policy/);
 });
 it('allows separately verified accepted recovery, while no-inner metadata cannot release source',()=>{
 const s=fixture(),p=s.proposals[0]!,m=s.manifests[0]!;
 p.envelope={...p.envelope,innerProposalId:null,innerProposalHash:null,attemptId:null,mandateId:null,mandateRevision:null,contextDigest:null,recovery:{manifestHash:'c'.repeat(64),planDigest:'d'.repeat(64)}};
 p.digest=computeProjectProposalHash(p.envelope);m.envelopeDigest=p.digest;const {hash,...content}=m;m.hash=computeProjectManifestHash(content);
 expect(nativeReleaseSubject(s,{source:source.revisionId},recipe,environment).manifestHash).toBe(m.hash);
 p.envelope.recovery=null;p.digest=computeProjectProposalHash(p.envelope);m.envelopeDigest=p.digest;
 expect(()=>nativeReleaseSubject(s,{source:source.revisionId},recipe,environment)).toThrow(/accepted source proposal/);
 });
 it('records actual deployment output identity and expires health after five minutes',async()=>{
 const h=harness();let clock=new Date(now);h.deps.now=()=>clock;const s=fixture();const b=nativeReleaseSubject(s,{source:source.revisionId},recipe,environment);
 const rel={release_id:'release',org_id:'org',project_id:'project',sources_json:JSON.stringify({source:source.revisionId}),recipe_json:JSON.stringify(recipe),environment_json:JSON.stringify(environment),output_digest:'f'.repeat(64),deploy_attempts:1,health_json:JSON.stringify({ok:true,checkedAt:now,targets:[{targetId:'api',ok:true}]})} as ReleaseRow;
 const observation=nativeReleaseObservation(rel,b,{ok:true,checkedAt:now,targets:[{targetId:'api',ok:true}]},now);expect(observation.buildDigest).toBe(rel.output_digest);expect(observation.manifestHash).toBe(b.manifestHash);expect(observation.summary).toContain('source scenario evidence is separate');
 // No real release is inserted here: test presentation via an isolated SELECT dependency.
 const svc=h.services();const original=svc.db;svc.db={prepare:()=>({bind:()=>({first:async()=>({manifest_hash:b.manifestHash,envelope_digest:b.envelopeDigest,verified_source_digest:b.verifiedSourceDigest,runtime_recipe_digest:b.runtimeRecipeDigest,sources_json:JSON.stringify(b.sources)})})})} as unknown as D1Database;
 expect((await presentNativeRelease(svc,rel)).healthState).toBe('healthy');clock=new Date(Date.parse(now)+300000);expect((await presentNativeRelease(svc,rel)).healthState).toBe('unknown');svc.db=original;
 });
 it('refuses publishing/deploying a legacy-prepared release after native enablement',async()=>{
 const h=harness();const {o,pid,runner}=await provisionedTask(h);const kv=await orgKv(h,o);expect((await h.api('PUT',`/api/orgs/${o.orgId}/projects/${pid}/policy`,{token:o.token,body:{release:releasePolicy(o.orgId,kv)}})).status).toBe(200);
 const prepared=await h.api('POST',`/api/orgs/${o.orgId}/projects/${pid}/releases`,{token:o.token,body:{}});expect(prepared.status,JSON.stringify(prepared.body)).toBe(202);await waitUntil(async()=>(await h.api('GET',`/api/orgs/${o.orgId}/releases/${prepared.body.releaseId}`,{token:o.token})).body.buildState!=='building');
 const svc=h.services();const mounts=await svc.db.prepare('SELECT resource_id FROM mounts WHERE org_id = ? AND project_id = ?').bind(o.orgId,pid).all<{resource_id:string}>();const heads=[];for(const m of mounts.results){const head=await svc.ledger(o.orgId).getHead(m.resource_id);if(head)heads.push({resourceId:m.resource_id,revisionId:head.revisionId});}
 const project=await svc.db.prepare('SELECT policy_revision FROM projects WHERE org_id = ? AND project_id = ?').bind(o.orgId,pid).first<{policy_revision:number}>();await svc.ledger(o.orgId).enableNativeProject({organizationId:o.orgId,projectId:pid,actorId:o.userId,policyRevision:project!.policy_revision,sourceHeads:heads,authorities:[{principalId:o.userId,role:'owner',revision:1,active:true}]});
 const pub=await h.api('POST',`/api/orgs/${o.orgId}/releases/${prepared.body.releaseId}/publish-approvals`,{token:o.token,body:{outputDigest:(await h.api('GET',`/api/orgs/${o.orgId}/releases/${prepared.body.releaseId}`,{token:o.token})).body.outputDigest}});expect(pub.status).toBe(409);expect(pub.body.error.code).toBe('project_mode_unsupported');
 const deploy=await h.api('POST',`/api/orgs/${o.orgId}/releases/${prepared.body.releaseId}/deploy`,{token:o.token,body:{idempotencyKey:'old-release-deploy'}});expect(deploy.status).toBe(409);expect(deploy.body.error.code).toBe('project_mode_unsupported');expect(runner.handled.some(j=>j.job.kind==='release-deploy')).toBe(false);
 const next=await h.api('POST',`/api/orgs/${o.orgId}/projects/${pid}/releases`,{token:o.token,body:{}});expect(next.status).toBe(409);expect(next.body.error.code).toBe('scenario_evidence_missing');
 });
});
