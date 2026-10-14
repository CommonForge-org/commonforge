<p align="center">
  <img src="brand/commonforge-headerlogo-light.png" alt="CommonForge" width="600">
</p>

# CommonForge

CommonForge is a self-hosted workspace where an agency, its clients and their coding agents change
a client's website together. Clients ask for changes as tasks. Agents work on each task in an
isolated copy of the code. Every change is checked, previewed on a staging site and approved
before it reaches production, and every accepted version can be restored.

For developers: it runs entirely on **Cloudflare Workers** and **Cloudflare Artifacts**. You
deploy it into your own Cloudflare account with one script, and agents work through a small CLI,
`cforge`.

| | |
|---|---|
| ![Getting started checklist on a new project](docs/images/getting-started.png) | ![Tasks board with client tasks, one on staging and one an agent is working on](docs/images/tasks-board.png) |
| **Getting started** walks a new owner from an empty organization to the first client task live. | **Tasks** (staging mode): client tasks move from Working to In staging, Waiting for approval and Live. |
| ![Give this task to your agent: one Copy prompt button, the steps by hand folded away](docs/images/give-to-agent.png) | ![The Change storyboard of a proposal that passed its checks](docs/images/change-storyboard.png) |
| **Give to agent** copies one prompt that a coding agent runs from start to finish: install, sign in, check out, submit. | **The Change storyboard**: what was asked, what changed, what was verified, and the next decision. |
| ![Versions: the accepted versions, the live one marked](docs/images/versions.png) | |
| **Versions**: every accepted version, the one production runs, and restore. | |

The screenshots come from the local stack (below), not from fixture data. To regenerate them, run
`pnpm --filter @commonforge-org/web run screenshots`
([apps/web/e2e/readme-screenshots.spec.ts](apps/web/e2e/readme-screenshots.spec.ts)).

## How it works

The path from a new deployment to a client's change in production:

1. **Owner signs in.** Sign-in is by emailed magic link. Only the addresses in the deployment's
   admin list (`COMMONFORGE_ADMIN_EMAILS`) may create an organization.
2. **Organization and project.** One organization per client; a project is one client site. The
   project's Overview shows a **Getting started** checklist that reads its progress from the real
   project state.
3. **Import the code.** *Files → Add* imports a public Git repository as the project's first version.
4. **Release target and first publish.** The project's *Settings → Policy* gets a Release section
   (a ready example is offered), which says how to build the site and which Cloudflare Worker runs
   production. Then *Versions → Publish this version*: prepare, approve publishing, publish.
5. **Staging.** A Staging section in the Policy turns on always-on staging. Staging starts from what
   production runs, so the first publish comes before it.
6. **Invite the client.** *Members → Invite*, role Client, with access to the project. Clients see
   only the projects they are given. Then choose, under *Settings → Access*, what they can do with
   each folder: **Can change** (their agent changes it, and the change goes to staging for review),
   **Read only**, or **No access**. A new client reads only until you choose.
7. **The client asks for a change.** The client creates a task on the **Tasks** board: a title and
   what they want, nothing else. Which folders the agent may change, only read, or never see comes
   from the access the owner set in step 6, not from the client.
8. **An agent does it.** *Give to agent* has one button, **Copy prompt for your agent**. The
   person pastes the prompt into a coding agent that can run commands (the Code tab in Claude
   Desktop, Codex, Claude Code, Cursor, …). The agent installs `cforge` if it is missing, signs in
   with a one-time code that the button puts in the prompt, checks the task out into its own copy
   of the task's folders, does the work and finishes with `cforge submit`. The same steps, to run
   by hand, are folded away under the button.
9. **Staging and review.** The submitted change goes to the shared staging site by itself and moves
   to *In staging*. The client tries it there.
10. **Production.** The client who asked for it (or a developer) promotes it from the board. It
    reaches production once it is approved and published; publishing is a separate, explicit step
    (owners by default).

Without staging, the same work goes through **Changes** instead: *New task*, *Give to agent*,
then *Make proposal* once the agent submits. The proposal opens as a Change storyboard: validation
runs the project's checks, then approve, accept as a new version, and publish are three separate
records. Clients of such a project edit a filtered **edition** copy and send it back as a proposal.

Underneath:

- Every task works in its own isolated Artifacts repository, with short-lived credentials scoped to
  that repository. Clients' editions have no access to the production repository.
- A SQLite Durable Object ledger decides, atomically, what becomes the accepted version. Stale
  proposals are refused, approvals are bound to the exact proposal hash, and restore is a new
  forward version.
- An integration runner in a Cloudflare Sandbox container does the git merge, the checks, the
  preview build and the push. The Artifacts API cannot write, so every write is a `git push` from
  the runner.

The repository also hosts the reusable versioned-workspace engine (`@commonforge-org/*`: core,
ledger, providers, runner protocol, conformance suites) that other products can adopt.

## Architecture

```text
 web app / cforge CLI / agents
            │  HTTPS (session cookie or bearer)
            ▼
 ┌─────────────────────────────┐   signed jobs (Queue)   ┌──────────────────────────────┐
 │ commonforge-worker          │ ──────────────────────▶ │ commonforge-runner           │
 │ Hono API, auth, broker      │ ◀────────────────────── │ Sandbox container per job:   │
 │ OrgLedger DO (SQLite)       │   results, credentials  │ git merge/check/push, builds │
 │ D1 directory, outbox, cron  │   (service binding)     └──────────────┬───────────────┘
 └──────┬───────────────┬──────┘                                        │ git push
        │ REST/binding  │                                               ▼
        ▼               ▼                               ┌──────────────────────────────┐
  R2 (assets,      Artifacts: <prefix>-<org>-canonical │ -tasks │ -editions repos      │
  manifests,       └────────────────────────────────────────────────────────────────────┘
  exports)         commonforge-preview: token-gated previews from R2 + a container per preview
```

The Worker names are the demo instance's; a bootstrap deployment calls them `<name>-worker`,
`<name>-runner` and `<name>-preview`. The HTTP API, deploy prerequisites and known deviations are
in [apps/worker/API.md](apps/worker/API.md).

Code comments and docs sometimes refer to "plan §…", "PRD §…", "AT-NN" (acceptance tests) or
"Task N". These point to internal planning documents that are not published; the code, the tests
and the docs in this repository are the source of truth.

| Path | Package | What |
|---|---|---|
| `packages/core` | `@commonforge-org/core` | Identities, schemas, hashing, path policy, provider contracts |
| `packages/ledger` | `@commonforge-org/ledger` | Acceptance invariants (pure `planCommit`) over a `LedgerStore` port |
| `packages/provider-cloudflare` | `@commonforge-org/provider-cloudflare` | Artifacts and R2 providers |
| `packages/provider-local-git` | `@commonforge-org/provider-local-git` | Local bare-git provider (tests, offline, exit path) |
| `packages/runner-protocol` | `@commonforge-org/runner-protocol` | Signed runner jobs, materialization plans |
| `packages/conformance` | `@commonforge-org/conformance` | Provider and ledger conformance suites |
| `apps/worker` | `@commonforge-org/worker` | Control-plane Worker + `OrgLedger`/`OpsGate` Durable Objects; also the preview and runner Workers (`src/preview`, `src/sandbox`) |
| `apps/runner` | `@commonforge-org/runner` | Integration runner (Sandbox container image, or a Node process) |
| `apps/web` | `@commonforge-org/web` | Web UI (React + Vite), served by the control-plane Worker |
| `apps/cli` | `@commonforge-org/cli` | Developer CLI, binary `cforge` |
| `apps/demo-agents` | `@commonforge-org/demo-agents` | Orchestrates three real agent sessions working concurrently |
| `fixtures/` | | The demo client project ("Customer Portal") |
| `scripts/` | | Bootstrap, teardown, deploy, the live CI harness, demo helpers |

## Quickstart (local, no credentials)

Requires Node.js 22 or newer, pnpm (the version pinned in `package.json`; `corepack enable`) and git.
Run the whole product on your machine without a Cloudflare account:

```sh
pnpm install
scripts/dev-local.sh          # or: pnpm dev:local; PORT=8813 scripts/dev-local.sh for another port
```

Open <http://127.0.0.1:8799> and sign in as `owner@agency.e2e.test` (the only address allowed to
create an organization; set `ADMIN_EMAIL=you@example.test` to change it). No email is sent: the
sign-in link is printed in the terminal as
`[commonforge dev] magic link for <email>: <link>` (and kept in
`apps/worker/.wrangler/dev-local.log`). Open it in the same browser. To use the CLI against it:

```sh
pnpm exec turbo run build --filter=@commonforge-org/cli      # bundles apps/cli/dist/index.js
node apps/cli/dist/index.js login --api-url http://127.0.0.1:8799 --email owner@agency.e2e.test
```

The CLI's sign-in link (`…/auth/cli?code=…`) is printed in the server's terminal too; paste it
when `cforge` asks, or run `cforge login --code <code>`.

This is the stack the local-stack e2e suite runs: the real control-plane Worker under
`wrangler dev -c apps/worker/wrangler.e2e.jsonc`, with local D1, Durable Objects, R2 and queues,
serving the real web app. Cloudflare Artifacts, the integration runner and the Cloudflare API are
in-memory fakes, so git pushes, merges, checks and deploys are simulated, previews do not run, and
everything starts empty on each run. `apps/worker/.dev.vars` is never read.

## Self-host on Cloudflare

`scripts/bootstrap.sh` deploys a complete CommonForge into your own Cloudflare account. It is
idempotent: rerun it to update.

You need Workers Paid, Cloudflare Artifacts and Containers (Sandbox) on the account, Docker on
your machine (the runner and preview images are built locally), Node.js 22+, pnpm and an API token.
The token needs Workers Scripts, Workers R2 Storage, D1, Queues, Workers KV Storage, Containers and
Artifacts: Edit, and Account Settings: Read. The Worker gets its own Artifacts-only token.

```sh
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…   # wrangler + account API (never echoed)
export CF_API_TOKEN=…                                   # the Worker's Artifacts token (Artifacts: Edit)
export COMMONFORGE_DEPLOY_API_TOKEN=…                   # optional: release deploys (Workers Scripts + KV: Edit)

scripts/bootstrap.sh --name acme --email-mode log --admin-emails you@acme.com --smoke   # a test deployment
scripts/bootstrap.sh --name acme --admin-emails you@acme.com,@acme.com \
  --email-from login@acme.com --app-domain forge.acme.com --preview-domain preview.acme.net
scripts/teardown.sh  --name acme                         # list what it created
scripts/teardown.sh  --name acme --yes                   # delete it and verify nothing is left
```

Custom domains and the email sender's domain must be zones on the same Cloudflare account as the
deployment. The app and preview domains must differ: previews run site code and never share the
app's origin. Onboarding the sending domain to Cloudflare Email Service is a manual step that the
script prints.

Prerequisites, every flag, the token scopes, state and ownership rules, and teardown are in
**[docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)**. It also covers local development against real
Cloudflare resources, and the maintainers' scripts for the project's own demo and CI instances
(`scripts/deploy-live.sh`, `scripts/deploy-ci.sh`, `scripts/ci-live/`).

## Install the CLI

```sh
npm install -g @commonforge-org/cli
```

It needs Node.js 22+ and Git. To run a CLI you changed yourself, build it from the source instead
(Node.js 22+, Git and pnpm):

```sh
git clone https://github.com/CommonForge-org/commonforge.git
cd commonforge
pnpm install
pnpm --filter "@commonforge-org/cli..." build
npm install -g ./apps/cli
```

Then `cforge login --api-url <your app URL> --email <you>`. *Give to agent* in the app shows the
rest, filled in for the task, and its **Copy prompt for your agent** lets the agent do all of this
by itself. (The app's hand-off panel shows the same commands; a self-hosted copy that changes the
CLI without publishing it can set `CLI_PUBLISHED` to `false` in
[apps/web/src/lib/handoff.ts](apps/web/src/lib/handoff.ts) to show the source build instead.)

### From Claude or Codex (MCP)

`cforge mcp` gives an AI app tools to sign in, list projects and tasks, create a task, check it
out and submit it. The app's **Account** page shows the setup for each app and makes the one-time
sign-in code:

- **Claude Desktop:** the `commonforge.mcpb` extension from the latest release. Open the file and click Install.
- **Claude Code:** `/plugin install commonforge --marketplace CommonForge-org/commonforge`
- **Codex:** a `[mcp_servers.commonforge]` entry in `~/.codex/config.toml` (see
  [apps/cli/README.md](apps/cli/README.md#use-it-from-an-ai-app-mcp)).

The plugin and the Codex entry start the server with `npx -y @commonforge-org/cli mcp`, so they
need Node.js 22+ but no separate install.

The tools can do only what the signed-in person can; see [docs/LIMITATIONS.md](docs/LIMITATIONS.md)
for what is tested.

## Build and test

```sh
pnpm install
pnpm build          # turbo: every package, the web app, the Worker bundles
pnpm typecheck
pnpm test           # unit and integration tests (miniflare, real git, fakes for Artifacts/runner)

pnpm --filter @commonforge-org/web exec playwright install chromium   # once
pnpm test:e2e        # Playwright: fixture-mode UI + the local stack (no credentials)
pnpm test:fault      # fault injection via COMMONFORGE_CHAOS flags + provider fault conformance
pnpm test:security   # the security acceptance tests across worker, runner, core, runner-protocol, conformance
pnpm test:live       # live-provider tests; need CF_API_TOKEN (CI runs them only when the secret is set)
```

[docs/LIMITATIONS.md §8](docs/LIMITATIONS.md#8-what-the-test-suites-fake-and-what-only-a-live-run-proves)
lists, per suite, what is real and what is faked. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.

## Demo

The project runs its own demo instance of CommonForge on its Cloudflare account. The competition
demo is a single eight-minute take against it; the script, beat by beat, is
[docs/DEMO-SCRIPT.md](docs/DEMO-SCRIPT.md).

## Spike results

Before anything depended on Artifacts and Sandbox behavior, each assumption the design rests on
was measured on a live Cloudflare account (evidence in `spikes/*/RESULTS.md`).

| | Assumption | Verdict | Consequence |
|---|---|---|---|
| A1 | Stale pushes are refused | PARTIAL: the server accepts `--force`, but never silently last-writer-wins | Every runner push uses `--force-with-lease` against the ledger's sha, one ref per push (`--atomic` is now refused) |
| A2 | Forks are fast and survive parent deletion | PARTIAL: they survive; 2.5 s at 1 MB, ~50 s at 500 MB | Forks and creates run in queue steps. Forks cannot cross namespaces, so task repos are fresh repos seeded by the runner |
| A3 | `git` runs in a Sandbox container and pushes to Artifacts | VERIFIED | Runner = Sandbox container, token injected on egress, internet off |
| A4 | Token revocation stops in-flight pushes | VERIFIED: effective on the next request (~170 ms) | Candidate freeze = token revocation |
| A5 | Custom refs and notes work | PARTIAL: over git yes; REST cannot resolve full ref names | The ledger stores shas; ref listing happens in the runner |
| A6 | `pushed` events arrive within ~5 s | VERIFIED (p95 1.1 s); `repo.forked`/`imported` never arrive | Events are wakeups only, with a periodic sweep as the backstop |
| A7 | Per-candidate preview hostnames | PARTIAL: needs a zone with wildcard DNS | Path-based, token-gated, expiring previews on one dedicated origin |
| A8 | Wrangler ≥ 4.145 with a remote Artifacts binding | VERIFIED | `wrangler dev` always uses real credentials |
| A9 | Rate-limit headroom for 100 task lifecycles | VERIFIED: 0 × 429 over 700 lifecycles | Cap of 25 concurrent fork/token operations per namespace |

## Limitations and what is simulated

**Nothing in the core path is simulated** on a Cloudflare deployment (yours, or the demo
instance): real Artifacts repositories, real `git push` from a real Sandbox container, the real
Durable Object ledger, R2, Queues, Email Service and real `wrangler deploy` releases. The local
quickstart is the exception: it fakes Artifacts, the runner and the Cloudflare API, and says so.

Also labelled as not live:

- The web app's **fixture mode** (`VITE_COMMONFORGE_FIXTURE=1`) runs the UI on in-memory sample
  data, always under a "Fixture mode" banner. Only the fixture-mode e2e suite uses it.
- The e2e, fault and security suites replace Artifacts, the runner and the Cloudflare API with test
  doubles, and they say so.

The main shortcuts of this build:

- Previews share one origin, the preview Worker's (a path per preview, token-gated, expiring).
- There is one ledger Durable Object per organization.
- Stale bases are refused, with no automatic rebase.
- Sign-in is by magic link only.
- No ArtifactFS: export is plain git bundles plus asset manifests.
- No private Git import. A confirmed ZIP intake creates its resources empty: copying the archive in
  needs a runner step that does not exist yet.

The full, honest list is in [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Contributing, security, licence

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Reporting a vulnerability: [SECURITY.md](SECURITY.md)
(not a public issue).

The code is [MIT](LICENSE) © 2026 CommonForge contributors. Third-party licences:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The CommonForge name and the logos in `brand/` are trademarks and are not covered by the MIT
licence; see [brand/README.md](brand/README.md).
