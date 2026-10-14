/**
 * Client Workspace Editions (Task 21).
 *
 * - Clients: "Start an update" → pick an edition card (what you can and can't change) → "Open
 *   working copy" → download the ZIP → edit it in any tool → drop the ZIP back → "N files changed ·
 *   M blocked", each blocked file in one sentence with "Ask the developer" → it becomes a proposal.
 *   No Git, no production access.
 * - Developers: "Client editions" → configure what is published (read allowlist), what a return
 *   may change (write allowlist) and what never (protected paths); publish a build; give a client
 *   access.
 *
 * Views are pure functions of their props (tested by server rendering); containers hold state.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditionPolicyInput, EditionReturn, EditionSession, EditionView, MemberView, Project } from "../api/types.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import { askDeveloperHref, blockedSentence, editionLook, relativeTime, returnSummary } from "../lib/client-flow.js";
import { formatTime, type Tone } from "../lib/model.js";
import { membersHref, proposalHref, useRoute } from "../lib/router.js";
import { DropZone, EmptyState, Icon, type IconName } from "../primitives/index.js";
import { focusLater } from "../primitives/ConfirmSheet.js";
import { codeMessage, ErrorCode, ErrorNote, Link, Pill, Popover } from "../ui.js";
import { ClientPathNote } from "./GettingStarted.js";
import { useProject } from "./project-data.js";

const RETURN_STATE: Record<EditionReturn["state"], { label: string; tone: Tone }> = {
  queued: { label: "Received", tone: "busy" },
  running: { label: "Preparing your change", tone: "busy" },
  freezing: { label: "Preparing your change", tone: "busy" },
  proposed: { label: "Ready for review", tone: "good" },
  no_changes: { label: "Nothing to change", tone: "muted" },
  stale: { label: "Out of date", tone: "warn" },
  conflict: { label: "Conflicts with newer work", tone: "warn" },
  refused: { label: "Refused", tone: "bad" },
  failed: { label: "Failed", tone: "bad" },
};

/** One sentence per settled outcome that is not a proposal: what happened and what to do. */
const RETURN_NEXT: Partial<Record<EditionReturn["state"], string>> = {
  no_changes: "Nothing you sent differs from the working copy in a place you may change. Check that you sent the edited folder, then send it again.",
  stale: "The live site changed since you downloaded this copy. Start a new update to get the current version.",
  conflict: "Someone changed the same lines first. Start a new update and make your edit again.",
  refused: "The upload tried to change something it may not. Check the files below, or ask your developer.",
  failed: "Preparing your change failed. Send it again, or ask your developer.",
};

const CHANGE_LOOK: Record<EditionReturn["changes"][number]["kind"], { icon: IconName; word: string }> = {
  added: { icon: "plus", word: "new file" },
  modified: { icon: "pencil", word: "changed" },
  deleted: { icon: "minus", word: "removed" },
  renamed: { icon: "arrow", word: "renamed" },
};

export const isReturnSettled = (r: EditionReturn) => !["queued", "running", "freezing"].includes(r.state);

// --------------------------------------------------------------------------------- client

export interface StartUpdateViewProps {
  org: string;
  pid: string;
  editions: EditionView[] | null;
  editionId: string | null;
  onEdition: (id: string) => void;
  title: string;
  onTitle: (t: string) => void;
  onStart: () => void;
  startBusy: boolean;
  startError: unknown;
  session: EditionSession | null;
  mode: "partial" | "full";
  onMode: (m: "partial" | "full") => void;
  file: File | null;
  onFile: (f: File | null) => void;
  onSend: () => void;
  sendBusy: boolean;
  sendError: unknown;
  onClose?: () => void;
  now?: Date;
}

/** One sent-back copy: its state, "N files changed · M blocked", the files, and why any were blocked. */
export function ReturnStatus({ r, org, pid, title, now }: { r: EditionReturn; org: string; pid: string; title?: string; now?: Date }) {
  const s = RETURN_STATE[r.state];
  const settled = isReturnSettled(r);
  const sum = returnSummary(r);
  const ask = askDeveloperHref(`Question about my update${title ? `: ${title}` : ""}`, `Hi,\n\nSome files I sent back were not taken over:\n${r.blocked.map((b) => `- ${blockedSentence(b)}`).join("\n")}\n\nCan you help?\n`);
  return (
    <li className="edition-return" data-testid="edition-return">
      <div className="return-head">
        <Pill tone={s.tone} live={!settled}>
          {s.label}
        </Pill>
        <span className="muted small">sent {relativeTime(r.createdAt, now)}</span>
      </div>
      {settled && (r.changes.length || r.blocked.length) ? (
        <div className={`return-summary ${sum.blocked ? "has-blocked" : ""}`.trim()} data-testid="return-summary">
          <Icon name={sum.blocked ? "alert" : "check"} size={18} strokeWidth={2.2} />
          {sum.text}
        </div>
      ) : null}
      {r.changes.length ? (
        <ul className="return-files" aria-label="Files you changed">
          {r.changes.map((c) => (
            <li key={`${c.kind}-${c.path}`} className={`return-file return-${c.kind}`}>
              <Icon name={CHANGE_LOOK[c.kind].icon} size={15} strokeWidth={2.2} />
              <span className="return-path">{c.path}</span>
              <span className="muted small">{c.kind === "renamed" && c.oldPath ? `renamed from ${c.oldPath}` : CHANGE_LOOK[c.kind].word}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {r.mode === "partial" && r.keptAsIs > 0 ? <p className="muted small">{r.keptAsIs === 1 ? "1 file you did not send stays as it is." : `${r.keptAsIs} files you did not send stay as they are.`}</p> : null}
      {r.blocked.length ? (
        <div className="return-blocked">
          <ul>
            {r.blocked.map((b) => (
              <li key={b.path}>
                <Icon name="lock" size={15} strokeWidth={2} />
                <span>{blockedSentence(b)}</span>
              </li>
            ))}
          </ul>
          <a className="btn btn-small" href={ask}>
            <Icon name="message" size={15} /> Ask the developer
          </a>
        </div>
      ) : null}
      {RETURN_NEXT[r.state] ? <p className="small">{RETURN_NEXT[r.state]}</p> : null}
      {r.error && !RETURN_NEXT[r.state] ? <p className="small">{codeMessage(r.error.code, r.error.message)}</p> : null}
      {r.error ? <ErrorCode code={r.error.code} /> : null}
      {r.proposalId ? (
        <p className="return-next">
          <Link href={proposalHref(org, pid, r.proposalId)}>Review and approve the result</Link>
          <span className="muted small"> · preview it privately, then approve. Your developer publishes.</span>
        </p>
      ) : null}
    </li>
  );
}

function EditionCard({ e, selected, tabbable, onSelect, onArrow }: { e: EditionView; selected: boolean; tabbable: boolean; onSelect: () => void; onArrow: (dir: 1 | -1, from: HTMLElement) => void }) {
  const look = editionLook(e.name);
  const why = !e.ready ? "Not published yet. Your developer publishes it first." : e.readOnly ? "For reference only: you can read it, not send it back." : !e.canStartUpdate ? "Not available to you yet. Ask your developer." : null;
  const id = useId();
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-disabled={why ? true : undefined}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-desc`}
      tabIndex={tabbable ? 0 : -1}
      className={`edition-card ${selected ? "is-selected" : ""} ${why ? "is-unavailable" : ""}`.replace(/\s+/g, " ").trim()}
      onClick={() => !why && onSelect()}
      onKeyDown={(ev) => {
        if (ev.key === " " || ev.key === "Enter") {
          ev.preventDefault();
          if (!why) onSelect();
        } else if (ev.key === "ArrowDown" || ev.key === "ArrowRight") {
          ev.preventDefault();
          onArrow(1, ev.currentTarget);
        } else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") {
          ev.preventDefault();
          onArrow(-1, ev.currentTarget);
        }
      }}
    >
      <span className="edition-card-head">
        <span className="edition-card-icon" aria-hidden="true">
          <Icon name={look.icon} size={22} />
        </span>
        <span className="edition-card-name" id={`${id}-name`}>
          {e.name}
        </span>
        <span className="edition-card-check" aria-hidden="true">
          {selected ? <Icon name="check" size={14} strokeWidth={3} /> : null}
        </span>
      </span>
      <span id={`${id}-desc`} className="edition-card-body">
        <span className="edition-card-blurb">{look.blurb}</span>
        <span className="edition-card-rule">
          <span className="edition-card-label can">You can change</span>
          <span className="edition-chips">{e.editable.length ? e.editable.map((x) => <span key={x} className="edition-chip">{x}</span>) : <span className="muted small">everything in this copy</span>}</span>
        </span>
        <span className="edition-card-rule">
          <span className="edition-card-label cannot">You can't change</span>
          <span className="edition-chips">
            {e.protected.map((x) => (
              <span key={x} className="edition-chip edition-chip-locked">
                {x}
              </span>
            ))}
            <span className="muted small">{e.protected.length ? "or anything not in this copy" : "anything not in this copy"}</span>
          </span>
        </span>
        <span className={why ? "edition-card-why" : "muted small"}>{why ?? `${e.files} files in your copy`}</span>
      </span>
    </div>
  );
}

export function StartUpdatePanelView(p: StartUpdateViewProps) {
  const ready = (p.editions ?? []).filter((e) => e.canStartUpdate);
  const chosen = p.editionId ?? ready[0]?.editionId ?? null;
  const titleId = useId();
  return (
    <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="modal-head">
        <h2 id={titleId} tabIndex={-1}>
          Start an update
        </h2>
        {p.onClose ? (
          <button type="button" className="icon-btn" aria-label="Close" onClick={p.onClose}>
            <Icon name="close" size={18} />
          </button>
        ) : null}
      </header>
      {!p.session ? (
        <>
          <p className="modal-lede">Pick what you want to update. You get a copy to edit in your own tools, then send it back for a private preview and your approval. The production repository is never shared with you.</p>
          {p.editions === null ? (
            <p className="small">Loading…</p>
          ) : (p.editions ?? []).length === 0 ? (
            <EmptyState icon="edition" title="Developer setup required: no working copy has been published for you yet.">
              Your developer chooses what you can edit and publishes it here.
            </EmptyState>
          ) : (
            <>
              <div className="edition-cards" data-testid="edition-cards" role="radiogroup" aria-label="What do you want to update?">
                {(p.editions ?? []).map((e, i, all) => (
                  <EditionCard
                    key={e.editionId}
                    e={e}
                    selected={e.editionId === chosen}
                    // roving tab stop: the chosen card, or the first when none is chosen
                    tabbable={chosen ? e.editionId === chosen : i === 0}
                    onSelect={() => p.onEdition(e.editionId)}
                    onArrow={(dir, from) => {
                      const usable = all.filter((x) => x.canStartUpdate);
                      const at = usable.findIndex((x) => x.editionId === e.editionId);
                      const next = usable[(at + dir + usable.length) % usable.length];
                      if (!next) return;
                      p.onEdition(next.editionId);
                      const cards = from.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
                      cards?.[all.indexOf(next)]?.focus();
                    }}
                  />
                ))}
              </div>
              {ready.length === 0 ? <p className="note small">Developer setup required: none of these can be edited by you yet.</p> : null}
              <label className="field">
                What do you want to change?
                <input type="text" value={p.title} maxLength={200} placeholder="For example: explain what the quote covers" onChange={(e) => p.onTitle(e.target.value)} />
              </label>
              <ErrorNote error={p.startError} />
              <div className="modal-actions">
                <button type="button" className="btn btn-primary" disabled={p.startBusy || !p.title.trim() || !chosen} onClick={p.onStart}>
                  <Icon name="download" size={18} strokeWidth={2} />
                  {p.startBusy ? "Opening…" : "Open working copy"}
                </button>
                <span className="muted small">A ZIP of only the parts you may edit.</span>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <p className="modal-lede">
            <strong>{p.session.title}</strong> · {p.session.editionName}
          </p>
          {p.session.stale ? <p className="note note-bad small">The live application changed since this working copy was made. Start a new update to get the current version.</p> : null}
          <ol className="update-flow">
            <li>
              <span className="update-flow-num">1</span>
              <div>
                <div className="update-flow-title">Download your copy</div>
                <a className="btn" href={p.session.downloadUrl} download>
                  <Icon name="download" size={16} strokeWidth={2} />
                  Download working copy
                </a>{" "}
                <span className="muted small">{p.session.files} files</span>
              </div>
            </li>
            <li>
              <span className="update-flow-num">2</span>
              <div>
                <div className="update-flow-title">Edit it in any tool</div>
                <span className="muted small">Cursor, VS Code, a text editor: whatever you like.</span>
              </div>
            </li>
            <li>
              <span className="update-flow-num">3</span>
              <div className="update-flow-body">
                <div className="update-flow-title">Send it back as a ZIP</div>
                <DropZone inputLabel="Edited working copy (ZIP)" accept=".zip,application/zip" file={p.file} onFile={p.onFile} title="Drop the edited ZIP here" />
                <label className="small radio">
                  <input type="radio" name="mode" checked={p.mode === "partial"} onChange={() => p.onMode("partial")} /> Only the files I changed (others stay as they are)
                </label>
                <label className="small radio">
                  <input type="radio" name="mode" checked={p.mode === "full"} onChange={() => p.onMode("full")} /> The whole folder (files I removed are deleted)
                </label>
              </div>
            </li>
          </ol>
          <ErrorNote error={p.sendError} />
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" disabled={p.sendBusy || !p.file || p.session.stale} onClick={p.onSend}>
              <Icon name="upload" size={18} strokeWidth={2} />
              {p.sendBusy ? "Sending…" : "Send back edited copy"}
            </button>
          </div>
          {p.session.returns.length ? (
            <ul className="edition-returns" aria-label="What you sent back">
              {p.session.returns.map((r) => (
                <ReturnStatus key={r.returnId} r={r} org={p.org} pid={p.pid} title={p.session!.title} now={p.now} />
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

function StartUpdatePanel({ onClose, onSession }: { onClose: () => void; onSession: (open: boolean) => void }) {
  const { api } = useApp();
  const { org, pid } = useProject();
  const editions = useLoad(() => api.listEditions(org, pid), `${org}/${pid}/editions`);
  const [editionId, setEditionId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [session, setSession] = useState<EditionSession | null>(null);
  const [mode, setMode] = useState<"partial" | "full">("partial");
  const [file, setFile] = useState<File | null>(null);
  const ready = (editions.data ?? []).filter((e) => e.canStartUpdate);
  useEffect(() => onSession(session !== null), [session, onSession]);
  const start = useAction(async () => {
    const eid = editionId ?? ready[0]?.editionId;
    if (!eid) return;
    setSession(await api.startUpdate(org, eid, { title: title.trim() }));
  });
  const send = useAction(async () => {
    if (!session || !file) return;
    await api.sendBack(org, session.sessionId, file, { mode });
    setFile(null);
    setSession(await api.getUpdate(org, session.sessionId));
  });
  // follow the returns until each one settled
  const pending = session?.returns.some((r) => !isReturnSettled(r)) ?? false;
  useEffect(() => {
    if (!session || !pending) return;
    const t = setTimeout(() => void api.getUpdate(org, session.sessionId).then(setSession, () => undefined), 1500);
    return () => clearTimeout(t);
  }, [api, org, session, pending]);
  return (
    <StartUpdatePanelView
      org={org}
      pid={pid}
      editions={editions.data ?? null}
      editionId={editionId}
      onEdition={setEditionId}
      title={title}
      onTitle={setTitle}
      onStart={() => void start.run()}
      startBusy={start.busy}
      startError={start.error ?? editions.error}
      session={session}
      mode={mode}
      onMode={setMode}
      file={file}
      onFile={setFile}
      onSend={() => void send.run()}
      sendBusy={send.busy}
      sendError={send.error}
      onClose={onClose}
    />
  );
}

/** Keep Tab and Shift+Tab inside `root` (the dialog). */
export function wrapTab(e: KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== "Tab" || !root) return;
  const items = [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (items.length === 0) return;
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  // focus outside the sheet's tab stops (the body, its heading): wrap as well
  const stop = !!active && items.includes(active);
  if (e.shiftKey ? !stop || active === first : !stop || active === last) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

/**
 * "Start an update": the client's one primary action. Opens a modal sheet (role dialog, named
 * "Start an update") rendered over the app: the app behind it is `inert` and Tab stays inside the
 * sheet. Escape or Close closes it, and so does a click outside until a working copy is open (so an
 * open session is not lost by a stray click); focus returns to the button.
 */
export function StartUpdateButton({ quiet = false }: { /** a secondary button (pages whose one primary action is something else) */ quiet?: boolean }) {
  const [open, setOpen] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const triggerId = useId();
  const layer = useRef<HTMLDivElement>(null);
  // following a link out of the sheet (Review and approve the result) closes it
  const where = JSON.stringify(useRoute());
  useEffect(() => setOpen(false), [where]);
  const close = () => {
    setOpen(false);
    setHasSession(false);
    focusLater(triggerId);
  };
  useEffect(() => {
    if (!open) return;
    const app = document.getElementById("root");
    app?.setAttribute("inert", "");
    layer.current?.querySelector<HTMLElement>("h2")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else wrapTab(e, layer.current);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      app?.removeAttribute("inert");
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <button type="button" id={triggerId} className={`btn ${quiet ? "btn-outline" : "btn-primary"}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <Icon name="plus" size={18} strokeWidth={2} />
        Start an update
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              className="modal-layer"
              ref={layer}
              onMouseDown={(e) => {
                if (e.target === e.currentTarget && !hasSession) close();
              }}
            >
              <StartUpdatePanel onClose={close} onSession={setHasSession} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// ------------------------------------------------------------------------------ developer

const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

/** fixtures/README.md "Website edition policy": a sensible start for a web front end. */
export function defaultPolicyDraft(mountName: string) {
  return {
    name: "Website pages",
    mountName,
    include: ["index.html", "src/**", "public/**", "tests/quote-view.test.ts", "package.json", "vite.config.ts", "tsconfig.json"].join("\n"),
    write: ["index.html", "src", "public", "tests"].join("\n"),
    protectedPaths: ["package.json", "vite.config.ts", "tsconfig.json", "wrangler.jsonc", "tests/quote-contract.test.ts"].join("\n"),
  };
}
export type PolicyDraft = ReturnType<typeof defaultPolicyDraft>;

export function draftToPolicy(d: PolicyDraft): EditionPolicyInput {
  return { name: d.name.trim(), sources: [{ mountName: d.mountName, include: lines(d.include), write: lines(d.write) }], protectedPaths: lines(d.protectedPaths) };
}

export interface EditionsViewProps {
  /** the organization (links to Members and the project's Policy); optional for older callers */
  org?: string;
  project: Project;
  editions: EditionView[] | null;
  clients: MemberView[];
  draft: PolicyDraft | null;
  onDraft: (d: PolicyDraft | null) => void;
  onCreate: () => void;
  onBuild: (editionId: string) => void;
  onGrant: (editionId: string, userId: string) => void;
  busy: boolean;
  error: unknown;
}

export function EditionsPanelView(p: EditionsViewProps) {
  const gitMounts = p.project.mounts.filter((m) => m.provider === "artifacts");
  const d = p.draft;
  return (
    <div className="popover popover-wide" role="dialog" aria-label="Client editions">
      <h3>Client editions</h3>
      <p className="small">A client edits a fresh copy of only what you publish here, never the production repository or its history. Returns become proposals you review.</p>
      {p.org ? <ClientPathNote mode="editions" role="owner" org={p.org} pid={p.project.projectId} /> : null}
      {p.editions === null ? <p className="small">Loading…</p> : null}
      {p.editions?.length === 0 && !d ? (
        <EmptyState compact icon="edition" title="No editions yet.">
          {gitMounts.length ? "Click New edition, choose what the client may see and change, then publish it and give your client access." : "Add a git folder to the project first: an edition is a copy of one."}
        </EmptyState>
      ) : null}
      {p.editions?.length && !p.clients.length ? (
        <p className="muted small">
          No clients in this organization yet. {p.org ? <Link href={membersHref(p.org)}>Invite your client</Link> : "Invite your client in Members"}, then give them access here.
        </p>
      ) : null}
      {(p.editions ?? []).map((e) => {
        const last = e.builds?.[0];
        return (
          <section key={e.editionId} className="edition" data-testid="edition">
            <div>
              <strong>{e.name}</strong>{" "}
              <Pill tone={e.ready ? "good" : e.state === "failed" ? "bad" : "busy"} live={last?.state === "queued"}>
                {last?.state === "queued" ? "Publishing" : e.ready ? "Published" : e.state === "failed" ? "Publish failed" : "Not published"}
              </Pill>
            </div>
            <p className="muted small">
              {e.files} files published · editable: {e.editable.join(", ") || "nothing"} · protected: {e.protected.join(", ") || "none"}
            </p>
            {last ? (
              <p className="muted small">
                Last build {formatTime(last.createdAt)}
                {last.error ? ` · ${last.error}` : ""} · {last.sourceReleaseId ? `from live release ${last.sourceReleaseId}` : "from the accepted version (no live release recorded yet)"}
              </p>
            ) : null}
            <div className="popover-actions">
              <button type="button" className="btn btn-small" disabled={p.busy || !e.canManage} onClick={() => p.onBuild(e.editionId)}>
                {e.ready ? "Publish again" : "Publish"}
              </button>
              {p.clients.length ? (
                <select aria-label={`Give a client access to ${e.name}`} defaultValue="" disabled={p.busy || !e.canManage} onChange={(ev) => ev.target.value && p.onGrant(e.editionId, ev.target.value)}>
                  <option value="">Give access to…</option>
                  {p.clients.map((c) => (
                    <option key={c.userId} value={c.userId}>
                      {c.email}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </section>
        );
      })}
      {d ? (
        <div className="edition-form">
          <label className="field small">
            Name
            <input type="text" value={d.name} onChange={(e) => p.onDraft({ ...d, name: e.target.value })} />
          </label>
          <label className="field small">
            Source
            <select value={d.mountName} onChange={(e) => p.onDraft({ ...d, mountName: e.target.value })}>
              {gitMounts.map((m) => (
                <option key={m.mountName} value={m.mountName}>
                  {m.resourceName}
                </option>
              ))}
            </select>
          </label>
          <label className="field small">
            Published (read allowlist, one pattern per line)
            <textarea rows={4} value={d.include} onChange={(e) => p.onDraft({ ...d, include: e.target.value })} />
          </label>
          <label className="field small">
            Editable (write allowlist: files or folders)
            <textarea rows={3} value={d.write} onChange={(e) => p.onDraft({ ...d, write: e.target.value })} />
          </label>
          <label className="field small">
            Never changed by a client (protected)
            <textarea rows={3} value={d.protectedPaths} onChange={(e) => p.onDraft({ ...d, protectedPaths: e.target.value })} />
          </label>
          <p className="muted small">Anything not published stays private: it is not in the copy and not in its history. Files named .env are never published.</p>
          <div className="popover-actions">
            <button type="button" className="btn btn-primary btn-small" disabled={p.busy || !d.name.trim() || !lines(d.include).length} onClick={p.onCreate}>
              Create and publish
            </button>
            <button type="button" className="btn btn-quiet btn-small" onClick={() => p.onDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : gitMounts.length ? (
        <div className="popover-actions">
          <button type="button" className="btn btn-small" onClick={() => p.onDraft(defaultPolicyDraft((gitMounts.find((m) => m.mountName === "website") ?? gitMounts[0]!).mountName))}>
            New edition
          </button>
        </div>
      ) : null}
      <ErrorNote error={p.error} />
    </div>
  );
}

function EditionsPanel() {
  const { api } = useApp();
  const { org, pid, project } = useProject();
  const editions = useLoad(() => api.listEditions(org, pid), `${org}/${pid}/editions-dev`, 3000);
  const members = useLoad(() => api.listMembers(org).catch(() => [] as MemberView[]), `${org}/members`);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const act = useAction(async (fn: () => Promise<unknown>) => {
    await fn();
    editions.reload();
  });
  return (
    <EditionsPanelView
      org={org}
      project={project}
      editions={editions.data ?? null}
      clients={(members.data ?? []).filter((m) => m.role === "client")}
      draft={draft}
      onDraft={setDraft}
      onCreate={() =>
        void act.run(async () => {
          const e = await api.createEdition(org, pid, draftToPolicy(draft!));
          await api.buildEdition(org, e.editionId);
          setDraft(null);
        })
      }
      onBuild={(id) => void act.run(() => api.buildEdition(org, id))}
      onGrant={(id, userId) => void act.run(() => api.grantEdition(org, id, userId))}
      busy={act.busy}
      error={act.error ?? editions.error}
    />
  );
}

export function EditionsButton() {
  return <Popover label="Client editions">{() => <EditionsPanel />}</Popover>;
}
