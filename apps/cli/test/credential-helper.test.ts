import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.js";
import { helperConfigEntries, helperValue } from "../src/git.js";
import { matchRemote, parseCredentialRequest } from "../src/credential-helper.js";
import { harness, loginAs, type Harness } from "./helpers.js";

let h: Harness;
let taskId: string;
let record: string;
const WRITE_URL = "https://acct.artifacts.cloudflare.net/git/cf-o1-tasks/ws-tw-1.git";
const READ_URL = "https://acct.artifacts.cloudflare.net/git/cf-o1-tasks/ws-tw-2.git";

function request(url: string, extra = ""): string {
  const u = new URL(url);
  return `protocol=${u.protocol.slice(0, -1)}\nhost=${u.host}\npath=${u.pathname.slice(1)}\n${extra}\n`;
}

beforeEach(async () => {
  h = harness();
  h.world.addResource("api", { "a.txt": "a\n" });
  h.world.addResource("website", { "b.txt": "b\n" });
  await loginAs(h);
  const t = h.world.createTask("t", ["api"]);
  taskId = t.taskId;
  expect((await h.cli(["task", "lease", taskId, "--json"])).code).toBe(0);
  // remotes as they would be on Artifacts; the broker (fake) answers with these URLs
  const [api, web] = t.workspaces;
  h.world.remoteUrl = (_ns, repoName) => (repoName === api!.repoName ? WRITE_URL : repoName === web!.repoName ? READ_URL : "https://other.invalid/x.git");
  record = await new ConfigStore({ ...h.env }).saveCheckout({
    apiUrl: h.world.baseUrl,
    taskId,
    workspaceRoot: "/tmp/ws",
    createdAt: new Date().toISOString(),
    mounts: [
      { mountName: "api", remoteUrl: WRITE_URL, writable: true, credential: "helper", taskWorkspaceId: api!.taskWorkspaceId, baseSha: "a".repeat(40) },
      { mountName: "website", remoteUrl: READ_URL, writable: false, credential: "helper", baseSha: "b".repeat(40) },
    ],
  });
});
afterEach(() => h.world.close());

const credCalls = () => h.world.calls.filter((c) => c.path.endsWith("/credential"));

describe("cforge credential-helper", () => {
  it("answers git with a fresh write token for a writable mount, asked with the lease", async () => {
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(WRITE_URL, "capability[]=authtype\nwwwauth[]=Basic realm=x") });
    expect(r.code).toBe(0);
    const lines = parseCredentialRequest(r.stdout);
    expect(lines.get("username")).toBe("x-token");
    expect(lines.get("password")).toMatch(/^art_v1_/);
    expect(Number(lines.get("password_expiry_utc"))).toBeGreaterThan(Date.now() / 1000);
    expect(credCalls()).toHaveLength(1);
    expect(credCalls()[0]!.body).toEqual({ mountName: "api", access: "write" });
    expect(credCalls()[0]!.auth).toMatch(/^cfl_/);
    // a second git request asks the broker again (nothing cached)
    await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(WRITE_URL) });
    expect(credCalls()).toHaveLength(2);
  });

  it("review I2: retries a transient 503 provider_unavailable, then answers git", async () => {
    h.world.credentialOutages = 2;
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(WRITE_URL) });
    expect(parseCredentialRequest(r.stdout).get("password")).toMatch(/^art_v1_/);
    expect(credCalls()).toHaveLength(3);
    expect(r.stderr).toContain("temporarily unavailable, retrying (1/3)");
  });

  it("review I2: gives up after three retries", async () => {
    h.world.credentialOutages = 10;
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(WRITE_URL) });
    expect(r.stdout).toBe("quit=1\n");
    expect(credCalls()).toHaveLength(4);
  });

  it("asks for read on reference copies", async () => {
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(READ_URL) });
    expect(parseCredentialRequest(r.stdout).get("password")).toMatch(/^art_v1_/);
    expect(credCalls()[0]!.body).toEqual({ mountName: "website", access: "read" });
  });

  it("falls back to read once the workspace is frozen", async () => {
    h.world.tasks.get(taskId)!.workspaces[0]!.state = "frozen";
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(WRITE_URL) });
    expect(parseCredentialRequest(r.stdout).get("password")).toMatch(/^art_v1_/);
    expect(credCalls().map((c) => (c.body as { access: string }).access)).toEqual(["write", "read"]);
  });

  it.each([
    ["another host", "https://evil.example/git/cf-o1-tasks/ws-tw-1.git"],
    ["another repository on the same host", "https://acct.artifacts.cloudflare.net/git/cf-o1-canonical/res-1.git"],
    ["another scheme", "http://acct.artifacts.cloudflare.net/git/cf-o1-tasks/ws-tw-1.git"],
  ])("refuses %s without calling the broker", async (_name, url) => {
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(url) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("quit=1\n");
    expect(r.stderr).toMatch(/not a remote of/);
    expect(credCalls()).toHaveLength(0);
  });

  it("refuses a request without a path (useHttpPath off)", async () => {
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: "protocol=https\nhost=acct.artifacts.cloudflare.net\n\n" });
    expect(r.stdout).toBe("quit=1\n");
  });

  it("refuses a credential the broker issued for another repository", async () => {
    h.world.overrides.set("POST /api/tasks/[^/]+/credential", () => ({ status: 200, body: { tokenId: "t", secret: "art_v1_0123456789abcdef", scope: "write", expiresAt: new Date(Date.now() + 60_000).toISOString(), remoteUrl: READ_URL } }));
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(WRITE_URL) });
    expect(r.stdout).toBe("quit=1\n");
    expect(r.stderr).not.toContain("art_v1_0123456789abcdef");
  });

  it("uses CFORGE_LEASE_TOKEN when an agent is handed a lease, and refuses without any lease", async () => {
    const lease = h.world.tasks.get(taskId)!.lease!.token;
    await h.cli(["task", "release", taskId]);
    const none = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(WRITE_URL) });
    expect(none.stdout).toBe("quit=1\n");
    expect(none.stderr).toMatch(/no live lease/);
    // a fresh lease handed over through the environment
    const t = h.world.tasks.get(taskId)!;
    t.lease = { token: lease, generation: 9, expiresAt: Date.now() + 600_000, holder: "u" };
    t.state = "running";
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(WRITE_URL), env: { CFORGE_LEASE_TOKEN: lease } });
    expect(parseCredentialRequest(r.stdout).get("password")).toMatch(/^art_v1_/);
  });

  it("finds its record and lease from --record alone, whatever the caller's environment", async () => {
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(WRITE_URL), env: { XDG_CONFIG_HOME: "/nonexistent", HOME: "/nonexistent" } });
    expect(parseCredentialRequest(r.stdout).get("password")).toMatch(/^art_v1_/);
  });

  it("maps a dead lease (401) to the --force hint (I-2)", async () => {
    // a takeover elsewhere bumps the lease: the stored token is no principal any more
    const t = h.world.tasks.get(taskId)!;
    t.lease = { ...t.lease!, token: "cfl_someoneelse0123456789abcdef", generation: 2 };
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(WRITE_URL) });
    expect(r.stdout).toBe("quit=1\n");
    expect(r.stderr).toContain(`cforge task lease ${taskId} --force`);
    expect(r.stderr).not.toMatch(/cfl_[A-Za-z0-9]/);
  });

  it("never sends CFORGE_LEASE_TOKEN to another API than the one it is bound to", async () => {
    const lease = h.world.tasks.get(taskId)!.lease!.token;
    const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: request(WRITE_URL), env: { CFORGE_LEASE_TOKEN: lease, CFORGE_LEASE_API_URL: "https://elsewhere.example" } });
    expect(r.stdout).toBe("quit=1\n");
    expect(r.stderr).toMatch(/belongs to https:\/\/elsewhere\.example/);
    expect(credCalls()).toHaveLength(0);
  });

  it("refuses to hand a token to a plain-http remote that is not localhost", async () => {
    const insecure = "http://git.example.com/git/cf-o1-tasks/ws-tw-1.git";
    const store = new ConfigStore({ ...h.env });
    const rec = (await store.readCheckout(record))!;
    rec.mounts[0]!.remoteUrl = insecure;
    const p2 = await store.saveCheckout({ ...rec, workspaceRoot: "/tmp/ws2" });
    const r = await h.cli(["credential-helper", "--record", p2, "get"], { stdin: request(insecure) });
    expect(r.stdout).toBe("quit=1\n");
    expect(r.stderr).toMatch(/plain http/);
    expect(credCalls()).toHaveLength(0);
  });

  it("store and erase are no-ops", async () => {
    for (const action of ["store", "erase"]) {
      const r = await h.cli(["credential-helper", "--record", record, action], { stdin: request(WRITE_URL, "username=x-token\npassword=art_v1_deadbeefdeadbeef") });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(credCalls()).toHaveLength(0);
  });

  describe("the LFS URL (folders phase 4)", () => {
    let lfsUrl: string;
    let lfsRecord: string;
    const lfsRequest = (path: string) => {
      const u = new URL(lfsUrl);
      return `protocol=${u.protocol.slice(0, -1)}\nhost=${u.host}\npath=${path}\n\n`;
    };
    beforeEach(async () => {
      lfsUrl = `${h.world.baseUrl}/api/lfs/o1/res-api/info/lfs`;
      const store = new ConfigStore({ ...h.env });
      const rec = (await store.readCheckout(record))!;
      rec.mounts[0]!.lfsUrl = lfsUrl;
      lfsRecord = await store.saveCheckout({ ...rec, workspaceRoot: "/tmp/ws-lfs" });
    });

    it.each([
      ["the endpoint", "api/lfs/o1/res-api/info/lfs"],
      ["the endpoint with a leading slash", "/api/lfs/o1/res-api/info/lfs"],
      ["the endpoint with a trailing slash", "api/lfs/o1/res-api/info/lfs/"],
      ["the batch API under it", "api/lfs/o1/res-api/info/lfs/objects/batch"],
      ["the locks API under it", "/api/lfs/o1/res-api/info/lfs/locks/verify"],
    ])("answers %s with the lease token and its expiry, without the broker", async (_n, path) => {
      const r = await h.cli(["credential-helper", "--record", lfsRecord, "get"], { stdin: lfsRequest(path) });
      expect(r.code).toBe(0);
      const lines = parseCredentialRequest(r.stdout);
      const lease = h.world.tasks.get(taskId)!.lease!;
      expect(lines.get("username")).toBe("x-token");
      expect(lines.get("password")).toBe(lease.token);
      expect(Number(lines.get("password_expiry_utc"))).toBe(Math.floor(lease.expiresAt / 1000));
      expect(credCalls()).toHaveLength(0);
    });

    it.each([
      ["another folder's LFS URL", "api/lfs/o1/res-other/info/lfs"],
      ["a sibling with the same prefix", "api/lfs/o1/res-api/info/lfsx"],
      ["a parent of the endpoint", "api/lfs/o1/res-api/info"],
      ["a dot-dot escape", "api/lfs/o1/res-api/info/lfs/../../../res-other/info/lfs"],
      ["an encoded dot-dot escape", "api/lfs/o1/res-api/info/lfs/%2e%2e/x"],
      ["another API route", "api/orgs"],
    ])("refuses %s", async (_n, path) => {
      const r = await h.cli(["credential-helper", "--record", lfsRecord, "get"], { stdin: lfsRequest(path) });
      expect(r.stdout).toBe("quit=1\n");
      expect(credCalls()).toHaveLength(0);
    });

    it("refuses an LFS URL of a mount not in the record (the record without lfsUrl)", async () => {
      const r = await h.cli(["credential-helper", "--record", record, "get"], { stdin: lfsRequest("api/lfs/o1/res-api/info/lfs") });
      expect(r.stdout).toBe("quit=1\n");
    });

    it("refuses another host or scheme", async () => {
      for (const stdin of ["protocol=https\nhost=evil.example\npath=api/lfs/o1/res-api/info/lfs\n\n", "protocol=http\nhost=api.fake.test\npath=api/lfs/o1/res-api/info/lfs\n\n"]) {
        expect((await h.cli(["credential-helper", "--record", lfsRecord, "get"], { stdin })).stdout).toBe("quit=1\n");
      }
    });

    it("refuses an LFS URL that is not on the record's API origin, or over plain http", async () => {
      const store = new ConfigStore({ ...h.env });
      for (const [i, url] of ["https://lfs.elsewhere.example/api/lfs/o1/res-api/info/lfs", "http://api.fake.test/api/lfs/o1/res-api/info/lfs"].entries()) {
        const rec = (await store.readCheckout(record))!;
        rec.mounts[0]!.lfsUrl = url;
        if (url.startsWith("http:")) rec.apiUrl = "http://api.fake.test";
        const p = await store.saveCheckout({ ...rec, workspaceRoot: `/tmp/ws-bad-${i}` });
        const u = new URL(url);
        const r = await h.cli(["credential-helper", "--record", p, "get"], { stdin: `protocol=${u.protocol.slice(0, -1)}\nhost=${u.host}\npath=${u.pathname}\n\n` });
        expect(r.stdout, url).toBe("quit=1\n");
        expect(r.stderr).not.toMatch(/cfl_[A-Za-z0-9]/);
      }
    });

    it("refuses without a live lease, with the lease hint", async () => {
      await h.cli(["task", "release", taskId]);
      const r = await h.cli(["credential-helper", "--record", lfsRecord, "get"], { stdin: lfsRequest("api/lfs/o1/res-api/info/lfs/objects/batch") });
      expect(r.stdout).toBe("quit=1\n");
      expect(r.stderr).toMatch(/no live lease/);
      expect(r.stderr).toContain(`cforge task lease ${taskId}`);
    });

    it("answers with CFORGE_LEASE_TOKEN (no known expiry) when an agent is handed a lease", async () => {
      const r = await h.cli(["credential-helper", "--record", lfsRecord, "get"], { stdin: lfsRequest("api/lfs/o1/res-api/info/lfs/objects/batch"), env: { CFORGE_LEASE_TOKEN: "cfl_handedover0123456789", CFORGE_LEASE_API_URL: h.world.baseUrl } });
      const lines = parseCredentialRequest(r.stdout);
      expect(lines.get("password")).toBe("cfl_handedover0123456789");
      expect(lines.has("password_expiry_utc")).toBe(false);
    });

    it("the git remote of the same mount still goes to the broker", async () => {
      const r = await h.cli(["credential-helper", "--record", lfsRecord, "get"], { stdin: request(WRITE_URL) });
      expect(parseCredentialRequest(r.stdout).get("password")).toMatch(/^art_v1_/);
      expect(credCalls()).toHaveLength(1);
    });
  });

  it("matchRemote is exact on protocol, host (with port) and path", () => {
    const rec = { apiUrl: "x", taskId, workspaceRoot: "/w", createdAt: "", mounts: [{ mountName: "m", remoteUrl: "http://127.0.0.1:8080/git/ns/r.git", writable: true, credential: "helper" as const, baseSha: "" }] };
    const req = (s: string) => parseCredentialRequest(s);
    expect(matchRemote(rec, req("protocol=http\nhost=127.0.0.1:8080\npath=git/ns/r.git\n"))?.mountName).toBe("m");
    expect(matchRemote(rec, req("protocol=http\nhost=127.0.0.1\npath=git/ns/r.git\n"))).toBeNull();
    expect(matchRemote(rec, req("protocol=http\nhost=127.0.0.1:8080\npath=git/ns/r.git/../x.git\n"))).toBeNull();
  });

  it("builds a helper config that resets inherited helpers and never contains a token", () => {
    expect(helperValue(["/usr/bin/node", "/opt/my tools/cforge.js"], "/c/checkouts/t.json")).toBe("/usr/bin/node '/opt/my tools/cforge.js' credential-helper --record /c/checkouts/t.json");
    expect(helperValue(["/opt/node dir/node"], "/c/my dir/t.json")).toBe("/opt/node\\ dir/node credential-helper --record '/c/my dir/t.json'");
    expect(() => helperValue(["node"], "/c/t.json")).toThrow(/absolute/);
    const entries = helperConfigEntries(WRITE_URL, ["/usr/bin/node", "/x/index.js"], "/c/t.json");
    expect(entries[0]).toEqual([`credential.${WRITE_URL}.helper`, ""]);
    expect(entries[2]).toEqual([`credential.${WRITE_URL}.useHttpPath`, "true"]);
  });
});
