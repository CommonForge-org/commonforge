/**
 * Magic-link sign-in, sessions and task-lease tokens. Every bearer secret is stored only as
 * HMAC(COMMONFORGE_SESSION_SECRET, purpose|token); the plaintext is returned once.
 */
import { z } from "zod";
import type { Services } from "../context.js";
import { keyedHash, newId, randomToken } from "../lib/crypto.js";
import { ApiError } from "../lib/http.js";
import { ensureUser, getUser, type UserRow } from "./directory.js";

export const MAGIC_LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** A cforge session opened with a hand-off prompt's one-time code: it sat in an agent's chat, so it lasts a week. */
export const HANDOFF_SESSION_TTL_MS = 7 * 24 * 3600_000;
export type SessionClient = "web" | "cli" | "handoff";
/** Magic-link send limits (I-4): per address, per client IP, and a global cap protecting the sender domain. */
export const MAGIC_LINK_LIMIT = 5;
export const MAGIC_LINK_WINDOW_MS = 15 * 60_000;
export const MAGIC_LINK_IP_LIMIT = 10;
export const MAGIC_LINK_GLOBAL_LIMIT = 200;
export const MAGIC_LINK_GLOBAL_WINDOW_MS = 3600_000;

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

const secret = (svc: Services) => svc.env.COMMONFORGE_SESSION_SECRET;

/**
 * Send a sign-in link. `web` links open the app's sign-in page (the user clicks "Sign in", which
 * POSTs /api/auth/verify — nothing is consumed on GET, so mail scanners cannot burn the link);
 * `cli` links carry a code for `cforge login`, exchanged at POST /api/auth/cli/verify for a bearer.
 */
export async function requestMagicLink(svc: Services, email: string, purpose: "web" | "cli", clientIp: string | null): Promise<void> {
  const now = svc.now().getTime();
  // Never mail the sender address: it has no inbox, so the link would vanish silently.
  if (email.toLowerCase() === (svc.env.COMMONFORGE_EMAIL_FROM ?? "").toLowerCase()) {
    throw new ApiError(400, "invalid_email", "that is CommonForge's sending address; enter your own email");
  }
  const gate = svc.env.OPS_GATE.get(svc.env.OPS_GATE.idFromName("ratelimit:magic-link"));
  const ipKey = `ip:${ipBucket(clientIp)}`;
  const limited = await gate.hit([
    { key: `email:${email}`, limit: MAGIC_LINK_LIMIT, windowMs: MAGIC_LINK_WINDOW_MS },
    { key: ipKey, limit: MAGIC_LINK_IP_LIMIT, windowMs: MAGIC_LINK_WINDOW_MS },
    { key: "global", limit: MAGIC_LINK_GLOBAL_LIMIT, windowMs: MAGIC_LINK_GLOBAL_WINDOW_MS },
  ]);
  if (!limited.ok) throw new ApiError(429, "rate_limited", "too many sign-in links requested; try again later");
  const token = randomToken("cfm");
  const hash = await keyedHash(secret(svc), "magic", token);
  const expires = now + MAGIC_LINK_TTL_MS;
  await svc.db
    .prepare("INSERT INTO magic_links (token_hash, email, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(hash, email, purpose, now, expires)
    .run();
  const base = svc.env.COMMONFORGE_APP_URL.replace(/\/+$/, "");
  const link = purpose === "web" ? `${base}/auth/verify?token=${encodeURIComponent(token)}` : `${base}/auth/cli?code=${encodeURIComponent(token)}`;
  await svc.deps.email(svc.env).sendMagicLink({ to: email, link, expiresAt: new Date(expires).toISOString() });
}

/** One-time CLI codes a signed-in person asks for in the app (the agent hand-off's prompt): per user. */
export const CLI_CODE_LIMIT = 30;

/**
 * A one-time `cforge login` code for a person who is already signed in (`POST /api/auth/cli/code`):
 * the same single-use, 15-minute `cli` magic link the email carries, issued without the email, so
 * the agent hand-off's prompt can sign the agent in by itself. Only its hash is stored.
 */
export async function issueCliCode(svc: Services, user: { userId: string; email: string }): Promise<{ code: string; expiresAt: number }> {
  const now = svc.now().getTime();
  const gate = svc.env.OPS_GATE.get(svc.env.OPS_GATE.idFromName("ratelimit:magic-link"));
  const limited = await gate.hit([{ key: `cli-code:${user.userId}`, limit: CLI_CODE_LIMIT, windowMs: MAGIC_LINK_WINDOW_MS }]);
  if (!limited.ok) throw new ApiError(429, "rate_limited", "too many sign-in codes requested; try again later");
  const code = randomToken("cfm");
  const hash = await keyedHash(secret(svc), "magic", code);
  const expiresAt = now + MAGIC_LINK_TTL_MS;
  await svc.db.prepare("INSERT INTO magic_links (token_hash, email, purpose, created_at, expires_at, via) VALUES (?, ?, 'cli', ?, ?, 'handoff')").bind(hash, user.email, now, expiresAt).run();
  return { code, expiresAt };
}

/** Consume a magic-link token (single use) and open a session. */
/** Rate-limit bucket for a client IP: IPv4 as is, IPv6 by its /64 (one host usually owns a /64; N-5). */
export function ipBucket(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  let addr = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  if (addr.includes(".")) return addr; // v4-mapped
  const [head, tail] = addr.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export async function verifyMagicLink(svc: Services, token: string, purpose: "web" | "cli"): Promise<{ user: UserRow; sessionToken: string; expiresAt: number }> {
  const now = svc.now().getTime();
  const hash = await keyedHash(secret(svc), "magic", token);
  const consumed = await svc.db
    .prepare("UPDATE magic_links SET consumed_at = ? WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ? RETURNING email, via")
    .bind(now, hash, purpose, now)
    .first<{ email: string; via: string | null }>();
  if (!consumed) throw new ApiError(401, "invalid_token", "the sign-in link is invalid, used or expired");
  const user = await ensureUser(svc.db, consumed.email, () => newId("u"), svc.nowIso());
  const client: SessionClient = purpose === "web" ? "web" : consumed.via === "handoff" ? "handoff" : "cli";
  const session = await createSession(svc, user.user_id, client);
  return { user, ...session };
}

export async function createSession(svc: Services, userId: string, client: SessionClient | null = null): Promise<{ sessionToken: string; expiresAt: number }> {
  const now = svc.now().getTime();
  const sessionToken = randomToken("cfs");
  const hash = await keyedHash(secret(svc), "session", sessionToken);
  const expiresAt = now + (client === "handoff" ? HANDOFF_SESSION_TTL_MS : SESSION_TTL_MS);
  await svc.db.prepare("INSERT INTO sessions (session_hash, user_id, created_at, expires_at, client) VALUES (?, ?, ?, ?, ?)").bind(hash, userId, now, expiresAt, client).run();
  return { sessionToken, expiresAt };
}

/** A session's id on the Account page: a prefix of its keyed hash (never the token; it cannot sign anyone in). */
const SESSION_ID_LEN = 20;

export interface SessionView {
  sessionId: string;
  client: SessionClient | "unknown";
  createdAt: string;
  expiresAt: string;
  /** the session this request was made with */
  current: boolean;
}

/** The person's live sessions (not revoked, not expired), newest first. */
export async function listSessions(svc: Services, userId: string, currentToken: string | null): Promise<SessionView[]> {
  const currentHash = currentToken?.startsWith("cfs_") ? await keyedHash(secret(svc), "session", currentToken) : null;
  const rows = await svc.db
    .prepare("SELECT session_hash, client, created_at, expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 100")
    .bind(userId, svc.now().getTime())
    .all<{ session_hash: string; client: string | null; created_at: number; expires_at: number }>();
  return rows.results.map((r) => ({
    sessionId: r.session_hash.slice(0, SESSION_ID_LEN),
    client: r.client === "web" || r.client === "cli" || r.client === "handoff" ? r.client : "unknown",
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    current: r.session_hash === currentHash,
  }));
}

/**
 * End the person's own sessions: one (`sessionId`), or every one but the current (`others`).
 * Returns how many ended. Never touches another person's sessions.
 */
export async function revokeSessions(svc: Services, userId: string, currentToken: string | null, which: { sessionId: string } | { others: true }): Promise<number> {
  const now = svc.now().getTime();
  if ("sessionId" in which) {
    if (!/^[0-9a-f]{20}$/.test(which.sessionId)) return 0;
    const r = await svc.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND substr(session_hash, 1, ?) = ? AND revoked_at IS NULL").bind(now, userId, SESSION_ID_LEN, which.sessionId).run();
    return r.meta.changes ?? 0;
  }
  const keep = currentToken?.startsWith("cfs_") ? await keyedHash(secret(svc), "session", currentToken) : "";
  const r = await svc.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND session_hash <> ? AND revoked_at IS NULL").bind(now, userId, keep).run();
  return r.meta.changes ?? 0;
}

export async function resolveSession(svc: Services, token: string): Promise<UserRow | null> {
  const hash = await keyedHash(secret(svc), "session", token);
  const row = await svc.db
    .prepare("SELECT user_id FROM sessions WHERE session_hash = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(hash, svc.now().getTime())
    .first<{ user_id: string }>();
  return row ? getUser(svc.db, row.user_id) : null;
}

export async function revokeSession(svc: Services, token: string): Promise<void> {
  const hash = await keyedHash(secret(svc), "session", token);
  await svc.db.prepare("UPDATE sessions SET revoked_at = ? WHERE session_hash = ?").bind(svc.now().getTime(), hash).run();
}

export const leaseTokenHash = (svc: Services, token: string) => keyedHash(secret(svc), "lease", token);

export interface LeasedTask {
  task_id: string;
  org_id: string;
  lease_generation: number;
  lease_expires_at: number;
  lease_holder: string;
}

/** Resolve an agent bearer (`cfl_…`) to its task; expired leases resolve to null. */
export async function resolveLease(svc: Services, token: string): Promise<LeasedTask | null> {
  const hash = await leaseTokenHash(svc, token);
  const row = await svc.db
    .prepare("SELECT task_id, org_id, lease_generation, lease_expires_at, lease_holder FROM tasks WHERE lease_hash = ?")
    .bind(hash)
    .first<LeasedTask>();
  if (!row || row.lease_expires_at <= svc.now().getTime()) return null;
  return row;
}
