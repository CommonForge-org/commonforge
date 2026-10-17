# Native release bridge and outstanding live gate

G1 production release preparation binds the latest verified accepted project manifest, current
knowledge/policy, exact source revisions, and exact runtime recipe/environment digest. The native
binding is immutable and inserted with the release row before a build job is enqueued. Publishing
and deployment recheck it; a release prepared before native enablement cannot be published or
deployed afterward. Shared staging is unsupported for enabled projects.

`scenarioBuildDigest` identifies the verified **source revision set**. It does not hash compiled
deployment files. The release `outputDigest` separately identifies the signed runner's built files
and deploy configuration, and publish approval binds that output. G1 does not claim scenario tests
executed against those rebuilt deployment bytes. The runtime digest must equal
`nativeRuntimeRecipeDigest(recipe, environment)`; the environment is the exact existing release
`ReleaseEnvironment`, including account, targets, production environment, health check and migrations.
A local Node fixture runner's different runtime cannot authorize production: the bridge fails closed.
The separate workerd adapter below uses the release-compatible recipe/environment domain.

Release health observes the actual deployed release's existing configured identity/HTTP check,
records an observation against its manifest and output digest, and expires after five minutes.
Expired or missing observations return `unknown`. A healthy release identity check does not prove
business scenario correctness. Acceptance, publishing, deployment and health remain separate states.
Native failures require explicit recovery under current project requirements; the owner history
recovery UI/API now prepares and verifies exact old source as a newly accepted local manifest; automatic rollback
of earlier artifacts is disabled for enabled projects. External effects and database migrations
are never represented as automatically reverted.

## Dedicated isolated Cloudflare rehearsal

This task does not authorize deployment of the candidate into the running control plane. A live
G1 rehearsal needs a separate Cloudflare account/namespace, owner-approved release policy, disposable
demo-only D1/KV/R2, runner job keys stored in its supervisor, a real Sandbox/runner, and an external
Git/bootstrap recovery route. Its scenario verifier must execute the deployment runtime and bind
its exact recipe/environment; the current source-only local verifier is insufficient to claim
compiled-byte scenario verification.

After provisioning that isolated stack and configuring the bounded matching runtime adapter below,
run the existing account connectivity and provider gates with `pnpm test:live` from the repository
root, then execute the native API workflow: confirm rules/scenarios; issue a bounded task handoff;
submit an envelope with its exact source/runtime digests; request real verification; record the
exact decision; accept; prepare release; inspect signed build outputs; publish approval; deploy;
observe the resulting release and wait past the freshness bound to verify `unknown`.

`pnpm test:live` alone is the legacy live suite and is not the dedicated G1 acceptance gate. No
successful G1 Cloudflare run is claimed here. The bounded executable supervisor below is locally
verified; it still needs an authorized isolated target and remote integration rehearsal. Record the
command, revision, credentials-free artifact paths, account isolation, deployment identity and
observations in `execution-status.md` before marking that gate verified. Until then the live G1
release gate remains unverified.


## Locally verified Cloudflare runtime adapter

`apps/runner/src/g1-cloudflare-source.ts` builds the exact registered three-file Git snapshot in a
network/mount/PID namespace. `g1-cloudflare-verifier.ts` executes the immutable resulting bytes/config
in a pinned actual workerd binary under a second namespace. The independent nine scheduling scenarios
run over HTTP; no Node fallback, candidate harness, controller mount or cloud credentials are present
inside either candidate process. Verifier identity includes supervisor/source-build code, examples,
workerd binary/schema, Node binary/version and architecture. A wrong binary/output receipt fails closed.

Supported shape is one recipe step `node build.mjs`, one bundled Worker target with outputPath `dist`
and main `worker.mjs`, JSON `wrangler.json`, plain vars and compatibility flags. KV, D1, migrations,
assets, extra modules and general install commands are refused. This is the scheduling reference
adapter, not arbitrary Cloudflare compatibility. The fixture build explicitly removes exported value
constants, which actual workerd rejects; that build script is part of the exact source snapshot.

Run the actual local proofs without cloud credentials:

```sh
pnpm --filter @commonforge-org/runner exec vitest run test/g1-cloudflare-verifier.test.ts test/g1-cloudflare-source.test.ts test/g1-cloudflare-bridge.test.ts test/g1-cloudflare-server.test.ts
```

The Artifacts-backed executable is:

```sh
pnpm --filter @commonforge-org/runner exec tsx src/g1-cloudflare-server.ts /private/operator-config.json
```

The private operator JSON contains `port`, source `accountId`, `pin: {binary,sha256}`, workerd
`schema` path, the exact server-owned release `recipe`, full release `environment`, and `resources`.
Each resource registration fixes `{organizationId,projectId,resourceId,namespace,repoName,repoId,pathPrefix}`.
Only registered exact `art:<repoId>:<sha>` revisions are read; request data cannot select namespaces,
repositories or filesystem paths. `pathPrefix` is empty or slash-terminated simple path segments.
`resources` registers the scheduling Worker source, build.mjs and wrangler.json together.
The full environment is the existing release environment, including targets, accountId, per-target
vars/bindings, healthCheck and optional migrations; copying just target names yields a different digest.

Set `CF_API_TOKEN` and `COMMONFORGE_RUNNER_JOB_KEY` only in the supervisor environment, with the latter
matching the isolated control plane's k1 signing secret. Candidate processes receive neither. Serve
the loopback listener behind an operator-managed HTTPS endpoint, then configure the isolated Worker's
`COMMONFORGE_SCENARIO_RUNNER_URL` to that endpoint. The Worker refuses HTTP/auth/query/fragment/local
remote URLs, does not follow redirects, and validates explicit protocol capabilities plus signed
exact-subject results. Existing localhost-only Node configuration remains unchanged. No endpoint,
account, credential or deployment was configured by this task.

The actual signed bridge/Git/workerd tests establish the adapter and source binding. The REST source
registration test uses a transport double; real remote Artifacts access remains part of the live gate.
Scenario evidence still binds source+recipe, not a guarantee that a later production rebuild has
identical bytes. Publish approval separately binds that release's outputDigest. Retain external CI/Git
as the recovery bridge and complete AN-21 before describing G1 as achieved.


Local recovery is now exercised end-to-end by `pnpm test:g1:local`: human-role browser preparation,
fresh signed current scenarios, exact decision, atomic restore, actual canonical Git reconciliation
and repeated isolated behavior. This is a local provider recovery proof, not a cloud deployment.
Recovery refuses declared/intervening external effects, configured/recorded data migrations and
unsupported current mandatory legacy artifact checks/contracts. The corresponding live sequence
still needs the isolated target and must obtain separate release/publish authorization.
