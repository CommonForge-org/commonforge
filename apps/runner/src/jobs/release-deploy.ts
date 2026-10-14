/**
 * `release-deploy` (Task 22): publish a built release with the runner's own pinned `wrangler
 * deploy` (never a candidate's), from the stored outputs only.
 *
 * - Every file is fetched from `job.outputPrefix<targetId>/`, checked against its sha256 and size,
 *   each target's digest and the release `outputDigest` are recomputed and must match the job
 *   before anything is uploaded (AT-33/AT-34: what was approved is what is deployed).
 * - No candidate code runs: the Worker target is already bundled (`no_bundle`), the assets target
 *   is a static directory, and the generated `wrangler.json` holds only data fields from the
 *   release (`compatibility_date`, `compatibility_flags`, `vars`, `kv_namespaces`, `d1_databases`, `not_found_handling`).
 * - The account credential reaches only the wrangler process (`deploy.credentialEnv`): broker mode
 *   fetches it from the Worker for this open job; Sandbox egress mode passes a placeholder and the
 *   egress gateway injects the real token for this job kind only.
 * - Targets deploy in order. A failure after an earlier target went live reports
 *   `partial: <targetIds>` at the start of the detail, so the release service can tell `failed`
 *   (nothing changed) from `partial`.
 * - A `wrangler deploy` that failed because the Cloudflare API answered a 5xx (wrangler prints
 *   `<METHOD> /accounts/… -> 504 Gateway Timeout`) is run again for the same target, at most twice:
 *   the upload is the same files and config, so a repeat is safe. Seen on CI 2026-10-12, when about
 *   half the deploys of an hour hit a 504 on one API call. Any other failure is reported at once.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkPath, sha256HexSync } from '@commonforge-org/core';
import { redact, releaseOutputDigest, releaseTargetDigest, type JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';

const DEPLOY_TIMEOUT_MS = 5 * 60_000;
const RETRY_DELAYS_MS = [5_000, 20_000];
/** wrangler's report of a Cloudflare API call that answered a server error */
const API_5XX = /^\s*(GET|POST|PUT|PATCH|DELETE) \/\S+ -> 5\d\d\b/m;

/** True when a failed wrangler run failed on a Cloudflare API server error (worth one more try). */
export function isTransientApiFailure(output: string): boolean {
  return API_5XX.test(output);
}

type Target = JobContext<'release-deploy'>['job']['targets'][number];

export async function releaseDeploy(ctx: JobContext<'release-deploy'>): Promise<JobReceiptByKind['release-deploy']> {
  const job = ctx.job;
  const deploy = ctx.services.deploy;
  if (!deploy) throw new JobFailure('provider_unavailable', 'this runner is not configured for release deploys (no pinned wrangler)');

  // 1. fetch + verify everything before any upload
  const store = ctx.blobs();
  const work = await ctx.scratch('deploy');
  for (const t of job.targets) {
    for (const f of t.files) {
      const p = checkPath(f.path);
      if (!p.ok || p.path !== f.path) throw new JobFailure('scope_violation', `release file path ${JSON.stringify(f.path)} is invalid`);
      const data = await store.get(`${job.outputPrefix}${t.targetId}/${f.path}`);
      if (!data) throw new JobFailure('provider_unavailable', `release output ${t.targetId}/${f.path} is missing`);
      if (data.byteLength !== f.size || sha256HexSync(data) !== f.sha256) throw new JobFailure('scope_violation', `release output ${t.targetId}/${f.path} does not match its recorded sha256`);
      const abs = join(work, t.targetId, 'out', f.path);
      await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
      await writeFile(abs, data, { mode: 0o600 });
    }
    for (const f of t.dataFiles ?? []) {
      const p = checkPath(f.path);
      if (!p.ok || p.path !== f.path) throw new JobFailure('scope_violation', `release data path ${JSON.stringify(f.path)} is invalid`);
      const data = await store.get(`${job.outputPrefix}${t.targetId}/__data/${f.path}`);
      if (!data) throw new JobFailure('provider_unavailable', `release data file ${t.targetId}/${f.path} is missing`);
      if (data.byteLength !== f.size || sha256HexSync(data) !== f.sha256) throw new JobFailure('scope_violation', `release data file ${t.targetId}/${f.path} does not match its recorded sha256`);
    }
    if (releaseTargetDigest(t.files, t.config, t.dataFiles ?? []) !== t.digest) throw new JobFailure('scope_violation', `release target ${t.targetId} digest does not match its files and config`);
  }
  if (releaseOutputDigest(job.targets) !== job.outputDigest) throw new JobFailure('scope_violation', 'release outputDigest does not match its targets');

  // 2. deploy in order
  const deployed: JobReceiptByKind['release-deploy']['deployments'] = [];
  for (const t of job.targets) {
    ctx.assertNotExpired();
    const dir = join(work, t.targetId);
    await writeFile(join(dir, 'wrangler.json'), JSON.stringify(wranglerConfig(t, job.accountId), null, 2), { mode: 0o600 });
    const argv = [...deploy.wrangler, 'deploy', '--config', join(dir, 'wrangler.json')];
    const delays = deploy.retryDelaysMs ?? RETRY_DELAYS_MS;
    let r: Awaited<ReturnType<typeof run>>;
    let out: string;
    for (let attempt = 0; ; attempt++) {
      const credEnv = await deploy.credentialEnv(ctx.signedJob);
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: dir,
        CI: '1',
        NO_COLOR: '1',
        WRANGLER_SEND_METRICS: 'false',
        CLOUDFLARE_ACCOUNT_ID: job.accountId,
        ...(deploy.env ?? {}),
        ...credEnv,
      };
      r = await run(argv, dir, env);
      out = redact(`${r.stdout}\n${r.stderr}`, ...Object.values(credEnv), ...ctx.extraSecrets);
      if (r.code === 0 || attempt >= delays.length || !isTransientApiFailure(out)) break;
      ctx.log(`wrangler deploy of ${t.targetId}: the Cloudflare API answered a server error; trying again in ${Math.round(delays[attempt]! / 1000)} s`);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      ctx.assertNotExpired();
    }
    if (r.code !== 0) {
      const partial = deployed.length > 0 ? `partial: ${deployed.map((d) => d.targetId).join(',')}\n` : '';
      throw new JobFailure('provider_unavailable', `${partial}wrangler deploy of ${t.targetId} (${t.workerName}) failed: exit ${r.code}\n${out.slice(-3000)}`);
    }
    const version = /Current Version ID:\s*([0-9a-f-]{8,64})/i.exec(out)?.[1] ?? null;
    const url = new RegExp(`https://${t.workerName}\\.[a-z0-9-]+\\.workers\\.dev`).exec(out)?.[0] ?? null;
    deployed.push({ targetId: t.targetId, workerName: t.workerName, versionId: version, url });
    ctx.log(`deployed ${t.targetId} as ${t.workerName} (${version ?? 'no version id'})`);
  }
  return { jobId: ctx.jobId, releaseId: job.releaseId, outputDigest: job.outputDigest, deployments: deployed, deployedAt: ctx.nowIso() };
}

/** The generated config: data only (no build command, no bundling of candidate code). */
export function wranglerConfig(t: Target, accountId: string): Record<string, unknown> {
  const base = {
    name: t.workerName,
    account_id: accountId,
    compatibility_date: t.config.compatibilityDate,
    ...(t.config.compatibilityFlags.length > 0 ? { compatibility_flags: t.config.compatibilityFlags } : {}),
    workers_dev: true,
    ...(Object.keys(t.config.vars).length > 0 ? { vars: t.config.vars } : {}),
    ...(t.config.kvNamespaces.length > 0 ? { kv_namespaces: t.config.kvNamespaces.map((k) => ({ binding: k.binding, id: k.id })) } : {}),
    ...(t.config.d1Databases && t.config.d1Databases.length > 0 ? { d1_databases: t.config.d1Databases.map((d) => ({ binding: d.binding, database_id: d.id, database_name: d.binding })) } : {}),
  };
  if (t.kind === 'worker') {
    return { ...base, main: `out/${t.main}`, no_bundle: true, find_additional_modules: true, base_dir: 'out', rules: [{ type: 'ESModule', globs: ['**/*.js', '**/*.mjs'] }] };
  }
  return { ...base, assets: { directory: 'out', ...(t.config.notFoundHandling ? { not_found_handling: t.config.notFoundHandling } : {}) } };
}

function run(argv: readonly string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), DEPLOY_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => (stdout = (stdout + b.toString('utf8')).slice(-64_000)));
    child.stderr.on('data', (b: Buffer) => (stderr = (stderr + b.toString('utf8')).slice(-64_000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
