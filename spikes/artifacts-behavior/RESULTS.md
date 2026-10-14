# S2 Artifacts behavior spike: results (A1, A2, A4, A5)

Live runs on 2026-10-06 (UTC) against the dedicated CommonForge Cloudflare account, namespace
`commonforge-spike`, git 2.55.0, Node 26. The script is `run.mjs` in this directory. Raw evidence
(secrets and account ID redacted) is in `results-a1-a5.json` (run `muw6v53l`), `results-a4.json`
(run `muw6a2c5`) and `results-a2.json` (run `muw6gi9z`). Earlier runs of the same phases gave the
same verdicts. Every repo was deleted at the end of each run (`remainingAfterCleanup: []`). A final
listing of the namespace returned no repos. The namespace itself still exists because the docs
list no route for deleting a namespace.

Docs fetched on 2026-10-05/06: `artifacts/api/rest-api`, `api/git-protocol`,
`guides/authentication`, `api/errors`, `concepts/namespaces` and `platform/limits`.

## Verdicts

| ID | Verdict | One line |
|---|---|---|
| A1 | **PARTIAL** | No silent last-writer-wins: the server applies each ref update as a compare-and-swap on the old sha. However, the server does **not** reject non-fast-forward updates. A plain push is rejected only by the git client, and `--force` succeeds. |
| A2 | **PARTIAL** | Forks keep all their objects after the parent is deleted (`fsck --full --strict` clean at 1, 50 and 500 MB). `fork()` is **not** "seconds" at 500 MB: it took about 50 s, and one 500 MB fork attempt returned HTTP 500. |
| A4 | **VERIFIED** (stronger than assumed) | A revoke rejects new requests on the first probe. An in-flight 100 or 200 MB push **fails with 403 at the end of its upload** and the ref is not updated. A token that expires mid-push fails the same way. |
| A5 | **PARTIAL** | Git accepts, lists, fetches and reads custom refs and notes refs (protocol v1 and v2). REST `log?ref=` cannot resolve any full refname, including `refs/heads/main`: it returns **200 with `[]`**, which looks the same as a missing ref. It does work with a sha. |

**Design flag: `COMMONFORGE_FORCE_WITH_LEASE=1` (recommended on).** A1 fails in its "server
rejects non-ff" half, so the §0.3 fallback applies. The runner should always push with
`--force-with-lease=<ref>:<ledger-recorded sha>` (with `--atomic` for multi-ref updates). The spike
shows that this lease is enforced on the server (see the A1 lease race), not only on the client.

---

## A1: non-fast-forward, force, lease, races

Setup: `spike-canon` received 3 commits by `git push`. It was then forked with
`POST /repos/spike-canon/fork` to `spike-fork`. All pushes below went to the fork with the write
token returned by the fork call.

| Test | Result | Evidence |
|---|---|---|
| Fast-forward push to fork | OK, 0.86 s | `0cc3ecc..79d7221 main -> main` |
| Plain non-ff push (diverged clone, no force) | **rejected**, exit 1, remote unchanged | `! [rejected] main -> main (fetch first)`. This message comes from the **git client**: it compares against the advertised ref and sends nothing. |
| `--force` (non-ff) | **accepted** | `+ 88c5578...79d7221 main -> main (forced update)`. The server does not set `receive.denyNonFastForwards`. |
| `--force-with-lease=main:<stale sha>` | rejected (client) | `! [rejected] main -> main (stale info)`. Remote unchanged. |
| `--force-with-lease=main:<current sha>` (non-ff) | accepted | `(forced update)`. Remote equals the pushed sha. |
| 6 concurrent fast-forward pushes to `main` from the same base, 3 rounds | **exactly 1 winner per round**. The final ref is always the winner's sha. | The losers fail in three ways: `! [remote rejected] main -> main (stale ref)` (the **server** CAS on the old sha), `artifacts_git_receive_pack_busy` (see below), or the client's `fetch first` once the new tip was advertised. |
| 5 concurrent **`--force-with-lease` non-ff** pushes, same correct lease (with busy retry) | **exactly 1 winner**. The final ref is the winner's sha. | Outcomes: `ok`, `remote-rejected-stale-ref`, `client-stale-info`, `busy>client-stale-info` ×2. A lease that passed the client check was still refused by the server's CAS. |
| 6 concurrent pushes to **distinct** new branches of one repo | **only 2–4 of 6 succeed** across runs | Losers get HTTP 200 with sideband channel 3 (fatal) `artifacts_git_receive_pack_busy`. git prints only `fatal: the remote end hung up unexpectedly` and exits 1. The losing refs are not created. |
| Same distinct-ref fan-out with retry on `busy` (exponential backoff, 150 ms × 2^n with jitter) | 6/6 succeed in 0.85–1.3 s total, max 2 attempts | `concurrentDistinctRefsWithBusyRetry` |
| `--atomic` push (1 ff ref + 1 non-ff ref) | all-or-nothing: neither ref updated | `! [rejected] side -> side (atomic push failed)` |
| Same push without `--atomic` | partial: `side` updated, `main` rejected | |
| Ref deletion `push origin :refs/heads/side` | accepted, ref gone | `- [deleted] side` |
| Push with a `read` token | 403 | `remote: Insufficient permissions` |
| Parent `main` after all fork pushes | unchanged | Forks are independent. |

**Interpretation.** Artifacts behaves like a stock `receive-pack` with `denyNonFastForwards=false`
plus a per-repository write lock. Every command `(old, new, ref)` is checked against the current
ref on the server (`stale ref`), so a stale writer can never silently overwrite a newer one.
Fast-forward is **not** enforced: anyone with a write token for a repo can rewrite any ref in it
with `--force`.

**Design implications**
- A write token for a repo amounts to full ref-rewrite authority over that repo, because there is
  no branch or path scoping and no ff protection. **Canonical repos must never receive a write
  token outside the integration runner.** Refs in a task fork are advisory. The commit sha recorded
  in the ledger is the only identity (§0.3 fallback).
- `COMMONFORGE_FORCE_WITH_LEASE=1`: the runner pushes canonical updates with
  `--force-with-lease=<ref>:<expected sha> --atomic`. This is a real server-side CAS, and the
  `ok`/`stale ref` outcome tells the runner whether the conditional acceptance won.
- **A repository accepts one push at a time and does not queue.** A push that loses the race fails
  with `artifacts_git_receive_pack_busy`, and git only shows `the remote end hung up unexpectedly`.
  The runner must:
  1. Run push with `GIT_TRACE_PACKET=1`, or parse the sideband, to tell `busy` apart from a
     rejection.
  2. Retry `busy` with jittered backoff.
  3. After any ambiguous failure, re-read the ref (`ls-remote`) before it decides the outcome.

  One fork per agent (the plan's isolation unit) avoids this contention. The canonical repo will
  see it whenever several candidates are accepted at once, so canonical pushes should be
  serialized through the ledger or runner.

## A2: fork timing and object independence

Seeds are incompressible `crypto.randomBytes` files of at most 20 MB each, pushed in commits of at
most 100 MB. Each seed was forked twice (`a` and `b`). The parent was then deleted (`202`, after
which `GET` returned `404` immediately). After a 3 s wait, the surviving fork was `git clone
--mirror`-ed and checked with `git fsck --full --strict`.

| Seed | Fork API call (synchronous) | Usable after return | Fork `objects` | Clone of fork after parent delete | fsck | Objects and head |
|---|---|---|---|---|---|---|
| 1 MB | 2.4 s / 2.7 s | first `ls-remote` (0.18–0.46 s) | 3 | 0.6 s | clean | 3/3, head matches |
| 50 MB | 10.7 s / 5.0 s | first `ls-remote` (0.3–0.55 s) | 5 | 6.7 s | clean | 5/5, head matches |
| 500 MB | **fork a: HTTP 500 `{code:10400,"An internal error occurred."}`**; fork b: **50.6 s** | first `ls-remote` (4.4 s) | 35 | 76 s | clean | 35/35, head matches |
| tiny (A1 setup, 9 objects) | 2.3–3.5 s across runs | first `ls-remote` | 9 | n/a | n/a | n/a |

REST `file?ref=main&path=c0-0.bin` on the fork after the parent was deleted returned 200 at every
size.

Notes:
- The fork call is synchronous. When it returns 200, the fork is immediately cloneable, and no
  `FORK_IN_PROGRESS` (10303) was observed. Its duration grows roughly linearly with size (about
  0.1 s/MB at 500 MB). That suggests objects are copied rather than shared copy-on-write. This is
  an inference: the docs still do not say.
- The failed 500 MB fork left no repo behind: the cleanup sweep by name found nothing. The second
  attempt, made right after, succeeded.
- A transient `500 / 10400` also occurred once on a plain `POST /repos` (create) in an aborted run.
- Seed upload throughput was 0.6–1.3 MB/s. That was limited by the client uplink, not by
  Artifacts. A 500 MB seed took 383 s to push in 5 × 100 MB pushes, and every 100 MB push
  succeeded.
- 500 MB was achieved. The 1 GB per-repo limit was not tested.

**Design implications**
- Forks are safe to keep after their parent is deleted, so cleanup ordering does not matter
  (verified).
- Per-task `fork()` is a few seconds only for small repos. At 500 MB it takes about 50 s and can
  fail with a 5xx. The adapter should:
  1. Call fork outside the interactive request path (Queue or Workflow step) for large repos.
  2. On 5xx, `GET /repos/<name>` before retrying, because fork, like create, is not idempotent.
  3. Pass `default_branch_only: true` where possible.
- Large binaries belong in R2 (already planned).

## A4: token revocation and expiry

| Test | Result |
|---|---|
| Write token with TTL 60. Start a **100 MB** push. Revoke (`DELETE /tokens/:id`) once `Writing objects` reports ≥1% (revoke sent at 1.8 s, completed at 2.1 s) | **The push fails** after 11.4 s with `error: RPC failed; HTTP 403 … send-pack: unexpected disconnect`. The remote ref is **not** updated. |
| Same with a **200 MB** push (revoke sent at 6.9 s) | **Fails** after 25.7 s with HTTP 403. The ref is not updated. In an earlier run the same case failed with `curl 92 HTTP/2 stream reset (INTERNAL_ERROR)` after a 403. |
| Control: TTL-60 write token, 100 MB push, no revoke | succeeds (56 s) |
| **Token expiry mid-push**: TTL-60 token, 100 MB push started 8.0 s before `expires_at` | **Fails** with HTTP 403 when the upload finishes (4.7 s after expiry). The ref is not updated. |
| New requests after revoke (×3) | Fail on the **first** probe each time: 167–173 ms after the revoke call returned, 550–593 ms after it was sent. There were 0 successful probes after revoke. Error: `remote: Invalid or expired token` (HTTP 403). |
| Push and clone with the revoked token | 403 `Invalid or expired token`, about 0.17 s |
| TTL-60 token used until expiry, no revoke | First failure 0.18 s after `expires_at` (1.1 s in an earlier run) |
| `ttl: 59` | `400 {code:10103,"ttl must be between 60 and 31536000 seconds",source:{pointer:"/ttl"}}` |
| Revoke an already-revoked token | `404 {code:10200,"Token not found"}` |
| `GET /repos/:name/tokens?state=all` | Lists `active`, `revoked` and `expired` with scope. No plaintext is returned. |

**Interpretation.** The token is checked again when the receive-pack POST is processed, after the
whole pack has been received. A push still in flight is therefore aborted by a revoke or by expiry.
The client still uploads the full pack before it is rejected.

**Design implications**
- The candidate-freeze guarantee holds: revoke the fork's write token, then read the ref sha. Any
  push that had not finished cannot land.
- The TTL must exceed the worst-case **total** push duration plus a margin. A short TTL (60 s) will
  make large or slow pushes fail at the very end. For example, 100 MB took 56 s on this uplink.
  Mint runner and agent write tokens with TTL ≈ 2× the expected upload time plus slack, and revoke
  them explicitly on freeze, instead of relying on a tiny TTL.
- A 403 from revoke or expiry looks to git like `RPC failed; HTTP 403` or a disconnect. The runner
  should treat it as "not landed" and confirm with `ls-remote`.

## A5: custom refs and git notes

| Test | Result |
|---|---|
| `git push origin HEAD:refs/commonforge/checkpoints/1` | accepted, `* [new reference]` |
| `git notes add` + `git push origin refs/notes/commits` | accepted |
| Annotated tag push | accepted |
| `git ls-remote` with protocol v2 (`version 2` negotiation confirmed via `GIT_TRACE_PACKET`) and protocol v0/v1 | both list `refs/commonforge/checkpoints/1`, `refs/notes/commits`, `refs/tags/v-spike` and its `^{}` peel |
| `ls-remote <remote> 'refs/commonforge/*'` (v2 ref-prefix) | returns only the checkpoint ref |
| Fresh clone + `git fetch origin 'refs/commonforge/*:refs/commonforge/*' 'refs/notes/*:refs/notes/*'` | fetched. `git notes show <sha>` gives `{"run":"s2","validation":"pass"}`. The checkpoint sha matches. |
| Non-ff update of the custom ref without force | rejected (client, `fetch first`), same as branches |
| `GET /repos/:name` | No refs listed. There is no REST or binding endpoint that lists refs. |

REST `GET /repos/:name/log?ref=<x>&limit=3`:

| `ref=` | HTTP | Result |
|---|---|---|
| `main` | 200 | commits |
| `v-spike` (short tag name) | 200 | commits |
| `<commit sha>` (the checkpoint's target) | 200 | commits |
| `<notes commit sha>` | 200 | the notes commit |
| `refs/heads/main` | 200 | **`[]`** |
| `heads/main` | 200 | **`[]`** |
| `refs/commonforge/checkpoints/1` | 200 | **`[]`** |
| `commonforge/checkpoints/1` | 200 | **`[]`** |
| `refs/notes/commits` / `notes/commits` | 200 | **`[]`** |
| `refs/tags/v-spike` | 200 | **`[]`** |
| `does-not-exist` | 200 | **`[]`** (no 404) |

REST `file?ref=&path=` follows the same pattern. Full refnames, including `refs/heads/main`, return
`404 {code:10200,"File not found"}`. `ref=main` and `ref=<sha>` work. With
`ref=<notes commit sha>&path=<annotated commit sha>`, it returns the note body. `GET /commit/:sha`
returns `{hash, treeHash, message, author, committer, parents, authoredAt, committedAt}`.

**Design implications**
- Retention refs, candidate refs and notes under `refs/commonforge/...` and `refs/notes/...` work
  over git. Recovery and runners can use them.
- The control plane (Worker via REST, and probably the binding, which was not tested here but
  presumably shares the backend) **cannot resolve or discover them by name**. Worse, a wrong ref
  yields `200 []` rather than an error. Therefore:
  - The ledger must record the sha for every checkpoint, candidate and notes commit. The provider
    reads by sha.
  - `ArtifactsVersionProvider.log/readFile` must treat `[]` for a ref that should exist as
    "unresolved", and must pass refs in short form (`main`) or as a sha. Never pass `refs/...`.
  - Ref enumeration has to go through the runner (`git ls-remote`).

## Other observations

- **Rate-limit headers: none.** REST responses carry `api-version: 2026-10-01.epoch`,
  `cf-auditlog-id`, `cache-control: no-store`, `server: cloudflare` and `cf-ray`. There are no
  `ratelimit-*` or `retry-after` headers, so A9/S5 has to measure the limit empirically.
- Latencies: create repo 2.0–2.3 s, delete 1.3–1.8 s (202), token mint about 0.3 s, revoke about
  0.3–0.4 s, `log`/`commit` reads 0.2–0.35 s, small push 0.4–0.9 s.
- The repo-create response token has the default TTL of 86,400 s and encodes `?expires=` in the
  token string. The fork response also returns its own write token.
- Error bodies follow the documented v4 envelope with `documentation_url`. The TTL error includes
  `source.pointer`.
- The namespace was auto-created by the first `POST /repos`. No route for deleting a namespace is
  documented.
- Git protocol v2 is used for fetch and `ls-remote` by default (git 2.55). Push uses v1 as
  documented. `--atomic` push is supported.

## Exact calls used

REST base: `https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/artifacts/namespaces/commonforge-spike`,
with header `Authorization: Bearer $CF_API_TOKEN`.

- `POST /repos` `{name, default_branch:"main", description}` returns `{id,name,remote,token,...}`
- `POST /repos/:name/fork` `{name, description?}` returns `{..., remote, token, objects}`
- `GET /repos/:name`, `DELETE /repos/:name` (202), `GET /repos?limit=200&search=<runId>`
- `POST /tokens` `{repo, scope:"read"|"write", ttl}` returns `{id, plaintext, scope, expires_at}`
- `DELETE /tokens/:id`, `GET /repos/:name/tokens?state=all&per_page=100`
- `GET /repos/:name/log?ref=&limit=`, `GET /repos/:name/commit/:sha`, `GET /repos/:name/file?ref=&path=`

Git: the `remote` returned by the API, authenticated with `http.extraHeader=Authorization: Bearer <token>`.
The script passes this through `GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n` rather than
`-c`, so the token stays out of argv. It is otherwise identical to the documented
`git -c http.extraHeader=...`. `credential.helper` is empty and `GIT_TERMINAL_PROMPT=0`.

## Reproduce

```sh
source scripts/load-dev-vars.sh
node spikes/artifacts-behavior/run.mjs a1 a5      # ~80 s
node spikes/artifacts-behavior/run.mjs a4         # ~4 min (uploads ~500 MB total)
node spikes/artifacts-behavior/run.mjs a2         # ~11 min at ~1 MB/s uplink; --sizes=1,50 for a quick run
```
