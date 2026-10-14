# Admin screens: design

**Status:** approved in conversation on 2026-10-06; this document is the written record.
**Scope:** members and invites, access, new organization and new project, folders, project policy.
**Model:** single agency per deployment, ready for an agency layer later (§9).

## 1. Why

Everything an owner does to set up a client today (create an org, add people, give access, add
folders, set policy) is an API call or a script (`scripts/ci-live/project.ts`). The web app has no
screen for any of it. The Demo Client incident on 2026-10-06 shows the cost: a client was a member
with no project grant, so the project was invisible, and the fix needed hand-written API calls.

The worker already supports almost every operation (`apps/worker/API.md` "Roles and grants" and
"Projects, mounts, resources"). This work is mostly screens over that API, plus the few server
changes listed in §8.

## 2. Decisions

| Topic | Decision |
|---|---|
| Scope | All four parts in one spec, delivered in four phases (§10) |
| Tenancy | One agency per deployment; instance admins create orgs; agency layer later (§9) |
| Who creates orgs | Only instance admins (`COMMONFORGE_ADMIN_EMAILS`), enforced by the API |
| Developers | Keep today's rights: create projects and new folders; owners keep policy, detaching, attaching existing folders and write grants |
| Access model | Project-level access, with optional per-folder exceptions collapsed under each person |
| New folders | Automatically granted to everyone with access to the project, on the server |
| Invites | An invite email with a plain link to sign-in (no login token) |
| Layout | Admin lives next to what it changes: Members at org level, Settings inside a project |
| Policy editor | Forms for approvals, publishing, checks and rules; JSON for contracts, preview and release; forms for everything later |
| Private GitHub repos | Out of scope; next spec "Import v2" (§11) |

## 3. Screens and navigation

### Org level (`/o/:org`)

Sidebar: **Projects**, **Members**, and the org switcher at the bottom.

- **Projects** (existing page) gains **New project** (owners, developers).
- **Members** (`/o/:org/members`): each person's email, role and "member since". Owners also get
  **Invite**, a role control per person and **Remove**. Developers see a read-only list. Clients
  and viewers do not see the Members entry.
- **Person** (`/o/:org/members/:userId`): their role and their access to every project, with
  folder exceptions. Editable by the same rules as §5.

The org switcher gains **New organization** at the bottom, shown only when `me.canCreateOrgs`.

### Project level

The project sidebar gains **Settings** (owners and developers):
`/o/:org/p/:pid/settings/folders`, `/settings/access`, `/settings/policy`.

### Who sees what

| | Instance admin | Owner | Developer | Client / viewer |
|---|---|---|---|---|
| New organization | yes | (only if also an instance admin) | | |
| Members list | | manage | read-only | hidden |
| New project, new file collection | | yes | yes | hidden |
| Attach existing folder, detach folder | | yes | | hidden |
| Policy | | edit | read-only | hidden |
| Access | | full | add read only | hidden |

Being an instance admin grants nothing inside an org. Rights there come from the org role.

## 4. Members and invites

### Members page

- **Role control (owners).** Changing a role opens a confirmation that says what follows, in the
  API's terms. For example, demoting a developer to client "removes their write access and ends
  any agent tasks they are running" (`PATCH …/members/:user`). The last owner's control is
  disabled with the reason shown (`409 last_owner` is still handled).
- **Remove (owners).** A confirmation states the consequences: the membership, grants, task
  leases and tokens end (`DELETE …/members/:user`).

### Invite flow (owners)

1. A form takes an email, a role and an optional **Give access to projects** checklist. Developers
   default to read + write, everyone else to read (the §5 model).
2. Submitting adds the member (`POST …/members`), then applies each chosen project's access
   (`PUT …/projects/:pid/access`), as one user action.
3. The worker sends an invite email: *"\<inviter email\> added you to \<org name\> on CommonForge
   as \<role\>."* It links to the app's sign-in page.
   - The link carries no token, so a forwarded invite cannot sign anyone in. Sign-in still goes
     through the normal magic link.
   - The org name and inviter are HTML-escaped in the HTML part.
4. If the email fails, the member is still added. `POST …/members` returns
   `invite: "sent" | "failed"`. The screen says "Added, but the invite email didn't send" and offers
   **Resend invite**.

Server changes:

- `POST /api/orgs/:org/members` sends the invite after inserting the membership and reports
  `invite` in its response.
- New `POST /api/orgs/:org/members/:user/invite` (owner) resends it.
- Invites are rate limited per org and per inviter (30 per hour each) with the existing `OpsGate`
  rate limiter (`hit`), under its own key (`ratelimit:invite`). Over the limit the member is still
  added, `invite` is `"rate_limited"`, and Resend answers `429 invite_rate_limited`.
- `EmailTransport` gains `sendInvite({ to, orgName, inviter, role, link })` with an
  `inviteText(…)` template next to `magicLinkText`. Log and capturing transports implement it.

Not in scope: tracking pending or accepted invites, invite expiry, ownership transfer beyond role
changes.

## 5. Access

### Model

For each person and project, the screen shows one level:

- **None**, **Read**, or **Read + write** (developers only, set by owners only).
- Owners show **Full (owner)** and cannot be edited (their access is implicit).

Expanding a person's row lists the project's folders. Each folder follows the project level by
default and can be set **lower**: read-only, or no access. A folder is never higher than the
project level.

Under the hood these are the existing grants: one project grant and one grant per folder
(resource). A project grant alone still never exposes a folder (AT-16).

### Endpoints (new)

**`GET /api/orgs/:org/projects/:pid/access`** (owners and developers)

```json
{
  "people": [
    {
      "userId": "u-…", "email": "…", "role": "client",
      "level": "read",
      "folders": [{ "mountName": "api", "resourceId": "res-…", "level": "none" }]
    }
  ]
}
```

It lists every member of the org, including those with level `none`, so the screen can add access.

**`PUT /api/orgs/:org/projects/:pid/access`**

```json
{ "userId": "u-…", "level": "none" | "read" | "write",
  "folders": { "<resourceId>": "none" | "read" | "write" } }
```

- `folders` lists exceptions only. A folder not listed follows `level`.
- All grant writes happen in one D1 batch.
- It enforces the existing rules: clients and viewers hold read at most (`400 grant_exceeds_role`).
  Only owners grant write. A folder above the project level is `400 folder_exceeds_project`.
- **Developers** may only raise someone from `none` to `read`, with no folder exceptions. Any other
  change from a developer (lowering, removing, write, exceptions, or touching a person who holds
  write) is `403 grant_owner_only`. This matches today's grant rules.
- It keeps the existing side effects. Narrowing or removing access ends the person's task leases
  and revokes their task tokens (the same code path as `PUT/DELETE …/grants`).
- It records `grant.put` / `grant.deleted` events.

### Folders shared between projects

A folder can be attached to several projects. When a person loses access to a folder through
project A, their folder grant is kept if they still reach that folder through another project they
have access to.

### Automatic access for new folders

- **Attaching** a folder to a project grants it to every non-owner with access to that project, at
  their project level capped by role (clients and viewers: read). This happens in the same request
  as the attach, so the API, the CLI and import all behave the same. Earlier exceptions do not
  block it: a person who had other folders hidden still gets the new one, and an owner can then
  hide it.
- **Detaching** removes the folder grant of every non-owner with access to this project, unless
  the person still reaches the folder through another project they have access to. Grants are not
  tagged with where they came from, so a folder grant someone was given directly (through the
  grants API) for a person with access to this project is removed too. The detach confirmation
  lists everyone affected.
- **One function does both,** in a new `services/access.ts`. It is
  called from three places: `POST …/mounts`, the new `POST …/folders` (§6), and intake
  confirmation, which inserts mounts directly (`services/intake.ts`).

### Person page

It shows the same levels across all projects in the org and edits them through the same `PUT`.

## 6. New organization, new project, folders

### New organization (instance admins)

A dialog asks for the name, then `POST /api/orgs`. On success it refreshes `me` and opens
`/o/:new/members`, whose empty state says "Invite your first people" with the Invite button.

### New project (owners, developers)

A dialog asks for the name, then `POST …/projects`. It then opens
`/o/:org/p/:pid/settings/folders`, whose empty state lists the ways to add folders.

### Folders tab

One row per attached folder:

- the folder (mount) name;
- the kind: "Code (git)" for `artifacts`, "Files" for `r2-assets`;
- the state: empty, importing, ready (active), or failed with the error;
- "Also in: \<project\>" when the folder is attached elsewhere;
- **Detach** (owners). A confirmation says the folder is not deleted and lists who loses access
  (§5).

**Add folder** offers:

1. **Import files.** Opens the existing Add files screen (`/o/:org/p/:pid/files/add`). Its current
   limits are stated: public git URLs only; ZIP plans folders but does not fill them yet.
2. **New file collection** (owners, developers). Creates an empty `r2-assets` folder, which is
   ready at once, and attaches it.
3. **Attach an existing folder** (owners). A picker lists org folders not in this project. Attaching
   gives the folder to everyone with access to this project (§5), and the picker says so before
   confirming.

Empty **code** folders are not offered. A code folder needs a first commit before agents can work
on it (tasks require state `active`, `routes/tasks.ts`), and only the runner can push. That comes
with Import v2 (§11).

### New endpoint

**`POST /api/orgs/:org/projects/:pid/folders`** (owners, developers):
`{ name, kind: "files" }` → `201 { mountName, resourceId }`.

It creates the resource and attaches it in one request, then applies automatic access. It exists
because `POST …/mounts` is owner-only (attaching an existing folder widens who sees it), while
developers keep the right to create new folders. `kind: "code"` is added by Import v2.

Unchanged: mount mode (defaults to `must-match-accepted`; shown in the developer inspector only).
Out of scope: renaming folders, deleting folders outright.

## 7. Policy

**Settings → Policy**: owners edit; developers read (the API already returns `policy` to
developers). The header shows "Revision N, changed by X, date" from `project.policy_changed`
events.

### Forms

- **Who can approve changes:** owner, developer, client (`approvalRoles`; unset means all three,
  `services/proposals.ts`).
- **Who can approve publishing:** owner, developer, client (`publishRoles`; default owner).
- **Checks:** rows of name (`checkId`), folder (a select of this project's mounts), command,
  timeout and Required. Rows can be added and removed. The help text says a failing optional check
  is recorded but does not block.
- **Rules:** a list of plain-text rules. These are given to agents with every task
  (`routes/tasks.ts`), and the help text says so.

### JSON sections

**Contracts**, **Preview** and **Release** each get a monospace JSON text area (no editor
dependency). Each is labelled "Edit as JSON; forms for this section are planned". Forms for every
section are the stated direction.

### Saving

- New **`POST /api/orgs/:org/projects/:pid/policy/validate`** (owner) validates a full policy
  document with the same schema as `PUT` and returns `{ ok, issues: [{ path, message }] }` without
  saving. The editor validates as you go (debounced) and shows each issue next to its form field
  or JSON section, mapped by `path`.
- **Review changes** shows before and after for each changed section, then **Save**.
- `PUT …/policy` accepts an optional `expectedRevision`. If the stored revision differs it answers
  `409 policy_changed`, and the screen offers to load the newer version.
- The whole document is saved in one `PUT`, as today. The forms and JSON sections together cover
  every field of `PolicySchema`, so nothing is dropped.
- The review screen says what saving means: "Changes checked or released after this save use the
  new policy" (the revision bump; releases prepared afterwards are new identities, AT-33).

## 8. Server changes (summary)

| Change | Where |
|---|---|
| `COMMONFORGE_ADMIN_EMAILS` (comma-separated, case-insensitive; an entry is an email or a whole domain written `@domain`, so test and CI deployments with generated owner emails can still create orgs); `POST /api/orgs` answers `403 org_create_forbidden` for others | `routes/orgs.ts`, `env.ts`, all `wrangler*.jsonc`, `scripts/bootstrap.sh`, `scripts/ci-config*.mjs` |
| `GET /api/me` adds `canCreateOrgs` (the user's email is in the list) | `routes/auth.ts` |
| Invite email on add; `invite` in the response; resend endpoint; rate limit | `routes/orgs.ts`, `services/email.ts` |
| `GET`/`PUT …/projects/:pid/access` | `routes/projects.ts`, logic in `services/access.ts` |
| Shared automatic-access function, called by mounts, folders and intake | `services/access.ts` (new), `routes/projects.ts`, `services/intake.ts` |
| Detach removes this project's folder grants (shared-folder rule) | `routes/projects.ts` |
| `POST …/projects/:pid/folders` | `routes/projects.ts` |
| `POST …/policy/validate`; `expectedRevision` on `PUT …/policy` | `routes/projects.ts` |

No D1 migration is expected: grants and memberships use existing tables, and rate limits use
`OpsGate`. `API.md` documents every new or changed route.

## 9. Agency-ready, not agency-built

Single agency per deployment: the instance admins are the agency's people. A later agency layer
(for a hosted, multi-agency version) would:

- add `agencies` and `agency_members` tables, and `orgs.agency_id`;
- replace `COMMONFORGE_ADMIN_EMAILS` with agency admins, who create orgs inside their agency;
- group the org switcher by agency.

The rest of this spec (members, access, folders, policy) works within one org and does not
change. A multi-agency hosted version also needs work this spec does not touch: per-agency deploy
accounts, stronger isolation for untrusted build commands, separate preview origins, sign-up and
billing.

## 10. Plumbing, errors, tests, delivery

### Web app

- **API client** (`apps/web/src/api/client.ts`) and **types**: createOrg, inviteMember,
  resendInvite, updateMemberRole, removeMember, getProjectAccess, putProjectAccess, createProject,
  createFolder, listResources, attachFolder, detachFolder, validatePolicy, putPolicy;
  `Me.canCreateOrgs`.
- **Router:** `members`, `member`, and `settings` routes with a `tab`.
- **Fake API** (`apps/web/src/api/fake.ts`): every method, with the same rules as the worker (role
  limits, last owner, automatic access, shared folders), so fixture mode and the e2e tests match
  the server.
- **Screens** follow the existing split: a pure `…View` component (server-render tested) plus a
  loader component.

### Errors

Each code has a plain-language message: `last_owner`, `insufficient_role`, `grant_exceeds_role`,
`grant_owner_only`, `folder_exceeds_project`, `already_member`, `policy_changed`, `rate_limited`,
`invite_rate_limited`, `invite_failed`,
`org_create_forbidden`. Actions use `ConfirmSheet` and `ErrorNote` and reload after success (no
optimistic updates). Partial outcomes are named ("Added, but the invite email didn't send").

### Tests

- **Worker route tests:**
  - admins list (`403`, `canCreateOrgs`);
  - invites (sent, send failure, rate limit, resend, owner-only);
  - access (levels, role limits, developer limits, exceptions, shared folders, lease and token
    side effects);
  - automatic access through mounts, folders and intake;
  - detach (including the shared-folder rule);
  - policy validate and `expectedRevision`.
- **Security suite** (`apps/worker/test/security`):
  - automatic access never reaches a member without project access;
  - clients and viewers can never be given write through the access endpoint;
  - a developer cannot raise anyone to write.
- **Web:** server-render tests for each view. A fixture e2e journey: invite a client, give access,
  view as the client, and see the project with its folders. The capture-walkthrough selectors stay
  resolvable.

### Delivery (each phase merges and deploys on its own)

1. **Members:** admins list and `canCreateOrgs`, New organization, Members page, invites with
   email, role changes, removal.
2. **Access:** access endpoints, the shared automatic-access function (mounts and intake), Settings
   → Access, the person page.
3. **Projects and folders:** New project, Settings → Folders, `POST …/folders`, attach and detach.
4. **Policy:** validate endpoint, `expectedRevision`, the editor.

**Deployment:** set `COMMONFORGE_ADMIN_EMAILS=owner@agency.example` on production before phase 1
deploys, and the CI harness owner on the CI deployment.

## 11. Next: Import v2 (separate spec)

Private GitHub repositories, as a **one-time import** (the repo moves into CommonForge; export
covers leaving). Cloudflare Artifacts' import accepts public repos only (spike A6: "Only public
repositories can be imported"). So private import is a new runner job:

- it clones with a source credential (passed through `GIT_ASKPASS`, never in a URL or log);
- it pushes to the new canonical repo with a short-lived write token;
- the worker binds the head.

Credential options:

- a fine-grained personal access token, used once and never stored (first);
- a GitHub App with a repository picker (second).

The same job creates empty code folders with a starter commit (`kind: "code"` in §6). Ongoing sync
with GitHub is not planned.
