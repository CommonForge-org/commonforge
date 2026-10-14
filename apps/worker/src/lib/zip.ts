/**
 * Worker-side ZIP handling for client editions (no dependency; WebCrypto/Streams only).
 *
 * - {@link writeZip}: a stored (uncompressed) archive, used for the edition download. Entries are
 *   plain files at the archive root, UTF-8 names, fixed timestamps (deterministic bytes).
 * - {@link readReturnZip}: the defensive reader for a client's returned ZIP (plan §F "Path/symlink
 *   attacks", AT-28). It mirrors the runner's reader (`apps/runner/src/zip.ts`): traversal and
 *   absolute paths, symlinks, special files, duplicates, case collisions and entries whose ratio
 *   exceeds the limit are rejected per entry; ZIP64, encryption, unknown methods, overlapping or
 *   inconsistent entries, lying sizes or CRCs, too many files, too many bytes or an overall ratio
 *   above the limit refuse the whole archive. Inflation is bounded by each entry's declared size.
 *   The Worker refuses a return with any rejected entry before anything is staged, then stores a
 *   normalized re-pack (stored entries only) for the runner, which checks it again.
 * - A ZIP made by "compress this folder" wraps every entry in one top-level folder. It is stripped
 *   only when that folder is the download's own root name (review M-4: a genuinely new top-level
 *   folder is never flattened). OS metadata (`__MACOSX/`, `.DS_Store`, `Thumbs.db`) is ignored.
 */
import { caseFoldKey, checkPath } from "@commonforge-org/core";

export type ZipRejectReason = "path_escape" | "invalid_path" | "symlink" | "special_file" | "duplicate" | "case_collision" | "ratio_exceeded";

export class ZipRefused extends Error {
  constructor(
    readonly reason: "malformed" | "too_many_files" | "too_large" | "ratio_exceeded" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "ZipRefused";
  }
}

export interface ZipLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
}

/**
 * Same limits as the runner's `EDITION_RETURN_LIMITS`, with a much smaller byte budget: the raw
 * upload (≤ 32 MiB) plus inflated entries (≤ 24 MiB) plus, only when a wrapper folder or OS junk
 * must be removed, one re-pack stay well inside the 128 MB isolate (review M-1).
 */
export const RETURN_ZIP_LIMITS: ZipLimits = { maxFiles: 10_000, maxTotalBytes: 24 * 1024 * 1024, maxCompressionRatio: 100 };

export interface ReturnZip {
  entries: Array<{ path: string; data: Uint8Array }>;
  rejected: Array<{ path: string; reason: ZipRejectReason }>;
  ignored: string[];
  /** the single wrapping folder that was stripped, if any */
  strippedFolder: string | null;
}

// ------------------------------------------------------------------------------------- CRC-32

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------------------------- writer

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
/** 1980-01-01 00:00 in DOS format (deterministic archives) */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** A stored (method 0) ZIP of regular files. Paths must already be normalized relative paths. */
export function writeZip(files: Array<{ path: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder();
  if (files.length > 0xfffe) throw new ZipRefused("too_many_files", "too many files for a ZIP without ZIP64");
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LFH_SIG, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, CDH_SIG, true);
    cv.setUint16(4, (3 << 8) | 20, true); // made by: Unix
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, f.data);
    central.push(cd);
    offset += local.length + f.data.length;
    if (offset > 0xfffffff0) throw new ZipRefused("too_large", "archive too large for a ZIP without ZIP64");
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...parts, ...central, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

// ------------------------------------------------------------------------------------- reader

const S_IFMT = 0o170000;
const IGNORED_RE = /(^|\/)(__MACOSX(\/|$)|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

function decodeName(raw: Uint8Array, utf8Flag: boolean): string | null {
  if (!utf8Flag && raw.some((b) => b > 0x7f)) return null; // CP437 names are refused, not guessed
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw);
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function inflateBounded(data: Uint8Array, max: number): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const out = new Uint8Array(max);
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.length > max) throw new ZipRefused("malformed", "an entry inflates beyond its declared size");
      out.set(value, n);
      n += value.length;
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    if (e instanceof ZipRefused) throw e;
    throw new ZipRefused("malformed", "an entry does not inflate");
  }
  return out.subarray(0, n);
}

/**
 * Read a returned edition ZIP. `wrapperName` is the folder name the download unpacks to (the ZIP
 * file's base name); a single top-level folder of exactly that name is stripped. Stored entries
 * are views into `bytes` (no copy).
 */
export async function readReturnZip(bytes: Uint8Array, limits: ZipLimits, wrapperName: string | null): Promise<ReturnZip> {
  if (bytes.length < 22) throw new ZipRefused("malformed", "not a ZIP archive");
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === EOCD_SIG && i + 22 + v.getUint16(i + 20, true) === bytes.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipRefused("malformed", "not a ZIP archive (no end of central directory)");
  const disk = v.getUint16(eocd + 4, true);
  const cdDisk = v.getUint16(eocd + 6, true);
  const countDisk = v.getUint16(eocd + 8, true);
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipRefused("unsupported", "ZIP64 archives are not supported");
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) throw new ZipRefused("unsupported", "multi-disk archives are not supported");
  if (cdOffset + cdSize > eocd) throw new ZipRefused("malformed", "central directory out of range");
  if (count > limits.maxFiles) throw new ZipRefused("too_many_files", `archive has ${count} entries (limit ${limits.maxFiles})`);

  interface Raw {
    path: string;
    method: number;
    crc: number;
    csize: number;
    usize: number;
    start: number;
  }
  const accepted: Raw[] = [];
  const rejected: ReturnZip["rejected"] = [];
  const ignored: string[] = [];
  const ranges: Array<[number, number]> = [];
  let declaredTotal = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cdOffset + cdSize || v.getUint32(p, true) !== CDH_SIG) throw new ZipRefused("malformed", `bad central directory entry ${n}`);
    const madeBy = v.getUint16(p + 4, true);
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const external = v.getUint32(p + 38, true);
    const lho = v.getUint32(p + 42, true);
    const rawName = bytes.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (p > cdOffset + cdSize) throw new ZipRefused("malformed", "central directory overrun");
    if (csize === 0xffffffff || usize === 0xffffffff || lho === 0xffffffff) throw new ZipRefused("unsupported", "ZIP64 entries are not supported");
    if (flags & 0x1) throw new ZipRefused("unsupported", "encrypted entries are not supported");
    if (method !== 0 && method !== 8) throw new ZipRefused("unsupported", `compression method ${method} is not supported`);
    if (lho + 30 > cdOffset || v.getUint32(lho, true) !== LFH_SIG) throw new ZipRefused("malformed", `bad local header for entry ${n}`);
    const lNameLen = v.getUint16(lho + 26, true);
    const lExtraLen = v.getUint16(lho + 28, true);
    const start = lho + 30 + lNameLen + lExtraLen;
    if (!sameBytes(bytes.subarray(lho + 30, lho + 30 + lNameLen), rawName)) throw new ZipRefused("malformed", `local and central names differ for entry ${n}`);
    if (v.getUint16(lho + 8, true) !== method) throw new ZipRefused("malformed", `local and central methods differ for entry ${n}`);
    if (start + csize > cdOffset) throw new ZipRefused("malformed", `entry ${n} data out of range`);
    ranges.push([lho, start + csize]);

    const display = decodeName(rawName, (flags & 0x800) !== 0);
    if (display === null) {
      rejected.push({ path: new TextDecoder("latin1").decode(rawName), reason: "invalid_path" });
      continue;
    }
    const isUnix = madeBy >> 8 === 3;
    const mode = isUnix ? (external >>> 16) & 0xffff : 0;
    const type = mode & S_IFMT;
    const isDir = display.endsWith("/") || type === 0o040000 || (!isUnix && (external & 0x10) !== 0);
    const check = checkPath(display.replace(/\/+$/, ""));
    if (!check.ok) {
      rejected.push({ path: display, reason: check.violation === "dot_dot" || check.violation === "absolute" || check.violation === "drive_letter" ? "path_escape" : "invalid_path" });
      continue;
    }
    if (type === 0o120000) {
      rejected.push({ path: display, reason: "symlink" });
      continue;
    }
    if (isDir) {
      if (usize !== 0) throw new ZipRefused("malformed", `directory entry ${display} has data`);
      continue;
    }
    if (type !== 0 && type !== 0o100000) {
      rejected.push({ path: display, reason: "special_file" });
      continue;
    }
    if (IGNORED_RE.test(check.path)) {
      ignored.push(check.path);
      continue;
    }
    if (method === 0 && csize !== usize) throw new ZipRefused("malformed", `stored entry ${display} sizes differ`);
    if (usize / Math.max(csize, 1) > limits.maxCompressionRatio) {
      rejected.push({ path: display, reason: "ratio_exceeded" });
      continue;
    }
    declaredTotal += usize;
    if (declaredTotal > limits.maxTotalBytes) throw new ZipRefused("too_large", `archive expands beyond ${limits.maxTotalBytes} bytes`);
    accepted.push({ path: check.path, method, crc, csize, usize, start });
  }
  if (p !== cdOffset + cdSize) throw new ZipRefused("malformed", "central directory size mismatch");
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]![0] < ranges[i - 1]![1]) throw new ZipRefused("malformed", "overlapping entries");
  if (declaredTotal / Math.max(bytes.length, 1) > limits.maxCompressionRatio) {
    throw new ZipRefused("ratio_exceeded", `archive expands ${Math.round(declaredTotal / bytes.length)}x (limit ${limits.maxCompressionRatio}x)`);
  }

  // a single wrapping folder ("compress this folder") is stripped only when it is the download root
  let strippedFolder: string | null = null;
  const tops = new Set(accepted.map((a) => a.path.split("/")[0]!));
  if (accepted.length > 0 && tops.size === 1 && accepted.every((a) => a.path.includes("/"))) {
    const top = [...tops][0]!;
    if (wrapperName !== null && top === wrapperName) strippedFolder = top;
  }

  const entries: ReturnZip["entries"] = [];
  const seen = new Set<string>();
  const folded = new Set<string>();
  for (const a of accepted) {
    const path = strippedFolder ? a.path.slice(strippedFolder.length + 1) : a.path;
    if (seen.has(path)) {
      rejected.push({ path, reason: "duplicate" });
      continue;
    }
    const fold = caseFoldKey(path);
    if (folded.has(fold)) {
      rejected.push({ path, reason: "case_collision" });
      continue;
    }
    seen.add(path);
    folded.add(fold);
    const raw = bytes.subarray(a.start, a.start + a.csize);
    const data = a.method === 0 ? raw : await inflateBounded(raw, a.usize);
    if (data.length !== a.usize) throw new ZipRefused("malformed", `entry ${path} size does not match its header`);
    if (crc32(data) !== a.crc) throw new ZipRefused("malformed", `entry ${path} fails its CRC check`);
    entries.push({ path, data });
  }
  entries.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { entries, rejected, ignored, strippedFolder };
}
