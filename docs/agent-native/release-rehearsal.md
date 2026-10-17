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
A local fixture runner's different runtime cannot authorize production: the bridge fails closed.

Release health observes the actual deployed release's existing configured identity/HTTP check,
records an observation against its manifest and output digest, and expires after five minutes.
Expired or missing observations return `unknown`. A healthy release identity check does not prove
business scenario correctness. Acceptance, publishing, deployment and health remain separate states.
Native failures require explicit recovery under current project requirements; automatic rollback
of earlier artifacts is disabled for enabled projects. External effects and database migrations
are never represented as automatically reverted.

## Dedicated isolated Cloudflare rehearsal

This task does not authorize deployment of the candidate into the running control plane. A live
G1 rehearsal needs a separate Cloudflare account/namespace, owner-approved release policy, disposable
demo-only D1/KV/R2, runner job keys stored in its supervisor, a real Sandbox/runner, and an external
Git/bootstrap recovery route. Its scenario verifier must execute the deployment runtime and bind
its exact recipe/environment; the current source-only local verifier is insufficient to claim
compiled-byte scenario verification.

After provisioning that isolated stack and implementing/verifying its matching runtime adapter,
run the existing account connectivity and provider gates with `pnpm test:live` from the repository
root, then execute the native API workflow: confirm rules/scenarios; issue a bounded task handoff;
submit an envelope with its exact source/runtime digests; request real verification; record the
exact decision; accept; prepare release; inspect signed build outputs; publish approval; deploy;
observe the resulting release and wait past the freshness bound to verify `unknown`.

`pnpm test:live` alone is the legacy live suite and is not the dedicated G1 acceptance gate. No
executable live G1 runtime adapter or successful G1 Cloudflare run is claimed here. Record the
command, revision, credentials-free artifact paths, account isolation, deployment identity and
observations in `execution-status.md` before marking that gate verified. Until then the live G1
release gate remains unverified.
