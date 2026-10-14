/**
 * Magic-link auth.
 *
 * - Browser: `POST /api/auth/magic-link {email}` → the email links to `<APP_URL>/auth/verify?token=…`;
 *   the app page asks the user to click "Sign in", which POSTs `/api/auth/verify {token}`. The
 *   session is **only** an HttpOnly cookie; the body never carries it (I-5). Nothing is consumed on
 *   GET (mail scanners cannot burn links; no login CSRF through a link).
 * - CLI: `POST /api/auth/magic-link {email, client: "cli"}` → the email carries a code; the user
 *   runs `cforge login --code <code>`, which POSTs `/api/auth/cli/verify {code}` and receives a bearer
 *   (`cfs_…`). Web and CLI codes are not interchangeable.
 * - CLI, already signed in: `POST /api/auth/cli/code` returns such a code directly (no email), for
 *   the agent hand-off's prompt; the agent runs `cforge login --code <code>` itself.
 */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { readJson } from "../lib/http.js";
import { LEGACY_SESSION_COOKIE, SESSION_COOKIE, bearer, requireUser, sessionCookie } from "../middleware/authz.js";
import { EmailSchema, SESSION_TTL_MS, issueCliCode, listSessions, requestMagicLink, revokeSession, revokeSessions, verifyMagicLink } from "../services/auth.js";
import { isInstanceAdmin } from "../services/admins.js";

export const authRoutes = new Hono<AppEnv>();

function setSessionCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // `__Host-` cookies must be Secure (browsers also accept Secure cookies on http://localhost)
    secure: true,
    // Strict: never sent on cross-site requests; same-site cross-origin writes are refused by the
    // Origin check in app.ts (csrfGuard)
    sameSite: "Strict",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

authRoutes.post("/auth/magic-link", async (c) => {
  const body = await readJson(c, z.object({ email: EmailSchema, client: z.enum(["web", "cli"]).default("web") }));
  await requestMagicLink(c.get("svc"), body.email, body.client, c.req.header("cf-connecting-ip") ?? null);
  // Same answer whether or not the address has an account (no enumeration).
  return c.json({ ok: true }, 202);
});

const TokenSchema = z.string().regex(/^cfm_[A-Za-z0-9_-]{20,}$/);

authRoutes.post("/auth/verify", async (c) => {
  const body = await readJson(c, z.object({ token: TokenSchema }));
  const r = await verifyMagicLink(c.get("svc"), body.token, "web");
  setSessionCookie(c, r.sessionToken);
  c.header("cache-control", "no-store");
  return c.json({ user: { userId: r.user.user_id, email: r.user.email }, expiresAt: new Date(r.expiresAt).toISOString() });
});

/** CLI login: exchange a `client: "cli"` code for a bearer session token (shown once). */
authRoutes.post("/auth/cli/verify", async (c) => {
  const body = await readJson(c, z.object({ code: TokenSchema }));
  const r = await verifyMagicLink(c.get("svc"), body.code, "cli");
  c.header("cache-control", "no-store");
  return c.json({ user: { userId: r.user.user_id, email: r.user.email }, sessionToken: r.sessionToken, expiresAt: new Date(r.expiresAt).toISOString() });
});

/** A one-time `cforge login` code for the signed-in person (single use, 15 minutes); shown once. */
authRoutes.post("/auth/cli/code", async (c) => {
  const user = requireUser(c);
  const r = await issueCliCode(c.get("svc"), user);
  c.header("cache-control", "no-store");
  return c.json({ code: r.code, expiresAt: new Date(r.expiresAt).toISOString() }, 201);
});

/** The session token this request carries (bearer, else the cookie). */
function requestToken(c: Context<AppEnv>): string | null {
  const fromCookie = sessionCookie(c);
  return bearer(c) ?? (fromCookie === "duplicate" ? null : fromCookie);
}

/** The signed-in person's sessions (Account page): browser, cforge and hand-off logins; never the tokens. */
authRoutes.get("/auth/sessions", async (c) => {
  const user = requireUser(c);
  c.header("cache-control", "no-store");
  return c.json({ sessions: await listSessions(c.get("svc"), user.userId, requestToken(c)) });
});

/** End one of your sessions (`{ sessionId }`) or all but this one (`{ others: true }`). */
authRoutes.post("/auth/sessions/revoke", async (c) => {
  const user = requireUser(c);
  const body = await readJson(c, z.union([z.object({ sessionId: z.string().regex(/^[0-9a-f]{20}$/) }), z.object({ others: z.literal(true) })]));
  const ended = await revokeSessions(c.get("svc"), user.userId, requestToken(c), body);
  return c.json({ ended });
});

authRoutes.post("/auth/logout", async (c) => {
  const fromCookie = sessionCookie(c);
  const token = bearer(c) ?? (fromCookie === "duplicate" ? null : fromCookie) ?? getCookie(c, LEGACY_SESSION_COOKIE);
  if (token?.startsWith("cfs_")) await revokeSession(c.get("svc"), token);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
  deleteCookie(c, LEGACY_SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
  const user = requireUser(c);
  const rows = await c
    .get("svc")
    .db.prepare("SELECT m.org_id, m.role, o.name FROM memberships m JOIN orgs o ON o.org_id = m.org_id WHERE m.user_id = ? AND o.archived_at IS NULL ORDER BY o.name")
    .bind(user.userId)
    .all<{ org_id: string; role: string; name: string }>();
  return c.json({
    user: { userId: user.userId, email: user.email },
    memberships: rows.results.map((r) => ({ orgId: r.org_id, name: r.name, role: r.role })),
    canCreateOrgs: isInstanceAdmin(c.get("svc").env, user.email),
  });
});
