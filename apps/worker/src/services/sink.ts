/**
 * Staging's capture sink (spec 2026-10-07 §6, §8): staging's webhook/email vars point here, so
 * nothing staging sends reaches a real provider. Records only; never forwards. The per-project
 * token is derived (HMAC of the session secret), never stored; D1 keeps its sha256 for lookup.
 *
 * The endpoint is public and unauthenticated, so everything it accepts is bounded: the body is read
 * only up to the cap, header values and the path are clipped, and requests are rate limited per
 * project, per client IP and globally.
 */
import { sha256Hex } from "@commonforge-org/core";
import type { Services } from "../context.js";
import { ApiError } from "../lib/http.js";
import { newId } from "../lib/crypto.js";
import { ipBucket } from "./auth.js";

/** Stored body cap; with {@link KEEP_PER_PROJECT} it bounds a project at about 3.2 MB. */
const MAX_BODY = 16_384;
/** Newest captures kept per project (older rows are deleted on every insert). */
const KEEP_PER_PROJECT = 200;
const MAX_PATH = 2_048;
const MAX_HEADER_VALUE = 2_048;
const DROP = new Set(["x-api-key", "proxy-authorization", "set-cookie"]);
/** Credential-looking header names are never stored. */
const SECRET_HEADER = /(authorization|cookie|token|secret|api-key|apikey|password|session)/;
const dropHeader = (name: string) => {
  const n = name.toLowerCase();
  return DROP.has(n) || SECRET_HEADER.test(n);
};

async function hmac(secret: string, text: string): Promise<string> {
  if (!secret || secret.length < 16) throw new Error("server secret is not configured");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The project's sink token (recomputed, never stored) and its registered lookup hash. */
export async function ensureSink(svc: Services, orgId: string, projectId: string): Promise<string> {
  const token = `snk_${await hmac(svc.env.COMMONFORGE_SESSION_SECRET, `cf.sink/1|${orgId}|${projectId}`)}`;
  await svc.db
    .prepare("INSERT INTO staging_sinks (org_id, project_id, token_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (org_id, project_id) DO UPDATE SET token_hash = excluded.token_hash")
    .bind(orgId, projectId, await sha256Hex(token), svc.nowIso())
    .run();
  return token;
}

/** Read at most {@link MAX_BODY} bytes of the body; the rest is never buffered. */
async function readCapped(req: Request): Promise<{ text: string; truncated: boolean }> {
  if (!req.body) return { text: "", truncated: false };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > MAX_BODY) {
      chunks.push(value.subarray(0, MAX_BODY - size));
      size = MAX_BODY;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { text: new TextDecoder().decode(all), truncated };
}

export async function capture(svc: Services, token: string, req: Request, path: string, clientIp: string | null): Promise<void> {
  const sink = await svc.db.prepare("SELECT org_id, project_id FROM staging_sinks WHERE token_hash = ?").bind(await sha256Hex(token)).first<{ org_id: string; project_id: string }>();
  if (!sink) throw new ApiError(404, "not_found", "unknown sink");
  const gate = svc.env.OPS_GATE.get(svc.env.OPS_GATE.idFromName("ratelimit:sink"));
  const limited = await gate.hit([
    { key: `project:${sink.org_id}:${sink.project_id}`, limit: 120, windowMs: 60_000 },
    { key: `ip:${ipBucket(clientIp)}`, limit: 600, windowMs: 60_000 },
    { key: "global", limit: 2_000, windowMs: 60_000 },
  ]);
  if (!limited.ok) throw new ApiError(429, "rate_limited", "too many captured requests; try again later");
  const { text, truncated } = await readCapped(req);
  const headers = Object.fromEntries([...req.headers.entries()].filter(([k]) => !dropHeader(k)).map(([k, v]) => [k, v.slice(0, MAX_HEADER_VALUE)]));
  await svc.db
    .prepare("INSERT INTO staging_captures (capture_id, org_id, project_id, received_at, method, path, headers_json, body, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(newId("cap", 12), sink.org_id, sink.project_id, svc.nowIso(), req.method, (path || "/").slice(0, MAX_PATH), JSON.stringify(headers), text, truncated ? 1 : 0)
    .run();
  await svc.db
    .prepare(
      "DELETE FROM staging_captures WHERE org_id = ? AND project_id = ? AND capture_id NOT IN (SELECT capture_id FROM staging_captures WHERE org_id = ? AND project_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?)",
    )
    .bind(sink.org_id, sink.project_id, sink.org_id, sink.project_id, KEEP_PER_PROJECT)
    .run();
}

export interface CaptureView {
  captureId: string;
  receivedAt: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export async function listCaptures(svc: Services, orgId: string, projectId: string): Promise<CaptureView[]> {
  const rows = (
    await svc.db
      .prepare("SELECT * FROM staging_captures WHERE org_id = ? AND project_id = ? ORDER BY received_at DESC, rowid DESC LIMIT 100")
      .bind(orgId, projectId)
      .all<{ capture_id: string; received_at: string; method: string; path: string; headers_json: string; body: string; truncated: number }>()
  ).results;
  return rows.map((r) => ({ captureId: r.capture_id, receivedAt: r.received_at, method: r.method, path: r.path, headers: JSON.parse(r.headers_json), body: r.body, truncated: r.truncated === 1 }));
}

/** Captures are kept 7 days. */
export async function sweepCaptures(svc: Services): Promise<void> {
  await svc.db.prepare("DELETE FROM staging_captures WHERE received_at < ?").bind(new Date(svc.now().getTime() - 7 * 86_400_000).toISOString()).run();
}
