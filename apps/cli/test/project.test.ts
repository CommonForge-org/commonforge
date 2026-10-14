import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORG, PROJECT } from "./fake-commonforge.js";
import { harness, loginAs, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(async () => {
  h = harness();
  h.world.addResource("website", { "index.html": "<h1>hi</h1>\n" });
  h.world.addResource("api", { "src/quote.ts": "export const quote = 1;\n" });
  await loginAs(h);
});
afterEach(() => h.world.close());

describe("cforge project / task", () => {
  it("lists and shows projects, picking the only org automatically", async () => {
    const list = await h.cli(["project", "list", "--json"]);
    expect(list.json()).toEqual({ orgId: ORG, projects: [expect.objectContaining({ projectId: PROJECT })] });
    const show = await h.cli(["project", "show", PROJECT]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("website");
    expect(show.stdout).toContain("api");
  });

  it("requires --org when the user has several", async () => {
    h.world.memberships.push({ orgId: "o-000000000002", name: "Other", role: "developer" });
    const r = await h.cli(["project", "list", "--json"]);
    expect(r.json().error.code).toBe("org_required");
    expect((await h.cli(["project", "list", "--json", "--org", ORG])).code).toBe(0);
  });

  it("creates a task and lists it", async () => {
    const r = await h.cli(["task", "create", PROJECT, "--title", "Change quote", "--write", "api", "--json"]);
    expect(r.code).toBe(0);
    const taskId = r.json().taskId;
    const tasks = await h.cli(["project", "tasks", PROJECT, "--json"]);
    expect(tasks.json().tasks.map((t: { taskId: string }) => t.taskId)).toContain(taskId);
  });

  it("creates a task without --write, leaving the folders to the project's access settings", async () => {
    const r = await h.cli(["task", "create", PROJECT, "--title", "Holiday hours", "--request", "Closed on the 25th", "--json"]);
    expect(r.code, r.stdout).toBe(0);
    const post = h.world.calls.find((c) => c.method === "POST" && c.path.endsWith(`/projects/${PROJECT}/tasks`))!;
    expect(post.body).toEqual({ title: "Holiday hours", request: "Closed on the 25th" });
    expect((await h.cli(["task", "create", PROJECT, "--json"])).json().error.code).toBe("invalid_arguments");
  });

  it("takes a lease, stores it 0600, never prints it unless --print-token, and reuses it", async () => {
    const t = h.world.createTask("x", ["api"]);
    const r = await h.cli(["task", "lease", t.taskId, "--json"]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ taskId: t.taskId, leaseGeneration: 1, reused: false });
    expect(r.stdout).not.toContain("cfl_");
    const file = join(h.configDir, "leases", `${t.taskId}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).leaseToken).toBe(t.lease!.token);

    const again = await h.cli(["task", "lease", t.taskId, "--json"]);
    expect(again.json()).toMatchObject({ reused: true, leaseGeneration: 1 });
    const shown = await h.cli(["task", "lease", t.taskId, "--print-token"]);
    expect(shown.stdout.trim()).toBe(t.lease!.token);

    expect((await h.cli(["task", "release", t.taskId, "--json"])).code).toBe(0);
    expect(t.lease).toBeNull();
  });

  it("validates --ttl against the Worker's 300..28800 s bounds", async () => {
    const t = h.world.createTask("x", ["api"]);
    for (const ttl of ["60", "99999"]) expect((await h.cli(["task", "lease", t.taskId, "--ttl", ttl, "--json"])).json().error.code).toBe("invalid_arguments");
    expect((await h.cli(["task", "lease", t.taskId, "--ttl", "600", "--json"])).code).toBe(0);
  });
});
