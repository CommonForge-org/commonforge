/**
 * HTTP error model shared by every route: `{ "error": { "code", "message", "details"? } }` with a
 * stable machine-readable `code` (documented in API.md). Messages are for humans and may change.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { ProjectError } from '@commonforge-org/core';
import { parseLedgerRpcError } from "../ledger/errors.js";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "ApiError";
  }
}

export const badRequest = (code: string, message?: string, details?: Record<string, unknown>) => new ApiError(400, code, message, details);
export const unauthorized = (message = "authentication required") => new ApiError(401, "unauthenticated", message);
export const forbidden = (code = "forbidden", message?: string) => new ApiError(403, code, message);
/** Used for anything the caller may not know exists (no existence leak across grants/orgs). */
export const notFound = (what = "not found") => new ApiError(404, "not_found", what);
export const conflict = (code: string, message?: string, details?: Record<string, unknown>) => new ApiError(409, code, message, details);

export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

/** Parse a JSON body with a zod schema; malformed JSON or schema errors are 400 `invalid_request`. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    if (text.length > 0 && !/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
      throw new ApiError(415, "unsupported_media_type", "send JSON with content-type: application/json");
    }
    raw = text.length === 0 ? {} : JSON.parse(text);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw badRequest("invalid_request", "body is not valid JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw badRequest("invalid_request", r.error.issues.map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`).join("; "));
  }
  return r.data;
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw badRequest("invalid_request", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

/** Map any thrown error to a JSON response (ApiError, ledger RPC errors, zod, provider errors). */
export function toErrorResponse(c: Context, e: unknown): Response {
  if(e instanceof ProjectError)return c.json(errorBody(e.code,e.message),e.code==='authority_denied'?403:409);
  if (e instanceof ApiError) return c.json(errorBody(e.code, e.message, e.details), e.status);
  if (e instanceof z.ZodError) return c.json(errorBody("invalid_request", e.message), 400);
  const message = e instanceof Error ? e.message : String(e);
  const projectRefusal = /project_refused:([a-z_]+): (.*)/s.exec(message);
  if (projectRefusal) return c.json(errorBody(projectRefusal[1]!, projectRefusal[2]!), projectRefusal[1] === 'authority_denied' ? 403 : 409);
  if (/^ledger_[a-z_]+: /.test(message)) {
    const { code, status } = parseLedgerRpcError(e);
    return c.json(errorBody(code, message), status as ContentfulStatusCode);
  }
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && PROVIDER_STATUS[code]) {
    // the provider's message can name task repositories or namespaces: callers that are not
    // developers (clients and their agents, viewers) get a fixed plain message with the same code
    const plain = c.get("plainProviderErrors") === true;
    return c.json(errorBody(code, plain ? plainProviderMessage(code) : message), PROVIDER_STATUS[code]);
  }
  console.error("unhandled error", message);
  return c.json(errorBody("internal", "internal error"), 500);
}

/** The fixed message a non-developer gets for a provider error: the code, never the provider's text. */
export function plainProviderMessage(code: string): string {
  return code === "provider_unavailable" ? "The workspace service is unavailable; try again." : `This task's workspace could not be updated (${code}).`;
}

/** Engine error codes (provider, R2, asset token, core, runner-protocol) surfaced to callers. */
const PROVIDER_STATUS: Record<string, ContentfulStatusCode> = {
  provider_unavailable: 503,
  candidate_moved: 409,
  candidate_moved_during_freeze: 409,
  freeze_incomplete: 409,
  workspace_not_writable: 409,
  lease_stale: 409,
  lease_too_short: 409,
  already_exists: 409,
  repo_mismatch: 409,
  revision_mismatch: 400,
  canonical_namespace_refused: 403,
  namespace_refused: 403,
  not_found: 404,
  invalid_input: 400,
  invalid_path: 400,
  ref_unresolved: 404,
  asset_size_mismatch: 400,
  asset_sha256_mismatch: 400,
  asset_object_missing: 409,
  asset_object_conflict: 409,
  asset_staging_missing: 409,
  asset_wrong_organization: 403,
  asset_token_invalid: 403,
  asset_token_expired: 403,
  asset_token_scope: 403,
  asset_invalid_input: 400,
  asset_manifest_parent_missing: 409,
  asset_manifest_corrupt: 500,
  asset_grant_denied: 403,
  seed_failed: 502,
  runner_failed: 502,
  receipt_mismatch: 502,
  compare_unavailable: 503,
  not_supported: 501,
  // core
  invalid_id: 400,
  invalid_revision_id: 400,
  invalid_candidate_id: 400,
  invalid_proposal: 400,
  invalid_snapshot: 400,
  invalid_manifest: 400,
  // runner-protocol (materialization planning)
  invalid_job: 500,
  secret_in_job: 500,
  materialization_unauthorized: 403,
  materialization_unsupported: 409,
  workspace_not_in_snapshot: 409,
  workspace_base_mismatch: 409,
  secret_in_workspace: 500,
  invalid_materialization_input: 400,
  invalid_plan: 400,
  snapshot_id_mismatch: 500,
};
