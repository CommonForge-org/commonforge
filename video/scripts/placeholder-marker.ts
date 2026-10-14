/**
 * The intrinsic PLACEHOLDER marker `pnpm placeholders` burns into what it generates, so a
 * placeholder is recognised even without `.placeholder-manifest.json` (deleted, another machine):
 *   - WebM/MP4/MOV clips: container metadata `title=PLACEHOLDER` (ffmpeg `-metadata`)
 *   - PNG screenshots: a tEXt chunk `Comment=PLACEHOLDER`
 *   - casts: a header title starting with PLACEHOLDER
 *   - hashes.json: any hash starting with PLACEHOLDER
 * Narration placeholders are digital silence (build-narration-json.ts `isSilent`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { isPlaceholderCast } from './placeholder-manifest';

export const MARKER = 'PLACEHOLDER';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

/** tEXt chunks of a PNG as keyword → text. */
export function pngTextChunks(png: Buffer): Map<string, string> {
  const texts = new Map<string, string>();
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return texts;
  let at = 8;
  while (at + 12 <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'tEXt') {
      const data = png.subarray(at + 8, at + 8 + length);
      const nul = data.indexOf(0);
      if (nul > 0) texts.set(data.toString('latin1', 0, nul), data.toString('latin1', nul + 1));
    }
    if (type === 'IEND') break;
    at += 12 + length;
  }
  return texts;
}

/** Adds `Comment=PLACEHOLDER` as a tEXt chunk right after IHDR. */
export function markPng(file: string): void {
  const png = readFileSync(file);
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${file} is not a PNG`);
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8);
  writeFileSync(file, Buffer.concat([png.subarray(0, ihdrEnd), chunk('tEXt', Buffer.from(`Comment\0${MARKER}`, 'latin1')), png.subarray(ihdrEnd)]));
}

/** Container `title` tag of a video, or null when ffprobe cannot read the file. */
export function videoTitle(file: string, ffprobe = process.env.FFPROBE ?? 'ffprobe'): string | null {
  const result = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format_tags=title', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/** True when the file carries the marker `pnpm placeholders` burns in. */
export function hasPlaceholderMarker(file: string, ffprobe?: string): boolean {
  const lower = file.toLowerCase();
  if (lower.endsWith('.png')) return pngTextChunks(readFileSync(file)).get('Comment') === MARKER;
  if (/\.(webm|mp4|mov)$/.test(lower)) return videoTitle(file, ffprobe) === MARKER;
  if (lower.endsWith('.cast')) return isPlaceholderCast(readFileSync(file, 'utf8'));
  if (lower.endsWith('hashes.json')) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { hash?: unknown } | undefined>;
      return Object.values(raw).some((entry) => String(entry?.hash ?? '').startsWith(MARKER));
    } catch {
      return false;
    }
  }
  return false;
}
