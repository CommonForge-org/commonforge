/**
 * The "agency handover" archive of DEMO-SCRIPT 0:00, as a stored (uncompressed) ZIP built in
 * memory: code in three top-level folders, two exported repositories with their `.git` history,
 * `node_modules`, build output, a fake `.env` and `.npmrc`, a logo and a launch film that is too large for Git.
 *
 * Fixture mode lists a ZIP from its central directory only, so an entry may **claim** a size it
 * does not carry (`{ claim }`): the 50 MB film costs a few bytes here. The real Worker's runner
 * reads the bytes, so use claimed sizes only against fixture mode or the local stack's fake runner.
 */
import { crc32 } from "node:zlib";

export type ZipEntry = string | { body?: string; claim: number };

export function storedZip(files: Record<string, ZipEntry>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, entry] of Object.entries(files)) {
    const name = Buffer.from(path, "utf8");
    const data = Buffer.from(typeof entry === "string" ? entry : (entry.body ?? ""), "utf8");
    const size = typeof entry === "string" ? data.length : entry.claim;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

/**
 * A nested `.git` folder with `n` files (the usual layout: HEAD, config, refs, logs, hooks, loose
 * objects), so the inventory has a repository's worth of metadata to collapse (UX-6).
 */
export function gitDir(folder: string, n: number): Record<string, ZipEntry> {
  const fixed = ["HEAD", "config", "description", "index", "packed-refs", "COMMIT_EDITMSG", "info/exclude", "logs/HEAD", "logs/refs/heads/main", "refs/heads/main", "refs/remotes/origin/HEAD", "hooks/pre-commit.sample", "hooks/commit-msg.sample", "hooks/pre-push.sample"];
  const names = fixed.slice(0, n);
  for (let i = 0; names.length < n; i++) names.push(`objects/${(0x1a + i * 7).toString(16).padStart(2, "0")}/${(0xc0ffee + i * 4099).toString(16).padStart(38, "0")}`);
  return Object.fromEntries(names.map((f) => [`${folder}/.git/${f}`, f === "HEAD" ? "ref: refs/heads/main\n" : f === "config" ? "[core]\n\tbare = false\n" : `${f}\n`]));
}

export const HANDOVER_FILES: Record<string, ZipEntry> = {
  "website/index.html": "<main><h1>Get a quote</h1></main>\n",
  "website/package.json": '{ "name": "portal-website", "private": true }\n',
  "website/src/quote.ts": "export const total = (cents: number) => `$${(cents / 100).toFixed(2)}`;\n",
  "website/node_modules/vite/package.json": '{ "name": "vite" }\n',
  "website/node_modules/vite/dist/index.js": "export {};\n",
  "website/node_modules/react/index.js": "module.exports = {};\n",
  "website/dist/index.html": "<main></main>\n",
  "website/.env": "PAYMENT_KEY=sk_live_not_a_real_key\n",
  "website/.npmrc": "//registry.npmjs.org/:_authToken=npm_not_a_real_token\n",
  "api/package.json": '{ "name": "portal-api", "private": true }\n',
  "api/src/index.ts": "export default { fetch: () => Response.json({ total: 1500 }) };\n",
  "api/wrangler.jsonc": '{ "name": "portal-api", "main": "src/index.ts" }\n',
  // two exported repositories with their history, as in the live rehearsal's handoff folder
  ...gitDir("api", 26),
  ...gitDir("requirements", 12),
  "requirements/README.md": "# Customer Portal requirements\n",
  "requirements/contracts/quote.json": '{ "required": ["total"] }\n',
  "media/logo.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>\n',
  "media/launch-film.mp4": { claim: 52_428_800 },
};

export function handoverZip(): Buffer {
  return storedZip(HANDOVER_FILES);
}

/** What the local stack's fake runner should report for the same archive (sizes as claimed). */
export function handoverInventory() {
  const entries = Object.entries(HANDOVER_FILES).map(([path, e], i) => ({ path, size: typeof e === "string" ? Buffer.byteLength(e) : e.claim, sha256: (i + 1).toString(16).padStart(64, "0") }));
  return { entries, rejected: [] as Array<{ path: string; reason: string }> };
}
