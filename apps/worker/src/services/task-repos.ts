/**
 * Fresh task repositories for runner-written candidates (edition returns, file changes): the empty
 * `-tasks` repo a runner job pushes its candidate to, and the canonical coordinates the job reads,
 * verified against the live repository.
 */
import type { ArtifactsCoords, TaskWorkspaceHandle } from "@commonforge-org/core";
import { isArtifactsProviderError, namespaceFor, taskWorkspaceRepoName } from "@commonforge-org/provider-cloudflare";
import type { Services } from "../context.js";
import { conflict } from "../lib/http.js";
import { repoInfoCoords } from "./artifacts.js";
import { getResource, resourceCoords } from "./directory.js";
import { setWorkspaceState } from "./tasks.js";

export interface FreshTaskRepo {
  orgId: string;
  taskWorkspaceId: string;
  resourceId: string;
  baseRevision: string;
  /** the repo description (cut to 200 characters) */
  description: string;
}

/**
 * Create the empty `-tasks` repo the runner pushes the candidate to (its `main` must not exist: the
 * job leases it absent), record the workspace in the ledger and mark the row writable. Adopts the
 * repo (and the ledger record) of an earlier attempt of the same workspace.
 */
export async function ensureFreshTaskRepo(svc: Services, w: FreshTaskRepo): Promise<TaskWorkspaceHandle> {
  const ledger = svc.ledger(w.orgId);
  const existing = await ledger.getWorkspace(w.taskWorkspaceId);
  if (existing) return existing;
  const ns = namespaceFor(svc.env.COMMONFORGE_NAMESPACE_PREFIX, w.orgId, "tasks");
  const name = taskWorkspaceRepoName(w.taskWorkspaceId);
  let info = await svc.transport.getRepo(ns, name);
  if (!info) {
    try {
      const created = await svc.transport.createRepo(ns, name, { description: w.description.slice(0, 200), defaultBranch: "main" }); // the runner pushes refs/heads/main
      info = { id: created.id, name: created.name, defaultBranch: created.defaultBranch, remote: created.remote, source: created.source, readOnly: created.readOnly };
    } catch (e) {
      if (!isArtifactsProviderError(e, "already_exists")) throw e;
      info = await svc.transport.getRepo(ns, name);
      if (!info) throw e;
    }
  }
  // nobody but the runner job (broker-minted) ever gets a token for this repo
  for (const t of await svc.transport.listTokens(ns, name)) if (t.state === "active") await svc.transport.revokeToken(ns, name, t.id).catch(() => false);
  const handle = {
    taskWorkspaceId: w.taskWorkspaceId,
    resourceId: w.resourceId,
    baseRevision: w.baseRevision,
    provider: "artifacts",
    coords: repoInfoCoords(ns, info),
    state: "writable",
  } as TaskWorkspaceHandle;
  await ledger.putWorkspace(w.orgId, handle);
  await setWorkspaceState(svc, w.taskWorkspaceId, "writable", { from: "provisioning" });
  return handle;
}

/** Canonical coordinates verified against the live repo (jobs carry the server's view). */
export async function liveCanonical(svc: Services, orgId: string, resourceId: string): Promise<ArtifactsCoords> {
  const r = await getResource(svc.db, orgId, resourceId);
  const coords = r ? resourceCoords(r) : null;
  if (!coords || coords.kind !== "artifacts") throw conflict("resource_not_ready", "no canonical repository");
  const info = await svc.transport.getRepo(coords.namespace, coords.repoName);
  if (!info || info.id !== coords.repoId) throw conflict("repo_mismatch", "canonical repository changed");
  return repoInfoCoords(coords.namespace, info);
}
