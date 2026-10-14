/**
 * Cookie-mode authentication for capture: the `cfs_…` session token from a persona's CLI
 * `session.json` (written by `cforge login`) is injected as the app's session cookie in that
 * persona's browser context and checked with `GET /api/me`. Tokens are never printed.
 */
import { readFileSync } from 'node:fs';
import type { BrowserContext } from 'playwright';
import { z } from 'zod';

export type Persona = 'owner' | 'client';

export const SESSION_COOKIE = '__Host-cf_session';

const SessionFileSchema = z.object({
  apiUrl: z.string(),
  sessionToken: z.string(),
  expiresAt: z.string(),
  user: z.object({ email: z.string() }),
});

export interface Session {
  token: string;
  email: string;
  apiUrl: string;
  expiresAt: string;
}

export function readSession(file: string): Session {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read session file ${file}: ${(error as Error).message}`);
  }
  const parsed = SessionFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is not a CLI session.json (expected apiUrl, sessionToken, expiresAt, user.email)`);
  const s = parsed.data;
  if (!s.sessionToken.startsWith('cfs_')) throw new Error(`${file} is not a CLI session: its token is not a cfs_ session token`);
  return { token: s.sessionToken, email: s.user.email, apiUrl: s.apiUrl, expiresAt: s.expiresAt };
}

/** Adds the session cookie for `baseUrl` (HttpOnly, Secure, SameSite=Strict, host-only, Path=/). */
export async function attachSession(context: BrowserContext, baseUrl: string, session: Session): Promise<void> {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') throw new Error(`cookie mode needs an https CAPTURE_BASE_URL (${SESSION_COOKIE} is a Secure cookie), got ${url.origin}`);
  await context.addCookies([
    { name: SESSION_COOKIE, value: session.token, url: url.origin, httpOnly: true, secure: true, sameSite: 'Strict' },
  ]);
}

interface MeResponse {
  user: { email: string };
  memberships: Array<{ orgId: string; role: string }>;
}

/** `GET /api/me` through the context's cookie jar; returns the persona's email and role in `org`. */
export async function verifySession(context: BrowserContext, baseUrl: string, org: string, persona: Persona): Promise<{ email: string; role: string }> {
  const res = await context.request.get(new URL('/api/me', baseUrl).toString(), { failOnStatusCode: false });
  if (res.status() !== 200) throw new Error(`${persona}: GET /api/me returned ${res.status()}; log in again with cforge login`);
  const me = (await res.json()) as MeResponse;
  const role = me.memberships.find((m) => m.orgId === org)?.role;
  if (!role) throw new Error(`${persona}: ${me.user.email} is not a member of ${org}`);
  if (persona === 'client' ? role !== 'client' : role !== 'owner') {
    throw new Error(`${persona}: ${me.user.email} has role "${role}" in ${org}; expected "${persona === 'client' ? 'client' : 'owner'}"`);
  }
  return { email: me.user.email, role };
}
