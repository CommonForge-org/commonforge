/**
 * The README's screenshots (docs/images/*.png), taken from the LOCAL STACK: the real control-plane
 * Worker under `wrangler dev -c wrangler.e2e.jsonc` serving the real web bundle, with in-memory
 * fakes for Artifacts, the runner and the Cloudflare API (see local-stack.spec.ts). No fixture data:
 * every screen shows what a fresh deployment shows after the same clicks.
 *
 * Not part of `pnpm test:e2e`. Regenerate with (from apps/web):
 *   pnpm run screenshots          # playwright test -c playwright.readme.config.ts
 * COMMONFORGE_E2E_PORT picks another port for the stack (default 8799). README_SHOTS_DIR writes
 * somewhere else than docs/images.
 *
 * One story, run serially: an agency owner creates an organization and a project, imports the
 * site from Git, sets a release target and publishes once (Getting started, Versions); gives a
 * task to an agent (the hand-off panel); the agent's change becomes a proposal that passes
 * validation (the Change storyboard); then staging is turned on, a client is invited, and the
 * client's tasks are on the Tasks board while an agent works on one.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { E2E_KEY, STACK_URL, WORKER_LOG } from "./stack/env.js";

test.describe.configure({ mode: "serial" });

const OUT = process.env.README_SHOTS_DIR ?? fileURLToPath(new URL("../../../docs/images/", import.meta.url));
const OWNER = "owner@agency.e2e.test";
const CLIENT = "ana@bakery.e2e.test";
const REPO = "https://github.com/northwind-bakery/bakery-site";
const SITE = {
  "package.json": '{ "name": "bakery-site", "private": true, "scripts": { "build": "vite build" } }\n',
  "index.html": "<main><h1>Northwind Bakery</h1><p>Fresh bread every morning.</p></main>\n",
  "src/index.ts": "export default { fetch: () => new Response('Northwind Bakery') };\n",
};

// ------------------------------------------------------------------------------------- helpers

async function magicLink(email: string, after: number): Promise<string> {
  const re = new RegExp(`magic link for ${email.replace(/[.+]/g, "\\$&")}: (\\S+)`, "g");
  for (let i = 0; i < 60; i++) {
    const hits = [...readFileSync(WORKER_LOG, "utf8").slice(after).matchAll(re)];
    if (hits.length) return hits[hits.length - 1]![1]!;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no magic link for ${email} in ${WORKER_LOG}`);
}

async function signIn(page: Page, email: string) {
  await page.goto("/signin");
  const mark = readFileSync(WORKER_LOG, "utf8").length;
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.goto(await magicLink(email, mark));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

/** The cookie session's API, from inside the page (same-origin fetch, as the app calls it). */
function sessionApi(page: Page) {
  return async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await page.evaluate(
      async ({ method, path, body }) => {
        const res = await fetch(`/api${path}`, { method, credentials: "same-origin", headers: body !== undefined ? { "content-type": "application/json" } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        return { status: res.status, text: await res.text() };
      },
      { method, path, body },
    );
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${r.text}`);
    return (r.text ? JSON.parse(r.text) : null) as T;
  };
}

function agentApi(request: APIRequestContext, lease: string) {
  return async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await request.fetch(`${STACK_URL}/api${path}`, { method, headers: { authorization: `Bearer ${lease}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { data: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok()) throw new Error(`agent ${method} ${path} → ${r.status()} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
}

async function e2e<T = any>(request: APIRequestContext, method: string, path: string, body?: unknown): Promise<T> {
  const r = await request.fetch(`${STACK_URL}/__e2e${path}`, { method, headers: { "x-commonforge-e2e": E2E_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { data: JSON.stringify(body) } : {}) });
  const text = await r.text();
  if (!r.ok()) throw new Error(`e2e ${method} ${path} → ${r.status()} ${text}`);
  return JSON.parse(text) as T;
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** A 1440×900 viewport screenshot, with the caret and animations stilled. */
async function shot(page: Page, name: string) {
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.screenshot({ path: `${OUT}${name}.png`, animations: "disabled", caret: "hide" });
}

/** The agent's side of `cforge checkout` + `cforge submit`: lease, push one file, freeze. */
async function agentSubmits(page: Page, request: APIRequestContext, taskId: string, mount: string, files: Record<string, string>) {
  const lease = await sessionApi(page)<{ leaseToken: string }>("POST", `/tasks/${taskId}/lease`, {});
  const agent = agentApi(request, lease.leaseToken);
  const view = await agent<{ workspaces: Array<{ taskWorkspaceId: string; mountName: string; access: string }> }>("GET", `/tasks/${taskId}`);
  const cred = await agent<{ secret: string }>("POST", `/tasks/${taskId}/credential`, { mountName: mount, access: "write" });
  const pushed = await e2e<{ sha: string }>(request, "POST", "/git/push", { secret: cred.secret, files });
  const ws = view.workspaces.find((w) => w.mountName === mount && w.access === "write")!;
  await agent("POST", `/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { expectedSha: pushed.sha, tool: "claude" });
}

// ---------------------------------------------------------------------------------- the story

let browser: Browser;
let owner: BrowserContext;
let page: Page;
let orgId = "";
let pid = "";
const overview = () => page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Overview" }).click();
const gs = () => page.getByTestId("getting-started");

async function useExample(section: "release" | "staging") {
  const policy = page.getByRole("region", { name: "Policy" });
  const box = page.getByTestId(`policy-json-${section}`);
  await box.getByText("Show example").click();
  await box.getByRole("button", { name: "Use this example" }).click();
  await expect(policy.getByRole("button", { name: "Review changes" })).toBeEnabled({ timeout: 20_000 });
  await policy.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

test.beforeAll(async ({ browser: b }) => {
  mkdirSync(OUT, { recursive: true });
  browser = b;
  owner = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page = await owner.newPage();
});

test.afterAll(async () => {
  await owner?.close();
});

test("getting started: organization, project, Git import, release target, first publish", async () => {
  await e2e(owner.request, "POST", "/importer/remote", { url: REPO, branch: "main", files: SITE });
  await signIn(page, OWNER);
  await page.goto("/orgs/new");
  await page.getByLabel("Organization name").fill("Northwind Bakery");
  await page.getByRole("button", { name: "Create organization" }).click();
  await page.getByRole("link", { name: "Create a project" }).click();
  await gs().getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill("Bakery website");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText("This project has no folders yet.")).toBeVisible();
  const m = /\/o\/([^/]+)\/p\/([^/]+)/.exec(page.url())!;
  orgId = m[1]!;
  pid = m[2]!;

  await overview();
  await gs().getByRole("link", { name: "Import from Git" }).click();
  await page.getByLabel("Repository address").fill(REPO);
  await page.getByRole("button", { name: "Import repository" }).click();
  await expect(page.getByTestId("intake-result")).toContainText("Imported", { timeout: 30_000 });

  await overview();
  await expect(gs().getByTestId("gs-code")).toHaveAttribute("data-done", "true", { timeout: 20_000 });
  await gs().getByTestId("gs-release").getByRole("link", { name: "Open Policy" }).click();
  await expect(page.getByTestId("policy-json-release").getByLabel("Example: Release")).toContainText(`cfapp-${orgId}-site`, { timeout: 20_000 });
  await useExample("release");
  await expect(page.getByRole("region", { name: "Policy" })).toContainText("Revision 1");

  await overview();
  await expect(gs().getByTestId("gs-release")).toHaveAttribute("data-done", "true");
  await gs().getByTestId("gs-publish").getByRole("link", { name: "Open Versions" }).click();
  const panel = page.getByTestId("publish-version");
  await panel.getByRole("button", { name: "Publish this version" }).click();
  await panel.getByRole("button", { name: "Approve publishing this release" }).click({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Publish to production" }).click();
  await expect(panel.locator(".badge", { hasText: /^Live$/ })).toBeVisible({ timeout: 45_000 });

  await overview();
  await expect(gs().getByTestId("gs-publish")).toHaveAttribute("data-done", "true", { timeout: 20_000 });
  await expect(gs()).toContainText("5 of 10 done");
  await shot(page, "getting-started");
});

let taskId = "";

test("give a task to an agent: the hand-off panel", async () => {
  await page.goto(`/o/${orgId}/p/${pid}/changes`);
  await page.getByTestId("new-task-open").click();
  const form = page.getByTestId("new-task");
  await form.getByLabel("Title").fill("Show opening hours");
  await form.getByLabel("What should the agent do?").fill("Add our opening hours under the heading: Mon–Fri 7:00–18:00, Sat 7:00–14:00.");
  await page.getByTestId("new-task-submit").click();
  const handoff = page.getByTestId("task-handoff");
  await expect(handoff.getByTestId("handoff-copy-prompt")).toBeVisible();
  taskId = /^cforge checkout (task-\S+) /.exec((await handoff.getByTestId("task-handoff-command").textContent()) ?? "")![1]!;
  await handoff.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.evaluate(() => window.scrollBy(0, -16));
  await shot(page, "give-to-agent");
  await handoff.getByRole("button", { name: "Done" }).click();
});

test("the agent submits; the change becomes a proposal that passes validation: the Change storyboard", async () => {
  const api = sessionApi(page);
  await until("task ready", async () => (await api<{ state: string }>("GET", `/tasks/${taskId}`)).state === "ready");
  const mount = (await api<{ workspaces: Array<{ mountName: string; access: string }> }>("GET", `/tasks/${taskId}`)).workspaces.find((w) => w.access === "write")!.mountName;
  await agentSubmits(page, owner.request, taskId, mount, { "index.html": "<main><h1>Northwind Bakery</h1><p>Fresh bread every morning.</p><p class=hours>Mon–Fri 7:00–18:00 · Sat 7:00–14:00</p></main>\n" });
  await page.goto(`/o/${orgId}/p/${pid}/changes`);
  await page.locator(`[data-testid="change-task"][data-task="${taskId}"]`).getByTestId("change-task-propose").click();
  await expect(page).toHaveURL(/\/changes\/prop-/);
  const validate = page.getByRole("button", { name: "Run validation" });
  await expect(validate).toBeEnabled({ timeout: 30_000 });
  await validate.click();
  const approve = page.getByRole("button", { name: "Approve this result" });
  await expect(approve).toBeEnabled({ timeout: 30_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "change-storyboard");

  // approve, accept and publish, so Versions has a history
  await approve.click();
  await page.getByRole("button", { name: "Accept as new version" }).click({ timeout: 30_000 });
  const publish = page.getByTestId("step-publish");
  await publish.getByRole("button", { name: "Prepare release" }).click();
  await publish.getByRole("button", { name: "Approve publishing this release" }).click({ timeout: 30_000 });
  await publish.getByRole("button", { name: "Publish to production" }).click();
  await expect(publish.locator(".pill", { hasText: /^Live$/ })).toBeVisible({ timeout: 45_000 });
});

test("Versions: every accepted version, what production runs, restore and publish", async () => {
  await page.goto(`/o/${orgId}/p/${pid}/versions`);
  await expect(page.getByTestId("versions")).toBeVisible();
  await expect(page.getByTestId("versions").getByText(/Live/).first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "versions");
});

test("staging and a client: the Tasks board, with an agent working on a client's task", async () => {
  await page.goto(`/o/${orgId}/p/${pid}/settings/policy`);
  await useExample("staging");
  await expect(page.getByRole("region", { name: "Policy" })).toContainText("Revision 2");
  await expect(page.getByTestId("staging-header")).toBeVisible({ timeout: 20_000 });

  await page.goto(`/o/${orgId}/members`);
  const invite = page.getByRole("form", { name: "Invite a member" });
  await invite.getByLabel("Email").fill(CLIENT);
  await invite.getByLabel("Role").selectOption("client");
  await invite.getByRole("checkbox", { name: "Bakery website" }).check();
  await invite.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Only owners so far.")).toHaveCount(0);
  // a new client reads only: the owner lets them change the project's folders
  await page.goto(`/o/${orgId}/p/${pid}/settings/access`);
  await page.getByLabel(`Access of ${CLIENT}`, { exact: true }).selectOption({ label: "Can change" });
  await page.getByRole("button", { name: `Save access for ${CLIENT}` }).click();
  await expect(page.getByRole("button", { name: `Save access for ${CLIENT}` })).toBeDisabled();

  const client = await browser.newContext();
  const cpage = await client.newPage();
  const mount = (await sessionApi(page)<{ mounts: Array<{ mountName: string; provider: string }> }>("GET", `/orgs/${orgId}/projects/${pid}`)).mounts.find((m) => m.provider === "artifacts")!.mountName;
  const ids: string[] = [];
  try {
    await signIn(cpage, CLIENT);
    for (const [title, request] of [
      ["Add a gluten-free section", "List the gluten-free loaves on their own, with a small label."],
      ["Holiday opening hours", "We close on 24–26 December. Please say so at the top of the page."],
      ["Bigger photo on the home page", "Make the bread photo full width on phones."],
    ]) {
      const t = await sessionApi(cpage)<{ taskId: string }>("POST", `/orgs/${orgId}/projects/${pid}/tasks`, { title, request, writeMounts: [mount] });
      ids.push(t.taskId);
    }
  } finally {
    await client.close();
  }
  const api = sessionApi(page);
  for (const id of ids) await until(`task ${id} ready`, async () => (await api<{ state: string }>("GET", `/tasks/${id}`)).state === "ready");
  // the first goes all the way to staging; an agent is working on the second; the third waits
  await agentSubmits(page, owner.request, ids[0]!, mount, { "gluten-free.html": "<h2>Gluten-free</h2><ul><li>Buckwheat loaf</li><li>Seeded rice bread</li></ul>\n" });
  await api("POST", `/tasks/${ids[1]}/lease`, {});

  await page.goto(`/o/${orgId}/p/${pid}/tasks`);
  const card = (id: string) => page.locator(`[data-testid="task-card"][data-task="${id}"]`);
  await expect(card(ids[1]!).getByTestId("task-card-agent")).toContainText("The agent is working.", { timeout: 30_000 });
  await expect(card(ids[2]!).getByTestId("task-card-agent")).toContainText("Waiting for an agent");
  await expect(card(ids[0]!)).toHaveAttribute("data-column", /staging/, { timeout: 60_000 });
  await shot(page, "tasks-board");
});
