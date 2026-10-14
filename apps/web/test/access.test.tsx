import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FakeApi, FIXTURE_EMPTY_PROJECT as PID2, FIXTURE_ORG as ORG, FIXTURE_PROJECT as PID, FIXTURE_RESOURCES as R } from "../src/api/fake.js";
import { ApiError } from "../src/api/client.js";
import type { PersonAccess } from "../src/api/types.js";
import { accessPayload } from "../src/screens/AccessRow.js";
import { PersonView } from "../src/screens/Person.js";
import { AccessView } from "../src/screens/ProjectSettings.js";
import { ProjectTabs } from "../src/screens/ProjectShell.js";
import { errorMessage } from "../src/ui.js";

describe("fake project access (mirrors the worker)", () => {
  it("lists every member with their level; owners are write", async () => {
    const api = new FakeApi({ role: "owner" });
    const people = await api.getProjectAccess(ORG, PID);
    const by = Object.fromEntries(people.map((p) => [p.userId, p.level]));
    // the fixture's client may change the project's folders ("Can change")
    expect(by).toMatchObject({ "u-owner": "write", "u-developer": "write", "u-client": "write" });
    expect(people.find((p) => p.userId === "u-client")!.folders.map((f) => f.mountName)).toContain("api");
  });

  it("owners set levels and folder exceptions; the rules refuse what the worker refuses", async () => {
    const api = new FakeApi({ role: "owner" });
    const after = await api.putProjectAccess(ORG, PID, { userId: "u-client", level: "read", folders: { [R.api]: "none" } });
    expect(after.folders.find((f) => f.resourceId === R.api)!.level).toBe("none");
    expect(after.folders.find((f) => f.resourceId === R.website)!.level).toBe("read");
    // a client may hold Can change, as a project level or per folder
    const change = await api.putProjectAccess(ORG, PID, { userId: "u-client", level: "write", folders: { [R.api]: "read" } });
    expect([change.level, change.folders.find((f) => f.resourceId === R.api)!.level, change.folders.find((f) => f.resourceId === R.website)!.level]).toEqual(["write", "read", "write"]);
    await expect(api.putProjectAccess(ORG, PID, { userId: "u-client", level: "read", folders: { [R.api]: "write" } })).rejects.toMatchObject({ code: "folder_exceeds_project" });
    await expect(api.putProjectAccess(ORG, PID, { userId: "u-owner", level: "read" })).rejects.toMatchObject({ code: "owner_access_implicit" });
    await expect(api.putProjectAccess(ORG, PID, { userId: "u-client", level: "read", folders: { "res-x": "none" } })).rejects.toMatchObject({ code: "unknown_folder" });
  });

  it("developers only raise someone from none to read", async () => {
    const api = new FakeApi({ role: "owner" });
    await api.putProjectAccess(ORG, PID, { userId: "u-client", level: "none" });
    api.role = "developer";
    expect((await api.putProjectAccess(ORG, PID, { userId: "u-client", level: "read" })).level).toBe("read");
    await expect(api.putProjectAccess(ORG, PID, { userId: "u-client", level: "none" })).rejects.toMatchObject({ code: "grant_owner_only" });
    api.role = "client";
    await expect(api.getProjectAccess(ORG, PID)).rejects.toMatchObject({ code: "insufficient_role" });
  });

  it("no access to the project ends the person's grants on its editions", async () => {
    const api = new FakeApi({ role: "client" });
    expect((await api.listEditions(ORG, PID)).length).toBeGreaterThan(0);
    api.role = "owner";
    await api.putProjectAccess(ORG, PID, { userId: "u-client", level: "none" });
    api.role = "client";
    expect(await api.listEditions(ORG, PID)).toEqual([]);
  });

  it("people come sorted by email, like the worker", async () => {
    const api = new FakeApi({ role: "owner" });
    const emails = (await api.getProjectAccess(ORG, PID)).map((p) => p.email);
    expect(emails).toEqual([...emails].sort());
  });

  it("a shared folder is never narrowed below what another project gives, and is marked as held through it", async () => {
    const api = new FakeApi({ role: "owner" });
    const website = (await api.getProject(ORG, PID)).mounts.find((m) => m.resourceId === R.website)!;
    (api as unknown as { handoverMounts: unknown[] }).handoverMounts.push({ ...website });
    // the developer holds write on Customer Portal (fixture); read on the handover keeps website at write
    const after = await api.putProjectAccess(ORG, PID2, { userId: "u-developer", level: "read" });
    expect(after.level).toBe("read");
    expect(after.folders.find((f) => f.resourceId === R.website)).toMatchObject({ level: "write", min: "write", shared: true, via: "Customer Portal" });
    expect((await api.getProjectAccess(ORG, PID)).find((p) => p.userId === "u-developer")!.level).toBe("write");
    // Customer Portal lowered to read: the handover may now take website down to read (the floor), not below
    await api.putProjectAccess(ORG, PID, { userId: "u-developer", level: "read" });
    await api.putProjectAccess(ORG, PID2, { userId: "u-developer", level: "write" });
    const lowered = await api.putProjectAccess(ORG, PID2, { userId: "u-developer", level: "read", folders: { [R.website]: "none" } });
    const f = lowered.folders.find((x) => x.resourceId === R.website)!;
    expect(f).toMatchObject({ level: "read", min: "read" });
    expect(f.shared).toBeUndefined();
  });

  it("edition grants end only on a real move to none", async () => {
    const api = new FakeApi({ role: "owner" });
    await api.putProjectAccess(ORG, PID, { userId: "u-client", level: "none" });
    await api.grantEdition(ORG, (await api.listEditions(ORG, PID))[0]!.editionId, "u-client");
    await api.putProjectAccess(ORG, PID, { userId: "u-client", level: "none" });
    api.role = "client";
    expect((await api.listEditions(ORG, PID)).length).toBeGreaterThan(0);
  });

  it("a developer sees only the folders they can read, for every person", async () => {
    const api = new FakeApi({ role: "owner" });
    await api.putProjectAccess(ORG, PID, { userId: "u-developer", level: "write", folders: { [R.api]: "none" } });
    api.role = "developer";
    for (const p of await api.getProjectAccess(ORG, PID)) expect(p.folders.map((f) => f.resourceId)).not.toContain(R.api);
    api.role = "owner";
    for (const p of await api.getProjectAccess(ORG, PID)) expect(p.folders.map((f) => f.resourceId)).toContain(R.api);
  });
});

const html = (el: Parameters<typeof render>[0]) => render(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
const PEOPLE: PersonAccess[] = [
  { userId: "u-owner", email: "owner@agency.example", role: "owner", level: "write", folders: [{ mountName: "api", resourceId: "res-a", level: "write" }] },
  { userId: "u-client", email: "client@customer.example", role: "client", level: "read", folders: [{ mountName: "api", resourceId: "res-a", level: "none" }] },
  { userId: "u-new", email: "new@customer.example", role: "viewer", level: "none", folders: [{ mountName: "api", resourceId: "res-a", level: "none" }] },
];
const noop = () => {};

describe("AccessView", () => {
  it("owners get a level control per person, folder controls, and Full (owner) for owners", () => {
    const out = html(createElement(AccessView, { viewerRole: "owner", people: PEOPLE, busyUser: null, error: null, onSave: noop }));
    expect(out).toContain("Full (owner)");
    expect(out).toContain('aria-label="Access of client@customer.example"');
    expect(out).toContain('aria-label="Access of client@customer.example to api"');
    expect(out).not.toContain('aria-label="Access of owner@agency.example"');
    // a client can't be offered Read + write
    expect(out).toMatch(/aria-label="Access of client@customer.example"[\s\S]*?<\/select>/);
    const clientSelect = out.match(/aria-label="Access of client@customer.example"[\s\S]*?<\/select>/)![0];
    expect(clientSelect).not.toContain("Read + write");
  });

  it("developers see levels read-only, with Give read access only for people who have none", () => {
    const out = html(createElement(AccessView, { viewerRole: "developer", people: PEOPLE, busyUser: null, error: null, onSave: noop }));
    expect(out).not.toContain("<select");
    expect(out).toContain('aria-label="Give read access to new@customer.example"');
    expect(out).not.toContain('aria-label="Give read access to client@customer.example"');
  });

  it("the project sidebar shows Settings only when asked (owners and developers)", () => {
    const off = html(createElement(ProjectTabs, { org: "o-1", pid: "p-1", active: "files", decisions: 0 }));
    expect(off).not.toContain("Settings");
    const on = html(createElement(ProjectTabs, { org: "o-1", pid: "p-1", active: "settings", decisions: 0, showSettings: true }));
    expect(on).toContain('href="/o/o-1/p/p-1/settings/access"');
  });
});

describe("PersonView", () => {
  it("lists every project with the person's access, labelled by project name", () => {
    const client = PEOPLE[1]!;
    const out = html(
      createElement(PersonView, {
        viewerRole: "owner",
        member: { userId: client.userId, email: client.email, role: client.role },
        projects: [
          { projectId: "p-1", name: "Customer Portal", access: client },
          { projectId: "p-2", name: "Agency handover", access: { ...client, level: "none", folders: [] } },
        ],
        busyProject: null,
        error: null,
        onSave: noop,
      }),
    );
    expect(out).toContain("client@customer.example");
    expect(out).toContain('aria-label="Access of Customer Portal"');
    expect(out).toContain('aria-label="Access of Agency handover"');
  });

  it("with no projects to list, says so without claiming the organization has none", () => {
    const client = PEOPLE[1]!;
    const out = html(createElement(PersonView, { viewerRole: "developer", member: { userId: client.userId, email: client.email, role: client.role }, projects: [], busyProject: null, error: null, onSave: noop }));
    expect(out).toContain("No projects to show.");
    expect(out).not.toContain("no projects yet");
  });
});

describe("access copy", () => {
  it("grant_owner_only tells the reader to ask an owner", () => {
    expect(errorMessage(new ApiError(403, "grant_owner_only", "developers can only give read access to someone who has none"))).toBe("Only an owner can make this change. Ask an owner to do it.");
  });
});

const DEV: PersonAccess = {
  userId: "u-dev",
  email: "dev@agency.example",
  role: "developer",
  level: "read",
  folders: [
    { mountName: "site", resourceId: "res-s", level: "write", min: "write", shared: true, via: "Customer Portal" },
    { mountName: "docs", resourceId: "res-d", level: "none" },
    { mountName: "api", resourceId: "res-a", level: "read" },
  ],
};

describe("AccessRow: a client's levels", () => {
  it("offers Can change, Read only and No access, for the project and per folder, with what each means", () => {
    const client: PersonAccess = { userId: "u-c", email: "ana@client.example", role: "client", level: "write", folders: [{ mountName: "website", resourceId: "res-w", level: "write" }, { mountName: "api", resourceId: "res-a", level: "read" }] };
    const out = html(createElement(AccessView, { viewerRole: "owner", people: [client], busyUser: null, error: null, onSave: noop }));
    const level = out.match(/aria-label="Access of ana@client.example"[\s\S]*?<\/select>/)![0];
    expect([...level.matchAll(/<option value="([a-z]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]])).toEqual([
      ["none", "No access"],
      ["read", "Read only"],
      ["write", "Can change"],
    ]);
    const api = out.match(/aria-label="Access of ana@client.example to api"[\s\S]*?<\/select>/)![0];
    expect(api).toContain("Same as project (Can change)");
    expect(api).toMatch(/<option value="read"[^>]*>Read only</);
    expect(api).toMatch(/<option value="none"[^>]*>No access</);
    expect(out).toContain("the change goes to staging for review");
  });

  it("a folder that is read-only in the project reads Read only for a client with Can change, and can still be hidden", () => {
    const client: PersonAccess = { userId: "u-c", email: "ana@client.example", role: "client", level: "write", folders: [{ mountName: "docs", resourceId: "res-d", level: "read", readOnly: true }] };
    const out = html(createElement(AccessView, { viewerRole: "owner", people: [client], busyUser: null, error: null, onSave: noop }));
    expect(out).toContain("Read only (the folder is read-only in this project)");
    expect(out).not.toContain('aria-label="Access of ana@client.example to docs"');
    expect(out).toContain('aria-label="Hide docs from ana@client.example"');
  });
});

describe("AccessRow: folders held through another project", () => {
  it("renders a shared folder as fixed text with the other project, never as a select", () => {
    const out = html(createElement(AccessView, { viewerRole: "owner", people: [DEV], busyUser: null, error: null, onSave: noop }));
    expect(out).toContain("Read + write (through Customer Portal)");
    expect(out).not.toContain('aria-label="Access of dev@agency.example to site"');
    expect(out).toContain('aria-label="Access of dev@agency.example to docs"');
  });

  it("a shared folder without a visible project name says another project", () => {
    const p: PersonAccess = { ...DEV, folders: [{ mountName: "site", resourceId: "res-s", level: "write", min: "write", shared: true }] };
    const out = html(createElement(AccessView, { viewerRole: "owner", people: [p], busyUser: null, error: null, onSave: noop }));
    expect(out).toContain("Read + write (through another project)");
  });

  it("N3: a folder with a floor below the project level stays editable, but offers nothing below the floor", () => {
    const p: PersonAccess = { ...DEV, level: "write", folders: [{ mountName: "site", resourceId: "res-s", level: "write", min: "read" }] };
    const out = html(createElement(AccessView, { viewerRole: "owner", people: [p], busyUser: null, error: null, onSave: noop }));
    const select = out.match(/aria-label="Access of dev@agency.example to site"[\s\S]*?<\/select>/)![0];
    expect(select).toContain('value="read"');
    expect(select).not.toContain('value="none"');
    expect(out).not.toContain("(through");
    expect(accessPayload(p, "write", { "res-s": "none" })).toEqual({});
    expect(accessPayload(p, "write", { "res-s": "read" })).toEqual({ "res-s": "read" });
  });

  it("N4: an unshared folder above the project level stays editable (narrowed to the level on save)", () => {
    const above: PersonAccess = { ...DEV, folders: [{ mountName: "x", resourceId: "res-x", level: "write" }] };
    const out = html(createElement(AccessView, { viewerRole: "owner", people: [above], busyUser: null, error: null, onSave: noop }));
    expect(out).toContain('aria-label="Access of dev@agency.example to x"');
    expect(accessPayload(above, "read", { "res-x": "none" })).toEqual({ "res-x": "none" });
    expect(accessPayload(above, "read", {})).toEqual({});
  });

  it("the save payload leaves out fixed folders and exceptions not below the level", () => {
    expect(accessPayload(DEV, "read", { "res-s": "none", "res-d": "none" })).toEqual({ "res-d": "none" });
    // lowering the level drops exceptions that are no longer below it
    const w: PersonAccess = { ...DEV, level: "write", folders: [{ mountName: "api", resourceId: "res-a", level: "read" }] };
    expect(accessPayload(w, "read", { "res-a": "read" })).toEqual({});
    expect(accessPayload(w, "write", { "res-a": "read" })).toEqual({ "res-a": "read" });
    expect(accessPayload(w, "none", { "res-a": "none" })).toEqual({});
  });
});
