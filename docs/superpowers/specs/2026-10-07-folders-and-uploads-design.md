# One kind of folder, with uploads: design

**Status:** approved in conversation on 2026-10-07. This document is the written record.
**Scope:** one kind of folder (git, with large and binary files in R2 through Git LFS); uploads and file actions in the web app; quick edits in place; Add folder; LFS everywhere a folder's files are read.
**Next:** Spec B, "Import v2" (private GitHub import), which builds on this one (§11).

## 1. Why

Owners and developers need to put content into a project from the web app. Examples: a few demo videos, a PDF brief, a one-line config fix. Today none of that is possible:

- **No upload.** A file collection (the `r2-assets` folders, such as `brand-assets`) can be created empty, but the only way to add files is through an agent task (stage, upload, commit, then a change) or a script.
- **No code folder from scratch.** A code folder (an Artifacts git repository) can only come from a public git import or the seeding script. A new one can't be created and filled, because the storage API can't commit and only the runner pushes.
- **No large files in code folders.** A code folder can't hold large files at all: Artifacts refuses blobs over 32 MB.
- **Two kinds of folder.** The user must know whether a folder is "code" or "files". To the user there is no difference: a folder is a folder.

## 2. Decisions

| Topic | Decision |
|---|---|
| Folder model | One kind: a git repository. Large or binary files live in R2 through Git LFS, served by CommonForge's own LFS server |
| Existing file collections | Keep working as they are and look like any other folder. Converting them is a later, optional step |
| Who uploads and edits | Owners, and developers with write on the folder. Clients and viewers browse and download only (client uploads are a later phase) |
| File actions | Upload files or folders (keeping structure), subfolders, delete, replace, rename or move, and edit small text files in place |
| Size | Up to 5 GB per file; 1,000 files and 20 GB per change |
| How a change lands | Owner and developer uploads are added at once (approval and acceptance recorded together). Code changes are added once the project's checks pass. Approval and release policy decide what reaches production. Developers count only if the policy lists them (§7) |
| Edits | Refused when the file changed since it was opened (`409 file_changed`). Uploads and moves re-apply on the new version |
| Order | Spike, then the LFS server and `apply-files`, then the Files tab, then Add folder, then LFS where files are read (§10) |
| Runners and LFS | Runners never download LFS files by default: they work with pointers. A job fetches specific paths only when the project policy asks for them. Release media is served from R2 URLs, not copied into builds. (Decided 2026-10-07 after the spike; no large-disk runner instances are needed.) |

## 3. Architecture

**One kind of folder.**
- Every new folder is an Artifacts git repository, created with a first commit containing `.gitattributes`, `.lfsconfig` and a short `README.md`.
- Large or binary files are stored in R2 as content-addressed objects. Git keeps a small pointer file at the same path, which is standard Git LFS.
- CommonForge serves the Git LFS API itself, backed by R2, with the platform's own sign-in and grants. Plain `git`, agents, the `cforge` CLI and repositories that already use LFS therefore work unchanged.
- The UI shows each file at the path where it was uploaded, with its real size. Files are served from R2, and the user never sees a pointer.

**Uploads and file actions are ordinary changes.**
- Bytes are staged in R2 first.
- A new runner job, `apply-files` (§6), then:
  1. clones the folder into a fresh task repository;
  2. applies the operations, writing large or binary files as LFS pointers;
  3. commits and pushes.
- From there the existing path runs: freeze, prepare the candidate, create the change, run the checks, accept.
- Auto-accept follows §7.

**LFS where a folder's files are read.**
- People see real files: the Files tab, downloads, `cforge` checkout, client editions and export bundles serve the object, never the pointer.
- Runners work with pointers. Agent workspaces, the integration runner and preview and release builds get the pointer files and never download LFS objects by default.
- A job fetches specific LFS paths only when the project policy names them (for example a build step that must process one asset).
- Release and preview sites serve LFS media from R2 URLs instead of copying it into the build output.

## 4. Storage

All under the org prefix in the platform's R2 bucket:

| Key | Holds |
|---|---|
| `org/<org>/lfs/<resourceId>/obj/<stagingId>` | Every LFS object, staged or accepted: browser uploads (written there through R2 multipart) and git-lfs pushes (presigned PUT) |

The database records each object: its size, its verified sha256, whether it is binary, who uploaded it (and for agents, which task), and when a change that references it was accepted. **Accepting is a database fact; bytes are never copied or moved** (decided after the spike: the R2 binding has no copy, and S3 `CopyObject` stops near 5 GiB).

**Rules:**
- Every upload is hashed by the platform when it completes (a Worker step streaming the object through SHA-256). An object is usable only once its hash is verified; a git-lfs upload whose hash differs from the oid it claimed is deleted.
- An object becomes accepted when a change that references it is accepted.
- Unaccepted objects expire after **7 days** (counted from their last use by a change). Uploads that were never completed expire after **24 hours**.
- Accepted objects are kept, because Versions can restore any earlier version. Deleting accepted objects no version references any more is a later clean-up job, like today's file-collection GC.

## 5. The LFS server

**Endpoint:** `POST /api/lfs/:org/:resourceId/info/lfs/objects/batch`, the standard Git LFS batch API. The basic transfer adapter is used for download and for upload.

**Sign-in:**
- Session tokens (`cfs_…`) and agent lease tokens (`cfl_…`) over HTTP Basic, as with git.
- The `cforge` git credential helper answers for the LFS URL too. Tokens are never written to disk, and never put in logged URLs (presigned URLs are the exception noted below).

**Download:**
- Anyone with read on the folder gets **accepted** objects.
- Owners and developers who can see a change also get its **staged** objects.
- Clients and viewers never get staged objects.
- Responses stream through the Worker; a response has no size limit.

**Upload:**
- Owners, and developers with write on the folder, can upload.
- An agent can upload only into its own task's staging area.
- Large uploads go **directly to R2** through a presigned PUT URL. The URL lasts 15 minutes, covers one object key, and allows up to 5 GB. This needs an R2 access key pair, stored as Worker secrets `COMMONFORGE_R2_ACCESS_KEY_ID` and `COMMONFORGE_R2_SECRET_ACCESS_KEY`.
- The `verify` action records the object as uploaded and starts its hash. Nothing is used until the platform has verified its hash.

**Settings:**
- `COMMONFORGE_LFS_THRESHOLD_BYTES`, default 1 MB.
- `COMMONFORGE_STAGING_TTL_DAYS`, default 7.

## 6. The runner job `apply-files`

A new signed job kind, run in the Sandbox container like the others.

**Input:**
- the folder (resource) and its base version;
- an ordered list of operations:
  - `{ put: path, stagingId }`;
  - `{ edit: path, content, baseBlob }` (`baseBlob` is empty for a new file);
  - `{ delete: path }`;
  - `{ move: from, to }` (a directory moves everything under it);
- the uploader, as the commit author;
- a title.

**Steps:**
1. Clone the folder at its base version into a fresh `-tasks` repository, the same isolation as agent tasks.
2. Apply the operations in order:
   - **put:** the object's sha256, size and "binary" flag were recorded when its upload was hashed. If the file is binary, matches `.gitattributes`, or is over the threshold, write an LFS pointer from those values (the runner never downloads the object) and record the object for promotion. Otherwise fetch the small text file, check its hash, and write it as a plain file. A file stored in LFS whose path matches no pattern gets its exact path added to `.gitattributes` in the same commit.
   - **edit:** check that the file's current blob equals `baseBlob`. If it doesn't, stop with `file_changed`. Otherwise write the content (text only, under the threshold).
   - **delete** and **move:** apply them with git; LFS pointers move with their files.
3. Commit with the title, authored as the uploader. Push to the task repository.

**Result:**
- the commit;
- every changed path, classified as **code** or **content** (§7);
- the LFS objects to promote, as `{ stagingId, sha256, size }`;
- or a refusal: `file_changed`, `hash_mismatch` or a limit.

**Limits:**
- 5 GB per file;
- 1,000 operations and 20 GB per change;
- edits under 1 MB, text only.

## 7. How a change lands

**After `apply-files` succeeds:**
- The existing path runs: freeze, prepare the candidate, create the proposal.
- **Content or code.**
  - A path is **content** if it is stored in LFS, or is a PDF or Office document.
  - Every other path is **code**, and so is any delete or move of a code file.
  - A change with any code path is a code change.
- **Auto-accept.** The uploader's approval and acceptance are recorded together:
  - **content-only:** at once;
  - **code:** integration (the project's checks) runs first, and the change is accepted automatically when the checks pass. If they fail, it stays as a change showing the failure, like an agent's change.
- **Approval policy still applies.** The uploader's approval counts only if their role is in the project's `approvalRoles`. Owners are listed by default, and developers only if the policy lists them. If the uploader's role isn't listed, the change waits for an approval from a listed role, and the UI shows "Waiting for approval".
- **What reaches production** is still decided by the release policy and its publish approval. Accepting a change makes a new version of the folder; it doesn't publish anything.
- **On accept,** the change's staged LFS objects are promoted.

**Another change was accepted first (stale base):**
- Uploads and moves re-run `apply-files` on the new version, up to 3 times. They are idempotent "put these files here" operations, and if the same file changed meanwhile, the upload wins (the earlier version stays restorable).
- Edits never re-run; they fail with `file_changed`.

**Existing file collections** (`r2-assets`) keep their manifest path:
- uploads, replace, rename or move, and delete become an assets-only change, auto-accepted under the same approval rule;
- edit in place doesn't apply to them.

## 8. Using it

**Files tab.** For owners and developers with write on the folder:
- **Upload** files, or drop them on the tree. They land in the directory being viewed.
- **Upload folder** keeps the dropped folder's structure.
- **New subfolder.** It exists once a file is uploaded into it, since git has no empty directories.
- **On each file:** Download, Replace, Rename / Move, Delete. Several files can be selected for Delete or Move.
- **Upload tray:** per-file progress, plus Cancel and Retry. A failed 50 MB part retries on its own. Leaving the page cancels unfinished uploads, and resuming after a reload is out of scope.
- **Change titles** are generated, for example "Uploaded 30 files to videos/2026".
- **Status:** "Added", "Checking", "Waiting for approval", or the failure.
- Clients and viewers browse and download, as today.

**Edit in place.** For owners and developers with write, on text files not stored in LFS and under 1 MB:
- **Edit** opens a full-width monospace editor with line numbers (a plain text area, with no editor dependency in this version).
- **Save** shows a diff of the changed lines and an optional title, then creates the change. Code rules apply.
- If the file changed since it was opened, the save is refused with "This file changed since you opened it". The user can view the newer version, or copy their text before reloading.
- **New file** creates a small text file in the directory being viewed.

**Add folder (Folders tab, owners and developers).**
- One name field and no kind choice.
- It creates the Artifacts repository. The first commit is made by a small runner job, `init-folder` (phase 4 plan, ruling P4-1; `apply-files` needs an existing version):
  - `.gitattributes`: LFS for video, audio, images, archives, fonts, PDF and Office files;
  - `.lfsconfig`: the folder's LFS URL;
  - `README.md`: the folder name.
- The folder then has a first version, ready for uploads, edits and agent tasks.
- Automatic access applies, as now.
- The Folders tab drops the "Code (git)" / "Files" labels.

## 9. API (new or changed)

| Route | Who | Body → response |
|---|---|---|
| `POST /api/orgs/:org/projects/:pid/folders` (changed) | Owner, or developer with the project | `{ name }` → `201 { mountName, resourceId }`. Creates a git + LFS folder and starts the first commit. `kind: "files"` is still accepted, with the same result. |
| `POST /api/orgs/:org/projects/:pid/folders/:mount/uploads` | Owner, or developer with write | `{ path, size, mime }` → `{ uploadId, partSize }`. 5 GB maximum. |
| `PUT /api/orgs/:org/uploads/:uploadId/parts/:n` | The uploader | Raw bytes, at most `partSize` → `{ etag }` |
| `POST /api/orgs/:org/uploads/:uploadId/complete` | The uploader | `{ parts: [{ n, etag }] }` → `{ stagingId, size }` |
| `POST /api/orgs/:org/projects/:pid/folders/:mount/changes` | Owner, or developer with write | `{ ops: [{ put, stagingId } \| { edit, content, baseBlob } \| { delete } \| { move, to }], title? }` → `{ changeId, proposalId, state: "applying" \| "checking" \| "waiting_approval" \| "added" \| "failed", error? }`. `409 file_changed`; `413` for limits. |
| `POST /api/lfs/:org/:resourceId/info/lfs/objects/batch` | As §5 | The Git LFS batch API |

The existing proposal view shows progress, and the UI polls it.

## 10. Delivery

Each phase merges and deploys on its own.

1. **Spike.** Throwaway code; results in `spikes/lfs/RESULTS.md`. It must answer yes to all of these, or come back to the owner with options before building:
   1. git-lfs runs in the runner's Sandbox container, and pointer commits push to Artifacts as ordinary files.
   2. A 2 GB git-lfs upload through a presigned R2 URL works end to end. This is the riskiest item, and it confirms the R2 keys and the single-PUT limit.
   3. A 2 GB browser upload in 50 MB parts through the Worker's R2 multipart binding works, with throughput measured.
   4. Hashing a 2 GB staged object in the runner fits within a job's time.
   5. A preview build of a folder with a 100 MB LFS video produces real files.
2. **LFS server and `apply-files`.** R2 staging, part uploads, the changes endpoint, auto-accept (§7), promotion and expiry. API only.
3. **Files tab.** Upload tray, file actions, edit in place.
4. **Add folder, one kind.** First commit via the `init-folder` job (P4-1), labels removed, the old `kind` still accepted.
5. **LFS where files are read.** `cforge` checkout, editions, exports and bundle verify serve real files; builds keep pointers, fetch policy-named paths only, and serve media from R2 URLs.

**Caveat until phase 5 lands:** previews and releases of folders containing LFS files show pointers where the media should be, because the R2 media URLs come in phase 5.

**Tests (test-first throughout):**
- **Worker:**
  - LFS batch auth (read, write, agent staging only, clients never get staged objects);
  - part uploads;
  - every kind of change operation;
  - `file_changed`;
  - permissions;
  - auto-accept, including a developer not in `approvalRoles`;
  - promotion and expiry.
- **Security suite:** no staged object reaches a client; agents can't write outside their task; presigned URLs cover one key and expire.
- **Runner** (real git with git-lfs):
  - put, edit, delete, move;
  - pointers for large or binary files, and the per-path `.gitattributes` entry;
  - `hash_mismatch`;
  - stale base re-applied for uploads, refused for edits.
- **Web:**
  - pure views and logic: the upload tray, the editor and diff, file actions;
  - a fake that mirrors the rules;
  - a fixture journey: add a folder, upload a video, edit a config file, move, delete, restore.
- **Live (CI deployment):** upload a 2 GB video, see it in Files, preview a site that includes it, export and verify the bundle.

## 11. Next: Spec B, Import v2

- One-time import of private GitHub repositories:
  - with a fine-grained personal access token first, used once and never stored;
  - with a GitHub App later.
- It reuses `apply-files` and the LFS store, so repositories that use LFS on GitHub come in whole: their objects are fetched into our store and `.lfsconfig` is rewritten.
- Ongoing sync with GitHub is not planned.

## 12. Out of scope

- Client uploads (they need a "client proposes" path).
- Resuming uploads after a reload.
- Converting existing file collections.
- Deleting accepted objects no version references.
- Storage quotas and billing.
- Syntax highlighting in the editor.
- Ongoing GitHub sync.
