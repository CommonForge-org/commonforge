#!/usr/bin/env node
/**
 * `commonforge-runner` CLI.
 *
 *   commonforge-runner run [<delivery.json> | -]   execute one job delivered as a file or on stdin
 *   commonforge-runner poll                        ask the Worker for jobs and execute them, forever
 *
 * Input is a `RunnerJobDelivery` (`{signedJob, evidenceKey?}`) or a bare `SignedJob`. The result
 * (redacted) is printed as JSON on stdout and posted to `<worker>/api/runner/results` unless
 * `--no-post`. Exit code: 0 ok, 1 job failed, 2 usage/configuration error.
 *
 * Options (flag or environment variable):
 *   --worker-url URL        COMMONFORGE_WORKER_URL        the trusted Worker: jobs whose credentialBroker has
 *                                                         another origin are refused; results, blobs, keys and
 *                                                         heads go only here (required in broker mode)
 *   --work-dir DIR          COMMONFORGE_RUNNER_WORK_DIR   default: <tmp>/commonforge-runner
 *   --journal-dir DIR       COMMONFORGE_RUNNER_JOURNAL_DIR  results by jobId (dedupe across restarts)
 *   --credentials MODE      COMMONFORGE_RUNNER_CREDENTIALS  broker (default) | egress (Sandbox)
 *   --ca-file FILE          COMMONFORGE_RUNNER_CA         CA bundle for egress interception
 *   --egress-key-file FILE  COMMONFORGE_RUNNER_EGRESS_KEY_FILE  per-job key the Sandbox gateways require (egress mode)
 *   --auth-file FILE        COMMONFORGE_RUNNER_AUTH_FILE  bearer for Worker calls (read from a file,
 *                                                         never from the environment: check commands
 *                                                         could read the runner's /proc environ)
 *   --keyring-file FILE     COMMONFORGE_RUNNER_KEYRING_FILE  [{kid,secret}] to verify job signatures
 *                                                         (trusted dev runners only)
 *   --blobs worker|DIR      COMMONFORGE_RUNNER_BLOBS      object store (default worker)
 *   --preview-base-url URL  COMMONFORGE_PREVIEW_BASE_URL
 *   (env only)              COMMONFORGE_RUNNER_CHECK_ENV  JSON object of extra NON-secret environment for check and
 *                                                         recipe commands (e.g. the Sandbox's plain-HTTP registry
 *                                                         behind the egress gateway); secret-looking values are refused
 *   --wrangler PATH         COMMONFORGE_RUNNER_WRANGLER   the runner's pinned wrangler (enables release-deploy;
 *                                                         broker mode fetches the account token per job,
 *                                                         egress mode leaves it to the gateway)
 *   --runner-id ID          COMMONFORGE_RUNNER_ID         default node-runner
 *   --runner-kind KIND      COMMONFORGE_RUNNER_KIND       node-runner (default) | sandbox
 *   --check-uid UID         COMMONFORGE_RUNNER_CHECK_UID  run check commands as this uid (runner is root);
 *                                                         required for any job with checks/recipes unless
 *   --unsafe-same-uid-checks                              (trusted content only: checks run as the runner)
 *   --check-network MODE    COMMONFORGE_RUNNER_CHECK_NETWORK  inherit (default) | none | auto: checks in a
 *                                                         network namespace without routes (root + CAP_SYS_ADMIN)
 *   --checks-dir DIR        COMMONFORGE_RUNNER_CHECKS_DIR  check checkouts (default <work-dir>-checks)
 *   --npm-key-file FILE     COMMONFORGE_RUNNER_NPM_KEY_FILE  per-job registry key the Sandbox npm gateway requires
 *                                                         for the integrate dependency install (install.ts)
 *   --install-store DIR     COMMONFORGE_RUNNER_INSTALL_STORE  pnpm store for those installs (default: per job)
 *   --no-install-deps                                     skip the dependency install before integrate checks
 *   --allow-file-remotes                                  allow file:// repositories (local dev/tests only)
 *   --check-gid GID         COMMONFORGE_RUNNER_CHECK_GID  default: the check uid
 *   --ledger-heads                                        ask the Worker for ledger heads (stale checks)
 *   --allow-http                                          allow http:// git remotes (dev)
 *   --no-post                                             print only
 *   --poll-interval MS                                    idle delay between polls (default 2000)
 */
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { containsSecret, redact, type JobSigningKey, type RunnerResult, type SignedJob } from '@commonforge-org/runner-protocol';
import { RunnerKindSchema } from '@commonforge-org/core';
import { fsBlobStore, workerBlobStore } from './blob-store.js';
import { brokerCredentials, egressCredentials } from './credentials.js';
import { createRunner, type Runner, type RunnerOptions } from './runner.js';
import { probeNetworkIsolation } from './commands.js';
import { assertSeparateCheckUid } from './procs.js';
import { createWorkerClient, type WorkerClient } from './worker-client.js';

export interface CliIo {
  stdin: () => Promise<string>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set(['--no-post', '--ledger-heads', '--allow-http', '--allow-file-remotes', '--unsafe-same-uid-checks', '--no-install-deps']);

function parseArgs(argv: readonly string[]): Parsed {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags.set(a.slice(0, eq), a.slice(eq + 1));
      else if (BOOLEAN_FLAGS.has(a)) flags.set(a, true);
      else flags.set(a, rest[++i] ?? '');
    } else positional.push(a);
  }
  return { command, positional, flags };
}

class UsageError extends Error {}

/** What wrangler sends in egress mode; the gateway swaps it for the account token (release-deploy only). */
export const EGRESS_PLACEHOLDER_TOKEN = 'commonforge-egress-injected-deploy-token';

export async function buildRunner(p: Parsed, io: CliIo): Promise<{ runner: Runner; client: WorkerClient; post: boolean; pollMs: number; workerUrl?: string; secrets: string[] }> {
  const opt = (flag: string, env: string): string | undefined => {
    const f = p.flags.get(flag);
    return typeof f === 'string' && f !== '' ? f : io.env[env] || undefined;
  };
  const doFetch = io.fetch ?? fetch;
  const workerUrl = opt('--worker-url', 'COMMONFORGE_WORKER_URL');
  const authFile = opt('--auth-file', 'COMMONFORGE_RUNNER_AUTH_FILE');
  const secrets: string[] = [];
  const headers: Record<string, string> = {};
  if (authFile) {
    const bearer = (await readFile(authFile, 'utf8')).trim();
    if (!bearer) throw new UsageError(`empty auth file ${authFile}`);
    headers.authorization = `Bearer ${bearer}`;
    secrets.push(bearer);
  }
  const mode = opt('--credentials', 'COMMONFORGE_RUNNER_CREDENTIALS') ?? 'broker';
  const log = (line: string) => io.stderr(`${redact(line, ...secrets)}\n`);
  // Check commands running as the runner's uid can read its initial environment (/proc/<pid>/environ).
  const suspicious = Object.entries(io.env)
    .filter(([k, v]) => typeof v === 'string' && v !== '' && (containsSecret(v) || /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)$/i.test(k)))
    .map(([k]) => k);
  if (suspicious.length > 0) {
    log(`warning: the runner environment holds secret-looking values (${suspicious.join(', ')}); start it with a clean environment or run checks as another uid`);
  }
  const post = !p.flags.has('--no-post');
  const blobs = opt('--blobs', 'COMMONFORGE_RUNNER_BLOBS') ?? 'worker';
  // Review I-2: every destination comes from configuration, never from a (possibly unverified) job.
  if (!workerUrl) {
    if (mode === 'broker') throw new UsageError('broker mode needs --worker-url (the only origin credentials are requested from)');
    if (post) throw new UsageError('posting results needs --worker-url (or pass --no-post)');
    if (blobs === 'worker') throw new UsageError('the worker object store needs --worker-url (or --blobs DIR)');
  }
  let credentials;
  if (mode === 'broker') credentials = brokerCredentials({ fetch: doFetch, headers, log, brokerForLocalGit: true });
  else if (mode === 'egress') {
    const ca = opt('--ca-file', 'COMMONFORGE_RUNNER_CA');
    // Task 22 review I-3: a per-job key (root-only file) that the egress gateways require from the
    // runner's own git and Worker requests; check commands never see it
    const keyFile = opt('--egress-key-file', 'COMMONFORGE_RUNNER_EGRESS_KEY_FILE');
    let runnerKey: string | undefined;
    if (keyFile) {
      runnerKey = (await readFile(keyFile, 'utf8')).trim();
      if (!/^[0-9a-f]{32,128}$/.test(runnerKey)) throw new UsageError(`malformed egress key file ${keyFile}`);
      headers['x-commonforge-runner-key'] = runnerKey;
      secrets.push(runnerKey);
    }
    credentials = egressCredentials({ ...(ca ? { caInfo: ca } : {}), ...(runnerKey ? { runnerKey } : {}) });
  } else throw new UsageError(`unknown credentials mode ${mode}`);

  let jobKeyring: JobSigningKey[] | undefined;
  const keyringFile = opt('--keyring-file', 'COMMONFORGE_RUNNER_KEYRING_FILE');
  if (keyringFile) {
    jobKeyring = JSON.parse(await readFile(keyringFile, 'utf8')) as JobSigningKey[];
    for (const k of jobKeyring) secrets.push(String(k.secret));
  }
  const client = createWorkerClient({ workerUrl: workerUrl ?? 'http://worker.invalid', headers, fetch: doFetch });
  const kind = RunnerKindSchema.safeParse(opt('--runner-kind', 'COMMONFORGE_RUNNER_KIND') ?? 'node-runner');
  if (!kind.success) throw new UsageError('invalid --runner-kind');
  const options: RunnerOptions = {
    workDir: resolve(opt('--work-dir', 'COMMONFORGE_RUNNER_WORK_DIR') ?? join(tmpdir(), 'commonforge-runner')),
    credentials,
    blobStore: blobs === 'worker' ? workerBlobStore({ workerUrl: workerUrl!, headers, fetch: doFetch }) : fsBlobStore(resolve(blobs)),
    ...(workerUrl ? { trustedWorkerOrigin: new URL(workerUrl).origin, evidenceKey: (sj: SignedJob) => client.evidenceKey(sj) } : {}),
    runnerId: opt('--runner-id', 'COMMONFORGE_RUNNER_ID') ?? 'node-runner',
    runnerKind: kind.data,
    secrets,
    log,
    ...(jobKeyring ? { jobKeyring } : {}),
    ...(p.flags.has('--ledger-heads') ? { currentHeads: (sj) => client.heads(sj) } : {}),
    git: { allowHttp: p.flags.has('--allow-http'), allowFile: p.flags.has('--allow-file-remotes') },
  };
  const checksDir = opt('--checks-dir', 'COMMONFORGE_RUNNER_CHECKS_DIR');
  if (checksDir) options.checksDir = resolve(checksDir);
  const checkUid = opt('--check-uid', 'COMMONFORGE_RUNNER_CHECK_UID');
  if (checkUid) {
    const uid = Number(checkUid);
    const gid = Number(opt('--check-gid', 'COMMONFORGE_RUNNER_CHECK_GID') ?? checkUid);
    try {
      assertSeparateCheckUid(uid, gid);
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    options.commands = { ...options.commands, uid, gid };
  }
  if (p.flags.has('--unsafe-same-uid-checks')) {
    if (options.commands?.uid !== undefined) throw new UsageError('--unsafe-same-uid-checks contradicts --check-uid');
    log('warning: --unsafe-same-uid-checks: candidate commands run as the runner; use only for trusted content');
    options.commands = { ...options.commands, unsafeSameUid: true };
  }
  const network = opt('--check-network', 'COMMONFORGE_RUNNER_CHECK_NETWORK') ?? 'inherit';
  if (network !== 'inherit' && network !== 'none' && network !== 'auto') throw new UsageError('--check-network must be inherit, none or auto');
  if (network !== 'inherit') {
    if (options.commands?.uid === undefined) throw new UsageError('--check-network needs --check-uid');
    const ok = await probeNetworkIsolation();
    if (!ok && network === 'none') throw new UsageError('--check-network none: unshare --net is not permitted here (needs root with CAP_SYS_ADMIN)');
    if (!ok) log('warning: network namespaces unavailable; checks share the runner network (the egress gateway must enforce the job scope)');
    if (ok) options.commands = { ...options.commands, network: 'none' };
  }
  const journal = opt('--journal-dir', 'COMMONFORGE_RUNNER_JOURNAL_DIR');
  if (journal) options.journalDir = resolve(journal);
  const preview = opt('--preview-base-url', 'COMMONFORGE_PREVIEW_BASE_URL');
  if (preview) options.previewBaseUrl = preview;
  const wrangler = opt('--wrangler', 'COMMONFORGE_RUNNER_WRANGLER');
  if (wrangler) {
    if (mode === 'egress') {
      // the egress gateway replaces the Authorization header for release-deploy jobs only
      const ca = opt('--ca-file', 'COMMONFORGE_RUNNER_CA');
      options.deploy = {
        wrangler: [wrangler],
        credentialEnv: async () => ({ CLOUDFLARE_API_TOKEN: EGRESS_PLACEHOLDER_TOKEN }),
        ...(ca ? { env: { NODE_EXTRA_CA_CERTS: ca } } : {}),
      };
    } else {
      if (!workerUrl) throw new UsageError('--wrangler in broker mode needs --worker-url (the deploy credential comes from the Worker)');
      options.deploy = { wrangler: [wrangler], credentialEnv: async (sj) => ({ CLOUDFLARE_API_TOKEN: await client.deployCredential(sj) }) };
    }
  }
  const checkEnvRaw = io.env.COMMONFORGE_RUNNER_CHECK_ENV;
  if (checkEnvRaw) {
    let extra: unknown;
    try {
      extra = JSON.parse(checkEnvRaw);
    } catch {
      throw new UsageError('COMMONFORGE_RUNNER_CHECK_ENV must be a JSON object');
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra) || Object.entries(extra).some(([k, v]) => typeof v !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k))) {
      throw new UsageError('COMMONFORGE_RUNNER_CHECK_ENV must map variable names to strings');
    }
    if (containsSecret(checkEnvRaw)) throw new UsageError('COMMONFORGE_RUNNER_CHECK_ENV must not hold secrets');
    options.commands = { ...options.commands, extraEnv: { ...(options.commands?.extraEnv ?? {}), ...(extra as Record<string, string>) } };
  }
  // the runner-controlled dependency install before integrate checks (install.ts)
  if (p.flags.has('--no-install-deps')) options.commands = { ...options.commands, install: { enabled: false } };
  const store = opt('--install-store', 'COMMONFORGE_RUNNER_INSTALL_STORE');
  if (store) options.commands = { ...options.commands, install: { ...options.commands?.install, storeDir: resolve(store) } };
  const npmKeyFile = opt('--npm-key-file', 'COMMONFORGE_RUNNER_NPM_KEY_FILE');
  if (npmKeyFile) {
    const token = (await readFile(npmKeyFile, 'utf8')).trim();
    if (!/^[0-9a-f]{32,128}$/.test(token)) throw new UsageError(`malformed npm key file ${npmKeyFile}`);
    const registry = options.commands?.extraEnv?.PNPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org/';
    try {
      new URL(registry);
    } catch {
      throw new UsageError(`PNPM_CONFIG_REGISTRY ${registry} is not a URL`);
    }
    secrets.push(token);
    options.commands = { ...options.commands, install: { ...options.commands?.install, registryAuth: { registry, token } } };
  }
  const pollMs = Number(p.flags.get('--poll-interval') ?? 2000);
  return { runner: createRunner(options), client, post, pollMs, ...(workerUrl ? { workerUrl } : {}), secrets };
}

async function runOne(runner: Runner, client: WorkerClient, delivery: unknown, post: boolean, io: CliIo, secrets: string[]): Promise<RunnerResult> {
  const result = await runner.execute(delivery);
  const signedJob = runner.lastVerified.get(result.jobId);
  if (post && signedJob) {
    try {
      await client.postResult(signedJob, result);
    } catch (e) {
      io.stderr(`${redact(String((e as Error).message), ...secrets)}\n`);
    }
  }
  return result;
}

/** CLI entry; returns the exit code. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const p = parseArgs(argv);
  try {
    if (p.command === 'run') {
      const { runner, client, post, secrets } = await buildRunner(p, io);
      const src = p.positional[0] ?? '-';
      const text = src === '-' ? await io.stdin() : await readFile(src, 'utf8');
      let delivery: unknown;
      try {
        delivery = JSON.parse(text);
      } catch {
        throw new UsageError('input is not JSON');
      }
      const result = await runOne(runner, client, delivery, post, io, secrets);
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
    if (p.command === 'poll') {
      const { runner, client, post, pollMs, workerUrl, secrets } = await buildRunner(p, io);
      if (!workerUrl) throw new UsageError('poll needs --worker-url');
      const runnerId = typeof p.flags.get('--runner-id') === 'string' ? (p.flags.get('--runner-id') as string) : 'node-runner';
      for (;;) {
        let delivery: unknown = null;
        try {
          delivery = await client.nextJob(runnerId);
        } catch (e) {
          io.stderr(`${redact((e as Error).message, ...secrets)}\n`);
        }
        if (delivery === null) {
          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }
        const result = await runOne(runner, client, delivery, post, io, secrets);
        io.stdout(`${JSON.stringify({ jobId: result.jobId, ok: result.ok, ...(result.ok ? {} : { code: result.code }) })}\n`);
      }
    }
    io.stderr('usage: commonforge-runner run [<delivery.json>|-] | poll   (see src/main.ts for options)\n');
    return p.command === 'help' || p.command === '--help' ? 0 : 2;
  } catch (e) {
    io.stderr(`${e instanceof UsageError ? 'usage error' : 'error'}: ${(e as Error).message}\n`);
    return 2;
  }
}

function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    // resolve symlinks: the package bin (`commonforge-runner`) is a link to dist/main.js
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
const isEntry = isMainModule();
if (isEntry) {
  const readStdin = async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  main(process.argv.slice(2), {
    stdin: readStdin,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`fatal: ${String(e)}\n`);
      process.exitCode = 2;
    },
  );
}
