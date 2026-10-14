/**
 * `export` (plan §B.10, §C.1 row 12): portable export of a snapshot to object storage, so the
 * project can be reconstructed with only `git`, `curl` and the manifest.
 *
 * Per resource: a git bundle of `refs/heads/main` at the exported sha, written to
 * `<r2Prefix><resourceId>/<sha>.bundle` (the LocalGitProvider layout).
 * - `full` (default): the commit and its complete history; `headSha` is the exported sha.
 * - `snapshot-only`: one parentless commit with the same tree, author and dates (no history);
 *   `headSha` is that commit, and `project.json` records the source sha it snapshots.
 * Per asset manifest: its JSON at `<r2Prefix><resourceId>/manifest-<manifestId>.json` after the
 * manifest id is recomputed and checked. Then `<r2Prefix>project.json` with the snapshot id,
 * mounts and provenance. Canonical repositories are only read; every key is under the sink prefix.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, computeAssetManifestIdSync, sha256HexSync, type ExportItem } from '@commonforge-org/core';
import type { JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { fetchCommits, scratchRepo } from './common.js';

export async function exportJob(ctx: JobContext<'export'>): Promise<JobReceiptByKind['export']> {
  const job = ctx.job;
  const prefix = job.sink.r2Prefix;
  const store = ctx.blobs();
  const items: ExportItem[] = [];
  const provenance: Array<Record<string, unknown>> = [];

  for (const r of job.resources) {
    const mode = r.historyMode ?? 'full';
    const dir = await scratchRepo(ctx, `export-${r.resourceId}`);
    await fetchCommits(ctx, dir, r.coords, [r.sha], `${r.resourceId}@${r.sha}`);
    let head = r.sha;
    if (mode === 'snapshot-only') {
      const meta = (await ctx.git.ok(['log', '-1', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI', r.sha], dir)).trim().split('\0');
      const [an, ae, ad, cn, ce, cd] = meta as [string, string, string, string, string, string];
      head = (
        await ctx.git.ok(['commit-tree', `${r.sha}^{tree}`, '-m', `snapshot of ${r.sha}`], dir, {
          env: { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce, GIT_COMMITTER_DATE: cd },
        })
      ).trim();
    }
    await ctx.git.ok(['update-ref', 'refs/heads/main', head], dir);
    const file = join(await ctx.scratch('bundle'), 'export.bundle');
    await ctx.git.ok(['bundle', 'create', '-q', file, 'HEAD', 'refs/heads/main'], dir); // HEAD so a clone checks out main
    const bytes = new Uint8Array(await readFile(file));
    const r2Key = `${prefix}${r.resourceId}/${head}.bundle`;
    const sha256 = sha256HexSync(bytes);
    await store.put(r2Key, bytes, { contentType: 'application/x-git-bundle', sha256 });
    items.push({ resourceId: r.resourceId, kind: 'git-bundle', r2Key, sha256, headSha: head, historyMode: mode });
    provenance.push({ resourceId: r.resourceId, kind: r.coords.kind, namespace: r.coords.namespace, repoName: r.coords.repoName, repoId: r.coords.repoId, sourceSha: r.sha, headSha: head, historyMode: mode, bundle: r2Key });
  }

  for (const m of job.manifests) {
    const recomputed = computeAssetManifestIdSync({ resourceId: m.resourceId, parentManifestId: m.parentManifestId, entries: m.entries });
    if (recomputed !== m.manifestId) throw new JobFailure('scope_violation', `asset manifest ${m.manifestId} does not hash to its id`);
    const r2Key = `${prefix}${m.resourceId}/manifest-${m.manifestId}.json`;
    const bytes = new TextEncoder().encode(canonicalJson(m));
    await store.put(r2Key, bytes, { contentType: 'application/json', sha256: sha256HexSync(bytes) });
    items.push({ resourceId: m.resourceId, kind: 'asset-manifest', r2Key, manifestId: m.manifestId, objects: m.entries.length, bytes: m.entries.reduce((s, e) => s + e.size, 0) });
  }

  const createdAt = ctx.nowIso();
  const structureKey = `${prefix}project.json`;
  const structure = {
    format: 'commonforge-export/1',
    exportId: job.exportId,
    snapshotId: job.snapshotId,
    createdAt,
    resources: provenance,
    assetManifests: items.filter((i) => i.kind === 'asset-manifest'),
    restore: 'git clone <resourceId>/<headSha>.bundle <dir>; assets: fetch each manifest entry objectKey and verify sha256',
  };
  const sBytes = new TextEncoder().encode(JSON.stringify(structure, null, 2));
  await store.put(structureKey, sBytes, { contentType: 'application/json', sha256: sha256HexSync(sBytes) });
  items.push({ kind: 'project-structure', r2Key: structureKey });
  return { exportId: job.exportId, snapshotId: job.snapshotId, items, createdAt };
}
