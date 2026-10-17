/** Prepare an actual independently verified source proposal for owner browser review. */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit, RUNNER_IDENTITY_ENV } from './git.js';
const session = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as { ownerToken: string; organizationId: string; projectId: string };
const operator = JSON.parse(await readFile(process.argv[3]!, 'utf8')) as { workerUrl: string };
async function api(method: string, path: string, body?: unknown, token = session.ownerToken): Promise<any> {
  const res = await fetch(`${operator.workerUrl}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json(); if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`); return data;
}
async function waitFor(path: string, ready: (data: any) => boolean) { const end = Date.now() + 60000; while (Date.now() < end) { const data = await api('GET', path); if (ready(data)) return data; await new Promise(r => setTimeout(r, 250)); } throw new Error('timed out'); }
const native = `/orgs/${session.organizationId}/projects/${session.projectId}/native`;
const task = await api('POST', `/orgs/${session.organizationId}/projects/${session.projectId}/tasks`, { title: 'Review health metadata follow-up', request: 'Expose review readiness in synthetic fixture health while preserving all corrected scheduling rules.', writeMounts: ['app'] });
const ready = await waitFor(`/tasks/${task.taskId}`, data => data.state === 'ready');
const handoff = await api('POST', `/tasks/${task.taskId}/native/handoff`, { agentId: 'browser-review-preparation-client' });
const agent = await api('POST', '/auth/task/verify', { code: handoff.code });
const credential = await api('POST', `/tasks/${task.taskId}/credential`, { mountName: 'app', access: 'write' }, agent.leaseToken);
const root = await mkdtemp(join(tmpdir(), 'g1-pending-browser-review-')), work = join(root, 'candidate'), git = createGit({ allowHttp: true });
const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${credential.remoteUrl}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.secret}` };
await git.ok(['clone', '-q', credential.remoteUrl, work], root, { env });
const nested = join(work, 'fixtures/scheduling/worker.mjs');
const file = await readFile(nested).then(() => nested, () => join(work, 'worker.mjs'));
await writeFile(file, (await readFile(file, 'utf8')).replace('ruleVersion: 2', 'ruleVersion: 2, reviewReady: true'));
await git.ok(['add', '.'], work); await git.ok(['commit', '-q', '-m', 'Expose review readiness in fixture health'], work, { env: RUNNER_IDENTITY_ENV(new Date().toISOString()) });
const sha = (await git.ok(['rev-parse', 'HEAD'], work)).trim(); await git.ok(['push', '-q', 'origin', 'HEAD:refs/heads/main'], work, { env });
const ws = ready.workspaces.find((w: any) => w.mountName === 'app');
const candidate = await api('POST', `/tasks/${task.taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { expectedSha: sha, tool: 'real-browser-review-preparation' }, agent.leaseToken);
const inner = await api('POST', `/orgs/${session.organizationId}/proposals`, { taskId: task.taskId, candidateIds: [candidate.candidateId] });
const innerPath = `/orgs/${session.organizationId}/proposals/${inner.proposalId}`;
await waitFor(innerPath, data => data.state === 'prepared'); await api('POST', `${innerPath}/integrate`, {}); await waitFor(innerPath, data => !!data.integration);
const state = (await api('GET', native)).state;
const outer = await api('POST', `/tasks/${task.taskId}/native/proposals`, { innerProposalId: inner.proposalId, expectedGeneration: state.generation, idempotencyKey: `browser-outer-${task.taskId}` }, agent.leaseToken);
const verification = await api('POST', `${native}/proposals/${encodeURIComponent(outer.proposal.id)}/verify`, { idempotencyKey: `browser-verify-${task.taskId}` });
if (!verification.evidence.every((e: any) => e.result === 'pass')) throw new Error('behavioral verification failed');
const report = { root, organizationId: session.organizationId, projectId: session.projectId, taskId: task.taskId, innerProposalId: inner.proposalId, proposalId: outer.proposal.id, envelopeDigest: outer.proposal.digest, sourceRevision: sha, scenarioCount: verification.evidence.length, accepted: false, status: 'awaiting-owner-review' };
await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
