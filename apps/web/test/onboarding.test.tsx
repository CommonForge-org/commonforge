/** Getting started (usability push): the checklist is read from API state; the view says what to do next. */
import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { FakeApi, FIXTURE_ORG, FIXTURE_PROJECT, seedFixtureBrowser } from "../src/api/fake.js";
import type { PersonAccess, Project, ProjectFolder, PromotionView, ProposalSummary, ReleaseList, StagingView } from "../src/api/types.js";
import { checklistComplete, orgChecklist, projectChecklist, readDismissed, writeDismissed, type ProjectChecklistInput } from "../src/lib/onboarding.js";
import { EditionsPanelView } from "../src/screens/Editions.js";
import { checklistPollMs, GettingStartedView, StagingBaselineNote, TasksIntro } from "../src/screens/GettingStarted.js";
import { OrgHomeView } from "../src/screens/Home.js";
import { loadLive } from "../src/screens/project-data.js";

function renderToString(el: Parameters<typeof render>[0]): string {
  return render(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
}

const ORG = "o-aaaa11112222";
const PID = "p-new";
const EMPTY: ProjectChecklistInput = { org: ORG, pid: PID, project: { mounts: [], policy: { checks: [], contracts: [], rules: [] } }, folders: [], access: [], releases: { releases: [], live: null }, staging: { enabled: false, url: null, current: null, building: false, landings: [] }, tasks: [], promotions: [], proposals: [] };

const folder = (over: Partial<ProjectFolder> = {}): ProjectFolder => ({ mountName: "website", resourceId: "res-1", resourceName: "website", provider: "artifacts", state: "active", writable: true, settingUp: false, setupFailed: false, alsoIn: [], ...over });
const person = (role: PersonAccess["role"], level: PersonAccess["level"], email = `${role}@x.test`): PersonAccess => ({ userId: `u-${role}`, email, role, level, folders: [] });
const LIVE: ReleaseList = { releases: [{ releaseId: "rel-1" } as ReleaseList["releases"][number]], live: { releaseId: "rel-1", acceptedVersionId: "av-1", outputDigest: "d", since: "2026-10-10T12:00:00.000Z" } };
const awaiting: StagingView = { enabled: true, state: "awaiting_baseline", stateText: "Waiting for the owner's first production publish.", baseline: null, url: null, current: null, building: false, landings: [] };
const activeStaging: StagingView = { ...awaiting, state: "active", stateText: null, baseline: { since: "2026-10-10T12:00:00.000Z" } };

const byId = (steps: ReturnType<typeof projectChecklist>) => Object.fromEntries(steps.map((s) => [s.id, s]));

describe("projectChecklist", () => {
  it("a new project: only the organization and the project are done; the next step is to import code from Git", () => {
    const s = byId(projectChecklist(EMPTY));
    expect(Object.keys(s)).toEqual(["org", "project", "code", "release", "publish", "staging", "client", "clientAccess", "task", "live"]);
    expect(s.org!.done && s.project!.done).toBe(true);
    for (const id of ["code", "release", "publish", "staging", "client", "clientAccess", "task", "live"]) expect(s[id]!.done, id).toBe(false);
    expect(s.code!.href).toBe(`/o/${ORG}/p/${PID}/files/add`);
    expect(s.code!.note).toContain("A ZIP creates its folders empty");
    expect(s.release!.href).toBe(`/o/${ORG}/p/${PID}/settings/policy`);
    expect(s.release!.docs?.href).toContain("API.md#releases-task-22");
    expect(s.publish!.note).toBe("Needs the release target first.");
    expect(s.staging!.optional).toBe(true);
    expect(s.client!.href).toBe(`/o/${ORG}/members`);
    expect(s.task!.href).toBe(`/o/${ORG}/p/${PID}/changes`);
    expect(checklistComplete(projectChecklist(EMPTY))).toBe(false);
  });

  it("code counts only a git folder with its first version; a ZIP-planned empty folder is named", () => {
    expect(byId(projectChecklist({ ...EMPTY, folders: [folder({ state: "empty" })] })).code!.done).toBe(false);
    expect(byId(projectChecklist({ ...EMPTY, folders: [folder({ state: "empty" })] })).code!.note).toContain("website is still empty");
    expect(byId(projectChecklist({ ...EMPTY, folders: [folder({ state: "empty", settingUp: true })] })).code!.note).not.toContain("still empty");
    expect(byId(projectChecklist({ ...EMPTY, folders: [folder({ provider: "r2-assets" })] })).code!.done).toBe(false);
    expect(byId(projectChecklist({ ...EMPTY, folders: [folder()] })).code!.done).toBe(true);
    // folders not read (yet): the project's git mounts stand in
    expect(byId(projectChecklist({ ...EMPTY, folders: undefined, project: { mounts: [{ mountName: "w", resourceId: "r", provider: "artifacts", resourceName: "w", mode: "must-match-accepted", operations: ["read"] }] } })).code!.done).toBe(true);
  });

  it("release: a policy release section (or any release); publish: a live release or a staging baseline", () => {
    const withRelease = { ...EMPTY, project: { mounts: [], policy: { checks: [], contracts: [], rules: [], release: {} } } };
    expect(byId(projectChecklist(withRelease)).release!.done).toBe(true);
    expect(byId(projectChecklist(withRelease)).publish!.note).toContain("prepare, approve publishing, then publish");
    expect(byId(projectChecklist({ ...EMPTY, releases: LIVE })).release!.done).toBe(true);
    expect(byId(projectChecklist({ ...EMPTY, releases: LIVE })).publish!.done).toBe(true);
    expect(byId(projectChecklist({ ...EMPTY, staging: activeStaging })).publish!.done).toBe(true);
    const waiting = byId(projectChecklist({ ...EMPTY, staging: awaiting }));
    expect(waiting.staging!.done).toBe(true);
    expect(waiting.publish!.done).toBe(false);
  });

  it("staging on: the task steps point at the Tasks board", () => {
    const s = byId(projectChecklist({ ...EMPTY, staging: activeStaging }));
    expect(s.task!.href).toBe(`/o/${ORG}/p/${PID}/tasks`);
    expect(s.task!.action).toBe("Open Tasks");
  });

  it("client: a client with access to the project; a client member without it is sent to Access", () => {
    expect(byId(projectChecklist({ ...EMPTY, access: [person("owner", "write"), person("client", "read")] })).client!.done).toBe(true);
    const noAccess = byId(projectChecklist({ ...EMPTY, access: [person("client", "none", "ana@client.test")] })).client!;
    expect(noAccess.done).toBe(false);
    expect(noAccess.href).toBe(`/o/${ORG}/p/${PID}/settings/access`);
    expect(noAccess.note).toContain("ana@client.test can't see this project yet");
    // a developer is not a client
    expect(byId(projectChecklist({ ...EMPTY, access: [person("developer", "write")] })).client!.done).toBe(false);
  });

  it("first task and first task live: a task; then a live promotion, or an accepted change published after it", () => {
    const task = { taskId: "t-1", title: "Phone field", state: "ready" as const, changeId: "c-1", createdAt: "2026-10-10T10:00:00.000Z" };
    expect(byId(projectChecklist({ ...EMPTY, tasks: [task] })).task!.done).toBe(true);
    expect(byId(projectChecklist({ ...EMPTY, promotions: [{ state: "live" } as PromotionView] })).live!.done).toBe(true);
    const accepted: ProposalSummary = { proposalId: "prop-1", proposalHash: "h", projectId: PID, changeId: "c-1", state: "accepted", kind: null, updatedAt: "2026-10-10T11:00:00.000Z" };
    expect(byId(projectChecklist({ ...EMPTY, tasks: [task], proposals: [accepted], releases: LIVE })).live!.done).toBe(true);
    // an accepted proposal with no task (an edition sent back, a file change) is not a task live
    expect(byId(projectChecklist({ ...EMPTY, proposals: [accepted], releases: LIVE })).live!.done).toBe(false);
    expect(byId(projectChecklist({ ...EMPTY, tasks: [task], proposals: [{ ...accepted, changeId: "c-edition" }], releases: LIVE })).live!.done).toBe(false);
    // published before the change was accepted: not live yet
    expect(byId(projectChecklist({ ...EMPTY, tasks: [task], proposals: [{ ...accepted, updatedAt: "2026-10-10T13:00:00.000Z" }], releases: LIVE })).live!.done).toBe(false);
    // a staging landing proposal is not a published change
    expect(byId(projectChecklist({ ...EMPTY, tasks: [task], proposals: [{ ...accepted, kind: "staging" }], releases: LIVE })).live!.done).toBe(false);
  });

  it("the folders and access reads poll only while the checklist can show", () => {
    expect(checklistPollMs({ dismissed: false, complete: false })).toBe(10_000);
    expect(checklistPollMs({ dismissed: false, complete: true })).toBeUndefined();
    expect(checklistPollMs({ dismissed: true, complete: false })).toBeUndefined();
  });

  it("complete once every required step is done; staging stays optional", () => {
    const project: Pick<Project, "mounts" | "policy"> = { mounts: [], policy: { checks: [], contracts: [], rules: [], release: {} } };
    const done = projectChecklist({ ...EMPTY, project, folders: [folder()], access: [person("client", "read")], releases: LIVE, tasks: [{ taskId: "t", title: "t", state: "ready", changeId: "c", createdAt: "x" }], promotions: [{ state: "live" } as PromotionView] });
    expect(byId(done).staging!.done).toBe(false);
    expect(checklistComplete(done)).toBe(true);
  });
});

describe("GettingStartedView", () => {
  it("shows the count, marks done steps, and makes the first open required step the primary action", () => {
    const html = renderToString(createElement(GettingStartedView, { steps: projectChecklist(EMPTY), onDismiss: () => {} }));
    expect(html).toContain("Getting started");
    expect(html).toContain("2 of 10 done");
    expect(html).toMatch(/data-testid="gs-org" data-done="true"/);
    expect(html).toMatch(/<a href="\/o\/o-aaaa11112222\/p\/p-new\/files\/add" class="btn btn-small btn-primary">Import from Git<\/a>/);
    expect(html).toMatch(/class="btn btn-small btn-outline">Open Policy<\/a>/);
    expect(html).toContain("optional");
    expect(html).toContain(">Hide<");
    expect(html).toContain('target="_blank"');
  });

  it("the organization's list (no projects) has New project as a button and no Hide", () => {
    const html = renderToString(createElement(GettingStartedView, { steps: orgChecklist(), onAction: { project: () => {} } }));
    expect(html).toMatch(/<button type="button" class="btn btn-small btn-primary">New project<\/button>/);
    expect(html).not.toContain(">Hide<");
    expect(html).toContain("1 of 6 done");
    expect(html).toContain("Opens once the project exists.");
  });

  it("the org Home shows it to owners and developers when there are no projects; clients get a plain empty state", () => {
    const owner = renderToString(createElement(OrgHomeView, { membership: { orgId: ORG, name: "New Client", role: "owner" }, projects: [], newProject: { busy: false, error: null, onCreate: () => {} } }));
    expect(owner).toContain("Getting started");
    expect(owner).not.toContain("No projects you can see");
    // one primary per view: the checklist's New project; the form shows once asked for
    expect(owner.match(/btn-primary/g)?.length).toBe(1);
    expect(owner).not.toContain("Project name");
    const client = renderToString(createElement(OrgHomeView, { membership: { orgId: ORG, name: "New Client", role: "client" }, projects: [] }));
    expect(client).not.toContain("Getting started");
    expect(client).toContain("Your developer gives you access to your project.");
    const withProjects = renderToString(createElement(OrgHomeView, { membership: { orgId: ORG, name: "New Client", role: "owner" }, projects: [{ projectId: "p-1", name: "Site", createdAt: "2026-10-10T10:00:00.000Z" }], newProject: { busy: false, error: null, onCreate: () => {} } }));
    expect(withProjects).not.toContain("Getting started");
  });
});

describe("dismissal", () => {
  const store = new Map<string, string>();
  const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  afterEach(() => {
    store.clear();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("the fixture browser starts with the demo project's checklist hidden, and only that project's", () => {
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    seedFixtureBrowser();
    expect(readDismissed(FIXTURE_ORG, FIXTURE_PROJECT)).toBe(true);
    expect(readDismissed(FIXTURE_ORG, "p-other")).toBe(false);
  });

  it("is remembered per project, and survives storage that throws", () => {
    (globalThis as { localStorage?: unknown }).localStorage = ls;
    expect(readDismissed(ORG, PID)).toBe(false);
    writeDismissed(ORG, PID, true);
    expect(readDismissed(ORG, PID)).toBe(true);
    expect(readDismissed(ORG, "p-other")).toBe(false);
    writeDismissed(ORG, PID, false);
    expect(readDismissed(ORG, PID)).toBe(false);
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
    expect(readDismissed(ORG, PID)).toBe(false);
    expect(() => writeDismissed(ORG, PID, true)).not.toThrow();
  });
});

describe("client path and staging notes", () => {
  it("the Tasks board says staging is always on, why it waits, and what to do on an empty board", () => {
    const dev = renderToString(createElement(TasksIntro, { staging: awaiting, empty: true, role: "owner", org: ORG, pid: PID }));
    expect(dev).toContain("This project uses always-on staging: clients ask for changes as tasks.");
    expect(dev).toMatch(/<a href="\/o\/o-aaaa11112222\/p\/p-new\/settings\/policy">Staging settings<\/a>/);
    expect(dev).toContain("Staging starts after your first production publish.");
    expect(dev).toMatch(/<a href="\/o\/o-aaaa11112222\/p\/p-new\/versions"[^>]*>Publish the current version<\/a>/);
    expect(dev).toContain("No tasks yet.");
    const client = renderToString(createElement(TasksIntro, { staging: activeStaging, empty: false, role: "client", org: ORG, pid: PID }));
    expect(client).toContain("clients ask for changes as tasks");
    expect(client).not.toContain("<a ");
    expect(client).not.toContain("Staging starts after");
    expect(client).not.toContain("No tasks yet.");
    const waitingClient = renderToString(createElement(StagingBaselineNote, { staging: awaiting, role: "client", org: ORG, pid: PID }));
    expect(waitingClient).toContain("Staging starts after your developer's first production publish.");
  });

  it("Client editions say the project has no staging, with the setting that turns it on, and what to do first", () => {
    const project: Project = { projectId: PID, name: "Site", membershipRevision: 1, policyRevision: 1, mounts: [{ mountName: "website", resourceId: "r", provider: "artifacts", resourceName: "website", mode: "must-match-accepted", operations: ["read", "write"] }] };
    const base = { org: ORG, project, clients: [], draft: null, onDraft: () => {}, onCreate: () => {}, onBuild: () => {}, onGrant: () => {}, busy: false, error: null };
    const empty = renderToString(createElement(EditionsPanelView, { ...base, editions: [] }));
    expect(empty).toContain("This project has no staging: clients work on an edition copy and send it back.");
    expect(empty).toMatch(/<a href="\/o\/o-aaaa11112222\/p\/p-new\/settings\/policy">Turn on staging<\/a>/);
    expect(empty).toContain("No editions yet.");
    const one = renderToString(createElement(EditionsPanelView, { ...base, editions: [{ editionId: "e1", name: "Pages", state: "ready", ready: true, files: 3, editable: [], protected: [], canManage: true } as never] }));
    expect(one).toContain("No clients in this organization yet.");
    expect(one).toMatch(/<a href="\/o\/o-aaaa11112222\/members">Invite your client<\/a>/);
  });
});

describe("one primary per view", () => {
  it("with primary={false} the next step is marked but its action is not the page's primary button", () => {
    const html = renderToString(createElement(GettingStartedView, { steps: projectChecklist(EMPTY), primary: false }));
    expect(html).not.toContain("btn-primary");
    expect(html).toMatch(/class="gs-step gs-next" data-testid="gs-code"/);
  });
});

describe("fixture: a brand-new organization (the fake mirrors an empty org)", () => {
  async function checklistOf(api: FakeApi, org: string, pid: string) {
    const project = await api.getProject(org, pid);
    const live = await loadLive(api, org, pid, "owner", { project });
    return byId(projectChecklist({ org, pid, project, folders: await api.listFolders(org, pid), access: await api.getProjectAccess(org, pid), releases: live.releases, staging: live.staging, tasks: live.tasks, promotions: live.promotions, proposals: live.proposals }));
  }

  it("a new org's project starts empty: no demo tasks, proposals, releases, history or policy; importing from Git brings the code in", async () => {
    let now = Date.parse("2026-10-13T10:00:00.000Z");
    const api = new FakeApi({ role: "owner", now: () => now });
    const { orgId } = await api.createOrg("Acme Bakery");
    expect(await api.listProjects(orgId)).toEqual([]);
    const { projectId } = await api.createProject(orgId, "Bakery site");
    expect((await api.listProjects(orgId)).map((p) => p.name)).toEqual(["Bakery site"]);
    // the demo organization does not list it
    expect((await api.listProjects(FIXTURE_ORG)).some((p) => p.projectId === projectId)).toBe(false);
    const project = await api.getProject(orgId, projectId);
    expect(project).toMatchObject({ mounts: [], policyRevision: 0, policy: { checks: [], contracts: [], rules: [] } });
    expect(await api.listResources(orgId)).toEqual([]);
    expect((await api.listEvents(orgId, { projectId })).events).toEqual([]);
    let s = await checklistOf(api, orgId, projectId);
    expect(Object.values(s).filter((x) => x.done).map((x) => x.id)).toEqual(["org", "project"]);

    const { intakeId } = await api.startUrlIntake(orgId, { url: "https://github.com/acme/bakery-site", branch: "main", name: "site", projectId, mountName: "site" });
    now += 5_000;
    expect((await api.getIntake(orgId, intakeId)).state).toBe("completed");
    s = await checklistOf(api, orgId, projectId);
    expect(s.code!.done).toBe(true);
    expect((await api.listResources(orgId)).map((r) => r.name)).toEqual(["site"]);

    // a policy saved here is this project's own: the demo's stays as it was
    const demoBefore = (await api.getProject(FIXTURE_ORG, FIXTURE_PROJECT)).policy;
    await api.putPolicy(orgId, projectId, { checks: [], contracts: [], rules: [], release: { recipe: {} } }, 0);
    expect((await api.getProject(orgId, projectId)).policyRevision).toBe(1);
    expect((await api.getProject(FIXTURE_ORG, FIXTURE_PROJECT)).policy).toEqual(demoBefore);
    expect((await checklistOf(api, orgId, projectId)).release!.done).toBe(true);
    // another organization's project is not reachable from the demo org, and the reverse
    await expect(api.getProject(FIXTURE_ORG, projectId)).rejects.toMatchObject({ status: 404 });
    await expect(api.getProject(orgId, FIXTURE_PROJECT)).rejects.toMatchObject({ status: 404 });
  });

  it("a project created in the demo organization has none of the demo project's tasks or releases", async () => {
    const api = new FakeApi({ role: "owner" });
    const { projectId } = await api.createProject(FIXTURE_ORG, "Intranet");
    expect(await api.listTasks(FIXTURE_ORG, projectId)).toEqual([]);
    expect(await api.listProposals(FIXTURE_ORG, projectId)).toEqual([]);
    expect(await api.listReleases(FIXTURE_ORG, projectId)).toEqual({ releases: [], live: null });
    expect((await api.listEvents(FIXTURE_ORG, { projectId })).events).toEqual([]);
  });
});
