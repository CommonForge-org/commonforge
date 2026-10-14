import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client.js";
import { FakeApi, FIXTURE_ORG as ORG } from "../src/api/fake.js";
import { InviteProjects, MembersView, type MembersViewProps } from "../src/screens/Members.js";

describe("fake members (mirrors the worker)", () => {
  it("owners invite, change roles and remove; the result says whether the email went", async () => {
    const api = new FakeApi({ role: "owner" });
    const r = await api.inviteMember(ORG, { email: "New@Customer.example", role: "client" });
    expect(r).toMatchObject({ email: "new@customer.example", role: "client", invite: "sent" });
    expect((await api.listMembers(ORG)).some((m) => m.userId === r.userId)).toBe(true);
    await api.updateMemberRole(ORG, r.userId, "viewer");
    expect((await api.listMembers(ORG)).find((m) => m.userId === r.userId)?.role).toBe("viewer");
    await api.resendInvite(ORG, r.userId);
    await api.removeMember(ORG, r.userId);
    expect((await api.listMembers(ORG)).some((m) => m.userId === r.userId)).toBe(false);
  });

  it("refuses what the worker refuses", async () => {
    const api = new FakeApi({ role: "owner" });
    await expect(api.inviteMember(ORG, { email: "client@customer.example", role: "client" })).rejects.toMatchObject({ code: "already_member" });
    await expect(api.updateMemberRole(ORG, "u-owner", "developer")).rejects.toMatchObject({ code: "last_owner" });
    await expect(api.removeMember(ORG, "u-owner")).rejects.toMatchObject({ code: "last_owner" });
    const dev = new FakeApi({ role: "developer" });
    expect((await dev.listMembers(ORG)).length).toBeGreaterThan(0);
    await expect(dev.inviteMember(ORG, { email: "x@y.example", role: "client" })).rejects.toMatchObject({ code: "insufficient_role" });
    await expect(new FakeApi({ role: "client" }).listMembers(ORG)).rejects.toMatchObject({ code: "insufficient_role" });
  });

  it("only instance admins create organizations; the new org is the creator's", async () => {
    const admin = new FakeApi({ role: "owner" });
    expect((await admin.me()).canCreateOrgs).toBe(true);
    const o = await admin.createOrg("Second Client");
    expect(o).toMatchObject({ name: "Second Client", role: "owner" });
    expect((await admin.me()).memberships.map((m) => m.orgId)).toContain(o.orgId);
    expect(await admin.listProjects(o.orgId)).toEqual([]);
    const client = new FakeApi({ role: "client" });
    expect((await client.me()).canCreateOrgs).toBe(false);
    await expect(client.createOrg("Mine")).rejects.toMatchObject({ code: "org_create_forbidden" });
  });
});

describe("fake instance-admin flag", () => {
  it("follows the role when the fixture switches it after construction", async () => {
    const api = new FakeApi({ role: "owner" });
    expect((await api.me()).canCreateOrgs).toBe(true);
    api.role = "client";
    expect((await api.me()).canCreateOrgs).toBe(false);
    await expect(api.createOrg("Mine")).rejects.toMatchObject({ code: "org_create_forbidden" });
    // an explicit option is not overridden by the role
    expect((await new FakeApi({ role: "client", canCreateOrgs: true }).me()).canCreateOrgs).toBe(true);
  });
});

const html = (el: Parameters<typeof render>[0]) => render(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
const MEMBERS = [
  { userId: "u-owner", email: "owner@agency.example", role: "owner" as const, since: "2026-09-01T00:00:00.000Z" },
  { userId: "u-client", email: "client@customer.example", role: "client" as const, since: "2026-09-02T00:00:00.000Z" },
];
const noop = () => {};
const base: MembersViewProps = {
  org: "o-1",
  viewerRole: "owner",
  viewerId: "u-owner",
  members: MEMBERS,
  pending: null,
  busy: false,
  error: null,
  notice: null,
  projects: [{ projectId: "p-1", name: "Customer Portal", createdAt: "2026-10-01T00:00:00.000Z" }],
  onInvite: noop,
  onAskRole: noop,
  onAskRemove: noop,
  onConfirm: noop,
  onCancel: noop,
  onResend: noop,
};

describe("MembersView", () => {
  it("the invite form offers each project, so access is given in the same step", () => {
    const out = html(createElement(MembersView, base));
    expect(out).toContain("Give access to projects");
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*>[\s\S]*?Customer Portal/);
  });

  it("the project checklist is disabled while the role is owner; the hint stays", () => {
    const projects = [{ projectId: "p-1", name: "Customer Portal", createdAt: "2026-10-01T00:00:00.000Z" }];
    const owner = html(createElement(InviteProjects, { role: "owner", projects, selected: [], onToggle: noop }));
    expect(owner).toMatch(/<fieldset[^>]*disabled/);
    expect(owner).toContain("Owners already see every project.");
    const client = html(createElement(InviteProjects, { role: "client", projects, selected: [], onToggle: noop }));
    expect(client).not.toMatch(/<fieldset[^>]*disabled/);
  });

  it("a failed access grant after an invite is named", () => {
    const out = html(createElement(MembersView, { ...base, notice: { userId: "u-client", invite: "sent", accessFailed: ["Customer Portal"] } }));
    expect(out).toContain("Couldn't give access to Customer Portal.");
  });

  it("owners see Invite, a role control per person and Remove; the last owner's controls are disabled with the reason", () => {
    const out = html(createElement(MembersView, base));
    expect(out).toContain('href="/o/o-1/members/u-client"');
    expect(out).toContain("Invite");
    expect(out).toContain("client@customer.example");
    expect(out).toContain('aria-label="Role of client@customer.example"');
    expect(out).toContain('aria-label="Remove client@customer.example"');
    expect(out).toMatch(/aria-label="Role of owner@agency.example"[^>]*disabled/);
    expect(out).toContain("The only owner");
  });

  it("developers see a read-only list", () => {
    const out = html(createElement(MembersView, { ...base, viewerRole: "developer", viewerId: "u-dev" }));
    expect(out).toContain("client@customer.example");
    expect(out).not.toContain("Invite");
    expect(out).not.toContain("Remove client@customer.example");
    expect(out).not.toContain("<select");
  });

  it("a role change asks first and says what follows", () => {
    const out = html(createElement(MembersView, { ...base, pending: { kind: "role", userId: "u-client", role: "developer" } }));
    expect(out).toContain("Make client@customer.example a developer?");
    const demote = html(
      createElement(MembersView, {
        ...base,
        members: [...MEMBERS, { userId: "u-dev", email: "dev@agency.example", role: "developer" as const }],
        pending: { kind: "role", userId: "u-dev", role: "client" },
      }),
    );
    expect(demote).toContain("removes their write access and ends any agent tasks they are running");
  });

  it("remove asks first; a failed invite email is named with a Resend action", () => {
    expect(html(createElement(MembersView, { ...base, pending: { kind: "remove", userId: "u-client" } }))).toContain("Remove client@customer.example from this organization?");
    const out = html(createElement(MembersView, { ...base, notice: { userId: "u-client", invite: "failed" } }));
    expect(out).toContain("Added, but the invite email didn't send.");
    expect(out).toContain("Resend invite");
  });

  it("a resend that worked says so, without offering Resend again", () => {
    const out = html(createElement(MembersView, { ...base, notice: { userId: "u-client", invite: "resent" } }));
    expect(out).toContain("Invite sent again.");
    expect(out).not.toContain("Added.");
    expect(out).not.toContain("Resend invite");
  });

  it("a failed confirmed action shows its error inside the open sheet, not above the table", () => {
    const error = new ApiError(409, "last_owner", "last owner");
    const out = html(createElement(MembersView, { ...base, pending: { kind: "remove", userId: "u-client" }, error }));
    const friendly = "An organization needs at least one owner.";
    const title = out.indexOf("Remove client@customer.example from this organization?");
    expect(title).toBeGreaterThan(-1);
    expect(out.indexOf(friendly)).toBeGreaterThan(title);
    expect(out.split(friendly).length - 1).toBe(1);
    // with nothing pending (an invite error) it stays above the table
    const top = html(createElement(MembersView, { ...base, error }));
    expect(top.indexOf(friendly)).toBeGreaterThan(-1);
    expect(top.indexOf(friendly)).toBeLessThan(top.indexOf("<table"));
  });
});
