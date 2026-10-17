import { describe, expect, it } from 'vitest';
import { FakeRunner } from '../fakes/runner.js';
import { harness, member, ownerWithOrg, projectWith } from '../helpers.js';

describe('native project onboarding', () => {
  it('creates native understanding immediately, initializes dedicated source, and keeps legacy bypasses closed', async () => {
    const h = harness(), runner = new FakeRunner(h), owner = await ownerWithOrg(h);
    const created = await h.api('POST', `/api/orgs/${owner.orgId}/projects`, { token:owner.token, body:{name:'Public reference', mode:'agent-native'} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const root = `/api/orgs/${owner.orgId}/projects/${created.body.projectId}`;
    const genesis = (await h.api('GET', `${root}/native`, {token:owner.token})).body.state;
    expect(genesis.sourceHeads).toEqual([]);
    expect(genesis.manifests).toHaveLength(1);
    expect((await h.api('GET', root, {token:owner.token})).body.mode).toBe('agent-native');
    const folder = await h.api('POST', `${root}/folders`, {token:owner.token, body:{name:'source'}});
    expect(folder.status, JSON.stringify(folder.body)).toBe(201);
    const ledger = h.services().ledger(owner.orgId);
    expect(await ledger.nativeSourceProject(folder.body.resourceId)).toBe(created.body.projectId);
    const legacyProject = await projectWith(h, owner, []);
    const attach = await h.api('POST', `/api/orgs/${owner.orgId}/projects/${legacyProject}/mounts`, {token:owner.token,body:{resourceId:folder.body.resourceId,mountName:'stolen'}});
    expect([attach.status, attach.body.error.code]).toEqual([409,'project_mode_unsupported']);
    for (let i=0;i<10;i++) { await h.drainSteps(); await runner.idle(); if(!h.steps.length) break; }
    const folders = await h.api('GET', `${root}/folders`, {token:owner.token});
    expect(folders.body.folders).toMatchObject([{state:'active',settingUp:false}]);
    const state = (await h.api('GET', `${root}/native`, {token:owner.token})).body.state;
    const head = await ledger.getHead(folder.body.resourceId);
    expect(state.sourceHeads).toEqual([{resourceId:folder.body.resourceId,revisionId:head!.revisionId}]);
    expect(state.manifests.at(-1).sourceHeads).toEqual(state.sourceHeads);
    expect(state.manifests.at(-1).behavior).toBe('historical-unverified');
    expect(state.manifests.at(-1).evidenceIds).toEqual([]);
    const project = (await h.api("GET", root, {token:owner.token})).body;
    expect(project.mounts[0]).toMatchObject({canWrite:false,canRetrySetup:true,canStartTask:true});
    expect((await h.api('DELETE', `${root}/mounts/source`, {token:owner.token})).status).toBe(409);
    const adopt = await h.api('POST', `/api/orgs/${owner.orgId}/resources/${folder.body.resourceId}/adopt-head`, {token:owner.token});
    expect([adopt.status,adopt.body.error.code]).toEqual([409,'project_mode_unsupported']);
    // The source setup is resumable without adding a duplicate manifest.
    const retry = await ledger.initializeNativeSource({organizationId:owner.orgId,projectId:created.body.projectId,actorId:owner.userId,resourceId:folder.body.resourceId,revisionId:head!.revisionId,idempotencyKey:`native-init:${folder.body.resourceId}`});
    expect(retry.ok).toBe(true);
    expect(JSON.parse((await ledger.getNativeProject(created.body.projectId))!).manifests).toHaveLength(state.manifests.length);
  });

  it('lets a developer create a scoped native project while existing API defaults stay legacy', async () => {
    const h=harness(), owner=await ownerWithOrg(h), dev=await member(h,owner,'developer');
    const created=await h.api('POST',`/api/orgs/${owner.orgId}/projects`,{token:dev.token,body:{name:'Development',mode:'agent-native'}});
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    const state=(await h.api('GET',`/api/orgs/${owner.orgId}/projects/${created.body.projectId}/native`,{token:dev.token})).body.state;
    expect(state.authorities).toContainEqual(expect.objectContaining({principalId:dev.userId,role:'developer',active:true}));
    const legacy=await h.api('POST',`/api/orgs/${owner.orgId}/projects`,{token:owner.token,body:{name:'Existing client'}});
    expect((await h.api('GET',`/api/orgs/${owner.orgId}/projects/${legacy.body.projectId}/native`,{token:owner.token})).body.state).toBeNull();
    expect((await h.api('GET',`/api/orgs/${owner.orgId}/projects/${legacy.body.projectId}`,{token:owner.token})).body.mode).toBe('legacy');
    expect((await h.api('POST',`/api/orgs/${owner.orgId}/projects/${legacy.body.projectId}/native/enable`,{token:dev.token,body:{idempotencyKey:'not-a-creation'}})).status).toBe(403);
  });
});
