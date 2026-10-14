# S4: Artifacts events and import spike: results (A6)

Live runs on 2026-10-06 (UTC) against the dedicated CommonForge Cloudflare account (Workers Paid),
wrangler 4.147.0, git 2.55, Node 26, Artifacts namespace `commonforge-spike`. The script is
`run.mjs`, the consumer Worker is `worker.ts` + `wrangler.jsonc` in this directory. Raw evidence
(API token, repo tokens, the spike admin bearer and the account id redacted) is in `results-*.json`.
Everything live was deleted afterwards (see Cleanup).

Docs fetched on 2026-10-06: `artifacts/guides/event-subscriptions`, `artifacts/guides/import-repositories`,
`artifacts/api/rest-api` (import section), `queues/event-subscriptions` (+ `manage-event-subscriptions`,
`events-schemas`), `queues/reference/delivery-guarantees`.

## Verdict

| ID | Verdict | One line |
|---|---|---|
| **A6**: a `pushed` event is delivered at least once within ~5 s | **VERIFIED** for `pushed` (20/20 burst pushes delivered exactly once, in order, **p50 0.56 s, p95 1.13 s, max 1.21 s** from `git push` completion to consumer receive). **But** the account-level `repo.forked` and `repo.imported` events were **never delivered** (0 of 4 forks, 0 of 12 successful imports), while `repo.created` and `repo.deleted` were. |

So: `pushed` is a usable outbox **wakeup**, not an authority (as the plan already assumes). Do not
build anything on `repo.forked` / `repo.imported` events in this beta; the API call's own response
is the completion signal for those.

---

## What was built

```
spikes/events-import/
  wrangler.jsonc  Worker `commonforge-spike-events`: Queue consumer for `commonforge-spike-events`
                  (max_batch_size 1, max_batch_timeout 0, max_retries 3) + SQLite DO `EventRecorder`
  worker.ts       queue(): records each message (msg id, delivery attempt, Queue timestamp, receive
                  time, type, source, ref, before, after, eventTimestamp, full body) into the DO and
                  acks; fetch(): GET/DELETE /events (admin bearer), GET /time (clock probe)
  run.mjs         setup | push | import | teardown (REST + git + wrangler; redacts all output)
```

Subscriptions were created with the REST API (`POST /accounts/:id/event_subscriptions/subscriptions`),
because `wrangler queues subscription create --source artifacts.repo` (4.147.0) has **no flags for
`namespace`/`repo_name`** and sends `{type:"artifacts.repo"}` only. Bodies that worked (200 on the first
try, event names in the short form):

```json
{"name":"spike-account","enabled":true,"source":{"type":"artifacts"},
 "destination":{"type":"queues.queue","queue_id":"<id>"},
 "events":["repo.created","repo.forked","repo.imported","repo.deleted"]}

{"name":"spike-pushed","enabled":true,
 "source":{"type":"artifacts.repo","namespace":"commonforge-spike","repo_name":"<repo>"},
 "destination":{"type":"queues.queue","queue_id":"<id>"},"events":["pushed"]}
```

A repo-level subscription can only be created **after** the repo exists (it names the repo). The
probe push 8 s after creating the subscription was delivered, so activation is fast.

Latency method: push completion = the local time at which `git push` exited 0; receive = `Date.now()`
at the start of the Worker's `queue()` handler. The local↔Worker clock offset was measured with 15
`/time` probes before and after (best RTT 13–15 ms; offset −1 / −2 ms), so the cross-clock error is
about ±8 ms. `eventTimestamp` (Artifacts) and the Queue message timestamp are on Cloudflare clocks.

## A6 evidence: 20-push burst (`results-push.json`)

One repo, `pushed` subscription on it. 20 sequential single-commit pushes to `main`, no delay
between them (12.2 s wall, push p50 561 ms, no `receive_pack_busy` with a single sequential writer),
then one 5-commit push and one push that updated two refs.

| Metric (20 burst pushes) | Result |
|---|---|
| Delivered | **20 / 20**, missing 0 |
| Duplicates | **0** (by `ref+after`, and 0 duplicate Queue message ids). Every message had `attempts = 1`. |
| Order | Received in push order (0 inversions). `before` of each event = `after` of the previous push (chain intact). |
| Push completion → consumer receive | **min 175, p50 563, p95 1,127, max 1,213 ms** (mean 670) |
| Within 5 s | 20 / 20 |
| Push completion → `metadata.eventTimestamp` | p50 93 ms, max 193 ms (the event is stamped just after receive-pack finishes) |
| Queue message `timestamp` − `eventTimestamp` | **0 ms** for every message: the Queue timestamp *is* the event timestamp, so the hop cannot be split further |
| `eventTimestamp` → consumer receive | p50 468, p95 1,032, max 1,111 ms (Queue delivery to a batch-of-1 consumer) |

Other shapes:

| Push | Events | Notes |
|---|---|---|
| Probe (first push, new `main`) | 1, 0.96 s | `before` = `0000…0000` |
| One push carrying 5 commits | **1** event, 0.78 s | `commits` has all 5, `totalCommitsCount: 5`, `commitsTruncated: false` |
| One push updating `main` + new `refs/commonforge/candidates/c1` | **2** events (one per ref), 0.41 s / 0.48 s, 5 ms apart | Custom refs emit `pushed` too. The new ref's event has `before: 0000…`, **`commits: []`, `totalCommitsCount: 0`** (the commit was already reported on `main` in the same push). |

Payload as received (matches the docs; account id redacted):

```json
{"type":"cf.artifacts.repo.pushed",
 "source":{"namespace":"commonforge-spike","repoName":"ev-muw74ygc","type":"artifacts.repo"},
 "metadata":{"accountId":"<ACCOUNT_ID>","eventSubscriptionId":"b94e…","eventSchemaVersion":1,
             "eventTimestamp":"2026-10-06T04:46:37.313Z"},
 "payload":{"ref":"refs/heads/main","before":"0000000000000000000000000000000000000000",
            "after":"a88cb630…","commits":[{"id":"a88cb630…","message":"probe 0","messageTruncated":false,
            "timestamp":"…","author":{…},"committer":{…},"parents":[]}],
            "totalCommitsCount":1,"commitsTruncated":false}}
```

Caveats on the A6 numbers:
- n = 20 (+4) on one afternoon, one repo, one consumer with batch size 1. Ordering held here, but
  neither the Artifacts docs nor Queues promise ordering, and Queues documents **at-least-once**
  delivery. Zero duplicates in 24 messages does not mean duplicates cannot happen.
- With the Queues defaults (`max_batch_size` 10, `max_batch_timeout` 5 s) add up to ~5 s of
  batching wait; the latency above is the event path only.

### Account-level events

Subscription source `artifacts` (no filter) with `repo.created, repo.forked, repo.imported, repo.deleted`.
It is account-wide across namespaces: it also delivered events for repos another task was creating
concurrently in `commonforge-spike-p…-canonical` / `-tasks` namespaces.

| Event | Triggers observed | Delivered | Receive − `eventTimestamp` |
|---|---|---|---|
| `repo.created` | 4 `POST /repos` (2 mine, 2 another task's) | **4 / 4** | 1.1–4.7 s |
| `repo.deleted` | 20 deletes (16 mine incl. forks and imported repos, 4 another task's) | **20 / 20** | 0.08–0.99 s |
| `repo.forked` | 2 mine (`ev-…-fork`, `ev-probe2-…-f`, both 201) + ≥2 another task's (`f1`, `f2`) | **0** (waited 60 s and ≥4 min) | n/a |
| `repo.imported` | 12 successful imports (201) | **0** | n/a |

Also: a fork or an import does **not** emit `repo.created`; their only trace is the later
`repo.deleted`. So in this beta the account-level stream cannot be used to learn that a fork or an
import exists. (The subscription accepted the event names, so this is a delivery gap, not a
subscription error. Not tested: whether a repo-level subscription on the *parent* sees anything on fork.)

## Import evidence (`results-import-*.json`)

`POST /repos/:name/import {url, branch?, depth?}`. While the call was in flight, `run.mjs` probed
the same repo in parallel (`GET /repos/:name`, `GET /log?ref=<branch>&limit=1`, `POST /tokens` read)
every 250 ms (`SPIKE_PROBE_MS`), and after it returned, `git ls-remote` with the returned token.

| Run | Repo (size) | Import call | First 200 on GET/log/token | `ls-remote` OK | Commits |
|---|---|---|---|---|---|
| sequential | octocat/Hello-World (`master`) | 201 in 3.0 s | right after the call | 3.9 s | 2 |
| sequential | octocat/Spoon-Knife (`main`) | 201 in 2.6 s | right after | 3.8 s | 3 |
| sequential | expressjs/express (`master`, full history) | 201 in **32.0 s** | right after | 33.8 s | ≥200 |
| probe 250 ms | Hello-World | 201 in 1.7 s | log 1.43 s, token 1.49 s, get 1.66 s (**before** the 201 arrived) | 1.9 s | 2 |
| probe 250 ms | Hello-World, no `branch` | 201 in 2.4 s | 2.1–2.9 s | 3.0 s | 2 |
| probe 250 ms | Spoon-Knife | 201 in 2.6 s | 2.4–3.0 s | 3.2 s | 3 |
| probe 250 ms | express | **504 at 69.8 s** `10401 "The request timed out. Please retry the operation."` | never | n/a | repo **gone** (404) |
| probe 250 ms | express (retry) | **504 at 67.2 s**, same | never | n/a | gone |
| probe 3 s | express | 201 in 31.1 s | 31.0–31.3 s | 33.2 s | ≥500 |
| no probe | express | 201 in 50.6 s | right after | 51.0 s | ≥500 |
| no probe | express | 201 in 32.7 s | right after | 33.1 s | ≥500 |
| probe 250 ms | lodash/lodash (`main`, full) | **504 at 69.1 s** | never | n/a | gone |
| no probe | lodash (full) | **504 at 66.8 s** | never | n/a | gone |
| probe 1 s | lodash, `depth: 1` | 201 in 4.5 s | 4.7–5.0 s | 6.5 s | 1 |
| probe 1 s | lodash, `depth: 100` | 201 in 8.1 s | 7.7–8.6 s | 9.5 s | 100 |
| any | `https://github.com/octocat/this-repo-does-not-exist-cf-spike` | **422** in 1.6–1.8 s, `10106 "…requires authentication (HTTP 401). Only public repositories can be imported."`, `source.pointer: /url` | repo 404 | n/a | none created |

What the in-progress responses look like (all three REST probes behave identically):

1. First ~0.2–1 s after the POST: **`404 {code:10200,"Repository not found"}`** (the repo row does not
   exist yet).
2. Then **`409 {code:10302,"Repository \"<name>\" is currently being imported and is not yet available."}`**
   for `GET /repos/:name`, `GET /log`, and `POST /tokens`.
3. Success: 200 on GET/log, 201 on token, *at or slightly before* the import POST returns 201.
4. Timeout: at ~66–68 s the probes flip from 409 back to **404** (the partially imported repo is
   **deleted**), and ~1 s later the import POST returns **504 `10401`**. Nothing is left behind.

A second `POST …/import` to the same name while the first is running returns **`409 {code:10201,
"repo already exists: <name>"}`** in ~0.16 s, i.e. the name is reserved immediately and a retry
with the same name is not idempotent.

Other import observations:
- **The import call is effectively synchronous** in this beta: in every successful run it returned
  only once the repo was readable. The documented "may still be in progress after this request
  returns" never happened (n = 12 successes), but the 409 window is fully visible to concurrent callers.
- **Server-side budget ≈ 66–70 s, then rollback.** Full-history express (~6k commits) took 31–51 s;
  full lodash always timed out. Two of four express runs failed **only when probed every 250 ms**
  (both probe-free and 3 s-probe runs succeeded); heavy polling of an importing repo may slow the
  import (n is small: treat as a likely effect, not proven).
- `depth` is the fix for large repos: lodash `depth:1` imported in 4.5 s, `depth:100` in 8.1 s.
- **Only the requested branch is imported** (`ls-remote`: `HEAD` + that one branch; no tags, no other
  branches). With no `branch`, the remote's default branch (`master` for Hello-World) was imported.
- **`default_branch` in the import response and in `GET /repos/:name` is wrong**: it says `"main"`
  while `HEAD -> refs/heads/master`, and `log?ref=main` returns `200 []` (the S2 A5 trap again).
  `GET /repos/:name` does carry `source: "git:https://github.com/<o>/<r>.git"`.
- The import response carries a write token (default TTL, `?expires=` suffix), same as create.

## Implications

### Task 17 (outbox consumer, wakeups)
- Use `pushed` purely as a **wakeup** to reconcile: on an event, re-read the ref sha (runner
  `ls-remote` or ledger) and compare with the ledger. Never apply `before/after` from the event as
  truth. Expect ~0.5–1.2 s end-to-end at batch size 1; with default batching budget +5 s.
- Dedupe by `(repo, ref, after)` (idempotent reconcile), not by Queue message id: the at-least-once
  contract allows redelivery with the same body.
- Do not rely on order: ordering held here, but nothing promises it. A reconcile that reads the
  current ref makes order irrelevant.
- One push → one event **per ref**; a new ref whose commits were already announced comes with
  `commits: []`. Candidate/checkpoint refs under `refs/commonforge/...` do emit events, so the
  consumer can wake on candidate pushes, but must filter by ref prefix.
- Keep the periodic sweep (GC Workflow / cron) as the backstop for missed events: the account-level
  `forked`/`imported` events silently never arrived, which shows events can be absent without error.
- Subscriptions are per repo (`artifacts.repo` needs `repo_name`), so wakeups need **one subscription
  per watched repo** (canonical repos at least), created after the repo, via REST (wrangler cannot
  set the filter). Alternatively the account-level `artifacts` source gives create/delete only.
  Subscription create took 0.4–1.1 s.
- Set `max_retries` and a DLQ on the consumer; acking is per message.

### Task 16 (intake: public URL import)
- Treat the import POST as a **long synchronous call (up to ~70 s)**: run it from a Queue/Workflow
  step, not inside the interactive request. Do not poll aggressively while it runs (≥ 2–3 s interval
  if at all); the POST's own 201 is the completion signal.
- Map outcomes: `201` = ready (repo is cloneable within ~0.3–2 s for `ls-remote`); `422/10106` =
  private or missing repo (show "only public repositories"); `504/10401` = too big for the budget,
  repo already rolled back: **retry with `depth`** (e.g. 1 or 100) rather than the same call;
  `409/10201` = name taken (a previous import still running or done: `GET /repos/:name` and treat
  `409/10302` as "still importing", `404` as "gone").
- During polling: `404` in the first second and `409/10302` mean "in progress"; a `404` **after**
  `409` means "failed and rolled back".
- Always pass `branch` explicitly and record it; do not trust `default_branch` from the response
  (`"main"` even when the imported branch is `master`). Use the short branch name for REST reads.
- Imports bring one branch and no tags. If intake needs tags/other branches, the runner must push
  them separately (git push to the new repo) after import.
- Don't expect a `repo.imported` event; `repo.created` is not emitted for imports either.

## Cleanup

Done by `run.mjs teardown` plus a manual finish (the first teardown hit two ordering bugs, now
fixed in the script: wrangler refuses to delete a Worker that is still a Queue consumer
(`code 10064`), and `wrangler queues delete` has no `--force`):

- Deleted all 16 repos this spike created that still existed (6 were already gone: the 422 import,
  and the timed-out imports that rolled back). Final namespace listing: `[]`.
- Deleted both event subscriptions (final `GET /event_subscriptions/subscriptions`: `[]`).
- `wrangler queues consumer remove`, then `wrangler delete` (Worker gone: `GET /workers/scripts/…` 404;
  `GET /workers/durable_objects/namespaces` shows no `EventRecorder` namespace), then
  `wrangler queues delete` (queue list: `[]`).
- The `commonforge-spike` namespace is left in place (no namespace delete route; shared with other spikes).
- Repos created by another task during the run were observed in the event log only, never touched.

## Reproduce

```sh
source scripts/load-dev-vars.sh
node spikes/events-import/run.mjs                    # setup -> push -> import -> teardown (~6 min)
# or step by step (state in $SPIKE_STATE_DIR or $TMPDIR, mode 0600):
node spikes/events-import/run.mjs setup push
SPIKE_IMPORTS=hello-world,expressjs SPIKE_PROBE_MS=3000 node spikes/events-import/run.mjs import
SPIKE_NO_PROBE=1 SPIKE_IMPORTS=lodash node spikes/events-import/run.mjs import
node spikes/events-import/run.mjs teardown
```
