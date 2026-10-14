/**
 * Live project state shared by the project tabs: proposals (with details for open ones), tasks
 * (developers only), and the activity log. Polled every few seconds so concurrent agents' task
 * states and integration results appear without a reload.
 */
import { createContext, useContext, useEffect, useId, useState } from "react";
import type { InspectorSection } from "../primitives/InspectorDrawer.js";
import type { CommonForgeApi } from "../api/client.js";
import type { Capture, EventView, MemberView, Project, PromotionView, Proposal, ProposalSummary, ReleaseList, Role, StagingView, TaskSummary } from "../api/types.js";
import { isClosed, isDeveloperRole, isReplaced, latestPerChange, needsDecision } from "../lib/model.js";
import { UploadQueue } from "../lib/uploads.js";

export const POLL_MS = 3000;

export interface LiveState {
  proposals: ProposalSummary[];
  /** full proposals: the latest of each Change (status, badge and lanes need them) */
  details: Record<string, Proposal>;
  /** changeId → its latest proposal id; every other proposal of a Change was replaced */
  latest: Map<string, string>;
  tasks: TaskSummary[];
  events: EventView[];
  /** developers: the project's releases (UX-4 review I-2: the Changes list's Publish/Live facts); undefined for clients or when unreadable */
  releases?: ReleaseList | undefined;
  /** developers: the organization's members, to name the people in Activity and on the storyboard; undefined for clients or when unreadable */
  members?: MemberView[] | undefined;
  /** the project's staging (`enabled: false` without a staging section); undefined when unreadable */
  staging?: StagingView | undefined;
  /** staging-mode projects: what staging sent (the header's 24-hour count and the drawer); undefined otherwise or when unreadable */
  captures?: Capture[] | undefined;
  /**
   * staging-mode projects, owners, developers and clients: the tasks of the Tasks board (owners and
   * developers: every task, as `tasks`; clients: the tasks they created); undefined otherwise or
   * when unreadable (a failed read keeps the previous poll's)
   */
  boardTasks?: TaskSummary[] | undefined;
  /** staging-mode projects, owners, developers and clients: the promotions they can read (newest first); undefined otherwise */
  promotions?: PromotionView[] | undefined;
  /**
   * staging-mode projects, owners and developers: the promotions waiting for a developer
   * (`listPromotions(["pending_approval"])`, Needs you and the decision count); undefined otherwise
   * (a failed read keeps the previous poll's)
   */
  pendingPromotions?: PromotionView[] | undefined;
  at: number;
}

/** Members change rarely: read once per API and organization, not on every poll. */
const membersCache = new WeakMap<CommonForgeApi, Map<string, Promise<MemberView[] | undefined>>>();

function members(api: CommonForgeApi, org: string): Promise<MemberView[] | undefined> {
  let byOrg = membersCache.get(api);
  if (!byOrg) membersCache.set(api, (byOrg = new Map()));
  let hit = byOrg.get(org);
  if (!hit) {
    const cache = byOrg;
    // a failed read is not kept: the next poll tries again (UX-5 review m-4)
    hit = api.listMembers(org).catch(() => {
      cache.delete(org);
      return undefined;
    });
    byOrg.set(org, hit);
  }
  return hit;
}

const PAGE = 500;

interface EventLog {
  events: EventView[];
  next: number;
  inflight: Promise<EventView[]> | null;
}

/** Events are paged oldest-first: keep what was read and only ask for newer pages on each poll. */
const eventLogs = new WeakMap<CommonForgeApi, Map<string, EventLog>>();

/**
 * Single-flight per (api, project, role): a reload that overlaps a poll waits for the same read
 * instead of appending the same page twice; events are also deduplicated by `seq` (review I-2).
 */
export function readEvents(api: CommonForgeApi, org: string, pid: string, role: Role): Promise<EventView[]> {
  let logs = eventLogs.get(api);
  if (!logs) eventLogs.set(api, (logs = new Map()));
  const key = `${org}/${pid}/${role}`;
  let log = logs.get(key);
  if (!log) logs.set(key, (log = { events: [], next: 0, inflight: null }));
  if (log.inflight) return log.inflight;
  const l = log;
  l.inflight = (async () => {
    try {
      for (let i = 0; i < 20; i++) {
        const page = await api.listEvents(org, { projectId: pid, after: l.next, limit: PAGE });
        const last = l.events.length ? l.events[l.events.length - 1]!.seq : 0;
        for (const e of page.events) if (e.seq > last && !l.events.some((x) => x.seq === e.seq)) l.events.push(e);
        l.next = Math.max(l.next, page.next);
        if (page.events.length < PAGE) break;
      }
      return [...l.events];
    } finally {
      l.inflight = null;
    }
  })();
  return l.inflight;
}

/** Closed proposals never change: fetch them once. */
const closedCache = new WeakMap<CommonForgeApi, Map<string, Proposal>>();

/**
 * Whether the project is in staging mode as its policy says (a `staging` and a `release` section),
 * when the caller can read the policy (owners and developers); undefined otherwise (clients and
 * viewers get no policy, so their poll asks `GET …/staging`, which answers `enabled: false`).
 */
export function policyStaging(project: Project | undefined): boolean | undefined {
  if (!project?.policy) return undefined;
  return project.policy.staging !== undefined && project.policy.release !== undefined;
}

export interface LoadLiveOptions {
  /** the project as loaded: a policy without staging skips the staging read */
  project?: Project | undefined;
  /** the previous poll's state: kept for staging and captures when their read fails */
  previous?: LiveState | undefined;
}

export async function loadLive(api: CommonForgeApi, org: string, pid: string, role: Role, opts: LoadLiveOptions = {}): Promise<LiveState> {
  const dev = isDeveloperRole(role);
  const { previous } = opts;
  const policy = policyStaging(opts.project);
  // staging never fails the poll: a read error keeps the previous poll's staging (none on the first
  // poll, so the header stays hidden until a read succeeds); a policy without staging skips the read
  const stagingRead: Promise<StagingView | undefined | "off"> = policy === false ? Promise.resolve("off") : api.getStaging(org, pid).catch(() => undefined);
  // captures alongside the staging read when the project is known to be in staging mode (the policy
  // or the previous poll says so); otherwise only once the staging read says so
  const readCaptures = () => api.listCaptures(org, pid).catch(() => undefined);
  const early = policy !== false && (policy === true || !!previous?.staging?.enabled);
  const earlyCaptures = early ? readCaptures() : null;
  // the Tasks board's reads (staging mode, never viewers): a client's own tasks and the promotions
  // they can read; a failed read keeps the previous poll's
  const boardReads = role !== "viewer";
  const readBoard = (): Promise<[TaskSummary[] | undefined, PromotionView[] | undefined, PromotionView[] | undefined]> =>
    Promise.all([
      dev ? Promise.resolve(undefined) : api.listTasks(org, pid).catch(() => previous?.boardTasks),
      api.listPromotions(org, pid).catch(() => previous?.promotions),
      dev ? api.listPromotions(org, pid, ["pending_approval"]).catch(() => previous?.pendingPromotions) : Promise.resolve(undefined),
    ]);
  const earlyBoard = early && boardReads ? readBoard() : null;
  const [proposals, tasks, events, releases, people, stagingNow] = await Promise.all([
    api.listProposals(org, pid),
    dev ? api.listTasks(org, pid) : Promise.resolve([] as TaskSummary[]),
    readEvents(api, org, pid, role),
    dev ? api.listReleases(org, pid).catch(() => undefined) : Promise.resolve(undefined),
    dev ? members(api, org) : Promise.resolve(undefined),
    stagingRead,
  ]);
  const staging = stagingNow === "off" ? undefined : (stagingNow ?? previous?.staging);
  // captures only for staging-mode projects, with the poll: the header's count needs them on every page
  // (read alongside the proposal details below); a failed read keeps the previous captures
  const capturesRead = staging?.enabled ? (earlyCaptures ?? readCaptures()).then((c) => c ?? previous?.captures) : Promise.resolve(undefined);
  const boardRead: Promise<[TaskSummary[] | undefined, PromotionView[] | undefined, PromotionView[] | undefined]> = staging?.enabled && boardReads ? (earlyBoard ?? readBoard()) : Promise.resolve([undefined, undefined, undefined]);
  // only the latest proposal of each Change is fetched in full (review I-3): older ones were
  // replaced and need no status, badge or decision; closed ones are fetched once
  const latest = latestPerChange(proposals);
  let cache = closedCache.get(api);
  if (!cache) closedCache.set(api, (cache = new Map()));
  const c = cache;
  const wanted = proposals.filter((p) => latest.get(p.changeId) === p.proposalId);
  const full = await Promise.all(
    wanted.map(async (p) => {
      const key = `${role}/${p.proposalId}`;
      const hit = isClosed(p.state) ? c.get(key) : undefined;
      if (hit) return hit;
      const got = await api.getProposal(org, p.proposalId);
      if (isClosed(got.state)) c.set(key, got);
      return got;
    }),
  );
  const details: Record<string, Proposal> = {};
  for (const p of full) details[p.proposalId] = p;
  const captures = await capturesRead;
  const [clientTasks, promotions, pendingPromotions] = await boardRead;
  const boardTasks = staging?.enabled && boardReads ? (dev ? tasks : clientTasks) : undefined;
  return { proposals, details, latest, tasks, events, ...(releases ? { releases } : {}), ...(people ? { members: people } : {}), ...(staging ? { staging } : {}), ...(captures ? { captures } : {}), ...(boardTasks ? { boardTasks } : {}), ...(promotions ? { promotions } : {}), ...(pendingPromotions ? { pendingPromotions } : {}), at: Date.now() };
}

/**
 * A landing (`staging`) or promotion proposal: never decided on its own (the Worker refuses to
 * integrate, approve or accept it); a promotion is decided through the promotion.
 */
export function routedProposal(live: Pick<LiveState, "proposals">, proposalId: string): boolean {
  const kind = live.proposals.find((x) => x.proposalId === proposalId)?.kind;
  return kind === "staging" || kind === "promotion";
}

/**
 * Promotions waiting for this developer's decision: pending, in the developer view (a developer
 * without read on every folder it changes cannot review it), and only when the project's
 * `approvalRoles` (unset: every role) accept an approval from the viewer's role. Another
 * approver's promotion is not counted (it stays reachable from the Tasks board and Changes, where
 * Send back is still offered). Clients and viewers: none.
 */
export function pendingPromotionsFor(live: LiveState | undefined, role: Role, approvalRoles: readonly Role[] | undefined): PromotionView[] {
  if (!live || !isDeveloperRole(role)) return [];
  if (approvalRoles && !approvalRoles.includes(role)) return [];
  return (live.pendingPromotions ?? []).filter((p) => p.state === "pending_approval" && p.requestedBy !== undefined);
}

export function decisionCount(live: LiveState | undefined, role: Role, approvalRoles: readonly Role[] | undefined): number {
  if (!live) return 0;
  const proposals = Object.values(live.details).filter((p) => !routedProposal(live, p.proposalId) && needsDecision(p, role, isReplaced(p, live.latest))).length;
  return proposals + pendingPromotionsFor(live, role, approvalRoles).length;
}

export interface ProjectCtx {
  org: string;
  pid: string;
  role: Role;
  project: Project;
  live: LiveState | undefined;
  reloadLive: () => void;
  /** re-read the project (mounts change after "Add files"); optional so tests may omit it */
  reloadProject?: () => void;
  /**
   * Developers: register technical detail for the inspector drawer under `id` (null removes it).
   * Several components may register at once; the drawer shows them in registration order.
   */
  setInspector?: (id: string, sections: InspectorSection[] | null) => void;
}

export const ProjectContext = createContext<ProjectCtx | null>(null);

export function useProject(): ProjectCtx {
  const v = useContext(ProjectContext);
  if (!v) throw new Error("ProjectContext missing");
  return v;
}

/**
 * Show `sections` in the inspector drawer while the calling component is mounted, alongside any
 * other component's sections (keyed per caller).
 *
 * `key` must change whenever the sections' content changes: they hold React nodes, which cannot
 * be compared, so they are re-read only when `key` changes. Build `key` from every value shown.
 */
export function useInspectorSections(sections: InspectorSection[] | null, key: string): void {
  const set = useContext(ProjectContext)?.setInspector;
  const id = useId();
  useEffect(() => {
    if (!set) return;
    set(id, sections);
    // `sections` is read when `key` changes, by design
  }, [set, id, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!set) return;
    return () => set(id, null);
  }, [set, id]);
}

/** The registry behind `setInspector`: keyed, in registration order. Pure, for tests. */
export function updateRegistry(reg: ReadonlyArray<{ id: string; sections: InspectorSection[] }>, id: string, sections: InspectorSection[] | null): Array<{ id: string; sections: InspectorSection[] }> {
  const i = reg.findIndex((x) => x.id === id);
  if (sections === null) return i < 0 ? [...reg] : reg.filter((x) => x.id !== id);
  if (i < 0) return [...reg, { id, sections }];
  const out = [...reg];
  out[i] = { id, sections };
  return out;
}

export function mountNameOf(project: Project, resourceId: string): string {
  return project.mounts.find((m) => m.resourceId === resourceId)?.mountName ?? resourceId;
}

// ------------------------------------------------------------------------------ uploads

/**
 * The project's upload queue (review 4): owned by the project frame, not the Files tab, so
 * switching tabs inside the project keeps uploads going and the tray shows again on Files.
 */
export const UploadsContext = createContext<UploadQueue | null>(null);

export function useUploads(): UploadQueue {
  const q = useContext(UploadsContext);
  if (!q) throw new Error("UploadsContext missing");
  return q;
}

/**
 * The frame's queue: leaving the project (unmount) or the page (pagehide) cancels what is
 * unfinished and sends no change (a page restored from the back/forward cache reopens it);
 * while anything is unfinished, leaving the page warns.
 */
export function useProjectUploads(api: CommonForgeApi, org: string, pid: string): UploadQueue {
  const [queue] = useState(() => new UploadQueue({ api, org, pid }));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const off = queue.subscribe(() => setBusy(queue.busy));
    const leave = () => queue.cancelAll();
    // back from the back/forward cache: the page lives on, and so may its uploads' changes
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) queue.reopen();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    return () => {
      off();
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
      queue.cancelAll();
    };
  }, [queue]);
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  return queue;
}
