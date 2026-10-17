/** Owner-requested exact artifact recovery; preparation is neither acceptance nor deployment. */
import { Hono } from 'hono';
import { z } from 'zod';
import { computeProjectProposalHash, currentConfirmed, sha256HexSync, type ProjectProposalEnvelope } from '@commonforge-org/core';
import { projectRecoveryPlanDigest, validateProjectRecovery } from '@commonforge-org/ledger';
import { scenarioBuildDigest } from '@commonforge-org/runner-protocol';
import type { AppEnv } from '../context.js';
import { conflict, forbidden, notFound, readJson } from '../lib/http.js';
import { orgActor, canWriteResource } from '../middleware/authz.js';
import { nativeState } from './native-projects.js';
import { assertNativeRecoveryEffects } from '../services/native-recovery.js';
import { nativeVerifierCapabilities } from '../services/native-verifier.js';

export const nativeRecoveryRoutes=new Hono<AppEnv>();
nativeRecoveryRoutes.post('/orgs/:org/projects/:pid/native/recoveries',async c=>{
  const actor=await orgActor(c,c.req.param('org'),['owner','developer']),pid=c.req.param('pid'),svc=c.get('svc');
  const body=await readJson(c,z.object({manifestHash:z.string().regex(/^[a-f0-9]{64}$/),expectedGeneration:z.number().int().nonnegative(),idempotencyKey:z.string().min(1).max(256)}).strict());
  const state=await nativeState(c,actor,pid);if(!state)throw notFound();
  await assertNativeRecoveryEffects(svc,state);
  for(const head of state.sourceHeads)if(!await canWriteResource(svc,actor,head.resourceId))throw forbidden('no_write_grant');
  const id=`recovery:${sha256HexSync(`${actor.userId}:${body.idempotencyKey}`)}`,existing=state.proposals.find(p=>p.id===id);
  if(existing){if(existing.envelope.recovery?.manifestHash!==body.manifestHash)throw conflict('idempotency_conflict','recovery key already used');return c.json({proposal:existing,state,replayed:true});}
  if(state.generation!==body.expectedGeneration)throw conflict('revision_conflict','project changed; review the current recovery plan');
  const target=state.manifests.find(m=>m.hash===body.manifestHash);if(!target)throw notFound();
  const capabilities=await nativeVerifierCapabilities(svc);
  const envelope:ProjectProposalEnvelope={domain:'cf.project-proposal/1',schemaVersion:1,organizationId:actor.orgId,projectId:pid,outcome:null,attemptId:null,mandateId:null,mandateRevision:null,contextDigest:null,innerProposalId:null,innerProposalHash:null,sourceHeads:target.sourceHeads,runtimeRecipeDigest:capabilities.runtimeRecipeDigest,buildDigest:scenarioBuildDigest(target.sourceHeads),expectedParent:state.manifests.at(-1)?.hash??null,expectedKnowledgeHead:state.knowledgeHead,policyRevision:state.policyRevision,proposedKnowledge:[],proposedScenarios:[],requiredScenarios:currentConfirmed(state.scenarios).filter(s=>s.required).map(s=>({id:s.id,revision:s.revision,verifierDigest:s.verifierDigest,method:s.method})),recovery:{manifestHash:body.manifestHash,planDigest:projectRecoveryPlanDigest(state,body.manifestHash)},effects:[]};
  validateProjectRecovery(state,envelope);
  const proposal={schemaVersion:1 as const,organizationId:actor.orgId,projectId:pid,id,author:actor.userId,createdAt:svc.nowIso(),envelope,digest:computeProjectProposalHash(envelope)};
  const result=JSON.parse(await svc.ledger(actor.orgId).nativeCommand(actor.orgId,pid,{type:'prepareProposal',record:proposal,expectedGeneration:body.expectedGeneration,idempotencyKey:body.idempotencyKey},actor.userId));
  return c.json({...result,proposal},201);
});
