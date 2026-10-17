/** Actual Worker/SQLite authorization; historical source seed and capabilities are explicit doubles. */
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, computeProjectManifestHash, computeProjectProposalHash } from '@commonforge-org/core';
import { SqliteLedgerStore } from '../../src/ledger/sqlite-store.js';
import { putGrant } from '../../src/services/directory.js';
import { harness, ownerWithOrg, member, codeResource, projectWith } from '../helpers.js';

async function fixture() {
  const h = harness(), owner = await ownerWithOrg(h), dev = await member(h, owner, 'developer');
  const source = await codeResource(h, owner, 'source', { 'index.txt': 'historical' });
  const pid = await projectWith(h, owner, [{ mountName: 'source', resourceId: source.resourceId }]);
  const path = `/api/orgs/${owner.orgId}/projects/${pid}/native`, ledger = h.services().ledger(owner.orgId);
  for (const [scopeKind, scopeId] of [['project', pid], ['resource', source.resourceId]] as const) await putGrant(h.services().db, { orgId: owner.orgId, userId: dev.userId, scopeKind, scopeId, operations: ['read'], grantedBy: owner.userId, now: h.services().nowIso() });
  const enabled = await h.api('POST', path + '/enable', { token: owner.token, body: { idempotencyKey: 'enable' } });
  expect(enabled.status).toBe(201);
  const target = enabled.body.state.manifests[0].hash, current = source.revisionId.replace(/[a-f0-9]{40}$/, 'b'.repeat(40));
  await runInDurableObject(ledger, (_instance, ctx) => {
    const store = new SqliteLedgerStore(ctx.storage);
    store.seed({ heads: [{ resourceId: source.resourceId, revisionId: current as never, versionSeq: 2 }] });
    store.transactionSync(tx => {
      const s = JSON.parse(tx.getNativeProjectJson(pid)!);
      s.sourceHeads = [{ resourceId: source.resourceId, revisionId: current }];
      const m = { ...s.manifests[0], id: 'later-source', sequence: 1, parent: target, sourceHeads: s.sourceHeads }; delete m.hash;
      s.manifests.push({ ...m, hash: computeProjectManifestHash(m) });
      tx.putNativeProjectJson(pid, owner.orgId, s.generation, canonicalJson(s));
    });
  });
  h.envOverrides.COMMONFORGE_SCENARIO_RUNNER_URL = 'https://recovery-verifier.example.com';
  return { h, owner, dev, source, pid, path, ledger, target, current };
}

describe('native recovery source authorization', () => {
  it('requires full source write at preparation and acceptance, including generic prepare bypass', async () => {
    const f = await fixture(), { h, owner, dev, path, target, ledger, pid } = f;
    const readOnly = await h.api('POST', path + '/recoveries', { token: dev.token, body: { manifestHash: target, expectedGeneration: 0, idempotencyKey: 'read-only' } });
    expect(readOnly.status).toBe(403);
    const original = globalThis.fetch, mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => String(input).startsWith('https://recovery-verifier.example.com') ? Response.json({ protocolVersion: 1, runtimeRecipeDigest: 'c'.repeat(64) }) : original(input, init));
    try {
      const prepared = await h.api('POST', path + '/recoveries', { token: owner.token, body: { manifestHash: target, expectedGeneration: 0, idempotencyKey: 'owner-recovery' } });
      expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
      const p = { ...prepared.body.proposal, id: 'raw-read-only-recovery', author: dev.userId };
      p.digest = computeProjectProposalHash(p.envelope);
      const generic = await h.api('POST', path + '/commands', { token: dev.token, body: { type: 'prepareProposal', record: p, expectedGeneration: prepared.body.state.generation, idempotencyKey: 'generic-recovery' } });
      expect(generic.status, JSON.stringify(generic.body)).toBe(403);
      const denied = await h.api('POST', path + '/commands', { token: dev.token, body: { type: 'accept', proposalId: prepared.body.proposal.id, decisionId: 'none', expectedGeneration: prepared.body.state.generation, idempotencyKey: 'accept-read-only' } });
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      expect(JSON.parse((await ledger.getNativeProject(pid))!).sourceHeads[0].revisionId).toBe(f.current);
    } finally { mock.mockRestore(); }
  });

  it('rechecks recorded external effects at acceptance after preparation', async () => {
    const f = await fixture(), { h, owner, path, target, source, ledger, pid } = f;
    const original = globalThis.fetch, mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => String(input).startsWith('https://recovery-verifier.example.com') ? Response.json({ protocolVersion: 1, runtimeRecipeDigest: 'c'.repeat(64) }) : original(input, init));
    try {
      const prepared = await h.api('POST', path + '/recoveries', { token: owner.token, body: { manifestHash: target, expectedGeneration: 0, idempotencyKey: 'before-effect' } });
      expect(prepared.status).toBe(201);
      await h.services().db.prepare("INSERT INTO production_migrations(org_id,resource_id,key,release_id,state,started_at) VALUES (?,?,?,?,?,?)").bind(owner.orgId, source.resourceId, 'data-effect', 'historical-release', 'applied', h.services().nowIso()).run();
      const denied = await h.api('POST', path + '/commands', { token: owner.token, body: { type: 'accept', proposalId: prepared.body.proposal.id, decisionId: 'none', expectedGeneration: prepared.body.state.generation, idempotencyKey: 'after-effect' } });
      expect([denied.status, denied.body.error.code]).toEqual([409, 'recovery_unsupported']);
      const preparation = await h.api('POST', path + '/recoveries', { token: owner.token, body: { manifestHash: target, expectedGeneration: prepared.body.state.generation, idempotencyKey: 'effect-already-exists' } });
      expect([preparation.status, preparation.body.error.code]).toEqual([409, 'recovery_unsupported']);
      expect(JSON.parse((await ledger.getNativeProject(pid))!).sourceHeads[0].revisionId).toBe(f.current);
    } finally { mock.mockRestore(); }
  });

  it('does not let a developer decision satisfy owner-only source approval policy', async () => {
    const f = await fixture(), { h, owner, dev, path, target, pid, ledger } = f;
    const policy = await h.api('PUT', `/api/orgs/${owner.orgId}/projects/${pid}/policy`, { token: owner.token, body: { approvalRoles: ['owner'], checks: [] } });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const state = (await h.api('GET', path, { token: owner.token })).body.state;
    const original = globalThis.fetch, mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => String(input).startsWith('https://recovery-verifier.example.com') ? Response.json({ protocolVersion: 1, runtimeRecipeDigest: 'c'.repeat(64) }) : original(input, init));
    try {
      const prepared = await h.api('POST', path + '/recoveries', { token: owner.token, body: { manifestHash: target, expectedGeneration: state.generation, idempotencyKey: 'owner-only-plan' } });
      expect(prepared.status, JSON.stringify(prepared.body)).toBe(201);
      const proposal = prepared.body.proposal, now = h.services().nowIso();
      const approved = await h.api('POST', path + '/commands', { token: dev.token, body: { type: 'recordDecision', expectedGeneration: prepared.body.state.generation, idempotencyKey: 'developer-decision', record: { schemaVersion: 1, organizationId: owner.orgId, projectId: pid, id: 'developer-approval', author: dev.userId, createdAt: now, envelopeDigest: proposal.digest, innerProposalHash: null, action: 'approve', explanation: 'Developer recommendation requires owner approval', authorityRevision: 1 } } });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const denied = await h.api('POST', path + '/commands', { token: owner.token, body: { type: 'accept', expectedGeneration: approved.body.state.generation, idempotencyKey: 'owner-accepts-developer-decision', proposalId: proposal.id, decisionId: 'developer-approval' } });
      expect([denied.status, denied.body.error.code]).toEqual([403, 'authority_denied']);
      expect(JSON.parse((await ledger.getNativeProject(pid))!).sourceHeads[0].revisionId).toBe(f.current);
    } finally { mock.mockRestore(); }
  });


  it.each(['required-check', 'contract'])('refuses unsupported current artifact policy at prepare and accept: %s', async kind => {
    const f = await fixture(), { h, owner, path, target, source, pid } = f;
    const original = globalThis.fetch, mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => String(input).startsWith('https://recovery-verifier.example.com') ? Response.json({ protocolVersion: 1, runtimeRecipeDigest: 'c'.repeat(64) }) : original(input, init));
    try {
      const prepared = await h.api('POST', path + '/recoveries', { token: owner.token, body: { manifestHash: target, expectedGeneration: 0, idempotencyKey: 'before-artifact-policy' } });
      expect(prepared.status).toBe(201);
      const body = kind === 'required-check'
        ? { checks: [{ checkId: 'required-build', mountName: 'source', command: 'node build.mjs' }] }
        : { checks: [], contracts: [{ contractId: 'current-contract', version: '1', producerResource: source.resourceId, consumerResource: source.resourceId, schema: { resourceId: source.resourceId, path: 'contract.schema.json' }, producerOutput: { mountName: 'source', command: 'node output.mjs' } }] };
      const policy = await h.api('PUT', `/api/orgs/${owner.orgId}/projects/${pid}/policy`, { token: owner.token, body });
      expect(policy.status, JSON.stringify(policy.body)).toBe(200);
      const current = (await h.api('GET', path, { token: owner.token })).body.state;
      const deniedPreparation = await h.api('POST', path + '/recoveries', { token: owner.token, body: { manifestHash: target, expectedGeneration: current.generation, idempotencyKey: 'after-artifact-policy' } });
      expect([deniedPreparation.status, deniedPreparation.body.error.code]).toEqual([409, 'recovery_unsupported']);
      const deniedAccept = await h.api('POST', path + '/commands', { token: owner.token, body: { type: 'accept', proposalId: prepared.body.proposal.id, decisionId: 'none', expectedGeneration: current.generation, idempotencyKey: 'accept-after-artifact-policy' } });
      expect([deniedAccept.status, deniedAccept.body.error.code]).toEqual([409, 'recovery_unsupported']);
    } finally { mock.mockRestore(); }
  });

});
