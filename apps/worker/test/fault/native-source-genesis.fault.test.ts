import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { artRevisionId } from '@commonforge-org/core';
import { harness, ownerWithOrg } from '../helpers.js';

// Actual SQLite rollback. Supplied revisions model trusted folder-init output; no source
// execution or independent behavioral verification is claimed by these storage tests.
describe('native source genesis atomicity', () => {
  it('rolls genesis back with its manifest and permits exactly one same-key retry', async () => {
    const h = harness(), owner = await ownerWithOrg(h);
    const project = await h.api('POST', `/api/orgs/${owner.orgId}/projects`, { token: owner.token, body: { name: 'Genesis fault', mode: 'agent-native' } });
    expect(project.status).toBe(201);
    const projectId = project.body.projectId, ledger = h.services().ledger(owner.orgId), resourceId = 'res_native_genesis';
    await ledger.reserveNativeSource(owner.orgId, projectId, owner.userId, resourceId);
    const request = { organizationId: owner.orgId, projectId, actorId: owner.userId, resourceId, revisionId: artRevisionId('native-genesis-repo', 'a'.repeat(40)), idempotencyKey: 'first-native-source' };
    const snapshot = () => runInDurableObject(ledger, (_instance, ctx) => ({
      heads: ctx.storage.sql.exec('SELECT * FROM heads').toArray(),
      audit: ctx.storage.sql.exec('SELECT * FROM audit').toArray(),
      versions: ctx.storage.sql.exec('SELECT * FROM accepted_versions').toArray(),
      idempotency: ctx.storage.sql.exec('SELECT * FROM idempotency').toArray(),
      projects: ctx.storage.sql.exec('SELECT * FROM native_projects').toArray(),
      resources: ctx.storage.sql.exec('SELECT * FROM resource_orgs').toArray(),
    }));
    const before = await snapshot();
    await runInDurableObject(ledger, (_instance, ctx) => ctx.storage.sql.exec("CREATE TRIGGER source_init_failure BEFORE UPDATE ON native_projects BEGIN SELECT RAISE(ABORT,'injected genesis persistence failure'); END"));
    await expect(Promise.resolve(ledger.initializeNativeSource(request))).rejects.toThrow(/injected genesis/);
    expect(await snapshot()).toEqual(before);
    await runInDurableObject(ledger, (_instance, ctx) => ctx.storage.sql.exec('DROP TRIGGER source_init_failure'));
    const accepted = await ledger.initializeNativeSource(request);
    expect(accepted.ok).toBe(true);
    const state = JSON.parse((await ledger.getNativeProject(projectId))!);
    expect(state.sourceHeads).toEqual([{ resourceId, revisionId: request.revisionId }]);
    expect(state.manifests.at(-1)).toMatchObject({ behavior: 'historical-unverified', evidenceIds: [], decisionId: null });
    const committed = await snapshot();
    expect((await ledger.initializeNativeSource(request)).ok).toBe(true);
    expect(await snapshot()).toEqual(committed);
    await expect(Promise.resolve(ledger.initializeNativeSource({ ...request, revisionId: artRevisionId('native-genesis-repo', 'b'.repeat(40)) }))).rejects.toThrow(/review_subject_changed/);
    expect(await snapshot()).toEqual(committed);
  });
});
