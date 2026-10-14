/**
 * Versions: the accepted history of each resource as a timeline of version cards, newest first,
 * numbered like the project's history ("Version 3"), with "Restore this version".
 * A restore is a new recorded version pointing at a retained revision; nothing is erased.
 * - Developers (write grant) restore after a confirm sheet that says what restore does and does not do.
 * - Clients cannot restore (API.md: write grant): "Ask to restore" opens the same sheet, which asks the developer.
 * UX-3 slot: `versionActions` renders extra actions on each card (e.g. "Publish this version"),
 * `restoredExtra` under the "Restored." note.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Mount, ResourceDetail, Role, VersionEntry } from "../api/types.js";
import { askDeveloperHref, liveHeadPerResource, liveSite, versionById, versionSummary } from "../lib/client-flow.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import { formatTime, isDeveloperRole, newIdempotencyKey, providerKind, providerLabel, revisionLabel, shortCode } from "../lib/model.js";
import { intakeHref, navigate, projectHref, proposalHref } from "../lib/router.js";
import { Badge, ConfirmSheet, EmptyState, Icon, resourceIcon, SiteThumb } from "../primitives/index.js";
import { Card, ErrorNote, Link, Loading, Pill } from "../ui.js";
import { changeContext } from "./Changes.js";
import { useProjectHistory, type ProjectHistory } from "./client-data.js";
import { useProject } from "./project-data.js";
import { PublishVersion, publishTarget, releaseMounts } from "./PublishVersion.js";

/** The genesis bind (kind `bind`, or an older `accept` with no proposal) is the import. */
export function versionLabel(v: VersionEntry): string {
  if (v.kind === "restore") return "Restored an earlier version";
  if (v.kind === "bind") return "Imported (first version)";
  return v.proposalId ? "Accepted change" : "Imported (first version)";
}

/** How the project history names and describes each version (absent: still loading). */
export interface VersionNames {
  numberOf: (acceptedVersionId: string) => number | null;
  summaryOf: (acceptedVersionId: string) => string | null;
  /** the live version's accepted version ids */
  liveIds: ReadonlySet<string>;
}

export interface VersionsViewProps {
  org: string;
  pid: string;
  mount: Mount;
  resource: ResourceDetail;
  versions: VersionEntry[];
  role: Role;
  confirming: string | null;
  onAskRestore: (revision: string | null) => void;
  onRestore: (revision: string) => void;
  busy: boolean;
  error: unknown;
  restored: { acceptedVersionId: string; headRevisionId: string } | null;
  names?: VersionNames;
  /** clients: open the prepared message to the developer */
  onAskDeveloper?: (href: string) => void;
  /** UX-3 slot: extra actions on a version card */
  versionActions?: (v: VersionEntry, ctx: { current: boolean; live: boolean }) => ReactNode;
  /** UX-3 slot: under the "Restored." note */
  restoredExtra?: ReactNode;
  now?: Date;
}

/** A stable DOM id for a version row's "Restore this version" button (focus returns to it). */
export function restoreButtonId(revision: string): string {
  return `restore-${revision.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function VersionsView({ org, pid, mount, resource, versions, role, confirming, onAskRestore, onRestore, busy, error, restored, names, onAskDeveloper, versionActions, restoredExtra, now }: VersionsViewProps) {
  // after a restore the trigger row is gone: focus the "Restored." note instead
  const restoredNote = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (restored) restoredNote.current?.focus();
  }, [restored]);
  const head = resource.head?.revisionId;
  const developer = isDeveloperRole(role);
  const canRestore = developer && resource.operations.includes("write");
  // clients and viewers see what restore would do and ask the developer (they hold read grants only)
  const canAsk = !developer && role !== "viewer";
  const nameOf = (v: VersionEntry) => {
    const n = names?.numberOf(v.acceptedVersionId);
    return n != null ? `Version ${n}` : "This version";
  };
  const restoredNumber = restored ? names?.numberOf(restored.acceptedVersionId) : null;
  return (
    <Card title={<><Icon name={resourceIcon(mount.provider, mount.resourceName)} size={18} /> {mount.resourceName} {developer ? <span className="muted small">{providerLabel(mount.provider)}</span> : null}</>}>
      {restored ? (
        <div className="note note-good" role="status" tabIndex={-1} ref={restoredNote}>
          <span>
            Restored. {mount.resourceName} is back as a new version{restoredNumber != null ? `, Version ${restoredNumber}` : ""}. The earlier history is kept.
            {" "}
            Nothing is published until a release of it goes live.
          </span>
          {restoredExtra}
        </div>
      ) : null}
      <ErrorNote error={error} />
      {versions.length === 0 ? (
        <EmptyState compact icon="versions" title={developer ? "No versions yet." : "No versions yet. Your developer imports the project first."}>
          {developer ? "A folder gets its first version when its import or setup finishes. Accepted changes and restores add the next ones." : null}
        </EmptyState>
      ) : (
        <ol className="versions" data-testid="versions">
          {versions.map((v) => {
            const rev = v.head?.revisionId ?? "";
            const current = rev === head && v === versions.find((x) => x.head?.revisionId === head);
            const live = names?.liveIds.has(v.acceptedVersionId) ?? false;
            const label = nameOf(v);
            const summary = names?.summaryOf(v.acceptedVersionId);
            const offer = !current && !!rev && rev !== head;
            const sheet =
              confirming === rev && offer ? (
                canRestore ? (
                  <ConfirmSheet
                    title={`Restore ${label}?`}
                    confirmLabel="Restore this version"
                    busyLabel="Restoring…"
                    busy={busy}
                    onConfirm={() => onRestore(rev)}
                    onCancel={() => onAskRestore(null)}
                    returnFocusId={restoreButtonId(rev)}
                    does={`Brings ${mount.resourceName} back to ${label}. This records a new version; nothing is deleted.`}
                    doesNot="It does not publish to the live site, and it does not undo database changes or releases."
                  />
                ) : canAsk ? (
                  <ConfirmSheet
                    title="Your developer restores versions"
                    confirmLabel="Ask the developer to restore"
                    onConfirm={() => onAskDeveloper?.(askDeveloperHref(`Please restore ${label} of the ${mount.resourceName}`, `Hi,\n\nCould you restore ${label} of the ${mount.resourceName} (${summary ?? versionLabel(v)})?\n\nThanks!\n`))}
                    onCancel={() => onAskRestore(null)}
                    returnFocusId={restoreButtonId(rev)}
                    does={`Restoring brings ${mount.resourceName} back to ${label} as a new version; nothing is deleted.`}
                    doesNot="It does not publish to your live site by itself, and it does not undo orders, payments or other data."
                  />
                ) : null
              ) : null;
            return (
              <li key={v.acceptedVersionId} className={`version ${current ? "version-current" : ""} ${live ? "version-live" : ""}`.replace(/\s+/g, " ").trim()}>
                <div className="version-card">
                  <SiteThumb size="mini" accent={live} />
                  <div className="version-main">
                    <div className="version-title">
                      <strong>{label}</strong>
                      {developer || !summary ? <span className="version-kind">{versionLabel(v)}</span> : null}
                      {live ? <Badge state="ready" size="sm">Live</Badge> : null}
                      {current ? <Pill tone="good">Current</Pill> : null}
                    </div>
                    <div className="muted small">
                      {summary ? `${summary} · ` : ""}
                      {formatTime(v.acceptedAt, now)}
                    </div>
                    {developer ? (
                      <details className="muted small version-tech">
                        <summary>Details</summary>
                        revision <code title={rev}>{revisionLabel(rev)}</code>
                        {v.proposalHash ? (
                          <>
                            {" "}
                            · review code <code>{shortCode(v.proposalHash)}</code>
                          </>
                        ) : null}
                        {v.proposalId ? (
                          <>
                            {" "}
                            · <Link href={proposalHref(org, pid, v.proposalId)}>Open the change</Link>
                          </>
                        ) : null}
                      </details>
                    ) : null}
                  </div>
                  {/* actions: Restore, then the UX-3 slot */}
                  <div className="version-actions">
                    {offer && (canRestore || canAsk) && confirming !== rev ? (
                      <button type="button" id={restoreButtonId(rev)} className="btn btn-small" data-testid="restore-version" onClick={() => onAskRestore(rev)}>
                        {canRestore ? "Restore this version" : "Ask to restore"}
                      </button>
                    ) : null}
                    {versionActions?.(v, { current, live })}
                  </div>
                </div>
                {sheet}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function ResourceVersions({ mount, history, openVersion }: { mount: Mount; history: { data: ProjectHistory | undefined; reload: () => void }; openVersion?: string }) {
  const { api } = useApp();
  const { org, pid, role, live, project, reloadLive } = useProject();
  const data = useLoad(async () => {
    const [resource, versions] = await Promise.all([api.getResource(org, mount.resourceId), api.listVersions(org, mount.resourceId)]);
    return { resource, versions };
  }, `${org}/${mount.resourceId}`);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [restored, setRestored] = useState<{ acceptedVersionId: string; headRevisionId: string } | null>(null);
  const key = useRef<string>("");
  const opened = useRef(false);
  const restore = useAction(async (target: string) => {
    const head = data.data?.resource.head?.revisionId;
    if (!head) return;
    const r = await api.restore(org, mount.resourceId, { expectedHead: head, targetRevision: target, idempotencyKey: key.current });
    setRestored(r);
    setConfirming(null);
    data.reload();
    history.reload();
    reloadLive();
  });
  const ask = (rev: string | null) => {
    // a fresh key per restore decision; retries of the same decision reuse it
    if (rev) key.current = newIdempotencyKey(`restore:${mount.resourceId}`);
    setRestored(null);
    restore.clearError();
    setConfirming(rev);
  };
  // a link from the Overview ("Restore this version") opens that version's sheet once
  useEffect(() => {
    if (opened.current || !openVersion || !data.data) return;
    opened.current = true;
    const v = data.data.versions.find((x) => x.acceptedVersionId === openVersion);
    if (v?.head && v.head.revisionId !== data.data.resource.head?.revisionId) ask(v.head.revisionId);
  }, [data.data, openVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  // A release went live (seen by the project's poll): re-read the history so "Live" moves. The
  // publish panel does this too, but a first publish closes the panel as soon as it is live.
  const liveRelease = live?.releases === undefined ? undefined : (live.releases.live?.releaseId ?? null);
  const seenLive = useRef(liveRelease);
  useEffect(() => {
    if (liveRelease === undefined) return;
    if (seenLive.current !== undefined && seenLive.current !== liveRelease) history.reload();
    seenLive.current = liveRelease;
  }, [liveRelease]); // eslint-disable-line react-hooks/exhaustive-deps
  if (data.error) return <ErrorNote error={data.error} onRetry={data.reload} />;
  if (!data.data) return <Loading what="Loading versions" />;
  const h = history.data;
  const cx = live ? changeContext(live, project, role) : null;
  const titleOf = (proposalId: string) => {
    const changeId = cx?.changeOfProposal(proposalId);
    return changeId && cx ? cx.titleOf(changeId) : null;
  };
  const site = h ? liveSite(h.releases, h.versions) : null;
  // the live entry of this resource: its newest at or before the live version (review m1)
  const liveHead = h ? liveHeadPerResource(h.perResource, h.versions, site?.number ?? null).get(mount.resourceId) : undefined;
  const names: VersionNames | undefined = h
    ? {
        numberOf: (id) => versionById(h.versions, id)?.number ?? null,
        summaryOf: (id) => {
          const v = versionById(h.versions, id);
          return v ? versionSummary(v, titleOf) : null;
        },
        liveIds: new Set(liveHead ? [liveHead] : []),
      }
    : undefined;
  // UX-3: restore-then-publish (the panel is self-contained in PublishVersion.tsx)
  // nothing published yet: offer the first publish on a folder the release builds
  const firstPublish = live?.releases !== undefined && live.releases.live === null && releaseMounts(project.policy).has(mount.mountName);
  const publishVersion = publishTarget(role, data.data.resource, data.data.versions, restored, firstPublish);
  return (
    <div className="versions-main">
    <VersionsView
      org={org}
      pid={pid}
      mount={mount}
      resource={data.data.resource}
      versions={data.data.versions}
      role={role}
      confirming={confirming}
      onAskRestore={ask}
      onRestore={(rev) => void restore.run(rev)}
      onAskDeveloper={(href) => {
        window.location.assign(href);
        setConfirming(null);
      }}
      busy={restore.busy}
      error={restore.error}
      restored={restored}
      {...(names ? { names } : {})}
    />
    {publishVersion ? <PublishVersion key={publishVersion} mount={mount} acceptedVersionId={publishVersion} justRestored={restored?.acceptedVersionId === publishVersion} versions={data.data.versions} versionNumber={names?.numberOf(publishVersion) ?? null} onChanged={history.reload} /> : null}
    </div>
  );
}

export function VersionsScreen({ mount, version }: { mount?: string; version?: string }) {
  const { org, pid, project, role } = useProject();
  const history = useProjectHistory("versions");
  // a version link without a mount picks the first resource that version touched
  const byVersion = version && !mount ? history.data?.perResource.find((r) => r.versions.some((v) => v.acceptedVersionId === version))?.resourceId : undefined;
  if (version && !mount && !history.data && !history.error) return <Loading what="Loading versions" />;
  const selected = project.mounts.find((m) => m.mountName === mount) ?? project.mounts.find((m) => m.resourceId === byVersion) ?? project.mounts[0];
  const dev = isDeveloperRole(role);
  if (!selected)
    return (
      <EmptyState icon="versions" title="This project has no folders yet, so it has no versions." action={role === "owner" ? <Link className="btn btn-primary" href={intakeHref(org, pid)}>Import from Git</Link> : undefined}>
        {role === "owner" ? "Import the code from a Git repository: its current commit becomes the first version." : dev ? "The project owner adds the project's folders. Their versions appear here." : "Your developer adds the project's files first. Each version appears here."}
      </EmptyState>
    );
  return (
    <div className="versions-layout">
      <nav className="resource-picker" aria-label="Resources">
        <p className="muted small">{dev ? "Each resource keeps its own accepted history. A change across several resources is accepted as one version of all of them." : "Pick a part of your project to see its versions. A change to several parts is one version of all of them."}</p>
        {project.mounts.map((m) => (
          <button key={m.mountName} type="button" className={`picker-item ${m.mountName === selected.mountName ? "picker-item-active" : ""}`} onClick={() => navigate(projectHref(org, pid, "versions", { mount: m.mountName }), { replace: true })}>
            <span className="picker-name">
              <Icon name={resourceIcon(m.provider, m.resourceName)} size={16} />
              {m.resourceName}
            </span>
            {dev ? <span className={`tag tag-${providerKind(m.provider)}`}>{providerKind(m.provider) === "assets" ? "R2" : "Git"}</span> : null}
          </button>
        ))}
      </nav>
      <ResourceVersions key={selected.resourceId} mount={selected} history={history} {...(version ? { openVersion: version } : {})} />
    </div>
  );
}
