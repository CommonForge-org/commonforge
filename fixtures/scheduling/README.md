# Synthetic scheduling fixture

This resettable Worker module uses no production data, payments, email, or cloud service.
The clock is explicitly `2026-10-17T12:00:00.000Z`; the timezone is UTC. Exactly 24 hours
is allowed. Less than 24 hours requires a manager and a nonempty retained reason. Travel
blocks everybody, including managers. Roles in request JSON are synthetic test inputs,
not a production authorization mechanism.

The required scenarios live outside this tree in
`apps/runner/src/g1-scheduling-harness.ts`. Editing fixture tests or build scripts cannot
change that harness. The trusted supervisor tests HTTP responses from a candidate process
inside bubblewrap mount/PID/network namespaces. Candidate code cannot read the controlling
instance or the supervisor's signing keys. This is a concrete Linux local backend, not a
Cloudflare runtime emulator or a claim of production scheduling readiness.

Run `scripts/dev-real-local.sh` from the repository root for a bounded real provider/runner
rehearsal. It prints JSON and writes a report under a new task-owned temporary directory.
Use `scripts/dev-real-local.sh --serve` to keep its real static preview and signed behavioral
bridge available. This isolated spike does not itself exercise Worker acceptance.

Run `scripts/dev-real-worker.sh` for the complete local control plane. It starts the real
Worker API and web app on port 8899, a separate preview origin on 8900, local SQLite/D1/R2,
real Git smart HTTP, a real signed Node pull runner, and the isolated behavioral verifier.
No cloud credentials are used. The fast `scripts/dev-local.sh` remains explicitly fake for
source/runner/cloud services; these commands have separate wiring and state.

Prerequisites: Node 22+, the pinned pnpm runtime, Git, Linux bubblewrap (`bwrap`) with working
unprivileged user/mount/PID/network namespaces, and `/usr`, `/lib`, `/lib64` runtime paths.
Missing isolation fails closed; there is no same-process candidate execution fallback.
Only Node recipe/check commands run locally; dependency installation and other command families
are unsupported. API previews accept standalone Node-compatible modules, and start with fresh
synthetic state per request. Workers-only APIs and real cloud deployment require separate checks.

Each startup prints a machine-readable report with `root`, URLs, and an operator configuration
file location. Those task-owned files contain local secrets and must not be committed or supplied
to an implementation agent. The local operator and external CLI share the development account;
this is local development infrastructure, not a multi-tenant hosting boundary. Candidate build,
check, and API processes see only their exported candidate tree and system runtime mounts.

Keep state across restarts with `G1_STATE_DIR=<root from startup report> scripts/dev-real-worker.sh`.
The command preserves its local keys, source coordinates, SQLite/D1/R2 state and runner journal.
A new startup without that variable creates a fresh disposable instance. No reset deletes
another instance or the developer's running checkout. Stop with Ctrl-C.

The public-API rehearsal can bootstrap a separate synthetic project and exercise scoped
handoff, real Git changes, integration, correction, independent verification and acceptance:

```sh
pnpm --filter @commonforge-org/runner exec tsx src/g1-worker-rehearsal.ts \
  /path/to/operator.json /path/to/worker.log --preview
```

The log supplies the local magic link; no mail is sent. `--self-development` instead snapshots
nonignored public repository source into an isolated Git project and changes the fixture's health
metadata. A later-context scripted cycle is explicitly reported separately from an actual fresh
agent. `g1-fresh-session.ts` prepares persisted task/context inputs for a separately invoked agent;
`g1-fresh-submit.ts` supervises its real submission and verification after that agent actually runs.
