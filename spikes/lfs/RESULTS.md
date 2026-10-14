# LFS spike results (folders and uploads, phase 1)

Run on 2026-10-07 (UTC, about 14:13 to 15:10) against the dedicated CommonForge account
(`<CLOUDFLARE_ACCOUNT_ID>`, Workers Paid). Wrangler 4.147.0 for the first deploy, 4.148.0
for later deploys and the teardown. Resources: Worker `commonforge-spike-lfs` on
`commonforge-spike-lfs.<subdomain>.workers.dev`, its container application
`commonforge-spike-lfs-lfsrunner` (instance `standard-1`), R2 bucket `commonforge-spike-lfs`, and the
Artifacts namespace `commonforge-spike-lfs` with repos `lfs-*`. The namespace is not
`commonforge-spike` as planned: that namespace was no longer active (the CLI and the binding both
returned "Namespace is not active [10200]"), so the spike created its own. In the
container: git 2.47.3, git-lfs 3.6.1. Browser: headless Chromium 153.0.8010.12 through Playwright
1.63.0. Everything live was deleted afterwards (see Cleanup). The wrangler and git versions, the
namespace error, the image size, the transient 1042 error and the teardown counts are the
operators' own observations from the task runs, not fields in the results JSON.

`standard-1` is **½ vCPU, 4 GiB memory, 8 GB disk** (`spikes/sandbox-runner/RESULTS.md`, "Costs and
limits observed"). That matches what the container reported here: MemTotal 4,401,424 kB and a 7.5G
disk. `nproc` printed 1, but `nproc` does not show the CPU quota, so read every timing below as
½ vCPU.

Every LFS run (Q1, Q2, Q5) used **open egress** (`enableInternet: true`) and credentials passed in
the exec env. The production runner starts containers with `enableInternet: false` and egress
intercepts (`apps/worker/src/sandbox/index.ts:248`). That mode is untested with LFS.

Spec: `docs/superpowers/specs/2026-10-07-folders-and-uploads-design.md`, §10 phase 1. The numbers
below are quoted from `results-q1.json` … `results-q5.json`. MB/GB = 10^6/10^9 bytes; MiB/GiB =
2^20/2^30 bytes. The spec's "5 GB" limit is read as decimal (5,000,000,000 B); 5 GiB is 7% larger.

| Question (spec §10.1) | Verdict | One line |
|---|---|---|
| **Q1**: git-lfs runs in the runner container, and pointer commits push to Artifacts as ordinary files | **VERIFIED** | A 150 MB file pushed in 5.4 s. Artifacts holds a 134 B pointer blob, and R2 holds exactly 150,000,000 B. The first attempt hung in an endless credential loop on git-lfs's `locks/verify` call; `lfs.locksverify false` fixed it (see Limits). Open egress; the runner's intercept mode is untested. |
| **Q2**: a 2 GB git-lfs upload through a presigned R2 URL works end to end | **VERIFIED at 2 GiB** | 2 GiB went in **one** presigned PUT straight to R2, 59.3 s (36 MB/s), with the exact size stored. Expired URLs and URLs moved to another key got 403. The 5 GB single-PUT limit remains an open phase 2 test. Open egress; the runner's intercept mode is untested. |
| **Q3**: a 2 GB browser upload in 50 MB parts through the Worker's R2 multipart binding works, with throughput measured | **VERIFIED** | 41 parts of 50 MiB, 0 retries, 0 × 413, exact size stored. 428 s = 5.0 MB/s, which we infer is this machine's uplink, not the Worker. After an abort, nothing was stored and a later complete was refused. |
| **Q4**: hashing a 2 GB staged object in the runner fits within a job's time | **VERIFIED** | sha256 of 2 GiB on `standard-1` took 8.4 s (`sha256sum`) and 8.7 s (Node stream). Reading the object from R2, not hashing it, sets the job's time. A pessimistic 23 min for a 20 GB change would exceed the runner's 10 min pull-mode claim and the queue consumer's wall clock, so hashing belongs at upload completion (see Recommendations). |
| **Q5**: a preview build of a folder with a 100 MB LFS video produces real files | **VERIFIED** | After `git lfs pull` in a fresh clone, `dist/demo.mp4` was 100,000,000 B and sha256-identical, downloaded by presigned GET from R2 at 14.7 MB/s. Without the pull, the build shipped the 134 B pointer. Open egress; the runner's intercept mode is untested. |

All five answers are yes (Q2 is VERIFIED at 2 GiB; the 5 GB single-PUT limit remains an open
phase 2 test). So §10 does not need to come back to the owner before phase 2 starts, **on one
condition**: phase 2's first task re-runs Q1, Q2 and Q5 in the runner's egress-intercept mode.
None of the LFS runs here used it. The open points below (disk, time budget, TTL, the 5 GB PUT,
presigned-PUT scope) are design inputs for phase 2; the owner decisions and Limits 10 cover them.

## What was built

```
spikes/lfs/
  Dockerfile        node:22-trixie-slim + git + git-lfs + coreutils + sandbox-shim 1.0.0
  wrangler.jsonc    sandbox-spike shape (images map, durable_object scheduling, sqlite exports),
                    R2 binding BUCKET, Artifacts binding ARTIFACTS (namespace commonforge-spike-lfs)
  presign.ts        SigV4 query presigning for R2 (PUT/GET, one key, expiresSeconds)
  worker.ts         LFS batch + verify, R2 multipart routes, /exec into the container DO,
                    /repos (create, list, delete lfs-*), /head, /presign-test, DELETE /objects
  page.html         browser multipart uploader (served at GET /)
  browser.spec.mjs  Playwright driver for page.html (Q3)
  run.mjs           orchestrator: node run.mjs <q1|q2|q3|q4|q5|teardown>
  results-q*.json   measured results, scrubbed of secrets
```

- **LFS server (spike):** `POST /lfs/:repo/info/lfs/objects/batch` answers the standard batch API
  with the `basic` transfer. On upload it returns a presigned R2 PUT for `lfs/<repo>/<oid>` plus a
  `verify` action, unless the object already exists with the same size. On download it returns a
  presigned GET. Both use `expires_in: 900`. `POST /lfs/:repo/verify` checks the size with
  `BUCKET.head()`. HTTP Basic auth, with `LFS-Authenticate` on 401 for those two paths.
- **Runner:** one container DO (`standard-1`, `enableInternet: true`, so the container can reach
  the Worker and R2). Scripts that may run longer than about a minute run detached (`setsid nohup`,
  with a pidfile and an exit-code file) and are polled with short `/exec` calls every 5 s, so no
  single request has to outlive the edge or the container's inactivity timeout.
- **Credentials in the container (env only, nothing on disk):** the runner needs **two**
  credentials:
  - The Artifacts bearer for git travels as `GIT_CONFIG_COUNT/KEY_0/VALUE_0` =
    `http.<artifacts origin>/.extraHeader`, so it is scoped to the Artifacts origin and never sent
    to the LFS host or R2.
  - The LFS token is read from env by an inline `credential.helper`.

  Neither credential is written to `.git/config`, the image or the remote URL. The sandbox spike's
  recommended **egress-intercept** mode (no token in the container) was **not** tested with LFS
  here: the spike needed open egress to the Worker and R2, and kept the proven env mode for
  Artifacts. That is a phase 2 item; see Recommendations.

## Q1 evidence: git-lfs against Artifacts

`node run.mjs q1` (`results-q1.json`, 2026-10-07T14:33Z): repo `lfs-q1` with `.lfsconfig` pointing
at `/lfs/q1/info/lfs` and `*.bin` tracked. It commits 150,000,000 random bytes, then runs
`git push -f` (the git-lfs pre-push hook uploads the object, then git pushes the pointer).

| Item | Value |
|---|---|
| `git push` (LFS upload of 150 MB + pointer push) | exit 0, **5,404 ms** (about 28 MB/s) |
| Pointer blob locally / in Artifacts (fresh clone, `GIT_LFS_SKIP_SMUDGE=1`) | 134 B / **134 B**; remote HEAD = local HEAD |
| Stored pointer | `version https://git-lfs.github.com/spec/v1`, `oid sha256:ce0ee3a4…4d9f`, `size 150000000` |
| R2 `lfs/q1/<oid>` (`GET /head`) | **150,000,000 B**, etag without `-N` (single part) |
| Container script wall time | 15,651 ms |

**Attempt 1 hung.** `git push` stayed inside the pre-push hook for more than 10 minutes. A traced
5 MB run showed git-lfs `POST`ing `<lfs-url>/locks/verify` before the push, getting `401`, and
looping on credential reject, fill and resubmit, forever and silently. The spike Worker did not
route that path. In `worker.ts`, an unrouted path goes through the Bearer-only auth check
(`authorized(…, allowBasic=false)`), so git-lfs's Basic credentials, which batch and verify accept,
were rejected every time; that 401 also carried no `LFS-Authenticate`. **The cause is inferred**
from the code and the trace: the spike never varied either factor. The spike worked around it on
the client with `git config lfs.locksverify false`, the only fix that was exercised. The product
cannot rely on that (see Limits).

## Q2 evidence: 2 GiB through a presigned URL; expiry and key scope

`node run.mjs q2` (`results-q2.json`, 14:48Z). A 2 GiB random file (`/dev/urandom`) goes into
`lfs-q2`. `git lfs push --all origin` uploads the object, then `git push` sends only the pointer.
The R2 host was confirmed from a git-lfs trace that was reduced to hosts and method+path in the
container. No query strings were kept.

| Item | Value |
|---|---|
| File / R2 object `lfs/q2/<oid>` | 2,147,483,648 B / **2,147,483,648 B** |
| R2 etag | `f483902e…bb32`, no `-N` suffix: **one single-part PUT** of 2 GiB |
| Requests in the trace | 2 × batch POST and 1 × verify POST to the Worker; **1 × PUT to `<account-id>.r2.cloudflarestorage.com/commonforge-spike-lfs/lfs/q2/<oid>`** |
| `git lfs push` | exit 0, **59,307 ms = 36.2 MB/s** (user 2.0 s, sys 1.7 s). Attempt 1 measured 45.7 s (about 47 MB/s); see `steps` |
| `git push` (pointer only; the object was already in R2) | 1,711 ms |
| `git add` (git-lfs clean filter: hash + copy into `.git/lfs/objects`) | **53,837 ms** (user 10.2 s, sys 12.7 s) |
| `git commit` | 113 ms |
| Generating the random file (not part of any product path) | 48,546 ms |
| Pointer in Artifacts | 135 B, HEAD matches |
| Container | `nproc` 1 (does not show the ½ vCPU quota), MemTotal 4,401,424 kB |

**Disk** (`df -B1` on `/`, after `sync`; random data, so nothing compresses):

| Point | Used | Available |
|---|---|---|
| start | 186 MB | 7,717 MB |
| 2 GiB file in the working tree | 2,338 MB | 5,569 MB |
| after `git add` + commit (second copy in `.git/lfs/objects`, exactly 2,147,483,648 B) | **4,490 MB** | **3,422 MB** |
| after `git lfs push` / after `git push` | 4,490 MB | 3,422 MB |
| after removing the workdir | 186 MB | 7,717 MB |

`df -h` reports `standard-1`'s disk as 7.5G; used plus available is 7.90 GB. A 2 GiB LFS file
needed about **2× its size** during commit and push: one copy in the working tree and one in
`.git/lfs/objects`.

**Negative checks** (from this machine, keys under `lfs/q2-neg/`, each with a control):

| Check | Control | Result |
|---|---|---|
| Expiry: URL with a 5 s TTL, PUT after 10 s | fresh PUT 200 | **403 `ExpiredRequest`** ("Request has expired") |
| Scope: URL for key A, path changed to key B | PUT A 200 | **403 `SignatureDoesNotMatch`**; B does not exist afterwards |

## Q3 evidence: browser multipart through the Worker

`node run.mjs q3` (`results-q3.json`, 15:00Z). Headless Chromium loads `page.html` from the Worker,
generates one random 50 MiB part at a time in the page, `PUT`s it to `/mp/part` (the Worker streams
it into `uploadPart`, with a cap of 52,428,800 B, else 413), and then completes the upload. Parts
are sent one after another, with up to 4 attempts each.

| Item | Value |
|---|---|
| Parts | **41** (40 × 50 MiB + 1 × 48 MiB); all 41 returned 200; **0 retries; 0 × 413** |
| `GET /head` of the completed key | **2,147,483,648 B**, etag `…-41` |
| Total time | **428,406 ms = 5.0 MB/s** (4.8 MiB/s); generating the parts took 574 ms of that |
| Time per part | min 7,051 / median 8,873 / max 21,099 ms |

**Throughput (inference):** the 5 MB/s is most likely this machine's uplink, not the Worker. The
container reached R2 at 36 to 47 MB/s (Q2). Part times varied during the run (the first 11 parts
took 10.7 to 21.1 s, later parts mostly 7 to 10 s), which looks like a variable home link. No
Worker-side limit was hit. We did not measure the uplink separately, so this is an inference,
not a measurement.

**Abort** (200 MB planned, abort after 2 parts). Three results together show the upload
was discarded:
1. `POST /mp/abort` returned **204**.
2. `POST /mp/complete` on the aborted upload then failed with R2's
   `The specified multipart upload does not exist. (10024)`, which is NoSuchUpload.
3. `GET /head` of the key, after that complete attempt, returned **404**.

The spike did not check whether R2 still bills or stores the parts of an aborted upload. It could
not see them, and teardown found 0 in-progress multipart uploads. The spike Worker returned that R2
error as **500**; see Limits.

## Q4 evidence: hashing 2 GiB in the runner

`node run.mjs q4` (`results-q4.json`, 14:34Z), `standard-1` (½ vCPU; `nproc` printed 1):

| Item | Value |
|---|---|
| `sha256sum` of 2,147,483,648 B | **8,391 ms** (about 256 MB/s) |
| Node `createHash("sha256")` over a read stream | **8,729 ms** (about 246 MB/s); digests identical |

**Caveat:** Q4's test file was 2 GiB of the byte `a`, which the disk stores compressed.
`df` grew by only about 59 MB, so **Q4's disk headroom number means nothing**. Q2 measured disk with
random data (above). The hash time is still valid, because the hash reads all 2 GiB. The file may
have come from the page cache, so this is the CPU cost, not a cold-read cost.

## Q5 evidence: builds get real files only after `git lfs pull`

`node run.mjs q5` (`results-q5.json`, 15:04Z). Repo `lfs-q5` holds `index.html`
(`<video src="demo.mp4">`) and a 100,000,000 B random `demo.mp4` tracked by LFS. Two fresh clones
are made with `GIT_LFS_SKIP_SMUDGE=1`. Each runs the same "build", `cp index.html demo.mp4 dist/`.

| Item | With `git lfs pull` | Without |
|---|---|---|
| `demo.mp4` after checkout | 134 B pointer | 134 B pointer |
| `git lfs pull` | exit 0, **6,786 ms = 14.7 MB/s** | – |
| `dist/demo.mp4` | **100,000,000 B**, sha256 = original | **134 B**, first line `version https://git-lfs.github.com/spec/v1` |
| Object bytes came from | 1 × GET to `<account-id>.r2.cloudflarestorage.com/commonforge-spike-lfs/lfs/q5/<oid>` (presigned) after 2 × batch POST to the Worker | – |

Attempt 1 had correct data but two harness bugs, so its verdict was PARTIAL. Both bugs are recorded
in `steps`. The download rate, 14.7 MB/s, comes from a single 100 MB sample, small enough that
request setup and the smudge write weigh on it.

## Limits and findings

1. **git-lfs `locks/verify`.** git-lfs `POST`s `<lfs-url>/locks/verify` before every push. In Q1
   attempt 1 the spike Worker answered it with 401 and git-lfs looped on credentials forever, with
   no error message. The likely cause (inferred from `worker.ts`, not varied in a test) is that the
   unrouted path accepted only Bearer auth, so git-lfs's Basic credentials were rejected and
   replayed; the 401 also lacked `LFS-Authenticate`. Rule for the product: **`locks/verify` must
   accept the same Basic credentials as the batch endpoint, and must answer** with 404 or an empty
   lock list (`{"ours":[],"theirs":[]}`). Send `LFS-Authenticate` on every 401 under the LFS URL as
   well. **Both server-side fixes are untested**; only the client-side `lfs.locksverify false` was
   exercised. The `cforge` credential helper and agent images must not depend on that setting.
2. **Disk is 2× the file on the git-lfs commit path (measured).** `git add` (clean filter) keeps
   the working-tree file and a copy in `.git/lfs/objects`: 4.49 GB used for 2 GiB on a disk with
   7.90 GB in total. A 5 GB file would need about 10 GB plus the base image, so **5 GB files (the
   spec limit) do not fit `standard-1` on that path**. About 3.5 GiB is the theoretical ceiling
   there, with no margin. `git lfs pull` and smudge presumably need the same 2× (git-lfs keeps
   pulled objects in `.git/lfs/objects` and writes a working copy), but **Q5 recorded no disk
   figures, so 2× on pull is not measured**.
3. **The clean filter is likely CPU-bound on `standard-1`.** `git add` of 2 GiB took 53.8 s wall
   and 22.9 s CPU (user 10.2 s + sys 12.7 s). At ½ vCPU, 22.9 s of CPU needs at least 46 s of wall
   time, so most of the 54 s was spent waiting for CPU, not disk. Hashing alone took 8.4 s.
4. **Single PUT measured at 2 GiB only.** The etag without `-N` shows R2 accepted 2 GiB in one
   presigned PUT. The spec assumes one PUT up to 5 GB. R2 documents its single-PUT limit at about
   5 GiB, but **we did not measure 5 GB**. git-lfs's `basic` adapter always uses one PUT per
   object, so the spec's 5 GB per file depends on that documented limit.
5. **R2 errors surface as 500.** The spike Worker passed R2 errors through as 500, for example
   NoSuchUpload (10024) on complete-after-abort. The product should map R2 errors to 4xx
   (NoSuchUpload → 404 or 409, bad part → 400) and keep 500 for real failures.
6. **Presigned URLs expire and cover one key.** A request after the TTL got 403 `ExpiredRequest`; a
   key swap got 403 `SignatureDoesNotMatch` (Q2). **Not tested:** what happens when a PUT starts
   before the URL expires and finishes after.
7. **Data reaches R2 directly.** In Q2 and Q5, object bytes went to `<account>.r2.cloudflarestorage.com`.
   So the runner needs egress to the R2 S3 host, not only to Artifacts and the Worker. The trace
   text also mentions `a.nel.cloudflare.com`, probably from a NEL / report-to response header
   (inferred). No request to that host was observed.
8. **Downloads in the spec stream through the Worker; the spike used presigned GETs.** Spec §5
   says download "responses stream through the Worker". Q5 proved the presigned-GET path only. A
   Worker-streamed download was not tested.
9. **Small things.** The first `/exec` call right after a fresh deploy once got a transient
   `error code: 1042` from the Cloudflare edge (an observation during the first deploy; a retry
   fixed it, and `run.mjs` retries `error code: 10xx` for that reason). `page.html` sends parts with
   `fetch()` and a byte body, which gives the browser no upload-progress events, so progress was
   only per part.
10. **A presigned PUT limits neither size nor content.** `presign.ts` signs only `host`, with
    `UNSIGNED-PAYLOAD`. The "up to 5 GB" in spec §5 is R2's own single-PUT limit, not a property
    of the URL. Anyone holding the URL can PUT any bytes of any size to that key for 15 minutes.
    `verify` catches only a size mismatch, and only afterwards; the hash is checked later still.
    The spike's batch handler also skipped the upload whenever an object with the same size was
    already at the key (`worker.ts`, the `head.size === o.size` branch). That is unsafe for staged
    objects, because their bytes are unverified. **Recommendation:** skip an upload only for an
    **accepted, hash-verified** object in the same resource, never for a staged one. Signing
    `Content-Length` into the URL could cap the size, but that is untested on R2.

## Recommendations for phase 2 (LFS server and `apply-files`)

- **Presigned TTL:** keep **900 s** (spec §5) for uploads and downloads alike. Every transfer here
  started within seconds of its batch response. The longest one, a 2 GiB PUT from the container,
  took 59 s, and expiry is enforced at request time (403 `ExpiredRequest`). R2 likely checks expiry
  only when a request starts, as S3 does, so a transfer that starts in time should finish even if
  it outlasts the URL; **this is unmeasured**. It matters for slow clients: at the 5 MB/s seen in
  Q3, a 5 GB transfer in either direction takes about 1,000 s, longer than the TTL. Phase 2 should
  test a PUT and a GET that outlast their URLs. If R2 cuts them off, scale the TTL with object size
  for both directions (for example, size ÷ 2 MB/s, between 900 and 3,600 s). git-lfs is expected
  to request the batch again rather than use an action whose `expires_in` has passed (not tested
  here).
- **Browser part size:** keep **50 MiB (52,428,800 B)**, and state it as MiB in the spec (§10 says
  "50 MB"). It gave 0 retries and 0 × 413 over 41 parts, and a median of 8.9 s per part at 5 MB/s,
  so a failed part costs about 10 s to resend. A 5 GB (decimal) file is 96 parts (5 GiB would be
  103) and a 20 GB change about 382, well under R2's 10,000-part limit. Keep every part except the
  last the same size, as the spike did. The spike sent parts one after another; 2 to 4 parallel
  parts are worth measuring in phase 3, but this spike did not test them. Report progress per
  part, or use XHR for byte-level progress.
- **Hashing in `apply-files`:** it fits, as long as the job **streams** each staged object (R2 GET →
  sha256 → discard) instead of storing it. The hashing is cheap: 8.4 s per 2 GiB, so about 20 s per
  5 GB and about 80 s per 20 GB change (scaled linearly from Q4). Reading the object is the cost.
  The only container download we measured was 14.7 MB/s, a single 100 MB sample through git-lfs
  (Q5). At that rate 5 GB takes about 6 min and a 20 GB change about 23 min, but these
  extrapolations are probably pessimistic: a small sample carries fixed setup costs, and
  container-to-R2 uploads of 2 GiB ran at 36 to 47 MB/s (Q2).

  **The runner's time budget today** (a job must fit the limits of whichever path runs it):

  | Limit | Where | Value |
  |---|---|---|
  | The queue consumer awaits the whole job (`await env.RUNNER_BOX.getByName(jobId).run(…)` inside `queue()`) | `apps/worker/src/sandbox/index.ts:346-356` | the queue consumer's wall-clock limit, about 15 min (Cloudflare's figure; to confirm) |
  | A pull-mode runner re-claims a job whose claim is older than `CLAIM_TIMEOUT_MS` | `apps/worker/src/routes/runner.ts:21` | 10 min |
  | `defaultMaxLifetimeSeconds`: canonical-write kinds, `seed-workspace` and `release-deploy` | `packages/runner-protocol/src/sign.ts:68-71` | 3,600 s (86,400 s for other kinds) |

  Against that budget, hashing (about 80 s per 20 GB) fits. Reading 20 GB at the pessimistic
  14.7 MB/s (about 23 min) exceeds both the 10 min claim and the about 15 min consumer limit. A
  single 5 GB file (about 6 min) fits only with little margin.

  **Recommendation:** by default, hash each staged object **when its upload completes**, in its own
  job or step. Record `{stagingId, sha256, size}`, and have `apply-files` only look the result up,
  at least for large changes. The spec already allows this: nothing is trusted until a hash is
  verified. The alternative is to keep hashing inside `apply-files` and make a measured raw R2 GET
  of 2 GiB in the runner container a **phase 2 gate**, with the job budget set from that rate.
  Owner decision 2 covers the choice.
- **Writing pointers directly (spec §6 "put"):** the spike supports the pieces but did not run
  them together. It showed that:
  - the pointer is an ordinary 134 to 135 B blob that Artifacts stores and serves (Q1, Q2);
  - the object and the pointer travel separately: after `git lfs push`, `git push` of the pointer
    took 1.7 s (Q2);
  - a streamed sha256 of 2 GiB takes 8.7 s in Node (Q4).

  So `apply-files` can write the pointer text (`version`, `oid sha256:…`, `size`) itself, without
  the object ever touching the container's disk and without running the clean filter (Q2: 54 s
  per 2 GiB on ½ vCPU). **Not tested:** pushing a hand-written pointer whose object exists only in
  R2. The job must push with the git-lfs pre-push hook off (no `git lfs install` in that clone, or
  `--no-verify`). Otherwise git-lfs will try to upload an object it does not have locally.
- **Container disk for 5 GB files:**
  - **`apply-files` with streaming "put":** no per-file disk beyond the pointer, so `standard-1`
    is enough.
  - **Any path that runs git-lfs on real files:** agent pushes need about **2× the largest file**
    (measured on commit, Q2). Phase 5 builds (`git lfs pull` + build), workspaces and exports
    probably need the same 2× plus build output (Q5's build copied the file again into `dist/`),
    but the pull side is not measured, so treat this sizing as provisional until phase 5 measures
    `df` around a pull. For the 5 GB limit, size disk from 2 × 5 GB + build output + about 1 GB
    base, so 16 GB or more. Options:
    - a **custom instance** `{ vcpu: 1, memoryMib: 4096, diskMb: ≥ 16000 }`. The
      `{vcpu, memoryMib, diskMb}` shape comes from the sandbox spike's notes and is still to
      confirm. `vcpu: 1` is double `standard-1`'s ½ vCPU.
    - a named type with enough disk, such as `standard-3`, which may meet the 16 GB need (to
      confirm against the limits page).

    The alternative is to lower the per-file limit for LFS on these paths to what `standard-1`
    can hold (about 3 GiB). More CPU should speed up the clean filter: it took 54 s per 2 GiB with
    23 s of CPU on ½ vCPU, so it looks CPU-bound.
- **Credentials:** the runner needs both the Artifacts bearer (git) and an LFS token (batch API).
  The env-only injection used here works and leaves nothing on disk. **The first task of phase 2**
  should repeat Q1, Q2 and Q5 in the runner's **egress-intercept** mode (`enableInternet: false`,
  no token in the container), as production runs it. That mode must intercept the LFS URL and
  add the LFS credential. It must also either allow `<account>.r2.cloudflarestorage.com` for
  presigned URLs, or stream object bytes through the Worker. That choice also settles finding 8
  (owner decision 3).
- **LFS server details:** accept the same Basic credentials on `locks/verify` as on batch, and
  answer it (404 or an empty lock list); send `LFS-Authenticate` on every 401. Both are untested
  server-side fixes (Limits 1). Omit `actions` only for objects that are **accepted and
  hash-verified in the same resource** (Limits 10), never for staged ones. Map R2 errors to 4xx.

## Owner decisions

Every verdict is VERIFIED, so nothing in the spike blocks phase 2. The one condition is that phase 2
starts by re-running Q1, Q2 and Q5 in the runner's egress-intercept mode, because every LFS run here
had open egress. These choices shape phase 2, and the owner may want to make them up front:

1. **Disk for any job that runs git-lfs on real files.** This covers agent pushes, workspaces,
   builds, editions and exports. The 2× figure was measured on commit and push (Q2); on pull it is
   expected but not measured.
   - (a) Keep 5 GB per file and give those jobs 16 GB or more of disk, with a custom instance or a
     larger named type (recommended).
   - (b) Keep `standard-1` and cap LFS files on those paths at about 3 GiB.

   Uploads through `apply-files` with a streaming "put" hold 5 GB either way.
2. **Where hashing runs (time budget).** The runner's limits are a 10 min pull-mode claim, the
   queue consumer's wall clock (about 15 min, to confirm), and a 1 h lifetime for the existing write kinds (`issueJob` defaults every job to 3,600 s, `apps/worker/src/services/runner-jobs.ts:101`).
   - (a) Hash each staged object when its upload completes, and have `apply-files` only look the
     result up (recommended for large changes).
   - (b) Hash inside `apply-files`, gated on a phase 2 measurement of a raw R2 GET in the runner.
3. **Download path, and R2 under intercept.** Spec §5 says download responses stream through the
   Worker, but the spike used presigned R2 GETs.
   - (a) Presigned URLs both ways. The runner, under intercept, must then be allowed to reach
     `<account>.r2.cloudflarestorage.com`.
   - (b) Stream object bytes through the Worker (or an intercept gateway), so the runner never
     reaches R2 directly. Not tested here.
4. **5 GB through one PUT.** git-lfs's `basic` adapter sends each object in one PUT and cannot
   resume. At the about 5 MB/s seen in Q3, a 5 GB upload takes about 1,000 s, which outlasts a
   15 min URL (whether R2 still accepts it depends on the untested start-time expiry check) and
   restarts from zero on any failure.
   - (a) Accept that for git-lfs clients and steer large files to the browser's multipart path.
   - (b) Lower the per-file limit for git-lfs pushes.
   - (c) Build a multipart custom transfer adapter later.
5. **Promotion to `objects/<sha256>` at up to 5 GB.** The R2 binding has no copy operation, and S3
   `CopyObject` is capped near 5 GiB, so a 5 GB promotion is tight or needs a multipart copy.
   - (a) Promote by copy, accepting those limits.
   - (b) Key staged objects by oid from the start, and record acceptance in the database instead
     of moving bytes.
6. **Not exercised:** the 1 MB LFS threshold (`COMMONFORGE_LFS_THRESHOLD_BYTES`) and the
   per-path `.gitattributes` entry. Every measured LFS file was 100 MB or more and matched a tracked
   pattern.

## Reproduce

Needs `~/.config/commonforge/spike-lfs.env` with `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`SPIKE_TOKEN` and `SPIKE_URL` (mode 0600; never printed), plus a local Docker daemon for the image
build.

```sh
cd spikes/lfs
export CLOUDFLARE_ACCOUNT_ID=<CLOUDFLARE_ACCOUNT_ID>
npx wrangler r2 bucket create commonforge-spike-lfs
npx wrangler artifacts repos create lfs-bootstrap --namespace commonforge-spike-lfs   # creates the namespace
npx wrangler deploy
npx wrangler secret put R2_ACCESS_KEY_ID      # and R2_SECRET_ACCESS_KEY, SPIKE_TOKEN
node run.mjs q1   # then q4, q2, q3 (Playwright from apps/web), q5
node run.mjs teardown
```

## Cleanup

Done on 2026-10-07 at about 15:10 UTC. Commands ran from `spikes/lfs` with
`CLOUDFLARE_ACCOUNT_ID=<CLOUDFLARE_ACCOUNT_ID>`. The figures below are the operators' own
command outputs, not results JSON.

1. Added `GET /repos` and `DELETE /repos/:name` to `worker.ts` (the binding's
   `ARTIFACTS.list()` / `ARTIFACTS.delete("lfs-<name>")`; only `lfs-*` names can be deleted), and
   redeployed (version `c91bca28`).
2. Before teardown, the S3 API listed **8 objects**, all under `lfs/` (`lfs/mp` 1 × 2 GiB,
   `lfs/q1` 3, `lfs/q2` 2 × 2 GiB, `lfs/q5` 2), and **0** in-progress multipart uploads.
3. `node run.mjs teardown`:
   - `DELETE /objects?prefix=lfs/`: round 1 deleted 8, round 2 deleted 0.
   - Repos listed: `lfs-q5, lfs-q2, lfs-q1, lfs-smoke1, lfs-bootstrap`. `DELETE` → `{"deleted":true}`
     for `lfs-q1`, `lfs-q2`, `lfs-q5`, `lfs-bootstrap` and `lfs-smoke1`.
   - Repos listed afterwards: none. `wrangler artifacts repos list --namespace commonforge-spike-lfs`
     reported "No Artifacts repos found".
4. An S3 `ListObjectsV2` + `ListMultipartUploads` check found 0 objects and 0 uploads.
5. `npx wrangler delete --name commonforge-spike-lfs --force` returned "Successfully deleted". The
   workers.dev URL now returns 404, and `wrangler deployments list` returns 10007 "This Worker does
   not exist".
6. As the sandbox spike found, deleting the Worker left the container application in place
   (`commonforge-spike-lfs-lfsrunner`, `active`, 1 live instance). `npx wrangler containers delete
   d7222f4cdc484c808884212de421a614` removed it. `npx wrangler containers images delete
   commonforge-spike-lfs-lfsrunner-runner:wrangler-muy6sa3y` removed the registry image. The local
   Docker image (124 MB) was removed with `docker rmi`. Afterwards, no `spike` entries remained in
   `containers list` or `images list`.
7. `npx wrangler r2 bucket delete commonforge-spike-lfs` returned "Deleted bucket" on the first try.
   The bucket list now shows only buckets that are not spike buckets.

**Left in place:**
- **The Artifacts namespace `commonforge-spike-lfs`** is empty (`repo_count: 0`). Wrangler 4.148.0
  has no namespace delete command (`artifacts namespaces` offers only `list` and `get`), and the
  binding has none either. The old `commonforge-spike` namespace went inactive on its own, so this
  one may too.
- **Owner action:** delete the **R2 API token** used by this spike in the dashboard (R2 → Manage
  API Tokens), and delete **`~/.config/commonforge/spike-lfs.env`**. The file holds that token's
  key pair and the spike's `SPIKE_TOKEN`/`SPIKE_URL`, which are now dead. Neither was deleted here.
  The spike did not record the token's bucket scope. Check it, and if it covers "all buckets",
  delete it promptly: it could reach `commonforge-assets-dev`.

Nothing else was touched. `commonforge-worker`, `commonforge-preview`, `commonforge-runner`, the
`commonforge-ci-*` containers, D1 `commonforge-dev`, and buckets `commonforge-assets-dev` and
`commonforge-assets-ci` are unchanged. Nothing was bought.
