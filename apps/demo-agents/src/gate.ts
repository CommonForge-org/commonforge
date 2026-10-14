/**
 * The trusted gate agent 1's change has to pass (PRD §14.4 4:00–6:00: "expose a cross-repository
 * contract mismatch … repair, validate").
 *
 * - `api` (live default): build a proposal from the task's frozen candidates, wait until it is
 *   prepared, request integration (runner `integrate`, server-owned checks and contracts), and read
 *   the outcome from the event log (`proposal.integrated` / `proposal.integration_failed`) and the
 *   proposal's integration record.
 * - `local` (rehearsal only): run the `/quote` contract check on the agent's local workspace.
 */
import { checkQuoteContract } from "./contract-check.js";
import type { OwnerApi } from "./owner-api.js";
import { sleep } from "./proc.js";

export interface GateOutcome {
  gate: "api" | "local";
  result: "pass" | "fail";
  detail: string;
  at: string;
  proposalId?: string;
  proposalHash?: string;
  jobId?: string;
  contractChecks?: Array<{ contractId: string; result: string }>;
  checks?: Array<{ checkId: string; result: string }>;
}

export type ContractGate = (o: { taskId: string; workspaceRoot: string; attempt: number }) => Promise<GateOutcome>;

export function localGate(): ContractGate {
  return async ({ workspaceRoot }) => {
    const r = await checkQuoteContract(workspaceRoot);
    return { gate: "local", result: r.result, detail: `${r.contractId}: ${r.detail}`, at: new Date().toISOString(), contractChecks: [{ contractId: r.contractId, result: r.result }] };
  };
}

const DONE = new Set(["proposal.integrated", "proposal.integration_failed", "proposal.integration_rejected"]);

export function apiGate(owner: OwnerApi, org: string, o: { startSeq: number; projectId?: string; timeoutMs?: number; pollMs?: number }): ContractGate {
  let cursor = o.startSeq;
  const pollMs = o.pollMs ?? 2000;
  return async ({ taskId }) => {
    const deadline = Date.now() + (o.timeoutMs ?? 15 * 60_000);
    const created = await owner.createProposal(org, taskId);
    let p = created;
    while (p.state !== "prepared") {
      if (Date.now() > deadline) throw new Error(`proposal ${created.proposalId} not prepared in time (state ${p.state})`);
      await sleep(pollMs);
      p = await owner.proposal(org, created.proposalId);
    }
    const job = await owner.integrate(org, p.proposalId);
    for (;;) {
      const page = await owner.allEvents(org, cursor, o.projectId);
      cursor = page.next;
      const done = page.events.find((e) => e.subject.id === p.proposalId && DONE.has(e.action) && (e.detail?.jobId === undefined || e.detail.jobId === job.jobId));
      if (done) {
        const base = { gate: "api" as const, at: done.at, proposalId: p.proposalId, proposalHash: p.proposalHash, jobId: job.jobId };
        if (done.action !== "proposal.integrated") {
          return { ...base, result: "fail", detail: `${done.action}: ${String(done.detail?.code ?? "")} ${String(done.detail?.detail ?? "")}`.trim() };
        }
        const view = await owner.proposal(org, p.proposalId);
        const integ = view.integration;
        const failed = [
          ...(integ?.contractChecks ?? []).filter((c) => c.result !== "pass").map((c) => `contract ${c.contractId}: ${c.result}`),
          ...(integ?.checks ?? []).filter((c) => c.result !== "pass" && c.result !== "skipped").map((c) => `check ${c.checkId}: ${c.result}`),
          ...(integ?.mergeOutcome ?? []).filter((m) => m.result !== "clean").map((m) => `merge ${m.resourceId}: ${m.result} ${(m.conflictPaths ?? []).join(", ")}`),
        ];
        return {
          ...base,
          result: failed.length ? "fail" : "pass",
          detail: failed.length ? failed.join("; ") : "integration passed (checks, contracts and merge clean)",
          ...(integ ? { contractChecks: integ.contractChecks, checks: integ.checks } : {}),
        };
      }
      if (Date.now() > deadline) throw new Error(`integration of ${p.proposalId} (job ${job.jobId}) did not finish in time`);
      await sleep(pollMs);
    }
  };
}
