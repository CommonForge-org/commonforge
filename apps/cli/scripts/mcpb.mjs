#!/usr/bin/env node
// Build the Claude Desktop extension, dist/commonforge.mcpb: a zip of manifest.json (from
// mcpb/manifest.json, with the CLI's version and tool list), server/index.js (the bundled CLI,
// run as `index.js mcp`), its licence files and the icon. Run `node scripts/bundle.mjs` first.
//
//   node scripts/mcpb.mjs [outFile]
//
// The zip is written here (deflate, no dependency), so the build needs no network. Timestamps are
// fixed; the bytes are the same for the same Node version (its zlib does the compressing).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(app, "..", "..");
const out = process.argv[2] ?? join(app, "dist", "commonforge.mcpb");

const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(app, "mcpb", "manifest.json"), "utf8"));
manifest.version = pkg.version;
// the tool list Claude Desktop shows before install, from the built server itself
manifest.tools = toolsFromServer().map((t) => ({ name: t.name, description: t.description }));

/** Ask the built server for its tools (tools/list over stdio). */
function toolsFromServer() {
  const lines = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpb-build", version: "1" } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  ].join("\n");
  const r = spawnSync(process.execPath, [join(app, "dist", "index.js"), "mcp"], { input: `${lines}\n`, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 30_000 });
  const reply = r.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
  if (!reply?.result?.tools) throw new Error(`cforge mcp did not list its tools: ${r.stderr}`);
  return reply.result.tools;
}

const files = [
  ["manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  ["server/index.js", readFileSync(join(app, "dist", "index.js"))],
  ["server/THIRD_PARTY_LICENSES.txt", readFileSync(join(app, "dist", "THIRD_PARTY_LICENSES.txt"))],
  ["LICENSE", readFileSync(join(app, "LICENSE"))],
  ["icon.png", readFileSync(join(repo, "brand", "commonforge-icon-512.png"))],
];

writeFileSync(out, zip(files));
console.log(`${out} (${manifest.name} ${manifest.version}, ${manifest.tools.length} tools)`);

/** A minimal zip (PKZIP 2.0, deflate), with fixed timestamps so the build is reproducible. */
function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
