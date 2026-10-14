/**
 * Sandbox egress gateway policy (Task 22; apps/runner/README.md "Requirements for Task 22").
 *
 * The runner container starts with `enableInternet: false`; the only ways out are the outbound
 * interceptors the RunnerBox registers for ONE job, each a `WorkerEntrypoint` with per-job props:
 *
 * | Host | Allowed | Credential |
 * |---|---|---|
 * | the Artifacts git host | only the job's repositories (`jobRepoAccess`): `upload-pack` for every one, `receive-pack` only for write entries, and a receive-pack command list of exactly ONE update to a ref in `jobAllowedPushRefs(job)` with the job's lease (no deletes, no `atomic`, no push options) | the job's short-lived token, injected here; minted by the broker after it verified the SignedJob, `ttl <= job expiry`, revoked when the job ends; refused after `expiresAt` |
 * | the control plane | `POST /api/runner/{results,evidence-key,heads}`, `GET\|PUT /api/runner/blobs/*` (the SignedJob authenticates them) | none added; `/credential*` and `/deploy-credential` are refused, so code in the container can never mint anything |
 * | `registry.npmjs.org` | `GET`/`HEAD` only, for jobs that run install/build steps; for `integrate` only with the per-job npm key the runner's dependency install presents (checks run offline) | none (Authorization stripped) |
 * | `api.cloudflare.com` | `release-deploy` jobs only: the job's Worker scripts (and the workers.dev subdomain lookup, assets upload) on the job's account | the account deploy token, swapped in for wrangler's placeholder; refused after `expiresAt` |
 *
 * Bearer only for runner traffic (requirement 4): the interceptor sees requests, not processes, so
 * it cannot tell the runner's git from a check process (both run in the container). Items 1–3 are
 * therefore the control: a check that reached the gateway could only read the job's own
 * repositories and could only push the one allowed ref with the job's lease (the runner's own
 * push would then fail its lease and the job fails; nothing else is reachable). Where the runtime
 * allows `unshare --net`, checks get no network at all (`COMMONFORGE_RUNNER_CHECK_NETWORK=auto`).
 */
import { jobRepoAccess, type AllowedPush, type IntegrationJob } from "@commonforge-org/runner-protocol";

export const ZERO_SHA = "0000000000000000000000000000000000000000";

export interface GatewayRepo {
  /** `/git/<namespace>/<repo>.git` */
  path: string;
  token: string;
  write: boolean;
  /** exact refs this job may update in this repository, with their leases */
  pushes: Array<Pick<AllowedPush, "ref" | "lease" | "expectedSha">>;
}

/** Header only the root runner process sends (review I-3); the gateways drop it before forwarding. */
export const RUNNER_KEY_HEADER = "x-commonforge-runner-key";

/** Constant-time-ish equality of the presented runner key. */
export function runnerKeyOk(expected: string, presented: string | null): boolean {
  if (!presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

export interface ArtifactsGatewayProps {
  jobId: string;
  /**
   * Per-job secret held only by the root runner process (root-only file, git child env). Check and
   * recipe processes (uid 10001) never have it, so they get no canonical read through the injected
   * bearer even when they share the container's network (review I-3).
   */
  runnerKey: string;
  /** ms since epoch: the job's expiry; nothing passes afterwards */
  expiresAt: number;
  host: string;
  repos: GatewayRepo[];
}

export type GitDecision =
  | { ok: true; repo: GatewayRepo; service: "upload-pack" | "receive-pack"; rpc: boolean }
  | { ok: false; status: number; reason: string };

/** Which git smart-HTTP requests may pass for this job (host, repo path, service, method). */
export function decideGitRequest(props: ArtifactsGatewayProps, method: string, url: URL, now: number, presentedKey: string | null): GitDecision {
  if (now >= props.expiresAt) return { ok: false, status: 403, reason: "job expired" };
  if (!runnerKeyOk(props.runnerKey, presentedKey)) return { ok: false, status: 403, reason: "only the runner process may use the job's repositories" };
  if (url.hostname !== props.host) return { ok: false, status: 403, reason: "host not allowed" };
  for (const repo of props.repos) {
    if (url.pathname === `${repo.path}/info/refs` && method === "GET") {
      const svc = url.searchParams.get("service");
      if (svc === "git-upload-pack") return { ok: true, repo, service: "upload-pack", rpc: false };
      if (svc === "git-receive-pack" && repo.write) return { ok: true, repo, service: "receive-pack", rpc: false };
      return { ok: false, status: 403, reason: `service ${svc ?? "(none)"} not allowed on ${repo.path}` };
    }
    if (method === "POST" && url.pathname === `${repo.path}/git-upload-pack`) return { ok: true, repo, service: "upload-pack", rpc: true };
    if (method === "POST" && url.pathname === `${repo.path}/git-receive-pack`) {
      return repo.write ? { ok: true, repo, service: "receive-pack", rpc: true } : { ok: false, status: 403, reason: `${repo.path} is read-only for this job` };
    }
  }
  return { ok: false, status: 403, reason: "repository or path not part of this job" };
}

export interface ReceivePackCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

export type CommandParse = { complete: false } | { complete: true; ok: true; commands: ReceivePackCommand[]; capabilities: string[]; headerLength: number } | { complete: true; ok: false; reason: string };

const dec = new TextDecoder();

/**
 * Parse the receive-pack command section (pkt-lines up to the first flush) from the start of the
 * request body. `complete: false` = need more bytes.
 */
export function parseReceivePackCommands(buf: Uint8Array): CommandParse {
  let off = 0;
  const commands: ReceivePackCommand[] = [];
  let caps: string[] = [];
  for (;;) {
    if (buf.length < off + 4) return { complete: false };
    const lenHex = dec.decode(buf.subarray(off, off + 4));
    if (!/^[0-9a-f]{4}$/.test(lenHex)) return { complete: true, ok: false, reason: "malformed pkt-line" };
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      off += 4;
      break;
    }
    if (len < 4) return { complete: true, ok: false, reason: "unexpected special pkt-line" };
    if (buf.length < off + len) return { complete: false };
    let line = dec.decode(buf.subarray(off + 4, off + len));
    off += len;
    if (line.endsWith("\n")) line = line.slice(0, -1);
    if (line.startsWith("shallow ")) continue;
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      if (commands.length === 0) caps = line.slice(nul + 1).split(" ").filter(Boolean);
      line = line.slice(0, nul);
    }
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/.exec(line);
    if (!m) return { complete: true, ok: false, reason: "malformed receive-pack command" };
    commands.push({ oldSha: m[1]!, newSha: m[2]!, ref: m[3]! });
    if (commands.length > 16) return { complete: true, ok: false, reason: "too many commands" };
  }
  return { complete: true, ok: true, commands, capabilities: caps, headerLength: off };
}

/** Requirement 2: exactly one update, to an allowed ref, with the job's lease; no atomic, no push options, no deletes. */
export function checkReceivePack(repo: GatewayRepo, parsed: { commands: ReceivePackCommand[]; capabilities: string[] }): { ok: true } | { ok: false; reason: string } {
  if (parsed.capabilities.includes("atomic")) return { ok: false, reason: "atomic pushes are refused" };
  if (parsed.capabilities.includes("push-options")) return { ok: false, reason: "push options are refused" };
  if (parsed.commands.length !== 1) return { ok: false, reason: `exactly one ref update per push (got ${parsed.commands.length})` };
  const c = parsed.commands[0]!;
  if (/^0+$/.test(c.newSha)) return { ok: false, reason: "ref deletion is refused" };
  const allowed = repo.pushes.find((p) => p.ref === c.ref);
  if (!allowed) return { ok: false, reason: `push to ${c.ref} is not allowed for this job` };
  const zero = /^0+$/.test(c.oldSha);
  if (allowed.lease === "absent" && !zero) return { ok: false, reason: `${c.ref} must not exist yet` };
  if (allowed.lease === "expected") {
    const want = allowed.expectedSha ?? null;
    if (want === null ? !zero : c.oldSha !== want) return { ok: false, reason: `${c.ref} lease mismatch` };
  }
  return { ok: true };
}

/**
 * Read the body until the receive-pack command section is complete, check it, and return a body
 * that replays the bytes already read followed by the rest of the stream (the pack).
 */
export async function guardReceivePack(body: ReadableStream<Uint8Array> | null, repo: GatewayRepo, maxHeader = 64 * 1024): Promise<{ ok: true; body: ReadableStream<Uint8Array> } | { ok: false; reason: string }> {
  if (!body) return { ok: false, reason: "empty push" };
  const reader = body.getReader();
  let head: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  for (;;) {
    const parsed = parseReceivePackCommands(head);
    if (parsed.complete) {
      if (!parsed.ok) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: parsed.reason };
      }
      const verdict = checkReceivePack(repo, parsed);
      if (!verdict.ok) {
        await reader.cancel().catch(() => undefined);
        return verdict;
      }
      break;
    }
    if (head.length > maxHeader) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "command section too large" };
    }
    const { value, done } = await reader.read();
    if (done) return { ok: false, reason: "truncated push" };
    const next = new Uint8Array(head.length + value.length);
    next.set(head);
    next.set(value, head.length);
    head = next;
  }
  const replay = head;
  let sentHead = false;
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sentHead) {
          sentHead = true;
          controller.enqueue(replay);
          return;
        }
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
  };
}

// --------------------------------------------------------------------------------- control plane

/** Runner → control-plane calls a container may make (the SignedJob in the body authenticates them). */
export function controlPathAllowed(method: string, pathname: string): boolean {
  if (method === "POST" && (pathname === "/api/runner/results" || pathname === "/api/runner/evidence-key" || pathname === "/api/runner/heads")) return true;
  if ((method === "GET" || method === "PUT") && pathname.startsWith("/api/runner/blobs/")) return true;
  return false;
}

/**
 * Network of a job's check/recipe commands. With working network namespaces, every job that can
 * write a repository, and every `integrate` job (an assets-only one writes nothing, follow-up
 * Task 23), runs them with no network at all, after the runner's own dependency install. Read-only
 * build jobs keep the gateway-limited network for their install steps.
 */
export function checkNetworkFor(job: IntegrationJob, netns: boolean): "none" | "inherit" {
  const writes = jobRepoAccess(job).some((a) => a.access === "write");
  return netns && (writes || job.kind === "integrate") ? "none" : "inherit";
}

// ------------------------------------------------------------------------------------ npm registry

export const NPM_HOST = "registry.npmjs.org";

export interface NpmGatewayProps {
  /** ms since epoch: the job's expiry; nothing passes afterwards */
  expiresAt: number;
  /**
   * Integrate jobs: the per-job registry key the runner's dependency install presents as its npm
   * auth token (`Authorization: Bearer <key>`, stripped before forwarding). Without it, nothing
   * passes. Build jobs (preview/release recipes) have none: their install steps read anonymously.
   */
  npmKey?: string;
}

/** Which registry requests may pass for this job: reads of the npm host only, before expiry, with the job's key when it has one. */
export function decideNpmRequest(props: NpmGatewayProps, method: string, url: URL, authorization: string | null, now: number): { ok: true } | { ok: false; reason: string } {
  if (now >= props.expiresAt) return { ok: false, reason: "job expired" };
  if (method !== "GET" && method !== "HEAD") return { ok: false, reason: "the registry is read-only for jobs" };
  if (url.hostname !== NPM_HOST) return { ok: false, reason: "host not allowed" };
  if (props.npmKey !== undefined) {
    const presented = /^Bearer (\S+)$/i.exec(authorization ?? "")?.[1] ?? null;
    if (!runnerKeyOk(props.npmKey, presented)) return { ok: false, reason: "only the runner's dependency install may use the registry for this job" };
  }
  return { ok: true };
}

// ----------------------------------------------------------------------------------- Cloudflare API

export interface CloudflareApiProps {
  jobId: string;
  expiresAt: number;
  accountId: string;
  workerNames: string[];
  /** every name must start with this (`<deployPrefix>-<orgId>-`; review C-1, defence in depth) */
  workerPrefix: string;
  /** the KV namespace ids this deploy may bind (from the signed job's target configs) */
  allowedKvIds: string[];
  /** the D1 database ids this deploy may bind (from the signed job's target configs; missing = none) */
  allowedD1Ids?: string[];
  /** the account deploy token (never enters the container) */
  token: string;
  /** what wrangler in the container sends instead */
  placeholder: string;
}

export type ApiDecision = { ok: true; inject: boolean } | { ok: false; reason: string };

/** Wrangler deploy calls a release-deploy job may make (only its own scripts on its own account). */
export function decideCloudflareApi(props: CloudflareApiProps, method: string, url: URL, authorization: string | null, now: number): ApiDecision {
  if (now >= props.expiresAt) return { ok: false, reason: "job expired" };
  if (url.hostname !== "api.cloudflare.com") return { ok: false, reason: "host not allowed" };
  const acct = `/client/v4/accounts/${props.accountId}`;
  const p = url.pathname;
  if (props.workerNames.some((n) => n.startsWith("commonforge") || !n.startsWith(props.workerPrefix) || n.length === props.workerPrefix.length)) return { ok: false, reason: "a target is outside the organization's Worker namespace" };
  const placeholder = authorization === `Bearer ${props.placeholder}`;
  // assets upload uses the upload-session JWT wrangler got from the scripts endpoint: pass it through
  if (method === "POST" && p === `${acct}/workers/assets/upload`) return authorization && !placeholder ? { ok: true, inject: false } : { ok: false, reason: "assets upload needs its session token" };
  if (!placeholder) return { ok: false, reason: "unexpected credential" };
  if (method === "GET" && (p === `${acct}/workers/subdomain` || p === acct || p === `${acct}/`)) return { ok: true, inject: true };
  // wrangler's credential check (whoami); reveals nothing beyond the token being valid
  if (method === "GET" && (p === "/client/v4/user/tokens/verify" || p === `${acct}/tokens/verify`)) return { ok: true, inject: true };
  for (const name of props.workerNames) {
    // review m-a: an explicit allowlist of what the pinned wrangler's data-only deploy needs
    const scripts = `${acct}/workers/scripts/${name}`;
    const rest = p === scripts ? "" : p.startsWith(`${scripts}/`) ? p.slice(scripts.length + 1) : null;
    if (rest !== null) {
      // never tail consumers, secret writes or settings changes (those could bind or expose anything);
      // wrangler reads the secret NAMES before a deploy (verified live), which reveals no value
      if (/^tails(\/|$)/.test(rest)) return { ok: false, reason: "tails are not part of a release deploy" };
      if (/^secrets(\/|$)/.test(rest) && method !== "GET") return { ok: false, reason: "secrets are not part of a release deploy" };
      if (method === "GET") return { ok: true, inject: true };
      const allowed: Array<[string, RegExp]> = [
        ["PUT", /^$/], // the script upload (metadata inspected by the gateway)
        ["PUT", /^content$/],
        ["POST", /^versions$/],
        ["POST", /^deployments$/],
        ["POST", /^assets-upload-session$/],
        ["POST", /^subdomain$/],
        ["PUT", /^schedules$/],
      ];
      if (allowed.some(([m, re]) => m === method && re.test(rest))) return { ok: true, inject: true };
      return { ok: false, reason: `${method} ${rest || "(script)"} is not part of a release deploy` };
    }
    for (const base of [`${acct}/workers/services/${name}`, `${acct}/workers/workers/${name}`]) {
      if ((p === base || p.startsWith(`${base}/`)) && method === "GET") return { ok: true, inject: true };
    }
  }
  return { ok: false, reason: `path not allowed for this release: ${method} ${p}` };
}

/** Binding types a release upload may carry (review C-1): plain vars, the job's own KV and its own D1 databases only. */
const ALLOWED_BINDING_TYPES = new Set(["plain_text", "kv_namespace", "d1"]);

function jsonProblem(value: unknown, allowedKvIds: readonly string[], allowedD1Ids: readonly string[]): string | null {
  if (Array.isArray(value)) {
    for (const v of value) {
      const p = jsonProblem(v, allowedKvIds, allowedD1Ids);
      if (p) return p;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (Array.isArray(o.tail_consumers) && o.tail_consumers.length > 0) return "tail consumers are not allowed for release targets";
  if (o.logpush === true) return "logpush is not allowed for release targets";
  if (Array.isArray(o.bindings)) {
    for (const b of o.bindings as Array<{ type?: unknown; namespace_id?: unknown; id?: unknown }>) {
      if (typeof b?.type !== "string" || !ALLOWED_BINDING_TYPES.has(b.type)) return `binding type ${String(b?.type)} is not allowed for release targets`;
      if (b.type === "kv_namespace" && !allowedKvIds.includes(String(b.namespace_id))) return `KV namespace ${String(b.namespace_id)} is not one this release may bind`;
      if (b.type === "d1" && !allowedD1Ids.includes(String(b.id))) return `D1 database ${String(b.id)} is not one this release may bind`;
    }
  }
  for (const k of ["metadata", "settings", "script", "result"]) {
    if (o[k] && typeof o[k] === "object") {
      const p = jsonProblem(o[k], allowedKvIds, allowedD1Ids);
      if (p) return p;
    }
  }
  return null;
}

function tryJson(text: string): unknown {
  const t = text.trimStart();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Multipart parts the Cloudflare API reads configuration from (inspected whatever their size). */
const CONFIG_PARTS = new Set(["metadata", "settings"]);
/** Other parts up to this size are JSON-checked whatever their type. */
const INSPECT_PART_BYTES = 1024 * 1024;
/** Larger parts must be one of the module types wrangler uploads (code, wasm, source maps, data). */
const MODULE_PART_TYPE = /^(application\/(javascript|javascript\+module|wasm|source-map|octet-stream)|text\/(javascript|plain))\s*(;|$)/i;

/**
 * Check a Cloudflare API request body (review C-1, m-a): every multipart part and any JSON body
 * (whatever its declared type) may carry only plain vars, the job's own KV namespaces and D1 databases, no tail
 * consumers, no logpush. Content types are matched case-insensitively; a non-empty body of any
 * other type than multipart or JSON is refused. Returns a refusal reason, or null.
 */
export async function uploadBindingsProblem(contentType: string, body: ArrayBuffer, allowedKvIds: readonly string[], allowedD1Ids: readonly string[] = []): Promise<string | null> {
  if (body.byteLength === 0) return null;
  const ct = contentType.toLowerCase();
  if (ct.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await new Request("https://x.invalid/", { method: "POST", headers: { "content-type": contentType }, body }).formData();
    } catch {
      return "unreadable multipart body";
    }
    for (const [name, part] of form.entries()) {
      // follow-up n-3: the config parts are inspected at ANY size (a padded `metadata` part with a
      // filename must not slip past); any other large part must be a module, never unchecked data
      const config = CONFIG_PARTS.has(name.toLowerCase());
      let text: string;
      if (typeof part === "string") text = part;
      else if (config || part.size <= INSPECT_PART_BYTES || /json/i.test(part.type)) text = await part.text();
      else if (MODULE_PART_TYPE.test(part.type)) continue;
      else return `multipart part ${name} (${part.size} bytes, type ${part.type || "none"}) is too large to inspect and is not a module`;
      const v = tryJson(text);
      if (v === undefined && config && text.trim() !== "") return `multipart part ${name} is not JSON`;
      if (v !== undefined) {
        const p = jsonProblem(v, allowedKvIds, allowedD1Ids);
        if (p) return p;
      }
    }
    return null;
  }
  const text = new TextDecoder().decode(body);
  const v = tryJson(text);
  if (v !== undefined) return jsonProblem(v, allowedKvIds, allowedD1Ids);
  if (ct.includes("json")) return "unreadable JSON body";
  return `content type ${ct || "(none)"} is not accepted for release deploy calls`;
}
