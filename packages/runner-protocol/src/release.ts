/**
 * Release identity helpers (Task 22, plan §A.5 `ReleaseId`, AT-33). Worker-safe (sync sha256 from
 * core, no node imports).
 *
 * - A target's digest covers its files (path, sha256, size; sorted by path) and its deploy config.
 * - The release `outputDigest` covers every target's `{targetId, digest}` (sorted by targetId).
 * - `envConfigDigest` covers the server-owned release environment (targets + overlay vars).
 *
 * The publish approval binds `{releaseId, outputDigest}`; any change of source, recipe, config or
 * output is a different release (and needs a new approval).
 */
import { canonicalJson, sha256HexSync } from '@commonforge-org/core';
import type { ReleaseFile, ReleaseTargetConfig } from './jobs.js';

const enc = new TextEncoder();
const digestOf = (value: unknown) => sha256HexSync(enc.encode(canonicalJson(value)));

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Digest of one target. `dataFiles` joins the hashed object only when non-empty and `d1Databases`
 * only when non-empty, so a release made without D1 or data hashes exactly as it did before.
 */
export function releaseTargetDigest(files: readonly ReleaseFile[], config: ReleaseTargetConfig, dataFiles: readonly ReleaseFile[] = []): string {
  const sorted = [...files].map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })).sort(byPath);
  const { d1Databases, ...rest } = config;
  const normalized = d1Databases && d1Databases.length > 0 ? { ...rest, d1Databases } : rest;
  const data = [...dataFiles].map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })).sort(byPath);
  return digestOf({ $t: 'cf.release-target/1', files: sorted, config: normalized, ...(data.length > 0 ? { dataFiles: data } : {}) });
}

export function releaseOutputDigest(targets: ReadonlyArray<{ targetId: string; digest: string }>): string {
  const sorted = targets.map((t) => ({ targetId: t.targetId, digest: t.digest })).sort((a, b) => (a.targetId < b.targetId ? -1 : 1));
  return digestOf({ $t: 'cf.release-output/1', targets: sorted });
}

/** Digest of any server-owned configuration object (recipe env, release targets, overlay vars). */
export function configDigest(value: unknown): string {
  return digestOf({ $t: 'cf.release-env/1', value });
}
