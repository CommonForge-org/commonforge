import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FakeApi, FIXTURE_ORG as ORG, FIXTURE_PUBLIC_URL, FIXTURE_PROJECT as PID, FIXTURE_RESOURCES as R } from "../src/api/fake.js";
import type { PersonAccess, ProjectFolder } from "../src/api/types.js";
import { firstCommitFiles, lfsEndpointUrl } from "../src/lib/first-commit.js";
import { codeMessage } from "../src/ui.js";
import { detachImpact, folderNameIssue, folderStatus, FoldersView, setupPollStep, type FoldersViewProps } from "../src/screens/FoldersTab.js";

describe("fake projects and folders (mirrors the worker)", () => {
  it("attaching a folder the project already has is folder_already_attached", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.createProject(ORG, "Intranet");
    await api.attachFolder(ORG, p.projectId, { mountName: "site", resourceId: R.website });
    await expect(api.attachFolder(ORG, p.projectId, { mountName: "site2", resourceId: R.website })).rejects.toMatchObject({ status: 409, code: "folder_already_attached" });
    await expect(api.attachFolder(ORG, p.projectId, { mountName: "site", resourceId: R.api })).rejects.toMatchObject({ code: "mount_exists" });
    expect((await api.listFolders(ORG, p.projectId)).map((x) => x.mountName)).toEqual(["site"]);
  });

  it("detach lowers write to what another project gives (read), and reports the change", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.createProject(ORG, "Intranet");
    await api.attachFolder(ORG, p.projectId, { mountName: "site", resourceId: R.website });
    // Customer Portal gives the developer read; Intranet gives write
    await api.putProjectAccess(ORG, PID, { userId: "u-developer", level: "read" });
    await api.putProjectAccess(ORG, p.projectId, { userId: "u-developer", level: "write" });
    const grants = (api as unknown as { grants: Map<string, string[]> }).grants;
    expect(grants.get(`u-developer|resource|${R.website}`)).toEqual(["read", "write"]);
    expect((await api.detachFolder(ORG, p.projectId, "site")).changed).toEqual(["u-developer"]);
    expect(grants.get(`u-developer|resource|${R.website}`)).toEqual(["read"]);
  });

  it("detach never touches someone without a grant on the project", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.createProject(ORG, "Intranet");
    const f = await api.createFolder(ORG, p.projectId, { name: "media" });
    const grants = (api as unknown as { grants: Map<string, string[]> }).grants;
    // a direct folder grant, no project grant on Intranet
    grants.set(`u-client|resource|${f.resourceId}`, ["read"]);
    expect(grants.has(`u-client|project|${p.projectId}`)).toBe(false);
    expect((await api.detachFolder(ORG, p.projectId, "media")).changed).toEqual([]);
    expect(grants.get(`u-client|resource|${f.resourceId}`)).toEqual(["read"]);
  });

  it("detaching one of two mounts of the same folder in one project keeps access (the other mount counts)", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.createProject(ORG, "Intranet");
    await api.attachFolder(ORG, p.projectId, { mountName: "site", resourceId: R.website });
    await api.putProjectAccess(ORG, PID, { userId: "u-developer", level: "none" });
    await api.putProjectAccess(ORG, p.projectId, { userId: "u-developer", level: "write" });
    // a second mount of the same folder (older data; attachFolder now refuses it)
    const mounts = (api as unknown as { mountsOf(pid: string): Array<Record<string, unknown>> }).mountsOf(p.projectId);
    mounts.push({ ...mounts[0], mountName: "site2" });
    expect((await api.detachFolder(ORG, p.projectId, "site2")).changed).toEqual([]);
    const grants = (api as unknown as { grants: Map<string, string[]> }).grants;
    expect(grants.get(`u-developer|resource|${R.website}`)).toEqual(["read", "write"]);
  });

  it("a new project is listed, opens with no folders, and its creator lands on it", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.createProject(ORG, "Intranet");
    expect((await api.listProjects(ORG)).map((x) => x.name)).toContain("Intranet");
    expect((await api.getProject(ORG, p.projectId)).mounts).toEqual([]);
    expect(await api.listFolders(ORG, p.projectId)).toEqual([]);
    await expect(new FakeApi({ role: "client" }).createProject(ORG, "x")).rejects.toMatchObject({ code: "insufficient_role" });
  });

  it("add folder, attach existing, detach; the client follows the project's access", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.createProject(ORG, "Intranet");
    await api.putProjectAccess(ORG, p.projectId, { userId: "u-client", level: "read" });
    const f = await api.createFolder(ORG, p.projectId, { name: "media" });
    await api.attachFolder(ORG, p.projectId, { mountName: "site", resourceId: R.website });
    await api.listFolders(ORG, p.projectId); // the read that shows it setting up
    const folders = await api.listFolders(ORG, p.projectId);
    expect(folders.map((x) => [x.mountName, x.provider, x.state, x.settingUp])).toEqual([
      ["media", "artifacts", "active", false],
      ["site", "artifacts", "active", false],
    ]);
    expect(folders.find((x) => x.mountName === "site")!.alsoIn.map((x) => x.projectId)).toContain(PID);
    const access = await api.getProjectAccess(ORG, p.projectId);
    // site is held at Can change through Customer Portal (its floor)
    expect(access.find((x) => x.userId === "u-client")!.folders.map((x) => x.level)).toEqual(["read", "write"]);
    await expect(api.createFolder(ORG, p.projectId, { name: "media" })).rejects.toMatchObject({ status: 409, code: "mount_exists" });
    const d = await api.detachFolder(ORG, p.projectId, "media");
    expect(d.changed).toEqual(["u-client"]);
    expect((await api.listFolders(ORG, p.projectId)).map((x) => x.mountName)).toEqual(["site"]);
    expect(f.mountName).toBe("media");
  });

  it("attach and detach are owner-only; developers may add a folder", async () => {
    const api = new FakeApi({ role: "developer" });
    await expect(api.attachFolder(ORG, PID, { mountName: "x", resourceId: R.api })).rejects.toMatchObject({ code: "insufficient_role" });
    await expect(api.detachFolder(ORG, PID, "api")).rejects.toMatchObject({ code: "insufficient_role" });
    expect((await api.createFolder(ORG, PID, { name: "media" })).mountName).toBe("media");
  });

  it("a shared folder keeps its floor from another project, including a new one", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.createProject(ORG, "Intranet");
    await api.attachFolder(ORG, p.projectId, { mountName: "site", resourceId: R.website });
    // u-client may change Customer Portal's folders, so the website is held at Can change through it
    await api.putProjectAccess(ORG, p.projectId, { userId: "u-client", level: "read" });
    await api.putProjectAccess(ORG, p.projectId, { userId: "u-client", level: "none" });
    // the website stays readable through Customer Portal (its floor), not removed with the new project's access
    const portal0 = await api.getProjectAccess(ORG, PID);
    expect(portal0.find((x) => x.userId === "u-client")!.folders.find((x) => x.mountName === "website")!.level).toBe("write");
    // and the other way: Customer Portal sees the new project as the source of a floor on the website
    await api.putProjectAccess(ORG, p.projectId, { userId: "u-client", level: "read" });
    const portal1 = await api.getProjectAccess(ORG, PID);
    expect(portal1.find((x) => x.userId === "u-client")!.folders.find((x) => x.mountName === "website")!).toMatchObject({ level: "write", min: "read" });
    // detaching from the new project leaves the Customer Portal level in place
    await api.putProjectAccess(ORG, p.projectId, { userId: "u-client", level: "read" });
    expect((await api.detachFolder(ORG, p.projectId, "site")).changed).toEqual([]);
    const portal = await api.getProjectAccess(ORG, PID);
    expect(portal.find((x) => x.userId === "u-client")!.folders.find((x) => x.mountName === "website")!.level).toBe("write");
  });

  it("a developer sees only the folders they can read, and only the projects they can read in alsoIn", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.createProject(ORG, "Intranet");
    const q = await api.createProject(ORG, "Private");
    // the developer holds no grant on this new collection, nor on project Intranet or Private
    await api.createFolder(ORG, p.projectId, { name: "media" });
    await api.attachFolder(ORG, p.projectId, { mountName: "site", resourceId: R.website });
    await api.attachFolder(ORG, q.projectId, { mountName: "site", resourceId: R.website });
    const asOwner = await api.listFolders(ORG, p.projectId);
    expect(asOwner.map((x) => x.mountName)).toEqual(["media", "site"]);
    expect(asOwner.find((x) => x.mountName === "site")!.alsoIn.map((x) => x.projectId).sort()).toEqual([PID, q.projectId].sort());
    api.role = "developer";
    const asDev = await api.listFolders(ORG, p.projectId);
    expect(asDev.map((x) => x.mountName)).toEqual(["site"]);
    expect(asDev[0]!.alsoIn.map((x) => x.projectId)).toEqual([PID]);
  });
});

describe("fake: Add folder, one kind (phase 4, mirrors the Worker)", () => {
  const files = async (api: FakeApi, pid: string, mount: string) => (await api.listTree(ORG, pid, { mount, path: "" })).entries.map((e) => e.path);
  const text = async (api: FakeApi, pid: string, mount: string, path: string) => (await api.readFileForEdit(ORG, pid, { mount, path })).text;

  it("a new folder is a git folder, setting up until its first version is bound", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.createProject(ORG, "Intranet");
    const f = await api.createFolder(ORG, p.projectId, { name: "media" });
    const [first] = await api.listFolders(ORG, p.projectId);
    expect(first).toMatchObject({ mountName: "media", resourceId: f.resourceId, provider: "artifacts", state: "empty", settingUp: true });
    // like the Worker: nothing to browse before the first version
    await expect(api.listTree(ORG, p.projectId, { mount: "media", path: "" })).rejects.toMatchObject({ status: 409, code: "no_accepted_head" });
    const [ready] = await api.listFolders(ORG, p.projectId);
    expect(ready).toMatchObject({ state: "active", settingUp: false });
    expect(await files(api, p.projectId, "media")).toEqual([".gitattributes", ".lfsconfig", "README.md"]);
    const lfsUrl = lfsEndpointUrl(FIXTURE_PUBLIC_URL, ORG, f.resourceId);
    for (const x of firstCommitFiles("media", lfsUrl)) expect(await text(api, p.projectId, "media", x.path)).toBe(x.content);
    expect(await text(api, p.projectId, "media", ".lfsconfig")).toBe(`[lfs]\n\turl = ${FIXTURE_PUBLIC_URL}/api/lfs/${ORG}/${f.resourceId}/info/lfs\n`);
    // its first version is genesis: one accepted version, no proposal
    const versions = await api.listVersions(ORG, f.resourceId);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ proposalId: null });
  });

  it("answers copies: changing a listed folder changes nothing in the fake", async () => {
    const api = new FakeApi({ role: "owner" });
    await api.createFolder(ORG, PID, { name: "media" });
    await api.listFolders(ORG, PID);
    const list = await api.listFolders(ORG, PID);
    const m = list.find((x) => x.mountName === "media")!;
    m.state = "failed";
    m.alsoIn.push({ projectId: "p-x", name: "x" });
    expect((await api.listFolders(ORG, PID)).find((x) => x.mountName === "media")).toMatchObject({ state: "active", alsoIn: [] });
  });

  it("kind is ignored (files or code); any other kind and a bad name are invalid_request", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.createProject(ORG, "Intranet");
    await api.createFolder(ORG, p.projectId, { name: "a", kind: "files" } as { name: string });
    await api.createFolder(ORG, p.projectId, { name: "b", kind: "code" } as { name: string });
    await api.listFolders(ORG, p.projectId);
    expect((await api.listFolders(ORG, p.projectId)).map((x) => [x.mountName, x.provider, x.state])).toEqual([
      ["a", "artifacts", "active"],
      ["b", "artifacts", "active"],
    ]);
    await expect(api.createFolder(ORG, p.projectId, { name: "c", kind: "other" } as { name: string })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    for (const name of ["", ".hidden", "a/b", "x".repeat(129)]) await expect(api.createFolder(ORG, p.projectId, { name })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    // 409 mount_exists creates nothing
    const before = (await api.listResources(ORG)).length;
    await expect(api.createFolder(ORG, p.projectId, { name: "a" })).rejects.toMatchObject({ status: 409, code: "mount_exists" });
    expect((await api.listResources(ORG)).length).toBe(before);
  });

  it("a failed setup shows its error, and Try again sets it up", async () => {
    const api = new FakeApi({ role: "owner", folderSetupFails: true });
    const p = await api.createProject(ORG, "Intranet");
    await api.createFolder(ORG, p.projectId, { name: "media" });
    await expect(api.retryFolderSetup(ORG, p.projectId, "media")).rejects.toMatchObject({ status: 409, code: "setup_not_failed" });
    await api.listFolders(ORG, p.projectId);
    const [failed] = await api.listFolders(ORG, p.projectId);
    expect(failed).toMatchObject({ state: "failed", writable: true, settingUp: false, setupFailed: true });
    expect(failed!.error).toMatch(/^Setting up this folder failed/);
    await expect(api.retryFolderSetup(ORG, p.projectId, "nope")).rejects.toMatchObject({ status: 404 });
    expect(await api.retryFolderSetup(ORG, p.projectId, "media")).toEqual({ state: "empty", settingUp: true });
    const [again] = await api.listFolders(ORG, p.projectId);
    expect(again).toMatchObject({ state: "empty", settingUp: true, setupFailed: false });
    expect(again!.error).toBeUndefined();
    const [ready] = await api.listFolders(ORG, p.projectId);
    expect(ready).toMatchObject({ state: "active", writable: true, settingUp: false, setupFailed: false });
    // it fails once only: the next folder sets up
    await api.createFolder(ORG, p.projectId, { name: "docs" });
    await api.listFolders(ORG, p.projectId);
    expect((await api.listFolders(ORG, p.projectId)).find((x) => x.mountName === "docs")).toMatchObject({ state: "active", setupFailed: false });
  });

  it("setupFailed is this folder's own failed setup only: a setting-up, ready or failed-import folder says false", async () => {
    const api = new FakeApi({ role: "owner", folderSetupFails: true });
    await api.createFolder(ORG, PID, { name: "media" });
    const [pending] = (await api.listFolders(ORG, PID)).filter((x) => x.mountName === "media");
    expect(pending).toMatchObject({ settingUp: true, setupFailed: false });
    const list = await api.listFolders(ORG, PID);
    expect(list.find((x) => x.mountName === "media")).toMatchObject({ state: "failed", setupFailed: true });
    for (const f of list.filter((x) => x.mountName !== "media")) expect(f.setupFailed).toBe(false);
    // a folder failed for another reason (an import) is failed without setupFailed
    const res = (api as unknown as { resources: Map<string, { state?: string; error?: string }> }).resources.get(list.find((x) => x.mountName !== "media")!.resourceId)!;
    Object.assign(res, { state: "failed", error: "import failed" });
    const other = (await api.listFolders(ORG, PID)).find((x) => x.mountName !== "media" && x.state === "failed");
    expect(other).toMatchObject({ state: "failed", setupFailed: false, error: "import failed" });
  });

  it("Try again: owners and developers with write on the folder; not clients", async () => {
    const api = new FakeApi({ role: "developer", folderSetupFails: true });
    await api.createFolder(ORG, PID, { name: "media" });
    await api.listFolders(ORG, PID);
    await api.listFolders(ORG, PID);
    api.role = "client";
    await expect(api.retryFolderSetup(ORG, PID, "media")).rejects.toMatchObject({ status: 403 });
    api.role = "developer";
    expect(await api.retryFolderSetup(ORG, PID, "media")).toEqual({ state: "empty", settingUp: true });
  });
});

const html = (el: Parameters<typeof render>[0]) => render(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
const FOLDERS: ProjectFolder[] = [
  { mountName: "website", resourceId: "res-w", resourceName: "Website", provider: "artifacts", state: "active", writable: true, settingUp: false, setupFailed: false, alsoIn: [{ projectId: "p-2", name: "Intranet" }] },
  { mountName: "media", resourceId: "res-m", resourceName: "media", provider: "r2-assets", state: "failed", writable: true, settingUp: false, setupFailed: false, error: "upload failed", alsoIn: [] },
];
const noop = () => {};
const base: FoldersViewProps = {
  org: "o-1",
  pid: "p-1",
  viewerRole: "owner",
  folders: FOLDERS,
  attachable: [{ resourceId: "res-x", name: "requirements", provider: "artifacts" }],
  peopleWithAccess: 2,
  pending: null,
  impact: null,
  busy: false,
  error: null,
  formKey: 0,
  onCreate: noop,
  onAttach: noop,
  onAskDetach: noop,
  onConfirmDetach: noop,
  onCancel: noop,
  writable: [],
  onRetry: noop,
};

describe("FoldersView", () => {
  it("lists state, errors and the other projects, with no kind; owners can detach", () => {
    const out = html(createElement(FoldersView, base));
    expect(out).not.toContain("Code (git)");
    expect(out).not.toContain("role-chip");
    expect(out).toContain("Ready");
    expect(out).toContain(">Failed<");
    expect(out).toContain("upload failed");
    expect(out).toContain("Also in: Intranet");
    expect(out).toContain('aria-label="Detach website"');
    expect(out).toContain('href="/o/o-1/p/p-1/files/add"');
    expect(out).toContain("Attach an existing folder");
    // the attach list names folders only
    expect(out).toContain('<option value="res-x">requirements</option>');
  });

  it("the add form: New folder, placeholder assets, Add folder; no file collection wording", () => {
    const out = html(createElement(FoldersView, base));
    expect(out).toContain('aria-label="New folder"');
    expect(out).toMatch(/<label class="field">New folder<input[^>]*placeholder="assets"/);
    expect(out).toMatch(/<button type="submit"[^>]*>Add folder<\/button>/);
    expect(out).not.toMatch(/file collection/i);
  });

  it("developers can add a folder and import, but not attach or detach", () => {
    const out = html(createElement(FoldersView, { ...base, viewerRole: "developer" }));
    expect(out).toContain('aria-label="New folder"');
    expect(out).not.toContain("Attach an existing folder");
    expect(out).not.toContain("Detach website");
  });

  it("row states: Setting up…, Ready, Setup failed with its error, Empty (a ZIP-planned folder), Importing", () => {
    const row = (f: Partial<ProjectFolder>): ProjectFolder => ({ mountName: "media", resourceId: "res-m", resourceName: "media", provider: "artifacts", state: "empty", writable: true, settingUp: false, setupFailed: false, alsoIn: [], ...f });
    expect(folderStatus(row({ settingUp: true }))).toBe("Setting up…");
    expect(folderStatus(row({ state: "active" }))).toBe("Ready");
    expect(folderStatus(row({ state: "failed", setupFailed: true }))).toBe("Setup failed");
    // a failed import is not a failed setup
    expect(folderStatus(row({ state: "failed" }))).toBe("Failed");
    expect(folderStatus(row({}))).toBe("Empty");
    expect(folderStatus(row({ state: "importing" }))).toBe("Importing");
    const out = html(createElement(FoldersView, { ...base, folders: [row({ settingUp: true })] }));
    expect(out).toContain("Setting up…");
    expect(out).not.toContain("Try again");
  });

  it("Try again on a failed setup: owners, and developers with write on the folder", () => {
    const failed: ProjectFolder = { mountName: "media", resourceId: "res-m", resourceName: "media", provider: "artifacts", state: "failed", writable: true, settingUp: false, setupFailed: true, error: "Setting up this folder failed: boom", alsoIn: [] };
    const owner = html(createElement(FoldersView, { ...base, folders: [failed] }));
    expect(owner).toContain("Setup failed");
    expect(owner).toContain("Setting up this folder failed: boom");
    expect(owner).toMatch(/aria-label="Try again setting up media"[^>]*>Try again<\/button>/);
    expect(html(createElement(FoldersView, { ...base, viewerRole: "developer", folders: [failed], writable: ["media"] }))).toContain("Try again");
    expect(html(createElement(FoldersView, { ...base, viewerRole: "developer", folders: [failed], writable: [] }))).not.toContain("Try again");
    // an active folder offers nothing to retry
    expect(html(createElement(FoldersView, { ...base, folders: [{ ...failed, state: "active", setupFailed: false, error: undefined } as ProjectFolder] }))).not.toContain("Try again");
  });

  it("a failed folder whose setup did not fail (a failed import) shows its error, with no Try again", () => {
    const imp: ProjectFolder = { mountName: "media", resourceId: "res-m", resourceName: "media", provider: "artifacts", state: "failed", writable: true, settingUp: false, setupFailed: false, error: "The import failed: repository not found", alsoIn: [] };
    for (const out of [html(createElement(FoldersView, { ...base, folders: [imp] })), html(createElement(FoldersView, { ...base, viewerRole: "developer", folders: [imp], writable: ["media"] }))]) {
      expect(out).toContain("The import failed: repository not found");
      expect(out).not.toContain("Try again");
    }
  });

  it("a row's state is announced when it changes (Setting up… to Ready)", () => {
    const out = html(createElement(FoldersView, { ...base, folders: [{ ...FOLDERS[0]!, settingUp: true, state: "empty" }] }));
    expect(out).toMatch(/<span class="small muted" aria-live="polite">Setting up…<\/span>/);
  });

  it("setup polling: starts and stops on a read, and a list not read yet (another key) changes nothing", () => {
    // a read that shows a folder setting up starts polling; nothing finished
    expect(setupPollStep(false, true, true)).toEqual({ polling: true, finished: false });
    // a read that shows none: polling stops, and a setup finished (re-read the project)
    expect(setupPollStep(true, true, false)).toEqual({ polling: false, finished: true });
    // no change either way
    expect(setupPollStep(false, true, false)).toEqual({ polling: false, finished: false });
    expect(setupPollStep(true, true, true)).toEqual({ polling: true, finished: false });
    // the list for a new key (another project, another folder) is not in yet: no stop, no spurious "finished"
    expect(setupPollStep(true, false, false)).toEqual({ polling: true, finished: false });
    expect(setupPollStep(false, false, false)).toEqual({ polling: false, finished: false });
  });

  it("Try again on a folder that failed for another reason (an import) says so plainly", () => {
    // the folder list can't tell a failed import from a failed setup: the Worker answers 409 setup_not_failed
    expect(codeMessage("setup_not_failed", "this folder's setup has not failed")).toBe("Only a folder whose setup failed can be set up again. Reload the folder list; a folder whose import failed can be detached and imported again.");
  });

  it("empty list text", () => {
    const owner = html(createElement(FoldersView, { ...base, folders: [] }));
    expect(owner).toContain("This project has no folders yet.");
    expect(owner).toContain("Import the site's code from a public Git repository");
    expect(owner).toMatch(/<a href="[^"]*\/files\/add" class="btn btn-primary btn-small">Import from Git<\/a>/);
    const dev = html(createElement(FoldersView, { ...base, viewerRole: "developer", folders: [] }));
    expect(dev).toContain("the project owner imports existing code");
    expect(dev).not.toContain("Import from Git");
  });

  it("a folder name is checked before sending (MountNameSchema rules)", () => {
    expect(folderNameIssue("assets")).toBeNull();
    expect(folderNameIssue("brand assets")).toBeNull();
    expect(folderNameIssue("")).not.toBeNull();
    expect(folderNameIssue(".hidden")).toMatch(/\./);
    expect(folderNameIssue("a/b")).toMatch(/\//);
    expect(folderNameIssue("x".repeat(129))).toMatch(/128/);
  });

  it("detach asks first, says the folder is kept, and names who loses access", () => {
    const out = html(createElement(FoldersView, { ...base, pending: { mountName: "website", resourceId: "res-w" }, impact: { lose: ["client@customer.example"], narrowed: [{ email: "lead@agency.example", keeps: "read", via: "Intranet" }], keep: [{ email: "dev@agency.example", via: "Intranet" }] } }));
    expect(out).toContain("Detach website from this project?");
    expect(out).toContain("The folder itself is not deleted.");
    expect(out).toContain("These people lose access: client@customer.example.");
    expect(out).toContain("lead@agency.example keeps read (loses write) through Intranet");
    expect(out).toContain("dev@agency.example keeps access through Intranet");
  });

  it("detach with only a narrowing says nobody loses access entirely", () => {
    const out = html(createElement(FoldersView, { ...base, pending: { mountName: "website", resourceId: "res-w" }, impact: { lose: [], narrowed: [{ email: "lead@agency.example", keeps: "read", via: "Intranet" }], keep: [] } }));
    expect(out).toContain("Nobody loses access entirely.");
    expect(out).toContain("lead@agency.example keeps read (loses write) through Intranet");
    expect(html(createElement(FoldersView, { ...base, pending: { mountName: "website", resourceId: "res-w" }, impact: { lose: [], narrowed: [], keep: [] } }))).toContain("Nobody loses access.");
  });

  it("states the Import limits next to Import files", () => {
    for (const viewerRole of ["owner", "developer"] as const) expect(html(createElement(FoldersView, { ...base, viewerRole }))).toContain("Public git URLs only; ZIP plans folders but doesn't fill them yet.");
  });

  it("detachImpact: people with the folder lose it unless another project keeps it", () => {
    const people: PersonAccess[] = [
      { userId: "u-o", email: "owner@a", role: "owner", level: "write", folders: [{ mountName: "website", resourceId: "res-w", level: "write" }] },
      { userId: "u-c", email: "client@c", role: "client", level: "read", folders: [{ mountName: "website", resourceId: "res-w", level: "read" }] },
      { userId: "u-d", email: "dev@a", role: "developer", level: "read", folders: [{ mountName: "website", resourceId: "res-w", level: "read", min: "read", via: "Intranet" }] },
      { userId: "u-n", email: "none@c", role: "viewer", level: "none", folders: [{ mountName: "website", resourceId: "res-w", level: "none" }] },
      // write here, read through Intranet: keeps read, loses write
      { userId: "u-l", email: "lead@a", role: "developer", level: "write", folders: [{ mountName: "website", resourceId: "res-w", level: "write", min: "read", via: "Intranet" }] },
      // write here and write through another project it can't see: keeps write
      { userId: "u-w", email: "writer@a", role: "developer", level: "write", folders: [{ mountName: "website", resourceId: "res-w", level: "write", min: "write" }] },
    ];
    expect(detachImpact(people, "res-w")).toEqual({
      lose: ["client@c"],
      narrowed: [{ email: "lead@a", keeps: "read", via: "Intranet" }],
      keep: [
        { email: "dev@a", via: "Intranet" },
        { email: "writer@a", via: "another project" },
      ],
    });
  });
});

describe("a folder's writable setting", () => {
  it("owners switch each folder between Can be changed and Read-only; others see Read-only as text", () => {
    const folders: ProjectFolder[] = [FOLDERS[0]!, { ...FOLDERS[0]!, mountName: "docs", resourceId: "res-d", writable: false }];
    const owner = html(createElement(FoldersView, { ...base, folders }));
    const sel = (m: string) => owner.match(new RegExp(`aria-label="Changes to ${m}"[\\s\\S]*?</select>`))![0];
    expect(sel("website")).toMatch(/<option value="writable" selected="">Can be changed</);
    expect(sel("docs")).toMatch(/<option value="read-only" selected="">Read-only</);
    expect(owner).toContain('data-testid="folders-writable-note"');
    const dev = html(createElement(FoldersView, { ...base, folders, viewerRole: "developer" }));
    expect(dev).not.toContain("Changes to");
    expect(dev).toContain("Read-only in this project");
  });

  it("the fake mirrors the worker: owner only; read-only takes a client's Can change unless another project still gives it", async () => {
    const api = new FakeApi({ role: "developer" });
    await expect(api.setFolderWritable(ORG, PID, "api", false)).rejects.toMatchObject({ code: "insufficient_role" });
    api.role = "owner";
    const r = await api.setFolderWritable(ORG, PID, "api", false);
    expect(r.changed).toEqual(["u-client"]);
    expect((await api.listFolders(ORG, PID)).find((f) => f.mountName === "api")!.writable).toBe(false);
    const client = (await api.getProjectAccess(ORG, PID)).find((x) => x.userId === "u-client")!;
    expect(client.folders.find((f) => f.mountName === "api")).toMatchObject({ level: "read", readOnly: true });
    // Can change for the project again: the read-only folder stays read
    const after = await api.putProjectAccess(ORG, PID, { userId: "u-client", level: "write" });
    expect(after.folders.find((f) => f.mountName === "api")!.level).toBe("read");
    expect(after.folders.find((f) => f.mountName === "website")!.level).toBe("write");
    await expect(api.setFolderWritable(ORG, PID, "nope", true)).rejects.toMatchObject({ status: 404 });
  });
});
