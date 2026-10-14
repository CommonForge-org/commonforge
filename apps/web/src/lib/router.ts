/** A tiny history router: no dependency, routes are a typed union parsed from the URL. */
import { useSyncExternalStore } from "react";

/** `tasks`: the Tasks board, shown only for staging-mode projects (staging phase 3). */
export type ProjectTab = "overview" | "files" | "changes" | "versions" | "activity" | "tasks";

export type Route =
  | { name: "signin" }
  | { name: "verify"; token: string }
  | { name: "cli"; code: string }
  | { name: "home" }
  /** your sessions: `/account` */
  | { name: "account" }
  /** a new organization (instance admins): `/orgs/new` */
  | { name: "new-org" }
  /** one organization's projects: `/o/:org` */
  | { name: "org"; org: string }
  /** one organization's members: `/o/:org/members` */
  | { name: "members"; org: string }
  /** one member's access across projects: `/o/:org/members/:userId` */
  | { name: "member"; org: string; userId: string }
  /** `?edit=1`: the file at `path` opens in the editor; `?new=1`: a new file in the folder `path` (phase 3) */
  | { name: "project"; org: string; pid: string; tab: "files"; mount?: string; path?: string; edit?: true; new?: true }
  | { name: "project"; org: string; pid: string; tab: "changes" }
  | { name: "project"; org: string; pid: string; tab: "overview" }
  | { name: "project"; org: string; pid: string; tab: "activity" }
  /** the Tasks board (staging-mode projects): `/o/:org/p/:pid/tasks` */
  | { name: "project"; org: string; pid: string; tab: "tasks" }
  | { name: "project"; org: string; pid: string; tab: "versions"; mount?: string; /** an accepted version id: open its restore sheet */ version?: string }
  | { name: "proposal"; org: string; pid: string; proposalId: string }
  /** a promotion's review (owners and developers; staging phase 3): `/o/:org/p/:pid/promotions/:id` */
  | { name: "promotion"; org: string; pid: string; promotionId: string }
  /** "Add files" (UX-3): `/o/:org/p/:pid/files/add[?intake=]` */
  | { name: "intake"; org: string; pid: string; intakeId?: string }
  /** project settings: `/o/:org/p/:pid/settings[/access|/folders|/policy]` */
  | { name: "settings"; org: string; pid: string; section: "access" | "folders" | "policy" }
  | { name: "not-found"; path: string };

export function parseRoute(pathname: string, search: string): Route {
  const q = new URLSearchParams(search);
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "signin" && parts.length === 1) return { name: "signin" };
  if (parts[0] === "auth" && parts[1] === "verify" && parts.length === 2) return { name: "verify", token: q.get("token") ?? "" };
  if (parts[0] === "auth" && parts[1] === "cli" && parts.length === 2) return { name: "cli", code: q.get("code") ?? "" };
  if (parts[0] === "orgs" && parts[1] === "new" && parts.length === 2) return { name: "new-org" };
  if (parts[0] === "account" && parts.length === 1) return { name: "account" };
  if (parts[0] === "o" && parts.length === 2) return { name: "org", org: parts[1]! };
  if (parts[0] === "o" && parts.length === 3 && parts[2] === "members") return { name: "members", org: parts[1]! };
  if (parts[0] === "o" && parts.length === 4 && parts[2] === "members") return { name: "member", org: parts[1]!, userId: parts[3]! };
  if (parts[0] === "o" && parts[2] === "p" && parts.length >= 4) {
    const org = parts[1]!;
    const pid = parts[3]!;
    const tab = parts[4] ?? "files";
    if (tab === "files" && parts.length <= 5) {
      const mount = q.get("mount") ?? undefined;
      const path = q.get("path") ?? undefined;
      const edit = q.get("edit") === "1";
      const isNew = !edit && q.get("new") === "1";
      return { name: "project", org, pid, tab: "files", ...(mount ? { mount } : {}), ...(path ? { path } : {}), ...(edit ? { edit: true as const } : {}), ...(isNew ? { new: true as const } : {}) };
    }
    if (tab === "files" && parts[5] === "add" && parts.length === 6) {
      const intakeId = q.get("intake") ?? undefined;
      return { name: "intake", org, pid, ...(intakeId ? { intakeId } : {}) };
    }
    if (tab === "changes" && parts.length === 5) return { name: "project", org, pid, tab: "changes" };
    if (tab === "overview" && parts.length === 5) return { name: "project", org, pid, tab: "overview" };
    if (tab === "activity" && parts.length === 5) return { name: "project", org, pid, tab: "activity" };
    if (tab === "tasks" && parts.length === 5) return { name: "project", org, pid, tab: "tasks" };
    if (tab === "promotions" && parts.length === 6) return { name: "promotion", org, pid, promotionId: parts[5]! };
    if (tab === "changes" && parts.length === 6) return { name: "proposal", org, pid, proposalId: parts[5]! };
    if (tab === "versions" && parts.length === 5) {
      const mount = q.get("mount") ?? undefined;
      const version = q.get("version") ?? undefined;
      return { name: "project", org, pid, tab: "versions", ...(mount ? { mount } : {}), ...(version ? { version } : {}) };
    }
    if (tab === "settings" && (parts.length === 5 || (parts.length === 6 && (parts[5] === "access" || parts[5] === "folders" || parts[5] === "policy"))))
      return { name: "settings", org, pid, section: parts[5] === "folders" || parts[5] === "policy" ? parts[5] : "access" };
  }
  return { name: "not-found", path: pathname };
}

export const NEW_ORG_HREF = "/orgs/new";

const enc = encodeURIComponent;

export function orgHref(org: string): string {
  return `/o/${enc(org)}`;
}

export function membersHref(org: string): string {
  return `/o/${enc(org)}/members`;
}

export function memberHref(org: string, userId: string): string {
  return `/o/${enc(org)}/members/${enc(userId)}`;
}

/** Query flags (`edit`, `new`) are `true` for `=1`; `false` and `undefined` leave a param out. */
export function projectHref(org: string, pid: string, tab: ProjectTab = "files", params: Record<string, string | boolean | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v === true ? "1" : v);
  const s = q.toString();
  return `/o/${enc(org)}/p/${enc(pid)}/${tab}${s ? `?${s}` : ""}`;
}

export function settingsHref(org: string, pid: string, section: "access" | "folders" | "policy" = "access"): string {
  return `/o/${enc(org)}/p/${enc(pid)}/settings/${section}`;
}

export function proposalHref(org: string, pid: string, proposalId: string): string {
  return `/o/${enc(org)}/p/${enc(pid)}/changes/${enc(proposalId)}`;
}

/** A promotion's review screen (owners and developers). */
export function promotionHref(org: string, pid: string, promotionId: string): string {
  return `/o/${enc(org)}/p/${enc(pid)}/promotions/${enc(promotionId)}`;
}

/** The "Add files" screen, optionally following one intake. */
export function intakeHref(org: string, pid: string, intakeId?: string): string {
  return `/o/${enc(org)}/p/${enc(pid)}/files/add${intakeId ? `?intake=${enc(intakeId)}` : ""}`;
}

// ---------------------------------------------------------------------------- location store

const listeners = new Set<() => void>();

function snapshot() {
  return window.location.pathname + window.location.search;
}

/**
 * One guard at a time (the editor, while it holds unsaved text): asked before any in-app
 * navigation, and on Back/Forward. It calls `proceed` to let the navigation go on (or never, to
 * stay). A browser-level leave (reload, closing the tab) is `beforeunload`'s business.
 */
export type NavigationGuard = (proceed: () => void) => void;

let guard: NavigationGuard | null = null;
/** the location subscribers last saw: where Back is undone to */
let current = "";
/** the next popstate is our own `history.back()` after the guard let it go */
let skipPop = false;
let installedOn: unknown = null;

function notify() {
  for (const fn of listeners) fn();
}

function onPopState() {
  const to = snapshot();
  if (skipPop || !guard || to === current) {
    skipPop = false;
    current = to;
    notify();
    return;
  }
  // the browser moved already: put the guarded page back, and go back only if the guard says so
  window.history.pushState(null, "", current);
  guard(() => {
    skipPop = true;
    window.history.back();
  });
}

/** The one popstate listener, installed on first use (and again for a new `window`, in tests). */
function install() {
  if (installedOn === window) return;
  installedOn = window;
  current = snapshot();
  window.addEventListener("popstate", onPopState);
}

/** Sets the navigation guard; returns its remover (which leaves a newer guard in place). */
export function setNavigationGuard(g: NavigationGuard): () => void {
  install();
  guard = g;
  return () => {
    if (guard === g) guard = null;
  };
}

export function subscribeLocation(fn: () => void) {
  install();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** `force`: skip the guard (the guarded screen's own exit, after it asked). */
export function navigate(href: string, opts: { replace?: boolean; force?: boolean } = {}) {
  install();
  const go = () => {
    if (opts.replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
    current = snapshot();
    notify();
    window.scrollTo?.(0, 0);
  };
  if (guard && !opts.force) guard(go);
  else go();
}

/** Server rendering (tests) passes the location explicitly. */
export function useRoute(serverLocation = "/"): Route {
  const loc = useSyncExternalStore(subscribeLocation, snapshot, () => serverLocation);
  const i = loc.indexOf("?");
  return parseRoute(i < 0 ? loc : loc.slice(0, i), i < 0 ? "" : loc.slice(i));
}
