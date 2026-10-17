import { describe, expect, it } from 'vitest';
import { computeProjectProposalHash, createProjectState, currentConfirmed, type ProjectProposal, type ProjectState, type KnowledgeRevision, type ProjectProposalEnvelope } from '@commonforge-org/core';
import { applyProjectCommand, createNativeGenesis, planProjectAccept, type ProjectActor } from './project.js';
import { InMemoryLedgerStore } from './memory-store.js';
import { acceptFixture, FIXTURE_TIME } from './fixtures.js';
import { applyWrites } from './apply-writes.js';
const now=FIXTURE_TIME.now;
const owner:ProjectActor={actorId:'owner',now};
const agent:ProjectActor={actorId:'agent',now};
const hash='a'.repeat(64);
function state() {const s=createProjectState('org-1','proj-1'); s.authorities=[{principalId:'owner',role:'owner',revision:1,active:true},{principalId:'agent',role:'agent',revision:1,active:true}]; return createNativeGenesis(s,owner);}
function draft(s:ProjectState,id='rule'):KnowledgeRevision {return {schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id,author:'owner',createdAt:now,revision:1,predecessor:null,kind:'rule',text:'Managers must retain override reasons',rationale:'Accountability',sources:[],confirmation:null,archived:false};}
function run(s:ProjectState,type:string,extra:Record<string,unknown>,a=owner,key=type+':'+s.generation) {return applyProjectCommand(s,{type,expectedGeneration:s.generation,idempotencyKey:key,...extra},a);}
function proposal(s:ProjectState,overrides:Partial<ProjectProposalEnvelope>={}):ProjectProposal {
 const envelope:ProjectProposalEnvelope={schemaVersion:1,domain:'cf.project-proposal/1',organizationId:s.organizationId,projectId:s.projectId,outcome:null,attemptId:null,mandateId:null,mandateRevision:null,contextDigest:null,innerProposalId:null,innerProposalHash:null,sourceHeads:s.sourceHeads,runtimeRecipeDigest:hash,buildDigest:hash,expectedParent:s.manifests.at(-1)?.hash??null,expectedKnowledgeHead:s.knowledgeHead,policyRevision:s.policyRevision,proposedKnowledge:[],proposedScenarios:[],requiredScenarios:currentConfirmed(s.scenarios).filter(s=>s.required).map(s=>({id:s.id,revision:s.revision,verifierDigest:s.verifierDigest,method:s.method})),recovery:null,effects:[],...overrides};
 return {schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id:'proposal',author:'owner',createdAt:now,envelope,digest:computeProjectProposalHash(envelope)};
}
function decision(s:ProjectState,p:ProjectProposal) {return {schemaVersion:1 as const,organizationId:s.organizationId,projectId:s.projectId,id:'decision',author:'owner',createdAt:now,envelopeDigest:p.digest,innerProposalHash:p.envelope.innerProposalHash,action:'approve' as const,explanation:'Reviewed exact subject',authorityRevision:1};}
function ready(s:ProjectState,p:ProjectProposal) {s=run(s,'prepareProposal',{record:p}).state;return run(s,'recordDecision',{record:decision(s,p)}).state;}
function withAttempt(s:ProjectState) {
 s=run(s,'issueMandate',{record:{schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id:'mandate',author:'owner',createdAt:now,revision:1,taskId:'task',agentId:'agent',issuer:'owner',operations:['context:read','candidate:submit','knowledge:propose'],resourceIds:['r1'],issuedAt:now,expiresAt:FIXTURE_TIME.later,revocationGeneration:0,revokedAt:null,maxAttempts:1,maxJobs:1,timeoutSeconds:60}}).state;
 return run(s,'exchangeHandoff',{record:{schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id:'attempt',author:'agent',createdAt:now,taskId:'task',agentId:'agent',mandateId:'mandate',mandateRevision:1,contextDigest:hash,knowledgeHead:s.knowledgeHead,startedAt:now,endedAt:null,status:'active',proposalIds:[]}},agent).state;
}
describe('G1 pure project transitions',()=>{
 it('keeps drafts immutable, confirms a new revision and records outstanding behavior',()=>{
 const s=state();const r=draft(s);const d=run(s,'draftKnowledge',{record:r}).state;const next=run(d,'confirmKnowledge',{id:r.id,revision:1,decisionId:'confirm',explanation:'Confirmed requirement'}).state;
 expect(s.knowledge).toHaveLength(0);expect(next.knowledge).toHaveLength(2);expect(next.knowledge[0]?.confirmation).toBeNull();expect(currentConfirmed(next.knowledge)[0]?.revision).toBe(2);expect(next.knowledgeHead).not.toBe(s.knowledgeHead);expect(next.manifests.at(-1)?.behavior).toBe('outstanding');
 });
 it('CAS has one winner and idempotent retry returns before generation check',()=>{
 const s=state();const c={type:'draftKnowledge',record:draft(s),expectedGeneration:0,idempotencyKey:'retry'};const a=applyProjectCommand(s,c,owner);expect(applyProjectCommand(a.state,c,owner).replayed).toBe(true);expect(a.state.knowledge).toHaveLength(1);
 expect(()=>applyProjectCommand(a.state,{...c,idempotencyKey:'other'},owner)).toThrowError(/generation/);expect(()=>applyProjectCommand(a.state,{...c,record:{...c.record,text:'Different'}},owner)).toThrowError(/another command/);
 });
 it('rejects agent confirmations, cross-project writes, and unknown fields',()=>{
 const s=run(state(),'draftKnowledge',{record:draft(state())}).state;
 expect(()=>run(s,'confirmKnowledge',{id:'rule',revision:1,decisionId:'bad',explanation:'No'},agent)).toThrowError(/authority/);
 expect(()=>run(s,'draftKnowledge',{record:{...draft(s,'other'),projectId:'foreign'}})).toThrowError(/another project/);
 expect(()=>run(s,'accept',{proposalId:'p',decisionId:'d',verified:true})).toThrowError();
 });
 it('archives through a new immutable revision',()=>{
 let s=run(state(),'draftKnowledge',{record:draft(state())}).state;s=run(s,'confirmKnowledge',{id:'rule',revision:1,decisionId:'confirm',explanation:'Yes'}).state;s=run(s,'archiveKnowledge',{id:'rule',revision:2,decisionId:'archive',explanation:'Replaced'}).state;expect(currentConfirmed(s.knowledge)).toEqual([]);expect(s.knowledge).toHaveLength(3);
 });
 it('accepts metadata without claiming existing deployment satisfies it',()=>{
 let s=run(state(),'draftKnowledge',{record:draft(state())}).state;const p=proposal(s,{proposedKnowledge:[{id:'rule',revision:1}]});s=ready(s,p);const a=run(s,'accept',{proposalId:p.id,decisionId:'decision'});expect(a.state.manifests.at(-1)?.behavior).toBe('outstanding');expect(currentConfirmed(a.state.knowledge)).toHaveLength(1);expect(a.artifactWrites).toEqual([]);
 });
 it('rejects stale envelope after knowledge correction',()=>{
 let s=run(state(),'draftKnowledge',{record:draft(state())}).state;const p=proposal(s);s=ready(s,p);s=run(s,'confirmKnowledge',{id:'rule',revision:1,decisionId:'correction',explanation:'New requirement'}).state;expect(()=>run(s,'accept',{proposalId:p.id,decisionId:'decision'})).toThrowError(/requirements changed/);
 });
 it('rechecks decision authority at acceptance',()=>{
 let s=state();const p=proposal(s);s=ready(s,p);s.authorities[0]!.revision++;expect(()=>run(s,'accept',{proposalId:p.id,decisionId:'decision'})).toThrowError(/authority changed/);
 });
 it('limits attempts and revokes future submissions',()=>{
 let s=withAttempt(state());const record={...s.attempts[0]!,id:'second'};expect(()=>run(s,'exchangeHandoff',{record},agent)).toThrowError(/exceeds/);s=run(s,'revokeMandate',{id:'mandate',revision:1}).state;
 expect(s.attempts[0]?.status).toBe('revoked');const p=proposal(s,{attemptId:'attempt',mandateId:'mandate',mandateRevision:1,contextDigest:hash});expect(()=>run(s,'prepareProposal',{record:p})).toThrowError(/not active/);
 });
 it('plans source+manifest writes without changing either store, and transaction failure rolls back',()=>{
 const f=acceptFixture();const store=new InMemoryLedgerStore();store.seed(f.seed);let s=state();s.policyRevision=1;s.sourceHeads=f.input.expectedHeads.map(h=>({resourceId:h.resourceId,revisionId:h.revisionId}));s=withAttempt(s);
 const p=proposal(s,{attemptId:'attempt',mandateId:'mandate',mandateRevision:1,contextDigest:hash,innerProposalId:f.proposal.proposalId,innerProposalHash:f.proposal.proposalHash,sourceHeads:f.input.newHeads.map(h=>({resourceId:h.resourceId,revisionId:h.revisionId}))});s=ready(s,p);const c={type:'accept',proposalId:p.id,decisionId:'decision',expectedGeneration:s.generation,idempotencyKey:'accept'};const input={...f.input,actor:{kind:'user' as const,id:'owner'}};
 const a=store.transactionSync(tx=>planProjectAccept(tx,s,c,owner,input));expect(s.attempts[0]?.status).toBe('submitted');expect(a.state.attempts[0]?.status).toBe('completed');expect(a.state.attempts[0]?.proposalIds).toContain(p.id);expect(a.artifactWrites.length).toBeGreaterThan(0);expect(a.state.manifests.at(-1)?.behavior).toBe('verified');expect(s.manifests).toHaveLength(1);
 expect(()=>store.transactionSync(tx=>{applyWrites(tx,a.artifactWrites);throw new Error('injected');})).toThrow('injected');expect(store.transactionSync(tx=>tx.getHead(f.input.expectedHeads[0]!.resourceId)?.revisionId)).toBe(f.input.expectedHeads[0]!.revisionId);
 });
 it('does not allow a legacy artifact approval to substitute for an outer decision',()=>{
 const f=acceptFixture();const store=new InMemoryLedgerStore();store.seed(f.seed);let s=state();s.policyRevision=1;s.sourceHeads=f.input.expectedHeads.map(h=>({resourceId:h.resourceId,revisionId:h.revisionId}));s=withAttempt(s);const p=proposal(s,{attemptId:'attempt',mandateId:'mandate',mandateRevision:1,contextDigest:hash,innerProposalId:f.proposal.proposalId,innerProposalHash:f.proposal.proposalHash,sourceHeads:f.input.newHeads.map(h=>({resourceId:h.resourceId,revisionId:h.revisionId}))});s=run(s,'prepareProposal',{record:p}).state;
 expect(()=>store.transactionSync(tx=>planProjectAccept(tx,s,{type:'accept',expectedGeneration:s.generation,idempotencyKey:'accept',proposalId:p.id,decisionId:'legacy'},owner,f.input))).toThrowError(/exact approval/);
 });
 it('binds runner evidence to scenario, recipe and build, refusing public provenance claims',()=>{
 let s=state();
 s=run(s,'draftScenario',{record:{schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id:'scenario',author:'owner',createdAt:now,revision:1,predecessor:null,title:'Retain reason',given:'Manager override',when:'Recorded',then:'Reason retained',ruleRefs:[],required:true,method:'automated',verifierDigest:hash,confirmation:null,archived:false}}).state;
 s=run(s,'confirmScenario',{id:'scenario',revision:1,decisionId:'scenario-confirm',explanation:'Required'}).state;
 const p=proposal(s);s=run(s,'prepareProposal',{record:p}).state;
 const evidence={schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id:'evidence',author:'owner',createdAt:now,envelopeDigest:p.digest,buildDigest:hash,runtimeRecipeDigest:hash,scenarioId:'scenario',scenarioRevision:2,verifierDigest:hash,method:'automated',result:'pass',runId:'run',actor:'node-runner',startedAt:now,completedAt:now,provenance:'runner-verified',supersedes:null,attachments:[],summary:'Executed required check'};
 expect(()=>run(s,'recordEvidence',{record:evidence})).toThrowError(/runner provenance/);
 expect(()=>run(s,'recordEvidence',{record:{...evidence,buildDigest:'b'.repeat(64)}},{...owner,trustedRunner:{runnerId:'node-runner'}})).toThrowError(/subject/);
 const verified=run(s,'recordEvidence',{record:evidence},{...owner,trustedRunner:{runnerId:'node-runner'}}).state;expect(verified.evidence).toHaveLength(1);
 expect(()=>run(verified,'recordEvidence',{record:{...evidence,id:'import',provenance:'imported-untrusted'}})).toThrowError(/imported/);
 });
 it('requires every source scenario pass and explicit same-subject supersession',()=>{
 const f=acceptFixture();const store=new InMemoryLedgerStore();store.seed(f.seed);let s=state();s.policyRevision=1;s.sourceHeads=f.input.expectedHeads.map(h=>({resourceId:h.resourceId,revisionId:h.revisionId}));
 s=run(s,'draftScenario',{record:{schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id:'scenario',author:'owner',createdAt:now,revision:1,predecessor:null,title:'Required',given:'Input',when:'Action',then:'Expected',ruleRefs:[],required:true,method:'automated',verifierDigest:hash,confirmation:null,archived:false}}).state;
 s=run(s,'confirmScenario',{id:'scenario',revision:1,decisionId:'scenario-confirm',explanation:'Required'}).state;s=withAttempt(s);
 const p=proposal(s,{attemptId:'attempt',mandateId:'mandate',mandateRevision:1,contextDigest:hash,innerProposalId:f.proposal.proposalId,innerProposalHash:f.proposal.proposalHash,sourceHeads:f.input.newHeads.map(h=>({resourceId:h.resourceId,revisionId:h.revisionId}))});s=ready(s,p);
 const accept=(state:ProjectState)=>store.transactionSync(tx=>planProjectAccept(tx,state,{type:'accept',expectedGeneration:state.generation,idempotencyKey:'accept',proposalId:p.id,decisionId:'decision'},owner,{...f.input,actor:{kind:'user',id:'owner'}}));
 expect(()=>accept(s)).toThrowError(/passing evidence/);
 const evidence={schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id:'failed',author:'owner',createdAt:now,envelopeDigest:p.digest,buildDigest:hash,runtimeRecipeDigest:hash,scenarioId:'scenario',scenarioRevision:2,verifierDigest:hash,method:'automated',result:'fail',runId:'run',actor:'node-runner',startedAt:now,completedAt:now,provenance:'runner-verified',supersedes:null,attachments:[],summary:'Real runner result'};
 const supervisor={...owner,trustedRunner:{runnerId:'node-runner'}};
 s=run(s,'recordEvidence',{record:evidence},supervisor).state;s=run(s,'recordEvidence',{record:{...evidence,id:'unrelated-pass',result:'pass'}},supervisor).state;expect(()=>accept(s)).toThrowError(/passing evidence/);
 s=run(s,'recordEvidence',{record:{...evidence,id:'retry-pass',result:'pass',supersedes:'failed'}},supervisor).state;expect(accept(s).state.manifests.at(-1)?.behavior).toBe('verified');
 });
 it('refuses recovery whose source heads differ from the referenced historical manifest',()=>{
 const s=state();const p=proposal(s,{sourceHeads:[{resourceId:'extra',revisionId:'new'}],recovery:{manifestHash:s.manifests[0]!.hash,planDigest:hash}});expect(()=>run(s,'prepareProposal',{record:p})).toThrowError(/historical/);
 });

 it('refuses confirmation of a scenario referencing unavailable or superseded rules',()=>{
 let s=state();const r={schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id:'invalid-rule-ref',author:'owner',createdAt:now,revision:1,predecessor:null,title:'Cannot silently invent requirements',given:'An input',when:'An action',then:'Expected behavior',ruleRefs:[{id:'missing-rule',revision:1}],required:true,method:'automated',verifierDigest:hash,confirmation:null,archived:false};s=run(s,'draftScenario',{record:r}).state;const before=structuredClone(s);expect(()=>run(s,'confirmScenario',{id:r.id,revision:1,decisionId:'invalid-confirm',explanation:'Must fail'})).toThrowError(/confirmed knowledge/);expect(s).toEqual(before);
 });
 it('refuses automatic recovery of declared external effects even with an existing source manifest',()=>{
 const s=state();const p=proposal(s,{recovery:{manifestHash:s.manifests[0]!.hash,planDigest:hash},effects:['Sent synthetic external notification']});expect(()=>run(s,'prepareProposal',{record:p})).toThrowError(/external effects/);
 });

});
