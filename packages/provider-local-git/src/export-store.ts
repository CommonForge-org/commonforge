/**
 * Where `exportRevision` writes bundles. The `ExportSink` names an R2 key prefix; locally the
 * default store maps keys to files under a directory. A consumer with real R2 passes its own store.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkPath } from '@commonforge-org/core';
import { LocalGitProviderError } from './errors.js';

export interface ExportStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
}

/** Keys are resource-relative POSIX paths (no `..`, no leading `/`); stored under `dir`. */
export class FileExportStore implements ExportStore {
  constructor(readonly dir: string) {}

  #path(key: string): string {
    const r = checkPath(key);
    if (!r.ok || r.path !== key) throw new LocalGitProviderError('invalid_input', `export key ${JSON.stringify(key)} is not a normalized relative path`);
    return join(this.dir, ...key.split('/'));
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${crypto.randomUUID()}`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.#path(key)));
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null;
      throw e;
    }
  }
}
