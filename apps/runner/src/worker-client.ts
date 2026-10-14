/**
 * The runner's calls to the Worker (Task 16 owns the endpoints; the runner treats the Worker as a
 * plain HTTP service):
 *
 * | Call | Endpoint | Body → response |
 * |---|---|---|
 * | credential | `POST <job.credentialBroker>` | `{signedJob, repo, access}` → `RunnerCredentialResponse` |
 * | revoke | `POST <job.credentialBroker>/revoke` | `{signedJob, tokenId}` → 2xx |
 * | results | `POST <workerUrl>/api/runner/results` | `{signedJob, result}` → 2xx (409 = already applied) |
 * | poll | `POST <workerUrl>/api/runner/jobs/next` | `{runnerId}` → 200 `RunnerJobDelivery` or 204 |
 * | evidence key | `POST <workerUrl>/api/runner/evidence-key` | `{signedJob}` → `EvidenceKeyWire` (only when the delivery lacks it) |
 * | heads | `POST <workerUrl>/api/runner/heads` | `{signedJob}` → `{heads: {[resourceId]: RevisionId|null}}` (ledger heads; optional) |
 * | blobs | `GET/PUT <workerUrl>/api/runner/blobs/<key>` | see `blob-store.ts` |
 * | deploy credential | `POST <workerUrl>/api/runner/deploy-credential` | `{signedJob}` → `{token}` (open `release-deploy` jobs only; broker-mode runners) |
 *
 * `workerUrl` is configuration; the runner refuses jobs whose `credentialBroker` has another
 * origin (review I-2). All bodies are JSON and are
 * redacted before sending; an optional runner bearer (read from a file, never from the
 * environment) authenticates the runner.
 */
import { EvidenceKeyWireSchema, evidenceKeyFromWire, type EvidenceSigningKey, type RunnerResult, type SignedJob } from '@commonforge-org/runner-protocol';
import type { RevisionId } from '@commonforge-org/core';

export interface WorkerClientOptions {
  /** the trusted Worker; every call goes here (never to an origin taken from a job) */
  workerUrl: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkerClient {
  postResult(signedJob: SignedJob, result: RunnerResult): Promise<void>;
  nextJob(runnerId: string): Promise<unknown | null>;
  evidenceKey(signedJob: SignedJob): Promise<EvidenceSigningKey | null>;
  heads(signedJob: SignedJob): Promise<Record<string, RevisionId | null> | null>;
  /** The account deploy token for an open release-deploy job (a secret: one wrangler process only). */
  deployCredential(signedJob: SignedJob): Promise<string>;
}

export function createWorkerClient(options: WorkerClientOptions): WorkerClient {
  const base = options.workerUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const headers = { 'content-type': 'application/json', ...options.headers };
  const post = (url: string, body: unknown) => doFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

  return {
    async postResult(signedJob, result) {
      const url = `${base}/api/runner/results`;
      const attempts = options.attempts ?? 6;
      let last = '';
      for (let i = 0; i < attempts; i++) {
        try {
          const res = await post(url, { signedJob, result });
          if (res.ok || res.status === 409) return;
          last = `HTTP ${res.status}`;
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break;
        } catch (e) {
          last = (e as Error).message;
        }
        await sleep(250 * 2 ** i * (0.5 + Math.random()));
      }
      throw new Error(`posting result for ${signedJob.jobId} failed: ${last}`);
    },
    async nextJob(runnerId) {
      const res = await post(`${base}/api/runner/jobs/next`, { runnerId });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`job poll: HTTP ${res.status}`);
      return res.json();
    },
    async evidenceKey(signedJob) {
      const res = await post(`${base}/api/runner/evidence-key`, { signedJob });
      if (!res.ok) return null;
      const parsed = EvidenceKeyWireSchema.safeParse(await res.json().catch(() => null));
      return parsed.success ? evidenceKeyFromWire(parsed.data) : null;
    },
    async heads(signedJob) {
      const res = await post(`${base}/api/runner/heads`, { signedJob });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as { heads?: Record<string, RevisionId | null> } | null;
      return body?.heads ?? null;
    },
    async deployCredential(signedJob) {
      const res = await post(`${base}/api/runner/deploy-credential`, { signedJob });
      if (!res.ok) throw new Error(`deploy credential refused: HTTP ${res.status}`);
      const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
      if (typeof body?.token !== 'string' || body.token.length < 8) throw new Error('deploy credential response is malformed');
      return body.token;
    },
  };
}
