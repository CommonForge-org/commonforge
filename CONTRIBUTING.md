# Contributing to CommonForge

Thanks for helping. Bug reports, fixes, tests and docs are all welcome. For a larger change, open
an issue first so we can agree on the approach before you write it.

Security problems: do not open a public issue. See [SECURITY.md](SECURITY.md).

## Setup

You need Node.js 22 or later, pnpm (the version pinned in `package.json`; `corepack enable` picks
it up) and git. `git-lfs` is optional; the tests that need it skip without it.

```sh
pnpm install --frozen-lockfile
pnpm build          # every package, the web app and the Worker bundles (turbo)
pnpm typecheck
pnpm test           # unit and integration tests; no credentials, no network
```

To run CommonForge itself without a Cloudflare account:

```sh
scripts/dev-local.sh      # http://127.0.0.1:8799, sign-in links printed in the terminal
```

See the README's "Quickstart (local, no credentials)" for what is real and what is faked there.

## Tests

| Command | What it runs | Needs |
|---|---|---|
| `pnpm test` | unit and integration tests of every package | nothing |
| `pnpm test:fault` | fault injection (`COMMONFORGE_CHAOS`) and provider fault conformance | nothing |
| `pnpm test:security` | the security acceptance suites | nothing |
| `pnpm --filter @commonforge-org/web run test:e2e:fixture` | Playwright against the UI in fixture mode | Chromium (below) |
| `pnpm --filter @commonforge-org/web run test:e2e:stack` | Playwright against the local stack (`wrangler dev -c wrangler.e2e.jsonc`), one story from sign-in to export | Chromium, port 8799 free |
| `pnpm test:live` | live-provider tests | Cloudflare credentials; CI runs them only when the secret is set |

Install the browser once with
`pnpm --filter @commonforge-org/web exec playwright install chromium`.

The local-stack suite and `scripts/dev-local.sh` use the same stack, so do not run them at the
same time on the same port. [docs/LIMITATIONS.md](docs/LIMITATIONS.md) lists, per suite, what is
real and what is faked.

Run the tests of the packages you touch before you open a pull request, and add tests for new
behavior. CI runs typecheck, build, the unit tests, the fault and security suites and the fixture
e2e on every pull request.

## Pull requests

1. Fork the repository (or create a branch if you have write access) and branch from `main`.
2. Keep each commit small and focused, with a message that says what changed and why.
3. Open a pull request against `main`. Describe the change, how you tested it, and anything you
   could not test.
4. A maintainer reviews it. CI must be green before it is merged.

No contributor licence agreement or DCO sign-off is required. By contributing you agree that your
contribution is licensed under the [MIT licence](LICENSE) of this repository.

## Style

- Match the surrounding code: naming, comment density and error handling.
- TypeScript everywhere; `pnpm typecheck` must pass.
- UI copy is plain, short and task-oriented, in the tone of the existing screens.
- Never commit credentials. `apps/worker/.dev.vars`, `.env` files and `.wrangler/` are git-ignored;
  keep it that way.
- If you change a third-party dependency, regenerate the notices with
  `node scripts/third-party-notices.mjs` and commit `THIRD_PARTY_NOTICES.md`.

Comments and docs sometimes refer to "plan §…", "PRD §…", "AT-NN" or "Task N". These point to
internal planning documents that are not published; the code and tests are the source of truth.
