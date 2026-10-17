/** Task-scoped proposal preparation; grants neither acceptance nor release authority. */
import { Hono } from 'hono';
import { z } from 'zod';
import { ProjectStateSchema, sha256HexSync, type CandidateRecord, type ProposalRecord } from '@commonforge-org/core';
import type { AppEnv } from '../context.js';
import { conflict, forbidden, notFound, readJson } from '../lib/http.js';
import { taskActor } from '../middleware/authz.js';
import { userRef } from '../services/events.js';
import { issueIntegration } from '../services/integration.js';
import { getProposalIndex, latestIntegration, proposeTaskWorkspaces } from '../services/proposals.js';
import { getTask, listWorkspaces } from '../services/tasks.js';

export const nativeSubmitRoutes = new Hono<AppEnv>();
nativeSubmitRoutes.post('/tasks/:id/native/submit', async c => {
  const svc = c.get('svc');
  const task = await getTask(svc, c.req.param('id')); if (!task) throw notFound();
  await taskActor(c, task, { allowUser: false });
  const principal = c.get('principal');
  if (principal?.kind !== 'agent' || !principal.native) throw forbidden('mandate_scope_denied', 'use task-scoped project authority');
  await readJson(c, z.object({}).strict());
  const ledger = svc.ledger(task.org_id);
  const stored = await ledger.getNativeProject(task.project_id); if (!stored) throw notFound();
  const state = ProjectStateSchema.parse(JSON.parse(stored));
  const attempt = state.attempts.find(a => a.id === principal.native!.attemptId);
  const mandate = state.mandates.filter(m => m.id === principal.native!.mandateId).at(-1);
  if (!attempt || !mandate || mandate.revokedAt || Date.parse(mandate.expiresAt) <= svc.now().getTime() || !mandate.operations.includes('candidate:submit')) throw forbidden('mandate_revoked');
  if (attempt.knowledgeHead !== state.knowledgeHead) throw conflict('knowledge_stale', 'requirements changed; obtain a fresh task handoff');
  if (attempt.taskId !== task.task_id || mandate.taskId !== task.task_id || attempt.agentId !== principal.native.agentId) throw forbidden('mandate_scope_denied');
  const proposalId = `prop-native-${sha256HexSync(attempt.id).slice(0, 40)}`;
  let proposal: ProposalRecord | null = await ledger.getProposal(proposalId);
  if (!proposal) {
    const workspaces = await listWorkspaces(svc, task.task_id);
    const ids = await svc.db.prepare('SELECT candidate_id FROM task_candidates WHERE task_id = ? ORDER BY created_at').bind(task.task_id).all<{ candidate_id: string }>();
    const byResource = new Map<string, CandidateRecord>();
    for (const { candidate_id: id } of ids.results) {
      const record = await ledger.getCandidate(id);
      if (!record || !['frozen', 'prepared'].includes(record.state)) throw conflict('candidate_not_available', 'wait for task candidate preparation');
      if (!mandate.resourceIds.includes(record.candidate.resourceId)) throw forbidden('mandate_scope_denied');
      byResource.set(record.candidate.resourceId, record);
    }
    const assetWs = workspaces.filter(w => w.provider === 'r2-assets' && w.state === 'frozen' && w.asset_manifest_id);
    if (assetWs.some(w => !mandate.resourceIds.includes(w.resource_id))) throw forbidden('mandate_scope_denied');
    if (!byResource.size && !assetWs.length) throw conflict('nothing_to_integrate', 'submit task source candidates first');
    proposal = await proposeTaskWorkspaces(svc, { orgId: task.org_id, task, proposalId, candidates: [...byResource.values()], assetWs, actor: principal.holderUserId, detail: { nativeAttemptId: attempt.id, nativeAgentId: attempt.agentId } });
  }
  const index = await getProposalIndex(svc, task.org_id, proposalId);
  if (!index || index.task_id !== task.task_id || proposal.projectId !== task.project_id) throw conflict('review_subject_changed', 'proposal task binding changed');
  const integrated = await latestIntegration(svc, task.org_id, proposalId);
  if (integrated?.receipt.evidence.proposalHash === proposal.proposalHash) return c.json({ innerProposalId: proposalId, jobId: integrated.jobId, state: 'integrated' });
  const { jobId } = await issueIntegration(svc, userRef(principal.holderUserId), proposal, index, { jobKey: `native:${attempt.id}:${proposal.proposalHash}` });
  return c.json({ innerProposalId: proposalId, jobId, state: 'queued' }, 202);
});
