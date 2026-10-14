/**
 * Client view of JSON responses (Task 20 review O-1; AT-25/AT-26): clients and viewers never
 * receive raw revision ids (`art:`, `cand:`, `gh:`, `local:`). An Artifacts revision `art:<repoId>:<sha>` names the canonical
 * repository (`repoId` is part of `ArtifactsCoords`) and its commit; a candidate id
 * `cand:<taskWorkspaceId>:<sha>` names a task repository. For clients and viewers every such id
 * (whole strings and ids embedded in text) becomes a stable opaque label `rev-<16 hex>`, so equality
 * still works on the client (current version, which candidate belongs to which change), and the
 * keys that only describe repositories (`taskWorkspaceId`, `fork`, `treeId`, `sha`) are dropped;
 * a `submitter` is reduced to its kind. Asset manifest ids (`r2m:`) are content hashes, not
 * coordinates, and stay. `x-commonforge-revision` is rewritten the same way.
 *
 * Applied as middleware on `/api/orgs/:org/*` after the route ran, keyed on the caller's role in
 * that org, so no route can forget it. Also on `/api/tasks/*` (keyed on the task's org): in staging
 * mode a client works on their own tasks through those routes (their agent, a lease token, is not a
 * user and keeps the raw ids it needs).
 */
import { sha256HexSync } from "@commonforge-org/core";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../context.js";
import { getRole } from "../services/directory.js";

// art:<repoId>:<sha>, cand:<taskWorkspaceId>:<sha>, gh:<owner>/<repo>:<sha>, local:<repoId>:<sha> (review M-8)
const WHOLE_RE = /^(?:art|cand|gh|local):[A-Za-z0-9._/-]+:[0-9a-f]{7,64}$/;
const EMBEDDED_RE = /\b(?:art|cand|gh|local):[A-Za-z0-9._/-]+:[0-9a-f]{7,64}\b/g;
const DROPPED_KEYS = new Set(["taskWorkspaceId", "fork", "treeId", "sha"]);

export function opaqueRevision(rev: string): string {
  return `rev-${sha256HexSync(`cf.client-revision/1|${rev}`).slice(0, 16)}`;
}

export function clientValue(value: unknown): unknown {
  if (typeof value === "string") return WHOLE_RE.test(value) ? opaqueRevision(value) : value.replace(EMBEDDED_RE, (m) => opaqueRevision(m));
  if (Array.isArray(value)) return value.map(clientValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROPPED_KEYS.has(k)) continue;
      if (k === "submitter" && v && typeof v === "object") {
        out[k] = { kind: (v as { kind?: unknown }).kind };
        continue;
      }
      out[k] = clientValue(v);
    }
    return out;
  }
  return value;
}

export function clientView(orgOf?: (c: Context<AppEnv>) => Promise<string | null>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const p = c.get("principal");
    if (!p || p.kind !== "user") return;
    const org = orgOf ? await orgOf(c) : c.req.param("org");
    if (!org) return;
    const isJson = /^application\/json\b/i.test(c.res.headers.get("content-type") ?? "");
    const revHeader = c.res.headers.get("x-commonforge-revision");
    if (!isJson && !revHeader) return;
    const role = await getRole(c.get("svc").db, org, p.userId);
    if (role !== "client" && role !== "viewer") return;
    const headers = new Headers(c.res.headers);
    const replace = (res: Response) => {
      // Hono's setter copies the old response's headers over the new one; clear it first
      c.res = undefined as never;
      c.res = res;
    };
    if (revHeader) headers.set("x-commonforge-revision", clientValue(revHeader) as string);
    if (!isJson) {
      replace(new Response(c.res.body, { status: c.res.status, headers }));
      return;
    }
    const text = await c.res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      replace(new Response(text, { status: c.res.status, headers }));
      return;
    }
    headers.delete("content-length");
    replace(new Response(JSON.stringify(clientValue(body)), { status: c.res.status, headers }));
  };
}

/** The org of the task named by `/api/tasks/<taskId>/…` (null when there is none). */
export async function taskOrgOf(c: Context<AppEnv>): Promise<string | null> {
  let id: string | undefined;
  try {
    id = decodeURIComponent(new URL(c.req.url).pathname.split("/")[3] ?? "");
  } catch {
    return null;
  }
  if (!id) return null;
  const row = await c.get("svc").db.prepare("SELECT org_id FROM tasks WHERE task_id = ?").bind(id).first<{ org_id: string }>();
  return row?.org_id ?? null;
}
