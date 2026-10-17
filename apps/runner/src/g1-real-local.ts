/** Reproducible real Git/Node-runner/HTTP-verifier spike; does not simulate cloud release. */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalGitProvider } from '@commonforge-org/provider-local-git';
import { localRevisionId } from '@commonforge-org/core';
import { scenarioBuildDigest, signScenarioRequest, verifyScenarioResult, type JobSigningKey, type ScenarioVerificationRequest } from '@commonforge-org/runner-protocol';
import { createGit, RUNNER_IDENTITY_ENV } from './git.js';
import { createRunner } from './runner.js';
import { staticCredentials } from './credentials.js';
import { fsBlobStore } from './blob-store.js';
import { createRunnerSubmit } from './submit.js';
import { schedulingVerifierDigest } from './g1-local-verifier.js';
import { SCHEDULING_RUNTIME_RECIPE_DIGEST, startLocalScenarioBridge } from './g1-local-bridge.js';
import { localNamespaceCommands } from './g1-bwrap-commands.js';
import { cases } from './g1-scheduling-harness.js';

export async function runRealLocal(options: { port?: number; bridgePort?: number; jobKey?: JobSigningKey; organizationId?: string; projectId?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'commonforge-g1-real-local-'));
  const seed = join(root, 'seed'); await mkdir(seed);
  for (const file of ['worker.mjs', 'build.mjs']) await copyFile(new URL(`../../../fixtures/scheduling/${file}`, import.meta.url), join(seed, file));
  const git = createGit({ allowFile: true });
  await git.ok(['init', '-q', '-b', 'main'], seed);
  await git.ok(['add', '.'], seed);
  await git.ok(['commit', '-q', '-m', 'Synthetic scheduling reference'], seed, { env: RUNNER_IDENTITY_ENV(new Date().toISOString()) });
  const provider = await LocalGitProvider.open({ root: join(root, 'repos'), namespacePrefix: 'commonforge-g1' });
  const organizationId = options.organizationId ?? 'g1-local-org', projectId = options.projectId ?? 'g1-scheduling';
  const resource = await provider.createCanonicalResource({ organizationId, resourceId: 'scheduling', source: seed });
  if (resource.coords.kind !== 'local-git') throw new Error('local coords expected');
  const revision = await provider.resolveRevision(resource, { kind: 'ref', ref: 'refs/heads/main' });
  const jobKey = options.jobKey ?? { kid: 'k1', secret: randomBytes(32).toString('hex') };
  await writeFile(join(root, 'job-key.json'), JSON.stringify(jobKey), { mode: 0o600 });
  const serviceEnv = await provider.serviceGitEnv();
  // Only the fixed audited fixture build executes here. Hostile code uses the namespace verifier.
  const runner = createRunner({ workDir: join(root, 'runner'), credentials: staticCredentials(() => serviceEnv),
    jobKeyring: [jobKey], git: { allowFile: true }, commands: await localNamespaceCommands(join(root, 'sandbox-bin')),
    blobStore: fsBlobStore(join(root, 'blobs')), previewBaseUrl: 'http://127.0.0.1', runnerId: 'g1-real-local-node', log: () => undefined });
  const submit = createRunnerSubmit({ runner, jobKey });
  const buildResult = await submit({ kind: 'preview-build', previewId: 'scheduling',
    integrationSha: { scheduling: revision.contentId }, sources: [{ resourceId: 'scheduling', mountName: 'app', canonical: resource.coords }],
    recipe: { recipeId: 'audited-scheduling-build', revision: 1, steps: [{ stepId: 'build', mountName: 'app', command: 'node build.mjs' }], output: { mountName: 'app', path: 'dist' } },
    bundles: [{ name: 'worker', mountName: 'app', path: 'dist' }],
  });
  if (!buildResult.ok) throw new Error(`real runner preview build failed: ${JSON.stringify(buildResult)}`);
  const preview = createServer((_req, res) => { void readFile(join(root, 'blobs/previews/scheduling/site/index.html')).then(data => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(data); }, () => { res.writeHead(503); res.end('preview not available'); }); });
  await new Promise<void>((resolve, reject) => { preview.once('error', reject); preview.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const previewUrl = `http://127.0.0.1:${(preview.address() as { port: number }).port}/`;
  let bridge: Awaited<ReturnType<typeof startLocalScenarioBridge>>;
  try { bridge = await startLocalScenarioBridge({ provider, jobKey, port: options.bridgePort, resources: [{ organizationId, projectId, resourceId: 'scheduling' }] }); }
  catch (e) { preview.close(); throw e; }
  try {
    const now = new Date();
    const sourceHeads = [{ resourceId: 'scheduling', revisionId: localRevisionId(resource.coords.repoId, revision.contentId) }];
    const request: ScenarioVerificationRequest = { protocolVersion: 1, organizationId, projectId,
      runId: `local-${Date.now()}`, envelopeDigest: 'a'.repeat(64), buildDigest: scenarioBuildDigest(sourceHeads),
      runtimeRecipeDigest: SCHEDULING_RUNTIME_RECIPE_DIGEST, sourceHeads,
      requiredScenarios: cases.map(c => ({ id: c[0], revision: 1, verifierDigest: '', method: 'automated' })),
      issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString() };
    const verifierDigest = await schedulingVerifierDigest();
    request.requiredScenarios.forEach(s => { s.verifierDigest = verifierDigest; });
    const result = await fetch(`${bridge.url}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signScenarioRequest(request, jobKey)) });
    if (!result.ok) throw new Error(`bridge verification HTTP ${result.status}: ${await result.text()}`);
    const signedResult = await result.json();
    const verified = await verifyScenarioResult(signedResult, jobKey, request);
    const previewResponse = await fetch(previewUrl);
    if (!previewResponse.ok || !(await previewResponse.text()).includes('Synthetic scheduling')) throw new Error('real HTTP preview failed');
    const report = { protocolVersion: 1, mode: 'real-local', root, organizationId, projectId, sourceHeads,
      previewUrl, bridgeUrl: bridge.url, verifierDigest, runtimeRecipeDigest: SCHEDULING_RUNTIME_RECIPE_DIGEST,
      gates: { realGit: 'pass', signedNodeRunner: 'pass', localBlobStore: 'pass', httpPreview: 'pass', trustedIsolatedScenarios: verified.evidence.every(e => e.result === 'pass') ? 'pass' : 'fail', workerWorkflow: 'not_run', cloudRelease: 'not_run', freshAgent: 'not_run' },
      runnerBuild: buildResult, verification: verified, limitations: ['Only Node build/check entrypoints are supported by the local namespace wrapper; package installs and other command families fail closed.', 'Standalone provider/runner rehearsal does not itself prove the Worker acceptance workflow.', 'Local preview is not a cloud release.'],
    };
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(join(root, 'signed-verification.json'), JSON.stringify(signedResult, null, 2));
    return { report, provider, resource, close: async () => { await bridge.close(); await new Promise<void>((resolve, reject) => preview.close(e => e ? reject(e) : resolve())); } };
  } catch (e) { await bridge.close(); preview.close(); throw e; }
}

async function main() {
  const keyFile = process.env.COMMONFORGE_LOCAL_JOB_KEY_FILE;
  const jobKey = keyFile ? JSON.parse(await readFile(resolve(keyFile), 'utf8')) as JobSigningKey : undefined;
  const running = await runRealLocal({ port: Number(process.env.PREVIEW_PORT ?? 0), bridgePort: Number(process.env.BRIDGE_PORT ?? 0), jobKey,
    organizationId: process.env.G1_ORGANIZATION_ID, projectId: process.env.G1_PROJECT_ID });
  process.stdout.write(`${JSON.stringify(running.report, null, 2)}\n`);
  if (!process.argv.includes('--serve')) await running.close();
  else {
    const stop = async () => { await running.close(); process.exit(0); };
    process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(e => { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
