/**
 * UX-3: the "Add files" intake screen and "Publish this version" after a restore. Fake API
 * behaviour (fixture mode, which the capture uses) and server-rendered views.
 */
import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { handoverZip, storedZip } from "../e2e/handover-zip.js";
import { ApiError } from "../src/api/client.js";
import { FakeApi, fakePlacementPlan, fakeResolveIncludes, FIXTURE_EMPTY_PROJECT as EMPTY, FIXTURE_ORG as ORG, FIXTURE_PROJECT as PID, FIXTURE_PROPOSALS as P, FIXTURE_RESOURCES as R, zipListing } from "../src/api/fake.js";
import type { IntakeView, Mount, ReleaseList, ReleaseView, ResourceDetail, VersionEntry } from "../src/api/types.js";
import { parseRoute } from "../src/lib/router.js";
import { attestSentence, confirmResult, exclusionKind, folderName, groupExclusions, includeTarget, intakeErrorSentence, intakePosition, InventoryView, isFolderName, nameFromUrl, placementSentence, ResultView } from "../src/screens/Intake.js";
import { deployWithKey, isRetryable, publishBadge, publishPosition, publishTarget, PublishVersion, PublishVersionView, releaseMounts, RETRY_DELAYS_MS, versionNumberLabel, withRetry, type PublishVersionViewProps } from "../src/screens/PublishVersion.js";
import { ReleaseControls } from "../src/screens/ReleasePanels.js";

const noop = () => {};
const html = (el: Parameters<typeof render>[0]) => render(el).replace(/<!-- -->/g, "");

function clock(start = Date.parse("2026-10-06T12:00:00.000Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ApiError ? e.code : String(e);
  }
}

const zipBlob = (buf: Buffer) => new Blob([new Uint8Array(buf)], { type: "application/zip" });

async function inventoried(api: FakeApi, c: ReturnType<typeof clock>) {
  const { intakeId } = await api.startZipIntake(ORG, zipBlob(handoverZip()), "agency-handover.zip");
  expect((await api.getIntake(ORG, intakeId)).state).toBe("inventorying");
  c.advance(api.intakeMs);
  return api.getIntake(ORG, intakeId);
}

describe("route", () => {
  it("parses /files/add with and without an intake", () => {
    expect(parseRoute("/o/o1/p/p1/files/add", "")).toEqual({ name: "intake", org: "o1", pid: "p1" });
    expect(parseRoute("/o/o1/p/p1/files/add", "?intake=in-1")).toEqual({ name: "intake", org: "o1", pid: "p1", intakeId: "in-1" });
    expect(parseRoute("/o/o1/p/p1/files", "")).toMatchObject({ name: "project", tab: "files" });
  });
});

describe("fake intake (fixture mode)", () => {
  it("lists a ZIP from its central directory, with claimed sizes and path escapes", () => {
    const l = zipListing(new Uint8Array(storedZip({ "a/b.txt": "hi", "film.mp4": { claim: 50_000_000 }, "../x": "no", "dir/": "" })))!;
    expect(l.entries).toEqual([
      { path: "a/b.txt", size: 2 },
      { path: "film.mp4", size: 50_000_000 },
    ]);
    expect(l.rejected).toEqual([{ path: "../x", reason: "path_escape" }]);
    expect(zipListing(new TextEncoder().encode("not a zip at all, definitely"))).toBeNull();
  });

  it("plans like the Worker: one code resource per top-level folder, media and big files to R2, reasons for every exclusion", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now });
    const i = await inventoried(api, c);
    expect(i.state).toBe("inventoried");
    // the Worker lists every excluded file: 38 of the 54 are two nested repositories' .git metadata
    expect(i.inventory?.files).toBe(54);
    expect(i.plan!.placements.map((p) => [p.resourceName, p.provider])).toEqual([
      ["api", "artifacts"],
      ["requirements", "artifacts"],
      ["website", "artifacts"],
      ["agency-handover-assets", "r2-assets"],
    ]);
    const reasons = Object.fromEntries(i.plan!.excluded.map((e) => [e.path, e.reason]));
    expect(reasons["website/.env"]).toMatch(/credential/);
    expect(reasons["website/.npmrc"]).toMatch(/credential/);
    expect(i.plan!.excluded.filter((e) => /nested repository/.test(e.reason))).toHaveLength(38);
    expect(reasons["api/.git/HEAD"]).toMatch(/nested repository/);
    expect(reasons["website/node_modules/react/index.js"]).toMatch(/dependency/);
    expect(reasons["website/dist/index.html"]).toMatch(/build output/);
  });

  it("an unreadable upload fails the check with a reason; clients cannot start an intake", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now });
    const { intakeId } = await api.startZipIntake(ORG, new Blob(["definitely not a zip archive"]), "x.zip");
    c.advance(api.intakeMs);
    const i = await api.getIntake(ORG, intakeId);
    expect(i.state).toBe("failed");
    expect(i.error).toMatch(/not a readable ZIP/);
    api.role = "client";
    expect(await code(api.startZipIntake(ORG, zipBlob(handoverZip()), "a.zip"))).toBe("insufficient_role");
  });

  it("confirm into the empty project creates resources and mounts and says population is pending; skip is honoured", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now });
    expect((await api.getProject(ORG, EMPTY)).mounts).toEqual([]);
    const i = await inventoried(api, c);
    const r = await api.confirmIntake(ORG, i.intakeId, { projectId: EMPTY, skip: ["requirements"] });
    expect(r.pendingPopulation).toBe(true);
    expect(r.resources.map((x) => [x.name, x.mountName])).toEqual([
      ["api", "api"],
      ["website", "website"],
      ["agency-handover-assets", "agency-handover-assets"],
    ]);
    const project = await api.getProject(ORG, EMPTY);
    expect(project.name).toBe("Agency handover");
    expect(project.mounts.map((m) => m.mountName)).toEqual(["api", "website", "agency-handover-assets"]);
    // the populated project is untouched
    expect((await api.getProject(ORG, PID)).mounts.some((m) => m.mountName === "agency-handover-assets")).toBe(false);
    const code1 = await api.getResource(ORG, r.resources[0]!.resourceId);
    expect(code1.state).toBe("empty");
    expect(code1.head).toBeNull();
    // like the Worker: an empty git folder cannot be browsed yet
    expect(await code(api.listTree(ORG, EMPTY, { mount: "api", path: "" }))).toBe("no_accepted_head");
    expect((await api.getResource(ORG, r.resources[2]!.resourceId)).state).toBe("active");
    expect((await api.listTree(ORG, EMPTY, { mount: "agency-handover-assets", path: "" })).entries).toEqual([]);
    expect((await api.getSnapshot(ORG, EMPTY)).entries.map((e) => e.mountName)).toEqual(["agency-handover-assets"]);
    expect(confirmResult(await api.getIntake(ORG, i.intakeId))?.resources).toHaveLength(3);
    expect(await code(api.confirmIntake(ORG, i.intakeId, {}))).toBe("intake_not_ready");
    // nothing else lives in the empty project
    expect(await api.listProposals(ORG, EMPTY)).toEqual([]);
    expect((await api.listReleases(ORG, EMPTY)).releases).toEqual([]);
  });

  it("like the Worker: a taken folder name is refused before anything is created, and adding folders is owner-only", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now });
    const i = await inventoried(api, c);
    const err = await api.confirmIntake(ORG, i.intakeId, { projectId: PID }).catch((e: ApiError) => e);
    expect((err as ApiError).code).toBe("mount_exists");
    expect((err as ApiError).details?.names).toEqual(["api", "requirements", "website"]);
    expect((await api.getIntake(ORG, i.intakeId)).state).toBe("inventoried");
    api.role = "developer";
    expect(await code(api.confirmIntake(ORG, i.intakeId, { projectId: EMPTY }))).toBe("insufficient_role");
    expect(await code(api.startUrlIntake(ORG, { url: "https://github.com/a/b.git", branch: "main", name: "b", projectId: EMPTY, mountName: "b" }))).toBe("insufficient_role");
    api.role = "owner";
    const ok = await api.confirmIntake(ORG, i.intakeId, { projectId: PID, skip: ["api", "requirements", "website"] });
    expect(ok.resources.map((r) => r.mountName)).toEqual(["agency-handover-assets"]);
    expect(await code(api.startUrlIntake(ORG, { url: "https://github.com/a/website.git", branch: "main", name: "website", projectId: PID, mountName: "website" }))).toBe("mount_exists");
  });

  it("include anyway, like the Worker: only blocked-by-name files whose part is added, owners only; recorded on the plan and in an owner-only event", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now });
    const i = await inventoried(api, c);
    // a dependency folder's file, a nested repository's file, a placed file and an unknown path are refused, by path
    const bad = await api.confirmIntake(ORG, i.intakeId, { projectId: EMPTY, include: ["website/.npmrc", "website/node_modules/react/index.js", "website/dist/index.html", "api/.git/HEAD", "website/index.html", "nope"] }).catch((e: ApiError) => e);
    expect((bad as ApiError).code).toBe("include_refused");
    expect((bad as ApiError).details?.paths).toEqual(["website/node_modules/react/index.js", "website/dist/index.html", "api/.git/HEAD", "website/index.html", "nope"]);
    // a skipped part has nowhere to put the file
    const skipped = await api.confirmIntake(ORG, i.intakeId, { projectId: EMPTY, skip: ["website"], include: ["website/.npmrc"] }).catch((e: ApiError) => e);
    expect((skipped as ApiError).details?.paths).toEqual(["website/.npmrc"]);
    api.role = "developer";
    expect(await code(api.confirmIntake(ORG, i.intakeId, { include: ["website/.npmrc"] }))).toBe("insufficient_role");
    api.role = "owner";
    expect((await api.getIntake(ORG, i.intakeId)).state).toBe("inventoried");

    const r = await api.confirmIntake(ORG, i.intakeId, { projectId: EMPTY, include: ["website/.npmrc"] });
    expect(r.includedAnyway).toEqual(["website/.npmrc"]);
    const after = await api.getIntake(ORG, i.intakeId);
    expect(after.plan?.includedAnyway).toEqual([{ path: "website/.npmrc", resourceName: "website" }]);
    expect(r.excluded).toBe(after.plan!.excluded.length - 1);
    const ev = (await api.listEvents(ORG, {})).events.find((e) => e.action === "intake.included_anyway");
    expect(ev?.detail?.paths).toEqual(["website/.npmrc"]);
    expect(ev?.projectId).toBeNull();
    expect((await api.listEvents(ORG, { projectId: EMPTY })).events.map((e) => e.action)).not.toContain("intake.included_anyway");
    api.role = "developer";
    expect((await api.listEvents(ORG, {})).events.map((e) => e.action)).not.toContain("intake.included_anyway");
    // the choice on the intake itself is owner-only too
    const devView = await api.getIntake(ORG, i.intakeId);
    expect(devView.plan?.includedAnyway).toBeUndefined();
    expect(confirmResult(devView)?.includedAnyway).toBeUndefined();
  });

  it("like the Worker: a path with any other exclusion row is never includable; folder exclusions ignore case; role and include before mount checks", async () => {
    const plan = fakePlacementPlan(
      {
        entries: [
          { path: "web/index.html", size: 1 },
          { path: "web/.env", size: 1 },
          { path: "web/.GIT/.env", size: 1 },
          { path: "web/NODE_MODULES/.npmrc", size: 1 },
          { path: "Build/x.js", size: 1 },
          { path: "constructor/a.ts", size: 1 },
        ],
        rejected: [{ path: "web/.env", reason: "duplicate" }],
      },
      "x.zip",
    );
    const reasons = Object.fromEntries(plan.excluded.map((e) => [e.path, e.reason]));
    expect(reasons["web/.GIT/.env"]).toMatch(/nested repository/);
    expect(reasons["web/NODE_MODULES/.npmrc"]).toMatch(/dependency/);
    expect(reasons["Build/x.js"]).toBe("build output");
    expect(plan.placements.map((p) => p.resourceName)).toEqual(["constructor", "web"]);
    const listing = { entries: [{ path: "web/.env", size: 1 }, { path: "web/.GIT/.env", size: 1 }, { path: "web/NODE_MODULES/.npmrc", size: 1 }], rejected: [] };
    expect(fakeResolveIncludes(plan, listing, plan.placements, ["web/.env", "web/.GIT/.env", "web/NODE_MODULES/.npmrc"]).refused.map((r) => r.why)).toEqual(["not_secret_name", "not_secret_name", "not_secret_name"]);
    // the view offers no checkbox for the duplicate
    const intake: IntakeView = { intakeId: "in-1", kind: "zip", state: "inventoried", request: {}, plan, createdAt: "", updatedAt: "" };
    const out = html(createElement(InventoryView, { intake, projectName: "P", skip: [], existing: [], onToggle: noop, onConfirm: noop, busy: false, error: null, startOverHref: "/x", include: [], onInclude: noop }));
    expect(out).not.toContain("Include web/.env anyway");
    // order: a developer's include is refused (403) even when a folder name is also taken
    const c = clock();
    const api = new FakeApi({ now: c.now });
    const i = await inventoried(api, c);
    api.role = "developer";
    expect(await code(api.confirmIntake(ORG, i.intakeId, { projectId: PID, include: ["website/.npmrc"] }))).toBe("insufficient_role");
    api.role = "owner";
    expect(await code(api.confirmIntake(ORG, i.intakeId, { projectId: PID, include: ["website/.env", "nope"] }))).toBe("include_refused");
  });

  it("a public URL import binds a first version and mounts it; other URLs are refused", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now });
    expect(await code(api.startUrlIntake(ORG, { url: "http://github.com/a/b.git", branch: "main", name: "b" }))).toBe("invalid_url");
    expect(await code(api.startUrlIntake(ORG, { url: "https://user:pw@github.com/a/b.git", branch: "main", name: "b" }))).toBe("invalid_url");
    const s = await api.startUrlIntake(ORG, { url: "https://github.com/agency/portal-docs.git", branch: "main", name: "portal-docs", projectId: PID, mountName: "portal-docs" });
    expect((await api.getResource(ORG, s.resourceId)).state).toBe("importing");
    c.advance(api.intakeMs);
    const i = await api.getIntake(ORG, s.intakeId);
    expect(i.state).toBe("completed");
    const res = await api.getResource(ORG, s.resourceId);
    expect(res.state).toBe("active");
    expect(res.head?.revisionId).toMatch(/^art:/);
    expect((await api.getProject(ORG, PID)).mounts.some((m) => m.mountName === "portal-docs")).toBe(true);
    expect(await api.listVersions(ORG, s.resourceId)).toHaveLength(1);
  });
});

describe("intake views", () => {
  it("groups exclusions by reason and collapses folders", () => {
    const plan = fakePlacementPlan(zipListing(new Uint8Array(handoverZip()))!, "agency-handover.zip");
    const groups = groupExclusions(plan.excluded);
    expect(groups.map((g) => [g.kind, g.files])).toEqual([
      ["secret", 2],
      ["nested", 38],
      ["dependency", 3],
      ["build", 1],
    ]);
    // UX-6: one row per nested repository, named by its folder; the files stay behind a disclosure
    const nested = groups.find((g) => g.kind === "nested")!.items;
    expect(nested.map((i) => [i.label, i.files, i.note])).toEqual([
      ["api/", 26, "nested repository (26 files): import by URL to keep its history"],
      ["requirements/", 12, "nested repository (12 files): import by URL to keep its history"],
    ]);
    expect(nested[0]!.paths).toContain("api/.git/HEAD");
    expect(groups.find((g) => g.kind === "dependency")!.items.map((i) => [i.label, i.files, i.note])).toEqual([["website/node_modules/", 3, "dependency folder (3 files): reinstalled from the lockfile"]]);
    // UX-6: a blocked file says what it may hold, not that it "looks like a credential file"
    expect(groups[0]!.items.map((i) => [i.label, i.note])).toEqual([
      ["website/.env", "may contain passwords or API keys"],
      ["website/.npmrc", "may contain a registry token"],
    ]);
    expect(groupExclusions([{ path: ".git/HEAD", reason: "nested repository metadata" }])[0]!.items[0]!.label).toBe("(archive root)/");
    expect(exclusionKind("refused by inventory: path_escape")).toBe("refused");
    expect(placementSentence(plan.placements[0]!)).toMatch(/top-level folder api becomes its own code repository/);
    expect(placementSentence(plan.placements[3]!)).toMatch(/over 32 MB stay out of Git/);
  });

  it("the inventory shows placements, reasons, a blocked-secret chip and one Confirm; taken names warn", () => {
    const plan = fakePlacementPlan(zipListing(new Uint8Array(handoverZip()))!, "agency-handover.zip");
    const intake: IntakeView = { intakeId: "in-1", kind: "zip", state: "inventoried", request: { filename: "agency-handover.zip", size: 1 }, plan, inventory: { files: 54 }, createdAt: "", updatedAt: "" };
    const out = html(createElement(InventoryView, { intake, projectName: "Customer Portal", skip: ["api"], existing: ["api"], onToggle: noop, onConfirm: noop, busy: false, error: null, startOverHref: "/x" }));
    expect(out).toContain('data-testid="intake-inventory"');
    expect(out).toContain('data-testid="intake-confirm"');
    expect(out).toContain("Add to Customer Portal");
    expect(out).toContain("54 files checked, nothing run");
    expect(out).toContain("2 files that may contain secrets blocked");
    expect(out).toContain("may contain a registry token");
    expect(out).not.toContain("looks like a credential file");
    // the rehearsal's 84-of-111-lines finding: each nested repository (and node_modules, dist) is one
    // row, its files behind a disclosure
    expect((out.match(/data-testid="intake-excluded-folder"/g) ?? []).length).toBe(4);
    expect(out).toContain("nested repository (26 files): import by URL to keep its history");
    expect(out).toMatch(/<details><summary><code>api\/<\/code>/);
    expect(out).not.toMatch(/<details open/);
    expect(out).toContain("The contents were not read and are never shown");
    expect(out).toContain("This project already has a folder named api, so this part cannot be added here");
    expect(out).toContain("Add 3 resources to Customer Portal?");
    // said before Confirm, not only after
    expect(out).toContain("the new folders start empty");
    expect(out).not.toContain("sk_live");
  });

  it("include anyway: owner rows on blocked-by-name files only, the attestation gates Confirm", () => {
    const plan = fakePlacementPlan(zipListing(new Uint8Array(handoverZip()))!, "agency-handover.zip");
    const intake: IntakeView = { intakeId: "in-1", kind: "zip", state: "inventoried", request: { filename: "agency-handover.zip", size: 1 }, plan, inventory: { files: 54 }, createdAt: "", updatedAt: "" };
    const base = { intake, projectName: "Agency handover", skip: [], existing: [], onToggle: noop, onConfirm: noop, busy: false, error: null, startOverHref: "/x" };
    // no include props (not an owner): no controls
    expect(html(createElement(InventoryView, base))).not.toContain("intake-include-anyway");
    const none = html(createElement(InventoryView, { ...base, include: [], onInclude: noop }));
    // one checkbox per blocked file (.env and .npmrc), none on folders
    expect((none.match(/data-testid="intake-include-anyway"/g) ?? []).length).toBe(2);
    expect(none).toContain('aria-label="Include website/.npmrc anyway"');
    expect(none).not.toContain("intake-include-attest");
    expect(none).not.toMatch(/data-testid="intake-confirm"[^>]*disabled/);
    const ticked = html(createElement(InventoryView, { ...base, include: ["website/.npmrc"], onInclude: noop, attested: false, onAttest: noop }));
    expect(ticked).toContain('data-testid="intake-include-attest"');
    expect(ticked).toContain(attestSentence(1));
    expect(ticked).toContain("Includes website/.npmrc at your request, in website");
    expect(ticked).toMatch(/<button[^>]*disabled=""[^>]*data-testid="intake-confirm"|<button[^>]*data-testid="intake-confirm"[^>]*disabled=""/);
    const attested = html(createElement(InventoryView, { ...base, include: ["website/.npmrc"], onInclude: noop, attested: true, onAttest: noop }));
    expect(attested).not.toMatch(/data-testid="intake-confirm"[^>]*disabled/);
    // the part is unticked: the file cannot be included, and is not sent
    const off = html(createElement(InventoryView, { ...base, skip: ["website"], include: ["website/.npmrc"], onInclude: noop }));
    expect(off).toContain("nothing in its folder is being added");
    expect(off).not.toContain("intake-include-attest");
    expect(includeTarget("website/.npmrc", plan.placements)).toBe("website");
    expect(includeTarget(".env", plan.placements)).toBeNull();
    expect(attestSentence(2)).toBe("I have inspected these files and they contain no secrets");
    const result = { resources: [], excluded: 3, includedAnyway: ["website/.npmrc"], pendingPopulation: true, note: "" };
    expect(html(createElement(ResultView, { org: ORG, pid: PID, result, states: {}, mounts: [] }))).toContain("Included at your request after you inspected it: website/.npmrc");
  });

  it("after confirm, pending population is said plainly; the rail stops short of done", () => {
    const result = { resources: [{ resourceId: "res-1", name: "website", provider: "artifacts" as const, mountName: "website" }], excluded: 7, pendingPopulation: true, note: "" };
    const mounts: Mount[] = [{ mountName: "website", resourceId: "res-1", provider: "artifacts", resourceName: "website", mode: "must-match-accepted", operations: ["read", "write"] }];
    const out = html(createElement(ResultView, { org: ORG, pid: PID, result, states: { "res-1": { state: "empty", hasVersion: false } }, mounts }));
    expect(out).toContain('data-testid="intake-pending"');
    expect(out).toContain("still to be copied in");
    expect(out).toContain("Created · content pending");
    expect(out).toContain("Open in Files");
    // right after Confirm, before the project reloads, the Worker's reported folder is shown
    expect(html(createElement(ResultView, { org: ORG, pid: PID, result, states: {}, mounts: [] }))).toContain("folder website");
    const loose = { ...result, resources: [{ resourceId: "res-2", name: "site", provider: "artifacts" as const }] };
    expect(html(createElement(ResultView, { org: ORG, pid: PID, result: loose, states: {}, mounts: [] }))).toContain("not added as a folder");
    const confirmed: IntakeView = { intakeId: "in-1", kind: "zip", state: "confirmed", request: {}, result, createdAt: "", updatedAt: "" };
    expect(intakePosition(confirmed)).toEqual({ current: 3, state: "decision", complete: false });
    expect(intakePosition({ ...confirmed, kind: "url", state: "completed" }).complete).toBe(true);
    expect(intakePosition({ ...confirmed, state: "failed" }).state).toBe("blocked");
  });

  it("failures read as one plain sentence", () => {
    expect(intakeErrorSentence("zip", "inventory zip_refused: the upload is not a readable ZIP archive")).toMatch(/^The file is not a ZIP archive we can read/);
    expect(intakeErrorSentence("url", "branch dev not found in the imported repository")).toMatch(/branch does not exist/);
    expect(intakeErrorSentence("url", "weird")).toMatch(/could not be imported/);
    expect(isFolderName(".github")).toBe(false);
    expect(isFolderName("website")).toBe(true);
  });

  it("derives a folder name from a URL", () => {
    expect(nameFromUrl("https://github.com/agency/portal-website.git")).toBe("portal-website");
    expect(nameFromUrl("nope")).toBe("");
    expect(folderName(" .hidden/name ")).toBe("hidden-name");
  });
});

// ------------------------------------------------------------------------------- publish

const MOUNT: Mount = { mountName: "website", resourceId: R.website, provider: "artifacts", resourceName: "Website", mode: "must-match-accepted", operations: ["read", "write"] };

function rel(over: Partial<ReleaseView> = {}): ReleaseView {
  return { releaseId: "rel-1", projectId: PID, acceptedVersionId: "av-1", recipeRevision: 1, envDigest: "e".repeat(64), outputDigest: "o".repeat(64), state: "prepared", buildState: "built", status: "Ready for publish approval", live: false, publishApproved: false, deployAttempts: 0, createdAt: "", updatedAt: "", error: null, deployments: [], health: null, ...over };
}

function view(over: Partial<PublishVersionViewProps> = {}) {
  const releases: ReleaseList = { releases: [], live: null };
  const props: PublishVersionViewProps = {
    role: "owner",
    mount: MOUNT,
    acceptedVersionId: "av-1",
    justRestored: true,
    releases,
    current: null,
    onPublishCurrent: noop,
    publish: { releases, acceptedVersionId: "av-1", onPrepare: noop, onApprove: noop, onDeploy: noop, busy: null, error: null },
    ...over,
  };
  return html(createElement(PublishVersionView, props));
}

describe("publish this version", () => {
  it("offers the version only to people who can restore it, after a restore or on a restored current version", () => {
    const res = { head: { acceptedVersionId: "av-2" }, operations: ["read", "write"] } as unknown as ResourceDetail;
    const versions = [{ acceptedVersionId: "av-2", kind: "restore" }, { acceptedVersionId: "av-1", kind: "accept" }] as VersionEntry[];
    expect(publishTarget("owner", res, versions, { acceptedVersionId: "av-9" })).toBe("av-9");
    expect(publishTarget("developer", res, versions, null)).toBe("av-2");
    expect(publishTarget("owner", res, [{ acceptedVersionId: "av-2", kind: "accept" }] as VersionEntry[], null)).toBeNull();
    expect(publishTarget("client", res, versions, { acceptedVersionId: "av-9" })).toBeNull();
    expect(publishTarget("owner", { ...res, operations: ["read"] }, versions, { acceptedVersionId: "av-9" })).toBeNull();
  });

  it("offers the first production publish of the current version (an import's first version too) while nothing is live", () => {
    const res = { head: { acceptedVersionId: "av-1" }, operations: ["read", "write"] } as unknown as ResourceDetail;
    const imported = [{ acceptedVersionId: "av-1", kind: "bind" }] as VersionEntry[];
    expect(publishTarget("owner", res, imported, null)).toBeNull();
    expect(publishTarget("owner", res, imported, null, true)).toBe("av-1");
    expect(publishTarget("client", res, imported, null, true)).toBeNull();
    expect(publishTarget("owner", { ...res, head: null } as unknown as ResourceDetail, [], null, true)).toBeNull();
    expect([...releaseMounts({ release: { recipe: { steps: [{ mountName: "api" }] }, targets: [{ mountName: "website" }, { mountName: "api" }] } })].sort()).toEqual(["api", "website"]);
    expect(releaseMounts({}).size).toBe(0);
    expect(releaseMounts({ release: { recipe: "nonsense" } }).size).toBe(0);
  });

  it("says restoring did not change production, with one primary action", () => {
    const out = view();
    expect(out).toContain('data-testid="publish-version"');
    expect(out).toContain("Restoring changed the accepted version, not production");
    expect(out).toContain("Not live");
    expect(out.match(/btn-primary/g)).toHaveLength(1);
    expect(out).toContain("Publish this version");
  });

  it("walks the release gate: approve (owner), Approved not live, Live, rolled back, recovery", () => {
    const list = (r: ReleaseView): ReleaseList => ({ releases: [r], live: r.live ? { releaseId: r.releaseId, acceptedVersionId: r.acceptedVersionId, outputDigest: r.outputDigest!, since: "" } : null });
    const prepared = rel();
    expect(view({ releases: list(prepared), publish: { releases: list(prepared), acceptedVersionId: "av-1", onPrepare: noop, onApprove: noop, onDeploy: noop, busy: null, error: null } })).toContain("Approve publishing this release");
    const approved = rel({ state: "publish_approved", publishApproved: true, status: "Approved, not live" });
    const a = view({ releases: list(approved), publish: { releases: list(approved), acceptedVersionId: "av-1", onPrepare: noop, onApprove: noop, onDeploy: noop, busy: null, error: null } });
    expect(a).toContain("Approved, not live");
    expect(a).toContain("Publish to production");
    expect(publishBadge(rel({ live: true, state: "live" })).label).toBe("Live");
    expect(publishPosition(rel({ live: true, state: "live" })).complete).toBe(true);
    expect(publishBadge(rel({ state: "failed", publishApproved: true, rollback: { state: "done" } })).label).toBe("Rolled back");
    expect(publishBadge(rel({ state: "recovery_required", publishApproved: true })).label).toBe("Recovery required");
    expect(publishPosition(rel({ state: "recovery_required" })).state).toBe("blocked");
    // a client never gets publish controls
    expect(view({ role: "client" })).not.toContain("<button");
  });

  it("a stale version explains itself and offers publishing the current version", () => {
    const error = new ApiError(409, "accepted_version_stale", "newer", { currentAcceptedVersionId: "av-7" });
    const out = view({ publish: { releases: { releases: [], live: null }, acceptedVersionId: "av-1", onPrepare: noop, onApprove: noop, onDeploy: noop, busy: null, error } });
    expect(out).toContain("Publishing now releases that current version, not this one");
    expect(out).not.toContain("including this restore");
    expect(out).toContain("Publish the current version");
  });

  it("retryable 503s show as temporarily unavailable, never as a failure", async () => {
    expect(isRetryable(new ApiError(503, "provider_unavailable", "x"))).toBe(true);
    expect(isRetryable(new ApiError(503, "config_missing", "x"))).toBe(false);
    expect(isRetryable(new ApiError(409, "deploy_in_progress", "x"))).toBe(false);
    expect(view({ retrying: 1 })).toContain("Temporarily unavailable, retrying");
    const after = view({ publish: { releases: { releases: [], live: null }, acceptedVersionId: "av-1", onPrepare: noop, onApprove: noop, onDeploy: noop, busy: null, error: new ApiError(503, "provider_unavailable", "x") } });
    expect(after).toContain("temporarily unavailable");
    expect(after).not.toContain("note-bad");

    const seen: Array<number | null> = [];
    let calls = 0;
    const ok = await withRetry(
      async () => {
        if (++calls < 3) throw new ApiError(503, "provider_unavailable", "busy");
        return "done";
      },
      (n) => seen.push(n),
      async () => {},
    );
    expect(ok).toBe("done");
    expect(seen).toEqual([1, 2, null]);
    calls = 0;
    await expect(withRetry(async () => { calls++; throw new ApiError(503, "provider_unavailable", "busy"); }, noop, async () => {})).rejects.toThrow("busy");
    expect(calls).toBe(RETRY_DELAYS_MS.length + 1);
    calls = 0;
    await expect(withRetry(async () => { calls++; throw new ApiError(409, "already_live", "x"); }, noop, async () => {})).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("fixture: restore, then publish exactly the restored version through approval and deploy", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now });
    const p = await api.getProposal(ORG, P.quoteRepaired);
    api.role = "client";
    await api.approve(ORG, P.quoteRepaired, p.proposalHash);
    api.role = "owner";
    await api.accept(ORG, P.quoteRepaired, "accept:ux3-0001");
    const site = await api.getResource(ORG, R.website);
    const [, first] = await api.listVersions(ORG, R.website);
    const restored = await api.restore(ORG, R.website, { expectedHead: site.head!.revisionId, targetRevision: first!.head!.revisionId, idempotencyKey: "restore:ux3-0001" });
    // an older version is refused like the Worker, naming the current one
    const stale = await api.prepareRelease(ORG, PID, first!.acceptedVersionId).catch((e: ApiError) => e);
    expect(stale).toBeInstanceOf(ApiError);
    expect((stale as ApiError).details?.currentAcceptedVersionId).toBe(restored.acceptedVersionId);
    const r = await api.prepareRelease(ORG, PID, restored.acceptedVersionId);
    expect(r.acceptedVersionId).toBe(restored.acceptedVersionId);
    c.advance(2000);
    const built = (await api.listReleases(ORG, PID)).releases[0]!;
    await api.approvePublish(ORG, built.releaseId, built.outputDigest!);
    await api.deployRelease(ORG, built.releaseId, "deploy:ux3-0001");
    c.advance(2000);
    const list = await api.listReleases(ORG, PID);
    expect(list.live?.acceptedVersionId).toBe(restored.acceptedVersionId);
  });

  it("I2: restoring an asset collection offers no release, only a neutral note", () => {
    const out = html(createElement(PublishVersion, { mount: { ...MOUNT, provider: "r2-assets", resourceName: "Brand and media" }, acceptedVersionId: "av-1", justRestored: true }));
    expect(out).toContain('data-testid="publish-version-assets"');
    expect(out).toContain("Asset collections are not part of a release: publishing does not change which assets production uses");
    expect(out).not.toContain("<button");
    expect(out).not.toContain('data-testid="publish-version"');
  });

  it("I4: the release record carries a human label; ids stay out of the default view", () => {
    const r = rel({ releaseId: "rel-0123456789abcdef01234567", acceptedVersionId: "av-89abcdef01234567", state: "publish_approved", publishApproved: true });
    const out = html(createElement(ReleaseControls, { role: "owner", rel: r, liveId: "rel-ffff", versionLabel: "version 3", publish: { releases: undefined, acceptedVersionId: null, onPrepare: noop, onApprove: noop, onDeploy: noop, busy: null, error: null } }));
    expect(out).toContain("Release for version 3");
    expect(out).toContain("Production still runs the previous release");
    expect(out).not.toMatch(/rel-|av-|o{12}/);
    expect(versionNumberLabel([{ acceptedVersionId: "av-3" }, { acceptedVersionId: "av-2" }, { acceptedVersionId: "av-1" }] as VersionEntry[], "av-2")).toBe("version 2");
  });

  it("I1: Retry publish after a failed deploy starts a new attempt (the key is dropped once a call is answered)", async () => {
    const c = clock();
    const api = new FakeApi({ now: c.now });
    const r = await api.prepareRelease(ORG, PID);
    c.advance(2000);
    const built = (await api.listReleases(ORG, PID)).releases.find((x) => x.releaseId === r.releaseId)!;
    await api.approvePublish(ORG, built.releaseId, built.outputDigest!);
    const keys = new Map<string, string>();
    api.failNextDeploy = true;
    const first = await deployWithKey(api, ORG, built.releaseId, built.outputDigest!, keys);
    expect(first).toMatchObject({ attempt: 1, replayed: false });
    expect(keys.size).toBe(0);
    c.advance(2000);
    const failed = (await api.listReleases(ORG, PID)).releases[0]!;
    expect(failed.state).toBe("failed");
    expect(failed.status).toBe("Approved, not live");
    const retry = await deployWithKey(api, ORG, built.releaseId, built.outputDigest!, keys);
    expect(retry).toMatchObject({ attempt: 2, replayed: false });
    c.advance(2000);
    expect((await api.listReleases(ORG, PID)).live?.releaseId).toBe(built.releaseId);
  });

  it("I1: an unanswered deploy (503s, then success) keeps one key across the retries", async () => {
    const seenKeys: string[] = [];
    let n = 0;
    const api = {
      async deployRelease(_o: string, releaseId: string, key: string) {
        seenKeys.push(key);
        if (++n < 3) throw new ApiError(503, "provider_unavailable", "busy");
        return { releaseId, attempt: 1, replayed: false };
      },
    };
    const keys = new Map<string, string>();
    await deployWithKey(api, ORG, "rel-1", "d", keys, noop, async () => {});
    expect(new Set(seenKeys).size).toBe(1);
    expect(seenKeys).toHaveLength(3);
    expect(keys.size).toBe(0);
  });
});
