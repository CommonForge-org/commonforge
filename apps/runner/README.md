# @commonforge-org/runner

The CommonForge integration runner is the only component that writes canonical Artifacts repositories. It executes signed jobs with real git:

- `seed-workspace`
- `prepare-candidate`
- `integrate`
- `reconcile-ref`
- `build-edition`
- `edition-return`
- `apply-files`
- `inventory`
- `export`
- `preview-build`

It runs either as a Sandbox container image (`Dockerfile`) or as a Node process (`commonforge-runner run|poll`). See `src/main.ts` for every flag. `src/worker-client.ts` lists the Worker endpoints the runner calls.

## Trust model
- **Jobs.** Jobs are verified with a keyring (`--keyring-file`) only on trusted runners. Other runners pre-check the shape and expiry, and authenticity is enforced by the credential broker and the results endpoint. An unverified job can never choose where the runner connects:
  - `--worker-url` is the only trusted origin.
  - A job whose `credentialBroker` has another origin is refused before any network call.
  - Results, blobs, evidence keys and heads go only to `--worker-url`.
  - `file://` remotes are refused unless `--allow-file-remotes` is set, and `http://` remotes unless `--allow-http` is set.
- **Tokens.** Tokens reach git only through the environment of the git process that needs them: `http.<url>.extraHeader` via `GIT_CONFIG_*`, or `COMMONFORGE_TOKEN` for local-git. They never appear in argv or a config file. Every token is revoked when the job ends. In egress mode the container never holds a token.
- **Pushes.** Each push updates one ref, leased with `--force-with-lease`, and only refs listed by `jobAllowedPushRefs(job)` are pushed.

## Assets-only integrate
A proposal whose only changes are R2 asset manifests (for example a logo replacement) gets an
`integrate` job with no candidates and no targets, only `assetChanges` (runner-protocol README). The
runner merges and pushes nothing and asks for no write credential. It still exports every git mount
of the snapshot as a reference, installs their dependencies and runs the policy checks and contracts
there, so a required check or contract can refuse the change. It signs evidence with
`mergeOutcome: []` and returns `results: []`. It never reads the asset bytes; the evidence binds the
manifests through `proposalHash`.

## Isolation of check and recipe commands
Checks, contract producers and preview recipes run candidate code. `pnpm test` runs scripts from the candidate's `package.json`. The command allowlist only bounds the entry points; isolation is the real control.

- **A separate uid is required.** Use `--check-uid` with the runner running as root, as the image does (`cfcheck`, uid 10001).
  - Without it, the runner refuses every job that has checks or recipe steps, unless `--unsafe-same-uid-checks` is given.
  - That flag is for trusted content only, such as tests or a developer's own changes. In that mode, candidate code can read the runner's initial environment (`/proc/<pid>/environ`) and the user's files.
  - **Node mode on a shared host is trusted-content only.**
- **The checkout is separate.** Checks run in an exported tree (no `.git`) under `--checks-dir`, outside the job directory that holds the repositories the runner pushes from. That job directory is mode 0700 and owned by the runner.
- **Lingering processes are reaped.** After each command, every process of the check uid is killed, including ones that started their own session. The runner refuses to push while any check-uid process survives. In unsafe same-uid mode, reaping is best effort, using a marker environment variable.
- **Preview output is read without following links.** The output directory's realpath must stay inside the mount. Files are opened with `O_NOFOLLOW` and must be regular files with one link, owned by the check uid.
- **Network is not isolated by default.** `--check-network auto|none` runs checks in a network namespace with no routes (`unshare --net` plus `setpriv`). This needs root with CAP_SYS_ADMIN. It works in Docker with `--cap-add SYS_ADMIN` and is refused in default Docker; whether the Cloudflare Sandbox runtime grants it has not been checked. When it is unavailable, checks share the runner's network.

## Dependency installs (integrate)
Integrate checks in the Sandbox run with no network (`--check-network none`), so a check cannot install
its own dependencies. The runner does it, as its own step, after exporting the checkout and before the
first check (`src/install.ts`):

- **Which mounts.** Every mount of the checkout whose `package.json` declares `dependencies`,
  `devDependencies` or `optionalDependencies`, or that is a pnpm workspace (`pnpm-workspace.yaml` with
  `packages:`), in mount-name order. Other mounts are skipped. Every mount is decided before the first
  install runs, so nothing an install writes can change what the runner reads for another mount.
- **Lockfile required.** Exactly `installArgv(policy)` in the mount:
  `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --config.pm-on-fail=ignore
  --no-runtime --no-trust-lockfile --config.minimum-release-age=<m>
  --config.minimum-release-age-exclude=<entry>` (one flag per entry). No committed `pnpm-lock.yaml`,
  or a stale one, fails the job with `check_failed` before any check runs.
- **No candidate code runs during the install.**
  - No lifecycle script runs, neither the project's own nor any dependency's. That is within the
    fixtures' `allowBuilds` set (esbuild, workerd). pnpm 12 reads `allowBuilds` only from the
    project's own, candidate-controlled `pnpm-workspace.yaml`, so the runner allows none at all.
  - No `.pnpmfile.*` hook runs.
  - A `packageManager` field cannot make pnpm fetch and run another pnpm.
  - A lockfile `runtime:` entry (for example a node runtime) is never fetched or linked.
- **Policy on the command line.** `DEFAULT_INSTALL_POLICY` (pnpm's one-day `minimumReleaseAge` plus the
  monorepo's `minimumReleaseAgeExclude`) is passed as flags, which beat the candidate's own
  `pnpm-workspace.yaml`: a yaml `minimumReleaseAge: 0`, `trustLockfile: true` or extra excludes change
  nothing. `--no-trust-lockfile` re-verifies every lockfile entry against it. An empty exclude list
  still names a sentinel entry, because with none on the command line pnpm applies the yaml's.
- **Isolation.**
  - The install runs as the check uid, with a clean environment, its own HOME/XDG directories and one
    pnpm store per job, and it is reaped like a check.
  - It is the only step that keeps the runner's network. The checks then run with
    `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`, so `pnpm exec` does not try to re-install.
  - In the Sandbox, that network reaches only the npm gateway. For integrate jobs, the gateway requires
    a per-job registry key (`--npm-key-file`, written root-only by the RunnerBox and put in the install's
    own npmrc only while it runs), stays read-only, and does not follow redirects.
  - The Artifacts and control-plane gateways refuse the install: they require the root runner's key,
    which the install never has.
- **Flags.** `--install-store DIR` shares a store between jobs on a trusted dev host (tests).
  `--no-install-deps` turns the step off.

## Requirements for Task 22 (Sandbox deployment and the egress gateway)
In egress mode the Worker's outbound interceptor adds the Artifacts bearer to requests that leave the container. Unless checks run without network (`--check-network`), check processes share that network path. **The gateway is therefore the enforcement point for the job's write scope**, and it MUST:

1. **Limit hosts.** Allow only the Artifacts host and only the repository paths named by the job (`jobRepoAccess(job)`). Refuse everything else, including other repositories and other hosts.
2. **Limit services and refs.**
   - Allow `git-upload-pack` (read) for the job's repositories.
   - Allow `git-receive-pack` (write) only for repositories with write access in `jobRepoAccess(job)`. Canonical repositories get write only for `prepare-candidate`, `integrate` and `reconcile-ref`.
   - Parse the receive-pack command list and allow updates only to the refs in `jobAllowedPushRefs(job)`, with the expected old value for `absent`/`expected` leases. Reject `--atomic` and multi-ref pushes.
3. **Bound the credential.** Mint the injected token with `ttl <= job.expiresAt`, verify the SignedJob before minting, and revoke the token when the job ends.
4. **Inject the bearer for the runner only, if possible.** If the runtime can distinguish the runner process from check processes, for example by source port or uid via a local proxy, add the bearer only to the runner's traffic. Otherwise treat items 1–3 as the only control and prefer `--check-network none`.
5. **Verify the network isolation.** Check whether the Sandbox runtime permits `unshare --net`. If it does, set `COMMONFORGE_RUNNER_CHECK_NETWORK=none` so a missing namespace fails closed. Fixture checks that need `pnpm install` then need a preinstalled store or an install step that runs before the network is cut.
6. **Isolate containers.** Use one container per job, instance type `standard-1`, and destroy the container afterwards. The runner's in-process push mutex does not serialize separate containers; Artifacts' one-push-per-repo busy errors are retried.

## Known limits
- `catFileBatch` loads every selected blob of a tree into memory, which is fine for demo-sized repositories.
- No `logRef`: check logs are returned as a redacted tail in the failure detail.

### Status (Task 22, verified live 2026-10-06)
The Sandbox runner (`apps/worker/src/sandbox/`) implements items 1–6: per-job gateways for the
Artifacts host (job repositories, services, one allowed ref with its lease, nothing after expiry),
the control plane (result/evidence/heads/blob calls only), the npm registry (read-only, plain HTTP
inside the container) and, for `release-deploy` only, `api.cloudflare.com` (the job's Workers).
Tokens are minted by the broker for the verified job (`ttl <= expiresAt`) and revoked at the end.
**`unshare --net` works in the Sandbox runtime**, so jobs with write access run their checks with
`--check-network none` (the bearer is then only used by the runner's own traffic, item 4), after the
runner installed their dependencies ("Dependency installs" above); read-only
build jobs keep the gateway-limited network for install steps. Per-step env comes from the recipe
(`env`) and `COMMONFORGE_RUNNER_CHECK_ENV`; release deploys use the image's pinned wrangler
(`COMMONFORGE_RUNNER_WRANGLER`) and `dist/preview-host.js` serves preview bundles with fixture bindings.
