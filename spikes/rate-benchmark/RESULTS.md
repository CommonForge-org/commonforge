# S5: Artifacts rate-limit / cost benchmark: results (A9)

Live runs on 2026-10-06 (UTC) against the dedicated CommonForge Cloudflare account (Workers Paid),
git 2.55, Node 26. The script is `run.mjs` in this directory. Namespaces were
`commonforge-bench-canonical` (one small seed repo) and `commonforge-bench-tasks` (fork baseline plus
every per-task repo). Raw evidence (API token, repo tokens and account id redacted) is in
`results-*.json`. Every repo was deleted; the final sweep listed both namespaces empty after each run.

**Possible interference:** other implementers were running small live tests in other namespaces on
the same account at the same time. Any account-level (rather than namespace-level) limit or platform
flakiness they caused would show up here; the cluster of fork 500s in one batch (below) could be that.

## Verdict

| ID | Verdict | One line |
|---|---|---|
| **A9**: 100 synthetic task lifecycles (fork + token + clone + push + revoke + delete) stay under 2,000 req/10 s | **VERIFIED** | 7 batches of 100 lifecycles (700 in all) at concurrency 1/10/25/50/100 (fork) and 25/50 (create): **0 HTTP 429s** on any control-plane or git request. The busiest 10 s window of a lifecycle batch peaked at **474 control-plane requests** (c50, including retries), about 24% of the documented 2,000/10 s/namespace. A separate read burst reached **2,286 control-plane requests in 10 s** in one namespace with **0 429s**. |

Caveat on reliability, not rate: in one c50 batch, **19 of 100 forks returned HTTP 500 (code 10400)**
on the first attempt. Their names then stayed reserved: retries got **409 `10201 repo already exists`**
while `GET /repos/:name` still returned **404**, before a later retry got 201. All 100 lifecycles
completed with retries. The c100 batch run immediately afterwards had no errors.

## What one lifecycle costs in requests (measured)

| Step | Kind | Requests | Notes |
|---|---|---|---|
| `POST /repos/:base/fork` (or `POST /repos`) | control | 1 | fork is ~1.5–2.4 s, create ~1.4–1.5 s |
| `POST /tokens` (write, TTL 600 s) | control | 1 | |
| `git clone` | git | 3 (fork) / 2 (empty create) | protocol v2: `GET info/refs`, `POST ls-refs`, `POST fetch` (no fetch for an empty repo) |
| `git push` one commit | git | 2 | protocol v1: `GET info/refs?service=git-receive-pack`, `POST git-receive-pack` |
| `DELETE /tokens/:id` | control | 1 | |
| `DELETE /repos/:name` | control | 1 | 202 |
| **Total (no retries)** | | **4 control + 5 git = 9** (fork) / 4 + 4 = 8 (create) | git requests counted from `GIT_TRACE_CURL` |

Retries add requests. At c50, the 19 fork 500s cost 18 extra 409s, 37 recovery `GET`s and 37 fork
retries, so 474 control-plane requests instead of 400.

## Results per batch (100 lifecycles each)

Latencies are per operation in ms, including retries. "Peak/10 s" is the largest number of requests
in any sliding 10 s window.

| Batch | Wall | Lifecycle p50 / p95 / max | Control / git reqs | Peak/10 s control / git | 429 | 5xx | Retries |
|---|---|---|---|---|---|---|---|
| fork c1 | 422.5 s | 4,032 / 5,042 / 13,041 | 400 / 500 | 12 / 15 | 0 | 0 | 0 |
| fork c10 | 43.2 s | 4,036 / 5,016 / 5,816 | 400 / 500 | 110 / 150 | 0 | 0 | 0 |
| fork c25 | 18.5 s | 4,006 / 4,963 / 6,900 | 400 / 500 | 267 / 369 | 0 | 0 | 0 |
| fork c50 | 11.5 s | 4,510 / 7,036 / 8,137 | 474 / 500 | 474 / 500 | 0 | 19 (fork, 10400) | 37 (fork) |
| fork c100 | 8.2 s | 7,152 / 7,678 / 8,161 | 400 / 500 | 400 / 500 | 0 | 0 | 0 |
| create c25 | 16.5 s | 3,517 / 4,479 / 6,528 | 400 / 400 | 302 / 306 | 0 | 0 | 0 |
| create c50 | 8.0 s | 3,547 / 4,043 / 4,045 | 400 / 400 | 400 / 400 | 0 | 0 | 0 |

### Per-operation latency (p50 / p95 / max, ms)

| Op | fork c1 | fork c10 | fork c25 | fork c50 | fork c100 | create c25 | create c50 |
|---|---|---|---|---|---|---|---|
| fork / create | 1,519 / 2,053 / 2,169 | 1,532 / 2,244 / 2,498 | 1,536 / 2,040 / 2,212 | 2,024 / 5,015 / 6,038 | 2,432 / 2,469 / 2,656 | 1,480 / 2,011 / 3,000 | 1,497 / 1,560 / 1,572 |
| token | 220 / 304 / 522 | 225 / 372 / 2,299 | 220 / 430 / 514 | 190 / 276 / 571 | **735 / 1,716 / 1,955** | 218 / 467 / 1,143 | 187 / 298 / 409 |
| clone | 372 / 603 / 814 | 403 / 605 / 726 | 426 / 650 / 2,182 | 381 / 692 / 958 | 417 / 786 / 860 | 203 / 400 / 569 | 209 / 512 / 585 |
| push | 323 / 533 / 730 | 335 / 554 / 807 | 357 / 610 / 706 | 324 / 585 / 767 | 329 / 546 / 711 | 304 / 487 / 639 | 304 / 576 / 801 |
| revoke | 275 / 403 / 1,106 | 269 / 355 / 442 | 240 / 325 / 611 | 239 / 294 / 429 | **857 / 1,705 / 1,938** | 232 / 309 / 3,705 | 224 / 272 / 350 |
| delete | 1,225 / 1,769 / 10,358 | 1,176 / 1,433 / 1,618 | 1,194 / 1,422 / 1,808 | 1,166 / 1,376 / 1,525 | 1,679 / 2,644 / 3,047 | 1,057 / 1,361 / 2,073 | 1,072 / 1,386 / 1,435 |

Latency is flat from c1 to c25. At c100 there are still no 429s, but token mint and revoke are 3–4x
slower and fork and delete are about 40–60% slower. Lifecycle p50 goes from 4.0 s to 7.2 s. The
service queues work under load instead of rejecting it.

### Control-plane read burst (rate probe)

`GET /repos/<base>` x 2,400 at a target of 240 req/s against `commonforge-bench-tasks`: all 2,400
were sent in 11.3 s, the **peak sliding 10 s window was 2,286 requests**, and every response was 200
(per second: 83, 188, 213, 220, 212, 220, 257, 232, 242, 263, 226, 44). The documented
2,000 req/10 s/namespace limit was not enforced on reads at this level, or it is enforced over a
different window or key. I stopped there rather than escalating further past the documented limit.
Writes (fork, create, token) were not burst-tested above 474/10 s.

### Rate-limit headers

None. No `ratelimit-*`, `retry-after` or similar header appeared on any of the 5,316 control-plane
responses (this matches S2). A client can't pace itself from headers; it needs its own budget.

## Other findings

1. **Forks are namespace-local.** `POST /namespaces/<canonical>/repos/:seed/fork` with
   `{ name, namespace: "<tasks>" }` (or `target_namespace`) returns 201 but creates the fork in the
   **source** namespace and ignores the field. Splitting a canonical namespace from a task namespace
   therefore needs a **baseline mirror** in the task namespace: one extra create plus push, and a
   re-push of the mirror each time canonical advances. The benchmark does this in setup.
2. **Fork 500s are not idempotent and leave a ghost name.** The pattern was 500 (10400), then GET
   404, then fork 409 (10201 `repo already exists`), then GET 404, then fork 201. The 409 doesn't mean
   the repo exists and is usable. The name is reserved while the failed fork rolls back. No orphan
   remained (the sweep found no leftovers).
3. **Repo token format changed.** Tokens are now `art_v2_x_<hex>?expires=<epoch>`, where S2/S3 saw
   `art_v1_<hex>`. Redaction written for `art_v1_` misses the new format. This script redacts
   `art_v\d+_[A-Za-z0-9_]+`.
4. The fork and create responses still include a write token with the default 86,400 s TTL and no
   token id. The benchmark ignores it and mints its own 600 s token. Deleting the repo invalidates it,
   but while the repo exists it is a long-lived credential the orchestrator must not log or persist.
5. Per-repo git load is trivial. A lifecycle makes 5 git requests to its own repo; the documented
   2,000 git req/10 s limit is per repository and is not a constraint for per-task forks.

## Cost projection

Pricing (plan §0.2): billing starts **2026-10-14**. Each month includes 10,000 operations (and 1 GB-month);
after that it's **$0.15 per 1,000 operations**. Pricing docs don't say whether a git smart-HTTP request is
one "operation", so two bounds are shown:

- **A. Control plane only:** 4 ops per benchmark lifecycle.
- **B. Every request (control + git):** 9 ops per benchmark lifecycle.
- **C. Realistic CommonForge task (estimate, not measured):** about 30 ops. That is the 9 above, plus
  integration (read token for the fork and write token for canonical, mint and revoke = 4; runner
  fetch of the fork = 3; push to canonical with `--force-with-lease --atomic` = 2; `ls-remote`
  verification = 1–2; baseline-mirror refresh about 4), plus about 6–8 Worker REST reads (log,
  commit, tree, file) for compare and review.

| Scenario | Tasks / month | Ops / month (A / B / C) | Billable over 10k (A / B / C) | Cost / month (A / B / C) |
|---|---|---|---|---|
| Demo: 3 agents x ~4 tasks, ~10 rehearsals | ~120 | 480 / 1,080 / 3,600 | 0 / 0 / 0 | **$0 / $0 / $0** |
| 1,000 tasks/day | 30,000 | 120k / 270k / 900k | 110k / 260k / 890k | **$16.50 / $39.00 / $133.50** |

The marginal cost per task after the included ops is $0.0006 (A), $0.00135 (B) and about $0.0045
(C). Storage is negligible for small per-task forks that get deleted, but fork storage billing is
undocumented. Retries add little: +18% control ops in the worst batch (c50), +0% elsewhere.

This spike used about **8,600 requests** (5,316 control-plane + 3,312 git). That was before billing
starts, so it cost nothing. After 2026-10-14 the same run would use most of a month's included
10,000 ops.

**Rate headroom for 1,000 tasks/day:** that is about 0.012 tasks/s, or about 0.05 control-plane
req/s. At 4–5 control requests per task, the documented 2,000/10 s per namespace allows about 400–500
task starts per 10 s, so there is about four orders of magnitude of headroom. Latency rises at about
100 concurrent lifecycles, well before any rate limit.

## Recommendations

1. **Concurrency cap:** limit concurrent fork/create plus token operations to **25 per namespace**.
   Latency is flat up to c25 and degrades at c100. Put this cap in the Queue/Workflow consumer that
   performs forks (plan §0.3 A2 consequence already moves forks there).
2. **Client-side budget:** without rate-limit headers, enforce a token bucket of **1,000 control-plane
   requests per 10 s per namespace** (50% of the documented limit) in the provider adapter. Count
   retries against it.
3. **Backoff:**
   - On 429: exponential with full jitter, starting at 1 s, doubling, capped at 16 s, at most 6
     attempts. Honor `Retry-After` if it ever appears.
   - On 5xx or a network error for idempotent calls (token, revoke, delete, reads): 300 ms base,
     doubling, cap 8 s.
   - Treat 404 on delete and revoke as success.
4. **Fork/create recovery (non-idempotent):** record the intended repo name in the ledger before the
   call. On 5xx, `GET` the name:
   - 200 with the expected baseline: adopt it.
   - 404: back off 1–2 s and retry the **same name**.
   - 409 `10201` while GET is 404: keep backing off, because the name is reserved by the failed
     attempt.
   Give up after about 30 s and use a fresh name (suffix `-r<n>`). A periodic sweep deletes `bench-`
   or task repos that the ledger doesn't know about.
5. **Namespace partitioning:** because forks can't cross namespaces, partition by **project x
   environment** (for example `commonforge-<env>-<project>`), with the canonical repo and its task
   forks in the **same** namespace. A separate canonical namespace costs a baseline mirror and an
   extra push per acceptance, and it only isolates rate limits that we are nowhere near. Use separate
   namespaces for dev, demo, prod and spikes so tests can't eat production's budget.
6. **Token hygiene:** mint short-TTL (600 s or the job duration) tokens per step and revoke them on
   completion. Never use or persist the 86,400 s token returned by fork/create. Update redaction to
   cover `art_v2_x_…`.

## Reproduce

```sh
source scripts/load-dev-vars.sh
node spikes/rate-benchmark/run.mjs --n=100 --concurrency=1,10,25 --label=fork-c1_10_25
node spikes/rate-benchmark/run.mjs --n=100 --concurrency=50,100 --burst=2400 --burst-rate=240 --label=fork-c50_100-burst2400
node spikes/rate-benchmark/run.mjs --n=100 --mode=create --concurrency=25,50 --label=create-c25_50
node spikes/rate-benchmark/run.mjs --sweep-only   # deletes any leftover bench-* repos in both namespaces
```

## Cleanup

Each lifecycle revokes its token and deletes its repo in `finally`. Each run ends with a sweep that
deletes every repo this run created, then deletes any `bench-*` repo listed in either namespace, and
lists both again. All three runs ended with `commonforge-bench-canonical: []` and
`commonforge-bench-tasks: []`. The namespaces themselves remain because there is no namespace-delete
route.
