/**
 * The filesystem/git port used by `materialize` and `verifyMaterialization`. The main entry stays
 * Worker-safe; the Node implementation lives at `@commonforge-org/runner-protocol/node`.
 *
 * Paths are absolute, `/`-separated. Implementations must not inject credentials into git
 * arguments (use a credential helper or environment configured by the adapter).
 */
import type { AssetManifestEntry, ManifestId, ResourceId } from '@commonforge-org/core';

export interface GitResult {
  /** process exit code (0 = success) */
  code: number;
  stdout: string;
  stderr: string;
}

export type FileKind = 'file' | 'dir' | 'symlink' | 'other';

export interface FileStat {
  /** from lstat: a symlink is reported as `symlink`, never followed */
  type: FileKind;
  size: number;
}

export interface AssetObjectRequest {
  mountName: string;
  resourceId: ResourceId;
  manifestId: ManifestId;
  entry: AssetManifestEntry;
}

export interface MaterializeIo {
  /** Run `git <args>` in `cwd`; resolve with the exit code instead of throwing on failure. */
  git(args: readonly string[], cwd: string): Promise<GitResult>;
  /** lstat semantics; `null` when the path does not exist. */
  lstat(path: string): Promise<FileStat | null>;
  readdir(path: string): Promise<string[]>;
  realpath(path: string): Promise<string>;
  /** `null` when the path does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Create a new file exclusively (fail if anything, including a symlink, exists at `path`). */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  /** Create one directory (`recursive` only used for the workspace root). */
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Fetch an asset object through the capability broker (asset mounts only). */
  fetchObject?(request: AssetObjectRequest): Promise<Uint8Array>;
}

/** Join an absolute directory with relative `/`-separated parts. */
export function joinFsPath(base: string, ...parts: string[]): string {
  const trimmed = base.length > 1 ? base.replace(/\/+$/, '') : base;
  return [trimmed, ...parts.filter((p) => p.length > 0)].join('/').replace(/^\/\//, '/');
}
