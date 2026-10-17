/** One organization at a time: `/o/:org`, the remembered org for `/`, and the sidebar org switcher. */
import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FakeApi, FIXTURE_ORG } from "../src/api/fake.js";
import type { Membership } from "../src/api/types.js";
import { orgLabels, pickOrg } from "../src/lib/orgs.js";
import { orgHref, parseRoute } from "../src/lib/router.js";
import { OrgSwitcher } from "../src/primitives/index.js";
import { NoOrgsView, OrgHomeView } from "../src/screens/Home.js";
import { NewOrgView } from "../src/screens/NewOrg.js";
import { ProjectTabs } from "../src/screens/ProjectShell.js";

function renderToString(el: Parameters<typeof render>[0]): string {
  return render(el).replace(/<!-- -->/g, "");
}

const A: Membership = { orgId: "o-aaaa11112222", name: "Demo Client", role: "client" };
const B: Membership = { orgId: "o-f1e688e00ca5", name: "Freeze run 1", role: "client" };
const C: Membership = { orgId: "o-2d4d35786876", name: "Freeze run 1", role: "owner" };

describe("org routes", () => {
  it("/o/:org is one organization's home", () => {
    expect(parseRoute("/o/o-1", "")).toEqual({ name: "org", org: "o-1" });
    expect(parseRoute("/o/o-1/", "")).toEqual({ name: "org", org: "o-1" });
    expect(orgHref("o-1")).toBe("/o/o-1");
    expect(parseRoute(orgHref("o 1/x"), "")).toEqual({ name: "org", org: "o 1/x" });
  });
});

describe("pickOrg", () => {
  it("opens the remembered organization while the caller is still a member", () => {
    expect(pickOrg([A, B], B.orgId)).toBe(B.orgId);
  });
  it("falls back to the first membership when nothing (or a stale org) is remembered", () => {
    expect(pickOrg([A, B], null)).toBe(A.orgId);
    expect(pickOrg([A, B], "o-gone")).toBe(A.orgId);
  });
  it("has nothing to open without memberships", () => {
    expect(pickOrg([], "o-gone")).toBeNull();
  });
});

describe("orgLabels", () => {
  it("names each org, and tells organizations with the same name apart by id", () => {
    const labels = orgLabels([A, B, C]);
    expect(labels.get(A.orgId)).toBe("Demo Client");
    expect(labels.get(B.orgId)).toBe("Freeze run 1 · f1e6");
    expect(labels.get(C.orgId)).toBe("Freeze run 1 · 2d4d");
  });
});

describe("OrgSwitcher", () => {
  it("is not shown with a single organization", () => {
    expect(renderToString(createElement(OrgSwitcher, { memberships: [A], current: A.orgId }))).toBe("");
    expect(renderToString(createElement(OrgSwitcher, { memberships: [], current: "o-x" }))).toBe("");
  });

  it("shows the current org and links to every org's home with the caller's role there", () => {
    const html = renderToString(createElement(OrgSwitcher, { memberships: [A, B, C], current: C.orgId }));
    expect(html).toContain('aria-label="Switch organization (current: Freeze run 1 · 2d4d)"');
    expect(html).toContain("Freeze run 1 · 2d4d");
    expect(html).toContain(`href="/o/${A.orgId}"`);
    expect(html).toContain(`href="/o/${B.orgId}"`);
    expect(html).toContain(`href="/o/${C.orgId}"`);
    expect(html).toContain("Owner");
    expect(html).toContain("Client");
    expect(html).toMatch(/aria-current="true"[^>]*>[\s\S]*?Freeze run 1 · 2d4d/);
  });
});

describe("org home", () => {
  it("lists only that organization's projects, under its name and the caller's role", () => {
    const html = renderToString(
      createElement(OrgHomeView, { membership: A, projects: [{ projectId: "p-1", name: "Customer Portal", createdAt: "2026-10-05T00:00:00.000Z" }] }),
    );
    expect(html).toContain("Demo Client");
    expect(html).toContain("Client");
    expect(html).toContain("Customer Portal");
    expect(html).toContain(`href="/o/${A.orgId}/p/p-1/overview"`);
  });

  it("says when the caller can see no project in the organization", () => {
    const html = renderToString(createElement(OrgHomeView, { membership: A, projects: [] }));
    expect(html).toContain("No projects you can see in this organization.");
  });

  it("owners and developers get a New project form; others don't", () => {
    const closed = renderToString(createElement(OrgHomeView, { membership: A, projects: [], newProject: { busy: false, error: null, onCreate: () => {} } }));
    expect(closed).toContain("New project");
    const withForm = renderToString(createElement(OrgHomeView, { membership: A, projects: [], newProject: { busy: false, error: null, onCreate: () => {}, startOpen: true } }));
    expect(withForm).toContain("New project");
    expect(withForm).toContain("Project name");
    expect(withForm).toContain('value="agent-native" selected=""');
    expect(withForm).toContain('Legacy agency and staging');
    expect(renderToString(createElement(OrgHomeView, { membership: A, projects: [] }))).not.toContain("Project name");
  });

  it("the New project form's Cancel is disabled while it is creating", () => {
    const idle = renderToString(createElement(OrgHomeView, { membership: A, projects: [], newProject: { busy: false, error: null, onCreate: () => {}, onCancel: () => {}, startOpen: true } }));
    expect(idle).toMatch(/<button type="button" class="btn btn-quiet">Cancel<\/button>/);
    const busy = renderToString(createElement(OrgHomeView, { membership: A, projects: [], newProject: { busy: true, error: null, onCreate: () => {}, onCancel: () => {}, startOpen: true } }));
    expect(busy).toMatch(/<button type="button" class="btn btn-quiet" disabled="">Cancel<\/button>/);
  });

  it("the project sidebar carries the switcher at the bottom when there is a second org", () => {
    const one = renderToString(createElement(ProjectTabs, { org: A.orgId, pid: "p-1", active: "files", decisions: 0, memberships: [A] }));
    expect(one).not.toContain("Switch organization");
    const two = renderToString(createElement(ProjectTabs, { org: A.orgId, pid: "p-1", active: "files", decisions: 0, memberships: [A, B] }));
    expect(two).toContain("Switch organization");
    expect(two.indexOf("Switch organization")).toBeGreaterThan(two.indexOf("Activity"));
  });
});

describe("fixture orgs", () => {
  it("the fake can add organizations without projects, so the switcher can be tried", async () => {
    const api = new FakeApi({ extraOrgs: [{ orgId: "o-second0001", name: "Second Client" }] });
    const me = await api.me();
    expect(me.memberships.map((m) => m.orgId)).toEqual([FIXTURE_ORG, "o-second0001"]);
    expect(await api.listProjects("o-second0001")).toEqual([]);
    await expect(api.getProject("o-second0001", "p-x")).rejects.toMatchObject({ status: 404 });
    await expect(api.listProjects("o-unknown")).rejects.toMatchObject({ status: 404 });
  });
});

describe("new organization", () => {
  it("the switcher offers New organization to admins, even with a single org", () => {
    const one = renderToString(createElement(OrgSwitcher, { memberships: [A], current: A.orgId, canCreateOrgs: true }));
    expect(one).toContain('href="/orgs/new"');
    expect(one).toContain("New organization");
    expect(renderToString(createElement(OrgSwitcher, { memberships: [A], current: A.orgId, canCreateOrgs: false }))).toBe("");
    expect(renderToString(createElement(OrgSwitcher, { memberships: [A, B], current: A.orgId }))).not.toContain("New organization");
  });

  it("someone with no orgs is offered to create one only if they may", () => {
    expect(renderToString(createElement(NoOrgsView, { canCreateOrgs: true }))).toContain('href="/orgs/new"');
    expect(renderToString(createElement(NoOrgsView, { canCreateOrgs: false }))).not.toContain("/orgs/new");
  });

  it("the form asks for a name", () => {
    const out = renderToString(createElement(NewOrgView, { busy: false, error: null, onCreate: () => {} }));
    expect(out).toContain("New organization");
    expect(out).toContain("Organization name");
    expect(out).toContain("Create organization");
  });
});
