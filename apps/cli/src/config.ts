/**
 * User-level state, kept in the OS config directory (never in a workspace):
 *
 *   <configDir>/config.json             apiUrl, default org (no secrets)
 *   <configDir>/session.json   (0600)   the CLI session bearer (`cfs_…`) from `cforge login`
 *   <configDir>/leases/<task>.json (0600)  the task lease bearer (`cfl_…`) from `cforge checkout`
 *   <configDir>/checkouts/<task>.<hash(root)>.json   one per checkout: where, and which remotes it
 *                                       uses (the credential helper's allowlist; its path, never a
 *                                       token, is written into the mounts' git config) and LFS URLs
 *
 * The directory is 0700. Git tokens are never stored anywhere: the credential helper asks the
 * broker for a fresh one on every git request.
 */
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CliError, rememberSecret, type CliIo } from "./context.js";

export function configDir(env: CliIo["env"]): string {
  if (env.CFORGE_CONFIG_DIR) return env.CFORGE_CONFIG_DIR;
  const home = env.HOME || homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "commonforge");
    case "win32":
      return join(env.APPDATA || join(home, "AppData", "Roaming"), "commonforge");
    default:
      return join(env.XDG_CONFIG_HOME || join(home, ".config"), "commonforge");
  }
}

const ConfigSchema = z.object({ apiUrl: z.string().optional(), org: z.string().optional() });
export type CliConfig = z.infer<typeof ConfigSchema>;

export const SessionSchema = z.object({
  apiUrl: z.string(),
  sessionToken: z.string().startsWith("cfs_"),
  expiresAt: z.string(),
  user: z.object({ userId: z.string(), email: z.string() }),
});
export type Session = z.infer<typeof SessionSchema>;

export const LeaseSchema = z.object({
  apiUrl: z.string(),
  taskId: z.string(),
  leaseToken: z.string().startsWith("cfl_"),
  leaseGeneration: z.number(),
  expiresAt: z.string(),
});
export type Lease = z.infer<typeof LeaseSchema>;

export const CheckoutMountSchema = z.object({
  mountName: z.string(),
  remoteUrl: z.string(),
  writable: z.boolean(),
  credential: z.enum(["helper", "none"]),
  taskWorkspaceId: z.string().optional(),
  baseSha: z.string(),
  /** the folder's Git LFS endpoint, recorded only when it is on the checkout's API origin */
  lfsUrl: z.string().optional(),
});
export const CheckoutRecordSchema = z.object({
  apiUrl: z.string(),
  taskId: z.string(),
  workspaceRoot: z.string(),
  mounts: z.array(CheckoutMountSchema),
  createdAt: z.string(),
});
export type CheckoutRecord = z.infer<typeof CheckoutRecordSchema>;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export class ConfigStore {
  readonly dir: string;
  constructor(env: CliIo["env"], dir?: string) {
    this.dir = dir ?? configDir(env);
  }

  /** The store a checkout record lives in (`<dir>/checkouts/<file>`), independent of the environment. */
  static forRecord(recordPath: string): ConfigStore {
    return new ConfigStore({}, dirname(dirname(recordPath)));
  }

  async #ensureDir(sub?: string): Promise<string> {
    const d = sub ? join(this.dir, sub) : this.dir;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    if (sub) await mkdir(d, { recursive: true, mode: 0o700 });
    return d;
  }

  async #read<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return null;
      throw e;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // never echo the content: JSON.parse quotes the start of the input, which may be a token
      throw new CliError("config_corrupt", `${path} is not valid JSON; fix or remove it`);
    }
    const r = schema.safeParse(parsed);
    return r.success ? r.data : null;
  }

  /** Atomic write; secrets files are created 0600 before any byte is written. */
  async #write(path: string, value: unknown, mode: number): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
    await chmod(tmp, mode);
    await rename(tmp, path);
  }

  #file(sub: string, name: string): string {
    if (!SAFE_NAME.test(name)) throw new CliError("invalid_request", `invalid id ${JSON.stringify(name)}`);
    return join(this.dir, sub, `${name}.json`);
  }

  async config(): Promise<CliConfig> {
    return (await this.#read(join(this.dir, "config.json"), ConfigSchema)) ?? {};
  }

  async saveConfig(patch: CliConfig): Promise<void> {
    await this.#ensureDir();
    await this.#write(join(this.dir, "config.json"), { ...(await this.config()), ...patch }, 0o600);
  }

  async session(): Promise<Session | null> {
    const s = await this.#read(join(this.dir, "session.json"), SessionSchema);
    rememberSecret(s?.sessionToken);
    return s;
  }

  async saveSession(s: Session): Promise<void> {
    await this.#ensureDir();
    await this.#write(join(this.dir, "session.json"), s, 0o600);
  }

  async clearSession(): Promise<void> {
    await rm(join(this.dir, "session.json"), { force: true });
  }

  async lease(taskId: string): Promise<Lease | null> {
    const l = await this.#read(this.#file("leases", taskId), LeaseSchema);
    rememberSecret(l?.leaseToken);
    return l;
  }

  async saveLease(l: Lease): Promise<void> {
    await this.#ensureDir("leases");
    await this.#write(this.#file("leases", l.taskId), l, 0o600);
  }

  async clearLease(taskId: string): Promise<void> {
    await rm(this.#file("leases", taskId), { force: true });
  }

  /** Path of the record for checking `taskId` out at `root` (one record per checkout). */
  checkoutPath(taskId: string, root: string): string {
    return this.#file("checkouts", `${taskId}.${createHash("sha256").update(root).digest("hex").slice(0, 16)}`);
  }

  async readCheckout(path: string): Promise<CheckoutRecord | null> {
    return this.#read(path, CheckoutRecordSchema);
  }

  async saveCheckout(r: CheckoutRecord): Promise<string> {
    await this.#ensureDir("checkouts");
    const path = this.checkoutPath(r.taskId, r.workspaceRoot);
    await this.#write(path, r, 0o600);
    return path;
  }

  async removeCheckout(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  /** Every readable checkout record (corrupt ones are skipped, never echoed). */
  async checkouts(taskId?: string): Promise<Array<{ path: string; record: CheckoutRecord }>> {
    let names: string[];
    try {
      names = await readdir(join(this.dir, "checkouts"));
    } catch {
      return [];
    }
    const out: Array<{ path: string; record: CheckoutRecord }> = [];
    for (const n of names.filter((x) => x.endsWith(".json")).sort()) {
      const path = join(this.dir, "checkouts", n);
      try {
        const record = await this.#read(path, CheckoutRecordSchema);
        if (record && (!taskId || record.taskId === taskId)) out.push({ path, record });
      } catch {
        /* corrupt record: ignored */
      }
    }
    return out;
  }

  /** File mode bits (tests and `cforge status` report them). */
  async modeOf(sub: string | null, name: string): Promise<number | null> {
    try {
      return (await stat(sub ? join(this.dir, sub, name) : join(this.dir, name))).mode & 0o777;
    } catch {
      return null;
    }
  }
}
