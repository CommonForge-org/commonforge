# G1 authority map

Inspected baseline: `d5ab4eb`. Existing agency paths retain their semantics for legacy projects.
New mode requires authoritative resource ownership and transaction-level checks, not UI flags.

| Mutation | Existing path | Required new-mode boundary |
|---|---|---|
| Direct proposal accept | `routes/accept.ts` → `OrgLedger.accept` | Reject missing outer project envelope inside the transaction |
| File or asset accept | `services/file-changes.ts`, `files.accept` → `OrgLedger.accept` | Same check, including queued work |
| Asset construction | `services/asset-changes.ts`, copy/manifest steps | Staged bytes are not accepted source; ordinary accept remains gated |
| Promotion | `services/promotions.ts` → `OrgLedger.accept` | Explicit unsupported mode, including queued accept |
| Restore | `routes/restore.ts` → `OrgLedger.restore` | Current knowledge recovery proposal required; legacy restore refused |
| Genesis, adopt, import | `services/resources.ts`, `intake.ts`, `folder-init.ts` → `OrgLedger.bindHead` | Explicit bootstrap before enablement or controlled manifest attachment |
| Release | `services/releases.ts`, prepare/approve/deploy and internal promotion release | Bind accepted project manifest; refuse legacy release prepared before enablement |
| Handoff | `/auth/cli/code` → broad user handoff session | New handoff exchange must mint task-scoped principal, never user impersonation |
| Policy/mount mutations | `routes/projects.ts` | Prevent staging activation, downgrade and shared-resource bypass |

A resource can have multiple mounts/projects. Enabled resource ownership must be stored in
OrgLedger or sharing explicitly prohibited. Proposal project ID alone cannot protect a resource
also mounted by a legacy project. Enablement must exclude in-flight operations, with transaction
checks retained to close races. D1 projection reads cannot authorize head movement.

`OrgLedger.accept`, `restore`, and `bindHead` are the existing head writers. They use pure ledger
plans and synchronous SQLite transactions. New project acceptance must commit project state,
source writes, decisions, idempotency and existing outbox in that same transaction.

Signed job outer envelopes are strict in `packages/runner-protocol/src/jobs.ts`. Verification
signs raw fields before parsing (`sign.ts`); nested job schemas mostly strip unknown fields.
New semantics require explicit protocol discrimination; unknown fields cannot convey authority.
Existing job domain is `cf.signed-job/1` and existing hashes must remain unchanged.

`scripts/dev-local.sh` uses `apps/worker/e2e/stack.ts`: real miniflare storage/queues, fake source,
runner, deployment and health. `Services.provider()` concretely constructs an Artifacts provider;
real-local needs an explicit provider/control-plane seam. The existing Node runner supports
polling, broker credentials, real Git, filesystem blobs and subprocess isolation.
`provider-local-git` file remotes prove real Git behavior but are advisory security: hostile local
processes can disable hooks. Smart HTTP plus denying agent repository filesystem access is the
required isolation boundary. Report real execution and isolation verification separately.
