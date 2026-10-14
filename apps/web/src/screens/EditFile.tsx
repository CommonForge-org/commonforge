/**
 * Edit in place and New file (spec §8, plan phase 3 Task 10). A small text file of a git folder
 * opens in a plain `<textarea>` with a line-number gutter (no editor dependency), the change is
 * reviewed as a line diff, and Save sends one `edit` op with the blob id read when the file was
 * opened. The change is then followed until it is added or fails. If the file changed meanwhile
 * (`file_changed`), the user can open the newer version with their own text kept beside it, or
 * copy their text. A new file sends `baseBlob: ""`.
 *
 * The views are pure (tests render them to a string); `EditFileScreen` holds the hooks.
 */
import { useEffect, useRef, useState, type UIEvent } from "react";
import { ApiError } from "../api/client.js";
import type { EditableFile, FileChange, Mount, TreeEntry } from "../api/types.js";
import { checkFilePath, editTitle, joinPath, LIMITS, titleOf } from "../lib/file-ops.js";
import { useApp } from "../lib/hooks.js";
import { setNavigationGuard } from "../lib/router.js";
import { collapseDiff, formatBytes, lineDiff, RetryKey } from "../lib/model.js";
import { ConfirmSheet } from "../primitives/ConfirmSheet.js";
import { Card, ErrorNote, errorMessage, Loading } from "../ui.js";
import { useProject } from "./project-data.js";
import { ChangeStatusLine, changePollMs, isOpenChange } from "./UploadTray.js";

// ------------------------------------------------------------------------------ pure helpers

/** The gutter's line numbers, one per line of `text` (an empty text has line 1). */
export function gutterText(text: string): string {
  const n = text.split(/\r\n|\r|\n/).length;
  let out = "1";
  for (let i = 2; i <= n; i++) out += `\n${i}`;
  return out;
}

/** What may be sent as an edit: text (no NUL) under 1 MiB, by its UTF-8 size. */
export function checkEditText(text: string): { ok: true; bytes: number } | { ok: false; bytes: number; reason: string } {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes >= LIMITS.maxEditBytes) return { ok: false, bytes, reason: "Files edited here stay under 1 MiB. Upload a larger file instead." };
  if (text.includes("\0")) return { ok: false, bytes, reason: "The text contains a NUL character, so it would not be a text file." };
  return { ok: true, bytes };
}

/**
 * A new file's path: `name` inside `dir`, a valid upload path, and not already in `dir`'s listing
 * (as a file or folder, or a file where the path needs a folder). The server's `file_changed`
 * covers what this listing could not know.
 */
export function checkNewFilePath(dir: string, name: string, listing: ReadonlyArray<Pick<TreeEntry, "path" | "type">>): { ok: true; path: string } | { ok: false; reason: string } {
  const raw = name.trim();
  if (!raw) return { ok: false, reason: "Enter a name for the file." };
  if (raw.endsWith("/")) return { ok: false, reason: "The name ends with /: name the file, not a folder." };
  const path = joinPath(dir, raw);
  if (!path) return { ok: false, reason: "Enter a name for the file." };
  const r = checkFilePath(path);
  if (!r.ok) return { ok: false, reason: `${path} ${r.reason}` };
  for (const e of listing) {
    if (e.path === path) return { ok: false, reason: `${path} exists already` };
    if (e.type !== "dir" && path.startsWith(`${e.path}/`)) return { ok: false, reason: `${e.path} is a file, not a folder` };
  }
  return { ok: true, path };
}

/** `navigator.clipboard.writeText`, guarded: false when there is no clipboard or it refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clip || typeof clip.writeText !== "function") return false;
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------ views

export interface NameInput {
  /** the folder the new file goes in ("" at the top) */
  dir: string;
  value: string;
  onChange: (v: string) => void;
  /** the path's refusal, if any: review waits until it is fixed */
  error?: string | undefined;
}

export interface EditorViewProps {
  /** the file's path (for a new file, the path the name gives) */
  path: string;
  text: string;
  onChange: (text: string) => void;
  onCancel: () => void;
  onReview: () => void;
  isNew: boolean;
  nameInput?: NameInput | undefined;
}

/** The editor: a full-width monospace textarea with a scroll-synced line-number gutter. */
export function EditorView({ path, text, onChange, onCancel, onReview, isNew, nameInput }: EditorViewProps) {
  const gutter = useRef<HTMLPreElement>(null);
  const check = checkEditText(text);
  const blocked = !check.ok || !!nameInput?.error;
  const sync = (e: UIEvent<HTMLTextAreaElement>) => {
    if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
  };
  return (
    <form
      className="editor"
      aria-label={isNew ? "New file" : `Edit ${path}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) onReview();
      }}
    >
      {nameInput ? (
        <label className="field editor-name">
          Path
          <span className="editor-name-row">
            {nameInput.dir ? <code className="editor-name-dir">{nameInput.dir}/</code> : null}
            <input type="text" aria-label="New file path" value={nameInput.value} onChange={(e) => nameInput.onChange(e.target.value)} placeholder="notes.md" autoComplete="off" spellCheck={false} />
          </span>
          {nameInput.error && nameInput.value ? (
            <span className="note-inline-bad small" role="alert">
              {nameInput.error}
            </span>
          ) : null}
        </label>
      ) : (
        <p className="editor-path">
          <code>{path}</code>
        </p>
      )}
      <div className="editor-frame">
        <pre ref={gutter} className="editor-gutter" aria-hidden="true">
          {gutterText(text)}
        </pre>
        <textarea className="editor-text" aria-label="File contents" value={text} onChange={(e) => onChange(e.target.value)} onScroll={sync} wrap="off" spellCheck={false} autoCapitalize="off" autoComplete="off" />
      </div>
      <div className="editor-foot">
        <span className={`small ${check.ok ? "muted" : "note-inline-bad"}`}>{formatBytes(check.bytes)}</span>
        {!check.ok ? (
          <span className="note-inline-bad small" role="alert">
            {check.reason}
          </span>
        ) : null}
        <span className="editor-actions">
          <button type="submit" className="btn btn-primary btn-small" disabled={blocked}>
            Review changes
          </button>
          <button type="button" className="btn btn-quiet btn-small" onClick={onCancel}>
            Cancel
          </button>
        </span>
      </div>
    </form>
  );
}

export interface ReviewViewProps {
  path: string;
  before: string;
  after: string;
  title: string;
  onTitle: (t: string) => void;
  onBack: () => void;
  onSave: () => void;
  saving: boolean;
  error: unknown;
  /** a new file: saving it is a change even when it is empty */
  isNew?: boolean | undefined;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The change as a line diff (3 lines of context), an optional title, and Save. */
export function ReviewView({ path, before, after, title, onTitle, onBack, onSave, saving, error, isNew = false }: ReviewViewProps) {
  const changed = isNew || before !== after;
  const ops = collapseDiff(lineDiff(before, after), 3);
  return (
    <form
      className="editor-review"
      aria-label="Review the edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (changed && !saving) onSave();
      }}
    >
      <p className="editor-path">
        <code>{path}</code>
      </p>
      {changed ? (
        <div className="diff" role="table" aria-label={`Changes to ${path}`}>
          {isNew ? <div className="diff-note">New file</div> : null}
          {ops.map((o, i) =>
            o.op === "skip" ? (
              <div key={i} className="diff-skip">
                ⋯ {plural(o.count, "unchanged line")}
              </div>
            ) : (
              <div key={i} className={`diff-line diff-${o.op}`}>
                <span className="diff-sign" aria-hidden="true">
                  {o.op === "add" ? "+" : o.op === "del" ? "−" : " "}
                </span>
                <span className="diff-text">{o.text || " "}</span>
              </div>
            ),
          )}
        </div>
      ) : (
        <p className="muted small">No changes: the text is the same as the file.</p>
      )}
      <label className="field">
        Title (optional)
        <input type="text" value={title} onChange={(e) => onTitle(e.target.value)} placeholder={editTitle(path, isNew)} maxLength={200} autoComplete="off" />
      </label>
      {error ? <ErrorNote error={error} /> : null}
      <div className="editor-actions">
        <button type="submit" className="btn btn-primary btn-small" disabled={!changed || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={onBack} disabled={saving}>
          Back to editing
        </button>
      </div>
      <p className="muted small">Saving makes one change, added under the project's approval rules.</p>
    </form>
  );
}

/** The edit was refused because the file changed after it was opened. */
export function ChangedSinceView({ onViewNewer, onCopy, busy = false, copied, error }: { onViewNewer: () => void; onCopy: () => void; busy?: boolean; /** the last copy's result */ copied?: boolean | undefined; error?: unknown }) {
  return (
    <div className="note note-warn editor-changed" role="alert">
      <p>
        <strong>This file changed since you opened it</strong>, so your edit was not added. Your text is kept here.
      </p>
      <div className="editor-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={onViewNewer} disabled={busy}>
          {busy ? "Opening…" : "View the newer version"}
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={onCopy}>
          Copy my text
        </button>
        <CopyResult copied={copied} />
      </div>
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}

function CopyResult({ copied }: { copied: boolean | undefined }) {
  if (copied === undefined) return null;
  return copied ? (
    <span className="small muted" role="status">
      Copied
    </span>
  ) : (
    <span className="note-inline-bad small" role="status">
      Could not copy here; select the text and copy it yourself.
    </span>
  );
}

/** Beside the newer version: the user's own text, read-only, to copy from. */
export function MyTextPanel({ text, onCopy, copied }: { text: string; onCopy: () => void; copied?: boolean | undefined }) {
  return (
    <aside className="editor-mine" aria-label="Your text">
      <div className="editor-mine-head">
        <strong className="small">Your text</strong>
        <button type="button" className="btn btn-quiet btn-small" onClick={onCopy}>
          Copy my text
        </button>
        <CopyResult copied={copied} />
      </div>
      <pre className="preview-text editor-mine-text">{text}</pre>
    </aside>
  );
}

/** Leaving the editor with unsaved changes. */
export function LeaveSheetView({ onLeave, onStay }: { onLeave: () => void; onStay: () => void }) {
  return (
    <ConfirmSheet title="Leave without saving?" confirmLabel="Discard changes" onConfirm={onLeave} onCancel={onStay} tone="blocked" does="Your unsaved text is discarded." doesNot="The file is not changed." />
  );
}

// ------------------------------------------------------------------------------ the screen

/** How the editor was left: the file view to show, a change to follow there, or a message. */
export interface EditExit {
  /** the file (or, for a canceled new file, folder) to show */
  path: string | undefined;
  change?: FileChange;
  note?: string;
}

type Phase = "loading" | "edit" | "review" | "saving" | "changed";

export function EditFileScreen({ mount, path, isNew, onExit }: { mount: Mount; /** the file, or the folder of a new file */ path: string; isNew: boolean; onExit: (r: EditExit) => void }) {
  const { api } = useApp();
  const { org, pid } = useProject();
  const dir = isNew ? path : "";
  const [creating, setCreating] = useState(isNew);
  const [phase, setPhase] = useState<Phase>(isNew ? "edit" : "loading");
  const [base, setBase] = useState<EditableFile | null>(null);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [mine, setMine] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | undefined>(undefined);
  const [change, setChange] = useState<FileChange | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  /** the leave sheet is open: what Discard changes then does (leave the editor, or the navigation it held) */
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const [listing, setListing] = useState<TreeEntry[]>([]);
  const [filePath, setFilePath] = useState(isNew ? "" : path);
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  // open: the text and the blob id it was read at; `not_editable` goes back with its message
  const open = (p: string) =>
    api.readFileForEdit(org, pid, { mount: mount.mountName, path: p }).then((f) => {
      setBase(f);
      setText(f.text);
      return f;
    });
  useEffect(() => {
    if (isNew) {
      let live = true;
      api
        .listTree(org, pid, { mount: mount.mountName, path: dir })
        .then((l) => live && setListing(l.entries))
        .catch(() => undefined); // the server's file_changed covers it
      return () => {
        live = false;
      };
    }
    let live = true;
    open(path)
      .then(() => live && setPhase("edit"))
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === "not_editable") exitRef.current({ path, note: errorMessage(e) });
        else setError(e);
      });
    return () => {
      live = false;
    };
    // opened once per file
  }, [api, org, pid, mount.mountName, path, isNew]); // eslint-disable-line react-hooks/exhaustive-deps

  // after Save: follow the change until it is added or fails (1.5 s, or 15 s while it waits for approval; stops on unmount)
  const changeId = change?.changeId;
  const pollMs = change ? changePollMs([change]) : null;
  useEffect(() => {
    if (!changeId || pollMs === null) return;
    let live = true;
    const id = setInterval(() => {
      api.getFileChange(org, changeId).then(
        (c) => live && setChange(c),
        (e: unknown) => live && setError(e),
      );
    }, pollMs);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [api, org, changeId, pollMs]);
  const state = change?.state;
  useEffect(() => {
    if (!change || isOpenChange(change)) return;
    if (change.state === "added") exitRef.current({ path: filePath, change });
    else if (change.state === "failed") {
      if (change.error?.code === "file_changed") setPhase("changed");
      else {
        setError(new ApiError(409, change.error?.code ?? "failed", change.error?.message ?? "Nothing was added."));
        setPhase("review");
      }
      setChange(null);
    }
    // read when the state changes
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const before = base?.text ?? "";
  const nameCheck = creating ? checkNewFilePath(dir, name, listing) : null;
  const target = creating ? (nameCheck?.ok ? nameCheck.path : joinPath(dir, name.trim())) : filePath;
  const dirty = phase !== "saving" && (text !== before || (creating && name.trim() !== ""));
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    // in-app navigation (tabs, links, Back) asks first too, with the same sheet
    const off = setNavigationGuard((proceed) => setLeaving(() => proceed));
    return () => {
      window.removeEventListener("beforeunload", warn);
      off();
    };
  }, [dirty]);

  const leave = () => onExit({ path: creating ? dir || undefined : filePath });
  const cancel = () => (dirty ? setLeaving(() => leave) : leave());

  const saveKey = useRef(new RetryKey());
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // the generated title names a new file "Created …" (the server's default says "Edited")
      const t = title.trim() ? titleOf(title) : editTitle(target, creating);
      const ops = [{ edit: target, content: text, baseBlob: creating ? "" : (base?.baseBlob ?? "") }];
      // Save again after an error (a lost reply) repeats the same key: no second change
      const c = await api.createFileChange(org, pid, mount.mountName, { ops, title: t, idempotencyKey: saveKey.current.for(JSON.stringify([mount.mountName, ops])) });
      saveKey.current.done();
      setFilePath(target);
      setChange(c);
      setPhase("saving");
    } catch (e) {
      if (e instanceof ApiError && e.code === "file_changed") setPhase("changed");
      else setError(e);
    } finally {
      setBusy(false);
    }
  };

  const viewNewer = async () => {
    setBusy(true);
    setError(null);
    const keep = text;
    try {
      await open(target);
      setMine(keep);
      setFilePath(target);
      setCreating(false);
      setCopied(undefined);
      setPhase("edit");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const copy = async (what: string) => setCopied(await copyText(what));

  const heading = creating ? "New file" : `Edit ${filePath}`;
  let body;
  if (phase === "loading") body = error ? <ErrorNote error={error} /> : <Loading what="Opening the file" />;
  else if (phase === "changed")
    body = (
      <>
        <ChangedSinceView onViewNewer={() => void viewNewer()} onCopy={() => void copy(text)} busy={busy} copied={copied} error={error} />
        <pre className="preview-text editor-mine-text" aria-label="Your text">
          {text}
        </pre>
      </>
    );
  else if (phase === "saving" && change)
    body = (
      <div className="editor-saving">
        <p className="small">
          <code>{filePath}</code>
        </p>
        <ChangeStatusLine org={org} pid={pid} change={change} />
        {error ? <ErrorNote error={error} /> : null}
        <div className="editor-actions">
          <button type="button" className="btn btn-quiet btn-small" onClick={() => onExit({ path: filePath, change })}>
            Back to files
          </button>
        </div>
        <p className="muted small">The change keeps going if you leave; the Files tab shows its status.</p>
      </div>
    );
  else if (phase === "review" || phase === "saving")
    body = <ReviewView path={target} before={creating ? "" : before} after={text} title={title} onTitle={setTitle} onBack={() => setPhase("edit")} onSave={() => void save()} saving={busy} error={error} isNew={creating} />;
  else
    body = (
      <div className={mine !== null ? "editor-split" : undefined}>
        <EditorView
          path={target}
          text={text}
          onChange={setText}
          onCancel={cancel}
          onReview={() => {
            setError(null);
            setPhase("review");
          }}
          isNew={creating}
          nameInput={creating ? { dir, value: name, onChange: setName, error: nameCheck && !nameCheck.ok ? nameCheck.reason : undefined } : undefined}
        />
        {mine !== null ? <MyTextPanel text={mine} onCopy={() => void copy(mine)} copied={copied} /> : null}
      </div>
    );

  return (
    <Card title={heading} className="editor-card" aside={phase === "loading" || phase === "changed" ? <button type="button" className="btn btn-quiet btn-small" onClick={cancel}>Back to files</button> : null}>
      {mine !== null && phase === "edit" ? <p className="muted small">This is the newer version. Your text is on the side: redo your change here, then review it.</p> : null}
      {body}
      {leaving ? (
        <LeaveSheetView
          onLeave={() => {
            const go = leaving;
            setLeaving(null);
            go();
          }}
          onStay={() => setLeaving(null)}
        />
      ) : null}
    </Card>
  );
}
