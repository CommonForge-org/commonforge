/** One person's access to one project: a level, plus folder exceptions under a Folders disclosure. */
import { useState } from "react";
import type { AccessLevel, FolderAccess, PersonAccess, Role } from "../api/types.js";
import { roleLabel } from "../lib/orgs.js";

export const LEVEL_LABEL: Record<AccessLevel, string> = { none: "No access", read: "Read", write: "Read + write" };
/**
 * A client's levels: Can change means their agent may change the folder in its own task copy (a
 * staging-mode project; the change goes to staging for review), never the folder itself.
 */
export const CLIENT_LEVEL_LABEL: Record<AccessLevel, string> = { none: "No access", read: "Read only", write: "Can change" };
export const levelLabel = (role: Role, l: AccessLevel) => (role === "client" ? CLIENT_LEVEL_LABEL : LEVEL_LABEL)[l];
const RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };

/**
 * A folder another project keeps above `level` (its floor is higher) can't be changed from this
 * project: it shows as text and is never sent. Any other folder, even one above the project level
 * (an old direct grant), stays editable and is set to the level or its exception on save.
 */
export function folderFixed(f: FolderAccess, level: AccessLevel): boolean {
  return f.min !== undefined && RANK[f.min] > RANK[level];
}

/** The exception levels a folder can take under `level`: below the level, never below its floor. */
export function folderOptions(f: FolderAccess, level: AccessLevel): AccessLevel[] {
  const floor = RANK[f.min ?? "none"];
  return (["read", "none"] as const).filter((l) => RANK[l] < RANK[level] && RANK[l] >= floor);
}

/** The `folders` of a save: exceptions the folder may take under the new level only, never a fixed folder. */
export function accessPayload(person: PersonAccess, level: AccessLevel, folders: Record<string, AccessLevel>): Record<string, AccessLevel> {
  if (level === "none") return {};
  const out: Record<string, AccessLevel> = {};
  for (const f of person.folders) {
    const v = folders[f.resourceId];
    if (v !== undefined && !folderFixed(f, level) && folderOptions(f, level).includes(v)) out[f.resourceId] = v;
  }
  return out;
}

const fixedLabel = (f: FolderAccess, role: Role) => `${levelLabel(role, f.min ?? f.level)} (through ${f.via ?? "another project"})`;

export function AccessRow({ label, person, viewerRole, busy, onSave }: { label: string; person: PersonAccess; viewerRole: Role; busy: boolean; onSave: (level: AccessLevel, folders: Record<string, AccessLevel>) => void }) {
  // exceptions only: folders below the project level that this project controls
  const initialEx: Record<string, AccessLevel> = Object.fromEntries(person.folders.filter((f) => !folderFixed(f, person.level) && RANK[f.level] < RANK[person.level]).map((f) => [f.resourceId, f.level]));
  const [level, setLevel] = useState<AccessLevel>(person.level);
  const [folders, setFolders] = useState<Record<string, AccessLevel>>(initialEx);
  const owner = person.role === "owner";
  const levels: AccessLevel[] = person.role === "developer" || person.role === "client" ? ["none", "read", "write"] : ["none", "read"];
  const L = (l: AccessLevel) => levelLabel(person.role, l);
  const effective = (l: AccessLevel, ex: Record<string, AccessLevel>, rid: string): AccessLevel => (l === "none" ? "none" : (ex[rid] ?? l));
  // against each folder's actual level, so an old grant above the project level can be saved down to it
  const dirty = level !== person.level || person.folders.some((f) => !folderFixed(f, level) && effective(level, folders, f.resourceId) !== f.level);
  const changeLevel = (next: AccessLevel) => {
    setLevel(next);
    // an exception stays below the level, so a folder select never holds a value it doesn't offer
    setFolders((cur) => Object.fromEntries(Object.entries(cur).filter(([, l]) => RANK[l] < RANK[next])));
  };

  if (owner)
    return (
      <div className="access-row">
        <div className="access-who">
          <strong>{label}</strong> <span className="role-chip">{roleLabel(person.role)}</span>
        </div>
        <div className="access-level muted">Full (owner)</div>
      </div>
    );

  if (viewerRole !== "owner")
    return (
      <div className="access-row">
        <div className="access-who">
          <strong>{label}</strong> <span className="role-chip">{roleLabel(person.role)}</span>
        </div>
        <div className="access-level">
          {L(person.level)}
          {person.level === "none" ? (
            <button type="button" className="btn btn-quiet btn-small" aria-label={`Give read access to ${label}`} disabled={busy} onClick={() => onSave("read", {})}>
              Give read access
            </button>
          ) : null}
        </div>
      </div>
    );

  return (
    <div className="access-row">
      <div className="access-who">
        <strong>{label}</strong> <span className="role-chip">{roleLabel(person.role)}</span>
      </div>
      <div className="access-level">
        <select aria-label={`Access of ${label}`} value={level} disabled={busy} onChange={(e) => changeLevel(e.target.value as AccessLevel)}>
          {levels.map((l) => (
            <option key={l} value={l}>
              {L(l)}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-primary btn-small" aria-label={`Save access for ${label}`} disabled={busy || !dirty} onClick={() => onSave(level, accessPayload(person, level, folders))}>
          Save
        </button>
      </div>
      {person.role === "client" && level !== "none" ? (
        <p className="muted small access-note">Can change: their agent changes the folder in its own copy, and the change goes to staging for review. Read only: their agent can see it. No access: hidden from them.</p>
      ) : null}
      {level !== "none" && person.folders.length ? (
        <details className="access-folders">
          <summary>Folders</summary>
          <ul>
            {person.folders.map((f) => (
              <li key={f.resourceId}>
                <span>{f.mountName}</span>
                {folderFixed(f, level) ? (
                  <span className="muted">{fixedLabel(f, person.role)}</span>
                ) : f.readOnly && person.role === "client" && level === "write" && folders[f.resourceId] !== "none" ? (
                  <span className="muted" data-testid="access-folder-read-only">
                    Read only (the folder is read-only in this project){" "}
                    <button type="button" className="btn btn-quiet btn-small" disabled={busy} onClick={() => setFolders((cur) => ({ ...cur, [f.resourceId]: "none" }))} aria-label={`Hide ${f.mountName} from ${label}`}>
                      Hide it
                    </button>
                  </span>
                ) : (
                  <select
                    aria-label={`Access of ${label} to ${f.mountName}`}
                    value={folders[f.resourceId] ?? "same"}
                    disabled={busy}
                    onChange={(e) => {
                      const v = e.target.value;
                      setFolders((cur) => {
                        const next = { ...cur };
                        if (v === "same") delete next[f.resourceId];
                        else next[f.resourceId] = v as AccessLevel;
                        return next;
                      });
                    }}
                  >
                    <option value="same">Same as project ({L(level)})</option>
                    {folderOptions(f, level).map((l) => (
                      <option key={l} value={l}>
                        {L(l)}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
