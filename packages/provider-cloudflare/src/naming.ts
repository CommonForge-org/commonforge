/**
 * Artifacts naming (plan §A.7): one namespace per (environment prefix, org, role).
 *
 *   <prefix>-<orgId>-canonical   canonical repos, one per Resource (repo name = resourceId)
 *   <prefix>-<orgId>-tasks       task workspaces, one per (task, resource) (repo name = ws-<taskWorkspaceId>)
 *   <prefix>-<orgId>-editions    client edition repos (repo name = ed-<editionId>)
 *
 * The prefix comes from config (`COMMONFORGE_NAMESPACE_PREFIX`: commonforge-dev, commonforge-ci, …).
 * Namespaces are partitioned deliberately: Artifacts rate limits are per namespace, so task-fork
 * churn in `-tasks` cannot starve canonical reads.
 */
import { IdSegmentSchema } from '@commonforge-org/core';
import { ArtifactsProviderError } from './errors.js';

export type NamespaceKind = 'canonical' | 'tasks' | 'editions';
export const NAMESPACE_KINDS: readonly NamespaceKind[] = ['canonical', 'tasks', 'editions'];

/** Default prefix used by spikes and live tests when `COMMONFORGE_NAMESPACE_PREFIX` is unset. */
export const DEFAULT_NAMESPACE_PREFIX = 'commonforge-spike';

/** Max namespace length accepted by `ArtifactsCoordsSchema`. */
export const MAX_NAMESPACE_LENGTH = 128;

const PREFIX_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

export function assertNamespacePrefix(prefix: string): string {
  if (!PREFIX_RE.test(prefix)) {
    throw new ArtifactsProviderError('invalid_input', `namespace prefix must match ${PREFIX_RE}`, { prefix });
  }
  return prefix;
}

function assertId(value: string, label: string): string {
  if (!IdSegmentSchema.safeParse(value).success) {
    throw new ArtifactsProviderError('invalid_input', `${label} is not a valid id segment`, { [label]: value });
  }
  return value;
}

/** `<prefix>-<orgId>-<kind>`. */
export function namespaceFor(prefix: string, orgId: string, kind: NamespaceKind): string {
  assertNamespacePrefix(prefix);
  assertId(orgId, 'organizationId');
  const ns = `${prefix}-${orgId}-${kind}`;
  if (ns.length > MAX_NAMESPACE_LENGTH) {
    throw new ArtifactsProviderError('invalid_input', `namespace longer than ${MAX_NAMESPACE_LENGTH} chars`, { namespace: ns });
  }
  return ns;
}

/** Inverse of {@link namespaceFor} for this prefix; null when `ns` is not one of ours. */
export function parseNamespace(prefix: string, ns: string): { organizationId: string; kind: NamespaceKind } | null {
  const head = `${prefix}-`;
  if (!ns.startsWith(head)) return null;
  for (const kind of NAMESPACE_KINDS) {
    const tail = `-${kind}`;
    if (ns.endsWith(tail) && ns.length > head.length + tail.length) {
      const organizationId = ns.slice(head.length, ns.length - tail.length);
      return IdSegmentSchema.safeParse(organizationId).success ? { organizationId, kind } : null;
    }
  }
  return null;
}

/**
 * True for any canonical namespace, whatever its prefix. Used as a conservative fence: a handle in
 * such a namespace never receives a credential and is never deleted by the provider.
 */
export function isCanonicalNamespace(ns: string): boolean {
  return ns.endsWith('-canonical');
}

/** Canonical repo name for a Resource. */
export function canonicalRepoName(resourceId: string): string {
  return assertId(resourceId, 'resourceId');
}

/** Task workspace repo name. */
export function taskWorkspaceRepoName(taskWorkspaceId: string): string {
  return `ws-${assertId(taskWorkspaceId, 'taskWorkspaceId')}`;
}

/** Inverse of {@link taskWorkspaceRepoName}; null when the name is not a task workspace repo. */
export function parseTaskWorkspaceRepoName(name: string): string | null {
  if (!name.startsWith('ws-')) return null;
  const id = name.slice(3);
  return IdSegmentSchema.safeParse(id).success ? id : null;
}

/** Edition repo name. */
export function editionRepoName(editionId: string): string {
  return `ed-${assertId(editionId, 'editionId')}`;
}

export function assertRepoName(name: string): string {
  if (!REPO_NAME_RE.test(name)) throw new ArtifactsProviderError('invalid_input', 'invalid repo name', { name });
  return name;
}

/** Git smart-HTTP remote: `https://<accountId>.artifacts.cloudflare.net/git/<ns>/<repo>.git` (plan §0.2). */
export function artifactsRemoteUrl(accountId: string, namespace: string, repoName: string): string {
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new ArtifactsProviderError('invalid_input', 'accountId must be 32 hex chars');
  return `https://${accountId}.artifacts.cloudflare.net/git/${encodeURIComponent(namespace)}/${encodeURIComponent(assertRepoName(repoName))}.git`;
}
