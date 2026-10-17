/** Worker-safe RPC transport for the explicit real-local Node source sidecar. Never cloud wiring. */
import { ArtifactsProviderError, type ArtifactsTransport, type ArtifactsCreatedRepo, type ArtifactsRepoInfo, type ArtifactsTokenMinted, type ArtifactsTokenInfo, type ArtifactsCommit, type ArtifactsTreeItem } from '@commonforge-org/provider-cloudflare';
import { isLocalHostname } from './lib/local-host.js';
import type { ArtifactsImporter } from './services/artifacts.js';
export class LocalArtifactsTransport implements ArtifactsTransport {
  readonly kind = 'rest' as const;
  constructor(readonly url: string, private readonly key: string) {
    const parsed = new URL(url); if (parsed.protocol !== 'http:' || !isLocalHostname(parsed.hostname) || parsed.username || parsed.password || !key) throw new Error('real-local Artifacts must use authenticated localhost HTTP');
  }
  async rpc<T>(method: string, args: unknown[]): Promise<T> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(30000) });
    const body = await res.json() as { result?: T; error?: { code: string } };
    if (!res.ok) throw new ArtifactsProviderError((body.error?.code ?? 'provider_unavailable') as never, 'real-local source operation failed');
    return body.result as T;
  }
  createRepo(ns: string, name: string, opts?: { description?: string; defaultBranch?: string }) { return this.rpc<ArtifactsCreatedRepo>('createRepo', [ns, name, opts ?? {}]); }
  getRepo(ns: string, name: string) { return this.rpc<ArtifactsRepoInfo | null>('getRepo', [ns, name]); }
  deleteRepo(ns: string, name: string) { return this.rpc<boolean>('deleteRepo', [ns, name]); }
  createToken(ns: string, name: string, scope: 'read' | 'write', ttl: number) { return this.rpc<ArtifactsTokenMinted>('createToken', [ns, name, scope, ttl]); }
  listTokens(ns: string, name: string) { return this.rpc<ArtifactsTokenInfo[]>('listTokens', [ns, name]); }
  revokeToken(ns: string, name: string, id: string) { return this.rpc<boolean>('revokeToken', [ns, name, id]); }
  log(ns: string, name: string, opts: { ref: string; limit?: number }) { return this.rpc<ArtifactsCommit[]>('log', [ns, name, opts]); }
  readCommit(ns: string, name: string, sha: string) { return this.rpc<ArtifactsCommit | null>('readCommit', [ns, name, sha]); }
  readTree(ns: string, name: string, sha: string) { return this.rpc<ArtifactsTreeItem[] | null>('readTree', [ns, name, sha]); }
  async readFile(ns: string, name: string, ref: string, path: string) {
    const result = await this.rpc<{ bytes: string } | null>('readFile', [ns, name, ref, path]);
    if (!result) return null;
    return Uint8Array.from(atob(result.bytes), c => c.charCodeAt(0));
  }
}
export const localImporter: ArtifactsImporter = { async importRepo() { throw new Error('real-local URL import is unsupported; use the audited synthetic fixture seed or Git push'); } };
