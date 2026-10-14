#!/usr/bin/env node
// Deterministic 64x64 RGBA PNG logo for the Demo Client fixture. No dependencies:
// raw scanlines are deflated with node:zlib and framed with a hand-rolled CRC-32.
//
//   node scripts/make-logo.mjs [out.png] [--color=#0f766e]
//
// The demo's brand agent replaces the logo by re-running this with another
// colour (for example --color=#7c3aed) or by committing any other PNG.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--")) ?? fileURLToPath(new URL("../logo.png", import.meta.url));
const colorArg = args.find((a) => a.startsWith("--color="))?.slice(8) ?? "#0f766e";
const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colorArg);
if (!m) throw new Error(`bad --color ${colorArg}`);
const brand = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];

const SIZE = 64;
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Pixel: teal disc, white "D" glyph (vertical bar + half ring), transparent outside.
function pixel(x, y) {
  const cx = x + 0.5 - SIZE / 2;
  const cy = y + 0.5 - SIZE / 2;
  if (Math.hypot(cx, cy) > SIZE / 2 - 1) return [0, 0, 0, 0];
  const bar = cx >= -14 && cx <= -8 && cy >= -16 && cy <= 16;
  const r = Math.hypot(cx + 8, cy);
  const bowl = cx >= -8 && r <= 17 && r >= 11;
  return bar || bowl ? [255, 255, 255, 255] : [...brand, 255];
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0; // filter: none
  for (let x = 0; x < SIZE; x++) raw.set(pixel(x, y), row + 1 + x * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${colorArg})`);
