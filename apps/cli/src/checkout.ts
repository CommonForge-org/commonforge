/**
 * `cforge checkout <taskId> <dir>` (plan §A.8, §B.3):
 *   1. take (or reuse) the task lease with the CLI session — or use `CFORGE_LEASE_TOKEN`;
 *   2. fetch the server-built `MaterializationPlan` (`GET /api/tasks/:id/materialization?root=`);
 *      asset mounts are downloaded with the lease (`GET /api/tasks/:id/assets/file`), never a session;
 *   3. record the task's remotes in the user config dir (the credential helper's allowlist);
 *   4. `materialize` with git configured to ask `cforge credential-helper` (via GIT_CONFIG_* env);
 *   5. write the same helper config into each mount's `.git/config`, and wire git-lfs: `lfs.url`
 *      from the plan, `lfs.fetchexclude = *` and the helper for the LFS URL (only on the API's
 *      origin); the clone runs with `GIT_LFS_SKIP_SMUDGE=1`, so LFS files stay pointers (P4-7);
 *   6. `verifyMaterialization` — refuse to hand over a workspace that does not match the plan.
 * No token is ever written to disk, to git config, to workspace.json or to the output.
 */
import { mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { MaterializationPlanSchema, type MaterializationPlan } from "@commonforge-org/core";
import { materialize, validatePlan, verifyMaterialization, type AssetObjectRequest } from "@commonforge-org/runner-protocol";
import { createNodeIo } from "@commonforge-org/runner-protocol/node";
import { ApiClient, isSecureEnough, leaseBearer, resolveApiUrl, sessionClient } from "./api.js";
import { int, parse, positional, type CommandContext } from "./command.js";
import { CliError, scrub } from "./context.js";
import type { CheckoutRecord } from "./config.js";
import { gitEnv, helperConfigEntries, helperConfigEnv, installHelperConfig, lfsConfigEntries } from "./git.js";
import { acquireLease, leaseTtl } from "./project.js";

const USAGE = "cforge checkout <taskId> <dir> [--lease-ttl <seconds>] [--wait <seconds>] [--json]";

async function prepareRoot(dir: string): Promise<{ root: string; created: boolean }> {
  let created = false;
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) throw new CliError("workspace_root_invalid", `${dir} exists and is not a directory`);
    if ((await readdir(dir)).length > 0) throw new CliError("workspace_not_empty", `${dir} is not empty`);
  } catch (e) {
    if (e instanceof CliError) throw e;
    if ((e as { code?: string }).code !== "ENOENT") throw e;
    await mkdir(dir, { recursive: true });
    created = true;
  }
  return { root: await realpath(dir), created };
}

const READY_STATES = new Set(["ready", "running"]);

/** Wait while the server provisions the task's workspaces (`provisioning` → `ready`). */
async function waitForTask(ctx: CommandContext, api: ApiClient, taskId: string, waitSeconds: number): Promise<void> {
  const deadline = ctx.io.now().getTime() + waitSeconds * 1000;
  let announced = false;
  for (let delay = 1000; ; delay = Math.min(delay * 1.5, 10_000)) {
    const t = await api.get<{ state: string; workspaces?: Array<{ mountName: string; state: string; error?: string }> }>(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (READY_STATES.has(t.state)) return;
    if (t.state !== "provisioning") {
      const errors = (t.workspaces ?? []).filter((w) => w.error).map((w) => `${w.mountName}: ${w.error}`);
      throw new CliError("task_not_ready", `task ${taskId} is ${t.state}${errors.length ? ` (${errors.join("; ")})` : ""}`);
    }
    if (ctx.io.now().getTime() + delay > deadline) throw new CliError("task_not_ready", `task ${taskId} is still provisioning; retry \`cforge checkout\` in a moment (or pass --wait <seconds>)`);
    if (!announced) ctx.out.info(`Task ${taskId} is still provisioning its workspaces; waiting …`);
    announced = true;
    await ctx.io.sleep(delay);
  }
}

/** Plan remotes may carry a credential: https, loopback http, or file. */
function checkRemotes(plan: MaterializationPlan): void {
  for (const m of plan.mounts) {
    if (m.source.kind !== "git") continue;
    const u = new URL(m.source.remoteUrl);
    if (u.protocol !== "file:" && !isSecureEnough(m.source.remoteUrl)) throw new CliError("insecure_url", `refusing plain-http remote ${u.host} for ${m.mountName}; only https (or http on localhost)`);
  }
}

export async function checkout(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, { "lease-ttl": { type: "string" }, wait: { type: "string" } }, USAGE);
  const taskId = positional(p, 0, "taskId", USAGE);
  const dir = resolve(ctx.io.cwd, positional(p, 1, "dir", USAGE));
  const apiUrl = await resolveApiUrl(ctx.io, ctx.store, ctx.global.apiUrl);
  const ttl = leaseTtl(int(p, "lease-ttl"), "lease-ttl");

  // A lease handed to an agent wins; otherwise the developer's session takes one.
  let userApi: ApiClient | null = null;
  let leaseInfo: Record<string, unknown>;
  let leaseToken: string;
  const envLease = await leaseBearer(ctx.io, ctx.store, taskId, apiUrl).then((b) => (b?.source === "env" ? b : null));
  if (envLease) {
    leaseInfo = { source: "env" };
    leaseToken = envLease.token;
  } else {
    userApi = (await sessionClient(ctx.io, ctx.store, apiUrl)).api;
    await waitForTask(ctx, userApi, taskId, int(p, "wait") ?? 600);
    const { lease, reused, replacedStale } = await acquireLease(ctx, userApi, taskId, ttl);
    leaseInfo = { source: "config", leaseGeneration: lease.leaseGeneration, expiresAt: lease.expiresAt, reused, ...(replacedStale ? { replacedStale } : {}) };
    leaseToken = lease.leaseToken;
  }
  // The task's agent routes (the plan, asset reads) use the lease alone: no session fallback on 401.
  // The agent may read its plan; a client's session cannot (the plan names repositories).
  const leaseApi = new ApiClient(ctx.io, apiUrl, leaseToken);
  const planApi = leaseApi;

  const { root, created } = await prepareRoot(dir);
  let recordPath: string | null = null;
  const cleanup = async () => {
    if (recordPath) await ctx.store.removeCheckout(recordPath);
    if (created) await rm(root, { recursive: true, force: true });
    else for (const name of await readdir(root).catch(() => [])) await rm(resolve(root, name), { recursive: true, force: true });
  };
  try {
    const raw = await planApi.get(`/api/tasks/${encodeURIComponent(taskId)}/materialization?root=${encodeURIComponent(root)}`);
    const parsed = MaterializationPlanSchema.safeParse(raw);
    if (!parsed.success) throw new CliError("invalid_plan", "the server returned an invalid materialization plan");
    let plan: MaterializationPlan;
    try {
      plan = validatePlan(parsed.data);
    } catch (e) {
      throw new CliError("invalid_plan", (e as Error).message);
    }
    if (plan.workspaceRoot !== root) throw new CliError("invalid_plan", `the plan is for ${plan.workspaceRoot}, not ${root}`);
    checkRemotes(plan);
    await materializeAndVerify(ctx, plan, { apiUrl, taskId, root, leaseApi, leaseInfo, setRecord: (r) => void (recordPath = r) });
  } catch (e) {
    await cleanup();
    throw e;
  }
}

async function materializeAndVerify(
  ctx: CommandContext,
  plan: MaterializationPlan,
  o: { apiUrl: string; taskId: string; root: string; leaseApi: ApiClient; leaseInfo: Record<string, unknown>; setRecord: (path: string) => void },
): Promise<void> {
  const { apiUrl, taskId, root } = o;
  // The lease goes to an LFS URL only on the API's own origin (Tokens, folders phase 4).
  const lfsUrlOf = (mountName: string, lfsUrl: string | undefined): string | null => {
    if (!lfsUrl) return null;
    if (isSecureEnough(lfsUrl) && new URL(lfsUrl).origin === new URL(apiUrl).origin) return lfsUrl;
    ctx.out.warn(`warning: ${mountName}: the plan's LFS URL ${lfsUrl} is not on ${new URL(apiUrl).origin}; git-lfs is not configured for it`);
    return null;
  };
  // The helper's allowlist: exactly the planned remotes of this checkout (one record per root).
  const record: CheckoutRecord = {
    apiUrl,
    taskId,
    workspaceRoot: root,
    mounts: plan.mounts.flatMap((m) => {
      if (m.source.kind !== "git") return [];
      const lfsUrl = lfsUrlOf(m.mountName, m.source.lfsUrl);
      return [
        {
          mountName: m.mountName,
          remoteUrl: m.source.remoteUrl,
          writable: m.writable,
          credential: m.source.credential ?? "none",
          baseSha: m.source.sha,
          ...(m.taskWorkspaceId ? { taskWorkspaceId: m.taskWorkspaceId } : {}),
          ...(lfsUrl ? { lfsUrl } : {}),
        },
      ];
    }),
    createdAt: ctx.io.now().toISOString(),
  };
  const recordPath = await ctx.store.saveCheckout(record);
  o.setRecord(recordPath);

  const helper = ctx.io.helperCommand;
  const localEntries = (m: CheckoutRecord["mounts"][number]) => [
    ...(m.credential === "helper" ? helperConfigEntries(m.remoteUrl, helper, recordPath) : []),
    ...(m.lfsUrl ? lfsConfigEntries(m.lfsUrl, helper, recordPath) : []),
  ];
  // at clone: the helper for remotes and LFS URLs (no local config exists yet); never smudge
  const entries = record.mounts.flatMap((m) => [
    ...(m.credential === "helper" ? helperConfigEntries(m.remoteUrl, helper, recordPath) : []),
    ...(m.lfsUrl ? helperConfigEntries(m.lfsUrl, helper, recordPath) : []),
  ]);
  const hasAssets = plan.mounts.some((m) => m.source.kind === "assets");
  let fetchObject: ((r: AssetObjectRequest) => Promise<Uint8Array>) | undefined;
  if (hasAssets) {
    // Lease-authenticated asset reads (API.md "Agent asset reads"): the server pins the manifest to
    // the task snapshot; the CLI checks it is the plan's manifest, and `materialize` the sha256.
    // Never retried with a developer session, so the checkout acts as one identity.
    fetchObject = async (r) => {
      const q = new URLSearchParams({ mount: r.mountName, path: r.entry.path });
      const res = await o.leaseApi.request("GET", `/api/tasks/${encodeURIComponent(taskId)}/assets/file?${q}`, undefined, { accept: "application/octet-stream" });
      const served = res.headers.get("x-commonforge-revision");
      if (served !== `r2m:${r.manifestId}`) {
        await res.body?.cancel();
        throw new CliError("asset_revision_mismatch", `the server served ${r.mountName}/${r.entry.path} from ${served ?? "an unknown revision"}, not the planned r2m:${r.manifestId}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    };
  }
  const nodeIo = createNodeIo({ env: { ...gitBaseEnv(ctx), ...helperConfigEnv(entries), GIT_LFS_SKIP_SMUDGE: "1" }, ...(fetchObject ? { fetchObject } : {}) });

  ctx.out.info(`Materializing ${plan.mounts.length} mount(s) into ${root} …`);
  try {
    await materialize(plan, nodeIo);
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw e instanceof CliError ? e : new CliError(typeof code === "string" ? code : "materialize_failed", scrub((e as Error).message));
  }

  for (const m of record.mounts) {
    const local = localEntries(m);
    if (local.length > 0) await installHelperConfig(ctx.git, resolve(root, m.mountName), local);
  }

  const verify = await verifyMaterialization(plan, createNodeIo({ env: gitBaseEnv(ctx) }));
  if (!verify.ok) throw new CliError("verify_failed", `the materialized workspace does not match the plan: ${verify.problems.map((x) => `${x.code} ${x.path}`).join("; ")}`, { problems: verify.problems });

  const mounts = plan.mounts.map((m) => ({
    mountName: m.mountName,
    resourceId: m.resourceId,
    revisionId: m.revisionId,
    writable: m.writable,
    ...(m.taskWorkspaceId ? { taskWorkspaceId: m.taskWorkspaceId } : {}),
    ...(m.source.kind === "git" ? { kind: "git", sha: m.source.sha, remoteUrl: m.source.remoteUrl } : { kind: "assets", manifestId: m.source.manifest.manifestId }),
  }));
  ctx.out.result({ taskId, workspaceRoot: root, mounts, lease: o.leaseInfo, verified: true }, () =>
    [
      `Checked out ${taskId} into ${root} (verified).`,
      ...mounts.map((m) => `  ${m.mountName.padEnd(20)} ${m.writable ? "read-write" : "read-only "} ${"sha" in m ? m.sha : m.manifestId}`),
      "Git asks `cforge credential-helper` for a short-lived token on each request; none is stored.",
      "Save progress with `cforge checkpoint`, hand in with `cforge submit`.",
    ].join("\n"),
  );
}

/** Environment for git launched by the CLI (the helper inherits it, e.g. CFORGE_CONFIG_DIR). */
export function gitBaseEnv(ctx: CommandContext): Record<string, string> {
  return gitEnv(ctx.io.env);
}
