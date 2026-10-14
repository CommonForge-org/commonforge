# @commonforge-org/conformance

Reusable vitest suites that every engine adapter must pass. vitest is a **peer dependency**: the
suites call `describe`/`it` from your vitest.

| Entry | Runtime | Contents |
|---|---|---|
| `@commonforge-org/conformance` | Worker-safe | `describeLedgerConformance` |
| `@commonforge-org/conformance/provider` | Node only (real `git`, temp dirs) | `describeProviderConformance`, git/temp-repo helpers, `createReferenceRunner` |

## Ledger suite

```ts
import { describeLedgerConformance } from '@commonforge-org/conformance';

describeLedgerConformance(() => new MyLedgerStore(), { name: 'OrgLedger DO' });
```

It registers one test per scenario in `@commonforge-org/ledger`'s `LEDGER_SCENARIOS` (AT-09 … AT-15,
one per refusal code, replay, restore, bind, concurrency, optional checks, record-keeping guards).
The scenario logic lives in the ledger package. This suite only wraps it.

`record.*` scenarios are record-keeping proposal writes. Give the target a `putProposal(record, now)`
hook wired to the store's **real** record-keeping endpoint (RPC, route or plpgsql function, with its
clock pinned to `now`) and, if its errors are not `LedgerRecordError`s or `ledger_conflict:` /
`ledger_invalid_input:`-prefixed, a `recordErrorCode(e)` mapper. The scenarios then check that the
endpoint enforces the ledger's record guards (`checkProposalUpdate` etc. from
`@commonforge-org/ledger`). A target without the hook fails those scenarios with a clear message,
unless `allowPortOnlyRecords: true` (a store with no record endpoint, e.g. the in-memory store),
which runs them over the transaction port instead.

The factory must return a **fresh, empty** `LedgerConformanceTarget` for each call: a
`LedgerStore` plus `seed(seed: LedgerSeed)`. A `concurrent` step submits its operations together,
and the store must serialize them. Options: `skip: { [scenarioId]: reason }`, `dispose(target)`,
`timeoutMs`.

## Provider suite

```ts
import { describeProviderConformance } from '@commonforge-org/conformance/provider';

describeProviderConformance({
  name: 'LocalGitProvider',
  makeProvider: async (ctx) => {
    /* create canonical from ctx.seed, return ProviderUnderTest */
  },
});
```

The suite runs one lifecycle in order, with shared state. Three agents work concurrently, and
plain git checks every step. The suite keeps a simulated **ledger head**, the authority, separate
from canonical `refs/heads/main`, which is only its projection.

1. **Capabilities.** The provider has `gitTransport`, `writableCandidates` and `immutableRevisions`.
2. **Seed reads.** Canonical `refs/heads/main` equals the seed. `resolveRevision`, `readFile` and `listTree` work by sha. A missing file reads as `null`.
3. **Isolated changes.** `createIsolatedChange` runs three times in parallel. Each handle is `writable`, sits on the base, and is a distinct repository that is not canonical.
4. **Credentials.** `issueWorkspaceCredential` returns `write` for writable handles. It refuses a handle carrying canonical coords, and a handle in the `frozen` state with `workspace_not_writable`.
5. **Agent pushes.** Agents clone their task repo and push. Canonical is untouched.
   - An agent's write credential pushing to canonical `refs/heads/main`, to a candidate retention ref or to an integration ref is refused, and the refs are unchanged.
   - A `read` credential cannot push.
6. **Moved candidate.** `freezeCandidate` with a wrong `expectedSha` rejects with `code: 'candidate_moved'`.
7. **Freeze.** The step passes a false `declaredChangedPaths`. The returned `FrozenCandidate` fields are checked, and `changedPaths` must be the computed list, not the declared one. After freeze:
   - a push with the agent's earlier write credential is refused;
   - a new write credential for the **original handle object, which still says `writable`**, is refused with `workspace_not_writable`;
   - read credentials still work.
8. **Compare.** `compare(base, <task-repo revision>)` reports the added, modified, deleted and binary files. `compare(x, x)` reports `sameTree` and no files.
9. **Prepare.**
   - A tampered `prepare-candidate`, whose tree differs, is refused with `scope_violation`.
   - `prepareForAcceptance(frozen, submit)` submits a schema-valid job, retains the candidate at `refs/commonforge/candidates/<ws>/<sha>`, and returns a readable canonical revision. A repeat is idempotent.
   - Another agent's write credential cannot overwrite the retention ref.
   - The ledger head then becomes A.
10. **Other candidates.** B and C are frozen and prepared.
11. **Lagging main.** `integrate` C onto the ledger head A succeeds while `refs/heads/main` still lags at the seed (reconcile pending).
12. **Reconcile.** `reconcileAccepted(head A)` submits `reconcile-ref` for `refs/heads/main`, leasing on the sha it observed. The result is `synced`.
13. **Stale base.** `integrate` onto the old base, which is no longer the ledger head, is refused with `stale_base`.
14. **Textual conflict.** `integrate` of B onto A is refused with `textual_conflict`. The detail names the path, and nothing is pushed.
15. **Collect.** After `collectWorkspace` on every task workspace:
   - each task repo is gone: `ls-remote` fails and the provider cannot read it;
   - write credentials for the collected handles are refused;
   - a clean `integrate` still works from canonical alone, and the provider reads the merge by sha.
16. **Concurrent writer.** A concurrent writer moves `main` between submission and execution. `reconcileAccepted` returns `diverged` and keeps the writer's commit. **Policy:** the ledger head is the authority, so a retry leases on the newly observed sha and restores `main`. The out-of-band commit is no longer referenced.
17. **Export.** `exportRevision` returns a `git-bundle` item whose bytes hash to `sha256`. The suite reimports it with plain git and checks:
   - the head sha and tree are the same;
   - with `historyMode: 'full'`, the history count is 4;
   - **object-level equality**: every blob id in the reimported tree equals the git blob hash of `readFile`, and equals the `listTree` `oid` when one is given.

`integrate` is not a provider method, so the suite submits it itself, to the same `RunnerSubmit`
that the provider receives. The suite never requires multi-ref atomic pushes.

### What a provider must supply

`makeProvider(ctx)` receives the following context:

| `ctx` field | Contents |
|---|---|
| `workDir` | A scratch directory, removed afterwards |
| `git` | The suite's git runner |
| `seed` | A local working repo whose `main` (`seed.sha`) holds `SEED_FILES` |
| `organizationId`, `resourceId` | Identifiers for the resource under test |

It returns a `ProviderUnderTest` with these fields:

| Field | Required | Meaning |
|---|---|---|
| `provider` | yes | The `VersionProvider` under test |
| `resource` | yes | Canonical `ResourceRef` for `ctx.resourceId`. Its `refs/heads/main` must equal `ctx.seed.sha`. |
| `canonical` | yes | Canonical `RepoCoords`. Revisions are `art:`/`local:` + `canonical.repoId` + sha. |
| `readExport(r2Key)` | yes | The bytes written for an export item, or `null` |
| `serviceGit` | no | A git runner with the runner/service credential: it can read and write canonical and read task repos. For Artifacts, set an auth header via `GIT_CONFIG_*` env. |
| `gitForCredential(cred)` | no | A git runner that authenticates as the holder of `cred`, an agent |
| `dispose()` | no | Delete remote repos and tokens |

### Provider conventions the suite enforces

Each convention below is proposed for JSDoc in `@commonforge-org/core`.

- **Errors.** Errors are `CoreError`s with a `.code`.
  - Freeze and credential refusals use `FreezeErrorCodeSchema` codes: `candidate_moved`, `candidate_moved_during_freeze` and `workspace_not_writable`.
  - Refusing a canonical-coords handle must reject; its code is not yet standardized.
- **Real state.** Write credentials are decided by the **provider's own state**, never by the caller's `handle.state`.
- **Credential scope.** An agent write credential is scoped to its task repo and can never write canonical.
- **Credential URLs.** `WorkspaceCredential.remoteUrl === handle.coords.remoteUrl`.
- **Task-repo revisions.** `compare` (and reads before collect) accept a task-repo revision, `revisionForCoords(handle.coords, sha)`, before prepare.
- **`listTree`.** `listTree(resource, rev, '')` lists the root. Entries are direct children with full resource-relative paths, and directories are `type: 'dir'`.
- **Computed paths.** `FrozenCandidate.changedPaths` is computed and ignores `declaredChangedPaths`.
- **Collect.** `collectWorkspace` deletes the task repo. Prepared candidates must stay readable from canonical.
- **Reads by sha.** The suite never resolves a full ref through the provider (spike A5).
- **Writes through the runner.** Every canonical write goes through the injected `RunnerSubmit`. The suite validates each job with `IntegrationJobSchema`, so roles and namespaces must fit:
  - canonical lives in `*-canonical` or a role-less local namespace;
  - task repos live in `*-tasks`.
- **No fork lineage.** The suite never assumes git fork lineage between canonical and a task repo. Artifacts forks cannot cross namespaces, so `createIsolatedChange` may create a fresh `-tasks` repo seeded with the base sha.

Options: `git` (suite runner), `makeRunner(ctx)` and `timeoutMs` (default 60 s per step). The
`makeRunner` context is `{ git, workDir, currentHead(resourceId) }`, where `currentHead` returns
the simulated ledger head.

### Reference runner

`createReferenceRunner({ git, workDir, currentHead })` is the default `RunnerSubmit`. It runs
`prepare-candidate`, `integrate` (merge only: no checks or contracts) and `reconcile-ref` with
real git.

**Pushes**
- Each push updates **one ref with `--force-with-lease=<ref>:<sha>`** and never uses `--atomic`, because Artifacts refuses atomic pushes.
- A multi-target `integrate` pushes its targets sequentially. If a later push fails, the job fails with `provider_unavailable` and names the refs already pushed. Integration refs are unique per job and unreferenced by the ledger, so a partial result is inert and a retry is a new job.

**Refs and access**
- Retention refs are `refs/commonforge/candidates/<ws>/<sha>`.
- Integration refs are the job's `integrationRef` (`refs/commonforge/integrations/<proposalId>/<jobId>`).
- Canonical access is by sha, with `ls-remote` for refs.

**Current head**
- The "current head" is the **ledger head, never `refs/heads/main`**.
- `stale_base` is returned when the job's `must-match-accepted` snapshot entry differs from `expectedHead`, or when `currentHead(resourceId)` does.
- The ledger CAS at accept time remains the authority.

**Result codes**
- Retention ref already holding another sha: `scope_violation`.
- Tampered tree: `scope_violation`.
- Reconcile push that failed with the ref unmoved (busy, network): `provider_unavailable`.
- Ref moved by someone else: `diverged`.

**Not covered**
- Job ids are runner-assigned (`ref-job-<n>`), because `RunnerSubmit` carries the bare job. A production runner uses `SignedJob.jobId`.
- The runner does not retry `receive-pack busy`. For a live Artifacts run, pass the production runner through `makeRunner`.

### Helpers

The `/provider` entry also exports these helpers:

- `nodeGitRunner(env?)`, isolated from global and system git config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), plus `gitOk`, `revParse`, `lsRemote`, `pushRef`
- `createTempDir`, `removeDir`, `fileUrl`
- `initWorkRepo`, `initBareRepo`, `createSeedRepo`
- `writeFiles`, `commitAll`, `commitFiles`, `cloneRepo`, `AgentCheckout`
- `revisionForCoords`, `gitBlobOid`
- `SEED_FILES`, `CHANGE_A`, `CHANGE_B`, `CHANGE_C`

The package's own tests prove both suites run:

- the ledger suite against `InMemoryLedgerStore`;
- the provider suite against a minimal fake provider over local bare repos, in `test/fake-provider.ts`. The fake is not exported.

Its pre-receive hooks enforce agent tokens and freeze on task repos, and a service-only credential on canonical.
