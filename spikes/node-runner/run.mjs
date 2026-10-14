#!/usr/bin/env node
// Task 3 fallback runner (plan §0.3 A3 fallback, §C.2): the same SignedJob, the same
// git script, executed by a developer-controlled Node process with local git.
//
// Usage: node spikes/node-runner/run.mjs [path/to/signed-job.json] [--broker URL]
//   reads the SignedJob (default: spikes/fixtures/signed-job.json, or stdin with "-"),
//   asks job.credentialBroker for a short-lived write token, runs clone/commit/push in a
//   temp dir, revokes the token, prints a RunnerResult JSON (+ timings) on stdout.
// No dependencies beyond Node >= 22 and git on PATH. The token is passed to git only
// through the child-process env (never argv, never written to disk, never printed).
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_JOB_SCRIPT, candidateRefs, parseScriptOutput, redact } from "../shared/signed-job.mjs";

const args = process.argv.slice(2);
const brokerIdx = args.indexOf("--broker");
const brokerOverride = brokerIdx >= 0 ? args.splice(brokerIdx, 2)[1] : undefined;
const jobPath = args[0] ?? fileURLToPath(new URL("../fixtures/signed-job.json", import.meta.url));

const readStdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
};

function sh(script, env) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    // Minimal env: PATH + HOME + job vars. Nothing else from the parent leaks in.
    const child = spawn("bash", ["-c", script], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr, wallMs: Math.round(performance.now() - t0) }));
  });
}

async function main() {
  const tAll = performance.now();
  const signedJob = JSON.parse(jobPath === "-" ? await readStdin() : await readFile(jobPath, "utf8"));
  const timings = {};

  if (Date.parse(signedJob.expiresAt) <= Date.now()) {
    return { jobId: signedJob.jobId, ok: false, code: "job_expired", detail: `expired at ${signedJob.expiresAt}` };
  }

  const broker = brokerOverride ?? signedJob.credentialBroker;
  const tb = performance.now();
  const res = await fetch(broker, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signedJob) });
  const cred = await res.json();
  timings.brokerRoundTripMs = Math.round(performance.now() - tb);
  if (!cred.ok) return { jobId: signedJob.jobId, ok: false, code: cred.code ?? "provider_unavailable", detail: cred.detail ?? `broker ${res.status}` };

  const work = await mkdtemp(join(tmpdir(), "cf-node-runner-"));
  const runTag = `node-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const refs = candidateRefs(signedJob.job, runTag);
  try {
    const r = await sh(GIT_JOB_SCRIPT, {
      T: cred.token,
      REMOTE: cred.remote,
      WORKDIR: join(work, "repo"),
      RUN_TAG: runTag,
      RUNNER: "node",
      JOB_ID: signedJob.jobId,
      CANONICAL_REF: refs.canonicalRef,
      RETENTION_REF: refs.retentionRef,
    });
    const parsed = parseScriptOutput(r.stdout);
    for (const [k, v] of Object.entries(parsed.phases)) timings[`${k}Ms`] = v;
    timings.gitScriptWallMs = r.wallMs;
    if (r.exitCode !== 0 || !parsed.sha) {
      return { jobId: signedJob.jobId, ok: false, code: "provider_unavailable", detail: redact(`git exit ${r.exitCode}: ${r.stderr}`, cred.token), timings };
    }
    return {
      jobId: signedJob.jobId,
      ok: true,
      receipt: { candidateId: signedJob.job.candidate.candidateId, canonicalRef: refs.canonicalRef, retentionRef: refs.retentionRef, sha: parsed.sha },
      runner: "node",
      timings,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
    const tr = performance.now();
    const rv = await fetch(new URL("/broker/revoke", broker), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedJob, tokenId: cred.tokenId }),
    }).then((r) => r.json(), () => ({ ok: false }));
    timings.revokeRoundTripMs = Math.round(performance.now() - tr);
    timings.revoked = rv.revoked ?? false;
    timings.totalMs = Math.round(performance.now() - tAll);
  }
}

const result = await main();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ok ? 0 : 1;
