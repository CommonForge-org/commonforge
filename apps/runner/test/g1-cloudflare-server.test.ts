/** Source authority tests use a transport double; actual Git/workerd execution is in bridge tests. */
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactsTransport } from '@commonforge-org/provider-cloudflare';
import type { ScenarioVerificationRequest } from '@commonforge-org/runner-protocol';
import { registeredArtifactsSource } from '../src/g1-cloudflare-server.js';

describe('operator-registered Cloudflare source',()=>{
  it('reads only the pinned repository, immutable revision and operator prefix',async()=>{
    const readFile=vi.fn().mockResolvedValue(new Uint8Array([1,2,3]));
    const transport={getRepo:vi.fn().mockResolvedValue({id:'repo1'}),readFile} as unknown as ArtifactsTransport;
    const read=registeredArtifactsSource(transport,[{organizationId:'org1',projectId:'p1',resourceId:'res1',namespace:'operator-ns',repoName:'operator-repo',repoId:'repo1',pathPrefix:'fixture/'}]);
    const request={organizationId:'org1',projectId:'p1',sourceHeads:[{resourceId:'res1',revisionId:`art:repo1:${'a'.repeat(40)}`}]} as ScenarioVerificationRequest;
    expect(await read(request,['worker.mjs'])).toEqual({'worker.mjs':new Uint8Array([1,2,3])});
    expect(readFile).toHaveBeenCalledWith('operator-ns','operator-repo','a'.repeat(40),'fixture/worker.mjs');
    readFile.mockClear();
    await expect(read({...request,projectId:'other'},['worker.mjs'])).rejects.toThrow(/scope/);
    await expect(read({...request,sourceHeads:[{resourceId:'res1',revisionId:`art:other:${'a'.repeat(40)}`}]},['worker.mjs'])).rejects.toThrow(/scope/);
    await expect(read(request,['../secret'])).rejects.toThrow(/path/);
    expect(readFile).not.toHaveBeenCalled();
  });
});
