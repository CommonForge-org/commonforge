# Dedicated G1 isolated-CI rehearsal

`apps/runner/src/g1-cloud-rehearsal.ts` prepares and executes the G1 live gate through the
real public API, Artifacts Git, existing Sandbox runner, pinned workerd scenario supervisor,
and existing gated release services. The actual 2026-10-17 isolated run passed; see
[evidence/live-cloud-report.json](evidence/live-cloud-report.json) and
[execution status](execution-status.md). The instructions below support a new operator run;
local preparation tests alone do not establish its cloud result.

The executable refuses production control-plane origins and release names. It accepts only
`https://commonforge-ci-worker.<account-subdomain>.workers.dev`, `commonforge-ci-worker`, and
release target `cfci-<orgId>-g1-<runId>`. It provisions no D1, KV, R2, queue, container service,
or tunnel. Existing owner-approved CI infrastructure and an explicitly reviewed deployment
must already be available. The stateless synthetic target has plain vars, one bundled Worker,
and no persistent bindings, migrations, messages, payments, or external effects.

Use the existing `scripts/ci-live/lib.ts` `Tail.start` and `cliSignIn` helpers to obtain an
owner session through the CI log-mode magic link and built `cforge`. Keep its session JSON
private. The rehearsal consumes that session; it never gives it to a task-scoped agent.
Operational phases reuse the existing CI polling/secret helpers and reject a production target.
The `plan` phase does not import those helpers, read credentials, or contact any network.

Private operator config example (replace placeholders; flags start false):

```json
{
  "schemaVersion": 1,
  "runId": "an21-run",
  "apiUrl": "https://commonforge-ci-worker.example.workers.dev",
  "accountId": "00000000000000000000000000000000",
  "organizationId": "o-0123456789ab",
  "ownerSessionFile": "/private/ci-owner/session.json",
  "stateDirectory": "/private/g1-live-run",
  "controlWorker": "commonforge-ci-worker",
  "targetPrefix": "cfci",
  "mutationsApproved": false,
  "deploymentApproved": false,
  "supervisorPort": 8971,
  "pin": { "binary": "/operator/pinned/workerd", "sha256": "<actual binary SHA256>" },
  "schema": "/operator/pinned/workerd.capnp"
}
```

Run from the repository root through the existing runner package:

```sh
pnpm --filter @commonforge-org/runner exec tsx src/g1-cloud-rehearsal.ts plan /private/config.json
```

After the exact isolated target is reviewed and authorized, the operator sets
`mutationsApproved:true`; `deploymentApproved:true` additionally permits explicit release
deployment. These fields record operator execution scope; they do not create authorization.

1. `setup` creates a fresh native project and dedicated `api` source folder through actual
   Sandbox initialization, then installs the stateless release policy. It writes private
   `supervisor-registration.json` with exact source repo identity, recipe, full release
   environment and pinned workerd toolchain. The owner session must already own the configured org.
2. Start `g1-cloudflare-server.ts` with that registration and its existing supervisor-only
   Artifacts credential and CI job key. Expose it only through the authorized HTTPS verifier
   transport. Configure the CI control plane's verifier URL through its established isolated
   deployment workflow. Add that exact origin as `trustedSupervisorUrl` in the private config.
   No candidate receives provider credentials, keys, registration control, or harness write access.
3. `run` confirms the corrected synthetic rule and nine independently pinned scenarios. It
   issues a scoped handoff, performs real Git clone/edit/push/freeze, Sandbox integration,
   scenario verification, exact owner-role decision, and atomic acceptance. It builds a release,
   separately approves its output digest, deploys only the exact `cfci-...` target, checks actual
   `/version`, checks all nine scenarios over deployed HTTPS, and requires a persisted healthy
   observation bound to the manifest and actual release output. Scripted owner-role decisions
   are recorded as synthetic operations, not observed human usability validation.
4. `expiry` reads the actual release after its five-minute freshness deadline. Calling it early
   returns `not_run` and the exact `waitUntil`; it never changes a clock or fabricates expiry.
   Repeat after that real deadline and require `healthState:unknown` before continuing.
5. `recover` implements and deploys a second distinct source variant, prepares native recovery
   to the first exact accepted manifest under the current rule, runs nine fresh checks, obtains
   an exact owner-role decision, accepts, and creates a new explicit release. It requires the
   historical variant to answer on the actual target, all nine live scenarios to pass, and a new
   correctly bound healthy observation. Knowledge must remain unchanged.
6. `inspect` refreshes authoritative state and emits `public-report.json` containing synthetic
   identifiers, exact subjects, digests, observations and explicit gates. Until actual remote
   phases pass, every absent gate remains `not_run`.

Invoke each phase with the same command shape as `plan`. `checkpoint.json` is private and
contains task leases, workspace coordinates and completed operation state. It must never be
committed or uploaded as public evidence. Checkpoints retain exact run/runtime scope and permit
continuation after completed steps; a failed external operation still requires inspection.
Do not change a recipe, account, target or run identity to make an existing checkpoint pass.
Setup refuses name-only adoption of an existing project without this run’s recorded identifier.
Source commits persist their intended SHA and exact base before pushing; retries verify the actual
remote ref, accept an already-landed intended commit and refuse concurrent foreign movement.

There is no automatic infrastructure deletion, production rollback, source deletion, or cleanup
of another project. Retain accepted manifests and evidence. Use the existing CI cleanup tooling
only within its separately authorized exact target scope after preserving the public report.

Local preparation tests execute real isolated builds and workerd against both generated source
variants, without a cloud call:

```sh
pnpm --filter @commonforge-org/runner exec vitest run test/g1-cloud-rehearsal.test.ts
```

A passing local test proves toolchain/recipe/fixture readiness, not AN-21. Only the actual remote
release, real freshness deadline, and explicit recovery deployment can substantiate that gate.
