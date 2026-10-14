import { createWorker } from "./app.js";
import type { Env } from "./env.js";

export type { Env } from "./env.js";
/** Per-org acceptance ledger (SQLite-backed Durable Object; binding `ORG_LEDGER`). */
export { OrgLedger } from "./ledger/org-ledger.js";
/** Per-namespace Artifacts ops gate (A9 rate cap) and named locks (binding `OPS_GATE`). */
export { OpsGate } from "./services/ops-gate.js";

const worker = createWorker();

export default {
  fetch: worker.fetch,
  queue: worker.queue,
  scheduled: worker.scheduled,
} satisfies ExportedHandler<Env>;
