/** The task list's hand-off facts: `updatedAt` and `leaseExpiresAt` (the web app's "agent working" line). */
import { describe, expect, it } from "vitest";
import { harness, provisionedTask } from "../helpers.js";

interface Row {
  taskId: string;
  state: string;
  updatedAt: string;
  leaseExpiresAt: string | null;
}

describe("GET …/projects/:pid/tasks", () => {
  it("carries updatedAt and the lease expiry: none before checkout, set while leased, null once released", async () => {
    const h = harness();
    const { o, pid, taskId } = await provisionedTask(h);
    const list = async () => ((await h.api("GET", `/api/orgs/${o.orgId}/projects/${pid}/tasks`, { token: o.token })).body.tasks as Row[]).find((t) => t.taskId === taskId)!;

    const ready = await list();
    expect(ready.state).toBe("ready");
    expect(ready.leaseExpiresAt).toBeNull();
    expect(Number.isNaN(Date.parse(ready.updatedAt))).toBe(false);

    const lease = await h.api("POST", `/api/tasks/${taskId}/lease`, { token: o.token, body: {} });
    expect(lease.status).toBe(200);
    const running = await list();
    expect(running.state).toBe("running");
    expect(running.leaseExpiresAt).toBe(lease.body.expiresAt);
    expect(running.updatedAt >= ready.updatedAt).toBe(true);

    expect((await h.api("DELETE", `/api/tasks/${taskId}/lease`, { token: o.token })).status).toBe(200);
    const released = await list();
    expect(released.leaseExpiresAt).toBeNull();
  });
});
