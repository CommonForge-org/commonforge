import { CandidateExecutionError, candidateErrorResults } from './g1-scenario-failure.js';
/** Trusted scheduling harness against immutable Cloudflare release outputs in real workerd.
 * No cloud deploy, binding emulation, candidate tests, Node fallback or credentials. */
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildRecipeSchema, canonicalJson, hashCanonicalSync, sha256HexSync, type BuildRecipe } from '@commonforge-org/core';
import { releaseOutputDigest, releaseTargetDigest, ReleaseTargetConfigSchema, type ReleaseBuildReceipt, type ReleaseTarget } from '@commonforge-org/runner-protocol';
import { cases } from './g1-scheduling-harness.js';
import type { LocalScenarioResult } from './g1-local-verifier.js';

/** Supervisor configuration, never candidate-provided. Pin the actual installed executable bytes. */
export interface CloudflareWorkerdPin { binary: string; sha256: string }
export interface CloudflareReleaseEnvironment {
  targets: ReleaseTarget[];
  environment: Record<string, { vars: Record<string, string>; kvNamespaces: unknown[]; d1Databases?: unknown[]; data?: string[]; compatibilityFlags?: string[] }>;
  healthCheck: unknown;
  accountId: string;
  migrations?: unknown[];
}
export interface CloudflareBuiltVerification {
  verifierDigest: string;
  runtimeRecipeDigest: string;
  outputDigest: string;
  targetDigest: string;
  execution: 'bubblewrap-linux-http';
  engine: 'workerd';
  engineDigest: string;
  network: 'none';
  controlPlaneMounted: false;
  results: LocalScenarioResult[];
}

export function cloudflareRuntimeRecipeDigest(recipe: BuildRecipe, environment: CloudflareReleaseEnvironment): string {
  BuildRecipeSchema.parse(recipe);
  return hashCanonicalSync({ domain: 'cf.project-runtime/1', recipe, environment });
}
export async function cloudflareSchedulingVerifierDigest(pin: CloudflareWorkerdPin, schema: string): Promise<string> {
  return hashCanonicalSync({ domain: 'cf.cloudflare-scheduling-verifier/2', cases, binaryDigest: pin.sha256,
    supervisorDigest: sha256HexSync(await readFile(new URL(import.meta.url))), failureSupervisorDigest: sha256HexSync(await readFile(new URL(`./g1-scenario-failure.${import.meta.url.endsWith('.ts')?'ts':'js'}`,import.meta.url))), schemaDigest: sha256HexSync(await readFile(schema)) });
}

function capnpText(value: string): string {
  // JSON string escaping is not identical to Cap'n Proto (notably \uXXXX); refuse unsupported controls.
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('unsupported control character in runtime configuration');
  return JSON.stringify(value);
}
function configuration(module: Uint8Array, config: ReturnType<typeof ReleaseTargetConfigSchema.parse>): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(module);
  if (text.includes('\0')) throw new Error('unsupported null byte in Worker module');
  // Explicit empty internet allowlist. Even a workerd vulnerability remains
  // confined by the surrounding mount/PID/network namespace and clean environment.
  return `using Workerd = import "workerd.capnp";\nconst config :Workerd.Config = (
    services = [(name = "internet", network = (allow = [])), (name = "candidate", worker = (
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      compatibilityDate = ${capnpText(config.compatibilityDate)},
      compatibilityFlags = [${config.compatibilityFlags.map(capnpText).join(',')}],
      bindings = [${Object.entries(config.vars).map(([name, value]) => `(name = ${capnpText(name)}, text = ${capnpText(value)})`).join(',')}]
    ))],
    sockets = [(name = "http", address = "unix:/scratch/preview.sock", http = (), service = "candidate")]
  );\n`;
}
async function observe(socketPath: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/reschedule', method: 'POST', timeout: 1500,
      headers: { host: 'fixture', 'content-type': 'application/json' } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65536) res.destroy(new Error('response exceeds bound')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('non-success response'); resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out'))); req.on('error', reject); req.end(JSON.stringify(body));
  });
}
async function waitForSocket(path: string, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (exited()) throw new Error('isolated workerd exited before startup');
    if ((await lstat(path).catch(() => null))?.isSocket()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('isolated workerd startup timed out');
}

/** Receipt and bytes must come from the supervisor's real release-build job, not an API body.
 * Narrow supported production contract: one already bundled ES Worker, vars only, no persistent
 * bindings or migrations, no additional modules. Refuse instead of emulating unavailable services.
 * Hashes verify built bytes; they do not themselves authenticate who produced the receipt. */
export async function verifyCloudflareBuiltScheduling(options: {
  pin: CloudflareWorkerdPin;
  /** The schema shipped alongside the pinned workerd installation, supervisor-owned. */
  schema: string;
  recipe: BuildRecipe;
  environment: CloudflareReleaseEnvironment;
  built: ReleaseBuildReceipt;
  readOutput(path: string): Promise<Uint8Array | null>;
}): Promise<CloudflareBuiltVerification> {
  const { pin, recipe, environment, built } = options;
  if (!/^[a-f0-9]{64}$/.test(pin.sha256)) throw new Error('workerd binary requires an exact digest');
  if (environment.targets.length !== 1 || built.targets.length !== 1 || (environment.migrations?.length ?? 0)) throw new Error('unsupported Cloudflare target set or migrations');
  const target = environment.targets[0]!;
  const receipt = built.targets[0]!;
  if (target.kind !== 'worker' || !target.main || receipt.targetId !== target.targetId || receipt.files.length !== 1 || receipt.files[0]!.path !== target.main || !/\.(?:mjs|js)$/.test(target.main) || (receipt.dataFiles?.length ?? 0)) throw new Error('only one bundled Worker output is supported');
  const config = ReleaseTargetConfigSchema.parse(receipt.config);
  const env = environment.environment[target.targetId] ?? { vars: {}, kvNamespaces: [] };
  if (Object.keys(environment.environment).some(k => k !== target.targetId) || env.kvNamespaces.length || env.d1Databases?.length || env.data?.length || config.kvNamespaces.length || config.d1Databases?.length || config.notFoundHandling) throw new Error('persistent bindings and assets are unsupported');
  if (Object.entries(env.vars).some(([key, value]) => config.vars[key] !== value) || (env.compatibilityFlags ?? []).some(flag => !config.compatibilityFlags.includes(flag))) throw new Error('release environment/config mismatch');
  if (config.vars.COMMONFORGE_RELEASE_ID !== built.releaseId) throw new Error('release identity mismatch');
  if (releaseTargetDigest(receipt.files, config, receipt.dataFiles ?? []) !== receipt.digest || releaseOutputDigest(built.targets) !== built.outputDigest) throw new Error('release output digest mismatch');
  const file = receipt.files[0]!;
  if (file.size > 1048576) throw new Error('Worker output exceeds bound');
  const output = await options.readOutput(file.path);
  if (!output || output.length !== file.size || sha256HexSync(output) !== file.sha256) throw new Error('release output bytes mismatch');
  const executable = await readFile(pin.binary);
  if (sha256HexSync(executable) !== pin.sha256) throw new Error('installed workerd differs from supervisor pin');
  const schemaBytes = await readFile(options.schema);
  const verifierDigest = await cloudflareSchedulingVerifierDigest(pin, options.schema);
  const scratch = await mkdtemp(join(tmpdir(), 'commonforge-g1-workerd-'));
  await chmod(scratch, 0o700);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    // Snapshot all executable/configuration inputs before launch; no path race with candidate files.
    await mkdir(join(scratch, 'socket'), { mode: 0o700 });
    await writeFile(join(scratch, 'workerd'), executable, { mode: 0o500 });
    await writeFile(join(scratch, 'workerd.capnp'), schemaBytes, { mode: 0o400 });
    await writeFile(join(scratch, 'worker.mjs'), output, { mode: 0o400 });
    await writeFile(join(scratch, 'config.capnp'), configuration(output, config), { mode: 0o400 });
    child = spawn('bwrap', ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--ro-bind', join(scratch, 'workerd'), '/workerd', '--ro-bind', join(scratch, 'workerd.capnp'), '/candidate/workerd.capnp',
      '--ro-bind', join(scratch, 'worker.mjs'), '/candidate/worker.mjs', '--ro-bind', join(scratch, 'config.capnp'), '/candidate/config.capnp',
      '--bind', join(scratch, 'socket'), '/scratch', '--chdir', '/candidate', '/usr/bin/sh', '-c', 'printf \'SANDBOX_STARTED\\n\'; exec /workerd serve /candidate/config.capnp'],
    { env: { PATH: '/usr/bin:/bin', HOME: '/tmp', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let failure: Error | undefined; let sandboxStarted = false;
    let startupOutput='';
    child.stdout?.on('data', chunk => { startupOutput=(startupOutput+String(chunk)).slice(-1024); if(startupOutput.includes('SANDBOX_STARTED\n'))sandboxStarted=true; });
    child.once('error', e => { failure = e; });
    // Drain bounded diagnostics without exposing candidate-controlled logs or secrets in results.
    child.stderr?.on('data', () => {});
    try { await waitForSocket(join(scratch, 'socket', 'preview.sock'), () => !!failure || child!.exitCode !== null || child!.signalCode !== null); } catch (error) { if (sandboxStarted) throw new CandidateExecutionError(); throw error; }
    const results: LocalScenarioResult[] = [];
    for (const [scenarioId, input, expected] of cases) {
      try {
        const actual = await observe(join(scratch, 'socket', 'preview.sock'), { now: '2026-10-17T12:00:00.000Z', ...input });
        const pass = canonicalJson(actual) === canonicalJson(expected);
        results.push({ scenarioId, result: pass ? 'pass' : 'fail', detail: pass ? 'expected workerd HTTP behavior observed' : 'workerd response differs from trusted expectation' });
      } catch { results.push({ scenarioId, result: 'error', detail: 'isolated workerd HTTP request failed' }); }
    }
    return { verifierDigest, runtimeRecipeDigest: cloudflareRuntimeRecipeDigest(recipe, environment), outputDigest: built.outputDigest,
      targetDigest: receipt.digest, execution: 'bubblewrap-linux-http', engine: 'workerd', engineDigest: pin.sha256,
      network: 'none', controlPlaneMounted: false, results };
  } catch (error) {
    if (!(error instanceof CandidateExecutionError)) throw error;
    return { verifierDigest, runtimeRecipeDigest: cloudflareRuntimeRecipeDigest(recipe, environment), outputDigest: built.outputDigest, targetDigest: receipt.digest, execution: 'bubblewrap-linux-http', engine: 'workerd', engineDigest: pin.sha256, network: 'none', controlPlaneMounted: false, results: candidateErrorResults(cases.map(c => c[0])) };
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child!.once('exit', () => resolve())); }
    await rm(scratch, { recursive: true, force: true });
  }
}
