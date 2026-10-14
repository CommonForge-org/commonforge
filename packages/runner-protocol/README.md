# @commonforge-org/runner-protocol

The integration runner contract: signed jobs, the credential-broker policy, materialization (plan,
execute, verify), redaction and validation-evidence signatures. The main entry is Worker-safe
(WebCrypto only). The Node io adapter lives at `@commonforge-org/runner-protocol/node`.

## Signed jobs
- `signJob` / `verifySignedJob` use HMAC-SHA256 over the domain-tagged canonical JSON of every field except `sig`.
  - `kid` selects the key from a keyring, which supports rotation.
  - Expiry and not-before are checked with a clock-skew allowance (default 30 s).
  - The default maximum lifetime is **1 h for canonical-write kinds** (`prepare-candidate`, `integrate`, `reconcile-ref`) and 24 h for the rest.
- **Use the verified object.** Act only on `result.signedJob`. Never re-parse the raw body with another JSON parser, because duplicate keys are last-wins only under `JSON.parse`.
- **There is no replay guard here.** The broker and the ledger dedupe by `jobId` (runner results are applied once, plan §F). Tokens are minted with a TTL no later than `expiresAt`.
- `integrate` pushes to `refs/commonforge/integrations/<proposalId>/<jobId>`, which is unique per job. Nothing may push core's bare `integrationRef(proposalId)`.
- **Assets-only `integrate`** (additive). `candidates` and `targets` may both be empty when `assetChanges` (the proposal's asset manifest changes, signature-covered) is non-empty; a job with neither is refused. `assetChanges` is only for assets-only jobs: a job with git targets (including a mixed git + assets proposal) must not carry it, so mixed jobs stay byte-identical to jobs older runners understand (an older runner strips unknown fields, which breaks the signature at the broker).
  - Such a job has no canonical write and no allowed push: `jobRepoAccess` yields only its `references` (read), `jobAllowedPushRefs` yields none.
  - The runner runs the policy checks and contracts against the snapshot's git mounts and signs evidence with `mergeOutcome: []`. The receipt has `results: []`. `parseRunnerResultForJob` needs no special case: the result and clean-merge sets must equal the (empty) target set, and the checks must still be exactly the job's.
  - The evidence does not name the asset manifests. It binds them through `proposalHash`, which covers `assetManifestChanges`; the ledger refuses evidence for any other hash. The runner never reads asset bytes, so it should not attest to them; their integrity is checked when they are committed (size and sha256 per object).

## Credential broker
- `jobRepoAccess(job)` lists the repos a job may use, each tagged `canonical | task-fork | edition | reference`.
  - Canonical write is allowed only for `prepare-candidate`, `integrate` and `reconcile-ref`.
  - `build-edition` writes only its `-editions` repo.
  - `edition-return` writes only a fresh `-tasks` fork.
  - `apply-files` reads canonical and writes only a fresh `-tasks` fork. Its operations are not inline (a queue message holds 128 KB): the job carries `opsManifest { r2Key, sha256, count }`, an R2 object the runner reads through its blob scope and checks against the hash, and parses with `parseApplyFilesOps`. Large, binary or LFS-pattern files are committed as LFS pointers; the runner never downloads LFS objects.
  - `seed-workspace` (addition: Artifacts cannot fork across namespaces) reads canonical and writes only its fresh `-tasks` repo (`ws-<taskWorkspaceId>`). The runner pushes exactly `<baseSha>:<ref>` with `--force-with-lease=<ref>:`; a lease failure where `ls-remote` already shows `baseSha` counts as success. It never pushes `--mirror` or any other ref. The default maximum lifetime is 1 h.
- `IntegrationJobSchema` refuses any repo whose Artifacts namespace does not match its role.
- `authorizeCredentialRequest(verifiedJob, {repo, access})` is the pure broker decision.
  - It matches by strict identity: kind, namespace, repoId **and** remoteUrl.
  - It returns the **job's** coordinates. Mint tokens for those, never for the request's.

## Evidence keys
The runner never holds a job-signing key. The issuer derives a per-job key,
`deriveEvidenceKey(jobKey, jobId)` = `HMAC(jobKey, "cf.evidence-key/1|" + jobId)`, and ships it with
`evidenceKeyToWire`.
- That key can sign evidence for this one job only. It cannot sign evidence for another job, and it cannot sign a `SignedJob`.
- `verifyEvidence(ev, jobKeyring, {jobId})` re-derives the key to check the signature.
- Sign evidence in the runner supervisor, outside the process that runs candidate check commands.

## Materialization
`planMaterialization` runs on the server.
- It omits resources that have no grant.
- `workspace.json` never contains tokens; this is enforced with a tripwire check.
- `PROJECT-CONTEXT.md` is generated server-side and redacted.

`materialize` and `verifyMaterialization` both run `validatePlan` first.
- The workspace root must be absolute.
- Mount names must be unique.
- Context files are limited to the planned `.commonforge/` files.

Git runs with `core.fsmonitor=false` and `core.hooksPath=/dev/null`. Clone and fetch allow only the transport of the planned URL.

`verifyMaterialization` reports:
- symlinked or escaping mounts, and unadmitted root or `.commonforge` entries;
- HEAD different from the pinned sha, and origin or pushurl drift;
- non-sample hooks;
- unsafe local config: hooksPath, fsmonitor, `include*`, sshCommand, filters, credential store;
- secrets in the config, in included files, in `config.worktree` or in `.git/credentials`;
- asset and context-file mismatches.

Paths are POSIX. A Windows client needs an adapter that normalizes them.
