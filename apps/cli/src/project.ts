/**
 * `cforge project list|show|tasks` and `cforge task create|lease|release` (API.md "Projects",
 * "Tasks, workspaces, leases, credentials").
 */
import { z } from "zod";
import { ApiClient, sessionClient } from "./api.js";
import { int, list, parse, positional, resolveOrg, str, type CommandContext } from "./command.js";
import { CliError, rememberSecret } from "./context.js";
import type { Lease } from "./config.js";
import type { MeResponse } from "./login.js";

const PROJECT_USAGE = "cforge project list | show <projectId> | tasks <projectId>  [--org <org>] [--json]";
const TASK_USAGE =
  "cforge task create <projectId> --title <t> [--write <mount>...] [--read <mount>...] [--request <text>] | lease <taskId> [--ttl <s>] [--print-token] | release <taskId>  [--org <org>] [--json]";

export async function orgFor(ctx: CommandContext, api: ApiClient): Promise<string> {
  return resolveOrg(ctx, async () => (await api.get<MeResponse>("/api/me")).memberships);
}

interface ProjectDetail {
  projectId: string;
  name: string;
  membershipRevision: number;
  policyRevision: number;
  mounts: Array<{ mountName: string; resourceId: string; provider: string; resourceName: string; mode: string; operations: string[] }>;
}

export async function project(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, {}, PROJECT_USAGE);
  const sub = positional(p, 0, "subcommand", PROJECT_USAGE);
  const { api } = await sessionClient(ctx.io, ctx.store, ctx.global.apiUrl);
  const org = await orgFor(ctx, api);
  const o = encodeURIComponent(org);
  switch (sub) {
    case "list": {
      const r = await api.get<{ projects: Array<{ projectId: string; name: string; createdAt: string }> }>(`/api/orgs/${o}/projects`);
      ctx.out.result({ orgId: org, ...r }, () => (r.projects.length ? r.projects.map((x) => `${x.projectId}  ${x.name}`).join("\n") : "No projects."));
      return;
    }
    case "show": {
      const pid = encodeURIComponent(positional(p, 1, "projectId", PROJECT_USAGE));
      const r = await api.get<ProjectDetail>(`/api/orgs/${o}/projects/${pid}`);
      ctx.out.result(r, () =>
        [
          `${r.projectId}  ${r.name}  (membership rev ${r.membershipRevision}, policy rev ${r.policyRevision})`,
          ...r.mounts.map((m) => `  ${m.mountName.padEnd(20)} ${m.provider.padEnd(10)} ${m.operations.join("+").padEnd(10)} ${m.resourceId} (${m.resourceName})`),
        ].join("\n"),
      );
      return;
    }
    case "tasks": {
      const pid = encodeURIComponent(positional(p, 1, "projectId", PROJECT_USAGE));
      const r = await api.get<{ tasks: Array<{ taskId: string; title: string; state: string; createdAt: string }> }>(`/api/orgs/${o}/projects/${pid}/tasks`);
      ctx.out.result({ orgId: org, ...r }, () => (r.tasks.length ? r.tasks.map((t) => `${t.taskId}  ${t.state.padEnd(12)} ${t.title}`).join("\n") : "No tasks."));
      return;
    }
    default:
      throw new CliError("invalid_arguments", `unknown subcommand ${sub}\nusage: ${PROJECT_USAGE}`, undefined, 2);
  }
}

const LeaseResponseSchema = z.object({ taskId: z.string(), leaseToken: z.string().startsWith("cfl_"), leaseGeneration: z.number(), expiresAt: z.string() });

/** Seconds a stored lease must still have to be reused instead of taking a new one. */
const LEASE_REUSE_MARGIN_S = 120;
/** The Worker's lease TTL bounds (`POST /api/tasks/:id/lease`). */
export const MIN_LEASE_SECONDS = 300;
export const MAX_LEASE_SECONDS = 28_800;

export function leaseTtl(value: number | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (value < MIN_LEASE_SECONDS || value > MAX_LEASE_SECONDS) throw new CliError("invalid_arguments", `--${flag} must be between ${MIN_LEASE_SECONDS} and ${MAX_LEASE_SECONDS} seconds`, undefined, 2);
  return value;
}

/** Is the stored lease still the task's current lease? Asks the server with the lease itself. */
async function leaseIsCurrent(ctx: CommandContext, api: ApiClient, lease: Lease): Promise<boolean> {
  try {
    const t = await new ApiClient(ctx.io, api.apiUrl, lease.leaseToken).get<{ lease: { generation: number } | null }>(`/api/tasks/${encodeURIComponent(lease.taskId)}`);
    return t.lease?.generation === lease.leaseGeneration;
  } catch (e) {
    if (e instanceof CliError && [401, 403, 404].includes(Number(e.details?.status))) return false;
    throw e;
  }
}

/**
 * `409 lease_held`: someone else checked the task out and their lease is still live. Says until
 * when (from `GET /api/tasks/:id`, best effort) and what to do; keeps the code.
 */
async function leaseHeldError(api: ApiClient, taskId: string, e: CliError): Promise<CliError> {
  let until: string | null = null;
  try {
    until = (await api.get<{ lease: { expiresAt: string } | null }>(`/api/tasks/${encodeURIComponent(taskId)}`)).lease?.expiresAt ?? null;
  } catch {
    /* the message works without it */
  }
  return new CliError(
    "lease_held",
    `someone else has task ${taskId} checked out${until ? ` (until ${until})` : ""}. Wait for their lease to end or ask them to submit; an owner of the organization can take it over.`,
    { ...e.details, ...(until ? { leaseExpiresAt: until } : {}) },
  );
}

/**
 * Take (or reuse) the task lease with the CLI session and store it 0600 in the config dir. A
 * stored lease is reused only when it has time left, no specific TTL was asked for, and the server
 * confirms it is still the current one (a takeover or release elsewhere bumps the generation).
 * Taking a new lease revokes the previous agent token and the task repos' write tokens (API.md).
 */
export async function acquireLease(ctx: CommandContext, api: ApiClient, taskId: string, ttlSeconds?: number, force = false): Promise<{ lease: Lease; reused: boolean; replacedStale: boolean }> {
  const stored = await ctx.store.lease(taskId);
  let replacedStale = false;
  if (!force && ttlSeconds === undefined && stored && stored.apiUrl === api.apiUrl && Date.parse(stored.expiresAt) - ctx.io.now().getTime() > LEASE_REUSE_MARGIN_S * 1000) {
    if (await leaseIsCurrent(ctx, api, stored)) return { lease: stored, reused: true, replacedStale };
    replacedStale = true;
    ctx.out.warn(`warning: the stored lease for ${taskId} (generation ${stored.leaseGeneration}) is no longer current; taking a new one.`);
  }
  let raw: unknown;
  try {
    raw = await api.post(`/api/tasks/${encodeURIComponent(taskId)}/lease`, ttlSeconds ? { ttlSeconds } : {});
  } catch (e) {
    if (e instanceof CliError && e.code === "lease_held") throw await leaseHeldError(api, taskId, e);
    throw e;
  }
  const r = LeaseResponseSchema.safeParse(raw);
  if (!r.success) throw new CliError("invalid_response", "unexpected lease response");
  rememberSecret(r.data.leaseToken);
  const lease: Lease = { apiUrl: api.apiUrl, taskId, leaseToken: r.data.leaseToken, leaseGeneration: r.data.leaseGeneration, expiresAt: r.data.expiresAt };
  await ctx.store.saveLease(lease);
  return { lease, reused: false, replacedStale };
}

export async function task(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(
    args,
    {
      title: { type: "string" },
      request: { type: "string" },
      write: { type: "string", multiple: true },
      read: { type: "string", multiple: true },
      ttl: { type: "string" },
      "print-token": { type: "boolean" },
      force: { type: "boolean" },
    },
    TASK_USAGE,
  );
  const sub = positional(p, 0, "subcommand", TASK_USAGE);
  const { api } = await sessionClient(ctx.io, ctx.store, ctx.global.apiUrl);
  switch (sub) {
    case "create": {
      const pid = positional(p, 1, "projectId", TASK_USAGE);
      const title = str(p, "title");
      const writeMounts = list(p, "write");
      if (!title) throw new CliError("invalid_arguments", `--title is required\nusage: ${TASK_USAGE}`, undefined, 2);
      const org = await orgFor(ctx, api);
      // without --write the server picks the folders from the project's access settings
      const body: Record<string, unknown> = { title, ...(writeMounts.length > 0 ? { writeMounts } : {}) };
      if (str(p, "request")) body.request = str(p, "request");
      if (p.values.read !== undefined) body.readMounts = list(p, "read");
      const t = await api.post<{ taskId: string; state: string; workspaces: unknown[] }>(`/api/orgs/${encodeURIComponent(org)}/projects/${encodeURIComponent(pid)}/tasks`, body);
      ctx.out.result(t, `Created ${t.taskId} (${t.state}). Check it out with: cforge checkout ${t.taskId} <dir>`);
      return;
    }
    case "lease": {
      const taskId = positional(p, 1, "taskId", TASK_USAGE);
      const { lease, reused } = await acquireLease(ctx, api, taskId, leaseTtl(int(p, "ttl"), "ttl"), p.values.force === true);
      const show = p.values["print-token"] === true;
      // with the token, also the API it is bound to (CFORGE_LEASE_API_URL for the agent)
      const value = { taskId, leaseGeneration: lease.leaseGeneration, expiresAt: lease.expiresAt, reused, ...(show ? { leaseToken: lease.leaseToken, apiUrl: lease.apiUrl } : {}) };
      // --print-token deliberately bypasses redaction: it hands the lease to an agent process (CFORGE_LEASE_TOKEN)
      if (show) {
        if (ctx.out.json) ctx.io.stdout(`${JSON.stringify(value)}\n`);
        else ctx.io.stdout(`${lease.leaseToken}\n`);
        return;
      }
      ctx.out.result(value, `Lease for ${taskId}: generation ${lease.leaseGeneration}, expires ${lease.expiresAt}${reused ? " (reused)" : ""}.`);
      return;
    }
    case "release": {
      const taskId = positional(p, 1, "taskId", TASK_USAGE);
      await api.json("DELETE", `/api/tasks/${encodeURIComponent(taskId)}/lease`);
      await ctx.store.clearLease(taskId);
      ctx.out.result({ taskId, status: "released" }, `Released the lease on ${taskId}.`);
      return;
    }
    default:
      throw new CliError("invalid_arguments", `unknown subcommand ${sub}\nusage: ${TASK_USAGE}`, undefined, 2);
  }
}
