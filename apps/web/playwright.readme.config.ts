import { defineConfig, devices } from "@playwright/test";
import { STACK_URL } from "./e2e/stack/env.js";

/**
 * The README's screenshots (e2e/readme-screenshots.spec.ts → docs/images/), from the local real
 * stack started by the same global setup as `playwright.stack.config.ts`. Not part of
 * `pnpm test:e2e`; run `pnpm run screenshots` (apps/web) to regenerate them.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["readme-screenshots.spec.ts"],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  outputDir: "test-results/readme",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  globalSetup: "./e2e/stack/global-setup.ts",
  use: { baseURL: STACK_URL, trace: "retain-on-failure", ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  projects: [{ name: "readme", use: {} }],
});
