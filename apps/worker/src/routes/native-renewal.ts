/** Explicit human renewal replaces authority; old leases and context never gain extra lifetime. */
import { Hono } from 'hono';
import { z } from 'zod';
import { canonicalJson, sha256HexSync } from '@commonforge-org/core';
import type { AppEnv } from '../context.js';
import { conflict, forbidden, notFound, readJson } from '../lib/http.js';
import { keyedHash } from '../lib/crypto.js';
import { canReadResource, canWriteResource, orgActor } from '../middleware/authz.js';
import { getTask, listWorkspaces } from '../services/tasks.js';
import { nativeState } from './native-projects.js';

export const nativeRenewalRoutes = new Hono<AppEnv>();
nativeRenewalRoutes.post('/tasks/:id/native/renew', async c => {
  const svc=c.get('svc'),task=await getTask(svc,c.req.param('id')); if(!task)throw notFound();
  const actor=await orgActor(c,task.org_id,['owner','developer']);
  if(!['ready','running'].includes(task.state))throw conflict('task_not_ready','only an open task can receive replacement authority');
  const state=await nativeState(c,actor,task.project_id);if(!state)throw notFound();
  const body=await readJson(c,z.object({mandateId:z.string().min(1).max(256),revision:z.number().int().positive(),expectedGeneration:z.number().int().nonnegative(),idempotencyKey:z.string().min(1).max(128),agentId:z.string().min(1).max(128)}).strict());
  if(task.lease_hash&&(task.lease_expires_at??0)>svc.now().getTime()&&task.lease_holder!==actor.userId&&actor.role!=='owner')throw conflict('lease_held','only an owner may replace another person’s active handoff');
  const ws=await listWorkspaces(svc,task.task_id);
  for(const w of ws)if(!await canReadResource(svc,actor,w.resource_id)||w.access==='write'&&!await canWriteResource(svc,actor,w.resource_id))throw forbidden('context_forbidden','task context unavailable');
  // Secret-keyed deterministic code permits exact retry without storing the raw bearer at rest.
  const secret=await keyedHash(svc.env.COMMONFORGE_SESSION_SECRET,'cf.native-renewal-code/1',canonicalJson({organizationId:task.org_id,projectId:task.project_id,taskId:task.task_id,actorId:actor.userId,...body}));
  const code=`${task.org_id}.${task.project_id}.cfh_${secret}`;
  const result=JSON.parse(await svc.ledger(task.org_id).issueNativeHandoff(task.org_id,task.project_id,actor.userId,task.task_id,`agent:${body.agentId}:${sha256HexSync(code).slice(0,16)}`,ws.filter(w=>w.access==='write').map(w=>w.resource_id),sha256HexSync(code),{mandateId:body.mandateId,revision:body.revision,expectedGeneration:body.expectedGeneration,idempotencyKey:body.idempotencyKey}));
  c.header('cache-control','no-store');
  return c.json({...result,protocolVersion:1,taskId:task.task_id,code,requiresFreshCheckout:true},result.replayed?200:201);
});
