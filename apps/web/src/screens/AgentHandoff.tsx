/**
 * The agent hand-off panel: one button copies a self-contained prompt for a coding agent that can
 * run commands (Claude Desktop's Code tab, Codex, Claude Code, Cursor, …). The agent installs
 * cforge if it is missing, signs in with a one-time code made on the click (Worker `POST
 * /api/auth/cli/code`; never shown on the page), checks the task out, does it and submits. The
 * same steps to run by hand stay under "Run the steps yourself". Shown after New task, and from a
 * task card or row while the task is still open for an agent. The commands and texts come from
 * lib/handoff.ts (verified against apps/cli); the install route lives there in one place.
 *
 * A client may run a task they created in a staging-mode project themselves (Worker: lease and
 * freeze as the creator); one without a coding agent copies a message for their developer.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import type { Role, TaskView } from "../api/types.js";
import { useApp } from "../lib/hooks.js";
import {
  afterSubmitText,
  agentPrompt,
  checkoutCommand,
  checkoutDir,
  CLI_NPM_INSTALL,
  CODE_PLACEHOLDER,
  CLI_PUBLISHED,
  CLI_REQUIREMENTS,
  CLI_SOURCE_INSTALL,
  developerMessage,
  leaseHeldNote,
  loginCommand,
  mayRunAgent,
  submitCommand,
  taskFolders,
  type HandoffTask,
} from "../lib/handoff.js";
import { isDeveloperRole } from "../lib/model.js";
import { CopyButton } from "../primitives/index.js";
import { errorMessage, Loading } from "../ui.js";

/** Who is looking and where: the facts the commands are filled in from. */
export interface HandoffContext {
  role: Role;
  /** a staging-mode project: submitted work goes to staging by itself */
  staging: boolean;
  /** this app's origin: the Worker serves the app and `/api` from it */
  apiUrl: string;
  /** the signed-in person's email, for `cforge login` */
  email: string | null;
  /** the signed-in person's user id: is a live lease theirs? */
  userId?: string | null;
  /** a one-time `cforge login` code for the prompt (Worker `POST /api/auth/cli/code`); absent: the agent asks for the emailed code */
  cliCode?: () => Promise<{ code: string }>;
}

/** The origin `cforge login --api-url` takes: this page's (empty during server rendering). */
export function appOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/** The hand-off context from the app (signed-in user) and the project's mode. */
export function useHandoffContext(role: Role, staging: boolean): HandoffContext {
  const { me, api } = useApp();
  return { role, staging, apiUrl: appOrigin(), email: me?.user.email ?? null, userId: me?.user.userId ?? null, cliCode: () => api.cliCode() };
}

export function handoffTask(task: Pick<TaskView, "taskId" | "title" | "request" | "workspaces" | "snapshot"> & Partial<Pick<TaskView, "lease">>): HandoffTask {
  return { taskId: task.taskId, title: task.title, request: task.request ?? "", ...taskFolders(task), ...(task.lease ? { lease: task.lease } : {}) };
}

/** A command (or several lines) with its copy button. */
export function Cmd({ text, label, testId, multiline = false }: { text: string; label: string; testId?: string; multiline?: boolean }) {
  return (
    <div className={`handoff-cmd${multiline ? " handoff-cmd-block" : ""}`}>
      {multiline ? (
        <pre className="mono" data-testid={testId}>
          {text}
        </pre>
      ) : (
        <code className="mono" data-testid={testId}>
          {text}
        </code>
      )}
      <CopyButton text={text} label={label} />
    </div>
  );
}

/**
 * Copy text made on the click (the prompt with a fresh one-time code). With `ClipboardItem` the
 * clipboard write starts inside the click, as Safari requires, and resolves once the text is made;
 * otherwise the text is written when it is ready.
 */
export async function copyLater(text: Promise<string>): Promise<void> {
  const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clip) throw new Error("no clipboard");
  if (typeof ClipboardItem !== "undefined" && typeof clip.write === "function") {
    try {
      await clip.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      return;
    } catch {
      // a browser that refuses a promised item: the plain write below
    }
  }
  await clip.writeText(await text);
}

type CopyState = { kind: "idle" } | { kind: "busy" } | { kind: "copied"; withCode: boolean; limited: boolean } | { kind: "failed" };

/** The main action: copy the prompt, with a one-time code put in on the click. */
function CopyPrompt({ task, ctx }: { task: HandoffTask; ctx: HandoffContext }) {
  const [state, setState] = useState<CopyState>({ kind: "idle" });
  const withCode = useRef(false);
  const limited = useRef(false);
  const copy = () => {
    if (state.kind === "busy") return;
    setState({ kind: "busy" });
    withCode.current = false;
    limited.current = false;
    const base = { staging: ctx.staging, apiUrl: ctx.apiUrl, email: ctx.email };
    const text = (ctx.cliCode ? ctx.cliCode() : Promise.reject(new Error("no code")))
      .then((r) => {
        withCode.current = true;
        return agentPrompt(task, { ...base, code: r.code });
      })
      // no code (an older server, the limit): the agent asks for the emailed one instead
      .catch((e: unknown) => {
        limited.current = e instanceof ApiError && e.code === "rate_limited";
        return agentPrompt(task, { ...base, code: null });
      });
    copyLater(text).then(
      () => setState({ kind: "copied", withCode: withCode.current, limited: limited.current }),
      () => setState({ kind: "failed" }),
    );
  };
  return (
    <div className="handoff-copy">
      <button type="button" className="btn btn-primary" onClick={copy} disabled={state.kind === "busy"} data-testid="handoff-copy-prompt">
        {state.kind === "busy" ? "Copying…" : state.kind === "copied" ? "Copied" : "Copy prompt for your agent"}
      </button>
      <p className="muted small" role="status" data-testid="handoff-copy-status">
        {state.kind === "copied"
          ? state.withCode
            ? "Copied. Paste it into your agent now: its sign-in code works once, within 15 minutes. The agent's sign-in lasts a week; end it sooner under Your account (your avatar)."
            : state.limited
              ? "Copied, without a sign-in code: too many were made in the last few minutes. Your agent will ask you for the code cforge emails you."
              : "Copied. Your agent will ask you for the sign-in code cforge emails you."
          : state.kind === "failed"
            ? "Couldn't copy. Use the prompt under “Run the steps yourself” below."
            : "The prompt includes a one-time sign-in code, so your agent can sign in by itself."}
      </p>
    </div>
  );
}

export function AgentHandoff({ task, ctx, ownTask = true, onDone, intro }: { task: HandoffTask; ctx: HandoffContext; ownTask?: boolean; onDone: () => void; intro?: string }) {
  const dir = checkoutDir(task.title);
  const canRun = mayRunAgent(ctx.role, { staging: ctx.staging, ownTask });
  const client = !isDeveloperRole(ctx.role);
  const base = { staging: ctx.staging, apiUrl: ctx.apiUrl, email: ctx.email };
  // shown on the page: the code is never displayed, only put in on Copy
  const preview = agentPrompt(task, { ...base, code: ctx.cliCode ? CODE_PLACEHOLDER : null });
  const handPrompt = agentPrompt(task, { ...base, code: null });
  const held = leaseHeldNote(task.lease, { userId: ctx.userId, role: ctx.role });
  return (
    <section className="handoff" data-testid="task-handoff" aria-label="Give this task to your agent">
      <h3 className="handoff-title">Give this task to your agent</h3>
      <p className="small">
        {intro ?? (
          <>
            <strong>{task.title}</strong> is ready for an agent.
          </>
        )}{" "}
        {canRun ? "Copy the prompt and paste it into a coding agent that can run commands: the Code tab in Claude Desktop, Codex, Claude Code or Cursor. It sets everything up, does the task and hands it in." : null}
      </p>
      {!canRun ? (
        <p className="note small" data-testid="handoff-who">
          Only a developer can check this task out. Send them the message below.
        </p>
      ) : null}
      {held ? (
        <p className="note small" data-testid="handoff-lease-held">
          {held}
        </p>
      ) : null}
      {canRun ? (
        <>
          <CopyPrompt task={task} ctx={ctx} />
          <p className="muted small">
            Needs {CLI_REQUIREMENTS} The agent checks and tells you if something is missing. {afterSubmitText(ctx.staging)}
          </p>
          <details className="handoff-preview" data-testid="handoff-prompt">
            <summary>See the prompt</summary>
            <pre className="mono handoff-prompt-preview" data-testid="handoff-prompt-text">
              {preview}
            </pre>
          </details>
          <details className="handoff-manual" data-testid="handoff-manual">
            <summary>Run the steps yourself</summary>
            <ol className="handoff-steps">
              <li data-testid="handoff-install">
                <strong>Install cforge</strong> <span className="muted small">(once)</span>
                {CLI_PUBLISHED ? (
                  <Cmd text={CLI_NPM_INSTALL} label="the install command" testId="handoff-install-command" />
                ) : (
                  <>
                    <p className="small">cforge isn't on npm yet. Until it is, build it from the CommonForge source:</p>
                    <Cmd text={CLI_SOURCE_INSTALL} label="the build-from-source commands" testId="handoff-install-command" multiline />
                    <p className="muted small">
                      Once it's published, this will be <code className="mono">{CLI_NPM_INSTALL}</code>.
                    </p>
                  </>
                )}
              </li>
              <li data-testid="handoff-login">
                <strong>Sign in</strong> <span className="muted small">(once per computer)</span>
                <Cmd text={loginCommand(ctx.apiUrl, ctx.email)} label="the sign-in command" testId="handoff-login-command" />
                <p className="muted small">cforge emails you a code. Paste it (or the link) when cforge asks for it.</p>
              </li>
              <li data-testid="handoff-checkout">
                <strong>Get the task</strong>
                <Cmd text={checkoutCommand(task)} label="the checkout command" testId="task-handoff-command" />
                <p className="muted small">
                  This makes the folder <code className="mono">{dir}</code> with a copy of the task's folders.
                </p>
                {ctx.role === "developer" ? (
                  <p className="muted small" data-testid="handoff-write-access">
                    Checking out needs write access to the task's folders. If cforge says no_write_grant, ask an owner for access.
                  </p>
                ) : null}
              </li>
              <li>
                <strong>Give it to your agent</strong>
                <p className="small">Start your coding agent in the folder where you ran the checkout, and paste this:</p>
                <Cmd text={handPrompt} label="the prompt for your agent" multiline />
                <p className="muted small">
                  The agent finishes with <code className="mono">{submitCommand(task.taskId)}</code>.
                </p>
              </li>
            </ol>
          </details>
        </>
      ) : null}
      {client ? (
        <details className="handoff-send" data-testid="handoff-developer" {...(canRun ? {} : { open: true })}>
          <summary>Send this to your developer</summary>
          <Cmd text={developerMessage(task, { apiUrl: ctx.apiUrl, staging: ctx.staging })} label="the message for your developer" testId="handoff-developer-message" multiline />
        </details>
      ) : null}
      <div className="confirm-actions">
        <button type="button" className="btn btn-outline btn-small" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}

/** The hand-off for an existing task: reads it (`GET /tasks/:id`) for its request and folders. */
export function TaskHandoffLoader({ taskId, ctx, load, ownTask = true, onDone }: { taskId: string; ctx: HandoffContext; load: (taskId: string) => Promise<TaskView>; ownTask?: boolean; onDone: () => void }) {
  const [task, setTask] = useState<TaskView | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    load(taskId).then(
      (t) => alive && setTask(t),
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [taskId, load]);
  if (error)
    return (
      <section className="handoff" data-testid="task-handoff">
        <p className="note note-bad small" role="alert">
          {errorMessage(error, isDeveloperRole(ctx.role))}
        </p>
        <button type="button" className="btn btn-outline btn-small" onClick={onDone}>
          Close
        </button>
      </section>
    );
  if (!task) return <Loading what="Loading the task" />;
  return <AgentHandoff task={handoffTask(task)} ctx={ctx} ownTask={ownTask} onDone={onDone} />;
}
