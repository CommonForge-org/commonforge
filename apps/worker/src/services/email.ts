/**
 * Magic-link delivery. Production: Cloudflare Email Service through the `send_email` binding
 * (`EMAIL`), sending from the address onboarded for Email Sending (`COMMONFORGE_EMAIL_FROM`). Dev: `log` mode writes the link to
 * the Worker log. Tests: {@link CapturingEmailTransport} records the message (no send).
 */
import type { Env } from "../env.js";
import { isLocalUrl } from "../lib/local-host.js";

export interface MagicLinkMessage {
  to: string;
  link: string;
  expiresAt: string;
}

export interface InviteMessage {
  to: string;
  orgName: string;
  /** the inviting owner's email */
  inviter: string;
  role: string;
  /** <COMMONFORGE_APP_URL>/signin: no token, so a forwarded invite signs nobody in */
  link: string;
}

export interface EmailTransport {
  sendMagicLink(message: MagicLinkMessage): Promise<void>;
  sendInvite(message: InviteMessage): Promise<void>;
}

export class EmailSendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function magicLinkText(link: string, expiresAt: string): { subject: string; text: string; html: string } {
  const subject = "Your CommonForge sign-in link";
  const text = `Sign in to CommonForge:\n\n${link}\n\nThe link works once and expires at ${expiresAt}. If you did not ask for it, ignore this email.`;
  const safe = escapeHtml(link);
  const html = `<p>Sign in to CommonForge:</p><p><a href="${safe}">Sign in</a></p><p>The link works once and expires at ${expiresAt}. If you did not ask for it, ignore this email.</p>`;
  return { subject, text, html };
}

/** Strip control characters (CR/LF would inject headers into the subject). */
function plain(s: string): string {
  return s.replace(/\p{Cc}/gu, "");
}

export function inviteText(message: InviteMessage): { subject: string; text: string; html: string } {
  const m = { ...message, orgName: plain(message.orgName), inviter: plain(message.inviter), role: plain(message.role) };
  const subject = `You were added to ${m.orgName} on CommonForge`;
  const text = `${m.inviter} added you to ${m.orgName} on CommonForge as ${m.role}.\n\nSign in with this email address:\n${m.link}\n\nIf you did not expect this, ignore this email.`;
  const html = `<p>${escapeHtml(m.inviter)} added you to <strong>${escapeHtml(m.orgName)}</strong> on CommonForge as ${escapeHtml(m.role)}.</p><p><a href="${escapeHtml(m.link)}">Sign in</a> with this email address.</p><p>If you did not expect this, ignore this email.</p>`;
  return { subject, text, html };
}

/** Cloudflare Email Service via the Workers `send_email` binding. */
export class BindingEmailTransport implements EmailTransport {
  constructor(
    private readonly binding: SendEmail,
    private readonly from: string,
  ) {}

  async sendMagicLink(m: MagicLinkMessage): Promise<void> {
    await this.send(m.to, magicLinkText(m.link, m.expiresAt));
  }

  async sendInvite(m: InviteMessage): Promise<void> {
    await this.send(m.to, inviteText(m));
  }

  private async send(to: string, { subject, text, html }: { subject: string; text: string; html: string }): Promise<void> {
    try {
      await this.binding.send({ from: { name: "CommonForge", email: this.from }, to, subject, text, html });
    } catch (e) {
      const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "E_UNKNOWN";
      throw new EmailSendError(code, `email send failed (${code})`);
    }
  }
}

/** Dev transport: the link goes to the Worker log. Never enable in production. */
export class LogEmailTransport implements EmailTransport {
  async sendMagicLink(m: MagicLinkMessage): Promise<void> {
    console.log(`[commonforge dev] magic link for ${m.to}: ${m.link}`);
  }

  async sendInvite(m: InviteMessage): Promise<void> {
    console.log(`[commonforge dev] invite for ${m.to} to ${m.orgName} as ${m.role}: ${m.link}`);
  }
}

/** Test transport: records every message so tests can follow the link. */
export class CapturingEmailTransport implements EmailTransport {
  readonly sent: MagicLinkMessage[] = [];
  readonly invites: InviteMessage[] = [];
  /** tests: make the next invites fail to send */
  failInvites = false;

  async sendMagicLink(m: MagicLinkMessage): Promise<void> {
    this.sent.push(m);
  }

  async sendInvite(m: InviteMessage): Promise<void> {
    if (this.failInvites) throw new EmailSendError("E_TEST", "invite send failed (test)");
    this.invites.push(m);
  }

  /** The token of the last web sign-in link sent to `to`. */
  lastToken(to: string): string | null {
    const m = [...this.sent].reverse().find((x) => x.to === to && new URL(x.link).searchParams.has("token"));
    return m ? new URL(m.link).searchParams.get("token") : null;
  }
  /** The code of the last CLI sign-in email sent to `to`. */
  lastCode(to: string): string | null {
    const m = [...this.sent].reverse().find((x) => x.to === to && new URL(x.link).searchParams.has("code"));
    return m ? new URL(m.link).searchParams.get("code") : null;
  }
}

/** names a deployment may carry (`ci`, bootstrap names); see emailLogAllowed */
const DEPLOYMENT_RE = /^[a-z][a-z0-9]{1,15}$/;
const RESERVED_DEPLOYMENTS = new Set(["production", "prod", "live", "main", "staging", "commonforge", "dev", "cfapp", "cfci"]);

/**
 * Log mode writes sign-in links to the Worker log, which anyone with log access can read, so it is
 * allowed only on a local Worker (`COMMONFORGE_PUBLIC_URL` on localhost / `.test`) or on a
 * non-production deployment that has its OWN resources: `COMMONFORGE_DEPLOYMENT` is a deployment
 * name (`ci` from scripts/ci-config.mjs, `<name>` from scripts/bootstrap.sh; exact match, not a
 * reserved word) AND the deployment's queue suffix is `-<name>`. Production consumes the unsuffixed
 * production queues, so a stray `COMMONFORGE_DEPLOYMENT` var or secret on it can never enable log
 * mode. Anywhere else a log-mode setting is refused: no link is written, sign-in fails, and
 * `/health` reports `ok: false` (review m4; Task 24 review I1).
 */
export function emailLogAllowed(env: Pick<Env, "COMMONFORGE_PUBLIC_URL" | "COMMONFORGE_DEPLOYMENT" | "COMMONFORGE_QUEUE_SUFFIX">): boolean {
  if (isLocalUrl(env.COMMONFORGE_PUBLIC_URL)) return true;
  const d = env.COMMONFORGE_DEPLOYMENT ?? "";
  return DEPLOYMENT_RE.test(d) && !RESERVED_DEPLOYMENTS.has(d) && env.COMMONFORGE_QUEUE_SUFFIX === `-${d}`;
}

export function defaultEmailTransport(env: Env): EmailTransport {
  if (env.COMMONFORGE_EMAIL_MODE !== "log") return new BindingEmailTransport(env.EMAIL, env.COMMONFORGE_EMAIL_FROM);
  if (emailLogAllowed(env)) return new LogEmailTransport();
  return {
    async sendMagicLink() {
      console.error("COMMONFORGE_EMAIL_MODE=log is refused on this deployment (production); no sign-in link was written");
      throw new EmailSendError("email_log_refused", "email log mode is refused on this deployment");
    },
    async sendInvite() {
      throw new EmailSendError("email_log_refused", "email log mode is refused on this deployment");
    },
  };
}
