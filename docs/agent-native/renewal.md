# Explicit task authority renewal

Renewal creates a replacement mandate, attempt, lease and pinned context. It does not extend an
old token or rewrite an existing checkout. An owner or authorized developer must authorize the
replacement; agents cannot renew themselves. Previous task mandates and attempts remain revoked.

Read the authoritative project state to obtain the current project `generation` and the prior
mandate's exact `id` and `revision`. The human's authenticated API request is:

```text
POST /api/tasks/:taskId/native/renew
```

```json
{
  "mandateId": "<prior mandate id>",
  "revision": 1,
  "expectedGeneration": 12,
  "idempotencyKey": "<unique renewal request key>",
  "agentId": "<agent or client identity>"
}
```

This checks current project/task access, ownership of an active lease when applicable, the exact
prior task mandate and project generation. It returns a one-use task code with a 15-minute exchange
window and `requiresFreshCheckout: true`. The replacement mandate lasts at most one hour from
issuance, with the existing one-attempt/ten-job limits. Expired prior authority can be replaced;
explicitly revoked or superseded authority cannot be resurrected through this endpoint.

Exact retries before exchange return the same secret-key-derived code without storing its raw
value in the ledger. Changed request content under the same key is refused. A consumed, expired
or superseded replacement is refused rather than returning a code described as usable. If exchange
already succeeded, use its stored task lease; if unavailable, request another fresh handoff.

The agent exchanges the human-issued replacement into a new empty workspace:

```sh
cforge renew --api-url https://forge.example.com --code '<replacement code>' --out ./task-renewed-unique
```

The structured MCP equivalent is `renew_task_authority` with `code`, absolute `folder` and optional
`api_url`. The native owner handoff panel uses a unique renewal checkout directory when a previous
lease exists. Initial handoff behavior is unchanged.

The CLI validates the context and lease binding, stores only the task credential in its existing
protected config directory, performs a verified source checkout, and rechecks current authority
and context after materialization. Only then does it return success. Existing/nonempty destinations
and an overriding `CFORGE_LEASE_TOKEN` are refused before consuming the one-use code. A checkout
failure after exchange is reported as a failure with a retry instruction; it does not claim that
a usable fresh checkout was produced. Preserve the previous checkout as history and reapply useful
changes under the newly pinned requirements. Old evidence and decisions do not become applicable
to the replacement attempt automatically.

The generic `renewMandate` project command is refused with `project_mode_unsupported`; changing
only its expiry/revision would leave the task lease and prior attempt inconsistent. Direct token
extension is not supported.

Validation: Worker renewal security tests exercise real D1/SQLite state, current-context inheritance,
clock advancement past the previous expiry, CAS/idempotency races and concurrent one-use exchange;
source/runner transports there are explicit doubles. CLI renewal tests use actual local Git
materialization with a fake control plane and verify that revocation during checkout prevents a
success response. These tests make no cloud-provider or live-release claim. Existing provider
credentials can have a bounded residual lifetime; authoritative task access is revoked immediately,
and workspace provider write tokens are revoked during replacement exchange.
