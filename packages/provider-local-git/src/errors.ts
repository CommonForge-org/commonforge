/**
 * Errors raised by {@link LocalGitProvider}. Codes mirror the Artifacts provider's where the
 * meaning is the same, so a consumer can handle both providers alike. Freeze and credential
 * refusals use core's `FreezeErrorCodeSchema` codes.
 */
import { CoreError, type ProviderErrorCode } from '@commonforge-org/core';

/** A superset of core's shared {@link ProviderErrorCode} (same meanings), plus provider-specific codes. */
export type LocalGitProviderErrorCode =
  | ProviderErrorCode
  /** a credential, freeze or collect was attempted on a canonical repository */
  | 'canonical_namespace_refused'
  /** the handle's coords are not the task repository this provider recorded for it */
  | 'namespace_refused'
  /** write credential or freeze requested for a workspace that is not (really) writable */
  | 'workspace_not_writable'
  /** freeze: task branch head ≠ expectedSha */
  | 'candidate_moved'
  /** freeze: the head moved while write access was being revoked */
  | 'candidate_moved_during_freeze'
  | 'invalid_input'
  /** a RevisionId that does not belong to this resource's repositories */
  | 'revision_mismatch'
  | 'not_found'
  | 'ref_unresolved'
  | 'already_exists'
  /** `resolveRevision({ kind: 'accepted' })` without an `acceptedHead` resolver */
  | 'accepted_head_unavailable'
  /** the injected RunnerSubmit returned `ok: false` */
  | 'runner_failed'
  /** the runner returned a receipt that does not match the job */
  | 'receipt_mismatch'
  /** prepare was asked for a workspace that was already collected */
  | 'workspace_collected'
  /** a registry record on disk is unreadable or malformed */
  | 'state_corrupt'
  /** a git command failed unexpectedly */
  | 'git_failed';

export class LocalGitProviderError extends CoreError<LocalGitProviderErrorCode> {
  constructor(code: LocalGitProviderErrorCode, message?: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'LocalGitProviderError';
  }
}

export function isLocalGitProviderError(e: unknown, code?: LocalGitProviderErrorCode): e is LocalGitProviderError {
  return e instanceof LocalGitProviderError && (code === undefined || e.code === code);
}
