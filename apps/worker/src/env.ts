import type { OrgLedger } from "./ledger/org-ledger.js";
import type { OpsGate } from "./services/ops-gate.js";

/** Bindings declared in wrangler.jsonc (keep in sync; `pnpm types` generates the reference shape). */
export interface Env {
  ARTIFACTS: Artifacts;
  ORG_LEDGER: DurableObjectNamespace<OrgLedger>;
  OPS_GATE: DurableObjectNamespace<OpsGate>;
  DB: D1Database;
  COMMONFORGE_ASSETS: R2Bucket;
  EMAIL: SendEmail;
  OUTBOX: Queue;
  STEPS: Queue;
  RUNNER_JOBS: Queue;
  COMMONFORGE_NAMESPACE_PREFIX: string;
  COMMONFORGE_APP_URL: string;
  COMMONFORGE_PUBLIC_URL: string;
  COMMONFORGE_EMAIL_FROM: string;
  /** `send` (Email Service) | `log` (dev: write the link to the Worker log) */
  COMMONFORGE_EMAIL_MODE: string;
  /** who may create organizations: comma-separated emails or `@domain` entries (services/admins.ts); unset: nobody */
  COMMONFORGE_ADMIN_EMAILS?: string;
  // ---- secrets (wrangler secret put / .dev.vars) ----
  COMMONFORGE_SESSION_SECRET: string;
  COMMONFORGE_RUNNER_JOB_KEY: string;
  /** Artifacts REST transport for per-org namespaces (a binding serves one namespace only). */
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  /** optional: bearer that pull-mode runners present to `POST /api/runner/jobs/next` (unset: pull disabled) */
  COMMONFORGE_RUNNER_TOKEN?: string;
  /** Loopback-only signed G1 scenario supervisor. Never a production execution backend. */
  COMMONFORGE_LOCAL_RUNNER_URL?: string;
  /** Trusted isolated HTTPS scenario supervisor. Requests/results are HMAC-bound; never caller selected. */
  COMMONFORGE_SCENARIO_RUNNER_URL?: string;
  // ---- Task 22: previews and releases ----
  /** base URL of the dedicated preview Worker (another origin than the app); previews are `<url>/p/<org>/<previewId>/<token>/` */
  COMMONFORGE_PREVIEW_URL?: string;
  /** secret shared with the preview Worker: HMAC key of the per-preview expiring link tokens (>= 32 bytes) */
  COMMONFORGE_PREVIEW_KEY?: string;
  /** secret: Cloudflare API token (Workers Scripts: Edit) handed ONLY to open release-deploy jobs */
  COMMONFORGE_DEPLOY_API_TOKEN?: string;
  /** account the release targets deploy to (default: CF_ACCOUNT_ID); ideally a SEPARATE account (review C-1d) */
  COMMONFORGE_DEPLOY_ACCOUNT_ID?: string;
  /** release Worker names are `<prefix>-<orgId>-<name>` (default `cfapp`; review C-1a) */
  COMMONFORGE_DEPLOY_WORKER_PREFIX?: string;
  /** `1` lets pull-mode runners claim release-deploy jobs (default: never; review m-4) */
  COMMONFORGE_RUNNER_DEPLOY?: string;
  // ---- folders and uploads (git + LFS on R2) ----
  /** name of the bucket behind COMMONFORGE_ASSETS (presigned URLs address it through R2's S3 API) */
  COMMONFORGE_ASSETS_BUCKET?: string;
  /** secret, optional: R2 API token (Object Read & Write on the assets bucket) that signs git-lfs upload URLs; unset → LFS uploads answer 503 */
  COMMONFORGE_R2_ACCESS_KEY_ID?: string;
  COMMONFORGE_R2_SECRET_ACCESS_KEY?: string;
  /** files above this many bytes are stored in LFS (default 1048576) */
  COMMONFORGE_LFS_THRESHOLD_BYTES?: string;
  /** unaccepted LFS objects are deleted this many days after their last use (default 7) */
  COMMONFORGE_STAGING_TTL_DAYS?: string;
  /** browser upload part size in bytes (default 52428800; at least 5242880; tests lower it) */
  COMMONFORGE_UPLOAD_PART_BYTES?: string;
  // ---- staging phase 3: risk classifier (src/services/classifier.ts) ----
  /** secret, optional: TypeSafe API key for Jev (`POST https://api.typesafe.ai/v1/systemone`); unset → the `jev` provider answers not_configured (developer review) */
  JEV_API_KEY?: string;
  /** secret, optional: OpenAI API key for the Decisions API; unset → the `openai-decisions` provider answers not_configured */
  OPENAI_API_KEY?: string;
  /** OpenAI Decisions model (default `gpt-6-luna`) */
  COMMONFORGE_OPENAI_DECISIONS_MODEL?: string;
  // ---- Task 23: fault injection (src/chaos.ts); never set by default ----
  /** comma-separated chaos points; ignored unless the Worker is local or explicitly allowed below */
  COMMONFORGE_CHAOS?: string;
  /** `inject-faults` lets a deployed rehearsal Worker honor COMMONFORGE_CHAOS (never production) */
  COMMONFORGE_CHAOS_ALLOW_DEPLOYED?: string;
  /** a non-production deployment's name (`ci` from scripts/ci-config.mjs, `<name>` from scripts/bootstrap.sh); unset on production. Reported by /health; with a matching COMMONFORGE_QUEUE_SUFFIX (`-<name>`) it allows email log mode there */
  COMMONFORGE_DEPLOYMENT?: string;
  /** suffix of every queue name of this deployment (e.g. `-ci`; default none). See `queueBaseName`. */
  COMMONFORGE_QUEUE_SUFFIX?: string;
}

type WorkerEnv = Env;

declare global {
  namespace Cloudflare {
    // Types `env` from `cloudflare:workers` and `cloudflare:test` with the bindings above.
    interface Env extends WorkerEnv {
      /** test-only: D1 migrations injected by vitest.config.ts */
      TEST_MIGRATIONS?: { name: string; queries: string[] }[];
    }
  }
}
