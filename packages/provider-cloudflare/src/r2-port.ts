/**
 * Minimal R2-like storage port used by {@link R2AssetProvider}.
 *
 * It is a structural subset of the Workers `R2Bucket` binding (`@cloudflare/workers-types`), so a
 * Worker passes `env.COMMONFORGE_ASSETS` directly (checked by `test/r2-port.typecheck.ts`). Node/CLI
 * callers can implement it over the R2 S3-compatible API (see `test/r2-s3-port.ts`).
 *
 * Only what the provider needs is declared; nothing here may be wider than `R2Bucket` accepts.
 */

/** Result of a stream read (matches `ReadableStreamReadResult`). */
export type R2PortReadResult = { done: false; value: Uint8Array } | { done: true; value?: undefined };

export interface R2PortReader {
  read(): Promise<R2PortReadResult>;
  releaseLock(): void;
  cancel(reason?: unknown): Promise<void>;
}

/** The subset of `ReadableStream<Uint8Array>` the provider consumes. */
export interface R2PortStream {
  getReader(): R2PortReader;
}

export interface R2PortHttpMetadata {
  contentType?: string;
}

/** Subset of `R2Object`. */
export interface R2PortObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: Date;
  readonly httpMetadata?: R2PortHttpMetadata;
  readonly customMetadata?: Record<string, string>;
}

/** Subset of `R2ObjectBody`. */
export interface R2PortObjectBody extends R2PortObject {
  readonly body: R2PortStream;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2PortPutOptions {
  httpMetadata?: R2PortHttpMetadata;
  customMetadata?: Record<string, string>;
  /** Hex sha256 the store verifies before accepting the write (R2 binding semantics). */
  sha256?: string;
}

/** Subset of `R2GetOptions`: a conditional read. */
export interface R2PortGetOptions {
  onlyIf: { etagMatches?: string };
}

export interface R2PortListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface R2PortListResult {
  objects: R2PortObject[];
  truncated: boolean;
  cursor?: string;
}

export interface R2PortUploadedPart {
  partNumber: number;
  etag: string;
}

/** Subset of `R2MultipartUpload`. */
export interface R2PortMultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: Uint8Array): Promise<R2PortUploadedPart>;
  abort(): Promise<void>;
  complete(parts: R2PortUploadedPart[]): Promise<R2PortObject>;
}

export interface R2PortMultipartOptions {
  httpMetadata?: R2PortHttpMetadata;
  customMetadata?: Record<string, string>;
}

/** Subset of `R2Bucket`. */
export interface R2PortBucket {
  head(key: string): Promise<R2PortObject | null>;
  /** A failed `onlyIf` precondition resolves to the object's metadata without a body (R2 semantics). */
  get(key: string, options: R2PortGetOptions): Promise<R2PortObjectBody | R2PortObject | null>;
  get(key: string): Promise<R2PortObjectBody | null>;
  put(key: string, value: Uint8Array | string, options?: R2PortPutOptions): Promise<R2PortObject | null>;
  /** Up to 1000 keys per call. */
  delete(keys: string | string[]): Promise<void>;
  list(options?: R2PortListOptions): Promise<R2PortListResult>;
  createMultipartUpload(key: string, options?: R2PortMultipartOptions): Promise<R2PortMultipartUpload>;
}

/** R2 multipart limits: every part but the last must be the same size and at least 5 MiB. */
export const R2_MIN_PART_BYTES = 5 * 1024 * 1024;
export const R2_MAX_PARTS = 10_000;
export const R2_MAX_DELETE_KEYS = 1000;
