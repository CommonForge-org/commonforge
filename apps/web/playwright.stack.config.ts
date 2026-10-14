import { defineConfig, devices } from "@playwright/test";
import { STACK_URL } from "./e2e/stack/env.js";

/**
 * Local real stack (Task 23): the control-plane Worker under `wrangler dev -c wrangler.e2e.jsonc`
 * (apps/worker/e2e/stack.ts) serving the real web bundle. Real: routes, D1, Durable Objects, R2,
 * queues, log-mode magic links, cookies, CSRF. Faked in-process: Artifacts, the integration runner
 * and the Cloudflare API (docs/LIMITATIONS.md). Needs no credentials and no network, so CI can run it.
 *
 * The tests run serially against one stack: one story, from sign-in to export.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["local-stack.spec.ts"],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report/stack" }]] : "list",
  outputDir: "test-results/stack",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  globalSetup: "./e2e/stack/global-setup.ts",
  use: { baseURL: STACK_URL, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  projects: [{ name: "local-stack", use: {} }],
});
