/**
 * Error types shared by every CommonForge engine package.
 *
 * Every engine error carries a stable machine-readable `code`; messages are for humans and may change.
 */

/** Codes raised by `@commonforge-org/core` itself. Other packages may extend with their own string codes. */
export type CoreErrorCode =
  | 'invalid_id'
  | 'invalid_revision_id'
  | 'invalid_candidate_id'
  | 'invalid_canonical_json'
  | 'invalid_path'
  | 'invalid_snapshot'
  | 'invalid_manifest'
  | 'invalid_proposal'
  | 'invalid_edition_return'
  | 'invalid_transition'
  | 'invalid_input'
  | 'provider_capability_unsupported';

export class CoreError<C extends string = CoreErrorCode> extends Error {
  readonly code: C;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: C, message?: string, details?: Record<string, unknown>) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'CoreError';
    this.code = code;
    this.details = details;
  }
}

/** Reasons {@link normalizePath} refuses a path. */
export type PathViolation =
  | 'empty'
  | 'nul'
  | 'control_char'
  | 'backslash'
  | 'absolute'
  | 'drive_letter'
  | 'dot_dot'
  | 'too_long';

export class PathPolicyError extends CoreError<'invalid_path'> {
  readonly violation: PathViolation;
  readonly input: string;

  constructor(violation: PathViolation, input: string) {
    super('invalid_path', violation, { violation });
    this.name = 'PathPolicyError';
    this.violation = violation;
    this.input = input;
  }
}

export function isCoreError(e: unknown): e is CoreError<string> {
  return e instanceof CoreError;
}
