import { afterEach, describe, expect, it, vi } from "vitest";
import { memberHref, membersHref, parseRoute, projectHref, proposalHref, settingsHref } from "../src/lib/router.js";

describe("router", () => {
  it("parses the app routes", () => {
    expect(parseRoute("/", "")).toEqual({ name: "home" });
    expect(parseRoute("/signin", "")).toEqual({ name: "signin" });
    expect(parseRoute("/orgs/new", "")).toEqual({ name: "new-org" });
    expect(parseRoute("/auth/verify", "?token=cfm_abc")).toEqual({ name: "verify", token: "cfm_abc" });
    expect(parseRoute("/o/o-1/p/p-1", "")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "files" });
    expect(parseRoute("/o/o-1/p/p-1/files", "?mount=website&path=src%2Fa.ts")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "files", mount: "website", path: "src/a.ts" });
    expect(parseRoute("/o/o-1/p/p-1/changes", "")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "changes" });
    expect(parseRoute("/o/o-1/p/p-1/changes/prop-9", "")).toEqual({ name: "proposal", org: "o-1", pid: "p-1", proposalId: "prop-9" });
    expect(parseRoute("/o/o-1/p/p-1/versions", "?mount=api")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "versions", mount: "api" });
    expect(parseRoute("/o/o-1/p/p-1/overview", "")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "overview" });
    expect(parseRoute("/o/o-1/p/p-1/activity", "")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "activity" });
    expect(parseRoute("/o/o-1/members", "")).toEqual({ name: "members", org: "o-1" });
    expect(membersHref("o-1")).toBe("/o/o-1/members");
    expect(parseRoute("/o/o-1/members/u-2", "")).toEqual({ name: "member", org: "o-1", userId: "u-2" });
    expect(memberHref("o-1", "u-2")).toBe("/o/o-1/members/u-2");
    expect(parseRoute("/o/o-1/p/p-1/settings", "")).toEqual({ name: "settings", org: "o-1", pid: "p-1", section: "access" });
    expect(parseRoute("/o/o-1/p/p-1/settings/access", "")).toEqual({ name: "settings", org: "o-1", pid: "p-1", section: "access" });
    expect(settingsHref("o-1", "p-1")).toBe("/o/o-1/p/p-1/settings/access");
    expect(parseRoute("/o/o-1/p/p-1/settings/folders", "")).toEqual({ name: "settings", org: "o-1", pid: "p-1", section: "folders" });
    expect(settingsHref("o-1", "p-1", "folders")).toBe("/o/o-1/p/p-1/settings/folders");
    expect(parseRoute("/o/o-1/p/p-1/settings/policy", "")).toEqual({ name: "settings", org: "o-1", pid: "p-1", section: "policy" });
    expect(settingsHref("o-1", "p-1", "policy")).toBe("/o/o-1/p/p-1/settings/policy");
    expect(parseRoute("/nope", "")).toEqual({ name: "not-found", path: "/nope" });
  });

  it("builds hrefs that parse back", () => {
    const h = projectHref("o-1", "p-1", "files", { mount: "brand-assets", path: "logos/logo.svg" });
    const [path, search] = h.split("?");
    expect(parseRoute(path!, `?${search}`)).toMatchObject({ tab: "files", mount: "brand-assets", path: "logos/logo.svg" });
    expect(proposalHref("o-1", "p-1", "prop-1")).toBe("/o/o-1/p/p-1/changes/prop-1");
  });

  it("UX-2: a Versions link can name the version to restore", () => {
    expect(parseRoute("/o/o-1/p/p-1/versions", "?mount=api&version=av-7")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "versions", mount: "api", version: "av-7" });
    const h = projectHref("o-1", "p-1", "versions", { version: "av-2" });
    expect(parseRoute(h.split("?")[0]!, `?${h.split("?")[1]}`)).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "versions", version: "av-2" });
  });

  it("phase 3: the files route opens a file in the editor (?edit=1) or a new file in a folder (?new=1)", () => {
    expect(parseRoute("/o/o-1/p/p-1/files", "?mount=website&path=src%2Fa.ts&edit=1")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "files", mount: "website", path: "src/a.ts", edit: true });
    expect(parseRoute("/o/o-1/p/p-1/files", "?mount=website&path=src&new=1")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "files", mount: "website", path: "src", new: true });
    expect(parseRoute("/o/o-1/p/p-1/files", "?mount=website&new=1")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "files", mount: "website", new: true });
    // other values are not the flag
    expect(parseRoute("/o/o-1/p/p-1/files", "?mount=website&path=a.ts&edit=0")).toEqual({ name: "project", org: "o-1", pid: "p-1", tab: "files", mount: "website", path: "a.ts" });
    const e = projectHref("o-1", "p-1", "files", { mount: "website", path: "src/a.ts", edit: true });
    expect(e).toBe("/o/o-1/p/p-1/files?mount=website&path=src%2Fa.ts&edit=1");
    expect(parseRoute(e.split("?")[0]!, `?${e.split("?")[1]}`)).toMatchObject({ mount: "website", path: "src/a.ts", edit: true });
    const n = projectHref("o-1", "p-1", "files", { mount: "website", path: "src", new: true, edit: false });
    expect(n).toBe("/o/o-1/p/p-1/files?mount=website&path=src&new=1");
    expect(parseRoute(n.split("?")[0]!, `?${n.split("?")[1]}`)).toMatchObject({ mount: "website", path: "src", new: true });
  });
});

/**
 * A stand-in for the browser's window: a history stack with pushState, replaceState and back
 * (back fires popstate, as the browser does, after the location changed).
 */
function fakeWindow(start: string) {
  const stack = [start];
  let at = 0;
  const pops = new Set<() => void>();
  const loc = () => {
    const u = new URL(stack[at]!, "https://x.test");
    return { pathname: u.pathname, search: u.search };
  };
  const w = {
    get location() {
      return loc();
    },
    history: {
      pushState: (_s: unknown, _t: string, href: string) => {
        stack.splice(at + 1, stack.length, href);
        at = stack.length - 1;
      },
      replaceState: (_s: unknown, _t: string, href: string) => {
        stack[at] = href;
      },
      back: () => {
        if (at === 0) return;
        at--;
        queueMicrotask(() => pops.forEach((f) => f()));
      },
    },
    addEventListener: (type: string, f: () => void) => type === "popstate" && pops.add(f),
    removeEventListener: (type: string, f: () => void) => type === "popstate" && pops.delete(f),
    scrollTo: () => undefined,
  };
  return { w, stack: () => [...stack], at: () => at, here: () => stack[at] };
}

describe("router: the navigation guard (review 4)", () => {
  const setup = async (start = "/o/o-1/p/p-1/files?mount=site&path=a.txt&edit=1") => {
    const f = fakeWindow(start);
    vi.stubGlobal("window", f.w);
    vi.resetModules();
    const r = await import("../src/lib/router.js");
    const seen: string[] = [];
    r.subscribeLocation(() => seen.push(f.here()!));
    return { ...f, r, seen };
  };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("without a guard, navigate goes at once", async () => {
    const t = await setup("/a");
    t.r.navigate("/b");
    expect(t.here()).toBe("/b");
    expect(t.seen).toEqual(["/b"]);
  });

  it("navigate asks the guard; staying changes nothing, leaving goes where it was asked to", async () => {
    const t = await setup("/a");
    const asks: Array<() => void> = [];
    const off = t.r.setNavigationGuard((proceed) => asks.push(proceed));
    t.r.navigate("/b");
    expect(t.here()).toBe("/a");
    expect(t.seen).toEqual([]);
    expect(asks).toHaveLength(1);
    asks[0]!(); // "Discard changes"
    expect(t.here()).toBe("/b");
    expect(t.seen).toEqual(["/b"]);
    off();
    t.r.navigate("/c");
    expect(t.here()).toBe("/c");
    expect(asks).toHaveLength(1);
  });

  it("force skips the guard (the editor's own exit)", async () => {
    const t = await setup("/a");
    const asks: Array<() => void> = [];
    t.r.setNavigationGuard((proceed) => asks.push(proceed));
    t.r.navigate("/b", { replace: true, force: true });
    expect(t.here()).toBe("/b");
    expect(asks).toHaveLength(0);
  });

  it("Back with a guard: the page stays, and leaving goes back after all", async () => {
    const t = await setup("/a");
    t.r.navigate("/edit");
    expect(t.stack()).toEqual(["/a", "/edit"]);
    const asks: Array<() => void> = [];
    t.r.setNavigationGuard((proceed) => asks.push(proceed));
    t.seen.length = 0;
    t.w.history.back();
    await Promise.resolve();
    await Promise.resolve();
    expect(asks).toHaveLength(1);
    expect(t.here()).toBe("/edit"); // put back: the editor stays
    expect(t.seen).toEqual([]); // no subscriber saw the location change
    asks[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.here()).toBe("/a");
    expect(t.seen).toEqual(["/a"]);
    expect(asks).toHaveLength(1); // the guard is not asked twice
  });

  it("a removed guard no longer asks on Back", async () => {
    const t = await setup("/a");
    t.r.navigate("/edit");
    const asks: Array<() => void> = [];
    const off = t.r.setNavigationGuard((proceed) => asks.push(proceed));
    off();
    t.w.history.back();
    await Promise.resolve();
    expect(asks).toHaveLength(0);
    expect(t.here()).toBe("/a");
  });

  it("a newer guard replaces the older; removing the older one leaves the newer", async () => {
    const t = await setup("/a");
    const a: string[] = [];
    const offOld = t.r.setNavigationGuard(() => a.push("old"));
    t.r.setNavigationGuard(() => a.push("new"));
    offOld();
    t.r.navigate("/b");
    expect(a).toEqual(["new"]);
  });
});
