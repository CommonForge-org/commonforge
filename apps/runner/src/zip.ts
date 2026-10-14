/**
 * A minimal, defensive ZIP reader (no dependency) for client returns and intake inventory
 * (plan §F "Path/symlink attacks": reject traversal, symlinks, >N files, decompression ratio >100).
 *
 * Supported: the central directory of a single-disk archive, entries `stored` (0) or `deflate`
 * (8), UTF-8 or ASCII names, data descriptors. Refused outright (the whole archive): ZIP64,
 * multi-disk, encryption, other compression methods, inconsistent or overlapping entries, CRC or
 * size mismatches, more than `maxFiles` entries, more than `maxTotalBytes` uncompressed, or an
 * overall compression ratio above the limit. Refused per entry (reported, never extracted):
 * traversal/absolute paths (`path_escape`), other invalid names (`invalid_path`), symlinks,
 * special files, duplicates and case-fold collisions, and entries whose own ratio exceeds the
 * limit. Nothing is ever written to disk here; callers get bytes.
 *
 * Entries recorded with a FIFO/device mode are `special_file`: Info-ZIP `zip -fd -` (archiving
 * stdin) records its entry as a FIFO, so client tooling must zip real files, not streams.
 *
 * Inflation is bounded by each entry's declared size (`maxOutputLength`), so a lying header
 * cannot expand past what the limits already accepted.
 */
import { crc32, inflateRawSync } from 'node:zlib';
import { caseFoldKey, checkPath } from '@commonforge-org/core';

export type ZipRejectReason =
  | 'path_escape'
  | 'invalid_path'
  | 'symlink'
  | 'special_file'
  | 'duplicate'
  | 'case_collision'
  | 'too_many_files'
  | 'too_large'
  | 'ratio_exceeded';

export interface ZipLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
}

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

export interface ZipReadResult {
  entries: ZipEntry[];
  rejected: Array<{ path: string; reason: ZipRejectReason }>;
  totalBytes: number;
}

export class ZipError extends Error {
  constructor(
    readonly reason: ZipRejectReason | 'malformed',
    message: string,
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const S_IFMT = 0o170000;

function malformed(msg: string): never {
  throw new ZipError('malformed', `malformed zip: ${msg}`);
}

function decodeName(raw: Uint8Array, utf8Flag: boolean): string | null {
  if (!utf8Flag && raw.some((b) => b > 0x7f)) return null; // CP437 names are refused, not guessed
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return null;
  }
}

export function readZip(bytes: Uint8Array, limits: ZipLimits): ZipReadResult {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 22) malformed('too short');
  // End of central directory: the last signature within the final 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) malformed('no end of central directory');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('malformed', 'ZIP64 archives are not supported');
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) malformed('multi-disk archive');
  if (cdOffset + cdSize > eocd) malformed('central directory out of range');
  if (count > limits.maxFiles) throw new ZipError('too_many_files', `archive has ${count} entries (limit ${limits.maxFiles})`);

  interface Raw {
    path: string;
    method: number;
    crc: number;
    csize: number;
    usize: number;
    start: number;
  }
  const accepted: Raw[] = [];
  const rejected: ZipReadResult['rejected'] = [];
  const seen = new Set<string>();
  const folded = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let declaredTotal = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== CDH_SIG) malformed(`bad central directory entry ${n}`);
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const lho = buf.readUInt32LE(p + 42);
    const rawName = new Uint8Array(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (p > cdOffset + cdSize) malformed('central directory overrun');
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw new ZipError('malformed', 'ZIP64 entries are not supported');
    if (flags & 0x1) throw new ZipError('malformed', 'encrypted entries are not supported');
    if (method !== 0 && method !== 8) throw new ZipError('malformed', `compression method ${method} is not supported`);

    // local header: must agree with the central directory
    if (lho + 30 > cdOffset || buf.readUInt32LE(lho) !== LFH_SIG) malformed(`bad local header for entry ${n}`);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    if (!buf.subarray(lho + 30, lho + 30 + lNameLen).equals(Buffer.from(rawName))) malformed(`local and central names differ for entry ${n}`);
    if (buf.readUInt16LE(lho + 8) !== method) malformed(`local and central methods differ for entry ${n}`);
    if (start + csize > cdOffset) malformed(`entry ${n} data out of range`);
    ranges.push([lho, start + csize]);

    const display = decodeName(rawName, (flags & 0x800) !== 0);
    const shown = display ?? Buffer.from(rawName).toString('latin1');
    if (display === null) {
      rejected.push({ path: shown, reason: 'invalid_path' });
      continue;
    }
    const isUnix = madeBy >> 8 === 3;
    const mode = isUnix ? (external >>> 16) & 0xffff : 0;
    const type = mode & S_IFMT;
    const isDir = display.endsWith('/') || type === 0o040000 || (!isUnix && (external & 0x10) !== 0);
    const check = checkPath(display.replace(/\/+$/, ''));
    if (!check.ok) {
      rejected.push({ path: display, reason: check.violation === 'dot_dot' || check.violation === 'absolute' || check.violation === 'drive_letter' ? 'path_escape' : 'invalid_path' });
      continue;
    }
    if (type === 0o120000) {
      rejected.push({ path: display, reason: 'symlink' });
      continue;
    }
    if (isDir) {
      if (usize !== 0) malformed(`directory entry ${display} has data`);
      continue;
    }
    if (type !== 0 && type !== 0o100000) {
      rejected.push({ path: display, reason: 'special_file' });
      continue;
    }
    if (seen.has(check.path)) {
      rejected.push({ path: display, reason: 'duplicate' });
      continue;
    }
    const fold = caseFoldKey(check.path);
    if (folded.has(fold)) {
      rejected.push({ path: display, reason: 'case_collision' });
      continue;
    }
    if (method === 0 && csize !== usize) malformed(`stored entry ${display} sizes differ`);
    if (usize / Math.max(csize, 1) > limits.maxCompressionRatio) {
      rejected.push({ path: display, reason: 'ratio_exceeded' });
      continue;
    }
    seen.add(check.path);
    folded.add(fold);
    declaredTotal += usize;
    if (declaredTotal > limits.maxTotalBytes) throw new ZipError('too_large', `archive expands beyond ${limits.maxTotalBytes} bytes`);
    accepted.push({ path: check.path, method, crc, csize, usize, start });
  }
  if (p !== cdOffset + cdSize) malformed('central directory size mismatch');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1]) malformed('overlapping entries');
  if (declaredTotal / Math.max(buf.length, 1) > limits.maxCompressionRatio) {
    throw new ZipError('ratio_exceeded', `archive expands ${Math.round(declaredTotal / buf.length)}x (limit ${limits.maxCompressionRatio}x)`);
  }

  const entries: ZipEntry[] = [];
  for (const e of accepted) {
    const raw = buf.subarray(e.start, e.start + e.csize);
    let data: Buffer;
    if (e.method === 0) data = Buffer.from(raw);
    else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(e.usize, 1) });
      } catch {
        throw new ZipError('malformed', `entry ${e.path} does not inflate to its declared size`);
      }
    }
    if (data.length !== e.usize) throw new ZipError('malformed', `entry ${e.path} size mismatch`);
    if (crc32(data) >>> 0 !== e.crc >>> 0) throw new ZipError('malformed', `entry ${e.path} CRC mismatch`);
    entries.push({ path: e.path, data: new Uint8Array(data) });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, rejected, totalBytes: declaredTotal };
}
