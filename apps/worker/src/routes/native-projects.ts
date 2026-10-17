/** G1 reference API. Authoritative records and acceptance live in OrgLedger, never D1. */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ProjectStateSchema, computeProjectProposalHash, sha256HexSync, currentConfirmed, type ProjectState, type ProjectProposalEnvelope } from '@commonforge-org/core';
import { exportProjectBundle, validateProjectBundle, ProjectCommandSchema } from '@commonforge-org/ledger';
import { signScenarioRequest, verifyScenarioResult, scenarioBuildDigest, type ScenarioVerificationRequest } from '@commonforge-org/runner-protocol';
import type { AppEnv } from '../context.js';
import { ApiError, conflict, forbidden, notFound, readJson, badRequest } from '../lib/http.js';
import { newId, randomToken } from '../lib/crypto.js';
import { orgActor, readableProject, canReadResource, canWriteResource, taskActor, requireUser, type OrgActor } from '../middleware/authz.js';
import { listMounts, getProject, getRole, projectPolicy } from '../services/directory.js';
import { getTask, listWorkspaces, revokeWorkspaceWriteTokens } from '../services/tasks.js';
import { leaseTokenHash } from '../services/auth.js';
import { acceptInputFor, afterProposalAccepted, currentApprovals } from '../services/proposals.js';
import { userRef } from '../services/events.js';
import { nativeVerifierUrl, nativeVerifierCapabilities } from '../services/native-verifier.js';
import { exportNativePayloads } from '../services/native-payloads.js';

export const nativeProjectRoutes = new Hono<AppEnv>();
const root='/orgs/:org/projects/:pid/native';
const Idempotent=z.object({idempotencyKey:z.string().min(1).max(256)}).strict();
export async function nativeState(c:Context<AppEnv>, actor:OrgActor, pid:string):Promise<ProjectState|null> {
  const svc=c.get('svc'); await readableProject(svc,actor,pid);
  // Small G1 packets include ALL rules. Refuse assignment instead of leaking hidden dependencies.
  for(const m of await listMounts(svc.db,actor.orgId,pid)) if(!await canReadResource(svc,actor,m.resource_id)) throw forbidden('context_forbidden','complete project context is unavailable');
  const value=await svc.ledger(actor.orgId).getNativeProject(pid);
  return value ? ProjectStateSchema.parse(JSON.parse(value)) : null;
}
nativeProjectRoutes.get(root,async c=>{
  const actor=await orgActor(c,c.req.param('org'),['owner','developer']);
  return c.json({protocolVersion:1,state:await nativeState(c,actor,c.req.param('pid'))});
});
nativeProjectRoutes.get(`${root}/:collection`,async c=>{
  const actor=await orgActor(c,c.req.param('org'),['owner','developer']);
  const s=await nativeState(c,actor,c.req.param('pid'));if(!s)throw notFound();
  const key=c.req.param('collection');
  if(key==='bundle') return c.json({bundle:exportProjectBundle(s,c.req.query('includePayloads')==='1'?await exportNativePayloads(c.get('svc'),actor.orgId,s.projectId,s):[]),importedHistory:(await c.get('svc').ledger(actor.orgId).nativeArchive(s.projectId)) ? JSON.parse((await c.get('svc').ledger(actor.orgId).nativeArchive(s.projectId))!) : null});
  const collections=['outcomes','knowledge','scenarios','proposals','decisions','evidence','manifests','observations','attempts'] as const;
  if(!collections.includes(key as typeof collections[number]))throw notFound();
  const cursor=Number(c.req.query('cursor')??0),limit=Number(c.req.query('limit')??50);
  if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isInteger(limit)||limit<1||limit>100)throw badRequest('invalid_request');
  const items=s[key as typeof collections[number]];
  return c.json({items:items.slice(cursor,cursor+limit),nextCursor:cursor+limit<items.length?String(cursor+limit):null,generation:s.generation});
});
nativeProjectRoutes.post(`${root}/enable`,async c=>{
  const actor=await orgActor(c,c.req.param('org'),['owner']);await readJson(c,Idempotent);
  const svc=c.get('svc'),pid=c.req.param('pid');const p=await readableProject(svc,actor,pid);
  const existing=await nativeState(c,actor,pid);if(existing)return c.json({protocolVersion:1,state:existing,replayed:true});
  if(projectPolicy(p).staging)throw conflict('project_mode_unsupported','disable staging and settle existing work before enablement');
  // Do not reinterpret an in-flight legacy operation as an agent-native operation.
  for(const [table,column,states] of [['tasks','state',"'accepted','canceled','failed'"],['file_changes','state',"'added','canceled','failed'"],['releases','state',"'live','failed','canceled','recovered'"]] as const){
    const pending=await svc.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE org_id=? AND project_id=? AND ${column} NOT IN (${states})`).bind(actor.orgId,pid).first<{n:number}>();
    if(pending?.n)throw conflict('project_mode_unsupported','settle in-flight work before enablement');
  }
  const sourceHeads=[];
  for(const m of await listMounts(svc.db,actor.orgId,pid)){
    const shared=await svc.db.prepare('SELECT count(*) AS n FROM mounts WHERE org_id=? AND resource_id=? AND project_id!=?').bind(actor.orgId,m.resource_id,pid).first<{n:number}>();
    if(shared?.n)throw conflict('project_mode_unsupported','agent-native source resources must belong to one project');
    const h=await svc.ledger(actor.orgId).getHead(m.resource_id);if(!h)throw conflict('resource_not_ready','finish folder setup before enablement');
    sourceHeads.push({resourceId:m.resource_id,revisionId:h.revisionId});
  }
  const members=await svc.db.prepare("SELECT user_id,role FROM memberships WHERE org_id=? AND role IN ('owner','developer')").bind(actor.orgId).all<{user_id:string;role:'owner'|'developer'}>();
  const state=JSON.parse(await svc.ledger(actor.orgId).enableNativeProject({organizationId:actor.orgId,projectId:pid,actorId:actor.userId,policyRevision:p.policy_revision,sourceHeads,authorities:members.results.map(m=>({principalId:m.user_id,role:m.role,revision:1,active:true}))}));
  return c.json({protocolVersion:1,state},201);
});
// Explicit owner enrollment after current directory access is checked. Old decisions and
// mandates remain revoked; the incremented authority revision cannot validate old approvals.
nativeProjectRoutes.post(`${root}/authorities/:principal/reconcile`,async c=>{
  const actor=await orgActor(c,c.req.param('org'),['owner']);const pid=c.req.param('pid');
  const body=await readJson(c,Idempotent.extend({expectedGeneration:z.number().int().nonnegative()}));const state=await nativeState(c,actor,pid);if(!state)throw notFound();
  const svc=c.get('svc'),principalId=c.req.param('principal'),role=await getRole(svc.db,actor.orgId,principalId);
  if(role!=='owner'&&role!=='developer')throw forbidden('authority_denied','member must currently be an owner or developer');
  const target={...actor,userId:principalId,role};
  await readableProject(svc,target,pid);
  for(const m of await listMounts(svc.db,actor.orgId,pid))if(!await canReadResource(svc,target,m.resource_id)||!await canWriteResource(svc,target,m.resource_id))throw forbidden('authority_denied','member must have complete project source access');
  const result=await svc.ledger(actor.orgId).reconcileNativeAuthority(actor.orgId,pid,actor.userId,principalId,role,body.expectedGeneration,body.idempotencyKey);
  return c.json({state:JSON.parse(result)});
});
nativeProjectRoutes.post(`${root}/commands`,async c=>{
  const actor=await orgActor(c,c.req.param('org'),['owner','developer']);const pid=c.req.param('pid');
  const state=await nativeState(c,actor,pid);if(!state)throw notFound();
  const command=await readJson(c,ProjectCommandSchema);const svc=c.get('svc'),ledger=svc.ledger(actor.orgId);
  // Agent mandate/attempt creation is performed only by the scoped handoff service.
  if(['issueMandate','exchangeHandoff'].includes(command.type))throw forbidden('mandate_scope_denied','use a task handoff');
  if(command.type==='recordEvidence' && command.record.provenance!=='human-attested')throw forbidden('scenario_evidence_invalid','automated evidence must come from a verified runner');
  let input:Awaited<ReturnType<typeof acceptInputFor>>|undefined;
  if(command.type==='accept'){
    const proposal=state.proposals.find(p=>p.id===command.proposalId);if(!proposal)throw notFound();
    if(proposal.envelope.innerProposalId){
      const inner=await ledger.getProposal(proposal.envelope.innerProposalId);if(!inner)throw notFound();
      for(const r of [...inner.resourceChanges,...inner.assetManifestChanges])if(!await canWriteResource(svc,actor,r.resourceId))throw forbidden('no_write_grant');
      input=await acceptInputFor(svc,inner,`native:${command.idempotencyKey}`,userRef(actor.userId));
      // Dual binding and current reviewer authority are checked again atomically by planProjectAccept.
      const d=state.decisions.find(d=>d.id===command.decisionId);if(!d)throw conflict('review_subject_changed','record exact decision first');
      input.approvals=await currentApprovals(svc,actor.orgId,pid,[{approvalId:`native-${sha256HexSync(d.id).slice(0,40)}`,proposalId:inner.proposalId,proposalHash:inner.proposalHash,approver:{kind:'user',id:d.author},role:state.authorities.find(a=>a.principalId===d.author)?.role==='owner'?'owner':'developer',approvedAt:d.createdAt} as never],inner);
    }
  }
  const result=JSON.parse(await ledger.nativeCommand(actor.orgId,pid,command,actor.userId,input));
  if(input && result.acceptedVersionId){const p=await ledger.getProposal(input.proposalId);if(p)await afterProposalAccepted(svc,{orgId:actor.orgId,p,projectId:pid,userId:actor.userId,acceptedVersionId:result.acceptedVersionId,replayed:result.replayed});}
  return c.json(result);
});
nativeProjectRoutes.post('/tasks/:id/native/handoff',async c=>{
  const svc=c.get('svc'),task=await getTask(svc,c.req.param('id'));if(!task)throw notFound();
  const actor=await orgActor(c,task.org_id,['owner','developer']);await nativeState(c,actor,task.project_id);
  if(task.lease_hash && (task.lease_expires_at??0)>svc.now().getTime() && task.lease_holder!==actor.userId && actor.role!=='owner')throw conflict('lease_held','only an owner may replace another person’s active handoff');
  const body=await readJson(c,z.object({agentId:z.string().min(1).max(128)}).strict());
  const ws=await listWorkspaces(svc,task.task_id);for(const w of ws)if(!await canReadResource(svc,actor,w.resource_id)||w.access==='write'&&!await canWriteResource(svc,actor,w.resource_id))throw forbidden('context_forbidden','task context unavailable');
  const secret=randomToken('cfh'),code=`${task.org_id}.${task.project_id}.${secret}`;
  const result=JSON.parse(await svc.ledger(task.org_id).issueNativeHandoff(task.org_id,task.project_id,actor.userId,task.task_id,`agent:${body.agentId}:${sha256HexSync(code).slice(0,16)}`,ws.filter(w=>w.access==='write').map(w=>w.resource_id),sha256HexSync(code)));
  c.header('cache-control','no-store');return c.json({...result,code,taskId:task.task_id},201);
});
nativeProjectRoutes.post('/auth/task/verify',async c=>{
  const body=await readJson(c,z.object({code:z.string().min(1).max(1024)}).strict());
  const [org,pid]=body.code.split('.');if(!org||!pid)throw new ApiError(401,'invalid_handoff','handoff unavailable');
  const svc=c.get('svc'),token=randomToken('cfl');let result;
  try{result=JSON.parse(await svc.ledger(org).exchangeNativeHandoff(org,pid,sha256HexSync(body.code),sha256HexSync(token)));}catch{throw new ApiError(401,'invalid_handoff','handoff unavailable');}
  const task=await getTask(svc,result.taskId);if(!task || task.org_id!==org || task.project_id!==pid || !['ready','running'].includes(task.state) || !await getRole(svc.db,org,result.issuer))throw new ApiError(401,'invalid_handoff','handoff unavailable');
  await revokeWorkspaceWriteTokens(svc,org,await listWorkspaces(svc,task.task_id));
  const row=await svc.db.prepare("UPDATE tasks SET lease_hash=?,lease_generation=lease_generation+1,lease_expires_at=?,lease_holder=?,state='running',updated_at=? WHERE task_id=? AND lease_generation=? RETURNING lease_generation").bind(await leaseTokenHash(svc,token),Date.parse(result.expiresAt),result.issuer,svc.nowIso(),task.task_id,task.lease_generation).first<{lease_generation:number}>();
  if(!row)throw conflict('revision_conflict','task changed; request a new handoff');
  c.header('cache-control','no-store');return c.json({...result,protocolVersion:1,leaseToken:token,leaseGeneration:row.lease_generation});
});
nativeProjectRoutes.get('/tasks/:id/native/context',async c=>{
  const svc=c.get('svc'),task=await getTask(svc,c.req.param('id'));if(!task)throw notFound();
  const actor=await taskActor(c,task,{allowUser:false});const p=c.get('principal');
  if(p?.kind!=='agent'||!p.native)throw forbidden('mandate_scope_denied','use a scoped project handoff');
  const value=await svc.ledger(task.org_id).resolveNativeToken(task.project_id,p.native.tokenHash);if(!value)throw forbidden('mandate_revoked');
  const data=JSON.parse(value);return c.json({protocolVersion:1,attemptId:data.attemptId,mandateId:data.mandateId,agentId:data.agentId,generation:data.generation,context:data.packet,knowledgeStale:data.knowledgeStale});
});
nativeProjectRoutes.get('/tasks/:id/native/results',async c=>{
  const svc=c.get('svc'),task=await getTask(svc,c.req.param('id'));if(!task)throw notFound();await taskActor(c,task,{allowUser:false});
  const p=c.get('principal');if(p?.kind!=='agent'||!p.native)throw forbidden('mandate_scope_denied');
  const value=await svc.ledger(task.org_id).getNativeProject(task.project_id);if(!value)throw notFound();const s=ProjectStateSchema.parse(JSON.parse(value));
  const proposals=s.proposals.filter(r=>r.envelope.attemptId===p.native!.attemptId);const digests=new Set(proposals.map(r=>r.digest));
  return c.json({protocolVersion:1,generation:s.generation,attempt:s.attempts.find(a=>a.id===p.native!.attemptId),proposals:proposals.slice(-100),evidence:s.evidence.filter(e=>digests.has(e.envelopeDigest)).slice(-100),decisions:s.decisions.filter(d=>digests.has(d.envelopeDigest)).slice(-100),manifests:s.manifests.filter(m=>m.envelopeDigest&&digests.has(m.envelopeDigest)).slice(-100)});
});
nativeProjectRoutes.post('/tasks/:id/native/commands',async c=>{
  const svc=c.get('svc'),task=await getTask(svc,c.req.param('id'));if(!task)throw notFound();await taskActor(c,task,{allowUser:false});
  const p=c.get('principal');if(p?.kind!=='agent'||!p.native)throw forbidden('mandate_scope_denied');
  const command=await readJson(c,ProjectCommandSchema);
  if(!['draftKnowledge','draftScenario','prepareProposal'].includes(command.type))throw forbidden('mandate_scope_denied','agent operation outside mandate');
  if(command.type==='prepareProposal' && (command.record.envelope.attemptId!==p.native.attemptId || command.record.envelope.mandateId!==p.native.mandateId))throw forbidden('mandate_scope_denied','proposal must belong to this task attempt');
  if(command.type==='prepareProposal' && command.record.envelope.innerProposalId!==null)throw forbidden('mandate_scope_denied','prepare source through this task’s native/proposals endpoint so the inner task binding is verified');
  const result=JSON.parse(await svc.ledger(task.org_id).nativeCommand(task.org_id,task.project_id,command,p.native.agentId));return c.json(result);
});
/** Freeze the outer envelope only AFTER preparation/integration has fixed the inner result. */
nativeProjectRoutes.post('/tasks/:id/native/proposals',async c=>{
  const svc=c.get('svc'),task=await getTask(svc,c.req.param('id'));if(!task)throw notFound();await taskActor(c,task,{allowUser:false});
  const principal=c.get('principal');if(principal?.kind!=='agent'||!principal.native)throw forbidden('mandate_scope_denied');
  const body=await readJson(c,z.object({innerProposalId:z.string().min(1),expectedGeneration:z.number().int().nonnegative(),idempotencyKey:z.string().min(1),outcome:z.object({id:z.string(),revision:z.number().int().positive()}).nullable().default(null)}).strict());
  const ledger=svc.ledger(task.org_id),raw=await ledger.getNativeProject(task.project_id);if(!raw)throw notFound();
  const state=ProjectStateSchema.parse(JSON.parse(raw)),attempt=state.attempts.find(a=>a.id===principal.native!.attemptId),inner=await ledger.getProposal(body.innerProposalId);
  const idx=await svc.db.prepare('SELECT task_id FROM proposals_index WHERE org_id=? AND proposal_id=?').bind(task.org_id,body.innerProposalId).first<{task_id:string}>();
  if(!inner || inner.organizationId!==task.org_id || inner.projectId!==task.project_id || !idx || idx.task_id!==task.task_id || !attempt)throw notFound();
  const prepared=await acceptInputFor(svc,inner,`prepare-native:${body.idempotencyKey}`,userRef(principal.holderUserId));
  if(!prepared.evidence.length)throw conflict('scenario_evidence_missing','integrate the artifact proposal before freezing project review');
  const sourceHeads=state.sourceHeads.map(h=>({resourceId:h.resourceId,revisionId:prepared.newHeads.find(n=>n.resourceId===h.resourceId)?.revisionId??h.revisionId}));
  const capabilities=await nativeVerifierCapabilities(svc);
  const envelope:ProjectProposalEnvelope={domain:'cf.project-proposal/1',schemaVersion:1,organizationId:task.org_id,projectId:task.project_id,outcome:body.outcome,attemptId:attempt.id,mandateId:attempt.mandateId,mandateRevision:attempt.mandateRevision,contextDigest:attempt.contextDigest,innerProposalId:inner.proposalId,innerProposalHash:inner.proposalHash,sourceHeads,runtimeRecipeDigest:capabilities.runtimeRecipeDigest,buildDigest:scenarioBuildDigest(sourceHeads),expectedParent:state.manifests.at(-1)?.hash??null,expectedKnowledgeHead:state.knowledgeHead,policyRevision:state.policyRevision,proposedKnowledge:[],proposedScenarios:[],requiredScenarios:currentConfirmed(state.scenarios).filter(s=>s.required).map(s=>({id:s.id,revision:s.revision,verifierDigest:s.verifierDigest,method:s.method})),recovery:null,effects:[]};
  const proposalId=`project:${inner.proposalId}:${principal.native.attemptId}`;
  const existing=state.proposals.find(p=>p.id===proposalId);
  if(existing){if(existing.digest!==computeProjectProposalHash(envelope))throw conflict('review_subject_changed','create a new attempt for a changed review subject');return c.json({proposal:existing,state,replayed:true});}
  const record={schemaVersion:1,organizationId:task.org_id,projectId:task.project_id,id:proposalId,author:principal.native.agentId,createdAt:svc.nowIso(),envelope,digest:computeProjectProposalHash(envelope)};
  const result=JSON.parse(await ledger.nativeCommand(task.org_id,task.project_id,{type:'prepareProposal',record,expectedGeneration:body.expectedGeneration,idempotencyKey:body.idempotencyKey},principal.native.agentId));return c.json({...result,proposal:record},201);
});
nativeProjectRoutes.post(`${root}/proposals/:proposal/verify`,async c=>{
  const actor=await orgActor(c,c.req.param('org'),['owner','developer']);const pid=c.req.param('pid'),svc=c.get('svc');const s=await nativeState(c,actor,pid);if(!s)throw notFound();
  const body=await readJson(c,Idempotent);const p=s.proposals.find(p=>p.id===c.req.param('proposal'));if(!p)throw notFound();
  const url=nativeVerifierUrl(svc);
  const now=svc.nowIso();const proposedRequest:ScenarioVerificationRequest={protocolVersion:1,organizationId:actor.orgId,projectId:pid,runId:newId('run',12),envelopeDigest:p.digest,buildDigest:p.envelope.buildDigest,runtimeRecipeDigest:p.envelope.runtimeRecipeDigest,sourceHeads:p.envelope.sourceHeads,requiredScenarios:p.envelope.requiredScenarios.filter(q=>q.method==='automated'),issuedAt:now,expiresAt:new Date(Date.parse(now)+300000).toISOString()};
  const reserved=JSON.parse(await svc.ledger(actor.orgId).reserveNativeVerification(actor.orgId,pid,actor.userId,body.idempotencyKey,proposedRequest));
  if(reserved.result)return c.json(JSON.parse(reserved.result));
  const request=JSON.parse(reserved.request) as ScenarioVerificationRequest;
  const response=await fetch(`${url.replace(/\/$/,'')}/verify`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(await signScenarioRequest(request,svc.jobKey())),signal:AbortSignal.timeout(125000),redirect:'manual'});
  if(!response.ok)throw new ApiError(502,'verification_failed','runner refused verification');
  const result=await verifyScenarioResult(await response.json(),svc.jobKey(),request);
  return c.json(JSON.parse(await svc.ledger(actor.orgId).completeNativeVerification(actor.orgId,pid,actor.userId,body.idempotencyKey,result)));
});

// Import retains original history as an untrusted archive; local knowledge starts as drafts.
nativeProjectRoutes.post('/orgs/:org/native/import',async c=>{
  const actor=await orgActor(c,c.req.param('org'),['owner']);const svc=c.get('svc');
  const raw=await readJson(c,z.object({name:z.string().min(1).max(128),idempotencyKey:z.string().min(1).max(256),bundle:z.unknown()}).strict());
  const bundle=validateProjectBundle(raw.bundle);
  const pid=`p-import-${sha256HexSync(actor.orgId+':'+actor.userId+':'+raw.idempotencyKey).slice(0,20)}`;
  await svc.db.prepare('INSERT OR IGNORE INTO projects (org_id,project_id,name,created_by,created_at) VALUES (?,?,?,?,?)').bind(actor.orgId,pid,raw.name,actor.userId,svc.nowIso()).run();
  const state=JSON.parse(await svc.ledger(actor.orgId).importNativeBundle(actor.orgId,pid,actor.userId,bundle));
  return c.json({projectId:pid,state,requiresLocalConfirmation:true,sourceMaterialization:'not-performed'},201);
});
