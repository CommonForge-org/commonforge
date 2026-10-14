/** Shared by the LFS server and file change tests (api/lfs.test.ts, api/file-changes.test.ts, security/lfs-staging.test.ts). */
import { sha256Hex } from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { codeResource, harness, ownerWithOrg, projectWith, type Harness } from "../helpers.js";

export const LFS_TYPE = "application/vnd.git-lfs+json";
export const basic = (token: string) => ({ authorization: `Basic ${btoa(`git:${token}`)}` });
export const lfsHeaders = (token: string) => ({ ...basic(token), accept: LFS_TYPE, "content-type": LFS_TYPE });

export const CONFIG_JSON = '{ "title": "Demo" }\n';

/** An owner, a git folder `site` (index.html, config.json) in a project, and a fake runner answering jobs. */
export async function world() {
  const h = harness();
  const runner = new FakeRunner(h);
  const o = await ownerWithOrg(h);
  const site = await codeResource(h, o, "site", { "index.html": "v1", "config.json": CONFIG_JSON });
  const pid = await projectWith(h, o, [{ mountName: "site", resourceId: site.resourceId }]);
  const base = `/api/lfs/${o.orgId}/${site.resourceId}/info/lfs`;
  return { h, o, site, pid, base, runner };
}

/**
 * The browser upload flow (routes/uploads.ts): start, one PUT per part, complete; then (unless
 * `hash: false`) drain the steps so the hash step verifies the object. Returns the staging id.
 */
export async function uploadFile(h: Harness, o: { token: string; orgId: string }, pid: string, path: string, bytes: Uint8Array, opts: { mount?: string; hash?: boolean; mime?: string } = {}): Promise<string> {
  const s = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/folders/${opts.mount ?? "site"}/uploads`, { token: o.token, body: { path, size: bytes.length, mime: opts.mime ?? "application/octet-stream" } });
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  const parts: Array<{ n: number; etag: string }> = [];
  for (let n = 1; n <= s.body.parts; n++) {
    const chunk = bytes.slice((n - 1) * s.body.partSize, n * s.body.partSize);
    const p = await h.api("PUT", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/parts/${n}`, { token: o.token, raw: chunk, headers: { "content-length": String(chunk.length) } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    parts.push({ n, etag: p.body.etag });
  }
  const done = await h.api("POST", `/api/orgs/${o.orgId}/uploads/${s.body.uploadId}/complete`, { token: o.token, body: { parts } });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  if (opts.hash !== false) await h.drainSteps();
  return done.body.stagingId as string;
}

export const batch = (h: Harness, base: string, token: string, operation: "upload" | "download", objects: Array<{ oid: string; size: number }>) =>
  h.api("POST", `${base}/objects/batch`, { headers: lfsHeaders(token), raw: JSON.stringify({ operation, transfers: ["basic"], objects, hash_algo: "sha256" }) });

export const parse = (r: { body: unknown }) => (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as any;

/** Upload `bytes` the way git-lfs does: batch, PUT to R2 (simulated: put at the key), verify, hash. */
export async function lfsUpload(h: Harness, base: string, token: string, bytes: Uint8Array) {
  const oid = await sha256Hex(bytes);
  const b = await batch(h, base, token, "upload", [{ oid, size: bytes.length }]);
  expect(b.status).toBe(200);
  const obj = parse(b).objects[0];
  const href = new URL(obj.actions.upload.href);
  const key = decodeURIComponent(href.pathname.split("/").slice(2).join("/"));
  await env.COMMONFORGE_ASSETS.put(key, bytes);
  const v = await h.api("POST", new URL(obj.actions.verify.href).pathname, { headers: { ...obj.actions.verify.header, "content-type": LFS_TYPE }, raw: JSON.stringify({ oid, size: bytes.length }) });
  expect(v.status).toBe(200);
  await h.drainSteps();
  return { oid, key, obj };
}
