/**
 * Spec §10 security suite for LFS: no unaccepted object reaches a client or viewer; agents write
 * only inside their task's write workspaces and read only their own task's unaccepted objects;
 * presigned URLs name one key and expire within an hour.
 */
import { sha256Hex } from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/context.js";
import { getLfsObject, promoteObjects } from "../../src/services/lfs-store.js";
import { codeResource, harness, member, ownerWithOrg, provisionedTask } from "../helpers.js";
import { basic, batch, lfsHeaders, lfsUpload, parse, world, LFS_TYPE } from "../lfs/lfs-helpers.js";

const bytesOf = (s: string) => new TextEncoder().encode(s);

describe("LFS staging security", () => {
  it("an unaccepted object never reaches a client or a viewer; accepting it does", async () => {
    const { h, o, base, pid } = await world();
    const client = await member(h, o, "client");
    const viewer = await member(h, o, "viewer");
    for (const m of [client, viewer]) {
      expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: m.userId, level: "read" } })).status).toBe(200);
    }
    const bytes = bytesOf("secret draft");
    const { oid, key } = await lfsUpload(h, base, o.token, bytes);
    for (const m of [client, viewer]) {
      const r = await batch(h, base, m.token, "download", [{ oid, size: bytes.length }]);
      expect(r.status).toBe(200);
      const d = parse(r);
      expect(d.objects).toHaveLength(1);
      expect(d.objects[0].error.code).toBe(404);
      const direct = await h.api("GET", `${base}/objects/${oid}`, { headers: basic(m.token) });
      expect(direct.status).toBe(404);
    }
    const svc = createServices(env, h.deps);
    await promoteObjects(svc, o.orgId, [key.split("/").pop()!]);
    for (const m of [client, viewer]) {
      const r = await batch(h, base, m.token, "download", [{ oid, size: bytes.length }]);
      expect(r.status).toBe(200);
      const d = parse(r);
      expect(d.objects).toHaveLength(1);
      expect(d.objects[0].error).toBeUndefined();
      expect(d.objects[0].actions.download).toBeTruthy();
      const direct = await h.api("GET", `${base}/objects/${oid}`, { headers: basic(m.token) });
      expect(direct.status).toBe(200);
      expect(direct.body).toBe("secret draft");
    }
  });

  it("agents: upload only into their write workspace, 404 elsewhere, and read only their own unaccepted objects", async () => {
    const h = harness();
    const { o, web, api, taskId } = await provisionedTask(h);
    const lease = await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} });
    expect(lease.status).toBe(200);
    const agent = lease.body.leaseToken as string;
    const base = `/api/lfs/${o.orgId}/${web.resourceId}/info/lfs`;

    // a user's unaccepted object in the task's own write workspace
    const userBytes = bytesOf("uploaded by the user");
    const user = await lfsUpload(h, base, o.token, userBytes);
    // the agent uploads its own
    const agentBytes = bytesOf("uploaded by the agent");
    const mine = await lfsUpload(h, base, agent, agentBytes);
    const svc = createServices(env, h.deps);
    const row = await getLfsObject(svc, o.orgId, mine.key.split("/").pop()!);
    expect(row?.task_id).toBe(taskId);

    // cannot download an unaccepted object a user uploaded, can download its own
    const d1 = parse(await batch(h, base, agent, "download", [{ oid: user.oid, size: userBytes.length }]));
    expect(d1.objects[0].error.code).toBe(404);
    expect((await h.api("GET", `${base}/objects/${user.oid}`, { headers: basic(agent) })).status).toBe(404);
    const d2 = parse(await batch(h, base, agent, "download", [{ oid: mine.oid, size: agentBytes.length }]));
    expect(d2.objects[0].actions.download).toBeTruthy();
    const got = await h.api("GET", `${base}/objects/${mine.oid}`, { headers: basic(agent) });
    expect(got.body).toBe("uploaded by the agent");

    // the read-only reference mount is not writable by the agent
    const apiBase = `/api/lfs/${o.orgId}/${api.resourceId}/info/lfs`;
    expect([403, 404]).toContain((await batch(h, apiBase, agent, "upload", [{ oid: "a".repeat(64), size: 1 }])).status);
    // a folder outside the task's workspaces
    const other = await codeResource(h, o, "other", { "x.txt": "x" });
    const otherBase = `/api/lfs/${o.orgId}/${other.resourceId}/info/lfs`;
    expect((await batch(h, otherBase, agent, "upload", [{ oid: "a".repeat(64), size: 1 }])).status).toBe(404);
    expect((await batch(h, otherBase, agent, "download", [{ oid: "a".repeat(64), size: 1 }])).status).toBe(404);
    // a lease for another org
    const o2 = await ownerWithOrg(h, "Other Org");
    expect((await batch(h, `/api/lfs/${o2.orgId}/${web.resourceId}/info/lfs`, agent, "download", [])).status).toBe(404);
  });

  it("an agent whose workspace is no longer writable cannot upload or call locks/verify, may still read; an abandoned one sees nothing", async () => {
    const h = harness();
    const { o, web, taskId } = await provisionedTask(h);
    const base = `/api/lfs/${o.orgId}/${web.resourceId}/info/lfs`;
    const agent = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} })).body.leaseToken as string;
    const mine = await lfsUpload(h, base, agent, bytesOf("kept"));
    const svc = createServices(env, h.deps);
    const setState = (state: string) => svc.db.prepare("UPDATE task_workspaces SET state = ? WHERE task_id = ? AND resource_id = ?").bind(state, taskId, web.resourceId).run();
    await setState("frozen");
    expect((await batch(h, base, agent, "upload", [{ oid: "a".repeat(64), size: 1 }])).status).toBe(403);
    expect((await h.api("POST", `${base}/locks/verify`, { headers: lfsHeaders(agent), raw: "{}" })).status).toBe(403);
    expect((await h.api("POST", `${base}/verify`, { headers: lfsHeaders(agent), raw: JSON.stringify({ oid: mine.oid, size: 4 }) })).status).toBe(403);
    expect(parse(await batch(h, base, agent, "download", [{ oid: mine.oid, size: 4 }])).objects[0].actions.download).toBeTruthy();
    await setState("abandoned");
    expect((await batch(h, base, agent, "download", [])).status).toBe(404);
  });

  it("an agent of task A cannot download task B's unaccepted object for the same oid", async () => {
    const h = harness();
    const { o, web, pid, taskId } = await provisionedTask(h);
    const base = `/api/lfs/${o.orgId}/${web.resourceId}/info/lfs`;
    const a = (await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} })).body.leaseToken as string;
    const t2 = await h.api("POST", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, {
      token: o.token,
      body: { title: "second", request: "again", writeMounts: ["website"] },
    });
    expect(t2.status).toBe(201);
    await h.drainSteps();
    const b = (await h.api("POST", `/api/tasks/${t2.body.taskId}/lease`, { token: o.token, body: {} })).body.leaseToken as string;
    const bytes = bytesOf("same bytes, two tasks");
    const up = await lfsUpload(h, base, b, bytes);
    const d = parse(await batch(h, base, a, "download", [{ oid: up.oid, size: bytes.length }]));
    expect(d.objects[0].error.code).toBe(404);
    expect((await h.api("GET", `${base}/objects/${up.oid}`, { headers: basic(a) })).status).toBe(404);
    const own = parse(await batch(h, base, b, "download", [{ oid: up.oid, size: bytes.length }]));
    expect(own.objects[0].actions.download).toBeTruthy();
  });

  it("every presigned upload URL names exactly the row's key, expires within an hour and only creates (if-none-match: * signed)", async () => {
    const { h, o, base, site } = await world();
    const objs = [
      { oid: "1".repeat(64), size: 10 },
      { oid: "2".repeat(64), size: 4_000_000_000 },
    ];
    const r = parse(await batch(h, base, o.token, "upload", objs));
    for (const obj of r.objects) {
      const u = new URL(obj.actions.upload.href);
      const stagingId = u.pathname.split("/").pop()!;
      expect(u.pathname).toBe(`/${env.COMMONFORGE_ASSETS_BUCKET}/org/${o.orgId}/lfs/${site.resourceId}/obj/${stagingId}`);
      expect(Number(u.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(3600);
      expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host;if-none-match");
      const row = await getLfsObject(createServices(env, h.deps), o.orgId, stagingId);
      expect(row?.r2_key).toBe(`org/${o.orgId}/lfs/${site.resourceId}/obj/${stagingId}`);
    }
  });

  it("a verify by another user for someone else's upload is refused and the row stays uploading", async () => {
    const { h, o, base, pid } = await world();
    const dev = await member(h, o, "developer");
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/access`, { token: o.token, body: { userId: dev.userId, level: "write" } })).status).toBe(200);
    const bytes = bytesOf("owner's bytes");
    const oid = await sha256Hex(bytes);
    const b = parse(await batch(h, base, o.token, "upload", [{ oid, size: bytes.length }])).objects[0];
    const key = decodeURIComponent(new URL(b.actions.upload.href).pathname.split("/").slice(2).join("/"));
    await env.COMMONFORGE_ASSETS.put(key, bytes);
    const v = await h.api("POST", `${base}/verify`, { headers: { ...basic(dev.token), "content-type": LFS_TYPE }, raw: JSON.stringify({ oid, size: bytes.length }) });
    expect([404, 422]).toContain(v.status);
    expect((await getLfsObject(createServices(env, h.deps), o.orgId, key.split("/").pop()!))?.state).toBe("uploading");
  });
});
