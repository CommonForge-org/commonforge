/**
 * Runner-controlled dependency installation before integrate checks (follow-up to Task 22: in the
 * Sandbox, jobs that can write a repository run their checks with NO network, so a check that
 * needs `node_modules` could never install it itself).
 *
 * For every mount of the check checkout whose `package.json` declares dependencies, or that is a
 * pnpm workspace, the runner (not the job) runs exactly {@link installArgv}:
 *
 *     pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile --config.pm-on-fail=ignore
 *       --no-runtime --no-trust-lockfile --config.minimum-release-age=<m>
 *       --config.minimum-release-age-exclude=<entry>…
 *
 * in that mount, BEFORE any check runs, and only then runs the checks offline as the check uid.
 *
 * - **Lockfile required.** A mount that declares dependencies but has no committed `pnpm-lock.yaml`
 *   fails the job (`check_failed`); a stale lockfile fails `--frozen-lockfile` the same way.
 *   Versions and integrity hashes therefore come from the candidate's reviewed lockfile only.
 * - **No candidate code runs during the install.** No lifecycle scripts (`--ignore-scripts`: none
 *   at all, which is within the fixtures' allowBuilds set), no `.pnpmfile.*` hooks
 *   (`--ignore-pnpmfile`), and no switch to another pnpm named by a `packageManager` field
 *   (`pm-on-fail=ignore`), no lockfile `runtime:` (`--no-runtime`). Only the image's pinned pnpm
 *   executes. The release-age policy is on the command line, so the candidate's own config cannot
 *   relax it (`--no-trust-lockfile` re-verifies every lockfile entry against it).
 * - **Isolation.** The install runs as the check uid (so a hostile tree, e.g. a `node_modules`
 *   symlink, can only make it write where the check uid already may), with a clean environment
 *   and its own HOME/config/cache, and every check-uid process is reaped afterwards. It keeps the
 *   runner's network (the checks do not): in the Sandbox that network reaches only the npm
 *   gateway, which for these jobs requires a per-job registry key (`InstallSettings.registryAuth`)
 *   and fetches upstream without following redirects; the Artifacts and control-plane gateways
 *   refuse it (they require the root runner's own key, which the install never has).
 * - The registry key lives in the install's own npmrc only while the install runs.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntegrationJobKind } from '@commonforge-org/runner-protocol';
import { DEFAULT_INSTALL_POLICY, type JobContext } from './context.js';
import { JobFailure } from './errors.js';

/** The flags every install gets, whatever the candidate's own pnpm-workspace.yaml or .npmrc say. */
export const INSTALL_BASE_ARGV = [
  'pnpm',
  'install',
  '--frozen-lockfile',
  '--ignore-scripts',
  '--ignore-pnpmfile',
  '--config.pm-on-fail=ignore',
  // review m-1: a lockfile `runtime:` entry (e.g. node) is never fetched or linked
  '--no-runtime',
  // review m-1: lockfile entries are re-verified against the policy below, never trusted as-is
  '--no-trust-lockfile',
] as const;

export interface InstallPolicy {
  /** pnpm minimumReleaseAge, minutes */
  minimumReleaseAge: number;
  /** `name@version` entries exempt from it */
  minimumReleaseAgeExclude: readonly string[];
}

const EXCLUDE_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@[0-9A-Za-z.+-]+$/;
/** pnpm applies the candidate's own excludes when the command line names none: always name one. */
const NO_EXCLUDE_SENTINEL = '@commonforge-org/no-release-age-exclusions@0.0.0';

/**
 * The exact install argv. Review m-1: the release-age policy is on the COMMAND LINE, which beats the
 * candidate's pnpm-workspace.yaml (verified with pnpm 12.5.1: a yaml `minimumReleaseAge: 0`,
 * `trustLockfile: true` or extra `minimumReleaseAgeExclude` entries change nothing). The exclude
 * list is passed one flag per entry (pnpm refuses a comma list).
 */
export function installArgv(policy: InstallPolicy): string[] {
  if (!Number.isInteger(policy.minimumReleaseAge) || policy.minimumReleaseAge < 0) throw new Error('minimumReleaseAge must be a non-negative integer (minutes)');
  const excludes = policy.minimumReleaseAgeExclude.length > 0 ? policy.minimumReleaseAgeExclude : [NO_EXCLUDE_SENTINEL];
  for (const e of excludes) if (!EXCLUDE_RE.test(e)) throw new Error(`invalid minimumReleaseAgeExclude entry ${JSON.stringify(e)}`);
  return [...INSTALL_BASE_ARGV, `--config.minimum-release-age=${policy.minimumReleaseAge}`, ...excludes.map((e) => `--config.minimum-release-age-exclude=${e}`)];
}

export const INSTALL_TIMEOUT_MS = 10 * 60_000;
/**
 * Environment for the checks after an install: pnpm 12 otherwise re-verifies `node_modules` before
 * `pnpm exec`/`pnpm run` and, finding another store path, installs again (with no network: fails).
 */
export const INSTALLED_CHECK_ENV: Readonly<Record<string, string>> = { PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false' };
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

export interface MountInstall {
  mountName: string;
  /** `installed`, or why nothing was installed */
  status: 'installed' | 'no-package-json' | 'no-dependencies';
  /** the mount is a pnpm workspace (pnpm-workspace.yaml with `packages:`) */
  workspace?: boolean;
  ms?: number;
}

/** `//host[:port]/path/` (npm's "nerf dart") of a registry URL, the key npmrc auth lines use. */
export function registryNerfDart(registry: string): string {
  const u = new URL(registry);
  const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  return `//${u.host}${path}`;
}

async function regularFile(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  return !!st && st.isFile();
}

async function readSmall(path: string): Promise<string | null> {
  if (!(await regularFile(path))) return null;
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * What a mount needs: `null` (nothing to install) or the reason it installs. A mount installs when
 * its root package.json declares dependencies, or (review m-3) when it is a pnpm workspace
 * (`pnpm-workspace.yaml` with a `packages:` list), whose packages declare their own.
 */
async function decideMount(mountDir: string, mountName: string): Promise<MountInstall | { install: true; workspace: boolean }> {
  const pkgText = await readSmall(join(mountDir, 'package.json'));
  const ws = await readSmall(join(mountDir, 'pnpm-workspace.yaml'));
  const workspace = ws !== null && /^packages\s*:/m.test(ws);
  let declares = false;
  if (pkgText !== null) {
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(pkgText) as Record<string, unknown>;
    } catch {
      throw new JobFailure('check_failed', `${mountName}/package.json is not valid JSON`);
    }
    declares = DEPENDENCY_FIELDS.some((f) => {
      const v = pkg?.[f];
      return !!v && typeof v === 'object' && Object.keys(v).length > 0;
    });
  }
  if (!declares && !workspace) return { mountName, status: pkgText === null ? 'no-package-json' : 'no-dependencies' };
  if (!(await regularFile(join(mountDir, 'pnpm-lock.yaml')))) {
    throw new JobFailure(
      'check_failed',
      `mount ${mountName} ${workspace ? 'is a pnpm workspace' : 'declares dependencies'} but has no committed pnpm-lock.yaml: the runner installs check dependencies only from a lockfile (pnpm install --frozen-lockfile)`,
    );
  }
  return { install: true, workspace };
}

/**
 * Install each mount's dependencies (in mount-name order) into the check checkout `root`. Call
 * after the checkout is handed to the check uid and before any check runs. Review m-4: every mount
 * is decided (package.json, workspace, lockfile) BEFORE the first install runs, so nothing an
 * install writes (as the check uid) can change what the runner reads for another mount.
 */
export async function installMountDependencies<K extends IntegrationJobKind>(ctx: JobContext<K>, root: string, mountNames: readonly string[]): Promise<MountInstall[]> {
  const settings = ctx.services.commands.install ?? {};
  const out: MountInstall[] = [];
  if (settings.enabled === false) return out;
  const argv = installArgv(settings.policy ?? DEFAULT_INSTALL_POLICY);
  const plan: Array<{ mountName: string; workspace: boolean }> = [];
  for (const mountName of [...new Set(mountNames)].sort()) {
    const d = await decideMount(join(root, mountName), mountName);
    if ('install' in d) plan.push({ mountName, workspace: d.workspace });
    else out.push(d);
  }
  let storeDir: string | undefined = settings.storeDir;
  for (const { mountName, workspace } of plan) {
    const dir = join(root, mountName);
    ctx.assertNotExpired();
    // one store per job (shared by its mounts, never by other jobs), owned by the check uid
    if (!storeDir) {
      storeDir = await ctx.checkScratch('pnpm-store');
      await ctx.prepareCheckDir(storeDir);
    }
    const home = await ctx.checkScratch('install-home');
    const configDir = join(home, '.config');
    await mkdir(configDir, { recursive: true });
    const npmrc = join(home, '.npmrc');
    const auth = settings.registryAuth;
    await writeFile(npmrc, auth ? `${registryNerfDart(auth.registry)}:_authToken=${auth.token}\n` : '', { mode: 0o600 });
    const env: Record<string, string> = {
      ...(ctx.services.commands.extraEnv ?? {}),
      ...(auth ? { PNPM_CONFIG_REGISTRY: auth.registry, NPM_CONFIG_REGISTRY: auth.registry } : {}),
      NPM_CONFIG_USERCONFIG: npmrc,
      PNPM_CONFIG_STORE_DIR: storeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
    };
    const remaining = Date.parse(ctx.signedJob.expiresAt) - ctx.now().getTime();
    const timeoutMs = Math.max(1_000, Math.min(settings.timeoutMs ?? INSTALL_TIMEOUT_MS, remaining - 5_000));
    let run;
    try {
      run = await ctx.runIsolatedAsCheck(argv, dir, timeoutMs, env, home, 'inherit');
    } finally {
      await rm(npmrc, { force: true }).catch(() => undefined);
    }
    if (run.exitCode !== 0 || run.timedOut) {
      const why = run.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exit ${run.exitCode ?? run.signal}`;
      const tail = (run.stderr.trim() || run.stdout.trim()).slice(-2000);
      throw new JobFailure('check_failed', ctx.redact(`dependency install for mount ${mountName} (${argv.slice(0, 3).join(' ')} …) failed: ${why}\n${tail}`));
    }
    out.push({ mountName, status: 'installed', ...(workspace ? { workspace } : {}), ms: run.endedAt.getTime() - run.startedAt.getTime() });
    ctx.log(`installed dependencies of ${mountName} from its lockfile (${out.at(-1)!.ms} ms)`);
  }
  return out;
}
