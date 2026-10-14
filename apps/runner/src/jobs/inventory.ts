/**
 * `inventory` (ZIP intake dry run, plan §C.1 row 2): a deterministic listing of an uploaded ZIP.
 * Nothing is executed and nothing is extracted to disk; no repository is touched.
 *
 * - The upload's sha256/size, when the job states them, must match (`scope_violation`).
 * - Unsafe entries are listed in `rejected` with their raw path and reason; archive-level limits
 *   (`too_many_files`, `too_large`, `ratio_exceeded`) give an empty listing with one rejection for
 *   the archive (path `""`). A structurally invalid archive fails the job (`scope_violation`).
 */
import { sha256HexSync } from '@commonforge-org/core';
import type { JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { readZip, ZipError } from '../zip.js';

export async function inventory(ctx: JobContext<'inventory'>): Promise<JobReceiptByKind['inventory']> {
  const { intakeId, upload, limits } = ctx.job;
  const bytes = await ctx.blobs().get(upload.r2Key);
  if (!bytes) throw new JobFailure('provider_unavailable', `upload ${upload.r2Key} not found`);
  if (upload.size !== undefined && bytes.length !== upload.size) throw new JobFailure('scope_violation', `upload is ${bytes.length} bytes, expected ${upload.size}`);
  if (upload.sha256 !== undefined && sha256HexSync(bytes) !== upload.sha256) throw new JobFailure('scope_violation', 'upload sha256 does not match');
  const base = { jobId: ctx.jobId, intakeId, inventoriedAt: ctx.nowIso() };
  try {
    const zip = readZip(bytes, limits);
    return {
      ...base,
      entries: zip.entries.map((e) => ({ path: e.path, size: e.data.length, sha256: sha256HexSync(e.data) })),
      rejected: zip.rejected.map((r) => ({ path: r.path.slice(0, 4096), reason: r.reason })),
      totalBytes: zip.totalBytes,
    };
  } catch (e) {
    if (e instanceof ZipError && e.reason !== 'malformed') return { ...base, entries: [], rejected: [{ path: '', reason: e.reason }], totalBytes: 0 };
    if (e instanceof ZipError) throw new JobFailure('scope_violation', `upload is not an acceptable zip: ${e.message}`);
    throw e;
  }
}
