/**
 * Live end-to-end run with the real Sandbox runner and real Artifacts.
 *
 *   pnpm build && node scripts/ci-live/e2e.ts [--keep] [--evidence <file>]
 *     the CI deployment (scripts/deploy-ci.sh); sign-in through log-mode links
 *   pnpm build && node scripts/ci-live/e2e.ts --target production --owner-config <dir> --client-config <dir> \
 *       --org-name "Freeze run N" [--keep] [--evidence <file>]
 *     the production Worker (Task 23 freeze). Production sends real email, so there is no sign-in:
 *     owner and client are existing `cforge login` sessions (CFORGE_CONFIG_DIR dirs; the bearers are
 *     read in-process and never printed or logged out). /health must say production + send, no
 *     chaos. Release targets are cfapp-<orgId>-*. Cleanup (on success; --keep skips it) deletes the
 *     release Workers, the KV and the task + edition repos, and keeps the canonical repos and the
 *     org's ledger data. A failed run keeps everything for inspection.
 *
 * Flow (each step timed in the evidence JSON, evidence/ci/e2e-<runId>.json by default):
 *   sign-in through log-mode links (owner: cforge CLI code; client: web link + cookie) →
 *   org, client member, project, resources from fixtures/ (operator genesis push with x-token
 *   basic auth, then adopt-head), mounts, grants, KV, policy →
 *   task → cforge checkout (lease only) → checkpoint ref → submit api+website (+ R2 logo) →
 *   integrate FAILS (contract) → fix requirements → integrate PASSES → private preview →
 *   client approves, owner accepts → reconcile synced →
 *   client edition: build, session, ZIP download, edit, return → integrate → client approves,
 *   owner accepts → release to cfci-<orgId>-* (publish approval, deploy, /version live) →
 *   restore (api + brand-assets) → publish the restored version (live, no breakdown) →
 *   export (git bundle verify) → events → per-run cleanup.
 */
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { agentIdentity, cforgeJson, dryRunAgent, replaceAsset, subprocessCforge } from "../../apps/demo-agents/dist/index.js";
import { readZip, writeZip } from "../../apps/demo-agents/dist/edition-zip.js";
import { websiteEditionPolicy } from "../../apps/demo-agents/dist/edition.js";
import { API, ApiError, ArtifactsOperator, Client, Evidence, PROTECTED_ORGS, REPO, RELEASE_PREFIX, TARGET, Tail, assertProductionHealth, cliSignIn, configSession, devVars, poll, redact, rmrf, run, secret, webSignIn } from "./lib.ts";
import { cleanupRun, setupDemoProject } from "./project.ts";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${randomBytes(2).toString("hex")}`;
const arg = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const PROD = TARGET === "production";
const evidencePath = arg("--evidence") ?? join(REPO, "evidence", PROD ? "freeze" : "ci", `e2e-${runId}.json`);
const enc = encodeURIComponent;
const ownerConfig = arg("--owner-config");
const clientConfig = arg("--client-config");
const orgName = arg("--org-name") ?? `${PROD ? "Freeze" : "CI e2e"} ${runId}`;
if (PROD && (!ownerConfig || !clientConfig || !arg("--org-name"))) throw new Error("--target production needs --owner-config <dir> --client-config <dir> --org-name <name>");

const ev = new Evidence(PROD ? "production-freeze-e2e" : "ci-e2e");
const vars = await devVars();
const op = new ArtifactsOperator(vars.CF_ACCOUNT_ID!, vars.CF_API_TOKEN!);
const runDir = await mkdtemp(join(tmpdir(), "cf-ci-e2e-"));
// production sends real email: never read (or trigger) sign-in links there
const tail = PROD ? null : await Tail.start(vars);
const cforge = subprocessCforge();
ev.facts.runId = runId;
ev.facts.target = TARGET;
ev.facts.orgName = orgName;

let orgId = "";
let kvId = "";
let owner!: Client;
let client!: Client;

try {
  await ev.step("health", async () => (PROD ? assertProductionHealth() : (await fetch(`${API}/health`)).json()), (h) => h);

  // ---------------------------------------------------------------- sign-in
  let ownerS: { bearer: string; env: Record<string, string> };
  let clientS: { bearer: string; email: string } | null = null;
  let clientEmail: string;
  if (PROD) {
    // existing cforge sessions; nothing is sent to anyone's inbox
    const o = await ev.step("owner: existing cforge session (--owner-config)", async () => {
      const s = await configSession(ownerConfig!);
      const me = await new Client("owner", { bearer: s.bearer }).req("GET", "/api/me");
      return { ...s, me };
    }, (s) => ({ email: s.me.user?.email ?? s.email }));
    ownerS = o;
    const c = await ev.step("client: existing cforge session (--client-config)", async () => {
      const s = await configSession(clientConfig!);
      const me = await new Client("client", { bearer: s.bearer }).req("GET", "/api/me");
      return { ...s, email: me.user?.email ?? s.email };
    }, (s) => ({ email: s.email }));
    if (c.email === (o.me.user?.email ?? o.email)) throw new Error("owner and client sessions are the same user");
    clientS = c;
    clientEmail = c.email;
  } else {
    const ownerEmail = `ci-owner-${runId}@commonforge.invalid`;
    clientEmail = `ci-client-${runId}@commonforge.invalid`;
    ownerS = await ev.step("owner signs in (cforge login, code from the worker log)", () => cliSignIn(tail!, ownerEmail, join(runDir, "owner-cforge")), () => ({ email: ownerEmail }));
  }
  owner = new Client("owner", { bearer: ownerS.bearer });

  const proj = await setupDemoProject({ ev, owner, op, runDir, orgName, clientEmail, onOrg: (id) => {
    if (PROTECTED_ORGS.includes(id)) throw new Error(`created org ${id} is protected`);
    orgId = id;
  }, onKv: (id) => (kvId = id) });
  const O = `/api/orgs/${enc(orgId)}`;
  const pid = proj.projectId;
  const P = `${O}/projects/${enc(pid)}`;
  const res = proj.res;
  const clientMember = { userId: proj.clientUserId };
  const { apiWorker, siteWorker, workersDevSubdomain: sub } = proj;
  if (clientS) client = new Client("client", { bearer: clientS.bearer });
  else client = new Client("client", { cookie: await ev.step("client signs in (web link from the worker log, click → cookie)", () => webSignIn(tail!, clientEmail)) });
  await ev.step("client /api/me", () => client.req("GET", "/api/me"), (m) => m.memberships);

  // ---------------------------------------------------------------- task → checkout → submit
  const task = await ev.step("create task (writes api, website, requirements, brand-assets)", async () => {
    const t = await owner.req("POST", `${P}/tasks`, { title: "Quote breakdown + violet logo", request: "Add breakdown to /quote, render it, replace the logo", writeMounts: ["api", "website", "requirements", "brand-assets"], readMounts: [] });
    return poll("task provisioning", () => owner.req("GET", `/api/tasks/${enc(t.taskId)}`), (v) => v.state !== "provisioning", 10 * 60_000);
  }, (t) => ({ taskId: t.taskId, state: t.state, workspaces: t.workspaces.map((w: any) => `${w.mountName}:${w.access}:${w.state}`) }));
  if (task.state !== "ready") throw new Error(`task ${task.state}`);
  const taskId: string = task.taskId;
  const lease = await ev.step("owner takes the lease (task.started) and hands it to the agent", () => owner.req("POST", `/api/tasks/${enc(taskId)}/lease`, { ttlSeconds: 3600 }), (l) => ({ leaseGeneration: l.leaseGeneration }));
  secret(lease.leaseToken);
  const agentDir = join(runDir, "agent");
  const ws = join(agentDir, "ws");
  await mkdir(agentDir, { recursive: true });
  const ident = await agentIdentity(join(agentDir, "home"), "CI Agent", API, lease.leaseToken);
  const co = await ev.step("cforge checkout (lease only; credential helper username x-token)", async () => {
    const c = await cforgeJson<any>(cforge, ["checkout", taskId, ws], { cwd: agentDir, env: ident.env });
    if (!c.verified) throw new Error("checkout not verified");
    const helper = (await run("git", ["config", "--get-regexp", "^credential\\."], { cwd: join(ws, "api"), env: ident.env }).catch(() => ({ stdout: "" }))).stdout.trim();
    return { ...c, helper };
  }, (c) => ({ verified: c.verified, mounts: c.mounts.map((m: any) => `${m.mountName}:${m.kind}${m.writable ? ":w" : ""}`), helperConfigured: /credential-helper/.test(c.helper) }));
  void co;

  await ev.step("agent edits (scripted agent-1 feature) + violet logo in website/public", async () => {
    await dryRunAgent()({ agentId: "agent-1", phase: "feature" } as any, ws);
    await run(process.execPath, [join(REPO, "fixtures/brand-assets/scripts/make-logo.mjs"), join(ws, "website/public/logo.png"), "--color=#7c3aed"], { env: { PATH: process.env.PATH ?? "" } });
  });
  const cp = await ev.step("cforge checkpoint api → refs/commonforge/checkpoints/<n>, visible on the task repo", async () => {
    const c = await cforgeJson<any>(cforge, ["checkpoint", "--mount", "api", "--commit", "wip: quote breakdown"], { cwd: ws, env: ident.env });
    const ls = (await run("git", ["ls-remote", "origin", "refs/commonforge/checkpoints/*"], { cwd: join(ws, "api"), env: ident.env })).stdout;
    const cpRef = c.checkpoints[0];
    if (!ls.includes(`${cpRef.sha}\t${cpRef.ref}`)) throw new Error(`checkpoint ref not on the remote: ${ls}`);
    return cpRef;
  }, (c) => c);
  void cp;
  const logoBytes = new Uint8Array(await readFile(join(ws, "website/public/logo.png")));
  ev.facts.violetLogoSha256 = createHash("sha256").update(logoBytes).digest("hex");
  const assetWs = task.workspaces.find((w: any) => w.mountName === "brand-assets");
  await ev.step("upload logo.png to the R2 asset workspace with the lease (stage → upload → commit → freeze)", () =>
    replaceAsset({ apiUrl: API, lease: lease.leaseToken, taskId, taskWorkspaceId: assetWs.taskWorkspaceId, mountName: "brand-assets", path: "logo.png", bytes: logoBytes, mime: "image/png" }), (a) => a);
  const sub1 = await ev.step("cforge submit api + website (push, freeze)", () =>
    cforgeJson<any>(cforge, ["submit", "--mount", "api", "--mount", "website", "--commit", "feat: quote breakdown", "--tool", "ci-e2e"], { cwd: ws, env: ident.env }),
    (s) => s.candidates.map((c: any) => ({ mount: c.mountName, sha: c.sha, changedPaths: c.changedPaths })));
  void sub1;

  const integrate = async (proposalId: string) => {
    await poll("proposal prepared", () => owner.req("GET", `${O}/proposals/${enc(proposalId)}`), (p) => p.state === "prepared" || p.state === "integrated", 10 * 60_000);
    const job = await owner.req("POST", `${O}/proposals/${enc(proposalId)}/integrate`, {});
    // review I1: "applying" (runner done, ledger not yet) counts as still running; once the state is
    // succeeded the ledger has the receipt, so accept right away must work (no receipt_missing)
    const seen = new Set<string>();
    const p = await poll("integration", async () => {
      const v = await owner.req("GET", `${O}/proposals/${enc(proposalId)}`);
      if (v.lastAttempt?.state) seen.add(v.lastAttempt.state);
      return v;
    }, (v) => v.lastAttempt && !["queued", "applying"].includes(v.lastAttempt.state), 15 * 60_000, 1000);
    p.statesSeen = [...seen];
    return { jobId: job.jobId, proposal: p };
  };
  const att = (p: any) => ({ statesSeen: p.statesSeen, proposalId: p.proposalId, proposalHash: p.proposalHash, state: p.lastAttempt.state, code: p.lastAttempt.code, checks: p.lastAttempt.checks, contractChecks: p.lastAttempt.contractChecks, mergeOutcome: p.lastAttempt.mergeOutcome, detail: redact(String(p.lastAttempt.detail ?? "")).slice(0, 300) });

  const p1 = await ev.step("proposal 1 → integrate: expect FAIL (contract: breakdown undeclared)", async () => {
    const pr = await owner.req("POST", `${O}/proposals`, { taskId });
    const { proposal } = await integrate(pr.proposalId);
    if (proposal.lastAttempt.state !== "failed") throw new Error(`attempt 1 ${proposal.lastAttempt.state}, expected failed`);
    return proposal;
  }, att);
  ev.facts.attempt1 = att(p1);

  await ev.step("fix: requirements declares breakdown (scripted agent-1 fix) → submit", async () => {
    await dryRunAgent()({ agentId: "agent-1", phase: "fix-contract" } as any, ws);
    return cforgeJson<any>(cforge, ["submit", "--mount", "requirements", "--commit", "contract: declare breakdown", "--tool", "ci-e2e"], { cwd: ws, env: ident.env });
  }, (s) => s.candidates.map((c: any) => ({ mount: c.mountName, sha: c.sha })));
  const p2 = await ev.step("proposal 2 → integrate: expect PASS", async () => {
    const pr = await owner.req("POST", `${O}/proposals`, { taskId });
    const { proposal } = await integrate(pr.proposalId);
    if (proposal.lastAttempt.state !== "succeeded") throw new Error(`attempt 2 ${proposal.lastAttempt.state}: ${proposal.lastAttempt.code}`);
    return proposal;
  }, att);
  ev.facts.attempt2 = att(p2);
  await ev.step("release the lease", () => owner.req("DELETE", `/api/tasks/${enc(taskId)}/lease`), () => "released");

  // ---------------------------------------------------------------- preview
  await ev.step("private preview of proposal 2 (separate origin, fixture bindings)", async () => {
    const pv = await owner.req("POST", `${O}/proposals/${enc(p2.proposalId)}/previews`, {});
    const ready = await poll("preview", () => owner.req("GET", `${O}/previews/${enc(pv.previewId)}`), (v) => v.state !== "queued", 20 * 60_000, 5000);
    if (ready.state !== "ready") throw new Error(`preview ${ready.state}: ${JSON.stringify(ready.error)}`);
    secret(ready.url);
    const site = await fetch(ready.url);
    const html = await site.text();
    const q = await fetch(`${ready.url}api/quote?plan=enterprise&seats=300&customer=CI`);
    const quote: any = await q.json().catch(() => null);
    const before: any = await (await fetch(`${ready.url}api/__fixtures`)).json().catch(() => null);
    const clientView = await client.req("GET", `${O}/proposals/${enc(p2.proposalId)}/previews`);
    const bad = await fetch(ready.url.replace(/\/p\/([^/]+)\/([^/]+)\/[^/]+\//, "/p/$1/$2/garbage/"));
    return {
      previewId: ready.previewId, origin: new URL(ready.url).origin, appOrigin: new URL(API).origin, siteStatus: site.status,
      siteHasPortal: /Customer Portal|quote/i.test(html), quoteStatus: q.status, quoteHasBreakdown: !!quote?.breakdown,
      fixtures: before, clientSeesPreview: clientView.previews.length > 0, badTokenStatus: bad.status,
    };
  }, (v) => v);

  // ---------------------------------------------------------------- approve / accept / reconcile
  const av1 = await ev.step("client approves proposal 2; owner accepts", async () => {
    const appr = await client.req("POST", `${O}/proposals/${enc(p2.proposalId)}/approvals`, { proposalHash: p2.proposalHash });
    let refusedClientAccept = 0;
    try {
      await client.req("POST", `${O}/proposals/${enc(p2.proposalId)}/accept`, { idempotencyKey: `client-${runId}` });
    } catch (e) {
      refusedClientAccept = e instanceof ApiError ? e.status : -1;
    }
    const acc = await owner.req("POST", `${O}/proposals/${enc(p2.proposalId)}/accept`, { idempotencyKey: `accept-${runId}-1` });
    return { approval: appr.approvalId ?? appr, clientAcceptStatus: refusedClientAccept, ...acc };
  }, (v) => v);
  const reconciled = async (mounts: string[]) => {
    const out: Record<string, unknown> = {};
    for (const m of mounts) {
      const r = await poll(`reconcile ${m}`, () => owner.req("GET", `${O}/resources/${enc(res[m].resourceId)}`), (v) => v.head?.reconciliation === "synced", 10 * 60_000, 3000);
      const sha = String(r.head.revisionId).split(":").pop();
      const branch = r.coords?.kind === "artifacts" ? await op.branchSha(r.coords.namespace, r.coords.repoName) : null;
      out[m] = { revisionId: r.head.revisionId, reconciliation: r.head.reconciliation, canonicalMain: branch, matches: branch ? branch === sha : null };
    }
    return out;
  };
  await ev.step("reconcile: canonical main synced to the accepted heads", () => reconciled(["api", "website", "requirements"]), (v) => v);
  void av1;

  // ---------------------------------------------------------------- client edition
  const edition = await ev.step("client edition: create, build, grant client", async () => {
    const ed = await owner.req("POST", `${P}/editions`, websiteEditionPolicy("website"));
    const b = await owner.req("POST", `${O}/editions/${enc(ed.editionId)}/builds`, {});
    const built = await poll("edition build", () => owner.req("GET", `${O}/editions/${enc(ed.editionId)}`), (v) => (v.builds ?? []).some((x: any) => x.buildId === b.buildId && x.state !== "queued" && x.state !== "running"), 10 * 60_000, 3000);
    const bb = built.builds.find((x: any) => x.buildId === b.buildId);
    if (bb.state !== "ready") throw new Error(`edition build ${bb.state}: ${bb.error}`);
    await owner.req("PUT", `${O}/editions/${enc(ed.editionId)}/grants`, { userId: clientMember.userId });
    return { editionId: ed.editionId, buildId: b.buildId, files: bb.files, sourceReleaseId: bb.sourceReleaseId ?? null };
  }, (v) => v);
  const ret = await ev.step("client: start update, download ZIP, edit, return partial ZIP → proposal", async () => {
    const s = await client.req("POST", `${O}/editions/${enc(edition.editionId)}/sessions`, { title: "What the price covers", request: "Add a note under the quote" });
    const zip = readZip(await client.bytes(s.downloadUrl));
    const cred = await client.req("POST", `${O}/edition-sessions/${enc(s.sessionId)}/credential`, {});
    secret(cred.secret);
    // the client's read token: the edition repo answers, the canonical website repo does not
    const lsRemote = async (url: string) => {
      const u = new URL(url);
      u.username = "x-token";
      u.password = cred.secret;
      try {
        await run("git", ["-c", "credential.helper=", "ls-remote", u.toString()], { env: { PATH: process.env.PATH ?? "", HOME: runDir, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" }, timeoutMs: 60_000 });
        return "allowed";
      } catch {
        return "denied";
      }
    };
    const editionClone = await lsRemote(cred.remoteUrl);
    const canonicalClone = await lsRemote(res.website.coords.remoteUrl);
    const root = join(runDir, "edition");
    for (const [path, data] of zip) {
      await mkdir(join(root, "website", path, ".."), { recursive: true });
      await writeFile(join(root, "website", path), data);
    }
    await dryRunAgent()({ agentId: "agent-2", phase: "client-edit" } as any, root);
    const changed = new Map<string, Uint8Array>();
    for (const [path, before] of zip) {
      const now = new Uint8Array(await readFile(join(root, "website", path)));
      if (Buffer.compare(Buffer.from(before), Buffer.from(now)) !== 0) changed.set(path, now);
    }
    const r = await client.upload(`${O}/edition-sessions/${enc(s.sessionId)}/returns?mode=partial&tool=ci-e2e`, writeZip(changed), "application/zip");
    const settled = await poll("edition return", () => client.req("GET", `${O}/edition-returns/${enc(r.returnId)}`), (v) => !["queued", "running", "freezing"].includes(v.state), 10 * 60_000, 3000);
    if (settled.state !== "proposed") throw new Error(`return ${settled.state}: ${JSON.stringify(settled.error)}`);
    return { sessionId: s.sessionId, zipFiles: zip.size, changed: [...changed.keys()], returnId: r.returnId, state: settled.state, proposalId: settled.proposalId, blocked: settled.blocked, editionClone, canonicalClone };
  }, (v) => v);
  const pe = await ev.step("edition proposal → integrate (pass) → client approves → owner accepts", async () => {
    const { proposal } = await integrate(ret.proposalId);
    if (proposal.lastAttempt.state !== "succeeded") throw new Error(`edition integrate ${proposal.lastAttempt.state}: ${proposal.lastAttempt.code}`);
    const clientView = await client.req("GET", `${O}/proposals/${enc(ret.proposalId)}`);
    await client.req("POST", `${O}/proposals/${enc(ret.proposalId)}/approvals`, { proposalHash: clientView.proposalHash });
    const acc = await owner.req("POST", `${O}/proposals/${enc(ret.proposalId)}/accept`, { idempotencyKey: `accept-${runId}-ed` });
    return { ...att(proposal), sameHashForClient: clientView.proposalHash === proposal.proposalHash, acceptedVersionId: acc.acceptedVersionId };
  }, (v) => v);
  void pe;
  await ev.step("reconcile website synced", () => reconciled(["website"]), (v) => v);

  // ---------------------------------------------------------------- assets-only proposal (logo)
  await ev.step("logo-only change: task writes brand-assets only → integrate (no git targets, contract still checked via pinned references) → client approves → owner accepts", async () => {
    const t = await owner.req("POST", `${P}/tasks`, { title: "Amber logo", request: "Replace the logo in brand-assets only", writeMounts: ["brand-assets"], readMounts: [] });
    const ready = await poll("task provisioning", () => owner.req("GET", `/api/tasks/${enc(t.taskId)}`), (v) => v.state !== "provisioning", 10 * 60_000);
    const l = await owner.req("POST", `/api/tasks/${enc(t.taskId)}/lease`, { ttlSeconds: 900 });
    secret(l.leaseToken);
    const amber = join(runDir, "amber-logo.png");
    await run(process.execPath, [join(REPO, "fixtures/brand-assets/scripts/make-logo.mjs"), amber, "--color=#d97706"], { env: { PATH: process.env.PATH ?? "" } });
    const bytes = new Uint8Array(await readFile(amber));
    const w = ready.workspaces.find((x: any) => x.mountName === "brand-assets");
    const frozen = await replaceAsset({ apiUrl: API, lease: l.leaseToken, taskId: t.taskId, taskWorkspaceId: w.taskWorkspaceId, mountName: "brand-assets", path: "logo.png", bytes, mime: "image/png" });
    await owner.req("DELETE", `/api/tasks/${enc(t.taskId)}/lease`).catch(() => undefined);
    const pr = await owner.req("POST", `${O}/proposals`, { taskId: t.taskId });
    let previewRefusal = "";
    const { proposal } = await integrate(pr.proposalId);
    if (proposal.lastAttempt.state !== "succeeded") throw new Error(`assets-only integrate ${proposal.lastAttempt.state}: ${proposal.lastAttempt.code} ${proposal.lastAttempt.detail ?? ""}`);
    // review C1: the contract and the website check ran although the task mounts only brand-assets
    if (!proposal.lastAttempt.contractChecks.some((c: any) => c.contractId === "quote" && c.result === "pass")) throw new Error(`assets-only proposal was not contract-checked: ${JSON.stringify(proposal.lastAttempt.contractChecks)}`);
    try {
      await owner.req("POST", `${O}/proposals/${enc(pr.proposalId)}/previews`, {});
    } catch (e) {
      previewRefusal = e instanceof ApiError ? e.code : String(e);
    }
    await client.req("POST", `${O}/proposals/${enc(pr.proposalId)}/approvals`, { proposalHash: proposal.proposalHash });
    const acc = await owner.req("POST", `${O}/proposals/${enc(pr.proposalId)}/accept`, { idempotencyKey: `accept-${runId}-logo` });
    const head = await owner.req("GET", `${O}/resources/${enc(res["brand-assets"].resourceId)}`);
    return { ...att(proposal), manifestId: frozen.manifestId, acceptedVersionId: acc.acceptedVersionId, headRevision: head.head.revisionId, headIsNewManifest: head.head.revisionId === `r2m:${frozen.manifestId}`, previewRefusal };
  }, (v) => v);

  // ---------------------------------------------------------------- release
  const rel = await ev.step(`release: prepare/build → publish approval → deploy to ${RELEASE_PREFIX}-${orgId}-*`, async () => {
    const r = await owner.req("POST", `${P}/releases`, {});
    const built = await poll("release build", () => owner.req("GET", `${O}/releases/${enc(r.releaseId)}`), (v) => v.buildState !== "building", 25 * 60_000, 5000);
    if (built.buildState !== "built") throw new Error(`release build ${built.buildState}: ${JSON.stringify(built.error)}`);
    let clientPublish = 0;
    try {
      await client.req("POST", `${O}/releases/${enc(r.releaseId)}/publish-approvals`, { outputDigest: built.outputDigest });
    } catch (e) {
      clientPublish = e instanceof ApiError ? e.status : -1;
    }
    await owner.req("POST", `${O}/releases/${enc(r.releaseId)}/publish-approvals`, { outputDigest: built.outputDigest });
    await owner.req("POST", `${O}/releases/${enc(r.releaseId)}/deploy`, { idempotencyKey: `deploy-${runId}` });
    const done = await poll("release live", () => owner.req("GET", `${O}/releases/${enc(r.releaseId)}`), (v) => ["live", "failed", "recovery_required", "partial"].includes(v.state), 20 * 60_000, 5000);
    if (done.state !== "live") throw new Error(`release ${done.state}: ${JSON.stringify(done.error)}`);
    const version: any = await (await fetch(`https://${apiWorker}.${sub}.workers.dev/version`, { headers: { "cache-control": "no-cache" } })).json();
    const liveLogo = new Uint8Array(await (await fetch(`https://${siteWorker}.${sub}.workers.dev/logo.png`)).arrayBuffer());
    const quote: any = await (await fetch(`https://${apiWorker}.${sub}.workers.dev/quote?plan=enterprise&seats=300&customer=CI`)).json();
    return {
      releaseId: r.releaseId, acceptedVersionId: done.acceptedVersionId, outputDigest: done.outputDigest, state: done.state, status: done.status,
      deployments: done.deployments, version, liveLogoIsViolet: createHash("sha256").update(liveLogo).digest("hex") === ev.facts.violetLogoSha256,
      liveQuoteHasBreakdown: !!quote?.breakdown, clientPublishApprovalStatus: clientPublish,
    };
  }, (v) => v);
  void rel;

  // ---------------------------------------------------------------- restore + export
  const restoredOut = await ev.step("restore api and brand-assets to their genesis versions (new forward versions)", async () => {
    const out: Record<string, unknown> = {};
    for (const m of ["api", "brand-assets"]) {
      const rid = res[m].resourceId;
      const cur = await owner.req("GET", `${O}/resources/${enc(rid)}`);
      const versions = (await owner.req("GET", `${O}/resources/${enc(rid)}/versions`)).versions;
      const target = versions[versions.length - 1];
      const r = await owner.req("POST", `${O}/resources/${enc(rid)}/restore`, { expectedHead: cur.head.revisionId, targetRevision: target.head.revisionId ?? target.head, idempotencyKey: `restore-${runId}-${m}` });
      out[m] = { from: cur.head.revisionId, to: r.headRevisionId, acceptedVersionId: r.acceptedVersionId, versionsBefore: versions.length };
    }
    out.reconcile = await reconciled(["api"]);
    return out;
  }, (v) => v);
  // the code restore's version: a release's version is the newest accepted version touching its git
  // sources (releases.ts prepareRelease), so an R2-only restore (brand-assets) is not releasable
  // (the UI offers no publish for asset restores either); 409 accepted_version_stale otherwise
  const restoredVersionId = (restoredOut.api as any).acceptedVersionId as string;
  await ev.step("publish the restored version: prepare (acceptedVersionId) → publish approval → deploy → live, quote without breakdown", async () => {
    const r = await owner.req("POST", `${P}/releases`, { acceptedVersionId: restoredVersionId });
    const built = await poll("restored release build", () => owner.req("GET", `${O}/releases/${enc(r.releaseId)}`), (v) => v.buildState !== "building", 25 * 60_000, 5000);
    if (built.buildState !== "built") throw new Error(`restored release build ${built.buildState}: ${JSON.stringify(built.error)}`);
    await owner.req("POST", `${O}/releases/${enc(r.releaseId)}/publish-approvals`, { outputDigest: built.outputDigest });
    await owner.req("POST", `${O}/releases/${enc(r.releaseId)}/deploy`, { idempotencyKey: `deploy-restored-${runId}` });
    const done = await poll("restored release live", () => owner.req("GET", `${O}/releases/${enc(r.releaseId)}`), (v) => ["live", "failed", "recovery_required", "partial"].includes(v.state), 20 * 60_000, 5000);
    if (done.state !== "live") throw new Error(`restored release ${done.state}: ${JSON.stringify(done.error)}`);
    const version: any = await (await fetch(`https://${apiWorker}.${sub}.workers.dev/version`, { headers: { "cache-control": "no-cache" } })).json();
    const quote: any = await (await fetch(`https://${apiWorker}.${sub}.workers.dev/quote?plan=enterprise&seats=300&customer=CI&t=${Date.now()}`, { headers: { "cache-control": "no-cache" } })).json();
    if (quote?.breakdown) throw new Error("the restored release still serves a quote with breakdown");
    return { releaseId: r.releaseId, acceptedVersionId: done.acceptedVersionId, pinnedToRestore: done.acceptedVersionId === restoredVersionId, state: done.state, version, liveQuoteHasBreakdown: !!quote?.breakdown };
  }, (v) => v);
  await ev.step("export (cforge export) → git bundle verify", async () => {
    const out = join(runDir, "export");
    const e = await run(process.execPath, [CFORGE_PATH(), "export", pid, "--out", out, "--json", "--org", orgId], { env: ownerS.env });
    const j = JSON.parse(e.stdout);
    const bundles = (j.files as Array<{ path: string; kind: string; headSha?: string }>).filter((f) => f.kind === "git-bundle");
    const verified: Record<string, string> = {};
    // `git bundle verify` needs a repository (any, even empty); `git clone <bundle>` needs none
    const vdir = join(runDir, "verify");
    const genv = { PATH: process.env.PATH ?? "", HOME: runDir, GIT_CONFIG_NOSYSTEM: "1" };
    await run("git", ["init", "-q", vdir], { env: genv });
    for (const b of bundles) {
      await run("git", ["bundle", "verify", join(out, b.path)], { cwd: vdir, env: genv });
      const clone = join(runDir, "restored", b.path.replace(/[^\w.-]+/g, "_"));
      await run("git", ["clone", "-q", join(out, b.path), clone], { env: genv });
      const head = (await run("git", ["rev-parse", "HEAD"], { cwd: clone, env: genv })).stdout.trim();
      verified[b.path] = `verify ok; clone HEAD ${head.slice(0, 12)}${head === b.headSha ? " = receipt head" : ` ≠ receipt ${b.headSha}`}`;
    }
    const kinds: Record<string, number> = {};
    for (const f of j.files as Array<{ kind: string }>) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    return { exportId: j.exportId, files: kinds, bundles: verified, manifest: (await readdir(out)).includes("manifest.json") };
  }, (v) => v);

  // ---------------------------------------------------------------- events
  await ev.step("events (owner view)", async () => {
    const events: any[] = [];
    let after = 0;
    for (;;) {
      const page = await owner.req("GET", `${O}/events?after=${after}&limit=500`);
      events.push(...page.events);
      if (!page.events.length || page.next <= after) break;
      after = page.next;
    }
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.action] = (counts[e.action] ?? 0) + 1;
    ev.facts.events = events.map((e) => ({ seq: e.seq, at: e.at, action: e.action, subject: e.subject }));
    return counts;
  }, (v) => v);
} catch (e) {
  process.stderr.write(`run failed: ${redact(e instanceof Error ? e.stack ?? e.message : String(e))}\n`);
  process.exitCode = 1;
} finally {
  // ---------------------------------------------------------------- per-run cleanup
  // production: a failed run keeps its leftovers for inspection (clean them up by hand afterwards)
  const runOk = ev.steps.every((s) => s.ok) && !process.exitCode;
  if (!KEEP && orgId && (!PROD || runOk)) await cleanupRun({ ev, op, orgId, kvId, sessions: [client, owner] });
  else if (orgId) process.stderr.write(`kept: org ${orgId}, KV ${kvId || "-"}, ${RELEASE_PREFIX}-${orgId}-*, Artifacts namespaces of ${orgId}\n`);
  tail?.stop();
  ev.facts.orgId = orgId;
  ev.facts.kept = KEEP;
  await ev.write(evidencePath);
  process.stderr.write(`evidence: ${evidencePath}\n`);
  if (!KEEP) await rmrf(runDir);
  process.exit(process.exitCode ?? 0);
}

function CFORGE_PATH(): string {
  return join(REPO, "apps", "cli", "dist", "index.js");
}
