/** Start a disposable real-local Worker + Node source sidecar + pull runner. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startArtifactsSidecar } from './g1-artifacts-sidecar.js';
import { startLocalScenarioBridge } from './g1-local-bridge.js';
import { startLocalPreview } from './g1-local-preview.js';
import { localNamespaceCommands } from './g1-bwrap-commands.js';
import { brokerCredentials } from './credentials.js';
import { createRunner } from './runner.js';
import { createWorkerClient } from './worker-client.js';
import { workerBlobStore } from './blob-store.js';

async function command(args: string[], cwd: string) {
  await new Promise<void>((resolve, reject) => { const child = spawn('pnpm', args, { cwd, stdio: ['ignore', process.stderr, process.stderr] }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`command exited ${code}`))); });
}
async function main() {
  const repo = fileURLToPath(new URL('../../../', import.meta.url)), workerDir = join(repo, 'apps/worker');
  const root = process.env.G1_STATE_DIR ? resolve(process.env.G1_STATE_DIR) : await mkdtemp(join(tmpdir(), 'commonforge-g1-real-worker-'));
  const previous = await readFile(join(root, 'worker.json'), 'utf8').then(s => JSON.parse(s) as { vars: Record<string,string> }, () => null);
  const priorOperator = previous ? JSON.parse(await readFile(join(root, 'operator.json'), 'utf8')) as { sidecarUrl: string; sidecarKey: string; bridgeUrl: string; jobKey: {kid:string;secret:string} } : null;
  const port = Number(process.env.PORT ?? 8899), previewPort = Number(process.env.PREVIEW_PORT ?? 8900);
  if (!Number.isInteger(port) || port <= 1024 || port > 65535 || !Number.isInteger(previewPort) || previewPort <= 1024 || previewPort > 65535 || port === previewPort) throw new Error('PORT/PREVIEW_PORT must be distinct unprivileged ports');
  const workerUrl = `http://127.0.0.1:${port}`, previewUrl = `http://127.0.0.1:${previewPort}`;
  for (const url of [workerUrl, previewUrl]) {
    try { const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }); await r.body?.cancel(); throw new Error(`port already occupied: ${url}`); }
    catch (e) { if (e instanceof Error && e.message.startsWith('port already')) throw e; }
  }
  const random = () => randomBytes(32).toString('hex'), key = priorOperator?.sidecarKey ?? random(), runnerBearer = previous?.vars.COMMONFORGE_RUNNER_TOKEN ?? random();
  const jobKey = priorOperator?.jobKey ?? { kid: 'k1', secret: random() }, namespacePrefix = 'commonforge-real';
  const sidecar = await startArtifactsSidecar({ stateDir: join(root, 'source'), key, port: priorOperator ? Number(new URL(priorOperator.sidecarUrl).port) : undefined });
  const bridge = await startLocalScenarioBridge({ provider: sidecar.provider, jobKey, resources: [], port: priorOperator ? Number(new URL(priorOperator.bridgeUrl).port) : undefined, readCandidate: async request => {
    const head = request.sourceHeads[0]!; return sidecar.artifacts.candidateData(request.organizationId, head.resourceId, head.revisionId, namespacePrefix);
  } });
  const previewKey = previous?.vars.COMMONFORGE_LOCAL_PREVIEW_KEY ?? random();
  const localPreview = await startLocalPreview({ key: previewKey, port: previous?.vars.COMMONFORGE_LOCAL_PREVIEW_URL ? Number(new URL(previous.vars.COMMONFORGE_LOCAL_PREVIEW_URL).port) : undefined });
  const vars = {
    COMMONFORGE_NAMESPACE_PREFIX: namespacePrefix, COMMONFORGE_ASSETS_BUCKET: 'commonforge-assets-real',
    COMMONFORGE_APP_URL: workerUrl, COMMONFORGE_PUBLIC_URL: workerUrl, COMMONFORGE_EMAIL_FROM: 'login@example.test', COMMONFORGE_EMAIL_MODE: 'log',
    COMMONFORGE_ADMIN_EMAILS: process.env.ADMIN_EMAIL ?? 'owner@agency.e2e.test', COMMONFORGE_DEPLOY_WORKER_PREFIX: 'cfapp',
    COMMONFORGE_SESSION_SECRET: previous?.vars.COMMONFORGE_SESSION_SECRET ?? random(), COMMONFORGE_RUNNER_JOB_KEY: jobKey.secret, COMMONFORGE_RUNNER_TOKEN: runnerBearer,
    COMMONFORGE_LOCAL_ARTIFACTS_URL: sidecar.url, COMMONFORGE_LOCAL_ARTIFACTS_KEY: key, COMMONFORGE_LOCAL_RUNNER_URL: bridge.url, COMMONFORGE_LOCAL_PREVIEW_URL: localPreview.url, COMMONFORGE_LOCAL_PREVIEW_KEY: previewKey,
    COMMONFORGE_PREVIEW_URL: previewUrl, COMMONFORGE_PREVIEW_KEY: previous?.vars.COMMONFORGE_PREVIEW_KEY ?? random(), CF_ACCOUNT_ID: '00000000000000000000000000000000', CF_API_TOKEN: 'local-only-no-cloud-token',
  };
  const bindings = { compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'], workers_dev: false,
    r2_buckets: [{ binding: 'COMMONFORGE_ASSETS', bucket_name: 'commonforge-assets-real' }], vars };
  const config = { ...bindings, name: 'commonforge-real-local', main: join(workerDir, 'e2e/real-stack.ts'),
    assets: { directory: join(repo, 'apps/web/dist'), not_found_handling: 'single-page-application', run_worker_first: ['/api/*', '/health'] },
    durable_objects: { bindings: [{ name: 'ORG_LEDGER', class_name: 'OrgLedger' }, { name: 'OPS_GATE', class_name: 'OpsGate' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['OrgLedger'] }, { tag: 'v2', new_sqlite_classes: ['OpsGate'] }],
    d1_databases: [{ binding: 'DB', database_name: 'commonforge-real', database_id: '00000000-0000-4000-8000-0000000000e3', migrations_dir: join(workerDir, 'migrations') }],
    queues: { producers: [{ binding: 'OUTBOX', queue: 'commonforge-real-outbox' }, { binding: 'STEPS', queue: 'commonforge-real-steps' }, { binding: 'RUNNER_JOBS', queue: 'commonforge-real-runner-jobs' }], consumers: [ { queue: 'commonforge-real-outbox', max_batch_size: 4, max_batch_timeout: 1 }, { queue: 'commonforge-real-steps', max_batch_size: 4, max_batch_timeout: 1 }, { queue: 'commonforge-real-runner-jobs', max_batch_size: 1, max_batch_timeout: 1 }] },
  };
  const configPath = join(root, 'worker.json'), previewConfig = join(root, 'preview.json'), persist = join(root, 'miniflare');
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(previewConfig, JSON.stringify({ ...bindings, vars: { COMMONFORGE_PREVIEW_KEY: vars.COMMONFORGE_PREVIEW_KEY, COMMONFORGE_LOCAL_PREVIEW_URL: localPreview.url, COMMONFORGE_LOCAL_PREVIEW_KEY: previewKey }, name: 'commonforge-real-preview', main: join(workerDir, 'e2e/real-preview.ts') }, null, 2), { mode: 0o600 });
  await writeFile(join(root, 'operator.json'), JSON.stringify({ sidecarUrl: sidecar.url, sidecarKey: key, bridgeUrl: bridge.url, jobKey, workerUrl, namespacePrefix }), { mode: 0o600 });
  const baseArgs = ['--filter', '@commonforge-org/worker', 'exec', 'wrangler'];
  await command([...baseArgs, 'd1', 'migrations', 'apply', 'commonforge-real', '--local', '-c', configPath, '--persist-to', persist, '--env-file', join(workerDir, 'e2e/no-secrets.env')], repo);
  // Both processes need their own ephemeral inspector port as well as distinct HTTP ports.
  const start = (path: string, listen: number) => spawn('pnpm', [...baseArgs, 'dev', '-c', path, '--persist-to', persist, '--env-file', join(workerDir, 'e2e/no-secrets.env'), '--ip', '127.0.0.1', '--port', String(listen), '--inspector-port', '0', '--show-interactive-dev-session=false'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = start(configPath, port), preview = start(previewConfig, previewPort);
  for (const c of [child, preview]) { c.stdout.pipe(process.stderr); c.stderr.pipe(process.stderr); }
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; child.kill('SIGTERM'); preview.kill('SIGTERM'); await bridge.close(); await localPreview.close(); await sidecar.close(); };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  for (const [name, process] of [['API', child], ['preview', preview]] as const) {
    process.once('exit', (code, signal) => {
      if (!stopped) console.error(`G1 ${name} Worker exited (code=${code}, signal=${signal}); stopping the local stack`);
      void stop();
    });
  }
  const headers = { authorization: `Bearer ${runnerBearer}` }, client = createWorkerClient({ workerUrl, headers, attempts: 2 });
  const runner = createRunner({ workDir: join(root, 'runner'), journalDir: join(root, 'journal'), trustedWorkerOrigin: workerUrl,
    credentials: brokerCredentials({ headers }), jobKeyring: [jobKey], git: { allowHttp: true },
    commands: await localNamespaceCommands(join(root, 'sandbox-bin')), evidenceKey: job => client.evidenceKey(job), currentHeads: job => client.heads(job),
    blobStore: workerBlobStore({ workerUrl, headers }), previewBaseUrl: previewUrl, runnerId: 'real-local-pull-runner', log: line => process.stderr.write(`${line}\n`) });
  const report = { mode: 'real-local-worker', pid: process.pid, root, workerUrl, previewUrl, sourceUrl: sidecar.url, bridgeUrl: bridge.url, operatorFile: join(root, 'operator.json'),
    real: ['Worker API', 'SQLite Durable Objects', 'D1', 'local R2', 'Git smart HTTP', 'Node pull runner', 'isolated scheduling scenarios', 'static and isolated API previews'],
    limitations: ['Cloud release is unavailable.', 'Only Node build/check entrypoints are supported; no dependency installs.', 'API previews support standalone Node-compatible modules and fresh synthetic state per request; Workers-only runtime APIs require cloud verification.'] };
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(`${JSON.stringify(report)}\n`);
  while (!stopped) {
    try { const delivery = await client.nextJob('real-local-pull-runner'); if (delivery) { const result = await runner.execute(delivery); const job = runner.lastVerified.get(result.jobId); if (job) await client.postResult(job, result); } }
    catch (e) { if (!stopped) process.stderr.write(`[real-local runner] ${e instanceof Error ? e.message : String(e)}\n`); }
    if (!stopped) await new Promise(resolve => setTimeout(resolve, 250));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(e => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
