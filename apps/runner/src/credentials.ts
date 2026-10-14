/**
 * Short-lived repository credentials for one job.
 *
 * Rules (plan §F "Token leakage", §0.3 A3/A4):
 * - tokens come from the job's `credentialBroker`, presenting the signed job; they live only in
 *   this process's memory for the duration of the job, are never written to disk, argv or git
 *   config, and every token is revoked when the job ends (`close`);
 * - git receives a token only through the environment of the one git process that needs it:
 *   `http.<remoteUrl>.extraHeader` via `GIT_CONFIG_COUNT/KEY/VALUE` (scoped to that exact URL), or
 *   `COMMONFORGE_TOKEN` for a `local-git` repository (the LocalGitProvider push guard);
 * - a token is re-acquired when less than `minRemainingSeconds` of its TTL is left, so a push
 *   never starts on a token that may expire mid-upload (A4: expiry mid-push fails the push);
 * - every token is registered with the job's redactor before it is used.
 *
 * In Sandbox egress mode the container never sees a token: the Worker's outbound interceptor adds
 * the header, so {@link egressCredentials} only sets the CA bundle.
 */
import { RunnerCredentialResponseSchema, type SignedJob } from '@commonforge-org/runner-protocol';
import { RunnerFailureCodeSchema, type RepoCoords, type RunnerFailureCode } from '@commonforge-org/core';
import { JobFailure } from './errors.js';

export type Access = 'read' | 'write';

export interface CredentialSession {
  /** git environment granting `access` to `repo` (empty when no credential is needed) */
  gitEnv(repo: RepoCoords, access: Access): Promise<Record<string, string>>;
  /** every secret handed out so far (for redaction) */
  secrets(): string[];
  /** revoke everything issued in this session (idempotent, never throws) */
  close(): Promise<void>;
}

export interface CredentialSource {
  /** `broker`: tokens (and the runner's headers) go to the job's credentialBroker */
  readonly kind?: 'broker' | 'egress' | 'static';
  open(signedJob: SignedJob): CredentialSession;
}

/** Git environment carrying `token` for `repo` without putting it in argv or a config file. */
export function tokenGitEnv(repo: RepoCoords, token: string): Record<string, string> {
  if (repo.kind === 'local-git' && repo.remoteUrl.startsWith('file:')) return { COMMONFORGE_TOKEN: token };
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${repo.remoteUrl}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
  };
}

export interface BrokerCredentialOptions {
  fetch?: typeof fetch;
  /** extra headers on broker calls (e.g. a runner authentication bearer); treated as secrets */
  headers?: Record<string, string>;
  /** re-acquire a token with less TTL than this left (default 120 s) */
  minRemainingSeconds?: number;
  now?: () => number;
  /** `local-git` repositories: ask the broker too (default false: they need no token) */
  brokerForLocalGit?: boolean;
  log?: (msg: string) => void;
}

interface Held {
  token: string;
  tokenId: string;
  expiresAt: number;
}

async function readFailure(res: Response): Promise<{ code: RunnerFailureCode; detail: string }> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not json */
  }
  const b = (body ?? {}) as { code?: unknown; detail?: unknown; error?: unknown };
  const parsed = RunnerFailureCodeSchema.safeParse(b.code);
  const code: RunnerFailureCode = parsed.success ? parsed.data : res.status === 401 || res.status === 403 ? 'scope_violation' : res.status === 410 ? 'job_expired' : 'provider_unavailable';
  const detail = typeof b.detail === 'string' ? b.detail : typeof b.error === 'string' ? b.error : `HTTP ${res.status}`;
  return { code, detail };
}

/** Credentials from the job's credential broker (`POST <credentialBroker>`; revoke at `<credentialBroker>/revoke`). */
export function brokerCredentials(options: BrokerCredentialOptions = {}): CredentialSource {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const minRemainingMs = (options.minRemainingSeconds ?? 120) * 1000;
  return {
    kind: 'broker',
    open(signedJob) {
      const held = new Map<string, Held>();
      const all: Held[] = [];
      const brokerUrl = signedJob.credentialBroker;
      const headers = { 'content-type': 'application/json', ...options.headers };
      let closed = false;

      const acquire = async (repo: RepoCoords, access: Access): Promise<Held> => {
        let res: Response;
        try {
          res = await doFetch(brokerUrl, { method: 'POST', headers, body: JSON.stringify({ signedJob, repo, access }) });
        } catch (e) {
          throw new JobFailure('provider_unavailable', `credential broker unreachable: ${(e as Error).message}`);
        }
        if (!res.ok) {
          const f = await readFailure(res);
          throw new JobFailure(f.code, `credential broker refused ${access} on ${repo.namespace}/${repo.repoName}: ${f.detail}`);
        }
        const parsed = RunnerCredentialResponseSchema.safeParse(await res.json().catch(() => null));
        if (!parsed.success) throw new JobFailure('provider_unavailable', 'credential broker returned a malformed response');
        const cred = parsed.data;
        const h: Held = { token: cred.token, tokenId: cred.tokenId, expiresAt: Date.parse(cred.expiresAt) };
        all.push(h);
        if (cred.remoteUrl !== repo.remoteUrl) {
          throw new JobFailure('scope_violation', `credential broker returned a different remote for ${repo.namespace}/${repo.repoName}`);
        }
        if (h.expiresAt - now() < minRemainingMs) {
          throw new JobFailure('job_expired', `credential for ${repo.namespace}/${repo.repoName} expires too soon (${cred.expiresAt})`);
        }
        return h;
      };

      return {
        async gitEnv(repo, access) {
          if (closed) throw new JobFailure('provider_unavailable', 'credential session closed');
          if (repo.kind === 'local-git' && repo.remoteUrl.startsWith('file:') && !options.brokerForLocalGit) return {};
          const base = `${repo.kind}|${repo.namespace}|${repo.repoId}|${repo.remoteUrl}`;
          const key = `${base}|${access}`;
          // a write token also reads: never mint a second token for the same repository
          let h = held.get(key) ?? (access === 'read' ? held.get(`${base}|write`) : undefined);
          if (!h || h.expiresAt - now() < minRemainingMs) {
            h = await acquire(repo, access);
            held.set(key, h);
          }
          return tokenGitEnv(repo, h.token);
        },
        secrets() {
          return [...all.map((h) => h.token), ...Object.values(options.headers ?? {})];
        },
        async close() {
          if (closed) return;
          closed = true;
          const revokeUrl = `${brokerUrl.replace(/\/+$/, '')}/revoke`;
          await Promise.all(
            all.map(async (h) => {
              try {
                const r = await doFetch(revokeUrl, { method: 'POST', headers, body: JSON.stringify({ signedJob, tokenId: h.tokenId }) });
                if (!r.ok) options.log?.(`token revoke returned HTTP ${r.status} (TTL bounds it)`);
              } catch (e) {
                options.log?.(`token revoke failed: ${(e as Error).message} (TTL bounds it)`);
              }
            }),
          );
        },
      };
    },
  };
}

/**
 * Sandbox egress mode: no token ever enters the container; the Worker adds the header on egress.
 * Only the interceptor's CA bundle is configured.
 */
export function egressCredentials(options: { caInfo?: string; runnerKey?: string } = {}): CredentialSource {
  const env: Record<string, string> = options.caInfo ? { GIT_SSL_CAINFO: options.caInfo } : {};
  // Task 22 review I-3: the gateway serves the job's repositories only to requests carrying the
  // per-job runner key. It reaches git only through the environment of the one git process (never
  // argv, a config file, or a check command's environment).
  if (options.runnerKey) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `x-commonforge-runner-key: ${options.runnerKey}` });
  const secrets = options.runnerKey ? [options.runnerKey] : [];
  return {
    open: () => ({ gitEnv: async () => ({ ...env }), secrets: () => secrets, close: async () => undefined }),
  };
}

/**
 * Fixed per-repository environments (dev, tests, the conformance adapter). `envFor` returns the
 * git environment for a repository and access; values are registered as secrets.
 */
export function staticCredentials(envFor: (repo: RepoCoords, access: Access) => Record<string, string>): CredentialSource {
  return {
    open() {
      const seen = new Set<string>();
      return {
        async gitEnv(repo, access) {
          const env = envFor(repo, access);
          for (const [k, v] of Object.entries(env)) if (/TOKEN|VALUE_\d+$/.test(k) && v) seen.add(v.replace(/^Authorization: Bearer /, ''));
          return env;
        },
        secrets: () => [...seen],
        close: async () => undefined,
      };
    },
  };
}
