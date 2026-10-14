/**
 * Versions → "Publish this version" (UX-3): after "Restore this version" (or, for owners, on a
 * restored version that is not live), take the version through the same release gate as any
 * accepted change: prepare (`POST /releases {acceptedVersionId}`) → publish approval (owner by
 * default) → deploy → `/version` check. Restoring never deploys; this panel says so until the
 * release is live.
 *
 * Kept in its own file so the Versions timeline (restyled in UX-2) only mounts it.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import type { CommonForgeApi } from "../api/client.js";
import type { Mount, ReleaseList, ReleaseView, ResourceDetail, Role, VersionEntry } from "../api/types.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import { isDeveloperRole, newIdempotencyKey, providerKind } from "../lib/model.js";
import { Badge, Icon, StateRail, type RailPosition, type StateKind } from "../primitives/index.js";
import { Card, ErrorNote } from "../ui.js";
import { POLL_MS, useProject } from "./project-data.js";
import { ReleaseControls, type PublishPanelProps } from "./ReleasePanels.js";

export const PUBLISH_STEPS = ["Prepare", "Approve publishing", "Publish", "Live"] as const;

/** The newest release of exactly this accepted version (a failed build is replaced by a new one). */
export function releaseOfVersion(list: ReleaseList | undefined, acceptedVersionId: string | null): ReleaseView | null {
  if (!list || !acceptedVersionId) return null;
  return list.releases.find((r) => r.acceptedVersionId === acceptedVersionId) ?? null;
}

/** Where a release is on the four-step publish rail, honestly coloured. */
export function publishPosition(rel: ReleaseView | null): RailPosition {
  if (!rel) return { current: 0, state: "neutral", complete: false };
  if (rel.live) return { current: 3, state: "ready", complete: true };
  if (rel.buildState === "building") return { current: 0, state: "working", complete: false };
  if (rel.buildState === "failed") return { current: 0, state: "blocked", complete: false };
  switch (rel.state) {
    case "prepared":
      return { current: 1, state: "decision", complete: false };
    case "publish_approved":
      return { current: 2, state: "decision", complete: false };
    case "deploying":
      return { current: 2, state: "working", complete: false };
    case "health_verification":
      return { current: 3, state: "working", complete: false };
    case "failed":
    case "partial":
      return { current: 2, state: "blocked", complete: false };
    case "recovery_required":
      return { current: 3, state: "blocked", complete: false };
    default:
      return { current: 0, state: "working", complete: false };
  }
}

/** One plain badge for the release's state: "Not live", "Approved, not live", "Live", "Rolled back", … */
export function publishBadge(rel: ReleaseView | null): { state: StateKind; label: string; pulse?: boolean } {
  if (!rel) return { state: "neutral", label: "Not live" };
  if (rel.live) return { state: "ready", label: "Live" };
  if (rel.buildState === "building") return { state: "working", label: "Building", pulse: true };
  if (rel.buildState === "failed") return { state: "blocked", label: "Build failed" };
  if (rel.state === "recovery_required") {
    if (rel.rollback?.state === "running" || rel.rollback?.state === "verifying") return { state: "blocked", label: "Not verified, rolling back", pulse: true };
    return { state: "blocked", label: "Recovery required" };
  }
  if (rel.state === "failed" && rel.rollback?.state === "done") return { state: "blocked", label: "Rolled back" };
  if (rel.state === "deploying" || rel.state === "health_verification") return { state: "working", label: rel.status, pulse: true };
  if (rel.state === "prepared") return { state: "decision", label: "Ready for publish approval" };
  if (rel.publishApproved) return { state: "decision", label: "Approved, not live" };
  return { state: "neutral", label: rel.status };
}

/**
 * Which version Versions offers to publish, if any: the one just restored here, or (for anyone
 * who can restore it) a current version that is itself a restore, so the offer survives a reload.
 * Publishing needs write access to the release sources; the Worker re-checks every step.
 */
export function publishTarget(role: Role, resource: ResourceDetail, versions: VersionEntry[], restored: { acceptedVersionId: string } | null, firstPublish = false): string | null {
  if (!isDeveloperRole(role) || !resource.operations.includes("write")) return null;
  if (restored) return restored.acceptedVersionId;
  const head = resource.head?.acceptedVersionId ?? null;
  // nothing is live yet: the current version (an import's first version, too) is the first publish,
  // which staging waits for (API.md "Baseline")
  if (firstPublish && head) return head;
  const current = versions.find((v) => v.acceptedVersionId === head);
  return current?.kind === "restore" ? head : null;
}

/** The folders a release builds from (`policy.release`: recipe steps and targets); empty without a release section. */
export function releaseMounts(policy: { release?: unknown } | undefined): Set<string> {
  const r = policy?.release as { recipe?: { steps?: Array<{ mountName?: unknown }> }; targets?: Array<{ mountName?: unknown }> } | undefined;
  const names = [...(r?.recipe?.steps ?? []), ...(r?.targets ?? [])].map((x) => x?.mountName).filter((x): x is string => typeof x === "string");
  return new Set(names);
}

/**
 * A 503 the server expects to clear by itself (`provider_unavailable`: Artifacts or the deploy
 * API briefly unavailable). `config_missing` is also 503 but needs an operator, so it is not.
 */
export function isRetryable(e: unknown): boolean {
  return e instanceof ApiError && e.status === 503 && e.code !== "config_missing";
}

export const RETRY_DELAYS_MS = [2000, 4000, 8000, 15000];

/**
 * Run `fn`, retrying retryable 503s with backoff; `onRetry(n)` reports each wait (null: settled).
 * Safe for every publish step: prepare is idempotent by its inputs, deploy reuses its idempotency
 * key, and a repeated publish approval binds the same output digest.
 */
export async function withRetry<T>(fn: () => Promise<T>, onRetry: (attempt: number | null) => void, sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fn();
      onRetry(null);
      return r;
    } catch (e) {
      if (!isRetryable(e) || attempt >= RETRY_DELAYS_MS.length) {
        onRetry(null);
        throw e;
      }
      onRetry(attempt + 1);
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}

/**
 * Deploy one release output. The idempotency key is kept per `releaseId:outputDigest` only while a
 * call is unresolved (a thrown error: a lost response or 503s), so a retry replays instead of
 * deploying twice; it is dropped after an answered call, so "Retry publish" after a failed deploy
 * starts a new attempt instead of replaying the old one (mirrors ProposalReview).
 */
export async function deployWithKey(api: Pick<CommonForgeApi, "deployRelease">, org: string, releaseId: string, outputDigest: string, keys: Map<string, string>, onRetry: (attempt: number | null) => void = () => {}, sleep?: (ms: number) => Promise<unknown>) {
  const k = `${releaseId}:${outputDigest}`;
  if (!keys.has(k)) keys.set(k, newIdempotencyKey(`deploy:${releaseId}`));
  const r = await withRetry(() => api.deployRelease(org, releaseId, keys.get(k)!), onRetry, sleep);
  keys.delete(k);
  return r;
}

/** "version 3" for an accepted version of this resource (its place in the resource's history), or undefined. */
export function versionNumberLabel(versions: VersionEntry[] | undefined, acceptedVersionId: string | null): string | undefined {
  if (!versions || !acceptedVersionId) return undefined;
  const i = versions.findIndex((v) => v.acceptedVersionId === acceptedVersionId);
  return i < 0 ? undefined : `version ${versions.length - i}`;
}

/** The 409 when another accepted version is what a release of this project would build now. */
export function staleVersion(error: unknown): string | null {
  if (error instanceof ApiError && error.code === "accepted_version_stale") {
    const cur = error.details?.currentAcceptedVersionId;
    return typeof cur === "string" ? cur : null;
  }
  return null;
}

export interface PublishVersionViewProps {
  role: Role;
  mount: Mount;
  /** the version to publish (the restore's new version, or the current head's) */
  acceptedVersionId: string;
  /** the version was just restored on this screen */
  justRestored: boolean;
  releases: ReleaseList | undefined;
  /** set after a stale prepare: publish the current version instead */
  current: string | null;
  publish: PublishPanelProps;
  onPublishCurrent: (acceptedVersionId: string) => void;
  /** a retryable 503 is being retried (attempt number), or null */
  retrying?: number | null;
  /** "version 3" of this resource, when known */
  versionLabel?: string | undefined;
}

export function PublishVersionView({ role, mount, acceptedVersionId, justRestored, releases, current, publish, onPublishCurrent, retrying = null, versionLabel }: PublishVersionViewProps) {
  const developer = isDeveloperRole(role);
  const target = current ?? acceptedVersionId;
  const rel = releaseOfVersion(releases, target);
  const liveId = releases?.live?.releaseId ?? null;
  const badge = publishBadge(rel);
  const stale = staleVersion(publish.error);
  return (
    <Card
      className="publish-version"
      testId="publish-version"
      title={
        <>
          <Icon name="upload" size={18} /> Publish this version
        </>
      }
      aside={<Badge state={badge.state} pulse={badge.pulse} icon>{badge.label}</Badge>}
    >
      <p className="small">
        {rel?.live
          ? "This version is live: production runs it now, after its own publish approval."
          : `${justRestored ? "Restoring changed the accepted version, not production." : "This version is accepted but not live."} ${liveId ? "Production keeps running the last published release until this one is published." : "Nothing has been published from this project yet."}`}
      </p>
      <StateRail variant="developer" steps={PUBLISH_STEPS} position={publishPosition(rel)} label="Publish progress" />
      {releases === undefined ? (
        <div className="muted small">Loading releases…</div>
      ) : !rel ? (
        stale && developer ? (
          <div className="note note-warn small" role="note">
            <p>A newer version was accepted after this one, and a release always builds the project's current code. Publishing now releases that current version, not this one.</p>
            <button type="button" className="btn btn-primary btn-small" disabled={publish.busy !== null} onClick={() => onPublishCurrent(stale)}>
              {publish.busy === "prepare" ? "Preparing…" : "Publish the current version"}
            </button>
          </div>
        ) : developer ? (
          <>
            <button type="button" className="btn btn-primary" disabled={publish.busy !== null} onClick={publish.onPrepare}>
              {publish.busy === "prepare" ? "Preparing…" : "Publish this version"}
            </button>
            <div className="muted small">Builds this version in the sandbox first. Nothing is deployed until an owner approves publishing it.</div>
          </>
        ) : null
      ) : (
        <ReleaseControls role={role} rel={rel} liveId={liveId} publish={publish} versionLabel={current ? "the current version" : versionLabel} />
      )}
      {retrying ? (
        <div className="note note-warn small" role="status" data-testid="publish-retrying">
          <span className="pulse" aria-hidden="true" /> Temporarily unavailable, retrying (attempt {retrying + 1} of {RETRY_DELAYS_MS.length + 1}). Nothing has failed.
        </div>
      ) : stale ? null : isRetryable(publish.error) ? (
        <div className="note note-warn small" role="alert">
          The service is still temporarily unavailable. Nothing was changed; try again in a minute.
        </div>
      ) : (
        <ErrorNote error={publish.error} />
      )}
    </Card>
  );
}

/**
 * Asset collections are never release sources (a release builds git mounts only), so a restored
 * asset version has nothing to publish: say so, neutrally, instead of offering a release.
 */
export function AssetRestoreNote({ mount, justRestored }: { mount: Mount; justRestored: boolean }) {
  return (
    <Card className="publish-version publish-version-assets" testId="publish-version-assets" title={<><Icon name="assets" size={18} /> Publishing and assets</>}>
      <p className="small">
        {justRestored ? `${mount.resourceName} is restored as the accepted version. ` : ""}
        Asset collections are not part of a release: publishing does not change which assets production uses.
      </p>
    </Card>
  );
}

/** The container: loads releases (polled while open) and runs prepare / approve / deploy / recover. */
export function PublishVersion(props: { mount: Mount; acceptedVersionId: string; justRestored: boolean; versions?: VersionEntry[]; /** the project-wide version number (UX-2 `names.numberOf`), preferred over the resource's own count */ versionNumber?: number | null; /** the release moved (Versions re-reads its project history, so "Live" moves too) */ onChanged?: () => void }) {
  if (providerKind(props.mount.provider) === "assets") return <AssetRestoreNote mount={props.mount} justRestored={props.justRestored} />;
  return <PublishCodeVersion {...props} />;
}

function PublishCodeVersion({ mount, acceptedVersionId, justRestored, versions, versionNumber, onChanged }: { mount: Mount; acceptedVersionId: string; justRestored: boolean; versions?: VersionEntry[]; versionNumber?: number | null; onChanged?: () => void }) {
  const { api } = useApp();
  const { org, pid, role, reloadLive } = useProject();
  const releases = useLoad(() => api.listReleases(org, pid), `${org}/releases/${pid}/v/${acceptedVersionId}`, POLL_MS);
  // when this version's release goes live (a poll, not a click), the timeline's "Live" must move with it
  const liveNow = releases.data?.live?.releaseId ?? null;
  const seenLive = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (releases.data === undefined) return;
    if (seenLive.current !== undefined && seenLive.current !== liveNow) onChanged?.();
    seenLive.current = liveNow;
  }, [liveNow, releases.data, onChanged]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<PublishPanelProps["busy"]>(null);
  const [retrying, setRetrying] = useState<number | null>(null);
  const deployKeys = useRef(new Map<string, string>());
  const action = useAction(async (step: Exclude<PublishPanelProps["busy"], null>, arg?: string, outputDigest?: string) => {
    setBusy(step);
    try {
      if (step === "prepare") {
        await withRetry(() => api.prepareRelease(org, pid, arg ?? current ?? acceptedVersionId), setRetrying);
        if (arg) setCurrent(arg);
      } else if (step === "approve") await withRetry(() => api.approvePublish(org, arg!, outputDigest!), setRetrying);
      else if (step === "recover") await api.recoverRelease(org, arg!, "checked production by hand from Versions");
      else {
        await deployWithKey(api, org, arg!, outputDigest!, deployKeys.current, setRetrying);
      }
    } finally {
      setBusy(null);
      releases.reload();
      reloadLive();
      onChanged?.();
    }
  });
  return (
    <PublishVersionView
      role={role}
      mount={mount}
      acceptedVersionId={acceptedVersionId}
      justRestored={justRestored}
      releases={releases.data}
      current={current}
      onPublishCurrent={(v) => void action.run("prepare", v)}
      retrying={retrying}
      versionLabel={versionNumber != null ? `Version ${versionNumber}` : versionNumberLabel(versions, acceptedVersionId)}
      publish={{
        releases: releases.data,
        acceptedVersionId: current ?? acceptedVersionId,
        onPrepare: () => void action.run("prepare"),
        onApprove: (r) => void action.run("approve", r.releaseId, r.outputDigest ?? ""),
        onDeploy: (r) => void action.run("deploy", r.releaseId, r.outputDigest ?? ""),
        onRecover: (r) => void action.run("recover", r.releaseId),
        busy,
        error: action.error ?? releases.error,
      }}
    />
  );
}
