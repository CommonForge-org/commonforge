/**
 * Live check of the recording seed in staging mode on the CI deployment (staging Phase 4-2, Task 3):
 * `video/scripts/seed-demo.ts --staging --stage-tasks` exactly as the owner runs it on recording
 * day, then the take's three beats with a screenshot of each screen the video shows:
 *
 *   board      the client's Tasks board: three cards In staging
 *   copy       client promotes → gate self → live
 *   phone      client promotes → classifier asked → (declined: client sees it waiting, the developer's
 *              review screen shows Jev's answers, the developer approves) → live
 *   rename     client promotes → migration veto → the developer's review names the statement →
 *              sent back → the client sees the note
 *
 *   pnpm --filter @commonforge-org/cli --filter @commonforge-org/demo-agents build
 *   node scripts/ci-live/seed-staging.ts [--keep] [--evidence <file>]
 *
 * CI only (log-mode sign-in links). Cleanup (unless --keep; a failed run keeps everything) is
 * cleanupRun: release and `-staging` Workers, the org's D1 and KV, Artifacts namespaces, sessions.
 * Evidence: evidence/ci/seed-staging-<runId>.json and screenshots in evidence/ci/seed-staging-<runId>/.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, ArtifactsOperator, Client, Evidence, PROTECTED_ORGS, REPO, RELEASE_PREFIX, Tail, cliSignIn, devVars, poll, redact, requireCiTarget, rmrf, run, webSignIn } from "./lib.ts";
import { cleanupRun } from "./project.ts";
requireCiTarget("seed-staging.ts");

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const arg = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${randomBytes(2).toString("hex")}`;
const evidencePath = arg("--evidence") ?? join(REPO, "evidence", "ci", `seed-staging-${runId}.json`);
const shotDir = evidencePath.replace(/\.json$/, "");
const enc = encodeURIComponent;
const SETTLED = ["pending_approval", "live", "failed", "release_failed", "sent_back", "superseded", "withdrawn"];

// Playwright from video/ (its devDependency), as capture uses it
const { chromium } = createRequire(join(REPO, "video", "package.json"))("playwright") as typeof import("playwright");

const ev = new Evidence("ci-seed-staging");
const vars = await devVars();
const op = new ArtifactsOperator(vars.CF_ACCOUNT_ID!, vars.CF_API_TOKEN!);
const runDir = await mkdtemp(join(tmpdir(), "cf-ci-seed-staging-"));
const tail = await Tail.start(vars);
ev.facts.runId = runId;

let orgId = "";
let d1Id: string | undefined;
let owner: Client | undefined;
let client: Client | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

/** the seed, as the owner runs it (`pnpm seed -- …` from video/), output streamed to this run's log */
function seed(env: Record<string, string>, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(join(REPO, "video", "node_modules", ".bin", "tsx"), ["scripts/seed-demo.ts", ...argv], { cwd: join(REPO, "video"), env, stdio: ["ignore", "pipe", "pipe"] });
    let rest = "";
    const out = (b: Buffer) => {
      const lines = (rest + b.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) process.stderr.write(`    seed| ${redact(l)}\n`);
    };
    p.stdout.on("data", out);
    p.stderr.on("data", out);
    p.on("error", reject);
    p.on("close", (code) => (rest && process.stderr.write(`    seed| ${redact(rest)}\n`), code === 0 ? resolve() : reject(new Error(`seed-demo exited ${code}`))));
  });
}

try {
  await ev.step("health (CI, no chaos)", async () => {
    const h = (await (await fetch(`${API}/health`)).json()) as any;
    if (h.deployment !== "ci") throw new Error(`not the CI deployment: ${JSON.stringify(h)}`);
    if (h.chaos) throw new Error(`chaos flags active: ${JSON.stringify(h.chaos)}`);
    return h;
  }, (h) => h);

  const ownerEmail = `ci-owner-${runId}@commonforge.invalid`;
  const clientEmail = `ci-client-${runId}@commonforge.invalid`;
  const ownerDir = join(runDir, "owner-cforge");
  const clientDir = join(runDir, "client-cforge");
  const ownerS = await ev.step("owner signs in (cforge login)", () => cliSignIn(tail, ownerEmail, ownerDir), () => ({ email: ownerEmail }));
  owner = new Client("owner", { bearer: ownerS.bearer });
  await ev.step("client signs in (cforge login: the session file seed --stage-tasks uses)", () => cliSignIn(tail, clientEmail, clientDir), () => ({ email: clientEmail }));

  const video = join(runDir, "brand-video.mp4");
  await run(join(REPO, "fixtures/brand-assets/scripts/make-video.sh"), [video, "2"], { env: { PATH: process.env.PATH ?? "" } });
  const out = join(runDir, "seed-output.json");
  const orgName = `CI seed ${runId}`;
  await ev.step("seed-demo.ts --staging --stage-tasks (as on recording day)", async () => {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      CAPTURE_BASE_URL: API,
      CAPTURE_OWNER_SESSION_FILE: join(ownerDir, "session.json"),
      CAPTURE_CLIENT_SESSION_FILE: join(clientDir, "session.json"),
      CF_API_TOKEN: vars.CF_API_TOKEN!,
      CF_ACCOUNT_ID: vars.CF_ACCOUNT_ID!,
    };
    try {
      await seed(env, ["--new-org", orgName, "--client-email", clientEmail, "--staging", "--stage-tasks", "--video", video, "--out", out]);
    } finally {
      // the org id for cleanup, from the output or the partial file
      const partial = out.replace(/\.json$/, ".partial.json");
      const file = existsSync(out) ? out : existsSync(partial) ? partial : undefined;
      if (file) {
        const s = JSON.parse(await readFile(file, "utf8"));
        if (s.orgId && PROTECTED_ORGS.includes(s.orgId)) throw new Error(`seeded org ${s.orgId} is protected`);
        orgId = s.orgId ?? "";
        d1Id = s.staging?.productionD1Id ?? s.d1Id;
      }
    }
    return JSON.parse(await readFile(out, "utf8"));
  }, (s) => ({ orgId: s.orgId, projectId: s.projectId, editionId: s.editionId, staging: s.staging }));
  const s = JSON.parse(await readFile(out, "utf8"));
  const O = `/api/orgs/${enc(orgId)}`;
  const P = `${O}/projects/${enc(s.projectId)}`;
  const task = (key: string) => s.staging.tasks.find((t: any) => t.key === key).taskId as string;

  const clientCookie = await ev.step("client web sign-in (browser cookie)", () => webSignIn(tail, clientEmail));
  client = new Client("client", { cookie: clientCookie });
  const ownerCookie = await ev.step("owner web sign-in (browser cookie)", () => webSignIn(tail, ownerEmail));

  await mkdir(shotDir, { recursive: true });
  browser = await chromium.launch();
  const page = async (cookie: string) => {
    const ctx = await browser!.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const [name, ...rest] = cookie.split("=");
    await ctx.addCookies([{ name: name!, value: rest.join("="), url: API }]);
    return ctx.newPage();
  };
  const clientPage = await page(clientCookie);
  const devPage = await page(ownerCookie);
  const shot = async (p: Awaited<ReturnType<typeof page>>, name: string, url: string, ready: string) => {
    await p.goto(`${API}${url}`);
    await p.waitForSelector(ready, { timeout: 60_000 });
    await p.waitForTimeout(1500);
    const file = join(shotDir, `${name}.png`);
    await p.screenshot({ path: file, fullPage: true });
    return file;
  };
  const board = `/o/${enc(orgId)}/p/${enc(s.projectId)}/tasks`;
  const review = (id: string) => `/o/${enc(orgId)}/p/${enc(s.projectId)}/promotions/${enc(id)}`;

  await ev.step("screenshot: client board, three cards In staging", async () => {
    const st = await owner!.req("GET", `${P}/staging`);
    const landed = st.landings.filter((l: any) => l.state === "landed").length;
    if (landed !== 3) throw new Error(`expected 3 landed, got ${landed}`);
    await shot(clientPage, "01-client-board-three-in-staging", board, '[data-testid="tasks-board"] [data-testid="task-card"]');
    const cards = await clientPage.locator('[data-testid="task-card"]').count();
    if (cards < 3) throw new Error(`the board shows ${cards} cards`);
    return { landed, cards };
  }, (v) => v);

  const settle = (label: string, id: string) => poll(`${label} promotion`, () => owner!.req("GET", `${O}/promotions/${enc(id)}`), (p) => SETTLED.includes(p.state), 30 * 60_000, 5000);
  const promote = (label: string, key: string) =>
    ev.step(`${label}: client promotes`, async () => settle(label, (await client!.req("POST", `/api/tasks/${enc(task(key))}/promote`, {})).promotionId), view);
  const view = (p: any) => ({ promotionId: p.promotionId, state: p.state, reasonCode: p.reasonCode, pathLevel: p.gate?.pathLevel, veto: p.gate?.veto, classifier: p.gate?.classifier, releaseId: p.releaseId });

  const copyP = await promote("copy", "copy");
  if (copyP.state !== "live" || copyP.gate?.pathLevel !== "self") throw new Error(`copy promotion ${copyP.state} (${copyP.gate?.pathLevel}, ${copyP.reasonCode})`);
  await ev.step("screenshot: client board after the copy went live", () => shot(clientPage, "02-client-board-copy-live", board, '[data-testid="task-card"]'));

  let phoneP = await promote("phone", "phone");
  ev.facts.phoneClassifier = phoneP.gate?.classifier ?? null;
  if (phoneP.gate?.pathLevel !== "classify" || !phoneP.gate?.classifier?.asked) throw new Error(`phone: classifier not asked: ${JSON.stringify(view(phoneP)).slice(0, 400)}`);
  if (phoneP.state === "pending_approval") {
    await ev.step("screenshot: client board, phone waiting for a developer", () => shot(clientPage, "03-client-board-phone-pending", board, '[data-testid="task-card"]'));
    await ev.step("screenshot: developer review of the phone field (Jev's answers)", () => shot(devPage, "04-developer-review-phone", review(phoneP.promotionId), '[data-testid="promotion-review"]'));
    phoneP = await ev.step("phone: the developer approves", async () => {
      await owner!.req("POST", `${O}/promotions/${enc(phoneP.promotionId)}/approve`, {});
      return settle("phone (approved)", phoneP.promotionId);
    }, view);
  }
  if (phoneP.state !== "live") throw new Error(`phone promotion ${phoneP.state} (${phoneP.reasonCode})`);

  const renameP = await promote("rename", "rename");
  if (renameP.state !== "pending_approval" || renameP.gate?.veto?.kind !== "destructive") throw new Error(`rename: expected a destructive veto: ${JSON.stringify(view(renameP)).slice(0, 400)}`);
  await ev.step("screenshot: developer review of the rename (migration veto)", () => shot(devPage, "05-developer-review-rename-veto", review(renameP.promotionId), '[data-testid="promotion-review"]'));
  await ev.step("rename: the developer sends it back", async () => {
    const p = await owner!.req("POST", `${O}/promotions/${enc(renameP.promotionId)}/send-back`, { note: "Renaming a column breaks existing callers; add a new column instead." });
    if (p.state !== "sent_back") throw new Error(`send-back: ${p.state}`);
    return { state: p.state };
  }, (v) => v);
  await ev.step("screenshot: client board, rename sent back with the note", () => shot(clientPage, "06-client-board-rename-sent-back", board, '[data-testid="task-card"]'));

  await ev.step("the staging guards: a manual proposal and a preview are refused (P42-2)", async () => {
    const refusal = (e: any) => ({ status: e?.status, code: e?.code });
    const proposal = await owner!.req("POST", `${O}/proposals`, { taskId: task("rename") }).then(() => ({ status: 200 }), refusal);
    if (proposal.status !== 409) throw new Error(`POST proposals: ${JSON.stringify(proposal)}`);
    return { proposal };
  }, (v) => v);
} catch (e) {
  process.stderr.write(`run failed: ${redact(e instanceof Error ? e.stack ?? e.message : String(e))}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  const runOk = ev.steps.every((s) => s.ok) && !process.exitCode;
  if (!KEEP && orgId && runOk) await cleanupRun({ ev, op, orgId, kvId: "", ...(d1Id ? { d1Id } : {}), sessions: [client, owner] });
  else if (orgId) process.stderr.write(`kept: org ${orgId}: ${RELEASE_PREFIX}-${orgId}-* Workers (release and -staging), D1 and KV named ${RELEASE_PREFIX}-${orgId}-*, Artifacts namespaces; delete with cleanup-org.ts or sweep.ts\n`);
  tail.stop();
  ev.facts.orgId = orgId;
  ev.facts.screenshots = shotDir;
  ev.facts.kept = KEEP || !runOk;
  await ev.write(evidencePath);
  process.stderr.write(`evidence: ${evidencePath}\n`);
  if (!KEEP) await rmrf(runDir);
  process.exit(process.exitCode ?? 0);
}
