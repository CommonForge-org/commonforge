import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createGit, RUNNER_IDENTITY_ENV } from '../src/git.js';
import { startArtifactsSidecar } from '../src/g1-artifacts-sidecar.js';
it('serves real Git smart HTTP with repository-scoped expiring/revocable credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'g1-real-sidecar-'));
  const sidecar = await startArtifactsSidecar({ stateDir: root, key: 'local-rpc-key' });
  try {
    const repo = await sidecar.artifacts.createRepo('test-canonical', 'site');
    const seeded = await sidecar.artifacts.seedScheduling('test-canonical', 'site');
    const work = join(root, 'checkout'), git = createGit({ allowHttp: true });
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${repo.remote}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${repo.token}` };
    await git.ok(['clone', '-q', repo.remote, work], root, { env });
    expect((await sidecar.artifacts.log('test-canonical', 'site', { ref: 'main' }))[0]?.hash).toBe(seeded.sha);
    await writeFile(join(work, 'extra.txt'), 'real source update');
    await git.ok(['add', '.'], work); await git.ok(['commit', '-q', '-m', 'Real edit'], work, { env: RUNNER_IDENTITY_ENV(new Date().toISOString()) });
    await git.ok(['push', '-q', 'origin', 'HEAD:refs/heads/main'], work, { env });
    expect(new TextDecoder().decode(await sidecar.artifacts.readFile('test-canonical', 'site', 'main', 'extra.txt') ?? undefined)).toBe('real source update');
    const tokens = await sidecar.artifacts.listTokens('test-canonical', 'site');
    await sidecar.artifacts.revokeToken('test-canonical', 'site', tokens[0]!.id);
    expect((await git.run(['ls-remote', repo.remote], root, { env })).code).not.toBe(0);
    expect((await fetch(`${sidecar.url}/rpc`, { method: 'POST', body: '{}' })).status).toBe(403);
  } finally { await sidecar.close(); await rm(root, { recursive: true, force: true }); }
});
