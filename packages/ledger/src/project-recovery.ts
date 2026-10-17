/** Exact historical-head recovery. No provider operation, merge, or deployment occurs here. */
import { ProjectError, computeProjectProposalHash, canonicalJson, hashCanonicalSync, type ProjectProposalEnvelope, type ProjectState, type PrincipalRef, type ResourceId, type RevisionId } from '@commonforge-org/core';
import type { LedgerTx, LedgerWrite } from './store.js';
import { auditEvent, nextAcceptedVersion, parseNow, reconcileRefEvent } from './internal.js';

const sorted = (heads: ProjectState['sourceHeads']) => [...heads].sort((a,b)=>a.resourceId.localeCompare(b.resourceId));
export function projectRecoveryPlanDigest(state: ProjectState, manifestHash: string): string {
  const target=state.manifests.find(m=>m.hash===manifestHash);
  if(!target)throw new ProjectError('recovery_unsupported','historical manifest is unavailable');
  return hashCanonicalSync({domain:'cf.project-recovery-plan/1',organizationId:state.organizationId,projectId:state.projectId,manifestHash,expectedParent:state.manifests.at(-1)?.hash??null,expectedKnowledgeHead:state.knowledgeHead,policyRevision:state.policyRevision,from:sorted(state.sourceHeads),to:sorted(target.sourceHeads),effects:[]});
}
export function validateProjectRecovery(state:ProjectState,envelope:ProjectProposalEnvelope):void {
  const recovery=envelope.recovery;if(!recovery)return;
  const target=state.manifests.find(m=>m.hash===recovery.manifestHash);
  if(!target || canonicalJson(sorted(target.sourceHeads))!==canonicalJson(sorted(envelope.sourceHeads)))throw new ProjectError('recovery_unsupported','recovery must bind the historical complete source heads');
  if(envelope.innerProposalId!==null || envelope.proposedKnowledge.length || envelope.proposedScenarios.length)throw new ProjectError('recovery_unsupported','recovery retains current knowledge and exact historical artifacts without integration');
  if(envelope.effects.length || state.manifests.filter(m=>m.sequence>=target.sequence).some(m=>state.proposals.find(p=>p.digest===m.envelopeDigest)?.envelope.effects.length))throw new ProjectError('recovery_unsupported','automatic recovery cannot undo declared external effects');
  if(canonicalJson(sorted(state.sourceHeads).map(h=>h.resourceId))!==canonicalJson(sorted(target.sourceHeads).map(h=>h.resourceId)))throw new ProjectError('recovery_unsupported','source membership changed since the historical manifest');
  if(canonicalJson(sorted(state.sourceHeads))===canonicalJson(sorted(target.sourceHeads)))throw new ProjectError('recovery_unsupported','historical sources are already current');
  if(recovery.planDigest!==projectRecoveryPlanDigest(state,recovery.manifestHash))throw new ProjectError('review_subject_changed','recovery plan no longer matches current project state');
}
/** Called only after current knowledge, exact decision and ALL scenario evidence pass. */
export function planProjectRecovery(tx:LedgerTx,state:ProjectState,envelope:ProjectProposalEnvelope,actorId:string,now:string):{artifactWrites:LedgerWrite[];acceptedVersionId:string} {
  validateProjectRecovery(state,envelope);
  if((tx.getCurrentPolicyRevision(state.projectId)??0)!==state.policyRevision)throw new ProjectError('review_subject_changed','artifact policy changed');
  const at=parseNow(now),actor:PrincipalRef={kind:'user',id:actorId};
  const {sequence,acceptedVersionId}=nextAcceptedVersion(tx,state.organizationId);
  const heads=[];
  for(const target of sorted(envelope.sourceHeads)){
    const resourceId=target.resourceId as ResourceId,revisionId=target.revisionId as RevisionId;
    const previous=state.sourceHeads.find(h=>h.resourceId===resourceId),current=tx.getHead(resourceId);
    if(tx.getResourceOrganization(resourceId)!==state.organizationId || !previous || !current || current.revisionId!==previous.revisionId)throw new ProjectError('review_subject_changed','accepted artifact head changed');
    if(!tx.wasAcceptedHead(resourceId,revisionId))throw new ProjectError('recovery_unsupported','target was never an accepted artifact head');
    if(current.revisionId!==revisionId)heads.push({resourceId,revisionId,previousRevisionId:current.revisionId,versionSeq:current.versionSeq+1});
  }
  const artifactWrites:LedgerWrite[]=heads.map(h=>({op:'setHead',head:{resourceId:h.resourceId,revisionId:h.revisionId,versionSeq:h.versionSeq,acceptedVersionId,acceptedAt:at,reconciliation:'pending'}}));
  artifactWrites.push({op:'putAcceptedVersion',version:{acceptedVersionId,organizationId:state.organizationId,sequence,kind:'restore',proposalId:null,proposalHash:null,heads,actor,acceptedAt:at}});
  artifactWrites.push({op:'putIdempotency',organizationId:state.organizationId,record:{key:`native-recovery:${computeProjectProposalHash(envelope)}`,scope:'restore',requestHash:envelope.recovery!.planDigest,acceptedVersionId,createdAt:at}});
  for(const h of heads)artifactWrites.push({op:'appendOutbox',event:reconcileRefEvent(state.organizationId,h.resourceId,h.revisionId,h.previousRevisionId,acceptedVersionId,at)});
  artifactWrites.push({op:'appendAudit',event:auditEvent({organizationId:state.organizationId,at,actor,action:'project.recovered',subject:{kind:'project',id:state.projectId},avId:acceptedVersionId,detail:{targetManifestHash:envelope.recovery!.manifestHash,planDigest:envelope.recovery!.planDigest,heads}})});
  return {artifactWrites,acceptedVersionId};
}
