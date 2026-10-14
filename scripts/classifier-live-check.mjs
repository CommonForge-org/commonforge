#!/usr/bin/env node
/**
 * Live check of the staging risk classifier with the three demo changes (run with tsx, which the runner package has).
 *
 *   apps/runner/node_modules/.bin/tsx scripts/classifier-live-check.mjs [--dry-run]
 *   (or: pnpm --filter @commonforge-org/runner exec tsx ../../scripts/classifier-live-check.mjs)
 *
 * It builds the classifier's input for each demo task with core's `riskState`
 * (fixtures/demo-tasks/*), asks every configured provider through the Worker's own adapters
 * (apps/worker/src/services/classifier.ts, imported as TypeScript through tsx, which Node alone cannot load (it uses parameter properties), so the request mapping, parsing
 * and `riskClears` decision are exactly the Worker's) and prints, per input and provider: model,
 * each question's choice and safe probability, the decision at the threshold and the latency.
 *
 * Expected at 0.9 (live check 2026-10-11, jev-1.13.0, stable over 3 runs): copy clears; phone field
 * is declined (risk medium and apiChange breaking, about 0.40 safe) and goes to a developer, as the
 * demo shows (owner decision 2026-10-11); rename is vetoed in the gate before the classifier.
 * (That check fed the phone patch's test hunks into api/src/app.ts; since phase 4-1 api/tests/api.test.ts
 * is its own `classify` path (P4-1) and the rename patch applies on top of the phone patch (P4-2).)
 *
 * Providers: Jev through TypeSafe (JEV_API_KEY, required) and OpenAI Decisions (only when
 * OPENAI_API_KEY is set). Keys come from the environment, else from a dev-vars file: DEV_VARS, else
 * apps/worker/.dev.vars of this checkout. From a worktree without its own .dev.vars, set
 * DEV_VARS=<path to the main checkout's apps/worker/.dev.vars>. Keys are never printed.
 *
 * Variables: THRESHOLD (default 0.9), COMMONFORGE_OPENAI_DECISIONS_MODEL.
 * --dry-run: no network and no key needed. Prints each input's state and the request bodies the
 * adapters would send (the key only travels in a header, which is not printed).
 *
 * This calls paid APIs (fractions of a cent per run): run it with the owner's go-ahead. Exits
 * non-zero without JEV_API_KEY (unless --dry-run) or when a provider call fails.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const threshold = Number(process.env.THRESHOLD ?? "0.9");
if (!(threshold > 0 && threshold <= 1)) fail(`THRESHOLD must be in (0, 1], got ${process.env.THRESHOLD}`);

function fail(msg) {
  console.error(`classifier-live-check: ${msg}`);
  process.exit(1);
}

// ---- keys -----------------------------------------------------------------------------------
function parseVars(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const candidates = [process.env.DEV_VARS, join(root, "apps/worker/.dev.vars")].filter(Boolean);
const varsFile = candidates.find((p) => existsSync(p));
const fileVars = varsFile ? parseVars(readFileSync(varsFile, "utf8")) : {};
const jevKey = process.env.JEV_API_KEY || fileVars.JEV_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY || fileVars.OPENAI_API_KEY;
if (!dryRun && !jevKey) fail(`JEV_API_KEY is not set (looked in the environment and in ${varsFile ?? candidates.join(", ")}). Add it to apps/worker/.dev.vars, set DEV_VARS=<path to the main checkout's apps/worker/.dev.vars>, or export it.`);

// ---- the Worker's adapters and core ---------------------------------------------------------
let core, adapters;
try {
  core = await import(pathToFileURL(join(root, "packages/core/dist/index.js")).href);
  adapters = await import(pathToFileURL(join(root, "apps/worker/src/services/classifier.ts")).href);
} catch (e) {
  fail(`cannot load core/dist or the Worker adapters (${e instanceof Error ? e.message : e}). Run \`pnpm --filter @commonforge-org/core build\`, then run this script with tsx: \`apps/runner/node_modules/.bin/tsx scripts/classifier-live-check.mjs\`.`);
}
const { riskState } = core;
const { jevClassifier, openAiDecisionsClassifier, runClassifier, OPENAI_DECISIONS_MODEL } = adapters;

// ---- demo inputs ----------------------------------------------------------------------------
const fx = (...p) => readFileSync(join(root, "fixtures/demo-tasks", ...p), "utf8");
/**
 * The before and after text of each file of a unified diff (its hunks' context and +/- lines, keyed
 * by the `b/` path): the hunks only, not the whole file, which is what the classifier sees.
 */
function sidesOfPatch(patch) {
  const files = {};
  let cur = null;
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git ")) cur = null;
    else if (l.startsWith("+++ ")) cur = files[l.slice(4).replace(/^b\//, "")] = { before: [], after: [] };
    else if (!cur || l.startsWith("--- ") || l.startsWith("@@") || l === "") continue;
    else if (l.startsWith("-")) cur.before.push(l.slice(1));
    else if (l.startsWith("+")) cur.after.push(l.slice(1));
    else {
      cur.before.push(l.slice(1));
      cur.after.push(l.slice(1));
    }
  }
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { before: v.before.join("\n") + "\n", after: v.after.join("\n") + "\n" }]));
}
const checks = [{ checkId: "test", result: "passed" }];
// phone-field edits src/app.ts and tests/api.test.ts (both `classify` paths, P4-1); rename-column
// applies on top of it and edits src/app.ts only
const phone = sidesOfPatch(fx("phone-field", "api-code.patch"));
const rename = sidesOfPatch(fx("rename-column", "api-code.patch"))["src/app.ts"];
const demos = [
  {
    name: "copy (expected: clears)",
    parts: {
      tasks: [{ title: "Friendlier hero text", request: "Make the hero text mention clogs and burst pipes, and change the button to say Get a free quote." }],
      paths: [{ path: "website/index.html", level: "self" }],
      files: [{ path: "website/index.html", before: fx("copy-change", "before.html"), after: fx("copy-change", "after.html"), kind: "text", migration: false }],
      checks,
    },
  },
  {
    name: "phone field (expected: goes to a developer; Jev answers risk medium, apiChange breaking)",
    parts: {
      tasks: [{ title: "Add a phone field", request: "Add a phone number to the contacts, saved and listed." }],
      paths: [
        { path: "api/src/app.ts", level: "classify" },
        { path: "api/tests/api.test.ts", level: "classify" },
        { path: "api/migrations/0002_phone.sql", level: "classify" },
      ],
      files: [
        { path: "api/src/app.ts", before: phone["src/app.ts"].before, after: phone["src/app.ts"].after, kind: "text", migration: false },
        { path: "api/tests/api.test.ts", before: phone["tests/api.test.ts"].before, after: phone["tests/api.test.ts"].after, kind: "text", migration: false },
        { path: "api/migrations/0002_phone.sql", before: null, after: fx("phone-field", "migrations", "0002_phone.sql"), kind: "text", migration: true },
      ],
      checks,
    },
  },
  {
    name: "rename column (expected: vetoed in the gate, never asked; asked here only to show the answers)",
    parts: {
      tasks: [{ title: "Rename email to email_address", request: "Rename the contacts email column to email_address." }],
      paths: [
        { path: "api/src/app.ts", level: "classify" },
        { path: "api/migrations/0003_rename_email.sql", level: "classify" },
      ],
      files: [
        { path: "api/src/app.ts", before: rename.before, after: rename.after, kind: "text", migration: false },
        { path: "api/migrations/0003_rename_email.sql", before: null, after: fx("rename-column", "migrations", "0003_rename_email.sql"), kind: "text", migration: true },
      ],
      checks,
    },
  },
];

// ---- run ------------------------------------------------------------------------------------
/** In a dry run the fetch records the request and fails, so nothing leaves the machine. */
const captured = [];
const dryFetch = async (url, init) => {
  captured.push({ url, body: JSON.parse(init.body) });
  throw new Error("dry run");
};
const realFetch = (url, init) => fetch(url, init);
const f = dryRun ? dryFetch : realFetch;
const providers = [jevClassifier({ apiKey: jevKey ?? "dry-run", fetch: f })];
if (openaiKey || dryRun) providers.push(openAiDecisionsClassifier({ apiKey: openaiKey ?? "dry-run", model: process.env.COMMONFORGE_OPENAI_DECISIONS_MODEL || OPENAI_DECISIONS_MODEL, fetch: f }));
else console.log("(OPENAI_API_KEY not set: OpenAI Decisions skipped)");
console.log(`threshold ${threshold}${dryRun ? ", DRY RUN (no network)" : ""}${varsFile ? `, dev vars: ${varsFile}` : ""}`);

let failures = 0;
for (const demo of demos) {
  const input = riskState(demo.parts);
  console.log(`\n=== ${demo.name} ===`);
  console.log(`state: ${input.bytes} bytes, truncated=${input.truncated}, omittedFiles=${input.omittedFiles}, tooLarge=${input.tooLarge}, incomplete=[${input.incomplete.join(",")}]`);
  if (dryRun) console.log(input.state.split("\n").map((l) => `  ${l}`).join("\n"));
  for (const p of providers) {
    captured.length = 0;
    const ev = await runClassifier(p, input, threshold);
    if (dryRun) {
      for (const c of captured) console.log(`--- request to ${c.url}\n${JSON.stringify(c.body, null, 2)}`);
      continue;
    }
    console.log(`-- ${ev.provider} (${ev.model}), ${ev.latencyMs ?? "?"} ms`);
    if (ev.error) {
      failures++;
      console.log(`   error: ${ev.error}${ev.incomplete ? ` (${ev.incomplete.join(",")})` : ""}`);
      continue;
    }
    for (const [id, a] of Object.entries(ev.answers)) console.log(`   ${id}: choice=${a.choice}  safe=${ev.safeProbability[id].toFixed(4)}`);
    console.log(`   decision at ${threshold}: ${ev.cleared ? "CLEARS" : `does not clear (failed: ${ev.failed})`}`);
  }
}
if (failures) fail(`${failures} provider call(s) failed`);
