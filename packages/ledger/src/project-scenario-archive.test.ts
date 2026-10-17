import { describe,it,expect } from 'vitest';
import { createProjectState,currentConfirmed,computeProjectProposalHash,type ProjectState,type ProjectProposalEnvelope } from '@commonforge-org/core';
import { applyProjectCommand,createNativeGenesis } from './project.js';
const now='2026-10-17T12:00:00.000Z',digest='a'.repeat(64),actor={actorId:'owner',now};
function run(s:ProjectState,type:string,fields:Record<string,unknown>){return applyProjectCommand(s,{type,expectedGeneration:s.generation,idempotencyKey:`${type}:${s.generation}`,...fields},actor).state;}
function confirmed(){
 let s=createProjectState('org','project');s.authorities=[{principalId:'owner',role:'owner',revision:1,active:true},{principalId:'agent',role:'agent',revision:1,active:true}];s=createNativeGenesis(s,actor);
 s=run(s,'draftScenario',{record:{schemaVersion:1,organizationId:'org',projectId:'project',id:'example',author:'owner',createdAt:now,revision:1,predecessor:null,title:'Retained reason',given:'Authorized override',when:'Reason provided',then:'Reason retained',ruleRefs:[],required:true,method:'manual',verifierDigest:digest,confirmation:null,archived:false}});
 return run(s,'confirmScenario',{id:'example',revision:1,decisionId:'confirm',explanation:'Current requirement'});
}
describe('immutable scenario archival',()=>{
 it('archives through a new confirmed revision, preserves evidence and stales an earlier proposal',()=>{
 let s=confirmed();
 const envelope:ProjectProposalEnvelope={domain:'cf.project-proposal/1',schemaVersion:1,organizationId:'org',projectId:'project',outcome:null,attemptId:null,mandateId:null,mandateRevision:null,contextDigest:null,innerProposalId:null,innerProposalHash:null,sourceHeads:[],runtimeRecipeDigest:digest,buildDigest:digest,expectedParent:s.manifests.at(-1)!.hash,expectedKnowledgeHead:s.knowledgeHead,policyRevision:0,proposedKnowledge:[],proposedScenarios:[],requiredScenarios:[{id:'example',revision:2,method:'manual',verifierDigest:digest}],recovery:null,effects:[]};
 const proposal={schemaVersion:1 as const,organizationId:'org',projectId:'project',id:'old-proposal',author:'owner',createdAt:now,envelope,digest:computeProjectProposalHash(envelope)};
 s=run(s,'prepareProposal',{record:proposal});
 s=run(s,'recordEvidence',{record:{schemaVersion:1,organizationId:'org',projectId:'project',id:'observation',author:'owner',createdAt:now,envelopeDigest:proposal.digest,buildDigest:digest,runtimeRecipeDigest:digest,scenarioId:'example',scenarioRevision:2,verifierDigest:digest,method:'manual',result:'pass',runId:'manual-run',actor:'owner',startedAt:now,completedAt:now,provenance:'human-attested',supersedes:null,attachments:[],summary:'Observed exact subject'}});
 const previous=s,command={type:'archiveScenario',id:'example',revision:2,decisionId:'archive',explanation:'Requirement intentionally retired',expectedGeneration:s.generation,idempotencyKey:'archive-once'};
 const archived=applyProjectCommand(s,command,actor);
 expect(previous.scenarios).toHaveLength(2);expect(archived.state.scenarios).toHaveLength(3);
 expect(archived.state.scenarios.at(-1)).toMatchObject({revision:3,predecessor:2,archived:true,confirmation:{actor:'owner',decisionId:'archive'}});
 expect(currentConfirmed(archived.state.scenarios)).toEqual([]);expect(archived.state.knowledgeHead).not.toBe(previous.knowledgeHead);
 expect(archived.state.evidence).toEqual(previous.evidence);expect(archived.state.manifests.at(-1)?.behavior).toBe('outstanding');
 expect(applyProjectCommand(archived.state,command,actor).replayed).toBe(true);
 expect(()=>applyProjectCommand(archived.state,{...command,idempotencyKey:'stale-revision',decisionId:'archive-stale',expectedGeneration:archived.state.generation},actor)).toThrow(/draft revision/);
 expect(()=>run(archived.state,'prepareProposal',{record:{...proposal,id:'stale-after-archive'}})).toThrow(/requirements changed/);
 });
 it('does not let a task agent retire an owner requirement',()=>{
 const s=confirmed();expect(()=>applyProjectCommand(s,{type:'archiveScenario',id:'example',revision:2,decisionId:'bad-archive',explanation:'Agent cannot weaken requirements',expectedGeneration:s.generation,idempotencyKey:'agent-archive'},{actorId:'agent',now})).toThrow(/authority/);
 });
});
