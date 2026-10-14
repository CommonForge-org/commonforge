// LFS spike orchestrator (throwaway). Usage: node run.mjs <q1|q2|q3|q4|q5|teardown>
// Loads SPIKE_URL / SPIKE_TOKEN from ~/.config/commonforge/spike-lfs.env (values are never logged).
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- env ---------------------------------------------------------------------------------------
function loadEnv() {
  const out = {};
  for (const line of readFileSync(join(homedir(), ".config/commonforge/spike-lfs.env"), "utf8").split("\n")) {
    const m = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
const ENV = loadEnv();
export const SPIKE_URL = ENV.SPIKE_URL;
const SPIKE_TOKEN = ENV.SPIKE_TOKEN;
if (!SPIKE_URL || !SPIKE_TOKEN) throw new Error("SPIKE_URL / SPIKE_TOKEN missing from env file");

// Every secret value we hold, so results/logs can be scrubbed before they are written or printed.
const secrets = new Set([SPIKE_TOKEN]);
export const addSecret = (s) => s && String(s).length >= 8 && secrets.add(String(s));
export function scrub(s) {
  s = String(s ?? "");
  for (const v of secrets) s = s.split(v).join("[redacted]");
  // presigned query strings and credentials embedded in URLs
  s = s.replace(/\?[^\s"'<>]*X-Amz-[^\s"'<>]*/gi, "?[redacted]");
  s = s.replace(/(https?:\/\/)[^\s/@"']+:[^\s/@"']+@/g, "$1[redacted]@");
  return s;
}
const scrubDeep = (o) => JSON.parse(scrub(JSON.stringify(o)));

// --- HTTP helpers --------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function req(method, path, body, { retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res, text;
    try {
      res = await fetch(SPIKE_URL + path, {
        method,
        headers: { authorization: `Bearer ${SPIKE_TOKEN}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      text = await res.text();
    } catch (e) {
      if (attempt < retries) { await sleep(2000); continue; }
      throw e;
    }
    // transient edge errors (e.g. "error code: 1042" right after a deploy) and 5xx: retry
    if ((/^error code: 10\d\d/.test(text) || res.status >= 502) && attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text };
  }
}

export async function post(path, body) {
  const r = await req("POST", path, body ?? {});
  if (r.status !== 200 || r.json === undefined) throw new Error(`POST ${path} -> ${r.status} ${scrub(r.text).slice(0, 300)}`);
  return r.json;
}

// POST /exec { script, env } -> { exitCode, stdout, stderr, ms }
export async function exec(script, env = {}) {
  for (const v of Object.values(env)) addSecret(v);
  const r = await post("/exec", { script, env });
  return { ...r, stdout: scrub(r.stdout), stderr: scrub(r.stderr) };
}

// R5/R8: run a possibly long script detached in the container and poll it with short /exec calls.
// The script is written to /workspace/<name>.sh (no secrets in it: pass them via `env`, the detached
// child inherits the launching exec's environment). Files: <name>.log (output), <name>.exit (exit code,
// written by the wrapper when the script ends), <name>.pid (wrapper pid = process-group leader via setsid).
// R8: the launch /exec uses retries 0 (a retried launch could start the script twice); each poll checks
// `kill -0 <pid>` and fails fast if the wrapper died without writing .exit; on timeout the whole process
// group is killed via the pidfile. Returns { exitCode, log, ms, polls, launch }; exitCode is null with
// `timedOut` or `died` set when there was no clean exit.
export async function execLong(name, script, env = {}, timeoutMs = 20 * 60_000, pollMs = 5000) {
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error("bad name");
  for (const v of Object.values(env)) addSecret(v);
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const w = `/workspace/${name}`;
  const launch = [
    "set -e",
    "mkdir -p /workspace",
    `rm -f ${w}.exit ${w}.log ${w}.sh ${w}.pid`,
    `echo '${b64}' | base64 -d > ${w}.sh`,
    `setsid nohup bash -c 'echo $$ > ${w}.pid; bash ${w}.sh > ${w}.log 2>&1; echo $? > ${w}.exit' > /dev/null 2>&1 < /dev/null &`,
    `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s ${w}.pid ] && break; sleep 0.25; done`,
    `[ -s ${w}.pid ] || { echo "no pidfile"; exit 1; }`,
    "echo launched",
  ].join("\n");
  const t0 = Date.now();
  // retries 0: a retried launch could start the script twice.
  const lr = await req("POST", "/exec", { script: launch, env }, { retries: 0 });
  if (lr.status !== 200 || !lr.json) throw new Error(`launch failed: HTTP ${lr.status} ${scrub(lr.text).slice(0, 300)}`);
  const l = { ...lr.json, stdout: scrub(lr.json.stdout), stderr: scrub(lr.json.stderr) };
  if (l.exitCode !== 0 || !l.stdout.includes("launched")) throw new Error(`launch failed: ${l.exitCode} ${l.stderr.slice(0, 300)}`);
  const pollScript = [
    `PID=$(cat ${w}.pid 2>/dev/null)`,
    `if [ -f ${w}.exit ]; then echo "STATE:exit:$(cat ${w}.exit)"`,
    `elif [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo "STATE:running"`,
    `else sleep 1; if [ -f ${w}.exit ]; then echo "STATE:exit:$(cat ${w}.exit)"; else echo "STATE:died"; fi; fi`,
    "echo '---LOG---'",
    `tail -c 60000 ${w}.log 2>/dev/null || true`,
  ].join("\n");
  let polls = 0, failures = 0, last = { state: "running", log: "" };
  while (Date.now() - t0 < timeoutMs) {
    await sleep(pollMs);
    polls++;
    let p;
    try {
      p = await exec(pollScript, env); // env passed only so the Worker redacts it from the output
      failures = 0;
    } catch (e) {
      if (++failures >= 6) throw new Error(`poll failed ${failures}x: ${scrub(e.message)}`);
      continue;
    }
    const m = /^STATE:(\S*)\n---LOG---\n([\s\S]*)$/.exec(p.stdout);
    if (!m) continue;
    last = { state: m[1], log: m[2] };
    if (last.state.startsWith("exit:")) return { exitCode: Number(last.state.slice(5)), log: last.log, ms: Date.now() - t0, polls, launch: { ms: l.ms } };
    if (last.state === "died") return { exitCode: null, died: true, log: last.log, ms: Date.now() - t0, polls, launch: { ms: l.ms } };
  }
  // timeout: kill the whole process group (setsid made the wrapper its own group leader)
  let killed = "kill not confirmed";
  try {
    const k = await exec(`PID=$(cat ${w}.pid 2>/dev/null); [ -n "$PID" ] && { kill -TERM -- -"$PID" 2>/dev/null; sleep 2; kill -KILL -- -"$PID" 2>/dev/null; }; sleep 1; st=$(ps -o stat= -p "$PID" 2>/dev/null | tr -d " "); case "$st" in ""|Z*) echo gone;; *) echo "alive:$st";; esac`, env);
    killed = k.stdout.trim();
  } catch (e) { killed = `kill failed: ${scrub(e.message)}`; }
  return { exitCode: null, timedOut: true, killed, log: last.log, ms: Date.now() - t0, polls, launch: { ms: l.ms } };
}

// --- results -------------------------------------------------------------------------------------
export function save(name, obj) {
  const file = join(HERE, `results-${name}.json`);
  writeFileSync(file, JSON.stringify(scrubDeep({ at: new Date().toISOString(), ...obj }), null, 2) + "\n");
  console.log(`wrote ${file}`);
}

const kv = (log) => Object.fromEntries([...log.matchAll(/^([a-z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));

// --- shared container setup ------------------------------------------------------------------------
// Shell snippet (to splice into a String.raw script): fresh repo in /workspace/<dir> with LFS pointing at the
// spike Worker, git-lfs credentials from $SPIKE_TOKEN via a credential helper, and Artifacts auth via an
// origin-scoped extraHeader (env config; nothing on disk). Needs env SPIKE_URL SPIKE_TOKEN GIT_TOKEN ARTIFACTS_ORIGIN.
const lfsRepoSetup = (dir, name, track = "*.bin") => String.raw`
rm -rf /workspace/${dir} && mkdir -p /workspace/${dir} && cd /workspace/${dir}
git init -q -b main && git config user.email spike@commonforge.invalid && git config user.name spike
printf '[lfs]\n\turl = %s/lfs/${name}/info/lfs\n' "$SPIKE_URL" > .lfsconfig
git lfs track '${track}' >/dev/null
# git-lfs calls POST <lfs-url>/locks/verify before every push. The spike Worker has no locks API and answers
# 401 (no LFS-Authenticate path match), which makes git-lfs loop on credential fill/reject forever (q1 attempt 1
# hung for 10+ min). Turn the lock check off client-side; a real server must answer locks/verify (404/501 disables it).
git config lfs.locksverify false
# LFS auth: credential helper reading SPIKE_TOKEN from the environment (nothing on disk).
git config credential.helper '!f(){ echo username=spike; echo "password=$SPIKE_TOKEN"; }; f'
# Artifacts auth: bearer header scoped to the Artifacts origin only, so it is never sent to the LFS host or R2.
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="http.$ARTIFACTS_ORIGIN/.extraHeader"
export GIT_CONFIG_VALUE_0="Authorization: Bearer $GIT_TOKEN"
`;

// --- q1 ------------------------------------------------------------------------------------------
const Q1 = String.raw`
set -uo pipefail
cleanup() { rm -rf /workspace/q1 /workspace/q1-clone; }
trap cleanup EXIT
rm -rf /workspace/q1-clone
${lfsRepoSetup("q1", "q1")}
head -c 150000000 /dev/urandom > big.bin   # 150 MB: over Artifacts' 32 MB blob limit
git add .gitattributes .lfsconfig big.bin && git commit -qm "lfs spike q1"
echo "big_bin_bytes=$(stat -c %s big.bin)"
start=$(date +%s%3N); git push -f "$REMOTE" HEAD:main 2>&1; rc=$?; end=$(date +%s%3N)
echo "push_exit=$rc"
echo "push_ms=$((end-start))"
git lfs ls-files -l
echo "lfs_oid=$(git lfs ls-files -l | awk '{print $1}')"
echo "local_head_blob_bytes=$(git cat-file -s HEAD:big.bin)"
echo "remote_head=$(git ls-remote "$REMOTE" refs/heads/main | cut -c1-40)"
echo "local_head=$(git rev-parse HEAD)"
# What Artifacts actually holds: fresh clone with LFS smudge disabled, so big.bin stays the stored blob.
cd /workspace && GIT_LFS_SKIP_SMUDGE=1 git clone -q "$REMOTE" q1-clone 2>&1; echo "clone_exit=$?"
cd /workspace/q1-clone
echo "artifacts_blob_bytes=$(git cat-file -s HEAD:big.bin)"
echo "--- pointer blob stored in Artifacts:"
git cat-file -p HEAD:big.bin
echo "--- end pointer"
echo "ls_tree:"; git ls-tree -l HEAD
`;

async function q1() {
  const steps = [{
    step: "attempt 1 (no lfs.locksverify=false): hung",
    note: "git push stuck >10 min inside the git-lfs pre-push hook. Debug run (5 MB file, GIT_TRACE/GIT_CURL_VERBOSE, timeout 60 s): git-lfs POSTs <lfs-url>/locks/verify; the spike Worker does not route that path so it answers 401 without a usable challenge, and git-lfs endlessly loops credential reject/fill/resubmit. Workaround: git config lfs.locksverify false (client side, no redeploy).",
  }];
  const step = (s) => { steps.push(s); console.log(`[q1] ${s.step}${s.note ? ": " + s.note : ""}`); };
  const repo = await post("/repos/q1");
  addSecret(repo.token);
  const origin = new URL(repo.remote).origin;
  step({ step: "POST /repos/q1", repo: repo.repo, remote_path: new URL(repo.remote).pathname, token: "[redacted]" });

  const run = await execLong("q1", Q1, { SPIKE_URL, SPIKE_TOKEN, REMOTE: repo.remote, GIT_TOKEN: repo.token, ARTIFACTS_ORIGIN: origin }, 20 * 60_000);
  const v = kv(run.log);
  step({ step: "container q1 script (detached, polled)", exitCode: run.exitCode, timedOut: !!run.timedOut, wall_ms: run.ms, polls: run.polls });
  if (run.exitCode !== 0) step({ step: "script failed", log_tail: run.log.slice(-4000) });

  const oid = v.lfs_oid;
  let r2 = null;
  if (oid) {
    const h = await req("GET", `/head?key=${encodeURIComponent(`lfs/q1/${oid}`)}`);
    r2 = h.status === 200 ? h.json : { status: h.status };
    step({ step: "GET /head?key=lfs/q1/<oid>", status: h.status, result: r2 });
  }

  const pushOk = v.push_exit === "0";
  const pointerOk = Number(v.artifacts_blob_bytes) > 0 && Number(v.artifacts_blob_bytes) < 200;
  const r2Ok = r2 && r2.size === 150_000_000;
  save("q1", {
    question: "Q1: git-lfs push of 150 MB against Artifacts; pointer in Artifacts, object in R2",
    verdict: pushOk && pointerOk && r2Ok ? "VERIFIED" : pushOk || pointerOk || r2Ok ? "PARTIAL" : "FAILED",
    push_exit: v.push_exit == null ? null : Number(v.push_exit),
    push_ms: v.push_ms == null ? null : Number(v.push_ms),
    file_bytes: v.big_bin_bytes == null ? null : Number(v.big_bin_bytes),
    lfs_oid: oid ?? null,
    local_head_blob_bytes: v.local_head_blob_bytes == null ? null : Number(v.local_head_blob_bytes),
    artifacts_blob_bytes: v.artifacts_blob_bytes == null ? null : Number(v.artifacts_blob_bytes),
    artifacts_head_matches_local: v.remote_head && v.remote_head === v.local_head,
    r2_object: r2,
    r2_size_expected: 150_000_000,
    steps,
    script_log: run.log,
  });
}

// --- q2 ------------------------------------------------------------------------------------------
const Q2_BYTES = 2_147_483_648;

// Container side. Order: `git lfs push --all origin` first (uploads the 2 GiB object, direct PUT to R2), then
// `git push` (the pre-push hook finds the object already stored, so it uploads nothing and the time is the
// git side only: pack + pointer blob to Artifacts). Both are timed separately.
const q2Script = String.raw`
set -uo pipefail
cleanup() { cd /workspace; rm -rf /workspace/q2 /workspace/q2-clone /workspace/q2-trace.txt; dfx df_after_cleanup; }
trap cleanup EXIT
rm -rf /workspace/q2-clone /workspace/q2-trace.txt
TRACE_TO=
dfx() { sync; echo "$1_used_avail_bytes=$(df -B1 --output=used,avail /workspace | tail -1 | awk '{print $1","$2}')"; echo "$1=$(df -h /workspace | tail -1)"; }
# timed <name> <cmd...>: wall ms + user/sys CPU seconds (bash time builtin); stderr of cmd goes to $TRACE_TO if set.
timed() {
  local n=$1; shift
  local s e rc
  TIMEFORMAT=$'\n'"$n"'_user_s=%U'$'\n'"$n"'_sys_s=%S'
  s=$(date +%s%3N)
  if [ -n "$TRACE_TO" ]; then time "$@" 2>"$TRACE_TO"; rc=$?; else time "$@"; rc=$?; fi
  e=$(date +%s%3N)
  echo; echo "$n""_ms=$((e-s))"; echo "$n""_exit=$rc"
}
echo "nproc=$(nproc)"; echo "mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)"
echo "git_lfs_version=$(git lfs version)"
dfx df_start
${lfsRepoSetup("q2", "q2")}
git remote add origin "$REMOTE"
timed gen bash -c 'head -c ${Q2_BYTES} /dev/urandom > huge.bin'
echo "file_bytes=$(stat -c %s huge.bin)"
dfx df_with_file
timed add git add .gitattributes .lfsconfig huge.bin
timed commit git commit -qm "lfs spike q2"
dfx df_after_add
echo "lfs_oid=$(git lfs ls-files -l | awk '{print $1}')"
echo "lfs_objects_bytes=$(du -sb .git/lfs/objects | cut -f1)"
echo "pointer_bytes=$(git cat-file -s HEAD:huge.bin)"
# 1) LFS upload, traced. Trace lands in a file that is reduced to hosts / method+path (no query strings) and deleted.
TRACE_TO=/workspace/q2-trace.txt GIT_TRACE=1 GIT_TRANSFER_TRACE=1 GIT_CURL_VERBOSE=1 timed lfs_push git lfs push --all origin
dfx df_after_lfs_push
echo "trace_bytes=$(stat -c %s /workspace/q2-trace.txt)"
grep -aoE 'https?://[A-Za-z0-9._-]+' /workspace/q2-trace.txt | sed 's#^https\?://##' | sort | uniq -c | sed 's/^ */TRACE_HOST /'
grep -aoE '(PUT|POST|GET|HEAD) https?://[^ ?"]+' /workspace/q2-trace.txt | sort | uniq -c | sed 's/^ */TRACE_REQ /'
grep -aiE '> (PUT|POST) /|> Host:|adapter' /workspace/q2-trace.txt | grep -aiv authoriz | sed 's/?.*//' | cut -c1-200 | sort | uniq -c | head -20 | sed 's/^ */TRACE_LINE /'
rm -f /workspace/q2-trace.txt
# 2) git push (object already in R2: this is the git side only)
timed git_push git push -f origin HEAD:main
dfx df_after_push
echo "remote_head=$(git ls-remote origin refs/heads/main | cut -c1-40)"
echo "local_head=$(git rev-parse HEAD)"
cd /workspace && GIT_LFS_SKIP_SMUDGE=1 git clone -q "$REMOTE" q2-clone 2>&1; echo "clone_exit=$?"
echo "artifacts_blob_bytes=$(git -C q2-clone cat-file -s HEAD:huge.bin)"
`;

const NEG_PREFIX = "lfs/q2-neg/";

async function putBytes(url, bytes = 1024) {
  const r = await fetch(url, { method: "PUT", body: Buffer.alloc(bytes, 120) });
  const text = await r.text();
  return { status: r.status, code: /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? null, message: scrub(/<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? "") };
}

async function presignTest(key, method, expiresSeconds) {
  const { url } = await post("/presign-test", { key, method, expiresSeconds });
  const u = new URL(url);
  addSecret(u.searchParams.get("X-Amz-Signature"));
  addSecret(u.searchParams.get("X-Amz-Credential")?.split("/")[0]);
  return url;
}

async function negativeChecks(step) {
  const out = {};
  // Expiry: 5 s URL. Control PUT right away (should work), wait 10 s, PUT again (should be refused).
  const kExp = `${NEG_PREFIX}expiry`;
  const urlExp = await presignTest(kExp, "PUT", 5);
  const control = await putBytes(urlExp);
  await sleep(10_000);
  const expired = await putBytes(urlExp);
  out.expiry = { key: kExp, expires_seconds: 5, wait_seconds: 10, fresh_put: control, expired_put: expired, expect: 403, pass: expired.status === 403 };
  step({ step: "expiry check (5 s URL, PUT after 10 s)", fresh_status: control.status, expired_status: expired.status, code: expired.code });

  // Scope: valid URL for key A, path swapped to key B with the same query.
  const kA = `${NEG_PREFIX}scope-a`, kB = `${NEG_PREFIX}scope-b`;
  const urlA = await presignTest(kA, "PUT", 300);
  const okA = await putBytes(urlA);
  const u = new URL(urlA);
  u.pathname = u.pathname.replace(kA, kB);
  const swapped = await putBytes(u.toString());
  const headB = await req("GET", `/head?key=${encodeURIComponent(kB)}`);
  out.scope = { key_a: kA, key_b: kB, put_a: okA, put_b_with_a_query: swapped, key_b_exists_after: headB.status === 200, expect: 403, pass: swapped.status === 403 && headB.status === 404 };
  step({ step: "scope check (URL for A, path changed to B)", a_status: okA.status, b_status: swapped.status, code: swapped.code, b_exists: headB.status === 200 });
  const del = await req("DELETE", `/objects?prefix=${encodeURIComponent(NEG_PREFIX)}`);
  step({ step: "cleanup lfs/q2-neg/", status: del.status, result: del.json });
  return out;
}

async function q2() {
  const steps = [{
    step: "attempt 1 (same script, df read without sync): VERIFIED but disk numbers misleading",
    note: "Without a sync, df lagged writes and deletes (after writing the 2 GiB random file df showed +0.4 GB used; after rm -rf in the exit trap it still showed 4.2 GB used; a later df showed 178M, i.e. fully freed). This run syncs before every df. Attempt 1 numbers otherwise matched: lfs push 45.7 s, git push 1.5 s, R2 size 2147483648, expiry 403 ExpiredRequest, scope 403 SignatureDoesNotMatch.",
  }];
  const step = (s) => { steps.push(s); console.log(`[q2] ${s.step}`, JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "step"))).slice(0, 300)); };
  let neg = null, run = null, v = {}, r2 = null, error = null;
  try {
    neg = await negativeChecks(step);

    const repo = await post("/repos/q2");
    addSecret(repo.token);
    const origin = new URL(repo.remote).origin;
    step({ step: "POST /repos/q2", repo: repo.repo, remote_path: new URL(repo.remote).pathname, token: "[redacted]" });

    run = await execLong("q2", q2Script, { SPIKE_URL, SPIKE_TOKEN, REMOTE: repo.remote, GIT_TOKEN: repo.token, ARTIFACTS_ORIGIN: origin }, 45 * 60_000);
    v = kv(run.log);
    step({ step: "container q2 script (detached, polled)", exitCode: run.exitCode, timedOut: !!run.timedOut, died: !!run.died, wall_ms: run.ms, polls: run.polls });
    if (run.exitCode !== 0) step({ step: "script failed", log_tail: run.log.slice(-4000) });

    if (v.lfs_oid) {
      const h = await req("GET", `/head?key=${encodeURIComponent(`lfs/q2/${v.lfs_oid}`)}`);
      r2 = h.status === 200 ? h.json : { status: h.status };
      step({ step: "GET /head?key=lfs/q2/<oid>", status: h.status, result: r2 });
    }
  } catch (e) {
    error = scrub(e?.stack ?? e);
    step({ step: "q2 threw", error });
  }

  const num = (k) => (v[k] == null ? null : Number(v[k]));
  const mbps = (ms) => (ms ? Number((Q2_BYTES / (ms / 1000) / 1e6).toFixed(1)) : null); // MB = 1e6 bytes
  const hostLines = [...(run?.log ?? "").matchAll(/^TRACE_HOST\s+(\d+)\s+(\S+)/gm)].map((m) => ({ count: Number(m[1]), host: m[2] }));
  const r2Host = hostLines.find((h) => h.host.endsWith(".r2.cloudflarestorage.com"));
  const putLines = [...(run?.log ?? "").matchAll(/^TRACE_REQ\s+(\d+)\s+(\S+ \S+)/gm)].map((m) => ({ count: Number(m[1]), request: m[2] }));
  const dfPair = (k) => (v[`${k}_used_avail_bytes`] ? v[`${k}_used_avail_bytes`].split(",").map(Number) : null);
  const sizeOk = r2 && r2.size === Q2_BYTES;
  const pushed = v.lfs_push_exit === "0" && v.git_push_exit === "0";
  const negOk = neg && neg.expiry.pass && neg.scope.pass;
  save("q2", {
    question: "Q2: 2 GiB git-lfs upload straight to R2 via presigned URLs; expired and re-scoped URLs refused",
    verdict: sizeOk && pushed && negOk && r2Host ? "VERIFIED" : sizeOk || negOk ? "PARTIAL" : "FAILED",
    note_units: "MB/s = bytes / seconds / 1e6",
    file_bytes: num("file_bytes"),
    lfs_oid: v.lfs_oid ?? null,
    r2_object: r2,
    r2_size_expected: Q2_BYTES,
    transfer_hosts: hostLines,
    r2_transfer_host_seen: r2Host ? "<account-id>.r2.cloudflarestorage.com" : null,
    trace_requests_without_query: putLines,
    container: { nproc: num("nproc"), mem_kb: num("mem_kb"), git_lfs: v.git_lfs_version },
    timings: {
      gen_random_file_ms: num("gen_ms"),
      git_add_lfs_clean_ms: num("add_ms"), git_add_user_s: num("add_user_s"), git_add_sys_s: num("add_sys_s"),
      git_commit_ms: num("commit_ms"),
      git_lfs_push_ms: num("lfs_push_ms"), git_lfs_push_exit: num("lfs_push_exit"), git_lfs_push_mb_per_s: mbps(num("lfs_push_ms")),
      git_lfs_push_user_s: num("lfs_push_user_s"), git_lfs_push_sys_s: num("lfs_push_sys_s"),
      git_push_ms: num("git_push_ms"), git_push_exit: num("git_push_exit"),
      order: "git lfs push --all origin first (uploads the object), then git push (hook finds it already in R2; git side only)",
    },
    disk: {
      note: "used,avail bytes of /workspace (df -B1); random data, so no compression",
      start: dfPair("df_start"), with_file: dfPair("df_with_file"), after_add: dfPair("df_after_add"), after_lfs_push: dfPair("df_after_lfs_push"), after_git_push: dfPair("df_after_push"), after_cleanup: dfPair("df_after_cleanup"),
      human: { start: v.df_start, with_file: v.df_with_file, after_add: v.df_after_add, after_lfs_push: v.df_after_lfs_push, after_git_push: v.df_after_push, after_cleanup: v.df_after_cleanup },
      lfs_objects_bytes: num("lfs_objects_bytes"),
    },
    artifacts: { pointer_bytes_local: num("pointer_bytes"), artifacts_blob_bytes: num("artifacts_blob_bytes"), head_matches: v.remote_head && v.remote_head === v.local_head },
    negative_checks: neg,
    steps,
    error,
    script_log: run?.log ?? null,
  });
}

// --- q4 ------------------------------------------------------------------------------------------
const q4Script = (bytes) => String.raw`
set -uo pipefail
cd /workspace
trap 'rm -f /workspace/two.gb' EXIT
echo "bytes=${bytes}"
echo "df_before=$(df -h /workspace | tail -1)"
s=$(date +%s%3N); head -c ${bytes} /dev/zero | tr '\0' 'a' > two.gb; e=$(date +%s%3N); echo "write_ms=$((e-s))"
echo "file_bytes=$(stat -c %s two.gb)"
s=$(date +%s%3N); sha256sum two.gb | cut -d' ' -f1 | sed 's/^/sha256sum_digest=/'; e=$(date +%s%3N); echo "sha256sum_ms=$((e-s))"
s=$(date +%s%3N); node -e 'const c=require("crypto"),f=require("fs");const h=c.createHash("sha256");f.createReadStream("two.gb").on("data",d=>h.update(d)).on("end",()=>console.log("node_digest="+h.digest("hex")))'; e=$(date +%s%3N); echo "node_stream_ms=$((e-s))"
echo "df_with_file=$(df -h /workspace | tail -1)"
echo "df_with_file_bytes=$(df -B1 --output=avail /workspace | tail -1 | tr -d ' ')"
rm -f two.gb
echo "df_after=$(df -h /workspace | tail -1)"
`;

async function q4() {
  const steps = [];
  const step = (s) => { steps.push(s); console.log(`[q4] ${s.step}`); };
  const bytes = 2147483648;
  const run = await execLong("q4", q4Script(bytes), {}, 20 * 60_000);
  const v = kv(run.log);
  step({ step: "container q4 script, 2 GiB (detached, polled)", exitCode: run.exitCode, timedOut: !!run.timedOut, wall_ms: run.ms, polls: run.polls });
  if (run.exitCode !== 0) step({ step: "script failed", log_tail: run.log.slice(-4000) });
  const num = (k) => (v[k] == null ? null : Number(v[k]));
  save("q4", {
    question: "Q4: time to hash 2 GiB in the runner container (standard-1)",
    verdict: run.exitCode === 0 && v.sha256sum_ms && v.node_stream_ms ? "VERIFIED" : "FAILED",
    file_bytes: num("file_bytes"),
    write_ms: num("write_ms"),
    sha256sum_ms: num("sha256sum_ms"),
    node_stream_ms: num("node_stream_ms"),
    digests_match: v.sha256sum_digest && v.node_digest ? v.sha256sum_digest === v.node_digest : null,
    disk: { before: v.df_before, with_file: v.df_with_file, with_file_avail_bytes: num("df_with_file_bytes"), after: v.df_after },
    steps,
    script_log: run.log,
  });
}

// --- q3: 2 GiB browser upload in 50 MiB parts through the Worker (Playwright) ---------------------------
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { readFileSync as readF, rmSync } from "node:fs";

const med = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

async function q3() {
  const steps = [];
  const step = (s) => { steps.push(s); console.log(`[q3] ${s.step}`); };
  const out = join(tmpdir(), `q3-driver-${process.pid}.json`);
  // Run the driver as a child (it resolves Playwright from apps/web); pass creds via env, never argv.
  const code = await new Promise((resolve) => {
    const c = spawn(process.execPath, [join(HERE, "browser.spec.mjs"), out], { env: { ...process.env, SPIKE_URL, SPIKE_TOKEN }, stdio: ["ignore", "pipe", "pipe"] });
    c.stdout.on("data", (d) => process.stdout.write(scrub(d.toString())));
    c.stderr.on("data", (d) => process.stderr.write(scrub(d.toString())));
    c.on("close", resolve);
  });
  step({ step: "playwright driver finished", exitCode: code });
  let d;
  try { d = JSON.parse(readF(out, "utf8")); } catch { d = { driver_error: "no driver output" }; }
  try { rmSync(out); } catch {}

  const f = d.full?.result;
  const a = d.abort?.result;
  const want = 2147483648;
  // Independent confirmation from the Worker (R2 head), not from the page.
  const headFull = f?.key ? await req("GET", `/head?key=${encodeURIComponent(f.key)}`) : null;
  const headAbort = a?.key ? await req("GET", `/head?key=${encodeURIComponent(a.key)}`) : null;
  step({ step: "HEAD full key", status: headFull?.status, json: headFull?.json });
  step({ step: "HEAD aborted key", status: headAbort?.status });

  const mbytes = want / 1e6;
  const full = f && !f.error ? {
    key: f.key, parts: f.parts, page_size: f.size, head_size: headFull?.json?.size ?? null,
    total_ms: f.ms, wall_ms: d.full.wall_ms, gen_ms: f.genMs,
    upload_ms: f.ms - f.genMs,
    mb_per_s_total: +(mbytes / (f.ms / 1000)).toFixed(1), mb_per_s_upload_only: +(mbytes / ((f.ms - f.genMs) / 1000)).toFixed(1),
    mib_per_s_total: +(2048 / (f.ms / 1000)).toFixed(1),
    part_ms: { min: Math.min(...f.partMs), median: med(f.partMs), max: Math.max(...f.partMs), all: f.partMs },
    retries: f.retries, part_statuses: f.statuses, http_413: f.statuses.filter((s) => s === 413).length, attempts_log: f.attemptsLog,
  } : { error: f?.error ?? d.driver_error ?? "no result", raw: f };
  const abort = a && !a.error ? {
    key: a.key, aborted: a.aborted, abort_status: a.abortStatus, parts_uploaded_before_abort: a.partsUploaded,
    complete_after_abort_status: a.completeAfterAbortStatus, complete_after_abort_body: a.completeAfterAbortBody,
    head_status_after: headAbort?.status, retries: a.retries,
  } : { error: a?.error ?? d.driver_error ?? "no result", raw: a };
  const fullOk = full.head_size === want && full.page_size === want && full.http_413 === 0;
  const abortOk = abort.aborted === true && abort.head_status_after === 404;
  save("q3", {
    question: "Q3: 2 GiB browser upload in 50 MiB parts through the Worker's R2 multipart routes; abort leaves nothing",
    verdict: fullOk && abortOk ? "VERIFIED" : fullOk || abortOk ? "PARTIAL" : "FAILED",
    chromium_version: d.chromium_version,
    full, abort, driver_error: d.driver_error, steps,
  });
}

// --- q5: a preview-style build in a fresh clone gets the real file after `git lfs pull`, a pointer without -----
const Q5_BYTES = 100_000_000;

// Container side. Phase A pushes a repo (index.html + 100 MB random demo.mp4 tracked by LFS). Then two fresh
// clones (GIT_LFS_SKIP_SMUDGE=1, as the runner would): "good" runs `git lfs pull` (traced) and a build
// (mkdir dist && cp index.html demo.mp4 dist/); "bad" skips the pull and builds anyway.
const q5Script = String.raw`
set -uo pipefail
cleanup() { cd /workspace; rm -rf /workspace/q5 /workspace/q5-good /workspace/q5-bad /workspace/q5-trace.txt; }
trap cleanup EXIT
rm -rf /workspace/q5-good /workspace/q5-bad /workspace/q5-trace.txt
${lfsRepoSetup("q5", "q5", "*.mp4")}
printf '<!doctype html><title>q5</title><video src="demo.mp4" controls></video>\n' > index.html
head -c ${Q5_BYTES} /dev/urandom > demo.mp4
echo "orig_bytes=$(stat -c %s demo.mp4)"
echo "orig_sha256=$(sha256sum demo.mp4 | cut -d' ' -f1)"
git add .gitattributes .lfsconfig index.html demo.mp4 && git commit -qm "lfs spike q5"
git push -f "$REMOTE" HEAD:main 2>&1; echo "push_exit=$?"
echo "lfs_oid=$(git lfs ls-files -l | awk '{print $1}')"

# Per-clone auth, as the runner would configure: bearer scoped to the Artifacts origin (env, inherited from the
# setup block) for the clone; LFS credential helper + locksverify off in the clone's own config for lfs pull.
fresh_clone() {
  cd /workspace && GIT_LFS_SKIP_SMUDGE=1 git clone -q "$REMOTE" "$1" 2>&1; echo "$(echo $1 | tr - _)_clone_exit=$?"
  cd "/workspace/$1"
  git config lfs.locksverify false
  git config credential.helper '!f(){ echo username=spike; echo "password=$SPIKE_TOKEN"; }; f'
  echo "$(echo $1 | tr - _)_checkout_demo_bytes=$(stat -c %s demo.mp4)"
}
build() { mkdir dist && cp index.html demo.mp4 dist/; }

# --- good: git lfs pull, then build -------------------------------------------------------------------------
fresh_clone q5-good
echo "good_pre_pull_head40_lfs_count=$(head -c 40 demo.mp4 | grep -c git-lfs)"
s=$(date +%s%3N)
GIT_TRACE=1 GIT_TRANSFER_TRACE=1 GIT_CURL_VERBOSE=1 git lfs pull 2>/workspace/q5-trace.txt; rc=$?
e=$(date +%s%3N)
echo "pull_exit=$rc"; echo "pull_ms=$((e-s))"
build
echo "good_dist_bytes=$(stat -c %s dist/demo.mp4)"
echo "good_dist_head40_lfs_count=$(head -c 40 dist/demo.mp4 | grep -c git-lfs)"
echo "good_dist_sha256=$(sha256sum dist/demo.mp4 | cut -d' ' -f1)"
echo "good_dist_index_bytes=$(stat -c %s dist/index.html)"
echo "trace_bytes=$(stat -c %s /workspace/q5-trace.txt)"
grep -aoE 'https?://[A-Za-z0-9._-]+' /workspace/q5-trace.txt | sed 's#^https\?://##' | sort | uniq -c | sed 's/^ */TRACE_HOST /'
grep -aoE '(PUT|POST|GET|HEAD) https?://[^ ?"]+' /workspace/q5-trace.txt | sort | uniq -c | sed 's/^ */TRACE_REQ /'
rm -f /workspace/q5-trace.txt

# --- bad: no lfs pull, build anyway (the failure mode) --------------------------------------------------------
fresh_clone q5-bad
build
echo "bad_dist_bytes=$(stat -c %s dist/demo.mp4)"
echo "bad_dist_head40_lfs_count=$(head -c 40 dist/demo.mp4 | grep -c git-lfs)"
echo "bad_dist_first_line=$(head -n1 dist/demo.mp4 | cut -c1-80)"
echo "bad_dist_version_prefix_ok=$(head -c 42 dist/demo.mp4 | grep -c '^version https://git-lfs.github.com/spec/v1')"
`;

async function q5() {
  const steps = [{
    step: "attempt 1 (same script): data correct, two harness bugs, verdict PARTIAL",
    note: "Pulled build 100,000,000 B / git-lfs count 0 / sha256 match; no-pull build was the 134 B pointer. But (a) the kv() log parser ignores keys containing '-', so the clone-checkout sizes (q5-good_..., q5-bad_...) came back null, and (b) the pointer prefix check used head -c 41 on a 42-char first line, so starts_with_lfs_version_line read false although first_line was exactly the version line. Both fixed in the script (keys use '_', head -c 42); this run is the re-run. That attempt left one extra 100 MB object under lfs/q5/ in R2 (a fresh random file each run); Task 6 teardown covers the prefix.",
  }];
  const step = (s) => { steps.push(s); console.log(`[q5] ${s.step}`, JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== "step"))).slice(0, 300)); };
  let run = null, v = {}, error = null;
  try {
    const repo = await post("/repos/q5");
    addSecret(repo.token);
    const origin = new URL(repo.remote).origin;
    step({ step: "POST /repos/q5", repo: repo.repo, remote_path: new URL(repo.remote).pathname, token: "[redacted]" });
    run = await execLong("q5", q5Script, { SPIKE_URL, SPIKE_TOKEN, REMOTE: repo.remote, GIT_TOKEN: repo.token, ARTIFACTS_ORIGIN: origin }, 15 * 60_000);
    v = kv(run.log);
    step({ step: "container q5 script (detached, polled)", exitCode: run.exitCode, timedOut: !!run.timedOut, died: !!run.died, wall_ms: run.ms, polls: run.polls });
    if (run.exitCode !== 0) step({ step: "script failed", log_tail: run.log.slice(-4000) });
  } catch (e) {
    error = scrub(e?.stack ?? e);
    step({ step: "q5 threw", error });
  }
  const num = (k) => (v[k] == null ? null : Number(v[k]));
  const log = run?.log ?? "";
  const hostLines = [...log.matchAll(/^TRACE_HOST\s+(\d+)\s+(\S+)/gm)].map((m) => ({ count: Number(m[1]), host: m[2] }));
  const r2Host = hostLines.find((h) => h.host.endsWith(".r2.cloudflarestorage.com"));
  const reqLines = [...log.matchAll(/^TRACE_REQ\s+(\d+)\s+(\S+ \S+)/gm)].map((m) => ({ count: Number(m[1]), request: m[2] }));
  const pullMs = num("pull_ms");
  const goodOk = num("pull_exit") === 0 && num("good_dist_bytes") === Q5_BYTES && num("good_dist_head40_lfs_count") === 0;
  const hashOk = !!v.orig_sha256 && v.orig_sha256 === v.good_dist_sha256;
  const badOk = num("bad_dist_bytes") > 0 && num("bad_dist_bytes") < 200 && v.bad_dist_version_prefix_ok === "1" && num("bad_dist_head40_lfs_count") === 1;
  save("q5", {
    question: "Q5: a preview-style build in a fresh clone gets the real 100 MB file after git lfs pull (presigned R2 GETs); without the pull it gets a pointer",
    verdict: goodOk && hashOk && badOk && r2Host ? "VERIFIED" : goodOk || badOk ? "PARTIAL" : "FAILED",
    expected_bytes: Q5_BYTES,
    note_units: "MB/s = bytes / seconds / 1e6",
    push_exit: num("push_exit"),
    lfs_oid: v.lfs_oid ?? null,
    pulled_build: {
      checkout_demo_bytes_before_pull: num("q5_good_checkout_demo_bytes"),
      pre_pull_head40_git_lfs_count: num("good_pre_pull_head40_lfs_count"),
      pull_exit: num("pull_exit"),
      dist_demo_bytes: num("good_dist_bytes"),
      dist_head40_git_lfs_count: num("good_dist_head40_lfs_count"),
      dist_index_bytes: num("good_dist_index_bytes"),
      sha256_original: v.orig_sha256 ?? null,
      sha256_pulled_dist: v.good_dist_sha256 ?? null,
      sha256_match: hashOk,
    },
    pointer_build_no_pull: {
      checkout_demo_bytes: num("q5_bad_checkout_demo_bytes"),
      dist_demo_bytes: num("bad_dist_bytes"),
      dist_head40_git_lfs_count: num("bad_dist_head40_lfs_count"),
      first_line: v.bad_dist_first_line ?? null,
      starts_with_lfs_version_line: v.bad_dist_version_prefix_ok === "1",
    },
    download: {
      git_lfs_pull_ms: pullMs,
      git_lfs_pull_mb_per_s: pullMs ? Number((Q5_BYTES / (pullMs / 1000) / 1e6).toFixed(1)) : null,
      transfer_hosts: hostLines,
      r2_transfer_host_seen: r2Host ? "<account-id>.r2.cloudflarestorage.com" : null,
      trace_requests_without_query: reqLines,
    },
    steps,
    error,
    script_log: log || null,
  });
}

// --- teardown (Task 6) ---------------------------------------------------------------------------
// Deletes every object under lfs/ (covers lfs/q1, q2, q2-neg, q5, mp, smoke...; R6 put multipart keys
// under lfs/mp/) and every lfs-* Artifacts repo in the spike namespace. Prints what it deleted.
const KNOWN_REPOS = ["q1", "q2", "q5", "bootstrap", "smoke1"]; // suffixes of lfs-<name>

async function listRepos() {
  const r = await req("GET", "/repos");
  if (r.status !== 200 || !Array.isArray(r.json?.repos)) throw new Error(`GET /repos -> ${r.status} ${scrub(r.text).slice(0, 300)}`);
  return r.json.repos;
}

async function teardown() {
  console.log("== R2 objects under lfs/");
  let total = 0;
  for (let round = 1; round <= 10; round++) {
    const r = await req("DELETE", `/objects?prefix=${encodeURIComponent("lfs/")}`);
    if (r.status !== 200 || typeof r.json?.deleted !== "number") throw new Error(`DELETE /objects -> ${r.status} ${scrub(r.text).slice(0, 300)}`);
    console.log(`round ${round}: deleted ${r.json.deleted}`);
    total += r.json.deleted;
    if (r.json.deleted === 0) break;
  }
  console.log(`objects deleted in total: ${total}`);

  console.log("== Artifacts repos (namespace commonforge-spike-lfs)");
  const before = await listRepos();
  console.log(`listed before: ${before.length ? before.join(", ") : "(none)"}`);
  const others = before.filter((n) => !n.startsWith("lfs-"));
  if (others.length) console.log(`not lfs-* (left alone): ${others.join(", ")}`);
  const suffixes = new Set(KNOWN_REPOS);
  for (const n of before) if (n.startsWith("lfs-")) suffixes.add(n.slice(4));
  for (const s of suffixes) {
    const r = await req("DELETE", `/repos/${encodeURIComponent(s)}`);
    console.log(`DELETE lfs-${s}: ${r.status} ${scrub(r.text).slice(0, 200)}`);
  }
  const after = await listRepos();
  console.log(`listed after: ${after.length ? after.join(", ") : "(none)"}`);
}

// --- main ----------------------------------------------------------------------------------------
const cmds = { q1, q2, q3, q4, q5, teardown };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (!cmds[cmd]) { console.error(`usage: node run.mjs <${Object.keys(cmds).join("|")}>`); process.exit(2); }
  await cmds[cmd]();
}
