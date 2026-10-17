import { describe, expect, it } from 'vitest';
import { harness, ownerWithOrg, member, projectWith } from '../helpers.js';

describe('native authority reconciliation', () => {
  it('enrolls new owners and advances restored authority without rewriting knowledge', async () => {
    const h = harness(), o = await ownerWithOrg(h), other = await member(h, o, 'owner');
    const pid = await projectWith(h, o, []), root = `/api/orgs/${o.orgId}/projects/${pid}/native`;
    await h.api('POST', `${root}/enable`, { token: o.token, body: { idempotencyKey: 'enable' } });
    const before = (await h.api('GET', root, { token: o.token })).body.state;
    const original = before.authorities.find((a: any) => a.principalId === other.userId);
    expect(original.active).toBe(true);
    expect((await h.api('PATCH', `/api/orgs/${o.orgId}/members/${other.userId}`, { token: o.token, body: { role: 'developer' } })).status).toBe(200);
    expect((await h.api('PATCH', `/api/orgs/${o.orgId}/members/${other.userId}`, { token: o.token, body: { role: 'owner' } })).status).toBe(200);
    const revoked = (await h.api('GET', root, { token: o.token })).body.state;
    expect(revoked.authorities.find((a: any) => a.principalId === other.userId).active).toBe(false);
    const r = await h.api('POST', `${root}/authorities/${other.userId}/reconcile`, { token: o.token, body: { idempotencyKey: 'restore-owner', expectedGeneration:revoked.generation } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const restored = r.body.state.authorities.find((a: any) => a.principalId === other.userId);
    expect(restored.active).toBe(true); expect(restored.revision).toBeGreaterThan(original.revision);
    expect(r.body.state.knowledgeHead).toBe(before.knowledgeHead);
    const newcomer = await member(h, o, 'owner');
    const enroll = await h.api('POST', `${root}/authorities/${newcomer.userId}/reconcile`, { token: o.token, body: { idempotencyKey: 'new-owner',expectedGeneration:r.body.state.generation } });
    expect(enroll.status, JSON.stringify(enroll.body)).toBe(200);
    expect(enroll.body.state.authorities.find((a: any) => a.principalId === newcomer.userId)).toMatchObject({ role: 'owner', active: true, revision: 1 });
  });

  it('fences enrollment racing revocation even for a principal absent from native state', async () => {
    const h = harness(), o = await ownerWithOrg(h), pid = await projectWith(h, o, []);
    const ledger = h.services().ledger(o.orgId);
    await h.api('POST', `/api/orgs/${o.orgId}/projects/${pid}/native/enable`, { token: o.token, body: { idempotencyKey: 'enable' } });
    const state = JSON.parse((await ledger.getNativeProject(pid))!);
    await ledger.revokeNativeAuthority(o.orgId, 'new-principal');
    await expect(Promise.resolve(ledger.reconcileNativeAuthority(o.orgId, pid, o.userId, 'new-principal', 'owner', state.generation, 'reconcile-race'))).rejects.toThrow(/revision_conflict/);
    const after = JSON.parse((await ledger.getNativeProject(pid))!);
    expect(after.authorities.some((a: any) => a.principalId === 'new-principal')).toBe(false);
  });

  it('refuses enrollment of viewers and requires an active project owner inside the ledger', async () => {
    const h = harness(), o = await ownerWithOrg(h), viewer = await member(h, o, 'viewer'), pid = await projectWith(h, o, []);
    const root = `/api/orgs/${o.orgId}/projects/${pid}/native`;
    await h.api('POST', `${root}/enable`, { token: o.token, body: { idempotencyKey: 'enable' } });
    expect((await h.api('POST', `${root}/authorities/${viewer.userId}/reconcile`, { token: o.token, body: { idempotencyKey: 'viewer',expectedGeneration:0 } })).status).toBe(403);
    const ledger = h.services().ledger(o.orgId), state = JSON.parse((await ledger.getNativeProject(pid))!);
    await expect(Promise.resolve(ledger.reconcileNativeAuthority(o.orgId, pid, viewer.userId, viewer.userId, 'owner', state.generation, 'reconcile-race'))).rejects.toThrow(/authority_denied/);
  });
});
