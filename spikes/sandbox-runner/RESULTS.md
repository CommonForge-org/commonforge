# S3: Sandbox runner spike results (A3, A7)

Run on 2026-10-06 (UTC) against the dedicated CommonForge account (Workers Paid), wrangler 4.147.0,
`@cloudflare/sandbox` 1.0.0, Worker `commonforge-spike-sandbox` on `*.<subdomain>.workers.dev`,
Artifacts namespace `commonforge-spike`. Everything live was deleted afterwards (see Cleanup).

| Assumption | Verdict | One line |
|---|---|---|
| **A3**: `git` in a sandbox container can clone from and push to Artifacts with a bearer header | **VERIFIED** | 42 sandbox jobs cloned, committed and pushed. The 5 failures were 4 runs with the unsupported `basic` instance type and 1 accidental ref-name collision between two concurrent jobs (both explained below). Two credential modes worked: a token in the exec env, and no token in the container at all (the Worker adds it on egress). |
| **A7**: the sandbox preview hostname can be bound per candidate and expires | **PARTIAL** | Per-candidate binding, token gating and expiry all work, but on a shared `workers.dev` hostname with a path per preview. A separate hostname for each candidate needs a Cloudflare zone with wildcard DNS, and the account has none. **The owner must decide this (see "Owner decision").** |

## What was built

```
spikes/
  fixtures/signed-job.json        SignedJob (§B.8 shape) for a `prepare-candidate` job; stub HMAC
  fixtures/make-signed-job.mjs    regenerates it (it expires: default 48 h)
  shared/signed-job.mjs           canonical JSON + HMAC verify (WebCrypto), the git job script, redaction
  sandbox-runner/Dockerfile       node:22-trixie-slim + git + ca-certificates + sandbox-shim 1.0.0 + static server
  sandbox-runner/worker.ts        Worker + `SpikeRunner` DO (ctx.container) + `ArtifactsGitGateway` entrypoint + broker
  sandbox-runner/wrangler.jsonc   durable_object scheduling policy, Artifacts binding, stub key var
  sandbox-runner/static-server.mjs  preview server baked into the image
  node-runner/run.mjs             fallback: the same SignedJob and git script, run with local Node and git
```

Both runners consume the same `spikes/fixtures/signed-job.json` and execute the same `GIT_JOB_SCRIPT`.
That script runs `git clone`, writes `runs/<tag>.json` and `run.html`, commits, and then pushes
`HEAD:refs/commonforge/candidates/<candidateId>/<tag>` and `HEAD:<retentionRef>/<tag>` in one push.
Both runners ask `job.credentialBroker` (the spike Worker's `/broker`) for a write token with a TTL
of 300 s or less, scoped to the repo. The broker verifies the HMAC and expiry first. The runners
revoke the token in a `finally` block. The Artifacts token list afterwards showed 51 tokens revoked
and only the token from repo creation still active.

**Spike substitution:** S3 has no task fork. Instead of fetching `candidate.sha` from a fork, the
runner synthesizes the "candidate" commit on top of `baseRevision`. The git, credential and push
mechanics that Task 14 needs are the same.

## A3 evidence

### Mode `env` (what the brief asked for)
The token reaches the container only as `T` in `exec(["bash","-c",script], { env })`. The script
runs `git -c http.extraHeader="Authorization: Bearer $T" clone|push`. The token is not in the image,
not in `start({env})`, not in the remote URL and not in `.git/config`.

- After each job, a scan of `/proc/*/environ`, `.git/config` and `~/.gitconfig` found the token
  nowhere (`tokenInContainer: []`). A positive control, a background process holding a needle in its
  env, was found (`/proc/51/environ`), so the scan works.
- **Caveat:** while the job runs, the git process's environ is readable by any other process in the
  container (everything runs as uid 0). If agent code or build steps share the container, they can
  steal the token during that window.

### Mode `egress` (recommended for Task 14)
The container starts with `enableInternet: false`. The DO calls
`interceptOutboundHttps("<acct>.artifacts.cloudflare.net", ctx.exports.ArtifactsGitGateway({ props: { token, repoPath, allowPush } }))`.
In the container, git uses the plain remote URL, with no credentials, and
`GIT_SSL_CAINFO=/etc/cloudflare/certs/cloudflare-containers-ca.crt`. The gateway lets only
`info/refs?service=git-upload-pack|git-receive-pack` and `POST git-upload-pack|git-receive-pack`
through, for the one repo path, and adds the `Authorization: Bearer` header itself.

- **Per-job props on `ctx.exports.X({ props })` work.** The token travels as gateway props and never
  enters the container.
- **Push through the intercept works.** It uses receive-pack v1 over a TLS-terminating intercept.
- Probes from the egress container:

  | Probe | Result |
  |---|---|
  | `git ls-remote https://github.com/...` | `Could not resolve host` |
  | Node `fetch("https://example.com")` | `EAI_AGAIN` |
  | A different Artifacts repo path through the gateway | `403 Forbidden by spike gateway` |
  | The spike repo after the job's token was revoked | `403 Invalid or expired token` (revocation is effective) |
  | The spike repo without `GIT_SSL_CAINFO` | `certificate signer not trusted` |

### Timings (ms; median and range; measured inside the DO, git phases timed by the in-container script)

| Scenario | n | Cold start¹ | Clone | Commit | Push | Broker² | Job total³ |
|---|---|---|---|---|---|---|---|
| **First start after the image push** (env, default=lite) | 1 | **4306** | 577 | 17 | 251 | 385 | 6138 |
| Cold, env, default (lite) | 3 | 291 (264–357) | 639 | 20 | 268 | 379 | 1568 (1387–2236) |
| Cold, egress, default (lite) | 3 | 286 (274–313) | 581 | 16 | 278 | 255 | 1491 (1455–1771) |
| Cold, egress, standard-1 / standard-2 | 2 | 258 / 264 | 567 / 629 | 17 / 19 | 262 / 283 | | 1534 / 1885 |
| **Warm, lite (default), repeated** | 10 | – | **3298 (2300–4201)** | 300 | **2616 (2099–2801)** | 84 | **6701 (5135–7870)** |
| Warm, standard-1 | 4 | – | 408 (388–549) | 11 | 258 | 82 | 874 (832–1005) |
| Warm, standard-2 | 4 | – | 406 (366–413) | 10 | 278 | 85 | 863 (778–905) |
| **Concurrent** cold, standard-1 (one batch of 5, one of 8, separate DOs, one repo) | 12 ok | 323 (285–400) | 616 (563–949) | 16 | 319 (132–557) | 297 | 1686 (1354–2156); 8 jobs finished in 2.4 s of wall time |
| Node fallback (local laptop → Artifacts) | 4 | – | 412 (324–451) | 5 | 260 (237–284) | 268–576 (HTTPS round trip) | 1126–1340 |

¹ From `ctx.container.start()` to the first `exec(["true"])` returning, for a new DO name. A cold
start is about 0.3 s once a host has the image. Only the first start after `wrangler deploy` pushed
a new image digest paid the pull (about 4.3 s, n=1).
² `ARTIFACTS.get` + `info()` + `createToken`; slower on first use per isolate. Revoke took 51–61 ms.
³ Includes broker, intercept registration (2–7 ms), exec round trip (4–13 ms) and `readCommit`
verification through the binding (16–29 ms). The client round trip to the Worker added about 0.3–0.5 s.

Other observations:
- **`lite`, the default instance, is unusable for repeated jobs.** The first job in a fresh `lite`
  container is fast. Later jobs in the same container are about 8× slower (clone about 3.3 s, push
  about 2.6 s): 1/16 vCPU after the initial burst. `standard-1` stays under 1 s per job.
- **`instance: "basic"` is rejected by the runtime.** `start()` throws
  `TypeError: Invalid container instance type`, although the limits page lists `basic`. The types
  allow `lite | standard-1..4 | {vcpu, memoryMib, diskMb}`.
- **Containers survive a Worker redeploy.** Running instances and their intercepts kept working
  across `wrangler deploy` when the image did not change. A redeploy with an unchanged image took
  about 7 s; with a new image, about 75 s (build plus push of about 80 MB of layers).
- **Concurrent pushes to the same new ref are serialized and one is refused.** Two jobs collided on
  a timestamp run tag. Artifacts accepted one and rejected the other with `! [remote rejected] ... (stale ref)`.
  It also rejected the second ref in the same push with `(atomic transaction aborted)`. So there
  was no silent last-writer-wins, and a multi-ref push behaved atomically. This is input for A1 (S2
  owns it). After the run tag became `ts + random`, 13 of 13 concurrent jobs succeeded.
- Fixture, HMAC and expiry handling were checked in both runners. A tampered job got
  `scope_violation: bad signature` from the broker, the sandbox `/run` and the node runner. A
  correctly signed but expired job got `job_expired` from the broker and the node runner.

### Costs and limits observed

- Containers bill every 10 ms of running time, including idle time until the inactivity timeout
  stops the instance. `standard-1` (1/2 vCPU, 4 GiB, 8 GB) costs about $0.00001 per second for
  memory, plus CPU when used.
  - A 2 s job is negligible.
  - A runner left idle for the 10-minute inactivity timeout costs about 2,400 GiB-s, roughly
    $0.006 beyond the included 25 GiB-h/month.
  - **`destroy()` runners right after each job.** Destroy took 185 ms.
- Account limits: 1,500 concurrent vCPU, 6 TiB memory, 50 GB image storage. The runner image is
  about 80 MB compressed.
- Each job costs about 4 Artifacts control-plane ops (get + createToken + revokeToken + readCommit)
  and 2 git requests (clone and push; each spans several HTTP requests). Neither comes close to the
  2,000 per 10 s limits. S5 owns the benchmark.
- Deleting the Worker with `wrangler delete` does **not** delete the container application or its
  live instances: 23 idle instances stayed `active`. You must run `wrangler containers delete <id>`
  and `wrangler containers images delete` as well.
- To deploy, Wrangler needs a local Docker daemon. Here the user is not in the `docker` group, so
  the spike used `WRANGLER_DOCKER_BIN` pointing at a `sudo -n docker` wrapper with `DOCKER_CONFIG`
  in a scratch directory. No system config was changed.

## A7 evidence

### What works today (no domain)
- **Binding a preview to a candidate:** each candidate name maps to its own DO and container
  (`env.RUNNER.getByName(name)`). After the push, the DO runs `node static-server.mjs /workspace/repo 8080`
  as a background `exec()`. The server was ready about 0.5 s later, and the DO forwards requests with
  `ctx.container.getTcpPort(8080).fetch()`.
- **Token gating per candidate:** `POST /share/<name>?ttl=<s>` requires an admin bearer (unauthenticated: 401).
  It stores `share:<random128>` with an expiry in that DO's SQLite storage and returns
  `/p/<name>/<token>/`.

  | Request | Result |
  |---|---|
  | `/p/<name>/<token>/` | 200, served the pushed commit's `index.html` and `run.html` (about 90 ms warm) |
  | `/.git/config` through the preview | 404 |
  | Wrong token | 404 |
  | Valid token used on a different candidate name | 404 |

- **Expiry:** a link with a 45 s TTL returned 200 at T+0 and 404 at T+48 s. `DELETE /sandbox/<name>`
  destroyed the container and cleared that DO's share tokens; the old link then returned 404.
  A preview has two lifetimes: the share token TTL, which the DO enforces, and the container's
  inactivity timeout, which ends the server process.

### Why A7 is only PARTIAL: hostnames
- **Path prefix on one hostname.** Every preview is served on `commonforge-spike-sandbox.<subdomain>.workers.dev/p/...`.
  That hostname is separate from the app's Worker, but all previews share one origin. Code in one
  preview can read another preview's `localStorage` and cookies. Root-relative links (`/assets/x.js`)
  escape the `/p/<name>/<token>/` prefix. Dev servers such as Vite need a base path.
- **No per-candidate hostnames on workers.dev.** `cand-1.commonforge-spike-sandbox.<subdomain>.workers.dev`
  resolves in DNS, but TLS fails (curl exit 35), because Universal SSL on workers.dev does not cover
  that depth.
- **What the docs require.** The documented pattern ("Serve previews on their own hostnames") gives
  each preview `<name>.<preview-domain>`. It needs:
  - a zone on the account that Cloudflare manages for DNS, used only for previews;
  - a proxied wildcard record (`AAAA * 100::`);
  - a route `*.<preview-domain>/*` to the Worker.

  A preview domain one level deep is covered by Universal SSL. Deeper subdomains need Total TLS or
  Advanced Certificate Manager. **The CommonForge account has 0 zones** (`GET /zones?account.id=` returned `[]`).
- **Expiry is application-level.** No platform hostname is created or expires. The "binding" is the
  Worker parsing the hostname or path to `getByName(name)`, and expiry is the DO-stored token TTL
  plus container teardown. Nothing has to be provisioned per candidate, so A7's "bound per
  candidate" holds at the application level once a wildcard zone exists.

### Owner decision (blocker for Task 22's "`preview.<domain>` per-preview" wording)
1. **Use a preview-only domain on this account** (recommended): register or move a cheap domain to
   this account, then add the wildcard AAAA record and the route. Previews become
   `<candidate>.<preview-domain>`, each its own origin, and the token gate stays the same. Nothing
   was bought.
2. **Accept the P0 shortcut:** path-based previews on a dedicated preview Worker's `workers.dev`
   hostname, which is separate from the app, with the per-candidate token in the path. Record the
   shared-origin limitation in README and the video. This works today, as shown above.

## What Task 14 (runner) should do

- **Image:** `node:22-trixie-slim` + `git ca-certificates` + `COPY --from=docker.io/cloudflare/sandbox:<pkg version> /usr/local/bin/sandbox-shim`.
  `cloudflare/sandbox:1.0.0` is a scratch image holding only the shim, not a base OS. In 1.0, your
  own DO starts the container (`ctx.container`); the old `getSandbox()` API is 0.x only. Use the
  `durable_object` scheduling policy with `exports` and `storage: "sqlite"`.
- **Credentials:** use egress mode as the default. Start with `enableInternet: false`, register
  `interceptOutboundHttps(<artifacts host>, ctx.exports.Gateway({ props: { token, repoPath, allowPush } }))`
  before `start()`, and set `GIT_SSL_CAINFO` on exec. The gateway allowlists the job's repos and
  services: upload-pack only for read jobs, receive-pack only for `prepare-candidate`, `integrate`
  and `reconcile-ref`, per §B.8. The broker mints tokens with `ttl = min(300, job expiry)`
  (minimum 60) and revokes them in `finally`. Exec-env tokens remain the fallback, and the node
  runner must use them.
- **Instance and lifecycle:** use `instance: "standard-1"`, never the `lite` default. Run one DO and
  one container per job, or per candidate for previews. `destroy()` the container when the job ends.
  Keep the inactivity timeout short for runners and longer only for previews.
- **Refs and concurrency:** make each pushed ref unique per job (jobId plus attempt). Treat
  `[remote rejected] (stale ref)` as a lost race (`stale_base` or a retry), never as success. Push
  the candidate ref and the retention ref in one push; Artifacts applied it atomically.
- **Receipts:** check the pushed sha with `repo.readCommit(sha)` through the binding (about 20 ms)
  before reporting success.
- **Exec details:** `exec()` takes no shell and no inherited env except `PATH`; pass `HOME`
  explicitly. Waiting on the first `exec(["true"])` after `start()` is a reliable readiness check.
  Redact `art_v1_…` from anything returned.
- **Node fallback:** `spikes/node-runner/run.mjs` shows the same protocol, with the same fixture,
  broker and script, running locally in about 1.1–1.3 s per job. The A3 fallback is not needed, but
  the node runner stays useful for developer machines and CI.
- **Schema gaps for Task 9:** `FrozenCandidate` has no fork coordinates, so `prepare-candidate`
  cannot locate the fork it must fetch from. `RepoCoords` is not defined in §B; the spike used
  `{ namespace, repoName }` and had the broker return `remote`. The broker endpoint and response
  shape (`{ token, tokenId, expiresAt, remote }`) and revoke-on-finish should be part of
  runner-protocol.

## What Task 22 (preview) should do

- Serve previews from a **dedicated preview Worker or hostname**, never the app hostname. Without a
  domain, use a dedicated `workers.dev` Worker with path previews (the P0 shortcut). With a domain,
  use `<previewId>.<preview-domain>` and route the hostname to `getByName(previewId)`.
- Gate each preview with a random per-preview token. Keep the token in the preview DO's storage with
  an expiry. Keep share-link creation and destruction on the app or API hostname behind auth, never
  on the preview origin. Set preview cookies without a `Domain` attribute.
- Use `enableInternet: false` for preview containers. Listen on `0.0.0.0`. For WebSockets or HMR,
  bridge sockets in the DO, per the docs, so open connections keep the container alive.
- Start the preview server as a background `exec()` after materialization. It was ready in about
  0.5 s for a static server.

## Reproduce

```sh
source scripts/load-dev-vars.sh                     # dedicated CommonForge account
node spikes/fixtures/make-signed-job.mjs            # fixture expires after 48 h
pnpm --dir apps/worker exec wrangler artifacts repos create spike-runner --namespace commonforge-spike --json  # seed it with an index.html
WRANGLER_DOCKER_BIN=<docker or sudo wrapper> pnpm --dir apps/worker exec wrangler deploy -c ../../spikes/sandbox-runner/wrangler.jsonc
pnpm --dir apps/worker exec wrangler secret put SPIKE_ADMIN_TOKEN -c ../../spikes/sandbox-runner/wrangler.jsonc
curl -X POST "https://commonforge-spike-sandbox.<sub>.workers.dev/run?name=c1&mode=egress&instance=standard-1&preview=1" --data @spikes/fixtures/signed-job.json
curl -X POST -H "Authorization: Bearer $ADMIN" ".../share/c1?ttl=600"     # -> preview URL
node spikes/node-runner/run.mjs                    # fallback, same fixture
```

## Cleanup performed

- `wrangler delete` removed the `commonforge-spike-sandbox` Worker.
- `wrangler containers delete` removed the `commonforge-spike-sandbox-spikerunner` application and
  its 23 idle instances.
- `wrangler containers images delete` removed the image from the account registry.
- Local Docker images were removed.
- The Artifacts repo `commonforge-spike/spike-runner` was deleted.
- The namespace `commonforge-spike` was **left in place**: another spike (S2) was creating repos in
  it at the same time, and a namespace delete returns `10202 Namespace is not empty` anyway.
- Nothing was bought. No DNS or zones were created.
