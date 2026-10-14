# Security policy

## Reporting a vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting:
open the repository's **Security** tab and choose **Report a vulnerability**
(<https://github.com/CommonForge-org/commonforge/security/advisories/new>).

Do not open a public issue, pull request or discussion for a vulnerability.

Include what you found, how to reproduce it, and the impact you expect. We will acknowledge the
report, keep you updated while we fix it, and credit you in the advisory unless you prefer not to
be named. Please give us a reasonable time to release a fix before you disclose it.

## Scope

In scope: the code in this repository, including

- the control-plane, preview and runner Workers (`apps/worker`), the integration runner
  (`apps/runner`) and the web app (`apps/web`);
- the `cforge` CLI (`apps/cli`, published as `@commonforge-org/cli`), including its git credential
  helper;
- the engine packages (`packages/*`): identities, path policy, the ledger, providers and the
  runner protocol;
- the deployment scripts in `scripts/`.

Examples: authentication or authorization bypass, a credential or token leaking to the wrong
party, a task or client edition escaping its isolation, a way to get a change accepted without
the required approval, or a runner job reaching beyond its repositories.

Out of scope: vulnerabilities in Cloudflare's platform or in third-party dependencies (report those
upstream; tell us if CommonForge needs to react), deployments operated by someone else, social
engineering, and denial of service by volume. The known limitations in
[docs/LIMITATIONS.md](docs/LIMITATIONS.md) are not vulnerabilities by themselves, but a way to
exploit one beyond what that document says is.

## Supported versions

Only the `main` branch is supported. Fixes land on `main`; there are no maintained release
branches. For the CLI, use the latest published version of `@commonforge-org/cli`.
