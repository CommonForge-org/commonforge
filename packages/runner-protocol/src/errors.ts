import { CoreError } from '@commonforge-org/core';

/** Stable codes raised by `@commonforge-org/runner-protocol`. */
export type RunnerProtocolErrorCode =
  | 'invalid_job'
  | 'weak_job_key'
  | 'secret_in_job'
  | 'invalid_evidence'
  | 'snapshot_id_mismatch'
  | 'materialization_unauthorized'
  | 'materialization_unsupported'
  | 'workspace_not_in_snapshot'
  | 'workspace_not_writable'
  | 'workspace_base_mismatch'
  | 'manifest_mismatch'
  | 'secret_in_workspace'
  | 'workspace_not_empty'
  | 'workspace_root_invalid'
  | 'git_failed'
  | 'asset_fetch_unavailable'
  | 'asset_hash_mismatch'
  | 'unsafe_path'
  | 'invalid_materialization_input'
  | 'invalid_plan';

export class RunnerProtocolError extends CoreError<RunnerProtocolErrorCode> {
  constructor(code: RunnerProtocolErrorCode, message?: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'RunnerProtocolError';
  }
}
