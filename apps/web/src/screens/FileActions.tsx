/**
 * The Files tab's action sheets (plan phase 3 Task 9): Rename or move, Delete, Replace and New
 * folder. Each is a pure view with callbacks, built on `ConfirmSheet`; the ops and titles come
 * from `lib/file-ops.ts`, so what the sheet refuses is what the builders refuse.
 */
import { useId, useState } from "react";
import type { FileChangeOp } from "../api/types.js";
import { checkFilePath, deleteOps, deleteTitle, joinPath, moveOps, moveTitle, renameOp } from "../lib/file-ops.js";
import { ConfirmSheet } from "../primitives/ConfirmSheet.js";
import { DropZone } from "../primitives/DropZone.js";
import { ErrorNote } from "../ui.js";

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

type Plan = { ok: true; ops: FileChangeOp[]; title: string } | { ok: false; reason: string };

/** What a move sheet would send: one path renamed to `target`, or several moved into the folder `target`. */
export function planMove(paths: string[], target: string): Plan {
  if (paths.length === 1) {
    const from = paths[0]!;
    const to = joinPath(target, "");
    if (!to) return { ok: false, reason: "Enter the new path." };
    if (to === from) return { ok: false, reason: "That is where it is already." };
    if (to.startsWith(`${from}/`)) return { ok: false, reason: `cannot move ${from} into itself` };
    const r = checkFilePath(to);
    if (!r.ok) return { ok: false, reason: `${to} ${r.reason}` };
    return { ok: true, ops: [renameOp(from, to)], title: moveTitle([{ from, to }]) };
  }
  let ops: FileChangeOp[];
  try {
    ops = moveOps(paths, target);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  const dir = joinPath(target, "");
  if (dir) {
    const r = checkFilePath(dir);
    if (!r.ok) return { ok: false, reason: `${dir} ${r.reason}` };
  }
  if (ops.length === 0) return { ok: false, reason: "They are all in that folder already." };
  const moves = ops.map((o) => o as { move: string; to: string }).map((o) => ({ from: o.move, to: o.to }));
  return { ok: true, ops, title: moveTitle(moves) };
}

export interface MoveSheetViewProps {
  paths: string[];
  /** folders of the mount the tree has listed, offered as targets */
  knownDirs: string[];
  /** the target (several paths) or the new path (one) to start from */
  initialTarget?: string;
  busy: boolean;
  error: unknown;
  onSubmit: (ops: FileChangeOp[], title: string) => void;
  onCancel: () => void;
}

export function MoveSheetView({ paths, knownDirs, initialTarget, busy, error, onSubmit, onCancel }: MoveSheetViewProps) {
  const single = paths.length === 1;
  const [target, setTarget] = useState(initialTarget ?? (single ? paths[0]! : ""));
  const id = useId();
  const plan = planMove(paths, target);
  const submit = () => plan.ok && !busy && onSubmit(plan.ops, plan.title);
  return (
    <form
      className="file-sheet"
      aria-label="Move files"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ConfirmSheet title={single ? `Rename or move ${paths[0]}` : `Move ${files(paths.length)}`} confirmLabel="Move" busyLabel="Moving…" busy={busy} disabled={!plan.ok} onConfirm={submit} onCancel={onCancel} does="This becomes one change, added under the project's approval rules." doesNot="Nothing else in the folder changes.">
        {single ? (
          <label className="field">
            New path
            <input type="text" value={target} onChange={(e) => setTarget(e.target.value)} autoComplete="off" />
          </label>
        ) : (
          <>
            <ul className="file-sheet-paths small">
              {paths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <label className="field">
              Move {files(paths.length)} to
              <input type="text" list={`${id}-dirs`} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="/ (the top of the folder)" autoComplete="off" />
            </label>
            <datalist id={`${id}-dirs`}>
              {knownDirs.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </>
        )}
        {!plan.ok && (target || !single) ? (
          <p className="note-inline-bad small" role="alert">
            {plan.reason}
          </p>
        ) : null}
        {error ? <ErrorNote error={error} /> : null}
      </ConfirmSheet>
    </form>
  );
}

export function DeleteSheetView({ paths, busy, error, onConfirm, onCancel }: { paths: string[]; busy: boolean; error: unknown; onConfirm: (ops: FileChangeOp[], title: string) => void; onCancel: () => void }) {
  const go = () => !busy && onConfirm(deleteOps(paths), deleteTitle(paths));
  return (
    <form
      className="file-sheet"
      aria-label="Delete files"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <ConfirmSheet title={paths.length === 1 ? `Delete ${paths[0]}` : `Delete ${files(paths.length)}`} confirmLabel={paths.length === 1 ? "Delete" : `Delete ${files(paths.length)}`} busyLabel="Deleting…" busy={busy} onConfirm={go} onCancel={onCancel} tone="blocked" does="Deleting is a change like any other: it is added under the project's approval rules, and earlier versions keep the files." doesNot="A folder is deleted with everything in it.">
        <ul className="file-sheet-paths small">
          {paths.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        {error ? <ErrorNote error={error} /> : null}
      </ConfirmSheet>
    </form>
  );
}

/** A new, empty folder: kept in this tab only until a file is uploaded into it (git keeps no empty folders). */
export function NewFolderSheetView({ dir, initialName, onCreate, onCancel }: { dir: string; initialName?: string; onCreate: (path: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initialName ?? "");
  const path = joinPath(dir, name);
  const check = name.trim() ? checkFilePath(path) : null;
  const ok = !!check?.ok;
  const reason = check && !check.ok ? `${path || name} ${check.reason}` : null;
  const go = () => ok && onCreate(path);
  return (
    <form
      className="file-sheet"
      aria-label="New folder"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <ConfirmSheet title={`New folder in ${dir || "/"}`} confirmLabel="Create folder" disabled={!ok} onConfirm={go} onCancel={onCancel} doesNot="Upload a file to keep this folder: an empty folder is not saved.">
        <label className="field">
          Folder name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>
        {ok ? <p className="small muted">{path}</p> : null}
        {reason ? (
          <p className="note-inline-bad small" role="alert">
            {reason}
          </p>
        ) : null}
      </ConfirmSheet>
    </form>
  );
}

/** Replace one file with a new upload: the batch's change is titled "Replaced <path>". */
export function ReplaceSheetView({ path, onFile, onCancel }: { path: string; onFile: (f: File) => void; onCancel: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const go = () => file && onFile(file);
  return (
    <form
      className="file-sheet"
      aria-label="Replace file"
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <ConfirmSheet title={`Replace ${path}`} confirmLabel="Replace" disabled={!file} onConfirm={go} onCancel={onCancel} does="The new file is uploaded to the same path, as one change." doesNot="Earlier versions keep the old file.">
        <DropZone inputLabel="Replacement file" file={file} onFile={setFile} title="Drop the new version here" />
      </ConfirmSheet>
    </form>
  );
}
