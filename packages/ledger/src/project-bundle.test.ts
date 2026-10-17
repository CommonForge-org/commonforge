import { describe,expect,it } from 'vitest';
import { computeKnowledgeHead, computeProjectProposalHash, createProjectState, currentConfirmed, hashCanonicalSync, sha256HexSync, type ProjectState } from '@commonforge-org/core';
import { applyProjectCommand, createNativeGenesis } from './project.js';
import { exportProjectBundle,importProjectBundle,projectRetentionRoots,validateProjectBundle,type ProjectBundle,type ProjectBundlePayload } from './project-bundle.js';
const now='2026-10-17T12:00:00.000Z';
const actor={actorId:'owner',now};
const base={schemaVersion:1 as const,organizationId:'synthetic-org',projectId:'synthetic-project',author:'owner',createdAt:now};
function fixture():ProjectState {
 let s=createProjectState(base.organizationId,base.projectId);s.authorities=[{principalId:'owner',role:'owner',revision:1,active:true}];s.sourceHeads=[{resourceId:'source',revisionId:'git-ref-opaque'}];s=createNativeGenesis(s,actor);
 s=applyProjectCommand(s,{type:'draftKnowledge',expectedGeneration:0,idempotencyKey:'draft',record:{...base,id:'rule',revision:1,predecessor:null,kind:'rule',text:'Managers retain an override reason.',rationale:'Synthetic agency accountability',sources:[],confirmation:null,archived:false}},actor).state;
 s=applyProjectCommand(s,{type:'confirmKnowledge',expectedGeneration:1,idempotencyKey:'confirm',id:'rule',revision:1,decisionId:'confirmation',explanation:'Confirmed by synthetic owner'},actor).state;
 const envelope={schemaVersion:1 as const,organizationId:s.organizationId,projectId:s.projectId,domain:'cf.project-proposal/1' as const,outcome:null,attemptId:null,mandateId:null,mandateRevision:null,contextDigest:null,innerProposalId:null,innerProposalHash:null,sourceHeads:s.sourceHeads,runtimeRecipeDigest:'a'.repeat(64),buildDigest:'b'.repeat(64),expectedParent:s.manifests.at(-1)!.hash,expectedKnowledgeHead:s.knowledgeHead,policyRevision:0,proposedKnowledge:[],proposedScenarios:[],requiredScenarios:[],recovery:null,effects:[]};
 s.proposals.push({...base,id:'historical-proposal',envelope,digest:computeProjectProposalHash(envelope)});
 const text='synthetic retained observation';const digest=sha256HexSync(text);
 s.evidence.push({...base,id:'evidence',envelopeDigest:s.proposals[0]!.digest,buildDigest:envelope.buildDigest,runtimeRecipeDigest:envelope.runtimeRecipeDigest,scenarioId:'historic-scenario',scenarioRevision:1,verifierDigest:'c'.repeat(64),method:'automated',result:'pass',runId:'real-run-id',actor:'old-runner',startedAt:now,completedAt:now,provenance:'runner-verified',supersedes:null,attachments:[{digest,size:new TextEncoder().encode(text).byteLength,mediaType:'text/plain'}],summary:'Historical provenance retained'});
 return s;
}
function payload(content:string,kind:ProjectBundlePayload['kind'],subject?:string):ProjectBundlePayload {const digest=sha256HexSync(content);return {kind,subject:subject??digest,path:`payloads/${digest}`,digest,size:new TextEncoder().encode(content).byteLength,mediaType:'text/plain',contentBase64:btoa(content)};}
function rehash(bundle:ProjectBundle):ProjectBundle {const {digest:_,...content}=bundle;return {...content,digest:hashCanonicalSync(content)};}
describe('G1 project portability and consumer boundary',()=>{
 it('round trips exact history and reports missing source/attachments honestly',()=>{
 const s=fixture();const b=exportProjectBundle(s);const roundtrip=validateProjectBundle(JSON.parse(JSON.stringify(b)));expect(roundtrip.history).toEqual(s);expect(roundtrip.completeness.missingSources).toEqual(['git-ref-opaque']);expect(roundtrip.completeness.missingAttachments).toHaveLength(1);expect(roundtrip.completeness.completeBackup).toBe(false);
 });
 it('validates included byte digests without claiming Git content was verified',()=>{
 const b=exportProjectBundle(fixture(),[payload('synthetic retained observation','attachment'),payload('opaque source bytes','source','git-ref-opaque')]);expect(b.completeness.missingSources).toEqual([]);expect(b.completeness.missingAttachments).toEqual([]);expect(b.completeness.sourceContentValidation).toBe('not-performed');expect(b.completeness.completeBackup).toBe(false);
 });
 it('imports inert drafts with new local identity and keeps original evidence outside local state',()=>{
 const b=exportProjectBundle(fixture());const result=importProjectBundle(b,{organizationId:'new-org',projectId:'new-project',ownerId:'new-owner',now});expect(result.history.history.evidence[0]?.provenance).toBe('runner-verified');expect(result.state.evidence).toEqual([]);expect(result.state.decisions).toEqual([]);expect(result.state.mandates).toEqual([]);expect(result.state.sourceHeads).toEqual([]);expect(result.state.authorities).toEqual([{principalId:'new-owner',role:'owner',revision:1,active:true}]);expect(result.state.knowledge[0]?.id).not.toBe('rule');expect(result.state.knowledge[0]?.text).toBe('Managers retain an override reason.');expect(currentConfirmed(result.state.knowledge)).toEqual([]);expect(result.state.manifests[0]?.behavior).toBe('historical-unverified');
 expect(()=>applyProjectCommand(result.state,{type:'accept',proposalId:'historical-proposal',decisionId:'confirmation',expectedGeneration:0,idempotencyKey:'accept'}, {actorId:'new-owner',now})).toThrow(/unavailable/);
 expect(()=>applyProjectCommand(result.state,{type:'confirmKnowledge',id:result.state.knowledge[0]!.id,revision:1,decisionId:'confirm',explanation:'Review',expectedGeneration:0,idempotencyKey:'old-owner'},actor)).toThrow(/authority/);
 const local=applyProjectCommand(result.state,{type:'confirmKnowledge',id:result.state.knowledge[0]!.id,revision:1,decisionId:'local-confirm',explanation:'Fresh local confirmation',expectedGeneration:0,idempotencyKey:'new-owner'}, {actorId:'new-owner',now}).state;expect(currentConfirmed(local.knowledge)).toHaveLength(1);expect(local.manifests.at(-1)?.behavior).toBe('outstanding');
 });
 it.each(['../escape','/absolute','C:/drive','payloads/../escape','payloads\\escape'])('refuses unsafe payload paths: %s',path=>{
 const b=exportProjectBundle(fixture(),[payload('source bytes','source','git-ref-opaque')]);b.payloads[0]!.path=path;expect(()=>validateProjectBundle(rehash(b))).toThrow(/archive path/);
 });
 it('rejects corrupted content, missing history and falsified completeness',()=>{
 const b=exportProjectBundle(fixture(),[payload('source bytes','source','git-ref-opaque')]);b.payloads[0]!.contentBase64=btoa('changed');expect(()=>validateProjectBundle(rehash(b))).toThrow(/digest/);
 const missing=exportProjectBundle(fixture());missing.history.decisions=[];expect(()=>validateProjectBundle(rehash(missing))).toThrow(/missing history/);
 const lie=exportProjectBundle(fixture());lie.completeness.missingSources=[];expect(()=>validateProjectBundle(rehash(lie))).toThrow(/completeness/);
 });
 it('rejects unknown versions, unknown properties, duplicate paths and oversized declared payloads',()=>{
 const b=exportProjectBundle(fixture());expect(()=>validateProjectBundle({...b,schemaVersion:2})).toThrow(/malformed/);expect(()=>validateProjectBundle({...b,coordinates:{remoteUrl:'secret'}})).toThrow(/malformed/);
 const withBytes=exportProjectBundle(fixture(),[payload('source bytes','source','git-ref-opaque')]);withBytes.payloads.push(withBytes.payloads[0]!);expect(()=>validateProjectBundle(rehash(withBytes))).toThrow(/archive path/);
 const oversized=exportProjectBundle(fixture(),[payload('source bytes','source','git-ref-opaque')]);oversized.payloads[0]!.size=99_000_000;expect(()=>validateProjectBundle(rehash(oversized))).toThrow(/malformed/);
 });
 it.each(['password=secretvalue','Bearer abcdefghijklmnopqrstuvwxyz','file:///home/example/repository','https://user:secret@example.test/repo'])('refuses credential/local-coordinate prose and bytes: %s',text=>{
 const s=fixture();s.knowledge[0]!.text=text;s.knowledgeHead=computeKnowledgeHead(s.organizationId,s.projectId,s.knowledgeGeneration,s.knowledge,s.scenarios);expect(()=>exportProjectBundle(s)).toThrow();expect(()=>exportProjectBundle(fixture(),[payload(text,'source','git-ref-opaque')])).toThrow();
 });
 it('retains historical acceptance references and pending attempt payloads conservatively',()=>{
 const s=fixture();const roots=projectRetentionRoots(s);expect(roots.sourceRevisions).toContain('git-ref-opaque');expect(roots.manifestHashes).toHaveLength(2);expect(roots.evidenceIds).toContain('evidence');expect(roots.attachmentDigests).toContain(s.evidence[0]!.attachments[0]!.digest);expect(roots.buildDigests).toContain(s.proposals[0]!.envelope.buildDigest);expect(roots.canDeleteReferencedPayloads).toBe(false);
 });
 it('supports a synthetic agency branded workflow through public commands without ledger patches',()=>{
 const agency={name:'Synthetic Service Studio',clientLabel:'Cedar Demo',reviewText:'Confirm service rule',roles:{caseLead:'owner',implementationPartner:'agent'}};
 let s=fixture();const before=s.knowledgeHead;
 // Private presentation maps its workflow to public command contracts. No agency types enter state.
 const rule={...s.knowledge[0]!,id:'agency-draft',text:agency.clientLabel+' requires retained override reasons.',revision:1,predecessor:null,confirmation:null};s=applyProjectCommand(s,{type:'draftKnowledge',expectedGeneration:s.generation,idempotencyKey:'agency-draft',record:rule},actor).state;
 s=applyProjectCommand(s,{type:'confirmKnowledge',expectedGeneration:s.generation,idempotencyKey:'agency-confirm',id:rule.id,revision:1,decisionId:'agency-decision',explanation:agency.reviewText},actor).state;
 expect(s.knowledgeHead).not.toBe(before);expect(s.manifests.at(-1)?.behavior).toBe('outstanding');expect(JSON.stringify(exportProjectBundle(s))).not.toContain('private-package');
 });
});
