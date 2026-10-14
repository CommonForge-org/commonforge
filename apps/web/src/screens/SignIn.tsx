/** Sign-in by magic link, and the `/auth/verify` page that consumes the link only on a click. */
import { useState, type FormEvent } from "react";
import { useAction, useApp } from "../lib/hooks.js";
import { navigate } from "../lib/router.js";
import { BRAND } from "../primitives/index.js";
import { ErrorNote } from "../ui.js";

export function SignInView({ sent, email, busy, error, onEmail, onSubmit }: { sent: boolean; email: string; busy: boolean; error: unknown; onEmail: (v: string) => void; onSubmit: (e: FormEvent) => void }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <img className="auth-mark" src={BRAND.icon} alt="" width={40} height={40} />
        <h1>Sign in to CommonForge</h1>
        {sent ? (
          <div className="note note-good" role="status">
            <strong>Check your email.</strong> We sent a sign-in link to {email}. It works once, for 15 minutes.
          </div>
        ) : (
          <form onSubmit={onSubmit}>
            <label htmlFor="email">Work email</label>
            <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => onEmail(e.target.value)} placeholder="you@company.com" />
            <button type="submit" className="btn btn-primary" disabled={busy || !email}>
              {busy ? "Sending…" : "Email me a sign-in link"}
            </button>
            <ErrorNote error={error} />
          </form>
        )}
        <p className="muted small">No password. The link signs you in on this browser; the session stays in a secure cookie.</p>
      </div>
    </div>
  );
}

export function SignIn() {
  const { api } = useApp();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const send = useAction(async () => {
    await api.requestMagicLink(email.trim());
    setSent(true);
  });
  return (
    <SignInView
      sent={sent}
      email={email}
      busy={send.busy}
      error={send.error}
      onEmail={setEmail}
      onSubmit={(e) => {
        e.preventDefault();
        void send.run();
      }}
    />
  );
}

/**
 * `/auth/cli?code=` (API.md): the emailed CLI sign-in code. This page never POSTs anything; it
 * shows the command to paste into the terminal, where `cforge login --code` exchanges it.
 */
export function CliCodeView({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="auth">
      <div className="auth-card">
        <img className="auth-mark" src={BRAND.icon} alt="" width={40} height={40} />
        <h1>Finish signing in to the CLI</h1>
        {code ? (
          <>
            <p>Paste this code at the <code>cforge login</code> prompt in your terminal:</p>
            <pre className="cli-command">{code}</pre>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                void navigator.clipboard?.writeText(code).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? "Copied" : "Copy code"}
            </button>
            <p className="muted small">The code works once, for 15 minutes. Nothing is signed in on this browser. If the prompt has closed, run <code>cforge login --code &lt;code&gt;</code>.</p>
          </>
        ) : (
          <p>This link has no sign-in code.</p>
        )}
      </div>
    </div>
  );
}

/** Never consumes the token on page load: mail scanners would burn it (API.md, I-5). */
export function VerifyView({ token, busy, error, onConfirm }: { token: string; busy: boolean; error: unknown; onConfirm: () => void }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <img className="auth-mark" src={BRAND.icon} alt="" width={40} height={40} />
        <h1>Finish signing in</h1>
        {token ? (
          <>
            <p>One more click to finish signing in on this browser. This step keeps email scanners, which open links automatically, from using up your one-time link.</p>
            <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </>
        ) : (
          <p>This link has no sign-in token.</p>
        )}
        <ErrorNote error={error} />
        <p className="small">
          <a href="/signin">Request a new link</a>
        </p>
      </div>
    </div>
  );
}

export function Verify({ token }: { token: string }) {
  const { api, refreshMe } = useApp();
  const confirm = useAction(async () => {
    await api.verify(token);
    await refreshMe();
    navigate("/", { replace: true });
  });
  return <VerifyView token={token} busy={confirm.busy} error={confirm.error} onConfirm={() => void confirm.run()} />;
}
