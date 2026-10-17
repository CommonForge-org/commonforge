import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeProjectContext, type ProjectContextPacket } from '@commonforge-org/core';
import { checkPinnedNativeContext, validateNativeContext, writeNativeContext } from '../src/native.js';
import { ConfigStore } from '../src/config.js';
import { run } from '../src/main.js';

const T = '2026-10-17T12:00:00Z';
const D = 'a'.repeat(64);
const packet: ProjectContextPacket = { domain: 'cf.project-context/1', schemaVersion: 1, organizationId: 'org', projectId: 'project', taskId: 'task-1', attemptId: 'attempt-1', mandate: { schemaVersion: 1, organizationId: 'org', projectId: 'project', id: 'mandate-1', author: 'owner', createdAt: T, revision: 1, taskId: 'task-1', agentId: 'agent', issuer: 'owner', operations: ['context:read'], resourceIds: [], issuedAt: T, expiresAt: '2026-10-17T13:00:00Z', revocationGeneration: 0, revokedAt: null, maxAttempts: 1, maxJobs: 5, timeoutSeconds: 60 }, knowledgeHead: D, knowledgeGeneration: 1, outcomes: [], rules: [], assumptions: [], scenarios: [], sourceHeads: [], omissions: [] };
const wire = { protocolVersion: 1 as const, attemptId: 'attempt-1', mandateId: 'mandate-1', context: materializeProjectContext(packet) };
describe('task scoped project context', () => {
  it('refuses changed digest, task subject and unnegotiated protocol', () => {
    expect(validateNativeContext(wire, 'task-1').attemptId).toBe('attempt-1');
    expect(() => validateNativeContext(wire, 'another-task')).toThrow('subject');
    expect(() => validateNativeContext(wire, '../outside')).toThrow('identifier');
    expect(() => validateNativeContext({ ...wire, protocolVersion: 2 }, 'task-1')).toThrow('unsupported');
    expect(() => validateNativeContext({ ...wire, context: { ...wire.context, digest: 'b'.repeat(64) } }, 'task-1')).toThrow('digest');
  });
  it('stores context without credentials in protected files and detects tampering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cf-native-'));
    try {
      const data = validateNativeContext(wire, 'task-1');
      await writeNativeContext(root, data);
      expect((await stat(join(root, '.commonforge'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, '.commonforge/context.json'))).mode & 0o777).toBe(0o600);
      await expect(checkPinnedNativeContext(root, data)).resolves.toBeUndefined();
      expect(await readFile(join(root, '.commonforge/context.md'), 'utf8')).toContain('Project context');
      await expect(checkPinnedNativeContext(root, { ...data, attemptId: 'altered' })).rejects.toThrow('authority');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('refuses symbolic link context destinations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cf-native-'));
    const outside = await mkdtemp(join(tmpdir(), 'cf-outside-'));
    try {
      await symlink(outside, join(root, '.commonforge'));
      await expect(writeNativeContext(root, validateNativeContext(wire, 'task-1'))).rejects.toThrow('real directory');
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
  it.each([false, true])('refuses unsafe native submission before Git, including copied workspace without global marker (%s)', async copied => {
    const root = await mkdtemp(join(tmpdir(), 'cf-native-submit-'));
    const workspace = join(root, 'workspace'); const config = join(root, 'config');
    const apiUrl = 'http://localhost:8787'; let gitCalls = 0;
    try {
      await mkdir(join(workspace, '.commonforge'), { recursive: true });
      await writeFile(join(workspace, '.commonforge/workspace.json'), JSON.stringify({ snapshotId: 's', projectId: 'project', organizationId: 'org', mounts: [] }));
      const store = new ConfigStore({}, config);
      await store.saveCheckout({ apiUrl, taskId: 'task-1', workspaceRoot: workspace, mounts: [{ mountName: 'source', remoteUrl: 'file:///synthetic', writable: true, credential: 'none', taskWorkspaceId: 'ws', baseSha: 'base' }], createdAt: T });
      await store.saveLease({ apiUrl, taskId: 'task-1', leaseToken: 'cfl_onlytask123456', leaseGeneration: 1, expiresAt: '2050-01-01T00:00:00Z' });
      await store.saveSession({ apiUrl, sessionToken: 'cfs_broaduser123456', expiresAt: '2050-01-01T00:00:00Z', user: { userId: 'owner', email: 'synthetic@example.test' } });
      if (copied) await writeFile(join(workspace, '.commonforge/attempt.json'), '{}');
      else { await mkdir(join(config, 'native')); await writeFile(join(config, 'native/task-1.json'), '{}'); }
      let output = '';
      const code = await run(['submit', '--commit', 'Must not commit', '--json'], { cwd: workspace, env: { CFORGE_CONFIG_DIR: config, CFORGE_API_URL: apiUrl }, stdout: x => { output += x; }, stderr: () => {}, fetch: async (url, options) => {
        expect((options?.headers as Record<string, string>).authorization).toBe('Bearer cfl_onlytask123456');
        if (String(url).endsWith('/native/context')) return Response.json({ ...wire, protocolVersion: 1, knowledgeStale: true });
        if (String(url).endsWith('/tasks/task-1')) return Response.json(copied ? {} : { projectProtocolVersion: 1 });
        throw new Error('unexpected mutation');
      } }, { git: async () => { gitCalls++; return { code: 0, stdout: '', stderr: '' }; } });
      expect(code).toBe(1); expect(output).toContain(copied ? 'unsupported_version' : 'knowledge_stale'); expect(gitCalls).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('exchanges only task authority and never writes a broad user session or outputs the code/token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cf-native-'));
    const code = 'org.project.cfh_singleuse123456';
    const token = 'cfl_taskonly123456';
    let stdout = ''; let stderr = '';
    try {
      const exit = await run(['handoff', '--code', code, '--json'], { cwd: root, env: { CFORGE_CONFIG_DIR: root, CFORGE_API_URL: 'http://localhost:8787' }, stdout: x => { stdout += x; }, stderr: x => { stderr += x; }, fetch: async (url, options) => { expect(String(url)).toContain('/api/auth/task/verify'); expect(options?.body).toBe(JSON.stringify({ code })); return Response.json({ ...wire, taskId: 'task-1', leaseToken: token, leaseGeneration: 1, expiresAt: '2026-10-17T13:00:00Z' }); } });
      expect(exit, stdout + stderr).toBe(0);
      expect(stdout + stderr).not.toContain(code); expect(stdout + stderr).not.toContain(token);
      await expect(stat(join(root, 'session.json'))).rejects.toThrow();
      expect((await stat(join(root, 'leases/task-1.json'))).mode & 0o777).toBe(0o600);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
