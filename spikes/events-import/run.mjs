#!/usr/bin/env node
// Task 4 (S4): live spike for assumption A6 (Artifacts `pushed` events via Queues) and Artifacts
// import timing.
//
// Usage (from the repo root, plain Node 22+, no deps; wrangler comes from apps/worker):
//   source scripts/load-dev-vars.sh
//   node spikes/events-import/run.mjs              # setup -> push -> import -> teardown
//   node spikes/events-import/run.mjs setup push    # individual phases (state kept in $TMPDIR)
//   node spikes/events-import/run.mjs teardown
//
// What it does:
//   setup     create Queue `commonforge-spike-events`, deploy the spike Worker (consumer + SQLite
//             DO recorder), set its admin secret, create the repo, subscribe the Queue to the
//             repo's `pushed` events and to account-level repo.created/forked/imported/deleted.
//   push      20 sequential pushes of one commit each, as fast as possible (busy -> retry), then
//             a 5-commit push and a 2-ref push; wait for deliveries; compute latency, duplicates,
//             ordering, missing events.
//   import    import small public GitHub repos; poll GET /repos/:name, log and ls-remote until
//             they stop returning 409; record timings and in-progress responses; also a bad URL.
//   teardown  delete repos, subscriptions, the Worker (and its DO), and the Queue.
//
// Secrets: the API token, repo tokens and the account id are redacted from everything recorded.
// Repo tokens reach git via GIT_CONFIG_* env vars (not argv).

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const WORKER_DIR = join(REPO_ROOT, 'apps', 'worker');
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
if (!ACCOUNT_ID || !API_TOKEN) {
  console.error('CF_ACCOUNT_ID / CF_API_TOKEN missing: source scripts/load-dev-vars.sh first');
  process.exit(2);
}
const NS = 'commonforge-spike';
const QUEUE = 'commonforge-spike-events';
const WORKER = 'commonforge-spike-events';
const ACCT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;
const BASE = `${ACCT}/artifacts/namespaces/${NS}`;
const STATE_FILE = join(process.env.SPIKE_STATE_DIR ?? tmpdir(), 'commonforge-spike-events-state.json');
const N_PUSHES = Number(process.env.SPIKE_PUSHES ?? 20);

const argv = process.argv.slice(2);
const phases = argv.length ? argv : ['setup', 'push', 'import', 'teardown'];

// ---------------------------------------------------------------- helpers

let ADMIN = null; // spike Worker admin bearer (random per setup; kept only in the state file)
function redact(s) {
  if (s == null) return s;
  let out = String(s)
    .replace(/art_v1_[0-9a-f]+(\?expires=\d+)?/g, 'art_v1_<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9_\-.?=]+/g, 'Bearer <redacted>');
  for (const [secret, label] of [[API_TOKEN, '<cf-api-token>'], [ACCOUNT_ID, '<ACCOUNT_ID>'], [ADMIN, '<admin>']]) {
    if (secret) out = out.split(secret).join(label);
  }
  return out;
}
const now = () => performance.now();
const ms = (t0) => Math.round(performance.now() - t0);
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const log = (...a) => console.log(redact(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return {}; }
}
async function saveState(s) { await writeFile(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 }); }

async function cf(method, url, body) {
  const t0 = now();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${API_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, ms: ms(t0), json, text };
}
const api = (method, path, body) => cf(method, BASE + path, body);

function run(cmd, args, { cwd, input, env = {} } = {}) {
  return new Promise((resolve) => {
    const t0 = now();
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    if (input != null) { p.stdin.write(input); }
    p.stdin.end();
    p.on('close', (code) => resolve({ code, ms: ms(t0), stdout: redact(out.trim()), stderr: redact(err.trim()) }));
  });
}
const wrangler = (args, opts = {}) =>
  run('pnpm', ['exec', 'wrangler', ...args], { cwd: WORKER_DIR, ...opts, env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_API_TOKEN: API_TOKEN, ...(opts.env ?? {}) } });

function git(cwd, args, { token, env = {} } = {}) {
  const genv = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', ...env };
  let n = 0;
  const cfg = [['credential.helper', ''], ['user.name', 'spike'], ['user.email', 'spike@commonforge.invalid'], ['init.defaultBranch', 'main']];
  if (token) cfg.push(['http.extraHeader', `Authorization: Bearer ${token}`]);
  for (const [k, v] of cfg) { genv[`GIT_CONFIG_KEY_${n}`] = k; genv[`GIT_CONFIG_VALUE_${n}`] = v; n++; }
  genv.GIT_CONFIG_COUNT = String(n);
  return run('git', args, { cwd, env: genv });
}
async function gitOk(cwd, args, opts) {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr}`);
  return r;
}
async function lsRemote(remote, token) {
  const r = await git(undefined, ['ls-remote', remote], { token });
  const refs = {};
  if (r.code === 0) for (const l of r.stdout.split('\n').filter(Boolean)) { const [sha, ref] = l.split('\t'); refs[ref] = sha; }
  return { code: r.code, ms: r.ms, refs, stderr: r.stderr.split('\n').slice(-3).join(' | ') };
}

// Push with retry on `artifacts_git_receive_pack_busy` (S2: one push at a time per repo). After any
// failure, re-read the remote ref: if it already equals what we pushed, the push landed.
async function pushWithRetry(dir, remote, token, refspecs, expect) {
  const t0 = now();
  const attempts = [];
  for (let i = 0; i < 8; i++) {
    const r = await git(dir, ['push', '--porcelain', remote, ...refspecs], { token, env: { GIT_TRACE_PACKET: '1' } });
    const doneAt = Date.now();
    const busy = /receive_pack_busy/.test(r.stderr);
    attempts.push({ code: r.code, ms: r.ms, busy });
    if (r.code === 0) return { ok: true, doneAt, ms: ms(t0), attempts };
    const ls = await lsRemote(remote, token);
    if (Object.entries(expect).every(([ref, sha]) => ls.refs[ref] === sha)) return { ok: true, doneAt, ms: ms(t0), attempts, landedDespiteError: true };
    if (!busy) return { ok: false, ms: ms(t0), attempts, stderr: r.stderr.split('\n').filter((l) => !/packet:/.test(l)).slice(-4).join(' | ') };
    await sleep(150 * 2 ** i + Math.random() * 100);
  }
  return { ok: false, ms: ms(t0), attempts };
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stats = (arr) => ({ n: arr.length, min: pct(arr, 0.0001), p50: pct(arr, 50), p95: pct(arr, 95), max: pct(arr, 100), mean: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null });

async function workerGet(state, path) {
  const res = await fetch(state.workerUrl + path, { headers: { Authorization: `Bearer ${ADMIN}` } });
  if (!res.ok) throw new Error(`worker ${path}: ${res.status}`);
  return res.json();
}

// Clock offset (worker clock - local clock), from the lowest-RTT of several /time probes.
async function clockOffset(state, n = 15) {
  let best = null;
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    const p0 = now();
    const r = await (await fetch(state.workerUrl + '/time')).json();
    const rtt = now() - p0;
    const off = r.now - (t0 + rtt / 2);
    if (!best || rtt < best.rtt) best = { rtt: Math.round(rtt), offsetMs: Math.round(off) };
  }
  return best;
}

// ---------------------------------------------------------------- phases

async function setup(state, results) {
  const R = (results.setup = {});
  const q = await wrangler(['queues', 'create', QUEUE]);
  R.queueCreate = { code: q.code, ms: q.ms, out: (q.stdout + q.stderr).split('\n').slice(-3).join(' | ') };
  const ql = await cf('GET', `${ACCT}/queues?per_page=100`);
  const queue = ql.json?.result?.find((x) => x.queue_name === QUEUE);
  if (!queue) throw new Error(`queue ${QUEUE} not found after create`);
  state.queueId = queue.queue_id;

  const d = await wrangler(['deploy', '-c', join(HERE, 'wrangler.jsonc')]);
  R.deploy = { code: d.code, ms: d.ms, tail: d.stdout.split('\n').filter((l) => /queue|Consumer|Uploaded|Deployed|workers\.dev|Durable/i.test(l)).join(' | ') };
  if (d.code !== 0) throw new Error(`deploy failed: ${d.stderr.slice(-800)}`);
  const sub = await cf('GET', `${ACCT}/workers/subdomain`);
  state.workerUrl = `https://${WORKER}.${sub.json.result.subdomain}.workers.dev`;
  ADMIN = state.admin = randomBytes(24).toString('hex');
  const s = await wrangler(['secret', 'put', 'SPIKE_ADMIN_TOKEN', '-c', join(HERE, 'wrangler.jsonc')], { input: ADMIN });
  R.secretPut = { code: s.code, ms: s.ms };
  await saveState(state);

  // Wait for the workers.dev route and the secret to be live.
  for (let i = 0; i < 60; i++) {
    const r = await fetch(state.workerUrl + '/events', { headers: { Authorization: `Bearer ${ADMIN}` } }).catch(() => null);
    if (r?.ok) break;
    await sleep(1000);
  }

  // Account-level subscription first, so repo.created for the push repo is observed.
  state.subscriptions = [];
  R.subscriptions = [];
  const subscribe = async (name, source, eventsVariants) => {
    for (const events of eventsVariants) {
      const r = await cf('POST', `${ACCT}/event_subscriptions/subscriptions`, {
        name, enabled: true, source, destination: { type: 'queues.queue', queue_id: state.queueId }, events,
      });
      R.subscriptions.push({ name, source, events, status: r.status, ms: r.ms, errors: r.json?.errors, result: r.json?.success ? { id: r.json.result.id, events: r.json.result.events, source: r.json.result.source } : undefined });
      if (r.json?.success) { state.subscriptions.push(r.json.result.id); await saveState(state); return r.json.result.id; }
    }
    throw new Error(`subscription ${name} failed: ${redact(JSON.stringify(R.subscriptions.at(-1)))}`);
  };
  const acctEvents = ['repo.created', 'repo.forked', 'repo.imported', 'repo.deleted'];
  await subscribe('spike-account', { type: 'artifacts' }, [acctEvents, acctEvents.map((e) => `cf.artifacts.${e}`)]);

  state.run = Date.now().toString(36);
  state.pushRepo = `ev-${state.run}`;
  const c = await api('POST', '/repos', { name: state.pushRepo, default_branch: 'main' });
  if (!c.json?.success) throw new Error(`create repo failed ${c.status} ${redact(c.text)}`);
  R.createRepo = { ms: c.ms };
  state.repos = [state.pushRepo];
  state.pushRemote = c.json.result.remote;
  state.pushToken = c.json.result.token;
  await saveState(state);

  const pushedSource = { type: 'artifacts.repo', namespace: NS, repo_name: state.pushRepo };
  await subscribe('spike-pushed', pushedSource, [['pushed'], ['repo.pushed'], ['cf.artifacts.repo.pushed']]);
  state.subscribedAt = Date.now();
  await saveState(state);
}

async function pushPhase(state, results) {
  const R = (results.push = {});
  ADMIN = state.admin;
  R.clockBefore = await clockOffset(state);
  // A subscription may take a moment to activate; give it a few seconds and send a probe push
  // that is excluded from the stats.
  const work = await mkdtemp(join(tmpdir(), 'cf-spike-ev-'));
  const dir = join(work, 'w');
  await mkdir(dir);
  await gitOk(dir, ['init', '-q', '-b', 'main']);
  const pushes = [];
  let before = '0000000000000000000000000000000000000000';
  const commit = async (i, label) => {
    await writeFile(join(dir, 'n.txt'), `${label} ${i} ${Date.now()}\n`);
    await gitOk(dir, ['add', '-A']);
    await gitOk(dir, ['commit', '-q', '-m', `${label} ${i}`]);
    return (await gitOk(dir, ['rev-parse', 'HEAD'])).stdout;
  };
  const doPush = async (label, refspecs, expect, meta) => {
    const startedAt = Date.now();
    const r = await pushWithRetry(dir, state.pushRemote, state.pushToken, refspecs, expect);
    const entry = { label, startedAt, ...meta, ok: r.ok, pushMs: r.ms, doneAt: r.doneAt, attempts: r.attempts.length, busyRetries: r.attempts.filter((a) => a.busy).length, landedDespiteError: r.landedDespiteError, stderr: r.stderr };
    pushes.push(entry);
    log(`${label}: ok=${r.ok} ${r.ms}ms attempts=${r.attempts.length}`);
    return entry;
  };

  // Probe push (first commit) to make sure the subscription delivers before the burst.
  let sha = await commit(0, 'probe');
  await doPush('probe', ['HEAD:refs/heads/main'], { 'refs/heads/main': sha }, { ref: 'refs/heads/main', before, after: sha });
  before = sha;
  const probeT0 = Date.now();
  let probeSeen = null;
  for (let i = 0; i < 120 && !probeSeen; i++) {
    const ev = await workerGet(state, '/events');
    probeSeen = ev.find((e) => e.type?.endsWith('pushed') && e.after === sha);
    if (!probeSeen) await sleep(500);
  }
  R.probe = { seen: !!probeSeen, waitedMs: Date.now() - probeT0 };

  // Burst: N sequential single-commit pushes, no delay between them.
  const burstT0 = Date.now();
  for (let i = 1; i <= N_PUSHES; i++) {
    sha = await commit(i, 'burst');
    await doPush(`burst-${i}`, ['HEAD:refs/heads/main'], { 'refs/heads/main': sha }, { ref: 'refs/heads/main', before, after: sha, seq: i });
    before = sha;
  }
  R.burstWallMs = Date.now() - burstT0;

  // Extra shapes: one push carrying 5 commits; one push updating two refs.
  for (let i = 1; i <= 5; i++) sha = await commit(i, 'multi');
  await doPush('multi-commit', ['HEAD:refs/heads/main'], { 'refs/heads/main': sha }, { ref: 'refs/heads/main', before, after: sha, commits: 5 });
  before = sha;
  sha = await commit(1, 'tworef');
  await doPush('two-refs', ['HEAD:refs/heads/main', 'HEAD:refs/commonforge/candidates/c1'], { 'refs/heads/main': sha, 'refs/commonforge/candidates/c1': sha }, { ref: 'refs/heads/main+refs/commonforge/candidates/c1', before, after: sha });
  before = sha;
  // Fork once (account-level repo.forked) and fetch nothing else.
  state.forkRepo = `${state.pushRepo}-fork`;
  const f = await api('POST', `/repos/${state.pushRepo}/fork`, { name: state.forkRepo });
  R.fork = { status: f.status, ms: f.ms, doneAt: Date.now() };
  if (f.json?.success) { state.repos.push(state.forkRepo); await saveState(state); }

  // Wait for deliveries: until every push is seen or 180 s of no new events.
  const lastPushAt = Date.now();
  let events = [];
  let lastCount = -1, lastChange = Date.now();
  while (Date.now() - lastChange < 60_000 && Date.now() - lastPushAt < 300_000) {
    events = await workerGet(state, '/events');
    if (events.length !== lastCount) { lastCount = events.length; lastChange = Date.now(); }
    const pushedAfters = new Set(events.filter((e) => e.type?.endsWith('pushed')).map((e) => e.after));
    const forkSeen = events.some((e) => e.type?.endsWith('forked'));
    if (pushes.every((p) => pushedAfters.has(p.after)) && forkSeen && Date.now() - lastChange > 15_000) break;
    await sleep(1000);
  }
  R.waitedForDeliveryMs = Date.now() - lastPushAt;
  R.clockAfter = await clockOffset(state);
  const offset = Math.round((R.clockBefore.offsetMs + R.clockAfter.offsetMs) / 2);
  R.offsetUsedMs = offset;
  await rm(work, { recursive: true, force: true });

  // ---- analysis
  const pushed = events.filter((e) => e.type?.endsWith('pushed'));
  const byKey = new Map();
  for (const e of pushed) {
    const k = `${e.ref}|${e.after}`;
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  const perPush = [];
  for (const p of pushes) {
    const refs = p.ref.split('+');
    for (const ref of refs) {
      const got = byKey.get(`${ref}|${p.after}`) ?? [];
      const first = got[0];
      const doneWorker = p.doneAt + offset; // push completion on the worker clock
      const expBefore = ref.startsWith('refs/commonforge/') ? '0'.repeat(40) : p.before; // new ref
      perPush.push({
        label: p.label, ref, before: p.before?.slice(0, 10), after: p.after.slice(0, 10), pushMs: p.pushMs, busyRetries: p.busyRetries,
        deliveries: got.length,
        attemptsSeen: got.map((e) => e.attempts),
        beforeMatches: first ? first.before === expBefore : null,
        latencyMs: first ? first.receivedAt - doneWorker : null,
        eventTsMinusPushDoneMs: first?.eventTimestamp ? Date.parse(first.eventTimestamp) - doneWorker : null,
        enqueuedMinusEventTsMs: first?.eventTimestamp ? first.enqueuedAt - Date.parse(first.eventTimestamp) : null,
        receivedMinusEnqueuedMs: first ? first.receivedAt - first.enqueuedAt : null,
        receivedMinusEventTsMs: first?.eventTimestamp ? first.receivedAt - Date.parse(first.eventTimestamp) : null,
        recvSeq: first?.seq ?? null,
        commitsInPayload: first ? (JSON.parse(first.body).payload?.commits?.length ?? null) : null,
        totalCommitsCount: first ? (JSON.parse(first.body).payload?.totalCommitsCount ?? null) : null,
      });
    }
  }
  const burst = perPush.filter((p) => p.label.startsWith('burst'));
  const lat = (rows, k) => rows.map((r) => r[k]).filter((x) => x != null);
  R.pushes = perPush;
  R.burst = {
    n: N_PUSHES,
    delivered: burst.filter((b) => b.deliveries > 0).length,
    missing: burst.filter((b) => b.deliveries === 0).map((b) => b.label),
    duplicates: burst.filter((b) => b.deliveries > 1).map((b) => ({ label: b.label, deliveries: b.deliveries })),
    latencyPushDoneToReceiveMs: stats(lat(burst, 'latencyMs')),
    eventTsMinusPushDoneMs: stats(lat(burst, 'eventTsMinusPushDoneMs')),
    enqueuedMinusEventTsMs: stats(lat(burst, 'enqueuedMinusEventTsMs')),
    receivedMinusEnqueuedMs: stats(lat(burst, 'receivedMinusEnqueuedMs')),
    receivedMinusEventTsMs: stats(lat(burst, 'receivedMinusEventTsMs')),
    pushMs: stats(lat(burst, 'pushMs')),
    within5s: burst.filter((b) => b.latencyMs != null && b.latencyMs <= 5000).length,
  };
  const recvOrder = burst.filter((b) => b.recvSeq != null).sort((a, b) => a.recvSeq - b.recvSeq).map((b) => Number(b.label.split('-')[1]));
  let inversions = 0;
  for (let i = 1; i < recvOrder.length; i++) if (recvOrder[i] < recvOrder[i - 1]) inversions++;
  R.burst.receiveOrder = recvOrder;
  R.burst.adjacentInversions = inversions;
  R.burst.beforeChainIntact = burst.every((b) => b.beforeMatches !== false);
  const ids = pushed.map((e) => e.msgId);
  R.duplicateMessageIds = ids.length - new Set(ids).size;
  R.unmatchedPushedEvents = pushed.filter((e) => !pushes.some((p) => p.after === e.after)).map((e) => ({ ref: e.ref, after: e.after?.slice(0, 10) }));
  R.otherEvents = events.filter((e) => !e.type?.endsWith('pushed')).map((e) => ({ type: e.type, source: e.sourceType, repo: e.repoName, attempts: e.attempts, eventTimestamp: e.eventTimestamp, receivedMinusEventTsMs: e.eventTimestamp ? e.receivedAt - Date.parse(e.eventTimestamp) : null, forkLatencyMs: e.type?.endsWith('forked') ? e.receivedAt - (R.fork.doneAt + offset) : undefined }));
  R.samplePushedEvent = pushed[0] ? JSON.parse(pushed[0].body) : null;
  results.push.eventCount = events.length;
  state.lastSeq = events.at(-1)?.seq ?? 0;
  await saveState(state);
  log('burst', R.burst);
}

async function importPhase(state, results) {
  const R = (results.import = {});
  ADMIN = state.admin;
  const offset = (await clockOffset(state)).offsetMs;
  const targets = [
    { key: 'hello-world', url: 'https://github.com/octocat/Hello-World', branch: 'master' },
    { key: 'hello-world-nobranch', url: 'https://github.com/octocat/Hello-World' },
    { key: 'spoon-knife', url: 'https://github.com/octocat/Spoon-Knife', branch: 'main' },
    { key: 'expressjs', url: 'https://github.com/expressjs/express', branch: 'master', duplicateAfterMs: 3000 },
    { key: 'lodash', url: 'https://github.com/lodash/lodash', branch: 'main' },
    { key: 'lodash-depth1', url: 'https://github.com/lodash/lodash', branch: 'main', depth: 1 },
    { key: 'lodash-depth100', url: 'https://github.com/lodash/lodash', branch: 'main', depth: 100 },
    { key: 'bad-url', url: 'https://github.com/octocat/this-repo-does-not-exist-cf-spike', branch: 'main' },
  ].filter((t) => !process.env.SPIKE_IMPORTS || process.env.SPIKE_IMPORTS.split(',').includes(t.key));
  state.repos ??= [];
  const tag = Date.now().toString(36);
  for (const t of targets) {
    const name = `im-${tag}-${t.key}`;
    state.repos.push(name);
    await saveState(state);
    const T = (R[t.key] = { url: t.url, branch: t.branch ?? null, depth: t.depth ?? null, name });
    const t0 = now();
    T.startedAt = Date.now();
    // Fire the import and, while it is in flight, probe the repo with GET, log and token mint.
    let importRes = null;
    const importP = api('POST', `/repos/${name}/import`, { url: t.url, ...(t.branch ? { branch: t.branch } : {}), ...(t.depth ? { depth: t.depth } : {}) }).then((r) => { importRes = r; importRes.returnedAtMs = ms(t0); return r; });
    let dupP = null;
    if (t.duplicateAfterMs) dupP = sleep(t.duplicateAfterMs).then(() => api('POST', `/repos/${name}/import`, { url: t.url, branch: t.branch })).then((r) => ({ atMs: t.duplicateAfterMs, status: r.status, ms: r.ms, errors: r.json?.errors, success: r.json?.success }));
    const transitions = [];
    const counts = {};
    const ready = {};
    const lastSig = {};
    let mintedTokenId = null;
    const logRef = t.branch ?? 'master';
    const probes = {
      get: async () => { const g = await api('GET', `/repos/${name}`); return { status: g.status, ok: g.json?.success === true, sig: `${g.status}:${JSON.stringify(g.json?.errors ?? '')}`, body: g.json?.success ? redact(JSON.stringify({ ...g.json.result, token: undefined })) : redact(g.text.slice(0, 400)) }; },
      log: async () => { const g = await api('GET', `/repos/${name}/log?ref=${logRef}&limit=1`); const ok = g.json?.success === true && Array.isArray(g.json.result) && g.json.result.length > 0; return { status: g.status, ok, sig: `${g.status}:${ok ? 'commits' : JSON.stringify(g.json?.errors ?? g.json?.result)}`, body: ok ? `head ${g.json.result[0].id ?? g.json.result[0].hash}` : redact(g.text.slice(0, 400)) }; },
      token: async () => { const g = await api('POST', '/tokens', { repo: name, scope: 'read', ttl: 60 }); if (g.json?.success) mintedTokenId = g.json.result.id; return { status: g.status, ok: g.json?.success === true, sig: `${g.status}:${JSON.stringify(g.json?.errors ?? '')}`, body: g.json?.success ? 'minted' : redact(g.text.slice(0, 400)) }; },
      lsRemote: async () => {
        if (!importRes?.json?.success) return { status: 'n/a', ok: false, sig: 'waiting-for-import-response', body: 'import call not returned yet' };
        const l = await lsRemote(importRes.json.result.remote, importRes.json.result.token);
        const ok = l.code === 0 && Object.keys(l.refs).length > 0;
        return { status: l.code, ok, sig: `${l.code}:${ok ? 'refs' : l.stderr}`, body: ok ? Object.keys(l.refs).join(',') : l.stderr };
      },
    };
    const runProbe = async (k) => {
      while (ready[k] == null && ms(t0) < 600_000) {
        if (importRes && !importRes.json?.success) return; // failed import: stop probing
        const p = await probes[k]();
        const at = ms(t0);
        counts[k] = counts[k] ?? {};
        counts[k][p.status] = (counts[k][p.status] ?? 0) + 1;
        if (lastSig[k] !== p.sig) { transitions.push({ probe: k, atMs: at, status: p.status, body: p.body }); lastSig[k] = p.sig; }
        if (p.ok) ready[k] = at; else await sleep(Number(process.env.SPIKE_PROBE_MS ?? 250));
      }
    };
    // SPIKE_NO_PROBE=1: do not probe while the import call is in flight (control run).
    if (process.env.SPIKE_NO_PROBE) await importP;
    await Promise.all([importP, ...Object.keys(probes).map(runProbe)]);
    const r = importRes;
    log(`import ${t.key}: ${r.status} returned at ${r.returnedAtMs}ms; ready ${JSON.stringify(ready)}`);
    T.importCall = { status: r.status, ms: r.ms, returnedAtMs: r.returnedAtMs, success: r.json?.success, errors: r.json?.errors, result: r.json?.result ? redact(JSON.stringify({ ...r.json.result, token: undefined })) : null };
    if (dupP) T.duplicateImport = await dupP;
    T.readyMs = ready;
    T.probeStatusCounts = counts;
    T.transitions = transitions.sort((a, b) => a.atMs - b.atMs);
    if (!r.json?.success) {
      const g = await api('GET', `/repos/${name}`);
      T.afterFailureGet = { status: g.status, body: redact(g.text.slice(0, 300)) };
      continue;
    }
    if (mintedTokenId) await api('DELETE', `/tokens/${mintedTokenId}`);
    const g = await api('GET', `/repos/${name}`);
    T.repoInfo = g.json?.result ? { default_branch: g.json.result.default_branch, source: g.json.result.source, created_at: g.json.result.created_at, updated_at: g.json.result.updated_at } : null;
    const ls = await lsRemote(r.json.result.remote, r.json.result.token);
    T.refs = Object.keys(ls.refs);
    const lg = await api('GET', `/repos/${name}/log?ref=${logRef}&limit=500`);
    T.commitsVisible = Array.isArray(lg.json?.result) ? lg.json.result.length : null;
    const lgMain = await api('GET', `/repos/${name}/log?ref=${g.json?.result?.default_branch}&limit=1`);
    T.logAtReportedDefaultBranch = { ref: g.json?.result?.default_branch, status: lgMain.status, count: Array.isArray(lgMain.json?.result) ? lgMain.json.result.length : null };
  }
  // Events for imports (account-level subscription).
  await sleep(30_000);
  const events = await workerGet(state, `/events?since=${state.lastSeq ?? 0}`);
  R.events = events.map((e) => {
    const b = JSON.parse(e.body);
    const tgt = Object.values(R).find((x) => x?.name === e.repoName);
    return { type: e.type, repo: e.repoName, attempts: e.attempts, eventTimestamp: e.eventTimestamp, payload: redact(JSON.stringify(b.payload ?? {})).slice(0, 400), eventTsMinusImportStartMs: tgt?.startedAt && e.eventTimestamp ? Date.parse(e.eventTimestamp) - (tgt.startedAt + offset) : null, receivedMinusEventTsMs: e.eventTimestamp ? e.receivedAt - Date.parse(e.eventTimestamp) : null };
  });
  state.lastSeq = events.at(-1)?.seq ?? state.lastSeq;
  await saveState(state);
}

async function teardown(state, results) {
  const R = (results.teardown = {});
  ADMIN = state.admin;
  R.repos = [];
  for (const name of [...new Set(state.repos ?? [])]) {
    const r = await api('DELETE', `/repos/${name}`);
    R.repos.push({ name, status: r.status });
  }
  // Sweep: any leftover spike repos from this script.
  const l = await api('GET', '/repos?limit=200');
  const left = (l.json?.result ?? []).map((x) => x.name).filter((n) => /^(ev|im)-/.test(n));
  for (const name of left) { const r = await api('DELETE', `/repos/${name}`); R.repos.push({ name, status: r.status, sweep: true }); }
  // Let repo.deleted events arrive before dropping the subscriptions.
  if (state.workerUrl && state.admin) {
    await sleep(15_000);
    try {
      const events = await workerGet(state, `/events?since=${state.lastSeq ?? 0}`);
      R.deleteEvents = events.map((e) => ({ type: e.type, repo: e.repoName, receivedMinusEventTsMs: e.eventTimestamp ? e.receivedAt - Date.parse(e.eventTimestamp) : null }));
    } catch (e) { R.deleteEvents = String(e); }
  }
  R.subscriptions = [];
  const subs = await cf('GET', `${ACCT}/event_subscriptions/subscriptions?per_page=100`);
  const ids = new Set(state.subscriptions ?? []);
  for (const s of subs.json?.result ?? []) if (state.queueId && s.destination?.queue_id === state.queueId) ids.add(s.id);
  for (const id of ids) { const r = await cf('DELETE', `${ACCT}/event_subscriptions/subscriptions/${id}`); R.subscriptions.push({ id: id.slice(0, 6) + '…', status: r.status }); }
  // Order matters: a Worker that is a Queue consumer cannot be deleted (code 10064).
  const c = await wrangler(['queues', 'consumer', 'remove', QUEUE, WORKER]);
  R.consumerRemove = { code: c.code, out: (c.stdout + c.stderr).split('\n').slice(-2).join(' | ') };
  const d = await wrangler(['delete', '-c', join(HERE, 'wrangler.jsonc'), '--force']);
  R.workerDelete = { code: d.code, out: (d.stdout + d.stderr).split('\n').slice(-2).join(' | ') };
  const q = await wrangler(['queues', 'delete', QUEUE]);
  R.queueDelete = { code: q.code, out: (q.stdout + q.stderr).split('\n').slice(-2).join(' | ') };
  // Verify.
  const l2 = await api('GET', '/repos?limit=200');
  R.remainingSpikeRepos = (l2.json?.result ?? []).map((x) => x.name).filter((n) => /^(ev|im)-/.test(n));
  const ql = await cf('GET', `${ACCT}/queues?per_page=100`);
  R.queueRemaining = !!ql.json?.result?.some((x) => x.queue_name === QUEUE);
  const sl = await cf('GET', `${ACCT}/event_subscriptions/subscriptions?per_page=100`);
  R.subscriptionsRemainingOnSpikeQueue = (sl.json?.result ?? []).filter((s) => ids.has(s.id)).length;
  const ws = await cf('GET', `${ACCT}/workers/scripts/${WORKER}`);
  R.workerScriptStatus = ws.status;
  await rm(STATE_FILE, { force: true });
}

async function main() {
  const state = await loadState();
  ADMIN = state.admin ?? null;
  const results = { startedAt: new Date().toISOString(), namespace: NS, queue: QUEUE, worker: WORKER, phases };
  const out = join(HERE, `results-${phases.join('-')}.json`);
  try {
    for (const p of phases) {
      if (p === 'teardown') continue;
      log(`== ${p}`);
      await ({ setup, push: pushPhase, import: importPhase }[p])(state, results);
    }
  } catch (err) {
    results.error = redact(err.stack ?? String(err));
    console.error(results.error);
  } finally {
    if (phases.includes('teardown')) {
      log('== teardown');
      try { await teardown(state, results); } catch (err) { results.teardownError = redact(err.stack ?? String(err)); }
    }
    results.finishedAt = new Date().toISOString();
    await writeFile(out, redact(JSON.stringify(results, null, 2)) + '\n');
    log(`wrote ${out}`);
  }
}
main();
