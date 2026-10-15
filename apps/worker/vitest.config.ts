import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations"); // vitest runs from apps/worker
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // src/index.ts with locally delivered queue messages dropped (see test/entry.ts)
        main: "./test/entry.ts",
        // Unit tests never touch the real account; *.live.test.ts opt in later.
        remoteBindings: false,
        miniflare: {
          // Deterministic test secrets (override .dev.vars); never real credentials.
          bindings: {
            TEST_MIGRATIONS: migrations,
            COMMONFORGE_SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
            COMMONFORGE_RUNNER_JOB_KEY: "test-runner-job-key-0123456789abcdef0123456789",
            CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
            CF_API_TOKEN: "test-api-token-not-real",
            COMMONFORGE_PUBLIC_URL: "https://worker.test",
            COMMONFORGE_APP_URL: "https://app.test",
            COMMONFORGE_EMAIL_MODE: "log",
            // every test user (helpers.ts email(): <id>@example.test) may create orgs; tests narrow it via envOverrides
            COMMONFORGE_ADMIN_EMAILS: "@example.test",
            COMMONFORGE_RUNNER_TOKEN: "test-runner-bearer-0123456789abcdef",
            // Task 22 (previews, releases)
            COMMONFORGE_PREVIEW_URL: "https://preview.test",
            COMMONFORGE_PREVIEW_KEY: "test-preview-key-0123456789abcdef0123456789",
            COMMONFORGE_DEPLOY_API_TOKEN: "test-deploy-token-not-real-0123456789",
            // folders and uploads (phase 2): fake R2 S3 credentials so presigning runs; never real
            COMMONFORGE_ASSETS_BUCKET: "commonforge-assets-test",
            COMMONFORGE_R2_ACCESS_KEY_ID: "test-r2-access-key-id",
            COMMONFORGE_R2_SECRET_ACCESS_KEY: "test-r2-secret-access-key-not-real",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
      // API tests run a whole Worker with D1 and take about a second each, but a loaded CI runner has
      // made them five times slower (editions I-2/M-2/M-3 hit vitest's 5 s default). 15 s still
      // catches a real hang; tests that need longer keep their own timeout.
      testTimeout: 15_000,
    },
  };
});
