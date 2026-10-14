/**
 * Task 23 review fixes (found live on CI, B6): a prepare-candidate job that failed with
 * provider_unavailable (Artifacts answered "fatal: expected flush after ref listing" to git
 * ls-remote) gave up at once; the candidate stayed frozen and its proposal "open" forever. The
 * step now retries, issuing a fresh job.
 */
import { describe, expect, it } from "vitest";
import { agentPush, harness, provisionedTask, waitUntil } from "../helpers.js";

const STEPS = "commonforge-steps";

describe("candidate.prepare retries a transient runner failure", () => {
  it("provider_unavailable from prepare-candidate is retried with a new job, then prepares", async () => {
    const h = harness();
    const { runner, o, taskId } = await provisionedTask(h);
    const { agent, ws, sha } = await agentPush(h, o.token, taskId, { "index.html": "v2" });
    runner.opts.fail = { "prepare-candidate": { code: "provider_unavailable", detail: "git ls-remote exited 128: fatal: expected flush after ref listing" } };
    const f = await h.api("POST", `/api/tasks/${taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { token: agent, body: { expectedSha: sha } });
    expect(f.status).toBe(201);
    const cid = f.body.candidateId as string;
    const msg = h.steps.splice(0).find((b: any) => b.type === "candidate.prepare");
    expect(msg).toBeTruthy();
    const prepJobs = () => runner.handled.filter((j) => j.job.kind === "prepare-candidate").length;
    // 1: the job is issued (pending) → retry
    expect((await h.deliver(STEPS, [msg], 1)).retried).toHaveLength(1);
    await waitUntil(async () => prepJobs() === 1);
    await new Promise((r) => setTimeout(r, 20));
    // 2: the job failed provider_unavailable → retried, not given up
    const second = await h.deliver(STEPS, [msg], 2);
    expect(second.retried).toHaveLength(1);
    delete runner.opts.fail;
    for (let attempt = 3; attempt < 8; attempt++) {
      const r = await h.deliver(STEPS, [msg], attempt);
      if (r.acked.length) break;
      await waitUntil(async () => prepJobs() >= 2);
      await new Promise((res) => setTimeout(res, 20));
    }
    const c = await h.api("GET", `/api/orgs/${o.orgId}/candidates/${encodeURIComponent(cid)}`, { token: o.token });
    expect(c.body.state).toBe("prepared");
    expect(prepJobs()).toBeGreaterThanOrEqual(2);
    const evs = (await h.api("GET", `/api/orgs/${o.orgId}/events?limit=500`, { token: o.token })).body.events.map((e: any) => e.action);
    expect(evs).not.toContain("candidate.prepare_failed");
  });
});
