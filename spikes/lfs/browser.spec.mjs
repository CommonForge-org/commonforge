// Q3 browser driver (throwaway). Usage: SPIKE_URL=... SPIKE_TOKEN=... node browser.spec.mjs <out.json>
// Resolves Playwright from apps/web's installed @playwright/test (no install into the repo).
// The token is only ever placed in the page URL hash; this script never logs the URL, enables no tracing,
// takes no screenshots, and forwards no page console output.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "../../apps/web/package.json"));
const { chromium } = require("@playwright/test");

const { SPIKE_URL, SPIKE_TOKEN } = process.env;
if (!SPIKE_URL || !SPIKE_TOKEN) throw new Error("SPIKE_URL / SPIKE_TOKEN required");
const out = process.argv[2];
const scrub = (s) => String(s ?? "").split(SPIKE_TOKEN).join("[redacted]").split(encodeURIComponent(SPIKE_TOKEN)).join("[redacted]");

async function runOnce(browser, { mb, abortAfter, timeoutMs }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto(`${SPIKE_URL}/#${encodeURIComponent(SPIKE_TOKEN)}`);
    await page.fill("#mb", String(mb));
    await page.fill("#abortAfter", String(abortAfter));
    const t0 = Date.now();
    await page.click("#go");
    await page.waitForFunction(() => window.result !== undefined, null, { timeout: timeoutMs, polling: 2000 });
    const result = await page.evaluate(() => window.result);
    return { wall_ms: Date.now() - t0, result };
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch({ headless: true });
const res = { chromium_version: browser.version() };
try {
  console.log("[q3-driver] full run 2048 MB");
  res.full = await runOnce(browser, { mb: 2048, abortAfter: 0, timeoutMs: 30 * 60_000 });
  console.log("[q3-driver] full run done");
  console.log("[q3-driver] abort run 200 MB, abort after 2 parts");
  res.abort = await runOnce(browser, { mb: 200, abortAfter: 2, timeoutMs: 10 * 60_000 });
  console.log("[q3-driver] abort run done");
} catch (e) {
  res.driver_error = scrub(e && e.message || e).slice(0, 500);
} finally {
  await browser.close();
  writeFileSync(out, scrub(JSON.stringify(res)));
}
