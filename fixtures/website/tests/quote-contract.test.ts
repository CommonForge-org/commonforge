/**
 * Cross-resource contract test (plan §C.1 row 7).
 *
 * Validates a real GET /quote response from the api against the contract in
 * requirements/contracts/quote.schema.json. The three Resources are separate
 * repositories; the integration runner materializes them as sibling mounts
 * (website/, api/, requirements/), which is the layout these defaults assume.
 *
 *   QUOTE_API_URL      fetch /quote from a running api (preview) instead of
 *                      calling the api source in-process
 *   QUOTE_API_DIR      path to the api mount (default ../api)
 *   QUOTE_SCHEMA_PATH  path to the contract (default ../requirements/contracts/quote.schema.json)
 *
 * A producer change that adds a response field without updating the contract
 * fails here even when every repository merges cleanly.
 *
 * In a client edition (website only: no api source, no requirements) the suite
 * skips with a note. It runs in trusted integration, where all mounts exist.
 * Edition policy write-protects this file (see fixtures/README.md).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { validate, type JsonSchema } from "../src/json-schema.js";

const websiteRoot = resolve(import.meta.dirname, "..");
const schemaPath = resolve(
  websiteRoot,
  process.env.QUOTE_SCHEMA_PATH ?? "../requirements/contracts/quote.schema.json",
);
const apiDir = resolve(websiteRoot, process.env.QUOTE_API_DIR ?? "../api");
const liveApiUrl = process.env.QUOTE_API_URL;
const apiEntry = resolve(apiDir, "src/app.ts");

const missing = [
  ...(existsSync(schemaPath) ? [] : [`contract ${schemaPath}`]),
  ...(liveApiUrl || existsSync(apiEntry) ? [] : [`api source ${apiEntry} (or set QUOTE_API_URL)`]),
];
const skipNote =
  `[quote-contract] SKIPPED: ${missing.join("; ")} not present. ` +
  "This contract test runs in trusted integration only (all Resources mounted).";
if (missing.length > 0) process.stderr.write(`${skipNote}\n`);

const QUERIES = [
  "plan=starter&seats=1&customer=Solo",
  "plan=team&seats=12&customer=Acme&date=2026-10-01",
  "plan=enterprise&seats=300&customer=Big%20Co&date=2026-10-01",
];

type FetchLike = (path: string) => Promise<Response>;

async function quoteSource(): Promise<FetchLike> {
  if (liveApiUrl) {
    const base = liveApiUrl.replace(/\/$/, "");
    return (path) => fetch(`${base}${path}`);
  }
  const mod = (await import(pathToFileURL(apiEntry).href)) as {
    createApp: () => { request: (path: string) => Response | Promise<Response> };
  };
  const app = mod.createApp();
  return async (path) => app.request(path);
}

describe("GET /quote honours requirements/contracts/quote.schema.json", () => {
  if (missing.length > 0) {
    // Named skip so the reason shows in reporters, not only on stderr.
    it.skip(skipNote, () => {});
    return;
  }
  it.each(QUERIES)("response for ?%s matches the contract", async (query) => {
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonSchema;
    const request = await quoteSource();
    const res = await request(`/quote?${query}`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(validate(schema, body)).toEqual([]);
  });
});
