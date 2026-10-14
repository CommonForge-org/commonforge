/** Shared Task 22 test fixture: the demo release policy (api Worker + static website) for one org. */
import { expect } from "vitest";
import type { Harness } from "./helpers.js";

export const workerName = (orgId: string, name: string) => `cfapp-${orgId}-${name}`;

export function releasePolicy(orgId: string, kvId?: string) {
  return {
    recipe: {
      recipeId: "demo-release",
      revision: 1,
      steps: [
        { stepId: "api-install", mountName: "api", command: "pnpm install --frozen-lockfile --ignore-scripts" },
        { stepId: "api-bundle", mountName: "api", command: "pnpm run build" },
        { stepId: "site-install", mountName: "website", command: "pnpm install --frozen-lockfile --ignore-scripts" },
        { stepId: "site-build", mountName: "website", command: "pnpm exec vite build", env: { VITE_QUOTE_API_URL: `https://${workerName(orgId, "api")}.demo.workers.dev` } },
      ],
    },
    targets: [
      { targetId: "api", kind: "worker", mountName: "api", outputPath: "dist", main: "index.js", workerName: workerName(orgId, "api") },
      { targetId: "website", kind: "assets", mountName: "website", outputPath: "dist", workerName: workerName(orgId, "website") },
    ],
    environment: { api: { vars: { APP_VERSION: "1.0.0" }, kvNamespaces: kvId ? [{ binding: "ORDERS", id: kvId }] : [] } },
    healthCheck: { targetId: "api", path: "/version" },
  };
}

/** The platform creates the org's production KV namespace (review C-1b); returns its id. */
export async function orgKv(h: Harness, o: { token: string; orgId: string }, name = "orders"): Promise<string> {
  const r = await h.api("POST", `/api/orgs/${o.orgId}/deploy-resources`, { token: o.token, body: { kind: "kv", name } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
}
