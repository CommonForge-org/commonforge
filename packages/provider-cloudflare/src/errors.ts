/**
 * Errors raised by the Cloudflare providers. Every error has a stable `code`; messages and details
 * are passed through {@link redactSecrets} so a token can never leak through an error or a log line.
 */
import { CoreError, type ProviderErrorCode } from '@commonforge-org/core';

/** A superset of core's shared {@link ProviderErrorCode} (same meanings), plus provider-specific codes. */
export type ArtifactsProviderErrorCode =
  | ProviderErrorCode
  /** a credential, freeze or delete was attempted on a canonical-namespace repo */
  | 'canonical_namespace_refused'
  /** the handle's namespace is not this provider's `-tasks` namespace */
  | 'namespace_refused'
  /** write credential or freeze requested for a handle that is not `writable` */
  | 'workspace_not_writable'
  /** freeze: fork HEAD ≠ expectedSha before revocation */
  | 'candidate_moved'
  /** freeze: fork HEAD changed after revocation (after one retry) */
  | 'candidate_moved_during_freeze'
  /** freeze: write tokens kept reappearing (concurrent mints) after the bounded revoke rounds */
  | 'freeze_incomplete'
  /** the handle's repoId does not match the repository that exists under its name */
  | 'repo_mismatch'
  /** the grant's leaseGeneration is not the workspace's current lease generation */
  | 'lease_stale'
  /** the remaining task lease is shorter than the Artifacts minimum TTL (60 s) */
  | 'lease_too_short'
  | 'invalid_input'
  /** a RevisionId does not belong to this resource's repo */
  | 'revision_mismatch'
  | 'not_found'
  /** a ref selector could not be resolved (REST/binding return `[]`, never 404) */
  | 'ref_unresolved'
  | 'already_exists'
  /** Artifacts returned 5xx / INTERNAL_ERROR; safe to retry only after an idempotent lookup */
  | 'provider_unavailable'
  /** any other Artifacts API refusal */
  | 'provider_error'
  /** no binding configured for a namespace (binding transport) */
  | 'binding_missing'
  /** no runner configured / the seed-workspace job failed or did not produce the base sha */
  | 'seed_failed'
  /** trees differ and no compare delegate is configured (plan §B.6 P0: compare runs in the runner) */
  | 'compare_unavailable'
  /** the ledger head is not known to the provider (no `acceptedHead` resolver configured) */
  | 'accepted_head_unavailable'
  /** the operation needs a signed runner job the interface cannot carry */
  | 'not_supported'
  /** the injected RunnerSubmit returned `ok: false` */
  | 'runner_failed'
  /** the runner returned a receipt that does not match the job */
  | 'receipt_mismatch';

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Authorization headers (before the token pattern so the header keeps its shape).
  [/Bearer\s+[A-Za-z0-9_\-.~+/=?]+/gi, 'Bearer <redacted>'],
  // Artifacts repo tokens (art_v1_…, art_v2_x_… seen live 2026-10-06, optional ?expires=).
  [/art_v\d+_[A-Za-z0-9_]+(?:\?expires=\d+)?/g, '<redacted>'],
  // VibeControl resource tokens.
  [/vc-resource-v1\.[A-Za-z0-9_\-.]+/g, '<redacted>'],
  // userinfo in URLs.
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1<redacted>@'],
];

/** Replace every known secret shape in `s`; extra literal secrets (e.g. the API token) are replaced too. */
export function redactSecrets(s: string, extraSecrets: readonly string[] = []): string {
  let out = s;
  for (const secret of extraSecrets) if (secret && secret.length >= 8) out = out.split(secret).join('<redacted>');
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

function redactDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const json = JSON.stringify(details, (_k, v: unknown) => (typeof v === 'string' ? redactSecrets(v) : v));
  return JSON.parse(json) as Record<string, unknown>;
}

export class ArtifactsProviderError extends CoreError<ArtifactsProviderErrorCode> {
  /** HTTP status (REST) when the error came from the Artifacts API. */
  readonly status: number | undefined;

  constructor(code: ArtifactsProviderErrorCode, message?: string, details?: Record<string, unknown>, status?: number) {
    super(code, message === undefined ? undefined : redactSecrets(message), redactDetails(details));
    this.name = 'ArtifactsProviderError';
    this.status = status;
  }
}

export function isArtifactsProviderError(e: unknown, code?: ArtifactsProviderErrorCode): e is ArtifactsProviderError {
  return e instanceof ArtifactsProviderError && (code === undefined || e.code === code);
}
