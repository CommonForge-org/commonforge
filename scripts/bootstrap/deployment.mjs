#!/usr/bin/env node
// Cloudflare side of scripts/bootstrap.sh and scripts/teardown.sh (Task 24): names, permission
// probes, idempotent resource creation, per-deployment wrangler configs, inventory and teardown.
// Seed of the future `npx commonforge init` installer; it is NOT a package and publishes nothing.
//
//   node scripts/bootstrap/deployment.mjs names     <name> | --production
//   node scripts/bootstrap/deployment.mjs probe
//   node scripts/bootstrap/deployment.mjs ensure    <name> | --production  [--adopt]
//   node scripts/bootstrap/deployment.mjs config    <name> | --production  [--email-mode send|log] [--email-from addr] [--admin-emails list]
//   node scripts/bootstrap/deployment.mjs secrets   <name> | --production  --out-dir <dir> [--rotate-keys] [--replace-tokens]
//   node scripts/bootstrap/deployment.mjs identify  <name> | --production  (after a deploy: record the Workers' / containers' identities)
//   node scripts/bootstrap/deployment.mjs inventory <name> | --production  [--json] [--owned] [--expect-empty]
//   node scripts/bootstrap/deployment.mjs teardown  <name> --yes
//
// Ownership (review I3, I3a): <state>/deployment.json is bound to one Cloudflare account and records
// the identity of every resource the deployment created (queue id, D1 uuid, R2 creation date,
// Worker creation time, container application id). `ensure` reuses only resources whose identity
// matches and refuses anything else of the same name (someone else's) unless --adopt. Teardown
// refuses if the account or any recorded identity no longer matches; otherwise it deletes only the
// recorded resources plus the org-scoped ones only this deployment's Worker creates
// (<name>-o-<12 hex>[-…]: release Workers, KV, Artifacts namespaces).
//
// Credentials come from the environment only and are never printed:
//   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID  wrangler + account REST calls
//   CF_API_TOKEN (default CLOUDFLARE_API_TOKEN)   Artifacts REST calls (the Worker's own secret)
//
// Production (`--production`) means the canonical names of apps/worker/wrangler*.jsonc
// (commonforge-worker, commonforge-dev, ...). Without it, every name derives from <name> and a
// name that could reach production or the CI deployment is refused. Teardown never touches
// production.
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { SOURCES, ciNames, deploymentNames, parseJsonc } from "../ci-config-core.mjs";
import { NAME_RE, RESERVED, PREVIEW_SECRETS, WORKER_SECRETS, deploymentConfigs, domainUrls, nameProblem, orgScoped, ownership, parseArgs, pickDomains, pickSecrets, pickSender, productionDomains, teardownProblems } from "./args.mjs";
import { PLACEHOLDERS } from "../live-config-core.mjs";

export { NAME_RE, RESERVED, nameProblem };

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER_DIR = join(REPO, "apps", "worker");
const API = "https://api.cloudflare.com/client/v4";

// ---------------------------------------------------------------------------------------------
// Names

export function prodConfigs() {
  return Object.fromEntries(Object.entries(SOURCES).map(([k, f]) => [k, parseJsonc(readFileSync(join(WORKER_DIR, f), "utf8"))]));
}

/** The production deployment's names, read from the committed production configs. */
function productionNames(prod, base, d1Id) {
  const w = prod.worker;
  return {
    production: true,
    suffix: "",
    worker: w.name,
    preview: prod.preview.name,
    runner: prod.runner.name,
    d1: {
      database_name: w.d1_databases[0].database_name,
      database_id: d1Id ?? w.d1_databases[0].database_id,
    },
    bucket: w.r2_buckets[0].bucket_name,
    namespacePrefix: w.vars.COMMONFORGE_NAMESPACE_PREFIX,
    deployPrefix: w.vars.COMMONFORGE_DEPLOY_WORKER_PREFIX,
    deployment: "production",
    workerUrl: `https://${w.name}.${base}`,
    previewUrl: `https://${prod.preview.name}.${base}`,
  };
}

/**
 * Every account resource name a deployment owns (queues incl. DLQ, containers by worker name).
 * `domains` ({ appDomain, previewDomain }, as recorded in deployment.json) replace the workers.dev
 * app / preview URLs.
 */
export function resolveNames(name, { production = false, base = "<subdomain>.workers.dev", d1Id = "", domains = {} } = {}) {
  const prod = prodConfigs();
  let n;
  if (production) {
    if (name && name !== "commonforge") throw new Error("--production deploys the canonical production names; pass the name commonforge (or none)");
    n = productionNames(prod, base, d1Id || undefined);
  } else {
    const why = nameProblem(name);
    if (why) throw new Error(`refusing deployment name "${name}": ${why}`);
    n = deploymentNames(name, { base, d1Id });
    // belt and braces: nothing may equal a production or CI resource name
    const ci = ciNames(base);
    const forbidden = new Set([
      prod.worker.name,
      prod.preview.name,
      prod.runner.name,
      ci.worker,
      ci.preview,
      ci.runner,
      ci.bucket,
      ci.d1.database_name,
      ci.namespacePrefix,
      ci.deployPrefix,
      prod.worker.d1_databases[0].database_name,
      prod.worker.r2_buckets[0].bucket_name,
      prod.worker.vars.COMMONFORGE_NAMESPACE_PREFIX,
      prod.worker.vars.COMMONFORGE_DEPLOY_WORKER_PREFIX,
    ]);
    for (const v of [n.worker, n.preview, n.runner, n.bucket, n.d1.database_name, n.namespacePrefix, n.deployPrefix])
      if (forbidden.has(v)) throw new Error(`refusing: ${v} is a production or CI resource name`);
  }
  const baseQueues = [
    ...new Set([
      ...(prod.worker.queues.producers ?? []).map((p) => p.queue),
      ...(prod.worker.queues.consumers ?? []).flatMap((c) => [c.queue, c.dead_letter_queue].filter(Boolean)),
      ...(prod.runner.queues.consumers ?? []).map((c) => c.queue),
    ]),
  ];
  const queues = baseQueues.map((q) => `${q}${n.suffix}`);
  // container applications are named <worker>-<class lowercase> (observed on the account)
  const containerApps = [
    ...(prod.runner.containers ?? []).map((c) => `${n.runner}-${c.class_name.toLowerCase()}`),
    ...(prod.preview.containers ?? []).map((c) => `${n.preview}-${c.class_name.toLowerCase()}`),
  ];
  const configs = production
    ? {
        worker: "wrangler.deploy-production.jsonc",
        preview: "wrangler.deploy-production-preview.jsonc",
        runner: "wrangler.deploy-production-runner.jsonc",
      }
    : {
        worker: `wrangler.deploy-${name}.jsonc`,
        preview: `wrangler.deploy-${name}-preview.jsonc`,
        runner: `wrangler.deploy-${name}-runner.jsonc`,
      };
  return {
    name: production ? "production" : name,
    ...n,
    ...domainUrls(n, domains),
    ...(domains.appDomain ? { appDomain: domains.appDomain } : {}),
    ...(domains.previewDomain ? { previewDomain: domains.previewDomain } : {}),
    runnerUrl: `https://${n.runner}.${base}`,
    queues,
    containerApps,
    configs,
  };
}

export function stateDir(name) {
  return join(process.env.COMMONFORGE_STATE_DIR ?? join(homedir(), ".config", "commonforge", "deployments"), name);
}

// ---------------------------------------------------------------------------------------------
// REST (never prints a token)

function creds() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be exported (see scripts/bootstrap.sh --help)");
  return {
    accountId,
    token,
    artifactsToken: process.env.CF_API_TOKEN || token,
  };
}

class CfError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cf(method, path, { body, token, raw = false, account = true } = {}) {
  const c = creds();
  const url = `${API}${account ? `/accounts/${c.accountId}` : ""}${path}`;
  let res, j;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token ?? c.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    j = await res.json().catch(() => ({}));
    // transient "403 10004 Access denied" (platform blip, see scripts/ci-live/lib.ts) and 5xx: retry
    const transient = (res.status === 403 && (j?.errors ?? []).some((e) => e.code === 10004)) || res.status >= 500 || res.status === 429;
    if (!transient) break;
    await sleep(1000 * (attempt + 1));
  }
  if (raw) return { status: res.status, body: j };
  if (!res.ok || j.success === false) {
    const e = (j?.errors ?? [])[0];
    throw new CfError(res.status, String(e?.code ?? res.status), `${method} ${path} → ${res.status}: ${JSON.stringify(j?.errors ?? []).slice(0, 300)}`);
  }
  return j;
}

const art = (method, path, opts = {}) => cf(method, path, { ...opts, token: creds().artifactsToken });

async function listAll(path, key) {
  const out = [];
  for (let page = 1; page < 100; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const j = await cf("GET", `${path}${sep}page=${page}&per_page=100`);
    const items = Array.isArray(j.result) ? j.result : [];
    out.push(...items);
    const info = j.result_info;
    if (!info || items.length === 0 || (info.total_pages && page >= info.total_pages) || (!info.total_pages && items.length < (info.per_page ?? 1))) break;
  }
  return out;
}

export async function workersSubdomain() {
  const j = await cf("GET", "/workers/subdomain");
  if (!j.result?.subdomain) throw new Error("this account has no workers.dev subdomain yet: open Workers & Pages in the dashboard once to claim one");
  return `${j.result.subdomain}.workers.dev`;
}

// ---------------------------------------------------------------------------------------------
// probe

/** Read-only checks per permission the bootstrap needs. A read can pass while the Edit permission
 * is missing; the deploy itself is the final word, and this says so. */
async function probe() {
  const c = creds();
  const rows = [];
  const check = async (label, fn) => {
    try {
      const detail = await fn();
      rows.push({ label, ok: true, detail });
    } catch (e) {
      rows.push({
        label,
        ok: false,
        detail: e instanceof CfError ? `HTTP ${e.status} (code ${e.code})` : String(e.message ?? e),
      });
    }
  };
  await check("token is active (account token)", async () => {
    const a = await cf("GET", "/tokens/verify", { raw: true });
    if (a.status === 200 && a.body?.result?.status === "active") return "account API token";
    const u = await cf("GET", "/user/tokens/verify", {
      raw: true,
      account: false,
    });
    if (u.status === 200 && u.body?.result?.status === "active") return "user API token";
    throw new Error("token is not active for this account");
  });
  await check("account reachable", async () => (await cf("GET", "")).result?.name ?? "ok");
  await check("Workers Scripts (+ workers.dev subdomain)", async () => {
    await cf("GET", "/workers/scripts");
    return await workersSubdomain();
  });
  await check("D1", async () => (await cf("GET", "/d1/database?per_page=1"), "read ok"));
  await check("R2", async () => (await cf("GET", "/r2/buckets"), "read ok"));
  await check("Queues", async () => (await cf("GET", "/queues"), "read ok"));
  await check("Workers KV Storage", async () => (await cf("GET", "/storage/kv/namespaces?per_page=1"), "read ok"));
  await check("Containers", async () => (await cf("GET", "/containers/applications"), "read ok"));
  await check(
    `Artifacts (with ${process.env.CF_API_TOKEN ? "CF_API_TOKEN" : "CLOUDFLARE_API_TOKEN"})`,
    async () => (await art("GET", "/artifacts/namespaces?per_page=1"), "read ok"),
  );
  for (const r of rows) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.label}${r.detail ? `: ${r.detail}` : ""}`);
  console.log("  note: these are read probes; Edit permissions are proven by the create and deploy steps that follow");
  if (rows.some((r) => !r.ok)) {
    console.error("token is missing a permission above (needs: Workers Scripts/R2/D1/Queues/KV/Containers Edit, Artifacts Edit, Account Settings Read, Workers Tail Read)");
    process.exit(1);
  }
  void c;
}

// ---------------------------------------------------------------------------------------------
// state: <state>/deployment.json records what this deployment owns (review I3)

function statePath(stateName) {
  return join(stateDir(stateName), "deployment.json");
}

function loadState(stateName) {
  const p = statePath(stateName);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function saveState(stateName, st) {
  const dir = stateDir(stateName);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(statePath(stateName), JSON.stringify(st, null, 2) + "\n", { mode: 0o600 });
}

function readState(stateName) {
  const st = loadState(stateName);
  if (!st) throw new Error(`no state for deployment ${stateName} (${statePath(stateName)}); run scripts/bootstrap.sh first`);
  return st;
}

const emptyOwned = () => ({ queues: {}, d1: null, r2: null, workers: {}, containers: {} });

// ---------------------------------------------------------------------------------------------
// ensure: queues (incl. DLQ), D1, R2, and the claim on the Worker / container names.
// Idempotent for what the state records; refuses foreign same-named resources unless --adopt.

/** This account's view of a deployment's names: observed[kind][name] = { id, created }. */
async function observe(n) {
  const out = { queue: {}, D1: {}, R2: {}, Worker: {}, "container application": {} };
  for (const q of await listAll("/queues", "queues")) if (n.queues.includes(q.queue_name)) out.queue[q.queue_name] = { id: q.queue_id, created: q.created_on };
  for (const d of await listAll(`/d1/database?name=${encodeURIComponent(n.d1.database_name)}`, "d1"))
    if (d.name === n.d1.database_name) out.D1[d.name] = { id: d.uuid, created: d.created_at };
  for (const b of (await cf("GET", "/r2/buckets")).result?.buckets ?? []) if (b.name === n.bucket) out.R2[b.name] = { id: b.creation_date, created: b.creation_date };
  const scripts = await listAll("/workers/scripts", "scripts");
  for (const w of scripts) if ([n.worker, n.preview, n.runner].includes(w.id)) out.Worker[w.id] = { id: w.created_on, created: w.created_on };
  const apps = (await cf("GET", "/containers/applications")).result ?? [];
  for (const a of apps) if (n.containerApps.includes(a.name)) out["container application"][a.name] = { id: a.id, created: a.created_at };
  return { observed: out, scripts, apps };
}

/** The state must belong to the account the credentials point at (review I3a). */
function checkAccount(st, base) {
  const acct = creds().accountId;
  if (st.accountId && st.accountId !== acct) throw new Error(`the state ${statePath(st.name)} belongs to Cloudflare account ${st.accountId.slice(0, 6)}…, not the current ${acct.slice(0, 6)}…: refusing`);
  if (base && st.base && st.base !== base) throw new Error(`the state ${statePath(st.name)} was made for ${st.base}, but this account's workers.dev is ${base}: refusing`);
}

const adoptedFlag = (r) => (r.action === "adopt" || r.owned?.adopted ? { adopted: true } : {});

// ---------------------------------------------------------------------------------------------
// ensure: queues (incl. DLQ), D1, R2, and the claim on the Worker / container names.
// Idempotent for what the state records; refuses foreign same-named resources unless --adopt.

async function ensure(name, production, adopt) {
  const base = await workersSubdomain();
  const n = resolveNames(name, { production, base });
  const existing = loadState(n.name);
  if (existing && !existing.accountId) throw new Error(`the state ${statePath(n.name)} records no Cloudflare account id (made by an older bootstrap); remove it only if you are sure it is this account's`);
  const st = existing ?? { name: n.name, production, accountId: creds().accountId, base, createdAt: new Date().toISOString() };
  checkAccount(st, base);
  st.owned = { ...emptyOwned(), ...(st.owned ?? {}) };

  // look at the account once, decide everything, refuse before creating anything
  const { observed } = await observe(n);
  const row = (kind, nm, owned) => ({ kind, name: nm, exists: !!observed[kind][nm], existingId: observed[kind][nm]?.id, existingCreated: observed[kind][nm]?.created, owned });
  const plan = [
    ...n.queues.map((q) => row("queue", q, st.owned.queues[q])),
    row("D1", n.d1.database_name, st.owned.d1?.name === n.d1.database_name ? st.owned.d1 : undefined),
    row("R2", n.bucket, st.owned.r2?.name === n.bucket ? st.owned.r2 : undefined),
    ...[n.worker, n.preview, n.runner].map((w) => row("Worker", w, st.owned.workers[w])),
    ...n.containerApps.map((c) => row("container application", c, st.owned.containers[c])),
  ].map((r) => ({ ...r, action: ownership({ ...r, adopt }) }));
  const conflicts = plan.filter((r) => r.action === "conflict");
  if (conflicts.length) {
    throw new Error(
      `these already exist on the account and are not the ones this deployment's state (${statePath(n.name)}) records:\n` +
        conflicts.map((r) => `    ${r.kind} ${r.name}`).join("\n") +
        `\n  They may belong to someone else: pick another --name, or pass --adopt to take them over (teardown would then delete them).`,
    );
  }

  const now = new Date().toISOString();
  for (const r of plan) {
    const label = { create: "create", reuse: "reuse ", adopt: "ADOPT " }[r.action];
    if (r.kind === "queue") {
      let id = r.existingId;
      if (r.action === "create") id = (await cf("POST", "/queues", { body: { queue_name: r.name } })).result.queue_id;
      st.owned.queues[r.name] = { id, ...adoptedFlag(r) };
    } else if (r.kind === "D1") {
      let id = r.existingId;
      if (r.action === "create") id = (await cf("POST", "/d1/database", { body: { name: r.name } })).result.uuid;
      st.owned.d1 = { name: r.name, id, ...adoptedFlag(r) };
      st.d1Id = id;
    } else if (r.kind === "R2") {
      let id = r.existingId;
      if (r.action === "create") {
        await cf("POST", "/r2/buckets", { body: { name: r.name } });
        id = ((await cf("GET", "/r2/buckets")).result?.buckets ?? []).find((b) => b.name === r.name)?.creation_date;
      }
      st.owned.r2 = { name: r.name, id, ...adoptedFlag(r) };
    } else {
      // Workers and container applications are created by the deploy that follows: claim the names now
      // (claimedAt); `identify` records their identities after the deploy.
      const bag = r.kind === "Worker" ? st.owned.workers : st.owned.containers;
      bag[r.name] = r.action === "create" ? { claimedAt: r.owned?.claimedAt ?? now } : { id: r.existingId, ...adoptedFlag(r) };
      saveState(n.name, st);
      if (r.action !== "create") console.log(`  ${label} ${r.kind} ${r.name} (redeployed below)`);
      continue;
    }
    saveState(n.name, st); // after every step: a failure half way still records what was created
    console.log(`  ${label} ${r.kind} ${r.name}`);
  }
  // KV: the platform itself binds none; org KV namespaces are created on demand by
  // POST /api/orgs/:org/deploy-resources (titled <deployPrefix>-<org>-<name>), removed by teardown.
  saveState(n.name, st);
}

/** After a deploy: record the identity of each claimed Worker / container application created since the claim. */
async function identify(name, production) {
  const n = resolveNames(name, { production });
  const st = readState(n.name);
  checkAccount(st);
  const { observed } = await observe(n);
  for (const [kind, bag] of [["Worker", st.owned.workers], ["container application", st.owned.containers]]) {
    for (const [nm, rec] of Object.entries(bag ?? {})) {
      const seen = observed[kind][nm];
      if (!seen || rec.id !== undefined) continue;
      if (ownership({ exists: true, existingId: seen.id, existingCreated: seen.created, owned: rec }) !== "reuse") throw new Error(`${kind} ${nm} on the account was created before this deployment claimed it: not recording it as ours`);
      bag[nm] = { id: seen.id };
    }
  }
  saveState(n.name, st);
}

// ---------------------------------------------------------------------------------------------
// config: the three wrangler configs of this deployment (git-ignored, next to the production ones
// so their relative paths resolve the same way)

const HEADER = (name) =>
  `// GENERATED by scripts/bootstrap.sh for deployment "${name}". Do not edit; rerun the bootstrap.\n// Git-ignored. Every account-wide name is this deployment's own (scripts/ci-config-core.mjs checks).\n`;

function config(name, production, emailMode, emailFrom, adminEmails, domainOpts = {}) {
  const st = readState(production ? "production" : name);
  // custom domains: given ones replace the recorded ones (`none` clears), so a rerun keeps them
  const domains = pickDomains(st, domainOpts);
  const n = resolveNames(name, { production, base: st.base, d1Id: st.d1Id, domains });
  // the sender: given, else the one recorded by an earlier run; the template's is a placeholder (review M4)
  const sender = pickSender(st, emailFrom, { emailMode, worker: n.worker, placeholder: PLACEHOLDERS.emailFrom });
  if (sender.refuse) throw new Error(sender.refuse);
  emailFrom = sender.emailFrom;
  // a test deployment may not route production's custom domains (review L5)
  const prodDomains = production ? [] : productionDomains(process.env, loadState("production"));
  const out = deploymentConfigs(prodConfigs(), n, { production, base: st.base, d1Id: st.d1Id, emailMode, emailFrom, adminEmails, domains, productionDomains: prodDomains });
  if (sender.warn) console.error(`  warning: ${sender.warn}`);
  if (emailFrom) {
    st.emailFrom = emailFrom;
    delete st.placeholderSender;
  } else if (sender.warn) st.placeholderSender = true;
  st.appDomain = domains.appDomain;
  st.previewDomain = domains.previewDomain;
  saveState(n.name, st);
  for (const [k, f] of Object.entries(n.configs)) writeFileSync(join(WORKER_DIR, f), HEADER(n.name) + JSON.stringify(out[k], null, 2) + "\n");
  console.log(JSON.stringify({ ...n, emailMode, emailFrom: out.worker.vars.COMMONFORGE_EMAIL_FROM, adminEmails: out.worker.vars.COMMONFORGE_ADMIN_EMAILS ?? "" }));
}

// ---------------------------------------------------------------------------------------------
// secrets (review I4): write <out-dir>/worker.json and preview.json (0600) with only the secrets each
// Worker does not have yet (all of them with --rotate). Values come from this process's environment.

async function secretNames(script) {
  const r = await cf("GET", `/workers/scripts/${script}/secrets`, { raw: true });
  if (r.status === 404) return []; // first deploy: the Worker does not exist yet
  if (r.status !== 200 || r.body?.success === false) throw new Error(`cannot list the secrets of ${script} (HTTP ${r.status})`);
  return (r.body.result ?? []).map((x) => x.name);
}

async function secrets(name, production, outDir, mode) {
  if (!outDir) throw new Error("secrets needs --out-dir");
  const n = resolveNames(name, { production });
  for (const [script, wanted, file] of [
    [n.worker, WORKER_SECRETS, "worker.json"],
    [n.preview, PREVIEW_SECRETS, "preview.json"],
  ]) {
    const have = await secretNames(script);
    const { send, warnings } = pickSecrets(wanted, have, process.env, mode);
    for (const w of warnings) console.error(`  WARNING: ${w}`);
    writeFileSync(join(outDir, file), JSON.stringify(send), { mode: 0o600 });
    const keys = Object.keys(send);
    console.log(`  ${script}: ${keys.length ? `setting ${keys.join(", ")}` : "all secrets present (kept; --rotate-keys / --replace-tokens replace them)"}`);
  }
}

// ---------------------------------------------------------------------------------------------
// inventory / teardown

/**
 * What exists on the account for this deployment. By name by default (read-only listing); with
 * `owned`, only what the state records (by id where there is one) plus the <name>-o-* resources
 * that only this deployment's Worker creates.
 */
async function inventory(name, production = false, owned = false) {
  const n = resolveNames(name, { production });
  const st = owned ? readState(n.name) : null;
  if (st) checkAccount(st);
  const o = st ? { ...emptyOwned(), ...(st.owned ?? {}) } : null;
  const { observed, scripts, apps } = await observe(n);
  // by name; with `owned`, only names the state records (teardown checks identities before deleting)
  const pick = (kind, names) => names.filter((nm) => observed[kind][nm]);
  const kv = (await listAll("/storage/kv/namespaces", "kv")).filter((k) => orgScoped(n.deployPrefix, k.title));
  const nsAll = [];
  for (let page = 1; page < 50; page++) {
    const j = await art("GET", `/artifacts/namespaces?per_page=100&page=${page}`);
    nsAll.push(...(j.result ?? []));
    if (!j.result_info || page >= (j.result_info.total_pages ?? 1)) break;
  }
  const namespaces = nsAll.filter((x) => orgScoped(n.namespacePrefix, x.namespace)).map((x) => ({ namespace: x.namespace, repos: x.repo_count ?? null }));
  const queueNames = pick("queue", o ? Object.keys(o.queues) : n.queues);
  const containerNames = pick("container application", o ? Object.keys(o.containers) : n.containerApps);
  return {
    workers: pick("Worker", o ? Object.keys(o.workers) : [n.worker, n.preview, n.runner]),
    releaseWorkers: scripts.map((s) => s.id).filter((id) => orgScoped(n.deployPrefix, id)),
    containers: containerNames.map((nm) => ({ id: observed["container application"][nm].id, name: nm })),
    queues: queueNames.map((nm) => ({ id: observed.queue[nm].id, name: nm })),
    d1: pick("D1", o ? (o.d1 ? [o.d1.name] : []) : [n.d1.database_name]).map((nm) => ({ id: observed.D1[nm].id, name: nm })),
    r2: pick("R2", o ? (o.r2 ? [o.r2.name] : []) : [n.bucket]),
    kv: kv.map((k) => ({ id: k.id, title: k.title })),
    artifacts: namespaces,
    _observed: observed,
    _state: st,
  };
}

function countOf(inv) {
  return Object.entries(inv).reduce((a, [k, v]) => a + (k.startsWith("_") ? 0 : v.length), 0);
}

function printInventory(inv) {
  const line = (k, xs) => console.log(`  ${k.padEnd(15)} ${xs.length ? xs.join(", ") : "-"}`);
  line("workers", inv.workers);
  line("release workers", inv.releaseWorkers);
  line("containers", inv.containers.map((c) => c.name));
  line("queues", inv.queues.map((q) => q.name));
  line("D1", inv.d1.map((d) => d.name));
  line("R2", inv.r2);
  line("KV", inv.kv.map((k) => k.title));
  line("artifacts", inv.artifacts.map((a) => `${a.namespace}${a.repos != null ? ` (${a.repos} repos)` : ""}`));
}

async function emptyBucket(bucket) {
  let deleted = 0;
  for (;;) {
    const j = await cf("GET", `/r2/buckets/${bucket}/objects?per_page=1000`);
    const objs = j.result ?? [];
    if (!objs.length) break;
    for (let i = 0; i < objs.length; i += 16) {
      await Promise.all(objs.slice(i, i + 16).map((o) => cf("DELETE", `/r2/buckets/${bucket}/objects/${o.key.split("/").map(encodeURIComponent).join("/")}`)));
    }
    deleted += objs.length;
  }
  return deleted;
}

/** Deletes only what the state records (+ <name>-o-* org resources); never production or CI names. */
async function teardown(name) {
  resolveNames(name, {}); // refuses production and CI names
  const inv = await inventory(name, false, true); // throws without state, or for another account
  // review I3a: nothing is deleted unless every recorded resource is still the recorded one
  const problems = teardownProblems(inv._state, creds().accountId, inv._observed);
  if (problems.length) throw new Error(`refusing to delete anything:\n${problems.map((p) => `    ${p}`).join("\n")}`);
  const did = [];
  const step = async (label, fn) => {
    try {
      await fn();
      did.push(`deleted ${label}`);
      console.log(`  deleted ${label}`);
    } catch (e) {
      if (e instanceof CfError && e.status === 404) return void console.log(`  gone    ${label}`);
      console.log(`  FAILED  ${label}: ${e.message}`);
      did.push(`FAILED ${label}`);
    }
  };
  // 1. queue consumers first (a Worker that consumes a queue cannot be deleted: code 10064)
  for (const q of inv.queues) {
    const full = (await cf("GET", `/queues/${q.id}`)).result;
    for (const c of full?.consumers ?? []) await step(`consumer of ${q.name}`, () => cf("DELETE", `/queues/${q.id}/consumers/${c.consumer_id}`));
  }
  // 2. Workers (this deployment's, then the org release Workers), then the container apps
  for (const w of inv.workers) await step(`worker ${w}`, () => cf("DELETE", `/workers/scripts/${w}?force=true`));
  for (const w of inv.releaseWorkers) await step(`release worker ${w}`, () => cf("DELETE", `/workers/scripts/${w}?force=true`));
  for (const a of inv.containers) await step(`container application ${a.name}`, () => cf("DELETE", `/containers/applications/${a.id}`));
  // 3. queues (no Worker binds them any more: code 11005 otherwise)
  for (const q of inv.queues) await step(`queue ${q.name}`, () => cf("DELETE", `/queues/${q.id}`));
  // 4. D1 (by recorded id), R2 (emptied first), KV
  for (const d of inv.d1) await step(`D1 ${d.name}`, () => cf("DELETE", `/d1/database/${d.id}`));
  for (const b of inv.r2) {
    const k = await emptyBucket(b);
    console.log(`  emptied R2 ${b} (${k} objects)`);
    await step(`R2 ${b}`, () => cf("DELETE", `/r2/buckets/${b}`));
  }
  for (const k of inv.kv) await step(`KV ${k.title}`, () => cf("DELETE", `/storage/kv/namespaces/${k.id}`));
  // 5. Artifacts: every repo of every <name>-o-* namespace, then the namespace
  for (const ns of inv.artifacts) {
    const repos = [];
    try {
      for (let page = 1; page < 50; page++) {
        const j = await art("GET", `/artifacts/namespaces/${ns.namespace}/repos?per_page=100&page=${page}`);
        repos.push(...(j.result ?? []));
        if (!j.result_info || page >= (j.result_info.total_pages ?? 1)) break;
      }
    } catch (e) {
      if (!(e instanceof CfError && e.status === 404)) throw e;
    }
    for (const r of repos) await step(`repo ${ns.namespace}/${r.name}`, () => art("DELETE", `/artifacts/namespaces/${ns.namespace}/repos/${encodeURIComponent(r.name)}`));
    await step(`artifacts namespace ${ns.namespace}`, () => art("DELETE", `/artifacts/namespaces/${ns.namespace}`));
  }
  return did;
}

// ---------------------------------------------------------------------------------------------

async function main() {
  try {
    const { cmd, name, flags, opts } = parseArgs(process.argv.slice(2));
    const production = flags.has("--production");
    const needName = () => {
      if (!name) throw new Error(`${cmd} needs a deployment name (or --production)`);
      return name;
    };
    switch (cmd) {
      case "names":
        console.log(JSON.stringify(resolveNames(needName(), { production })));
        break;
      case "probe":
        await probe();
        break;
      case "ensure":
        await ensure(needName(), production, flags.has("--adopt"));
        break;
      case "config":
        config(needName(), production, opts["email-mode"] ?? "send", opts["email-from"], opts["admin-emails"], { "app-domain": opts["app-domain"], "preview-domain": opts["preview-domain"] });
        break;
      case "secrets":
        await secrets(needName(), production, opts["out-dir"], { rotateKeys: flags.has("--rotate-keys"), replaceTokens: flags.has("--replace-tokens") });
        break;
      case "identify":
        await identify(needName(), production);
        break;
      case "inventory": {
        const inv = await inventory(needName(), production, flags.has("--owned"));
        if (flags.has("--json")) console.log(JSON.stringify(inv, (k, v) => (k.startsWith("_") ? undefined : v)));
        else printInventory(inv);
        if (flags.has("--expect-empty") && countOf(inv) > 0) {
          console.error(`deployment ${name} still has ${countOf(inv)} resources`);
          process.exit(1);
        }
        break;
      }
      case "teardown": {
        if (production) throw new Error("production is never torn down");
        if (!flags.has("--yes")) throw new Error("teardown needs --yes");
        const did = await teardown(needName());
        if (did.some((d) => d.startsWith("FAILED"))) process.exit(1);
        break;
      }
      default:
        console.error("usage: deployment.mjs names|probe|ensure|config|secrets|identify|inventory|teardown <name> | --production [...]");
        process.exit(2);
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import("node:fs")).realpathSync(process.argv[1])) await main();
