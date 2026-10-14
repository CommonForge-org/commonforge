/**
 * Per-job execution context handed to every job handler.
 */
import { randomBytes } from 'node:crypto';
import { chmod, chown, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  containsSecret,
  jobAllowedPushRefs,
  redact,
  sameRepoIdentity,
  signEvidence,
  type EvidenceSigningKey,
  type IntegrationJobKind,
  type JobOfKind,
  type SignedJob,
  type UnsignedValidationEvidence,
} from '@commonforge-org/runner-protocol';
import { formatRevisionId, type RepoCoords, type RevisionId, type RunnerKind, type ValidationEvidence } from '@commonforge-org/core';
import type { BlobStore, BlobStoreFactory } from './blob-store.js';
import { checkEnvironment, DEFAULT_COMMAND_ALLOWLIST, parseAllowedCommand, runIsolated, type CommandPattern, type IsolatedRunResult } from './commands.js';
import type { CredentialSession } from './credentials.js';
import { JobFailure } from './errors.js';
import { KeyedMutex, pushWithLease, type Git, type PushOutcome } from './git.js';
import { assertSeparateCheckUid, CHECK_MARKER_VAR, reapCheckProcesses, type ProcessOps } from './procs.js';

export interface CommandSettings {
  /** allowlisted command shapes (default {@link DEFAULT_COMMAND_ALLOWLIST}) */
  allowlist?: readonly CommandPattern[];
  /** PATH for check commands (default: the runner's PATH) */
  path?: string;
  /** extra non-secret environment for check commands (refused if anything looks like a secret) */
  extraEnv?: Record<string, string>;
  maxOutputBytes?: number;
  /**
   * Run check commands as this uid/gid (the runner must be root). REQUIRED unless
   * `unsafeSameUid`: a same-uid child could read the runner's environment and memory-adjacent
   * state via /proc, tamper with the repositories the runner later pushes from, and leave
   * processes running while token-bearing git runs. The checkout, HOME and TMPDIR are chowned to it.
   */
  uid?: number;
  gid?: number;
  /**
   * Explicit opt-in to run checks as the runner's own uid (tests, a developer's own trusted
   * content). Never for untrusted candidates.
   */
  unsafeSameUid?: boolean;
  /** `none`: checks get no network (needs root + CAP_SYS_ADMIN); `inherit`: same network as the runner */
  network?: 'inherit' | 'none';
  /** the runner-controlled dependency install before integrate checks (see `install.ts`) */
  install?: InstallSettings;
}

export interface InstallSettings {
  /**
   * Per-job registry credential the egress gateway requires for installs (Sandbox: a random key
   * only this job's install may present; it unlocks anonymous registry reads and nothing else).
   * Written to the install's own npmrc for `registry`, removed when the install ends.
   */
  registryAuth?: { registry: string; token: string };
  /** pnpm store (default: a fresh per-job directory under the checks root) */
  storeDir?: string;
  /** release-age policy, passed on the install's command line (default {@link DEFAULT_INSTALL_POLICY}) */
  policy?: { minimumReleaseAge: number; minimumReleaseAgeExclude: readonly string[] };
  /** per-mount install timeout (default 10 min, never past the job's expiry) */
  timeoutMs?: number;
  /** `false` disables the install step (checks then see the checkout as committed) */
  enabled?: boolean;
}

/**
 * The pnpm policy installs run under, passed on the command line so the candidate's own
 * pnpm-workspace.yaml cannot relax it (review m-1): pnpm's default one-day minimumReleaseAge, with
 * the monorepo's `minimumReleaseAgeExclude` (fixtures/README.md "Runner install policy"). Lifecycle
 * scripts never run (`--ignore-scripts`): pnpm 12 honours `allowBuilds` only from the project's own
 * (candidate-controlled) pnpm-workspace.yaml, so the runner runs none at all, which is within the
 * fixtures' allowBuilds set (esbuild, workerd), and the fixtures' checks do not need those postinstalls.
 */
export const DEFAULT_INSTALL_POLICY: { minimumReleaseAge: number; minimumReleaseAgeExclude: readonly string[] } = {
  minimumReleaseAge: 1440,
  minimumReleaseAgeExclude: ['@cloudflare/workers-types@5.20261006.1', '@vitejs/plugin-react@6.1.2'],
};

export interface DeploySettings {
  /** argv prefix of the runner's own pinned wrangler (never a candidate's `node_modules/.bin`) */
  wrangler: readonly string[];
  /**
   * Environment carrying the account credential for ONE wrangler process. Broker mode: the token
   * from the Worker's `/api/runner/deploy-credential`; egress mode: a placeholder (the gateway
   * replaces the header, so the container never holds the token).
   */
  credentialEnv(signedJob: SignedJob): Promise<Record<string, string>>;
  /** extra non-secret environment for wrangler (e.g. NODE_EXTRA_CA_CERTS in egress mode) */
  env?: Record<string, string>;
  /** waits before each retry of a deploy the Cloudflare API answered with a 5xx (default 5 s, 20 s) */
  retryDelaysMs?: readonly number[];
}

export interface ContextServices {
  git: Git;
  pushMutex: KeyedMutex;
  runnerId: string;
  runnerKind: RunnerKind;
  blobStore?: BlobStoreFactory;
  currentHeads?: (signedJob: SignedJob) => Promise<Record<string, RevisionId | null> | null>;
  commands: CommandSettings;
  /** root for check checkouts/HOME/TMPDIR, separate from job dirs that hold push repositories */
  checksRoot: string;
  procs: ProcessOps;
  push: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> };
  previewBaseUrl?: string;
  /** release-deploy: the pinned wrangler and how the account credential reaches it */
  deploy?: DeploySettings;
  canaries: readonly string[];
  now: () => Date;
  log: (line: string) => void;
}

export interface CommandRun extends IsolatedRunResult {
  argv: string[];
}

export class JobContext<K extends IntegrationJobKind = IntegrationJobKind> {
  readonly job: JobOfKind<K>;
  readonly jobId: string;
  #seq = 0;
  #heads: Promise<Record<string, RevisionId | null> | null> | undefined;
  #checksDir: string | undefined;
  #markers: string[] = [];
  #checkSeq = 0;

  constructor(
    readonly signedJob: SignedJob,
    readonly jobDir: string,
    readonly credentials: CredentialSession,
    readonly services: ContextServices,
    readonly evidenceKey: EvidenceSigningKey | null,
    readonly extraSecrets: readonly string[],
  ) {
    this.job = signedJob.job as JobOfKind<K>;
    this.jobId = signedJob.jobId;
  }

  get git(): Git {
    return this.services.git;
  }

  now(): Date {
    return this.services.now();
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  /** Deterministic timestamp for commits the runner creates (stable across retries of one job). */
  commitDate(): string {
    return this.signedJob.issuedAt;
  }

  /** A fresh directory under the job directory. */
  async scratch(label: string): Promise<string> {
    const dir = join(this.jobDir, `${++this.#seq}-${label}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  assertNotExpired(): void {
    if (this.now().getTime() >= Date.parse(this.signedJob.expiresAt)) {
      throw new JobFailure('job_expired', `job expired at ${this.signedJob.expiresAt}`);
    }
  }

  redact(text: string): string {
    return redact(text, ...this.credentials.secrets(), ...this.extraSecrets);
  }

  readEnv(coords: RepoCoords): Promise<Record<string, string>> {
    return this.credentials.gitEnv(coords, 'read');
  }

  writeEnv(coords: RepoCoords): Promise<Record<string, string>> {
    return this.credentials.gitEnv(coords, 'write');
  }

  revisionFor(coords: RepoCoords, sha: string): RevisionId {
    return formatRevisionId(coords.kind === 'artifacts' ? { kind: 'art', repoId: coords.repoId, sha } : { kind: 'local', repoId: coords.repoId, sha });
  }

  blobs(): BlobStore {
    if (!this.services.blobStore) throw new JobFailure('provider_unavailable', 'no object store configured for this runner');
    return this.services.blobStore(this.signedJob);
  }

  /**
   * The ledger's current head of a resource, when the Worker provides it (`undefined` = unknown).
   * Never canonical `refs/heads/main`: that is a projection that may lag or diverge.
   */
  async currentHead(resourceId: string): Promise<RevisionId | null | undefined> {
    if (!this.services.currentHeads) return undefined;
    this.#heads ??= this.services.currentHeads(this.signedJob).catch(() => null);
    const heads = await this.#heads;
    if (!heads || !(resourceId in heads)) return undefined;
    return heads[resourceId] ?? null;
  }

  /**
   * Push exactly one allowed ref (plan §B.8 + jobAllowedPushRefs): the target must be listed for
   * this job, the lease is the job's, pushes to one repository are serialized, the job must not
   * have expired before any attempt.
   */
  async push(req: { coords: RepoCoords; ref: string; sha: string; dir: string }): Promise<PushOutcome> {
    const allowed = jobAllowedPushRefs(this.job).find((a) => sameRepoIdentity(a.coords, req.coords) && a.ref === req.ref);
    if (!allowed) throw new JobFailure('scope_violation', `push to ${req.ref} on ${req.coords.repoName} is not allowed for a ${this.job.kind} job`);
    const expected = allowed.lease === 'absent' ? null : allowed.lease === 'expected' ? (allowed.expectedSha ?? null) : 'observed';
    await this.assertNoCheckProcesses();
    return this.services.pushMutex.run(req.coords.remoteUrl, async () => {
      this.assertNotExpired();
      const env = await this.writeEnv(req.coords);
      return pushWithLease({
        git: this.git,
        dir: req.dir,
        remote: req.coords.remoteUrl,
        env,
        sha: req.sha,
        ref: req.ref,
        expected,
        ...(this.services.push.attempts !== undefined ? { attempts: this.services.push.attempts } : {}),
        ...(this.services.push.baseDelayMs !== undefined ? { baseDelayMs: this.services.push.baseDelayMs } : {}),
        ...(this.services.push.sleep ? { sleep: this.services.push.sleep } : {}),
        beforeAttempt: () => this.assertNotExpired(),
      });
    });
  }

  /**
   * A fresh directory for check content (checkouts, HOME, TMPDIR), under the checks root — never
   * inside the job directory that holds the repositories the runner pushes from.
   */
  async checkScratch(label: string): Promise<string> {
    if (!this.#checksDir) {
      await mkdir(this.services.checksRoot, { recursive: true, mode: 0o711 });
      this.#checksDir = await mkdtemp(join(this.services.checksRoot, `job-${this.jobId.slice(0, 40)}-`));
      // the check uid may traverse (not list) to the directories it owns
      if (this.services.commands.uid !== undefined) await chmod(this.#checksDir, 0o711);
    }
    const dir = join(this.#checksDir, `${++this.#checkSeq}-${label}`);
    await mkdir(dir, { mode: 0o700 });
    return dir;
  }

  /** Refuse to run candidate code without a separate uid unless explicitly opted in. */
  assertCheckIsolation(): void {
    const c = this.services.commands;
    if (c.uid !== undefined) {
      try {
        assertSeparateCheckUid(c.uid, c.gid ?? c.uid);
      } catch (e) {
        throw new JobFailure('provider_unavailable', (e as Error).message);
      }
      return;
    }
    if (!c.unsafeSameUid) {
      throw new JobFailure(
        'provider_unavailable',
        'this runner has no separate check uid (--check-uid); refusing to run candidate commands as the runner (use --unsafe-same-uid-checks only for trusted content)',
      );
    }
  }

  /**
   * Run an allowlisted command in an isolated child process (see `commands.ts`). The child's
   * environment is built from scratch: no credential, broker header or evidence key can reach it.
   * Afterwards every remaining check process (any session or group) is killed.
   */
  async runCommand(command: string, cwd: string, timeoutMs: number, stepEnv: Record<string, string> = {}): Promise<CommandRun | { refused: string }> {
    this.assertCheckIsolation();
    const parsed = parseAllowedCommand(command, this.services.commands.allowlist ?? DEFAULT_COMMAND_ALLOWLIST);
    if (!parsed.ok) return { refused: parsed.reason };
    // server-owned step env (recipe) first; runner-configured extras win; base vars always win
    for (const k of Object.keys(stepEnv)) if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k) || /^(PATH|HOME|TMPDIR|LANG|CI|NO_COLOR|GIT_.*|NODE_OPTIONS|LD_.*)$/.test(k)) return { refused: `step env ${k} is not allowed` };
    const extra = { ...stepEnv, ...(this.services.commands.extraEnv ?? {}) };
    if (containsSecret(JSON.stringify(extra))) throw new JobFailure('scope_violation', 'check environment contains a secret');
    const home = await this.checkScratch('home');
    return this.runIsolatedAsCheck(parsed.argv, cwd, timeoutMs, extra, home, this.services.commands.network ?? 'inherit');
  }

  /**
   * Run a RUNNER-built argv (never a job-supplied command string: no allowlist applies) with the
   * same isolation as checks: the check uid, a clean environment built from scratch (`extra` plus
   * the base variables, HOME = `home`, a fresh TMPDIR), its own process group, and every check
   * process reaped afterwards. `network` is chosen by the caller: the runner-controlled dependency
   * install (`install.ts`) is the only caller that keeps the network while checks run without it.
   */
  async runIsolatedAsCheck(argv: readonly string[], cwd: string, timeoutMs: number, extra: Record<string, string>, home: string, network: 'inherit' | 'none'): Promise<CommandRun> {
    this.assertCheckIsolation();
    const tmp = await this.checkScratch('tmp');
    await this.prepareCheckDir(home);
    await this.prepareCheckDir(tmp);
    const marker = randomBytes(12).toString('hex');
    this.#markers.push(marker);
    const env = { ...checkEnvironment({ path: this.services.commands.path ?? process.env.PATH ?? '/usr/bin:/bin', home, tmp }, extra), [CHECK_MARKER_VAR]: marker };
    const c = this.services.commands;
    let r;
    try {
      r = await runIsolated({
        argv,
        cwd,
        env,
        timeoutMs,
        ...(c.maxOutputBytes !== undefined ? { maxOutputBytes: c.maxOutputBytes } : {}),
        ...(c.uid !== undefined ? { uid: c.uid } : {}),
        ...(c.gid !== undefined ? { gid: c.gid } : {}),
        ...(network === 'none' ? { network: 'none' as const } : {}),
      });
    } finally {
      await this.assertNoCheckProcesses();
    }
    return { ...r, argv: [...argv], stdout: this.redact(r.stdout), stderr: this.redact(r.stderr) };
  }

  /** Kill every check process this job may have left; fail the job if any survives. */
  async assertNoCheckProcesses(): Promise<void> {
    const c = this.services.commands;
    if (c.uid === undefined && this.#markers.length === 0) return;
    const sel = c.uid !== undefined ? { uid: c.uid } : { markers: this.#markers };
    const left = await reapCheckProcesses(this.services.procs, sel);
    if (left.length > 0) throw new JobFailure('provider_unavailable', `check processes still running (${left.join(', ')}); refusing to continue`);
  }

  /** Hand a directory tree to the check uid (no-op when checks run as the runner's uid). */
  async prepareCheckDir(dir: string): Promise<void> {
    const { uid, gid } = this.services.commands;
    if (uid === undefined) return;
    const g = gid ?? uid;
    await chown(dir, uid, g);
    for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
      await chown(join(e.parentPath, e.name), uid, g);
    }
  }

  /** Remove this job's check directories. */
  async cleanupChecks(): Promise<void> {
    if (this.#checksDir) await rm(this.#checksDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Sign evidence in this (supervisor) process with the per-job derived key. */
  async signEvidence(unsigned: Omit<UnsignedValidationEvidence, 'evidenceId' | 'runnerId' | 'runnerKind' | 'producedAt'>): Promise<ValidationEvidence> {
    if (!this.evidenceKey) throw new JobFailure('provider_unavailable', 'no evidence key was delivered for this job');
    return signEvidence(
      {
        ...unsigned,
        evidenceId: `ev-${this.jobId}`,
        runnerId: this.services.runnerId,
        runnerKind: this.services.runnerKind,
        producedAt: this.nowIso(),
      },
      this.evidenceKey,
      { jobId: this.jobId },
    );
  }

  log(msg: string): void {
    this.services.log(this.redact(`[${this.jobId}] ${msg}`));
  }
}
