/**
 * R2 asset change through the Worker's agent asset path, authenticated with the task lease only
 * (API.md "Tasks": `assets/stage` → `PUT assets/upload` → `assets/commit`, then
 * `POST …/workspaces/:ws/freeze {}`). Used for the brand-assets copy of the logo.
 */
import { createHash } from "node:crypto";
import { ApiError, normalizeApiUrl } from "./owner-api.js";

export interface AssetFreeze {
  taskWorkspaceId: string;
  manifestId: string;
  parentManifestId: string;
  path: string;
  sha256: string;
  size: number;
}

export async function leaseRequest<T>(fetchImpl: typeof fetch, apiUrl: string, lease: string, method: string, path: string, body?: unknown, raw?: Uint8Array, contentType?: string): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${lease}`, accept: "application/json" };
  let payload: RequestInit["body"] | undefined;
  if (raw) {
    headers["content-type"] = contentType ?? "application/octet-stream";
    // a Uint8Array body gets its content-length from fetch itself (the upload route requires one)
    payload = raw as unknown as RequestInit["body"];
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetchImpl(`${normalizeApiUrl(apiUrl)}${path}`, { method, headers, redirect: "error", ...(payload !== undefined ? { body: payload } : {}) });
  if (!res.ok) {
    let e: { error?: { code?: string; message?: string } } = {};
    try {
      e = (await res.json()) as typeof e;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, e.error?.code ?? `http_${res.status}`, `${method} ${path}: ${e.error?.message ?? `HTTP ${res.status}`}`);
  }
  return (await res.json()) as T;
}

/** Replace one file in the task's asset workspace and freeze it, with the lease as the only credential. */
export async function replaceAsset(o: { fetchImpl?: typeof fetch; apiUrl: string; lease: string; taskId: string; taskWorkspaceId: string; mountName: string; path: string; bytes: Uint8Array; mime: string }): Promise<AssetFreeze> {
  const f = o.fetchImpl ?? globalThis.fetch;
  const t = encodeURIComponent(o.taskId);
  const sha256 = createHash("sha256").update(o.bytes).digest("hex");
  const staged = await leaseRequest<{ stagingKey: string; uploadUrl: string }>(f, o.apiUrl, o.lease, "POST", `/api/tasks/${t}/assets/stage`, { mountName: o.mountName, path: o.path, size: o.bytes.byteLength, mime: o.mime });
  if (!staged.uploadUrl.startsWith("/api/")) throw new Error(`unexpected upload URL ${staged.uploadUrl}`);
  await leaseRequest(f, o.apiUrl, o.lease, "PUT", staged.uploadUrl, undefined, o.bytes, o.mime);
  const committed = await leaseRequest<{ taskWorkspaceId: string; manifestId: string; parentManifestId: string }>(f, o.apiUrl, o.lease, "POST", `/api/tasks/${t}/assets/commit`, {
    mountName: o.mountName,
    changes: [{ path: o.path, stagingKey: staged.stagingKey, sha256, mime: o.mime }],
  });
  const frozen = await leaseRequest<{ manifestId: string }>(f, o.apiUrl, o.lease, "POST", `/api/tasks/${t}/workspaces/${encodeURIComponent(o.taskWorkspaceId)}/freeze`, {});
  return { taskWorkspaceId: o.taskWorkspaceId, manifestId: frozen.manifestId ?? committed.manifestId, parentManifestId: committed.parentManifestId, path: o.path, sha256, size: o.bytes.byteLength };
}
