# @commonforge-org/provider-local-git

`LocalGitProvider` is a `VersionProvider` (plan §B.2–§B.6, §B.10) over bare git repositories under one root directory. It backs tests and local development. It is also the exit route of plan §I Q15: `root` can be served by any git server, so canonical repositories do not depend on Cloudflare Artifacts. It passes the `@commonforge-org/conformance` provider suite.

```ts
import { LocalGitProvider } from '@commonforge-org/provider-local-git';

const provider = await LocalGitProvider.open({ root: '/srv/commonforge' });
const resource = await provider.createCanonicalResource({ organizationId: 'org-1', resourceId: 'res-1', source: '/path/to/repo' });
const runnerEnv = await provider.serviceGitEnv(); // { COMMONFORGE_TOKEN } for the integration runner's git
```

## Layout

| Path under `root` | Contents |
|---|---|
| `<prefix>-<org>-canonical/<resourceId>.git` | canonical repository, one per Resource |
| `<prefix>-<org>-tasks/ws-<id>.git` | task workspace: a fresh repository seeded with the base sha (no fork lineage) |
| `.commonforge/repos/<repoId>.json` | registry: role, owner, workspace state |
| `.commonforge/service-token` | the runner credential (mode 0600) |
| `exports/` | default export store |

## How it behaves

- **Revisions.** Revision ids have the form `local:<repoId>:<sha>`.
- **Canonical writes.** Every canonical write goes through the injected `RunnerSubmit`. The provider itself writes only three things: it seeds new task repos, takes the freeze lock, and deletes collected repos.
- **Push guard.** Each repository has one, installed as `pre-receive` and `reference-transaction`.
  - Canonical accepts only the service credential.
  - A task repo accepts only an unexpired write token issued for it.
  - Nothing is accepted after freeze or collect.
  - `--atomic` is refused, the same as on Artifacts.
- **Export.** `exportRevision` writes a full-history `git bundle` to an `ExportStore`.

## Security boundary

**Over `file://`, enforcement is advisory.** It catches mistakes and runs the conformance contract, but it does not stop a hostile agent:

- A `file://` pusher starts `receive-pack` itself, so it controls that process's command line and environment.
  - `git push --receive-pack='git -c core.hooksPath=/dev/null receive-pack'` skips the guard.
  - A fake `date` or `git` early on `PATH` defeats the expiry or digest check.
- Reads are never enforced over `file://`.

**Real enforcement** needs both of the following:

1. **Serve `root` over smart HTTP** (`git http-backend`) behind a front that:
   - authenticates `Authorization: Bearer <secret>` with `provider.authorizeGitRequest({ namespace, repoName, secret, operation })`. The `operation` is `write` for `git-receive-pack` and `read` otherwise.
   - runs the backend with `COMMONFORGE_TOKEN=<secret>`, so the server-side guard re-checks every push.
2. **Keep agents away from the host.** Agents can reach only that HTTP endpoint. They have no access to the `root` directory and no shell on the host.

Set the `remoteUrl` option so that coords carry the HTTP URLs.

## Operations

**Maintenance.** The guard also fires for local ref transactions. Plain `git pack-refs` or `git update-ref` without a credential is refused, and `git gc` skips packing refs. Use either:
- `provider.maintain()`, which runs `git gc` on every live repository;
- git with `-c core.hooksPath=<empty dir>`.

**Clock.** Credential expiry is stored as epoch seconds.
- The provider checks expiry against its `now` option.
- The guard checks it against the host clock (`date +%s`).
- Do not inject a skewed clock in production.

**Imports.** `createCanonicalResource` refuses a `source` that starts with `-`, and accepts only these forms of `sourceRef`:
- `HEAD`
- a full sha
- a full `refs/...` name

The fetch uses `--end-of-options` and allows only the `file`, `https` and `ssh` transports.

**Concurrency.**
- On-disk state is written atomically.
- Freeze is a compare-and-swap under git's ref lock, so it is safe across processes.
- Other per-workspace serialization is in-process only.
- The guard is a POSIX `sh` script, so native Windows is not supported.
