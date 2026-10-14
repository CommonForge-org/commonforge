/**
 * Injectable dependencies. Production wiring uses the real bindings/REST; tests inject in-memory
 * doubles (the Artifacts binding/REST API has no local simulator and is remote-only).
 */
import type { ArtifactsTransport } from "@commonforge-org/provider-cloudflare";
import type { Env } from "./env.js";
import { defaultArtifactsImporter, defaultArtifactsTransport, type ArtifactsImporter } from "./services/artifacts.js";
import { defaultEmailTransport, type EmailTransport } from "./services/email.js";
import { defaultDeployApi, type DeployApi } from "./services/deploy-api.js";
import { defaultClassifier, type ClassifierProvider, type RiskClassifier } from "./services/classifier.js";

export interface QueueLike {
  send(body: unknown): Promise<void>;
}

export interface Deps {
  now(): Date;
  email(env: Env): EmailTransport;
  /** Artifacts control plane (REST in production; ungated — the app adds the OpsGate). */
  artifacts(env: Env): ArtifactsTransport;
  importer(env: Env): ArtifactsImporter;
  /** Worker-internal step queue (`commonforge-steps`). */
  stepQueue(env: Env): QueueLike;
  /** Signed runner jobs (`commonforge-runner-jobs`). */
  runnerQueue(env: Env): QueueLike;
  /** Outbox queue (`commonforge-outbox`): reconcile requests from wakeups and the GC backstop. */
  outboxQueue(env: Env): QueueLike;
  /** How long a step waits for a runner result before giving up and retrying later. */
  runnerWait: { pollMs: number; timeoutMs: number };
  /** Max wait for an OpsGate slot. */
  gateWaitMs: number;
  /** Task 22: the release health check's GET of `<target>/version` (tests inject the "live" service). */
  healthFetch(url: string): Promise<Response>;
  /** Task 22 review: the control plane's Cloudflare API calls with the deploy token. */
  deployApi(env: Env): DeployApi;
  /** Staging phase 3: the risk classifier adapter for a provider (secrets from the env; tests inject a fake). */
  classifier(env: Env, provider: ClassifierProvider): RiskClassifier;
}

export const defaultDeps: Deps = {
  now: () => new Date(),
  email: defaultEmailTransport,
  artifacts: defaultArtifactsTransport,
  importer: defaultArtifactsImporter,
  stepQueue: (env) => ({ send: async (body) => void (await env.STEPS.send(body, { contentType: "json" })) }),
  runnerQueue: (env) => ({ send: async (body) => void (await env.RUNNER_JOBS.send(body, { contentType: "json" })) }),
  outboxQueue: (env) => ({ send: async (body) => void (await env.OUTBOX.send(body, { contentType: "json" })) }),
  runnerWait: { pollMs: 1000, timeoutMs: 90_000 },
  gateWaitMs: 10_000,
  // redirect: manual (review m-2): the health check reads only the target's own answer
  healthFetch: (url) => fetch(url, { headers: { "user-agent": "commonforge-release-health/1", "cache-control": "no-cache" }, redirect: "manual", signal: AbortSignal.timeout(10_000) }),
  deployApi: defaultDeployApi,
  classifier: (env, provider) => defaultClassifier(env, provider),
};
