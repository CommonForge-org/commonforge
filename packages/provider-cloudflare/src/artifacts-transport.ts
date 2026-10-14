/**
 * The Artifacts control-plane operations the provider needs, normalized over the two transports:
 * the Workers binding (`env.ARTIFACTS`, one binding per namespace) and the REST API
 * (`/accounts/{id}/artifacts/namespaces/{ns}/...`, Node runner/CLI).
 *
 * Neither transport can write: there are no commit/ref-update endpoints (plan §0.2). All writes go
 * through `git push` in the integration runner.
 *
 * Conventions shared by both implementations:
 * - "not found" on a lookup returns `null`/`false`, never throws;
 * - 5xx / INTERNAL_ERROR throws `ArtifactsProviderError('provider_unavailable')` — create is not
 *   idempotent, so the caller must look the repo up before retrying (spike A2);
 * - `log` returns `[]` when the ref cannot be resolved, and full ref names (`refs/heads/main`)
 *   never resolve (spike A5): pass short names or shas only.
 */

export interface ArtifactsRepoInfo {
  id: string;
  name: string;
  defaultBranch: string;
  /** HTTPS git remote (no credentials) */
  remote: string;
  /** fork source (`artifacts:<ns>/<repo>`), or null */
  source: string | null;
  readOnly: boolean;
}

export interface ArtifactsCreatedRepo extends ArtifactsRepoInfo {
  /** initial write token (secret). The provider revokes it as soon as it is no longer needed. */
  token: string;
}

export interface ArtifactsTokenMinted {
  id: string;
  /** secret */
  plaintext: string;
  scope: 'read' | 'write';
  /** ISO 8601 */
  expiresAt: string;
}

export interface ArtifactsTokenInfo {
  id: string;
  scope: 'read' | 'write';
  state: 'active' | 'expired' | 'revoked';
  expiresAt: string;
  /** ISO 8601 creation time, when the transport reports it */
  createdAt?: string;
}

export interface ArtifactsCommit {
  hash: string;
  treeHash: string;
  message: string;
  parents: string[];
  author: { name: string; email: string };
  committer: { name: string; email: string };
  authoredAt: number;
  committedAt: number;
}

export interface ArtifactsTreeItem {
  name: string;
  /** git mode as Artifacts reports it (`40000` for trees, no leading zero) */
  mode: string;
  hash: string;
  type: 'tree' | 'blob' | 'symlink' | 'gitlink' | 'exec';
}

export interface ArtifactsTransport {
  readonly kind: 'binding' | 'rest';
  createRepo(namespace: string, name: string, opts?: { description?: string; defaultBranch?: string }): Promise<ArtifactsCreatedRepo>;
  getRepo(namespace: string, name: string): Promise<ArtifactsRepoInfo | null>;
  /** true if deleted, false if it did not exist */
  deleteRepo(namespace: string, name: string): Promise<boolean>;
  createToken(namespace: string, repo: string, scope: 'read' | 'write', ttlSeconds: number): Promise<ArtifactsTokenMinted>;
  /** every token of the repo (all states); metadata only */
  listTokens(namespace: string, repo: string): Promise<ArtifactsTokenInfo[]>;
  /** true if revoked, false if not found */
  revokeToken(namespace: string, repo: string, tokenId: string): Promise<boolean>;
  /** first-parent history from `ref` (short name or sha), newest first; `[]` when unresolved */
  log(namespace: string, repo: string, opts: { ref: string; limit?: number }): Promise<ArtifactsCommit[]>;
  readCommit(namespace: string, repo: string, sha: string): Promise<ArtifactsCommit | null>;
  readTree(namespace: string, repo: string, treeSha: string): Promise<ArtifactsTreeItem[] | null>;
  /** file bytes at `ref` (short name or sha), or null when the ref/path does not resolve to a file */
  readFile(namespace: string, repo: string, ref: string, path: string): Promise<Uint8Array | null>;
}
