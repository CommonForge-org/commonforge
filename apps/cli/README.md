# cforge

The CommonForge developer CLI. `cforge` checks a CommonForge task out as ordinary git
repositories, then pushes and freezes your work as candidates for review. Git talks to
CommonForge through `cforge credential-helper`, so no token is written to disk, to git config or
to the workspace.

Requires Node.js 22 or later and `git` (plus `git-lfs` for folders that use Git LFS).

## Install

```sh
npm install -g @commonforge-org/cli
cforge --version
```

## Point it at your CommonForge API

There is no hosted default. Pass the API URL of the CommonForge deployment you use, once:

```sh
cforge login --api-url https://api.example.com --email you@example.com
```

`cforge login` remembers the URL in its config file. You can also set it per command with
`--api-url <url>` or the `CFORGE_API_URL` environment variable. With none of these, cforge uses
`http://localhost:8787` (a local `wrangler dev` worker). Plain `http` is only accepted for
localhost.

## Sign in

```sh
cforge login --email you@example.com      # emails a one-time code, then asks you to paste it
cforge login --code cfm_...               # or finish later with the code (or the emailed link);
                                          # pass the same --api-url if you have not logged in before
cforge whoami
cforge logout
```

The session is stored with mode 0600 in your config directory (`~/.config/commonforge` on
Linux, `~/Library/Application Support/commonforge` on macOS, `%APPDATA%\commonforge` on
Windows; override with `CFORGE_CONFIG_DIR`).

## Find a task

```sh
cforge project list
cforge project tasks <projectId>
```

If you belong to more than one organization, add `--org <orgId>` (or set `CFORGE_ORG`).

## Check out

```sh
cforge checkout <taskId> ./work
```

This takes the task's lease, clones each folder of the task into `./work/<mount>`, and verifies
the result against the server's plan. Options: `--lease-ttl <seconds>`, `--wait <seconds>`
(wait for a lease someone else holds).

## Save and submit

Inside the checkout, work with git as usual. Then:

```sh
cforge checkpoint --commit "WIP"          # push a recoverable checkpoint (not frozen)
cforge submit --commit "Fix the quote"    # push, then freeze: prints the candidate id(s)
```

Both commit everything first when you pass `--commit <message>`; without it only committed work
is pushed. `--mount <name>` (repeatable) limits them to some folders, `--workspace <dir>` runs
them from outside the checkout. `submit` also takes `--tool <name>` to record what produced the
change.

## Check status

```sh
cforge status              # inside a checkout
cforge status <taskId>     # anywhere
```

Shows the task, its lease, its candidates and the local checkout.

## For agents and scripts

Every command takes `--json` and then prints exactly one JSON document on stdout (errors too,
with a non-zero exit code). An agent can be handed a task lease instead of a login:
`CFORGE_LEASE_TOKEN` together with `CFORGE_LEASE_API_URL`, the API that issued it.

Run `cforge --help` or `cforge <command> --help` for every command and option, including
`task create|lease|release` and `export`.

## Use it from an AI app (MCP)

`cforge mcp` serves these commands as MCP tools on stdio: `sign_in`, `who_am_i`, `list_projects`,
`list_tasks`, `create_task`, `get_task`, `checkout_task`, `save_progress` and `submit_task`. Each
tool runs the matching command with `--json`, as the signed-in person, with the same config
directory, so the CLI and the app share one sign-in.

- **Claude Desktop:** install `commonforge.mcpb` (the repository's latest release; build it with
  `pnpm --filter @commonforge-org/cli mcpb`, which writes `dist/commonforge.mcpb`). It carries the
  CLI, so nothing else needs installing.
- **Claude Code:** `/plugin install commonforge --marketplace CommonForge-org/commonforge` (the
  plugin adds the server and a skill for the task routine; on Claude Code before 2.1.275, run
  `/plugin marketplace add CommonForge-org/commonforge`, then `/plugin install
  commonforge@commonforge`), or `claude mcp add --scope user commonforge -- cforge mcp`.
- **Codex:** add to `~/.codex/config.toml`:

  ```toml
  [mcp_servers.commonforge]
  command = "npx"
  args = ["-y", "@commonforge-org/cli", "mcp"]
  ```

Then get a sign-in code on the app's **Account** page and paste the message into the chat; the
agent passes it to `sign_in`. Checking out and submitting need an app that can edit local files.

`sign_in` will not move a live sign-in to another address (text the agent reads could otherwise
point it at another server): sign out of the current one first. `cforge mcp --api-url <url>` (or
`CFORGE_API_URL`) keeps it to one address.

## License

MIT. The bundled third-party code and its licences are listed in
`dist/THIRD_PARTY_LICENSES.txt`.
