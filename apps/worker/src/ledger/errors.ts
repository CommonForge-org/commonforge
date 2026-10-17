/**
 * Stable error codes for `OrgLedger` RPC failures.
 *
 * Errors cross the DO RPC boundary as plain `Error`s (custom classes and properties are lost), so
 * every error thrown by an RPC method has a message of the form `"<code>: <detail>"` where `<code>`
 * is one of {@link LEDGER_RPC_ERROR_CODES}. Callers (the Worker API, Task 16) map it to HTTP with
 * {@link parseLedgerRpcError}:
 *
 * | code                        | HTTP | meaning |
 * |-----------------------------|------|---------|
 * | `ledger_invalid_input`      | 400  | schema-invalid input, `LedgerInputError`, timestamp in the future (`LedgerRecordError` `record_invalid_input`) |
 * | `ledger_not_found`          | 404  | referenced proposal does not exist |
 * | `ledger_wrong_organization` | 403  | the ledger serves a different organization |
 * | `ledger_conflict`           | 409  | immutable field changed, terminal state, write-once record differs, monotonic value went backwards, UNIQUE violation (incl. the ledger package's `LedgerRecordError` `record_conflict`) |
 * | `ledger_internal`           | 500  | anything else (a bug) |
 *
 * A policy refusal of `accept`/`restore`/`bindHead` is not an error: it is a returned
 * `{ ok: false, code }` decision (map those to 409 / 412 as the API sees fit).
 */
import { LedgerRecordError, type LedgerRecordErrorCode } from '@commonforge-org/ledger';
import { z } from 'zod';
import { ProjectError } from '@commonforge-org/core';

export const LEDGER_RPC_ERROR_CODES = [
  'ledger_invalid_input',
  'ledger_not_found',
  'ledger_wrong_organization',
  'ledger_conflict',
  'ledger_internal',
] as const;
export type LedgerRpcErrorCode = (typeof LEDGER_RPC_ERROR_CODES)[number];

export const LEDGER_RPC_ERROR_STATUS: Readonly<Record<LedgerRpcErrorCode, number>> = {
  ledger_invalid_input: 400,
  ledger_not_found: 404,
  ledger_wrong_organization: 403,
  ledger_conflict: 409,
  ledger_internal: 500,
};

export class LedgerRpcError extends Error {
  constructor(
    readonly code: LedgerRpcErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'LedgerRpcError';
  }
}

export function ledgerError(code: LedgerRpcErrorCode, detail: string): LedgerRpcError {
  return new LedgerRpcError(code, detail);
}

function hasCode(message: string): LedgerRpcErrorCode | null {
  const prefix = message.split(':', 1)[0] ?? '';
  return (LEDGER_RPC_ERROR_CODES as readonly string[]).includes(prefix) ? (prefix as LedgerRpcErrorCode) : null;
}

const RECORD_ERROR_CODE: Readonly<Record<LedgerRecordErrorCode, LedgerRpcErrorCode>> = {
  record_conflict: 'ledger_conflict',
  record_invalid_input: 'ledger_invalid_input',
};

/** Map any error raised inside the DO to a coded `LedgerRpcError` (used by every RPC method). */
export function toLedgerRpcError(e: unknown): LedgerRpcError {
  // Preserve stable G1 refusal codes across RPC rather than wrapping them as ledger_internal.
  if (e instanceof ProjectError) throw new Error(`project_refused:${e.code}: ${e.message}`);
  if (e instanceof LedgerRpcError) return e;
  if (e instanceof LedgerRecordError) return new LedgerRpcError(RECORD_ERROR_CODE[e.code], e.detail);
  const message = e instanceof Error ? e.message : String(e);
  const coded = hasCode(message);
  if (coded) return new LedgerRpcError(coded, message.slice(coded.length + 2));
  if (e instanceof z.ZodError || (e instanceof Error && e.name === 'ZodError')) return new LedgerRpcError('ledger_invalid_input', message);
  if (e instanceof Error && (e as { code?: unknown }).code === 'invalid_ledger_input') return new LedgerRpcError('ledger_invalid_input', message);
  if (/UNIQUE constraint failed|write-once|already bound/.test(message)) return new LedgerRpcError('ledger_conflict', message);
  return new LedgerRpcError('ledger_internal', message);
}

/** Caller side: recover the code and HTTP status from an error received over RPC. */
export function parseLedgerRpcError(e: unknown): { code: LedgerRpcErrorCode; status: number; message: string } {
  const message = e instanceof Error ? e.message : String(e);
  const code = hasCode(message) ?? 'ledger_internal';
  return { code, status: LEDGER_RPC_ERROR_STATUS[code], message };
}
