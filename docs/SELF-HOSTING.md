# Self-hosting CommonForge on Cloudflare

CommonForge is self-hosted: you run your own copy in your own Cloudflare account.
`scripts/bootstrap.sh` sets up a complete deployment and is idempotent: rerun it to update the
deployment, or to finish one that stopped half way. `scripts/teardown.sh` removes it again.

The HTTP API, the full list of deploy prerequisites and the known deviations are in
[apps/worker/API.md](../apps/worker/API.md) ("Deploy prerequisites").

## Prerequisites

**Cloudflare account**

- Workers Paid. The integration runner and the previews run in Containers (Cloudflare Sandbox).
- Cloudflare Artifacts enabled on the account.
- For email sign-in (send mode): a sending domain onboarded to Cloudflare Email Service. The domain
  must be a zone on the same account (see [Email](#email)).
- For custom domains: their zones on the same account.

**Your machine**

- Node.js 22 or newer, pnpm (`corepack enable`), git, `openssl` and `curl`.
- Wrangler 4.145 or newer. It is a dev dependency of `apps/worker`, so `pnpm install` gets it, and
  the script checks the version.
- Docker. The runner and preview container images are built locally. A passwordless
  `sudo -n docker` also works.
- `zip`, only for `--smoke`.

**Credentials**, from the environment. They are never echoed or passed on a command line.
`--env-file <file>` loads them from a `.dev.vars`-style file instead.

| Variable | What it is | Minimal permissions |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Wrangler and the account REST API, used by the script | Account: Workers Scripts, Workers R2 Storage, D1, Queues, Workers KV Storage, Containers and Artifacts: Edit; Account Settings: Read; Workers Tail: Read (only for `--smoke`) |
| `CF_API_TOKEN` | The Worker's own Artifacts token | Artifacts: Edit only (a dedicated token) |
| `CF_ACCOUNT_ID` | The account the Worker uses | Defaults to `CLOUDFLARE_ACCOUNT_ID`; the two must match |
| `COMMONFORGE_DEPLOY_API_TOKEN` | Release deploys of your clients' sites | Workers Scripts and Workers KV Storage: Edit. Optional: when it is unset and the Worker has none yet, `CF_API_TOKEN` is installed in its place, with a warning |

The script runs read-only probes for these permissions before it creates anything. The probes
cannot prove Edit permissions: the create and deploy steps that follow do. They do not check zone
permissions either. With `--app-domain` or `--preview-domain`, the token must also be allowed to add
Custom Domains on those zones.

After the first run the script prints how to swap the broad token for dedicated ones: export the
new `CF_API_TOKEN` and `COMMONFORGE_DEPLOY_API_TOKEN` and rerun with `--replace-tokens`.

## Run it

```sh
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…
export CF_API_TOKEN=…                      # the Worker's Artifacts token
export COMMONFORGE_DEPLOY_API_TOKEN=…      # optional: release deploys

# a test deployment: sign-in links go to the Worker log; then sign in, create an org and a
# project, and run one runner job
scripts/bootstrap.sh --name acme --email-mode log --admin-emails you@acme.com --smoke

# a real one: emailed sign-in links, your own domains
scripts/bootstrap.sh --name acme --admin-emails you@acme.com,@acme.com \
  --email-from login@acme.com --app-domain forge.acme.com --preview-domain preview.acme.net
```

It checks the prerequisites. It then creates or reuses the five queues (with the dead-letter
queue), the D1 database (and applies the migrations) and the R2 bucket. It generates the session,
runner-job and preview keys, writes per-deployment Wrangler configs, and deploys the runner,
preview and control-plane Workers. Last, it checks `/health` and both container applications, and
prints the next steps.

### Options

| Option | Meaning |
| --- | --- |
| `--name <name>` | 3–16 lowercase letters and digits. Every resource derives from it: Workers `<name>-worker`, `<name>-preview` and `<name>-runner`, D1 `<name>`, R2 `<name>-assets`, the queues. Names that could reach the project's own instances (`commonforge*`, `ci`, `cfci`, `cfapp`, `prod`, `live`, …) are refused. |
| `--admin-emails <list>` | Who may create organizations: comma-separated addresses or `@domain` entries, case-insensitive (`COMMONFORGE_ADMIN_EMAILS`). Without it, the environment's `COMMONFORGE_ADMIN_EMAILS` is used. With neither, nobody can create one. |
| `--email-mode send\|log` | Default `send`. `log` writes sign-in links to the Worker log instead of mailing them: anyone who can read the account's Worker logs can then sign in as anyone. Use it for test deployments only. The script prints a warning, and the Worker refuses log mode on a production deployment. |
| `--email-from <address>` | The sender address. Its domain must be onboarded to Email Service on this account. It is recorded, so later reruns keep it. |
| `--app-domain <host>` | Serve the app on this custom domain instead of `<name>-worker.<subdomain>.workers.dev`. This adds a Custom Domain route on the Worker, and the app, public and runner URLs follow it. The worker's workers.dev URL is then turned off, which is Wrangler's default once a Worker has a route. `none` removes the domain. |
| `--preview-domain <host>` | The same for the preview Worker. It must differ from the app's domain: previews run your clients' site code and never share the app's origin. |
| `--smoke` | After deploying: sign in (log mode only), create an organization and a project, list them, and run one runner job. |
| `--adopt` | Take over same-named resources that this deployment's state does not record. Otherwise they are refused: they may be someone else's. |
| `--replace-tokens` | Install `CF_ACCOUNT_ID`, `CF_API_TOKEN` and `COMMONFORGE_DEPLOY_API_TOKEN` from the environment (all three are required). Sessions survive. |
| `--rotate-keys` | Generate and install new session, runner-job and preview keys. This signs everyone out. |
| `--env-file <file>` | Load the credentials from a `KEY=VALUE` file first. |
| `--skip-build` | Reuse the current build output. |

Without `--replace-tokens` or `--rotate-keys`, a secret the Worker already has is never replaced.
The custom domains and the sender are recorded, so a rerun without those flags keeps them.

### Email

Sign-in is by magic link, sent with Cloudflare Email Service. Onboarding a sending domain is a
manual step, and the script prints it:

1. The sending domain must be a zone on this Cloudflare account: the same account as the
   deployment and as the custom domains' zones, if you use any.
2. In the dashboard: Email Service, Email Sending, Onboard domain, then pick the zone. Cloudflare
   adds the bounce MX, SPF and DKIM records and a `_dmarc` record. That record is `p=reject` at the
   apex: mail sent for the domain through another provider without SPF/DKIM alignment is then
   rejected. Relax it to `p=none` in DNS if you need to.
3. When the domain shows as verified, rerun with `--email-from <login@your-domain>`.

The committed `apps/worker/wrangler.jsonc` only carries the placeholder `login@example.com`.

### Ownership and state

The state lives in `~/.config/commonforge/deployments/<name>/` (or `$COMMONFORGE_STATE_DIR`),
mode 0700. `deployment.json` is bound to the Cloudflare account. It records the identity of every
resource the bootstrap creates: the queue id, the D1 id, the R2 creation date, the Worker creation
time and the container application id. `secrets.env` (0600) holds the generated keys. The generated
Wrangler configs are `apps/worker/wrangler.deploy-<name>*.jsonc`, which git ignores.

A same-named resource whose identity is not the recorded one is refused, because it may be someone
else's (`--adopt` takes it over).

## Use it

1. Sign in at the app's URL with an address from `--admin-emails`, and create your organization.
2. Follow **Getting started** on the project's Overview (see the README's "How it works").
3. Install the CLI (README, "Install the CLI") and run
   `cforge login --api-url <your app URL> --email <you>`.

## Tear it down

```sh
scripts/teardown.sh --name acme          # list what would be deleted; nothing is deleted
scripts/teardown.sh --name acme --yes    # delete it, then verify nothing is left
```

It deletes only what the deployment's state records. It also deletes the resources only that
deployment's Worker creates, named `<name>-o-<org id>-*`: release Workers, KV namespaces, and the
Artifacts namespaces with every repository in them. It refuses when the account, or the identity of
a recorded resource, no longer matches. Names of the project's own instances are refused, and
there is no flag that tears them down. `--keep-state` keeps the local keys.

## Local development against Cloudflare

To run the Worker locally against real Cloudflare resources (Artifacts has no local simulator):
copy `apps/worker/.dev.vars.example` to `apps/worker/.dev.vars` (git-ignored) and fill it in. For
local sign-in add `COMMONFORGE_EMAIL_MODE=log`: the magic link is then printed in the `wrangler dev`
output. The Worker allows this only while `COMMONFORGE_PUBLIC_URL` is local.

```sh
pnpm --filter @commonforge-org/worker dev    # wrangler dev on http://localhost:8787
pnpm --filter @commonforge-org/web dev       # Vite on http://localhost:5173, proxies /api to 8787
source scripts/load-dev-vars.sh              # the same values in your shell (runner, CLI, scripts)
```

## Maintainers: the demo and CI instances

The project runs a demo instance on its own Cloudflare account (the competition demo) and a CI
copy of it. They are deployed with two maintainers' scripts instead of the bootstrap. You do not
need them to self-host.

```sh
scripts/deploy-live.sh [migrate] [worker] [preview] [runner]   # the demo instance: commonforge-{worker,preview,runner}
                                                               # (migrate applies D1 migrations; only when named)
scripts/deploy-ci.sh [setup] [secrets] [migrate] [runner] [preview] [worker]   # the CI copy (email log mode)
```

The committed `apps/worker/wrangler*.jsonc` are templates: their sender (`login@example.com`) and
D1 `database_id` are placeholders. Each script writes git-ignored
`apps/worker/wrangler.deploy-live*.jsonc` or `wrangler.deploy-ci*.jsonc` from values in
`apps/worker/.dev.vars` (a value already set in the shell wins for these settings; credentials
always come from `.dev.vars`). It refuses to run if a value is missing or still a placeholder.
`deploy-live.sh runner` alone needs only the URL settings.

| Variable (`apps/worker/.dev.vars`) | Used by | Meaning |
| --- | --- | --- |
| `COMMONFORGE_EMAIL_FROM` | both | the sender address onboarded for Email Sending |
| `COMMONFORGE_D1_DATABASE_ID` | both | the demo instance's D1 database id; `deploy-ci.sh` requires it so the CI id can never equal it |
| `COMMONFORGE_CI_D1_DATABASE_ID` | `deploy-ci.sh` | the `commonforge-ci` database id (checked against `wrangler d1 info commonforge-ci` before `migrate` and `worker`) |
| `COMMONFORGE_LIVE_BASE` | both, `scripts/ci-live/` | the account's `<subdomain>.workers.dev` |
| `COMMONFORGE_LIVE_APP_URL`, `COMMONFORGE_LIVE_PREVIEW_URL` | `deploy-live.sh` | optional: app and preview origins (default: their workers.dev URLs) |
| `COMMONFORGE_LIVE_APP_DOMAIN`, `COMMONFORGE_LIVE_PREVIEW_DOMAIN` | `deploy-live.sh` | optional: custom domains routed to the app and preview Workers |
| `COMMONFORGE_ADMIN_EMAILS` | `deploy-live.sh` | who may create organizations; the Worker is not deployed without it |
| `COMMONFORGE_PROTECTED_ORGS` | `scripts/ci-live/` | comma-separated org ids no harness may touch; list the demo recording org here |

`deploy-live.sh` refuses a Worker that is not in email send mode or that has active chaos flags.
The CI configs are generated from the templates by `node scripts/ci-config.mjs`, which refuses the
demo instance's resource names. `bootstrap.sh --production` deploys the templates' canonical names
too, always in send mode, and refuses to run without an admin list.

### Live CI harness

These scripts run against the CI instance with the real Sandbox runner and real Artifacts. They
take credentials from `apps/worker/.dev.vars` and need Node 23 or newer. Run `pnpm build` first.

```sh
node scripts/ci-live/e2e.ts          # the scripted full flow
node scripts/ci-live/rehearsal.ts    # the demo-agents orchestrator with real agents (--dry-run without)
node scripts/ci-live/take.ts         # the demo take (docs/DEMO-SCRIPT.md), beat by beat, timed
node scripts/ci-live/sweep.ts        # remove leftovers of interrupted CI runs (--dry-run)
```
