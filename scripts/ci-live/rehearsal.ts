/**
 * Demo rehearsal on the CI deployment: a fresh "Customer Portal" project from fixtures/, then the
 * apps/demo-agents orchestrator with real agents (claude by default; uses the operator's own claude
 * login) for agents 1, 2 (client edition, the client's own cforge login) and 3, gate `api`.
 *
 *   pnpm build && node scripts/ci-live/rehearsal.ts [--dry-run] [--keep] [--model sonnet] [--budget-usd 3]
 *
 * Afterwards it checks, from the orchestrator's evidence and the API:
 *   AT-05  apiStart.withinTwoSeconds and overlap.allConcurrent (concurrency.json)
 *   row 7  agent 1's gate: attempt 1 fails (contract), attempt 2 passes
 *   AT-07  the textual conflict between agent 1's website candidate and the client edition
 *          return (operator `git merge-tree` on the two candidates retained in canonical)
 *   row 9  the edition round trip produced a proposal
 *   logo   agent 3's R2 upload and website/public/logo.png in its git candidate
 * Evidence: evidence/ci/rehearsal-<runId>/{concurrency,demo-run,summary}.json
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { API, ArtifactsOperator, Client, Evidence, REPO, Tail, cliSignIn, devVars, poll, redact, rmrf, run, secret , requireCiTarget } from "./lib.ts";
requireCiTarget("rehearsal.ts");
import { cleanupRun, setupDemoProject } from "./project.ts";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1]! : d);
const DRY = flag("--dry-run");
const KEEP = flag("--keep");
const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${randomBytes(2).toString("hex")}`;
const evDir = join(REPO, "evidence", "ci", `rehearsal-${DRY ? "dry-" : ""}${runId}`);
const enc = encodeURIComponent;

const ev = new Evidence(DRY ? "ci-rehearsal-dry-run" : "ci-rehearsal");
const vars = await devVars();
const op = new ArtifactsOperator(vars.CF_ACCOUNT_ID!, vars.CF_API_TOKEN!);
const runDir = await mkdtemp(join(tmpdir(), "cf-ci-rehearsal-"));
const tail = await Tail.start(vars);
let orgId = "";
let kvId = "";
let owner: Client | undefined;
let clientC: Client | undefined;
ev.facts.runId = runId;
ev.facts.dryRun = DRY;

try {
  const ownerEmail = `ci-owner-${runId}@commonforge.invalid`;
  const clientEmail = `ci-client-${runId}@commonforge.invalid`;
  const ownerDir = join(runDir, "owner-cforge");
  const clientDir = join(runDir, "client-cforge");
  const ownerS = await ev.step("owner signs in (cforge login, code from the worker log)", () => cliSignIn(tail, ownerEmail, ownerDir));
  owner = new Client("owner", { bearer: ownerS.bearer });
  const proj = await setupDemoProject({ ev, owner, op, runDir, orgName: `CI rehearsal ${runId}`, clientEmail, onOrg: (id) => (orgId = id), onKv: (id) => (kvId = id) });
  const clientS = await ev.step("client signs in (cforge login, own config dir)", () => cliSignIn(tail, clientEmail, clientDir));
  clientC = new Client("client", { bearer: clientS.bearer });
  ev.facts.project = { orgId: proj.orgId, projectId: proj.projectId };

  await ev.step("recording aid: scripts/demo/intake-plan.ts on the demo 'mess' folder (dry-run plan, nothing confirmed)", async () => {
    const out = join(runDir, "intake-plan.json");
    const r = await run(process.execPath, [join(REPO, "scripts/demo/intake-plan.ts"), "--api-url", API, "--org", proj.orgId, "--config-dir", ownerDir, "--make-mess", join(runDir, "mess")], { env: { PATH: process.env.PATH ?? "", HOME: runDir, INTAKE_PLAN_JSON: out } });
    const v = JSON.parse(await readFile(out, "utf8"));
    const r2 = v.plan.placements.filter((p: any) => p.provider === "r2-assets").map((p: any) => p.resourceName);
    const excluded = v.plan.excluded.map((x: any) => `${x.path}: ${x.reason}`);
    if (!r2.length || !excluded.some((x: string) => /\.env/.test(x))) throw new Error(`unexpected plan: ${r.stdout}`);
    return { placements: v.plan.placements.map((p: any) => `${p.resourceName} (${p.provider}, ${p.files} files)`), excluded };
  }, (v) => v);

  // ---------------------------------------------------------------- the orchestrator
  // the orchestrator gets the owner's cforge session and nothing from .dev.vars
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(CLOUDFLARE_|CF_|COMMONFORGE_)/.test(k)) env[k] = v;
  env.CFORGE_CONFIG_DIR = ownerDir;
  const orchestrate = async (agents: string, dir: string, dry: boolean, extra: string[] = []): Promise<number> => {
    const demoArgs = [
      join(REPO, "apps/demo-agents/dist/main.js"),
      "--api-url", API, "--org", proj.orgId, "--project", proj.projectId, "--agents", agents,
      "--gate", "api", "--model", opt("--model", "sonnet"), "--budget-usd", opt("--budget-usd", "3"),
      "--step-timeout-min", opt("--step-timeout-min", "8"),
      "--run-dir", join(runDir, `agents-${agents.replace(/,/g, "")}`), "--evidence-dir", dir,
      ...extra, ...(dry ? ["--dry-run"] : []),
    ];
    const log: string[] = [];
    const code = await new Promise<number>((resolve) => {
      const p = spawn(process.execPath, demoArgs, { cwd: runDir, env, stdio: ["ignore", "pipe", "pipe"] });
      const onData = (d: Buffer) => {
        const s = redact(d.toString());
        log.push(s);
        process.stderr.write(s);
      };
      p.stdout.on("data", onData);
      p.stderr.on("data", onData);
      p.on("close", (c) => resolve(c ?? -1));
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "orchestrator-log.txt"), log.join(""));
    return code;
  };
  const exit = await ev.step(`demo-agents orchestrator (${DRY ? "DRY-RUN" : "real agents"}, --gate api, client edition)`,
    () => orchestrate("1,2,3", evDir, DRY, ["--client-edition", "edition", "--client-config-dir", clientDir]), (c) => ({ exitCode: c }));

  const report = JSON.parse(await readFile(join(evDir, "demo-run.json"), "utf8"));
  const conc = JSON.parse(await readFile(join(evDir, "concurrency.json"), "utf8"));
  const agent = (id: string) => report.agents.find((a: any) => a.agent === id);
  const O = `/api/orgs/${enc(proj.orgId)}`;

  await ev.step("AT-05: task.started spread (API clock) and overlap", async () => {
    const r = { apiStart: conc.apiStart, allConcurrent: conc.overlap.allConcurrent, commonWindow: conc.overlap.commonWindow };
    if (!conc.apiStart.withinTwoSeconds || !conc.overlap.allConcurrent) throw new Error(`AT-05 not met: ${JSON.stringify(r)}`);
    return r;
  }, (v) => v);
  await ev.step("row 7: contract gate fails, then passes after the fix", async () => {
    const r = report.contractSequence;
    if (!r?.failedFirst || !r?.passedAfterFix) throw new Error(`contract sequence: ${JSON.stringify(r)}`);
    return { failedFirst: r.failedFirst, passedAfterFix: r.passedAfterFix, attempts: r.attempts.map((a: any) => ({ result: a.result, contractChecks: a.contractChecks, checks: a.checks, detail: String(a.detail ?? "").slice(0, 200), proposalId: a.proposalId })) };
  }, (v) => v);
  const ed = await ev.step("row 9: client edition round trip → proposal", async () => {
    const a2 = agent("agent-2");
    if (!a2?.edition?.proposalId) throw new Error(`agent 2: ${a2?.status} ${a2?.error ?? a2?.note ?? ""}`);
    return { status: a2.status, actor: a2.edition.actor, editionId: a2.edition.editionId, proposalId: a2.edition.proposalId, changes: a2.edition.changes, blocked: a2.edition.blocked };
  }, (v) => v);
  await ev.step("recording aid: scripts/demo/edition-clone-check.ts (canonical denied, edition one commit)", async () => {
    const a2 = agent("agent-2");
    const r = await run(process.execPath, [join(REPO, "scripts/demo/edition-clone-check.ts"), "--api-url", API, "--org", proj.orgId, "--session", a2.edition.sessionId, "--mount", "website", "--client-config-dir", clientDir, "--owner-config-dir", ownerDir], { env: { PATH: process.env.PATH ?? "", HOME: runDir } });
    if (!/DENIED/.test(r.stdout) || !/ok, 1 commit/.test(r.stdout)) throw new Error(`unexpected: ${r.stdout}`);
    return r.stdout.trim().split("\n");
  }, (v) => v);
  await ev.step("logo: agent 3 replaced brand-assets/logo.png (R2) and website/public/logo.png (git)", async () => {
    const a3 = agent("agent-3");
    const gitPaths = (a3?.phases ?? []).flatMap((p: any) => p.submit.candidates.filter((c: any) => c.mountName === "website").flatMap((c: any) => c.changedPaths));
    if (!a3?.asset || !gitPaths.includes("public/logo.png")) throw new Error(`agent 3: ${a3?.status} ${a3?.error ?? ""} asset=${JSON.stringify(a3?.asset)} paths=${gitPaths}`);
    return { r2: { path: a3.asset.path, sha256: a3.asset.sha256, manifestId: a3.asset.manifestId }, gitWebsitePaths: gitPaths };
  }, (v) => v);
  await ev.step("AT-07: textual conflict between agent 1's website candidate and the client edition return", async () => {
    const a1 = agent("agent-1");
    const w1 = a1.phases.flatMap((p: any) => p.submit.candidates).find((c: any) => c.mountName === "website");
    const prop = await owner!.req("GET", `${O}/proposals/${enc(ed.proposalId)}`);
    const w2 = prop.candidates.find((c: any) => c.resourceId === proj.res.website.resourceId);
    const coords = proj.res.website.coords;
    const tok = await op.call<{ id: string; plaintext: string }>("POST", `/artifacts/namespaces/${coords.namespace}/tokens`, { repo: coords.repoName, scope: "read", ttl: 300 });
    secret(tok.plaintext);
    try {
      const dir = join(runDir, "conflict");
      await mkdir(dir, { recursive: true });
      const genv = { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
      const g = (...a: string[]) => run("git", ["-c", "credential.helper=", "-c", "user.name=ci", "-c", "user.email=ci@commonforge.invalid", ...a], { cwd: dir, env: genv });
      await g("init", "-q");
      const u = new URL(coords.remoteUrl);
      u.username = "x-token";
      u.password = tok.plaintext;
      await g("fetch", "-q", u.toString(), "+refs/commonforge/candidates/*:refs/c/*");
      const r = await run("git", ["merge-tree", "--write-tree", "--name-only", w1.sha, w2.sha], { cwd: dir, env: genv }).then(
        (x) => ({ conflict: false, out: x.stdout }),
        (e) => ({ conflict: true, out: String(e.message) }),
      );
      const paths = [...new Set(r.out.split("\n").filter((l) => /^[\w./-]+\.(ts|css|json|html)$/.test(l.trim())).map((l) => l.trim()))];
      if (!r.conflict) throw new Error("no textual conflict between the two website candidates");
      return { agent1: w1.sha, edition: w2.sha, conflict: r.conflict, paths };
    } finally {
      await op.call("DELETE", `/artifacts/namespaces/${coords.namespace}/tokens/${tok.id}`).catch(() => undefined);
    }
  }, (v) => v);
  if (exit !== 0) throw new Error(`orchestrator exited ${exit}`);

  // ---------------------------------------------------------------- after the agents: the recording's later beats
  const waitIntegrated = async (proposalId: string) => {
    const pr = await owner!.req("GET", `${O}/proposals/${enc(proposalId)}`);
    if (pr.state !== "prepared" && pr.state !== "integrated") await poll("prepared", () => owner!.req("GET", `${O}/proposals/${enc(proposalId)}`), (v) => v.state === "prepared", 10 * 60_000);
    const job = await owner!.req("POST", `${O}/proposals/${enc(proposalId)}/integrate`, {});
    void job;
    return poll("integration", () => owner!.req("GET", `${O}/proposals/${enc(proposalId)}`), (v) => v.lastAttempt?.state && !["queued", "applying"].includes(v.lastAttempt.state), 15 * 60_000, 2000);
  };
  const approveAccept = async (proposalId: string, key: string) => {
    const p = await owner!.req("GET", `${O}/proposals/${enc(proposalId)}`);
    await clientC!.req("POST", `${O}/proposals/${enc(proposalId)}/approvals`, { proposalHash: p.proposalHash });
    return owner!.req("POST", `${O}/proposals/${enc(proposalId)}/accept`, { idempotencyKey: `${key}-${runId}` });
  };
  const a1pass = report.contractSequence.attempts[1].proposalId as string;
  await ev.step("6:00 beat: client approves agent 1's passing proposal, owner accepts", () => approveAccept(a1pass, "a1"), (v) => v);
  await ev.step("after agent 1 lands, agent 3's and the edition's proposals are stale (base moved / dependency moved)", async () => {
    const out: Record<string, unknown> = {};
    const a3task = agent("agent-3").taskIds[0];
    const p3 = await owner!.req("POST", `${O}/proposals`, { taskId: a3task });
    for (const [name, pid] of [["agent-3", p3.proposalId], ["edition", ed.proposalId]] as const) {
      try {
        await owner!.req("POST", `${O}/proposals/${enc(pid)}/integrate`, {});
        out[name] = "integrate accepted (unexpected)";
      } catch (e: any) {
        out[name] = `${e.status} ${e.code}`;
      }
    }
    return out;
  }, (v) => v);
  const redo = await ev.step("fallback: re-run agent 3 on the new heads (orchestrator --agents 3, scripted), propose, integrate, approve, accept", async () => {
    const dir = join(evDir, "agent-3-redo");
    const code = await orchestrate("3", dir, true);
    if (code !== 0) throw new Error(`agent 3 redo exited ${code}`);
    const r = JSON.parse(await readFile(join(dir, "demo-run.json"), "utf8"));
    const taskId = r.agents.find((a: any) => a.agent === "agent-3").taskIds[0];
    const pr = await owner!.req("POST", `${O}/proposals`, { taskId });
    const p = await waitIntegrated(pr.proposalId);
    if (p.lastAttempt.state !== "succeeded") throw new Error(`agent 3 redo integrate ${p.lastAttempt.state} ${p.lastAttempt.code}`);
    const acc = await approveAccept(pr.proposalId, "a3");
    return { taskId, proposalId: pr.proposalId, checks: p.lastAttempt.checks, contractChecks: p.lastAttempt.contractChecks, acceptedVersionId: acc.acceptedVersionId };
  }, (v) => v);
  void redo;
  await ev.step("7:15 beat: restore website and brand-assets to the version before agent 3 (old logo)", async () => {
    const out: Record<string, unknown> = {};
    for (const m of ["website", "brand-assets"]) {
      const rid = proj.res[m].resourceId;
      const cur = await owner!.req("GET", `${O}/resources/${enc(rid)}`);
      const versions = (await owner!.req("GET", `${O}/resources/${enc(rid)}/versions`)).versions;
      const target = versions[1];
      if (!target) {
        out[m] = `only ${versions.length} accepted version(s): nothing earlier to restore`;
        continue;
      }
      const r = await owner!.req("POST", `${O}/resources/${enc(rid)}/restore`, { expectedHead: cur.head.revisionId, targetRevision: target.head.revisionId, idempotencyKey: `restore-${m}-${runId}` });
      out[m] = { versions: versions.length, to: target.acceptedVersionId, acceptedVersionId: r.acceptedVersionId };
    }
    return out;
  }, (v) => v);
} catch (e) {
  process.stderr.write(`rehearsal failed: ${redact(e instanceof Error ? e.stack ?? e.message : String(e))}\n`);
  process.exitCode = 1;
} finally {
  if (!KEEP && orgId) await cleanupRun({ ev, op, orgId, kvId, sessions: [clientC, owner] });
  tail.stop();
  ev.facts.orgId = orgId;
  ev.facts.kept = KEEP;
  await ev.write(join(evDir, "summary.json"));
  process.stderr.write(`evidence: ${evDir}\n`);
  if (!KEEP) await rmrf(runDir);
  process.exit(process.exitCode ?? 0);
}
