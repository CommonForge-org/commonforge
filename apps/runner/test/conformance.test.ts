/**
 * The provider conformance suite (packages/conformance) with THIS runner instead of the reference
 * runner: LocalGitProvider canonical/task repos, real git, prepare/integrate/reconcile executed by
 * apps/runner (signed jobs, evidence keys, lease pushes).
 */
import { join } from 'node:path';
import { LocalGitProvider } from '@commonforge-org/provider-local-git';
import { describeProviderConformance, nodeGitRunner } from '@commonforge-org/conformance/provider';
import { createRunner, createRunnerSubmit, staticCredentials } from '../src/index.js';
import { KEY } from './helpers.js';

let serviceEnv: Record<string, string> = {};

describeProviderConformance({
  name: 'provider conformance: LocalGitProvider + apps/runner',
  makeProvider: async (ctx) => {
    const provider = await LocalGitProvider.open({ root: join(ctx.workDir, 'local-git'), namespacePrefix: 'commonforge-conformance' });
    const resource = await provider.createCanonicalResource({ organizationId: ctx.organizationId, resourceId: ctx.resourceId, source: ctx.seed.path, sourceRef: 'refs/heads/main' });
    if (resource.coords.kind !== 'local-git') throw new Error('unexpected coords');
    serviceEnv = await provider.serviceGitEnv();
    return {
      provider,
      resource,
      canonical: resource.coords,
      serviceGit: nodeGitRunner(serviceEnv),
      gitForCredential: (cred) => nodeGitRunner(LocalGitProvider.credentialGitEnv(cred)),
      readExport: (key) => provider.readExport(key),
    };
  },
  makeRunner: (ctx) => {
    const runner = createRunner({
      workDir: ctx.workDir,
      // the service credential, only ever in git child environments
      credentials: staticCredentials(() => ({ ...serviceEnv })),
      jobKeyring: [KEY],
      currentHeads: async (sj) => {
        const ids = sj.job.kind === 'integrate' ? sj.job.targets.map((t) => t.resourceId) : sj.job.kind === 'edition-return' ? [sj.job.target.resourceId] : [];
        return Object.fromEntries(ids.map((id) => [id, ctx.currentHead(id)]));
      },
      push: { baseDelayMs: 5 },
      log: () => undefined,
      git: { allowFile: true },
    });
    return createRunnerSubmit({ runner, jobKey: KEY });
  },
});
