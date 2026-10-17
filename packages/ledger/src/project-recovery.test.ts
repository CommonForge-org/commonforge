import { describe,it,expect } from 'vitest';
import { createProjectState, computeProjectProposalHash, type ProjectState, type ProjectProposalEnvelope } from '@commonforge-org/core';
import { applyProjectCommand, createNativeGenesis, planProjectAccept } from './project.js';
import { projectRecoveryPlanDigest, validateProjectRecovery } from './project-recovery.js';
import { InMemoryLedgerStore } from './memory-store.js';
import { applyWrites } from './apply-writes.js';
import { fixtureRev, FIXTURE_TIME } from './fixtures.js';
const now=FIXTURE_TIME.now,actor={actorId:'owner',now},hash='a'.repeat(64);
const old=fixtureRev('r1','old'),current=fixtureRev('r1','current');
function run(s:ProjectState,type:string,extra:Record<string,unknown>){return applyProjectCommand(s,{type,expectedGeneration:s.generation,idempotencyKey:type+':'+s.generation,...extra},actor).state;}
function fixture(method:'automated'|'manual'='automated'){
 const store=new InMemoryLedgerStore();store.seed({heads:[{organizationId:'org-1',resourceId:'r1',revisionId:old,versionSeq:1},{resourceId:'r1',revisionId:current,versionSeq:2}]});
 let s=createProjectState('org-1','proj-1');s.authorities=[{principalId:'owner',role:'owner',revision:1,active:true}];s.sourceHeads=[{resourceId:'r1',revisionId:old}];s=createNativeGenesis(s,actor);const target=s.manifests[0]!.hash;s.sourceHeads=[{resourceId:'r1',revisionId:current}];
 s=run(s,'draftScenario',{record:{schemaVersion:1,organizationId:'org-1',projectId:'proj-1',id:'current-check',author:'owner',createdAt:now,revision:1,predecessor:null,title:'Current rule',given:'Input',when:'Requested',then:'Expected',ruleRefs:[],required:true,method,verifierDigest:hash,confirmation:null,archived:false}});
 s=run(s,'confirmScenario',{id:'current-check',revision:1,decisionId:'confirm-current',explanation:'Current requirements survive recovery'});
 const envelope:ProjectProposalEnvelope={domain:'cf.project-proposal/1',schemaVersion:1,organizationId:'org-1',projectId:'proj-1',outcome:null,attemptId:null,mandateId:null,mandateRevision:null,contextDigest:null,innerProposalId:null,innerProposalHash:null,sourceHeads:[{resourceId:'r1',revisionId:old}],runtimeRecipeDigest:hash,buildDigest:hash,expectedParent:s.manifests.at(-1)!.hash,expectedKnowledgeHead:s.knowledgeHead,policyRevision:0,proposedKnowledge:[],proposedScenarios:[],requiredScenarios:[{id:'current-check',revision:2,verifierDigest:hash,method}],recovery:{manifestHash:target,planDigest:projectRecoveryPlanDigest(s,target)},effects:[]};
 const proposal={schemaVersion:1 as const,organizationId:'org-1',projectId:'proj-1',id:'recovery',author:'owner',createdAt:now,envelope,digest:computeProjectProposalHash(envelope)};s=run(s,'prepareProposal',{record:proposal});
 s=run(s,'recordDecision',{record:{schemaVersion:1,organizationId:'org-1',projectId:'proj-1',id:'approve',author:'owner',createdAt:now,envelopeDigest:proposal.digest,innerProposalHash:null,action:'approve',explanation:'Exact old artifacts under current rules',authorityRevision:1}});
 const command={type:'accept',proposalId:proposal.id,decisionId:'approve',expectedGeneration:s.generation,idempotencyKey:'accept-recovery'};
 const evidence={schemaVersion:1,organizationId:'org-1',projectId:'proj-1',id:'fresh',author:'owner',createdAt:now,envelopeDigest:proposal.digest,buildDigest:hash,runtimeRecipeDigest:hash,scenarioId:'current-check',scenarioRevision:2,verifierDigest:hash,method:'automated',result:'pass',runId:'new-run',actor:'trusted',startedAt:now,completedAt:now,provenance:'runner-verified',supersedes:null,attachments:[],summary:'Independent verifier fixture'};
 return {store,s,proposal,command,evidence};
}
describe('native exact historical recovery',()=>{
 it('requires fresh complete current evidence and never treats recovery as metadata-only acceptance',()=>{const f=fixture();expect(()=>f.store.transactionSync(tx=>planProjectAccept(tx,f.s,f.command,actor))).toThrow(/passing evidence/);expect(()=>applyProjectCommand(f.s,f.command,actor)).toThrow(/passing evidence/);});
 it('atomically restores exact old refs while retaining current knowledge and replays accepted version',()=>{
 const f=fixture();const s=applyProjectCommand(f.s,{type:'recordEvidence',record:f.evidence,expectedGeneration:f.s.generation,idempotencyKey:'verified'},{...actor,trustedRunner:{runnerId:'trusted'}}).state;const command={...f.command,expectedGeneration:s.generation};
 const result=f.store.transactionSync(tx=>{const r=planProjectAccept(tx,s,command,actor);applyWrites(tx,r.artifactWrites);return r;});expect(result.state.sourceHeads[0]!.revisionId).toBe(old);expect(result.state.knowledgeHead).toBe(s.knowledgeHead);expect(result.state.scenarios).toEqual(s.scenarios);expect(result.state.manifests.at(-1)?.behavior).toBe('verified');expect(result.state.manifests.at(-1)?.evidenceIds).toEqual(['fresh']);expect(f.store.transactionSync(tx=>tx.getHead('r1' as never)?.revisionId)).toBe(old);expect(f.store.transactionSync(tx=>tx.getLatestAcceptedVersion('org-1')?.kind)).toBe('restore');
 const replay=f.store.transactionSync(tx=>planProjectAccept(tx,result.state,command,actor));expect(replay.replayed).toBe(true);expect(replay.acceptedVersionId).toBe(result.acceptedVersionId);expect(replay.artifactWrites).toEqual([]);
 });
 it('refuses stale artifact heads, unknown historical artifact refs and candidate-invented plan hashes',()=>{
 const f=fixture();const s=applyProjectCommand(f.s,{type:'recordEvidence',record:f.evidence,expectedGeneration:f.s.generation,idempotencyKey:'verified'},{...actor,trustedRunner:{runnerId:'trusted'}}).state;
 f.store.seed({heads:[{resourceId:'r1',revisionId:fixtureRev('r1','other'),versionSeq:3}]});expect(()=>f.store.transactionSync(tx=>planProjectAccept(tx,s,{...f.command,expectedGeneration:s.generation},actor))).toThrow(/head changed/);
 const bad={...f.proposal,envelope:{...f.proposal.envelope,recovery:{...f.proposal.envelope.recovery!,planDigest:'b'.repeat(64)}}};bad.digest=computeProjectProposalHash(bad.envelope);expect(()=>run({...f.s,proposals:[]},'prepareProposal',{record:bad})).toThrow(/plan/);
 });
 it('requires current manual observation for manual recovery scenarios',()=>{
  const f=fixture('manual');expect(()=>f.store.transactionSync(tx=>planProjectAccept(tx,f.s,f.command,actor))).toThrow(/passing evidence/);
  const evidence={...f.evidence,method:'manual',actor:'owner',provenance:'human-attested',summary:'Owner inspected exact historical build under current rule'};
  const s=applyProjectCommand(f.s,{type:'recordEvidence',record:evidence,expectedGeneration:f.s.generation,idempotencyKey:'manual'},actor).state;
  const result=f.store.transactionSync(tx=>planProjectAccept(tx,s,{...f.command,expectedGeneration:s.generation},actor));expect(result.state.manifests.at(-1)?.evidenceIds).toEqual(['fresh']);
 });
 it('refuses declared effects in the target or intervening accepted history and changed source membership',()=>{
  const f=fixture();const source={...f.proposal,envelope:{...f.proposal.envelope,recovery:null,effects:['External notification already sent']}};source.digest=computeProjectProposalHash(source.envelope);
  for(const index of [0,f.s.manifests.length-1]){
   const s=structuredClone(f.s);s.proposals.push({...source,id:'effect-source'});s.manifests[index]!.envelopeDigest=source.digest;
   expect(()=>validateProjectRecovery(s,f.proposal.envelope)).toThrow(/external effects/);
  }
  const s=structuredClone(f.s);s.sourceHeads.push({resourceId:'new-resource',revisionId:'new-revision'});expect(()=>validateProjectRecovery(s,f.proposal.envelope)).toThrow(/membership/);
 });

});
