import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { codeResource, member } from "../helpers.js";
import { stagingFixture } from "../staging-helpers.js";

/** Run migration 0017's statements again (the test database has all migrations applied already). */
async function migrate0017(): Promise<void> {
  const m = (env.TEST_MIGRATIONS ?? []).find((x: { name: string }) => x.name.startsWith("0017_"));
  if (!m) throw new Error("migration 0017 not found");
  for (const q of m.queries) await env.DB.prepare(q).run();
}

describe("migration 0017: clients keep what they could change", () => {
  it("a client's read grants become Change where a project they have attaches the folder as writable; hidden and read-only folders stay", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const docs = await codeResource(f.h, f.o, "docs", { "README.md": "docs\n" });
    const secret = await codeResource(f.h, f.o, "secret", { "keys.txt": "x\n" });
    for (const m of [
      { mountName: "docs", resourceId: docs.resourceId, operations: ["read"] },
      { mountName: "secret", resourceId: secret.resourceId },
    ])
      expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: m })).status).toBe(201);
    const client = await member(f.h, f.o, "client");
    const viewer = await member(f.h, f.o, "viewer");
    // before 0017: a client held read only (that is all the access screen gave a client)
    for (const who of [client, viewer]) expect((await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: who.userId, level: "read", folders: { [secret.resourceId]: "none" } } })).status).toBe(200);
    const create = () => f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/tasks`, { token: client.token, body: { title: "Footer" } });
    expect((await create()).body.error.code).toBe("no_write_grant");

    await migrate0017();
    const grant = async (userId: string, kind: string, id: string) =>
      (await env.DB.prepare("SELECT operations_json FROM grants WHERE org_id = ? AND user_id = ? AND scope_kind = ? AND scope_id = ?").bind(f.o.orgId, userId, kind, id).first<{ operations_json: string }>())?.operations_json ?? null;
    expect(await grant(client.userId, "project", f.pid)).toBe('["read","write"]');
    expect(await grant(client.userId, "resource", f.api.resourceId)).toBe('["read","write"]');
    expect(await grant(client.userId, "resource", docs.resourceId)).toBe('["read"]');
    expect(await grant(client.userId, "resource", secret.resourceId)).toBeNull();
    expect(await grant(viewer.userId, "project", f.pid)).toBe('["read"]');
    const t = await create();
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(t.body.workspaces.filter((w: { access: string }) => w.access === "write").map((w: { mountName: string }) => w.mountName)).toEqual(["api"]);
    // idempotent
    await migrate0017();
    expect(await grant(client.userId, "resource", docs.resourceId)).toBe('["read"]');
  });
});
