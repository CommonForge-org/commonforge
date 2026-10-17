/** Real-local Worker. Real Git source sidecar + real pull runner; cloud deployment unavailable. */
import { createWorker } from '../src/app.js';
import { defaultDeps } from '../src/deps.js';
import type { Env } from '../src/env.js';
import { isLocalWorker } from '../src/chaos.js';
import { LocalArtifactsTransport, localImporter } from '../src/local-artifacts.js';
export { OpsGate, OrgLedger } from '../src/index.js';
type LocalEnv = Env & { COMMONFORGE_LOCAL_ARTIFACTS_URL: string; COMMONFORGE_LOCAL_ARTIFACTS_KEY: string };
const worker = createWorker({ ...defaultDeps,
  artifacts: env => { const local = env as LocalEnv; if (!isLocalWorker(env)) throw new Error('real-local mode cannot run outside localhost'); return new LocalArtifactsTransport(local.COMMONFORGE_LOCAL_ARTIFACTS_URL, local.COMMONFORGE_LOCAL_ARTIFACTS_KEY); },
  importer: () => localImporter,
  // Pull runner reads the durable runner_jobs queue projection. The queue delivery is acked below.
  runnerWait: { pollMs: 100, timeoutMs: 30000 },
  deployApi: () => { throw new Error('cloud deployment unavailable in real-local mode'); },
});
export default {
  async fetch(request, env, ctx) {
    if (!isLocalWorker(env)) return new Response('real-local mode requires localhost', { status: 503 });
    return worker.fetch(request, env, ctx);
  },
  async queue(batch, env, ctx) {
    if (!isLocalWorker(env)) throw new Error('real-local mode requires localhost');
    const queue = batch.queue.replace('commonforge-real-', 'commonforge-');
    if (queue === 'commonforge-runner-jobs') { batch.ackAll(); return; }
    return worker.queue({ metadata: batch.metadata, queue, messages: batch.messages, ackAll: () => batch.ackAll(), retryAll: opts => batch.retryAll(opts) }, env, ctx);
  },
  async scheduled(controller, env, ctx) { if (!isLocalWorker(env)) throw new Error('local only'); return worker.scheduled(controller, env, ctx); },
} satisfies ExportedHandler<LocalEnv>;
