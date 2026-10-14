/**
 * Starts the local stack for local-stack.spec.ts: builds the real web bundle, applies the D1
 * migrations to a fresh local state directory, and runs `wrangler dev -c wrangler.e2e.jsonc`
 * with an empty env file (so apps/worker/.dev.vars, which may hold real credentials, is never
 * loaded). The Worker log goes to test-results/stack-worker.log. Returns the teardown.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { STACK_PORT, STACK_URL, WEB_DIR, WORKER_DIR, WORKER_LOG } from "./env.js";

const STATE = join(WORKER_DIR, ".wrangler", "e2e-stack");

async function waitHealthy(deadline: number) {
  for (;;) {
    try {
      const r = await fetch(`${STACK_URL}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`the local stack did not answer ${STACK_URL}/health; see ${WORKER_LOG}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export default async function globalSetup() {
  try {
    if ((await fetch(`${STACK_URL}/health`)).ok) throw new Error(`port ${STACK_PORT} is already serving; stop the other stack first`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("port")) throw e;
  }
  execFileSync("pnpm", ["run", "build"], { cwd: WEB_DIR, stdio: "inherit" });
  rmSync(STATE, { recursive: true, force: true });
  // never hand real credentials to the local stack (apps/worker/.dev.vars is skipped via --env-file)
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", CF_API_TOKEN: "", CF_ACCOUNT_ID: "", WRANGLER_SEND_METRICS: "false" };
  const envFile = join(WORKER_DIR, "e2e", "no-secrets.env");
  const wrangler = ["exec", "wrangler"];
  execFileSync("pnpm", [...wrangler, "d1", "migrations", "apply", "commonforge-e2e", "--local", "-c", "wrangler.e2e.jsonc", "--persist-to", STATE, "--env-file", envFile], { cwd: WORKER_DIR, stdio: "ignore", env });
  mkdirSync(dirname(WORKER_LOG), { recursive: true });
  const log = openSync(WORKER_LOG, "w");
  const child = spawn("pnpm", [...wrangler, "dev", "-c", "wrangler.e2e.jsonc", "--env-file", envFile, "--persist-to", STATE, "--ip", "127.0.0.1", "--port", String(STACK_PORT), "--show-interactive-dev-session=false", "--var", `COMMONFORGE_APP_URL:${STACK_URL}`, "--var", `COMMONFORGE_PUBLIC_URL:${STACK_URL}`], {
    cwd: WORKER_DIR,
    stdio: ["ignore", log, log],
    detached: true,
    env,
  });
  const stop = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  };
  try {
    await waitHealthy(Date.now() + 90_000);
  } catch (e) {
    stop(); // no teardown is returned when setup throws: never leave wrangler running
    throw e;
  }
  return async () => stop();
}
