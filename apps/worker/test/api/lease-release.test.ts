/** Follow-up (live finding): releasing a lease after the last write workspace froze must succeed, idempotently. */
import { describe, expect, it } from "vitest";
import { freezeAndPropose, harness, provisionedTask } from "../helpers.js";

describe("lease release after submit", () => {
  it("succeeds when the task's reference copies were already collected (deleted repos), and again on repeat", async () => {
    const h = harness();
    const { o, taskId } = await provisionedTask(h);
    await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    const task = (await h.api("GET", `/api/tasks/${taskId}`, { token: o.token })).body;
    const ref = task.workspaces.find((w: { access: string }) => w.access === "read");
    expect(ref.state).toBe("collected");
    for (let i = 0; i < 2; i++) {
      const r = await h.api("DELETE", `/api/tasks/${taskId}/lease`, { token: o.token });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
  });

  it("skips a reference copy whose repository is already gone even if not marked collected", async () => {
    const h = harness();
    const { o, taskId } = await provisionedTask(h);
    await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} });
    const { env } = await import("cloudflare:workers");
    const { createServices } = await import("../../src/context.js");
    const task = (await h.api("GET", `/api/tasks/${taskId}`, { token: o.token })).body;
    const ref = task.workspaces.find((w: { access: string }) => w.access === "read");
    const handle = await createServices(env, h.deps).ledger(o.orgId).getWorkspace(ref.taskWorkspaceId);
    await h.artifacts.deleteRepo(handle!.coords.namespace, handle!.coords.repoName);
    expect((await h.api("DELETE", `/api/tasks/${taskId}/lease`, { token: o.token })).status).toBe(200);
  });
});
