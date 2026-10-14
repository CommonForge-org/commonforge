import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { HttpApi } from "./api/client.js";
import type { FakeApi } from "./api/fake.js";
import type { Role } from "./api/types.js";
import "./styles.css";

/**
 * Fixture mode runs the UI on the in-memory demo story, always under a sticky "Sample data" banner.
 * - A fixture build (`VITE_COMMONFORGE_FIXTURE=1`, `pnpm build:fixture`) is always in fixture mode.
 * - The Vite dev server allows it with `?fixture` (remembered for the tab; `?fixture=off` leaves).
 * - A production build never contains it: the condition is a build-time constant, so the fake
 *   and its dynamic import are dropped from the bundle (review m-5).
 */
const FIXTURE_BUILD = import.meta.env.VITE_COMMONFORGE_FIXTURE === "1";

function devFixtureRequested(): boolean {
  const q = new URLSearchParams(window.location.search);
  try {
    if (q.get("fixture") === "off") sessionStorage.removeItem("cf-fixture");
    else if (q.has("fixture")) sessionStorage.setItem("cf-fixture", "1");
    return sessionStorage.getItem("cf-fixture") === "1";
  } catch {
    return q.has("fixture") && q.get("fixture") !== "off";
  }
}

function requestedRole(): Role {
  const role = new URLSearchParams(window.location.search).get("role");
  return role === "client" || role === "developer" || role === "viewer" ? role : "owner";
}

/** `?orgs` adds a second organization (no projects): the org switcher, and Getting started in a new organization. */
function requestedExtraOrgs(): Array<{ orgId: string; name: string }> {
  return new URLSearchParams(window.location.search).has("orgs") ? [{ orgId: "o-0de0c11e0002", name: "Second Client" }] : [];
}

/**
 * `?staging` turns on the staging demo (staging phase 3: the Customer Portal in staging mode with the
 * three client tasks, a working task and captures), remembered for the tab; `?staging=off` leaves it.
 * Off by default so the earlier fixture stories see the project exactly as before.
 */
function requestedStaging(): boolean {
  const q = new URLSearchParams(window.location.search);
  try {
    if (q.get("staging") === "off") sessionStorage.removeItem("cf-fixture-staging");
    else if (q.has("staging")) sessionStorage.setItem("cf-fixture-staging", "1");
    return sessionStorage.getItem("cf-fixture-staging") === "1";
  } catch {
    return q.has("staging") && q.get("staging") !== "off";
  }
}

/** `?folderSetupFails`: the next folder added fails to set up once, to show "Setup failed" and Try again. */
function requestedFolderSetupFails(): boolean {
  return new URLSearchParams(window.location.search).has("folderSetupFails");
}

async function boot() {
  let fixture: FakeApi | null = null;
  if (FIXTURE_BUILD || import.meta.env.DEV) {
    if (FIXTURE_BUILD || devFixtureRequested()) {
      const { FakeApi, seedFixtureBrowser } = await import("./api/fake.js");
      seedFixtureBrowser();
      // UX-4 review C-1: the quote change's repair is still running (4:00); "Finish running agent" submits it
      fixture = new FakeApi({ role: requestedRole(), repair: "running", extraOrgs: requestedExtraOrgs(), staging: requestedStaging(), folderSetupFails: requestedFolderSetupFails() });
    }
  }
  const api = fixture ?? new HttpApi();
  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root element");
  createRoot(root).render(
    <StrictMode>
      <App api={api} fixture={fixture} />
    </StrictMode>,
  );
}

void boot();
