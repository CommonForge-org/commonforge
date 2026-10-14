/**
 * Authorization matrix (plan §F): every principal against the core read/mutate routes.
 * 404 = the object does not exist for the caller (no existence leak); 403 = visible but not allowed;
 * 401 = no credential. `null` = not exercised for that principal (it would mutate shared fixture state).
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MAX_CONCURRENT_OPS } from "../../src/services/ops-gate.js";
import { email, freezeAndPropose, harness, member, provisionedTask } from "../helpers.js";

type Who = "owner" | "dev" | "devNoGrant" | "devReadOnly" | "client" | "clientNoRes" | "viewer" | "stranger" | "anon" | "agent";
const WHO: Who[] = ["owner", "dev", "devNoGrant", "devReadOnly", "client", "clientNoRes", "viewer", "stranger", "anon", "agent"];
/** keys that are canonical/task-repo coordinates; never in a client/viewer response */
const COORD_KEYS = ["remoteUrl", "namespace", "repoName", "repoId", "fork", "coords"];

describe("authz matrix (AT-16, AT-25 negatives)", () => {
  it("each principal gets exactly the expected status on each route", async () => {
    const h = harness();
    const { o, pid, web, taskId } = await provisionedTask(h);
    // the agent's lease is still current; its only workspace is frozen, so the task is "submitted"
    const { proposal, agent } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    const dev = await member(h, o, "developer");
    const devNo = await member(h, o, "developer");
    const client = await member(h, o, "client");
    const viewer = await member(h, o, "viewer");
    const devRo = await member(h, o, "developer");
    const clientNoRes = await member(h, o, "client");
    const grant = (userId: string, kind: string, id: string, operations: string[]) => h.api("PUT", `/api/orgs/${o.orgId}/grants`, { token: o.token, body: { userId, scope: { kind, id }, operations } });
    await grant(dev.userId, "project", pid, ["read"]);
    await grant(dev.userId, "resource", web.resourceId, ["read", "write"]);
    for (const u of [client, viewer]) {
      await grant(u.userId, "project", pid, ["read"]);
      await grant(u.userId, "resource", web.resourceId, ["read"]);
    }
    // project READ only, no resource grants
    await grant(devRo.userId, "project", pid, ["read"]);
    await grant(clientNoRes.userId, "project", pid, ["read"]);
    const stranger = await h.signIn(email("stranger"));
    const tokens: Record<Who, string | undefined> = { owner: o.token, dev: dev.token, devNoGrant: devNo.token, devReadOnly: devRo.token, client: client.token, clientNoRes: clientNoRes.token, viewer: viewer.token, stranger, anon: undefined, agent };
    const wsId = (await h.api("GET", `/api/tasks/${taskId}`, { token: o.token })).body.workspaces.find((w: any) => w.mountName === "website").taskWorkspaceId;

    const O = `/api/orgs/${o.orgId}`;
    const rows: Array<[string, string, unknown, Record<Who, number | null>]> = [
      ["GET", `${O}`, undefined, { owner: 200, dev: 200, devNoGrant: 200, devReadOnly: 200, client: 200, clientNoRes: 200, viewer: 200, stranger: 404, anon: 401, agent: 403 }],
      ["GET", `${O}/projects/${pid}`, undefined, { owner: 200, dev: 200, devNoGrant: 404, devReadOnly: 200, client: 200, clientNoRes: 200, viewer: 200, stranger: 404, anon: 401, agent: 403 }],
      ["GET", `${O}/projects/${pid}/tree?mount=website`, undefined, { owner: 200, dev: 200, devNoGrant: 404, devReadOnly: 404, client: 200, clientNoRes: 404, viewer: 200, stranger: 404, anon: 401, agent: 403 }],
      ["GET", `${O}/projects/${pid}/tree?mount=api`, undefined, { owner: 200, dev: 404, devNoGrant: 404, devReadOnly: 404, client: 404, clientNoRes: 404, viewer: 404, stranger: 404, anon: 401, agent: 403 }],
      ["GET", `${O}/resources/${web.resourceId}`, undefined, { owner: 200, dev: 200, devNoGrant: 404, devReadOnly: 404, client: 200, clientNoRes: 404, viewer: 200, stranger: 404, anon: 401, agent: 403 }],
      ["GET", `/api/tasks/${taskId}`, undefined, { owner: 200, dev: 404, devNoGrant: 404, devReadOnly: 404, client: 404, clientNoRes: 404, viewer: 404, stranger: 404, anon: 401, agent: 200 }],
      ["POST", `/api/tasks/${taskId}/credential`, { mountName: "api", access: "read" }, { owner: 403, dev: 403, devNoGrant: 403, devReadOnly: 403, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 409 }],
      ["GET", `/api/tasks/${taskId}/assets/file?mount=api&path=src/index.ts`, undefined, { owner: 403, dev: 403, devNoGrant: 403, devReadOnly: 403, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 409 }],
      ["POST", `/api/tasks/${taskId}/lease`, {}, { owner: null, dev: 404, devNoGrant: 404, devReadOnly: 404, client: 404, clientNoRes: 404, viewer: 404, stranger: 404, anon: 401, agent: 403 }],
      ["POST", `/api/tasks/${taskId}/workspaces/${wsId}/freeze`, { expectedSha: "a".repeat(40) }, { owner: null, dev: 404, devNoGrant: 404, devReadOnly: 404, client: 404, clientNoRes: 404, viewer: 404, stranger: 404, anon: 401, agent: 409 }],
      ["GET", `${O}/proposals/${proposal.proposalId}`, undefined, { owner: 200, dev: 200, devNoGrant: 404, devReadOnly: 404, client: 200, clientNoRes: 404, viewer: 200, stranger: 404, anon: 401, agent: 403 }],
      ["POST", `${O}/proposals/${proposal.proposalId}/approvals`, { proposalHash: proposal.proposalHash }, { owner: 201, dev: 201, devNoGrant: 404, devReadOnly: 404, client: 201, clientNoRes: 404, viewer: 403, stranger: 404, anon: 401, agent: 403 }],
      ["POST", `${O}/proposals/${proposal.proposalId}/accept`, { idempotencyKey: "matrix-accept" }, { owner: null, dev: null, devNoGrant: 404, devReadOnly: 404, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 403 }],
      ["POST", `${O}/proposals/${proposal.proposalId}/integrate`, undefined, { owner: null, dev: null, devNoGrant: 404, devReadOnly: 404, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 403 }],
      ["POST", `${O}/resources/${web.resourceId}/restore`, { expectedHead: web.revisionId, targetRevision: web.revisionId, idempotencyKey: "matrix-restore" }, { owner: null, dev: null, devNoGrant: 404, devReadOnly: 404, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 403 }],
      ["POST", `${O}/projects/${pid}/tasks`, { title: "x", writeMounts: ["website"] }, { owner: null, dev: null, devNoGrant: 404, devReadOnly: 404, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 403 }],
      ["POST", `${O}/projects/${pid}/exports`, undefined, { owner: null, dev: 403, devNoGrant: 404, devReadOnly: 403, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 403 }],
      ["PUT", `${O}/projects/${pid}/policy`, { checks: [] }, { owner: null, dev: 403, devNoGrant: 403, devReadOnly: 403, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 403 }],
      ["DELETE", `${O}/projects/${pid}/mounts/website`, undefined, { owner: null, dev: 403, devNoGrant: 403, devReadOnly: 403, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 403 }],
      ["GET", `${O}/audit`, undefined, { owner: 200, dev: 403, devNoGrant: 403, devReadOnly: 403, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 403 }],
      ["POST", `${O}/members`, { email: email("new"), role: "viewer" }, { owner: null, dev: 403, devNoGrant: 403, devReadOnly: 403, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 403 }],
      ["POST", `${O}/intake/url`, { url: "https://github.com/a/b.git", branch: "main", name: "x" }, { owner: null, dev: null, devNoGrant: null, devReadOnly: null, client: 403, clientNoRes: 403, viewer: 403, stranger: 404, anon: 401, agent: 403 }],
    ];
    const failures: string[] = [];
    for (const [method, path, body, expected] of rows) {
      for (const who of WHO) {
        const want = expected[who];
        if (want === null) continue;
        const r = await h.api(method, path, { ...(tokens[who] ? { token: tokens[who] } : {}), ...(body !== undefined ? { body } : {}) });
        if (r.status !== want) failures.push(`${who} ${method} ${path} → ${r.status} (want ${want}) ${JSON.stringify(r.body?.error ?? "")}`);
        const text = JSON.stringify(r.body ?? "");
        if (["client", "clientNoRes", "viewer"].includes(who)) {
          if (text.includes("artifacts.cloudflare.net") || text.includes(`-${o.orgId}-canonical`) || text.includes(`-${o.orgId}-tasks`)) failures.push(`${who} ${method} ${path} leaked repository coordinates`);
          for (const k of COORD_KEYS) if (text.includes(`"${k}":`)) failures.push(`${who} ${method} ${path} has a "${k}" key`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("OpsGate (A9: <= 25 concurrent fork/token ops per namespace)", () => {
  it("caps slots, frees on release and expiry, and keeps per-key locks exclusive", async () => {
    const gate = env.OPS_GATE.get(env.OPS_GATE.idFromName(`ns:test-${crypto.randomUUID()}`));
    const tickets: string[] = [];
    for (let i = 0; i < MAX_CONCURRENT_OPS; i++) tickets.push((await gate.acquire())!);
    expect(tickets.every(Boolean)).toBe(true);
    expect(await gate.acquire()).toBeNull();
    await gate.release(tickets[0]!);
    expect(await gate.acquire()).not.toBeNull();
    expect(await gate.acquire(MAX_CONCURRENT_OPS + 1, 1)).not.toBeNull(); // 1 ms lease
    await new Promise((r) => setTimeout(r, 5));
    expect(await gate.held()).toBe(MAX_CONCURRENT_OPS);
    expect(await gate.lock("ws-1", "a", 60_000)).toBe(true);
    expect(await gate.lock("ws-1", "b", 60_000)).toBe(false);
    await gate.unlock("ws-1", "a");
    expect(await gate.lock("ws-1", "b", 60_000)).toBe(true);
  });
});
