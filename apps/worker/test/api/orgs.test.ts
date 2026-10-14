import { describe, expect, it } from "vitest";
import { email, harness, member, ownerWithOrg } from "../helpers.js";

describe("orgs, roles and grants", () => {
  it("creator is owner; owner adds members; non-members get 404", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    expect(o.orgId).toMatch(/^o-[0-9a-f]{12}$/);
    const list = await h.api("GET", "/api/orgs", { token: o.token });
    expect(list.body.orgs).toEqual([{ orgId: o.orgId, name: "Demo Client", role: "owner" }]);

    const dev = await member(h, o, "developer");
    const members = await h.api("GET", `/api/orgs/${o.orgId}/members`, { token: dev.token });
    expect(members.status).toBe(200);
    expect(members.body.members.map((m: any) => m.role).sort()).toEqual(["developer", "owner"]);

    const stranger = await h.signIn(email("stranger"));
    expect((await h.api("GET", `/api/orgs/${o.orgId}`, { token: stranger })).status).toBe(404);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/members`, { token: stranger })).status).toBe(404);
    expect((await h.api("GET", `/api/orgs`, {})).status).toBe(401);
  });

  it("only owners manage members; the last owner cannot be demoted or removed", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const dev = await member(h, o, "developer");
    const r = await h.api("POST", `/api/orgs/${o.orgId}/members`, { token: dev.token, body: { email: email("x"), role: "owner" } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("insufficient_role");
    const demote = await h.api("PATCH", `/api/orgs/${o.orgId}/members/${o.userId}`, { token: o.token, body: { role: "developer" } });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe("last_owner");
    expect((await h.api("DELETE", `/api/orgs/${o.orgId}/members/${o.userId}`, { token: o.token })).status).toBe(409);
    const dup = await h.api("POST", `/api/orgs/${o.orgId}/members`, { token: o.token, body: { email: (await h.api("GET", "/api/me", { token: dev.token })).body.user.email, role: "viewer" } });
    expect(dup.status).toBe(409);
    expect((await h.api("DELETE", `/api/orgs/${o.orgId}/members/${dev.userId}`, { token: o.token })).status).toBe(200);
    expect((await h.api("GET", `/api/orgs/${o.orgId}`, { token: dev.token })).status).toBe(404);
  });

  it("an owner archives an org: hidden from every member and closed to the API until an owner unarchives it", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const client = await member(h, o, "client");
    const kept = await h.api("POST", "/api/orgs", { token: o.token, body: { name: "Kept" } });

    const notOwner = await h.api("POST", `/api/orgs/${o.orgId}/archive`, { token: client.token });
    expect(notOwner.status).toBe(403);

    const archived = await h.api("POST", `/api/orgs/${o.orgId}/archive`, { token: o.token });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ orgId: o.orgId, archivedAt: expect.any(String) });

    for (const who of [o, client]) {
      const me = await h.api("GET", "/api/me", { token: who.token });
      expect(me.body.memberships.map((m: any) => m.orgId)).not.toContain(o.orgId);
      const list = await h.api("GET", "/api/orgs", { token: who.token });
      expect(list.body.orgs.map((m: any) => m.orgId)).not.toContain(o.orgId);
      expect((await h.api("GET", `/api/orgs/${o.orgId}`, { token: who.token })).status).toBe(404);
      expect((await h.api("GET", `/api/orgs/${o.orgId}/projects`, { token: who.token })).status).toBe(404);
    }
    expect((await h.api("GET", "/api/me", { token: o.token })).body.memberships.map((m: any) => m.orgId)).toEqual([kept.body.orgId]);
    // archiving again is a no-op that still answers 404 (the org is closed)
    expect((await h.api("POST", `/api/orgs/${o.orgId}/archive`, { token: o.token })).status).toBe(404);

    // only an owner can bring it back; a client of the archived org cannot
    expect((await h.api("POST", `/api/orgs/${o.orgId}/unarchive`, { token: client.token })).status).toBe(404);
    const back = await h.api("POST", `/api/orgs/${o.orgId}/unarchive`, { token: o.token });
    expect(back.status).toBe(200);
    expect(back.body).toEqual({ orgId: o.orgId, archivedAt: null });
    expect((await h.api("GET", "/api/me", { token: client.token })).body.memberships.map((m: any) => m.orgId)).toContain(o.orgId);
    expect((await h.api("GET", `/api/orgs/${o.orgId}/projects`, { token: client.token })).status).toBe(200);
    // unarchiving an org that is not archived, or one the caller does not own, is 404
    expect((await h.api("POST", `/api/orgs/${o.orgId}/unarchive`, { token: o.token })).status).toBe(404);
    const stranger = await h.signIn(email("stranger"));
    expect((await h.api("POST", `/api/orgs/${o.orgId}/unarchive`, { token: stranger })).status).toBe(404);
  });

  it("a client's Can change never becomes a developer's write: promotion keeps read only; re-saving the same role keeps it", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const client = await member(h, o, "client");
    const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Portal" } });
    const scope = { kind: "project", id: p.body.projectId };
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope, operations: ["read", "write"] } })).status).toBe(200);
    const ops = async () => (await h.api("GET", `/api/orgs/${o.orgId}/grants?userId=${client.userId}`, { token: o.token })).body.grants.find((g: any) => g.scope.id === p.body.projectId)?.operations;
    expect((await h.api("PATCH", `/api/orgs/${o.orgId}/members/${client.userId}`, { token: o.token, body: { role: "client" } })).status).toBe(200);
    expect(await ops()).toEqual(["read", "write"]);
    expect((await h.api("PATCH", `/api/orgs/${o.orgId}/members/${client.userId}`, { token: o.token, body: { role: "developer" } })).status).toBe(200);
    expect(await ops()).toEqual(["read"]);
    // and a developer's write never becomes a client's Can change
    expect((await h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId: client.userId, scope, operations: ["read", "write"] } })).status).toBe(200);
    expect((await h.api("PATCH", `/api/orgs/${o.orgId}/members/${client.userId}`, { token: o.token, body: { role: "client" } })).status).toBe(200);
    expect(await ops()).toEqual(["read"]);
  });

  it("viewers can only hold read grants (a client's write is Can change, through tasks); grants on unknown scopes are 404", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const client = await member(h, o, "client");
    const viewer = await member(h, o, "viewer");
    const p = await h.api("POST", `/api/orgs/${o.orgId}/projects`, { token: o.token, body: { name: "Portal" } });
    expect(p.status).toBe(201);
    const write = await h.api("PUT", `/api/orgs/${o.orgId}/grants`, {
      token: o.token,
      body: { userId: viewer.userId, scope: { kind: "project", id: p.body.projectId }, operations: ["read", "write"] },
    });
    expect(write.status).toBe(400);
    expect(write.body.error.code).toBe("grant_exceeds_role");
    const clientWrite = await h.api("PUT", `/api/orgs/${o.orgId}/grants`, {
      token: o.token,
      body: { userId: client.userId, scope: { kind: "project", id: p.body.projectId }, operations: ["read", "write"] },
    });
    expect(clientWrite.status).toBe(200);
    const ok = await h.api("PUT", `/api/orgs/${o.orgId}/grants`, {
      token: o.token,
      body: { userId: client.userId, scope: { kind: "project", id: p.body.projectId }, operations: ["read"] },
    });
    expect(ok.status).toBe(200);
    const missing = await h.api("PUT", `/api/orgs/${o.orgId}/grants`, {
      token: o.token,
      body: { userId: client.userId, scope: { kind: "resource", id: "res-nope" }, operations: ["read"] },
    });
    expect(missing.status).toBe(404);
    const mine = await h.api("GET", `/api/orgs/${o.orgId}/grants`, { token: client.token });
    expect(mine.body.grants).toEqual([expect.objectContaining({ scope: { kind: "project", id: p.body.projectId }, operations: ["read"] })]);
  });
});
