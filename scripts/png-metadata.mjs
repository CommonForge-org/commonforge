#!/usr/bin/env node
// List or strip the metadata chunks of PNG files, losslessly (no dependencies).
//
//   node scripts/png-metadata.mjs <file.png>...            print each file's chunks and its metadata text
//   node scripts/png-metadata.mjs --check <file.png>...    exit 1 if any file carries metadata chunks
//   node scripts/png-metadata.mjs --strip <file.png>...    remove them in place
//
// Metadata chunks: tEXt, zTXt, iTXt (text, including XMP with author names), eXIf (Exif) and tIME.
// Stripping copies every other chunk byte for byte (image data, palette, colour profile...), so the
// pixels cannot change; each chunk's CRC is checked on read and the result is re-read and checked.
// scripts/export-public.sh runs --check on every PNG it would publish.
import { readFileSync, writeFileSync } from "node:fs";
import { crc32, inflateSync } from "node:zlib";

export const METADATA = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** buffer → [{ type, data, raw }] (raw: the whole chunk, length to CRC); throws on a malformed file */
export function chunks(buf, name = "PNG") {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${name}: not a PNG`);
  const out = [];
  let i = 8;
  while (i < buf.length) {
    if (i + 12 > buf.length) throw new Error(`${name}: truncated chunk at byte ${i}`);
    const len = buf.readUInt32BE(i);
    const end = i + 12 + len;
    if (end > buf.length) throw new Error(`${name}: truncated chunk at byte ${i}`);
    const type = buf.toString("latin1", i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (crc32(buf.subarray(i + 4, i + 8 + len)) !== buf.readUInt32BE(i + 8 + len)) throw new Error(`${name}: bad CRC in ${type} chunk`);
    out.push({ type, data, raw: buf.subarray(i, end) });
    i = end;
    if (type === "IEND") break;
  }
  if (out.at(-1)?.type !== "IEND") throw new Error(`${name}: no IEND chunk`);
  return out;
}

/** a text chunk's keyword and text (zTXt / compressed iTXt inflated) */
export function text({ type, data }) {
  const nul = data.indexOf(0);
  const key = data.toString("latin1", 0, nul);
  if (type === "tEXt") return `${key}: ${data.toString("latin1", nul + 1)}`;
  if (type === "zTXt") return `${key}: ${inflateSync(data.subarray(nul + 2)).toString("latin1")}`;
  if (type === "iTXt") {
    const compressed = data[nul + 1] === 1;
    let j = nul + 3;
    j = data.indexOf(0, j) + 1; // language tag
    j = data.indexOf(0, j) + 1; // translated keyword
    const body = data.subarray(j);
    return `${key}: ${(compressed ? inflateSync(body) : body).toString("utf8")}`;
  }
  if (type === "tIME") return `tIME: ${data.readUInt16BE(0)}-${data[2]}-${data[3]} ${data[4]}:${data[5]}:${data[6]}`;
  return `${type}: ${data.length} bytes`;
}

/** the file without its metadata chunks (every other byte unchanged) */
export function strip(buf, name) {
  return Buffer.concat([SIGNATURE, ...chunks(buf, name).filter((c) => !METADATA.has(c.type)).map((c) => c.raw)]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const mode = args[0] === "--check" || args[0] === "--strip" ? args.shift() : "--list";
  let found = 0;
  for (const f of args) {
    const buf = readFileSync(f);
    const all = chunks(buf, f);
    const meta = all.filter((c) => METADATA.has(c.type));
    if (mode === "--list") {
      console.log(`${f}: ${all.map((c) => c.type).join(" ")}`);
      for (const c of meta) console.log(`  ${text(c).replace(/\s+/g, " ").slice(0, 2000)}`);
    } else if (meta.length) {
      found++;
      if (mode === "--check") console.error(`PNG metadata (${[...new Set(meta.map((c) => c.type))].join(", ")}): ${f}`);
      else {
        const out = strip(buf, f);
        // re-read: still a valid PNG, no metadata, every other chunk identical and in order
        const kept = chunks(out, f);
        const want = all.filter((c) => !METADATA.has(c.type));
        if (kept.length !== want.length || kept.some((c, k) => !c.raw.equals(want[k].raw))) throw new Error(`${f}: strip changed other chunks`);
        writeFileSync(f, out);
        console.error(`stripped ${meta.map((c) => c.type).join(" ")} from ${f} (${buf.length} → ${out.length} bytes)`);
      }
    }
  }
  if (mode === "--check" && found) process.exit(1);
}
