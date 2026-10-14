/**
 * The Files tab's write affordances (plan phase 3 Task 9), by server rendering the pure views:
 * who sees the toolbar, checkboxes and file actions; the tray's progress, failures and status
 * words; the move, delete and new-folder sheets; LFS entries.
 */
import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FileChange, Mount, ProjectSnapshot, Role, TreeEntry } from "../src/api/types.js";
import type { UploadBatch, UploadItem } from "../src/lib/uploads.js";
import { DeleteSheetView, MoveSheetView, NewFolderSheetView, ReplaceSheetView } from "../src/screens/FileActions.js";
import { FileRowActions, FilesToolbarView, FolderSetupNoteView, folderSetupNote, mountHasVersion, prunePendingDirs, SelectionBarView, TreeRowView, writeAllowed, writeOffered } from "../src/screens/Files.js";
import { ChangeStatusList, changeStatus, changePollMs, UploadTrayView } from "../src/screens/UploadTray.js";

const noop = () => {};

function renderToString(el: Parameters<typeof render>[0]): string {
  return render(el).replace(/<!-- -->/g, "");
}

const git = (canWrite?: boolean): Mount => ({ mountName: "website", resourceId: "res-1", provider: "artifacts", resourceName: "Website", mode: "must-match-accepted", operations: ["read", "write"], ...(canWrite === undefined ? {} : { canWrite }) });
const assets = (canWrite?: boolean): Mount => ({ ...git(canWrite), mountName: "brand", resourceName: "Brand", provider: "r2-assets" });

const file: TreeEntry = { path: "docs/guide.md", type: "file", size: 120 };
const dir: TreeEntry = { path: "docs", type: "dir" };

/** Everything a viewer of this role and mount could be offered, rendered together. */
function surfaces(role: Role, m: Mount, entry: TreeEntry = file, hasVersion = true) {
  const canWrite = writeOffered(role, m, hasVersion);
  const editable = m.provider === "artifacts";
  return [
    renderToString(createElement(FilesToolbarView, { mount: m, dir: "docs", canWrite, editable, onUpload: noop, onUploadFolder: noop, onNewFolder: noop, onNewFile: noop })),
    renderToString(createElement(TreeRowView, { entry, depth: 1, active: false, open: false, canWrite, checked: false, onClick: noop, onCheck: noop })),
    renderToString(createElement(FileRowActions, { mount: m, entry, canWrite, downloadHref: "/dl/docs/guide.md", onReplace: noop, onMove: noop, onDelete: noop, onEdit: noop })),
  ].join("\n");
}

const WRITE_LABELS = ["Upload files", "Upload folder", "New folder", "New file", "Replace", "Rename or move", "Delete", "Edit", 'type="checkbox"'];

describe("Files tab: who sees write actions", () => {
  it("writeAllowed needs an owner or developer and canWrite: true", () => {
    expect(writeAllowed("owner", git(true))).toBe(true);
    expect(writeAllowed("developer", git(true))).toBe(true);
    expect(writeAllowed("developer", git(false))).toBe(false);
    expect(writeAllowed("owner", git())).toBe(false); // an older server: no canWrite means no
    expect(writeAllowed("client", git(true))).toBe(false);
    expect(writeAllowed("viewer", git(true))).toBe(false);
  });

  it("a client sees no toolbar, checkboxes or write actions, but sees Download", () => {
    const out = surfaces("client", git(true));
    for (const label of WRITE_LABELS) expect(out).not.toContain(label);
    expect(out).toContain("Download");
    expect(out).toContain('href="/dl/docs/guide.md"');
  });

  it("a developer with canWrite: false sees the same", () => {
    const out = surfaces("developer", git(false));
    for (const label of WRITE_LABELS) expect(out).not.toContain(label);
    expect(out).toContain("Download");
  });

  it("an owner sees all of them on a git folder", () => {
    const out = surfaces("owner", git(true));
    for (const label of WRITE_LABELS) expect(out).toContain(label);
    expect(out).toContain('aria-label="Upload"');
    expect(out).toContain("webkitdirectory");
    expect(out).toContain("multiple");
    expect(out).toContain('aria-label="Select guide.md"');
  });

  it("a file collection has no New file or Edit", () => {
    const out = surfaces("owner", assets(true));
    expect(out).toContain("Upload files");
    expect(out).toContain("Replace");
    expect(out).not.toContain("New file");
    expect(out).not.toContain(">Edit<");
  });

  it("an LFS file, a large file or a binary one is not offered Edit", () => {
    const m = git(true);
    const offered = (e: TreeEntry) => renderToString(createElement(FileRowActions, { mount: m, entry: e, canWrite: true, downloadHref: "/dl", onReplace: noop, onMove: noop, onDelete: noop, onEdit: noop })).includes(">Edit<");
    expect(offered(file)).toBe(true);
    expect(offered({ ...file, lfs: true })).toBe(false);
    expect(offered({ ...file, size: 2 * 1024 * 1024 })).toBe(false);
    expect(offered({ path: "media/film.mp4", type: "file", size: 10 })).toBe(false);
  });

  it("a directory offers move and delete, not download or replace", () => {
    const out = renderToString(createElement(FileRowActions, { mount: git(true), entry: dir, canWrite: true, downloadHref: "/dl", onReplace: noop, onMove: noop, onDelete: noop, onEdit: noop }));
    expect(out).toContain("Rename or move");
    expect(out).toContain("Delete");
    expect(out).not.toContain("Download");
    expect(out).not.toContain("Replace");
  });

  it("the selection bar offers Move and Delete for several files", () => {
    const out = renderToString(createElement(SelectionBarView, { count: 3, onMove: noop, onDelete: noop, onClear: noop }));
    expect(out).toContain("3 selected");
    expect(out).toContain("Move");
    expect(out).toContain("Delete");
    expect(renderToString(createElement(SelectionBarView, { count: 0, onMove: noop, onDelete: noop, onClear: noop }))).toBe("");
  });
});

describe("Files tab: tree rows", () => {
  it("LFS entries show their real size and an LFS tag", () => {
    const out = renderToString(createElement(TreeRowView, { entry: { path: "media/film.mp4", type: "file", size: 52_428_800, lfs: true }, depth: 1, active: false, open: false, canWrite: false, checked: false, onClick: noop, onCheck: noop }));
    expect(out).toContain("film.mp4");
    expect(out).toContain("50.0 MB");
    expect(out).toContain(">LFS<");
    const plain = renderToString(createElement(TreeRowView, { entry: file, depth: 1, active: false, open: false, canWrite: false, checked: false, onClick: noop, onCheck: noop }));
    expect(plain).not.toContain(">LFS<");
  });

  it("a pending folder says to upload a file to keep it", () => {
    const out = renderToString(createElement(TreeRowView, { entry: { path: "media/new", type: "dir" }, depth: 1, active: false, open: false, canWrite: true, checked: false, pending: true, onClick: noop, onCheck: noop }));
    expect(out).toContain("Upload a file to keep this folder");
  });

  it("a pending folder stops being pending once a listing shows it (a file landed in it)", () => {
    const pending = ["media", "media/sub", "drafts"];
    expect(prunePendingDirs(pending, ["contracts", "media"])).toEqual(["media/sub", "drafts"]);
    // nothing listed is pending: the same array, so the screen's state does not change
    expect(prunePendingDirs(pending, ["contracts"])).toBe(pending);
    expect(prunePendingDirs(undefined, ["media"])).toBeUndefined();
  });

  it("file names are text, never markup", () => {
    const out = renderToString(createElement(TreeRowView, { entry: { path: "x/<img src=x onerror=alert(1)>.txt", type: "file", size: 1 }, depth: 1, active: false, open: false, canWrite: true, checked: false, onClick: noop, onCheck: noop }));
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });
});

const item = (over: Partial<UploadItem>): UploadItem => ({ id: "item-1", batchId: "batch-1", path: "media/a.mp4", size: 200, sent: 50, state: "uploading", ...over });
const change = (state: FileChange["state"], over: Partial<FileChange> = {}): FileChange => ({ changeId: `fc-${state}`, projectId: "p-1", mountName: "website", title: `Uploaded 1 file to media (${state})`, state, attempt: 1, proposalId: null, createdAt: "", updatedAt: "", ...over });
const batch = (over: Partial<UploadBatch>): UploadBatch => ({ id: "batch-1", mount: "website", dir: "media", title: "Uploaded 1 file to media", itemIds: ["item-1"], ...over });

describe("Files tab: the upload tray", () => {
  it("renders each item's path and progress", () => {
    const out = renderToString(createElement(UploadTrayView, { org: "acme", pid: "p-1", items: [item({})], batches: [batch({})], onCancel: noop, onRetry: noop, onRemove: noop, onDismiss: noop, onResend: noop }));
    expect(out).toContain("media/a.mp4");
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-valuenow="25"');
    expect(out).toContain("Uploading");
    expect(out).toContain("Cancel");
  });

  it("an empty file shows as complete, not as 0 of 0", () => {
    const out = renderToString(createElement(UploadTrayView, { org: "acme", pid: "p-1", items: [item({ size: 0, sent: 0, state: "done", path: "media/.gitkeep" })], batches: [batch({})], onCancel: noop, onRetry: noop, onRemove: noop, onDismiss: noop, onResend: noop }));
    expect(out).toContain('aria-valuenow="100"');
    expect(out).not.toContain("NaN");
  });

  it("a failed item shows its error with Retry and Remove", () => {
    const out = renderToString(createElement(UploadTrayView, { org: "acme", pid: "p-1", items: [item({ state: "failed", error: "network down" })], batches: [batch({})], onCancel: noop, onRetry: noop, onRemove: noop, onDismiss: noop, onResend: noop }));
    expect(out).toContain("network down");
    expect(out).toContain("Retry");
    expect(out).toContain("Remove");
    expect(out).not.toContain(">Cancel<");
  });

  it("review 2: a batch whose change could not be sent shows why and offers Send again, not Dismiss", () => {
    const resent: string[] = [];
    const el = createElement(UploadTrayView, { org: "acme", pid: "p-1", items: [item({ state: "done", sent: 4, size: 4 })], batches: [batch({ sendError: "the connection failed" })], onCancel: noop, onRetry: noop, onRemove: noop, onDismiss: noop, onResend: (id: string) => void resent.push(id) });
    const out = renderToString(el);
    expect(out).toContain("the connection failed");
    expect(out).toContain("Send again");
    expect(out).not.toContain("Dismiss");
    expect(renderToString(createElement(UploadTrayView, { org: "acme", pid: "p-1", items: [item({ state: "done" })], batches: [batch({})], onCancel: noop, onRetry: noop, onRemove: noop, onDismiss: noop, onResend: noop }))).not.toContain("Send again");
  });

  it("a refused batch shows why", () => {
    const out = renderToString(createElement(UploadTrayView, { org: "acme", pid: "p-1", items: [], batches: [batch({ itemIds: [], error: "Files are limited to 5 GB each" })], onCancel: noop, onRetry: noop, onRemove: noop, onDismiss: noop, onResend: noop }));
    expect(out).toContain("Files are limited to 5 GB each");
    expect(out).toContain("Dismiss");
  });

  it("each status word, and the proposal link", () => {
    const states: Array<[FileChange, string]> = [
      [change("applying"), "Adding…"],
      [change("checking"), "Checking"],
      [change("waiting_approval", { proposalId: "prop-1" }), "Waiting for approval"],
      [change("staged"), "On staging"],
      [change("added", { proposalId: "prop-2" }), "Added"],
      [change("failed", { error: { code: "check_failed", message: "checks failed" } }), "The project's checks failed on this change"],
    ];
    for (const [c, word] of states) expect(changeStatus(c).label).toContain(word);
    const batches = states.map(([c], i) => batch({ id: `b-${i}`, itemIds: [], changeId: c.changeId, change: c, title: c.title }));
    const out = renderToString(createElement(UploadTrayView, { org: "acme", pid: "p-1", items: [], batches, onCancel: noop, onRetry: noop, onRemove: noop, onDismiss: noop, onResend: noop }));
    for (const [, word] of states) expect(out).toContain(word.replace("'", "&#x27;"));
    expect(out).toContain('href="/o/acme/p/p-1/changes/prop-1"');
    expect(out).toContain("someone with approval rights");
    expect(out).toContain("once its task is promoted from staging");
  });

  it("review 12: changes are polled every 1.5 s while one is being added or checked, every 15 s while they only wait for approval, every 60 s while they are only on staging, not at all otherwise", () => {
    expect(changePollMs([change("applying"), change("waiting_approval")])).toBe(1500);
    expect(changePollMs([change("checking")])).toBe(1500);
    expect(changePollMs([change("waiting_approval"), change("added")])).toBe(15_000);
    expect(changePollMs([change("staged"), change("waiting_approval")])).toBe(15_000);
    expect(changePollMs([change("staged"), change("added")])).toBe(60_000);
    expect(changePollMs([change("added"), change("failed")])).toBeNull();
    expect(changePollMs([])).toBeNull();
  });

  it("an unknown failure still reads as a sentence", () => {
    expect(changeStatus(change("failed", { error: { code: "weird", message: "it broke" } })).label).toContain("it broke.");
  });

  it("the change status list shows open changes from other tabs and teammates", () => {
    const out = renderToString(createElement(ChangeStatusList, { org: "acme", pid: "p-1", changes: [change("checking", { title: "Moved 2 files to media" })] }));
    expect(out).toContain("Moved 2 files to media");
    expect(out).toContain("Checking");
    expect(renderToString(createElement(ChangeStatusList, { org: "acme", pid: "p-1", changes: [] }))).toBe("");
  });
});

describe("Files tab: sheets", () => {
  it("the move sheet refuses moving a directory into itself", () => {
    const out = renderToString(createElement(MoveSheetView, { paths: ["media", "docs/a.md"], knownDirs: ["media", "media/sub"], initialTarget: "media/sub", busy: false, error: null, onSubmit: noop, onCancel: noop }));
    expect(out).toContain('aria-label="Move files"');
    expect(out).toContain("cannot move media into itself");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Move</);
  });

  it("the move sheet lists known dirs; one file gets a new-name input", () => {
    const many = renderToString(createElement(MoveSheetView, { paths: ["a.md", "b.md"], knownDirs: ["media", "docs"], busy: false, error: null, onSubmit: noop, onCancel: noop }));
    expect(many).toContain('value="media"');
    expect(many).toContain('value="docs"');
    expect(many).toContain("Move 2 files to");
    const one = renderToString(createElement(MoveSheetView, { paths: ["docs/a.md"], knownDirs: [], busy: false, error: null, onSubmit: noop, onCancel: noop }));
    expect(one).toContain("New path");
    expect(one).toContain('value="docs/a.md"');
  });

  it("the delete sheet lists every selected path", () => {
    const out = renderToString(createElement(DeleteSheetView, { paths: ["docs/a.md", "media", "b.txt"], busy: false, error: null, onConfirm: noop, onCancel: noop }));
    expect(out).toContain('aria-label="Delete files"');
    for (const p of ["docs/a.md", "media", "b.txt"]) expect(out).toContain(`<li>${p}</li>`);
    expect(out).toContain("Delete 3 files");
  });

  it("the new folder sheet checks the name", () => {
    const out = renderToString(createElement(NewFolderSheetView, { dir: "media", initialName: "../x", onCreate: noop, onCancel: noop }));
    expect(out).toContain('aria-label="New folder"');
    expect(out).toContain("contains ..");
    const ok = renderToString(createElement(NewFolderSheetView, { dir: "media", initialName: "2026", onCreate: noop, onCancel: noop }));
    expect(ok).toContain("media/2026");
    expect(ok).toContain("Upload a file to keep this folder");
  });

  it("the replace sheet names the file it replaces", () => {
    const out = renderToString(createElement(ReplaceSheetView, { path: "media/film.mp4", onFile: noop, onCancel: noop }));
    expect(out).toContain("media/film.mp4");
    expect(out).toContain("Replacement file");
  });
});

describe("Files tab: a folder that is being set up (phase 4)", () => {
  it("says it is being set up, or shows the setup error, instead of no_accepted_head", () => {
    expect(folderSetupNote({ state: "empty" }, true)).toEqual({ tone: "busy", text: "This folder is being set up. It will be ready in a few seconds." });
    expect(folderSetupNote({ state: "failed", error: "Setting up this folder failed: boom" }, false)).toEqual({ tone: "bad", text: "Setting up this folder failed: boom" });
    expect(folderSetupNote({ state: "failed" }, false)).toEqual({ tone: "bad", text: "Setting up this folder failed." });
    // a ZIP-planned empty folder, or nothing known (clients and viewers can't read the folder list):
    // a neutral sentence for any role, never the raw no_accepted_head error
    const neutral = { tone: "plain", text: "This folder has no files yet." };
    expect(folderSetupNote({ state: "empty" }, false)).toEqual(neutral);
    expect(folderSetupNote({ state: "active" }, false)).toEqual(neutral);
    expect(folderSetupNote(undefined, undefined)).toEqual(neutral);
  });

  it("renders as a status note", () => {
    const out = renderToString(createElement(FolderSetupNoteView, { note: { tone: "busy", text: "This folder is being set up. It will be ready in a few seconds." } }));
    expect(out).toContain('role="status"');
    expect(out).toContain("This folder is being set up. It will be ready in a few seconds.");
    expect(renderToString(createElement(FolderSetupNoteView, { note: { tone: "bad", text: "Setting up this folder failed: boom" } }))).toContain("note-bad");
    expect(renderToString(createElement(FolderSetupNoteView, { note: { tone: "plain", text: "This folder has no files yet." } }))).toContain('class="note"');
  });
});

describe("Files tab: a folder with no first version is read-only (phase 4)", () => {
  const snap = (mounts: string[]): ProjectSnapshot => ({ snapshotId: "s", projectId: "p", organizationId: "o", membershipRevision: 1, policyRevision: 1, entries: mounts.map((mountName) => ({ resourceId: `res-${mountName}`, revisionId: "r", mode: "must-match-accepted", mountName, operations: ["read", "write"] })), createdAt: "2026-10-11T00:00:00Z" });

  it("a mount has a version when the snapshot pins it and its tree read did not answer no_accepted_head", () => {
    expect(mountHasVersion(snap(["website"]), "website", new Set())).toBe(true);
    // being set up (or a ZIP-planned empty folder): not in the snapshot
    expect(mountHasVersion(snap(["website"]), "media", new Set())).toBe(false);
    // the tree read answered no_accepted_head
    expect(mountHasVersion(snap(["website"]), "website", new Set(["website"]))).toBe(false);
    expect(mountHasVersion(undefined, "media", new Set(["media"]))).toBe(false);
    // the snapshot not read yet: only a no_accepted_head read says no
    expect(mountHasVersion(undefined, "website", new Set())).toBe(true);
  });

  it("an owner on a writable git folder with no version is offered no write action", () => {
    expect(writeOffered("owner", git(true), false)).toBe(false);
    expect(writeOffered("owner", git(true), true)).toBe(true);
    expect(writeOffered("client", git(true), true)).toBe(false);
    const out = surfaces("owner", git(true), file, false);
    for (const label of WRITE_LABELS) expect(out).not.toContain(label);
    expect(out).not.toContain('aria-label="Upload"');
  });
});
