/** Small shared UI pieces. Styling lives in styles.css; the design-system primitives are in primitives/. */
import { useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ApiError } from "./api/client.js";
import { AppContext } from "./lib/hooks.js";
import { groupHash, isDeveloperRole, type Tone } from "./lib/model.js";
import { ProjectContext } from "./screens/project-data.js";
import { navigate } from "./lib/router.js";

export function Link({ href, children, className, title, ariaCurrent, ariaLabel }: { href: string; children: ReactNode; className?: string; title?: string; ariaCurrent?: "page" | "step" | "true"; ariaLabel?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} onClick={onClick} className={className} title={title} aria-current={ariaCurrent} aria-label={ariaLabel}>
      {children}
    </a>
  );
}

export function Pill({ tone, children, live }: { tone: Tone; children: ReactNode; live?: boolean }) {
  return (
    <span className={`pill pill-${tone}`}>
      {live || tone === "busy" ? <span className="pulse" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function DecisionBadge({ count }: { count?: number }) {
  if (count === 0) return null;
  return (
    <span className="decision-badge" role="status">
      <svg className="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 8v5" />
        <circle cx="12" cy="16.5" r="0.8" fill="currentColor" />
        <path d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
      Needs your decision{count && count > 1 ? ` · ${count}` : ""}
    </span>
  );
}

/** The proposal identity, grouped in fours so a client and a developer can compare it aloud. */
export function HashDisplay({ hash, label = "Review identity" }: { hash: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(hash).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="hash" data-testid="proposal-hash" data-hash={hash}>
      <div className="hash-label">
        {label} <code className="hash-field">proposalHash</code>
      </div>
      <code className="hash-value" aria-label={hash}>
        {groupHash(hash).map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </code>
      <button type="button" className="btn btn-quiet btn-small" onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Every error in one or two short sentences: what happened, then what to do next (docs/UX-POLISH.md §6). */
const FRIENDLY: Record<string, string> = {
  unauthenticated: "Your session has ended. Sign in again to continue.",
  invalid_token: "This sign-in link is invalid, already used or expired. Request a new one.",
  rate_limited: "Too many sign-in requests. Wait a few minutes, then try again.",
  insufficient_role: "Your role does not allow this. Ask the project owner if you need it.",
  org_create_forbidden: "Only your agency's administrators can create organizations. Ask one of them to create it.",
  last_owner: "An organization needs at least one owner. Make someone else an owner first.",
  already_member: "That person is already a member. Change their role in the list instead.",
  invite_rate_limited: "Too many invites were sent recently. Wait a while, then resend.",
  grant_exceeds_role: "Clients and viewers can only have read access. Choose Read, or make them a developer first.",
  mount_exists: "This project already has a folder with that name. Choose another name.",
  setup_not_failed: "Only a folder whose setup failed can be set up again. Reload the folder list; a folder whose import failed can be detached and imported again.",
  grant_owner_only: "Only an owner can make this change. Ask an owner to do it.",
  folder_exceeds_project: "A folder can't have more access than its project. Raise the project level first.",
  owner_access_implicit: "Owners already have full access to every project.",
  unknown_folder: "That folder isn't in this project anymore. Reload the page.",
  invite_failed: "The invite email could not be sent. Try Resend invite again later.",
  no_write_grant: "You do not have write access to every resource this touches. Ask the project owner for access.",
  approval_role_not_allowed: "This project's policy does not accept approvals from your role. Ask the client or a reviewer to approve.",
  proposal_hash_mismatch: "The proposal changed after you opened it. Reload and review the new review code.",
  expected_head_stale: "Another change was accepted to a resource first, so this proposal is out of date. Have the agent rebuild it on the current version.",
  dependency_stale: "A newer change was accepted to something this relies on, so this proposal is out of date. Have the agent rebuild it on the current version.",
  integration_applying: "The check result is still being recorded. Try again in a moment.",
  receipt_not_recorded: "The check result was lost. Validate again.",
  approval_invalid: "There is no valid approval for this exact proposal. Ask for an approval of this version first.",
  policy_changed: "Someone else saved this policy while you were editing. Load the newer version, then make your changes again.",
  policy_revision_stale: "The project policy changed after this proposal was made. Validate it again under the current policy.",
  evidence_missing: "Validation evidence for this exact proposal is missing. Run validation first.",
  receipt_missing: "A candidate has not been prepared yet. Wait for it, then try again.",
  proposal_not_prepared: "Candidates are still being prepared. Try again shortly.",
  restore_noop: "That version is already the current one. Pick an earlier version to restore.",
  restore_target_unknown: "That revision was never accepted, so it cannot be restored. Pick a version from the list.",
  idempotency_key_conflict: "This request was already used for something else. Reload the page and try again.",
  not_implemented: "This is not available in this build yet. Use the developer tools for it for now.",
  export_incomplete: "The export is not complete yet. Wait a moment, then try again.",
  csrf_refused: "The request was refused by a cross-site check. Reload the page and try again.",
  proposal_closed: "This proposal is already closed. Open the latest one from Changes.",
  nothing_to_integrate: "This proposal changes nothing, so there is nothing to validate. Close it or submit a change.",
  nothing_to_preview: "This proposal changes assets only, so there is no code to preview. Review the asset changes instead.",
  no_accepted_head: "This resource has no accepted version yet. Accept a first version, then try again.",
  candidate_not_available: "A candidate of this proposal is no longer available. Have the agent submit a new proposal.",
  nothing_to_export: "There is nothing to export yet. Accept a first version, then export.",
  config_missing: "The server is missing a setting for this. Ask the project owner to finish the setup.",
  lease_held: "Another developer is working on this task right now. Try again when they finish.",
  read_only_mount: "That folder is read-only for this task. Change files in a folder the task may write.",
  // client editions
  edition_stale: "The live application changed since this working copy was made. Start a new update to get the current version.",
  edition_policy_changed: "Your developer changed what this working copy allows. Start a new update.",
  edition_not_ready: "No working copy has been published yet. Ask your developer to publish one.",
  edition_read_only: "This working copy is for reference only, so it cannot be sent back. Ask your developer for one you can edit.",
  no_allowed_changes: "Nothing in the upload differs from the working copy in a place you may change. Check you sent the edited folder.",
  zip_refused: "The upload was refused: it must be a ZIP of ordinary files, with no links or paths outside the folder. Zip the folder again and resend it.",
  invalid_edition_return: "The upload names a file twice, or both sends and deletes it. Zip the folder again and resend it.",
  too_large: "The upload is too large. Send only the files you changed.",
  no_edition_grant: "You have no access to this working copy. Ask your developer for access.",
  // uploads and file changes (Files tab)
  edit_unsupported: "Files in a file collection can't be edited in place. Upload a new version instead.",
  file_changed: "This file changed after you opened it, so your edit was not added. Open it again and redo your change.",
  file_missing: "A file this change names is no longer there. Reload the folder and try again.",
  path_exists: "A file with that name is already there. Choose another name, or delete that file first.",
  invalid_path: "That file name or path isn't allowed. Use a relative path without '..' or a .git folder.",
  file_too_large: "That file is too large: each file can be at most 5 GB.",
  change_too_large: "This change is too large: one change adds at most 20 GB. Split it into smaller batches.",
  too_many_operations: "This change has too many files: one change has at most 1,000. Split it into smaller batches.",
  edit_too_large: "Only text files under 1 MiB can be edited here. Upload larger or binary files instead.",
  edits_too_large: "These edits are too large together: at most 16 MiB per change. Save them in smaller changes.",
  invalid_upload: "An upload in this change is unfinished, was refused or was added already. Upload the file again.",
  hash_mismatch: "An uploaded file did not arrive intact, so nothing was added. Upload it again.",
  check_failed: "The project's checks failed on this change, so nothing was added. Ask a developer to look at the change.",
  not_editable: "This file can't be edited here: only small text files of git folders can. Download it, or upload a new version.",
  object_missing: "This file's content is missing from storage. Ask the project owner to upload it again.",
  folder_missing: "This folder is no longer available. Reload the project.",
  stale_base: "Other changes kept landing first, so this change was not added. Try it again.",
  staging_failed: "Staging dropped this change, so it did not reach production. Make the change again.",
  staging_rolled_back: "This change was taken out of staging, so it did not reach production.",
  staging_land_failed: "This change could not be put on staging, so it did not reach production. Make the change again.",
  promotion_changed: "This production update changed since you opened it. Look at it again, then decide.",
  promotion_not_pending: "This production update is no longer waiting for a decision.",
  promotion_accepted: "This production update was already accepted into production, so it can't be withdrawn.",
  promotion_not_in_flight: "This production update already ended.",
  not_promotion_requester: "Only the person who asked for this production update can withdraw it.",
  resource_not_ready: "A folder of this project isn't ready yet. Try again in a few minutes.",
};

/** Errors without a plain sentence of their own still say what to do next, for the viewer's role. */
function fallbackNext(developer: boolean): string {
  return developer ? "Try again; if it keeps happening, check the inspector and the error details." : "Try again; if it keeps happening, tell your developer.";
}

/** The plain sentence for an error code the server recorded (e.g. on a returned working copy). */
export function codeMessage(code: string, message: string, developer = false): string {
  return FRIENDLY[code] ?? `${sentence(message)} ${fallbackNext(developer)}`;
}

export function errorMessage(e: unknown, developer = false): string {
  if (e instanceof ApiError) return codeMessage(e.code, e.message, developer);
  if (e instanceof Error) return `${sentence(e.message)} ${fallbackNext(developer)}`;
  return `${sentence(String(e))} ${fallbackNext(developer)}`;
}

/** Owner or developer where the viewer is: the project's role inside a project, else any membership. */
export function useDeveloperViewer(): boolean {
  const project = useContext(ProjectContext);
  const app = useContext(AppContext);
  if (project) return isDeveloperRole(project.role);
  const roles = app?.me?.memberships.map((m) => m.role) ?? [];
  return roles.length > 0 && roles.every((r) => isDeveloperRole(r));
}

/** The server's error code for support, reachable by keyboard, touch and screen readers. */
export function ErrorCode({ code }: { code: string | null | undefined }) {
  if (!code) return null;
  return (
    <details className="error-code small">
      <summary>Details</summary>
      Error code <code>{code}</code>
    </details>
  );
}

function sentence(s: string): string {
  const t = s.trim() || "Something went wrong";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const developer = useDeveloperViewer();
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : null;
  return (
    <div className="note note-bad" role="alert" {...(code ? { "data-error-code": code } : {})}>
      <span>{errorMessage(error, developer)}</span>
      <ErrorCode code={code} />
      {code === "unauthenticated" ? <Link href="/signin">Sign in</Link> : null}
      {onRetry ? (
        <button type="button" className="btn btn-quiet btn-small" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return (
    <div className="loading" role="status">
      <span className="pulse" aria-hidden="true" /> {what}…
    </div>
  );
}

export function Card({ title, aside, children, className, testId }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; testId?: string }) {
  return (
    <section className={`card ${className ?? ""}`} {...(testId ? { "data-testid": testId } : {})}>
      {title || aside ? (
        <header className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {aside}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function ResultMark({ result }: { result: string }) {
  const tone = result === "pass" || result === "clean" ? "good" : result === "skipped" ? "muted" : "bad";
  const label = result === "pass" ? "Passed" : result === "fail" ? "Failed" : result === "skipped" ? "Skipped" : result === "clean" ? "Clean merge" : result.replace(/-/g, " ");
  return <Pill tone={tone}>{label}</Pill>;
}

/** A popover anchor that closes on an outside click or Escape. */
export function Popover({ label, primary, children }: { label: string; primary?: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="popover-anchor" ref={ref}>
      <button type="button" className={`btn ${primary ? "btn-primary" : "btn-quiet"}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open ? children(() => setOpen(false)) : null}
    </div>
  );
}
