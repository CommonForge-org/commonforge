/**
 * In-memory R2 double implementing {@link R2PortBucket} with R2 semantics the provider relies on:
 * put-time sha256 verification, multipart part-size rules, invisible-until-complete multipart
 * uploads, paginated list with cursors, and an injectable clock for `uploaded`.
 */
import { createHash } from 'node:crypto';
import {
  R2_MIN_PART_BYTES,
  type R2PortBucket,
  type R2PortGetOptions,
  type R2PortListOptions,
  type R2PortListResult,
  type R2PortMultipartOptions,
  type R2PortMultipartUpload,
  type R2PortObject,
  type R2PortObjectBody,
  type R2PortPutOptions,
  type R2PortReader,
  type R2PortUploadedPart,
} from '../src/r2-port.js';

interface Stored {
  bytes: Uint8Array;
  uploaded: Date;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
  etag: string;
}

export class MemoryR2 implements R2PortBucket {
  readonly objects = new Map<string, Stored>();
  readonly calls: string[] = [];
  /** Open (not completed/aborted) multipart uploads by id. */
  readonly openUploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  completedMultipart = 0;
  abortedMultipart = 0;
  listPageSize = 1000;
  /** Read chunk size for `get().body` streams. */
  chunkSize = 1 << 20;
  private seq = 0;

  constructor(public clock: () => Date = () => new Date()) {}

  private meta(key: string, s: Stored): R2PortObject {
    return {
      key,
      size: s.bytes.length,
      etag: s.etag,
      uploaded: s.uploaded,
      httpMetadata: { ...s.httpMetadata },
      customMetadata: { ...s.customMetadata },
    };
  }

  private store(key: string, bytes: Uint8Array, o: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } = {}): R2PortObject {
    const s: Stored = {
      bytes: bytes.slice(),
      uploaded: this.clock(),
      httpMetadata: { ...(o.httpMetadata ?? {}) },
      customMetadata: { ...(o.customMetadata ?? {}) },
      etag: createHash('md5').update(bytes).digest('hex'),
    };
    this.objects.set(key, s);
    return this.meta(key, s);
  }

  /** Test helper: write bytes directly (bypasses the provider). */
  seed(key: string, bytes: Uint8Array | string, uploaded?: Date): void {
    const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    this.store(key, b);
    if (uploaded) this.objects.get(key)!.uploaded = uploaded;
  }

  async head(key: string): Promise<R2PortObject | null> {
    this.calls.push(`head ${key}`);
    const s = this.objects.get(key);
    return s ? this.meta(key, s) : null;
  }

  get(key: string, options: R2PortGetOptions): Promise<R2PortObjectBody | R2PortObject | null>;
  get(key: string): Promise<R2PortObjectBody | null>;
  async get(key: string, options?: R2PortGetOptions): Promise<R2PortObjectBody | R2PortObject | null> {
    this.calls.push(`get ${key}`);
    const s = this.objects.get(key);
    if (!s) return null;
    const want = options?.onlyIf.etagMatches;
    if (want !== undefined && want.replace(/^"|"$/g, '') !== s.etag) return this.meta(key, s);
    const bytes = s.bytes;
    const chunk = this.chunkSize;
    let off = 0;
    let released = false;
    const reader: R2PortReader = {
      read: async () => {
        if (released) throw new Error('reader released');
        if (off >= bytes.length) return { done: true };
        const v = bytes.slice(off, off + chunk);
        off += v.length;
        return { done: false, value: v };
      },
      releaseLock: () => {
        released = true;
      },
      cancel: async () => {
        off = bytes.length;
      },
    };
    return {
      ...this.meta(key, s),
      body: { getReader: () => reader },
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async put(key: string, value: Uint8Array | string, options: R2PortPutOptions = {}): Promise<R2PortObject | null> {
    this.calls.push(`put ${key}`);
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    if (options.sha256 !== undefined) {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== options.sha256) throw new Error(`put: sha256 mismatch for ${key}`);
    }
    return this.store(key, bytes, options);
  }

  async delete(keys: string | string[]): Promise<void> {
    const ks = typeof keys === 'string' ? [keys] : keys;
    if (ks.length > 1000) throw new Error('delete: > 1000 keys');
    this.calls.push(`delete ${ks.join(',')}`);
    for (const k of ks) this.objects.delete(k);
  }

  async list(options: R2PortListOptions = {}): Promise<R2PortListResult> {
    this.calls.push(`list ${options.prefix ?? ''}`);
    const limit = Math.min(options.limit ?? 1000, this.listPageSize);
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(options.prefix ?? '')).sort();
    const start = options.cursor ? keys.findIndex((k) => k > options.cursor!) : 0;
    const page = start < 0 ? [] : keys.slice(start, start + limit);
    const truncated = start >= 0 && start + limit < keys.length;
    return {
      objects: page.map((k) => this.meta(k, this.objects.get(k)!)),
      truncated,
      ...(truncated ? { cursor: page[page.length - 1]! } : {}),
    };
  }

  async createMultipartUpload(key: string, options: R2PortMultipartOptions = {}): Promise<R2PortMultipartUpload> {
    this.calls.push(`mpu-create ${key}`);
    const uploadId = `u${++this.seq}`;
    const state = { key, parts: new Map<number, Uint8Array>() };
    this.openUploads.set(uploadId, state);
    const self = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber: number, value: Uint8Array): Promise<R2PortUploadedPart> {
        if (!self.openUploads.has(uploadId)) throw new Error('upload not open');
        state.parts.set(partNumber, value.slice());
        return { partNumber, etag: `p${partNumber}-${value.length}` };
      },
      async abort(): Promise<void> {
        self.openUploads.delete(uploadId);
        self.abortedMultipart++;
      },
      async complete(parts: R2PortUploadedPart[]): Promise<R2PortObject> {
        if (!self.openUploads.has(uploadId)) throw new Error('upload not open');
        const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => state.parts.get(p.partNumber)!);
        // R2 rule: all parts except the last are equal size and >= 5 MiB.
        for (let i = 0; i < ordered.length - 1; i++) {
          if (ordered[i]!.length < R2_MIN_PART_BYTES || ordered[i]!.length !== ordered[0]!.length) {
            throw new Error('complete: invalid part sizes');
          }
        }
        const total = ordered.reduce((n, p) => n + p.length, 0);
        const all = new Uint8Array(total);
        let off = 0;
        for (const p of ordered) {
          all.set(p, off);
          off += p.length;
        }
        self.openUploads.delete(uploadId);
        self.completedMultipart++;
        return self.store(key, all, options);
      },
    };
  }
}
