#!/usr/bin/env node
// Task 2 (S2): live Cloudflare Artifacts behavior spike for assumptions A1, A2, A4, A5.
//
// Usage (from the repo root, plain Node 22+, no deps):
//   source scripts/load-dev-vars.sh
//   node spikes/artifacts-behavior/run.mjs [a1] [a5] [a4] [a2] [--sizes=1,50,500]
//
// With no phase arguments every phase runs. Results (secrets redacted) are written to
// spikes/artifacts-behavior/results-<phases>.json (e.g. results-a1-a5.json). Every repo the run
// creates is deleted in a finally block, and a final sweep deletes any repo in the spike
// namespace whose name carries this run's id.
//
// Secrets: the Cloudflare API token and every Artifacts repo token are passed to git via
// GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n environment variables (equivalent to
// `git -c http.extraHeader="Authorization: Bearer $T"` but kept out of argv), and all
// recorded output passes through redact().

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
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
const NS = process.env.SPIKE_NAMESPACE ?? 'commonforge-spike';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/artifacts/namespaces/${NS}`;
const RUN = Date.now().toString(36);
const args = process.argv.slice(2);
const phases = args.filter((a) => !a.startsWith('--'));
const want = (p) => phases.length === 0 || phases.includes(p);
const sizesArg = args.find((a) => a.startsWith('--sizes='));
const SIZES_MB = sizesArg ? sizesArg.slice(8).split(',').map(Number) : [1, 50, 500];

// ---------------------------------------------------------------- helpers

function redact(s) {
  if (s == null) return s;
  let out = String(s)
    .replace(/art_v1_[0-9a-f]+(\?expires=\d+)?/g, 'art_v1_<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9_\-.?=]+/g, 'Bearer <redacted>');
  if (API_TOKEN) out = out.split(API_TOKEN).join('<cf-api-token>');
  if (ACCOUNT_ID) out = out.split(ACCOUNT_ID).join('<ACCOUNT_ID>');
  return out;
}
const now = () => performance.now();
const ms = (t0) => Math.round(performance.now() - t0);
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const log = (...a) => console.log(redact(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));

const results = { run: RUN, namespace: NS, startedAt: new Date().toISOString(), git: null, rateLimitHeaders: {}, phases: {} };
const created = new Set();

async function api(method, path, body, { raw = false } = {}) {
  const t0 = now();
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${API_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const elapsed = ms(t0);
  if (!results.sampleResponseHeaders) results.sampleResponseHeaders = Object.fromEntries([...res.headers].filter(([k]) => !/cookie/i.test(k)));
  for (const [k, v] of res.headers) {
    if (/ratelimit|retry-after|cf-ray/i.test(k) && !/cf-ray/i.test(k)) results.rateLimitHeaders[k] = v;
  }
  const text = await res.text();
  let json = null;
  if (!raw) {
    try { json = JSON.parse(text); } catch { /* raw body */ }
  }
  return { status: res.status, ms: elapsed, json, text: raw ? text : undefined, bodyRedacted: json ? null : redact(text.slice(0, 500)) };
}

async function createRepo(name, extra = {}) {
  for (let attempt = 1; ; attempt++) {
    const r = await api('POST', '/repos', { name, default_branch: 'main', ...extra });
    if (r.json?.success) { created.add(name); return { ...r.json.result, apiMs: r.ms, attempts: attempt }; }
    if (r.status >= 500 && attempt < 4) {
      // Observed live: transient 500 / code 10400 on create. Create is not idempotent, so
      // check whether the repo exists before retrying.
      (results.transientErrors ??= []).push({ op: `create ${name}`, attempt, status: r.status, errors: r.json?.errors });
      created.add(name);
      const g = await api('GET', `/repos/${name}`);
      if (g.json?.success) { const t = await mintToken(name, 'write', 86400); return { ...g.json.result, token: t.plaintext, apiMs: r.ms, attempts: attempt, recoveredExisting: true }; }
      await sleep(1000 * attempt);
      continue;
    }
    throw new Error(`create ${name} failed: ${r.status} ${redact(JSON.stringify(r.json ?? r.bodyRedacted))}`);
  }
}
async function deleteRepo(name) {
  const r = await api('DELETE', `/repos/${name}`);
  if (r.status < 300 || r.status === 404) created.delete(name);
  return { status: r.status, ms: r.ms, errors: r.json?.errors };
}
async function mintToken(repo, scope = 'write', ttl = 3600) {
  const r = await api('POST', '/tokens', { repo, scope, ttl });
  if (!r.json?.success) throw new Error(`token ${repo} failed: ${r.status} ${redact(JSON.stringify(r.json))}`);
  return { ...r.json.result, apiMs: r.ms };
}

function git(cwd, argv, { token, env = {}, onStderr, timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = now();
    const genv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true', ...env };
    let n = 0;
    const cfg = [['credential.helper', ''], ['user.name', 'spike'], ['user.email', 'spike@commonforge.invalid'], ['init.defaultBranch', 'main'], ['core.compression', '0'], ['pack.compression', '0']];
    if (token) cfg.push(['http.extraHeader', `Authorization: Bearer ${token}`]);
    for (const [k, v] of cfg) { genv[`GIT_CONFIG_KEY_${n}`] = k; genv[`GIT_CONFIG_VALUE_${n}`] = v; n++; }
    genv.GIT_CONFIG_COUNT = String(n);
    const p = spawn('git', argv, { cwd, env: genv });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => { err += d; onStderr?.(String(d), now() - t0); });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, ms: ms(t0), stdout: redact(out.trim()), stderr: redact(err.trim()), argv: argv.join(' ') });
    });
  });
}
async function gitOk(cwd, argv, opts) {
  const r = await git(cwd, argv, opts);
  if (r.code !== 0) throw new Error(`git ${r.argv} failed (${r.code}): ${r.stderr}`);
  return r;
}
const tail = (s, n = 8) => s.split('\n').filter((l) => !/^(Writing|Counting|Compressing|Delta|Enumerating|Total|remote: Counting|Receiving|Resolving|Updating files)/.test(l.replace(/^\r/, ''))).slice(-n).join('\n');
const shortRes = (r) => ({ code: r.code, ms: r.ms, stderr: tail(r.stderr) });

async function newWork(root, name) {
  const d = join(root, name);
  await mkdir(d, { recursive: true });
  await gitOk(d, ['init', '-q', '-b', 'main']);
  return d;
}
async function commitFile(dir, file, content, msg) {
  await writeFile(join(dir, file), content);
  await gitOk(dir, ['add', '-A']);
  await gitOk(dir, ['commit', '-q', '-m', msg]);
  return (await gitOk(dir, ['rev-parse', 'HEAD'])).stdout;
}
async function lsRemote(remote, token, extra = []) {
  const r = await git(undefined, ['ls-remote', ...extra, remote], { token });
  const refs = {};
  if (r.code === 0) for (const l of r.stdout.split('\n').filter(Boolean)) { const [sha, ref] = l.split('\t'); refs[ref] = sha; }
  return { code: r.code, ms: r.ms, refs, stderr: tail(r.stderr, 4) };
}
async function waitUsable(remote, token, timeoutMs = 600_000) {
  const t0 = now();
  let attempts = 0, last;
  while (now() - t0 < timeoutMs) {
    attempts++;
    last = await lsRemote(remote, token);
    if (last.code === 0) return { ms: ms(t0), attempts };
    await sleep(500);
  }
  return { ms: ms(t0), attempts, timedOut: true, last };
}

// ---------------------------------------------------------------- A1 + A5

async function phaseA1A5(root) {
  const R = { a1: {}, a5: {} };
  results.phases.a1 = R.a1; results.phases.a5 = R.a5;
  const canonName = `spike-canon-${RUN}`, forkName = `spike-fork-${RUN}`;

  const canon = await createRepo(canonName, { description: 'S2 spike canon' });
  R.a1.createRepo = { apiMs: canon.apiMs, remoteShape: redact(canon.remote), tokenExpiresInS: Number(canon.token.split('expires=')[1]) - Math.floor(Date.now() / 1000) };
  const w = await newWork(root, 'canon');
  const shas = [];
  for (let i = 1; i <= 3; i++) shas.push(await commitFile(w, 'f.txt', `commit ${i}\n`, `c${i}`));
  await gitOk(w, ['remote', 'add', 'origin', canon.remote]);
  R.a1.pushCanon3 = shortRes(await gitOk(w, ['push', 'origin', 'main'], { token: canon.token }));

  // Fork.
  let t0 = now();
  const fr = await api('POST', `/repos/${canonName}/fork`, { name: forkName, description: 'S2 spike fork' });
  if (!fr.json?.success) throw new Error(`fork failed ${fr.status} ${redact(JSON.stringify(fr.json))}`);
  created.add(forkName);
  const fork = fr.json.result;
  R.a1.fork = { apiMs: fr.ms, objects: fork.objects, usable: await waitUsable(fork.remote, fork.token), totalMs: ms(t0) };
  const fl = await lsRemote(fork.remote, fork.token);
  R.a1.fork.refsMatchParent = fl.refs['refs/heads/main'] === shas[2];

  // Fast-forward push to fork.
  const f1 = join(root, 'fork1');
  await gitOk(root, ['clone', '-q', fork.remote, f1], { token: fork.token });
  const ff = await commitFile(f1, 'f.txt', 'commit 4 on fork\n', 'c4-fork');
  R.a1.ffPush = shortRes(await git(f1, ['push', 'origin', 'main'], { token: fork.token }));

  // Non-fast-forward: diverge from c3 in a second clone that does not have c4.
  const f2 = join(root, 'fork2');
  await gitOk(root, ['clone', '-q', canon.remote, f2], { token: canon.token });
  await gitOk(f2, ['remote', 'set-url', 'origin', fork.remote]);
  const div = await commitFile(f2, 'g.txt', 'divergent\n', 'c4-divergent');
  const nff = await git(f2, ['push', 'origin', 'main'], { token: fork.token });
  R.a1.nonFastForwardPush = { ...shortRes(nff), stderrFull: nff.stderr, remoteMainAfter: (await lsRemote(fork.remote, fork.token)).refs['refs/heads/main'], expected: ff };

  // force-with-lease with a stale lease (expects c3, remote is c4-fork).
  const stale = await git(f2, ['push', `--force-with-lease=main:${shas[2]}`, 'origin', 'main'], { token: fork.token });
  R.a1.forceWithLeaseStale = { ...shortRes(stale), stderrFull: stale.stderr, remoteMainAfter: (await lsRemote(fork.remote, fork.token)).refs['refs/heads/main'] };
  // force-with-lease with a correct lease.
  const good = await git(f2, ['push', `--force-with-lease=main:${ff}`, 'origin', 'main'], { token: fork.token });
  R.a1.forceWithLeaseCorrect = { ...shortRes(good), remoteMainAfter: (await lsRemote(fork.remote, fork.token)).refs['refs/heads/main'], expected: div };
  // Plain --force back to c4-fork from f1.
  const force = await git(f1, ['push', '--force', 'origin', 'main'], { token: fork.token });
  R.a1.forcePush = { ...shortRes(force), remoteMainAfter: (await lsRemote(fork.remote, fork.token)).refs['refs/heads/main'], expected: ff };

  // Server-side CAS race: the client lease check is client-side only (it compares against
  // the advertised ref). The real question is whether receive-pack's update is a CAS on
  // old-sha. Race N clients that all saw main=X and push different fast-forward children.
  const race = [];
  for (let round = 0; round < 3; round++) {
    const head = (await lsRemote(fork.remote, fork.token)).refs['refs/heads/main'];
    const dirs = [];
    for (let i = 0; i < 6; i++) {
      const d = join(root, `race-${round}-${i}`);
      await gitOk(root, ['clone', '-q', fork.remote, d], { token: fork.token });
      await commitFile(d, `race-${i}.txt`, `${round}-${i}-${randomBytes(4).toString('hex')}\n`, `race ${round}/${i}`);
      dirs.push(d);
    }
    const rs = await Promise.all(dirs.map((d) => git(d, ['push', 'origin', 'main'], { token: fork.token })));
    const final = (await lsRemote(fork.remote, fork.token)).refs['refs/heads/main'];
    const shasPushed = await Promise.all(dirs.map(async (d) => (await gitOk(d, ['rev-parse', 'HEAD'])).stdout));
    race.push({ base: head, successes: rs.filter((r) => r.code === 0).length, failures: rs.filter((r) => r.code !== 0).length, finalIsAWinner: rs.some((r, i) => r.code === 0 && shasPushed[i] === final), winners: rs.map((r) => r.code === 0), failureSamples: [...new Set(rs.filter((r) => r.code !== 0).map((r) => tail(r.stderr, 3)))].slice(0, 3), ms: rs.map((r) => r.ms) });
  }
  R.a1.concurrentFastForwardRace = race;
  // Concurrent pushes to DISTINCT refs of the same repo (many agents, one repo).
  {
    const dirs = [];
    for (let i = 0; i < 6; i++) {
      const d = join(root, `distinct-${i}`);
      await gitOk(root, ['clone', '-q', fork.remote, d], { token: fork.token });
      await commitFile(d, `agent-${i}.txt`, `${i}\n`, `agent ${i}`);
      dirs.push(d);
    }
    const rs = await Promise.all(dirs.map((d, i) => git(d, ['push', 'origin', `HEAD:refs/heads/agent-${i}`], { token: fork.token, env: { GIT_TRACE_PACKET: '1' } })));
    const refs = (await lsRemote(fork.remote, fork.token)).refs;
    R.a1.concurrentDistinctRefs = { successes: rs.filter((r) => r.code === 0).length, refsPresent: [0, 1, 2, 3, 4, 5].filter((i) => refs[`refs/heads/agent-${i}`]).length, failures: rs.filter((r) => r.code !== 0).map((r) => ({ serverFatal: [...r.stderr.matchAll(/sideband< \\3(\S+)/g)].map((m) => m[1]), tail: tail(r.stderr.split('\n').filter((l) => !/packet:/.test(l)).join('\n'), 3) })) };
  }
  // Same distinct-ref fan-out, but each pusher retries on artifacts_git_receive_pack_busy.
  {
    const dirs = [];
    for (let i = 0; i < 6; i++) {
      const d = join(root, `retry-${i}`);
      await gitOk(root, ['clone', '-q', fork.remote, d], { token: fork.token });
      await commitFile(d, `retry-${i}.txt`, `${i}\n`, `retry agent ${i}`);
      dirs.push(d);
    }
    const t0 = now();
    const rs = await Promise.all(dirs.map(async (d, i) => {
      for (let attempt = 1; attempt <= 12; attempt++) {
        const r = await git(d, ['push', 'origin', `HEAD:refs/heads/retry-${i}`], { token: fork.token, env: { GIT_TRACE_PACKET: '1' } });
        if (r.code === 0) return { attempts: attempt, ok: true, doneAtMs: ms(t0) };
        if (!/receive_pack_busy/.test(r.stderr)) return { attempts: attempt, ok: false, err: tail(r.stderr.split('\n').filter((l) => !/packet:/.test(l)).join('\n'), 2) };
        await sleep(Math.min(4000, 150 * 2 ** attempt) * (0.5 + Math.random()));
      }
      return { attempts: 12, ok: false };
    }));
    R.a1.concurrentDistinctRefsWithBusyRetry = { totalMs: ms(t0), results: rs };
  }
  // Re-run one same-ref race with curl tracing to see what "remote end hung up" is.
  {
    const dirs = [];
    for (let i = 0; i < 6; i++) {
      const d = join(root, `trace-race-${i}`);
      await gitOk(root, ['clone', '-q', fork.remote, d], { token: fork.token });
      await commitFile(d, `tr-${i}.txt`, `${i}\n`, `trace race ${i}`);
      dirs.push(d);
    }
    const rs = await Promise.all(dirs.map((d) => git(d, ['push', 'origin', 'main'], { token: fork.token, env: { GIT_TRACE_PACKET: '1' } })));
    R.a1.sameRefRaceServerErrors = rs.map((r) => ({ code: r.code, serverFatal: [...r.stderr.matchAll(/sideband< \\3(\S+)/g)].map((m) => m[1]), result: tail(r.stderr.split('\n').filter((l) => !/packet:/.test(l)).join('\n'), 2) }));
  }

  // Racing --force-with-lease pushes with the SAME correct lease and divergent (non-ff)
  // commits: the lease check is client-side against the advertisement, so this tests whether
  // the server's ref update is a compare-and-swap on the old sha sent in the command.
  {
    const lease = (await lsRemote(fork.remote, fork.token)).refs['refs/heads/main'];
    const dirs = [];
    for (let i = 0; i < 5; i++) {
      const d = join(root, `lease-${i}`);
      await gitOk(root, ['clone', '-q', fork.remote, d], { token: fork.token });
      await gitOk(d, ['reset', '-q', '--hard', 'HEAD~1']);
      await commitFile(d, `lease-${i}.txt`, `${i}\n`, `lease rewrite ${i}`);
      dirs.push(d);
    }
    const rs = await Promise.all(dirs.map(async (d) => {
      const out = [];
      for (let attempt = 1; attempt <= 12; attempt++) {
        const r = await git(d, ['push', `--force-with-lease=main:${lease}`, 'origin', 'main'], { token: fork.token, env: { GIT_TRACE_PACKET: '1' } });
        const clean = r.stderr.split('\n').filter((l) => !/packet:/.test(l)).join('\n');
        out.push(r.code === 0 ? 'ok' : /receive_pack_busy/.test(r.stderr) ? 'busy' : /stale ref/.test(clean) ? 'remote-rejected-stale-ref' : /stale info/.test(clean) ? 'client-stale-info' : tail(clean, 1));
        if (r.code === 0 || !/receive_pack_busy/.test(r.stderr)) break;
        await sleep(Math.min(4000, 150 * 2 ** attempt) * (0.5 + Math.random()));
      }
      return { outcome: out, head: (await gitOk(d, ['rev-parse', 'HEAD'])).stdout };
    }));
    const final = (await lsRemote(fork.remote, fork.token)).refs['refs/heads/main'];
    const winners = rs.filter((r) => r.outcome.at(-1) === 'ok');
    R.a1.forceWithLeaseRace = { lease, winners: winners.length, finalIsWinner: winners.some((w) => w.head === final), outcomes: rs.map((r) => r.outcome.join('>')) };
  }

  // Atomic push: one good ff ref + one non-ff ref.
  const fa = join(root, 'atomic');
  await gitOk(root, ['clone', '-q', fork.remote, fa], { token: fork.token });
  await gitOk(fa, ['branch', 'side', 'HEAD~1']);
  await gitOk(fa, ['push', '-q', 'origin', 'side'], { token: fork.token });
  await gitOk(fa, ['checkout', '-q', 'side']);
  await commitFile(fa, 'side.txt', 'side\n', 'side ff');
  await gitOk(fa, ['checkout', '-q', 'main']);
  await gitOk(fa, ['reset', '-q', '--hard', 'HEAD~1']);
  await commitFile(fa, 'nonff.txt', 'x\n', 'main non-ff');
  const before = await lsRemote(fork.remote, fork.token);
  const atomic = await git(fa, ['push', '--atomic', 'origin', 'main', 'side'], { token: fork.token });
  const after = await lsRemote(fork.remote, fork.token);
  R.a1.atomicPush = { ...shortRes(atomic), stderrFull: atomic.stderr, sideUpdated: before.refs['refs/heads/side'] !== after.refs['refs/heads/side'], mainUpdated: before.refs['refs/heads/main'] !== after.refs['refs/heads/main'] };
  const nonAtomic = await git(fa, ['push', 'origin', 'main', 'side'], { token: fork.token });
  const after2 = await lsRemote(fork.remote, fork.token);
  R.a1.nonAtomicMixedPush = { ...shortRes(nonAtomic), sideUpdated: after.refs['refs/heads/side'] !== after2.refs['refs/heads/side'], mainUpdated: after.refs['refs/heads/main'] !== after2.refs['refs/heads/main'] };
  // Ref deletion via push.
  const del = await git(fa, ['push', 'origin', ':refs/heads/side'], { token: fork.token });
  R.a1.deleteRefPush = { ...shortRes(del), sideGone: !('refs/heads/side' in (await lsRemote(fork.remote, fork.token)).refs) };
  // Read token cannot push.
  const rt = await mintToken(forkName, 'read', 300);
  const rpush = await git(f1, ['push', 'origin', 'HEAD:refs/heads/readtoken-test'], { token: rt.plaintext });
  R.a1.readTokenPush = shortRes(rpush);
  // Parent unaffected by fork pushes.
  R.a1.parentMainUnchanged = (await lsRemote(canon.remote, canon.token)).refs['refs/heads/main'] === shas[2];

  // ------------------------------------------------ A5: custom refs + notes
  const a5 = R.a5;
  const cp = await git(f1, ['push', 'origin', 'HEAD:refs/commonforge/checkpoints/1'], { token: fork.token });
  a5.pushCustomRef = shortRes(cp);
  await gitOk(f1, ['notes', 'add', '-m', '{"run":"s2","validation":"pass"}', 'HEAD']);
  const np = await git(f1, ['push', 'origin', 'refs/notes/commits'], { token: fork.token });
  a5.pushNotesRef = shortRes(np);
  const tagp = await git(f1, ['tag', '-a', 'v-spike', '-m', 'annotated'], {});
  a5.pushAnnotatedTag = tagp.code === 0 ? shortRes(await git(f1, ['push', 'origin', 'v-spike'], { token: fork.token })) : shortRes(tagp);
  const headSha = (await gitOk(f1, ['rev-parse', 'HEAD'])).stdout;
  const notesSha = (await gitOk(f1, ['rev-parse', 'refs/notes/commits'])).stdout;
  a5.expected = { checkpoint: headSha, notes: notesSha };
  const lsV2 = await git(undefined, ['-c', 'protocol.version=2', 'ls-remote', fork.remote], { token: fork.token, env: { GIT_TRACE_PACKET: '0' } });
  const lsV1 = await git(undefined, ['-c', 'protocol.version=0', 'ls-remote', fork.remote], { token: fork.token });
  a5.lsRemoteV2 = { code: lsV2.code, stdout: lsV2.stdout.split('\n') };
  a5.lsRemoteV1 = { code: lsV1.code, stdout: lsV1.stdout.split('\n') };
  // Confirm v2 was actually negotiated.
  const trace = await git(undefined, ['-c', 'protocol.version=2', 'ls-remote', fork.remote, 'refs/commonforge/*'], { token: fork.token, env: { GIT_TRACE_PACKET: '1' } });
  a5.protocolV2Negotiated = /version 2/.test(trace.stderr);
  a5.lsRemoteV2RefPrefix = trace.stdout;
  const label = (ref) => (ref === headSha ? '<checkpoint sha>' : ref === notesSha ? '<notes commit sha>' : ref);
  for (const ref of ['main', 'refs/heads/main', 'heads/main', 'refs/commonforge/checkpoints/1', 'commonforge/checkpoints/1', 'refs/notes/commits', 'notes/commits', headSha, notesSha, 'v-spike', 'refs/tags/v-spike', 'does-not-exist']) {
    const r = await api('GET', `/repos/${forkName}/log?ref=${encodeURIComponent(ref)}&limit=3`);
    a5[`restLog:${label(ref)}`] = { status: r.status, ms: r.ms, firstIds: Array.isArray(r.json?.result) ? r.json.result.map((c) => c.id ?? c.sha ?? c.hash ?? Object.keys(c)) : null, sample: r.json?.success ? redact(JSON.stringify(r.json.result?.[0] ?? r.json.result)).slice(0, 600) : redact(JSON.stringify(r.json?.errors ?? r.bodyRedacted)) };
  }
  // Notes tree is keyed by commit sha: read it via REST file + raw.
  for (const [ref, path] of [['refs/notes/commits', headSha], [notesSha, headSha], ['refs/commonforge/checkpoints/1', 'f.txt'], [headSha, 'f.txt'], ['main', 'f.txt'], ['refs/heads/main', 'f.txt']]) {
    const r = await api('GET', `/repos/${forkName}/file?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`, null, { raw: true });
    a5[`restFile:${label(ref)}:${path === headSha ? '<checkpoint sha>' : path}`] = { status: r.status, body: redact(r.text?.slice(0, 160)) };
  }
  const rc = await api('GET', `/repos/${forkName}/commit/${headSha}`);
  a5.restCommit = { status: rc.status, keys: rc.json?.result ? Object.keys(rc.json.result) : null };
  const gr = await api('GET', `/repos/${forkName}`);
  a5.restGetRepo = { status: gr.status, keys: gr.json?.result ? Object.keys(gr.json.result) : null, refsListed: /refs\//.test(JSON.stringify(gr.json?.result ?? {})) };
  // Fresh clone fetches custom refs + notes explicitly.
  const f3 = join(root, 'fetchrefs');
  await gitOk(root, ['clone', '-q', fork.remote, f3], { token: fork.token });
  const fe = await git(f3, ['fetch', 'origin', 'refs/commonforge/*:refs/commonforge/*', 'refs/notes/*:refs/notes/*'], { token: fork.token });
  a5.fetchCustomRefs = shortRes(fe);
  a5.notesShowInClone = (await git(f3, ['notes', 'show', headSha])).stdout;
  a5.checkpointInClone = (await git(f3, ['rev-parse', 'refs/commonforge/checkpoints/1'])).stdout === headSha;
  // Overwrite checkpoint ref non-ff (custom refs follow the same ff rule?).
  const cpn = await git(f2, ['push', 'origin', `${shas[0]}:refs/commonforge/checkpoints/1`], { token: fork.token });
  a5.customRefNonFastForward = shortRes(cpn);
  // Tokens list.
  const tl = await api('GET', `/repos/${forkName}/tokens?state=all&per_page=100`);
  a5.tokensList = { status: tl.status, count: tl.json?.result?.length, states: tl.json?.result?.map((t) => `${t.scope}/${t.state}`), resultInfo: tl.json?.result_info };

  return { canonName, forkName, fork };
}

// ---------------------------------------------------------------- A4

async function writeRandomFiles(dir, totalMB, prefix, maxFileMB = 20) {
  let left = totalMB, i = 0;
  while (left > 0) {
    const mb = Math.min(maxFileMB, left);
    await writeFile(join(dir, `${prefix}-${i++}.bin`), randomBytes(Math.round(mb * 1024 * 1024)));
    left -= mb;
  }
  return i;
}

async function phaseA4(root) {
  const R = {};
  results.phases.a4 = R;
  const name = `spike-revoke-${RUN}`;
  const repo = await createRepo(name, { description: 'S2 revoke' });
  const w = await newWork(root, 'revoke');
  await commitFile(w, 'README', 'seed\n', 'seed');
  await gitOk(w, ['remote', 'add', 'origin', repo.remote]);
  await gitOk(w, ['push', '-q', 'origin', 'main'], { token: repo.token });

  // Attempt 1: revoke while the pack is uploading.
  const attempts = [];
  for (const mb of [100, 200]) {
    await writeRandomFiles(w, mb, `big${mb}`);
    await gitOk(w, ['add', '-A']);
    await gitOk(w, ['commit', '-q', '-m', `big ${mb}MB`]);
    const sha = (await gitOk(w, ['rev-parse', 'HEAD'])).stdout;
    const tok = await mintToken(name, 'write', 60);
    const a = { sizeMB: mb, tokenTtl: 60, tokenExpiresAt: tok.expires_at };
    let revokeAt = null, revokeRes = null, revokeDone;
    const revokeP = new Promise((r) => (revokeDone = r));
    const t0 = now();
    const pushP = git(w, ['push', '--progress', 'origin', 'main'], {
      token: tok.plaintext,
      onStderr: (chunk, t) => {
        const m = [...chunk.matchAll(/Writing objects:\s+(\d+)%/g)].pop();
        if (revokeAt == null && m && Number(m[1]) >= 1) {
          revokeAt = t;
          a.progressAtRevoke = chunk.trim().split(/\r|\n/).pop();
          api('DELETE', `/tokens/${tok.id}`).then((r) => { revokeRes = { status: r.status, ms: r.ms, revokeCompletedAtPushMs: Math.round(now() - t0) }; revokeDone(); });
        }
      },
    });
    const push = await pushP;
    if (revokeAt == null) { await api('DELETE', `/tokens/${tok.id}`).then((r) => { revokeRes = { status: r.status, ms: r.ms, note: 'revoked after push finished (no progress line seen)' }; revokeDone(); }); }
    await revokeP;
    const tRevoked = now();
    a.revokeIssuedAtPushMs = revokeAt && Math.round(revokeAt);
    a.revoke = revokeRes;
    a.push = { code: push.code, ms: push.ms, stderr: tail(push.stderr, 6) };
    const check = await mintToken(name, 'read', 120);
    const remoteMain = (await lsRemote(repo.remote, check.plaintext)).refs['refs/heads/main'];
    a.remoteMainIsPushedCommit = remoteMain === sha;
    // Revoked token: how quickly do new git ops fail?
    const probes = [];
    let firstFailMs = null;
    for (let i = 0; i < 40; i++) {
      const p = await lsRemote(repo.remote, tok.plaintext);
      probes.push({ atMsAfterRevoke: ms(tRevoked), code: p.code });
      if (p.code !== 0) { firstFailMs ??= ms(tRevoked); a.revokedLsRemoteError = p.stderr; break; }
      await sleep(500);
    }
    a.revokedTokenFirstFailureMsAfterRevoke = firstFailMs;
    a.revokedProbeCount = probes.length;
    const pushRevoked = await git(w, ['push', 'origin', 'HEAD:refs/heads/after-revoke'], { token: tok.plaintext });
    a.pushWithRevokedToken = shortRes(pushRevoked);
    const cloneRevoked = await git(root, ['clone', '-q', repo.remote, join(root, `revoked-clone-${mb}`)], { token: tok.plaintext });
    a.cloneWithRevokedToken = shortRes(cloneRevoked);
    if (a.remoteMainIsPushedCommit === false) {
      // reset local state to remote for the next attempt
      await gitOk(w, ['reset', '-q', '--hard', remoteMain ?? 'HEAD~1']).catch(() => {});
    }
    attempts.push(a);
  }
  R.inFlightRevoke = attempts;
  R.inFlightRevoke_note = 'revokedTokenFirstFailureMsAfterRevoke is measured from when the push process exited, not from the revoke call; see revocationLatency for the tight measurement';

  // Control: same-sized push with a TTL-60 token and no revoke must succeed.
  {
    await writeRandomFiles(w, 100, 'control');
    await gitOk(w, ['add', '-A']);
    await gitOk(w, ['commit', '-q', '-m', 'control 100MB']);
    const tok = await mintToken(name, 'write', 60);
    const p = await git(w, ['push', 'origin', 'main'], { token: tok.plaintext });
    R.control100MBNoRevoke = { code: p.code, ms: p.ms, stderr: p.code ? tail(p.stderr, 4) : undefined };
    await api('DELETE', `/tokens/${tok.id}`);
  }
  // Expiry mid-push: TTL-60 token, start a ~100 MB push ~8 s before it expires.
  {
    await writeRandomFiles(w, 100, 'expiry');
    await gitOk(w, ['add', '-A']);
    await gitOk(w, ['commit', '-q', '-m', 'expiry 100MB']);
    const sha = (await gitOk(w, ['rev-parse', 'HEAD'])).stdout;
    const tok = await mintToken(name, 'write', 60);
    const exp = Date.parse(tok.expires_at);
    await sleep(Math.max(0, exp - Date.now() - 8000));
    const startedBeforeExpiryMs = exp - Date.now();
    const p = await git(w, ['push', 'origin', 'main'], { token: tok.plaintext });
    const check = await mintToken(name, 'read', 120);
    R.expiryMidPush = { startedBeforeExpiryMs, endedAfterExpiryMs: Date.now() - exp, code: p.code, ms: p.ms, stderr: tail(p.stderr, 4), refUpdated: (await lsRemote(repo.remote, check.plaintext)).refs['refs/heads/main'] === sha };
  }
  // Revocation latency for new requests: revoke, then probe back-to-back.
  R.revocationLatency = [];
  for (let i = 0; i < 3; i++) {
    const tok = await mintToken(name, 'read', 600);
    const ok = await lsRemote(repo.remote, tok.plaintext);
    const t0 = now();
    const rv = await api('DELETE', `/tokens/${tok.id}`);
    const tRet = now();
    const probes = [];
    let first = null;
    while (now() - tRet < 30_000) {
      const p = await lsRemote(repo.remote, tok.plaintext);
      probes.push(p.code);
      if (p.code !== 0) { first = { msAfterRevokeIssued: ms(t0), msAfterRevokeReturned: ms(tRet) }; break; }
    }
    R.revocationLatency.push({ preRevokeLsRemote: ok.code, revokeApiMs: rv.ms, probesUntilFailure: probes.length, successfulProbesAfterRevoke: probes.filter((c) => c === 0).length, ...first });
  }

  // TTL-60 expiry without revoke: how long after expires_at does the token stop working?
  const exp = await mintToken(name, 'read', 60);
  const expiresAt = Date.parse(exp.expires_at);
  R.ttl60 = { expiresAt: exp.expires_at, firstUse: (await lsRemote(repo.remote, exp.plaintext)).code };
  let failAt = null;
  while (Date.now() < expiresAt + 90_000) {
    const p = await lsRemote(repo.remote, exp.plaintext);
    if (p.code !== 0) { failAt = Date.now(); R.ttl60.error = p.stderr; break; }
    await sleep(2000);
  }
  R.ttl60.failedMsRelativeToExpiresAt = failAt && failAt - expiresAt;
  const tl = await api('GET', `/repos/${name}/tokens?state=all&per_page=100`);
  R.tokensListAfter = tl.json?.result?.map((t) => `${t.scope}/${t.state}`);
  const bad = await api('POST', '/tokens', { repo: name, scope: 'write', ttl: 59 });
  R.ttl59Rejected = { status: bad.status, errors: bad.json?.errors };
  // Revoking an already-revoked token, and an unknown id.
  const again = await api('DELETE', `/tokens/${tl.json?.result?.find((t) => t.state === 'revoked')?.id ?? 'x'}`);
  R.revokeTwice = { status: again.status, errors: again.json?.errors };
  return name;
}

// ---------------------------------------------------------------- A2

async function phaseA2(root) {
  const R = [];
  results.phases.a2 = R;
  for (const mb of SIZES_MB) {
    const e = { sizeMB: mb };
    R.push(e);
    const parent = `spike-seed${mb}-${RUN}`;
    const repo = await createRepo(parent, { description: `S2 seed ${mb}MB` });
    const w = await newWork(root, `seed${mb}`);
    await gitOk(w, ['remote', 'add', 'origin', repo.remote]);
    // Push in <=100 MB commits so no single pack is huge.
    let left = mb, chunk = 0, pushMs = 0;
    e.pushes = [];
    while (left > 0) {
      const c = Math.min(100, left);
      await writeRandomFiles(w, c, `c${chunk}`, mb < 20 ? mb : 20);
      await gitOk(w, ['add', '-A']);
      await gitOk(w, ['commit', '-q', '-m', `seed chunk ${chunk} (${c} MB)`]);
      const p = await git(w, ['push', 'origin', 'main'], { token: repo.token });
      e.pushes.push({ mb: c, code: p.code, ms: p.ms, stderr: p.code ? tail(p.stderr, 4) : undefined });
      if (p.code !== 0) throw new Error(`seed push ${mb}MB chunk ${chunk} failed: ${p.stderr}`);
      pushMs += p.ms; left -= c; chunk++;
    }
    e.seedPushMs = pushMs;
    e.seedUploadMBps = +(mb / (pushMs / 1000)).toFixed(2);
    const head = (await gitOk(w, ['rev-parse', 'HEAD'])).stdout;
    const localObjects = Number((await gitOk(w, ['rev-list', '--objects', '--all'])).stdout.split('\n').length);
    e.localObjects = localObjects;
    e.forks = [];
    let firstFork;
    for (const k of ['a', 'b']) {
      const fname = `spike-seed${mb}-fork${k}-${RUN}`;
      const t0 = now();
      const fr = await api('POST', `/repos/${parent}/fork`, { name: fname });
      if (!fr.json?.success) { e.forks.push({ name: fname, status: fr.status, errors: fr.json?.errors }); continue; }
      created.add(fname);
      const usable = await waitUsable(fr.json.result.remote, fr.json.result.token);
      const f = { apiMs: fr.ms, objects: fr.json.result.objects, usableAfterMs: usable.ms, usableAttempts: usable.attempts, totalMs: ms(t0) };
      const gi = await api('GET', `/repos/${fname}`);
      f.getRepoStatusRight = gi.status;
      e.forks.push(f);
      firstFork ??= { name: fname, ...fr.json.result };
    }
    // Delete parent, then clone the fork and fsck.
    const d = await deleteRepo(parent);
    e.deleteParent = d;
    const gone = await api('GET', `/repos/${parent}`);
    e.parentGetAfterDelete = gone.status;
    await sleep(3000);
    const cdir = join(root, `fork-clone-${mb}`);
    const tok = await mintToken(firstFork.name, 'read', 3600);
    const cl = await git(root, ['clone', '-q', '--mirror', firstFork.remote, cdir], { token: tok.plaintext });
    e.cloneForkAfterParentDelete = { code: cl.code, ms: cl.ms, stderr: cl.code ? tail(cl.stderr) : undefined };
    if (cl.code === 0) {
      const fsck = await git(cdir, ['fsck', '--full', '--strict']);
      e.fsck = { code: fsck.code, ms: fsck.ms, stderr: tail(fsck.stderr, 4), stdout: fsck.stdout.slice(0, 300) };
      e.forkHeadMatches = (await gitOk(cdir, ['rev-parse', 'refs/heads/main'])).stdout === head;
      e.forkObjects = Number((await gitOk(cdir, ['rev-list', '--objects', '--all'])).stdout.split('\n').length);
      e.allObjectsPresent = e.forkObjects === localObjects;
      const blob = await api('GET', `/repos/${firstFork.name}/file?ref=main&path=c0-0.bin`, null, { raw: true });
      e.restReadBlobAfterParentDelete = blob.status;
    }
    await rm(w, { recursive: true, force: true });
    await rm(cdir, { recursive: true, force: true });
    for (const f of [...created].filter((n) => n.startsWith(`spike-seed${mb}-`))) await deleteRepo(f);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'cf-s2-'));
  results.git = (await git(undefined, ['--version'])).stdout;
  log(`run=${RUN} ns=${NS} work=${root} phases=${phases.join(',') || 'all'}`);
  try {
    if (want('a1') || want('a5')) { log('== A1/A5'); await phaseA1A5(root); log('A1/A5 done'); }
    if (want('a4')) { log('== A4'); await phaseA4(root); log('A4 done'); }
    if (want('a2')) { log('== A2 sizes', SIZES_MB); await phaseA2(root); log('A2 done'); }
  } catch (err) {
    results.error = redact(err.stack ?? String(err));
    log('ERROR', results.error);
  } finally {
    const cleanup = [];
    for (const n of [...created]) cleanup.push({ name: n, ...(await deleteRepo(n)) });
    // Sweep anything carrying this run id (e.g. a fork whose create response was lost).
    const list = await api('GET', `/repos?limit=200&search=${RUN}`);
    for (const r of list.json?.result ?? []) if (r.name.includes(RUN)) cleanup.push({ name: r.name, sweep: true, ...(await deleteRepo(r.name)) });
    results.cleanup = cleanup;
    const remaining = await api('GET', `/repos?limit=200&search=${RUN}`);
    results.remainingAfterCleanup = (remaining.json?.result ?? []).map((r) => r.name);
    await rm(root, { recursive: true, force: true });
    results.finishedAt = new Date().toISOString();
    const out = join(HERE, `results-${phases.join('-') || 'all'}.json`);
    await writeFile(out, redact(JSON.stringify(results, null, 2)) + '\n');
    log(`wrote ${out}; remaining repos for run: ${results.remainingAfterCleanup.length}`);
  }
}

await main();
