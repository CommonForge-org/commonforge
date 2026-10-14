/**
 * Per-request (or per-queue-batch) service bundle and the Hono environment type.
 */
import { toIsoUtc, type RunnerSubmit } from "@commonforge-org/core";
import { R2AssetProvider, type ArtifactsTransport, type ArtifactsVersionProvider, type WorkspaceRecord } from "@commonforge-org/provider-cloudflare";
import type { JobSigningKey } from "@commonforge-org/runner-protocol";
import type { Deps } from "./deps.js";
import type { Env } from "./env.js";
import type { OrgLedger } from "./ledger/org-ledger.js";
import { deriveKeyBytes } from "./lib/crypto.js";
import { GatedImporter, GatedTransport, makeProvider, type ArtifactsImporter } from "./services/artifacts.js";
import { gateClient, type GateClient } from "./services/ops-gate.js";

/** Who is calling. Agents act on behalf of the user holding the task lease (never with the user's full rights). */
export type Principal =
  | { kind: "user"; userId: string; email: string }
  | { kind: "agent"; taskId: string; orgId: string; leaseGeneration: number; leaseExpiresAt: number; holderUserId: string };

export interface Services {
  env: Env;
  deps: Deps;
  db: D1Database;
  now(): Date;
  nowIso(): string;
  gate: GateClient;
  /** gated Artifacts control-plane transport */
  transport: ArtifactsTransport;
  importer: ArtifactsImporter;
  ledger(orgId: string): DurableObjectStub<OrgLedger>;
  /** Artifacts provider with the ledger-backed workspace resolver; pass `runner` for seed jobs. */
  provider(runner?: RunnerSubmit): ArtifactsVersionProvider;
  assets(orgId: string): Promise<R2AssetProvider>;
  jobKey(): JobSigningKey;
}

export interface AppEnv {
  Bindings: Env;
  Variables: {
    svc: Services;
    principal: Principal | null;
    /** set by routes whose caller must not see raw provider error text (see `plainProviderErrors`) */
    plainProviderErrors?: boolean;
  };
}

/** Key id of the single runner job key (rotation: add a second kid and accept both). */
export const RUNNER_JOB_KID = "k1";

export function createServices(env: Env, deps: Deps): Services {
  const gate = gateClient(env.OPS_GATE, { waitMs: deps.gateWaitMs });
  const transport = new GatedTransport(deps.artifacts(env), gate);
  const importer = new GatedImporter(deps.importer(env), gate);
  let assetKey: Promise<Uint8Array> | null = null;
  const svc: Services = {
    env,
    deps,
    db: env.DB,
    now: () => deps.now(),
    nowIso: () => toIsoUtc(deps.now()),
    gate,
    transport,
    importer,
    ledger: (orgId) => env.ORG_LEDGER.get(env.ORG_LEDGER.idFromName(`org:${orgId}`)),
    provider: (runner) =>
      makeProvider({
        transport,
        namespacePrefix: env.COMMONFORGE_NAMESPACE_PREFIX,
        ...(runner ? { runner } : {}),
        workspace: (id) => workspaceRecord(svc, id),
      }),
    assets: async (orgId) => {
      assetKey ??= deriveKeyBytes(env.COMMONFORGE_SESSION_SECRET, "asset-token");
      return new R2AssetProvider({ bucket: env.COMMONFORGE_ASSETS, organizationId: orgId, signingKey: await assetKey, urlBase: "/v1/assets", now: () => deps.now() });
    },
    jobKey: () => {
      const secret = env.COMMONFORGE_RUNNER_JOB_KEY;
      if (!secret || secret.length < 32) throw new Error("COMMONFORGE_RUNNER_JOB_KEY is not configured (>= 32 bytes)");
      return { kid: RUNNER_JOB_KID, secret };
    },
  };
  return svc;
}

/**
 * The provider's `workspace` resolver: the ledger record decides state, the task row decides the
 * lease. A workspace being frozen reports `frozen` so no new write token can be minted meanwhile.
 */
export async function workspaceRecord(svc: Services, taskWorkspaceId: string): Promise<WorkspaceRecord | null> {
  const row = await svc.db
    .prepare(
      "SELECT w.org_id, w.state AS ws_state, t.lease_generation, t.lease_expires_at FROM task_workspaces w JOIN tasks t ON t.task_id = w.task_id WHERE w.task_workspace_id = ?",
    )
    .bind(taskWorkspaceId)
    .first<{ org_id: string; ws_state: string; lease_generation: number; lease_expires_at: number | null }>();
  if (!row) return null;
  const handle = await svc.ledger(row.org_id).getWorkspace(taskWorkspaceId);
  if (!handle) return null;
  const state = row.ws_state === "freezing" ? "frozen" : handle.state;
  return {
    organizationId: row.org_id,
    state,
    leaseGeneration: row.lease_generation,
    ...(row.lease_expires_at ? { leaseExpiresAt: new Date(row.lease_expires_at).toISOString() } : {}),
  };
}
