/**
 * Artifacts wiring for the Worker.
 *
 * Transport: a Workers binding serves exactly one namespace, but CommonForge uses per-org
 * namespaces (`<prefix>-<org>-canonical|tasks|editions`), so the Worker reaches Artifacts through
 * the REST API (`CF_ACCOUNT_ID` + `CF_API_TOKEN` secrets). Tests inject an in-memory transport.
 *
 * Every create / token mint / delete / import goes through the per-namespace {@link OpsGate}
 * (A9: at most 25 concurrent fork/token operations per namespace).
 */
import {
  CompareResultSchema,
  type ArtifactsCoords,
  type CompareResult,
  type RunnerSubmit,
} from "@commonforge-org/core";
import {
  ArtifactsProviderError,
  ArtifactsVersionProvider,
  RestArtifactsTransport,
  type ArtifactsCompareDelegate,
  type ArtifactsCreatedRepo,
  type ArtifactsRepoInfo,
  type ArtifactsTransport,
  type CompareRequest,
  type WorkspaceRecord,
} from "@commonforge-org/provider-cloudflare";
import type { Env } from "../env.js";
import type { GateClient } from "./ops-gate.js";

/** Public HTTPS import into a namespace (not part of the provider's transport interface). */
export interface ArtifactsImporter {
  importRepo(namespace: string, name: string, source: { url: string; branch: string; depth?: number }): Promise<ArtifactsCreatedRepo>;
}

export type ImportErrorCode = "import_timeout" | "import_in_progress" | "already_exists" | "import_refused" | "not_found" | "provider_unavailable" | "provider_error";

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ImportError";
  }
}

interface RawRepo {
  id: string;
  name: string;
  default_branch?: string;
  remote: string;
  source?: string | null;
  read_only?: boolean;
  token?: string;
}

/** REST `POST /accounts/:id/artifacts/namespaces/:ns/repos/:name/import` (spike S4 shape). */
export class RestArtifactsImporter implements ArtifactsImporter {
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
    private readonly fetchFn: typeof fetch = (i, init) => fetch(i, init),
    private readonly apiBase = "https://api.cloudflare.com/client/v4",
  ) {}

  async importRepo(namespace: string, name: string, source: { url: string; branch: string; depth?: number }): Promise<ArtifactsCreatedRepo> {
    const url = `${this.apiBase}/accounts/${this.accountId}/artifacts/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(name)}/import`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify({ url: source.url, branch: source.branch, ...(source.depth ? { depth: source.depth } : {}) }),
      });
    } catch {
      throw new ImportError("provider_unavailable", "import request failed");
    }
    let body: { success?: boolean; result?: RawRepo; errors?: Array<{ code?: number; message?: string }> } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON */
    }
    const first = body.errors?.[0];
    const msg = (first?.message ?? `HTTP ${res.status}`).slice(0, 300).replace(this.apiToken, "<redacted>");
    if (res.status === 504) throw new ImportError("import_timeout", msg);
    if (res.status === 409) throw new ImportError(first?.code === 10302 ? "import_in_progress" : "already_exists", msg);
    if (res.status === 422 || res.status === 400) throw new ImportError("import_refused", msg);
    if (res.status === 404) throw new ImportError("not_found", msg);
    if (res.status >= 500) throw new ImportError("provider_unavailable", msg);
    if (!res.ok || !body.success || !body.result) throw new ImportError("provider_error", msg);
    const r = body.result;
    return {
      id: r.id,
      name: r.name,
      defaultBranch: r.default_branch ?? source.branch,
      remote: r.remote,
      source: r.source ?? null,
      readOnly: r.read_only ?? false,
      token: r.token ?? "",
    };
  }
}

/** Decorates a transport so every fork/create/token/delete holds a namespace slot. */
export class GatedTransport implements ArtifactsTransport {
  readonly kind: ArtifactsTransport["kind"];
  constructor(
    private readonly inner: ArtifactsTransport,
    private readonly gate: GateClient,
  ) {
    this.kind = inner.kind;
  }
  createRepo(ns: string, name: string, opts?: { description?: string; defaultBranch?: string }) {
    return this.gate.withSlot(ns, () => this.inner.createRepo(ns, name, opts));
  }
  getRepo(ns: string, name: string) {
    return this.inner.getRepo(ns, name);
  }
  deleteRepo(ns: string, name: string) {
    return this.gate.withSlot(ns, () => this.inner.deleteRepo(ns, name));
  }
  createToken(ns: string, repo: string, scope: "read" | "write", ttl: number) {
    return this.gate.withSlot(ns, () => this.inner.createToken(ns, repo, scope, ttl));
  }
  listTokens(ns: string, repo: string) {
    return this.inner.listTokens(ns, repo);
  }
  revokeToken(ns: string, repo: string, id: string) {
    return this.inner.revokeToken(ns, repo, id);
  }
  log(ns: string, repo: string, opts: { ref: string; limit?: number }) {
    return this.inner.log(ns, repo, opts);
  }
  readCommit(ns: string, repo: string, sha: string) {
    return this.inner.readCommit(ns, repo, sha);
  }
  readTree(ns: string, repo: string, sha: string) {
    return this.inner.readTree(ns, repo, sha);
  }
  readFile(ns: string, repo: string, ref: string, path: string) {
    return this.inner.readFile(ns, repo, ref, path);
  }
}

export class GatedImporter implements ArtifactsImporter {
  constructor(
    private readonly inner: ArtifactsImporter,
    private readonly gate: GateClient,
  ) {}
  importRepo(ns: string, name: string, source: { url: string; branch: string; depth?: number }) {
    return this.gate.withSlot(ns, () => this.inner.importRepo(ns, name, source));
  }
}

export function defaultArtifactsTransport(env: Env): ArtifactsTransport {
  return new RestArtifactsTransport({ accountId: env.CF_ACCOUNT_ID, apiToken: env.CF_API_TOKEN });
}

export function defaultArtifactsImporter(env: Env): ArtifactsImporter {
  return new RestArtifactsImporter(env.CF_ACCOUNT_ID, env.CF_API_TOKEN);
}

/** Max files a Worker-side compare walks before giving up (plan §B.6: P0 compare is cheap). */
export const COMPARE_MAX_ENTRIES = 20_000;

/**
 * Worker-side compare over `readTree` recursion (plan §B.6 lists this as the later optimization of
 * the runner's `git diff`; there is no runner `compare` job kind, so the Worker does it). Reports
 * added / modified / deleted files; renames appear as delete + add; `binary` is unknown (false).
 */
export function treeCompare(transport: ArtifactsTransport): ArtifactsCompareDelegate {
  return async (req: CompareRequest): Promise<CompareResult> => {
    const { namespace: ns, repoName: repo } = req.repo;
    const [b, c] = await Promise.all([transport.readCommit(ns, repo, req.baseSha), transport.readCommit(ns, repo, req.candidateSha)]);
    if (!b || !c) throw new ArtifactsProviderError("not_found", "compare: commit missing in repository");
    const files: CompareResult["files"] = [];
    let seen = 0;
    const walk = async (base: string | null, cand: string | null, prefix: string): Promise<void> => {
      const [bi, ci] = await Promise.all([base ? transport.readTree(ns, repo, base) : null, cand ? transport.readTree(ns, repo, cand) : null]);
      const bm = new Map((bi ?? []).map((i) => [i.name, i]));
      const cm = new Map((ci ?? []).map((i) => [i.name, i]));
      for (const name of [...new Set([...bm.keys(), ...cm.keys()])].sort()) {
        if (++seen > COMPARE_MAX_ENTRIES) throw new ArtifactsProviderError("compare_unavailable", "tree too large for a Worker-side compare");
        const x = bm.get(name);
        const y = cm.get(name);
        const path = prefix ? `${prefix}/${name}` : name;
        if (x && y && x.hash === y.hash && x.mode === y.mode) continue;
        const xt = x?.type === "tree";
        const yt = y?.type === "tree";
        if (xt || yt) {
          await walk(xt ? x!.hash : null, yt ? y!.hash : null, path);
          if (x && !xt) files.push({ path, status: "deleted", binary: false });
          if (y && !yt) files.push({ path, status: "added", binary: false });
          continue;
        }
        files.push({ path, status: !x ? "added" : !y ? "deleted" : "modified", binary: false });
      }
    };
    await walk(b.treeHash, c.treeHash, "");
    files.sort((p, q) => (p.path < q.path ? -1 : p.path > q.path ? 1 : 0));
    return CompareResultSchema.parse({ base: req.base, candidate: req.candidate, sameTree: files.length === 0, files });
  };
}

export interface ProviderWiring {
  transport: ArtifactsTransport;
  namespacePrefix: string;
  runner?: RunnerSubmit;
  workspace?: (taskWorkspaceId: string) => Promise<WorkspaceRecord | null>;
}

export function makeProvider(w: ProviderWiring): ArtifactsVersionProvider {
  return new ArtifactsVersionProvider({
    transport: w.transport,
    namespacePrefix: w.namespacePrefix,
    compare: treeCompare(w.transport),
    ...(w.runner ? { runner: w.runner } : {}),
    ...(w.workspace ? { workspace: w.workspace } : {}),
  });
}

export function repoInfoCoords(namespace: string, info: ArtifactsRepoInfo): ArtifactsCoords {
  return { kind: "artifacts", namespace, repoName: info.name, repoId: info.id as ArtifactsCoords["repoId"], remoteUrl: info.remote };
}
