/**
 * `release-build` (Task 22): build a release's outputs at the accepted shas with the
 * server-owned recipe, and store them under `job.outputPrefix<targetId>/` (immutable: a deploy
 * uploads exactly these bytes). The receipt lists every file's sha256, the per-target deploy
 * config (data only) and the release `outputDigest` that the publish approval binds (AT-33).
 *
 * Deploy config per target comes from the source's `wrangler.jsonc`/`wrangler.json`, read BEFORE
 * any recipe step runs (a build step can not rewrite it), and only data fields are taken:
 * `compatibility_date`, `compatibility_flags`, `vars`, `assets.not_found_handling`. Anything that
 * would execute at deploy time (`build.command`, custom bundling) or bind production resources is
 * ignored. The server-owned `job.environment[targetId]` supplies production bindings and wins over
 * source vars, and its `compatibilityFlags` are added to the source's (`global_fetch_strictly_public`
 * drops a source `no_global_fetch_strictly_public`); `COMMONFORGE_RELEASE_ID` is always the release. `environment.data` paths (files or
 * directories of the mount) are stored as `<target>/__data/<path>` and listed as `dataFiles`. They
 * are read BEFORE any recipe step runs, like the deploy config (staging phase 2, review I1): a build
 * step must never add or edit a migration that then runs on a database (the promotion veto reads
 * git). If the recipe changed any data file, the build fails.
 */
import { sha256HexSync } from '@commonforge-org/core';
import {
  ReleaseTargetConfigSchema,
  releaseOutputDigest,
  releaseTargetDigest,
  type JobReceiptByKind,
  type ReleaseFile,
  type ReleaseTargetConfig,
  type ReleaseTargetEnvironment,
} from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { parseJsonc } from '../jsonc.js';
import { collectOutput, contentTypeOf, materializeForBuild, readSourceFile, runRecipe } from './build-common.js';

/** the receipt schema's limit on `dataFiles` per target */
const MAX_DATA_FILES = 500;

type Target = JobContext<'release-build'>['job']['targets'][number];

export async function releaseBuild(ctx: JobContext<'release-build'>): Promise<JobReceiptByKind['release-build']> {
  const job = ctx.job;
  const root = await materializeForBuild(ctx, 'release', job.sources);
  const configs = new Map<string, ReleaseTargetConfig>();
  for (const t of job.targets) configs.set(t.targetId, await sourceConfig(root, t, environmentFor(job, t.targetId), job.releaseId));
  const data = new Map<string, DataFile[]>();
  for (const t of job.targets) data.set(t.targetId, await collectData(ctx, root, t, environmentFor(job, t.targetId), 'runner'));

  await runRecipe(ctx, root, job.recipe);

  for (const t of job.targets) {
    if (!sameData(data.get(t.targetId)!, await collectData(ctx, root, t, environmentFor(job, t.targetId), 'check').catch(() => null))) {
      throw new JobFailure('check_failed', `release target ${t.targetId}: the recipe changed its data files (migrations, seed); they must come from the source as committed`);
    }
  }

  const store = ctx.blobs();
  const targets: JobReceiptByKind['release-build']['targets'] = [];
  for (const t of job.targets) {
    const out = await collectOutput(ctx, root, t.mountName, t.outputPath);
    if (out.length === 0) throw new JobFailure('check_failed', `release target ${t.targetId}: ${t.mountName}/${t.outputPath} is empty`);
    if (t.kind === 'worker' && !out.some((f) => f.path === t.main)) throw new JobFailure('check_failed', `release target ${t.targetId}: entry ${t.main} was not built`);
    const files: ReleaseFile[] = [];
    for (const f of out) {
      const sha256 = sha256HexSync(f.data);
      await store.put(`${job.outputPrefix}${t.targetId}/${f.path}`, f.data, { contentType: contentTypeOf(f.path), sha256 });
      files.push({ path: f.path, sha256, size: f.data.byteLength });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    // data files (migrations, seed) come from the target's mount as read before the recipe, not
    // its output; they are stored under `<target>/__data/` (never deployed) and bound into the digest
    const dataFiles: ReleaseFile[] = [];
    for (const f of data.get(t.targetId)!) {
      await store.put(`${job.outputPrefix}${t.targetId}/__data/${f.path}`, f.data, { contentType: 'text/plain', sha256: f.sha256 });
      dataFiles.push({ path: f.path, sha256: f.sha256, size: f.data.byteLength });
    }
    const config = configs.get(t.targetId)!;
    targets.push({ targetId: t.targetId, digest: releaseTargetDigest(files, config, dataFiles), files, config, ...(dataFiles.length > 0 ? { dataFiles } : {}) });
  }
  return { jobId: ctx.jobId, releaseId: job.releaseId, outputDigest: releaseOutputDigest(targets), targets, builtAt: ctx.nowIso() };
}

type DataFile = { path: string; sha256: string; data: Uint8Array };

/** The target's `environment.data` files (mount-relative paths, sorted), with their sha256. */
/** `ownedBy`: `runner` before the recipe (the tree is still the runner's), `check` after it. */
async function collectData(ctx: JobContext<'release-build'>, root: string, t: Target, env: ReleaseTargetEnvironment, ownedBy: 'runner' | 'check'): Promise<DataFile[]> {
  const out: DataFile[] = [];
  for (const rel of env.data ?? []) {
    for (const f of await collectOutput(ctx, root, t.mountName, rel, { allowFile: true, ownedBy })) {
      const path = `${rel.replace(/\/$/, '')}${f.path ? `/${f.path}` : ''}`.replace(/^\/+/, '');
      if (out.some((d) => d.path === path)) continue; // listed twice (a directory and a file inside it)
      out.push({ path, sha256: sha256HexSync(f.data), data: f.data });
      if (out.length > MAX_DATA_FILES) throw new JobFailure('check_failed', `release target ${t.targetId}: more than ${MAX_DATA_FILES} data files`);
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const sameData = (a: DataFile[], b: DataFile[] | null): boolean => b !== null && a.length === b.length && a.every((f, i) => f.path === b[i]!.path && f.sha256 === b[i]!.sha256);

function environmentFor(job: JobContext<'release-build'>['job'], targetId: string): ReleaseTargetEnvironment {
  return job.environment[targetId] ?? { vars: {}, kvNamespaces: [] };
}

async function sourceConfig(root: string, t: Target, environment: ReleaseTargetEnvironment, releaseId: string): Promise<ReleaseTargetConfig> {
  const text = (await readSourceFile(root, t.mountName, 'wrangler.jsonc')) ?? (await readSourceFile(root, t.mountName, 'wrangler.json'));
  let src: Record<string, unknown> = {};
  if (text !== null) {
    try {
      const parsed = parseJsonc(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) src = parsed as Record<string, unknown>;
    } catch (e) {
      throw new JobFailure('check_failed', `release target ${t.targetId}: ${t.mountName}/wrangler.jsonc is not valid JSONC (${(e as Error).message})`);
    }
  }
  const vars: Record<string, string> = {};
  if (src.vars && typeof src.vars === 'object' && !Array.isArray(src.vars)) {
    for (const [k, v] of Object.entries(src.vars as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') vars[k] = String(v);
    }
  }
  Object.assign(vars, environment.vars, { COMMONFORGE_RELEASE_ID: releaseId });
  const assets = src.assets && typeof src.assets === 'object' ? (src.assets as Record<string, unknown>) : {};
  const added: string[] = environment.compatibilityFlags ?? [];
  // the environment's flags win: `global_fetch_strictly_public` and its `no_` form conflict
  const flags = [...(Array.isArray(src.compatibility_flags) ? (src.compatibility_flags as unknown[]) : []).filter((f) => !added.some((a) => f === `no_${a}`)), ...added];
  const parsed = ReleaseTargetConfigSchema.safeParse({
    compatibilityDate: src.compatibility_date,
    compatibilityFlags: [...new Set(flags)],
    vars,
    ...(t.kind === 'assets' && typeof assets.not_found_handling === 'string' ? { notFoundHandling: assets.not_found_handling } : {}),
    kvNamespaces: environment.kvNamespaces,
    ...(environment.d1Databases && environment.d1Databases.length > 0 ? { d1Databases: environment.d1Databases } : {}),
  });
  if (!parsed.success) {
    throw new JobFailure('check_failed', `release target ${t.targetId}: unusable deploy config in ${t.mountName}/wrangler.jsonc: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
