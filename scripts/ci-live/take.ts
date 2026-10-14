/**
 * A timed dry run of the recording, on the CI deployment, following docs/REHEARSAL.md §3 beat by
 * beat with real agents. The browser clicks are made as the same API calls the web app sends; the
 * terminal steps (intake-plan, clone check, orchestrator, export) run exactly as documented.
 *
 *   pnpm build && node scripts/ci-live/take.ts [--dry-run] [--keep]
 *
 * Every beat records its take-clock time (0:00 = the orchestrator launch + LEAD seconds, as in
 * REHEARSAL.md: launch at T−2:45). Evidence: evidence/ci/take-<runId>/{take.json,…}.
 * Covers the three steps never rehearsed before review I3: the client's manual return concurrent
 * with agent 2, the restore to the version before agent 1, and publishing after the restore.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZip, writeZip } from "../../apps/demo-agents/dist/edition-zip.js";
import { API, ApiError, ArtifactsOperator, Client, Evidence, REPO, Tail, cliSignIn, devVars, poll, redact, rmrf, run, secret, sleep, webSignIn , requireCiTarget } from "./lib.ts";
requireCiTarget("take.ts");
import { cleanupRun, setupDemoProject } from "./project.ts";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const KEEP = args.includes("--keep");
const LEAD_S = 165; // REHEARSAL.md §3: launch the orchestrator at T−2:45
const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${randomBytes(2).toString("hex")}`;
const evDir = join(REPO, "evidence", "ci", `take-${DRY ? "dry-" : ""}${runId}`);
const enc = encodeURIComponent;

const ev = new Evidence(DRY ? "ci-take-dry-run" : "ci-take");
const vars = await devVars();
const op = new ArtifactsOperator(vars.CF_ACCOUNT_ID!, vars.CF_API_TOKEN!);
const runDir = await mkdtemp(join(tmpdir(), "cf-ci-take-"));
const tail = await Tail.start(vars);
let orgId = "";
let kvId = "";
let owner: Client | undefined;
let clientWeb: Client | undefined;
let clientCli: Client | undefined;
let take0 = 0;
const beats: Array<{ beat: string; takeClock: string; ms: number; detail?: unknown }> = [];
const clock = (t = Date.now()) => {
  const s = Math.round((t - take0) / 1000);
  const sign = s < 0 ? "−" : "";
  const a = Math.abs(s);
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
};
const beat = (name: string, detail?: unknown) => {
  const b = { beat: name, takeClock: clock(), ms: Date.now() - take0, ...(detail !== undefined ? { detail } : {}) };
  beats.push(b);
  process.stderr.write(`  [take ${b.takeClock}] ${name}\n`);
};
ev.facts.runId = runId;
ev.facts.dryRunAgents = DRY;

try {
  // ------------------------------------------------------------------ the day before / pre-flight
  const ownerEmail = `ci-owner-${runId}@commonforge.invalid`;
  const clientEmail = `ci-client-${runId}@commonforge.invalid`;
  const ownerDir = join(runDir, "owner-cforge");
  const clientDir = join(runDir, "client-cforge");
  const ownerS = await ev.step("owner signs in (cforge login)", () => cliSignIn(tail, ownerEmail, ownerDir));
  owner = new Client("owner", { bearer: ownerS.bearer });
  const proj = await setupDemoProject({ ev, owner, op, runDir, orgName: `CI take ${runId}`, clientEmail, onOrg: (id) => (orgId = id), onKv: (id) => (kvId = id) });
  const O = `/api/orgs/${enc(proj.orgId)}`;
  const P = `${O}/projects/${enc(proj.projectId)}`;
  const clientS = await ev.step("client signs in: cforge login (agent 2) and browser (manual return)", async () => {
    const s = await cliSignIn(tail, clientEmail, clientDir);
    const cookie = await webSignIn(tail, clientEmail);
    return { ...s, cookie };
  });
  clientCli = new Client("client-cli", { bearer: clientS.bearer });
  clientWeb = new Client("client-web", { cookie: clientS.cookie });

  const sub = proj.workersDevSubdomain;
  const releaseLive = async (label: string) => {
    const r = await owner!.req("POST", `${P}/releases`, {});
    const built = await poll(`${label} build`, () => owner!.req("GET", `${O}/releases/${enc(r.releaseId)}`), (v) => v.buildState !== "building", 25 * 60_000, 5000);
    if (built.buildState !== "built") throw new Error(`${label} build ${built.buildState}: ${JSON.stringify(built.error)}`);
    await owner!.req("POST", `${O}/releases/${enc(r.releaseId)}/publish-approvals`, { outputDigest: built.outputDigest });
    await owner!.req("POST", `${O}/releases/${enc(r.releaseId)}/deploy`, { idempotencyKey: `deploy-${label}-${runId}` });
    const done = await poll(`${label} live`, () => owner!.req("GET", `${O}/releases/${enc(r.releaseId)}`), (v) => ["live", "failed", "recovery_required", "partial"].includes(v.state), 20 * 60_000, 5000);
    if (done.state !== "live") throw new Error(`${label} ${done.state}: ${JSON.stringify(done.error)}`);
    const version: any = await (await fetch(`https://${proj.apiWorker}.${sub}.workers.dev/version`, { headers: { "cache-control": "no-cache" } })).json();
    // a just-deployed assets Worker can answer briefly with something else: retry until a PNG
    let logo = new Uint8Array();
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`https://${proj.siteWorker}.${sub}.workers.dev/logo.png?t=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
      logo = new Uint8Array(await res.arrayBuffer());
      if (res.ok && (res.headers.get("content-type") ?? "").includes("image/png")) break;
      await sleep(3000);
    }
    const q: any = await (await fetch(`https://${proj.apiWorker}.${sub}.workers.dev/quote?plan=enterprise&seats=300&customer=CI`)).json().catch(() => null);
    return { releaseId: r.releaseId, acceptedVersionId: done.acceptedVersionId, versionRelease: version.release, logoSha256: createHash("sha256").update(logo).digest("hex").slice(0, 16), quoteHasBreakdown: !!q?.breakdown };
  };
  const previous = await ev.step("the day before: publish the previous version (genesis) so it is live", () => releaseLive("previous"), (v) => v);
  // the teal logo every genesis website carries (fixtures/website/public/logo.png)
  const genesisLogo = createHash("sha256").update(await readFile(join(REPO, "fixtures/website/public/logo.png"))).digest("hex").slice(0, 16);
  if (previous.logoSha256 !== genesisLogo) process.stderr.write(`  note: the previous release served logo ${previous.logoSha256}, not the fixture's ${genesisLogo}\n`);

  await ev.step("pre-flight: the orchestrator command line parses (node apps/demo-agents/dist/main.js --help)", async () => {
    const r = await run(process.execPath, [join(REPO, "apps/demo-agents/dist/main.js"), "--help"], { env: { PATH: process.env.PATH ?? "" } });
    if (!r.stdout.includes("--api-url") && !r.stderr.includes("--api-url")) throw new Error("no usage text");
    return "ok";
  }, (v) => v);

  // ------------------------------------------------------------------ T−4:00: intake upload (pre-staged)
  const intake = await ev.step("T−4:00 pre-staged: intake-plan.ts uploads the demo mess folder (dry-run plan)", async () => {
    const out = join(runDir, "intake-plan.json");
    const t0 = Date.now();
    await run(process.execPath, [join(REPO, "scripts/demo/intake-plan.ts"), "--api-url", API, "--org", proj.orgId, "--config-dir", ownerDir, "--make-mess", join(runDir, "mess")], { env: { PATH: process.env.PATH ?? "", HOME: runDir, INTAKE_PLAN_JSON: out } });
    const v = JSON.parse(await readFile(out, "utf8"));
    return { intakeId: v.intakeId as string, ms: Date.now() - t0, placements: v.plan.placements.map((p: any) => `${p.resourceName} (${p.provider})`), excluded: v.plan.excluded.length };
  }, (v) => v);

  // ------------------------------------------------------------------ T−2:45: launch the orchestrator
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLOUDFLARE_|CF_|COMMONFORGE_)/.test(k)) env[k] = v;
  env.CFORGE_CONFIG_DIR = ownerDir;
  const orchestrate = (agents: string, dir: string, extra: string[], dry: boolean) => {
    const argv = [join(REPO, "apps/demo-agents/dist/main.js"), "--api-url", API, "--org", proj.orgId, "--project", proj.projectId, "--agents", agents, "--gate", "api", "--model", "sonnet", "--budget-usd", "3", "--step-timeout-min", "8", "--run-dir", join(runDir, `agents-${agents.replace(/,/g, "")}`), "--evidence-dir", dir, ...extra, ...(dry ? ["--dry-run"] : [])];
    const log: string[] = [];
    const done = new Promise<number>((resolve) => {
      const p = spawn(process.execPath, argv, { cwd: runDir, env, stdio: ["ignore", "pipe", "pipe"] });
      const onData = (d: Buffer) => {
        const s = redact(d.toString());
        log.push(s);
        for (const line of s.split("\n").filter((l) => /^agent-\d|^starting|gate attempt/.test(l))) process.stderr.write(`  [take ${clock()}] orchestrator: ${line}\n`);
      };
      p.stdout.on("data", onData);
      p.stderr.on("data", onData);
      p.on("close", (c) => resolve(c ?? -1));
    });
    return { done, log };
  };
  const launchedAt = Date.now();
  take0 = launchedAt + LEAD_S * 1000;
  beat("T−2:45 orchestrator launched (hidden pane): agents 1,2,3, client edition, gate api");
  const orch = orchestrate("1,2,3", evDir, ["--client-edition", "edition", "--client-config-dir", clientDir], DRY);
  const startSeq = 0;

  // ------------------------------------------------------------------ 0:00 intake (uploaded before the clock)
  while (Date.now() < take0) await sleep(500);
  beat("0:00 take starts: the intake plan (uploaded at T−4:00) is on screen; project tree");
  const plan = await owner.req("GET", `${O}/intake/${enc(intake.intakeId)}`);
  beat("intake plan shown", { placements: plan.plan.placements.length, excluded: plan.plan.excluded.length });

  while (Date.now() < take0 + 45_000) await sleep(500);
  // ------------------------------------------------------------------ 0:45 client: start an update
  const edition = await ev.step("0:45 client: Editions → Start an update → download the ZIP (after the orchestrator's build)", async () => {
    const ed = await poll("edition built by the orchestrator", async () => (await owner!.req("GET", `${P}/editions`)).editions.find((e: any) => e.ready), (e) => !!e, 5 * 60_000, 2000);
    const s = await clientWeb!.req("POST", `${O}/editions/${enc(ed.editionId)}/sessions`, { title: "Quote breakdown section", request: "Add a short breakdown note under the quote" });
    const zip = readZip(await clientWeb!.bytes(s.downloadUrl));
    return { editionId: ed.editionId, sessionId: s.sessionId, files: zip.size, zip };
  }, (v) => ({ editionId: v.editionId, sessionId: v.sessionId, files: v.files }));
  beat("client downloaded the working copy", { files: edition.files });
  const cloneCheck = await ev.step("0:45 terminal: scripts/demo/edition-clone-check.ts", async () => {
    const r = await run(process.execPath, [join(REPO, "scripts/demo/edition-clone-check.ts"), "--api-url", API, "--org", proj.orgId, "--session", edition.sessionId, "--mount", "website", "--client-config-dir", clientDir, "--owner-config-dir", ownerDir], { env: { PATH: process.env.PATH ?? "", HOME: runDir } });
    return r.stdout.trim().split("\n");
  }, (v) => v);
  beat("clone check shown", cloneCheck);

  // ------------------------------------------------------------------ 1:30 client edits and returns by hand
  while (Date.now() < take0 + 90_000) await sleep(500);
  const manual = await ev.step("1:30 client: edit index.html in their tool, zip, Send it back (concurrent with agent 2)", async () => {
    const before = new TextDecoder().decode(edition.zip.get("index.html")!);
    const after = before.replace("<h1>Customer Portal</h1>", "<h1>Customer Portal</h1>\n      <p class=\"tagline\">Transparent pricing: see the breakdown under every quote.</p>");
    if (after === before) throw new Error("index.html anchor not found");
    const r = await clientWeb!.upload(`${O}/edition-sessions/${enc(edition.sessionId)}/returns?mode=partial&tool=cursor`, writeZip(new Map([["index.html", new TextEncoder().encode(after)]])), "application/zip");
    const settled = await poll("manual return", () => clientWeb!.req("GET", `${O}/edition-returns/${enc(r.returnId)}`), (v) => !["queued", "running", "freezing"].includes(v.state), 10 * 60_000, 2000);
    if (settled.state !== "proposed") throw new Error(`manual return ${settled.state}: ${JSON.stringify(settled.error)}`);
    return { returnId: r.returnId, changes: settled.changes, blocked: settled.blocked, proposalId: settled.proposalId };
  }, (v) => v);
  beat("manual return proposed", { proposalId: manual.proposalId });
  const manualValidation = ev.step("developer: Run validation on the client's return (base still current)", async () => {
    await poll("prepared", () => owner!.req("GET", `${O}/proposals/${enc(manual.proposalId)}`), (v) => v.state === "prepared", 10 * 60_000, 2000);
    await owner!.req("POST", `${O}/proposals/${enc(manual.proposalId)}/integrate`, {});
    const p = await poll("validated", () => owner!.req("GET", `${O}/proposals/${enc(manual.proposalId)}`), (v) => v.lastAttempt && !["queued", "applying"].includes(v.lastAttempt.state), 15 * 60_000, 2000);
    return { state: p.lastAttempt.state, code: p.lastAttempt.code, checks: p.lastAttempt.checks, contractChecks: p.lastAttempt.contractChecks };
  }, (v) => v);
  // runs while the agents work (a click on "Run validation", then back to the agents' pane)
  void manualValidation.then((v) => beat("client return validated", v), () => undefined);

  // ------------------------------------------------------------------ 2:30–5:00 agents, contract fail, fix
  const orchExit = await ev.step("2:30–5:00 orchestrator: three agents, gate attempt 1 fails, the fix passes", () => orch.done, (c) => ({ exitCode: c }));
  await mkdir(evDir, { recursive: true });
  await writeFile(join(evDir, "orchestrator-log.txt"), orch.log.join(""));
  const report = JSON.parse(await readFile(join(evDir, "demo-run.json"), "utf8"));
  const conc = JSON.parse(await readFile(join(evDir, "concurrency.json"), "utf8"));
  const evs = (await owner.req("GET", `${O}/events?after=${startSeq}&limit=500&projectId=${proj.projectId}`)).events as any[];
  const at = (pred: (e: any) => boolean) => {
    const e = evs.find(pred);
    return e ? clock(Date.parse(e.at)) : null;
  };
  const attempts = report.contractSequence?.attempts ?? [];
  beat("agents and gate (from API events)", {
    firstTaskStarted: at((e) => e.action === "task.started"),
    apiStartSpreadMs: conc.apiStart.spreadMs,
    allConcurrent: conc.overlap.allConcurrent,
    agent2EditionReturned: at((e) => e.action === "edition.returned"),
    attempt1Failed: attempts[0] ? at((e) => e.action === "proposal.integration_failed" && e.subject.id === attempts[0].proposalId) : null,
    attempt2Passed: attempts[1] ? at((e) => e.action === "proposal.integrated" && e.subject.id === attempts[1].proposalId) : null,
    orchestratorDone: clock(),
  });
  if (orchExit !== 0 || !report.contractSequence?.passedAfterFix) throw new Error(`orchestrator exit ${orchExit}; contract sequence ${JSON.stringify(report.contractSequence)}`);
  const a1 = attempts[1].proposalId as string;
  const agent2 = report.agents.find((a: any) => a.agent === "agent-2");

  // ------------------------------------------------------------------ ~5:15 Build preview, and approve/accept at once (REHEARSAL.md §3)
  const pv = await owner.req("POST", `${O}/proposals/${enc(a1)}/previews`, {}); // the "Build preview" click
  const previewP = ev.step("5:00 developer: Build preview on agent 1's validated proposal; client opens it", async () => {
    const ready = await poll("preview", () => owner!.req("GET", `${O}/previews/${enc(pv.previewId)}`), (v) => v.state !== "queued", 20 * 60_000, 3000);
    if (ready.state !== "ready") throw new Error(`preview ${ready.state}`);
    const cv = (await clientWeb!.req("GET", `${O}/proposals/${enc(a1)}/previews`)).previews[0];
    secret(cv.url);
    const q: any = await (await fetch(`${cv.url}api/quote?plan=enterprise&seats=300&customer=CI`)).json().catch(() => null);
    return { previewId: pv.previewId, origin: new URL(cv.url).origin, quoteHasBreakdown: !!q?.breakdown };
  }, (v) => v);
  const previewDone = previewP.then((preview) => beat("preview open as the client", preview));

  // ------------------------------------------------------------------ 6:00 approve, accept, publish (+ agent 3 re-run)
  const accepted = await ev.step("6:00 client: Approve this result; developer: Accept as new version", async () => {
    const p = await owner!.req("GET", `${O}/proposals/${enc(a1)}`);
    await clientWeb!.req("POST", `${O}/proposals/${enc(a1)}/approvals`, { proposalHash: p.proposalHash });
    for (let i = 0; ; i++) {
      try {
        return await owner!.req("POST", `${O}/proposals/${enc(a1)}/accept`, { idempotencyKey: `a1-${runId}` });
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== "integration_applying" || i > 10) throw e;
        await sleep(2000);
      }
    }
  }, (v) => v);
  beat("agent 1 accepted", accepted);
  await manualValidation;
  const stalePeers: Record<string, string> = {};
  for (const [name, pid] of [["agent-2 edition return", agent2?.edition?.proposalId], ["client manual return", manual.proposalId]] as const) {
    if (!pid) continue;
    try {
      await owner.req("POST", `${O}/proposals/${enc(pid)}/integrate`, {});
      stalePeers[name] = "integrate accepted";
    } catch (e: any) {
      stalePeers[name] = `${e.status} ${e.code}`;
    }
  }
  beat("peers on website are now stale (shown, not accepted)", stalePeers);
  const redoDir = join(evDir, "agent-3-redo");
  const redo = orchestrate("3", redoDir, [], DRY);
  beat("agent 3 re-run started on the new heads (terminal)");
  const release = ev.step("6:00–7:15 Release: Prepare release → Approve publishing this release → Publish to production", () => releaseLive("agent-1"), (v) => v).then((relV) => {
    beat("agent 1's version is live", { ...relV, logoIsGenesis: relV.logoSha256 === genesisLogo });
    return relV;
  });

  const a3 = await ev.step("agent 3 re-run: propose → Run validation → client approves → Accept", async () => {
    const code = await redo.done;
    await writeFile(join(redoDir, "orchestrator-log.txt"), redo.log.join(""));
    if (code !== 0) throw new Error(`agent 3 redo exited ${code}`);
    const r = JSON.parse(await readFile(join(redoDir, "demo-run.json"), "utf8"));
    const taskId = r.agents.find((a: any) => a.agent === "agent-3").taskIds[0];
    const pr = await owner!.req("POST", `${O}/proposals`, { taskId });
    await poll("prepared", () => owner!.req("GET", `${O}/proposals/${enc(pr.proposalId)}`), (v) => v.state === "prepared", 10 * 60_000, 2000);
    await owner!.req("POST", `${O}/proposals/${enc(pr.proposalId)}/integrate`, {});
    const p = await poll("validated", () => owner!.req("GET", `${O}/proposals/${enc(pr.proposalId)}`), (v) => v.lastAttempt && !["queued", "applying"].includes(v.lastAttempt.state), 15 * 60_000, 2000);
    if (p.lastAttempt.state !== "succeeded") throw new Error(`agent 3 integrate ${p.lastAttempt.code}`);
    await clientWeb!.req("POST", `${O}/proposals/${enc(pr.proposalId)}/approvals`, { proposalHash: p.proposalHash });
    const acc = await owner!.req("POST", `${O}/proposals/${enc(pr.proposalId)}/accept`, { idempotencyKey: `a3-${runId}` });
    return { proposalId: pr.proposalId, contractChecks: p.lastAttempt.contractChecks, acceptedVersionId: acc.acceptedVersionId };
  }, (v) => v);
  beat("agent 3's logo accepted", a3);
  await previewDone;
  await release;

  // ------------------------------------------------------------------ 7:15 restore + export
  const restored = await ev.step("7:15 Versions → each resource → the version before agent 1 → Restore this version", async () => {
    const out: Record<string, unknown> = {};
    for (const m of ["website", "api", "requirements", "brand-assets"]) {
      const rid = proj.res[m].resourceId;
      const cur = await owner!.req("GET", `${O}/resources/${enc(rid)}`);
      const versions = (await owner!.req("GET", `${O}/resources/${enc(rid)}/versions`)).versions as any[];
      // newest first: the first version older than agent 1's acceptance
      const target = versions.find((v) => v.sequence < Number(String(accepted.acceptedVersionId).replace(/\D/g, "")));
      if (!target || target.head.revisionId === cur.head.revisionId) {
        out[m] = "unchanged";
        continue;
      }
      const r = await owner!.req("POST", `${O}/resources/${enc(rid)}/restore`, { expectedHead: cur.head.revisionId, targetRevision: target.head.revisionId, idempotencyKey: `restore-${m}-${runId}` });
      out[m] = { to: target.acceptedVersionId ?? "genesis", acceptedVersionId: r.acceptedVersionId };
    }
    return out;
  }, (v) => v);
  beat("restored to before agent 1", restored);
  const exported = await ev.step("Export → Start export (cforge export) + git bundle verify inside a repo", async () => {
    const out = join(runDir, "export");
    const e = JSON.parse((await run(process.execPath, [join(REPO, "apps/cli/dist/index.js"), "export", proj.projectId, "--out", out, "--json", "--org", proj.orgId], { env: ownerS.env })).stdout);
    const genv = { PATH: process.env.PATH ?? "", HOME: runDir, GIT_CONFIG_NOSYSTEM: "1" };
    await run("git", ["init", "-q", join(runDir, "v")], { env: genv });
    let verified = 0;
    for (const f of e.files.filter((x: any) => x.kind === "git-bundle")) {
      await run("git", ["bundle", "verify", join(out, f.path)], { cwd: join(runDir, "v"), env: genv });
      verified++;
    }
    return { exportId: e.exportId, bundlesVerified: verified };
  }, (v) => v);
  beat("export downloaded and verified", exported);
  const takeEnd = clock();

  // ------------------------------------------------------------------ after the core take: publish the restore
  const restoredLive = await ev.step("publish after restore: the restored version through the same gate", () => releaseLive("restore"), (v) => v);
  beat("restored version is live", { ...restoredLive, logoIsGenesis: restoredLive.logoSha256 === genesisLogo });
  if (restoredLive.quoteHasBreakdown || restoredLive.logoSha256 !== genesisLogo) throw new Error("the restored release does not serve the previous version");
  ev.facts.takeEndedAt = takeEnd;
  ev.facts.beats = beats;
} catch (e) {
  process.stderr.write(`take failed: ${redact(e instanceof Error ? e.stack ?? e.message : String(e))}\n`);
  ev.facts.beats = beats;
  process.exitCode = 1;
} finally {
  if (!KEEP && orgId) await cleanupRun({ ev, op, orgId, kvId, sessions: [clientWeb, clientCli, owner] });
  tail.stop();
  ev.facts.orgId = orgId;
  await ev.write(join(evDir, "take.json"));
  process.stderr.write(`evidence: ${evDir}\n`);
  if (!KEEP) await rmrf(runDir);
  process.exit(process.exitCode ?? 0);
}
