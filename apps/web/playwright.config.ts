import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suites (plan §G.4). Two modes, two configs:
 *
 * - **fixture** (this file, CI): the production UI bundle built with `VITE_COMMONFORGE_FIXTURE=1`
 *   (`dist-fixture/`), served by `vite preview`. Deterministic: every API call is answered by the
 *   in-memory demo story (`src/api/fake.ts`), always under the "Fixture mode" banner. It proves
 *   the screens of the eight-minute path, not the backend.
 * - **local stack** (`playwright.stack.config.ts`): the real Worker under `wrangler dev` serving the
 *   real (non-fixture) bundle, with in-process fakes only for Artifacts, the runner and the
 *   Cloudflare API (docs/LIMITATIONS.md, "What the suites fake").
 *
 * CI: this fixture project runs in CI (no credentials). The local stack is CI-friendly too (no
 * credentials, no network); `pnpm test:e2e` runs both.
 */
const PORT = Number(process.env.COMMONFORGE_E2E_FIXTURE_PORT ?? 4317);

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["fixture.spec.ts", "capture-walkthrough.spec.ts"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report/fixture" }]] : "list",
  outputDir: "test-results/fixture",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  projects: [{ name: "fixture", use: {} }],
  webServer: {
    command: `pnpm run build:fixture && pnpm exec vite preview --outDir dist-fixture --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "ignore",
  },
});
