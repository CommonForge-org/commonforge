#!/usr/bin/env node
// Build the published CLI: one self-contained ESM file, dist/index.js (`#!/usr/bin/env node`),
// with @commonforge-org/core, @commonforge-org/runner-protocol and zod inlined, so the npm
// package has no runtime dependencies. The licences of the inlined third-party packages are
// written next to it (dist/THIRD_PARTY_LICENSES.txt). Node built-ins stay external.
//
// The workspace packages are bundled from their built dist/ (turbo builds them first: `^build`).
// The credential helper git runs is this same file (src/main.ts: `./index.js` next to it).
import { build } from "esbuild";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(app, "dist");
mkdirSync(dist, { recursive: true });

/** Replace a file atomically: tests that build concurrently (pack, AT-22) never see a partial bundle. */
function put(name, contents, mode = 0o644) {
  const tmp = join(dist, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp, contents);
  chmodSync(tmp, mode);
  renameSync(tmp, join(dist, name));
}

const result = await build({
  entryPoints: [join(app, "src", "index.ts")],
  outfile: join(dist, "index.js"),
  absWorkingDir: app,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  legalComments: "eof",
  metafile: true,
  write: false,
  logLevel: "warning",
});

put("index.js", result.outputFiles[0].contents, 0o755);

// Third-party packages that ended up in the bundle (workspace packages are this repo's MIT code).
const bundled = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = relative(app, join(app, input)).split(sep);
  const i = parts.lastIndexOf("node_modules");
  if (i < 0) continue;
  const name = parts[i + 1].startsWith("@") ? `${parts[i + 1]}/${parts[i + 2]}` : parts[i + 1];
  if (name.startsWith("@commonforge-org/")) continue;
  bundled.set(name, join(...parts.slice(0, i + 1 + name.split("/").length)));
}
const notices = [];
for (const [name, rel] of [...bundled].sort(([a], [b]) => (a < b ? -1 : 1))) {
  const dir = join(app, rel);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const file = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  if (!file) throw new Error(`${name}: no licence file to ship with the bundle`);
  notices.push(`${name}@${pkg.version} (${pkg.license})\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`);
}
put(
  "THIRD_PARTY_LICENSES.txt",
  `cforge bundles the following third-party packages.\n\n${notices.join(`\n${"-".repeat(72)}\n\n`)}`,
);
console.log(`dist/index.js (${bundled.size ? [...bundled.keys()].join(", ") : "no third-party packages"} inlined)`);
