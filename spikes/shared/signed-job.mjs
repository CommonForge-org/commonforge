// Shared by the sandbox runner (Worker) and the node runner (Node >= 22).
// WebCrypto only, no `node:` imports, so the same file bundles into a Worker.
//
// SPIKE ONLY: the HMAC key is a committed stub (see spikes/fixtures/README in
// RESULTS.md). Task 9 owns the real SignedJob schema and key handling.

/** The fields covered by `sig`, per plan §B.8 `SignedJob` minus `sig`. */
export const SIGNED_FIELDS = ["job", "jobId", "issuedAt", "expiresAt", "credentialBroker"];

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function payloadOf(signedJob) {
  const payload = {};
  for (const k of SIGNED_FIELDS) payload[k] = signedJob[k];
  return canonicalJson(payload);
}

async function hmacHex(key, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signJob(unsigned, key) {
  return { ...unsigned, sig: await hmacHex(key, payloadOf(unsigned)) };
}

/**
 * Returns `{ ok: true }` or `{ ok: false, code, detail }` using the
 * RunnerResult failure codes from §B.8 where one fits.
 */
export async function verifyJob(signedJob, key, now = Date.now()) {
  if (!signedJob || typeof signedJob !== "object" || typeof signedJob.sig !== "string") {
    return { ok: false, code: "scope_violation", detail: "not a SignedJob" };
  }
  const expected = await hmacHex(key, payloadOf(signedJob));
  if (expected.length !== signedJob.sig.length) {
    return { ok: false, code: "scope_violation", detail: "bad signature" };
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signedJob.sig.charCodeAt(i);
  if (diff !== 0) return { ok: false, code: "scope_violation", detail: "bad signature" };
  if (Date.parse(signedJob.expiresAt) <= now) {
    return { ok: false, code: "job_expired", detail: `expired at ${signedJob.expiresAt}` };
  }
  return { ok: true };
}

/** Refs the spike pushes for a `prepare-candidate` job. `runTag` keeps reruns fast-forward-free. */
export function candidateRefs(job, runTag) {
  return {
    canonicalRef: `refs/commonforge/candidates/${job.candidate.candidateId}/${runTag}`,
    retentionRef: `${job.retentionRef}/${runTag}`,
  };
}

/**
 * The shell script both runners execute. Inputs come only from env:
 * T (token, never echoed), REMOTE, WORKDIR, RUN_TAG, RUNNER, JOB_ID,
 * CANONICAL_REF, RETENTION_REF, plus GIT_SSL_CAINFO in egress mode.
 * Prints one line per phase: `PHASE <name> <ms>` and finally `SHA <sha>`.
 */
export const GIT_JOB_SCRIPT = String.raw`set -eu
now() { date +%s%3N; }
auth() { if [ -n "${"${T:-}"}" ]; then git -c http.extraHeader="Authorization: Bearer $T" "$@"; else git "$@"; fi; }
rm -rf "$WORKDIR"
t=$(now); auth clone --quiet "$REMOTE" "$WORKDIR"; echo "PHASE clone $(( $(now) - t ))"
cd "$WORKDIR"
t=$(now)
mkdir -p runs
cat > "runs/$RUN_TAG.json" <<EOF
{"runner":"$RUNNER","jobId":"$JOB_ID","runTag":"$RUN_TAG"}
EOF
cat > run.html <<EOF
<!doctype html><meta charset="utf-8"><title>run</title><p id="run">$RUNNER $RUN_TAG</p>
EOF
git add -A
git -c user.name="commonforge-spike-runner" -c user.email="runner@commonforge.invalid" commit --quiet -m "spike($RUNNER): $JOB_ID $RUN_TAG"
echo "PHASE commit $(( $(now) - t ))"
t=$(now); auth push --quiet origin "HEAD:$CANONICAL_REF" "HEAD:$RETENTION_REF"; echo "PHASE push $(( $(now) - t ))"
echo "SHA $(git rev-parse HEAD)"
`;

export function parseScriptOutput(stdout) {
  const phases = {};
  let sha = null;
  for (const line of stdout.split("\n")) {
    const m = /^PHASE (\w+) (\d+)$/.exec(line.trim());
    if (m) phases[m[1]] = Number(m[2]);
    const s = /^SHA ([0-9a-f]{40})$/.exec(line.trim());
    if (s) sha = s[1];
  }
  return { phases, sha };
}

/** Never let a token reach logs or responses. */
export function redact(text, ...secrets) {
  let out = String(text);
  for (const s of secrets) if (s) out = out.split(s).join("<redacted>");
  return out.replace(/art_v1_[0-9a-f]{20,}(\?expires=\d+)?/g, "<redacted>");
}
