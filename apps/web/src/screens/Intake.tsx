/**
 * "Add files" (UX-3, DEMO-SCRIPT 0:00): bring an existing project in, either a ZIP of the folder
 * someone has or a public Git repository, on the Worker's intake routes:
 *
 *   ZIP:  POST /intake/zip → inventory (runner, nothing executed) → placement plan with a reason
 *         for every exclusion → POST /intake/:id/confirm {projectId, skip, include} → resources + mounts.
 *         `include` (owner only): files blocked only for a secret-looking name that the owner has
 *         inspected and keeps ("Include anyway", UX-POLISH §11.3), after one attestation sentence.
 *   URL:  POST /intake/url {projectId, mountName} → import step → bound first version + mount.
 *
 * Honesty: confirming a ZIP creates the resources and folders, but copying the archive's files
 * into them needs a runner step that does not exist yet (`pendingPopulation`); the screen says so
 * instead of showing "done".
 */
import { useEffect, useState, type FormEvent } from "react";
import type { IntakeConfirmResult, IntakePlacement, IntakePlan, IntakeView, Mount } from "../api/types.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import { formatBytes, providerKind } from "../lib/model.js";
import { intakeHref, navigate, projectHref } from "../lib/router.js";
import { Badge, Chip, DropZone, EmptyState, Icon, resourceIcon, StateRail, type IconName, type RailPosition, type StateKind } from "../primitives/index.js";
import { Card, ErrorNote, Link, Loading } from "../ui.js";
import { useProject } from "./project-data.js";

const POLL_INTAKE_MS = 1500;

export const ZIP_STEPS = ["Choose", "Check", "Confirm", "Added"] as const;
export const URL_STEPS = ["Choose", "Import", "Added"] as const;

// ------------------------------------------------------------------------------- pure helpers

const nf = new Intl.NumberFormat("en-US");
export const count = (n: number, one: string, many = `${one}s`) => `${nf.format(n)} ${n === 1 ? one : many}`;

/** Where a ZIP or URL intake is on its rail; a confirmed ZIP still waiting for content is not "done". */
export function intakePosition(i: IntakeView | null): RailPosition {
  if (!i) return { current: 0, state: "working", complete: false };
  if (i.kind === "url") {
    if (i.state === "completed") return { current: 2, state: "ready", complete: true };
    if (i.state === "failed") return { current: 1, state: "blocked", complete: false };
    return { current: 1, state: "working", complete: false };
  }
  switch (i.state) {
    case "inventorying":
      return { current: 1, state: "working", complete: false };
    case "inventoried":
      return { current: 2, state: "decision", complete: false };
    case "confirming":
      return { current: 2, state: "working", complete: false };
    case "confirmed":
      return confirmResult(i)?.pendingPopulation ? { current: 3, state: "decision", complete: false } : { current: 3, state: "ready", complete: true };
    default:
      return { current: 1, state: "blocked", complete: false };
  }
}

export function confirmResult(i: IntakeView): IntakeConfirmResult | null {
  const r = i.result as Partial<IntakeConfirmResult> | undefined;
  return r && Array.isArray(r.resources) ? (r as IntakeConfirmResult) : null;
}

export type ExclusionKind = "secret" | "refused" | "nested" | "dependency" | "build" | "other";

/** One row of an exclusion group: a folder (a nested repository, a dependency or build folder) or a single file. */
export interface ExclusionItem {
  /** the folder ("api/", "website/node_modules/") or the file path */
  label: string;
  files: number;
  /** every excluded path in this row (shown behind a disclosure for folders) */
  paths: string[];
  /** one plain phrase for the row: "nested repository (26 files): import by URL to keep its history" */
  note: string;
  folder: boolean;
}

export interface ExclusionGroup {
  kind: ExclusionKind;
  title: string;
  /** one plain sentence: why, and what to do instead */
  why: string;
  icon: IconName;
  state: StateKind;
  /** files in this group */
  files: number;
  /** folders (with their file count) or single files, most files first */
  items: ExclusionItem[];
}

const GROUPS: Record<ExclusionKind, Omit<ExclusionGroup, "kind" | "files" | "items">> = {
  secret: { title: "Blocked: may contain a secret", why: "Blocked because of the file name. The contents were not read and are never shown. Keep real secrets in the deploy settings, not in files.", icon: "lock", state: "blocked" },
  refused: { title: "Refused by the safety check", why: "These entries could not be read safely (for example, a path pointing outside the folder), so they are skipped.", icon: "cross", state: "blocked" },
  nested: { title: "Nested repositories", why: "A .git folder is another project's own history. Import that repository by its URL to keep its history.", icon: "repo", state: "decision" },
  dependency: { title: "Dependency folders", why: "Installed packages are rebuilt from the lockfile, so they are not stored.", icon: "files", state: "neutral" },
  build: { title: "Build output and caches", why: "Generated files are rebuilt from the source when needed.", icon: "files", state: "neutral" },
  other: { title: "Left out", why: "Skipped by the intake rules.", icon: "inbox", state: "neutral" },
};

const ORDER: ExclusionKind[] = ["secret", "refused", "nested", "dependency", "build", "other"];

export function exclusionKind(reason: string): ExclusionKind {
  if (/^refused by inventory/i.test(reason)) return "refused";
  if (/credential/i.test(reason)) return "secret";
  if (/nested repository/i.test(reason)) return "nested";
  if (/dependency/i.test(reason)) return "dependency";
  if (/build output|cache/i.test(reason)) return "build";
  return "other";
}

/**
 * What a blocked file may hold, from its name only (the Worker blocks by name and never reads it):
 * ".npmrc" → "may contain a registry token". Said as a possibility, not an accusation.
 */
export function secretHint(path: string): string {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (name === ".npmrc" || name === ".pypirc") return "may contain a registry token";
  if (name === ".netrc") return "may contain a login for another server";
  if (name.startsWith(".env")) return "may contain passwords or API keys";
  if (/\.(pem|key)$/.test(name) || name.startsWith("id_")) return "may contain a private key";
  if (name.startsWith("service-account")) return "may contain a cloud service account key";
  if (name.startsWith("credentials")) return "may contain account credentials";
  return "may contain a secret";
}

const FOLDER_SEGMENTS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache"]);

function folderNote(kind: ExclusionKind, files: number, segment: string): string {
  const n = count(files, "file");
  if (kind === "nested") return `nested repository (${n}): import by URL to keep its history`;
  if (kind === "dependency") return `dependency folder (${n}): reinstalled from the lockfile`;
  return `${segment === ".cache" || segment === ".turbo" ? "cache" : "build output"} (${n}): rebuilt from the source`;
}

/**
 * Group the plan's exclusions by reason. The Worker lists every excluded file; folder exclusions
 * collapse to one row per folder (UX-6): one per nested repository, named by the repository's own
 * folder ("api/ · nested repository (26 files)"), one per dependency or build folder.
 */
export function groupExclusions(excluded: IntakePlan["excluded"]): ExclusionGroup[] {
  const byKind = new Map<ExclusionKind, Map<string, { paths: string[]; folder: boolean; segment: string }>>();
  for (const e of excluded) {
    const kind = exclusionKind(e.reason);
    let label = e.path;
    let folder = false;
    let segment = "";
    if (kind === "nested" || kind === "dependency" || kind === "build") {
      const segs = e.path.split("/");
      const at = segs.findIndex((s) => FOLDER_SEGMENTS.has(s));
      if (at >= 0) {
        folder = true;
        segment = segs[at]!;
        // a nested repository is named by its own folder (the .git inside it is its history)
        label = kind === "nested" && segment === ".git" ? (at === 0 ? "(archive root)/" : `${segs.slice(0, at).join("/")}/`) : `${segs.slice(0, at + 1).join("/")}/`;
      }
    }
    const m = byKind.get(kind) ?? new Map<string, { paths: string[]; folder: boolean; segment: string }>();
    const row = m.get(label) ?? { paths: [], folder, segment };
    row.paths.push(e.path);
    m.set(label, row);
    byKind.set(kind, m);
  }
  return ORDER.filter((k) => byKind.has(k)).map((kind) => {
    const items: ExclusionItem[] = [...byKind.get(kind)!.entries()]
      .map(([label, r]) => ({ label, files: r.paths.length, paths: r.paths, folder: r.folder, note: r.folder ? folderNote(kind, r.paths.length, r.segment) : kind === "secret" ? secretHint(label) : "" }))
      .sort((a, b) => b.files - a.files || (a.label < b.label ? -1 : 1));
    return { kind, ...GROUPS[kind], files: items.reduce((n, i) => n + i.files, 0), items };
  });
}

/**
 * The code resource a blocked file would go into if included anyway (the Worker's rule: its
 * top-level folder's resource, or the root resource for a file at the top), among the parts being
 * added; null when that part is not being added, so the file cannot be included.
 */
export function includeTarget(path: string, chosen: IntakePlacement[]): string | null {
  const segs = path.split("/");
  const prefix = segs.length > 1 ? `${segs[0]}/` : "";
  return chosen.find((p) => providerKind(p.provider) !== "assets" && p.pathPrefix === prefix)?.resourceName ?? null;
}

/** The attestation an owner ticks before blocked files are included. */
export function attestSentence(n: number): string {
  return n === 1 ? "I have inspected this file and it contains no secrets" : "I have inspected these files and they contain no secrets";
}

/** The plan's reason for a placement, in plain language. */
export function placementSentence(p: IntakePlacement): string {
  if (p.provider === "r2-assets") return "Images, video, fonts and files over 32 MB stay out of Git: they go to an asset collection, versioned with the code.";
  const folder = /^top-level folder "(.+)" kept/.exec(p.reason)?.[1];
  if (folder) return `The top-level folder ${folder} becomes its own code repository, with its own history of versions.`;
  if (/source files at the archive root/.test(p.reason)) return "The archive's files become one code repository.";
  if (/loose files at the archive root/.test(p.reason)) return "Loose files at the top of the archive become their own code repository.";
  return p.reason;
}

export function storedIn(provider: string): string {
  return providerKind(provider) === "assets" ? "Asset collection (R2)" : "Code repository (Git)";
}

/** A valid project folder name (Worker `MountNameSchema`: one path segment, not dot-prefixed, ≤128). */
export function isFolderName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && !name.includes("/") && !name.startsWith(".") && name !== "..";
}

/** The intake's failure in one plain sentence (the raw text stays under "Technical detail"). */
export function intakeErrorSentence(kind: "zip" | "url", error: string | undefined): string {
  const e = error ?? "";
  if (/zip_refused|not a readable zip/i.test(e)) return "The file is not a ZIP archive we can read. Make a new ZIP of the folder and try again.";
  if (/too_large|limit/i.test(e)) return "The archive is too large. Split it, or import the code by its Git address.";
  if (/branch .* not found/i.test(e)) return "That branch does not exist in the repository. Check the branch name and try again.";
  if (/timed out/i.test(e)) return "The repository took too long to import, even without its full history. Try again later.";
  if (kind === "url") return "The repository could not be imported. Check that the address is public and correct, then try again.";
  return "The archive could not be checked. Try again; if it keeps failing, make a new ZIP of the folder.";
}

/** "Website" → "Website"; a usable folder name for a URL import (one path segment, not dot-prefixed). */
export function folderName(name: string): string {
  return name.trim().replace(/[\\/]+/g, "-").replace(/^\.+/, "").slice(0, 128);
}

/** "https://github.com/acme/portal-website.git" → "portal-website" */
export function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    return last.replace(/\.git$/i, "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------- views

function PlacementCard({ p, included, onToggle, disabled, taken }: { p: IntakePlacement; included: boolean; onToggle: () => void; disabled: boolean; taken: boolean }) {
  const oddName = !isFolderName(p.resourceName);
  const icon = resourceIcon(p.provider, p.resourceName);
  return (
    <li className={`intake-card intake-place ${included ? "" : "intake-card-off"}`.trim()} data-testid="intake-placement">
      <div className="intake-card-head">
        <span className={`icon icon-${icon}`} aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
        <strong>{p.resourceName}</strong>
        <span className={`tag tag-${providerKind(p.provider)}`}>{providerKind(p.provider) === "assets" ? "R2" : "Git"}</span>
      </div>
      <div className="muted small">
        {storedIn(p.provider)} · {count(p.files, "file")} · {formatBytes(p.bytes)}
        {p.pathPrefix ? (
          <>
            {" "}
            · from <code>{p.pathPrefix}</code>
          </>
        ) : null}
      </div>
      <p className="small">{placementSentence(p)}</p>
      {taken ? <p className="small warn-text">This project already has a folder named {p.resourceName}, so this part cannot be added here.</p> : null}
      {oddName && !taken ? <p className="small warn-text">{p.resourceName} cannot be a folder name, so it is added under a generated name.</p> : null}
      <label className="small intake-include">
        <input type="checkbox" checked={included && !taken} disabled={disabled || taken} onChange={onToggle} /> Add {p.resourceName}
      </label>
    </li>
  );
}

/** At most this many paths are listed behind one folder's disclosure (a node_modules can hold thousands). */
const PATHS_SHOWN = 100;

/** Owner-only "Include anyway" for blocked-by-name files: what is ticked, and where each could go. */
interface IncludeControl {
  include: string[];
  onInclude: (path: string) => void;
  /** the resource each blocked file would go into (null: nothing in its folder is being added) */
  target: (path: string) => string | null;
  /** paths that also have another exclusion (e.g. refused by the inventory as a duplicate): never includable */
  other: Set<string>;
  disabled: boolean;
}

function ExclusionRow({ i, inc }: { i: ExclusionItem; inc?: IncludeControl }) {
  if (!i.folder) {
    const target = inc ? inc.target(i.label) : null;
    const offer = !!inc && !inc.other.has(i.label);
    return (
      <li className={inc ? "intake-secret-file" : undefined}>
        <code>{i.label}</code>
        {i.note ? <span className="muted"> · {i.note}</span> : null}
        {inc && offer ? (
          <span className="intake-include-anyway">
            <label className="small">
              <input type="checkbox" data-testid="intake-include-anyway" aria-label={`Include ${i.label} anyway`} checked={!!target && inc.include.includes(i.label)} disabled={inc.disabled || !target} onChange={() => inc.onInclude(i.label)} /> Include anyway
            </label>
            {!target ? <span className="muted small"> (nothing in its folder is being added)</span> : null}
          </span>
        ) : null}
      </li>
    );
  }
  const shown = i.paths.slice(0, PATHS_SHOWN);
  return (
    <li className="intake-folder" data-testid="intake-excluded-folder">
      <details>
        <summary>
          <code>{i.label}</code> <span className="muted">{i.note}</span>
        </summary>
        <ul className="intake-folder-files">
          {shown.map((p) => (
            <li key={p}>
              <code>{p}</code>
            </li>
          ))}
          {i.paths.length > shown.length ? <li className="muted">and {count(i.paths.length - shown.length, "more file")}</li> : null}
        </ul>
      </details>
    </li>
  );
}

function ExclusionCard({ g, inc }: { g: ExclusionGroup; inc?: IncludeControl }) {
  // only files blocked for their name can be included anyway; every other exclusion stays out
  const rowInc = g.kind === "secret" ? inc : undefined;
  const shown = g.items.slice(0, 6);
  const rest = g.items.slice(shown.length);
  return (
    <li className={`intake-card intake-excl intake-excl-${g.state}`} data-testid="intake-exclusion" data-kind={g.kind}>
      <div className="intake-card-head">
        <span className={`intake-excl-icon intake-excl-icon-${g.state}`} aria-hidden="true">
          <Icon name={g.icon} size={16} />
        </span>
        <strong>{g.title}</strong>
        <span className="muted small">{count(g.files, "file")}</span>
      </div>
      <p className="small">
        {g.why}
        {rowInc ? " If you have opened a file and it holds no secret, you can include it anyway." : null}
      </p>
      <ul className="intake-paths small">
        {shown.map((i) => (
          <ExclusionRow key={i.label} i={i} inc={rowInc} />
        ))}
        {rest.length ? (
          <li className="intake-folder">
            <details>
              <summary className="muted">and {count(rest.length, "more item")}</summary>
              <ul className="intake-paths">
                {rest.map((i) => (
                  <ExclusionRow key={i.label} i={i} inc={rowInc} />
                ))}
              </ul>
            </details>
          </li>
        ) : null}
      </ul>
    </li>
  );
}

export interface InventoryViewProps {
  intake: IntakeView;
  projectName: string;
  skip: string[];
  onToggle: (resourceName: string) => void;
  onConfirm: () => void;
  busy: boolean;
  error: unknown;
  /** back to the source choice */
  startOverHref: string;
  /** the project's existing folder names (a planned name that is taken is not mounted) */
  existing: string[];
  /** owner only: blocked-by-name files ticked "Include anyway" (absent: no include controls) */
  include?: string[];
  onInclude?: (path: string) => void;
  /** the attestation sentence is ticked */
  attested?: boolean;
  onAttest?: (attested: boolean) => void;
}

/** The dry-run result: where each part goes, what is left out and why, and one Confirm. */
export function InventoryView({ intake, projectName, skip, onToggle, onConfirm, busy, error, startOverHref, existing, include, onInclude, attested = false, onAttest }: InventoryViewProps) {
  const plan = intake.plan ?? { placements: [], excluded: [] };
  const groups = groupExclusions(plan.excluded);
  const chosen = plan.placements.filter((p) => !skip.includes(p.resourceName) && !existing.includes(p.resourceName));
  const target = (path: string) => includeTarget(path, chosen);
  const other = new Set(plan.excluded.filter((e) => exclusionKind(e.reason) !== "secret").map((e) => e.path));
  const inc: IncludeControl | undefined = include && onInclude ? { include, onInclude, target, other, disabled: busy } : undefined;
  // a ticked file whose part was unticked afterwards is not sent
  const including = (include ?? []).filter((p) => target(p) !== null && !other.has(p));
  const needsAttest = including.length > 0 && !attested;
  const secrets = groups.find((g) => g.kind === "secret")?.files ?? 0;
  const checked = intake.inventory?.files ?? plan.placements.reduce((n, p) => n + p.files, 0) + plan.excluded.length;
  return (
    <section className="intake-inventory" data-testid="intake-inventory" aria-label="What the check found">
      <div className="chip-row" aria-label="Summary">
        <Chip result="pass">{count(checked, "file")} checked, nothing run</Chip>
        <Chip result="neutral" icon="files">
          {count(plan.placements.length, "place", "places")} to put them
        </Chip>
        {plan.excluded.length ? <Chip result="warn">{count(plan.excluded.length, "file")} left out</Chip> : null}
        {secrets ? (
          <Chip result="fail" icon="lock" testId="intake-secret-chip">
            {count(secrets, "file")} that may contain secrets blocked
          </Chip>
        ) : null}
      </div>

      <h3 className="intake-h">Where your files go</h3>
      {plan.placements.length === 0 ? (
        <EmptyState compact icon="inbox" title="Nothing to add.">
          Every file in the archive was left out. The reasons are below.
        </EmptyState>
      ) : (
        <ul className="intake-grid">
          {plan.placements.map((p) => (
            <PlacementCard key={p.resourceName} p={p} included={!skip.includes(p.resourceName)} disabled={busy} taken={existing.includes(p.resourceName)} onToggle={() => onToggle(p.resourceName)} />
          ))}
        </ul>
      )}

      {groups.length ? (
        <>
          <h3 className="intake-h">Left out, and why</h3>
          <ul className="intake-grid">
            {groups.map((g) => (
              <ExclusionCard key={g.kind} g={g} inc={inc} />
            ))}
          </ul>
        </>
      ) : null}

      <div className="confirm confirm-decision intake-confirm-box">
        <div className="confirm-title">Add {count(chosen.length, "resource")} to {projectName}?</div>
        <ul className="confirm-facts small">
          <li className="confirm-does">
            Creates {chosen.map((p) => p.resourceName).join(", ") || "nothing"} and adds {chosen.length === 1 ? "it as a folder of this project, with its own" : "them as folders of this project, each with its own"} version history.
          </li>
          <li className="confirm-does-not" data-testid="intake-starts-empty">Does not copy the files in yet: that server step is not available, so the new folders start empty.</li>
          {including.length ? (
            <li className="confirm-does" data-testid="intake-included-fact">
              Includes {including.join(", ")} at your request, in {[...new Set(including.map((p) => target(p)))].join(", ")}, when the files are copied in.
            </li>
          ) : null}
          <li className="confirm-does-not">Does not change existing folders, versions or what is live. {including.length ? "Other left-out files are not stored." : "Left-out files are not stored."}</li>
        </ul>
        {including.length ? (
          <label className="small intake-attest" data-testid="intake-include-attest">
            <input type="checkbox" checked={attested} disabled={busy} onChange={(e) => onAttest?.(e.target.checked)} /> {attestSentence(including.length)}
          </label>
        ) : null}
        <div className="confirm-actions">
          <button type="button" className="btn btn-primary" data-testid="intake-confirm" disabled={busy || chosen.length === 0 || needsAttest} onClick={onConfirm}>
            {busy ? "Adding…" : `Add to ${projectName}`}
          </button>
          <Link className="btn btn-quiet" href={startOverHref}>
            Start over
          </Link>
        </div>
      </div>
      <ErrorNote error={error} />
    </section>
  );
}

export interface ResultViewProps {
  org: string;
  pid: string;
  result: IntakeConfirmResult;
  /** live state of each created resource (undefined while loading) */
  states: Record<string, { state: string; hasVersion: boolean } | undefined>;
  mounts: Mount[];
}

/** After Confirm: what exists now, and (honestly) what is still to come. */
export function ResultView({ org, pid, result, states, mounts }: ResultViewProps) {
  return (
    <section className="intake-result" data-testid="intake-result" aria-label="Added to the project">
      {result.pendingPopulation ? (
        <div className="note note-warn small intake-pending" role="status" data-testid="intake-pending">
          <Icon name="alert" size={16} />
          <span>
            {result.resources.length === 1 ? "1 resource was created. Its content is" : `${count(result.resources.length, "resource")} were created. Their content is`} still to be copied in from the archive: that needs a server step that is not available yet, so {result.resources.length === 1 ? "it is" : "they are"} empty for now. The archive stays staged, and nothing in it was run.
          </span>
        </div>
      ) : (
        <div className="note note-good small" role="status">
          Added {count(result.resources.length, "resource")}.
        </div>
      )}
      <ul className="intake-grid">
        {result.resources.map((r) => {
          const s = states[r.resourceId];
          // the Worker reports a folder only when it really added one
          const mount = mounts.find((m) => m.resourceId === r.resourceId)?.mountName ?? r.mountName;
          const icon = resourceIcon(r.provider, r.name);
          const ready = s?.hasVersion && !result.pendingPopulation;
          const badge: { state: StateKind; label: string } = !s
            ? { state: "working", label: "Checking…" }
            : s.state === "failed"
              ? { state: "blocked", label: "Failed" }
              : s.state === "importing"
                ? { state: "working", label: "Importing" }
                : ready
                  ? { state: "ready", label: "Ready" }
                  : { state: "decision", label: "Created · content pending" };
          return (
            <li key={r.resourceId} className="intake-card" data-testid="intake-created">
              <div className="intake-card-head">
                <span className={`icon icon-${icon}`} aria-hidden="true">
                  <Icon name={icon} size={18} />
                </span>
                <strong>{r.name}</strong>
              </div>
              <div>
                <Badge state={badge.state} size="sm" icon>
                  {badge.label}
                </Badge>
              </div>
              <div className="muted small">
                {storedIn(r.provider)}
                {mount ? ` · folder ${mount}` : " · not added as a folder"}
              </div>
              {mount ? (
                <Link className="small" href={projectHref(org, pid, "files", { mount })}>
                  Open in Files
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
      {result.includedAnyway?.length ? (
        <p className="small" data-testid="intake-included-anyway">
          Included at your request after you inspected {result.includedAnyway.length === 1 ? "it" : "them"}: {result.includedAnyway.join(", ")}. {result.pendingPopulation ? "Copied in with the rest once that step is available." : null}
        </p>
      ) : null}
      {result.excluded ? <p className="muted small">{count(result.excluded, "file")} left out, as shown in the check.</p> : null}
    </section>
  );
}

// ------------------------------------------------------------------------------- containers

function StartView() {
  const { api } = useApp();
  const { org, pid, project } = useProject();
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [name, setName] = useState("");
  const zip = useAction(async (f: File) => {
    const r = await api.startZipIntake(org, f, f.name);
    navigate(intakeHref(org, pid, r.intakeId));
  });
  const imp = useAction(async () => {
    const n = name.trim() || nameFromUrl(url);
    const r = await api.startUrlIntake(org, { url: url.trim(), branch: branch.trim() || "main", name: n, projectId: pid, mountName: folderName(n) });
    navigate(intakeHref(org, pid, r.intakeId));
  });
  const n = name.trim() || nameFromUrl(url);
  const taken = n && project.mounts.some((m) => m.mountName === folderName(n)) ? `This project already has a folder named ${folderName(n)}. Choose another name.` : null;
  const onUrl = (e: FormEvent) => {
    e.preventDefault();
    if (!taken) void imp.run();
  };
  return (
    <>
      <div className="intake-sources">
        <Card title={<><Icon name="upload" size={18} /> Upload a ZIP</>} className="intake-source">
          <p className="small">A ZIP of the project folder you have: code, media, notes. We list it, sort it and show you the plan first.</p>
          <p className="small note note-warn" data-testid="intake-zip-empty">Confirming creates the planned folders empty for now: copying the archive's files in needs a server step that is not available yet. To bring code in with its files, import it from Git.</p>
          <DropZone inputLabel="Project archive (ZIP)" accept=".zip,application/zip" file={file} onFile={setFile} title="Drop the ZIP here" hint="or click to choose it (up to 100 MB)" disabled={zip.busy} />
          <button type="button" className="btn btn-primary" disabled={!file || zip.busy} onClick={() => file && void zip.run(file)}>
            {zip.busy ? "Uploading…" : "Check this archive"}
          </button>
          <ErrorNote error={zip.error} />
        </Card>
        <Card title={<><Icon name="repo" size={18} /> Import a public Git repository</>} className="intake-source">
          <p className="small">Keeps the repository's full history. Public https addresses only.</p>
          <p className="small note" data-testid="intake-git-public">Private repositories are not supported yet: the repository must be readable without signing in.</p>
          <form onSubmit={onUrl}>
            <label className="field small">
              Repository address
              <input type="text" inputMode="url" placeholder="https://github.com/agency/portal-website" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <div className="intake-row">
              <label className="field small">
                Branch
                <input type="text" value={branch} onChange={(e) => setBranch(e.target.value)} />
              </label>
              <label className="field small">
                Folder name
                <input type="text" placeholder={nameFromUrl(url) || "website"} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            </div>
            {taken ? <p className="small warn-text">{taken}</p> : null}
            <button type="submit" className="btn" disabled={!url.trim() || !n || !!taken || imp.busy}>
              {imp.busy ? "Starting…" : "Import repository"}
            </button>
          </form>
          <ErrorNote error={imp.error} />
        </Card>
      </div>
      <p className="muted small intake-trust">
        <Icon name="lock" size={14} /> Checking never runs anything from your files. Files that may contain secrets (an .env, a registry token in .npmrc) are blocked by name; their contents are never read or shown.
      </p>
    </>
  );
}

function CreatedStates({ result }: { result: IntakeConfirmResult }) {
  const { api } = useApp();
  const { org, pid, project } = useProject();
  const states = useLoad(
    async () => {
      const out: ResultViewProps["states"] = {};
      for (const r of result.resources) {
        const d = await api.getResource(org, r.resourceId);
        out[r.resourceId] = { state: d.state, hasVersion: !!d.head };
      }
      return out;
    },
    `${org}/intake-created/${result.resources.map((r) => r.resourceId).join(",")}`,
    POLL_INTAKE_MS * 2,
  );
  return <ResultView org={org} pid={pid} result={result} states={states.data ?? {}} mounts={project.mounts} />;
}

function Following({ intakeId }: { intakeId: string }) {
  const { api } = useApp();
  const { org, pid, project, reloadProject, role } = useProject();
  const [skip, setSkip] = useState<string[] | null>(null);
  const [include, setInclude] = useState<string[]>([]);
  const [attested, setAttested] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const intake = useLoad(() => api.getIntake(org, intakeId), `${org}/intake/${intakeId}`, terminal ? undefined : POLL_INTAKE_MS);
  const i = intake.data;
  const done = !!i && ["confirmed", "completed", "failed"].includes(i.state);
  // stop polling once settled; a finished URL import adds a mount the project view must re-read
  const imported = i?.kind === "url" && i.state === "completed" ? String(i.request.resourceId) : null;
  const missing = !!imported && !project.mounts.some((m) => m.resourceId === imported);
  useEffect(() => {
    setTerminal(done);
  }, [done]);
  useEffect(() => {
    if (missing) reloadProject?.();
  }, [missing, reloadProject]);
  // planned names that are already folders start unticked: confirming them would not mount them
  const existing = project.mounts.map((m) => m.mountName);
  const planned = i?.plan?.placements.map((p) => p.resourceName) ?? null;
  useEffect(() => {
    if (planned && skip === null) setSkip(planned.filter((n) => existing.includes(n)));
  }, [planned, skip, existing]);
  const confirm = useAction(async () => {
    // names that are already folders are never sent (the Worker refuses them with mount_exists)
    const skipped = [...new Set([...(skip ?? []), ...(planned ?? []).filter((n) => existing.includes(n))])];
    // only files whose part is still being added are sent (the Worker refuses the rest)
    const chosen = (i?.plan?.placements ?? []).filter((p) => !skipped.includes(p.resourceName));
    const included = include.filter((p) => includeTarget(p, chosen) !== null);
    await api.confirmIntake(org, intakeId, { projectId: pid, skip: skipped, ...(included.length ? { include: included } : {}) });
    intake.reload();
    reloadProject?.();
  });
  if (intake.error) return <ErrorNote error={intake.error} onRetry={intake.reload} />;
  if (!i) return <Loading what="Opening intake" />;
  const steps = i.kind === "url" ? URL_STEPS : ZIP_STEPS;
  const filename = String(i.request.filename ?? i.request.url ?? "");
  const result = confirmResult(i);
  return (
    <>
      <StateRail variant="developer" steps={steps} position={intakePosition(i)} label="Add files progress" />
      <p className="intake-source-line small">
        <Icon name={i.kind === "url" ? "repo" : "upload"} size={14} /> {i.kind === "url" ? "Repository" : "Archive"} <code>{filename}</code>
        {i.kind === "zip" && typeof i.request.size === "number" ? <span className="muted"> · {formatBytes(i.request.size)}</span> : null}
        {i.kind === "url" && i.request.branch ? <span className="muted"> · branch {String(i.request.branch)}</span> : null}
      </p>
      {i.state === "failed" ? (
        <div className="note note-bad" role="alert">
          <span>{intakeErrorSentence(i.kind, i.error)} Nothing was added to the project.</span>
          <Link className="btn btn-quiet btn-small" href={intakeHref(org, pid)}>
            Try again
          </Link>
          {i.error ? (
            <details className="small intake-error-detail">
              <summary>Technical detail</summary>
              <code>{i.error}</code>
            </details>
          ) : null}
        </div>
      ) : i.state === "inventorying" ? (
        <div className="small" role="status">
          <span className="pulse" aria-hidden="true" /> Listing the archive in an isolated sandbox. Nothing in it is run…
        </div>
      ) : i.state === "queued" || i.state === "importing" ? (
        <div className="small" role="status">
          <span className="pulse" aria-hidden="true" /> Importing the repository with its history. Large repositories can take a minute…
        </div>
      ) : i.state === "completed" ? (
        <div className="note note-good small" role="status" data-testid="intake-result">
          <span>Imported. It is now a folder of {project.name}, with its first version in place.</span>
          {i.request.mountName ? (
            <Link className="btn btn-quiet btn-small" href={projectHref(org, pid, "files", { mount: String(i.request.mountName) })}>
              Open in Files
            </Link>
          ) : null}
        </div>
      ) : i.state === "inventoried" || i.state === "confirming" ? (
        <InventoryView intake={i} projectName={project.name} skip={skip ?? []} existing={existing} onToggle={(n) => setSkip((s) => (s ?? []).includes(n) ? (s ?? []).filter((x) => x !== n) : [...(s ?? []), n])} onConfirm={() => void confirm.run()} busy={confirm.busy || i.state === "confirming"} error={confirm.error} startOverHref={intakeHref(org, pid)}
          include={role === "owner" ? include : undefined}
          onInclude={(path) => {
            // ticking another file asks for the attestation again
            setAttested(false);
            setInclude((s) => (s.includes(path) ? s.filter((x) => x !== path) : [...s, path]));
          }}
          attested={attested}
          onAttest={setAttested}
        />
      ) : result ? (
        <CreatedStates result={result} />
      ) : (
        <Loading what="Finishing" />
      )}
    </>
  );
}

export function IntakeScreen({ intakeId }: { intakeId?: string }) {
  const { org, pid, role } = useProject();
  // adding folders is project membership: owners only, like adding a mount (the Worker enforces it)
  if (role !== "owner") {
    return <EmptyState icon="lock" title="Only the project owner adds files to a project.">{role === "developer" ? "Ask an owner to add what you have; they see the plan before anything is added." : "Ask your developer to add what you have."}</EmptyState>;
  }
  return (
    <div className="intake">
      <header className="intake-head">
        <div>
          <h2>Add files</h2>
          <p className="muted small">Bring in what you already have. A ZIP is checked first and nothing is added until you confirm the plan; a public Git repository is imported as soon as you start it.</p>
        </div>
        <Link className="btn btn-quiet btn-small" href={projectHref(org, pid, "files")}>
          Back to Files
        </Link>
      </header>
      {intakeId ? (
        <Following key={intakeId} intakeId={intakeId} />
      ) : (
        <>
          <StateRail variant="developer" steps={ZIP_STEPS} position={intakePosition(null)} label="Add files progress" />
          <StartView />
        </>
      )}
    </div>
  );
}
