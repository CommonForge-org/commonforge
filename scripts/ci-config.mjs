#!/usr/bin/env node
// Derive the CI deployment's wrangler configs from the production templates (logic: ci-config-core.mjs).
//
//   node scripts/ci-config.mjs    write apps/worker/wrangler.deploy-ci{,-preview,-runner}.jsonc (git-ignored)
//
// Inputs from the environment (scripts/deploy-ci.sh loads apps/worker/.dev.vars): COMMONFORGE_LIVE_BASE,
// COMMONFORGE_CI_D1_DATABASE_ID, COMMONFORGE_EMAIL_FROM and COMMONFORGE_D1_DATABASE_ID (production's,
// required: CI's id must differ, and the generated configs are checked against it). See ciSettings.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES, buildFromSources, ciNames, ciSettings, parseJsonc, render } from "./ci-config-core.mjs";

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "worker");
try {
  const s = ciSettings(process.env);
  const prod = Object.fromEntries(Object.entries(SOURCES).map(([k, f]) => [k, parseJsonc(readFileSync(join(WORKER_DIR, f), "utf8"))]));
  // the real production id replaces the template's placeholder, so the leak check refuses it
  prod.worker.d1_databases[0].database_id = s.prodD1Id;
  // CI harness owners sign in as ci-owner-<run>@commonforge.invalid (scripts/ci-live/)
  const files = render(buildFromSources(prod, s.base, ciNames(s.base, s.d1Id), { adminEmails: "@commonforge.invalid", emailFrom: s.emailFrom }));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(WORKER_DIR, f), text);
  console.error(`wrote ${Object.keys(files).map((f) => `apps/worker/${f}`).join(", ")}`);
} catch (e) {
  console.error(`ci-config: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
