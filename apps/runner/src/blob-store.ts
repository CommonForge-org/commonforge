/**
 * Object storage the runner reads uploads from (`edition-return`, `inventory`) and writes exports,
 * previews and logs to. Production goes through the Worker (which owns the R2 binding and checks
 * every key against the signed job); dev and tests use a directory.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkPath } from '@commonforge-org/core';
import type { SignedJob } from '@commonforge-org/runner-protocol';
import { JobFailure } from './errors.js';

export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array, meta?: { contentType?: string; sha256?: string }): Promise<void>;
}

/** Factory: a store scoped to one signed job (the Worker authorizes keys per job). */
export type BlobStoreFactory = (signedJob: SignedJob) => BlobStore;

function safeKey(key: string): string {
  const r = checkPath(key);
  if (!r.ok || r.path !== key) throw new JobFailure('scope_violation', `invalid object key ${JSON.stringify(key)}`);
  return key;
}

/** Keys map to files under `root` (dev/tests). */
export function fsBlobStore(root: string): BlobStoreFactory {
  return () => ({
    async get(key) {
      try {
        return new Uint8Array(await readFile(join(root, safeKey(key))));
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') return null;
        throw e;
      }
    },
    async put(key, data) {
      const path = join(root, safeKey(key));
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
      await writeFile(tmp, data);
      await rename(tmp, path);
    },
  });
}

/**
 * Through the Worker: `GET|PUT <workerUrl>/api/runner/blobs/<encoded key>` with the signed job in
 * `x-commonforge-signed-job` (base64url JSON). The Worker verifies the job and allows only the
 * keys the job names (upload key; export sink prefix; preview prefix). Proposed contract for Task 16.
 */
export function workerBlobStore(options: { workerUrl: string; headers?: Record<string, string>; fetch?: typeof fetch }): BlobStoreFactory {
  const doFetch = options.fetch ?? fetch;
  return (signedJob) => {
    const jobHeader = Buffer.from(JSON.stringify(signedJob), 'utf8').toString('base64url');
    const url = (key: string) => `${options.workerUrl.replace(/\/+$/, '')}/api/runner/blobs/${encodeURIComponent(safeKey(key))}`;
    const headers = { ...options.headers, 'x-commonforge-signed-job': jobHeader };
    return {
      async get(key) {
        const res = await doFetch(url(key), { headers }).catch((e: Error) => {
          throw new JobFailure('provider_unavailable', `object store unreachable: ${e.message}`);
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new JobFailure(res.status === 403 ? 'scope_violation' : 'provider_unavailable', `object read ${key}: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      },
      async put(key, data, meta) {
        const res = await doFetch(url(key), {
          method: 'PUT',
          headers: { ...headers, 'content-type': meta?.contentType ?? 'application/octet-stream', ...(meta?.sha256 ? { 'x-commonforge-sha256': meta.sha256 } : {}) },
          body: data,
        }).catch((e: Error) => {
          throw new JobFailure('provider_unavailable', `object store unreachable: ${e.message}`);
        });
        if (!res.ok) throw new JobFailure(res.status === 403 ? 'scope_violation' : 'provider_unavailable', `object write ${key}: HTTP ${res.status}`);
      },
    };
  };
}
