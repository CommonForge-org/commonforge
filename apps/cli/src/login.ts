/**
 * `cforge login` — the CLI code flow (API.md "Auth routes"):
 *   1. `POST /api/auth/magic-link {email, client: "cli"}` emails a one-time code (`cfm_…`);
 *   2. `POST /api/auth/cli/verify {code}` exchanges it for a session bearer (`cfs_…`).
 * The bearer is stored 0600 in the user config dir, never in a workspace. The browser cookie
 * flow is never used.
 */
import { z } from "zod";
import { ApiClient, normalizeApiUrl, resolveApiUrl, sessionClient } from "./api.js";
import { parse, str, type CommandContext } from "./command.js";
import { CliError, rememberSecret } from "./context.js";

const LOGIN_USAGE = "cforge login [--email <address>] [--code <code>] [--api-url <url>] [--json]";

const CODE_RE = /^cfm_[A-Za-z0-9_-]{20,}$/;

/**
 * Accept the bare code, the emailed link (`…/auth/cli?code=cfm_…`), or the whole
 * `cforge login --code cfm_…` command the web page's Copy button produces.
 */
export function extractCode(input: string): string {
  const s = input.trim();
  let code = s;
  const fromCommand = /^cforge\s+login\b.*--code[=\s]+(\S+)\s*$/.exec(s);
  if (fromCommand) code = fromCommand[1]!.replace(/^["']|["']$/g, "");
  if (/^https?:\/\//i.test(s)) {
    try {
      code = new URL(s).searchParams.get("code") ?? "";
    } catch {
      code = "";
    }
  }
  if (!CODE_RE.test(code)) throw new CliError("invalid_code", "that does not look like a cforge login code (cfm_…)");
  return code;
}

const VerifySchema = z.object({
  user: z.object({ userId: z.string(), email: z.string() }),
  sessionToken: z.string().startsWith("cfs_"),
  expiresAt: z.string(),
});

export async function login(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, { email: { type: "string" }, code: { type: "string" } }, LOGIN_USAGE);
  const apiUrl = await resolveApiUrl(ctx.io, ctx.store, ctx.global.apiUrl);
  const api = new ApiClient(ctx.io, apiUrl, null);
  let codeInput = str(p, "code");
  const email = str(p, "email");

  if (!codeInput) {
    if (!email) throw new CliError("invalid_arguments", `pass --email to receive a code, or --code\nusage: ${LOGIN_USAGE}`, undefined, 2);
    await api.post("/api/auth/magic-link", { email, client: "cli" });
    codeInput = (await ctx.io.prompt(`A sign-in code was sent to ${email}. Paste the code (or the link): `)) ?? undefined;
    if (!codeInput) {
      ctx.out.result({ status: "code_sent", email, apiUrl, next: "cforge login --code <code>" }, `A sign-in code was sent to ${email}.\nRun: cforge login --code <code>`);
      return;
    }
  }

  const code = extractCode(codeInput);
  rememberSecret(code);
  const raw = await api.post("/api/auth/cli/verify", { code });
  const r = VerifySchema.safeParse(raw);
  if (!r.success) throw new CliError("invalid_response", "unexpected response from /api/auth/cli/verify");
  rememberSecret(r.data.sessionToken);
  await ctx.store.saveSession({ apiUrl, sessionToken: r.data.sessionToken, expiresAt: r.data.expiresAt, user: r.data.user });
  await ctx.store.saveConfig({ apiUrl });
  ctx.out.result({ status: "logged_in", apiUrl, user: r.data.user, expiresAt: r.data.expiresAt }, `Logged in to ${apiUrl} as ${r.data.user.email} (session expires ${r.data.expiresAt}).`);
}

export async function logout(ctx: CommandContext, args: readonly string[]): Promise<void> {
  parse(args, {}, "cforge logout [--json]");
  const session = await ctx.store.session();
  if (session) {
    try {
      await new ApiClient(ctx.io, normalizeApiUrl(session.apiUrl), session.sessionToken).post("/api/auth/logout");
    } catch (e) {
      ctx.out.info(`warning: server logout failed: ${(e as Error).message}`);
    }
  }
  await ctx.store.clearSession();
  ctx.out.result({ status: "logged_out" }, "Logged out.");
}

export interface MeResponse {
  user: { userId: string; email: string };
  memberships: Array<{ orgId: string; name: string; role: string }>;
}

export async function whoami(ctx: CommandContext, args: readonly string[]): Promise<void> {
  parse(args, {}, "cforge whoami [--json]");
  const { api } = await sessionClient(ctx.io, ctx.store, ctx.global.apiUrl);
  const me = await api.get<MeResponse>("/api/me");
  ctx.out.result({ apiUrl: api.apiUrl, ...me }, () =>
    [`${me.user.email} (${me.user.userId}) at ${api.apiUrl}`, ...me.memberships.map((m) => `  ${m.orgId}  ${m.role.padEnd(9)} ${m.name}`)].join("\n"),
  );
}
