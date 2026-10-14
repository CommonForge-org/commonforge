#!/usr/bin/env node
// Smoke test of a NON-PRODUCTION bootstrap deployment in email log mode (Task 24):
// sign in through the log-mode magic link (wrangler tail), create an organization and a project,
// list both, create an org KV namespace, then upload a tiny ZIP to intake (a runner `inventory` job: proves queue → runner
// container → R2 → control plane) and confirm it into the project (creates Artifacts repos).
//
//   node scripts/bootstrap/smoke.mjs <name>        (after scripts/bootstrap.sh --email-mode log)
//
// Credentials: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID for `wrangler tail`. Never prints the
// sign-in token or the session cookie.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNames, stateDir } from "./deployment.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_DIR = join(REPO, "apps", "worker");
const name = process.argv[2];
const st = JSON.parse(readFileSync(join(stateDir(name), "deployment.json"), "utf8"));
const n = resolveNames(name, { base: st.base, d1Id: st.d1Id, domains: { appDomain: st.appDomain, previewDomain: st.previewDomain } }); // refuses production / CI names
const API = n.workerUrl;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(`  ${s}`);

const health = await (await fetch(`${API}/health`)).json();
if (health.deployment !== name || health.emailMode !== "log") throw new Error(`smoke needs ${name} in log mode; /health says ${JSON.stringify(health)}`);

// --- the Worker log (log-mode sign-in links) -------------------------------------------------
let buf = "";
const tail = spawn("pnpm", ["exec", "wrangler", "tail", n.worker, "--format", "json"], {
  cwd: WORKER_DIR,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    WRANGLER_SEND_METRICS: "false",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let connected = false;
tail.stdout.on("data", (d) => (buf += d.toString()));
tail.stderr.on("data", (d) => /Connected to|Successfully created tail/i.test(d.toString()) && (connected = true));
for (let i = 0; i < 60 && !connected; i++) await sleep(500);
await sleep(2000);

// a fixed address: bootstrap.sh --smoke adds it to COMMONFORGE_ADMIN_EMAILS so the smoke may create an org
const email = "smoke@example.com";
const h = {
  "content-type": "application/json",
  origin: API,
  accept: "application/json",
};
let token = null;
for (let attempt = 1; attempt <= 3 && !token; attempt++) {
  const mark = buf.length;
  const r = await fetch(`${API}/api/auth/magic-link`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({ email }),
  });
  if (r.status !== 202) throw new Error(`magic-link → ${r.status}`);
  const re = new RegExp(`magic link for ${email.replace(/[.+]/g, "\\$&")}: (https://[^"\\s\\\\]+)`);
  for (let i = 0; i < 30 && !token; i++) {
    const m = re.exec(buf.slice(mark));
    if (m) token = new URL(m[1]).searchParams.get("token");
    else await sleep(1000);
  }
}
tail.kill("SIGINT");
if (!token) throw new Error("no sign-in link in the Worker log");
const v = await fetch(`${API}/api/auth/verify`, {
  method: "POST",
  headers: h,
  body: JSON.stringify({ token }),
});
if (!v.ok) throw new Error(`verify → ${v.status}`);
const cookie = v.headers
  .getSetCookie()
  .find((c) => c.startsWith("__Host-cf_session="))
  ?.split(";")[0];
if (!cookie) throw new Error("verify set no session cookie");
say(`signed in as ${email} (log-mode magic link)`);

const call = async (method, path, body, raw) => {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...h,
      cookie,
      ...(raw
        ? {
            "content-type": "application/zip",
            "content-length": String(raw.byteLength),
          }
        : {}),
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j?.error ?? j).slice(0, 300)}`);
  return j;
};

const org = await call("POST", "/api/orgs", { name: "Bootstrap smoke" });
const proj = await call("POST", `/api/orgs/${org.orgId}/projects`, {
  name: "Smoke project",
});
const orgs = (await call("GET", "/api/orgs")).orgs;
const projects = (await call("GET", `/api/orgs/${org.orgId}/projects`)).projects;
if (!orgs.some((o) => o.orgId === org.orgId) || !projects.some((p) => p.projectId === proj.projectId)) throw new Error("the new org/project is not listed");
say(`org ${org.orgId} and project ${proj.projectId} created and listed (${orgs.length} org, ${projects.length} project)`);

// an org KV namespace for releases (created on the deploy account as <prefix>-<org>-<name>)
const kv = await call("POST", `/api/orgs/${org.orgId}/deploy-resources`, { kind: "kv", name: "smoke" });
say(`org KV namespace ${kv.title} created`);

// --- runner container: intake inventory job ---------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "cfboot-smoke-"));
try {
  mkdirSync(join(work, "src", "site"), { recursive: true });
  writeFileSync(join(work, "src", "site", "index.html"), "<!doctype html><title>smoke</title><h1>CommonForge bootstrap smoke</h1>\n");
  writeFileSync(join(work, "src", "site", "README.md"), "# smoke\n");
  execFileSync("zip", ["-qr", join(work, "smoke.zip"), "site"], {
    cwd: join(work, "src"),
  });
  const zip = readFileSync(join(work, "smoke.zip"));
  const t0 = Date.now();
  const intake = await call("POST", `/api/orgs/${org.orgId}/intake/zip?name=smoke.zip`, undefined, zip);
  let i;
  for (;;) {
    i = await call("GET", `/api/orgs/${org.orgId}/intake/${intake.intakeId}`);
    if (i.state !== "inventorying") break;
    if (Date.now() - t0 > 5 * 60_000) throw new Error("intake inventory did not finish in 5 min (runner container?)");
    await sleep(3000);
  }
  if (i.state !== "inventoried") throw new Error(`intake ${i.state}: ${JSON.stringify(i.error ?? {}).slice(0, 300)}`);
  say(`runner inventory job ${intake.jobId} done in ${Math.round((Date.now() - t0) / 1000)} s (${(i.plan?.placements ?? []).map((pl) => `${pl.resourceName}: ${pl.files} files`).join(", ") || "inventoried"}; the runner container ran)`);
  const conf = await call("POST", `/api/orgs/${org.orgId}/intake/${intake.intakeId}/confirm`, { projectId: proj.projectId });
  say(`intake confirmed: resources ${conf.resources.map((r) => `${r.name} (${r.provider})`).join(", ")}`);
  // Populating confirmed resources from the archive is not implemented yet (API.md: `pendingPopulation:
  // true`), so they stay `empty`; the canonical Artifacts repo exists and is listed.
  const res = (await call("GET", `/api/orgs/${org.orgId}/resources`)).resources;
  say(`resources: ${res.map((r) => `${r.name}=${r.state}`).join(", ")}${conf.pendingPopulation ? " (population pending, as documented)" : ""}`);
  if (!conf.resources.every((c) => res.some((r) => r.resourceId === c.resourceId && ["empty", "active"].includes(r.state)))) throw new Error("a confirmed resource is missing or failed");
  const p = await call("GET", `/api/orgs/${org.orgId}/projects/${proj.projectId}`);
  say(`project mounts: ${p.mounts.map((m) => `${m.mountName}→${m.provider}`).join(", ")}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log("smoke: ok");
