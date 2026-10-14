/**
 * `cforge credential-helper --record <path> get|store|erase` — the git credential helper
 * (gitcredentials(7)) that `cforge checkout` configures per remote URL.
 *
 * On `get` it:
 *   - matches git's protocol/host/path against the task's planned remotes (from the checkout
 *     record in the user config dir) and answers `quit=1` for anything else, so a redirect or a
 *     stray remote never receives a token;
 *   - asks the broker for a fresh token on every request (`POST /api/tasks/:id/credential` with
 *     the task lease): `write` for writable mounts (falling back to `read` once the workspace is
 *     frozen), `read` for reference copies;
 *   - prints it to git only (basic-auth form `x-token:<token>`), with `password_expiry_utc`.
 * For a mount's LFS URL (`lfs.url`, folders phase 4) — the endpoint or a path under it, on the
 * checkout's API origin over https (or loopback http) — it answers the task lease token itself,
 * which the LFS server accepts (agent staging only); no broker call.
 * `store` and `erase` are no-ops: nothing is ever persisted.
 */
import { WorkspaceCredentialSchema } from "@commonforge-org/core";
import { isAbsolute } from "node:path";
import { ApiClient, isSecureEnough, leaseBearer, leaseHint, normalizeApiUrl } from "./api.js";
import { parse, positional, str, type CommandContext } from "./command.js";
import { CliError, rememberSecret, scrub } from "./context.js";
import { ConfigStore, type CheckoutRecord } from "./config.js";

const USAGE = "cforge credential-helper --record <checkout record path> <get|store|erase>";

/** Artifacts accepts the token as the basic-auth password (plan §D.2); the username is ignored. */
export const HELPER_USERNAME = "x-token";

export function parseCredentialRequest(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const l = line.replace(/\r$/, "");
    if (l === "") break;
    const eq = l.indexOf("=");
    if (eq <= 0) continue;
    const k = l.slice(0, eq);
    if (!m.has(k)) m.set(k, l.slice(eq + 1));
  }
  return m;
}

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, "");

/** The planned mount whose remote is exactly git's protocol + host + path, or null. */
export function matchRemote(record: CheckoutRecord, req: Map<string, string>): CheckoutRecord["mounts"][number] | null {
  const protocol = req.get("protocol");
  const host = req.get("host");
  const path = req.get("path");
  if (!protocol || !host || path === undefined) return null;
  for (const m of record.mounts) {
    if (m.credential !== "helper") continue;
    let u: URL;
    try {
      u = new URL(m.remoteUrl);
    } catch {
      continue;
    }
    if (u.protocol !== `${protocol}:` || u.host.toLowerCase() !== host.toLowerCase()) continue;
    if (trimSlashes(decodeURIComponent(u.pathname)) !== trimSlashes(path)) continue;
    return m;
  }
  return null;
}

/** Path segments of a credential request path, or null for `.`/`..`/empty or undecodable segments. */
function pathSegments(path: string): string[] | null {
  const trimmed = trimSlashes(path);
  if (trimmed === "") return [];
  const out: string[] = [];
  for (const raw of trimmed.split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === "" || seg === "." || seg === ".." || seg.includes("/")) return null;
    out.push(seg);
  }
  return out;
}

/**
 * The recorded mount whose LFS URL is git's protocol + host and whose path is that URL's path or
 * under it (git-lfs asks for the endpoint; `…/objects/batch` and `…/locks/…` are accepted too).
 * Only LFS URLs on the record's API origin and over https (or loopback http) count.
 */
export function matchLfs(record: CheckoutRecord, req: Map<string, string>): CheckoutRecord["mounts"][number] | null {
  const protocol = req.get("protocol");
  const host = req.get("host");
  const path = req.get("path");
  if (!protocol || !host || path === undefined) return null;
  const segs = pathSegments(path);
  if (!segs) return null;
  let apiOrigin: string;
  try {
    apiOrigin = new URL(record.apiUrl).origin;
  } catch {
    return null;
  }
  for (const m of record.mounts) {
    if (!m.lfsUrl || !isSecureEnough(m.lfsUrl)) continue;
    let u: URL;
    try {
      u = new URL(m.lfsUrl);
    } catch {
      continue;
    }
    if (u.origin !== apiOrigin || u.protocol !== `${protocol}:` || u.host.toLowerCase() !== host.toLowerCase()) continue;
    const base = pathSegments(u.pathname);
    if (!base || base.length === 0 || segs.length < base.length || base.some((s, i) => s !== segs[i])) continue;
    return m;
  }
  return null;
}

/** Retries of the `/credential` call on 503 / provider_unavailable (1 s, 2 s, 4 s). */
export const CREDENTIAL_RETRIES = 3;
const CREDENTIAL_RETRY_BASE_MS = 1000;

/** Codes after which a writable mount may still be read (frozen or not writable any more). */
const WRITE_REFUSED = new Set(["workspace_not_writable", "workspace_frozen", "read_only_mount", "no_write_grant", "candidate_frozen"]);

export async function credentialHelper(ctx: CommandContext, args: readonly string[]): Promise<number> {
  const p = parse(args, { record: { type: "string" } }, USAGE);
  const action = positional(p, 0, "action", USAGE);
  const input = await ctx.io.readStdin();
  if (action !== "get") return 0; // store / erase: nothing is ever kept
  const refuse = (why: string): number => {
    ctx.io.stderr(scrub(`cforge credential-helper: ${why}\n`));
    ctx.io.stdout("quit=1\n");
    return 0;
  };
  const recordPath = str(p, "record");
  if (!recordPath || !isAbsolute(recordPath) || !recordPath.endsWith(".json")) return refuse("missing or invalid --record");

  // Everything comes from the checkout record's config dir, not from the caller's environment.
  const store = ConfigStore.forRecord(recordPath);
  let record: CheckoutRecord | null;
  try {
    record = await store.readCheckout(recordPath);
  } catch (e) {
    return refuse(e instanceof CliError ? e.message : "unreadable checkout record");
  }
  if (!record) return refuse(`no checkout record at ${recordPath} (re-run \`cforge checkout\`)`);
  const taskId = record.taskId;
  const req = parseCredentialRequest(input);
  if (matchLfs(record, req)) {
    // The LFS server takes the lease itself as the basic-auth password (no broker call).
    let bearer: Awaited<ReturnType<typeof leaseBearer>>;
    try {
      bearer = await leaseBearer(ctx.io, store, taskId, normalizeApiUrl(record.apiUrl));
    } catch (e) {
      return refuse(e instanceof CliError ? e.message : String(e));
    }
    if (!bearer) return refuse(`no live lease for ${taskId}; run \`cforge task lease ${taskId}\``);
    rememberSecret(bearer.token);
    if (/[\r\n]/.test(bearer.token)) return refuse("the lease token is malformed");
    const expiry = bearer.expiresAt ? Math.floor(Date.parse(bearer.expiresAt) / 1000) : NaN;
    // Protocol output to git only — deliberately not redacted.
    ctx.io.stdout(`username=${HELPER_USERNAME}\npassword=${bearer.token}\n${Number.isFinite(expiry) ? `password_expiry_utc=${expiry}\n` : ""}`);
    return 0;
  }
  const mount = matchRemote(record, req);
  if (!mount) return refuse(`refusing credentials for ${req.get("protocol") ?? "?"}://${req.get("host") ?? "?"}/${req.get("path") ?? ""}: not a remote of ${taskId}`);
  if (!isSecureEnough(mount.remoteUrl)) return refuse(`refusing to send a token over plain http to ${new URL(mount.remoteUrl).host}`);

  let api: ApiClient;
  try {
    const apiUrl = normalizeApiUrl(record.apiUrl);
    const bearer = await leaseBearer(ctx.io, store, taskId, apiUrl);
    if (!bearer) return refuse(`no live lease for ${taskId}; run \`cforge task lease ${taskId}\``);
    api = new ApiClient(ctx.io, apiUrl, bearer.token);
  } catch (e) {
    return refuse(e instanceof CliError ? e.message : String(e));
  }
  // review I2: a transient platform outage (503 / provider_unavailable) is retried, so a short
  // Artifacts blip does not kill the agent's push; anything else fails at once
  const ask = async (access: "read" | "write") => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await api.post(`/api/tasks/${encodeURIComponent(taskId)}/credential`, { mountName: mount.mountName, access });
      } catch (e) {
        const transient = e instanceof CliError && (e.details?.status === 503 || e.code === "provider_unavailable");
        if (!transient || attempt > CREDENTIAL_RETRIES) throw e;
        ctx.io.stderr(`cforge credential-helper: the credential service is temporarily unavailable, retrying (${attempt}/${CREDENTIAL_RETRIES})\n`);
        await ctx.io.sleep(CREDENTIAL_RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
  };

  let raw: unknown;
  try {
    if (mount.writable) {
      try {
        raw = await ask("write");
      } catch (e) {
        if (!(e instanceof CliError) || !WRITE_REFUSED.has(e.code)) throw e;
        raw = await ask("read");
      }
    } else {
      raw = await ask("read");
    }
  } catch (e) {
    if (e instanceof CliError && e.details?.status === 401) return refuse(leaseHint(taskId));
    return refuse(e instanceof CliError ? `${e.message} (${e.code})` : String(e));
  }
  const cred = WorkspaceCredentialSchema.safeParse(raw);
  if (!cred.success) return refuse("the broker returned an invalid credential");
  rememberSecret(cred.data.secret);
  if (cred.data.remoteUrl !== mount.remoteUrl) return refuse(`the broker returned a credential for another repository`);
  if (/[\r\n]/.test(cred.data.secret)) return refuse("the broker returned a malformed credential");
  const expiry = Math.floor(Date.parse(cred.data.expiresAt) / 1000);
  // Protocol output to git only — deliberately not redacted.
  ctx.io.stdout(`username=${HELPER_USERNAME}\npassword=${cred.data.secret}\n${Number.isFinite(expiry) ? `password_expiry_utc=${expiry}\n` : ""}`);
  return 0;
}
