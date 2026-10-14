#!/usr/bin/env node
// Task 5 (S5): Artifacts rate-limit / cost benchmark for assumption A9.
//
// Usage (from the repo root, plain Node 22+, git 2.4x+, no deps):
//   source scripts/load-dev-vars.sh
//   node spikes/rate-benchmark/run.mjs [--n=100] [--concurrency=1,10,25] [--mode=fork|create]
//                                      [--burst=0] [--burst-rate=220] [--label=x] [--sweep-only]
//
// Each "lifecycle" is one synthetic task:
//   fork the baseline (or create an empty repo) in the -tasks namespace
//   -> mint a write token (TTL 600 s) -> git clone -> commit + push -> revoke the token -> delete.
// The run executes --n lifecycles at each listed concurrency (a worker pool), then optionally a
// control-plane read burst (--burst=<requests>, GET /repos/<base> at --burst-rate req/s) to probe
// the documented 2,000 control-plane req/10 s/namespace limit. The burst stops early on sustained
// 429s (>= 50% of the last 100 responses).
//
// Namespaces (override with BENCH_CANONICAL_NS / BENCH_TASKS_NS):
//   commonforge-bench-canonical  one small "canonical" seed repo
//   commonforge-bench-tasks      the baseline mirror plus every per-task repo
// Forks are namespace-local (the fork endpoint ignores `namespace`/`target_namespace`; measured
// in this spike), so the canonical seed is mirrored once into -tasks as the fork baseline.
//
// Every repo is deleted in a finally block, and a final sweep lists both namespaces and deletes
// any `bench-` repo left behind. Secrets (CF API token, account id, every repo token) are kept
// out of argv (GIT_CONFIG_* env) and out of the results file (redact()).

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
if (!ACCOUNT_ID || !API_TOKEN) {
  console.error('CF_ACCOUNT_ID / CF_API_TOKEN missing: source scripts/load-dev-vars.sh first');
  process.exit(2);
}
const CANON_NS = process.env.BENCH_CANONICAL_NS ?? 'commonforge-bench-canonical';
const TASKS_NS = process.env.BENCH_TASKS_NS ?? 'commonforge-bench-tasks';
const ACCT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
const nsBase = (ns) => `${ACCT}/artifacts/namespaces/${ns}`;
const RUN = Date.now().toString(36);

const argv = process.argv.slice(2);
const opt = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const N = Number(opt('n', 100));
const CONCURRENCIES = opt('concurrency', '1,10,25').split(',').filter(Boolean).map(Number);
const MODE = opt('mode', 'fork');
const BURST = Number(opt('burst', 0));
const BURST_RATE = Number(opt('burst-rate', 220));
const LABEL = opt('label', `${MODE}-c${CONCURRENCIES.join('_')}${BURST ? `-burst${BURST}` : ''}`);
const SWEEP_ONLY = argv.includes('--sweep-only');
const TOKEN_TTL = 600;

// ---------------------------------------------------------------- helpers

function redact(s) {
  if (s == null) return s;
  let out = String(s)
    // Repo tokens: art_v1_<hex> (S2/S3) and art_v2_x_<hex> (observed 2026-10-06), optional ?expires=.
    .replace(/art_v\d+_[A-Za-z0-9_]+(\?expires=\d+)?/g, 'art_<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9_\-.?=]+/g, 'Bearer <redacted>')
    .replace(/(Authorization:\s*)(?!Bearer <redacted>)\S.*$/gim, '$1<redacted>');
  out = out.split(API_TOKEN).join('<cf-api-token>').split(ACCOUNT_ID).join('<ACCOUNT_ID>');
  return out;
}
const now = () => performance.now();
const ms = (t0) => Math.round(performance.now() - t0);
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const log = (...a) => console.log(redact(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
const jitter = (base) => Math.round(base * (0.5 + Math.random()));

// ---------------------------------------------------------------- metrics

// One metrics bucket per scenario (setup, c1, c10, ..., burst, sweep). Every HTTP request is an
// event: { op, kind: 'control'|'git', t (ms since run start), ms, status, ok, attempt }.
const T0 = Date.now();
let M = null;
function bucket(name) { return { name, events: [], ops: [], errors: [], startedAt: Date.now() }; }
function recordReq(kind, op, status, durMs, extra = {}) {
  M.events.push({ kind, op, t: Date.now() - T0, ms: durMs, status, ...extra });
}
function recordOp(op, durMs, ok, attempts, extra = {}) { M.ops.push({ op, ms: durMs, ok, attempts, ...extra }); }
function recordErr(op, status, detail) { M.errors.push({ op, status, detail: redact(detail)?.slice(0, 400) }); }

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const stats = (arr) => ({ n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), max: arr.length ? Math.max(...arr) : null, mean: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null });
function maxIn10s(ts) {
  const s = [...ts].sort((a, b) => a - b);
  let best = 0, j = 0;
  for (let i = 0; i < s.length; i++) { while (s[i] - s[j] >= 10_000) j++; best = Math.max(best, i - j + 1); }
  return best;
}
function summarize(b) {
  const control = b.events.filter((e) => e.kind === 'control');
  const gitEv = b.events.filter((e) => e.kind === 'git');
  const byOp = {};
  for (const e of b.events) {
    const k = `${e.kind}:${e.op}`;
    const o = (byOp[k] ??= { requests: 0, statuses: {} });
    o.requests++;
    o.statuses[e.status] = (o.statuses[e.status] ?? 0) + 1;
  }
  const opLatency = {};
  for (const op of [...new Set(b.ops.map((o) => o.op))]) {
    const xs = b.ops.filter((o) => o.op === op);
    opLatency[op] = { ...stats(xs.map((o) => o.ms)), failed: xs.filter((o) => !o.ok).length, retries: xs.reduce((a, o) => a + Math.max(0, o.attempts - 1), 0) };
  }
  const lc = b.lifecycles ?? [];
  return {
    name: b.name,
    wallMs: (b.endedAt ?? Date.now()) - b.startedAt,
    requests: { control: control.length, git: gitEv.length, total: b.events.length },
    status429: { control: control.filter((e) => e.status === 429).length, git: gitEv.filter((e) => e.status === 429).length },
    status5xx: { control: control.filter((e) => e.status >= 500).length, git: gitEv.filter((e) => e.status >= 500).length },
    peak10s: { control: maxIn10s(control.map((e) => e.t)), git: maxIn10s(gitEv.map((e) => e.t)), all: maxIn10s(b.events.map((e) => e.t)) },
    byOp,
    opLatency,
    lifecycles: lc.length ? { n: lc.length, ok: lc.filter((x) => x.ok).length, failed: lc.filter((x) => !x.ok).length, ms: stats(lc.map((x) => x.ms)), perLifecycle: { control: control.length / lc.length, git: gitEv.length / lc.length } } : undefined,
    errors: b.errors,
  };
}

// ---------------------------------------------------------------- control plane

async function rawApi(ns, method, path, body) {
  const t0 = now();
  try {
    const res = await fetch(nsBase(ns) + path, {
      method,
      headers: { Authorization: `Bearer ${API_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    const rl = [...res.headers].filter(([k]) => /ratelimit|retry-after/i.test(k));
    return { status: res.status, ms: ms(t0), json, text, rateHeaders: rl.length ? Object.fromEntries(rl) : undefined };
  } catch (e) {
    return { status: 0, ms: ms(t0), json: null, text: String(e?.cause?.code ?? e) };
  }
}

// Control-plane call with jittered exponential backoff on 429 / 5xx / network error.
// Non-idempotent ops (fork, create) pass `recover`, which looks the repo up before retrying.
async function cp(op, ns, method, path, body, { recover, okStatuses = [], maxAttempts = 6 } = {}) {
  const t0 = now();
  for (let attempt = 1; ; attempt++) {
    const r = await rawApi(ns, method, path, body);
    recordReq('control', op, r.status, r.ms, attempt > 1 ? { retry: true } : {});
    if (r.rateHeaders) (M.rateHeaders ??= []).push(r.rateHeaders);
    if (r.json?.success || okStatuses.includes(r.status) || (r.status >= 200 && r.status < 300 && !r.json)) {
      recordOp(op, ms(t0), true, attempt);
      return { ...r, attempts: attempt };
    }
    const retryable = r.status === 429 || r.status >= 500 || r.status === 0 || r.status === 409;
    recordErr(op, r.status, `attempt ${attempt}: ${JSON.stringify(r.json?.errors ?? r.text?.slice(0, 300))}`);
    if (!retryable || attempt >= maxAttempts) {
      recordOp(op, ms(t0), false, attempt);
      return { ...r, attempts: attempt, failed: true };
    }
    if (recover) {
      const got = await recover();
      if (got) { recordOp(op, ms(t0), true, attempt, { recovered: true }); return { ...got, attempts: attempt, recovered: true }; }
    }
    await sleep(jitter(Math.min(8000, 300 * 2 ** (attempt - 1)) * (r.status === 429 ? 2 : 1)));
  }
}

// ---------------------------------------------------------------- git

// Runs git with the token in GIT_CONFIG_* env. GIT_TRACE_CURL (no data) is enabled so the number
// of smart-HTTP requests each git command makes can be counted; git redacts Authorization in
// traces and redact() runs on top. Trace lines are stripped from the returned stderr.
function git(cwd, args, { token } = {}) {
  return new Promise((resolve) => {
    const t0 = now();
    const genv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', GIT_TRACE_CURL: '1', GIT_TRACE_CURL_NO_DATA: '1', GIT_TRACE_REDACT: '1' };
    let n = 0;
    const cfg = [['credential.helper', ''], ['user.name', 'bench'], ['user.email', 'bench@commonforge.invalid'], ['init.defaultBranch', 'main'], ['advice.detachedHead', 'false']];
    if (token) cfg.push(['http.extraHeader', `Authorization: Bearer ${token}`]);
    for (const [k, v] of cfg) { genv[`GIT_CONFIG_KEY_${n}`] = k; genv[`GIT_CONFIG_VALUE_${n}`] = v; n++; }
    genv.GIT_CONFIG_COUNT = String(n);
    const p = spawn('git', args, { cwd, env: genv });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      const lines = err.split('\n');
      const sends = lines.filter((l) => /=> Send header: (GET|POST) /.test(l)).length;
      const statuses = lines.map((l) => l.match(/<= Recv header: HTTP\/[\d.]+ (\d{3})/)?.[1]).filter(Boolean).map(Number);
      const plain = lines.filter((l) => !/^\d\d:\d\d:\d\d\.\d+ (http\.c|trace\.c|git\.c|run-command\.c)/.test(l) && !/(=>|<=) (Send|Recv)/.test(l) && !/^\s*$/.test(l)).join('\n');
      resolve({ code, ms: ms(t0), sends, statuses, stdout: redact(out.trim()), stderr: redact(plain.trim()) });
    });
  });
}
// Records each HTTP request a git command made (statuses from the trace; requests with no
// response line are recorded as status 0).
function recordGit(op, r, attempt) {
  for (let i = 0; i < Math.max(r.sends, r.statuses.length); i++) {
    recordReq('git', op, r.statuses[i] ?? 0, Math.round(r.ms / Math.max(1, r.sends)), attempt > 1 ? { retry: true } : {});
  }
}
async function gitLocal(cwd, args) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
const isBusy = (s) => /receive_pack_busy|remote end hung up|unexpected disconnect/i.test(s);
const is429 = (r) => r.statuses.includes(429) || /\b429\b|rate.?limit/i.test(r.stderr);

// Remote git op with retry on 429 / 5xx / busy. Push re-checks the remote ref before retrying,
// because a push reported as failed can still have landed (S4).
async function gitRemote(op, cwd, args, { token, maxAttempts = 6, verifyLanded } = {}) {
  const t0 = now();
  for (let attempt = 1; ; attempt++) {
    const r = await git(cwd, args, { token });
    recordGit(op, r, attempt);
    if (r.code === 0) { recordOp(op, ms(t0), true, attempt); return r; }
    const status = r.statuses.find((s) => s >= 400) ?? (isBusy(r.stderr) ? 'busy' : `exit${r.code}`);
    recordErr(op, status, `attempt ${attempt}: ${r.stderr.split('\n').slice(-3).join(' | ')}`);
    if (verifyLanded && (await verifyLanded())) { recordOp(op, ms(t0), true, attempt, { landedDespiteError: true }); return r; }
    const retryable = is429(r) || r.statuses.some((s) => s >= 500) || isBusy(r.stderr);
    if (!retryable || attempt >= maxAttempts) { recordOp(op, ms(t0), false, attempt); throw new Error(`${op} failed: ${r.stderr.split('\n').slice(-2).join(' | ')}`); }
    await sleep(jitter(Math.min(8000, 250 * 2 ** (attempt - 1)) * (is429(r) ? 2 : 1)));
  }
}
async function lsRemoteHead(remote, token) {
  const r = await git(undefined, ['ls-remote', remote, 'refs/heads/main'], { token });
  recordGit('ls-remote', r, 1);
  return r.code === 0 ? r.stdout.split('\t')[0] : null;
}

// ---------------------------------------------------------------- repo helpers

const created = new Map(); // name -> ns
async function getRepo(ns, name) {
  const g = await rawApi(ns, 'GET', `/repos/${name}`);
  recordReq('control', 'get-repo(recover)', g.status, g.ms);
  return g.json?.success ? g : null;
}
async function createRepo(ns, name) {
  created.set(name, ns);
  const r = await cp('create', ns, 'POST', '/repos', { name, default_branch: 'main', description: `S5 bench ${RUN}` }, { recover: () => getRepo(ns, name) });
  if (r.failed) throw new Error(`create ${name}: ${r.status}`);
  return r.json.result;
}
async function forkRepo(ns, base, name) {
  created.set(name, ns);
  const r = await cp('fork', ns, 'POST', `/repos/${base}/fork`, { name, description: `S5 bench ${RUN}` }, { recover: () => getRepo(ns, name) });
  if (r.failed) throw new Error(`fork ${name}: ${r.status}`);
  return r.json.result;
}
async function mintToken(ns, repo, scope = 'write') {
  const r = await cp('token', ns, 'POST', '/tokens', { repo, scope, ttl: TOKEN_TTL });
  if (r.failed) throw new Error(`token ${repo}: ${r.status}`);
  return r.json.result; // { id, plaintext, scope, expires_at }
}
async function revokeToken(ns, id) {
  const r = await cp('revoke', ns, 'DELETE', `/tokens/${id}`, undefined, { okStatuses: [404] });
  if (r.failed) throw new Error(`revoke: ${r.status}`);
}
async function deleteRepo(ns, name) {
  const r = await cp('delete', ns, 'DELETE', `/repos/${name}`, undefined, { okStatuses: [202, 204, 404] });
  if (!r.failed) created.delete(name);
  return r;
}
const remoteOf = (ns, name) => `https://${ACCOUNT_ID}.artifacts.cloudflare.net/git/${ns}/${name}.git`;

// ---------------------------------------------------------------- setup: canonical seed + baseline mirror

async function setup(root) {
  M = bucket('setup');
  const seed = `bench-seed-${RUN}`, base = `bench-base-${RUN}`;
  const s = await createRepo(CANON_NS, seed);
  const w = join(root, 'seed');
  await mkdir(w, { recursive: true });
  await gitLocal(w, ['init', '-q', '-b', 'main']);
  await writeFile(join(w, 'README.md'), '# S5 benchmark seed\n');
  await mkdir(join(w, 'src'));
  for (let i = 0; i < 20; i++) await writeFile(join(w, 'src', `m${i}.ts`), `export const v${i} = ${i};\n`.repeat(50));
  await gitLocal(w, ['add', '-A']);
  await gitLocal(w, ['commit', '-q', '-m', 'seed']);
  const t = await mintToken(CANON_NS, seed);
  await gitRemote('push(setup)', w, ['push', '-q', s.remote, 'HEAD:refs/heads/main'], { token: t.plaintext });
  await revokeToken(CANON_NS, t.id);
  // Forks are namespace-local, so mirror the canonical baseline into -tasks once.
  const b = await createRepo(TASKS_NS, base);
  const tb = await mintToken(TASKS_NS, base);
  await gitRemote('push(setup)', w, ['push', '-q', b.remote, 'HEAD:refs/heads/main'], { token: tb.plaintext });
  await revokeToken(TASKS_NS, tb.id);
  // Cross-namespace fork probe: does the fork body accept a target namespace?
  const probeName = `bench-xns-${RUN}`;
  created.set(probeName, CANON_NS);
  const xr = await rawApi(CANON_NS, 'POST', `/repos/${seed}/fork`, { name: probeName, namespace: TASKS_NS });
  recordReq('control', 'fork(xns-probe)', xr.status, xr.ms);
  const landedNs = xr.json?.result?.remote?.match(/\/git\/([^/]+)\//)?.[1];
  const crossNamespaceFork = { status: xr.status, requestedNamespace: TASKS_NS, landedNamespace: landedNs, honoured: landedNs === TASKS_NS };
  if (xr.json?.success) { created.set(probeName, landedNs ?? CANON_NS); await deleteRepo(landedNs ?? CANON_NS, probeName); }
  M.endedAt = Date.now();
  return { seed, base, bucket: M, crossNamespaceFork, seedFiles: 21 };
}

// ---------------------------------------------------------------- one lifecycle

async function lifecycle(root, base, label, i) {
  const name = `bench-${RUN}-${label}-${i}`;
  const dir = join(root, name);
  const t0 = now();
  let tok = null, repo = null, ok = false, err = null;
  try {
    repo = MODE === 'fork' ? await forkRepo(TASKS_NS, base, name) : await createRepo(TASKS_NS, name);
    tok = await mintToken(TASKS_NS, name, 'write');
    const remote = repo.remote ?? remoteOf(TASKS_NS, name);
    await gitRemote('clone', root, ['clone', '-q', remote, dir], { token: tok.plaintext });
    await writeFile(join(dir, `task-${i}.txt`), `task ${i} ${label} ${Date.now()}\n`);
    await gitLocal(dir, ['add', '-A']);
    await gitLocal(dir, ['commit', '-q', '-m', `task ${i}`]);
    const sha = await gitLocal(dir, ['rev-parse', 'HEAD']);
    await gitRemote('push', dir, ['push', '-q', 'origin', 'HEAD:refs/heads/main'], { token: tok.plaintext, verifyLanded: async () => (await lsRemoteHead(remote, tok.plaintext)) === sha });
    await revokeToken(TASKS_NS, tok.id);
    tok = null;
    ok = true;
  } catch (e) {
    err = redact(String(e?.message ?? e)).slice(0, 300);
  } finally {
    if (tok) { try { await revokeToken(TASKS_NS, tok.id); } catch { /* sweep */ } }
    if (repo || created.has(name)) { const d = await deleteRepo(TASKS_NS, name); if (d.failed) { ok = false; err ??= `delete ${d.status}`; } }
    await rm(dir, { recursive: true, force: true });
  }
  return { i, ok, ms: ms(t0), err };
}

async function scenario(root, base, conc) {
  M = bucket(`c${conc}`);
  const label = `c${conc}`;
  let next = 0;
  const lc = [];
  const worker = async () => { while (next < N) { const i = next++; const r = await lifecycle(root, base, label, i); lc.push(r); if (!r.ok) log(`  lifecycle ${label}/${i} failed: ${r.err}`); } };
  await Promise.all(Array.from({ length: Math.min(conc, N) }, worker));
  M.lifecycles = lc;
  M.endedAt = Date.now();
  return M;
}

// ---------------------------------------------------------------- control-plane read burst

async function burst(base) {
  M = bucket(`burst${BURST}`);
  const interval = 1000 / BURST_RATE;
  const recent = [];
  let stopped = null, sent = 0;
  const inflight = new Set();
  const tStart = now();
  while (sent < BURST && !stopped) {
    const due = tStart + sent * interval;
    const wait = due - now();
    if (wait > 1) await sleep(wait);
    sent++;
    const p = rawApi(TASKS_NS, 'GET', `/repos/${base}`).then((r) => {
      recordReq('control', 'get-repo(burst)', r.status, r.ms);
      if (r.rateHeaders) (M.rateHeaders ??= []).push(r.rateHeaders);
      if (r.status !== 200 && (M.errors.length < 20)) recordErr('get-repo(burst)', r.status, JSON.stringify(r.json?.errors ?? r.text?.slice(0, 200)));
      recent.push(r.status === 429);
      if (recent.length > 100) recent.shift();
      if (recent.length === 100 && recent.filter(Boolean).length >= 50) stopped ??= `sustained 429s after ${sent} requests`;
    });
    inflight.add(p); p.finally(() => inflight.delete(p));
    if (inflight.size > 400) await Promise.race(inflight);
  }
  await Promise.all(inflight);
  M.endedAt = Date.now();
  M.burst = { requested: BURST, sent, targetRate: BURST_RATE, sendWindowMs: ms(tStart), stopped };
  // Per-second histogram of statuses so the onset of 429s is visible.
  const perSec = {};
  for (const e of M.events) { const s = Math.floor((e.t - (M.startedAt - T0)) / 1000); const o = (perSec[s] ??= { n: 0, s429: 0, other: 0 }); o.n++; if (e.status === 429) o.s429++; else if (e.status !== 200) o.other++; }
  M.burst.perSecond = perSec;
  const first429 = M.events.filter((e) => e.status === 429).sort((a, b) => a.t - b.t)[0];
  M.burst.first429AtRequestIndex = first429 ? M.events.filter((e) => e.t <= first429.t).length : null;
  return M;
}

// ---------------------------------------------------------------- sweep

async function listRepos(ns) {
  const names = [];
  for (let page = 1; page <= 20; page++) {
    const r = await rawApi(ns, 'GET', `/repos?limit=200&per_page=200&page=${page}`);
    recordReq('control', 'list(sweep)', r.status, r.ms);
    const got = (r.json?.result ?? []).map((x) => x.name);
    names.push(...got);
    const info = r.json?.result_info;
    if (!got.length || !info || (info.total_pages ?? 1) <= page || got.length < 200) break;
  }
  return [...new Set(names)];
}
async function sweep() {
  M = bucket('sweep');
  const out = { deleted: [], remaining: {} };
  for (const [name, ns] of created) { const d = await deleteRepo(ns, name); out.deleted.push({ name, status: d.status }); }
  for (const ns of [CANON_NS, TASKS_NS]) {
    for (const name of (await listRepos(ns)).filter((n) => n.startsWith('bench-'))) {
      const d = await deleteRepo(ns, name);
      out.deleted.push({ name, ns, status: d.status, sweep: true });
    }
  }
  await sleep(3000);
  for (const ns of [CANON_NS, TASKS_NS]) out.remaining[ns] = await listRepos(ns);
  M.endedAt = Date.now();
  out.bucket = summarize(M);
  return out;
}

// ---------------------------------------------------------------- main

async function main() {
  const results = { run: RUN, label: LABEL, namespaces: { canonical: CANON_NS, tasks: TASKS_NS }, mode: MODE, n: N, concurrencies: CONCURRENCIES, tokenTtlS: TOKEN_TTL, startedAt: new Date().toISOString(), git: null, scenarios: [] };
  results.git = (await git(undefined, ['--version'])).stdout;
  const root = await mkdtemp(join(tmpdir(), 'cf-s5-'));
  const outFile = join(HERE, `results-${LABEL}.json`);
  try {
    if (!SWEEP_ONLY) {
      const s = await setup(root);
      results.setup = { ...summarize(s.bucket), crossNamespaceFork: s.crossNamespaceFork, seedFiles: s.seedFiles };
      log('setup', results.setup.crossNamespaceFork, `wall ${results.setup.wallMs} ms`);
      for (const c of CONCURRENCIES) {
        log(`scenario: ${N} lifecycles at concurrency ${c} (${MODE})`);
        const b = await scenario(root, s.base, c);
        const sum = summarize(b);
        results.scenarios.push(sum);
        log(`  wall ${sum.wallMs} ms; ok ${sum.lifecycles.ok}/${sum.lifecycles.n}; control ${sum.requests.control} git ${sum.requests.git}; 429 ${JSON.stringify(sum.status429)}; 5xx ${JSON.stringify(sum.status5xx)}; peak10s ${JSON.stringify(sum.peak10s)}`);
        await writeFile(outFile, redact(JSON.stringify(results, null, 2)) + '\n');
        // Let the 10 s windows drain before the next scenario.
        await sleep(12_000);
      }
      if (BURST > 0) {
        log(`burst: ${BURST} GET /repos/<base> at ${BURST_RATE} req/s`);
        const b = await burst(s.base);
        results.burst = { ...summarize(b), ...b.burst };
        log(`  sent ${b.burst.sent} in ${b.burst.sendWindowMs} ms; 429 ${results.burst.status429.control}; peak10s ${results.burst.peak10s.control}; stopped ${b.burst.stopped}`);
      }
    }
  } catch (e) {
    results.fatal = redact(String(e?.stack ?? e));
    log('FATAL', results.fatal);
  } finally {
    results.sweep = await sweep();
    log('sweep: deleted', results.sweep.deleted.length, 'remaining', results.sweep.remaining);
    results.endedAt = new Date().toISOString();
    await writeFile(outFile, redact(JSON.stringify(results, null, 2)) + '\n');
    await rm(root, { recursive: true, force: true });
    log('wrote', outFile);
  }
}

await main();
