/** Pure G1 project transitions. Persist returned state and artifactWrites in ONE transaction.
 * Authentication and cryptographic runner verification belong to the trusted adapter; callers
 * must never construct ProjectActor from request JSON. Every actor is rechecked against state.
 */
import { z } from 'zod';
import {
  AgentMandateSchema, KnowledgeRevisionSchema, ProjectAttemptSchema, ProjectDecisionSchema,
  ProjectError, ProjectMutationSchema, ProjectOutcomeSchema, ProjectProposalSchema,
  ProjectStateSchema, ScenarioEvidenceSchema, ScenarioRevisionSchema, canonicalJson,
  computeKnowledgeHead, computeProjectManifestHash, computeProjectProposalHash, currentConfirmed,
  hashCanonicalSync, type AcceptInput, type AgentMandate, type KnowledgeRevision,
  type ProjectManifest, type ProjectProposal, type ProjectState, type ScenarioRevision,
} from '@commonforge-org/core';
import { planCommit } from './plan-commit.js';
import { planProjectRecovery, validateProjectRecovery } from './project-recovery.js';
import type { LedgerTx, LedgerWrite } from './store.js';

const Id = z.string().min(1).max(256);
const rev = z.number().int().positive();
const base = ProjectMutationSchema.shape;
const command = <const K extends string, T extends z.ZodRawShape>(type: K, fields: T) => z.object({ ...base, type: z.literal(type), ...fields }).strict();
export const ProjectCommandSchema = z.union([
  command('draftKnowledge', { record: KnowledgeRevisionSchema }),
  command('confirmKnowledge', { id: Id, revision: rev, decisionId: Id, explanation: z.string().min(1).max(32768) }),
  command('archiveKnowledge', { id: Id, revision: rev, decisionId: Id, explanation: z.string().min(1).max(32768) }),
  command('upsertOutcome', { record: ProjectOutcomeSchema }),
  command('draftScenario', { record: ScenarioRevisionSchema }),
  command('confirmScenario', { id: Id, revision: rev, decisionId: Id, explanation: z.string().min(1).max(32768) }),
  command('issueMandate', { record: AgentMandateSchema }),
  command('exchangeHandoff', { record: ProjectAttemptSchema }),
  command('revokeMandate', { id: Id, revision: rev }),
  command('renewMandate', { id: Id, revision: rev, expiresAt: z.string().datetime({ offset: true }) }),
  command('prepareProposal', { record: ProjectProposalSchema }),
  command('recordDecision', { record: ProjectDecisionSchema }),
  command('recordEvidence', { record: ScenarioEvidenceSchema }),
  command('accept', { proposalId: Id, decisionId: Id }),
]);
export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;
export interface ProjectActor { actorId: string; now: string; /** Internal supervisor provenance, never a public request option. */ trustedRunner?: { runnerId: string } }
export interface ProjectTransition { state: ProjectState; replayed: boolean; resultId: string | null; artifactWrites: LedgerWrite[]; acceptedVersionId?: string }
const fail = (code: ConstructorParameters<typeof ProjectError>[0], message: string): never => { throw new ProjectError(code, message); };
const last = <T>(a: readonly T[]): T | undefined => a[a.length - 1];
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const heads = (a: ProjectState['sourceHeads']) => [...a].sort((x,y) => x.resourceId.localeCompare(y.resourceId));
function authority(s: ProjectState, actor: string, human = false) {
  const a = s.authorities.find(a => a.principalId === actor && a.active);
  if (!a || human && a.role === 'agent') return fail('authority_denied', 'active project authority is required');
  return a;
}
function scope(s: ProjectState, r: { organizationId: string; projectId: string }) {
  if (r.organizationId !== s.organizationId || r.projectId !== s.projectId) fail('authority_denied', 'record belongs to another project');
}
function authored(s: ProjectState, r: { organizationId: string; projectId: string; author: string; createdAt: string }, a: ProjectActor) {
  scope(s, r);
  if (r.author !== a.actorId || Date.parse(r.createdAt) > Date.parse(a.now)) fail('authority_denied', 'record author must match actor and timestamp cannot be future');
}
function appendRevision<T extends { id: string; revision: number; predecessor?: number | null }>(list: T[], r: T) {
  const latest = list.filter(x => x.id === r.id).sort((a,b) => b.revision-a.revision)[0];
  if (r.revision !== (latest?.revision ?? 0) + 1 || 'predecessor' in r && r.predecessor !== (latest?.revision ?? null)) fail('revision_conflict', 'revision does not extend current history');
  list.push(r);
}
function unique<T extends { id: string }>(list: T[], r: T) {
  if (list.some(x => x.id === r.id)) fail('revision_conflict', 'record identity already exists');
  list.push(r);
}
function mandate(s: ProjectState, id: string, now: string): AgentMandate {
  const m = s.mandates.filter(m => m.id === id).sort((a,b) => b.revision-a.revision)[0];
  if (!m || m.revokedAt !== null) return fail('mandate_revoked', 'mandate is not active');
  if (Date.parse(m.expiresAt) <= Date.parse(now) || Date.parse(m.issuedAt) > Date.parse(now)) fail('mandate_expired', 'mandate is outside its validity period');
  authority(s, m.issuer, true);
  return m;
}
function checkProposal(s: ProjectState, p: ProjectProposal, now: string) {
  scope(s, p); scope(s, p.envelope);
  const e = p.envelope;
  if (computeProjectProposalHash(e) !== p.digest) fail('review_subject_changed', 'envelope digest does not match content');
  if (e.expectedKnowledgeHead !== s.knowledgeHead) fail('knowledge_stale', 'project requirements changed; prepare and verify again');
  if (e.expectedParent !== (last(s.manifests)?.hash ?? null) || e.policyRevision !== s.policyRevision) fail('review_subject_changed', 'parent or policy changed');
  if (e.outcome && !s.outcomes.some(o => o.id === e.outcome!.id && o.revision === e.outcome!.revision)) fail('review_subject_changed', 'outcome revision is unavailable');
  if (e.recovery) { validateProjectRecovery(s,e); authority(s,p.author,true); }
  for (const [refs, records] of [[e.proposedKnowledge,s.knowledge],[e.proposedScenarios,s.scenarios]] as const) {
    for (const ref of refs) if (!records.some(r => r.id === ref.id && r.revision === ref.revision && !r.archived && r.confirmation === null)) fail('revision_conflict', 'proposed draft revision is unavailable');
  }
  const required = currentConfirmed(s.scenarios).filter(r => r.required).map(r => ({id:r.id,revision:r.revision,verifierDigest:r.verifierDigest,method:r.method})).sort((a,b) => a.id.localeCompare(b.id));
  if (!same([...e.requiredScenarios].sort((a,b) => a.id.localeCompare(b.id)),required)) fail('scenario_evidence_missing', 'envelope must name every current required scenario');
  if(e.innerProposalId!==null && (e.proposedKnowledge.length || e.proposedScenarios.length)) fail('project_mode_unsupported','confirm knowledge changes before source verification');
  if(e.innerProposalId!==null && e.attemptId===null) fail('mandate_scope_denied','source proposals require a pinned attempt and mandate');
  if (e.attemptId !== null) {
    const a = s.attempts.find(a => a.id === e.attemptId);
    const m = mandate(s,e.mandateId!,now);
    if (!a || a.status === 'revoked' || a.mandateId !== m.id || a.mandateRevision !== e.mandateRevision || m.revision !== e.mandateRevision || a.contextDigest !== e.contextDigest || a.knowledgeHead !== s.knowledgeHead || !m.operations.includes('candidate:submit')) fail('mandate_scope_denied','attempt authority or context does not match');
    if (e.sourceHeads.some(h => !m.resourceIds.includes(h.resourceId) && s.sourceHeads.find(x => x.resourceId === h.resourceId)?.revisionId !== h.revisionId)) fail('mandate_scope_denied','proposal changes a resource outside mandate');
  }
}
function addManifest(s: ProjectState, a: ProjectActor, id: string, behavior: ProjectManifest['behavior'], p?: ProjectProposal, decisionId: string | null = null, evidenceIds: string[] = []) {
  const content: Omit<ProjectManifest,'hash'> = { schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id,author:a.actorId,createdAt:a.now,sequence:(last(s.manifests)?.sequence ?? -1)+1,parent:last(s.manifests)?.hash ?? null, sourceHeads:heads(s.sourceHeads),knowledgeHead:s.knowledgeHead,knowledgeGeneration:s.knowledgeGeneration,envelopeDigest:p?.digest ?? null,decisionId,evidenceIds,behavior };
  unique(s.manifests,{...content,hash:computeProjectManifestHash(content)});
}
function refreshKnowledge(s: ProjectState) {
  s.knowledgeGeneration++;
  s.knowledgeHead=computeKnowledgeHead(s.organizationId,s.projectId,s.knowledgeGeneration,s.knowledge,s.scenarios);
}
function confirm<T extends KnowledgeRevision | ScenarioRevision>(s:ProjectState,list:T[],id:string,revision:number,decisionId:string,a:ProjectActor,archived=false) {
  const r = list.filter(r=>r.id===id).sort((a,b)=>b.revision-a.revision)[0];
  if(!r || r.revision!==revision || (!archived && r.confirmation!==null)) fail('revision_conflict','draft revision is no longer current');
  if ('ruleRefs' in r!) for(const ref of (r as ScenarioRevision).ruleRefs) if(!currentConfirmed(s.knowledge).some(k=>k.id===ref.id && k.revision===ref.revision)) fail('knowledge_stale','scenario references a non-current confirmed rule');
  const next = {...r!,revision:revision+1,predecessor:revision,author:a.actorId,createdAt:a.now,archived,confirmation:{actor:a.actorId,confirmedAt:a.now,authorityRevision:authority(s,a.actorId,true).revision,decisionId}} as T;
  appendRevision(list,next);
  return next;
}

/** Commands do not perform network I/O and do not modify the input state. */
export function applyProjectCommand(input:ProjectState,raw:unknown,actor:ProjectActor):ProjectTransition {
  return transition(input,raw,actor);
}
function transition(input:ProjectState,raw:unknown,actor:ProjectActor,artifact?:{tx:LedgerTx;input?:AcceptInput}):ProjectTransition {
  const parsed=ProjectCommandSchema.safeParse(raw);
  if(!parsed.success) return fail('invalid_project_record',parsed.error.message);
  const c=parsed.data;
  const s=ProjectStateSchema.parse(input);
  if(!Number.isFinite(Date.parse(actor.now))) fail('invalid_project_record','invalid operation time');
  const auth=authority(s,actor.actorId);
  const digest=hashCanonicalSync({domain:'cf.project-command/1',actor:actor.actorId,command:c});
  const replay=s.idempotency.find(i=>i.key===c.idempotencyKey);
  if(replay) {
    if(replay.requestDigest!==digest) fail('idempotency_conflict','key was used for another command');
    const proposal=c.type==='accept'?s.proposals.find(p=>p.id===c.proposalId):undefined;
    const artifactKey=artifact?.input?.idempotencyKey ?? (proposal?.envelope.recovery ? `native-recovery:${proposal.digest}` : undefined);
    const acceptedVersionId=artifactKey?artifact?.tx.getIdempotency(s.organizationId,artifactKey)?.acceptedVersionId:undefined;
    return {state:s,replayed:true,resultId:replay.resultId,artifactWrites:[],...(acceptedVersionId?{acceptedVersionId}:{})};
  }
  if(c.expectedGeneration!==s.generation) fail('revision_conflict','project generation changed');
  if(c.type!=='draftKnowledge' && c.type!=='draftScenario' && c.type!=='prepareProposal' && c.type!=='exchangeHandoff' && c.type!=='recordEvidence') authority(s,actor.actorId,true);
  let resultId:string|null=null;
  let artifactWrites:LedgerWrite[]=[];
  let acceptedVersionId:string|undefined;
  switch(c.type) {
    case 'draftKnowledge': case 'draftScenario': {
      const r=c.record; authored(s,r,actor);
      if(r.confirmation!==null || r.archived) fail('authority_denied','draft cannot carry confirmation or archival');
      if(auth.role==='agent') {
        const m=s.mandates.filter(m=>m.agentId===actor.actorId && !m.revokedAt && m.operations.includes('knowledge:propose')).find(m=>{try{mandate(s,m.id,actor.now);return true;}catch{return false;}});
        if(!m) fail('mandate_scope_denied','active knowledge proposal mandate required');
      }
      if(c.type==='draftKnowledge') appendRevision(s.knowledge,c.record); else appendRevision(s.scenarios,c.record);
      resultId=r.id; break;
    }
    case 'confirmKnowledge': case 'archiveKnowledge': case 'confirmScenario': {
      if(s.decisions.some(d=>d.id===c.decisionId)) fail('revision_conflict','decision identity already exists');
      if(c.type==='confirmScenario') {
        const scenario=s.scenarios.find(r=>r.id===c.id&&r.revision===c.revision);
        if(scenario?.ruleRefs.some(ref=>!s.knowledge.some(r=>r.id===ref.id&&r.revision===ref.revision&&r.confirmation!==null&&!r.archived)))fail('revision_conflict','scenario references unavailable confirmed knowledge');
        confirm(s,s.scenarios,c.id,c.revision,c.decisionId,actor);
      } else confirm(s,s.knowledge,c.id,c.revision,c.decisionId,actor,c.type==='archiveKnowledge');
      const subject=hashCanonicalSync({domain:'cf.knowledge-confirmation/1',projectId:s.projectId,type:c.type,id:c.id,revision:c.revision});
      unique(s.decisions,{schemaVersion:1,organizationId:s.organizationId,projectId:s.projectId,id:c.decisionId,author:actor.actorId,createdAt:actor.now,envelopeDigest:subject,innerProposalHash:null,action:'approve',explanation:c.explanation,authorityRevision:auth.revision});
      refreshKnowledge(s); addManifest(s,actor,c.decisionId+':manifest','outstanding',undefined,c.decisionId); resultId=c.decisionId; break;
    }
    case 'upsertOutcome': authored(s,c.record,actor); appendRevision(s.outcomes,c.record); resultId=c.record.id; break;
    case 'issueMandate': {
      const r=c.record; authored(s,r,actor);
      if(r.issuer!==actor.actorId || r.revokedAt!==null || r.revocationGeneration!==0 || r.issuedAt!==actor.now || Date.parse(r.expiresAt)<=Date.parse(actor.now) || r.revision!==1 || s.mandates.some(m=>m.id===r.id)) fail('invalid_project_record','invalid new mandate');
      authority(s,r.agentId); s.mandates.push(r); resultId=r.id; break;
    }
    case 'exchangeHandoff': {
      const r=c.record; authored(s,r,actor); const m=mandate(s,r.mandateId,actor.now);
      if(r.agentId!==actor.actorId || r.agentId!==m.agentId || r.taskId!==m.taskId || r.mandateRevision!==m.revision || r.knowledgeHead!==s.knowledgeHead || r.startedAt!==actor.now || r.endedAt!==null || r.status!=='active' || r.proposalIds.length || !m.operations.includes('context:read') || s.attempts.filter(a=>a.mandateId===m.id).length>=m.maxAttempts) fail('mandate_scope_denied','attempt exceeds current mandate');
      unique(s.attempts,r); resultId=r.id; break;
    }
    case 'revokeMandate': case 'renewMandate': {
      const m=s.mandates.filter(m=>m.id===c.id).sort((a,b)=>b.revision-a.revision)[0];
      if(!m || m.revision!==c.revision || m.revokedAt) fail('revision_conflict','mandate revision changed');
      if(c.type==='renewMandate' && Date.parse(c.expiresAt)<=Date.parse(actor.now)) fail('invalid_project_record','renewal must expire in future');
      s.mandates.push({...m!,revision:c.revision+1,author:actor.actorId,createdAt:actor.now,...(c.type==='revokeMandate'?{revokedAt:actor.now,revocationGeneration:m!.revocationGeneration+1}:{expiresAt:c.expiresAt})});
      if(c.type==='revokeMandate') s.attempts=s.attempts.map(a=>a.mandateId===c.id?{...a,status:'revoked' as const,endedAt:actor.now}:a);
      resultId=c.id; break;
    }
    case 'prepareProposal': authored(s,c.record,actor); checkProposal(s,c.record,actor.now); if(auth.role==='agent' && !s.attempts.some(a=>a.id===c.record.envelope.attemptId && a.agentId===actor.actorId)) fail('mandate_scope_denied','agent must submit its own attempt'); unique(s.proposals,c.record); if(c.record.envelope.attemptId){const attempt=s.attempts.find(a=>a.id===c.record.envelope.attemptId)!;attempt.status='submitted';attempt.proposalIds.push(c.record.id);} resultId=c.record.id; break;
    case 'recordDecision': {
      authored(s,c.record,actor); const p=s.proposals.find(p=>p.digest===c.record.envelopeDigest);
      if(!p || p.envelope.innerProposalHash!==c.record.innerProposalHash || c.record.authorityRevision!==auth.revision) fail('review_subject_changed','decision must bind current envelope and inner proposal');
      checkProposal(s,p!,actor.now); unique(s.decisions,c.record); resultId=c.record.id; break;
    }
    case 'recordEvidence': {
      const r=c.record; scope(s,r); const p=s.proposals.find(p=>p.digest===r.envelopeDigest);
      if(!p || r.buildDigest!==p.envelope.buildDigest || r.runtimeRecipeDigest!==p.envelope.runtimeRecipeDigest || !p.envelope.requiredScenarios.some(q=>q.id===r.scenarioId && q.revision===r.scenarioRevision && q.verifierDigest===r.verifierDigest && q.method===r.method) || Date.parse(r.startedAt)>Date.parse(r.completedAt) || Date.parse(r.completedAt)>Date.parse(actor.now)) fail('scenario_evidence_invalid','evidence subject or timing does not match');
      if(r.provenance==='runner-verified') {if(!actor.trustedRunner || actor.trustedRunner.runnerId!==r.actor || r.method!=='automated') fail('scenario_evidence_invalid','verified runner provenance is required');}
      else if(r.provenance==='human-attested') {authority(s,actor.actorId,true); if(r.actor!==actor.actorId || r.author!==actor.actorId || r.method!=='manual') fail('scenario_evidence_invalid','manual observation must identify authenticated reviewer');}
      else fail('scenario_evidence_invalid','imported evidence cannot authorize acceptance');
      if(Date.parse(r.createdAt)>Date.parse(actor.now)) fail('scenario_evidence_invalid','evidence recording time mismatch');
      if(r.supersedes && (!s.evidence.some(e=>e.id===r.supersedes && e.envelopeDigest===r.envelopeDigest && e.scenarioId===r.scenarioId && e.scenarioRevision===r.scenarioRevision) || s.evidence.some(e=>e.supersedes===r.supersedes))) fail('scenario_evidence_invalid','superseded evidence must have identical subject');
      unique(s.evidence,r); resultId=r.id; break;
    }
    case 'accept': {
      const p=s.proposals.find(p=>p.id===c.proposalId); if(!p) fail('review_subject_changed','proposal unavailable'); checkProposal(s,p!,actor.now);
      if(s.manifests.some(m=>m.envelopeDigest===p!.digest)) fail('review_subject_changed','proposal already accepted');
      const d=s.decisions.find(d=>d.id===c.decisionId);
      if(!d || d.action!=='approve' || d.envelopeDigest!==p!.digest || d.innerProposalHash!==p!.envelope.innerProposalHash || d.createdAt>actor.now) fail('review_subject_changed','exact approval required');
      const reviewer=authority(s,d!.author,true); if(reviewer.revision!==d!.authorityRevision) fail('authority_denied','approval authority changed');
      const e=p!.envelope; const evidenceIds:string[]=[];
      for(const q of e.innerProposalId===null && !e.recovery ? [] : e.requiredScenarios) {
        const pool=s.evidence.filter(r=>r.envelopeDigest===p!.digest && r.scenarioId===q.id && r.scenarioRevision===q.revision && r.verifierDigest===q.verifierDigest && r.method===q.method && r.buildDigest===e.buildDigest && r.runtimeRecipeDigest===e.runtimeRecipeDigest);
        const active=pool.filter(r=>!pool.some(n=>n.supersedes===r.id));
        if(!active.length || active.some(r=>r.result!=='pass' || r.provenance===(q.method==='automated'?'human-attested':'runner-verified') || r.provenance==='imported-untrusted')) fail('scenario_evidence_missing','every required scenario needs current passing evidence');
        evidenceIds.push(...active.map(r=>r.id));
      }
      if(e.innerProposalId!==null) {
        if(!artifact?.input) fail('project_mode_unsupported','source acceptance requires atomic artifact transaction');
        const inner=artifact!.tx.getProposal(artifact!.input!.proposalId);
        if(!inner || inner.organizationId!==s.organizationId || inner.projectId!==s.projectId || inner.proposalHash!==e.innerProposalHash || artifact!.input!.proposalId!==e.innerProposalId || artifact!.input!.proposalHash!==e.innerProposalHash || artifact!.input!.policyRevision!==e.policyRevision || artifact!.input!.actor.id!==actor.actorId) fail('review_subject_changed','inner proposal identity does not match envelope');
        const expected=new Map(s.sourceHeads.map(h=>[h.resourceId,h.revisionId]));
        for(const h of artifact!.input!.newHeads) {if(!expected.has(h.resourceId)) fail('review_subject_changed','source change is outside project');expected.set(h.resourceId,h.revisionId);}
        if(!same(heads(e.sourceHeads),heads([...expected].map(([resourceId,revisionId])=>({resourceId,revisionId}))))) fail('review_subject_changed','envelope must bind complete resulting source heads');
        const decision=planCommit(artifact!.tx,artifact!.input!,actor.now);
        if(!decision.ok) fail(decision.code==='dependency_stale'?'knowledge_stale':'review_subject_changed',decision.detail??decision.code);
        if(decision.ok) {artifactWrites=decision.replayed?[]:decision.writes;acceptedVersionId=decision.acceptedVersionId;}
        s.sourceHeads=e.sourceHeads;
      } else if(e.recovery) {
        if(!artifact) fail('project_mode_unsupported','recovery requires atomic artifact transaction');
        const recovered=planProjectRecovery(artifact!.tx,s,e,actor.actorId,actor.now);
        artifactWrites=recovered.artifactWrites;acceptedVersionId=recovered.acceptedVersionId;s.sourceHeads=e.sourceHeads;
      } else if(!same(heads(e.sourceHeads),heads(s.sourceHeads))) fail('review_subject_changed','knowledge-only acceptance cannot move source');
      if(e.proposedKnowledge.length || e.proposedScenarios.length) {
        for(const r of e.proposedKnowledge) confirm(s,s.knowledge,r.id,r.revision,c.decisionId,actor);
        for(const r of e.proposedScenarios) confirm(s,s.scenarios,r.id,r.revision,c.decisionId,actor);
        refreshKnowledge(s);
      }
      if(e.attemptId){const attempt=s.attempts.find(a=>a.id===e.attemptId)!;attempt.status='completed';attempt.endedAt=actor.now;}
      addManifest(s,actor,p!.id+':manifest',(e.innerProposalId!==null || e.recovery!==null) && !e.proposedKnowledge.length && !e.proposedScenarios.length?'verified':'outstanding',p!,c.decisionId,evidenceIds); resultId=last(s.manifests)!.hash; break;
    }
  }
  s.generation++;
  s.idempotency.push({key:c.idempotencyKey,requestDigest:digest,resultGeneration:s.generation,resultId});
  const state=ProjectStateSchema.parse(s);
  return {state,replayed:false,resultId,artifactWrites,...(acceptedVersionId?{acceptedVersionId}:{})};
}
export function planProjectAccept(tx:LedgerTx,state:ProjectState,command:unknown,actor:ProjectActor,artifactInput?:AcceptInput):ProjectTransition {
  const parsed=ProjectCommandSchema.safeParse(command);
  if(!parsed.success || parsed.data.type!=='accept') fail('invalid_project_record','accept command required');
  return transition(state,command,actor,{tx,...(artifactInput?{input:artifactInput}:{})});
}

/** Trusted migration/bootstrap only: call after authoritative no-in-flight and ownership checks. */
export function createNativeGenesis(input: ProjectState, actor: ProjectActor): ProjectState {
  const state = ProjectStateSchema.parse(input);
  authority(state, actor.actorId, true);
  if(state.generation !== 0 || state.manifests.length || state.knowledge.length || state.scenarios.length || state.idempotency.length) fail('revision_conflict','genesis requires a new project state');
  if(new Set(state.sourceHeads.map(h=>h.resourceId)).size!==state.sourceHeads.length) fail('invalid_project_record','duplicate genesis source');
  addManifest(state,actor,'genesis','historical-unverified');
  return ProjectStateSchema.parse(state);
}
