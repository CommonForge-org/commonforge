import { describe, expect, it } from "vitest";
import { isInstanceAdmin, parseAdminList } from "../../src/services/admins.js";
import { email, harness } from "../helpers.js";

describe("instance admins", () => {
  it("parses emails and @domains, ignoring case, spaces and empty entries", () => {
    expect(parseAdminList(" Owner@Agency.Example, @Example.TEST ,, ")).toEqual(["owner@agency.example", "@example.test"]);
    expect(parseAdminList(undefined)).toEqual([]);
    expect(isInstanceAdmin({ COMMONFORGE_ADMIN_EMAILS: "owner@agency.example" }, "OWNER@agency.example")).toBe(true);
    expect(isInstanceAdmin({ COMMONFORGE_ADMIN_EMAILS: "@example.test" }, "a.b@example.test")).toBe(true);
    // a domain entry matches the whole domain only, never a suffix
    expect(isInstanceAdmin({ COMMONFORGE_ADMIN_EMAILS: "@example.test" }, "a@evil-example.test")).toBe(false);
    expect(isInstanceAdmin({ COMMONFORGE_ADMIN_EMAILS: "@example.test" }, "a@sub.example.test")).toBe(false);
    expect(isInstanceAdmin({ COMMONFORGE_ADMIN_EMAILS: "" }, "a@example.test")).toBe(false);
    expect(isInstanceAdmin({}, "a@example.test")).toBe(false);
  });

  it("only admins create organizations; /api/me says who can", async () => {
    const h = harness();
    const admin = email("admin");
    h.envOverrides.COMMONFORGE_ADMIN_EMAILS = admin;
    const adminToken = await h.signIn(admin);
    const other = await h.signIn(email("client"));

    expect((await h.api("GET", "/api/me", { token: adminToken })).body.canCreateOrgs).toBe(true);
    expect((await h.api("GET", "/api/me", { token: other })).body.canCreateOrgs).toBe(false);

    const refused = await h.api("POST", "/api/orgs", { token: other, body: { name: "Mine" } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("org_create_forbidden");
    expect((await h.api("POST", "/api/orgs", { token: adminToken, body: { name: "Agency client" } })).status).toBe(201);
  });

  it("an organization name cannot carry control characters", async () => {
    const h = harness();
    const admin = email("admin");
    h.envOverrides.COMMONFORGE_ADMIN_EMAILS = admin;
    const token = await h.signIn(admin);
    const r = await h.api("POST", "/api/orgs", { token, body: { name: "Acme\r\nBcc: x@evil.test" } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_request");
    expect((await h.api("POST", "/api/orgs", { token, body: { name: "Acme & Sons" } })).status).toBe(201);
  });

  it("an empty list lets nobody create organizations", async () => {
    const h = harness();
    h.envOverrides.COMMONFORGE_ADMIN_EMAILS = "";
    const token = await h.signIn(email("owner"));
    expect((await h.api("POST", "/api/orgs", { token, body: { name: "X" } })).status).toBe(403);
  });
});
