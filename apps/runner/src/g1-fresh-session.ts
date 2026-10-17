/** Prepare scoped persisted inputs for a real, separately invoked agent. Does NOT simulate an agent. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit } from './git.js';
const session = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as { ownerToken: string; organizationId: string; projectId: string };
const operator = JSON.parse(await readFile(process.argv[3]!, 'utf8')) as { workerUrl: string };
async function api(method: string, path: string, body?: unknown, token = session.ownerToken): Promise<any> {
  const res = await fetch(`${operator.workerUrl}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json(); if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`); return data;
}
const taskText = 'Add supportContact metadata to health response with value support@example.test; keep existing project behavior';
const root = await mkdtemp(join(tmpdir(), 'g1-fresh-agent-'));
const task = await api('POST', `/orgs/${session.organizationId}/projects/${session.projectId}/tasks`, { title: 'Add support contact to fixture health', request: taskText, writeMounts: ['app'] });
let ready: any; const end = Date.now() + 60000;
while (Date.now() < end) { ready = await api('GET', `/tasks/${task.taskId}`); if (ready.state === 'ready') break; await new Promise(r => setTimeout(r, 250)); }
if (ready.state !== 'ready') throw new Error('task source seeding timed out');
const handoff = await api('POST', `/tasks/${task.taskId}/native/handoff`, { agentId: 'actual-fresh-session-codex' });
const agent = await api('POST', '/auth/task/verify', { code: handoff.code });
const context = await api('GET', `/tasks/${task.taskId}/native/context`, undefined, agent.leaseToken);
const credential = await api('POST', `/tasks/${task.taskId}/credential`, { mountName: 'app', access: 'write' }, agent.leaseToken);
const work = join(root, 'workspace'), git = createGit({ allowHttp: true });
const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${credential.remoteUrl}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.secret}` };
await git.ok(['clone', '-q', credential.remoteUrl, work], root, { env });
await mkdir(join(work, '.commonforge'), { recursive: true });
const inputs = { 'task.md': taskText + '\n', '.commonforge/context.json': context.context.json, '.commonforge/context.md': context.context.markdown };
for (const [path, text] of Object.entries(inputs)) await writeFile(join(work, path), text);
const inputDigests = Object.fromEntries(Object.entries(inputs).map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')]));
const sourceFile = 'fixtures/scheduling/worker.mjs';
const sourceDigest = createHash('sha256').update(await readFile(join(work, sourceFile))).digest('hex');
const report = { root, workspace: work, taskId: task.taskId, organizationId: session.organizationId, projectId: session.projectId, allowedInputFiles: Object.keys(inputs), allowedImplementationPath: sourceFile, inputDigests, implementationBeforeDigest: sourceDigest, contextDigest: context.context.digest, agentIdentity: null, freshAgentExecuted: false };
await writeFile(join(root, 'agent-control.json'), JSON.stringify({ ...report, credential, agent, ownerSessionFile: process.argv[2], workerUrl: operator.workerUrl, workspaceId: ready.workspaces.find((w: any) => w.mountName === 'app').taskWorkspaceId }), { mode: 0o600 });
await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
