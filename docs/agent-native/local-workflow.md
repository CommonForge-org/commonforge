# Running the implemented G1 workflow

Use Node 22+, pnpm 12.5.1, Git, Linux and bubblewrap with unprivileged user/mount/PID/network
namespaces. The real-local verifier fails closed if namespaces cannot be created. No Cloudflare
account is needed. macOS/Windows require a Linux VM; an in-process fake is not an isolation substitute.
The current real runner supports Node entrypoints without dependency installation. This is a
bounded synthetic/reference workflow, not a general hosted execution fleet.

```sh
pnpm install --frozen-lockfile
pnpm --filter @commonforge-org/web exec playwright install chromium
pnpm dev:real-local
# another terminal, or an automated disposable stack:
pnpm test:g1:local
```

`dev:real-local` starts the actual Worker API, SQLite Durable Objects, D1 and local R2, a real Git
smart-HTTP sidecar, signed Node pull runner, static preview Worker and isolated HTTP scenario
supervisor. Default ports are 8899/8900; set `PORT`/`PREVIEW_PORT` for another task-owned instance.
The launcher prints a report location. Its state directory and operator file contain local keys;
keep them private. Use `G1_STATE_DIR=<existing task-owned directory>` to restart that instance.
Do not point it at someone else's data. Sign-in emails are printed to its private terminal/log.
Cloud credentials inherited from the shell are blanked. Cloud deployment is explicitly unavailable.

`pnpm dev:local` remains the faster fake stack. It simulates Git, runner checks and cloud deployment;
it cannot substantiate provider behavior. `pnpm test:g1:provider` runs the standalone real provider /
Node runner / preview / namespace rehearsal and reports its own narrower gates.

## Owner and agent workflow

1. Set up a project and its source folders before enabling Knowledge → **Enable project
   understanding**. Enablement is permanent and requires settled legacy work, no shared source
   resources and no staging mode. Existing accepted source becomes historical/unverified.
2. Record an outcome, draft a rule with its provenance, then confirm it. Add manual examples in
   Knowledge. The trusted scheduling fixture supervisor advertises pinned automated examples;
   the real rehearsal script installs those definitions through the same authorized API.
3. Create a task. **Give to agent** issues a single-use task handoff instead of a broad login.
   The agent runs `cforge handoff --code <code> --api-url <local-url>`, then `cforge checkout`.
   The protected `.commonforge/context.json` and `.md` carry the exact context digest and mandate.
4. After editing, use `cforge submit` and `cforge propose <taskId>`. Repeat propose while integration
   is queued. Preparation freezes the outer envelope only after the inner integration is fixed.
   `cforge results <taskId>` inspects this attempt's results; all tools also have structured MCP tools.
5. In Review, inspect exact rules, preview and evidence. Run required automated scenarios or attest
   to a manual scenario on the exact subject with a written observation. Record an exact decision,
   then accept separately. Acceptance does not release.
6. A correction creates a new confirmed revision and a manifest with verification outstanding.
   Old evidence remains inspectable and cannot authorize source acceptance under the new head.
   Request a fresh handoff/context and reverify. Replacement handoffs revoke prior task mandates.

The real API rehearsal is `apps/runner/src/g1-worker-rehearsal.ts`; the launcher supplies its private
operator file and Worker log. It creates disposable synthetic projects and produces machine-readable
reports. These reports distinguish real execution, scripted continuity, actual fresh-agent execution,
browser operation and unavailable cloud release. Never upload its owner-session/operator files or
magic-link logs. CI uploads only its sanitized report and screenshots.

## Bounded implementation and recovery

Knowledge-only confirmation never claims the deployed app satisfies a new rule. Source and knowledge
changes are currently two steps: confirm metadata, then refresh and independently verify source.
Source membership is fixed after enablement, and existing legacy staging/promotion/file-accept/restore
paths cannot bypass native acceptance. Owner/developer knowledge authority is seeded at enablement;
revocation fails closed. Adding or restoring authority after a later membership/access change needs
an explicit future reconciliation workflow. Transparent renewal of an existing pinned attempt is not
implemented; obtain a replacement handoff and checkout. A provider token already issued has at most
its bounded remaining lifetime; final acceptance still checks authoritative mandate revocation.

The synthetic fixture has an explicit UTC clock and travel state, the exact 24-hour boundary,
authorized/unauthorized manager overrides and retained reasons. Its harness lives outside candidate
write control; modifying candidate tests cannot weaken it. The control checkout, keys and host network
are absent from the behavioral namespace. The local runner wrapper also confines supported Node
build/check entrypoints; unsupported commands fail closed.

Keep Git exports and external CI/bootstrap available. Candidate verification never replaces the
running control instance. Release observations are bounded five-minute observations, not continuous
monitoring. Native release requires an exact compatible deployment runtime verifier; the current
Node fixture verifier does not establish Cloudflare deployment behavior. See
[release prerequisites and limits](release-rehearsal.md). Recovery of source is a newly reviewed
proposal under current knowledge; automatic legacy rollback and unmodeled external-effect recovery
are refused. There is no database/external-side-effect reversal automation.

Project bundle export reports missing source content and is not labeled a complete backup. Import
retains original history without granting its principals or evidence local authority; local rules and
scenarios start as drafts. Git materialization is separate. Evidence attachments are digest checked,
project scoped and conservatively retained while any history references them; orphan deletion first
records a permanent tombstone, so a racing evidence write cannot acquire a deleted attachment.
