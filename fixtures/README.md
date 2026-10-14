# Demo fixtures: "Demo Client / Customer Portal"

Synthetic client project used by the CommonForge demo (PRD §14.4, plan §C.1)
and by the acceptance tests. Nothing here is real customer data.

In the demo each directory below becomes its own **Resource** (a separate
Artifacts repo or R2 asset set). The integration runner materializes them as
sibling mounts named `website/`, `api/`, `requirements/` and `brand-assets/`,
which is also how they sit in this monorepo, so the cross-resource contract test
runs the same way locally and in the runner.

**Each fixture is self-contained.** Nothing references monorepo files: each
`tsconfig.json` inlines its compiler options rather than extending the root
base. The monorepo-only file `website/turbo.json` is harmless when it is
materialized. `scripts/check-standalone.sh` proves this. It copies `website/`,
`api/` and `requirements/` into a temp dir as siblings, installs each on its
own, and runs:

1. both typechecks and both test suites
2. the row-7 breakdown scenario: fail, then pass after the schema is updated
3. the website-only client-edition shape: the contract test is skipped, the
   rest passes

Run it after changing any fixture.

**Runner install policy (Tasks 14/22 and the follow-up).** Install the `api` and `website` mounts
before running website checks: the contract test imports the api source, and
that source resolves `hono` from `api/node_modules`. The integration runner does
this itself before integrate checks (`apps/runner/README.md`, "Dependency
installs"): for every mount whose `package.json` declares dependencies (or
that is a pnpm workspace) it runs, from the mount's committed `pnpm-lock.yaml`
(required), as the check uid:

    pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile \
      --config.pm-on-fail=ignore --no-runtime --no-trust-lockfile \
      --config.minimum-release-age=1440 \
      --config.minimum-release-age-exclude=@cloudflare/workers-types@5.20261006.1 \
      --config.minimum-release-age-exclude=@vitejs/plugin-react@6.1.2

(`installArgv` in `apps/runner/src/install.ts`), then runs the checks offline. No install script runs at all, which stays within the
monorepo's `allowBuilds: {esbuild: true, workerd: true}` (the fixtures' tests
and builds do not need those postinstalls). The release-age policy (pnpm's one-day default
plus the monorepo's `minimumReleaseAgeExclude`) is on the command line, so a
candidate's own `pnpm-workspace.yaml` cannot relax it. `check-standalone.sh`
instead writes the root `pnpm-workspace.yaml` minus `packages:` into each mount,
because pnpm 12 fails an install whose build scripts are not approved unless
scripts are ignored.
`api/` and `website/` ship their own standalone `pnpm-lock.yaml` (Task 22 review
m-5; generated outside the workspace with `pnpm install --lockfile-only`), so
the Sandbox recipes install with `pnpm install --frozen-lockfile
--ignore-scripts` (versions and integrity pinned; no install scripts). Inside
the monorepo the root lockfile governs and these files are ignored. Regenerate
them after changing a fixture's `package.json`.

| Fixture | Kind | Role in the demo |
|---|---|---|
| `website/` | Vite static site, package `@commonforge-org/fixture-website` | Customer Portal quote UI; consumer side of the `/quote` contract; the client edition edits it |
| `api/` | Hono Worker, package `@commonforge-org/fixture-api`, Worker `commonforge-demo-api` | `GET /quote`, `GET /version`, `/contacts` (staging D1 only); hidden from the client edition; publish target and `/version` health check |
| `requirements/` | Small text repo | `requirements.md` plus `contracts/quote.schema.json`, the declared cross-resource contract |
| `brand-assets/` | R2 asset set | `logo.png` (304 bytes) and a generated ~50 MB `brand-video.mp4` that must route to R2 |
| `demo-tasks/` | Task content (not a package) | Changes an agent writes during the demo, applied by the task rather than by default (see below) |
| `canary/` | Script that generates a git repo | AT-26: proves a fresh-history edition leaks no old-commit secret and no deleted directory |

## website/

`index.html` + `src/main.ts` render a quote form and call `${VITE_QUOTE_API_URL}/quote`
(empty means same origin; `vite` dev proxies `/quote` and `/version` to
`wrangler dev` on port 8787). Rendering lives in `src/quote-view.ts` as pure
string functions so tests need no DOM. `public/logo.png` is the site's copy of
`brand-assets/logo.png`.

The site deploys as a static-assets-only Worker: `wrangler.jsonc`, Worker
`commonforge-demo-website`, serving `./dist`. Build it with
`VITE_QUOTE_API_URL=<api origin>`, then run `pnpm run deploy`
(`vite build && wrangler deploy`), or `pnpm run deploy:dry-run` after a build.
Only the CommonForge publish step deploys it, from an accepted release. In
production it pairs with `commonforge-demo-api`.

Tests (`pnpm --filter @commonforge-org/fixture-website test`):

- `tests/quote-contract.test.ts` validates real `/quote` responses against
  `../requirements/contracts/quote.schema.json`. By default it imports the
  sibling api source (`../api/src/app.ts`) and calls it in-process. Env
  overrides: `QUOTE_API_URL` (fetch a running api, for example the private
  preview), `QUOTE_API_DIR`, `QUOTE_SCHEMA_PATH`.
  If the schema or the api (source or URL) is missing, the suite records one
  skipped test named `[quote-contract] SKIPPED: …` and prints the same note to
  stderr. That is the client-edition shape.
  The api sources and contract live outside the package, so `website/turbo.json`
  adds `fixtures/api/src/**` and `fixtures/requirements/contracts/**` to the
  test task's inputs. It also passes the `QUOTE_*` env vars through turbo's
  strict env mode. An api or schema change therefore invalidates the cached
  result (verified).
- `src/json-schema.ts` is a tiny hand-rolled JSON Schema subset validator
  (no ajv). Unsupported keywords throw, so a contract edit can't silently pass.
- `tests/quote-view.test.ts` covers rendering. Its `renderQuote` block ends
  with an anchor comment, "Quote view cases end here", where new presentation
  cases go. That is the same-file textual conflict point (AT-07).

### Website edition policy (client edition, Task 21)

The client edits a fresh-history edition of `website/` only. Suggested policy:

- **Read allowlist:** `index.html`, `src/**`, `public/**`,
  `tests/quote-view.test.ts`, `tests/json-schema.test.ts`, `package.json`,
  `vite.config.ts`, `tsconfig.json`.
- **Write-protected** (edits returned from the edition are rejected):
  `package.json`, `vite.config.ts`, `tsconfig.json`, `wrangler.jsonc`,
  `tests/quote-contract.test.ts`. The contract test is trusted integration
  evidence. A client or client agent must never be able to weaken or delete
  it. If the edition includes it read-only, it skips there because no api or
  contract is mounted.
- **Not in the edition:** `api/` (hidden source, PRD §14.4), `requirements/`
  and `brand-assets/` (R2). The canary fixture covers the history-leak side.

## demo-tasks/phone-field/

The content an agent writes for the video's second task ("add a phone number to contacts"): an
additive D1 migration plus the matching code. It is **not applied by default**: `api/` has only
`migrations/0001_init.sql`, and nothing in the monorepo, the tests or the seeder reads this folder.

- `migrations/0002_phone.sql`: `ALTER TABLE contacts ADD COLUMN phone TEXT;`. Additive, so the
  promotion gate's migration veto passes it (a `classify` path is still decided by a developer
  until the classifier is wired). Copy it into `api/migrations/` as the task's change.
- `api-code.patch`: `GET /contacts` returns `phone`, `POST /contacts` accepts an optional `phone`
  (a string of at most 40 characters), and the in-memory D1 test double stores it. From the
  monorepo root: `git apply --directory=fixtures/api fixtures/demo-tasks/phone-field/api-code.patch`
  (`git apply` run inside `fixtures/api` would skip the files silently). With the patch applied the
  fixture's 15 tests and its typecheck pass.

## demo-tasks/rename-column/

The video's third task ("rename email to email_address"), vetoed by the promotion gate as a
destructive migration. Not applied by default.

- `migrations/0003_rename_email.sql`: `ALTER TABLE contacts RENAME COLUMN email TO email_address;`.
- `api-code.patch`: `GET /contacts` selects `email_address`. It applies **on top of the phone-field
  patch** (the demo order is copy → phone → rename): apply phone-field first, then
  `git apply --directory=fixtures/api fixtures/demo-tasks/rename-column/api-code.patch`.

## api/

`src/pricing.ts` holds pure pricing from requirements R1.3/R1.4, with
deterministic quote ids (FNV-1a over the inputs). `scripts/quote-sample.ts`
prints one priced quote as JSON (`node scripts/quote-sample.ts`, no install):
the producer command of the runner's `/quote` contract check
(apps/demo-agents/README.md). `src/app.ts` handles
`GET /quote?plan=&seats=&customer=[&date=YYYY-MM-DD]` and
`GET /version` → `{ name: "commonforge-demo-api", version: APP_VERSION }`.
`wrangler.jsonc` sets `APP_VERSION`; a release bumps it, and the publish
health check reads it back. `pnpm build` is `wrangler deploy --dry-run`.

**Staging data (spec 2026-10-07).** `GET /contacts` and `POST /contacts {name, email}` use an
optional D1 binding `DB`; without one (production today, private previews) they answer
`503 {"error":"no database"}`. `migrations/0001_init.sql` creates the `contacts` table;
`seed/contacts.sql` and `seed/orders.json` (KV `ORDERS`) are the demo data. They are used only by
the demo policy's `staging` section (scripts/ci-live/project.ts, opt-in: `demoPolicy(…, { staging: true })`;
no live run turns it on until Phase 4 adds cleanup of `-staging` Workers and staging D1/KV); the
production release policy carries no D1 and no data.

**Baseline (staging phase 2b).** Staging in a project starts only after the owner has published the
current `main` to production once (the baseline: the live release was built from exactly the
resources' heads). `setupDemoProject` with `staging: true` does that right after saving the policy
(prepare a release, owner publish approval, deploy, then wait until `GET …/staging` says
`state: "active"`); until then landings wait with `awaiting_baseline` and promote and reset answer
`409 staging_awaiting_baseline`. The default (staging off) is unchanged.

## requirements/

`contracts/quote.schema.json` is **strict**: `additionalProperties: false`. A
producer that adds a response field without updating the contract fails the
website contract test even when every repo merges cleanly.

## brand-assets/

- `logo.png` is generated deterministically by `scripts/make-logo.mjs`
  (no deps, hand-rolled PNG encoder). `--color=#rrggbb` produces a variant,
  for example `node scripts/make-logo.mjs logo.png --color=#7c3aed`.
- `scripts/make-video.sh [out] [MB]` writes `brand-video.mp4` (default about 50 MB,
  seeded ffmpeg noise at 40 Mb/s, capped with `-fs`). It is larger than the
  32 MB Artifacts blob limit on purpose. It is git-ignored; never commit it.
  Requires `ffmpeg`.

## canary/

`scripts/make-canary-repo.sh [out-dir]` builds a 3-commit repo (default
`canary/out/canary-repo`, git-ignored, plus a bare `canary-repo.git` for
pushing):

1. `.env` with `CANARY_SECRET=cfcanary-3b9e1f7c-…` and `hidden-module/`
   (marker string `hidden-module-canary-7d1e`)
2. both removed
3. an ordinary README change on HEAD

Identity and dates are pinned, so shas are stable for a given git version. The script self-checks and
prints `CANARY_*` lines (secret value, hidden path, marker, the sha of the
commit that holds the secret, HEAD). AT-26 builds an edition from HEAD and asserts that
none of these values, and no `hidden-module/` path, appear in any object the
edition serves. Override the secret with `CANARY_SECRET_VALUE`.
The default value is committed on purpose. Any secret scan of this repo should
allowlist the `cfcanary-` prefix.

## Work the Task 19 demo agents do

- **Agent 1 (developer, website + api, one Change with two candidates):** add a
  quote **breakdown** field (for example `breakdown: { gross, discount }`) to
  `api/src/pricing.ts`, then render it in `website/src/quote-view.ts` with a
  test at the anchor in `tests/quote-view.test.ts`. The contract test then
  fails with `$.breakdown is not declared in the contract` (plan §C.1 row 7)
  until `requirements/contracts/quote.schema.json` declares `breakdown`. This
  was verified by hand: 3 contract cases fail, then pass once the schema is
  updated.
- **Agent 2 (client edition, website only, no api source):** improve the quote
  interface (copy, layout, total presentation) in `website/` and add its view
  test at the same anchor. That is a same-file textual conflict with agent 1
  in `tests/quote-view.test.ts`.
- **Agent 3 (brand/docs):** replace the logo, for example via
  `make-logo.mjs --color=…`, and edit `requirements/requirements.md` (for
  example R4 brand colour). The video stays in R2.

**Must be stated in the Task 19 prompts:**

- **Same-file conflict anchor.** Agents 1 and 2 must both be told to add their
  new view test directly below the anchor comment
  `// Quote view cases end here.` in `website/tests/quote-view.test.ts`. The
  AT-07 conflict depends on both inserting at that same spot. Both will
  probably also edit `renderQuote` in `src/quote-view.ts`, which can produce a
  second, acceptable conflict.
- **Both logo copies.** Agent 3 must replace **both** `brand-assets/logo.png`
  (R2) **and** `website/public/logo.png` (Git). Otherwise the deployed site
  keeps the old logo. This is an intended cross-resource change, and it makes
  agent 3 a website writer too.
- **Contract test under turbo.** If Task 22 runs the contract test against the
  preview through turbo, `QUOTE_API_URL` is passed through. Running vitest
  directly in the website mount also works.
