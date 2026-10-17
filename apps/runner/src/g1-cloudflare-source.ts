/** Bounded actual source -> build -> workerd adapter for the scheduling reference target.
 * Deliberately not a general build system. Source files are fetched by the supervisor at the
 * signed exact Git revision; the candidate cannot substitute a test harness or build receipt. */
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, sha256HexSync, type BuildRecipe } from '@commonforge-org/core';
import { releaseOutputDigest, releaseTargetDigest, ReleaseTargetConfigSchema, type ReleaseBuildReceipt } from '@commonforge-org/runner-protocol';
import { cases } from './g1-scheduling-harness.js';
import { cloudflareRuntimeRecipeDigest, cloudflareSchedulingVerifierDigest, verifyCloudflareBuiltScheduling, type CloudflareReleaseEnvironment, type CloudflareWorkerdPin } from './g1-cloudflare-verifier.js';

export const CLOUDFLARE_SCHEDULING_SOURCE_FILES = ['worker.mjs', 'build.mjs', 'wrangler.json'];
export interface CloudflareSchedulingAdapterOptions {
  pin: CloudflareWorkerdPin;
  schema: string;
  recipe: BuildRecipe;
  environment: CloudflareReleaseEnvironment;
}
function validateRecipe(options: CloudflareSchedulingAdapterOptions): void {
  const { recipe, environment } = options;
  const step = recipe.steps[0];
  const target = environment.targets[0];
  if (recipe.steps.length !== 1 || !step || step.command !== 'node build.mjs' || step.env && Object.keys(step.env).length ||
    environment.targets.length !== 1 || !target || target.kind !== 'worker' || target.mountName !== step.mountName || target.outputPath !== 'dist' || target.main !== 'worker.mjs') {
    throw new Error('Cloudflare scheduling adapter requires one node build.mjs step and dist/worker.mjs target');
  }
}
async function buildIsolated(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  if (Object.keys(files).sort().join(',') !== [...CLOUDFLARE_SCHEDULING_SOURCE_FILES].sort().join(',') || Object.values(files).some(f => f.length > 1048576)) throw new Error('bounded exact source files required');
  const scratch = await mkdtemp(join(tmpdir(), 'commonforge-g1-cloud-build-'));
  await chmod(scratch, 0o700);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    for (const path of CLOUDFLARE_SCHEDULING_SOURCE_FILES) await writeFile(join(scratch, path), files[path]!, { mode: 0o400 });
    const node = await realpath(process.execPath);
    child = spawn('bwrap', ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', node, '/node', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--bind', scratch, '/candidate', '--chdir', '/candidate', '/node', 'build.mjs'],
    { env: { PATH: '/usr/bin:/bin', HOME: '/tmp', TZ: 'UTC' }, stdio: 'ignore', detached: true });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { if (child?.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} reject(new Error('isolated build timed out')); }, 10000);
      child!.once('error', e => { clearTimeout(timer); reject(e); });
      child!.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('isolated build failed')); });
    });
    // bwrap's PID namespace dies with its init; no candidate process survives to race this read.
    const dist = join(scratch, 'dist');
    if ((await readdir(dist)).sort().join(',') !== 'worker.mjs') throw new Error('only one bundled Worker output is supported');
    if (await realpath(dist) !== dist) throw new Error('build output directory may not be a symlink');
    const handle = await open(join(dist, 'worker.mjs'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.nlink !== 1 || st.size > 1048576) throw new Error('build output must be a bounded plain file');
      const bytes = await handle.readFile();
      if (bytes.length > 1048576) throw new Error('build output exceeds bound');
      return bytes;
    } finally { await handle.close(); }
  } finally {
    if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child!.once('exit', () => resolve())); }
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Full environment is the same server-owned snapshot releases.ts hashes, not just target vars.
 * Source-only cfg fields match releaseBuild's read-before-build rules; unsupported resources fail.
 * The adapter actually builds candidate code in a namespace, then executes those output bytes in
 * workerd. Production releaseBuild will rebuild; this does not assert identical future build bytes. */
export async function createCloudflareSchedulingAdapter(options: CloudflareSchedulingAdapterOptions) {
  // Snapshot operator configuration so later accidental mutations cannot change a pinned adapter.
  options = JSON.parse(JSON.stringify(options)) as CloudflareSchedulingAdapterOptions;
  validateRecipe(options);
  const sourceSupervisorDigest = sha256HexSync(await readFile(new URL(import.meta.url)));
  const verifierDigest = sha256HexSync(canonicalJson({ domain: 'cf.cloudflare-source-verifier/1',
    workerdVerifierDigest: await cloudflareSchedulingVerifierDigest(options.pin, options.schema),
    sourceSupervisorDigest, nodeDigest: sha256HexSync(await readFile(process.execPath)), nodeVersion: process.versions.node, architecture: process.arch }));
  return {
    runtimeRecipeDigest: cloudflareRuntimeRecipeDigest(options.recipe, options.environment), verifierDigest, actor: 'local-workerd-runner',
    sourceFiles: [...CLOUDFLARE_SCHEDULING_SOURCE_FILES], scenarioIds: cases.map(c => c[0]), execution: 'bubblewrap-linux-http' as const,
    async verify(input: Record<string, Uint8Array>) {
      if (Object.keys(input).sort().join(',') !== [...CLOUDFLARE_SCHEDULING_SOURCE_FILES].sort().join(',') || Object.values(input).some(bytes => bytes.length > 1048576)) throw new Error('bounded exact source files required');
      const files = Object.fromEntries(Object.entries(input).map(([path, bytes]) => [path, Uint8Array.from(bytes)]));
      const src: Record<string, unknown> = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(files['wrangler.json']!));
      if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('source config must be JSON object');
      const target = options.environment.targets[0]!;
      const env = options.environment.environment[target.targetId] ?? { vars: {}, kvNamespaces: [] };
      const vars: Record<string, string> = {};
      if (src.vars && typeof src.vars === 'object' && !Array.isArray(src.vars)) for (const [key, value] of Object.entries(src.vars)) if (['string','number','boolean'].includes(typeof value)) vars[key] = String(value);
      const added = env.compatibilityFlags ?? [];
      const flags = [...(Array.isArray(src.compatibility_flags) ? src.compatibility_flags : []).filter(f => !added.some(a => f === `no_${a}`)), ...added];
      const config = ReleaseTargetConfigSchema.parse({ compatibilityDate: src.compatibility_date, compatibilityFlags: [...new Set(flags)],
        vars: { ...vars, ...env.vars, COMMONFORGE_RELEASE_ID: 'scenario-verification' }, kvNamespaces: env.kvNamespaces,
        ...(env.d1Databases?.length ? { d1Databases: env.d1Databases } : {}) });
      const bytes = await buildIsolated(files);
      const outputFiles = [{ path: 'worker.mjs', sha256: sha256HexSync(bytes), size: bytes.length }];
      const targets = [{ targetId: target.targetId, files: outputFiles, config, digest: releaseTargetDigest(outputFiles, config) }];
      const built: ReleaseBuildReceipt = { jobId: 'scenario-build', releaseId: 'scenario-verification', outputDigest: releaseOutputDigest(targets), targets, builtAt: new Date().toISOString() };
      const verified = await verifyCloudflareBuiltScheduling({ ...options, built, readOutput: async path => path === 'worker.mjs' ? bytes : null });
      return { ...verified, verifierDigest };
    },
  };
}
