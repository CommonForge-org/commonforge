/** Real control-plane authorization with explicitly faked source and runner providers. */
import { describe, expect, it } from 'vitest';
import { FakeRunner } from '../fakes/runner.js';
import { harness, ownerWithOrg, codeResource, projectWith } from '../helpers.js';

describe('native task scoped proposal preparation', () => {
  it('refuses broad user authority and cross-task lease use; exact task integration retries join one proposal', async () => {
    const h = harness(); const runner = new FakeRunner(h); const o = await ownerWithOrg(h);
    const source = await codeResource(h, o, 'source', { 'index.txt': 'synthetic v1' });
    const pid = await projectWith(h, o, [{ mountName: 'source', resourceId: source.resourceId }]);
    const path = `/api/orgs/${o.orgId}/projects/${pid}/native`;
    expect((await h.api('POST', path + '/enable', { token: o.token, body: { idempotencyKey: 'enable' } })).status).toBe(201);
    const taskIds: string[] = [];
    for (const title of ['Assigned task', 'Another task']) {
      const task = await h.api('POST', `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token, body: { title, writeMounts: ['source'] } });
      expect(task.status).toBe(201); taskIds.push(task.body.taskId);
    }
    await h.drainSteps();
    const [taskId, otherId] = taskIds;
    const issued = await h.api('POST', `/api/tasks/${taskId}/native/handoff`, { token: o.token, body: { agentId: 'synthetic-client' } });
    const exchanged = await h.api('POST', '/api/auth/task/verify', { body: { code: issued.body.code } });
    expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
    const token = exchanged.body.leaseToken;
    expect((await h.api('POST', `/api/tasks/${taskId}/native/submit`, { token: o.token, body: {} })).status).toBe(403);
    expect((await h.api('POST', `/api/tasks/${otherId}/native/submit`, { token, body: {} })).status).not.toBe(202);
    expect((await h.api('POST', `/api/tasks/${taskId}/native/submit`, { token, body: {} })).body.error.code).toBe('nothing_to_integrate');
    const task = (await h.api('GET', `/api/tasks/${taskId}`, { token })).body;
    const ws = task.workspaces.find((w: { mountName: string }) => w.mountName === 'source');
    const cred = await h.api('POST', `/api/tasks/${taskId}/credential`, { token, body: { mountName: 'source', access: 'write' } });
    expect(cred.status, JSON.stringify(cred.body)).toBe(200);
    const where = h.artifacts.tokenByPlaintext(cred.body.secret)!;
    const base = h.artifacts.repo(where.ns, where.name).refs.get('main')!;
    const sha = h.artifacts.makeCommit({ 'index.txt': 'synthetic v2' }, [base]);
    h.artifacts.push(where.ns, where.name, 'main', sha);
    const freeze = await h.api('POST', `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token, body: { expectedSha: sha, tool: 'native-synthetic-test' } });
    expect(freeze.status, JSON.stringify(freeze.body)).toBe(201);
    await h.drainSteps();
    const first = await h.api('POST', `/api/tasks/${taskId}/native/submit`, { token, body: {} });
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const replay = await h.api('POST', `/api/tasks/${taskId}/native/submit`, { token, body: {} });
    expect(replay.body.innerProposalId).toBe(first.body.innerProposalId);
    expect(replay.body.jobId).toBe(first.body.jobId);
    expect(runner.errors).toEqual([]);
  });
});
