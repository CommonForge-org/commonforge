/**
 * Test entrypoint (vitest `main`): the deployed module (src/index.ts) with one change. Messages that
 * miniflare delivers from its local queues (for example the OrgLedger alarm draining the outbox) are
 * acknowledged and dropped: the deployed consumer would reach the real Artifacts REST API. Tests
 * drive the consumers explicitly through `createWorker(deps)` with in-memory doubles (helpers.ts).
 */
import worker from "../src/index.js";

export { OpsGate, OrgLedger } from "../src/index.js";

export default {
  ...worker,
  async queue(batch: MessageBatch): Promise<void> {
    batch.ackAll();
  },
} satisfies ExportedHandler<Cloudflare.Env>;
