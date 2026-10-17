import { defineConfig, devices } from '@playwright/test';

/** External REAL Worker started by scripts/dev-real-worker.sh; no fake provider routes. */
export default defineConfig({
  testDir: './e2e', testMatch: ['native.spec.ts','native-outcomes.spec.ts'], workers: 1, fullyParallel: false,
  reporter: 'list', outputDir: 'test-results/native', timeout: 120000,
  expect: { timeout: 20000 },
  use: { baseURL: process.env.COMMONFORGE_NATIVE_URL ?? 'http://127.0.0.1:8899', ...devices['Desktop Chrome'], trace: 'off' },
});
