/** Shared by the stack config, its global setup and the spec. The port defaults to apps/worker/wrangler.e2e.jsonc's 8799; COMMONFORGE_E2E_PORT picks another (global setup passes the matching app URL to the Worker). */
import { fileURLToPath } from "node:url";

export const STACK_PORT = Number(process.env.COMMONFORGE_E2E_PORT || 8799);
export const STACK_URL = `http://127.0.0.1:${STACK_PORT}`;
export const E2E_KEY = "e2e-local-only-key";
export const WORKER_DIR = fileURLToPath(new URL("../../../worker/", import.meta.url));
export const WEB_DIR = fileURLToPath(new URL("../../", import.meta.url));
/** the Worker log (wrangler dev stdout+stderr): the magic links are read from here */
export const WORKER_LOG = fileURLToPath(new URL("../../test-results/stack-worker.log", import.meta.url));
