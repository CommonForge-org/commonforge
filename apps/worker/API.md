# CommonForge Worker API

The HTTP surface of the CommonForge control plane (`apps/worker`, Hono on Cloudflare Workers).
Every client talks to it: the CLI (`cforge`, Task 18), the web app (Task 20), the demo agents
(Task 19), editions (Task 21), previews and releases (Task 22), and the integration runner (Task 14).

Type names in `code` refer to `@commonforge-org/core` Zod schemas (for example `ProposalRecord`,
`FrozenCandidate`, `ProjectSnapshot`), or to `@commonforge-org/runner-protocol` (`SignedJob`,
`RunnerResult`, `RunnerCredentialRequest`), unless the text says otherwise. Every request body is
JSON unless a route says otherwise. Every timestamp is ISO-8601 UTC with milliseconds.

## Architecture in one paragraph

- **Ledger.** The `OrgLedger` Durable Object (one per organization) is the single authority for
  accepted state: heads, proposals, candidates, approvals, receipts and the audit trail.
- **Directory.** D1 (`DB`) holds the directory: users, sessions, orgs, roles, grants, projects,
  mounts and resources. It also holds bookkeeping for tasks, runner jobs, intake and exports, and
  the full snapshots behind proposal ids.
- **Slow work** never runs inside a request. It runs in the `commonforge-steps` queue, or in the
  integration runner through signed jobs on `commonforge-runner-jobs`. Slow work here means
  creating and seeding a workspace, importing a URL, and preparing a candidate.
- **Artifacts is reached through the REST API.** A Workers binding serves exactly one namespace,
  but CommonForge needs one namespace per org (`<prefix>-<org>-canonical|tasks|editions`). The
  Worker therefore uses the `CF_ACCOUNT_ID` and `CF_API_TOKEN` secrets. Every create, token mint,
  delete and import goes through the per-namespace `OpsGate` DO, which allows at most 25
  concurrent operations (spike A9).

## Conventions

### Errors

Every error response has this shape:

```json
{ "error": { "code": "expected_head_stale", "message": "…", "details": { "resourceId": "…" } } }
```

`code` is stable. `message` is for humans and may change.

| Status | Meaning |
|---|---|
| 400 | Malformed input. Codes: `full_return_unmatched`, `invalid_request`, `invalid_url`, `invalid_path`, `revision_mismatch`, `grant_exceeds_role`, `not_git`, `not_assets`, `invalid_result`, `zip_refused`, `invalid_edition_return`, and for uploads and file changes `invalid_size`, `invalid_part`, `part_size_mismatch`, `parts_mismatch`, `upload_incomplete`, `size_mismatch`, `invalid_upload`, `edit_unsupported`. |
| 401 | No valid credential (`unauthenticated`), or a bad, used or expired sign-in link (`invalid_token`). |
| 403 | The caller can see the object but may not do this. Codes: `insufficient_role`, `no_write_grant`, `agent_not_allowed`, `lease_required`, `canonical_write_refused`, `revision_not_allowed`, `approval_role_not_allowed`, `promotion_not_visible`, `export_incomplete`, `org_create_forbidden`, the broker refusals (`access_exceeds_job`, `repo_not_in_job`, `identity_mismatch`, `namespace_role_mismatch`, `job_invalid`, `job_unknown`), `evidence_invalid`, `scope_violation`, `no_edition_grant`, `not_session_owner`. |
| 404 | The object does not exist **for this caller**. Non-members, missing grants and other orgs all get 404, so nothing leaks. |
| 409 | State conflict. Uploads: `upload_finished`. Ledger refusals use their own code: `expected_head_stale`, `dependency_stale`, `approval_invalid`, `policy_revision_stale`, `proposal_hash_mismatch`, `receipt_missing`, `evidence_missing`, `proposal_not_prepared`, `idempotency_key_conflict`, `restore_target_unknown`, `restore_noop`. Freeze refusals: `candidate_moved`, `candidate_moved_during_freeze`, `freeze_incomplete`. Editions: `edition_stale`, `edition_policy_changed`, `edition_not_ready`, `edition_read_only`, `edition_unavailable`, `no_allowed_changes`. File changes: `idempotency_key_reused`. Others: `workspace_not_writable`, `task_not_ready`, `task_not_running`, `job_finished`, `result_conflict`, `last_owner`, `mount_exists`, `policy_changed`, … |
| 410 | `job_expired`: the presented `SignedJob` has expired. |
| 413, 411 | ZIP upload too large, or no `content-length`. Uploads and file changes: `file_too_large`, `part_too_large`, `too_many_operations`, `change_too_large`, `edit_too_large`, `edits_too_large`; `length_required` (411). The LFS server answers `413` for a batch of more than 100 objects. |
| 429 | `rate_limited` (magic links), `invite_rate_limited` (resending a member invite). |
| 501 | `not_implemented` (none at the moment). |
| 502, 503 | Runner or provider failure: `seed_failed`, `runner_failed`, `receipt_mismatch`, `provider_unavailable`, `compare_unavailable`, `invite_failed` (the invite email could not be sent on resend). |

OrgLedger RPC errors keep the ledger's codes: `ledger_invalid_input` 400, `ledger_not_found` 404,
`ledger_wrong_organization` 403, `ledger_conflict` 409.

### Identifiers

| Kind | Format |
|---|---|
| Org | `o-<12 hex>` |
| Project | `p-<12 hex>` |
| Resource | `res-<16 hex>` |
| Task | `task-<uuid>` |
| Change | `chg-<uuid>` |
| Proposal | `prop-<uuid>` |
| Task workspace | `tw-<24 hex>`. Deterministic per (task, resource). |
| Intake | `in-<16 hex>` |
| Export | `exp-<16 hex>` |
| Job | `job-<24 hex>` |

Revisions, candidates and snapshots use core's formats: `art:<repoId>:<sha>`, `r2m:<manifestId>`,
`cand:<taskWorkspaceId>:<sha>`, and a 64-hex `SnapshotId` or `ProposalHash`.

### Idempotency

- `accept` and `restore` take an `idempotencyKey` matching `[A-Za-z0-9._:-]{8,200}`.
- The server scopes the key per organization.
- The same key with the same request replays the original `acceptedVersionId` (`replayed: true`).
- The same key with a different request is refused with `idempotency_key_conflict`.

## Authentication and principals

| Principal | Credential | Can call |
|---|---|---|
| user (browser) | Cookie `__Host-cf_session` (HttpOnly, SameSite=Strict, Secure, Path=/, no Domain: a sibling host on the same site cannot plant it; a request carrying two copies authenticates nobody; review I-2). The browser never sees the session value. | Everything their role and grants allow |
| user (CLI) | `Authorization: Bearer cfs_…`, issued only by `POST /api/auth/cli/verify` | Same |
| agent | `Authorization: Bearer cfl_…`, a task lease token | Only `/api/tasks/<its task>/…`. It acts on behalf of the lease holder; the holder's role and grants are re-checked on every request. |
| runner | The `SignedJob` in the request body | Only `/api/runner/…`, and only for repositories and keys that the job names |

- Every bearer secret is stored only as `HMAC(COMMONFORGE_SESSION_SECRET, purpose|token)`.
- CORS allows only the `COMMONFORGE_APP_URL` origin, with credentials.
- **CSRF.** State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) without an
  `Authorization` bearer are checked; this covers cookie sessions and sign-in itself. A present
  `Origin` must be `COMMONFORGE_APP_URL`'s origin or the Worker's own; without `Origin`,
  `Sec-Fetch-Site` must be `same-origin` or `none`. Otherwise the answer is `403 csrf_refused`.
  JSON bodies must be sent as `content-type: application/json` (`415 unsupported_media_type`).
  `/api/runner/*` is exempt, because the SignedJob authenticates it.

### Auth routes

| Route | Body | Response |
|---|---|---|
| `POST /api/auth/magic-link` | `{ email, client?: "web"\|"cli" = "web" }` | `202 { ok: true }`, whether or not the address is known. Details below. |
| `POST /api/auth/verify` | `{ token }` | `{ user: { userId, email }, expiresAt }` (`no-store`). Details below. |
| `POST /api/auth/cli/verify` | `{ code }` | `{ user, sessionToken: "cfs_…", expiresAt }` (`no-store`, no cookie). This is the **only** endpoint that hands out a session bearer. |
| `POST /api/auth/cli/code` | | Signed in (cookie or bearer). `201 { code: "cfm_…", expiresAt }` (`no-store`): a one-time `cforge login --code` code for the caller, without an email. Valid once, for 15 minutes; 30 per person per 15 min (`429 rate_limited`). The app's *Give to agent* puts it in the prompt it copies, so the agent can sign in by itself. |
| `GET /api/auth/sessions` | | Signed in. `{ sessions: [{ sessionId, client: "web"\|"cli"\|"handoff"\|"unknown", createdAt, expiresAt, current }] }` (`no-store`): the caller's live sessions, newest first. `sessionId` is a prefix of the session's keyed hash, never the token. `handoff`: opened with a hand-off prompt's code; it lasts 7 days instead of 30. |
| `POST /api/auth/sessions/revoke` | `{ sessionId }` or `{ others: true }` | Signed in. `{ ended }`: ends one of the caller's own sessions, or all but the current one. Another person's session id ends nothing. |
| `POST /api/auth/logout` | | `{ ok: true }`. Revokes the session (cookie or bearer) and clears the cookie. |
| `GET /api/me` | | `{ user, memberships: [{ orgId, name, role }], canCreateOrgs: boolean }` |

**Magic-link requests** (`/api/auth/magic-link`):
- Rate limits are atomic, held in the OpsGate DO `ratelimit:magic-link`:
  - 5 per address per 15 min
  - 10 per client IP (`cf-connecting-ip`; IPv6 bucketed by /64) per 15 min
  - 200 per hour globally, to protect the sender domain

  Over a limit the answer is `429 rate_limited`.
- `web` emails a link `<APP_URL>/auth/verify?token=cfm_…`.
- `cli` emails a code (`<APP_URL>/auth/cli?code=cfm_…`) for `cforge login --code`.
- Each link or code is valid once, for 15 minutes.

**Verify** (`/api/auth/verify`):
- It accepts web tokens only and sets the session cookie (30 days).
- The response body **never** carries the session (I-5).
- Nothing is consumed on GET. The app's `/auth/verify` page must ask for a click ("Sign in") and
  then POST, so mail-link scanners cannot burn the link.

The first sign-in of an address creates its user.

**Email delivery.**
- `/health` reports `deployment` (`production`, or `ci` when `COMMONFORGE_DEPLOYMENT=ci`) and
  `emailMode`. Log mode is honored only on a local Worker or the CI deployment; anywhere else it is
  refused (no link is written, sign-in fails) and `/health` answers `ok: false` (review m4).
- `COMMONFORGE_EMAIL_MODE=send` uses Cloudflare Email Service through the `send_email` binding
  `EMAIL`. It sends from `COMMONFORGE_EMAIL_FROM`, the sender address you onboarded for Email
  Sending. The binding is restricted to that sender (`allowed_sender_addresses`); the committed
  `wrangler.jsonc` carries the placeholder `login@example.com`, and a deploy writes the real address
  into both (`scripts/deploy-live.sh`, `scripts/bootstrap.sh --email-from`).
- `COMMONFORGE_EMAIL_MODE=log` (dev only) writes the link to the Worker log.
- Tests inject `CapturingEmailTransport`.

## Roles and grants

| Role | Default rights |
|---|---|
| `owner` | Everything in the org. Implicit read and write on every project and resource. Manages members and grants. **Only owners** change project policy and mounts, see the ledger audit, take over another developer's live lease, and see task repo coordinates other than their own. |
| `developer` | Creates projects, resources, intakes, tasks, proposals and exports. Integrates, approves, accepts and restores on resources it has a **write grant** for. Reads only granted projects and resources. |
| `client` | Reads granted projects and resources, and approves proposals (if policy allows the role). Never sees canonical coordinates, never gets a credential, never accepts. |
| `viewer` | Reads granted projects and resources. Never approves. Never sees canonical coordinates. |

- **Grants** come from `PUT /api/orgs/:org/grants`, with
  `{ userId, scope: { kind: "project"|"resource", id }, operations: ["read"|"write"] }`.
  - A project grant shows the project and those mounts whose resource the caller can also read.
  - A resource grant shows the content.
  - A project grant never exposes a resource by itself (AT-16).
  - Viewers can hold only `read` grants. Only owners grant `write`.
  - A **client's** `write` means **Can change** (2026-10-14): in a staging-mode project, their
    agent may change that folder in its own task copy, and the change goes to staging for review.
    It never lets a client write the folder itself (`resourceOps` reads it as `read`: no uploads, no
    file changes, no canonical credentials, `canWrite` false). A client with `read` only changes
    nothing. Migration 0017 gave existing clients `write` wherever they could already change a
    folder this way.
  - Developers may only **add** `read`, and may not touch a grant that includes `write`
    (`403 grant_owner_only`).
  - Revoking a grant, or narrowing it from write to read, ends the user's task leases and revokes
    their task tokens (N-2, N-3).
- **Creators** get a read+write grant on what they create.
- `GET /api/orgs/:org/grants[?userId=]` lists grants. `DELETE /api/orgs/:org/grants` (owner only)
  takes the same body without `operations`.

| Org route | Who | Body → response |
|---|---|---|
| `POST /api/orgs` | Instance admin (`COMMONFORGE_ADMIN_EMAILS`) | `{ name }` → `201 { orgId, name, role: "owner" }`. Anyone else: `403 org_create_forbidden`. |
| `GET /api/orgs` | User | `{ orgs: [{ orgId, name, role }] }` |
| `GET /api/orgs/:org` | Member | `{ orgId, name, createdAt, role }` |
| `POST /api/orgs/:org/archive` | Owner | → `{ orgId, archivedAt }`. Hides the org from every member's `GET /api/me` and `GET /api/orgs`; every member route then answers `404`. Nothing is deleted. |
| `POST /api/orgs/:org/unarchive` | Owner of the archived org | → `{ orgId, archivedAt: null }`. `404` for anyone else, and for an org that is not archived. |
| `GET /api/orgs/:org/members` | Owner or developer | `{ members: [{ userId, email, role, since }] }` |
| `POST /api/orgs/:org/members` | Owner | `{ email, role }` → `201 { userId, email, role, invite: "sent"\|"failed"\|"rate_limited" }` (creates the user if needed). Emails an invite linking to `<COMMONFORGE_APP_URL>/signin` (no token). The member is added whatever the email outcome. Invites are limited to 30 per hour per org and per inviter. |
| `POST /api/orgs/:org/members/:user/invite` | Owner | Resends the invite → `{ invite: "sent" }`; `429 invite_rate_limited`; `502 invite_failed`; `404` for a non-member. |
| `PATCH /api/orgs/:org/members/:user` | Owner | `{ role }`. The last owner cannot be demoted (`409 last_owner`). Demoting to client or viewer strips write grants and ends the member's leases. |
| `DELETE /api/orgs/:org/members/:user` | Owner | Removes the membership and the member's grants, ends their task leases and revokes every token (write and read, reference copies included) minted on those tasks' repos. |

## Projects, mounts, resources

| Route | Who | Body → response |
|---|---|---|
| `POST /api/orgs/:org/projects` | Owner or developer | `{ name }` → `201 { projectId, name }` |
| `GET /api/orgs/:org/projects` | Member | `{ projects: [{ projectId, name, createdAt }] }`, visible projects only |
| `GET /api/orgs/:org/projects/:pid` | Project grant | `{ projectId, name, membershipRevision, policyRevision, mounts: [{ mountName, resourceId, provider, resourceName, mode, operations, canWrite, canStartTask }], policy?, policyChanged?: { at, by } }`. Lists only readable mounts. `canWrite` says whether the caller may upload to and change the folder (an owner, or a developer with write on it; always false for clients and viewers); the Files tab shows write actions only when it is true, and the write routes still check for themselves. `canStartTask` says whether `POST …/projects/:pid/tasks` accepts the folder in `writeMounts` for the caller, by the same rule the route enforces: owners and developers need a write grant on the folder, a client a git folder in a staging-mode project that the owner opened for writing and gave them Can change on (a resource grant with `write`; so it can be true while `canWrite` is false); the mount must allow `write` and the folder be active; always false for viewers. (A folder with no accepted version yet still answers `409 no_accepted_head` on create.) `policy` and `policyChanged` (who last changed the policy, from the latest `project.policy_changed` event; `by` is an email or null) are shown to developers and owners only, and `policyChanged` only once a change exists. |
| `GET /api/orgs/:org/projects/:pid/access` | Owner, or developer with the project | `{ people: [{ userId, email, role, level: "none"\|"read"\|"write", folders: [{ mountName, resourceId, level, min?, shared?, via? }] }] }` for every member. Owners are `write` (implicit). `folders` lists the folders the caller can read (owners: all). `min` is the folder's floor: the highest level the person's other projects that attach it give (capped by role, never above what they hold); this project can't take it lower. `shared: true` marks a floor above this project's level (the folder is held there by another project); `via` is that project's name when the caller can see it. |
| `PUT /api/orgs/:org/projects/:pid/access` | Owner; developer (none → read only) | `{ userId, level, folders?: { [resourceId]: level } }` → the person's access. Writes the project grant and one grant per folder in one batch. A folder can only be lower than the project (`400 folder_exceeds_project`); `400 unknown_folder`, `400 grant_exceeds_role` (viewers: read at most; a client's `write` is Can change, see Grants), `400 owner_access_implicit`. Developers may only raise someone from `none` to `read` with no exceptions (`403 grant_owner_only`). Developers' PUTs skip folders they can't read; the response lists the folders the caller can read. Removing or narrowing ends the person's task leases. A folder the person also reaches through another project is narrowed at most down to its floor (`min`); the floor never raises a folder. Developers' PUTs never write `write`. A real move to `none` (from a project grant) also ends the person's grants on this project's editions (same batch) and revokes their edition tokens (`edition.grant_revoked`). |
| `GET /api/orgs/:org/projects/:pid/folders` | Owner, or developer with the project | `{ folders: [{ mountName, resourceId, resourceName, provider, state, error?, settingUp, setupFailed, alsoIn: [{ projectId, name }] }] }`. `state` is `empty`, `importing`, `active` or `failed`. `settingUp: true` while a folder added with `POST …/folders` waits for its first version (`state` is `empty` meanwhile); a failed setup is `state: "failed"`, `settingUp: false`, `setupFailed: true`, with `error` ("Setting up this folder failed: …"). `setupFailed` is true only for a folder whose setup failed, the only case where `POST …/folders/:mount/setup/retry` can work (offer Try again only then; a folder `failed` for another reason, such as an import, has `setupFailed: false`). Non-owners see only folders they can read, and `alsoIn` lists only projects they can read. |
| `POST /api/orgs/:org/projects/:pid/folders` | Owner, or developer with the project | `{ name, kind? }` → `201 { mountName, resourceId }`, before the folder's first version exists. Creates a git folder (an Artifacts repository, `provider: "artifacts"`, `state: "empty"`), attaches it under `name` (mode `must-match-accepted`, read + write) and starts its setup. There is one kind of folder: `kind` is optional and ignored (`"files"` and `"code"` give the same folder; any other value is `400 invalid_request`). Everyone with access to the project gets it (automatic access). A developer creator holds read + write on it. `409 mount_exists` creates nothing. **Setup:** a few seconds later the runner has put the folder's first commit on its `main` and it is bound as the folder's first version (`state: "active"`, event `resource.initialized`). Like an import, that first version is genesis: no proposal, no checks, no approval, and no staging (in a staging-mode project it is live at once). The commit holds exactly `.gitattributes` (Git LFS for media, archives, fonts, PDF and Office files: one header comment, then `*.<ext> filter=lfs diff=lfs merge=lfs -text` per extension), `.lfsconfig` (`[lfs]` `url = <COMMONFORGE_PUBLIC_URL>/api/lfs/<org>/<resourceId>/info/lfs`, see The LFS server) and `README.md` (`# <name>`). Author: the creator; committer `CommonForge <noreply@commonforge.invalid>`; both dated the request's second; message `Create folder <name>`. Every attempt of a setup makes the same commit: the first job's files, author and message are kept and reused (also by Try again), with the request's second. The setup is tried up to 3 times (a stalled one is picked up again by GC after 15 minutes); then the folder is `failed` (event `resource.init_failed`) until someone tries again. File collections (`r2-assets`) are no longer made here: use `POST /orgs/:org/resources` with `provider: "r2-assets"` (owners and developers), then `POST …/mounts` (owners). |
| `POST /api/orgs/:org/projects/:pid/folders/:mount/setup/retry` | Owner, or developer with write on the folder | `202 { state: "empty", settingUp: true }`: starts a failed setup over (3 more attempts; event `resource.init_retried`). `404` for a folder the caller cannot read; `403 no_write_grant` for a developer without write; `409 setup_not_failed` unless the folder's setup failed (still setting up, done, or a folder attached rather than added here). An owner may also detach a failed folder. |
| `PUT /api/orgs/:org/projects/:pid/policy` | **Owner** | `{ checks: CheckSpec[], contracts: ContractSpec[], approvalRoles?: Role[], rules: string[], preview?, release?, publishRoles?, staging? }` → `{ policyRevision, policy }`. Every section is optional except `checks`, `contracts` and `rules`; `staging` needs a `release` section (see "Staging"). Bumps the ledger's policy revision. This is **the only source of checks, contracts and approval roles**; repository files never become policy (AT-18, AT-38). Optional `expectedRevision`: when stale, `409 policy_changed` with `details.policyRevision`. A save that races another save can also get `409 policy_changed` (with the current `details.policyRevision`), even without `expectedRevision`; nothing is saved. |
| `POST /api/orgs/:org/projects/:pid/policy/validate` | **Owner** | A full policy document → `{ ok, issues: [{ path, message }] }`, running the same checks as `PUT …/policy` (schema, release targets, Worker quota). Never saves. `path` is the field path joined with `.`; release-target refusals use `release`. |
| `POST /api/orgs/:org/projects/:pid/mounts` | **Owner** | `{ mountName, resourceId, mode?: DependencyMode = "must-match-accepted", operations?: ["read","write"] }` → `201`. A `write` operation needs a write grant. Adding a mount bumps `membershipRevision`. Attaching grants the folder to every non-owner with access to the project, at their project level (clients and viewers: read), never narrowing an existing grant. Import attaches do the same. A folder the project already attaches (under any name) is `409 folder_already_attached`; a taken name is `409 mount_exists`. |
| `DELETE /api/orgs/:org/projects/:pid/mounts/:mount` | **Owner** | Removes the mount, never the resource → `{ ok: true, changed: userIds }`. Each non-owner with access to the project keeps only what their other projects attaching the same folder give; otherwise the folder grant is removed. People without access to the project are untouched. The mount removal, the `membershipRevision` bump and every grant write are one batch (all or nothing). Leases end for anyone who lost access or write. Records `mount.removed`. |
| `GET /api/orgs/:org/projects/:pid/snapshot` | Project grant | `ProjectSnapshot` of the mounts at their accepted heads. Non-owners see only entries they can read. |
| `GET /api/orgs/:org/projects/:pid/tree?mount=&path=&revision=` | Resource grant | `{ mountName, resourceId, provider, revisionId, path, entries: [{ path, type, size?, lfs? }] }`. Defaults to the accepted head. `revision=` is allowed for owners and developers only (`403 revision_not_allowed`). In a git folder, a file that is an LFS pointer to an object CommonForge holds is listed with the object's real `size` and `lfs: true` (recognised by the pointer's git blob id, one lookup per listing): accepted objects at the head, also staged ones at an explicit `revision`. A pointer to an object CommonForge never received (an imported repository's) is listed as an ordinary small file. |
| `GET /api/orgs/:org/projects/:pid/file?mount=&path=&revision=` | Resource grant | Raw bytes (`application/octet-stream`, `content-disposition: attachment`, `x-commonforge-revision`). For git folders `x-commonforge-blob` is the file's git blob id (the `baseBlob` of an edit, see Folders with uploads); for assets the body is streamed from R2 and `x-commonforge-sha256` is set. A git file that is an LFS pointer is served as the **real file**, never the pointer: the object is streamed from R2, pinned to the etag its hash step verified, with `x-commonforge-lfs: <sha256>`, `x-commonforge-sha256` and `content-length`, and **no** `x-commonforge-blob` (LFS files are not edited in place). Any reader gets accepted objects at the head; at an explicit `revision` (owners and developers) staged objects too. An object whose bytes are gone or were written again answers `404 object_missing`. A pointer to an object CommonForge does not hold is served as the pointer text, with `x-commonforge-lfs: missing` and its `x-commonforge-blob`. |
| `POST /api/orgs/:org/resources` | Owner or developer | `{ name, provider: "artifacts"\|"r2-assets", branch? }` → `201 Resource`. Details below. |
| `GET /api/orgs/:org/resources` | Member | `{ resources: Resource[] }`, readable only |
| `GET /api/orgs/:org/resources/:rid` | Resource grant | `Resource & { head: AcceptedHead\|null, operations }` |
| `POST /api/orgs/:org/resources/:rid/adopt-head` | Write grant | Binds an empty canonical repo to the current head of its branch (genesis; idempotent). → `{ resourceId, revisionId }`. Returns `409 branch_empty` if the branch has no commits. |
| `GET /api/orgs/:org/resources/:rid/versions` | Resource grant | `{ versions: [{ acceptedVersionId, sequence, kind, proposalId, proposalHash, acceptedAt, head }] }`, newest first |
| `GET /api/orgs/:org/resources/:rid/candidates` | Owner or developer | `{ candidates: Candidate[] }` |
| `GET /api/orgs/:org/candidates/:cid` | Owner or developer | `Candidate` |

`POST /api/orgs/:org/resources` details:
- `artifacts` creates the canonical repo `<prefix>-<org>-canonical/<resourceId>` and revokes its
  create token at once. The resource starts in state `empty`.
- `r2-assets` writes an empty manifest and binds it as the genesis head (state `active`).

`Resource` is `{ resourceId, name, provider, state: "empty"|"importing"|"active"|"failed", branch, createdAt, updatedAt, error? }`.
Owners and developers also get `coords` (`ArtifactsCoords` or `AssetManifestCoords`) and `source`.

`Candidate` is `FrozenCandidate` without `fork` (non-developers only) plus `{ state, preparedReceiptId }`.

## Intake

| Route | Who | Body → response |
|---|---|---|
| `POST /api/orgs/:org/intake/url` | Owner or developer | `{ url, branch, name, depth?, projectId?, mountName? }` → `202 { intakeId, resourceId, state: "queued" }`. Details below. |
| `POST /api/orgs/:org/intake/zip?name=<archive>` | Owner or developer | Raw ZIP body. `content-length` is required; the maximum is 100 MiB. → `202 { intakeId, state: "inventorying", sha256, jobId }`. Details below. |
| `GET /api/orgs/:org/intake/:id` | Owner or developer | `{ intakeId, kind, state, request, plan?, inventory?: { files }, result?, error? }` |
| `POST /api/orgs/:org/intake/:id/confirm` | Owner or developer | `{ projectId?, skip?: string[], include?: string[] }` → `{ resources: [{ resourceId, name, provider, mountName? }], excluded, includedAnyway?: string[], pendingPopulation: true, note }`. Details below. |

**URL import** (`/intake/url`):
- Only public `https://` remotes are accepted: no credentials, no query, no localhost.
- The import runs in the queue step `intake.import`.
- A 504 is retried once with `depth: 1`, and the resource is recorded as `historyTruncated`.
- A 409 while in progress is polled. A 404 after a 409 is a failed import.
- The 24 h import token is revoked.
- The branch is recorded explicitly.
- The head is bound in the ledger.
- The optional mount is created. Naming a project (`projectId` + `mountName`) is **owner-only**,
  like `POST /projects/:pid/mounts` (`403 insufficient_role`); a mount name the project already
  has is refused up front with `409 mount_exists` (`details.names`), before any resource exists.

**ZIP upload** (`/intake/zip`):
- The body is hashed while it streams to R2 at `org/<org>/intake/<id>/upload.zip`.
- A runner `inventory` job lists it. The listing is deterministic and nothing is executed.
- The result becomes a `plan`:
  `{ placements: [{ resourceName, provider, pathPrefix, files, bytes, reason }], excluded: [{ path, reason }] }`.
- The plan rules:
  - `node_modules`, nested `.git`, build output and caches are excluded with a reason. Folder
    names match case-insensitively (`.GIT/`, `NODE_MODULES/`, `Dist/`).
  - Credential-looking file names are blocked. Only the name is shown; the content is never read.
  - Media files and files over 32 MiB go to an `r2-assets` collection.
  - Each top-level folder becomes its own code resource.

**Confirm** (`/intake/:id/confirm`):
- Creates the planned resources and mounts. With `projectId` it is **owner-only** (adding mounts
  is project membership); without it, owners and developers create the resources only.
- Every planned folder name (minus `skip`) must be free in the project: otherwise `409 mount_exists`
  with `details.names`, before anything is created. Each added mount records `mount.added`.
- Populating them from the staged archive needs a runner job that does not exist yet
  (`intake-apply`). The response says so with `pendingPopulation: true`.
- **Include anyway** (`include`, **owner-only**: a developer sending it gets `403 insufficient_role`):
  exact paths (up to 4096 characters, like inventory paths) of files the dry run excluded **only**
  because of a secret-looking name (`.env*`, `.npmrc`, `id_*` keys, `*.pem`, …), which the owner
  has inspected. Each path must be in the plan's `excluded` list, **every** row for it must carry
  that reason (a duplicate entry name the inventory refused makes the path non-includable), it must
  be no larger than 32 MiB, and fall in a code resource
  this confirm creates (its top-level folder, or the root resource; not skipped). Files excluded
  for `.git/`, `node_modules`, build output or caches, refused by the inventory (path traversal) or
  unknown are never includable. Any refusal is `400 include_refused` with `details.paths` (the
  offending paths) and `details.refused: [{ path, why: "not_excluded"|"not_secret_name"|"oversize"|"no_placement" }]`,
  before anything is created. Accepted paths are recorded on the plan as
  `includedAnyway: [{ path, resourceName }]`, returned as `includedAnyway`, subtracted from
  `excluded`, and logged as `intake.included_anyway` (`detail.paths`), an org-level event naming
  no resource, so only owners see it. `GET /intake/:id` also shows `plan.includedAnyway` and
  `result.includedAnyway` to owners only (developers still see every excluded path, as before).
- ZIP population is still pending (`intake-apply`), so `include` records the owner's intent for
  when it lands: today nothing reads any archived file's contents. The inventory itself only ever
  lists names and sizes; files not included stay unread and unstored after population too.

## Tasks, workspaces, leases, credentials

| Route | Who | Body → response |
|---|---|---|
| `POST /api/orgs/:org/projects/:pid/tasks` | Owner or developer with write grants; **client** in a staging-mode project (see below) | `{ title, request?, writeMounts?: string[], readMounts?: string[] }` → `201 Task`. Details below. |
| `GET /api/orgs/:org/projects/:pid/tasks` | Owner or developer; **client** in a staging-mode project (own tasks only) | `{ tasks: [{ taskId, title, state, changeId, createdAt, updatedAt, leaseExpiresAt }] }`. `updatedAt` moves when a lease is taken or released and when the state changes (a push does not move it); `leaseExpiresAt` is the current lease's expiry, or `null` with no lease (never taken, or released). |
| `GET /api/tasks/:id` | A client who created the task (staging mode), or a developer who can read the project **and every resource the task snapshot names**, or the task's agent | `Task & { candidates: [{ candidateId, resourceId, taskWorkspaceId, state, preparedReceiptId, sha, changedPaths }] }`. Workspaces carry `remoteUrl` (the `-tasks` repo) only for the agent, the lease holder and owners. |
| `POST /api/tasks/:id/lease` | User (developer or owner, or the client who created the task in staging mode) who can see the task and has write grants on every written resource | `{ ttlSeconds?: 300..28800 = 3600 }` → `{ taskId, leaseToken: "cfl_…", leaseGeneration, expiresAt }` (`cache-control: no-store`). Details below. |
| `DELETE /api/tasks/:id/lease` | The agent, the lease holder or an owner | Releases the lease (bumps the generation, revokes write tokens). |
| `POST /api/tasks/:id/credential` | **Agent only** (`403 lease_required` for users) | `{ mountName, access: "read"\|"write" }` → `WorkspaceCredential { tokenId, secret, scope, expiresAt, remoteUrl }` (`no-store`). Details below. |
| `GET /api/tasks/:id/materialization?root=/abs/path` | Developer or agent | `MaterializationPlan` (runner-protocol `planMaterialization`). Each git (Artifacts) mount's `source` also carries `lfsUrl`, the folder's LFS endpoint (`<COMMONFORGE_PUBLIC_URL>/api/lfs/<org>/<resourceId>/info/lfs`, see The LFS server; left out when `COMMONFORGE_PUBLIC_URL` is not https or loopback http); asset mounts have none. Details below. |
| `GET /api/tasks/:id/assets/file?mount=&path=[&source=snapshot\|workspace]` | **Agent only** (task `running`; `403 lease_required` for users) | Raw bytes of one asset, streamed from R2 (`application/octet-stream`, `content-disposition: attachment`, `cache-control: private, no-store`, `x-commonforge-revision: r2m:<manifestId>`, `x-commonforge-sha256`). Details below. |
| `POST /api/tasks/:id/assets/stage` | Agent | `{ mountName, path, size, mime }` → `{ stagingKey, uploadUrl }` |
| `PUT /api/tasks/:id/assets/upload?key=` | Agent (task `running`, write grant, `content-length` required) | Raw bytes → `201 { stagingKey, size }` |
| `POST /api/tasks/:id/assets/commit` | Agent | `{ mountName, changes: [{ path, stagingKey, sha256, mime } \| { path, delete: true }] }` → `{ taskWorkspaceId, manifestId, parentManifestId, entries }`. Promotion verifies each object's size and sha256 (`400 asset_sha256_mismatch`), then the next manifest is written. |

**Staging mode (client tasks, spec 2026-10-07 §4).** In a project whose policy has a valid
`staging` and `release` section, a **client** who can read the project may also create tasks (write
mounts: code folders whose mount allows `write` and on whose resource the owner gave the client Can
change, a `write` grant), list and
read **the tasks they created**, lease them, and freeze as lease holder. Only their agent (the lease
token) gets credentials, and only for the task's own `-tasks` copies; the client's session gets
`403 lease_required` from `/materialization`, no `remoteUrl`/`fork`, and the client view (opaque
revision ids, no `taskWorkspaceId`/`sha`) on `/api/tasks/*` as on `/api/orgs/:org/*`. Anything short
of a readable staging-mode project answers `403 insufficient_role` as before. Proposals, integrate
and accept stay owner/developer. A **client's** task in a staging-mode project is pinned to the
live staging build's revision for each resource that build names, else to the accepted head. Until
Phase 2 promotion, owner and developer tasks start from the accepted heads, as without staging (a
proposal based on unpromoted staging work would fail integrate with `stale_base`).

Provider errors on the task routes (`GET/POST/DELETE /api/tasks/:id/*`, freeze) keep their status and
`code` but, for a client or their agent, carry a fixed plain `message` ("The workspace service is
unavailable; try again." for `provider_unavailable`, else "This task's workspace could not be
updated (<code>)."), because the provider's text can name the task repository. Owners and
developers still get the raw message.

**Creating a task:**
- The folders come from the project's access settings unless the body names them. Without
  `writeMounts`, the agent may change every mount the caller may start a task in (`canStartTask`:
  the same rule as for a named mount) that has an accepted version; with none, `403 no_write_grant`.
  Without `readMounts`, it reads every other mount the caller can read. A mount the caller cannot
  read is never included. The web app sends no folders for clients; owners and developers may
  narrow them.
- The snapshot is pinned to the current accepted heads (staging mode: see above). Written mounts get operations
  `["read","write"]`; everything else gets `["read"]`.
- Each written Artifacts resource gets a workspace `tw-…` (`access: "write"`), created in the queue step
  `workspace.create`. That step is serialized per workspace id by an OpsGate lock. It calls
  `createIsolatedChange`, which creates a fresh `-tasks` repo and seeds it with a `seed-workspace`
  runner job. The handle is then recorded in the ledger.
- Each **read** (reference) Artifacts mount gets a read-only copy in `-tasks` (`access: "read"`),
  created and seeded the same way at the pinned sha. Agents never get a token for a canonical repo
  (plan §F row 1, controller ruling I-6). Reference copies are collected (state `collected`) when
  the task turns `submitted`. When the task fails they are marked `abandoned`, in D1 and the ledger,
  and the GC sweep deletes them; it also cancels `running` tasks without a live lease and with no
  activity for 7 days (see "Outbox, wakeups and GC").
- Asset mounts get an R2 staging area, which is writable at once.
- Task states: `provisioning`, `ready`, `running`, `submitted`, `failed`, `canceled` (GC: `running`, no live
  lease, 7 days inactive; `ready` tasks are never canceled).

`Task` is `{ taskId, orgId, projectId, changeId, title, request, state, snapshot: ProjectSnapshot, lease, workspaces: [{ taskWorkspaceId, mountName, resourceId, provider, access, baseRevision, state, assetManifestId?, error?, remoteUrl? }] }`.

**Taking a lease:**
- Taking over another developer's **live** lease is owner-only; others get `409 lease_held`.
- A new lease bumps the generation.
- The previous agent token stops working (401).
- Active write tokens on the task repos are revoked.
- The event `task.started` is recorded.

**Agent credentials:**
- For a written mount, the broker calls `issueWorkspaceCredential` on the task's own `-tasks` repo.
  That call refuses canonical namespaces, non-writable or freezing workspaces, and stale lease
  generations. The TTL is at most min(1 h, lease remaining).
- For a reference mount, the broker issues a **read** token on the task's read-only reference copy
  in `-tasks`; a write request gets `403 read_only_mount`.
- A lease with less than 60 s left gets `409 lease_too_short`.
- Asset mounts answer `400 not_git`.

**Materialization plan:**
- Built from the ledger and grants only; it contains no tokens.
- Writable mounts point at the task repo.
- Reference mounts point at their read-only `-tasks` copy with `credential: "helper"`; the
  `workspace.json` coordinates are rewritten the same way, so the plan names no canonical repository.
  The CLI helper asks `/credential` (read) for them.
- Asset mounts carry their pinned manifest (read-only in the workspace). The CLI downloads each
  object with the lease through `GET /api/tasks/:id/assets/file` (below); changes go through
  `assets/stage` → `upload` → `commit`.

**Agent asset reads** (`GET /api/tasks/:id/assets/file`). `cforge checkout` materializes asset
mounts with this route, so an agent holding only the task lease can check out a task whose snapshot
includes an R2 mount. The user-only project file route (`GET /api/orgs/:org/projects/:pid/file`)
still answers `403 agent_not_allowed` to a lease.
- **Principal.** Only the current lease token of this task. Users (even the lease holder) get
  `403 lease_required`; another task's lease gets 404; an expired, released or replaced lease is no
  principal (401). The lease holder's read grant on the resource is re-checked on every request.
- **State.** The task must be `running` (`409 task_not_running`).
- **Mount.** It must be named in the **task snapshot** (else 404, even if the project mounts it) and
  pinned to an asset manifest (`r2m:`). Git mounts, written or reference, answer `400 not_assets`.
- **Manifest, chosen server-side.** The caller never names a revision.
  - `source=snapshot` (default): the manifest pinned in the task snapshot. This is what the
    materialization plan lists, so checkout bytes always match the plan's sha256s.
  - `source=workspace`: the task's own asset workspace (written mounts only): its last committed
    manifest, else its base. A reference mount has no asset workspace (404).
- **Path.** It must be a normalized relative path (`400 invalid_path`) listed in that manifest (404).
  Directories are not served.

## Candidates and freeze

`POST /api/tasks/:id/workspaces/:ws/freeze` can be called by the task's agent, its assignee (the
current lease holder, who also needs a write grant) or an owner (I-1). Others get
`403 not_task_assignee`, or 404 if they cannot see the task. Reference copies are never frozen
(`409 workspace_read_only`). Candidate `fork` coordinates are shown only to owners and to the
freezing agent or assignee.

| Workspace | Body | Response |
|---|---|---|
| Artifacts | `{ expectedSha, tool? }` | `201 Candidate` (with `fork`) |
| Asset | `{}` | `{ taskWorkspaceId, state: "frozen", manifestId }` |

Artifacts freeze sequence:
1. The workspace is marked `freezing`. The provider's workspace resolver then reports it frozen,
   so no new write token can be minted.
2. `freezeCandidate` runs:
   - It checks HEAD against `expectedSha` (`409 candidate_moved`).
   - It revokes every write token, then re-reads HEAD.
   - It computes `changedPaths` server-side with a Worker tree compare. The paths are never taken
     from input.
3. The ledger records the `CandidateRecord` (state `frozen`) and the workspace (state `frozen`).
4. The queue step `candidate.prepare` runs runner `prepare-candidate` through
   `prepareForAcceptance`. It records the `PreparedReceipt` and attaches it to the open proposals
   that contain the candidate.
5. On failure the workspace is writable again.

## Proposals, approvals, accept, restore

| Route | Who | Body → response |
|---|---|---|
| `POST /api/orgs/:org/proposals` | Owner or developer with write grants | `{ taskId, candidateIds?: CandidateId[] }` → `201 Proposal`. `409 staging_proposal` in a staging-mode project ("this project uses staging: promote the task instead"; landings make their own proposals). Details below. |
| `GET /api/orgs/:org/proposals[?projectId=]` | Member | `{ proposals: [{ proposalId, proposalHash, projectId, changeId, state, updatedAt }] }`. Only proposals whose changed resources the caller can all read. |
| `GET /api/orgs/:org/proposals/:id` | Same | `Proposal`. Client and developer views carry the **identical** `proposalHash` (AT-19). |
| `POST /api/orgs/:org/proposals/:id/integrate` | Owner or developer with write grants on the changed resources | → `202 { proposalId, jobId, state: "queued" }`. Details below. |
| `POST /api/orgs/:org/proposals/:id/approvals` | Owner, developer or client (subject to policy `approvalRoles`) | `{ proposalHash }` → `201 ApprovalRef`. Details below. |
| `GET /api/orgs/:org/proposals/:id/approvals` | Same as GET proposal | `{ approvals: ApprovalRef[] }`. Non-developers see only the approver's kind. |
| `POST /api/orgs/:org/proposals/:id/accept` | Owner or developer with write grants | `{ idempotencyKey }` → `{ proposalId, acceptedVersionId, replayed }`. Details below. |
| `POST /api/orgs/:org/resources/:rid/restore` | Write grant | `{ expectedHead, targetRevision, idempotencyKey }` → `{ resourceId, acceptedVersionId, replayed, headRevisionId }`. Details below. |

**Creating a proposal:**
- The default candidate set is the task's frozen candidates. When a resource has several, the
  latest freeze wins.
- The proposal also includes the task's frozen asset manifests as `assetManifestChanges`.
- **Policy references (Task 23 review C1).** The proposal's base snapshot (and so its candidate
  snapshot, `candidateSnapshotId` and hash) also pins every project mount the policy's checks and
  contracts need (`check.mountName`, a contract's producer mount, schema resource and consumer
  resource) that the task snapshot lacks, at its accepted head, with mode `must-match-accepted`
  and `operations: ["read"]` (re-review R1). They appear as `readDependencies` (redacted for
  callers who cannot read them). Once one of them moves (for example an `api` change is accepted
  while a requirements-only proposal waits), the proposal lists it in `stale` and accept refuses
  with `409 dependency_stale`: no accepted pair of producer, schema and consumer escapes the
  contract run. Re-proposing the task re-pins the references at the new heads (no rebase: they
  are read-only); validate the new proposal again. Agents and clients get no credential for them: the broker and the
  materialization plan read the *task* snapshot.
- `proposalHash` is computed with core `computeProposalHash`.
- `state` is `prepared` once every change has a prepared receipt; otherwise it is `open`.

In a `Proposal`, `readDependencies` on resources the caller cannot read appear as
`{ redacted: true, mode }`.

`Proposal` is `ProposalRecord & { stale: ResourceId[], approvals, integration: { jobId, forCurrentHash, integratedAt, checks, contractChecks, mergeOutcome, results? } | null, candidates: Candidate[], lastAttempt: IntegrationAttempt | null }`.

- `integration` is the latest **successful** integrate receipt; a failed run leaves it unchanged.
- `lastAttempt` is the latest integrate run whatever its outcome (Task 20 review C-1):
  `{ state: "queued"|"applying"|"succeeded"|"failed", expired, forCurrentHash, requestedAt, completedAt, code, checks: [{checkId, result}], contractChecks: [{contractId, result, producerResource?, consumerResource?}], mergeOutcome, conflictPaths, signedEvidence }`.
  `code` is the runner failure code (`contract_failed`, `check_failed`, `textual_conflict`, `stale_base`, …, `integration_rejected` when the control plane refused a receipt, or `receipt_not_recorded`, below); checks, contracts and merge outcome come from the run's signed evidence when it has any.
  `contractChecks[].producerResource` / `consumerResource` are left out for callers who cannot read that resource (re-review m1), as `readDependencies` are redacted.
  A run that is superseded never counts as the latest attempt: an older job that finishes after a
  newer one was requested, or a job that finishes after the proposal was accepted or closed, is
  marked failed with code `integration_superseded` (event `proposal.integration_superseded`) and
  its receipt is not recorded, so it never overwrites the newer state (re-review R3).
`state: "applying"` (review I1): the runner reported success but the ledger has not recorded the
receipt yet. `integration` is read from the ledger (the authority), so it appears only once the
receipt is recorded; the web treats `applying` as still validating. A retried result POST
re-applies an integrate result (idempotent), so a POST that failed after the job row was updated
never leaves the ledger without its receipt. `applying` is bounded (re-review R3): if the receipt
is still not recorded 2 minutes after the runner reported (`completedAt`), the attempt reads
`state: "failed"`, `code: "receipt_not_recorded"`, and the web offers "Validate again". A late
replay that does record it turns the attempt `succeeded`.
  Owners and developers also get `jobId`, `detail` (the runner's redacted text) and `evidenceId`; clients and viewers get codes, names and paths only (I-3).
`stale` lists resources whose head moved off the base, and `must-match-accepted` dependencies that moved.

**Integrate:**
- The proposal must be `prepared`.
- Each base must still be the head, asset manifests included; otherwise `409 expected_head_stale`
  with `details.resourceId`, because stale-base policy is "refuse" (§C.2).
- `409 nothing_to_integrate` only for a proposal with neither git nor asset changes.
- The runner `integrate` job uses server-owned `checks` and `contracts` only, **all of them**: a
  check or contract whose mount or resource is not in the proposal's snapshot is refused with
  `409 policy_unevaluable` (`details.unevaluable`), never dropped (review C1). Re-propose after
  fixing the policy or the mounts.
- `job.references` lists every other git entry of the base snapshot (canonical coordinates
  verified against the live repo, pinned by the snapshot's sha). The runner gets read access to
  them only, so checks and contracts on mounts the proposal does not change can run (N-1).
- `job.baseSnapshot` is the proposal's real **base** snapshot, and the runner checks each target's
  entry against `expectedHead`. `job.candidateSnapshotId` is the proposal's candidate snapshot id,
  and the evidence must be signed for it (a required, signature-covered field of runner-protocol's
  integrate job).
- The results endpoint binds every receipt to its job with runner-protocol's
  `parseRunnerResultForJob`. For integrate this checks the proposal, refs, expected heads, and that
  `evidence.snapshotId === job.candidateSnapshotId`; anything else is `400 invalid_result`. The
  Worker re-checks the evidence against the ledger's `proposal.candidateSnapshotId` before
  recording, and otherwise records `proposal.integration_rejected`.
- The result's evidence must verify with the per-job HMAC. The receipt is then recorded in the
  ledger.
- **Assets-only proposals** (only `assetManifestChanges`, for example a logo replacement;
  follow-up Task 23) are integrated too. The job has no candidates and no targets and carries the
  proposal's asset changes as `assetChanges` (runner-protocol README). Every git entry of the base
  snapshot is a reference, so the policy checks and contracts run there (offline, after the
  runner's own dependency install); nothing is merged or pushed and no write credential is minted.
  The receipt has `results: []` and its evidence `mergeOutcome: []`. The evidence names no
  manifest: it binds them through `proposalHash`, which covers `assetManifestChanges`. A failing
  required check or contract refuses as for any proposal (`check_failed`, `contract_failed`).

**Approvals:**
- The `proposalHash` must be the current one; otherwise `409 proposal_hash_mismatch` with
  `details.currentHash`.

**Accept** calls `OrgLedger.accept` (planCommit) with this input:

| Field | Value |
|---|---|
| `expectedHeads` | The bases the reviewers saw. |
| `newHeads` | The integration commits, or the fast-forward candidates; `r2m:<newManifestId>` for asset changes. |
| approvals | Filtered by **current** membership and policy roles. |
| evidence | The integrate receipt's signed evidence (for this proposal hash). Every proposal needs it, assets-only ones included: without a successful integrate run for the current hash, accept answers `409 evidence_missing`. |

- A refusal is `409 <ledger code>`, for example `expected_head_stale` with `details.resourceId`.
- While the proposal is `prepared` and its latest integrate run is `applying`, accept answers
  `409 integration_applying` with `retry-after: 2` (review I1); past the grace,
  `409 receipt_not_recorded` (validate again). These checks are skipped once the proposal is
  accepted, so a lost-response retry replays (re-review R3).
- A retry with the same key returns `replayed: true` and the same `acceptedVersionId`.

**Restore:**
- Moves the head forward to a previously accepted revision.
- `409 restore_target_unknown` if the revision was never accepted, `409 restore_noop` if it is
  already the head, `409 expected_head_stale` if the head moved.

## Export, events, audit

| Route | Who | Response |
|---|---|---|
| `POST /api/orgs/:org/projects/:pid/exports` | Owner or developer who can read every mounted resource | `202 { exportId, snapshotId, jobId, state }`. A runner `export` job writes git bundles and asset manifests under `org/<org>/exports/<exportId>/`. |
| `GET /api/orgs/:org/exports/:id` | Same | `{ exportId, projectId, state, snapshot, receipt: ExportReceipt\|null, downloads: string[] }` |
| `GET /api/orgs/:org/exports/:id/download?key=` | Same | Bytes of one receipt item |
| `GET /api/orgs/:org/events?after=&limit=&projectId=` | Member | `{ events: [{ seq, at, projectId, action, subject, actor, detail? }], next }`. Filtering rules below. |
| `GET /api/orgs/:org/audit?after=&limit=` | **Owner** (org-wide and unfiltered) | `{ audit: [{ seq, …AuditEvent }], next }`, the ledger audit trail |

**Event filtering** (I-3):
- Every event records the resources it is about.
- Non-owners see an event only with read on its project, if it has one, and on **every** resource
  it names. Org-level events that name no resource are owner-only.
- Clients and viewers see only client-visible events. They get `detail` = the event's
  client summary (codes and paths, for example `{ code, conflictPaths }`), never raw runner
  output, and the actor reduced to its kind.

Event actions:
- Org and project setup: `org.created`, `member.*`, `grant.*`, `project.created`,
  `project.policy_changed`, `mount.added`, `resource.created`, `resource.head_bound`,
  `resource.initialized` (a new folder's first version: `{ mountName, commitSha }`),
  `resource.init_failed` (`{ mountName, code, detail, attempts }`), `resource.init_retried`.
- Intake: `intake.requested`, `intake.imported`, `intake.confirmed`, `intake.included_anyway`
  (owner-only).
- Tasks and candidates: `task.created`, `task.started`, `task.lease_released`,
  `workspace.provisioned`, `credential.issued`, `assets.committed`, `task.candidate_frozen`,
  `candidate.prepared`, `candidate.prepare_failed`.
- Proposals: `proposal.created`, `proposal.integration_requested`, `proposal.integrated`,
  `proposal.integration_failed`, `proposal.approved`, `proposal.accepted`.
- Restore and export: `resource.restored`, `export.requested`.
- Staging: `staging.landing_checking`, `staging.landed`, `staging.landing_failed`,
  `staging.rolling_back`, `staging.rolled_back` (subject: the task), `staging.land_failed` (the
  landing step itself failed), `staging.build_failed` and `staging.reset` (subject: the project).
  All are client-visible; a client's `detail` carries a code only (for example `land_failed`).
- Outbox and GC: `task.abandoned` (actor `service:worker-outbox`), `outbox.dead_lettered` (names
  the event's resources; org-level otherwise).

`task.started` and `task.candidate_frozen` are the AT-05 overlap evidence.

## Client editions (Task 21)

A Workspace Edition is a developer-authorized, **fresh-history** copy of selected source, in its
own repo `<prefix>-<org>-editions/ed-<editionId>` (PRD §4.5, plan §B.13, §C.1 row 9). Clients edit
it in any tool and send it back as a ZIP; the server maps the return onto the canonical resource
and opens a normal proposal. The edition manifest (inventory, mappings, protected paths, canonical
bases, source release) is server-owned (D1 `edition_builds`); nothing in an upload can change it.

**Policy** (body of create / `PUT …/policy`):

```json
{ "name": "Website pages",
  "sources": [{ "mountName": "website",
                "include": ["index.html", "src/**", "public/**", "tests/quote-view.test.ts", "package.json"],
                "write": ["index.html", "src", "public", "tests"],
                "editionPathPrefix": "" }],
  "exclude": ["**/.env*"],
  "protectedPaths": ["package.json", "vite.config.ts", "tests/quote-contract.test.ts"] }
```

- `include` (read allowlist): canonical globs (core `matchesPathPattern`; a plain path matches
  itself and below). Only these files are published. `exclude` (default `**/.env*`) and the
  segments `.git`, `.commonforge`, `.vibecontrol` are never published; symlinks and submodules are
  never copied.
- `write` (write allowlist): canonical path **prefixes** (files or folders, no globs; `""` = the
  whole resource). They become writable mappings; everything else published is read-only.
- `protectedPaths`: canonical globs a return may never change, even inside a write prefix. Matched
  case-insensitively too (`Tests/Quote-Contract.test.ts` is `tests/quote-contract.test.ts`). The
  `exclude` patterns are protected for returns as well (a client cannot add `src/.env.production`).
- Up to 8 sources (Artifacts mounts only); at most one has `write` (a return targets one
  resource). `editionPathPrefix` defaults to the edition root for one source, else the mount name;
  prefixes may not overlap.
- Configuring, building and granting need the owner, or a developer with **write** grants on every
  source resource (`403 no_write_grant`). Policy changes bump `policyRevision`, un-publish the
  current build (state `draft` until the next build: no new sessions, `edition_not_ready`) and
  revoke every edition token (a build requested under the older revision is never promoted); sessions of the older revision can no longer download, clone or
  return (`409 edition_policy_changed`). Each build publishes the policy snapshotted on its row.

| Route | Who | Body → response |
|---|---|---|
| `POST /api/orgs/:org/projects/:pid/editions` | Owner / developer (write on sources) | Policy + `name` → `201 Edition` (state `draft`). `409 staging_mode` in a staging-mode project ("staging-mode projects use client tasks"). |
| `GET /api/orgs/:org/projects/:pid/editions`, `GET /api/orgs/:org/editions` | Member | `{ editions: Edition[] }`, visible ones only |
| `GET /api/orgs/:org/editions/:eid` | Edition grant, or developer who can read the project and every source | `Edition` |
| `PUT /api/orgs/:org/editions/:eid/policy` | Manager | Policy (+ optional `name`) → `Edition` |
| `POST /api/orgs/:org/editions/:eid/builds` | Manager | → `202 { editionId, buildId, state: "queued", sourceReleaseId }`. Details below. |
| `GET\|PUT\|DELETE /api/orgs/:org/editions/:eid/grants` | Manager (GET: developers) | `{ userId }`. Clients and developers may hold edition grants (viewers: `400 grant_exceeds_role`). DELETE revokes the user's edition read tokens. Removing a member, or demoting one to viewer, deletes their edition grants and revokes their tokens; viewers never have edition use. |
| `POST /api/orgs/:org/editions/:eid/sessions` | Owner or grant holder | `{ title, request? }` → `201 Session` ("Start an update": pins the current build). `409 edition_not_ready` before the first build ("Developer setup required"), `409 edition_read_only` without a write allowlist. `409 staging_mode` once the project is in staging mode ("staging-mode projects use client tasks"), also for an edition made before. |
| `GET /api/orgs/:org/editions/:eid/sessions` | Same as GET edition | `{ sessions }`: own sessions; developers see all |
| `GET /api/orgs/:org/edition-sessions/:sid` | Session owner, or developer view | `Session` |
| `GET /api/orgs/:org/edition-sessions/:sid/download` | Same | The working copy as a stored ZIP (`application/zip`, `no-store`): exactly the build's inventory, read from the edition repo and checked against the manifest hashes. `409 edition_unavailable` once a rebuild replaced the commit. |
| `POST /api/orgs/:org/edition-sessions/:sid/credential` | Session owner | `{ ttlSeconds? = 3600 (60..86400) }` → `{ tokenId, secret, scope: "read", expiresAt, remoteUrl, branch, commit, current }` (`no-store`): a **read** token on the edition repo, never on a canonical one (AT-25). |
| `POST /api/orgs/:org/edition-sessions/:sid/returns?mode=partial\|full&delete=<path>&tool=<name>` | Session owner | Raw ZIP body (`content-length` required, ≤ 32 MiB) → `202 Return`. `409 staging_mode` once the project is in staging mode, also for a session started before. Details below. |
| `GET /api/orgs/:org/edition-returns/:rid` | Return owner, or developer view | `Return` |

`Edition` (client view): `{ editionId, projectId, name, state: "draft"|"building"|"ready"|"failed",
ready, policyRevision, files, editable: string[], protected: string[], readOnly, builtAt,
canStartUpdate, createdAt, updatedAt }`. Developers also get `policy`, `canManage`,
`currentBuildId`, `repo` (the **edition** repo's namespace, name and remote URL) and `builds:
[{ buildId, state, policyRevision, sourceReleaseId, canonicalBases, exportedSnapshotId, commit,
files, error?, createdAt, updatedAt }]`.

`Session`: `{ sessionId, editionId, editionName, projectId, title, request, state, files, stale,
policyChanged, downloadUrl, downloadRoot, returnUrl, returns: Return[], createdAt, updatedAt }` (`stale`: the
target moved since the build, so a return would be refused).

`Return`: `{ returnId, sessionId, editionId, state, mode, deletions, changes: [{ path, kind,
oldPath? }], blocked: [{ path, reason: "not_mapped"|"read_only"|"protected"|"path_escape"|"case_collision"|"path_conflict" }],
unchanged, keptAsIs, unknownDeletions, ignored, strippedFolder, proposalId, tool, error?: { code,
message }, createdAt, updatedAt }`. Paths are edition paths. Developers also get `canonicalPath`
per change, `taskId`, `taskWorkspaceId`, `jobId`, `resourceId`, `size`, `sha256` and
`error.detail` (the runner's text). States: `queued` → `running` → `freezing` → `proposed`, or
`no_changes`, `stale` (`stale_base`), `conflict` (`textual_conflict`), `refused`
(`scope_violation`), `failed`.

**Build** (queue step `edition.build`): the sources' current accepted heads become the build's
`canonicalBases` and snapshot. `sourceReleaseId` is the project's **live release** at build time
(the release service's live pointer, Task 22; AT-30), or `null` while nothing has been published
(core `EditionManifestServerSide.sourceReleaseId` is nullable; `services/editions.ts`
`liveRelease()` reads `release_live`). The step creates
the edition repo once (its create token is revoked at once), then issues `build-edition`: canonical
**read** only, the edition repo **write** only; one parentless commit with only the allowlisted
blobs, pushed to `refs/heads/main` (a rebuild replaces it). The runner refuses to publish when a
configured canary string occurs (AT-26). The result marks the build `ready` with its inventory.

**Return** (AT-28, AT-29, AT-30):
1. The session's build must still have the edition's policy revision (`409 edition_policy_changed`)
   and the target's ledger head must still be the build's base (`409 edition_stale`: a return is
   never applied over newer accepted or live work).
2. The Worker reads the ZIP with a safe reader (`lib/zip.ts`, mirroring the runner's): traversal,
   absolute paths, symlinks, special files, duplicates, case collisions and ratio bombs refuse the
   whole upload (`400 zip_refused`, `details.rejected` / `details.reason`); so do ZIP64,
   encryption, lying sizes or CRCs. OS metadata (`__MACOSX/`, `.DS_Store`, `Thumbs.db`) is ignored;
   one wrapping folder is stripped only when it is the download's own root (`downloadRoot`, the
   ZIP's base name), so a new top-level folder is never flattened. Inflated content is capped at
   24 MiB; the upload is staged as sent (re-packed only when a wrapper or OS junk was removed).
3. Core `diffAgainstInventory` + `mapEditionDelta` against the build's manifest. `partial`
   (default): files left out stay as they are; only `delete=` paths are deleted. `full`: a
   published file missing from the ZIP is a deletion. Identical content under a new name is a
   rename. A new or renamed-to path that differs only by case from a published file is
   `case_collision` (and a case-only rename applies neither side). A new path that is a file where
   a published folder is, lies below a published file, spells a published folder in another case,
   or conflicts that way with another new path of the same return is `path_conflict`. In `full`
   mode, an upload that matches none of the published files is refused (`400
   full_return_unmatched`) instead of deleting everything. Blocked changes are reported,
   never applied. No allowed change → `409
   no_allowed_changes` (`details.blocked`), nothing staged.
4. A normalized ZIP is staged at `org/<org>/edition-returns/<returnId>/upload.zip`; a task
   (`Client update: <title>`, created by the client, state `provisioning`) and one write workspace
   are recorded. Queue step `edition.return` creates the empty `-tasks` repo (tokens revoked),
   records the handle in the ledger and issues `edition-return` (canonical read, the fresh task repo
   write, `expectedHead` = the build's base; the runner re-checks the ledger head → `stale_base`).
   The runner also blocks, as `not_mapped`, any new path that lands on (or differs only by case
   from) an existing canonical file the edition does not publish, is a file where the canonical
   tree has a folder, lies below a canonical file, or spells a canonical folder in another case,
   whatever its content, so a return is never an existence or content oracle. As a tripwire, the
   candidate tree may differ from the base only in the allowed paths (`scope_violation`
   otherwise; nothing is pushed).
5. The result: failure → the return's state, the workspace `abandoned` and the task `failed` (GC
   deletes the repo). A candidate → queue step `edition.candidate` freezes it like an agent
   candidate (`freezeCandidate`: HEAD check, tokens revoked, changed paths computed server-side),
   marks the task `submitted`, opens the proposal (`prop-ed-…`, deterministic per return; created
   by the client) and runs `candidate.prepare`. Review, integrate, approve and accept are the normal
   proposal flow.

**Edition proposals (ruling I-1).** A proposal opened by an edition return is visible to, and
approvable by, its returning client and any client holding a live grant on that edition, through
edition use alone: no project or resource grant is needed, and none is implied (tree, file,
resource and version routes stay 404). That view carries `edition: { editionId, name }` and is
limited to the edition: changed paths, conflict paths and merge outcomes are edition paths, and only
those that are published or that this return itself added. A client's approval counts at accept
only while the approver can still see the proposal (canonical read, or edition use). The proposal's events reach
the same users with the same path limit. Developers and owners see the proposal normally.

Events: `edition.created`, `edition.policy_changed`, `edition.build_requested`, `edition.built`,
`edition.build_failed`, `edition.granted`, `edition.grant_revoked`, `edition.session_started`
(client-visible), `edition.credential_issued`, `edition.returned`, `edition.return_failed`,
`edition.return_empty` (client-visible, codes only). Non-developers see `edition` events only with
use of that edition.

## Client view of responses (O-1)

For callers whose role in the org is `client` or `viewer`, every JSON response under
`/api/orgs/:org/…` passes through `lib/client-view.ts`: Artifacts revision ids
(`art:<repoId>:<sha>`), candidate ids (`cand:<taskWorkspaceId>:<sha>`), and `gh:<owner>/<repo>:<sha>` /
`local:<repoId>:<sha>` ids, whole or embedded in
text, become stable opaque labels `rev-<16 hex>` (equality still works), the keys
`taskWorkspaceId`, `fork`, `treeId` and `sha` are dropped, and `submitter` is reduced to its kind.
`x-commonforge-revision` is rewritten the same way. Asset manifest ids (`r2m:`) are content hashes
and stay.

## Private previews (Task 22)

Plan §C.1 row 10, §F "Preview production-data access"; AT-31, AT-37. Owner decision 2026-10-06:
previews are **path-based on a dedicated `workers.dev` Worker** (`commonforge-preview`), token-gated
and expiring, all sharing that one origin (P0 shortcut, see Known deviations).

| Route | Who | Body → response |
|---|---|---|
| `POST /api/orgs/:org/proposals/:id/previews` | Owner or developer with write grants on the changed resources | → `202 Preview`. Needs code changes (`409 nothing_to_preview` for an assets-only proposal), `policy.preview` (`409 preview_not_configured`) and a successful integration for the **current** hash (`409 integration_required`). `409 staging_mode` in a staging-mode project ("staging replaces previews"); previews made before stay readable. |
| `GET /api/orgs/:org/proposals/:id/previews` | Anyone who can see the proposal (clients too) | `{ previews: Preview[] }`, newest first |
| `GET /api/orgs/:org/previews/:pvid` | Same | `Preview` |
| `DELETE /api/orgs/:org/previews/:pvid` | Owner or developer | Revokes the link at once (`state: "revoked"`) |

`Preview` = `{ previewId, proposalId, proposalHash, forCurrentHash, state: queued|ready|failed|expired|revoked, createdAt, updatedAt, expiresAt, url, error: {code, detail?} | null }`;
owners/developers also get `jobId`, `sources` and the runner's `error.detail`.

- **Build.** A runner `preview-build` job (Sandbox) builds at the proposal's **integration** commits
  (changed resources) and the base for the other mounts, with the server-owned `policy.preview`
  recipe (`recipe`, `bundles`, `hostVars`, `ttlSeconds`). Canonical access is read-only; the job
  may write only `org/<org>/previews/<previewId>/site/…` and `…/bundles/<name>/…`.
- **Link.** When the result arrives the Worker writes `…/meta.json` (`PreviewMeta`) and the link
  becomes `<COMMONFORGE_PREVIEW_URL>/p/<org>/<previewId>/<token>/`. The token is
  `<expiry base36>.<HMAC-SHA256(COMMONFORGE_PREVIEW_KEY, org|previewId|expiry)>`
  (`src/lib/preview-token.ts`); it is never part of a job or receipt and is only returned to
  callers who can see the proposal. Revoking deletes `meta.json`.
- **Preview Worker** (`src/preview/`, `wrangler.preview.jsonc`): every request needs a valid token
  **and** `meta.json` with an unexpired expiry (else 404). Static files come from `site/` (SPA
  fallback for extension-less paths). `…/api/*` goes to the preview's `PreviewBox` container, which
  runs the api bundle with `apps/runner/dist/preview-host.js`: `enableInternet: false`, **no**
  outbound interceptors, the host as uid 10001, **fixture bindings only** (`ORDERS` in-memory KV,
  `PAYMENT_WEBHOOK_URL`/`EMAIL_WEBHOOK_URL` → in-process fixture sink, every other `fetch`
  refused); `GET …/api/__fixtures` shows the fixture counters. `Cookie`/`Authorization` are never
  forwarded and `Set-Cookie` is stripped; responses carry
  `Content-Security-Policy: default-src 'self'; … connect-src 'self'; frame-ancestors 'none'`,
  `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`.

## Releases (Task 22)

Plan §A.5 rule 6 (approval ≠ acceptance ≠ release), §A.6 Release, §C.1 row 11; AT-21, AT-33,
AT-34, AT-35. **Accepting a proposal never deploys.**

| Route | Who | Body → response |
|---|---|---|
| `POST /api/orgs/:org/projects/:pid/releases` | Owner or developer | `{ acceptedVersionId? }` → `202 Release & {created: true}` or `200` (same inputs → same release). `409 release_not_configured`, `409 accepted_version_stale` (with `details.currentAcceptedVersionId`). |
| `GET /api/orgs/:org/projects/:pid/releases` | Project readers (clients need read on every source resource) | `{ releases: Release[], live: {releaseId, acceptedVersionId, outputDigest, since} \| null }` |
| `GET /api/orgs/:org/projects/:pid/releases/live` | Same | `{ live: Release \| null }` |
| `GET /api/orgs/:org/releases/:rid` | Same | `Release` |
| `POST /api/orgs/:org/releases/:rid/publish-approvals` | Roles in `policy.publishRoles` (default `["owner"]`; else `403 publish_role_not_allowed`) | `{ outputDigest }` → `201 { approvalId, releaseId, outputDigest, envDigest, approver, role, approvedAt }`. `409 output_digest_mismatch`, `409 release_not_prepared`. |
| `GET /api/orgs/:org/releases/:rid/publish-approvals` | Same as GET release | `{ approvals }` |
| `POST /api/orgs/:org/releases/:rid/deploy` | Owner or developer with write grants on every source | `{ idempotencyKey }` → `202 { releaseId, jobId, attempt, replayed: false, release }`; the same key → `200 replayed`. `409 publish_approval_required`, `deploy_in_progress` (also when **another** release of the project is deploying, verifying or rolling back: one deploy per project), `already_live`, `403 release_target_not_allowed` / `binding_not_allowed` (re-checked here), `503 config_missing` (no deploy token). Allowed from `publish_approved`, `failed`, `partial` and `recovery_required`. |
| `POST /api/orgs/:org/releases/:rid/recover` | Owner | `{ note }` → `Release`: after checking production by hand, a `recovery_required`/`partial` release becomes `failed` (retryable) and stops blocking the project (review R-1). `409 not_recoverable` while a rollback runs. |
| `POST /api/orgs/:org/deploy-resources` | Owner | `{ kind: "kv" \| "d1", name }` → `201 { kind, name, id, title, created: true }`, or `200 { kind, name, id, created: false }` when the org already has that kind and name: the platform creates KV namespace or D1 database `<prefix>-<org>-<name>` on the deploy account. Release policies may bind only these (D1: see "Production D1 and migrations"). At most 5 KV and 3 D1 per org and 5 distinct release Workers per org (`409 quota_exceeded`); a release Worker name belongs to one project of the org (policy save refuses a name another project names or runs live: `409 release_target_in_use`); a placeholder row claims the name before the API call (`409 deploy_resource_pending` for a concurrent create). |
| `GET /api/orgs/:org/deploy-resources` | Owner or developer | `{ workerPrefix, resources: [{kind, name, id, createdAt}] }` |

**Release targets are platform-controlled** (review C-1; the deploy token is account-wide):
- Worker names must be `<COMMONFORGE_DEPLOY_WORKER_PREFIX>-<orgId>-<name>` (default prefix `cfapp`);
  names starting with `commonforge` (the platform's own Workers) are refused by the schema. Checked
  at `PUT …/policy`, prepare, deploy, and again by the Sandbox gateway for every API call and job.
- Bindings: plain vars and KV namespaces from `deploy-resources` of that org only; the gateway
  inspects every upload's metadata and refuses any other binding type or KV id.
- The health URL is derived: `https://<workerName>.<deploy account workers.dev subdomain>.workers.dev<path>`
  (the subdomain is looked up with the deploy token); `healthCheck.url` no longer exists.
- Strongest control: point `COMMONFORGE_DEPLOY_ACCOUNT_ID` and a token scoped to it at a
  **separate** Cloudflare account, so the deploy token cannot reach the platform at all.

`Release` = `{ releaseId, projectId, acceptedVersionId, recipeRevision, envDigest, outputDigest, state, buildState: building|built|failed, status, live, publishApproved, deployAttempts, deployments: [{targetId, workerName, url}], health, error, createdAt, updatedAt }`;
owners/developers also get `sources`, job ids, each target's full deploy config (vars, KV bindings,
compatibility date/flags: what the output digest and the approval cover; review m-7), health
details and `error.detail`. Clients and viewers get `health` as `{ok, checkedAt, targets:[{targetId, ok}]}`
only (review m-2). `rollback` is `{state: running|verifying|done|failed}` when production was rolled back.
`status` is the UI label: `Building`, `Ready for publish approval`, `Approved, not live`,
`Deploying`, `Verifying the live version`, `Live`, `Build failed`, `Partly deployed, retry to finish`,
`Not verified, rolling back`, `Recovery required: production is unverified`.

1. **Prepare** binds `{acceptedVersionId, recipe (revision), envDigest}` and the exact source
   revisions (the ledger heads; `acceptedVersionId` = the latest accepted version touching them)
   into a `rel-<24 hex>` and issues `release-build` (Sandbox; canonical read only). `envDigest`
   covers the server-owned `policy.release` `targets`, `environment` (per-target production
   `vars` and `kvNamespaces`), `healthCheck` and the deploy account.
2. **Build receipt** fixes `outputDigest` (every file's sha256 and size plus each target's deploy
   config, recomputed by `parseRunnerResultForJob`). Deploy config comes from the source's
   `wrangler.jsonc` **data** fields read before any build step (`compatibility_date`,
   `compatibility_flags`, `vars`, `assets.not_found_handling`), overlaid by the server-owned
   environment; `COMMONFORGE_RELEASE_ID` is always the release id. Outputs are stored under
   `org/<org>/releases/<releaseId>/<targetId>/`.
3. **Publish approval** is its own record, bound to `{releaseId, outputDigest, envDigest}` and
   re-checked against the approver's **current** role at deploy time. Any other change (source,
   recipe, environment, output) is a different release and needs its own approval (AT-33).
4. **Deploy** claims the release (CAS `publish_approved|failed|partial|recovery_required → deploying`,
   only while no other release of the project is deploying, verifying or rolling back; it records
   the then-live release as the rollback target) and
   issues `release-deploy`: the runner fetches every stored file, checks sha256, target digests and
   `outputDigest`, writes a data-only `wrangler.json` (`no_bundle` for Worker targets) and runs its
   **own pinned** wrangler. The account token reaches only that job: `POST /api/runner/deploy-credential`
   (below) for broker-mode runners, or the Sandbox egress gateway injects it.
5. **Health** (queue step `release.health`, up to 6 attempts): **every** target's active
   deployment must run the version this deploy uploaded (Workers deployments API, review m-3), and
   the health-check target's `/version` (derived URL, `redirect: manual`) must answer 200 with
   `release === releaseId`. Only then the project's live pointer (`release_live`) moves
   (`state: live`).
   - A deploy that failed before changing anything leaves the previous release live: `failed`,
     `Approved, not live`. Retrying deploys the same release again (new `deployAttempts`, no new
     acceptance or approval; AT-35).
   - **Any failed deploy is checked against production** (review R-2): every target's active
     version ids are compared with the live pointer's recorded versions (a target the live release
     does not have must not exist). If anything differs (partial deploys, a failure after an upload),
     or production cannot be checked, the release becomes `recovery_required`, the live pointer is
     **cleared** (so nothing, including editions' `sourceReleaseId`, can name a release that is not
     what serves), and the previous release is redeployed as below. Only a failure that left every
     target exactly as recorded is plain `failed` ("Approved, not live", previous release live).
     A `partial` result that changed nothing visible can be redeployed directly (review I-5).
   - **Lost jobs** (review R-1): a deploy or rollback whose job ended without a result (the Sandbox
     gave up, the container died, the job expired and GC closed it), or a health/rollback check that
     made no progress for 30 min, makes the release `recovery_required` (`deploy_lost`) or
     `rollback_failed` and clears the pointer, releasing the project's deploy lock. This runs before
     every deploy claim, in the GC cron and in `recover`. The Sandbox runner also posts a failure
     result itself when it gives up on a job or the runner exits without one.
   - **A health failure after a successful deploy** means the new code is serving (review I-4):
     the release becomes `recovery_required` (`Not verified, rolling back`) and the service
     redeploys the previous live release's stored outputs (a `release-deploy` job for it, with the
     deploy credential). Only when that verifies (every target) is the release `failed` ("rolled
     back: the previous release is live again") and the live pointer is set back to it. Workers that
     only the failed release had are deleted (review m-d; only names inside the org's namespace). Without a previous release, or when the rollback fails, it stays
     `recovery_required` and the UI says production may run it unverified.

Events: `preview.requested|ready|failed|revoked`, `release.prepare_requested`, `release.prepared`,
`release.build_failed`, `release.publish_approved`, `release.deploy_requested`,
`release.deploy_failed`, `release.health_failed`, `release.rolled_back`, `release.rollback_failed`,
`release.live`, `deploy_resource.created`. Every `release.*` event carries `channel`
(`production` or `staging`) in its detail and client detail; staging releases are never shown as
production.

**Runner endpoint** `POST /api/runner/deploy-credential`: `{ signedJob }` (a `release-deploy` job,
still open, and either the release's **current** deploy job in state `deploying` or its running
rollback job) → `{ token, accountId }`
(`no-store`); anything else is `403`/`409`.

## Staging (spec 2026-10-07, Phase 1)

A project is in **staging mode** when its policy has a valid `staging` section **and** a `release`
section (otherwise `reset` and `rollback` answer `404 not_found`, and `GET …/staging` answers `enabled: false`). Staging is one
environment per project: the release targets deployed as `<workerName>-staging` with their own
platform-created D1 and KV (never a production id), and a public workers.dev URL. Anything the
staging Workers send to a webhook or email var listed in `captureVars` goes to the capture sink
instead of the real provider.

**The `staging` policy section** (owner, via `PUT …/policy`; `POST …/policy/validate` runs the same checks):

```jsonc
{
  "recipe": { /* BuildRecipe; optional, defaults to release.recipe (use it to point the website at <api>-staging) */ },
  "environment": {                       // by release targetId
    "api": {
      "vars": { "APP_VERSION": "1.0.0-staging" },
      "kv": [{ "binding": "ORDERS", "seed": "seed/orders.json" }],                      // ≤ 4
      "d1": [{ "binding": "DB", "migrationsDir": "migrations", "seed": ["seed/contacts.sql"] }]  // ≤ 4, seed ≤ 20
    }
  },
  "captureVars": ["PAYMENT_WEBHOOK_URL", "EMAIL_WEBHOOK_URL"],   // ≤ 8; set to the sink URL, never also in `vars`
  "promotion": { "rules": [ /* path rules → self | classify | developer; used from Phase 2 */ ],
                 "classifier": { "provider": "jev" | "openai-decisions" | "none", "threshold": 0.9 } }
}
```

Each environment key must be a release target and binding names are unique per target; every
release target's `<workerName>-staging` must fit 63 characters (`release.targets.<i>.workerName`). Seed
data exists only here, and staging D1 is platform-created: a production `release` section binds only org-owned D1 databases
(Phase 2, see "Production D1 and migrations"), never `data`,
and may not name a Worker ending in `-staging` (the policy save is refused; a name another project's production target or live Worker uses is `409 release_target_in_use`).
Migrations are the `.sql` files directly under `migrationsDir`, applied in name order; each file runs as one
request. Each database records what it applied as `<file>@<sha256>`: a removed, reordered or edited
applied migration resets staging data. A transient Cloudflare API answer (5xx, 429, no response)
while applying data is retried within the build's deadline; a 4xx (e.g. SQL D1 refuses) fails the
landing. Seeds are applied after migrations on a fresh database (SQL files for D1, a JSON array of
`{ key, value }` for KV).

**Routes**

| Route | Who | Body → response |
|---|---|---|
| `GET /api/orgs/:org/projects/:pid/staging` | Anyone who can read the project | `{ enabled, state, stateText, baseline, url, current: { buildId, since } \| null, building, landings: [{ landingId, taskId, title, state, reasonCode, reason, promotion, parts?, createdBy, createdAt, detail?, travelsWith? }] }`, newest 100 landings first. `promotion` is the landing's newest promotion, `{ promotionId, state }` or `null`, for every reader; `parts` (`[{ part, taskId }]`, part 1 is the task, each revision adds one; see "Landing parts and revisions") only for those who see the landing's reasons (owners, developers, and the client who created it). `enabled: false` (no other data) when the project is not in staging mode. `state` is `awaiting_baseline` (staging starts only after the owner's first production publish; `stateText` says so, "Waiting for the owner's first production publish.") or `active`; `baseline` is `null` or `{ since, releaseId? }` (`releaseId` for owners and developers). A landing created before the baseline waits in `checking` with `reasonCode awaiting_baseline` and is built once the baseline exists. `travelsWith` (owners and developers) lists the landing ids this landing is linked to (see the travel-with routes). `state` is `checking`, `landed`, `failed`, `rolling_back` or `rolled_back`. A client sees `reasonCode`/`reason` only for landings they created, and the text is composed by the platform (conflicting paths, "the staging deploy failed", "a migration did not apply"), never raw runner or provider output. `detail` (raw text) is for owners and developers only. |
| `POST /api/orgs/:org/projects/:pid/staging/reset` | Owner, developer or client who can read the project | → `202 { buildId }`. Rebuilds staging on **fresh D1/KV**: every migration and seed is applied from scratch. `404 not_found` when the project has no staging; `409 staging_awaiting_baseline` before the owner baseline. |
| `POST /api/tasks/:id/rollback` | Owner, a developer who can see the task, or the client who created it | → `202 { buildId }`. Takes the task out of staging and rebuilds (`buildId: null` when no build lists the landing, as for a landing still waiting for the baseline: it is `rolled_back` at once). `409 not_in_staging` unless the task has a `checking` or `landed` landing; `404` for anything else. |
| `POST /api/orgs/:org/staging/landings/:id/travel-with` | Owner or developer who can read the landing's project | `{ landingId }` → `201 { landingId, withLandingId }`: the landing `:id` goes to production only together with the earlier landing `landingId` (a forced predecessor for the promotion set and the alone set; idempotent; at most 20 links per landing). `404` for an unknown landing, `409 travel_with_not_earlier` (the linked landing must have a lower sequence in the same project), `409 not_in_staging` (both must be `checking`, `landed` or `promoting`), `409 travel_with_limit`. If the landing is in a promotion that does not include the linked landing, that promotion is superseded before it is accepted (reason code `travel_with_added`: "A developer linked this task to '<title>'; promote again."); once it holds production (`accepting`, `releasing`) the link is refused with `409 travel_with_in_flight` (`details.promotionId`) and nothing is written. Event `staging.travel_with`. |
| `DELETE /api/orgs/:org/staging/landings/:id/travel-with/:withLandingId` | Owner or developer | → `204`; idempotent. Event `staging.travel_with` (`linked: false`). A link to a landing that is `failed` or `rolled_back` makes `promote` answer `409 travel_with_left_staging` until it is deleted; a link to a `promoted` landing is satisfied. |
| `GET /api/orgs/:org/projects/:pid/staging/sent` | Anyone who can read the project | `{ captures: [{ captureId, receivedAt, method, path, headers, body, truncated }] }`, newest 100. |
| Any method on `/api/sink/:token` and `/api/sink/:token/*` | **Public**; the path token is the credential | → `202 { ok: true }`; `404` for an unknown token; `429 rate_limited` beyond 120 requests a minute per project (600 per client IP, 2000 overall). Records the method, the path after the token, headers and up to 16 KiB of body (`truncated` marks a clipped body). Never forwards anything. |

**Sink details.** Each project has one sink token, derived from the server secret and registered by
hash (the token itself is never stored); it is what staging's `captureVars` are set to
(`https://<app>/api/sink/<token>`). Credential-looking headers (`authorization`, `cookie`, `*token*`,
`*secret*`, `*api-key*`, `*password*`, `*session*`, `set-cookie`, `proxy-authorization`) are never
stored. The newest 200 captures per project are kept, and the cron sweep deletes captures older
than 7 days. A staging Worker with any `captureVars` is built with the compatibility flag
`global_fetch_strictly_public` (added to the source's flags, replacing a `no_global_fetch_strictly_public`):
Cloudflare refuses a Worker's fetch to another workers.dev Worker on the same account (`404`, error
1042) otherwise, so the sink would never receive anything. With the flag, all of that staging Worker's
outbound `fetch` calls go over the public internet. A production release policy cannot set
`environment.<target>.compatibilityFlags` (`400`); production takes the source's `wrangler.jsonc`.

**Landing.** In a staging-mode project, freezing the last write workspace of a task (the task turns
`submitted`) queues `staging.land`: the task becomes a landing (`checking`), a staging build merges
every open landing onto the live staging revision (a merge conflict fails only the landing it names,
with the paths), builds with the staging recipe, creates or reuses the D1/KV, applies new
migrations then seeds, deploys `<workerName>-staging`, and health-checks it. Success marks the
landings `landed` and the build live; failure marks them `failed` and keeps the previous staging
live (or rolls the deploy back; if that cannot be confirmed, the landing says a developer must check
staging). One staging build runs per project at a time. A landing of a task that was rolled back,
never became live or whose change was withdrawn ends `rolled_back`. A failed landing's task is not retried: the client
starts a new task from the current staging, or revises a task that is live (see "Promotions").

**Client task rules** (see "Tasks, workspaces, leases, credentials"): a client creates, lists, reads,
leases, freezes and rolls back only tasks they created; their agent (the lease token) gets the only
credentials, and the client's own responses never contain a task or canonical repository name.
Proposals, integration and accept stay with owners and developers; a landing proposal is closed when its landing fails
or is rolled back, and is never integrated or accepted directly (`409 staging_proposal`).

**No way around promotion (staging phase 4-2, P42-2).** In a staging-mode project a task is not proposed directly
(`POST …/proposals`: `409 staging_proposal`), no preview is requested and no edition is created, started or returned
(`409 staging_mode`). Proposals, previews and editions from before staging was turned on are not migrated: their reads
and the integrate and approvals routes answer as before (an open proposal is `policy_revision_stale` at accept, as after
any policy change). Without a `staging` section nothing changes.

## Promotions (spec 2026-10-07, Phase 2)

A task that is live on staging goes to production as a **promotion**: the Worker builds one new
proposal (`prop-pro-*`, listing `kind: "promotion"`) on the current `main` heads plus the candidates
of the **promotion set** (the task's landing and every earlier landing in staging that it shares a
path with, or that one of its revisions was built on, in landing order). Each candidate is applied
with its own staging base as the explicit merge base and committed with a single parent, so only the
task's own edits reach `main`. Checks and contracts run on the result. The gate decides who may clear
it, the clearance is accepted into `main` through the ledger, and the release service ships it to
production with D1 migrations applied before the code. Staging mode gates all of this: without it
`promote` (and `revise`) answer `404 not_found` (`assertStagingProject`), and every existing flow is
unchanged. The other promotion routes (read, approve, send back, retry-release) keep working on an
existing promotion; a promotion that has not started accepting fails at its next step with
`staging_not_configured`, while `accepting` and `releasing` finish what they started.

**Parallel promotions.** Promotions of one project build, gate and wait for approval **in parallel** when
their landing sets are disjoint. Each promotion claims its landings (`promotion_landings`; a landing is in at most
one in-flight promotion, a database invariant); a request whose set holds a landing another promotion claims
answers `409 promotion_dependency_busy`, and `409 promotion_in_progress` now means only that this task is already
being promoted. Only the steps that move `main` and production take turns: from the accept until its release ends
(`live`, `release_failed`, `failed`, or a rebuild back to `requested`) one promotion holds **production** (a
database claim, so releases run in accept order). A `cleared` promotion that cannot take production waits in
`cleared` (`reasonCode production_busy`, `waitingForProduction: true`, first come first served by clearance
time); whoever releases production wakes the oldest one. A promotion's proposal is built on the `main` it will be
accepted on, so after each accept the oldest waiter rebuilds; it starts as soon as the accepting promotion
reaches `releasing` (its accept moved `main`), so the rebuild overlaps the release and the waiter is usually
ready when production frees. Only the oldest waiter rebuilds ahead; the others rebuild when they reach the front. A rebuild caused only by this project's own promotions' accepts
does not count toward the rebuild cap (`promotion_rebuilds` counts them); if the 6 hour deadline
still fires after such rebuilds the client text is "Production kept changing; promote again." A rebuild from
`cleared` restarts the 6 hour deadline, so the deadline alone does not bound a wait: waiting is bounded by the
first-in-first-out order (about one rebuild per promotion ahead in line).

**Baseline.** Staging in a project starts only after the owner has published the current `main` to
production once: a production release is live and, for every resource it is built from, the ledger head is
exactly the release's source revision. That is recorded once per project (`staging_baselines`; permanent,
turning staging off and on keeps it) when a production release goes live and when a staging policy is saved.
Before it, landings wait (`awaiting_baseline`), nothing is built or deployed, and `promote` and `reset` answer
`409 staging_awaiting_baseline`. Clearance releases start each resource at the live release's revision for it;
while nothing is live in production they start at the baseline's revisions. A resource the start point lacks (a
mount added or re-pointed later, missing from the live release or the baseline) is checked from its beginning, so
it needs one owner publish first.

**Alone-first.** A promotion first tries the task **alone** (the task plus the landings a developer linked it to
with travel-with) when every resource the alone set changes has at least one **required** policy check marked
`gatesAlone: true` (owners mark the checks that build or test the code of their mount; a lint-only check is not
marked; contracts do not count) and the overlap closure is larger. The response then has `mode: "alone"` and
`goingWithout`, the earlier overlapping tasks it leaves in staging (`Going to production without '<title>' (still in
staging)`). The alone build merges the task's own edits onto `main` like any build. If it ends in a textual
conflict, a failed required check or a failed contract, the promotion **widens once** to the current closure:
the extra landings are claimed, the clearance is void, it rebuilds with `mode: "closure"` and `needs` listing the
tasks it added (`reasonCode needs_dependencies`, "Needs '<title>'; promoting them together."), event
`promotion.widened`. It fails as before when the closure adds nothing, and with `promotion_dependency_busy`
(naming the tasks: not live on staging yet, or "being promoted now") when a landing it needs is not `landed`.
Eligibility is re-checked at every build; if a policy change makes the task ineligible the promotion widens the
same way (`policy_changed`: "The project's checks changed while the promotion was built. Promote again." as the
failure text when it cannot).

**Routes**

| Route | Who | Body → response |
|---|---|---|
| `POST /api/tasks/:id/promote` | The client who created the task, or an owner or developer who can see it; `404` for anyone else, or a project without staging | `{}` → `202 { promotionId, landings: [{ landingId, taskId }], mode, goingWithout: [{ landingId, taskId, title, text }] }` (the set, in landing order; `mode` is `alone` or `closure`). `409 not_in_staging` (no landing in staging for the task or the landing it joined as a revision; also a failed, rolled-back or promoted landing), `not_landed` (still `checking`), `promotion_in_progress` (this task is already being promoted; `details.promotionId`), `promotion_dependency_busy` (a landing of the set is `checking`, or claimed by another in-flight promotion; `details: { promotionId?, taskId, title }`, and the text says "is being promoted; wait until it finishes" or "not live on staging yet"), `staging_awaiting_baseline` (the owner has not published `main` to production yet), `travel_with_left_staging` (a task this one must travel with failed or was rolled back; a developer deletes the link; `details: { landingId, withLandingId }`), `staging_changed` (staging moved while the request was written; try again). |
| `GET /api/tasks/:id/promote` | As `POST` | **Dry run** (the Promote sheet): → `200 { landings: [{ landingId, taskId, title }], mode, goingWithout: [{ landingId, taskId, title, text }] }`, the set `POST` would promote now, computed by the same code (`planPromotion`), in landing order. Writes nothing (no promotion, no claims, no events; it does not repair leftover `promoting` landings or wake a holder, which `POST` does). The same errors as `POST` (`not_in_staging`, `not_landed`, `promotion_in_progress`, `promotion_dependency_busy`, `staging_awaiting_baseline`, `travel_with_left_staging`; `404` as `POST`). A later `POST` can still differ if staging changes in between. |
| `GET /api/orgs/:org/projects/:pid/promotions` | Owner, developer or client who can read the project; viewers `403 insufficient_role`; `404` for a project the caller cannot read or another org | `?state=a,b` (optional, comma-separated promotion states; an unknown state is `400 invalid_request`) → `{ promotions: [Promotion view] }`, newest first, at most 100. Owners and developers get every promotion of the project in the developer view (a developer without read on every resource a promotion changes gets the client view of that one, as in `GET …/promotions/:id`); a client only promotions they requested or with a landing they created, in the client view. List rows never carry `resources` or `checks` (read them with `GET …/promotions/:id`); everything else of the view is there. A project that never had promotions (one that never had staging, for instance) answers `{ promotions: [] }`; a project whose staging was turned off still lists its past promotions. |
| `GET /api/orgs/:org/promotions/:id` | Anyone who can read the project | Promotion view (below). `404` otherwise. `GET …/staging` also gives each landing's newest promotion (`promotion: { promotionId, state }`). |
| `POST /api/orgs/:org/promotions/:id/approve` | Owner or developer whose role is in the project's `approvalRoles` | `{}` → Promotion view. `pending_approval` → `cleared` with a `developer` clearance. `403 approval_role_not_allowed`, `403 promotion_not_visible` (a developer without read on every resource the promotion changes, the rule of the developer view; owners always pass), `409 promotion_not_pending`, `409 promotion_changed` (rebuilt since the caller read it; reload). |
| `POST /api/orgs/:org/promotions/:id/send-back` | Owner or developer | `{ note }` (1-2000 characters) → Promotion view. `pending_approval` or `cleared` → `sent_back`; any clearance is void and the landings return to `landed`. The note is shown to the client verbatim. `403 promotion_not_visible` (as for approve), `409 promotion_not_pending` (already accepting or ended), `409 promotion_changed`. |
| `POST /api/orgs/:org/promotions/:id/retry-release` | Owner or developer with a write grant on every resource the release deploys from and on the promotion's resources (`403 no_write_grant`) | `{}` → Promotion view. `release_failed` → `releasing`: a fresh prepare of the latest accepted version and a new deploy, run by the promotion service. It takes production ahead of any `cleared` waiter (it releases what is already in `main`). `409 promotion_not_release_failed`; `409 production_busy` while another promotion accepts or releases (`details.promotionId` of the holder). |
| `POST /api/orgs/:org/promotions/:id/withdraw` | The client who requested the promotion, or an owner or developer who can read its project; `404` for anyone else | `{}` → Promotion view. `requested`, `building`, `gating`, `pending_approval` or `cleared` → `withdrawn` (terminal; reason code `withdrawn`, "Withdrawn"): the landings return to `landed`, their claims are released, the proposal is superseded and any clearance is void. `409 promotion_accepted` once it is `accepting`, `releasing`, `release_failed` or `live` (a failed release is retried, not withdrawn), `409 promotion_not_in_flight` when it already ended, `403 not_promotion_requester` for any other client, `409 promotion_changed` (it moved while the request ran; reload). Its integrate job, if running, still runs to completion. Event `promotion.withdrawn`. |
| `POST /api/tasks/:id/revise` | The task's creator, or an owner or developer who can see it | `{ request? }` → `201 Task`: a follow-up task with the original's write and read mounts, started from live staging, titled `"<original title> (revision N)"`, with `revisesTaskId` set. Its proposal joins the original's landing as the next **part** when it is submitted. `409 landing_not_revisable` unless the landing is `landed`, or `promoting` in a promotion that is `pending_approval` or `cleared` (submitting the revision then supersedes that promotion). |

**Promotion view.** Everyone who can read the project gets `{ promotionId, state, landings: [{ landingId, taskId, title, state }], level, reasonCode, reason, waitingForProduction, mode, goingWithout, needs }`. `waitingForProduction` is true while the promotion is `cleared` with `reasonCode production_busy`; `mode` is `alone` or `closure`; `goingWithout` and `needs` are `[{ landingId, taskId, title }]` (`goingWithout` entries also carry `text`): the tasks an alone promotion leaves in staging, and the tasks it added when it widened.
`level` is `self`, `classify` or `developer` once gated. A client (or viewer) sees `reasonCode` and
`reason` only for promotions they requested or whose landings they created, and the text is composed
by the platform (conflicts with production, a failed required check, "a developer needs to check it",
"the production update did not go live", "a database migration failed; production was not changed",
"a database update did not confirm; a developer is checking production" (`migration_state_unknown`),
"production has other changes waiting for an owner's approval") or is a developer's send-back note.
Owners, and developers with read on every resource the promotion proposal changes (before a proposal exists: every resource its tasks' snapshots name; the task view's rule), also get `targetLandingId`, `proposalId`, `proposalHash`, `gate` (`pathLevel`,
`perPath`, `veto`, `classifier`, `reasonCode`; see "Gate"), raw `detail`, `clearance: { kind, clearedBy, clearedAt } | null`,
`acceptedVersionId`, `releaseId`, `requestedBy`, `createdAt`, `updatedAt`, and what the review screen needs:
- `landings[]` entries also carry `request` (the task's request text) and `parts: [{ part, taskId, title }]`
  (the task and its revisions, in part order).
- `resources: [{ resourceId, mountName, head, result }]`: per changed resource of the integration for the
  promotion's **current** proposal hash, `head` (the `main` head it was built on) and `result` (the integration
  result) as **revision ids** (for git folders `art:<repo>:<sha>`), exactly what `GET …/projects/:pid/file?mount=&path=&revision=`
  and `…/tree` take (developers only); `mountName` is a mount of the resource in the project (`null` if none). `[]`
  before the integration for the current hash is recorded (also while a rebuild runs).
- `checks: { checks, contractChecks, mergeOutcome } | null`: that integration's validation evidence (`checkId`,
  result and output per check, as in the proposal view), `null` before it exists.

`resources` and `checks` come only from `GET …/promotions/:id` (and the approve, send-back, withdraw and retry-release responses), never in the project's promotions list.

Clients, viewers and developers without read on every such resource never get `gate`, `resources`, `checks`, `request`, `parts`, `detail` or the ids above (their `reasonCode`/`reason` follow the client rule).

**States and transitions**

| State | Meaning → next |
|---|---|
| `requested` | The proposal is built on the current `main` and its integrate job issued → `building` |
| `building` | Waiting for the integrate receipt for the proposal hash; `main` moved → `requested` again (a rebuild) |
| `gating` | Path levels, the migration veto and (for `classify`) the risk classifier decide the level → `cleared` (self, the classifier, an owner's request, or a carried clearance) or `pending_approval` |
| `pending_approval` | Waits for a developer: `approve` → `cleared`; `send-back` → `sent_back`; a policy change → `requested` |
| `cleared` | Set guard, then takes production → `accepting`; waits here (`production_busy`) while another promotion accepts or releases and is nudged when production is free (oldest first); `main` moved → `requested`; a policy change → `requested`; `withdraw` → `withdrawn` |
| `accepting` | Holds production. Ledger accept with the clearance as the approval → `releasing`; `main` moved → `requested` |
| `releasing` | Prepare, clearance publish approval, deploy (migrations first) → `live`, or `release_failed` |
| `release_failed` | `retry-release` → `releasing`. `main` already has the change (R10) |
| `live` | A production release containing the accepted version went live (terminal) |
| `withdrawn` | Terminal. Withdrawn by its requester, an owner or a developer before it was accepted; the landings are `landed` again |
| `sent_back`, `failed`, `superseded` | Terminal. The landings go back to `landed` (`failed`/`sent_back`) or follow the revision that superseded the promotion |

`requested`, `building` and `gating` are bounded: 6 hours from `machine_since` (restarted when a
person acted and when a waiting `cleared` promotion rebuilds), at most 10 rebuilds
because `main` moved by something other than this project's promotions (`promotion_rebuild_limit`; the
rest are counted in `promotion_rebuilds`, bounded only by the deadline), at most 10 integrate jobs per proposal hash
(`promotion_job_limit`); `accepting` fails 1 hour after it took production (`claimed_at`, not the clearance), `releasing` becomes
`release_failed` 2 hours after it started or was retried. A proposal the ledger shows accepted
without an accepted version naming it (never expected) becomes `release_failed` with reason code
`accepted_version_missing` 1 hour after it took production (the landings are `promoted`: `main` has the
change; developers read `detail`); `retry-release` then prepares the latest version under the
clearance rules. Failure `reasonCode`s include
`textual_conflict`, `check_failed` and `contract_failed` from the build, `promotion_timed_out`, `promotion_step_failed`,
`landing_failed` (a landing left staging), `landing_revised` (a revision was submitted), `travel_with_added` (a developer linked one of its tasks to a landing it lacks; superseded), `withdrawn`, `needs_dependencies` (an alone promotion widened; not a failure) and `production_busy` (a cleared promotion waits for production; not a failure),
`staging_not_configured` (staging turned off), `candidate_missing`, `promotion_proposal_closed`,
and the gate reasons `developer_paths`, `migration_destructive`,
`classifier_declined`, `classifier_unavailable`, `gate_error`.

**Gate.** Each changed path gets a level from `staging.promotion.rules` (first match; unmatched
paths are `developer`); the set's level is the strictest. A deterministic **migration veto** reads the
migration files at the `main` head and at the integration result (`lintMigrations`): anything not
provably additive (drop, rename, type change, `UPDATE`/`DELETE`, unknown statements, a changed or
removed applied file, files too large, non-regular git modes) makes the level `developer`. The gate fails
closed: any error while gating is `developer`.

**Risk classifier** (staging phase 3). A set whose strictest path level is `classify`, whose veto passed and that
has no `developer` path, asks the project's classifier (`staging.promotion.classifier.provider`: `jev` (TypeSafe,
model `jev-latest`), `openai-decisions` (model `COMMONFORGE_OPENAI_DECISIONS_MODEL`, default `gpt-6-luna`) or
`none`) once per gating, with a 5 s timeout. It answers five fixed choice questions about the change (risk
low/medium/high, migration none/additive/destructive, API change none/backward_compatible/breaking, touches sign-in
or payments yes/no, and a guard: does the change contain text addressed to a reviewer); the promotion clears only
when every question's safe options reach `threshold`. Its input is platform text plus, as quoted data, the set's
task titles and requests, every changed path with its level, a diff capped at 64 KiB (16 KiB per file; migration
SQL in full) and the integration's check results; an input over 96 KiB is not sent. Every failure (no provider, no
key, timeout, HTTP error, refusal, malformed or partial answer) waits for a developer. A clearing answer writes a
`classifier` clearance (cleared by the requester).

**The classifier clears only a complete view of the change (P3-11).** It is not asked (error `input_incomplete`)
when a text diff was cut by the caps or shown only as a size line (`diff_truncated`), files were left out past the
diff cap (`files_omitted`), a changed file at a `classify` or `self` path was not read: a read error, a path absent
on both sides, or a file after reading stopped (`file_not_read`, listed as "(file not read)"), a binary or LFS file
sits at a `classify` path and its extension is not png, jpg, jpeg, gif, webp, avif, ico, woff, woff2, ttf, otf, mp4,
webm, mp3 or pdf (`binary_file`; svg is text), more than 200 changed `classify`/`self` files (`too_many_files`;
nothing is read), a side over 1 MiB (`file_too_large`) or more than 4 MiB read in all (`read_limit`). A cut task
text does not count. Reading stops at the first such finding. Before evidence clears, the gate checks it again: no
error, a complete input, the policy's provider and threshold, and the answers clear again at the policy's threshold.

`gate.classifier` (developers and owners only) is `{ asked, cleared, reason, evidence? }`, `reason` one of:
`not_needed` (the level was not `classify`, the veto was destructive, or a `developer` path; not asked),
`carried` (a clearance carried from an earlier build covers `classify`; not asked again), `not_configured`
(provider `none` or no key), `cleared`, `declined` (answered, not confident) or `error` (also evidence for another
provider or threshold than the policy names). `asked` is whether it was asked in this gating; `cleared` whether the
evidence clears (asked now, or carried). `evidence` is
`{ provider, model, threshold, inputDigest (sha256 of the exact input), truncated, omittedFiles, inputBytes,
latencyMs, answers: { <question>: { choice, probabilities, confidence? } } | null, safeProbability, cleared,
failed (the first question that did not clear), error (not_configured, timeout, http_error, refused, malformed,
input_too_large, input_incomplete), incomplete? (with input_incomplete: diff_truncated, files_omitted,
file_not_read, binary_file, too_many_files, file_too_large, read_limit) }`; never the provider's raw body or a key.
`gate.reasonCode` is `classifier` when it cleared, and also for a carried `classifier` clearance, shown as
`classifier: { asked: false, cleared: true, reason: "carried", evidence }` with the evidence it was first cleared on
(a `classifier` clearance keeps it; evidence that no longer clears under the policy, such as a changed provider or
threshold, asks again). A carried `developer` clearance over a `classify` level is `gate.reasonCode: "carried"`
(`classifier: { asked: false, cleared: false, reason: "carried" }`).

Promotion `reasonCode`s of a `classify` set that waits for a developer: `classifier_unavailable` ("Needs a
developer's review.": not configured, an error, a timeout, too large or an incomplete input; the developer-only
`detail` names the evidence error, e.g. `classifier: input_too_large` or `classifier: input_incomplete
(file_not_read)`) and `classifier_declined`, whose
text names the first question that did not clear: risk "The automatic review could not confirm this change is
low risk.", migration "Changes the database structure in a way that needs a developer.", API change "May change
how the API works for existing callers.", sign-in or payments "Touches sign-in or payments.", the guard "Needs a
developer's review.".

**Clearances.** A clearance is a typed ledger approval (`role: "clearance:self" | "clearance:classifier" | "clearance:developer"`)
written only by the promotion service, bound to the promotion proposal's hash and honoured only while
the promotion row is `cleared`/`accepting` for it. Users can never create one through the approvals
route.
- `self`: the gate level is `self`; cleared by the requester (a client may).
- `classifier`: the gate level is `classify` and the risk classifier cleared it; cleared by the requester (a client may). Covers `classify` and `self`.
- `developer`: an owner or developer approved, or an owner requested the promotion and owners are in `approvalRoles`.
- **Carry rule.** When `main` moves (or the policy changes) the promotion is rebuilt, the checks rerun and the
  clearance is carried to the new proposal without anyone approving again, if the key (the set's landing
  proposal hashes) is unchanged, the new level is no stricter than the clearance covers (`developer` covers every
  level, `classifier` covers `classify` and `self`, `self` only `self`) and the clearer still qualifies; a carried `classifier` clearance does not ask the classifier again (`gate.classifier.reason: carried`, its evidence kept) unless that evidence no longer clears under the policy (another provider or threshold).
- **Voided** by a new revision part of any landing in the set (a new proposal hash), by a policy change that raises the level
  above what was cleared, by a send-back, or when the clearer no longer qualifies.
- **Staging mode needs approvers:** saving a staging policy whose `approvalRoles` has neither `owner` nor `developer` is refused.

**Release.** After the accept the landings are `promoted` (not when production is live: R10), their landing proposals
`superseded`, and staging is rebuilt without them. What else `main` gained is recorded with the accept: every
part's task has its verified LFS objects accepted (in the resources both its landing proposal and the promotion
proposal change; objects the hash step verifies later too, as for an accepted task proposal), and a file change
staged through a part becomes `added` (its LFS objects accepted, event `files.change_added` with `promotionId`;
see "File changes"). Both are idempotent and repeated when the release starts, so a step that died after the
accept is repaired. The production release is prepared and deployed by the
promotion service on behalf of the clearer (a client who cleared by `self` can call no release route); the
clearance itself is the publish approval, **only when everything new in production came through promotions of this
project**. If production would also get accepted versions no promotion cleared (an ordinary accept, a restore),
the release stops with `release_needs_publish_approval` and an owner publishes the release by the normal routes.
A folder mounted after the owner baseline needs one owner publish before clearances can carry it.
Migrations are applied first; a failed migration stops the release before any code changes.

**Errors raised while a promotion is built or released** (a promotion's `reasonCode`, or the HTTP code of
the route that shows it): `promotion_part_missing` / `promotion_part_changed` (a landing proposal is gone or
changed since the request), `promotion_candidate_not_prepared`, `nothing_to_promote` (the set has no git
changes), `promotion_base_unsupported` (a candidate has no git base), `promotion_changed` (the proposal's hash
changed; at accept it fails the promotion), `integration_required` (a promotion is accepted only on its own
integration result for the current hash), `promotion_rebuild_limit`, `promotion_job_limit`,
`release_needs_publish_approval`, and the migration codes below.

**Landing parts and revisions.** A landing is made of **parts**: part 1 is the task, each revision appends a
part (`staging_landing_parts`). The landing keeps its position and returns to `checking` until a staging build
with the new part is live; staging applies all parts in order. A revision is applied at its landing's position
and may conflict if it builds on a later landing. Task responses carry `revisesTaskId` for a revision.
Every task in a staging-mode project, whoever creates it, starts from the live staging commit (the staging build it was
seeded from is recorded in `tasks.staging_build_id`, an internal column that the API does not return; promotion sets
use it to include the later landings a revision was built on).
Landing `reasonCode`s added in this phase:

| Code | Landing | Meaning |
|---|---|---|
| `revision_landed_alone` | the revision | the revised landing was still being accepted into production 2 hours after the submit, so the revision became a landing of its own |
| `revision_without_original` | the revision | the revised task is no longer in staging (`failed`/`rolled_back`), so the revision landed on its own without it |
| `conflicts_with_production` | the landed task | a landing that was live no longer merges onto `main` after a promotion; it fails (its promotion is superseded) |
| `promoted_after_staging_failure` | `promoted` landing | staging dropped it after the promotion's set guard, but its change is in `main` |

A revision that cannot be added to staging is dropped without touching the live parts (event
`staging.revision_dropped` on the revision task with the platform text "This revision conflicts with staging in …"
or "This revision could not be added to staging"; its proposal is withdrawn); the landing returns to `landed`
without it. Landing states are now `checking`, `landed`,
`promoting`, `promoted`, `failed`, `rolling_back`, `rolled_back`. A failed or rolled-back landing's proposals are
closed. After 5 failed staging builds in a row staging requests no further build by itself (`staging.stuck`,
visible to developers) until a new landing or a reset.

**Proposals listing.** `GET …/proposals` entries carry `kind: "staging" | "promotion" | null`. Landing (`staging`) and promotion
proposals are refused by the integrate, accept and approvals routes: `409 staging_proposal` ("Promote this task from
staging instead") and `409 promotion_proposal` (a promotion proposal is approved and accepted only through its promotion).

**Events** (project timeline; the client-visible ones carry only codes): `promotion.requested`, `promotion.pending_approval`,
`promotion.cleared` (`kind`, `clearedBy`; a carried clearance is recorded by the promotion service), `promotion.accepted`,
`promotion.live`, `promotion.release_failed`, `promotion.release_retried`, `promotion.sent_back`, `promotion.failed`,
`promotion.superseded`, `promotion.withdrawn`, `promotion.widened` (`needs`, `landings`, `failure`); `staging.baseline_established` (client visible, no detail; developers see `headsMovedSince` when a head moved between the check and the write), `staging.travel_with` (`landingId`, `withLandingId`, `linked`); `staging.promoting`, `staging.promoted`; `proposal.accepted` (with `promotionId`);
`release.migrations_applied`, `release.migration_failed`; `production_migration.resolved`; `staging.revision_dropped`, `staging.stuck`.

### Production D1 and migrations

- `POST /api/orgs/:org/deploy-resources` takes `kind: "kv" | "d1"` (owner). A `d1` creates a D1 database
  `<prefix>-<org>-<name>` on the deploy account → `201 { kind, name, id, title, created: true }`. At most **3** D1
  databases per org (`409 quota_exceeded`), 5 KV. A production release may bind only org-owned databases
  (`release.environment.<target>.d1Databases: [{ binding, id }]`), never a staging database; each D1 belongs to
  one project (`409 binding_in_use` at policy save and deploy).
- **`release.migrations`**: `[{ targetId, binding, dir }]` (≤ 8; the target must be a worker target that binds `binding`).
  The Worker derives the target's `data` from these folders: production carries migrations only, never a seed, and
  `release.environment.*.data` stays refused. A build whose data files are not all inside a declared folder is refused
  (`403 release_data_not_allowed`); a `migrations` entry the build does not bind is `409 release_migration_unbound`.
- **Applying.** Before a production deploy the Worker applies pending `.sql` files of each folder in name order, one
  D1 query per file, each file's stored bytes verified against the build receipt's sha256 first (`409 release_data_missing`,
  `409 release_data_mismatch`), and records `<file>@<sha256>` per database. Applied files are never re-run, edited or
  reverted. `409 production_migration_changed` (an applied name has other content: add a new migration),
  `409 migration_out_of_order` (a new name sorts before the last applied one), `409 migration_failed` (D1 refused the
  file with a 4xx: nothing is recorded, a retry runs it again), `409 migration_state_unknown` (the query was sent but
  its outcome is unknown, or another deploy is applying it; every later deploy needing the database refuses until an
  owner resolves it), `503 migration_unavailable` (could not start; retry the deploy).
- Records are `applying` (written before the query is sent) or `applied`.

| Route | Who | Body → response |
|---|---|---|
| `GET /api/orgs/:org/production-migrations?state=applying\|applied` | Owner or developer | `{ migrations: [{ resourceId, key, releaseId, state, startedAt, appliedAt }] }`, newest first, at most 500. `400 invalid_request` for another state. `?state=applying` lists those an owner must resolve. |
| `POST /api/orgs/:org/production-migrations/resolve` | Owner | `{ resourceId, key, applied }` → `{ resourceId, key, state: "applied" \| "pending" }`: after checking the database by hand, `applied: true` records it as run (never run again), `false` removes the record (the next deploy runs it). `404` unknown record, `409 migration_state_known` (already `applied`), `409 deploy_in_progress` (a production release deploying with that database). |

## Sandbox runner and egress gateway (Task 22)

`commonforge-runner` (`src/sandbox/`, `wrangler.runner.jsonc`) consumes `commonforge-runner-jobs`
and runs each job in a fresh container (`RunnerBox`, `standard-1`, destroyed afterwards) with the
`apps/runner` image, `enableInternet: false`, reaching the control plane only through the
`CONTROL` service binding. Before start it asks the broker for the job's repository tokens (and
the deploy token for `release-deploy`) and registers per-job interceptors (`src/sandbox/gateway.ts`):

- **Artifacts git host:** only the job's repositories; `upload-pack` for each, `receive-pack`
  only for write repositories, and the receive-pack command list must be exactly one update of a
  ref in `jobAllowedPushRefs(job)` with the job's lease (no delete, `atomic` or push options).
  The bearer is injected here; nothing passes after the job's expiry; tokens are revoked at the end.
- **Control plane:** `POST /api/runner/{results,evidence-key,heads}` and `GET|PUT /api/runner/blobs/*`
  only (never the broker or `deploy-credential`).
- **npm registry** (install steps of `integrate`, `preview-build`, `release-build`): GET/HEAD only,
  over plain HTTP inside the container (`PNPM_CONFIG_REGISTRY=http://registry.npmjs.org/`;
  pnpm 12 does not trust the interception CA); the gateway fetches HTTPS upstream without
  following redirects. For `integrate`, only the runner's own dependency install may use it: the
  RunnerBox writes a per-job npm key (root-only file), the install presents it as its registry
  token, and the gateway refuses requests without it.
- **`api.cloudflare.com`** (`release-deploy` only): the job's Worker names on the job's account
  (`/workers/scripts|services|workers/<name>…`, `/workers/subdomain`, assets upload with its own
  session JWT, token verify); the deploy token replaces wrangler's placeholder.

**`unshare --net` works in the Sandbox** (CAP_SYS_ADMIN; verified live 2026-10-06). Jobs that
can write a repository, and every `integrate` job (an assets-only one writes nothing), therefore run
checks with **no network** (`checkNetworkFor`, `src/sandbox/gateway.ts`). Before an integrate's checks, the
runner installs each mount's dependencies from its committed `pnpm-lock.yaml` (`--frozen-lockfile`,
no install scripts, as the check uid; apps/runner/README.md "Dependency installs"). Read-only build jobs keep the
gateway-limited network for their install steps. In every job the Artifacts and control-plane
gateways also require `x-commonforge-runner-key`, a per-job secret in a root-only file that only
the runner's own git processes and Worker calls send (review I-3): a check or recipe step reaches
the npm registry and nothing else, so it cannot read canonical history or other refs.

**Release deploy gateway** (review C-1, m-a): every target name must start with
`<COMMONFORGE_DEPLOY_WORKER_PREFIX>-<orgId>-` (the org, `o-<12 hex>`, from the job's output prefix)
and never `commonforge`. Per script, only the calls of a data-only deploy pass: `GET` anything but
`tails` (wrangler reads secret names, never values), `PUT` (upload), `PUT content`, `POST versions|deployments|assets-upload-session|subdomain`,
`PUT schedules`; `services/<n>` and `workers/<n>` are read-only. Settings changes, secrets and tail
consumers are refused. Every request body is inspected whatever its declared content type (matched
case-insensitively): every multipart part and any JSON may carry only `plain_text` and the job's
own `kv_namespace` bindings, no `tail_consumers`, no `logpush`; other non-empty body types are refused.

## Folders with uploads

Owners, and developers with write on a folder, add files to it from a browser (the web app's
Files tab) or the CLI. A **git folder** (`artifacts` resource) also takes `git push` with git-lfs.
Everything lands as an ordinary accepted version, through a proposal.

**File collections** (`r2-assets`) take uploads and changes too, with three differences: their
files are never edited in place (an `edit` op answers `400 edit_unsupported`), the Worker applies
the change itself by writing the collection's next manifest (no runner job, see "File collections"
below), and the LFS routes answer `404` for them (as for any folder that is not a git folder).

The browse routes (`GET …/tree`, `GET …/file`, under "Projects, mounts, resources") show people
**real files**, never LFS pointers: a git file stored in LFS is listed with its real size and
downloads its real bytes.

### Flow

1. **Upload.** `POST …/uploads` starts an R2 multipart upload straight to the object's final key;
   the client sends numbered parts (`PUT …/parts/:n`) and completes (`POST …/complete`). Each part's
   body is streamed through the Worker to R2 as it arrives (checked against its `content-length`),
   never buffered whole.
2. **Hash.** Completing queues the hash step (queue step `lfs.hash`): the Worker streams the object
   from R2, computes its sha256 and checks its size, and records whether it is binary and the R2
   etag of the bytes it hashed. The upload becomes `verified` (or `rejected`, with an `error`). Poll
   `GET …/uploads/:uploadId`. Everything that later serves or uses the bytes (LFS downloads, the
   runner's fetch of small text files) reads them **pinned to that etag**: bytes written again after
   verification are never served, and the upload becomes `rejected` (`object_changed`).
3. **Change.** `POST …/changes` names operations (put verified uploads, edit small text files,
   delete, move) and answers `202` with the change in state `applying`. A change waits until
   every upload it names is verified.
4. **Apply.** The Worker stores the resolved operations as an R2 manifest and issues an
   `apply-files` runner job: the runner applies them to the folder's accepted head in a fresh
   `-tasks` repository and pushes one commit authored by the uploader. Large, binary or
   LFS-pattern files are committed as **LFS pointers**; the runner never downloads LFS objects.
5. **Proposal.** The Worker freezes the candidate and opens a proposal like any task candidate, then
   prepares it. In a **staging-mode** project the change's task, now submitted, also lands in
   staging exactly as a frozen agent task does (`staging.land`, see "Staging"); the change itself
   still continues to the folder as below (Phase 1: owner and developer work reaches `main` through
   its proposal). A restarted attempt rolls its own landing back; the next attempt lands instead. A
   change that **fails** rolls its landing back too (best effort): a failed change is final, so
   nothing of it stays on staging. A landing created for a task that failed meanwhile is rolled
   back by `staging.land` itself. Changes to file collections never land in staging (staging builds
   git candidates only, as for an agent's asset-only task).
6. **Landing.** The proposal is integrated (state `checking`): a change whose paths are all
   **content** (not code) runs no checks; a change that touches code runs the project's policy
   checks. An LFS path is content, other paths are classified by extension; **replacing a code file
   that was not stored in LFS is code even when the new version is an LFS object** (so replacing
   `index.html` with a large upload runs the checks). Then the uploader's own approval is recorded **only if the uploader's role is listed in the
   project policy's `approvalRoles`** (owners when the policy sets none; developers count only if
   the policy lists them). Otherwise the change waits in `waiting_approval` for a person to approve
   and accept the proposal (`proposalId`) through the normal approval and accept routes. When the
   approval counts, the Worker accepts the proposal itself.
7. **Added.** The accepted version is the folder's new head and the LFS objects it points to are
   accepted (promoted; no bytes move). The change is `added`.

For a **file collection**, steps 4 and 5 differ (see "File collections" below): the Worker copies
each upload into the collection's content-addressed key, writes the next manifest and opens the
proposal; every path is content, so step 6 never runs checks. After step 7 the uploads' staged rows
and keys are deleted (the manifest names the copies).

Once a change that puts an upload has been added, that upload cannot be put again (`invalid_upload`):
upload the file again. Git-lfs pushes are staged the same way (verified, unaccepted) until an
accepted version points to them.

### Uploads

All upload routes need a signed-in member (`cfs_` session or cookie; agents never upload). Part,
complete, status and abort answer `404` to anyone but the uploader.

| Route | Who | Body → response |
|---|---|---|
| `POST /api/orgs/:org/projects/:pid/folders/:mount/uploads` | Owner, or developer with write on the folder | `{ path, size, mime }` → `201 { uploadId, partSize, parts, expiresAt }`. `path` is normalized, relative, at most 1,024 characters and never under `.git` (`400 invalid_path`); `size` is 0 to 5,000,000,000 bytes (`400 invalid_size`, `413 file_too_large`, also when it needs more than 10,000 parts). `partSize` is `COMMONFORGE_UPLOAD_PART_BYTES` (default 52,428,800): every part except the last is exactly that long. An empty file (`size: 0`) has `parts: 0`: no part is sent, and it is completed with `parts: []`. `expiresAt` is 24 h after the start. |
| `PUT /api/orgs/:org/uploads/:uploadId/parts/:n` | The uploader | Raw bytes, `content-length` required → `200 { etag }`. Part numbers run 1..`parts`. `409 upload_finished`, `400 invalid_part`, `411 length_required`, `413 part_too_large`, `400 part_size_mismatch` (wrong length, or a body shorter or longer than `content-length`). A part can be sent again. |
| `POST /api/orgs/:org/uploads/:uploadId/complete` | The uploader | `{ parts: [{ n, etag }] }`, all parts in order (`[]` for an empty file, which writes the empty object) → `200 { stagingId, size }` and queues the hash step. `400 parts_mismatch`, `400 upload_incomplete` (an unknown etag or an undersized part: send the missing parts and complete again; the upload stays open), `400 size_mismatch` (the assembled object has another size than `size`: the upload is deleted). Completing again after a lost response answers `200` again. |
| `GET /api/orgs/:org/uploads/:uploadId` | The uploader | `{ stagingId, state: "uploading"\|"uploaded"\|"verified"\|"rejected", size, sha256, path, error? }`. `sha256` is set once `verified`. `error` on `rejected`: `size_mismatch`, `hash_mismatch`, `missing`, `object_changed` (written again after it was verified), `hash_failed: …` (including `hash_failed: gave up after 3 retries`, see GC below). |
| `DELETE /api/orgs/:org/uploads/:uploadId` | The uploader | `204`. Aborts an unfinished upload and removes its row; a finished upload is left to expire. |

`uploadId` is the `stagingId` to name in a change. Unfinished uploads are aborted after 24 h.

### The LFS server

`/api/lfs/:org/:rid/info/lfs/…` implements the Git LFS batch API with the `basic` transfer adapter
for the git folder `:rid` (the resource id). Point git-lfs at it with
`lfs.url = <COMMONFORGE_PUBLIC_URL>/api/lfs/<org>/<rid>/info/lfs`. Folders added with
`POST …/folders` carry it in their `.lfsconfig` (and LFS patterns for media, archives, fonts, PDF
and Office files in `.gitattributes`), so a plain clone uses it. Folders made before phase 4 have no
`.lfsconfig`: a plain `git clone` of one does not know the LFS URL (set `lfs.url` yourself). The URL
in `.lfsconfig` is `COMMONFORGE_PUBLIC_URL` at the time the folder was added.

**Credentials.** HTTP Basic with any user name and a session (`cfs_`) or task lease (`cfl_`) token as
password, or `Authorization: Bearer <token>`.

**`cforge checkout` wires it.** The materialization plan gives each git mount its `lfsUrl`. For a
mount whose `lfsUrl` is on the checkout's API origin (https, or http on localhost / 127.0.0.1),
`cforge checkout` records it in the checkout record and sets, in the mount's local git config,
`lfs.url = <lfsUrl>` (from the plan, so folders without `.lfsconfig`, or with a stale one, work too),
`lfs.fetchexclude = *`, and the credential helper scoped to the LFS URL
(`credential.<lfsUrl>.helper` reset, then `cforge credential-helper --record …`, and
`credential.<lfsUrl>.useHttpPath = true`). The clone runs with `GIT_LFS_SKIP_SMUDGE=1`, so LFS files
stay pointers and a checkout never downloads LFS objects (`git -c lfs.fetchexclude= lfs pull` fetches them on
demand). When git-lfs asks for the LFS URL (protocol and host of the API, path equal to the
endpoint's or under it, e.g. `…/info/lfs/objects/batch`), the helper answers `username=x-token`,
the task lease token as password and `password_expiry_utc` from the stored lease, without calling
the broker; anything else it refuses (`quit=1`). Nothing is written to disk. So an agent's
`git push` of a large file uploads its LFS objects with the lease, into the task's staging area. An
`lfsUrl` on another origin is not configured at all (`cforge checkout` warns on stderr).
Responses are `application/vnd.git-lfs+json`, `cache-control: no-store`; errors are
`{ "message": … }`. A `401` carries `LFS-Authenticate: Basic realm="CommonForge"` (and no
`WWW-Authenticate`, so browsers do not prompt for or cache credentials). A folder the caller cannot
read, or that is not a git folder, answers `404`.

**Who.**
- Owners and developers with write on the folder may upload, `verify` and `locks/verify` (all three
  answer `403` without write). Any owner or developer who can read the folder may also download
  objects that are not accepted yet ("staged").
- Clients and viewers read accepted objects only, and never see staged ones.
- An agent works with its task lease: it reads in any workspace state but `abandoned`, writes only
  in a `writable` write workspace of this folder, and downloads accepted objects plus its own
  task's unaccepted ones.

| Route | Body → response |
|---|---|
| `POST …/objects/batch` | `{ operation: "upload"\|"download", objects: [{ oid, size }], hash_algo?: "sha256" }` → `200 { transfer: "basic", hash_algo: "sha256", objects }`. A body that is not JSON: `400`; JSON that is not a valid batch request (not an object, unknown `operation`, `objects` not a list): `422`; `hash_algo` other than `sha256`: `422`; more than 100 objects: `413`. **upload**: `403` without write; `503` while the R2 credential secrets are unset. Each object is `{ oid, size }` when that exact object is accepted already, `{ …, error: { code: 422 } }` for a bad oid or a size over 5,000,000,000 bytes, otherwise `actions.upload` and `actions.verify`. `actions.upload` is a presigned PUT for one key and one method, `expires_in` clamp(ceil(size/2e6), 900, 3600) seconds, that **only creates**: it signs `If-None-Match: *` (`X-Amz-SignedHeaders=host;if-none-match`) and carries `header: { "If-None-Match": "*" }`, which git-lfs sends; a PUT to a key that already holds an object is refused by R2. A retried batch reuses the caller's pending upload of that oid unless its key already holds bytes (a push interrupted between PUT and verify), in which case a fresh key is offered. **download**: `actions.download` for a servable object, `error.code 404` for the others. |
| `POST …/verify` | `{ oid, size }` → `200 {}`. Checks the object is in R2 with that size and queues the hash step. `404` when nothing of the caller's is pending, `422` for a missing object or a size mismatch. A retry after success answers `200`. |
| `GET …/objects/:oid` | Streams the object (`application/octet-stream`, `content-disposition: attachment`, `x-content-type-options: nosniff`, `cache-control: private, no-store`), read pinned to the etag the hash step recorded. `404` for an object the caller may not read, and for one whose bytes were written again after verification (the object is then `rejected` `object_changed`, accepted or not; nothing is deleted at that moment). |
| `POST …/locks/verify` | → `200 { ours: [], theirs: [] }`; git-lfs calls it before every push. `403` without write. |
| `* …/locks`, `* …/locks/*` | `404` "file locking is not supported". |

A pushed object is verified by its hash step: its sha256 must equal the `oid`, otherwise it is
`rejected` (`hash_mismatch`) and never served.

### File changes

Owners, and developers with write on the folder (a git folder or a file collection).

| Route | Who | Body → response |
|---|---|---|
| `POST /api/orgs/:org/projects/:pid/folders/:mount/changes` | Owner, or developer with write on the folder | `{ ops: Op[], title?, idempotencyKey? }` → `202 FileChange` (state `applying`) |
| `GET /api/orgs/:org/file-changes/:changeId` | The author; owners and developers who can read the folder | `FileChange`. Anyone else: `404 change not found`. |
| `GET /api/orgs/:org/projects/:pid/file-changes?mount=&limit=` | Owners and developers who can read the project | `{ changes: FileChange[] }`, newest first. Every **open** change (`applying`, `checking`, `waiting_approval`, `staged`) on the folders the caller can read is always listed, whatever its age and the limit (up to 100); **terminal** changes (`added`, `failed`) that ended in the last 24 hours fill the rest of `limit` (1 to 50, default 20; `400 invalid_request` otherwise): anyone's for owners, only the caller's own for developers. `mount=` narrows the list to one folder (`404` for a folder the caller cannot read). Up to 10 open changes per request get the read-time recovery (below); the rest are shown as stored. Clients and viewers: `403 insufficient_role`. |

`Op` is one of (exact keys; paths as for uploads):
- `{ put: path, stagingId }`: put a verified upload of yours to this folder at `path`. The same upload may be put at several paths.
- `{ edit: path, content, baseBlob }`: replace a small text file (valid UTF-8 text without NUL, at most 1 MiB, under the LFS threshold) with `content`. `baseBlob` is the 40-hex git blob id of the version being edited, from the `x-commonforge-blob` header of `GET …/file` (below), or `''` for a new file. A file stored in LFS is never edited in place. Git folders only: a file collection answers `400 edit_unsupported` (upload the new version instead).
- `{ delete: path }`: delete a file, or everything under a folder path. In a git folder, deleting what is not there is a no-op; in a file collection it fails the change `file_missing`.
- `{ move: path, to }`: move a file or folder. In a file collection, a missing source fails `file_missing` (unless the destination already exists: a re-applied move counts as done), and a destination file with other bytes, a path below a file, or a move into itself fails `path_exists`.

Rules:
- 1 to 1,000 operations (`413 too_many_operations`), 20 GB of puts per change (`413 change_too_large`; counted per put operation), 5 GB per file.
- Edits: at most 1 MiB each (`413 edit_too_large`) and 16 MiB together (`413 edits_too_large`). Edit contents are kept in R2 beside the change; the resolved operations also travel to the runner as an R2 manifest.
- `ops` are checked as a whole: `400 invalid_request`, `400 invalid_path`, `400 invalid_upload` (an upload that is not yours, is for another folder, was made by an agent, is unfinished, was rejected or was added already).
- `403 no_write_grant`, `403 insufficient_role`, `400 edit_unsupported` (an edit on a file collection), `404` for a folder you cannot read.
- `title` defaults to "Uploaded 30 files to videos/2026", "Edited config.json" or "Changed 3 files".
- `idempotencyKey` (optional; 1 to 128 characters of `A-Z a-z 0-9 _ -`, else `400 invalid_request`): send one key per change you mean to make, and the same key when you retry it (a lost reply, a `5xx`). A repeat with a key you used before answers that change, `202 FileChange` as `GET /file-changes/:id` shows it now, and makes nothing new, as long as it names the same folder and the same operations (the title is not compared); it is answered before the uploads are checked, so it works after the change was added too. The same key with another folder or other operations is `409 idempotency_key_reused`. Keys are per user: another person's key never matches yours.

`FileChange` is `{ changeId, projectId, mountName, title, state, attempt, proposalId, taskId, error?: { code, message }, note?: "no_changes", changedPaths?, createdAt, updatedAt }`. `taskId` is the current attempt's task once it was applied (null before): in a staging-mode project, the task to promote. `changedPaths` is the runner's list of `{ path, change: "added"|"modified"|"deleted", lfs: boolean, class: "content"|"code" }` once the change was applied (at most 5,000 entries: a change that would touch more fails `limit_exceeded`). For a file collection the Worker builds the same list from the old and new manifests (every path `content`, `lfs: false`).

**States.**

| State | Meaning |
|---|---|
| `applying` | Waiting for the uploads' hash step, then the runner applies the operations; the candidate is frozen and the proposal opened and prepared. `attempt` starts at 1. |
| `checking` | The proposal is being integrated (checks only when a changed path is code), then the Worker records the uploader's approval and accepts. |
| `waiting_approval` | Integrated, but the uploader's role is not in the project policy's `approvalRoles` (owners when it sets none). Someone who may approve opens `proposalId` and approves and accepts it; the change becomes `added`. |
| `staged` | Staging-mode projects only (git folders): the change is on staging and waits for a promotion. It has no proposal of its own (`proposalId: null`). It becomes `added` when a promotion accepts its task's landing into `main`, `failed` when that landing fails or is rolled back. |
| `added` | Accepted: the folder has a new head. With `note: "no_changes"` the operations changed nothing and no proposal was made. |
| `failed` | `error: { code, message }`. Final. Nothing was added: the change's proposal is withdrawn and, in a staging-mode project, its staging landing is rolled back. |

**Staging-mode projects.** A change to a git folder goes through promotion like an agent task: once its
candidate is frozen, its task lands in staging (a landing like any task's, titled with the change's title),
its candidate is prepared and the change is `staged`. It is not integrated, approved or accepted by itself;
the project's checks and the uploader's approval do not apply to it (the promotion's build, gate and
clearance do). Promote its task (`POST /api/tasks/:taskId/promote`; the task id is the landing's in
`GET …/staging`) to bring it to `main` and production: at the promotion's accept the change is `added` and
the LFS objects its receipt named are accepted. A withdrawn, sent-back or superseded promotion leaves it
`staged`; its landing failing makes it `failed` `staging_failed` (the message includes the landing's
reason), a rollback `staging_rolled_back`, a candidate that could not be prepared `prepare_failed` (its
landing is rolled back), and a change whose task never got a landing (6 hours after its candidate was
frozen) `staging_land_failed`. If staging drops the landing after its promotion's accept committed, the
change is failed `staging_failed` first and then `added` by the accept (its uploads are kept meanwhile). A staged change is never applied again on a moved head (its
promotion rebuilds on the new `main`), and its uploads never expire while it is staged. A change that had
already opened its own proposal when staging mode applied finishes on the old path. File collections are
not staged (as before, they land on their own).

**Stale base.** When another change was accepted first, uploads, deletes and moves are applied again
on the new head (`attempt` + 1, the old proposal is closed as superseded), up to 3 attempts, then
`stale_base`. A change with an edit fails `file_changed` instead (the file may have changed: open it again).
When the accept is refused because the project's **policy changed** (`policy_revision_stale`), every
change is applied again under the new policy, edits included (no file changed; each edit's
`baseBlob` still guards it), counting toward the same 3 attempts.

**Failure codes** (`error.code`; the change's `error.message` says more):
- Upload and request: `invalid_upload` (an upload vanished); an upload rejected after the change named it fails with the upload's own reason: `hash_mismatch` (its bytes do not hash to the oid git-lfs claimed), `size_mismatch`, `upload_missing` (its bytes are gone from R2), `object_changed` (written again after verification) or `hash_failed` (it could not be hashed); `file_changed` (an edit's `baseBlob` no longer matches, or the base moved), `stale_base` (three attempts), `path_conflict` (a file below a file, or over a folder), `path_not_found`, `limit_exceeded` (also for a path whose `.gitattributes` entry would be too long, an edit of a file stored in LFS, or more than 5,000 changed paths).
- File collections: `file_missing` (a delete or move of a path that is not there), `path_exists` (a move onto another file, below a file or into itself; a put below a file or over a folder), `object_missing` (an object of the collection's current version is gone from storage), `manifest_missing` (the collection's accepted manifest is gone), `limit_exceeded` (more than 5,000 changed paths, or paths too long to record together), `hash_mismatch` (an upload's stored bytes changed after they were verified, found while copying it).
- Folder: `folder_missing`, `no_accepted_head`, `uploader_missing`, `no_write_grant` (the uploader lost write before landing).
- Runner and receipt: `scope_violation`, `receipt_mismatch`, `provider_unavailable`, `freeze_failed`, `job_expired`.
- Landing: `check_failed` (a policy check failed or was unmet), `proposal_closed` (someone rejected or withdrew the proposal), or the integration's or ledger's own code.
- Staging (staged changes): `staging_failed`, `staging_rolled_back`, `staging_land_failed`.

### File collections

A change to a file collection is applied by the Worker in two queue steps (`files.apply` hands it
over):
1. **Copy.** `files.assets.copy` copies one verified upload into the collection's content key
   `org/<org>/res/<rid>/obj/<sha256>`, pinned to the etag the hash step recorded and hashed again
   while it is piped (a changed source fails the change `hash_mismatch`). One step per upload, so a
   20 GB change never has to fit in one step; a copy that is already there is not redone, and one
   upload is copied by one step at a time (a copy lock, leased 15 minutes).
2. **Manifest.** `files.assets.manifest` waits until every upload is verified and copied (each
   finished copy wakes it), creates the attempt's task with an R2 workspace on the collection's
   accepted manifest (`r2m:<id>`), applies the operations in order to that manifest, writes the new
   manifest, freezes the workspace and opens the proposal. The change then goes on to `files.land`
   and `files.accept` as a git change does, with no checks. Before the proposal it checks the copies
   once more while holding the asset GC's lock, so a GC run that listed an old, unreferenced copy
   cannot delete it under the new manifest (a swept copy is made again).

Operations that change nothing (the collection already holds those files) end `added` with
`note: "no_changes"`: no proposal is made and the uploads are deleted. Stale base works as for git
folders (file collections have no edits, so they always re-apply).

### The `x-commonforge-blob` header

`GET /api/orgs/:org/projects/:pid/file?mount=&path=&revision=` on a **git** folder also sends
`x-commonforge-blob`: the file's git blob id (40 hex, SHA-1 of `blob <size>\0<bytes>`). An editor
sends it back as `baseBlob`. Files stored in LFS send `x-commonforge-lfs` instead and are not
editable. File collections send `x-commonforge-sha256` instead.

### Settings and secrets

| Name | Kind | Meaning |
|---|---|---|
| `COMMONFORGE_ASSETS_BUCKET` | var | Name of the bucket behind the `COMMONFORGE_ASSETS` binding; presigned URLs address it through R2's S3 API. |
| `COMMONFORGE_R2_ACCESS_KEY_ID`, `COMMONFORGE_R2_SECRET_ACCESS_KEY` | secrets, optional | An R2 API token (Object Read & Write on that bucket) that signs git-lfs upload URLs. While either is unset, git-lfs uploads answer `503`; browser uploads, changes and downloads work. |
| `COMMONFORGE_LFS_THRESHOLD_BYTES` | var, default 1048576 | Text files above this size, and every binary file, are stored in LFS. Edits must be under it. |
| `COMMONFORGE_STAGING_TTL_DAYS` | var, default 7 | Unaccepted LFS objects (verified, rejected or never used) are deleted this many days after their last use, unless an open change or a live task needs them. Accepted objects are never deleted by GC. |
| `COMMONFORGE_UPLOAD_PART_BYTES` | var, default 52428800 | Browser upload part size; values under 5242880 are ignored (R2's minimum). |

GC (every 10 minutes, as the last phase of each organization's pass) also aborts unfinished uploads
after 24 h, enqueues the hash step again for uploads left `uploaded` for 15 minutes (a lost step; at
most 3 times, then the upload is rejected `hash_failed: gave up after 3 retries` and the changes
waiting for it fail `hash_failed`), deletes the R2 artifacts of finished changes (operation
manifests, edit contents) after the staging TTL, settles open changes nobody reads (see below),
and gives verified objects hashed before migration 0013 their pointer blob id (from the recorded
sha256 and size, nothing is read; the log line's `lfsPointerBackfill`), which the tree and file
routes need to recognise their pointers. Each kind handles at most 100 rows per organization per
pass (50 for the settle sweep, 500 for the pointer backfill). Before that phase, a new folder's setup
still pending after 15 minutes with no running job is queued again (the log line's
`folderInitRequeued`; each job it leads to counts toward the setup's 3 attempts).

### Runners keep pointers

Repositories hold LFS **pointer files** for large and binary files; the bytes are in R2. Runners
never download LFS objects: `apply-files` writes the pointer from the sha256 and size the hash step
recorded, and fetches only small text files. Checks, integrations and task workspaces therefore see
pointers; a person or agent that needs the bytes runs `git lfs pull` against the LFS server above
(in a `cforge checkout` mount, `git -c lfs.fetchexclude= lfs pull`, since checkout sets `lfs.fetchexclude = *`).
Every pointer the runner writes gets a `.gitattributes` entry in the same commit, so it is never
committed untracked.

**Recovery.** A change that has not moved for 2 minutes is looked at again whenever it is read (and
by GC): a lost queue step is enqueued again, an expired runner job fails the change `job_expired`,
an accepted proposal finishes landing, and a `waiting_approval` change whose base moved re-applies.

## Runner endpoints (Task 14 contract)

These match the runner's `apps/runner/src/worker-client.ts` and `blob-store.ts` (Task 14).

**Job kinds.** `seed-workspace`, `prepare-candidate`, `integrate`, `reconcile-ref`, `build-edition`, `edition-return`, `apply-files`, `inventory`, `export`, `preview-build`, `release-build`, `release-deploy`. `apply-files` (put / edit / delete / move on a folder's accepted head, one commit to a fresh `-tasks` repository) carries its operations as an R2 manifest, `opsManifest { r2Key, sha256, count }`, never inline.

**Delivery.** The runner gets jobs in one of two ways:
- consuming `{ signedJob }` messages (`RunnerJobDelivery`) from `commonforge-runner-jobs`;
- polling `/api/runner/jobs/next`.

The delivery never carries the evidence key. The runner fetches it from `/evidence-key`, so no
secret ever sits in a queue.

**Authentication.** The `SignedJob` itself is the credential. The Worker verifies it with the job
key **on every call**; the runner never holds that key. It must also be a job this Worker issued
(`job_unknown`) and, where noted, still open (`job_finished`).

| Route | Body → response |
|---|---|
| `POST /api/runner/credential` (= `job.credentialBroker`) | `RunnerCredentialRequest { signedJob, repo: RepoCoords, access }` → `RunnerCredentialResponse { token, tokenId, expiresAt, remoteUrl }` (`no-store`). Details below. |
| `POST /api/runner/credential/revoke` (`<credentialBroker>/revoke`) | `{ signedJob, tokenId }` → `{ ok: true }`. Only tokens minted for that job (`404` otherwise). Allowed after expiry. |
| `POST /api/runner/results` | `{ signedJob, result: RunnerResult }` → `201 { jobId, replayed: false, status }`. Details below. |
| `POST /api/runner/evidence-key` | `{ signedJob }` (integrate jobs, while open) → `EvidenceKeyWire`, the per-job derived key for `signEvidence` (`no-store`) |
| `POST /api/runner/heads` | `{ signedJob }` → `{ heads: { [resourceId]: RevisionId \| null } }`, the current ledger heads of the resources the job names. Informational: the ledger decides at accept. |
| `POST /api/runner/jobs/next` | `Authorization: Bearer <COMMONFORGE_RUNNER_TOKEN>`, `{ runnerId }` → `200 { signedJob }` or `204`. Details below. |
| `GET\|PUT /api/runner/blobs/<encodeURIComponent(key)>` | Header `x-commonforge-signed-job: <base64url JSON SignedJob>`. Details below. |

**Credential requests** (`/api/runner/credential`):
- The broker verifies the job and requires it to be open.
- `authorizeCredentialRequest` decides whether the job may have the repo. Canonical **write** is
  allowed only for `prepare-candidate`, `integrate` and `reconcile-ref`. `apply-files` reads
  canonical and writes only a fresh `-tasks` fork (like `edition-return`).
- The repo must sit in the job's org namespace, and its id and remote URL must equal the live
  server record (`identity_mismatch`).
- The TTL is at most `expiresAt` and at most 1 h (`409 job_expiring` under 60 s).
- The minted token id is recorded and revoked when the result arrives.

**Results** (`/api/runner/results`):
- The result must parse for the job's kind.
- Integrate evidence, and any failure evidence, must verify with the per-job derived key
  (`403 evidence_invalid`).
- A result is accepted until 15 min after `expiresAt`.
- The same result again gets `200 { replayed: true }`. A different result gets
  `409 result_conflict`; the runner treats 409 as "already applied".

**Pull mode** (`/api/runner/jobs/next`):
- The endpoint claims the oldest open, unexpired job. A claim older than 10 min can be re-claimed.
- When `COMMONFORGE_RUNNER_TOKEN` is unset the endpoint answers `503 runner_poll_disabled`.

**Blobs** (`/api/runner/blobs/<key>`):
- GET is allowed only for `inventory` and `edition-return` (`job.upload.r2Key`), and `export`
  (keys under `job.sink.r2Prefix`, which must be `org/<org>/exports/…`).
- GET is also allowed for `release-deploy` (keys under `org/<org>/releases/<releaseId>/`).
- GET is allowed for `apply-files`: the job's operations manifest (`job.opsManifest.r2Key`, under `org/<org>/file-changes/<changeId>/`) and the small text files its change puts (under `org/<org>/lfs/<resourceId>/obj/`). LFS objects are never readable by a runner.
- PUT is allowed only for `export` (keys under the sink prefix), `preview-build`
  (`org/<org>/previews/<previewId>/site/…` and `…/bundles/…`; never `meta.json`, which only the
  Worker writes) and `release-build` (`org/<org>/releases/<releaseId>/…`).
- PUT verifies `x-commonforge-sha256` when it is given.
- Any other key gets `403 scope_violation`.

**Runner contract notes:**
- `integrate.baseSnapshot` is the real base snapshot. Evidence must use
  `snapshotId = job.candidateSnapshotId`; the ledger checks it against
  `proposal.candidateSnapshotId`.
- Results are parsed with `parseRunnerResultForJob(signedJob, result)`, so a receipt for another
  job, proposal, ref or sha is refused with `400 invalid_result`.
- The integration ref is `refs/commonforge/integrations/<proposalId>/<jobId>`, one push per ref,
  with `--force-with-lease` (no `--atomic`).
- `seed-workspace` must push exactly `<baseSha>:<ref>` with a must-not-exist lease
  (see runner-protocol's README).

## Queue steps (`commonforge-steps`)

| Message | Work |
|---|---|
| `{ type: "workspace.create", orgId, taskWorkspaceId }` | `createIsolatedChange` (create the `-tasks` repo, seed it with a runner job), then record the workspace in the ledger. Serialized per workspace id. |
| `{ type: "intake.import", orgId, intakeId }` | Public URL import, 504→depth retry, token revoke, genesis `bindHead`. |
| `{ type: "candidate.prepare", orgId, candidateId }` | Runner `prepare-candidate`, `recordPreparedReceipt`, attach the receipt to open proposals. |
| `{ type: "edition.build", orgId, buildId }` | Create/adopt the edition repo, issue `build-edition`. |
| `{ type: "edition.return", orgId, returnId }` | Create the return's empty `-tasks` repo, record the workspace, issue `edition-return`. |
| `{ type: "edition.candidate", orgId, returnId }` | Freeze the returned candidate, open the proposal, queue `candidate.prepare`. |
| `{ type: "lfs.hash", orgId, stagingId }` | Hash a completed upload from R2: sha256, size, binary and the etag of the hashed bytes; `verified` or `rejected`; wakes the file changes waiting for it. GC enqueues it again for an upload left `uploaded` 15 minutes (at most 3 times). |
| `{ type: "files.apply", orgId, changeId }` | Wait for the change's uploads, create the attempt's task and workspace, store the operations manifest, issue `apply-files`. A file collection's change is handed to `files.assets.manifest` instead. |
| `{ type: "files.assets.copy", orgId, changeId, stagingId }` | File collections: copy one verified upload into its content key (`adoptVerified`, under a per-upload lock), then wake `files.assets.manifest`. Changed bytes fail the change `hash_mismatch`. |
| `{ type: "files.assets.manifest", orgId, changeId, copied? }` | File collections: once every upload is verified and copied (enqueues the missing copies otherwise), create the task and R2 workspace, write the new manifest, freeze, open the proposal, queue `files.land`. Waits (retry) while an asset GC run holds its lock. |
| `{ type: "files.candidate", orgId, changeId }` | Freeze the applied candidate, open the proposal, queue `candidate.prepare`. |
| `{ type: "files.land", orgId, changeId }` | Once prepared, issue the integration (checks only when a changed path is code) and move the change to `checking`. |
| `{ type: "files.accept", orgId, changeId, integrationOk, code?, detail? }` | After the integration: record the uploader's approval when their role counts, accept, promote LFS objects (a file collection's change deletes its staged uploads instead), or `waiting_approval` / `failed`. |

- Steps are idempotent.
- When the runner has not answered within 90 s (`deps.runnerWait`), the step is retried. The
  retry joins the same open runner job, matched by a hash of the job body.
- After 10 attempts the step's record is marked failed.

## Outbox, wakeups and GC (Task 17)

**Canonical-ref projection.** The ledger head is the authority; `refs/heads/<branch>` of the
canonical repo is a projection (plan §A.5 rule 2). Every accept and restore commits a `reconcile-ref`
outbox event and leaves the head `reconciliation: "pending"`. `GET …/resources/:rid` shows it.

**Outbox consumer** (`commonforge-outbox`, `services/outbox-consumer.ts`):
- Each event is applied **once per `(organizationId, dedupeKey)`**. The dedupe row lives in the
  org's ledger (`consumed_events`). For `reconcile-ref` it is written in the same DO transaction as
  the reconciliation state (`OrgLedger.recordReconciliation`); `projection-refresh` and
  `candidate-superseded` write their idempotent effect first, then `consumeEvent`. Redeliveries are
  acked without touching the provider.
- `reconcile-ref`: if the event's target is no longer the head it is consumed as `superseded` (the
  newer head has its own event). Asset (`r2m:`) heads are `synced` at once. Otherwise the consumer
  reads the resource's **recorded** branch (already at the head → `synced`, no job) and then:
  - **Lease rule (review I-1).** It pushes only with a lease on a sha it vouches for: the event's
    previous head (`expectedCurrent`), the sha last recorded as synced (ledger `ref_state`), or a
    foreign sha already recorded as `diverged` while this head was current. Any other branch value
    is first recorded as `diverged` (observation) and the message retried; the next attempt may
    then lease on it and move the ref to the ledger head.
  - It re-reads the head after reading the branch and before submitting (moved → `superseded`, no
    push), runs `reconcileAccepted(…, {branch, expectedCurrentSha})`, and re-reads the head after
    the job. If the head moved meanwhile, the current head is set back to `pending` and gets its own
    reconcile request leasing on the sha just pushed. So an older job never leaves a newer head
    wrongly `synced`.
  - **Open-job gate (re-review N-1).** A lease is a sha, and a restore can make an old lease sha
    the branch value again. So nothing is settled without a push while an older `reconcile-ref` job
    for the resource is still open (`queued`, not past `expiresAt` + 15 min): the branch-already-at-
    head path, every superseded exit (and its `verifySyncedHead`) and the `pushed` wakeup's
    `synced` all wait (message retried, head left `pending`) until that job resolved or expired.
    After expiry the broker mints no token for it, so it can no longer push. If the waiting message
    is dead-lettered meanwhile, the head is still `pending` and the GC backstop re-requests it.
  - Retries join the same open job (the job key is salted with the dedupeKey, so a finished job is
    never reused for a later event).
  - `synced` → recorded and consumed;
  - `diverged` (the lease failed: someone else holds the ref) → recorded, message retried;
  - a failed push with the ref unmoved (`provider_unavailable`), runner still working, ops gate busy
    → retried, the head stays `pending` (never `diverged`);
  - permanent provider errors (canonical repo gone or recreated) → `diverged`, consumed.
  Every state change is audited as `head.reconciliation_changed` (actor `service:org-ledger`).
- `projection-refresh` refreshes the D1 projection; `candidate-superseded` marks a still frozen or
  prepared candidate `superseded`. Malformed messages are dropped.
- After 10 deliveries a message moves to **`commonforge-outbox-dlq`**; its consumer records an
  `outbox.dead_lettered` event. The head stays `pending` and the GC backstop below re-requests it.

**D1 projection** `resource_heads (org_id, resource_id, revision_id, version_seq,
accepted_version_id, accepted_at, reconciliation, refreshed_at)`: refreshed by the consumer and by
every GC run (never moves backwards in `version_seq`). List views may read it; the ledger stays the
authority.

**Artifacts `pushed` wakeups** (`commonforge-artifacts-events`, `services/artifact-events.ts`; spike
A6): wakeups only, never authority. Deduped by (repo, ref, before, after) in the org ledger (with
`before`, a later move back to an already seen sha is a new wakeup). Only the
canonical repo's recorded branch counts; task repos, retention/integration refs and other
environments are ignored. The consumer **reads the branch itself** (the event's `after` is never
trusted): at the head's sha → `synced`; head still `pending` → nothing; otherwise → `diverged` plus a
`reconcile-ref` request on the outbox queue. `repo.forked` / `repo.imported` are never relied on.

**GC** (cron `*/10 * * * *`, `services/gc.ts`; plan §C.2 P0 shortcut). One run at a time: the run
holds the OpsGate lock `gc/sweep` (lease 14 min); a run that finds it held is skipped, and a run
starts no new org pass after 10 min (the rest waits for the next run), so asset passes never
overlap. The cron handler awaits the run. Phases, each idempotent and isolated per org:
1. Runner jobs past `expiresAt` + 15 min without a result are closed (`failed`, code
   `job_expired`; a late result gets `409 result_conflict`) and their minted tokens revoked.
2. `running` tasks with no live lease (expired **or released**) and no activity for **7 days**
   (`ABANDON_AFTER_SECONDS`, from max(lease expiry, last update)) are `canceled` (generation bumped).
   `ready` tasks are never canceled. Writable workspaces of `canceled`, `failed` or `submitted`
   tasks (reference copies included, N-4) are marked `abandoned` in D1 and the ledger, and every
   token on them is revoked.
3. Task repos are deleted with `collectWorkspace` (repo id checked; canonical never) after a 1 h
   grace when `abandoned`, or `frozen` with every candidate past `frozen` (prepared → retained in
   canonical; the ledger records `retained` → `collected`). The grace counts from the abandonment
   or the freeze (not the prepare), so a fork frozen long before its prepare finished goes on the
   first run after it. **Pushed but unfrozen work:** an abandoned written task repo whose branch
   moved past its seeded base is kept 7 more days (`UNFROZEN_WORK_GRACE_SECONDS`) so the work can
   still be recovered (clone it with an owner's help) before deletion. Workspaces stuck `provisioning` for 6 h
   are failed. For `failed` workspaces the recorded repo name is looked up and deleted on every run
   for 24 h, because a create that answered 500 can leave a ghost name that materializes later (A9).
   `task_workspaces.swept_at` marks a finished sweep; at most 200 deletions per org per run
   (confirming an absent repo is not counted). P0 scale note: every run loads the org's unswept
   workspaces (filtered by state in SQL).
4. Stale canonical write tokens are revoked (`revokeStaleCanonicalWriteTokens`).
5. The head projection is refreshed; heads not `synced` 10 min after acceptance get a fresh
   `reconcile-ref` request leasing on the previous head (backstop for dead letters and lost
   events): `pending` heads every run, `diverged` heads with exponential backoff (runs 1, 2, 4, 8, … after the
   divergence was observed).
6. Assets: the reachable manifest set is computed **after** the run start from every accepted
   version (current and previous heads), open/prepared proposals, asset workspaces of live tasks
   (not `failed`/`canceled`) and exports; then `R2AssetProvider.collectUnreachable` deletes
   unreachable objects older than 1 h. Just before deleting it re-lists manifests and spares any
   written during the run, with their objects (Task 13 re-review).

## Bindings and secrets

| Kind | Names |
|---|---|
| Bindings | `ORG_LEDGER`, `OPS_GATE` (DO, migration v2), `DB` (D1 `commonforge-dev`, `migrations/`), `COMMONFORGE_ASSETS` (R2), `EMAIL` (send_email), `OUTBOX`, `STEPS`, `RUNNER_JOBS` (queue producers), `ARTIFACTS` (unused by the API; see the transport note at the top) |
| Queue consumers | `commonforge-outbox` (max_batch_size 4, max_retries 10, DLQ `commonforge-outbox-dlq`), `commonforge-outbox-dlq`, `commonforge-steps`, `commonforge-artifacts-events` |
| Cron | `*/10 * * * *` (GC) |
| Vars | `COMMONFORGE_NAMESPACE_PREFIX`, `COMMONFORGE_APP_URL`, `COMMONFORGE_PUBLIC_URL` (broker URL inside jobs; **no default**: an https URL per environment, `http://localhost:8787` only in `.dev.vars`; jobs are refused with `503 config_missing` while unset), `COMMONFORGE_EMAIL_FROM`, `COMMONFORGE_EMAIL_MODE` |
| Folders with uploads | Var `COMMONFORGE_ASSETS_BUCKET`; optional secrets `COMMONFORGE_R2_ACCESS_KEY_ID`, `COMMONFORGE_R2_SECRET_ACCESS_KEY`; vars `COMMONFORGE_LFS_THRESHOLD_BYTES`, `COMMONFORGE_STAGING_TTL_DAYS`, `COMMONFORGE_UPLOAD_PART_BYTES` (see Folders with uploads) |
| Secrets | `COMMONFORGE_SESSION_SECRET` (session, magic-link and lease HMAC; also derives the asset token key), `COMMONFORGE_RUNNER_TOKEN` (optional; pull-mode runner bearer), `COMMONFORGE_RUNNER_JOB_KEY` (≥ 32 bytes; signs jobs, kid `k1`), `CF_ACCOUNT_ID`, `CF_API_TOKEN` (Artifacts REST), `COMMONFORGE_PREVIEW_KEY` (≥ 32 bytes; preview link tokens; same value on `commonforge-preview`), `COMMONFORGE_DEPLOY_API_TOKEN` (Workers Scripts: Edit; handed only to open `release-deploy` jobs) |
| Risk classifier (staging phase 3) | Optional secrets `JEV_API_KEY` (TypeSafe API key for provider `jev`), `OPENAI_API_KEY` (provider `openai-decisions`); optional var `COMMONFORGE_OPENAI_DECISIONS_MODEL` (default `gpt-6-luna`). Set with `wrangler secret put` and in `.dev.vars`; never in policy, logs, events or `gate_json`. A provider whose key is missing fails closed (`not_configured`: the promotion waits for a developer). |
| Task 22 vars | `COMMONFORGE_PREVIEW_URL` (the preview Worker's origin; must differ from the app/API origin, else `503 config_invalid`), `COMMONFORGE_DEPLOY_ACCOUNT_ID` (optional; default `CF_ACCOUNT_ID`) |
| Compatibility flags | `global_fetch_strictly_public` (the release health check fetches `<target>.workers.dev/version`; same-account workers.dev fetches otherwise fail with error 1042). Review m-6: the only control-plane fetch to a workers.dev host is the derived health URL of an org Worker (`cfapp-<org>-…`, never `commonforge-*`); intake URLs are fetched by Artifacts import, not by this Worker. |

## Threat-model mapping (plan §F)

| Threat | Where the Worker enforces it |
|---|---|
| Canonical mutation by an agent | Agents get tokens only for their task's `-tasks` repos (`issueWorkspaceCredential`): the writable copy, and read-only reference copies. They never get a canonical token, read or write. Canonical write exists only in runner jobs of the three allowed kinds (`authorizeCredentialRequest`). Tests: `tasks.test.ts`, `runner.test.ts`, `flow.test.ts`. |
| Stale acceptance | `OrgLedger.accept` rechecks heads, hash, approvals (current authorization), policy revision, receipts and evidence. Tests: `flow.test.ts` (stale accept, policy change, no approval). |
| Token leakage | Agent tokens are capped at min(1 h, lease). Tokens are revoked on freeze, on a new lease, on lease release, and when the holder is removed, demoted or loses a grant. Runner tokens are capped at job expiry and revoked when the result arrives. Lease and session tokens are stored hashed. Credentials are sent with `no-store`. |
| Client source disclosure (AT-25, AT-26) | Clients and viewers never receive canonical coordinates, raw revision ids (O-1), canonical credentials, tasks or materialization plans. The only token a client can get is a **read** token on its edition repo (`-editions`), which holds one fresh commit of allowlisted files (`build-edition`). There is no endpoint that mints for a canonical URL without a Worker-issued signed job. Tests: `authz-matrix.test.ts`, `tasks.test.ts`, `editions.test.ts`. |
| Cross-tenant and cross-resource (AT-16) | Every read resolves (org, project, mount) → resource and checks the resource grant. Non-members get 404. Namespaces and R2 keys carry the org id. Each org has its own ledger DO. |
| Malicious repository instructions (AT-18, AT-38) | Checks, contracts and approval roles come only from `PUT …/policy`, which is **owner-only**. A policy change makes open proposals `policy_revision_stale`. |
| Duplicate events / lost responses (AT-14) | Accept and restore idempotency keys. Runner results are applied once per `jobId`. Steps join open jobs. Outbox events are applied once per `(organizationId, dedupeKey)` (ledger `consumed_events`); `pushed` events are deduped by (repo, ref, after) and are wakeups only. Tests: `outbox.test.ts`. |
| Orphaned candidates/assets, partial failure (AT-12/13) | GC: task repos after `prepare-candidate` or abandonment plus 1 h; ghost names after failed creates; assets by ledger reachability with grace; the head shows `pending` until `reconcile-ref` lands. Tests: `gc.test.ts`, `outbox.test.ts`. |
| Rate limits (A9) | `OpsGate`: at most 25 concurrent create/token/delete/import operations per namespace, with jittered waits, then `503 provider_unavailable`. Create tokens and import tokens are never kept. |
| CSRF / session theft | Origin and `Sec-Fetch-Site` guard plus JSON-only bodies on bearer-less writes. The browser session lives only in an HttpOnly cookie; bearers come only from the explicit CLI login. |
| Email abuse | Per-address, per-IP and global magic-link limits (atomic, DO-held). |

## Known deviations (recorded)

- **Grants and memberships are authoritative in D1** (M-1). The ledger re-checks hashes, heads,
  receipts, evidence and policy revision inside its transaction, but not who holds a grant.
  Approvals are filtered by current D1 membership just before `accept`; a membership change in
  that window is not atomic with the accept. Acceptable for P0. A later option is to have the DO
  hold a membership revision that `accept` compares.
- **No "list/revoke all my sessions" endpoint yet.** Sessions last 30 days; logout revokes the
  current one.
- **The global magic-link cap (200/h) can be exhausted by a distributed sender.** Consider
  Turnstile before a public launch.
- **Self-approval is allowed.** The PRD lets one person hold every role; the records stay
  separate (approval ≠ acceptance). Agents can never approve.
- **The client snapshot view** filters entries but keeps the full `snapshotId` (an opaque hash).
- **Previews and releases (Task 22):**
  - All previews share one origin (`commonforge-preview.<sub>.workers.dev`, path per preview):
    storage (localStorage, IndexedDB) is shared between previews in the same browser. Service
    Workers are blocked (`worker-src 'none'`, `Service-Worker: script` refused,
    `Service-Worker-Allowed`/`Clear-Site-Data` stripped; review I-1) and cookies are blocked (the
    app's session cookie is `__Host-`; review I-2). Previews, demo targets and the app still share
    the registrable domain `<sub>.workers.dev` unless the deployment puts them on custom domains
    (`scripts/bootstrap.sh --app-domain/--preview-domain`).
  - Preview links carry their token in the path; `commonforge-preview` keeps observability on but
    invocation logs (which record URLs) off (review m-8). At most 3 previews of a project build at
    once (`409 preview_limit`); revoking a preview deletes its objects (review m-1, m-9).
  - The preview api runs as a Node "dev mode" host (`preview-host.js`), not workerd: a bundle that
    needs Workers-only runtime APIs would not run in preview.
  - In the Sandbox, `integrate` checks run without network. The runner installs dependencies
    beforehand, only from a committed `pnpm-lock.yaml` and without install scripts; a check that
    needs anything else from the network (or an install script's output) fails.
  - The `/version` health check is a single endpoint check (plan §C.1 row 11).
- **Editions (Task 21) limits:**
  - `sourceReleaseId` is the live release when the build was made (`null` before the first
    publish); builds always start from the accepted heads.
  - A return against a moved head is refused (`edition_stale`); there is no automatic
    reintegration of an old working copy yet. The client starts a new update after a rebuild.
  - A rebuild replaces the edition repo's single commit, so an older session's ZIP download (and
    its git `commit`) may become unavailable (`409 edition_unavailable`).
  - Edition repos and staged return ZIPs (`org/<org>/edition-returns/…`) are not swept by GC yet;
    a rebuild leaves the previous edition commit's objects stored (unreachable) in the edition repo.
- **Task 17 scope limits:**
  - `pushed` subscriptions are not created automatically (deploy step above); without them,
    divergence is found only when a reconcile runs (each accept/restore and the GC backstop).
  - The ledger does not emit `candidate-superseded` events yet (Task 8 follow-up). The consumer
    handles them, but other candidates on a resource are not marked `superseded` on accept; with the
    stale-base policy "refuse" they can never be accepted anyway.
  - The task view does not show a pending abandonment deadline yet (reviewer suggestion).
  - Staged intake ZIPs (`org/<org>/intake/…`) and old export bundles are not expired by GC.
  - One cron run walks every org sequentially (P0 scale); per-org sharding is a later change.
  - Tests run the module through `test/entry.ts`, which acks the messages miniflare delivers from
    its local queues (the deployed consumer would call the real Artifacts REST API); the consumers
    are exercised through `createWorker(deps)` with the in-memory doubles.

## Transient Artifacts failures (Task 23, review I2 / B6)

- The REST transport retries a `403` whose envelope code is `10004` ("Access denied" to a valid
  token, seen live for seconds at a time) twice (250 ms, 1 s) for every method, then throws
  `provider_unavailable`, which the API answers as `503`. Other 403s are not retried.
- `cforge credential-helper` retries `/credential` on 503 / `provider_unavailable` 3 times
  (1 s, 2 s, 4 s), so a short outage does not kill an agent's push.
- Queue steps treat a runner job that failed `provider_unavailable` (for example Artifacts
  answering git with "expected flush after ref listing") as transient and retry with a fresh job.

## Deploy prerequisites (M-13, M-14)

`scripts/bootstrap.sh` (Task 24) automates items 1–4, 6 and 7 for a named deployment (or `--production`)
and prints the manual Email Service steps (item 5); `scripts/teardown.sh` removes a named deployment.

1. **Queues:**
   ```
   wrangler queues create commonforge-steps
   wrangler queues create commonforge-runner-jobs
   wrangler queues create commonforge-outbox
   wrangler queues create commonforge-outbox-dlq
   wrangler queues create commonforge-artifacts-events
   ```
   **Artifacts event subscriptions** (optional; wakeups only, the GC backstop covers their absence):
   a repo-level `pushed` subscription per canonical repo, created through the REST API after the
   repo exists (`POST /accounts/:id/event_subscriptions/subscriptions` with
   `source: {type: "artifacts.repo", namespace, repo_name}`, destination the
   `commonforge-artifacts-events` queue; wrangler 4.147 cannot set namespace/repo). Not automated yet.
2. **D1:** `scripts/deploy-live.sh migrate` applies every migration in `migrations/` to the remote
   database. The committed `wrangler.jsonc` holds a placeholder `database_id`, so a plain
   `wrangler d1 migrations apply` fails; `scripts/deploy-live.sh` writes the real one
   (`COMMONFORGE_D1_DATABASE_ID` in `apps/worker/.dev.vars`) into a git-ignored
   `wrangler.deploy-live.jsonc` and runs
   `wrangler d1 migrations apply commonforge-dev --remote -c wrangler.deploy-live.jsonc`.
3. **Secrets:** `wrangler secret put` for each of the following.
   - `COMMONFORGE_SESSION_SECRET` and `COMMONFORGE_RUNNER_JOB_KEY`: random, ≥ 32 bytes.
   - `CF_ACCOUNT_ID`.
   - `CF_API_TOKEN`: a **dedicated** token with Artifacts:Edit only, not the broad dev token.
   - Optionally `COMMONFORGE_RUNNER_TOKEN`, for pull-mode runners.
4. **Vars:** set `COMMONFORGE_PUBLIC_URL` to the deployed Worker's https URL; it has no default.
   Set `COMMONFORGE_APP_URL` to the web app's origin. Keep `COMMONFORGE_EMAIL_MODE=send`.
5. **Email / DNS (owner):** onboarding a domain for Email Sending publishes a `_dmarc` record
   (for example `v=DMARC1; p=reject;`) at the apex, plus the `cf-bounce` MX, SPF and DKIM records.
   If that domain sends mail through any other provider (for example Google Workspace) without
   SPF/DKIM alignment, that mail is then rejected. Confirm, or relax the policy (for example to
   `p=none`) in DNS.
6. **Web app (served by this Worker):**
   - `wrangler.jsonc` `assets` serves `apps/web/dist` from the Worker's own origin:
     `run_worker_first: ["/api/*"]`, everything else is a static asset with SPA fallback
     (`/auth/verify`, `/auth/cli` and deep links load `index.html`). `@commonforge-org/web` is a
     devDependency of the worker so turbo builds the app first.
   - Set `COMMONFORGE_APP_URL` to **the Worker's own origin** (for example
     `https://commonforge-worker.<account>.workers.dev`): magic links point at it, and the CSRF
     guard and CORS both key on it. The `http://localhost:5173` default is for the Vite dev server,
     which proxies `/api` to `wrangler dev`.
   - `/auth/verify` POSTs the token on a user click; it is never consumed on page load.
7. **Previews and releases (Task 22):**
   - Build the web app first (`pnpm build` at the root; n-2), then deploy in this order:
     `commonforge-worker` (`wrangler deploy`), `commonforge-preview`
     (`wrangler deploy -c wrangler.preview.jsonc`) and `commonforge-runner`
     (`wrangler deploy -c wrangler.runner.jsonc --var COMMONFORGE_WORKER_URL:<worker url> --var COMMONFORGE_PREVIEW_URL:<preview url>`).
     The last two build the `apps/runner` image (Docker; `WRANGLER_DOCKER_BIN` may point at a
     `sudo -n docker` wrapper). `wrangler delete` leaves container applications: also run
     `wrangler containers delete`.
   - Secrets: `COMMONFORGE_PREVIEW_KEY` (random ≥ 32 bytes) on **both** `commonforge-worker` and
     `commonforge-preview`; `COMMONFORGE_DEPLOY_API_TOKEN` on `commonforge-worker` (a token with
     Workers Scripts: Edit on the deploy account, ideally dedicated).
   - Vars: `COMMONFORGE_PREVIEW_URL` on `commonforge-worker`.
   - Project policy (owner): `preview` and `release` recipes, e.g. installs with
     `pnpm install --frozen-lockfile --ignore-scripts` (the fixtures ship standalone lockfiles; review m-5), builds with step env `PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false`,
     the api bundle via `pnpm exec wrangler deploy --dry-run --outdir dist`, the preview site via
     `pnpm exec vite build --base ./` with `VITE_QUOTE_API_URL=./api`; production bindings (the demo
     `ORDERS` KV, created with `POST …/deploy-resources`) in `release.environment`; targets named
     `cfapp-<orgId>-<name>`.
   - Vars `COMMONFORGE_DEPLOY_WORKER_PREFIX` (same value on `commonforge-worker` and
     `commonforge-runner`; default `cfapp`) and optionally `COMMONFORGE_DEPLOY_ACCOUNT_ID`.
   - **Keep `COMMONFORGE_RUNNER_TOKEN` unset** on the deployed control plane (pull mode off). Even
     with it set, pull-mode runners never receive `release-deploy` jobs unless
     `COMMONFORGE_RUNNER_DEPLOY=1` (review m-4).
   - **Tokens (owner):** `CF_API_TOKEN` should be a dedicated token with *Account › Artifacts: Edit*;
     `COMMONFORGE_DEPLOY_API_TOKEN` a dedicated token with *Workers Scripts: Edit* and *Workers KV
     Storage: Edit* (it creates the org KV namespaces) on the deploy account. Install each with
     `cd apps/worker && pnpm exec wrangler secret put <NAME>`, then roll the broad dev token.

## Agent-native project protocol 1 (G1)

Existing projects retain legacy behavior. Owner/developer routes require access to every project
source; incomplete required context refuses without describing hidden dependencies. Records reside in
OrgLedger. D1 indexes do not authorize native acceptance.

- `GET /api/orgs/:org/projects/:pid/native` → `{protocolVersion:1,state:null|ProjectState}`.
- `POST …/native/enable {idempotencyKey}`: owner-only, permanent, settled legacy work and exclusive
  source membership required. Genesis source has no retroactive behavioral evidence.
- `POST …/native/commands`: strict `ProjectCommandSchema`, `expectedGeneration`, `idempotencyKey`.
  Knowledge/outcome/scenario drafts, confirmations, corrections, immutable `archiveScenario`, exact decisions, manual observations,
  and acceptance. Server checks current authority again inside acceptance. Public callers cannot
  provide runner provenance or create their own mandates/attempts.
- `GET …/native/{outcomes,knowledge,scenarios,proposals,decisions,evidence,manifests,observations,attempts}`
  supports `cursor` offset and `limit` ≤100, returning `{items,nextCursor,generation}`.
- `POST /api/tasks/:id/native/handoff {agentId}` issues a code (15-minute exchange window); only a
  person can issue it. Replacement revokes previous mandates for that task.
- `POST /api/tasks/:id/native/renew {mandateId,revision,expectedGeneration,idempotencyKey,agentId}`
  issues a human-authorized replacement with new attempt/context and fresh checkout required.
  Exact usable retries are idempotent; agents cannot renew themselves. See `docs/agent-native/renewal.md`.
- `POST /api/auth/task/verify {code}` consumes it once and returns a task lease, attempt, one-hour
  mandate and materialized context. It creates no user session.
- `GET /api/tasks/:id/native/context` returns pinned JSON/Markdown/digest plus current generation and
  a separate `knowledgeStale` flag. `GET …/native/results` exposes only the token's own attempt.
- `POST …/native/commands` permits scoped draft corrections and knowledge-only proposal submission. Source envelopes use
  `native/proposals`, which also verifies the inner artifact proposal belongs to this exact task.
- `POST …/native/submit {}` prepares the task's candidates and queues/joins actual artifact integration.
- `POST …/native/proposals {innerProposalId,expectedGeneration,idempotencyKey,outcome?}` freezes the
  outer source envelope after exact integration. All required scenarios come from confirmed state.
- `POST /api/orgs/:org/projects/:pid/native/proposals/:proposal/verify {idempotencyKey}` calls the
  configured signed supervisor (loopback only for a local control plane, or operator-pinned HTTPS). Requests/results use explicit protocol 1; unsupported
  runtime/verifier/set/signature/subject fails closed. Job budgets and result ingestion are durable.
  Candidate execution failures after established isolation may carry signed error evidence; preflight,
  transport or unavailable isolation records `execution:not-established` without behavioral evidence.
  Late valid superseded results remain job history and cannot satisfy current acceptance.
- `GET …/native/proposals/:proposal/verifications?cursor=0&limit=50` returns bounded durable
  owner/developer run history; task `native/results` filters it to that token’s own attempt.
  Replaying a terminal verification key returns the historical result without another dispatch.
- `PUT|GET|DELETE …/native/attachments/:sha256`: ≤1 MiB digest-checked project evidence bytes. DELETE
  refuses every referenced historical payload; tombstones serialize against evidence registration.
- `GET …/native/bundle?includePayloads=1` exports validated history and retained evidence bytes with
  explicit source/attachment completeness. `POST /api/orgs/:org/native/import
  {name,idempotencyKey,bundle}` creates fresh local authority, draft knowledge and an untrusted archive;
  it does not restore Git or authorize imported evidence. The portable `bundle` defaults to
  `cf.project-bundle/2` and includes exact inert ancestor bundles in `lineage`, retaining their digests
  and payloads across repeated imports. Responses advertise `bundleVersions: [1,2]`. Request
  `bundleVersion=1` for the original schema only when no imported lineage would be lost; unsupported
  versions and lossy version-1 exports refuse. The separate `importedHistory` field remains compatible.
  Both versions retain the original 16 MiB JSON and per-payload 8 MiB limits. Version 2 additionally
  bounds local and ancestor content to 8 MiB decoded payloads, 1,000 entries, 32 ancestors and eight
  lineage levels. Exceeding bounds refuses rather than truncating history.

Source acceptance invokes existing `planCommit` checks and writes artifact heads plus project manifest
in the same SQLite transaction. Native source locks also block legacy queue acceptance, restore and
head adoption. Fresh dedicated folders initialize atomically; existing source attachment/detach and
staging mutations are unsupported after enablement. Native release
preparation/publish/deploy require a manifest mapping and matching runtime; legacy-prepared releases
cannot bypass it. See `docs/agent-native/release-rehearsal.md` for runtime prerequisites and actual isolated live evidence.

Stable refusal codes include `revision_conflict`, `knowledge_stale`, `context_too_large`,
`context_forbidden`, `mandate_revoked`, `mandate_expired`, `mandate_scope_denied`,
`scenario_evidence_missing`, `scenario_evidence_invalid`, `review_subject_changed`,
`project_mode_unsupported`, `authority_denied`, `idempotency_conflict`, `unsupported_version`,
`recovery_unsupported` and `bundle_invalid`. Historical passes are immutable; applicability is computed.


Native onboarding: `POST /api/orgs/:org/projects {name,mode:"agent-native"}` creates empty native genesis
for an owner/developer. Web creation defaults to this mode; omitted API mode remains legacy for v1
clients. `POST …/folders` reserves a fresh source then initializes its first Git commit and manifest
atomically. No prior verification is invented. Permanent attachment reservations serialize legacy
sharing against native ownership; failed/former attachments can conservatively prevent conversion.
`POST …/native/authorities/:principal/reconcile {expectedGeneration,idempotencyKey}` lets an active
owner enroll/restore a current owner/developer with complete source access, using CAS/idempotency.
Authority revision advances; prior decisions/mandates stay invalid. Pending directory changes block
reconciliation; interrupted barriers require quiescent operator recovery (see local-workflow.md).


`POST …/native/recoveries {manifestHash,expectedGeneration,idempotencyKey}` prepares exact historical
source under current requirements with no fabricated task/inner proposal. Current complete write
access is required. Run fresh scenarios with the existing verification endpoint, record an exact
allowed-role decision, and accept via native commands. Artifact restore and manifest commit atomically;
current knowledge stays unchanged, canonical Git ref reconciliation is queued. Preparation/acceptance
refuse declared/data effects and current mandatory legacy checks/contracts the recovery adapter cannot
execute. Recovery is separate from deployment, and imported archives cannot authorize local recovery.
