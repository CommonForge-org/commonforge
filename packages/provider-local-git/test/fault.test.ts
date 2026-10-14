import { join } from 'node:path';
import { describeProviderFaultConformance, nodeGitRunner } from '@commonforge-org/conformance/provider';
import { LocalGitProvider } from '../src/index.js';

describeProviderFaultConformance({
  name: 'LocalGitProvider',
  makeProvider: async (ctx) => {
    const provider = await LocalGitProvider.open({ root: join(ctx.workDir, 'local-git'), namespacePrefix: 'commonforge-conformance' });
    const resource = await provider.createCanonicalResource({ organizationId: ctx.organizationId, resourceId: ctx.resourceId, source: ctx.seed.path, sourceRef: 'refs/heads/main' });
    if (resource.coords.kind !== 'local-git') throw new Error('unexpected coords');
    return {
      provider,
      resource,
      canonical: resource.coords,
      serviceGit: nodeGitRunner(await provider.serviceGitEnv()),
      gitForCredential: (cred) => nodeGitRunner(LocalGitProvider.credentialGitEnv(cred)),
      readExport: (key) => provider.readExport(key),
    };
  },
});
