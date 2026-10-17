import { describe, expect, it } from 'vitest';
import { harness, ownerWithOrg, member, projectWith, codeResource } from '../helpers.js';

// Actual OrgLedger SQLite transactions; source providers are not involved in authority tests.
describe('native enrollment during directory transitions', () => {
  it('does not enroll a pending-revoked member when a project is enabled mid-transition', async () => {
    const h = harness(), owner = await ownerWithOrg(h), target = await member(h, owner, 'owner');
    const pid = await projectWith(h, owner, []), ledger = h.services().ledger(owner.orgId);
    const transition = await ledger.revokeNativeAuthority(owner.orgId, target.userId);
    // D1 intentionally still lists target as owner, matching the interval between authoritative
    // revocation and completion of the independent directory write.
    const enabled = await h.api('POST', `/api/orgs/${owner.orgId}/projects/${pid}/native/enable`, {
      token: owner.token, body: { idempotencyKey: 'enable-mid-transition' },
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(201);
    expect(enabled.body.state.authorities.find((a: any) => a.principalId === target.userId)?.active).not.toBe(true);
    await ledger.finishNativeAuthorityRevocation(owner.orgId, transition);
    const state = JSON.parse((await ledger.getNativeProject(pid))!);
    expect(state.authorities.find((a: any) => a.principalId === target.userId)?.active).not.toBe(true);
  });

  it('denies native creation by an actor whose authoritative revocation is pending', async () => {
    const h = harness(), owner = await ownerWithOrg(h), target = await member(h, owner, 'owner');
    const ledger = h.services().ledger(owner.orgId), transition = await ledger.revokeNativeAuthority(owner.orgId, target.userId);
    const created = await h.api('POST', `/api/orgs/${owner.orgId}/projects`, {
      token: target.token, body: { name: 'Revoked owner attempt', mode: 'agent-native' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(403);
    await ledger.finishNativeAuthorityRevocation(owner.orgId, transition);
  });

  it('keeps overlapping transitions closed and fences reconciliation read before completion', async () => {
    const h = harness(), owner = await ownerWithOrg(h), target = await member(h, owner, 'owner');
    const pid = await projectWith(h, owner, []), ledger = h.services().ledger(owner.orgId);
    await h.api('POST', `/api/orgs/${owner.orgId}/projects/${pid}/native/enable`, { token: owner.token, body: { idempotencyKey: 'enable' } });
    const first = await ledger.revokeNativeAuthority(owner.orgId, target.userId);
    const second = await ledger.revokeNativeAuthority(owner.orgId, target.userId);
    await ledger.finishNativeAuthorityRevocation(owner.orgId, first);
    const pending = JSON.parse((await ledger.getNativeProject(pid))!);
    await expect(Promise.resolve(ledger.reconcileNativeAuthority(owner.orgId, pid, owner.userId, target.userId, 'owner', pending.generation, 'pending-reconcile'))).rejects.toThrow(/revision_conflict/);
    await ledger.finishNativeAuthorityRevocation(owner.orgId, second);
    await expect(Promise.resolve(ledger.reconcileNativeAuthority(owner.orgId, pid, owner.userId, target.userId, 'owner', pending.generation, 'pending-reconcile'))).rejects.toThrow(/revision_conflict/);
    const fresh = JSON.parse((await ledger.getNativeProject(pid))!);
    const restored = JSON.parse(await ledger.reconcileNativeAuthority(owner.orgId, pid, owner.userId, target.userId, 'owner', fresh.generation, 'fresh-reconcile'));
    expect(restored.authorities.find((a: any) => a.principalId === target.userId)).toMatchObject({ active: true, role: 'owner' });
  });

  it('replays reconciliation without reviving authority after a later revocation', async () => {
    const h = harness(), owner = await ownerWithOrg(h), target = await member(h, owner, 'owner');
    const pid = await projectWith(h, owner, []), ledger = h.services().ledger(owner.orgId);
    await h.api('POST', `/api/orgs/${owner.orgId}/projects/${pid}/native/enable`, { token: owner.token, body: { idempotencyKey: 'enable' } });
    const initial = JSON.parse((await ledger.getNativeProject(pid))!);
    await ledger.reconcileNativeAuthority(owner.orgId, pid, owner.userId, target.userId, 'owner', initial.generation, 'reconcile-once');
    const transition = await ledger.revokeNativeAuthority(owner.orgId, target.userId);
    await ledger.finishNativeAuthorityRevocation(owner.orgId, transition);
    const revoked = JSON.parse((await ledger.getNativeProject(pid))!);
    const replay = JSON.parse(await ledger.reconcileNativeAuthority(owner.orgId, pid, owner.userId, target.userId, 'owner', initial.generation, 'reconcile-once'));
    expect(replay).toEqual(revoked);
    expect(replay.authorities.find((a: any) => a.principalId === target.userId).active).toBe(false);
    await expect(Promise.resolve(ledger.reconcileNativeAuthority(owner.orgId, pid, owner.userId, target.userId, 'developer', initial.generation, 'reconcile-once'))).rejects.toThrow(/revision_conflict/);
    const root = `/api/orgs/${owner.orgId}/projects/${pid}/native`;
    const stale = await h.api('POST', `${root}/authorities/${target.userId}/reconcile`, { token: owner.token, body: { idempotencyKey: 'new-intent-stale-head', expectedGeneration: initial.generation } });
    expect(stale.status).toBe(409);
    expect(JSON.parse((await ledger.getNativeProject(pid))!).authorities.find((a: any) => a.principalId === target.userId).active).toBe(false);
  });


  it('serializes legacy attachment against native reservation in both orderings', async () => {
    const h = harness(), owner = await ownerWithOrg(h), ledger = h.services().ledger(owner.orgId);
    const native = await h.api('POST', `/api/orgs/${owner.orgId}/projects`, { token: owner.token, body: { name: 'Exclusive source', mode: 'agent-native' } });
    const nativePid = native.body.projectId, legacyPid = await projectWith(h, owner, []);
    await ledger.reserveResourceMount(owner.orgId, legacyPid, 'res_legacy_first');
    await expect(Promise.resolve(ledger.reserveNativeSource(owner.orgId, nativePid, owner.userId, 'res_legacy_first'))).rejects.toThrow(/review_subject_changed/);
    expect(await ledger.nativeSourceProject('res_legacy_first')).toBeNull();
    await ledger.reserveNativeSource(owner.orgId, nativePid, owner.userId, 'res_native_first');
    await expect(Promise.resolve(ledger.reserveResourceMount(owner.orgId, legacyPid, 'res_native_first'))).rejects.toThrow(/project_mode_unsupported/);
    expect(await ledger.nativeSourceProject('res_native_first')).toBe(nativePid);
  });

  it('does not treat an existing legacy source as fresh native genesis', async () => {
    const h = harness(), owner = await ownerWithOrg(h), source = await codeResource(h, owner, 'Existing source', { 'index.txt': 'legacy content' });
    const created = await h.api('POST', `/api/orgs/${owner.orgId}/projects`, { token: owner.token, body: { name: 'Fresh native', mode: 'agent-native' } });
    const ledger = h.services().ledger(owner.orgId), projectId = created.body.projectId;
    const before = await ledger.getNativeProject(projectId);
    await expect(Promise.resolve(ledger.initializeNativeSource({ organizationId: owner.orgId, projectId, actorId: owner.userId, resourceId: source.resourceId, revisionId: source.revisionId, idempotencyKey: 'adopt-legacy-through-genesis' }))).rejects.toThrow(/review_subject_changed/);
    expect(await ledger.getNativeProject(projectId)).toBe(before);
    expect((await ledger.getHead(source.resourceId))?.revisionId).toBe(source.revisionId);
    expect(await ledger.nativeSourceProject(source.resourceId)).toBeNull();
  });

});
