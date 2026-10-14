/**
 * Your account (`/account`): the sessions you are signed in with, and a way to end them. A browser,
 * a cforge login, and a cforge login an agent made with a hand-off prompt's one-time code (that code
 * sat in the agent's chat, so its session lasts a week). Worker `GET /api/auth/sessions` and
 * `POST /api/auth/sessions/revoke`; the tokens themselves are never shown or sent back.
 * Also how to connect an AI app (Claude Desktop, Claude Code, Codex) through the cforge MCP server,
 * with a one-time sign-in code for it.
 */
import { useState } from "react";
import type { SessionView } from "../api/types.js";
import { claudeCodeSetup, codexConfig, DESKTOP_EXTENSION_URL, signInMessage } from "../lib/agentapps.js";
import { CLI_PUBLISHED } from "../lib/handoff.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import { formatTime } from "../lib/model.js";
import { ErrorNote, errorMessage, Loading } from "../ui.js";
import { appOrigin, Cmd } from "./AgentHandoff.js";

export const SESSION_LABEL: Record<SessionView["client"], string> = {
  web: "Browser",
  cli: "cforge (command line)",
  handoff: "An agent or AI app, signed in with a one-time code",
  unknown: "Signed in before this list existed",
};

type CodeState = { kind: "idle" } | { kind: "busy" } | { kind: "ready"; message: string } | { kind: "failed"; message: string };

/** The one-time sign-in code for an AI app, made on the click (never on page load). */
function SignInCode({ apiUrl, cliCode }: { apiUrl: string; cliCode: () => Promise<{ code: string }> }) {
  const [state, setState] = useState<CodeState>({ kind: "idle" });
  const make = () => {
    setState({ kind: "busy" });
    cliCode().then(
      (r) => {
        const message = signInMessage(apiUrl, r.code);
        setState(message ? { kind: "ready", message } : { kind: "failed", message: "The server sent an unexpected code." });
      },
      (e: unknown) => setState({ kind: "failed", message: errorMessage(e) }),
    );
  };
  return (
    <div className="agent-app-signin">
      {state.kind === "ready" ? (
        <>
          <Cmd text={state.message} label="sign-in message" testId="agent-app-signin" />
          <p className="muted small">Paste this into your AI app. The code works once, within 15 minutes; the app stays signed in for a week, and you can end that below.</p>
        </>
      ) : (
        <button type="button" className="btn btn-outline btn-small" onClick={make} disabled={state.kind === "busy"} data-testid="agent-app-code">
          {state.kind === "busy" ? "Making a code…" : "Get a sign-in code"}
        </button>
      )}
      {state.kind === "failed" ? <p className="note small">{state.message}</p> : null}
    </div>
  );
}

/** Connect an AI app: install the CommonForge tools, then sign them in with a code. */
export function AgentApps({ apiUrl, cliCode }: { apiUrl: string; cliCode?: () => Promise<{ code: string }> }) {
  return (
    <section aria-label="Use CommonForge from your AI app" className="account-agent-apps" data-testid="agent-apps">
      <h2>Use CommonForge from your AI app</h2>
      <p className="muted small">Ask for changes, check on tasks and, in an app that can edit files, do a task and hand it in, all from the chat. Your app can do only what you can do here.</p>
      <ol className="agent-app-steps">
        <li>
          <strong>Add the CommonForge tools</strong> to your app:
          <dl className="agent-app-list">
            <dt>Claude Desktop</dt>
            <dd>
              <a href={DESKTOP_EXTENSION_URL} data-testid="agent-app-desktop">Download the CommonForge extension</a>, open the file, and click Install.
            </dd>
            <dt>Claude Code</dt>
            <dd>
              <Cmd text={claudeCodeSetup()} label="Claude Code setup" testId="agent-app-claude-code" />
            </dd>
            <dt>Codex</dt>
            <dd>
              Add to <code className="mono">~/.codex/config.toml</code>, then restart Codex:
              <Cmd text={codexConfig()} label="Codex setup" testId="agent-app-codex" multiline />
            </dd>
          </dl>
          {CLI_PUBLISHED ? null : <p className="muted small">Claude Code and Codex need cforge installed (Give to agent on a task shows how); the Claude Desktop extension brings its own.</p>}
        </li>
        <li>
          <strong>Sign the app in.</strong> {cliCode ? <SignInCode apiUrl={apiUrl} cliCode={cliCode} /> : null}
        </li>
      </ol>
    </section>
  );
}

export function AccountView({ email, sessions, busy, error, now = new Date(), onEnd, onEndOthers, apiUrl = "", cliCode }: { email: string; sessions: SessionView[]; busy: boolean; error: unknown; now?: Date; onEnd: (sessionId: string) => void; onEndOthers: () => void; apiUrl?: string; cliCode?: () => Promise<{ code: string }> }) {
  const others = sessions.filter((x) => !x.current);
  return (
    <div className="page account">
      <h1 className="page-title">Your account</h1>
      <p className="muted">Signed in as {email}.</p>
      <AgentApps apiUrl={apiUrl} {...(cliCode ? { cliCode } : {})} />
      <section aria-label="Sessions" className="account-sessions">
        <h2>Where you are signed in</h2>
        <p className="muted small">An agent you gave a task to with Copy prompt, and an AI app you signed in above, act as you. End their sessions here once you are done, or if you pasted a code somewhere by mistake.</p>
        <ul className="session-list">
          {sessions.map((x) => (
            <li key={x.sessionId} className="session-row" data-testid="session-row" data-client={x.client}>
              <div>
                <strong>{SESSION_LABEL[x.client]}</strong>
                {x.current ? <span className="role-chip">This browser</span> : null}
                <div className="small muted">
                  Signed in {formatTime(x.createdAt, now)}; ends {formatTime(x.expiresAt, now)}
                </div>
              </div>
              {x.current ? null : (
                <button type="button" className="btn btn-quiet btn-small" disabled={busy} aria-label={`Sign out ${SESSION_LABEL[x.client]}, signed in ${formatTime(x.createdAt, now)}`} onClick={() => onEnd(x.sessionId)}>
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
        {others.length ? (
          <button type="button" className="btn btn-outline btn-small" disabled={busy} onClick={onEndOthers} data-testid="sessions-end-others">
            Sign out everywhere else ({others.length})
          </button>
        ) : (
          <p className="muted small">You are signed in only here.</p>
        )}
      </section>
      <ErrorNote error={error} />
    </div>
  );
}

export function Account() {
  const { api, me } = useApp();
  const load = useLoad(() => api.listSessions(), "account/sessions");
  const act = useAction(async (fn: () => Promise<unknown>) => {
    await fn();
    load.reload();
  });
  if (load.error) return <ErrorNote error={load.error} onRetry={load.reload} />;
  if (!load.data) return <Loading what="Loading your sessions" />;
  return (
    <AccountView
      email={me?.user.email ?? ""}
      sessions={load.data}
      busy={act.busy}
      error={act.error}
      onEnd={(sessionId) => void act.run(() => api.revokeSessions({ sessionId }))}
      onEndOthers={() => void act.run(() => api.revokeSessions({ others: true }))}
      apiUrl={appOrigin()}
      cliCode={() => api.cliCode()}
    />
  );
}
