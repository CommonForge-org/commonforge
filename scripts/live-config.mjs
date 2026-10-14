#!/usr/bin/env node
// Write the live deployment's wrangler configs from the committed templates and this deployment's
// settings (logic and variables: live-config-core.mjs). Used by scripts/deploy-live.sh.
//
//   node scripts/live-config.mjs              write apps/worker/wrangler.deploy-live{,-preview}.jsonc
//                                             (git-ignored); print "<app url> <preview url>" on stdout
//   node scripts/live-config.mjs --urls-only  only print the URLs (deploying the runner alone: no
//                                             sender or D1 id needed, no files written)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES, parseJsonc } from "./ci-config-core.mjs";
import { buildLive, liveSettings, renderLive } from "./live-config-core.mjs";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "worker");
const template = Object.fromEntries(Object.entries(SOURCES).map(([k, f]) => [k, parseJsonc(readFileSync(join(WORKER_DIR, f), "utf8"))]));
try {
  const urlsOnly = process.argv.slice(2).includes("--urls-only");
  const s = liveSettings(process.env, template, { urlsOnly });
  if (urlsOnly) {
    console.log(`${s.appUrl} ${s.previewUrl}`);
    process.exit(0);
  }
  const files = renderLive(buildLive(template, s));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(WORKER_DIR, f), text);
  console.error(`wrote ${Object.keys(files).map((f) => `apps/worker/${f}`).join(", ")}`);
  console.log(`${s.appUrl} ${s.previewUrl}`);
} catch (e) {
  console.error(`live-config: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
