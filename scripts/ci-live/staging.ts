/**
 * Live always-on staging run on the CI deployment (staging Phase 4-1): real staging Workers with a
 * platform-created D1 (migrated and seeded), and promotions that apply migrations to the production
 * D1 before the code. The three demo tasks, each by the client's own agent (lease only):
 *
 *   copy change   website/index.html                 → gate self       → live
 *   phone field   api/src + additive migration 0002  → gate classify   → Jev asked; a developer
 *                                                                         approves if it declines → live
 *   rename column destructive migration 0003         → veto            → sent back, rolled back
 *
 *   pnpm build && node scripts/ci-live/staging.ts [--keep] [--dry-run] [--evidence <file>]
 *
 * CI only (log-mode sign-in links from the Worker log). The classifier's answer on the phone field is
 * recorded, not asserted (plan ruling P4-5): the run fails only when the classifier was not asked or
 * was unavailable. The rename is never approved (P4-4). Cleanup (unless --keep; a failed run keeps
 * everything) deletes the release and `-staging` Workers, the org's D1 and KV (production and
 * staging), the Artifacts namespaces and the sessions.
 * Evidence: evidence/ci/staging-<runId>.json
 */
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { agentIdentity, cforgeJson, subprocessCforge } from "../../apps/demo-agents/dist/index.js";
import { API, ArtifactsOperator, Client, Evidence, PROTECTED_ORGS, REPO, RELEASE_PREFIX, Tail, cliSignIn, devVars, poll, redact, requireCiTarget, rmrf, run, secret, webSignIn } from "./lib.ts";
import { cleanupRun, demoPolicy, setupDemoProject } from "./project.ts";
requireCiTarget("staging.ts");

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const DRY = args.includes("--dry-run");
const arg = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${randomBytes(2).toString("hex")}`;
const evidencePath = arg("--evidence") ?? join(REPO, "evidence", "ci", `staging-${runId}.json`);
const enc = encodeURIComponent;
const DEMO = join(REPO, "fixtures", "demo-tasks");
const COPY_FROM = "<h1>Customer Portal</h1>";
const COPY_TO = "<h1>Customer Portal: quotes in seconds</h1>";
const LANDED = ["landed", "failed", "rolled_back"];
/** promotion states where the run acts or stops (everything else is still moving) */
const SETTLED = ["pending_approval", "live", "failed", "release_failed", "sent_back", "superseded", "withdrawn"];

if (DRY) {
  const sample = demoPolicy(
    { res: { api: { resourceId: "res-api" }, website: { resourceId: "res-website" }, requirements: { resourceId: "res-requirements" } }, apiWorker: `${RELEASE_PREFIX}-o-xxxx-api`, siteWorker: `${RELEASE_PREFIX}-o-xxxx-website`, sub: "commonforge", kvId: "<kv>", d1Id: "<d1>" },
    { staging: true },
  );
  console.log(`dry run against ${API}\n\npolicy (staging part):\n${JSON.stringify((sample as any).staging, null, 2)}\n`);
  console.log([
    "1. owner signs in (cforge), sets up the project with staging (production D1, baseline release)",
    "2. client signs in (web); copy task on website → landed; staging serves the copy, seeded D1 (2 contacts), KV",
    "3. POST <api>-staging/orders → a capture in Sent from staging",
    "4. promote copy → gate self → live; production page shows the copy",
    "5. phone task on api (patch + 0002) → landed; staging stores a phone → promote → classifier asked → (approve) → live; production stores a phone",
    "6. rename task on api (patch + 0003) → landed → promote → veto (destructive), pending → send back → rollback → staging rebuilt",
    `7. cleanup${KEEP ? " skipped (--keep)" : ""}`,
  ].join("\n"));
  process.exit(0);
}

const ev = new Evidence("ci-staging");
const vars = await devVars();
const op = new ArtifactsOperator(vars.CF_ACCOUNT_ID!, vars.CF_API_TOKEN!);
const runDir = await mkdtemp(join(tmpdir(), "cf-ci-staging-"));
const tail = await Tail.start(vars);
const cforge = subprocessCforge();
ev.facts.runId = runId;

let orgId = "";
let kvId = "";
let d1Id: string | undefined;
let owner!: Client;
let client!: Client;

/** GET a public URL (the deployed demo Workers) → { status, json?, text } */
async function hit(url: string, init?: RequestInit): Promise<{ status: number; text: string; json?: any }> {
  const r = await fetch(url, { ...init, headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, text, json };
}

/** retry a public check while the Worker's new version propagates */
async function eventually<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  return poll(what, fn, ok, 3 * 60_000, 5000);
}

try {
  await ev.step("health (CI, no chaos)", async () => {
    const h = await (await fetch(`${API}/health`)).json() as any;
    if (h.deployment !== "ci") throw new Error(`not the CI deployment: ${JSON.stringify(h)}`);
    if (h.chaos) throw new Error(`chaos flags active: ${JSON.stringify(h.chaos)}`);
    return h;
  }, (h) => h);

  const ownerEmail = `ci-owner-${runId}@commonforge.invalid`;
  const clientEmail = `ci-client-${runId}@commonforge.invalid`;
  const ownerS = await ev.step("owner signs in (cforge login, code from the worker log)", () => cliSignIn(tail, ownerEmail, join(runDir, "owner-cforge")), () => ({ email: ownerEmail }));
  owner = new Client("owner", { bearer: ownerS.bearer });

  const proj = await setupDemoProject({
    ev, owner, op, runDir, orgName: `CI staging ${runId}`, clientEmail, staging: true,
    onOrg: (id) => {
      if (PROTECTED_ORGS.includes(id)) throw new Error(`created org ${id} is protected`);
      orgId = id;
    },
    onKv: (id) => (kvId = id),
    onD1: (id) => (d1Id = id),
  });
  const O = `/api/orgs/${enc(orgId)}`;
  const P = `${O}/projects/${enc(proj.projectId)}`;
  const host = (worker: string) => `https://${worker}.${proj.workersDevSubdomain}.workers.dev`;
  const api = { prod: host(proj.apiWorker), stg: host(`${proj.apiWorker}-staging`) };
  const site = { prod: host(proj.siteWorker), stg: host(`${proj.siteWorker}-staging`) };
  ev.facts.urls = { api, site };

  client = new Client("client", { cookie: await ev.step("client signs in (web link from the worker log, click → cookie)", () => webSignIn(tail, clientEmail)) });

  await ev.step("production D1 migrated by the baseline release, never seeded", async () => {
    const c = await eventually("production /contacts", () => hit(`${api.prod}/contacts`), (r) => r.status === 200);
    if (!Array.isArray(c.json?.contacts) || c.json.contacts.length !== 0) throw new Error(`production contacts: ${c.text.slice(0, 300)}`);
    return { contacts: c.json.contacts.length };
  }, (v) => v);

  // ------------------------------------------------------------ a client task by the client's agent
  const clientTask = async (label: string, title: string, request: string, mounts: string[], edit: (ws: string) => Promise<void>) => {
    const t = await ev.step(`${label}: client creates the task (${mounts.join(", ")})`, async () => {
      const created = await client.req("POST", `${P}/tasks`, { title, request, writeMounts: mounts, readMounts: [] });
      return poll("task provisioning", () => client.req("GET", `/api/tasks/${enc(created.taskId)}`), (v) => v.state !== "provisioning", 10 * 60_000);
    }, (v) => ({ taskId: v.taskId, state: v.state }));
    if (t.state !== "ready") throw new Error(`${label}: task ${t.state}`);
    const taskId: string = t.taskId;
    const lease = await ev.step(`${label}: client takes the lease and hands it to their agent`, () => client.req("POST", `/api/tasks/${enc(taskId)}/lease`, { ttlSeconds: 3600 }), (l) => ({ leaseGeneration: l.leaseGeneration }));
    secret(lease.leaseToken);
    const dir = join(runDir, label);
    const ws = join(dir, "ws");
    await mkdir(dir, { recursive: true });
    const ident = await agentIdentity(join(dir, "home"), "Client Agent", API, lease.leaseToken);
    await ev.step(`${label}: cforge checkout (from live staging)`, async () => {
      const c = await cforgeJson<any>(cforge, ["checkout", taskId, ws], { cwd: dir, env: ident.env });
      if (!c.verified) throw new Error("checkout not verified");
      return c;
    }, (c) => ({ verified: c.verified, mounts: c.mounts.map((m: any) => `${m.mountName}:${m.kind}${m.writable ? ":w" : ""}`) }));
    await ev.step(`${label}: agent edits`, () => edit(ws));
    await ev.step(`${label}: cforge submit (push, freeze → staging landing)`, () =>
      cforgeJson<any>(cforge, ["submit", ...mounts.flatMap((m) => ["--mount", m]), "--commit", title, "--tool", "ci-staging"], { cwd: ws, env: ident.env }),
      (s) => s.candidates.map((c: any) => ({ mount: c.mountName, sha: c.sha, changedPaths: c.changedPaths })));
    const landing = await ev.step(`${label}: landed in staging`, async () => {
      const st = await poll(`${label} landing`, async () => {
        const s = await owner.req("GET", `${P}/staging`);
        return { s, l: s.landings.find((x: any) => x.taskId === taskId) };
      }, (v) => !!v.l && LANDED.includes(v.l.state) && !v.s.building, 20 * 60_000, 5000);
      if (st.l.state !== "landed") throw new Error(`${label}: landing ${st.l.state}: ${st.l.reasonCode} ${redact(String(st.l.detail ?? st.l.reason ?? "")).slice(0, 400)}`);
      return { ...st.l, buildId: st.s.current?.buildId };
    }, (l) => ({ landingId: l.landingId, state: l.state, buildId: l.buildId }));
    return { taskId, landing };
  };

  const promote = async (label: string, taskId: string) =>
    ev.step(`${label}: client promotes`, async () => {
      const r = await client.req("POST", `/api/tasks/${enc(taskId)}/promote`, {});
      return settle(label, r.promotionId);
    }, view);
  const settle = (label: string, promotionId: string) =>
    poll(`${label} promotion`, () => owner.req("GET", `${O}/promotions/${enc(promotionId)}`), (p) => SETTLED.includes(p.state), 30 * 60_000, 5000);
  const view = (p: any) => ({
    promotionId: p.promotionId, state: p.state, level: p.level, reasonCode: p.reasonCode, reason: p.reason,
    pathLevel: p.gate?.pathLevel, veto: p.gate?.veto, classifier: p.gate?.classifier, releaseId: p.releaseId,
  });

  // ------------------------------------------------------------ 1. copy change → self
  const copy = await clientTask("copy", "Update the home page heading", "Say quotes take seconds.", ["website"], async (ws) => {
    const f = join(ws, "website", "index.html");
    const html = await readFile(f, "utf8");
    if (!html.includes(COPY_FROM)) throw new Error("heading not found in website/index.html");
    await writeFile(f, html.replace(COPY_FROM, COPY_TO));
  });

  await ev.step("staging serves the copy; staging api on its own seeded D1 and KV", async () => {
    const page = await eventually("staging page", () => hit(site.stg), (r) => r.status === 200 && r.text.includes(COPY_TO));
    const version = await eventually("staging /version", () => hit(`${api.stg}/version`), (r) => r.status === 200);
    if (version.json?.version !== "1.0.0-staging") throw new Error(`staging version ${version.text}`);
    const contacts = await hit(`${api.stg}/contacts`);
    const rows = contacts.json?.contacts ?? [];
    if (contacts.status !== 200 || rows.length !== 2) throw new Error(`staging seed: ${contacts.status} ${contacts.text.slice(0, 300)}`);
    const orders = await hit(`${api.stg}/orders/count`);
    if (orders.status !== 200) throw new Error(`staging KV: ${orders.status} ${orders.text.slice(0, 200)}`);
    const prodPage = await hit(site.prod);
    if (prodPage.text.includes(COPY_TO)) throw new Error("production shows the copy before promotion");
    return { page: page.status, version: version.json.version, seedContacts: rows.map((r: any) => r.name), orders: orders.json };
  }, (v) => v);

  await ev.step("Sent from staging: the staging api's payment webhook goes to the sink", async () => {
    const o = await hit(`${api.stg}/orders`, { method: "POST", body: JSON.stringify({ plan: "team", seats: 3, customer: `CI staging ${runId}` }) });
    if (o.status >= 300) throw new Error(`staging POST /orders ${o.status}: ${o.text.slice(0, 300)}`);
    // `charged` is the webhook's answer as the staging Worker saw it (false: the fetch never reached the sink)
    if (o.json?.charged !== true) throw new Error(`the staging Worker's webhook call failed: ${o.text.slice(0, 300)}`);
    const orderId: string = o.json.orderId;
    const sent = await poll("capture", () => owner.req("GET", `${P}/staging/sent`), (s) => s.captures.some((c: any) => String(c.body ?? "").includes(orderId)), 2 * 60_000, 3000);
    const c = sent.captures.find((x: any) => String(x.body ?? "").includes(orderId));
    return { order: o.status, charged: o.json.charged, captures: sent.captures.length, method: c.method, path: c.path };
  }, (v) => v);

  const copyP = await promote("copy", copy.taskId);
  if (copyP.state !== "live" || copyP.gate?.pathLevel !== "self") throw new Error(`copy promotion ${copyP.state} (${copyP.gate?.pathLevel}, ${copyP.reasonCode})`);
  await ev.step("copy: production page shows the copy", async () => {
    const r = await eventually("production page", () => hit(site.prod), (x) => x.status === 200 && x.text.includes(COPY_TO));
    return { status: r.status };
  }, (v) => v);

  // ------------------------------------------------------------ 2. phone field → classify
  const phone = await clientTask("phone", "Add a phone field to the contacts", "Add a phone number to the contacts, saved and listed.", ["api"], async (ws) => {
    await run("git", ["apply", join(DEMO, "phone-field", "api-code.patch")], { cwd: join(ws, "api"), env: { PATH: process.env.PATH ?? "" } });
    await mkdir(join(ws, "api", "migrations"), { recursive: true });
    await copyFile(join(DEMO, "phone-field", "migrations", "0002_phone.sql"), join(ws, "api", "migrations", "0002_phone.sql"));
  });
  await ev.step("phone: staging D1 migrated (0002); staging stores a phone", async () => {
    // the old code also answers 201 (dropping phone): wait for the new version, then POST once (review I3)
    await eventually("staging lists phone", () => hit(`${api.stg}/contacts`), (r) => r.status === 200 && (r.json?.contacts ?? []).some((c: any) => "phone" in c));
    const add = await hit(`${api.stg}/contacts`, { method: "POST", body: JSON.stringify({ name: "Staging Phone", email: "phone@example.com", phone: "+1 555 0100" }) });
    if (add.status !== 201) throw new Error(`staging POST /contacts ${add.status}: ${add.text.slice(0, 300)}`);
    const list = await hit(`${api.stg}/contacts`);
    const row = (list.json?.contacts ?? []).find((r: any) => r.name === "Staging Phone");
    if (row?.phone !== "+1 555 0100") throw new Error(`staging contacts: ${list.text.slice(0, 300)}`);
    return { add: add.status, row };
  }, (v) => v);

  let phoneP = await promote("phone", phone.taskId);
  const cls = phoneP.gate?.classifier;
  ev.facts.phoneClassifier = cls ?? null;
  if (phoneP.gate?.pathLevel !== "classify" || !cls?.asked || !["cleared", "declined"].includes(cls.reason)) {
    throw new Error(`phone: classifier not asked or unavailable: level ${phoneP.gate?.pathLevel}, ${JSON.stringify(cls ?? null).slice(0, 400)}`);
  }
  if (phoneP.state === "pending_approval") {
    phoneP = await ev.step("phone: classifier declined → owner (developer) approves", async () => {
      await owner.req("POST", `${O}/promotions/${enc(phoneP.promotionId)}/approve`, {});
      return settle("phone (approved)", phoneP.promotionId);
    }, view);
  }
  if (phoneP.state !== "live") throw new Error(`phone promotion ${phoneP.state} (${phoneP.reasonCode}: ${phoneP.reason})`);
  await ev.step("phone: production D1 migrated (0002) before the code; production stores a phone", async () => {
    // production has no rows yet, so the new version is recognised by its SELECT: an empty list from the
    // old code and the new one look alike; wait until /version names the promotion's release instead
    await eventually("production runs the phone release", () => hit(`${api.prod}/version`), (r) => r.status === 200 && !!phoneP.releaseId && r.json?.release === phoneP.releaseId);
    const add = await hit(`${api.prod}/contacts`, { method: "POST", body: JSON.stringify({ name: "Production Phone", email: "prod@example.com", phone: "+1 555 0199" }) });
    if (add.status !== 201) throw new Error(`production POST /contacts ${add.status}: ${add.text.slice(0, 300)}`);
    const list = await hit(`${api.prod}/contacts`);
    const rows = list.json?.contacts ?? [];
    if (rows.length !== 1 || rows[0].phone !== "+1 555 0199") throw new Error(`production contacts: ${list.text.slice(0, 300)}`);
    return { add: add.status, rows };
  }, (v) => v);

  // ------------------------------------------------------------ 3. rename column → veto, sent back
  const rename = await clientTask("rename", "Rename the contact email column", "Call the email column email_address.", ["api"], async (ws) => {
    await run("git", ["apply", join(DEMO, "rename-column", "api-code.patch")], { cwd: join(ws, "api"), env: { PATH: process.env.PATH ?? "" } });
    for (const f of ["0003_rename_email.sql"]) await copyFile(join(DEMO, "rename-column", "migrations", f), join(ws, "api", "migrations", f));
  });
  const renameP = await promote("rename", rename.taskId);
  if (renameP.state !== "pending_approval" || renameP.gate?.veto?.kind !== "destructive" || renameP.gate?.classifier?.asked) {
    throw new Error(`rename: expected a destructive veto, pending, classifier not asked: ${JSON.stringify(view(renameP)).slice(0, 600)}`);
  }
  await ev.step("rename: owner sends it back (never approved, P4-4)", async () => {
    const p = await owner.req("POST", `${O}/promotions/${enc(renameP.promotionId)}/send-back`, { note: "Renaming a column breaks existing callers; add a new column instead." });
    if (p.state !== "sent_back") throw new Error(`send-back: ${p.state}`);
    const seen = await client.req("GET", `${O}/promotions/${enc(renameP.promotionId)}`);
    return { state: p.state, clientSees: { state: seen.state, reason: seen.reason, hasGate: "gate" in seen } };
  }, (v) => v);
  await ev.step("rename: client rolls it back; staging rebuilt without it (fresh data)", async () => {
    await client.req("POST", `/api/tasks/${enc(rename.taskId)}/rollback`, {});
    const st = await poll("rollback", async () => {
      const s = await owner.req("GET", `${P}/staging`);
      return { s, l: s.landings.find((x: any) => x.taskId === rename.taskId) };
    }, (v) => v.l?.state === "rolled_back" && !v.s.building, 20 * 60_000, 5000);
    const list = await eventually("staging /contacts after rollback", () => hit(`${api.stg}/contacts`), (r) => r.status === 200 && Array.isArray(r.json?.contacts) && r.json.contacts.length === 2 && r.json.contacts.every((c: any) => "email" in c));
    return { landing: st.l.state, buildId: st.s.current?.buildId, contacts: list.json.contacts.length };
  }, (v) => v);

  await ev.step("production unchanged by the rename", async () => {
    const list = await hit(`${api.prod}/contacts`);
    const rows = list.json?.contacts ?? [];
    if (rows.length !== 1 || !("email" in rows[0])) throw new Error(`production contacts: ${list.text.slice(0, 300)}`);
    return { rows: rows.length };
  }, (v) => v);
} catch (e) {
  process.stderr.write(`run failed: ${redact(e instanceof Error ? e.stack ?? e.message : String(e))}\n`);
  process.exitCode = 1;
} finally {
  const runOk = ev.steps.every((s) => s.ok) && !process.exitCode;
  if (!KEEP && orgId && runOk) await cleanupRun({ ev, op, orgId, kvId, d1Id, sessions: [client, owner] });
  else if (orgId) process.stderr.write(`kept: org ${orgId}: ${RELEASE_PREFIX}-${orgId}-* Workers (release and -staging), D1 and KV named ${RELEASE_PREFIX}-${orgId}-*, Artifacts namespaces; delete with cleanup-org.ts or sweep.ts\n`);
  tail.stop();
  ev.facts.orgId = orgId;
  ev.facts.kept = KEEP || !(ev.steps.every((s) => s.ok) && !process.exitCode);
  await ev.write(evidencePath);
  process.stderr.write(`evidence: ${evidencePath}\n`);
  if (!KEEP) await rmrf(runDir);
  process.exit(process.exitCode ?? 0);
}
