/**
 * The demo path against the LOCAL REAL STACK (plan §G.4): the control-plane Worker under
 * `wrangler dev` (apps/worker/e2e/stack.ts) serving the production web bundle (no fixture code).
 *
 * Real: every route, D1, the OrgLedger/OpsGate Durable Objects, R2, the step/outbox/runner queues,
 * magic-link sign-in in `log` mode (the link is read from the Worker log), cookie sessions and CSRF.
 * Faked inside the Worker: Cloudflare Artifacts (in-memory repos; "git push" is a test route that
 * demands the agent's real write token), the integration runner (in-process FakeRunner speaking the
 * real runner protocol) and the Cloudflare API for releases. See docs/LIMITATIONS.md.
 *
 * One story, run serially: sign in → seed → browse → three-resource change with a contract failure
 * → fix → identical review code for client and developer → approve / accept / publish (separate
 * records) → restore → export → a client edition update.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { handoverInventory, handoverZip } from "./handover-zip.js";
import { E2E_KEY, STACK_URL, WEB_DIR, WORKER_LOG } from "./stack/env.js";

test.describe.configure({ mode: "serial" });

const OWNER = "owner@agency.e2e.test";
const CLIENT = "client@customer.e2e.test";

// ------------------------------------------------------------------------------------- helpers

/** The newest sign-in link for `email` written by the Worker in `log` mode. */
async function magicLink(email: string, after: number): Promise<string> {
  const re = new RegExp(`magic link for ${email.replace(/[.+]/g, "\\$&")}: (\\S+)`, "g");
  for (let i = 0; i < 60; i++) {
    const log = readFileSync(WORKER_LOG, "utf8").slice(after);
    const hits = [...log.matchAll(re)];
    if (hits.length) return hits[hits.length - 1]![1]!;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no magic link for ${email} in ${WORKER_LOG}`);
}

const logSize = () => readFileSync(WORKER_LOG, "utf8").length;

async function signIn(page: Page, email: string) {
  await page.goto("/signin");
  const mark = logSize();
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  const link = await magicLink(email, mark);
  expect(link.startsWith(`${STACK_URL}/auth/verify?token=cfm_`)).toBe(true);
  await page.goto(link);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

/**
 * The cookie session's API, called from inside the page exactly like the web app does (same-origin
 * fetch: the browser sends the `__Host-` cookie and the Origin header the CSRF guard checks).
 */
async function inPage(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; text: string; base64: string }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const init: RequestInit = { method, credentials: "same-origin", headers: body !== undefined ? { "content-type": "application/json" } : {} };
      if (body !== undefined) init.body = JSON.stringify(body);
      const r = await fetch(path, init);
      const bytes = new Uint8Array(await r.arrayBuffer());
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return { status: r.status, text: new TextDecoder().decode(bytes), base64: btoa(bin) };
    },
    { method, path, body },
  );
}

function sessionApi(page: Page) {
  return async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await inPage(page, method, `/api${path}`, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${r.text}`);
    return (r.text ? JSON.parse(r.text) : null) as T;
  };
}

/** An agent's calls with its lease token (`Authorization: Bearer cfl_…`). */
function agentApi(request: APIRequestContext, lease: string) {
  return async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await request.fetch(`${STACK_URL}/api${path}`, { method, headers: { authorization: `Bearer ${lease}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { data: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok()) throw new Error(`agent ${method} ${path} → ${r.status()} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
}

/** The stack's test routes (fake Artifacts and fake runner). */
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

/** A stored (uncompressed) ZIP: what a client's tool would hand back. */
function zip(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

/** Entry names of a ZIP (central directory). */
function zipNames(buf: Buffer): string[] {
  const names: string[] = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const n = buf.readUInt16LE(i + 28);
    names.push(buf.subarray(i + 46, i + 46 + n).toString("utf8"));
    i += 45 + n;
  }
  return names;
}

// ---------------------------------------------------------------------------------- the story

const WEBSITE = {
  "index.html": "<main><h1>Get a quote</h1><p class=total></p></main>\n",
  "src/quote.ts": "export function renderQuote(total: number) { return `$${(total / 100).toFixed(2)}`; }\n",
  "package.json": '{ "name": "portal-website", "private": true }\n',
  "tests/quote-contract.test.ts": "// checks the /quote response against requirements/contracts/quote.schema.json\n",
};
const API = { "src/index.ts": "export default { fetch: () => Response.json({ total: 1500 }) };\n" };
const REQUIREMENTS = { "README.md": "# Customer Portal requirements\n", "contracts/quote.schema.json": '{ "required": ["total"], "additionalProperties": false }\n' };

interface World {
  orgId: string;
  pid: string;
  rid: Record<"website" | "api" | "requirements" | "brand", string>;
  canonicalNs: string;
  seeded: Record<string, string>;
  taskId?: string;
  lease?: string;
  first?: { proposalId: string; proposalHash: string };
  second?: { proposalId: string; proposalHash: string };
  clientUserId?: string;
}

let browser: Browser;
let owner: BrowserContext;
let ownerPage: Page;
let world: World;

test.beforeAll(async ({ browser: b }) => {
  browser = b;
  owner = await browser.newContext();
  ownerPage = await owner.newPage();
});

test.afterAll(async () => {
  await owner?.close();
});

test("sign-in by magic link (log mode): the link from the Worker log signs the owner in", async () => {
  await signIn(ownerPage, OWNER);
  await expect(ownerPage.getByText("No organizations yet")).toBeVisible();
});

test("seed the Demo Client project (resources, canonical content, policy, release recipe, client member)", async () => {
  const api = sessionApi(ownerPage);
  const org = await api<{ orgId: string }>("POST", "/orgs", { name: "Demo Client" });
  const rid = {} as World["rid"];
  const seeded: Record<string, string> = {};
  const canonicalNs = `commonforge-e2e-${org.orgId}-canonical`;
  for (const [name, files] of [["website", WEBSITE], ["api", API], ["requirements", REQUIREMENTS]] as const) {
    const r = await api<{ resourceId: string; coords: { namespace: string } }>("POST", `/orgs/${org.orgId}/resources`, { name, provider: "artifacts" });
    expect(r.coords.namespace).toBe(canonicalNs);
    seeded[name] = (await e2e<{ sha: string }>(owner.request, "POST", "/git/seed", { namespace: canonicalNs, repo: r.resourceId, files })).sha;
    await api("POST", `/orgs/${org.orgId}/resources/${r.resourceId}/adopt-head`);
    rid[name] = r.resourceId;
  }
  rid.brand = (await api<{ resourceId: string }>("POST", `/orgs/${org.orgId}/resources`, { name: "brand-assets", provider: "r2-assets" })).resourceId;
  const { projectId: pid } = await api<{ projectId: string }>("POST", `/orgs/${org.orgId}/projects`, { name: "Customer Portal" });
  for (const m of ["website", "api", "requirements"] as const) await api("POST", `/orgs/${org.orgId}/projects/${pid}/mounts`, { mountName: m, resourceId: rid[m] });
  await api("POST", `/orgs/${org.orgId}/projects/${pid}/mounts`, { mountName: "brand-assets", resourceId: rid.brand });
  const kv = await api<{ id: string }>("POST", `/orgs/${org.orgId}/deploy-resources`, { kind: "kv", name: "orders" });
  const workerName = (n: string) => `cfapp-${org.orgId}-${n}`;
  await api("PUT", `/orgs/${org.orgId}/projects/${pid}/policy`, {
    checks: [{ checkId: "quote-contract", mountName: "website", command: "pnpm exec vitest run tests/quote-contract.test.ts" }],
    rules: ["Money is integer cents."],
    release: {
      recipe: { recipeId: "demo-release", revision: 1, steps: [{ stepId: "api-build", mountName: "api", command: "pnpm run build" }, { stepId: "site-build", mountName: "website", command: "pnpm exec vite build" }] },
      targets: [
        { targetId: "api", kind: "worker", mountName: "api", outputPath: "dist", main: "index.js", workerName: workerName("api") },
        { targetId: "website", kind: "assets", mountName: "website", outputPath: "dist", workerName: workerName("website") },
      ],
      environment: { api: { vars: { APP_VERSION: "1.0.0" }, kvNamespaces: [{ binding: "ORDERS", id: kv.id }] } },
      healthCheck: { targetId: "api", path: "/version" },
    },
  });
  const client = await api<{ userId: string }>("POST", `/orgs/${org.orgId}/members`, { email: CLIENT, role: "client" });
  for (const scope of [{ kind: "project", id: pid }, ...(["website", "api", "requirements", "brand"] as const).map((k) => ({ kind: "resource", id: rid[k] }))]) {
    await api("PUT", `/orgs/${org.orgId}/grants`, { userId: client.userId, scope, operations: ["read"] });
  }
  world = { orgId: org.orgId, pid, rid, canonicalNs, seeded, clientUserId: client.userId };
});

test("browse: one project, four resources; the source inspector shows the Artifacts repo and the R2 collection", async () => {
  await ownerPage.goto("/");
  await ownerPage.getByRole("link", { name: /Customer Portal/ }).click();
  const tree = ownerPage.getByRole("tree", { name: "Project files" });
  for (const name of ["website", "api", "requirements", "brand-assets"]) await expect(tree.locator(".tree-name", { hasText: name }).first()).toBeVisible();
  await tree.getByRole("button", { name: /website/ }).first().click();
  const inspector = ownerPage.locator(".browser-inspector");
  await expect(inspector).toContainText("Artifacts repository");
  await expect(inspector).toContainText(world.canonicalNs);
  await expect(inspector).toContainText(`art:`);
  await tree.getByRole("button", { name: /src/ }).click();
  await tree.getByRole("button", { name: /quote\.ts/ }).click();
  await expect(inspector.locator(".preview-text")).toContainText("renderQuote");
  await tree.getByRole("button", { name: /brand-assets/ }).click();
  await expect(inspector).toContainText("R2 asset collection");
});

test("an agent changes website + api in one task; the runner's contract check fails it; acceptance is blocked", async () => {
  const api = sessionApi(ownerPage);
  const task = await api<{ taskId: string }>("POST", `/orgs/${world.orgId}/projects/${world.pid}/tasks`, { title: "Add a quote breakdown", request: "Show each priced line under the total.", writeMounts: ["website", "api", "requirements"] });
  world.taskId = task.taskId;
  await until("task ready", async () => (await api<{ state: string }>("GET", `/tasks/${task.taskId}`)).state === "ready");
  const lease = await api<{ leaseToken: string }>("POST", `/tasks/${task.taskId}/lease`, {});
  world.lease = lease.leaseToken;
  const agent = agentApi(owner.request, lease.leaseToken);
  const view = await agent<{ workspaces: Array<{ taskWorkspaceId: string; mountName: string }> }>("GET", `/tasks/${task.taskId}`);
  for (const [mount, files] of [
    ["website", { "src/quote.ts": "export function renderQuote(q: { total: number; breakdown: Array<{ label: string; amount: number }> }) { return q.breakdown.map((l) => l.label).join(', '); }\n" }],
    ["api", { "src/index.ts": "export default { fetch: () => Response.json({ total: 1500, breakdown: [{ label: 'Widget', amount: 1500 }] }) };\n" }],
  ] as const) {
    const cred = await agent<{ secret: string; remoteUrl: string; scope: string }>("POST", `/tasks/${task.taskId}/credential`, { mountName: mount, access: "write" });
    expect(cred.scope).toBe("write");
    expect(cred.remoteUrl).toContain("-tasks/");
    const pushed = await e2e<{ sha: string }>(owner.request, "POST", "/git/push", { secret: cred.secret, files });
    const ws = view.workspaces.find((w) => w.mountName === mount)!;
    await agent("POST", `/tasks/${task.taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { expectedSha: pushed.sha, tool: "claude" });
    // freezing revoked the write token: a later push is refused
    await expect(e2e(owner.request, "POST", "/git/push", { secret: cred.secret, files: { "late.txt": "x" } })).rejects.toThrow(/403/);
  }
  await e2e(owner.request, "POST", "/runner", { integrateFailure: { code: "contract_failed", detail: "contract quote-schema: /quote response has property \"breakdown\" not allowed by requirements/contracts/quote.schema.json", contractId: "quote-schema" } });
  const p1 = await api<{ proposalId: string; proposalHash: string }>("POST", `/orgs/${world.orgId}/proposals`, { taskId: task.taskId });
  world.first = p1;

  await ownerPage.goto(`/o/${world.orgId}/p/${world.pid}/changes`);
  await expect(ownerPage.getByTestId("change-row")).toContainText("Add a quote breakdown");
  await ownerPage.goto(`/o/${world.orgId}/p/${world.pid}/changes/${p1.proposalId}`);
  const validate = ownerPage.getByRole("button", { name: "Run validation" });
  await expect(validate).toBeEnabled({ timeout: 30_000 }); // prepared by the queue steps + runner
  await validate.click();
  const blocked = ownerPage.getByTestId("blocked-banner");
  await expect(blocked).toBeVisible({ timeout: 30_000 });
  await expect(blocked).toContainText("Production is unchanged");
  await blocked.getByText("Runner output").click();
  await expect(blocked).toContainText("contract quote-schema");
  await expect(ownerPage.getByRole("button", { name: "Accept as new version" })).toBeDisabled();
  // canonical main never moved
  expect((await e2e<{ sha: string }>(owner.request, "GET", `/git/ref?namespace=${world.canonicalNs}&repo=${world.rid.api}&branch=main`)).sha).toBe(world.seeded.api);
});

test("the fix (requirements declares the breakdown) is a new identity of the same change, and passes", async () => {
  const api = sessionApi(ownerPage);
  const agent = agentApi(owner.request, world.lease!);
  const view = await agent<{ workspaces: Array<{ taskWorkspaceId: string; mountName: string }> }>("GET", `/tasks/${world.taskId}`);
  const cred = await agent<{ secret: string }>("POST", `/tasks/${world.taskId}/credential`, { mountName: "requirements", access: "write" });
  const pushed = await e2e<{ sha: string }>(owner.request, "POST", "/git/push", { secret: cred.secret, files: { "contracts/quote.schema.json": '{ "required": ["total", "breakdown"], "additionalProperties": false }\n' } });
  await agent("POST", `/tasks/${world.taskId}/workspaces/${view.workspaces.find((w) => w.mountName === "requirements")!.taskWorkspaceId}/freeze`, { expectedSha: pushed.sha, tool: "claude" });
  await e2e(owner.request, "POST", "/runner", {});
  const p2 = await api<{ proposalId: string; proposalHash: string }>("POST", `/orgs/${world.orgId}/proposals`, { taskId: world.taskId });
  expect(p2.proposalHash).not.toBe(world.first!.proposalHash);
  world.second = p2;

  // the failed proposal now points at the latest one
  await ownerPage.goto(`/o/${world.orgId}/p/${world.pid}/changes/${world.first!.proposalId}`);
  await ownerPage.getByRole("link", { name: "Review the latest" }).click();
  await expect(ownerPage).toHaveURL(new RegExp(`/changes/${p2.proposalId}$`));
  const validate = ownerPage.getByRole("button", { name: "Run validation" });
  await expect(validate).toBeEnabled({ timeout: 30_000 });
  await validate.click();
  await expect(ownerPage.getByTestId("fixed-banner")).toContainText("Fixed", { timeout: 30_000 });
  await expect(ownerPage.getByTestId("proposal-hash")).toHaveAttribute("data-hash", p2.proposalHash);
});

test("client and developer see the identical review code; the client approves and can neither accept nor publish", async () => {
  const client = await browser.newContext();
  const page = await client.newPage();
  try {
    await signIn(page, CLIENT);
    await page.goto(`/o/${world.orgId}/p/${world.pid}/changes/${world.second!.proposalId}`);
    const code = page.getByTestId("proposal-hash");
    await expect(code).toHaveAttribute("data-hash", world.second!.proposalHash);
    // the client view carries no repository coordinates
    await expect(page.locator("main")).not.toContainText(world.canonicalNs);
    await expect(page.locator("main")).not.toContainText("-tasks");
    await expect(page.getByRole("button", { name: "Accept as new version" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Publish/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Approve this result" }).click();
    await expect(page.locator(".client-side")).toContainText("Approved by client");
    // the client's session cannot accept through the API either
    const r = await inPage(page, "POST", `/api/orgs/${world.orgId}/proposals/${world.second!.proposalId}/accept`, { idempotencyKey: "client-accept-01" });
    expect(r.status).toBe(403);
  } finally {
    await client.close();
  }
});

test("approve, accept and publish are three records: accept moves the ledger and reconciles main; only a publish approval deploys", async () => {
  await ownerPage.goto(`/o/${world.orgId}/p/${world.pid}/changes/${world.second!.proposalId}`);
  await expect(ownerPage.getByTestId("step-approve")).toContainText("Approved by client");
  const accept = ownerPage.getByRole("button", { name: "Accept as new version" });
  await expect(accept).toBeEnabled();
  await accept.click();
  const trail = ownerPage.getByTestId("decision-trail");
  await expect(trail).toContainText(/Accepted as version \d+/);
  await expect(trail).toContainText(/Not published/);
  // the outbox reconciles canonical main to the accepted revision (local queue → fake runner)
  const head = await sessionApi(ownerPage)<{ head: { revisionId: string } }>("GET", `/orgs/${world.orgId}/resources/${world.rid.api}`);
  const acceptedSha = head.head.revisionId.split(":").pop()!;
  await until("canonical main reconciled", async () => (await e2e<{ sha: string }>(owner.request, "GET", `/git/ref?namespace=${world.canonicalNs}&repo=${world.rid.api}&branch=main`)).sha === acceptedSha);
  // accepting deployed nothing
  expect((await e2e<{ handled: Array<{ kind: string }> }>(owner.request, "GET", "/runner")).handled.filter((j) => j.kind.startsWith("release-"))).toEqual([]);

  const publish = ownerPage.getByTestId("step-publish");
  await publish.getByRole("button", { name: "Prepare release" }).click();
  await publish.getByRole("button", { name: "Approve publishing this release" }).click({ timeout: 30_000 });
  await expect(publish).toContainText("Approved, not live");
  await publish.getByRole("button", { name: "Publish to production" }).click();
  await expect(publish.locator(".pill", { hasText: /^Live$/ })).toBeVisible({ timeout: 45_000 });
  await expect(trail).toContainText("Live ·");
  const runner = await e2e<{ handled: Array<{ kind: string }>; errors: string[]; live: Record<string, Record<string, string>> }>(owner.request, "GET", "/runner");
  expect(runner.errors).toEqual([]);
  expect(Object.keys(runner.live).sort()).toEqual([`cfapp-${world.orgId}-api`, `cfapp-${world.orgId}-website`]);
});

test("restore: the imported version comes back as a new forward version; the earlier history is kept", async () => {
  await ownerPage.goto(`/o/${world.orgId}/p/${world.pid}/versions?mount=api`);
  const versions = ownerPage.getByTestId("versions");
  await expect(versions.locator(".version")).toHaveCount(2);
  await versions.getByRole("button", { name: "Restore this version" }).click();
  await ownerPage.locator(".confirm").getByRole("button", { name: "Restore this version" }).click();
  await expect(ownerPage.getByRole("status").filter({ hasText: "Restored." })).toBeVisible();
  await expect(versions.locator(".version")).toHaveCount(3);
  await expect(versions.locator(".version").first()).toContainText("Restored an earlier version");
  await until("canonical main restored", async () => (await e2e<{ sha: string }>(owner.request, "GET", `/git/ref?namespace=${world.canonicalNs}&repo=${world.rid.api}&branch=main`)).sha === world.seeded.api);
});

test("publish this version: the restored version goes through the same release gate, and goes live", async () => {
  const panel = ownerPage.getByTestId("publish-version");
  await expect(panel).toContainText("Restoring changed the accepted version, not production");
  // the earlier release is still what production runs
  await expect(panel).toContainText("Production keeps running the last published release");
  await panel.getByRole("button", { name: "Publish this version" }).click();
  await panel.getByRole("button", { name: "Approve publishing this release" }).click({ timeout: 30_000 });
  await expect(panel).toContainText("Approved, not live");
  await panel.getByRole("button", { name: "Publish to production" }).click();
  await expect(panel.locator(".badge", { hasText: /^Live$/ })).toBeVisible({ timeout: 45_000 });
  const restored = await sessionApi(ownerPage)<{ head: { acceptedVersionId: string } }>("GET", `/orgs/${world.orgId}/resources/${world.rid.api}`);
  const releases = await sessionApi(ownerPage)<{ live: { acceptedVersionId: string } | null }>("GET", `/orgs/${world.orgId}/projects/${world.pid}/releases`);
  expect(releases.live?.acceptedVersionId).toBe(restored.head.acceptedVersionId);
  // a reload keeps the offer (the current version is a restore) and shows it live
  await ownerPage.reload();
  await expect(ownerPage.getByTestId("publish-version").locator(".badge", { hasText: /^Live$/ })).toBeVisible();
});

test("export: git bundles and the asset manifest for the accepted version, downloadable", async () => {
  await ownerPage.goto(`/o/${world.orgId}/p/${world.pid}/files`);
  await ownerPage.getByRole("button", { name: "Export" }).click();
  const dialog = ownerPage.getByRole("dialog", { name: "Export project" });
  await dialog.getByRole("button", { name: "Start export" }).click();
  await expect(dialog).toContainText("Ready. One file per resource", { timeout: 30_000 });
  const links = dialog.locator(".downloads a");
  await expect(links.first()).toBeVisible();
  const hrefs = await links.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs.some((h) => h.includes(".bundle"))).toBe(true);
  for (const href of hrefs.filter((h) => h.includes(".bundle"))) {
    const r = await inPage(ownerPage, "GET", href);
    expect(r.status, href).toBe(200);
    expect(r.text).toMatch(/^bundle of [0-9a-f]{40}$/); // the fake runner's bundle stand-in
  }
});

test("client edition: the developer publishes a working copy; the client downloads it, sends an edited copy back, and gets a proposal", async () => {
  // developer side: create + publish the edition and give the client access (UI)
  await ownerPage.goto(`/o/${world.orgId}/p/${world.pid}/files`);
  await ownerPage.getByRole("button", { name: "Client editions" }).click();
  const panel = ownerPage.getByRole("dialog", { name: "Client editions" });
  await panel.getByRole("button", { name: "New edition" }).click();
  // the draft defaults to the first git mount (api, alphabetically): publish the website
  await panel.getByLabel("Source").selectOption({ label: "website" });
  await panel.getByRole("button", { name: "Create and publish" }).click();
  await expect(panel.getByTestId("edition")).toContainText("Published", { timeout: 30_000 });
  await panel.getByLabel("Give a client access to Website pages").selectOption({ label: CLIENT });
  await expect(panel).not.toContainText("error", { ignoreCase: true });

  const client = await browser.newContext();
  const page = await client.newPage();
  try {
    await signIn(page, CLIENT);
    await page.goto(`/o/${world.orgId}/p/${world.pid}/files`);
    await page.getByRole("button", { name: "Start an update" }).click();
    const update = page.getByRole("dialog", { name: "Start an update" });
    await expect(update.getByTestId("edition-cards")).toContainText("Website pages");
    await update.getByLabel("What do you want to change?").fill("Explain what the quote covers");
    await update.getByRole("button", { name: "Open working copy" }).click();
    const download = update.getByRole("link", { name: "Download working copy" });
    await expect(download).toBeVisible();
    const zipRes = await inPage(page, "GET", await download.evaluate((a) => (a as HTMLAnchorElement).href));
    expect(zipRes.status).toBe(200);
    const body = Buffer.from(zipRes.base64, "base64");
    expect(body.subarray(0, 2).toString()).toBe("PK");
    // the canonical history and unpublished files are not in the copy
    expect(body.includes(Buffer.from("tests/quote-contract.test.ts"))).toBe(false);

    const names = zipNames(body);
    const quote = names.find((n) => n.endsWith("src/quote.ts"));
    const pkg = names.find((n) => n.endsWith("package.json"));
    expect(quote, names.join(", ")).toBeTruthy();
    expect(pkg, names.join(", ")).toBeTruthy();
    const edited = zip({ [quote!]: "export function renderQuote(total: number) { return `Total: $${(total / 100).toFixed(2)} (incl. all items)`; }\n", [pkg!]: '{ "name": "hijacked" }\n' });
    await update.getByLabel("Edited working copy (ZIP)").setInputFiles({ name: "website-pages.zip", mimeType: "application/zip", buffer: edited });
    await update.getByRole("button", { name: "Send back edited copy" }).click();
    const ret = update.getByTestId("edition-return");
    await expect(ret).toContainText("Ready for review", { timeout: 45_000 });
    await expect(ret).toContainText("src/quote.ts");
    await expect(ret.getByTestId("return-summary")).toHaveText("1 file changed · 1 blocked");
    // not in the write allowlist (and protected): never taken over
    await expect(ret).toContainText(/package\.json was not taken over: (this working copy lets you read it but not change it|your developer protects this file)\./);
    await ret.getByRole("link", { name: "Review and approve the result" }).click();
    await expect(page.getByTestId("proposal-hash")).toHaveAttribute("data-hash", /^[0-9a-f]{64}$/);
    await expect(page.locator("main")).toContainText("What changes for you");
    // leaving through the sheet's link closes it
    await expect(page.getByRole("dialog", { name: "Start an update" })).toHaveCount(0);
  } finally {
    await client.close();
  }
});

test("Add files: a ZIP is inventoried by the runner, shown with reasons, and confirmed into an empty project (content population pending)", async () => {
  const api = sessionApi(ownerPage);
  const { projectId } = await api<{ projectId: string }>("POST", `/orgs/${world.orgId}/projects`, { name: "Agency handover" });
  await e2e(owner.request, "POST", "/runner", { inventory: handoverInventory() });
  try {
    await ownerPage.goto(`/o/${world.orgId}/p/${projectId}/files`);
    await expect(ownerPage.getByText("This project has no files yet.")).toBeVisible();
    await ownerPage.getByRole("link", { name: "Add files" }).click();
    await ownerPage.getByLabel("Project archive (ZIP)").setInputFiles({ name: "agency-handover.zip", mimeType: "application/zip", buffer: handoverZip() });
    await ownerPage.getByRole("button", { name: "Check this archive" }).click();
    const inv = ownerPage.getByTestId("intake-inventory");
    await expect(inv).toBeVisible({ timeout: 30_000 });
    await expect(inv.getByTestId("intake-placement")).toHaveCount(4);
    await expect(inv.locator('[data-kind="secret"]')).toContainText("website/.env");
    await expect(inv.locator('[data-kind="nested"]')).toContainText("api/ nested repository (26 files): import by URL to keep its history");
    await expect(inv.locator('[data-kind="secret"]')).toContainText("website/.npmrc · may contain a registry token");
    await expect(inv.getByTestId("intake-placement").filter({ hasText: "agency-handover-assets" })).toContainText("R2");
    // §11.3: include the inspected .npmrc anyway, after the attestation
    await inv.getByRole("checkbox", { name: "Include website/.npmrc anyway" }).check();
    await expect(ownerPage.getByTestId("intake-confirm")).toBeDisabled();
    await inv.getByTestId("intake-include-attest").getByRole("checkbox").check();
    await ownerPage.getByTestId("intake-confirm").click();
    await expect(ownerPage.getByTestId("intake-pending")).toContainText("still to be copied in");
    await expect(ownerPage.getByTestId("intake-included-anyway")).toContainText("website/.npmrc");
    await expect(ownerPage.getByTestId("intake-created")).toHaveCount(4);
    const project = await api<{ mounts: Array<{ mountName: string; provider: string }> }>("GET", `/orgs/${world.orgId}/projects/${projectId}`);
    expect(project.mounts.map((m) => m.mountName).sort()).toEqual(["agency-handover-assets", "api", "requirements", "website"]);
    await ownerPage.getByTestId("intake-created").filter({ hasText: "website" }).getByRole("link", { name: "Open in Files" }).click();
    await expect(ownerPage.getByTestId("resource-chips")).toContainText("agency-handover-assets");
  } finally {
    await e2e(owner.request, "POST", "/runner", {});
  }
});

test("Add folder: a new git folder is set up by the runner's init-folder job; its first version holds the three platform files", async () => {
  const api = sessionApi(ownerPage);
  const { projectId } = await api<{ projectId: string }>("POST", `/orgs/${world.orgId}/projects`, { name: "Media library" });
  const P = `/orgs/${world.orgId}/projects/${projectId}`;
  const { mountName, resourceId } = await api<{ mountName: string; resourceId: string }>("POST", `${P}/folders`, { name: "media" });
  expect(mountName).toBe("media");
  type Folder = { mountName: string; provider: string; state: string; settingUp: boolean; setupFailed: boolean };
  const ready = await until("the new folder to be set up", async () => {
    const f = (await api<{ folders: Folder[] }>("GET", `${P}/folders`)).folders.find((x) => x.mountName === "media");
    if (f?.state === "failed") throw new Error(`folder setup failed: ${JSON.stringify(f)}`);
    return f?.state === "active" ? f : null;
  });
  expect(ready).toMatchObject({ provider: "artifacts", state: "active", settingUp: false, setupFailed: false });
  const tree = await api<{ entries: Array<{ path: string }> }>("GET", `${P}/tree?mount=media`);
  expect(tree.entries.map((e) => e.path).sort()).toEqual([".gitattributes", ".lfsconfig", "README.md"]);
  const file = async (path: string) => {
    const r = await inPage(ownerPage, "GET", `/api${P}/file?mount=media&path=${encodeURIComponent(path)}`);
    expect(r.status, r.text).toBe(200);
    return r.text;
  };
  expect(await file("README.md")).toBe("# media\n");
  expect(await file(".lfsconfig")).toBe(`[lfs]\n\turl = ${STACK_URL}/api/lfs/${world.orgId}/${resourceId}/info/lfs\n`);
  expect(await file(".gitattributes")).toContain("*.mp4 filter=lfs diff=lfs merge=lfs -text\n");
  const handled = await e2e<{ handled: Array<{ kind: string }> }>(owner.request, "GET", "/runner");
  expect(handled.handled.some((j) => j.kind === "init-folder")).toBe(true);
  // the Folders tab shows it ready
  await ownerPage.goto(`/o/${world.orgId}/p/${projectId}/settings/folders`);
  await expect(ownerPage.locator(".folder-row", { hasText: "media" })).toContainText("Ready");

  // the owner makes it read-only in this project: no task may change it; then changeable again
  type ProjectView = { mounts: Array<{ mountName: string; operations: string[]; canStartTask: boolean }> };
  const media = async () => (await api<ProjectView>("GET", P)).mounts.find((m) => m.mountName === "media")!;
  expect(await media()).toMatchObject({ operations: ["read", "write"], canStartTask: true });
  await ownerPage.getByLabel("Changes to media").selectOption({ label: "Read-only" });
  await expect.poll(async () => (await media()).operations).toEqual(["read"]);
  expect((await media()).canStartTask).toBe(false);
  const refused = await inPage(ownerPage, "POST", `/api${P}/tasks`, { title: "Change media", writeMounts: ["media"] });
  expect([refused.status, JSON.parse(refused.text).error.code]).toEqual([403, "mount_read_only"]);
  await ownerPage.reload();
  await expect(ownerPage.getByLabel("Changes to media")).toHaveValue("read-only");
  await ownerPage.getByLabel("Changes to media").selectOption({ label: "Can be changed" });
  await expect.poll(async () => (await media()).canStartTask).toBe(true);
});

test("New task on Changes (no staging): the hand-off's commands, the agent's checkout and submit, then Make proposal", async () => {
  const TITLE = "Show opening hours";
  await ownerPage.goto(`/o/${world.orgId}/p/${world.pid}/changes`);
  await ownerPage.getByTestId("new-task-open").click();
  const form = ownerPage.getByTestId("new-task");
  await form.getByLabel("Title").fill(TITLE);
  await form.getByLabel("What should the agent do?").fill("Add our hours under the quote form.");
  await form.getByText("Choose folders").click();
  await form.locator('input[name="write"][value="website"]').check();
  await ownerPage.getByTestId("new-task-submit").click();

  // the hand-off names this deployment and the signed-in owner, and the task the Worker created
  const handoff = ownerPage.getByTestId("task-handoff");
  // Copy puts a fresh one-time sign-in code in the prompt; the Worker exchanges it once for a CLI session
  await owner.grantPermissions(["clipboard-read", "clipboard-write"], { origin: STACK_URL });
  await handoff.getByTestId("handoff-copy-prompt").click();
  await expect(handoff.getByTestId("handoff-copy-status")).toContainText("its sign-in code works once");
  const copied = await ownerPage.evaluate(() => navigator.clipboard.readText());
  const code = /--code (cfm_[A-Za-z0-9_-]+)/.exec(copied)?.[1];
  expect(code, copied).toBeTruthy();
  expect(copied).toContain(`cforge login --api-url ${STACK_URL} --code ${code}`);
  expect(copied).toContain("- You may change: website");
  await expect(handoff).not.toContainText(code!);
  const verify = await owner.request.post(`${STACK_URL}/api/auth/cli/verify`, { data: { code }, headers: { origin: STACK_URL } });
  expect(verify.status()).toBe(200);
  expect(((await verify.json()) as { user: { email: string } }).user.email).toBe(OWNER);
  expect((await owner.request.post(`${STACK_URL}/api/auth/cli/verify`, { data: { code }, headers: { origin: STACK_URL } })).status()).toBe(401);
  const agentToken = ((await verify.json()) as { sessionToken: string }).sessionToken;
  await expect(handoff.getByTestId("handoff-login-command")).toHaveText(`cforge login --api-url ${STACK_URL} --email ${OWNER}`);
  const checkout = (await handoff.getByTestId("task-handoff-command").textContent()) ?? "";
  const m = /^cforge checkout (task-\S+) show-opening-hours$/.exec(checkout);
  expect(m, checkout).not.toBeNull();
  const taskId = m![1]!;
  await expect(handoff.getByTestId("handoff-prompt-text")).toContainText("- You may change: website");
  await expect(handoff.getByTestId("handoff-prompt-text")).toContainText(`cforge submit --commit="Finish task ${taskId}"`);
  await handoff.getByRole("button", { name: "Done" }).click();

  const item = ownerPage.locator(`[data-testid="change-task"][data-task="${taskId}"]`);
  await expect(item.getByTestId("change-task-agent")).toContainText("Waiting for an agent to check it out.", { timeout: 30_000 });

  // what `cforge checkout` does: take the lease with the session; the row says the agent is working
  const api = sessionApi(ownerPage);
  const lease = await api<{ leaseToken: string }>("POST", `/tasks/${taskId}/lease`, {});
  await expect(item.getByTestId("change-task-agent")).toContainText("The agent is working.");

  // what `cforge submit` does: push, then freeze with the lease
  const agent = agentApi(owner.request, lease.leaseToken);
  const view = await agent<{ workspaces: Array<{ taskWorkspaceId: string; mountName: string; access: string }> }>("GET", `/tasks/${taskId}`);
  const cred = await agent<{ secret: string }>("POST", `/tasks/${taskId}/credential`, { mountName: "website", access: "write" });
  const pushed = await e2e<{ sha: string }>(owner.request, "POST", "/git/push", { secret: cred.secret, files: { "hours.html": "<p>Mon-Fri 9:00-17:30</p>\n" } });
  const ws = view.workspaces.find((w) => w.mountName === "website" && w.access === "write")!;
  await agent("POST", `/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { expectedSha: pushed.sha, tool: "claude" });

  await item.getByTestId("change-task-propose").click();
  await expect(ownerPage).toHaveURL(new RegExp(`/o/${world.orgId}/p/${world.pid}/changes/prop-`));
  const proposals = await api<{ proposals: Array<{ changeId: string }> }>("GET", `/orgs/${world.orgId}/proposals?projectId=${world.pid}`);
  const task = await api<{ changeId: string }>("GET", `/tasks/${taskId}`);
  expect(proposals.proposals.some((p) => p.changeId === task.changeId)).toBe(true);

  // the agent's session is on the Account page (the avatar), and ends there
  const meAs = (token: string) => owner.request.get(`${STACK_URL}/api/me`, { headers: { authorization: `Bearer ${token}` } });
  expect((await meAs(agentToken)).status()).toBe(200);
  await ownerPage.getByRole("link", { name: /Your account|Signed in as/ }).first().click();
  await expect(ownerPage).toHaveURL(/\/account$/);
  const row = ownerPage.locator('[data-testid="session-row"][data-client="handoff"]');
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: /^Sign out/ }).click();
  await expect(row).toHaveCount(0);
  expect((await meAs(agentToken)).status()).toBe(401);

  // an AI app: the Account page's sign-in code, pasted into the built `cforge mcp` (the server the
  // Claude Desktop extension and the plugin run), which signs in and creates a task with no folders
  await ownerPage.getByTestId("agent-app-code").click();
  const message = ((await ownerPage.getByTestId("agent-app-signin").textContent()) ?? "").trim();
  expect(message).toMatch(new RegExp(`^Sign in to CommonForge: cforge login --api-url ${STACK_URL.replace(/[.]/g, "\\.")} --code cfm_`));
  const app = mcpClient();
  try {
    expect((await app.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } })).serverInfo.name).toBe("commonforge");
    const signedIn = await app.tool("sign_in", { code: message });
    expect(signedIn.isError, JSON.stringify(signedIn)).toBe(false);
    expect(signedIn.structuredContent.user.email).toBe(OWNER);
    const projects = await app.tool("list_projects", { org: world.orgId });
    expect(projects.structuredContent.projects.map((p: { projectId: string }) => p.projectId)).toContain(world.pid);
    const created = await app.tool("create_task", { project_id: world.pid, title: "Holiday hours from the chat", request: "Closed on the 25th.", org: world.orgId });
    expect(created.isError, JSON.stringify(created)).toBe(false);
    const made = await api<{ title: string; workspaces: Array<{ mountName: string; access: string }> }>("GET", `/tasks/${created.structuredContent.taskId}`);
    expect(made.title).toBe("Holiday hours from the chat");
    expect(made.workspaces.some((w) => w.access === "write")).toBe(true);
  } finally {
    app.close();
  }
  await ownerPage.reload();
  await expect(ownerPage.locator('[data-testid="session-row"][data-client="handoff"]')).toHaveCount(1);
});

/** The built cforge's MCP server on stdio, with its own config dir; one request at a time. */
function mcpClient() {
  const cli = join(WEB_DIR, "..", "cli");
  const build = spawnSync(process.execPath, [join(cli, "scripts", "bundle.mjs")], { cwd: cli, encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr);
  const home = mkdtempSync(join(tmpdir(), "cforge-mcp-e2e-"));
  const child = spawn(process.execPath, [join(cli, "dist", "index.js"), "mcp"], { env: { PATH: process.env.PATH, HOME: home, CFORGE_CONFIG_DIR: join(home, "cfg") } });
  let buffer = "";
  const waiting = new Map<number, (v: any) => void>();
  child.stdout.on("data", (d: Buffer) => {
    buffer += d.toString("utf8");
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const call = (method: string, params: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
  return { call, tool: (name: string, args: Record<string, unknown>) => call("tools/call", { name, arguments: args }), close: () => child.stdin.end() };
}

test("Getting started on a fresh organization: Git import, release example, first publish, staging, client, first task", async () => {
  const page = ownerPage;
  const CLIENT2 = "ana@bakery.e2e.test";
  const REPO = "https://github.com/bakery-e2e/bakery-site";
  await e2e(owner.request, "POST", "/importer/remote", { url: REPO, branch: "main", files: { "package.json": '{ "name": "bakery-site", "private": true }\n', "src/index.ts": "export default { fetch: () => new Response('hi') };\n" } });

  // a new organization lands on Members, which points at creating a project first
  await page.goto("/orgs/new");
  await page.getByLabel("Organization name").fill("Fresh Bakery");
  await page.getByRole("button", { name: "Create organization" }).click();
  await expect(page.getByText("Only owners so far.")).toBeVisible();
  await page.getByRole("link", { name: "Create a project" }).click();
  const gs = page.getByTestId("getting-started");
  await expect(gs).toContainText("1 of 6 done");
  await gs.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill("Bakery site");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText("This project has no folders yet.")).toBeVisible();
  const orgId = /\/o\/([^/]+)\/p\//.exec(page.url())![1]!;
  const overview = () => page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Overview" }).click();

  // 1. code: a public Git import (the fake importer serves REPO)
  await overview();
  await expect(gs).toContainText("2 of 10 done");
  await gs.getByRole("link", { name: "Import from Git" }).click();
  await page.getByLabel("Repository address").fill(REPO);
  await page.getByRole("button", { name: "Import repository" }).click();
  await expect(page.getByTestId("intake-result")).toContainText("Imported", { timeout: 30_000 });
  await overview();
  await expect(gs.getByTestId("gs-code")).toHaveAttribute("data-done", "true", { timeout: 20_000 });

  // 2. release target: the Policy's Release example, validated and saved by the real Worker
  await gs.getByTestId("gs-release").getByRole("link", { name: "Open Policy" }).click();
  const policy = page.getByRole("region", { name: "Policy" });
  const useExample = async (section: string) => {
    const box = page.getByTestId(`policy-json-${section}`);
    await box.getByText("Show example").click();
    await box.getByRole("button", { name: "Use this example" }).click();
    await expect(policy.getByRole("button", { name: "Review changes" })).toBeEnabled({ timeout: 20_000 });
    await policy.getByRole("button", { name: "Review changes" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
  };
  await expect(page.getByTestId("policy-json-release").getByLabel("Example: Release")).toContainText(`cfapp-${orgId}-site`, { timeout: 20_000 });
  await useExample("release");
  await expect(policy).toContainText("Revision 1");

  // 3. the first production publish, from Versions (the imported first version)
  await overview();
  await expect(gs.getByTestId("gs-release")).toHaveAttribute("data-done", "true");
  await gs.getByTestId("gs-publish").getByRole("link", { name: "Open Versions" }).click();
  const panel = page.getByTestId("publish-version");
  await expect(panel).toContainText("Nothing has been published from this project yet.");
  await panel.getByRole("button", { name: "Publish this version" }).click();
  await panel.getByRole("button", { name: "Approve publishing this release" }).click({ timeout: 30_000 });
  await panel.getByRole("button", { name: "Publish to production" }).click();
  await expect(panel.locator(".badge", { hasText: /^Live$/ })).toBeVisible({ timeout: 45_000 });
  // the version list follows without a reload
  await expect(page.locator("li.version-live").locator(".badge", { hasText: /^Live$/ })).toBeVisible({ timeout: 20_000 });

  // 4. staging: the Staging example; production is live, so staging starts at once (no waiting)
  await overview();
  await expect(gs.getByTestId("gs-publish")).toHaveAttribute("data-done", "true", { timeout: 20_000 });
  await gs.getByTestId("gs-staging").getByRole("link", { name: "Open Policy" }).click();
  await useExample("staging");
  await expect(policy).toContainText("Revision 2");
  await expect(page.getByTestId("staging-header")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("staging-awaiting")).toHaveCount(0);

  // 5. invite the client with access to the project
  await overview();
  await expect(gs.getByTestId("gs-staging")).toHaveAttribute("data-done", "true");
  await gs.getByTestId("gs-client").getByRole("link", { name: "Open Members" }).click();
  const invite = page.getByRole("form", { name: "Invite a member" });
  await invite.getByLabel("Email").fill(CLIENT2);
  await invite.getByLabel("Role").selectOption("client");
  await invite.getByRole("checkbox", { name: "Bakery site" }).check();
  await invite.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Only owners so far.")).toHaveCount(0);
  await page.getByRole("navigation", { name: "Organization" }).getByRole("link", { name: "Projects" }).click();
  await page.getByRole("link", { name: /Bakery site/ }).click();
  const pid = /\/p\/([^/]+)\//.exec(page.url())![1]!;
  await overview();
  await expect(gs.getByTestId("gs-client")).toHaveAttribute("data-done", "true", { timeout: 20_000 });

  // 5b. a new client can read only: the owner chooses what they can change, on the access screen
  const client = await browser.newContext();
  const cpage = await client.newPage();
  try {
    await signIn(cpage, CLIENT2);
    await cpage.goto(`/o/${orgId}/p/${pid}/tasks`);
    await expect(cpage.getByTestId("client-path")).toContainText("clients ask for changes as tasks");
    const refused = await inPage(cpage, "POST", `/api/orgs/${orgId}/projects/${pid}/tasks`, { title: "Too early" });
    expect(refused.status, refused.text).toBe(403);

    await expect(gs.getByTestId("gs-clientAccess")).toHaveAttribute("data-done", "false");
    await gs.getByTestId("gs-clientAccess").getByRole("link", { name: "Open Access" }).click();
    await page.getByLabel(`Access of ${CLIENT2}`, { exact: true }).selectOption({ label: "Can change" });
    await page.getByRole("button", { name: `Save access for ${CLIENT2}` }).click();
    await expect(page.getByRole("button", { name: `Save access for ${CLIENT2}` })).toBeDisabled();
    await overview();
    await expect(gs.getByTestId("gs-clientAccess")).toHaveAttribute("data-done", "true", { timeout: 20_000 });

    // 6. the client creates the first task: a title and the request, no folders to choose
    await cpage.reload();
    await cpage.getByTestId("new-task-open").click();
    const form = cpage.getByTestId("new-task");
    await expect(form.locator('input[name="write"]')).toHaveCount(0);
    await form.getByLabel("Title").fill("New opening hours");
    await form.getByLabel("What should the agent do?").fill("Open at 7 on Saturdays.");
    await cpage.getByTestId("new-task-submit").click();
    await expect(cpage.getByTestId("handoff-copy-prompt")).toBeVisible();
  } finally {
    await client.close();
  }
  await page.reload();
  await expect(page.getByTestId("getting-started").getByTestId("gs-task")).toHaveAttribute("data-done", "true", { timeout: 20_000 });
  await expect(page.getByTestId("getting-started")).toContainText("9 of 10 done");
});
