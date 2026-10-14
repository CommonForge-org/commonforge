/**
 * Project browser: one tree built from the project snapshot (every mount is a top-level folder,
 * whatever its provider), and a source inspector that reveals where each item really lives.
 *
 * Owners, and developers with write on a folder (`Mount.canWrite`), also upload files and
 * folders (toolbar, or a drop on the tree or a folder row), create subfolders, and replace,
 * move or delete files (plan phase 3 Task 9). Every action is one change under the project's
 * approval policy; the tray and the status list show where each change is. Small text files of
 * git folders are edited in place, and new ones created, in `EditFile.tsx` (`?edit=1`, `?new=1`).
 */
import { createContext, useContext, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { ApiError } from "../api/client.js";
import type { FileChange, FileChangeOp, Mount, Project, ProjectSnapshot, ResourceDetail, Role, SnapshotEntry, TreeEntry } from "../api/types.js";
import { canEditInPlace, filesFromDrop, filesFromInput, type PickedFile } from "../lib/file-ops.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import type { UploadQueueState } from "../lib/uploads.js";
import { basename, formatBytes, formatTime, isDeveloperRole, looksLikeImage, looksLikeText, providerKind, providerLabel, revisionLabel, RetryKey, shortCode } from "../lib/model.js";
import { intakeHref, navigate, projectHref } from "../lib/router.js";
import { EmptyState, Icon, resourceIcon, type InspectorSection } from "../primitives/index.js";
import { Card, ErrorNote, Link, Loading } from "../ui.js";
import { EditFileScreen, type EditExit } from "./EditFile.js";
import { DeleteSheetView, MoveSheetView, NewFolderSheetView, ReplaceSheetView } from "./FileActions.js";
import { SETUP_POLL_MS, setupPollStep } from "./FoldersTab.js";
import { useInspectorSections, useProject, useUploads } from "./project-data.js";
import { ChangeStatusList, changePollMs, isOpenChange, UploadTrayView } from "./UploadTray.js";

const PREVIEW_LIMIT = 256 * 1024;

export interface MountGroup {
  label: string;
  mounts: Mount[];
}

/** Client-friendly grouping (PRD §4.3): current application, prototypes/reference, media. */
export function groupMounts(mounts: Mount[]): MountGroup[] {
  const groups: MountGroup[] = [
    { label: "Current application", mounts: [] },
    { label: "Brand and media", mounts: [] },
    { label: "Ideas, prototypes and reference", mounts: [] },
  ];
  for (const m of mounts) {
    if (providerKind(m.provider) === "assets") groups[1]!.mounts.push(m);
    else if (m.mode === "pinned-reference") groups[2]!.mounts.push(m);
    else groups[0]!.mounts.push(m);
  }
  return groups.filter((g) => g.mounts.length > 0);
}

/** The resource's object icon (repository, assets, notes): the same family as cards and the video. */
function MountIcon({ m }: { m: Mount }) {
  const kind = resourceIcon(m.provider, m.resourceName);
  return (
    <span className={`icon icon-${kind}`} aria-hidden="true">
      <Icon name={kind} size={16} />
    </span>
  );
}

/**
 * The project's resources as chips (hero frame, DEMO-SCRIPT 0:00): one per top-level folder, with
 * its object icon and where it is stored. Clicking a chip opens that folder.
 */
export function ResourceChips({ mounts, selected, onSelect }: { mounts: Mount[]; selected?: string | undefined; onSelect: (mount: string) => void }) {
  return (
    <ul className="resource-chips" data-testid="resource-chips" aria-label="Resources in this project">
      {mounts.map((m) => {
        const kind = providerKind(m.provider);
        return (
          <li key={m.mountName}>
            <button type="button" className={`resource-chip resource-chip-${kind} ${selected === m.mountName ? "resource-chip-active" : ""}`.trim()} aria-pressed={selected === m.mountName} onClick={() => onSelect(m.mountName)}>
              <MountIcon m={m} />
              <span className="resource-chip-name">{m.resourceName}</span>
              <span className="resource-chip-kind">{kind === "assets" ? "Assets · R2" : m.mode === "pinned-reference" ? "Reference · Git" : "Code · Git"}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Owners and developers act on a folder only where the server says they may write (`canWrite`). */
export function writeAllowed(role: Role, m: Mount): boolean {
  return isDeveloperRole(role) && m.canWrite === true;
}

/**
 * Whether a folder has an accepted version to write onto (phase 4): the snapshot pins it, and its
 * tree read did not answer `no_accepted_head`. A folder being set up (or a ZIP-planned empty one)
 * has none. Before the snapshot is read, only a `no_accepted_head` read says no.
 */
export function mountHasVersion(snapshot: Pick<ProjectSnapshot, "entries"> | undefined, mount: string, noHead: ReadonlySet<string>): boolean {
  if (noHead.has(mount)) return false;
  return snapshot ? snapshot.entries.some((e) => e.mountName === mount) : true;
}

/** Write actions (Upload, Upload folder, New file, New folder, drops, row actions) are offered only where the viewer may write and the folder has a version. */
export function writeOffered(role: Role, m: Mount, hasVersion: boolean): boolean {
  return hasVersion && writeAllowed(role, m);
}

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * A pending (client-side, empty) folder is real once a listing shows it, i.e. a file landed in
 * it: it leaves the pending set. The same array comes back when nothing changes.
 */
export function prunePendingDirs(pending: string[] | undefined, listedDirs: string[]): string[] | undefined {
  if (!pending) return pending;
  const listed = new Set(listedDirs);
  const kept = pending.filter((p) => !listed.has(p));
  return kept.length === pending.length ? pending : kept;
}

/**
 * What the tree needs from the screen to offer writes: which mounts are writable, the selection,
 * the client-side pending folders, drops, and a version that bumps when a change lands. The
 * default offers nothing, so the tree renders read-only without a provider.
 */
interface TreeControl {
  version: number;
  writable: (mount: string) => boolean;
  isChecked: (mount: string, path: string) => boolean;
  check: (mount: string, path: string, on: boolean) => void;
  /** pending (empty, client-side) folders directly under `dir` */
  pendingUnder: (mount: string, dir: string) => string[];
  /** listed folders, remembered as move targets (and no longer pending) */
  noteDirs: (mount: string, dirs: string[]) => void;
  drop: (mount: string, dir: string, e: DragEvent) => void;
  /** a folder without a first version: what to say instead of `no_accepted_head` (phase 4 setup) */
  setupNote: (mount: string) => FolderSetupNote;
  /** a root listing answered: `false` for `no_accepted_head` (the folder is read-only until it has a version) */
  noteHead: (mount: string, has: boolean) => void;
}

const READ_ONLY: TreeControl = {
  setupNote: () => folderSetupNote(undefined, false),
  noteHead: () => undefined,
  version: 0,
  writable: () => false,
  isChecked: () => false,
  check: () => undefined,
  pendingUnder: () => [],
  noteDirs: () => undefined,
  drop: () => undefined,
};

const TreeControlContext = createContext<TreeControl>(READ_ONLY);

/** Drag-over and drop handlers for a drop target: only where the viewer may write. */
function dropTarget(ctl: TreeControl, mount: string, dir: string, setOver?: (b: boolean) => void) {
  // a folder the viewer can't write takes no drop (and does not pass it to the folder around it)
  if (!ctl.writable(mount))
    return {
      onDragOver: (e: DragEvent) => e.stopPropagation(),
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
      },
    };
  return {
    onDragOver: (e: DragEvent) => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      setOver?.(true);
    },
    onDragLeave: () => setOver?.(false),
    onDrop: (e: DragEvent) => {
      e.stopPropagation();
      setOver?.(false);
      ctl.drop(mount, dir, e);
    },
  };
}

function TreeDir({ mount, path, depth, selected, onSelect }: { mount: string; path: string; depth: number; selected: { mount?: string; path?: string }; onSelect: (mount: string, entry: TreeEntry) => void }) {
  const { api } = useApp();
  const { org, pid } = useProject();
  const ctl = useContext(TreeControlContext);
  const list = useLoad(() => api.listTree(org, pid, { mount, path }), `${mount}:${path}:${ctl.version}`);
  const dirsKey = list.data?.entries.filter((e) => e.type === "dir").map((e) => e.path).join("\n") ?? "";
  useEffect(() => {
    if (dirsKey) ctl.noteDirs(mount, dirsKey.split("\n"));
  }, [ctl, mount, dirsKey]);
  const noHead = list.error instanceof ApiError && list.error.code === "no_accepted_head";
  const answered = noHead || !!list.data;
  useEffect(() => {
    if (path === "" && answered) ctl.noteHead(mount, !noHead);
  }, [ctl, mount, path, answered, noHead]);
  const setup = noHead ? ctl.setupNote(mount) : null;
  if (setup) return <FolderSetupNoteView note={setup} />;
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;
  if (!list.data) return <div className="tree-loading" style={{ paddingLeft: depth * 16 + 8 }}>Loading…</div>;
  const listed = new Set(list.data.entries.map((e) => e.path));
  const pending = ctl.pendingUnder(mount, path).filter((p) => !listed.has(p));
  const entries: TreeEntry[] = [...pending.map((p) => ({ path: p, type: "dir" })), ...list.data.entries];
  if (entries.length === 0) return <div className="tree-empty muted small" style={{ paddingLeft: depth * 16 + 8 }}>Empty</div>;
  return (
    <ul className="tree-list" role="group">
      {entries.map((e) => (
        <TreeItem key={e.path} mount={mount} entry={e} depth={depth} pending={pending.includes(e.path)} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}

export interface FolderSetupNote {
  tone: "busy" | "bad" | "plain";
  text: string;
}

/**
 * What to say for a folder whose listing answered `no_accepted_head` (no first version yet, phase
 * 4): while its setup runs, say so; when it failed, show the setup error; otherwise (a ZIP-planned
 * empty folder, or a client or viewer, who can't read the folder list) a neutral sentence, never
 * the raw error.
 */
export function folderSetupNote(resource: Pick<ResourceDetail, "state" | "error"> | undefined, settingUp: boolean | undefined): FolderSetupNote {
  if (settingUp) return { tone: "busy", text: "This folder is being set up. It will be ready in a few seconds." };
  if (resource?.state === "failed") return { tone: "bad", text: resource.error ?? "Setting up this folder failed." };
  return { tone: "plain", text: "This folder has no files yet." };
}

export function FolderSetupNoteView({ note }: { note: FolderSetupNote }) {
  return (
    <div className={note.tone === "plain" ? "note" : `note note-${note.tone}`} role="status">
      {note.text}
    </div>
  );
}

export interface TreeRowViewProps {
  entry: TreeEntry;
  depth: number;
  active: boolean;
  open: boolean;
  /** the viewer may write this folder: a checkbox selects the row */
  canWrite: boolean;
  checked: boolean;
  /** a folder made here that holds no file yet */
  pending?: boolean;
  over?: boolean;
  onClick: () => void;
  onCheck: (on: boolean) => void;
}

/** One row of the tree: name (as text), LFS tag, real size, and with write access a selection checkbox. */
export function TreeRowView({ entry, depth, active, open, canWrite, checked, pending, over, onClick, onCheck }: TreeRowViewProps) {
  const isDir = entry.type === "dir";
  const name = basename(entry.path);
  return (
    <>
      <div className={`tree-row-wrap ${over ? "tree-drop-over" : ""}`.trim()}>
        <button type="button" className={`tree-row ${active ? "tree-row-active" : ""}`} style={{ paddingLeft: depth * 16 + 8 }} onClick={onClick}>
          <span className={`caret ${isDir ? (open ? "caret-open" : "") : "caret-none"}`} aria-hidden="true">
            ▸
          </span>
          <span className="tree-name">{name}</span>
          {entry.lfs ? (
            <span className="tag tag-lfs" title="Stored in Git LFS: the size is the real file's">
              LFS
            </span>
          ) : null}
          {!isDir && entry.size !== undefined ? <span className="tree-size">{formatBytes(entry.size)}</span> : null}
        </button>
        {canWrite && !pending ? <input type="checkbox" className="tree-check" aria-label={`Select ${name}`} checked={checked} onChange={(e) => onCheck(e.target.checked)} /> : null}
      </div>
      {pending ? (
        <div className="tree-empty muted small" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>
          Upload a file to keep this folder
        </div>
      ) : null}
    </>
  );
}

function TreeItem({ mount, entry, depth, pending, selected, onSelect }: { mount: string; entry: TreeEntry; depth: number; /** a folder made here, not (yet) listed */ pending: boolean; selected: { mount?: string; path?: string }; onSelect: (mount: string, entry: TreeEntry) => void }) {
  const ctl = useContext(TreeControlContext);
  const isDir = entry.type === "dir";
  const inSelection = selected.mount === mount && !!selected.path && selected.path.startsWith(`${entry.path}/`);
  const [open, setOpen] = useState(inSelection);
  const [over, setOver] = useState(false);
  const active = selected.mount === mount && selected.path === entry.path;
  return (
    <li role="treeitem" aria-expanded={isDir ? open : undefined} aria-selected={active} {...(isDir ? dropTarget(ctl, mount, entry.path, setOver) : {})}>
      <TreeRowView
        entry={entry}
        depth={depth}
        active={active}
        open={open}
        canWrite={ctl.writable(mount)}
        checked={ctl.isChecked(mount, entry.path)}
        pending={pending}
        over={over}
        onClick={() => {
          if (isDir) setOpen(!open);
          onSelect(mount, entry);
        }}
        onCheck={(on) => ctl.check(mount, entry.path, on)}
      />
      {isDir && open && !pending ? <TreeDir mount={mount} path={entry.path} depth={depth + 1} selected={selected} onSelect={onSelect} /> : null}
    </li>
  );
}

function MountRoot({ m, entry, selected, onSelectMount, onSelect }: { m: Mount; entry: SnapshotEntry | undefined; selected: { mount?: string; path?: string }; onSelectMount: (m: string) => void; onSelect: (mount: string, e: TreeEntry) => void }) {
  const ctl = useContext(TreeControlContext);
  const [open, setOpen] = useState(selected.mount === m.mountName);
  const [over, setOver] = useState(false);
  const active = selected.mount === m.mountName && !selected.path;
  const kind = providerKind(m.provider);
  return (
    <li role="treeitem" aria-expanded={open} {...dropTarget(ctl, m.mountName, "", setOver)}>
      <button
        type="button"
        className={`tree-row tree-root ${active ? "tree-row-active" : ""} ${over ? "tree-drop-over" : ""}`}
        onClick={() => {
          setOpen(!open || !active);
          onSelectMount(m.mountName);
        }}
      >
        <span className={`caret ${open ? "caret-open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <MountIcon m={m} />
        <span className="tree-name">{m.resourceName}</span>
        <span className={`tag tag-${kind}`}>{kind === "assets" ? "R2" : "Git"}</span>
      </button>
      {open ? <TreeDir mount={m.mountName} path="" depth={1} selected={selected} onSelect={onSelect} /> : null}
    </li>
  );
}

export function ProjectTree({ project, snapshot, selected, onSelectMount, onSelect }: { project: Project; snapshot: ProjectSnapshot | undefined; selected: { mount?: string; path?: string }; onSelectMount: (m: string) => void; onSelect: (mount: string, e: TreeEntry) => void }) {
  const entries = new Map(snapshot?.entries.map((e) => [e.mountName, e]) ?? []);
  return (
    <div className="tree" role="tree" aria-label="Project files">
      {groupMounts(project.mounts).map((g) => (
        <div key={g.label} className="tree-group">
          <div className="tree-group-label">{g.label}</div>
          <ul className="tree-list">
            {g.mounts.map((m) => (
              <MountRoot key={m.mountName} m={m} entry={entries.get(m.mountName)} selected={selected} onSelectMount={onSelectMount} onSelect={onSelect} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="kv-row">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** What a resource really is: provider, revision, mode, and (developers) coordinates and origin. */
export function ResourceInspectorView({ mount, entry, resource, developer }: { mount: Mount; entry: SnapshotEntry | undefined; resource: ResourceDetail | undefined; developer: boolean }) {
  const source = resource?.source as Record<string, unknown> | null | undefined;
  return (
    <dl className="kv">
      <Row k="Folder">{mount.mountName}</Row>
      <Row k="Stored in">{providerLabel(mount.provider)}</Row>
      <Row k="Accepted revision">
        <code title={developer ? entry?.revisionId : undefined}>{revisionLabel(entry?.revisionId)}</code>
        {resource?.head ? <span className="muted small"> · version {resource.head.versionSeq}, {formatTime(resource.head.acceptedAt)}</span> : null}
      </Row>
      <Row k="Role in project">{mount.mode === "pinned-reference" ? "Reference (pinned)" : "Must match accepted"}</Row>
      <Row k="Your access">{mount.operations.join(" + ")}</Row>
      {developer ? (
        <>
          <Row k="Resource id">
            <code>{mount.resourceId}</code>
          </Row>
          {resource?.coords ? (
            <Row k="Coordinates">
              <code className="wrap">{Object.entries(resource.coords).filter(([k]) => k !== "kind").map(([k, v]) => `${k}: ${String(v)}`).join("\n")}</code>
            </Row>
          ) : null}
          {source ? (
            <Row k="Origin">
              <code className="wrap">{Object.entries(source).map(([k, v]) => `${k}: ${String(v)}`).join("\n")}</code>
            </Row>
          ) : null}
          {entry ? (
            <Row k="Full revision">
              <code className="wrap">{entry.revisionId}</code>
            </Row>
          ) : null}
          {resource?.head ? <Row k="Git projection">{resource.head.reconciliation}</Row> : null}
        </>
      ) : null}
    </dl>
  );
}

/** Developers: the selected resource's identity in the inspector drawer, with copy buttons. */
export function filesInspector(mount: Mount | undefined, entry: SnapshotEntry | undefined, resource: ResourceDetail | undefined, snapshotId: string | undefined, path: string | undefined): InspectorSection[] {
  const out: InspectorSection[] = [];
  if (snapshotId) out.push({ title: "Snapshot", rows: [{ label: "Snapshot", value: shortCode(snapshotId), copy: snapshotId }] });
  if (!mount) return out;
  const rows: InspectorSection["rows"] = [
    { label: "Resource", value: mount.resourceId, copy: mount.resourceId },
    { label: "Provider", value: mount.provider },
  ];
  if (entry) rows.push({ label: "Revision", value: revisionLabel(entry.revisionId), copy: entry.revisionId });
  if (resource?.head) rows.push({ label: "Accepted version", value: `seq ${resource.head.versionSeq} · ${resource.head.reconciliation}` });
  if (path) rows.push({ label: "Path", value: `${mount.mountName}/${path}`, copy: `${mount.mountName}/${path}` });
  out.unshift({ title: mount.resourceName, rows });
  return out;
}

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

/**
 * Images are shown from a `data:` URL, never a `blob:` URL (review I-1): a blob URL opened in a
 * new tab inherits this origin, so an SVG written by an agent could run script with the session.
 * Browsers refuse top-level navigation to `data:` URLs, and `<img>` never runs SVG script.
 */
export async function imageDataUrl(blob: Blob, path: string): Promise<string> {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${IMAGE_MIME[ext] ?? "application/octet-stream"};base64,${btoa(bin)}`;
}

function FilePreview({ mount, path, size, version }: { mount: string; path: string; size: number | undefined; version: number }) {
  const { api } = useApp();
  const { org, pid } = useProject();
  const [state, setState] = useState<{ text?: string; image?: string; error?: unknown }>({});
  const previewable = (size ?? 0) <= PREVIEW_LIMIT && (looksLikeText(path) || looksLikeImage(path));
  useEffect(() => {
    if (!previewable) return;
    let live = true;
    setState({});
    api
      .readFile(org, pid, { mount, path })
      .then(async (blob) => {
        if (!live) return;
        if (looksLikeImage(path)) {
          const url = await imageDataUrl(blob, path);
          if (live) setState({ image: url });
        } else {
          const text = await blob.text();
          if (live) setState({ text });
        }
      })
      .catch((error: unknown) => live && setState({ error }));
    return () => {
      live = false;
    };
  }, [api, org, pid, mount, path, previewable, version]);
  if (!previewable) return <p className="muted small">No preview for this file type or size. Download it to open it.</p>;
  if (state.error) return <ErrorNote error={state.error} />;
  if (state.image) return <img className="preview-image" src={state.image} alt={basename(path)} referrerPolicy="no-referrer" />;
  if (state.text !== undefined) return <pre className="preview-text">{state.text}</pre>;
  return <Loading what="Loading preview" />;
}

// ------------------------------------------------------------------------------ write affordances

export interface FilesToolbarViewProps {
  mount: Mount;
  /** the folder uploads go into ("" at the mount's top) */
  dir: string;
  canWrite: boolean;
  /** a git folder: New file is offered (file collections take uploads only) */
  editable: boolean;
  onUpload: (files: PickedFile[]) => void;
  onUploadFolder: (files: PickedFile[]) => void;
  onNewFolder: () => void;
  onNewFile?: (() => void) | undefined;
}

/** Upload files, Upload folder, New folder (and New file for git folders). Nothing without write access. */
export function FilesToolbarView({ mount, dir, canWrite, editable, onUpload, onUploadFolder, onNewFolder, onNewFile }: FilesToolbarViewProps) {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  if (!canWrite) return null;
  const take = (e: ChangeEvent<HTMLInputElement>, to: (f: PickedFile[]) => void) => {
    const list = e.target.files;
    const picked = list && list.length > 0 ? filesFromInput(list) : [];
    e.target.value = "";
    if (picked.length > 0) to(picked);
  };
  return (
    <form className="files-toolbar" aria-label="Upload" onSubmit={(e) => e.preventDefault()}>
      <span className="files-toolbar-target small muted">
        Into <code>{dir ? `${mount.mountName}/${dir}` : mount.mountName}</code>
      </span>
      <button type="button" className="btn btn-primary btn-small" onClick={() => filesRef.current?.click()}>
        <Icon name="upload" size={14} /> Upload files
      </button>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => folderRef.current?.click()}>
        <Icon name="upload" size={14} /> Upload folder
      </button>
      <button type="button" className="btn btn-quiet btn-small" onClick={onNewFolder}>
        <Icon name="plus" size={14} /> New folder
      </button>
      {editable && onNewFile ? (
        <button type="button" className="btn btn-quiet btn-small" onClick={onNewFile}>
          <Icon name="pencil" size={14} /> New file
        </button>
      ) : null}
      <input ref={filesRef} type="file" multiple hidden aria-label="Files to upload" onChange={(e) => take(e, onUpload)} />
      <input ref={folderRef} type="file" multiple hidden aria-label="Folder to upload" {...{ webkitdirectory: "" }} onChange={(e) => take(e, onUploadFolder)} />
    </form>
  );
}

export interface FileRowActionsProps {
  mount: Mount;
  entry: TreeEntry;
  canWrite: boolean;
  /** `api.fileUrl`: a plain link (attachment, nosniff) */
  downloadHref: string;
  onReplace: () => void;
  onMove: () => void;
  onDelete: () => void;
  /** offered only where `canEditInPlace` holds */
  onEdit?: (() => void) | undefined;
}

/** A file's (or folder's) actions: Download for everyone; Replace, Rename or move, Delete and Edit with write access. */
export function FileRowActions({ mount, entry, canWrite, downloadHref, onReplace, onMove, onDelete, onEdit }: FileRowActionsProps) {
  const isDir = entry.type === "dir";
  return (
    <div className="file-actions" role="group" aria-label={`Actions for ${basename(entry.path)}`}>
      {!isDir ? (
        <a className="btn btn-quiet btn-small" href={downloadHref} download={basename(entry.path)}>
          <Icon name="download" size={14} /> Download
        </a>
      ) : null}
      {canWrite ? (
        <>
          {onEdit && !isDir && canEditInPlace(mount, entry) ? (
            <button type="button" className="btn btn-quiet btn-small" onClick={onEdit}>
              Edit
            </button>
          ) : null}
          {!isDir ? (
            <button type="button" className="btn btn-quiet btn-small" onClick={onReplace}>
              Replace
            </button>
          ) : null}
          <button type="button" className="btn btn-quiet btn-small" onClick={onMove}>
            Rename or move
          </button>
          <button type="button" className="btn btn-quiet btn-small" onClick={onDelete}>
            Delete
          </button>
        </>
      ) : null}
    </div>
  );
}

/** With rows checked: Move and Delete for all of them. */
export function SelectionBarView({ count, onMove, onDelete, onClear }: { count: number; onMove: () => void; onDelete: () => void; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div className="selection-bar" role="group" aria-label="Selected files">
      <span className="small">{count} selected</span>
      <button type="button" className="btn btn-quiet btn-small" onClick={onMove}>
        Move
      </button>
      <button type="button" className="btn btn-quiet btn-small" onClick={onDelete}>
        Delete
      </button>
      <button type="button" className="btn btn-quiet btn-small" onClick={onClear}>
        Clear selection
      </button>
    </div>
  );
}

type Sheet = { kind: "move"; mount: string; paths: string[] } | { kind: "delete"; mount: string; paths: string[] } | { kind: "newFolder"; mount: string; dir: string } | { kind: "replace"; mount: string; path: string };

export function FilesScreen({ mount, path, edit, isNew }: { mount?: string | undefined; path?: string | undefined; /** `?edit=1`: the file at `path` in the editor */ edit?: boolean | undefined; /** `?new=1`: a new file in the folder `path` */ isNew?: boolean | undefined }) {
  const { api } = useApp();
  const { org, pid, project, role, reloadProject } = useProject();
  const [version, setVersion] = useState(0);
  const snapshot = useLoad(() => api.getSnapshot(org, pid), `${org}/${pid}:${version}`);
  const [picked, setFile] = useState<TreeEntry | null>(null);
  const selectedMount = project.mounts.find((m) => m.mountName === mount);
  // deep link (?mount=&path=): find out whether the path is a file from its parent listing
  const parentPath = path && path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const parent = useLoad(
    () => (selectedMount && path ? api.listTree(org, pid, { mount: selectedMount.mountName, path: parentPath }) : Promise.resolve(undefined)),
    `${mount ?? ""}:${parentPath}:${path ?? ""}:${version}`,
  );
  const linked = parent.data?.entries.find((e) => e.path === path && e.type !== "dir") ?? null;
  // a landed change re-reads the listing: the fresh entry (size, lfs) wins over the clicked one
  const file = linked ?? (picked && picked.path === path ? picked : null);
  const resource = useLoad(() => (selectedMount ? api.getResource(org, selectedMount.resourceId) : Promise.resolve(undefined)), `${selectedMount?.resourceId ?? "none"}:${version}`);
  const entry = snapshot.data?.entries.find((e) => e.mountName === mount);
  const developer = isDeveloperRole(role);
  // a selected folder with no version yet (not in the snapshot): is it being set up? (the folder
  // list says, for owners and developers; polled every 2 s while it is, then everything re-reads)
  const unversioned = !!selectedMount && !!snapshot.data && !entry;
  const watched = developer && unversioned ? (mount ?? "") : "";
  const [settingUp, setSettingUp] = useState(false);
  const folders = useLoad(
    () => (watched ? api.listFolders(org, pid) : Promise.resolve(undefined)),
    `${org}/${pid}/setup/${watched}/${version}`,
    settingUp ? SETUP_POLL_MS : undefined,
  );
  const nowSettingUp = !!folders.data?.find((f) => f.mountName === mount)?.settingUp;
  const known = folders.data !== undefined;
  useEffect(() => {
    // another folder chosen (or this one got its version): stop, without re-reading everything
    if (!watched) {
      if (settingUp) setSettingUp(false);
      return;
    }
    const next = setupPollStep(settingUp, known, nowSettingUp);
    if (next.polling !== settingUp) setSettingUp(next.polling);
    if (next.finished) setVersion((v) => v + 1);
  }, [watched, known, nowSettingUp, settingUp]);
  const setupNote = folderSetupNote(resource.data, nowSettingUp);
  const go = (m: string, p?: string, force = false) => navigate(projectHref(org, pid, "files", { mount: m, path: p }), { replace: true, force });
  useInspectorSections(developer ? filesInspector(selectedMount, entry, resource.data, snapshot.data?.snapshotId, path) : null, `${developer}|${selectedMount?.mountName}|${entry?.revisionId}|${resource.data ? "r" : ""}|${snapshot.data?.snapshotId}|${path}`);

  // ---- uploads: the project frame's queue (switching tabs keeps them going; the frame cancels on leaving)
  const queue = useUploads();
  const [tray, setTray] = useState<UploadQueueState>({ items: [], batches: [] });
  useEffect(() => queue.subscribe(setTray), [queue]);

  // ---- single actions (move, delete, a saved edit) show in the tray as batches with no items (`queue.track`)
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [selection, setSelection] = useState<{ mount: string; paths: string[] }>({ mount: "", paths: [] });
  // a message from the editor (e.g. the file can't be edited here), shown above the tree
  const [editNote, setEditNote] = useState<string | null>(null);
  const [pendingDirs, setPendingDirs] = useState<Record<string, string[]>>({});
  // folders whose root listing answered no_accepted_head: read-only until a listing answers
  const [noHead, setNoHead] = useState<ReadonlySet<string>>(() => new Set());
  const knownDirs = useRef(new Map<string, Set<string>>());
  // one idempotency key per action, the same when it is confirmed again after an error (a lost reply makes no second change)
  const actKey = useRef(new RetryKey());
  const act = useAction(async (mountName: string, ops: FileChangeOp[], title: string) => {
    const c = await api.createFileChange(org, pid, mountName, { ops, title, idempotencyKey: actKey.current.for(JSON.stringify([mountName, ops])) });
    actKey.current.done();
    queue.track(c);
    setSheet(null);
    setSelection({ mount: "", paths: [] });
  });

  // ---- change status: polled every 1.5 s while a shown change is being added or checked, 15 s while they only wait for approval, 60 s while they are only on staging
  const listed = useLoad(() => (developer ? api.listFileChanges(org, pid, { limit: 50 }) : Promise.resolve([] as FileChange[])), `${org}/${pid}/file-changes/${developer}`, undefined);
  const polled = new Map((listed.data ?? []).map((c) => [c.changeId, c]));
  const trayBatches = tray.batches.map((b) => (b.changeId && polled.has(b.changeId) ? { ...b, change: polled.get(b.changeId)! } : b));
  const inTray = new Set(trayBatches.map((b) => b.changeId).filter((x): x is string => !!x));
  const others = (listed.data ?? []).filter((c) => isOpenChange(c) && !inTray.has(c.changeId) && (!mount || c.mountName === mount));
  const shown = [...trayBatches.map((b) => b.change).filter((c): c is FileChange => !!c), ...others];
  const pollMs = developer ? changePollMs(shown) : null;
  const reloadChanges = listed.reload;
  useEffect(() => {
    if (pollMs === null) return;
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") reloadChanges();
    }, pollMs);
    return () => clearInterval(id);
  }, [pollMs, reloadChanges]);
  // a change this tab just started is read at once, not a tick later
  const startedKey = [...inTray].join(",");
  useEffect(() => {
    if (startedKey && developer) reloadChanges();
  }, [startedKey, developer, reloadChanges]);
  // a change turning `added` reloads the tree, the snapshot and the project
  const seen = useRef(new Map<string, FileChange["state"]>());
  const statesKey = shown.map((c) => `${c.changeId}:${c.state}`).join(",");
  useEffect(() => {
    let landed = false;
    for (const c of shown) {
      const before = seen.current.get(c.changeId);
      if (before !== undefined && before !== "added" && c.state === "added") landed = true;
      seen.current.set(c.changeId, c.state);
    }
    if (landed) {
      // the clicked entry may be gone (moved, deleted) or stale (replaced): the re-read listing decides
      setFile(null);
      setVersion((v) => v + 1);
      reloadProject?.();
    }
    // `shown` is read when its states change, by design
  }, [statesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- where the toolbar uploads go, and what the tree may offer
  const hasVersion = (m: string) => mountHasVersion(snapshot.data, m, noHead);
  const canWrite = selectedMount ? writeOffered(role, selectedMount, hasVersion(selectedMount.mountName)) : false;
  const pendingHere = (m: string, p: string) => (pendingDirs[m] ?? []).includes(p);
  const selectedIsDir = !!path && !file && (pendingHere(mount ?? "", path) || !!parent.data?.entries.some((e) => e.path === path && e.type === "dir"));
  // a file (or a path not known to be a folder, e.g. one a change just moved) uploads next to it
  const dir = !path ? "" : selectedIsDir ? path : parentOf(path);
  const enqueue = (m: string, into: string, files: PickedFile[]) => {
    if (files.length > 0) queue.add(m, into, files);
  };
  const writableMounts = new Set(project.mounts.filter((m) => writeOffered(role, m, hasVersion(m.mountName))).map((m) => m.mountName));
  const control: TreeControl = {
    setupNote: (m) => (m === selectedMount?.mountName ? setupNote : folderSetupNote(undefined, false)),
    noteHead: (m, has) =>
      setNoHead((s) => {
        if (s.has(m) === !has) return s;
        const next = new Set(s);
        if (has) next.delete(m);
        else next.add(m);
        return next;
      }),
    version,
    writable: (m) => writableMounts.has(m),
    isChecked: (m, p) => selection.mount === m && selection.paths.includes(p),
    check: (m, p, on) =>
      setSelection((s) => {
        const base = s.mount === m ? s.paths : [];
        return { mount: m, paths: on ? [...base.filter((x) => x !== p), p] : base.filter((x) => x !== p) };
      }),
    pendingUnder: (m, d) => (pendingDirs[m] ?? []).filter((p) => parentOf(p) === d),
    noteDirs: (m, dirs) => {
      let set = knownDirs.current.get(m);
      if (!set) knownDirs.current.set(m, (set = new Set()));
      for (const d of dirs) set.add(d);
      // a file landed in a pending folder: it is a real one now (rows, actions, uploads into it)
      setPendingDirs((all) => {
        const kept = prunePendingDirs(all[m], dirs);
        return kept === all[m] ? all : { ...all, [m]: kept ?? [] };
      });
    },
    drop: (m, into, e) => {
      e.preventDefault();
      const items = e.dataTransfer?.items;
      if (items && items.length > 0) void filesFromDrop(items).then((files) => enqueue(m, into, files));
      else if (e.dataTransfer?.files.length) enqueue(m, into, filesFromInput(e.dataTransfer.files));
    },
  };
  const dirsOf = (m: string) => [...new Set([...(knownDirs.current.get(m) ?? []), ...(pendingDirs[m] ?? [])])].sort();

  // adding folders is owner-only (like adding a mount); developers see the files, not the action
  const owner = role === "owner";
  const addFiles = owner ? (
    <Link className="btn btn-quiet btn-small" href={intakeHref(org, pid)}>
      <Icon name="plus" size={14} /> Add files
    </Link>
  ) : null;
  if (project.mounts.length === 0) {
    return (
      <EmptyState
        icon="files"
        title="This project has no files yet."
        action={
          owner ? (
            <Link className="btn btn-primary" href={intakeHref(org, pid)}>
              <Icon name="plus" size={16} /> Add files
            </Link>
          ) : undefined
        }
      >
        {owner ? (
          <>
            Import a public Git repository (it keeps its history), or add a ZIP of what you have: it is checked first, and its folders are created empty for now. <Link href={projectHref(org, pid, "overview")}>See the getting-started steps</Link>
          </>
        ) : developer ? (
          "The project owner adds the project's files. They will appear here."
        ) : (
          "Your developer adds the project's files. They will appear here."
        )}
      </EmptyState>
    );
  }

  const closeSheet = () => {
    setSheet(null);
    act.clearError();
  };
  const sheetView = (() => {
    if (!sheet) return null;
    if (sheet.kind === "move") return <MoveSheetView key={sheet.paths.join("\n")} paths={sheet.paths} knownDirs={dirsOf(sheet.mount)} busy={act.busy} error={act.error} onSubmit={(ops, title) => void act.run(sheet.mount, ops, title)} onCancel={closeSheet} />;
    if (sheet.kind === "delete") return <DeleteSheetView paths={sheet.paths} busy={act.busy} error={act.error} onConfirm={(ops, title) => void act.run(sheet.mount, ops, title)} onCancel={closeSheet} />;
    if (sheet.kind === "newFolder")
      return (
        <NewFolderSheetView
          dir={sheet.dir}
          onCreate={(p) => {
            setPendingDirs((all) => ({ ...all, [sheet.mount]: [...new Set([...(all[sheet.mount] ?? []), p])] }));
            setSheet(null);
            go(sheet.mount, p);
          }}
          onCancel={closeSheet}
        />
      );
    return (
      <ReplaceSheetView
        path={sheet.path}
        onFile={(f) => {
          queue.add(sheet.mount, parentOf(sheet.path), [{ file: f, relPath: basename(sheet.path), mime: f.type }], { replace: sheet.path });
          setSheet(null);
        }}
        onCancel={closeSheet}
      />
    );
  })();

  const selectedEntry: TreeEntry | null = file ?? (selectedIsDir && path ? { path, type: "dir" } : null);
  const rowActions = (e: TreeEntry, m: Mount) => (
    <FileRowActions
      mount={m}
      entry={e}
      canWrite={canWrite && !pendingHere(m.mountName, e.path)}
      downloadHref={api.fileUrl(org, pid, { mount: m.mountName, path: e.path })}
      onReplace={() => setSheet({ kind: "replace", mount: m.mountName, path: e.path })}
      onMove={() => setSheet({ kind: "move", mount: m.mountName, paths: [e.path] })}
      onDelete={() => setSheet({ kind: "delete", mount: m.mountName, paths: [e.path] })}
      onEdit={() => {
        setEditNote(null);
        navigate(projectHref(org, pid, "files", { mount: m.mountName, path: e.path, edit: true }));
      }}
    />
  );
  const editing = !!selectedMount && canWrite && ((edit && !!path) || (isNew && selectedMount.provider === "artifacts"));
  // leaving the editor: back to the file (or folder); a saved change shows in the tray, an added one reloads the tree
  const exitEditor = (r: EditExit) => {
    if (r.change) {
      const c = r.change;
      queue.track(c);
      if (c.state === "added") {
        setFile(null);
        setVersion((v) => v + 1);
        reloadProject?.();
      }
    }
    setEditNote(r.note ?? null);
    // forced: the editor asked about unsaved text itself (its guard is still set until it unmounts)
    if (selectedMount) go(selectedMount.mountName, r.path, true);
  };

  return (
    <>
    <div className="files-head">
      {/* hidden while editing: a chip would leave the editor (its unsaved text) in one click */}
      {editing ? null : (
        <ResourceChips mounts={project.mounts} selected={mount} onSelect={(m) => {
          setFile(null);
          go(m);
        }} />
      )}
      {addFiles}
    </div>
    <div className="files-work">
      {editNote ? (
        <div className="note note-bad" role="alert">
          <span>{editNote}</span>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => setEditNote(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {selectedMount && !editing ? (
        <FilesToolbarView
          mount={selectedMount}
          dir={dir}
          canWrite={canWrite}
          editable={selectedMount.provider === "artifacts"}
          onUpload={(f) => enqueue(selectedMount.mountName, dir, f)}
          onUploadFolder={(f) => enqueue(selectedMount.mountName, dir, f)}
          onNewFolder={() => setSheet({ kind: "newFolder", mount: selectedMount.mountName, dir })}
          onNewFile={() => {
            setEditNote(null);
            navigate(projectHref(org, pid, "files", { mount: selectedMount.mountName, path: dir || undefined, new: true }));
          }}
        />
      ) : null}
      <SelectionBarView
        count={selection.paths.length}
        onMove={() => setSheet({ kind: "move", mount: selection.mount, paths: [...selection.paths].sort() })}
        onDelete={() => setSheet({ kind: "delete", mount: selection.mount, paths: [...selection.paths].sort() })}
        onClear={() => setSelection({ mount: "", paths: [] })}
      />
      {sheetView}
      {listed.error && developer ? <ErrorNote error={listed.error} onRetry={listed.reload} /> : null}
      <ChangeStatusList org={org} pid={pid} changes={others} />
      <UploadTrayView
        org={org}
        pid={pid}
        items={tray.items}
        batches={trayBatches}
        onCancel={(id) => queue.cancel(id)}
        onRetry={(id) => queue.retry(id)}
        onRemove={(id) => queue.remove(id)}
        onDismiss={(id) => queue.dismiss(id)}
        onResend={(id) => queue.resend(id)}
      />
    </div>
    {editing && selectedMount ? (
      <EditFileScreen key={`${selectedMount.mountName}:${path ?? ""}:${edit ? "edit" : "new"}`} mount={selectedMount} path={edit ? path! : (path ?? "")} isNew={!edit} onExit={exitEditor} />
    ) : (
      <div className="browser">
        <aside className="browser-tree" {...(selectedMount ? dropTarget(control, selectedMount.mountName, dir) : {})}>
          {snapshot.error ? <ErrorNote error={snapshot.error} onRetry={snapshot.reload} /> : null}
          <TreeControlContext.Provider value={control}>
            <ProjectTree
              project={project}
              snapshot={snapshot.data}
              selected={{ mount, path }}
              onSelectMount={(m) => {
                setFile(null);
                go(m);
              }}
              onSelect={(m, e) => {
                setFile(e.type === "dir" ? null : e);
                go(m, e.path);
              }}
            />
          </TreeControlContext.Provider>
          {snapshot.data ? (
            <p className="muted small snapshot-note">{snapshot.data.entries.length} resources pinned at their accepted versions</p>
          ) : null}
        </aside>
        <div className="browser-inspector">
          {!selectedMount ? (
            <Card title="Source inspector">
              <p>Select a folder or file to see where it lives. Each top-level folder is a separate, independently versioned resource: code in Artifacts repositories, large media in R2.</p>
            </Card>
          ) : (
            <>
              {file && path ? (
                <Card title={basename(path)} aside={rowActions(file, selectedMount)}>
                  <dl className="kv">
                    <Row k="Path">
                      <code>
                        {selectedMount.mountName}/{path}
                      </code>
                    </Row>
                    {file.size !== undefined ? <Row k="Size">{formatBytes(file.size)}</Row> : null}
                    {file.lfs ? <Row k="Stored as">Git LFS (the size and download are the real file)</Row> : null}
                    <Row k="Read from">
                      {providerLabel(selectedMount.provider)} at <code>{revisionLabel(entry?.revisionId)}</code>
                    </Row>
                  </dl>
                  <FilePreview mount={selectedMount.mountName} path={path} size={file.size} version={version} />
                </Card>
              ) : selectedEntry && canWrite && !pendingHere(selectedMount.mountName, selectedEntry.path) ? (
                <Card title={basename(selectedEntry.path)} aside={rowActions(selectedEntry, selectedMount)}>
                  <p className="muted small">
                    Folder <code>{selectedMount.mountName}/{selectedEntry.path}</code>. Uploads go here.
                  </p>
                </Card>
              ) : null}
              <Card title={<>Source · {selectedMount.resourceName}</>}>
                {resource.error ? <ErrorNote error={resource.error} /> : null}
                <ResourceInspectorView mount={selectedMount} entry={entry} resource={resource.data} developer={developer} />
              </Card>
            </>
          )}
        </div>
      </div>
    )}
    </>
  );
}
