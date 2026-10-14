/**
 * Settings → Folders (admin screens spec §6): what's attached, plus add, attach (owners) and detach
 * (owners). Phase 4: one kind of folder. Add folder takes a name only; the folder sets itself up
 * (its first version) in a few seconds, and a failed setup offers Try again.
 */
import { useEffect, useId, useState } from "react";
import { MountNameSchema } from "@commonforge-org/core";
import type { PersonAccess, ProjectFolder, Resource, Role } from "../api/types.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import { intakeHref } from "../lib/router.js";
import { ConfirmSheet, EmptyState } from "../primitives/index.js";
import { ErrorNote, Link, Loading } from "../ui.js";
import { useProject } from "./project-data.js";

const STATE: Record<ProjectFolder["state"], string> = { empty: "Empty", importing: "Importing", active: "Ready", failed: "Failed" };

/** while any folder is setting up, the list is read again this often */
export const SETUP_POLL_MS = 2000;

/** A row's state word: a pending setup is "Setting up…" (its state is still `empty`); a failed one "Setup failed". */
export function folderStatus(f: Pick<ProjectFolder, "state" | "settingUp" | "setupFailed">): string {
  return f.settingUp ? "Setting up…" : f.setupFailed ? "Setup failed" : STATE[f.state];
}

/**
 * One step of the setting-up poll, on a folder-list read. `known`: the list for the current key is
 * in (false while another project's or folder's list is loading: that is no news, so polling neither
 * stops nor reports a finished setup). `finished`: polling stops because nothing is setting up any
 * more, so the caller re-reads what a first version changes.
 */
export function setupPollStep(polling: boolean, known: boolean, now: boolean): { polling: boolean; finished: boolean } {
  if (!known || now === polling) return { polling, finished: false };
  return { polling: now, finished: !now };
}

/** Why a folder name would be refused (Worker `MountNameSchema`), said before sending; null when it is fine. */
export function folderNameIssue(name: string): string | null {
  if (name.length === 0) return "Give the folder a name.";
  if (name.length > 128) return "A folder name is at most 128 characters.";
  if (name.includes("/")) return "A folder name can't contain /.";
  if (name.startsWith(".")) return "A folder name can't start with a dot (.).";
  if (!MountNameSchema.safeParse(name).success) return "That name can't be used for a folder.";
  return null;
}

export interface DetachImpact {
  /** lose the folder entirely */
  lose: string[];
  /** hold write here, keep only read through another project */
  narrowed: Array<{ email: string; keeps: "read"; via: string }>;
  /** keep their level through another project */
  keep: Array<{ email: string; via: string }>;
}

/** Everyone a detach affects: who loses the folder, who keeps only read, who keeps it through another project. Owners never change. */
export function detachImpact(people: PersonAccess[], resourceId: string): DetachImpact {
  const out: DetachImpact = { lose: [], narrowed: [], keep: [] };
  for (const p of people) {
    if (p.role === "owner") continue;
    const f = p.folders.find((x) => x.resourceId === resourceId);
    if (!f || f.level === "none") continue;
    const via = f.via ?? "another project";
    // min = what the person's other projects attaching this folder give: they keep that, never more than now
    if (!f.min || f.min === "none") out.lose.push(p.email);
    else if (f.level === "write" && f.min === "read") out.narrowed.push({ email: p.email, keeps: "read", via });
    else out.keep.push({ email: p.email, via });
  }
  return out;
}

export interface FoldersViewProps {
  org: string;
  pid: string;
  viewerRole: Role;
  folders: ProjectFolder[];
  /** org folders not in this project (owners) */
  attachable: Array<Pick<Resource, "resourceId" | "name" | "provider">>;
  /** non-owners with access to the project: who an attached folder will reach */
  peopleWithAccess: number;
  pending: { mountName: string; resourceId: string } | null;
  impact: DetachImpact | null;
  busy: boolean;
  /** bumped after a folder is created or attached: the add forms start empty again */
  formKey: number;
  error: unknown;
  onCreate: (name: string) => void;
  onAttach: (resourceId: string, mountName: string) => void;
  onAskDetach: (mountName: string, resourceId: string) => void;
  onConfirmDetach: () => void;
  onCancel: () => void;
  /** mounts the viewer may write (Mount.canWrite): a developer may Try again there (a folder with `setupFailed`); owners always may */
  writable: string[];
  onRetry: (mountName: string) => void;
  /** owners: whether the folder may be changed in this project */
  onSetWritable?: (mountName: string, writable: boolean) => void;
  /** what the last switch did (clients who lost Can change) */
  notice?: string | null;
}

export function FoldersView(p: FoldersViewProps) {
  const owner = p.viewerRole === "owner";
  return (
    <section className="folders" aria-label="Folders">
      {p.pending ? null : <ErrorNote error={p.error} />}
      {p.folders.length === 0 ? (
        <EmptyState
          compact
          icon="files"
          title="This project has no folders yet."
          action={
            p.viewerRole === "owner" ? (
              <Link href={intakeHref(p.org, p.pid)} className="btn btn-primary btn-small">
                Import from Git
              </Link>
            ) : undefined
          }
        >
          {p.viewerRole === "owner" ? "Import the site's code from a public Git repository (it keeps its history), or add an empty folder below." : "Add an empty folder below; the project owner imports existing code."}
        </EmptyState>
      ) : (
        <ul className="folder-list">
          {p.folders.map((f) => (
            <li key={f.mountName} className="folder-row">
              <div>
                <strong>{f.mountName}</strong> <span className={`small ${f.state === "failed" && !f.settingUp ? "note-inline-bad" : "muted"}`} aria-live="polite">
                  {folderStatus(f)}
                </span>
                {f.error ? <div className="small note-inline-bad">{f.error}</div> : null}
                {f.alsoIn.length ? <div className="small muted">Also in: {f.alsoIn.map((x) => x.name).join(", ")}</div> : null}
                {!f.writable && !owner ? <div className="small muted">Read-only in this project</div> : null}
              </div>
              <div className="folder-row-actions">
                {owner ? (
                  <select className="folder-writable" aria-label={`Changes to ${f.mountName}`} value={f.writable ? "writable" : "read-only"} disabled={p.busy} onChange={(e) => p.onSetWritable?.(f.mountName, e.target.value === "writable")}>
                    <option value="writable">Can be changed</option>
                    <option value="read-only">Read-only</option>
                  </select>
                ) : null}
                {f.setupFailed && !f.settingUp && (owner || (p.viewerRole === "developer" && p.writable.includes(f.mountName))) ? (
                  <button type="button" className="btn btn-quiet btn-small" aria-label={`Try again setting up ${f.mountName}`} disabled={p.busy} onClick={() => p.onRetry(f.mountName)}>
                    Try again
                  </button>
                ) : null}
                {owner ? (
                  <button type="button" className="btn btn-quiet btn-small" aria-label={`Detach ${f.mountName}`} disabled={p.busy} onClick={() => p.onAskDetach(f.mountName, f.resourceId)}>
                    Detach
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {p.notice ? (
        <p className="note small" role="status" data-testid="folders-writable-notice">
          {p.notice}
        </p>
      ) : null}
      {owner && p.folders.length ? (
        <p className="muted small" data-testid="folders-writable-note">
          <strong>Can be changed</strong>: developers with write, and clients you give Can change under Access, may change it through tasks. <strong>Read-only</strong>: agents get it to read, and new tasks cannot change it in this project (a developer's task already checked out keeps its write until it is submitted).
        </p>
      ) : null}
      {p.pending ? (
        <ConfirmSheet
          title={`Detach ${p.pending.mountName} from this project?`}
          does={p.impact && p.impact.lose.length ? `These people lose access: ${p.impact.lose.join(", ")}.` : p.impact?.narrowed.length ? "Nobody loses access entirely." : "Nobody loses access."}
          doesNot="The folder itself is not deleted."
          confirmLabel="Detach"
          tone="blocked"
          busy={p.busy}
          onConfirm={p.onConfirmDetach}
          onCancel={p.onCancel}
        >
          {p.impact?.narrowed.map((k) => (
            <div key={k.email} className="small muted">
              {k.email} keeps {k.keeps} (loses write) through {k.via}
            </div>
          ))}
          {p.impact?.keep.map((k) => (
            <div key={k.email} className="small muted">
              {k.email} keeps access through {k.via}
            </div>
          ))}
          <ErrorNote error={p.error} />
        </ConfirmSheet>
      ) : null}
      <AddFolder key={p.formKey} {...p} />
    </section>
  );
}

/** Add folder and Attach existing; keyed on `formKey`, so a success starts them empty again. */
function AddFolder(p: FoldersViewProps) {
  const owner = p.viewerRole === "owner";
  const [name, setName] = useState("");
  const [pick, setPick] = useState("");
  const [mountName, setMountName] = useState("");
  // a folder attached meanwhile (or by this form) is no longer a choice
  const picked = p.attachable.some((r) => r.resourceId === pick) ? pick : "";
  const trimmed = name.trim();
  const issue = trimmed ? folderNameIssue(trimmed) : null;
  const issueId = useId();
  return (
    <div className="folder-add">
      <h2 className="small">Add a folder</h2>
      <Link href={intakeHref(p.org, p.pid)} className="btn btn-quiet btn-small">
        Import files
      </Link>
      <p className="small muted">Public git URLs only; ZIP plans folders but doesn't fill them yet.</p>
      <form
        className="invite-form"
        aria-label="New folder"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && !issue) p.onCreate(trimmed);
        }}
      >
        <label className="field">
          New folder
          <input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="assets" aria-invalid={issue ? true : undefined} aria-describedby={issue ? issueId : undefined} />
        </label>
        <button type="submit" className="btn btn-primary btn-small" disabled={p.busy || !trimmed || !!issue}>
          Add folder
        </button>
        {issue ? (
          <p id={issueId} className="small note-inline-bad" role="alert">
            {issue}
          </p>
        ) : null}
      </form>
      {owner ? (
        <form
          className="invite-form"
          aria-label="Attach an existing folder"
          onSubmit={(e) => {
            e.preventDefault();
            if (picked && mountName.trim()) p.onAttach(picked, mountName.trim());
          }}
        >
          <label className="field">
            Attach an existing folder
            <select
              value={picked}
              onChange={(e) => {
                setPick(e.target.value);
                setMountName(p.attachable.find((r) => r.resourceId === e.target.value)?.name ?? "");
              }}
            >
              <option value="">Choose a folder…</option>
              {p.attachable.map((r) => (
                <option key={r.resourceId} value={r.resourceId}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Name in this project
            <input type="text" value={mountName} onChange={(e) => setMountName(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary btn-small" disabled={p.busy || !picked || !mountName.trim()}>
            Attach
          </button>
          {picked ? <p className="small muted">Everyone with access to this project ({p.peopleWithAccess} {p.peopleWithAccess === 1 ? "person" : "people"}) gets this folder.</p> : null}
        </form>
      ) : null}
    </div>
  );
}

export function FoldersTab() {
  const { api } = useApp();
  const { org, pid, role, project, reloadProject } = useProject();
  const owner = role === "owner";
  // polled every 2 s while a folder is setting up (none: no polling; unmount stops it)
  const [settingUp, setSettingUp] = useState(false);
  const load = useLoad(
    async () => {
      const [folders, resources, people] = await Promise.all([
        api.listFolders(org, pid),
        owner ? api.listResources(org) : Promise.resolve([] as Resource[]),
        owner ? api.getProjectAccess(org, pid) : Promise.resolve([] as PersonAccess[]),
      ]);
      return { folders, resources, people };
    },
    `${org}/${pid}/folders`,
    settingUp ? SETUP_POLL_MS : undefined,
  );
  const known = load.data !== undefined;
  const anySettingUp = !!load.data?.folders.some((f) => f.settingUp);
  useEffect(() => {
    const next = setupPollStep(settingUp, known, anySettingUp);
    if (next.polling !== settingUp) setSettingUp(next.polling);
    // a setup finished: the project (its mounts, the Files tab) has a new version to show
    if (next.finished) reloadProject?.();
  }, [known, anySettingUp, settingUp, reloadProject]);
  const [pending, setPending] = useState<FoldersViewProps["pending"]>(null);
  const [formKey, setFormKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const act = useAction(async (fn: () => Promise<unknown>) => {
    await fn();
    load.reload();
    reloadProject?.();
  });
  if (load.error) return <ErrorNote error={load.error} onRetry={load.reload} />;
  if (!load.data) return <Loading what="Loading folders" />;
  const { folders, resources, people } = load.data;
  const mounted = new Set(folders.map((f) => f.resourceId));
  return (
    <FoldersView
      org={org}
      pid={pid}
      viewerRole={role}
      folders={folders}
      attachable={resources.filter((r) => !mounted.has(r.resourceId))}
      peopleWithAccess={people.filter((x) => x.role !== "owner" && x.level !== "none").length}
      pending={pending}
      impact={pending ? detachImpact(people, pending.resourceId) : null}
      busy={act.busy}
      error={act.error}
      formKey={formKey}
      writable={project.mounts.filter((m) => m.canWrite).map((m) => m.mountName)}
      onRetry={(mountName) => void act.run(() => api.retryFolderSetup(org, pid, mountName))}
      onSetWritable={(mountName, writable) =>
        void act.run(async () => {
          const r = await api.setFolderWritable(org, pid, mountName, writable);
          setNotice(r.changed.length ? `${r.changed.length === 1 ? "One client" : `${r.changed.length} clients`} can no longer change ${mountName}.` : null);
        })
      }
      notice={notice}
      onCreate={(name) =>
        void act.run(async () => {
          await api.createFolder(org, pid, { name });
          setFormKey((k) => k + 1);
        })
      }
      onAttach={(resourceId, mountName) =>
        void act.run(async () => {
          await api.attachFolder(org, pid, { mountName, resourceId });
          setFormKey((k) => k + 1);
        })
      }
      onAskDetach={(mountName, resourceId) => {
        act.clearError();
        setPending({ mountName, resourceId });
      }}
      onCancel={() => {
        act.clearError();
        setPending(null);
      }}
      onConfirmDetach={() => {
        const p = pending;
        if (!p) return;
        void act.run(async () => {
          await api.detachFolder(org, pid, p.mountName);
          setPending(null);
        });
      }}
    />
  );
}
