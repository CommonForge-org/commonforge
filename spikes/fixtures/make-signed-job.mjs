#!/usr/bin/env node
// Regenerates spikes/fixtures/signed-job.json (the fixture expires; see RESULTS.md).
// Usage: node spikes/fixtures/make-signed-job.mjs [--hours 48] [--broker URL]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signJob } from "../shared/signed-job.mjs";

// SPIKE ONLY: committed stub key. The deployed spike Worker has the same value
// in wrangler.jsonc `vars.SPIKE_JOB_KEY`. Never reuse for Task 9/14.
export const SPIKE_STUB_KEY = "commonforge-spike-stub-key-not-a-secret";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const hours = Number(opt("hours", "48"));
const broker = opt("broker", "https://commonforge-spike-sandbox.example.workers.dev/broker");

const issuedAt = new Date();
const unsigned = {
  job: {
    kind: "prepare-candidate",
    candidate: {
      candidateId: "cand-spike-0001",
      taskWorkspaceId: "tw-spike-0001",
      resourceId: "res-spike-site",
      baseRevision: "main",
      // S3 has no task fork: the runner synthesizes the candidate commit on top
      // of baseRevision instead of fetching `sha` from a fork (see RESULTS.md).
      sha: "0000000000000000000000000000000000000000",
      treeId: "0000000000000000000000000000000000000000",
      frozenAt: issuedAt.toISOString(),
      submitter: { kind: "agent", id: "spike-agent" },
      tool: "spike",
      changedPaths: ["run.html", "runs/"],
    },
    canonical: { namespace: "commonforge-spike", repoName: "spike-runner" },
    retentionRef: "refs/commonforge/retained/cand-spike-0001",
  },
  jobId: "job-spike-0001",
  issuedAt: issuedAt.toISOString(),
  expiresAt: new Date(issuedAt.getTime() + hours * 3600_000).toISOString(),
  credentialBroker: broker,
};

const signed = await signJob(unsigned, SPIKE_STUB_KEY);
const out = fileURLToPath(new URL("./signed-job.json", import.meta.url));
writeFileSync(out, `${JSON.stringify(signed, null, 2)}\n`);
console.log(`wrote ${out} (expires ${signed.expiresAt})`);
