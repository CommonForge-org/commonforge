/**
 * The Tasks board (staging phase 3, spec 2026-10-07 §8 "Web"): staging-mode projects only. Four
 * columns, Working · In staging · Waiting for approval · Live, from the tasks the viewer can list,
 * the staging view's landings and the promotions they can read (`boardCards` in lib/model.ts).
 * Cards carry what can be done now: Open in staging, Promote (with the tasks that go together),
 * Roll back, Withdraw, and for developers Review on a promotion waiting for approval. New task
 * starts a task and hands it to the agent; a Working card shows where its agent is (checked out,
 * when) and opens the same hand-off again (Give to agent). After Promote the board follows the promotion every 3 s
 * until the project poll carries it (`stopFollowing`), backing off when the read keeps failing.
 *
 * Withdraw (Worker `withdrawPromotion`): owners and developers on every promotion before the
 * accept; a client only on the promotions they requested. A client's promotion view does not say
 * who requested it, so the board remembers the promotions requested from it in this browser tab
 * (sessionStorage); a refusal (`not_promotion_requester`) is said in plain words.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CreateTaskInput, EventView, Mount, PromoteResult, PromotionPreview, PromotionView, Role, StagingLanding, StagingView, TaskSummary, TaskView } from "../api/types.js";
import { agentLine, openForAgent } from "../lib/handoff.js";
import { useApp } from "../lib/hooks.js";
import { boardCards, canPromoteLanding, canRollBackLanding, canWithdrawPromotion, droppedRevisions, followedOverlay, isDeveloperRole, relativeTime, stopFollowing, type BoardCard, type BoardColumn } from "../lib/model.js";
import { promotionHref } from "../lib/router.js";
import { Badge, ConfirmSheet, EmptyState, Icon, stateOfTone } from "../primitives/index.js";
import { errorMessage, Link, Loading } from "../ui.js";
import { TaskHandoffLoader, useHandoffContext, type HandoffContext } from "./AgentHandoff.js";
import { TasksIntro } from "./GettingStarted.js";
import { NewTaskSheet } from "./NewTaskSheet.js";
import { POLL_MS, useProject } from "./project-data.js";
import { PromoteSheet } from "./PromoteSheet.js";
import { safeStagingUrl } from "./StagingHeader.js";

export const BOARD_COLUMNS: ReadonlyArray<{ id: BoardColumn; title: string; empty: string }> = [
  { id: "working", title: "Working", empty: "Nothing is being worked on." },
  { id: "staging", title: "In staging", empty: "Nothing on staging yet." },
  { id: "waiting", title: "Waiting for approval", empty: "Nothing is waiting for approval." },
  { id: "live", title: "Live", empty: "Nothing has gone live from here yet." },
];

export interface BoardActions {
  previewPromotion: (taskId: string) => Promise<PromotionPreview>;
  promoteTask: (taskId: string) => Promise<PromoteResult>;
  rollbackTask: (taskId: string) => Promise<unknown>;
  withdrawPromotion: (promotionId: string) => Promise<unknown>;
  createTask: (input: CreateTaskInput) => Promise<TaskView>;
  /** read a task for its hand-off (its request and folders) */
  getTask: (taskId: string) => Promise<TaskView>;
  /** something changed: read the project again */
  changed: () => void;
  /** a promotion was requested: follow it */
  promoted: (r: PromoteResult) => void;
}

const NOOP_ACTIONS: BoardActions = {
  previewPromotion: () => new Promise(() => {}),
  promoteTask: () => new Promise(() => {}),
  rollbackTask: () => Promise.resolve(),
  withdrawPromotion: () => Promise.resolve(),
  createTask: () => new Promise(() => {}),
  getTask: () => new Promise(() => {}),
  changed: () => {},
  promoted: () => {},
};

type SheetKind = "promote" | "rollback" | "withdraw";
/** The open action sheet, kept by the board (a card that moves columns remounts; the sheet stays). */
export interface OpenSheet {
  taskId: string;
  kind: SheetKind;
  /** its request is on its way: a poll that changes the card does not replace it with the notice */
  submitting: boolean;
}

/**
 * May the viewer withdraw this promotion: owners and developers always (before the accept); a
 * client only when they requested it (requested from this board, or `requestedBy` names them).
 */
export function mayWithdraw(promotion: Pick<PromotionView, "promotionId" | "state"> & { requestedBy?: string | undefined }, role: Role, requested: ReadonlySet<string>, userId: string | null): boolean {
  if (!canWithdrawPromotion(promotion)) return false;
  if (isDeveloperRole(role)) return true;
  if (role === "viewer") return false;
  return requested.has(promotion.promotionId) || (!!userId && promotion.requestedBy === userId);
}

interface CardProps {
  card: BoardCard;
  role: Role;
  org: string;
  pid: string;
  stagingUrl: string | null;
  actions: BoardActions;
  now: Date;
  requested: ReadonlySet<string>;
  userId: string | null;
  open: OpenSheet | null;
  setOpen: (s: OpenSheet | null) => void;
  /** open the agent hand-off for this card's task */
  onHandoff: (taskId: string) => void;
}

function TaskCard({ card, role, org, pid, stagingUrl, actions, now, requested, userId, open, setOpen, onHandoff }: CardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dev = isDeveloperRole(role);
  const mayAct = role !== "viewer" && card.own;
  const { landing, promotion, state } = card;
  const canPromote = mayAct && canPromoteLanding(landing, promotion);
  const canRollBack = mayAct && canRollBackLanding(landing, promotion);
  const canWithdraw = mayAct && !!promotion && mayWithdraw(promotion, role, requested, userId);
  const canReview = dev && promotion?.state === "pending_approval";
  // still open for an agent (no landing yet): where the agent is, and the hand-off again
  const agent = !landing && card.task ? agentLine(card.task, now) : null;
  const canHandoff = mayAct && !landing && !!card.task && openForAgent(card.task.state);
  const onStaging = !!landing && (landing.state === "landed" || landing.state === "promoting") && card.place !== "live";
  const idBase = `task-${card.taskId}`;
  const sheet = open?.taskId === card.taskId ? open.kind : null;
  const allowed = sheet === "promote" ? canPromote : sheet === "rollback" ? canRollBack : sheet === "withdraw" ? canWithdraw : true;
  // the poll changed the card under an open sheet (and nothing is on its way): say so, never vanish
  const stale = sheet !== null && !allowed && !open?.submitting && !busy;
  const setSheet = (kind: SheetKind | null) => setOpen(kind ? { taskId: card.taskId, kind, submitting: false } : null);
  const run = (kind: SheetKind, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOpen({ taskId: card.taskId, kind, submitting: true });
    fn().then(
      () => {
        setBusy(false);
        setOpen(null);
        actions.changed();
      },
      (e: unknown) => {
        setBusy(false);
        setError(e);
        setOpen({ taskId: card.taskId, kind, submitting: false });
      },
    );
  };
  const close = () => {
    setSheet(null);
    setError(null);
  };
  return (
    <article className={`task-card task-card-${card.place ?? "off"}`} data-testid="task-card" data-task={card.taskId} data-column={card.place ?? ""} aria-label={card.title}>
      {state.heading ? (
        <div className="task-card-heading" data-testid="task-card-heading">
          <Icon name="alert" size={15} strokeWidth={2} />
          {state.heading}
        </div>
      ) : null}
      <h3 className="task-card-title">{card.title}</h3>
      <div className="task-card-state">
        <Badge state={stateOfTone(state.tone)} pulse={state.tone === "busy"} size="sm">
          {state.line}
        </Badge>
        <span className="muted small">{relativeTime(card.createdAt, now)}</span>
      </div>
      {state.reason ? (
        <p className="task-card-reason small" data-testid="task-card-reason">
          {state.reason}
        </p>
      ) : null}
      {agent ? (
        <p className={`task-card-agent small task-card-agent-${agent.tone}`} data-testid="task-card-agent">
          {agent.text}
        </p>
      ) : null}
      {card.droppedRevisions.map((r) => (
        <p key={r.taskId} className="muted small" data-testid="task-card-dropped">
          '{r.title}' couldn't be added to staging.
        </p>
      ))}
      {stale ? (
        <div className="note small" role="status" data-testid="task-card-changed">
          <span>This task changed while you were deciding ({state.line.replace(/…$/, "")}), so nothing was sent.</span>{" "}
          <button type="button" className="btn btn-quiet btn-small" onClick={close}>
            Close
          </button>
        </div>
      ) : null}
      {sheet === null && (onStaging || canPromote || canRollBack || canWithdraw || canReview || canHandoff) ? (
        <div className="task-card-actions">
          {canHandoff ? (
            <button type="button" className="btn btn-outline btn-small" onClick={() => onHandoff(card.taskId)} data-testid="task-card-handoff">
              Give to agent
            </button>
          ) : null}
          {canReview && promotion ? (
            <Link href={promotionHref(org, pid, promotion.promotionId)} className="btn btn-outline btn-small">
              Review
            </Link>
          ) : null}
          {canPromote ? (
            <button type="button" id={`${idBase}-promote`} className="btn btn-outline btn-small" onClick={() => setSheet("promote")}>
              Promote
            </button>
          ) : null}
          {onStaging && stagingUrl ? (
            <a className="btn btn-quiet btn-small" href={stagingUrl} target="_blank" rel="noopener noreferrer">
              Open in staging
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
          {canWithdraw ? (
            <button type="button" id={`${idBase}-withdraw`} className="btn btn-quiet btn-small" onClick={() => setSheet("withdraw")}>
              Withdraw
            </button>
          ) : null}
          {canRollBack ? (
            <button type="button" id={`${idBase}-rollback`} className="btn btn-quiet btn-small" onClick={() => setSheet("rollback")}>
              Roll back
            </button>
          ) : null}
        </div>
      ) : null}
      {sheet === "promote" && !stale ? (
        <PromoteSheet
          title={card.title}
          developer={dev}
          loadPreview={() => actions.previewPromotion(card.taskId)}
          onPromote={async () => {
            setOpen({ taskId: card.taskId, kind: "promote", submitting: true });
            try {
              const r = await actions.promoteTask(card.taskId);
              actions.promoted(r);
            } catch (e) {
              setOpen({ taskId: card.taskId, kind: "promote", submitting: false });
              throw e;
            }
          }}
          onDone={() => {
            setSheet(null);
            actions.changed();
          }}
          onCancel={close}
          returnFocusId={`${idBase}-promote`}
        />
      ) : null}
      {sheet === "rollback" && !stale ? (
        <ConfirmSheet
          title={`Roll back '${card.title}'?`}
          does="Staging is rebuilt without this task's changes."
          doesNot="Production is not affected. The task's work is kept in its history."
          confirmLabel="Roll back"
          busyLabel="Rolling back…"
          busy={busy}
          tone="blocked"
          onConfirm={() => run("rollback", () => actions.rollbackTask(card.taskId))}
          onCancel={close}
          returnFocusId={`${idBase}-rollback`}
        >
          {error ? (
            <p className="note note-bad small" role="alert">
              {errorMessage(error, dev)}
            </p>
          ) : null}
        </ConfirmSheet>
      ) : null}
      {sheet === "withdraw" && promotion && !stale ? (
        <ConfirmSheet
          title="Withdraw this production update?"
          does="The update stops and its tasks stay on staging. You can promote them again later."
          doesNot="Production is not changed."
          confirmLabel="Withdraw"
          busyLabel="Withdrawing…"
          busy={busy}
          onConfirm={() => run("withdraw", () => actions.withdrawPromotion(promotion.promotionId))}
          onCancel={close}
          returnFocusId={`${idBase}-withdraw`}
        >
          {error ? (
            <p className="note note-bad small" role="alert">
              {errorMessage(error, dev)}
            </p>
          ) : null}
        </ConfirmSheet>
      ) : null}
    </article>
  );
}

export interface TasksBoardViewProps {
  cards: BoardCard[];
  role: Role;
  org: string;
  pid: string;
  /** the staging site (already checked to be http/https), or null */
  stagingUrl: string | null;
  /** the folders for New task (their `canStartTask`) */
  mounts: readonly Mount[];
  actions?: BoardActions;
  /** server rendering and tests: the New task sheet starts open */
  newTaskOpen?: boolean;
  /** under the heading: which client path this is, and why staging waits (GettingStarted.tsx) */
  intro?: ReactNode;
  /** the promotions requested from this board (a client may withdraw only those) */
  requested?: ReadonlySet<string>;
  /** the viewer's user id (a developer's view names who requested a promotion) */
  userId?: string | null;
  /** tests: an action sheet starts open */
  initialSheet?: OpenSheet | null;
  now?: Date;
  /** who is looking, for the hand-off's commands (default: this role, no origin or email) */
  handoff?: HandoffContext;
  /** tests: the hand-off of this task starts open */
  handoffOpen?: string | null;
}

const NONE: ReadonlySet<string> = new Set();

export function TasksBoardView({ cards, role, org, pid, stagingUrl, mounts, actions = NOOP_ACTIONS, newTaskOpen = false, intro, requested = NONE, userId = null, initialSheet = null, now = new Date(), handoff = { role, staging: true, apiUrl: "", email: null }, handoffOpen = null }: TasksBoardViewProps) {
  const [creating, setCreating] = useState(newTaskOpen);
  const [open, setOpen] = useState<OpenSheet | null>(initialSheet);
  const [handingOff, setHandingOff] = useState<string | null>(handoffOpen);
  const canCreate = role !== "viewer";
  const rolledBack = cards.filter((c) => c.place === "rolled_back");
  return (
    <div className="tasks-board" data-testid="tasks-board">
      <div className="section-head tasks-board-head">
        <h2>Tasks</h2>
        {canCreate && !creating && !handingOff ? (
          <button type="button" id="cf-new-task" className="btn btn-primary btn-small" onClick={() => setCreating(true)} data-testid="new-task-open">
            <Icon name="plus" size={15} />
            New task
          </button>
        ) : null}
      </div>
      {intro}
      {canCreate && creating ? (
        <NewTaskSheet
          mounts={mounts}
          developer={isDeveloperRole(role)}
          onCreate={actions.createTask}
          onCreated={() => actions.changed()}
          onClose={() => setCreating(false)}
          handoff={handoff}
        />
      ) : null}
      {handingOff && !creating ? <TaskHandoffLoader key={handingOff} taskId={handingOff} ctx={handoff} load={actions.getTask} onDone={() => setHandingOff(null)} /> : null}
      <div className="board">
        {BOARD_COLUMNS.map((col) => {
          const inCol = cards.filter((c) => c.place === col.id);
          return (
            <section key={col.id} className={`board-col board-col-${col.id}`} aria-labelledby={`board-col-${col.id}`} data-testid={`board-col-${col.id}`}>
              <h3 className="board-col-title" id={`board-col-${col.id}`}>
                {col.title} <span className="board-col-count">{inCol.length}</span>
              </h3>
              {inCol.length === 0 ? <p className="board-col-empty muted small">{col.empty}</p> : inCol.map((c) => <TaskCard key={c.taskId} card={c} role={role} org={org} pid={pid} stagingUrl={stagingUrl} actions={actions} now={now} requested={requested} userId={userId} open={open} setOpen={setOpen} onHandoff={(id) => {
                      setCreating(false);
                      setHandingOff(id);
                    }} />)}
            </section>
          );
        })}
      </div>
      {rolledBack.length ? (
        <details className="board-rolled-back" data-testid="board-rolled-back">
          <summary>Rolled back · {rolledBack.length}</summary>
          <ul>
            {rolledBack.map((c) => (
              <li key={c.taskId}>
                {c.title} <span className="muted small">· {relativeTime(c.createdAt, now)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The landings with a followed promotion folded in: right after Promote the staging view may not
 * name the new promotion yet, so its landings take it until the next poll does.
 */
export function withFollowed(landings: readonly StagingLanding[], followed: PromotionView | null): StagingLanding[] {
  if (!followed) return [...landings];
  const ids = new Set(followed.landings.map((l) => l.landingId));
  return landings.map((l) => (ids.has(l.landingId) && (!l.promotion || l.promotion.promotionId === followed.promotionId) ? { ...l, promotion: { promotionId: followed.promotionId, state: followed.state } } : l));
}

/** The board's cards from the project poll (and a followed promotion, newer than the poll). */
export function boardFromLive(staging: StagingView | undefined, tasks: readonly TaskSummary[] | undefined, promotions: readonly PromotionView[] | undefined, role: Role, followed: PromotionView | null = null, events: readonly EventView[] = []): BoardCard[] {
  if (!staging?.enabled) return [];
  const own = isDeveloperRole(role) ? ("all" as const) : new Set((role === "viewer" ? [] : (tasks ?? [])).map((t) => t.taskId));
  const views = [...(promotions ?? []).filter((p) => p.promotionId !== followed?.promotionId), ...(followed ? [followed] : [])];
  return boardCards(role === "viewer" ? [] : (tasks ?? []), withFollowed(staging.landings, followed), views, own, droppedRevisions(events));
}

/** Consecutive failed reads of a followed promotion before the board stops following it (the project poll still runs). */
export const FOLLOW_MAX_ERRORS = 6;
/** The wait before the next read of a followed promotion: 3 s, doubled per failed read in a row, at most 24 s. */
export function followDelay(errors: number): number {
  return POLL_MS * 2 ** Math.min(errors, 3);
}

const REQUESTED_KEY = (org: string) => `cf-requested-promotions:${org}`;

function readRequested(org: string): Set<string> {
  try {
    const raw = globalThis.sessionStorage?.getItem(REQUESTED_KEY(org));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function writeRequested(org: string, ids: ReadonlySet<string>): void {
  try {
    globalThis.sessionStorage?.setItem(REQUESTED_KEY(org), JSON.stringify([...ids].slice(-100)));
  } catch {
    // private windows, blocked storage: the set lives as long as the page
  }
}

export function TasksBoardScreen() {
  const { api, me } = useApp();
  const { org, pid, role, project, live, reloadLive } = useProject();
  // the promotion requested from this board, followed every 3 s until the project poll carries it
  const [followId, setFollowId] = useState<string | null>(null);
  const [followed, setFollowed] = useState<PromotionView | null>(null);
  const [stoppedAt, setStoppedAt] = useState<number | null>(null);
  const [requested, setRequested] = useState<Set<string>>(() => readRequested(org));
  const reload = useRef(reloadLive);
  reload.current = reloadLive;
  const stop = useCallback(() => {
    setFollowId(null);
    setStoppedAt(Date.now());
    reload.current();
  }, []);
  useEffect(() => {
    if (!followId) return;
    let alive = true;
    let errors = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      api.getPromotion(org, followId).then(
        (p) => {
          if (!alive) return;
          errors = 0;
          setFollowed(p);
          timer = setTimeout(tick, followDelay(0));
        },
        () => {
          if (!alive) return;
          // the project poll still runs; read again later, and give up after a few failures in a row
          errors++;
          if (errors >= FOLLOW_MAX_ERRORS) stop();
          else timer = setTimeout(tick, followDelay(errors));
        },
      );
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, org, followId, stop]);
  const polled = followed ? live?.promotions?.find((p) => p.promotionId === followed.promotionId) : undefined;
  // stop once it settled, the project poll caught up, or it waits on something slow
  useEffect(() => {
    if (followId && followed?.promotionId === followId && stopFollowing(followed, polled)) stop();
  }, [followId, followed, polled, stop]);
  const followedNow = followedOverlay(followed, { following: !!followId, polled: !!polled, pollAt: live?.at ?? 0, stoppedAt });
  // the polled row won: drop the copy
  useEffect(() => {
    if (followed && !followId && !followedNow) setFollowed(null);
  }, [followed, followId, followedNow]);
  const cards = useMemo(() => boardFromLive(live?.staging, live?.boardTasks, live?.promotions, role, followedNow, live?.events), [live, role, followedNow]);
  const handoff = useHandoffContext(role, true);
  const getTask = useCallback((taskId: string) => api.getTask(taskId), [api]);
  if (!live) return <Loading what="Loading tasks" />;
  if (!live.staging?.enabled) return <EmptyState title="This project has no staging." icon="changes" />;
  const actions: BoardActions = {
    previewPromotion: (taskId) => api.previewPromotion(taskId),
    promoteTask: (taskId) => api.promoteTask(taskId),
    rollbackTask: (taskId) => api.rollbackTask(taskId),
    withdrawPromotion: (promotionId) => api.withdrawPromotion(org, promotionId),
    createTask: (input) => api.createTask(org, pid, input),
    getTask,
    changed: reloadLive,
    promoted: (r) => {
      setFollowed(null);
      setStoppedAt(null);
      setFollowId(r.promotionId);
      setRequested((prev) => {
        const next = new Set(prev).add(r.promotionId);
        writeRequested(org, next);
        return next;
      });
    },
  };
  const intro = <TasksIntro staging={live.staging} empty={cards.length === 0} role={role} org={org} pid={pid} />;
  return <TasksBoardView cards={cards} role={role} org={org} pid={pid} stagingUrl={live.staging.state === "active" ? safeStagingUrl(live.staging.url) : null} mounts={project.mounts} actions={actions} intro={intro} requested={requested} userId={me?.user.userId ?? null} handoff={handoff} />;
}
