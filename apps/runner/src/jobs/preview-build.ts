/**
 * `preview-build` (Task 22): materialize each source at its integration sha (read only), run the
 * server-owned recipe steps as allowlisted isolated commands, and publish
 * - the static output directory under `<prefix>site/`, and
 * - each server bundle (e.g. the api Worker bundle the preview host runs with fixture bindings
 *   only) under `<prefix>bundles/<name>/`,
 * where `<prefix>` is `job.outputPrefix` (the Worker sets `org/<org>/previews/<previewId>/`).
 * The receipt URL is `<previewBaseUrl>/<previewId>/`; the per-preview token is never part of it
 * (the Worker mints it and only hands it to callers allowed to see the proposal).
 *
 * A failing step or a missing output directory → `check_failed` (redacted log tail). Symlinks,
 * hard links and special files in the output are never published.
 */
import { sha256HexSync } from '@commonforge-org/core';
import type { JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { collectOutput, contentTypeOf, materializeForBuild, runRecipe } from './build-common.js';

export async function previewBuild(ctx: JobContext<'preview-build'>): Promise<JobReceiptByKind['preview-build']> {
  const job = ctx.job;
  const base = ctx.services.previewBaseUrl;
  if (!base) throw new JobFailure('provider_unavailable', 'no preview base URL configured for this runner');
  const root = await materializeForBuild(
    ctx,
    'preview',
    job.sources.map((s) => ({ ...s, sha: job.integrationSha[s.resourceId]! })),
  );
  await runRecipe(ctx, root, job.recipe);

  const prefix = job.outputPrefix ?? `previews/${job.previewId}/`;
  const store = ctx.blobs();
  const publish = async (mountName: string, path: string, to: string) => {
    for (const f of await collectOutput(ctx, root, mountName, path)) {
      await store.put(`${to}${f.path}`, f.data, { contentType: contentTypeOf(f.path), sha256: sha256HexSync(f.data) });
    }
  };
  if (job.recipe.output) await publish(job.recipe.output.mountName, job.recipe.output.path, `${prefix}site/`);
  for (const b of job.bundles ?? []) await publish(b.mountName, b.path, `${prefix}bundles/${b.name}/`);
  const readyAt = ctx.now();
  return {
    jobId: ctx.jobId,
    previewId: job.previewId,
    url: `${base.replace(/\/+$/, '')}/${job.previewId}/`,
    integrationSha: job.integrationSha,
    recipe: { recipeId: job.recipe.recipeId, revision: job.recipe.revision },
    readyAt: readyAt.toISOString(),
    expiresAt: new Date(readyAt.getTime() + (job.ttlSeconds ?? 86_400) * 1000).toISOString(),
  };
}
