import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Apply the D1 directory schema once per test file (idempotent; tracked in d1_migrations).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);
