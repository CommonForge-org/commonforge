/**
 * Sandbox egress gateway policy (apps/runner/README.md "Requirements for Task 22"):
 * 1. only the job's repositories on the Artifacts host; 2. upload-pack for every job repo,
 * receive-pack only for write repos and only one update to an allowed ref with the job's lease
 * (no atomic, no push options, no deletes); 3. nothing after the job's expiry; control-plane
 * calls limited to results/evidence/heads/blobs (never the broker); release-deploy API scope.
 */
import { describe, expect, it } from "vitest";
import {
  checkNetworkFor,
  uploadBindingsProblem,
  checkReceivePack,
  controlPathAllowed,
  decideCloudflareApi,
  decideGitRequest,
  decideNpmRequest,
  guardReceivePack,
  parseReceivePackCommands,
  ZERO_SHA,
  type ArtifactsGatewayProps,
  type GatewayRepo,
} from "../src/sandbox/gateway.js";

const HOST = "0123456789abcdef0123456789abcdef.artifacts.cloudflare.net";
const canonical: GatewayRepo = {
  path: "/git/commonforge-dev-o-1-canonical/res-web.git",
  token: "art_v2_canonical",
  write: true,
  pushes: [{ ref: "refs/commonforge/integrations/prop-1/job-1", lease: "absent" }],
};
const reference: GatewayRepo = { path: "/git/commonforge-dev-o-1-canonical/res-api.git", token: "art_v2_ref", write: false, pushes: [] };
const KEY = "k".repeat(64);
const props: ArtifactsGatewayProps = { jobId: "job-1", expiresAt: Date.now() + 60_000, host: HOST, repos: [canonical, reference], runnerKey: KEY };
const u = (p: string) => new URL(`https://${HOST}${p}`);
const A = "a".repeat(40);
const B = "b".repeat(40);

function pkt(line: string): string {
  return (line.length + 4).toString(16).padStart(4, "0") + line;
}
const push = (lines: string[], pack = "PACK....") => new TextEncoder().encode(lines.map(pkt).join("") + "0000" + pack);

describe("git requests", () => {
  it("allows only the job's repos and services", () => {
    expect(decideGitRequest(props, "GET", u(`${canonical.path}/info/refs?service=git-upload-pack`), Date.now(), KEY)).toMatchObject({ ok: true, service: "upload-pack" });
    expect(decideGitRequest(props, "GET", u(`${canonical.path}/info/refs?service=git-receive-pack`), Date.now(), KEY)).toMatchObject({ ok: true, service: "receive-pack" });
    expect(decideGitRequest(props, "POST", u(`${reference.path}/git-upload-pack`), Date.now(), KEY)).toMatchObject({ ok: true });
    // read-only reference: no receive-pack
    expect(decideGitRequest(props, "GET", u(`${reference.path}/info/refs?service=git-receive-pack`), Date.now(), KEY).ok).toBe(false);
    expect(decideGitRequest(props, "POST", u(`${reference.path}/git-receive-pack`), Date.now(), KEY).ok).toBe(false);
    // other repos, other hosts, other paths, after expiry
    expect(decideGitRequest(props, "GET", u(`/git/commonforge-dev-o-2-canonical/res-web.git/info/refs?service=git-upload-pack`), Date.now(), KEY).ok).toBe(false);
    expect(decideGitRequest(props, "GET", new URL(`https://github.com${canonical.path}/info/refs?service=git-upload-pack`), Date.now(), KEY).ok).toBe(false);
    expect(decideGitRequest(props, "GET", u(`/v4/accounts/x/artifacts/namespaces`), Date.now(), KEY).ok).toBe(false);
    expect(decideGitRequest(props, "GET", u(`${canonical.path}/info/refs?service=git-upload-pack`), props.expiresAt, KEY).ok).toBe(false);
  });

  it("parses the receive-pack command section", () => {
    const p = parseReceivePackCommands(push([`${ZERO_SHA} ${A} refs/commonforge/integrations/prop-1/job-1\0report-status side-band-64k agent=git/2.47`]));
    expect(p).toMatchObject({ complete: true, ok: true, commands: [{ oldSha: ZERO_SHA, newSha: A, ref: "refs/commonforge/integrations/prop-1/job-1" }], capabilities: ["report-status", "side-band-64k", "agent=git/2.47"] });
    expect(parseReceivePackCommands(new TextEncoder().encode("00"))).toEqual({ complete: false });
  });

  it.each([
    ["the allowed ref with the absent lease", [`${ZERO_SHA} ${A} refs/commonforge/integrations/prop-1/job-1\0report-status`], true],
    ["another ref", [`${ZERO_SHA} ${A} refs/heads/main\0report-status`], false],
    ["an existing ref (lease absent)", [`${B} ${A} refs/commonforge/integrations/prop-1/job-1\0report-status`], false],
    ["a delete", [`${A} ${ZERO_SHA} refs/commonforge/integrations/prop-1/job-1\0report-status delete-refs`], false],
    ["two refs", [`${ZERO_SHA} ${A} refs/commonforge/integrations/prop-1/job-1\0report-status`, `${ZERO_SHA} ${A} refs/heads/main`], false],
    ["atomic", [`${ZERO_SHA} ${A} refs/commonforge/integrations/prop-1/job-1\0report-status atomic`], false],
    ["push options", [`${ZERO_SHA} ${A} refs/commonforge/integrations/prop-1/job-1\0report-status push-options`], false],
  ])("receive-pack: %s", async (_label, lines, ok) => {
    const r = await guardReceivePack(new Response(push(lines)).body, canonical);
    expect(r.ok).toBe(ok);
    if (r.ok) expect(await new Response(r.body).text()).toBe(new TextDecoder().decode(push(lines))); // replays every byte
  });

  it("expected leases (reconcile-ref) must match exactly", () => {
    const repo: GatewayRepo = { ...canonical, pushes: [{ ref: "refs/heads/main", lease: "expected", expectedSha: B }] };
    const cmd = (old: string) => ({ commands: [{ oldSha: old, newSha: A, ref: "refs/heads/main" }], capabilities: [] });
    expect(checkReceivePack(repo, cmd(B)).ok).toBe(true);
    expect(checkReceivePack(repo, cmd(A)).ok).toBe(false);
    expect(checkReceivePack(repo, cmd(ZERO_SHA)).ok).toBe(false);
    const absentMain: GatewayRepo = { ...canonical, pushes: [{ ref: "refs/heads/main", lease: "expected", expectedSha: null }] };
    expect(checkReceivePack(absentMain, cmd(ZERO_SHA)).ok).toBe(true);
  });
});

describe("control plane and Cloudflare API", () => {
  it("containers may post results and use blobs, never the broker", () => {
    expect(controlPathAllowed("POST", "/api/runner/results")).toBe(true);
    expect(controlPathAllowed("PUT", "/api/runner/blobs/org%2Fo-1%2Fpreviews%2Fx")).toBe(true);
    expect(controlPathAllowed("POST", "/api/runner/credential")).toBe(false);
    expect(controlPathAllowed("POST", "/api/runner/credential/revoke")).toBe(false);
    expect(controlPathAllowed("POST", "/api/runner/deploy-credential")).toBe(false);
    expect(controlPathAllowed("POST", "/api/runner/jobs/next")).toBe(false);
    expect(controlPathAllowed("GET", "/api/me")).toBe(false);
  });

  it("release-deploy: only the job's Workers on the job's account, token swapped in for the placeholder", () => {
    const p = { jobId: "job-d", expiresAt: Date.now() + 60_000, accountId: "f".repeat(32), workerNames: ["cfapp-o-1-api"], workerPrefix: "cfapp-o-1-", allowedKvIds: [], token: "real", placeholder: "ph" };
    const api = (path: string) => new URL(`https://api.cloudflare.com/client/v4/accounts/${"f".repeat(32)}${path}`);
    expect(decideCloudflareApi(p, "PUT", api("/workers/scripts/cfapp-o-1-api"), "Bearer ph", Date.now())).toEqual({ ok: true, inject: true });
    expect(decideCloudflareApi(p, "GET", api("/workers/subdomain"), "Bearer ph", Date.now())).toEqual({ ok: true, inject: true });
    expect(decideCloudflareApi(p, "POST", api("/workers/assets/upload"), "Bearer jwt-from-session", Date.now())).toEqual({ ok: true, inject: false });
    expect(decideCloudflareApi(p, "PUT", api("/workers/scripts/commonforge-worker"), "Bearer ph", Date.now()).ok).toBe(false);
    expect(decideCloudflareApi(p, "DELETE", new URL(`https://api.cloudflare.com/client/v4/accounts/${"0".repeat(32)}/workers/scripts/cfapp-o-1-api`), "Bearer ph", Date.now()).ok).toBe(false);
    expect(decideCloudflareApi(p, "GET", api("/workers/workers/cfapp-o-1-api"), "Bearer ph", Date.now())).toEqual({ ok: true, inject: true });
    expect(decideCloudflareApi(p, "GET", new URL("https://api.cloudflare.com/client/v4/user/tokens/verify"), "Bearer ph", Date.now())).toEqual({ ok: true, inject: true });
    expect(decideCloudflareApi(p, "GET", new URL("https://api.cloudflare.com/client/v4/user/tokens"), "Bearer ph", Date.now()).ok).toBe(false);
    expect(decideCloudflareApi(p, "GET", api("/workers/workers/commonforge-worker"), "Bearer ph", Date.now()).ok).toBe(false);
    // review C-1: a job naming a platform Worker or another org's Worker is refused outright
    expect(decideCloudflareApi({ ...p, workerNames: ["commonforge-worker"] }, "PUT", api("/workers/scripts/commonforge-worker"), "Bearer ph", Date.now()).ok).toBe(false);
    expect(decideCloudflareApi({ ...p, workerNames: ["cfapp-o-2-api"] }, "PUT", api("/workers/scripts/cfapp-o-2-api"), "Bearer ph", Date.now()).ok).toBe(false);
    expect(decideCloudflareApi(p, "PUT", api("/workers/scripts/cfapp-o-1-api"), "Bearer ph", p.expiresAt).ok).toBe(false);
  });
});

describe("review I-3: only the runner process gets through", () => {
  it("a recipe/check step (no runner key) cannot fetch the job's canonical repository through the injected bearer", () => {
    const url = u(`${canonical.path}/info/refs?service=git-upload-pack`);
    expect(decideGitRequest(props, "GET", url, Date.now(), null)).toMatchObject({ ok: false, status: 403 });
    expect(decideGitRequest(props, "GET", url, Date.now(), "x".repeat(64)).ok).toBe(false);
    expect(decideGitRequest(props, "POST", u(`${reference.path}/git-upload-pack`), Date.now(), null).ok).toBe(false);
    expect(decideGitRequest(props, "GET", url, Date.now(), KEY).ok).toBe(true);
  });
});

describe("review C-1: upload bindings", () => {
  const meta = (bindings: unknown[]) => JSON.stringify({ main_module: "index.js", bindings });
  async function multipart(bindings: unknown[]) {
    const fd = new FormData();
    fd.append("metadata", new Blob([meta(bindings)], { type: "application/json" }), "metadata.json");
    fd.append("index.js", new Blob(["export default {}"], { type: "application/javascript+module" }), "index.js");
    const r = new Request("https://x.invalid/", { method: "PUT", body: fd });
    return { ct: r.headers.get("content-type")!, body: await r.arrayBuffer() };
  }
  it("allows plain vars and the job's own KV; refuses other KV ids and other binding types", async () => {
    const own = "a".repeat(32);
    const ok = await multipart([{ type: "plain_text", name: "APP_VERSION", text: "1" }, { type: "kv_namespace", name: "ORDERS", namespace_id: own }]);
    expect(await uploadBindingsProblem(ok.ct, ok.body, [own])).toBeNull();
    const foreign = await multipart([{ type: "kv_namespace", name: "ORDERS", namespace_id: "b".repeat(32) }]);
    expect(await uploadBindingsProblem(foreign.ct, foreign.body, [own])).toMatch(/not one this release may bind/);
    for (const type of ["service", "r2_bucket", "durable_object_namespace", "secret_text"]) {
      const m = await multipart([{ type, name: "X" }]);
      expect(await uploadBindingsProblem(m.ct, m.body, [own]), type).toMatch(/not allowed/);
    }
    expect(await uploadBindingsProblem("application/json", new TextEncoder().encode(JSON.stringify({ bindings: [{ type: "service", name: "S", service: "commonforge-worker" }] })).buffer as ArrayBuffer, [own])).toMatch(/not allowed/);
    expect(await uploadBindingsProblem("application/json", new TextEncoder().encode("{}").buffer as ArrayBuffer, [own])).toBeNull();
  });

  it("allows a d1 binding only for the job's own database ids", async () => {
    const id = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
    const body = new TextEncoder().encode(JSON.stringify({ bindings: [{ type: "d1", name: "DB", id }] })).buffer as ArrayBuffer;
    expect(await uploadBindingsProblem("application/json", body, [], [id])).toBeNull();
    expect(await uploadBindingsProblem("application/json", body, [], [])).toMatch(/D1 database .* is not one this release may bind/);
    expect(await uploadBindingsProblem("application/json", body, [])).toMatch(/D1 database .* is not one this release may bind/);
    expect(await uploadBindingsProblem("application/json", body, [], ["1f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"])).toMatch(/is not one this release may bind/);
    // inside a multipart metadata part too, next to an allowed KV binding
    const m = await multipart([{ type: "kv_namespace", name: "ORDERS", namespace_id: "a".repeat(32) }, { type: "d1", name: "DB", id }]);
    expect(await uploadBindingsProblem(m.ct, m.body, ["a".repeat(32)], [id])).toBeNull();
    expect(await uploadBindingsProblem(m.ct, m.body, ["a".repeat(32)], [])).toMatch(/D1 database/);
  });
});

describe("review m-a: API allowlist and upload inspection", () => {
  const p = { jobId: "job-d", expiresAt: Date.now() + 60_000, accountId: "f".repeat(32), workerNames: ["cfapp-o-1-api"], workerPrefix: "cfapp-o-1-", allowedKvIds: ["a".repeat(32)], token: "real", placeholder: "ph" };
  const api = (path: string) => new URL(`https://api.cloudflare.com/client/v4/accounts/${"f".repeat(32)}/workers/scripts/cfapp-o-1-api${path}`);
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).buffer as ArrayBuffer;

  it("allows only the data-only deploy calls; never secrets, tails or settings changes", () => {
    for (const [m, path] of [["PUT", ""], ["POST", "/versions"], ["POST", "/deployments"], ["POST", "/assets-upload-session"], ["POST", "/subdomain"], ["PUT", "/schedules"], ["GET", "/settings"], ["GET", "/deployments"], ["GET", "/secrets"]] as const) {
      expect(decideCloudflareApi(p, m, api(path), "Bearer ph", Date.now()).ok, `${m} ${path}`).toBe(true);
    }
    for (const [m, path] of [["PATCH", "/settings"], ["PUT", "/secrets"], ["DELETE", "/secrets/X"], ["POST", "/tails"], ["GET", "/tails"], ["DELETE", ""], ["PUT", "/routes"], ["PATCH", "/script-settings"]] as const) {
      expect(decideCloudflareApi(p, m, api(path), "Bearer ph", Date.now()).ok, `${m} ${path}`).toBe(false);
    }
    expect(decideCloudflareApi(p, "PATCH", new URL(`https://api.cloudflare.com/client/v4/accounts/${"f".repeat(32)}/workers/workers/cfapp-o-1-api`), "Bearer ph", Date.now()).ok).toBe(false);
  });

  it("inspects bodies whatever their declared type, every multipart part, tail consumers and logpush", async () => {
    const bad = { bindings: [{ type: "service", name: "S", service: "commonforge-worker" }] };
    expect(await uploadBindingsProblem("text/plain", enc(bad), p.allowedKvIds)).toMatch(/not allowed/);
    const fd = new FormData();
    fd.append("settings", new Blob([JSON.stringify(bad)], { type: "application/json" }));
    const r = new Request("https://x.invalid/", { method: "PATCH", body: fd });
    const ct = r.headers.get("content-type")!.replace("multipart/form-data", "Multipart/Form-Data");
    expect(await uploadBindingsProblem(ct, await r.arrayBuffer(), p.allowedKvIds)).toMatch(/not allowed/);
    expect(await uploadBindingsProblem("application/json", enc({ tail_consumers: [{ service: "commonforge-worker" }] }), p.allowedKvIds)).toMatch(/tail consumers/);
    expect(await uploadBindingsProblem("application/json", enc({ metadata: { logpush: true } }), p.allowedKvIds)).toMatch(/logpush/);
    expect(await uploadBindingsProblem("application/octet-stream", new TextEncoder().encode("binary").buffer as ArrayBuffer, p.allowedKvIds)).toMatch(/not accepted/);
    expect(await uploadBindingsProblem("application/json", enc([]), p.allowedKvIds)).toBeNull(); // schedules: []
  });
});

describe("follow-up n-3: large multipart parts", () => {
  const own = "a".repeat(32);
  const bad = { main_module: "index.js", bindings: [{ type: "service", name: "S", service: "commonforge-worker" }] };
  const pad = (o: unknown) => JSON.stringify(o) + " ".repeat(2 * 1024 * 1024); // valid JSON, over 1 MiB
  async function form(parts: Array<[string, Blob, string?]>) {
    const fd = new FormData();
    for (const [n, b, f] of parts) (f ? fd.append(n, b, f) : fd.append(n, b));
    const r = new Request("https://x.invalid/", { method: "PUT", body: fd });
    return [r.headers.get("content-type")!, await r.arrayBuffer()] as const;
  }

  it("inspects a padded metadata (or settings) part with a filename, whatever its size or declared type", async () => {
    for (const [name, type] of [["metadata", "application/json"], ["metadata", "application/octet-stream"], ["Metadata", "text/plain"], ["settings", ""]] as const) {
      const [ct, body] = await form([[name, new Blob([pad(bad)], { type }), "metadata.json"]]);
      expect(await uploadBindingsProblem(ct, body, [own]), `${name} ${type}`).toMatch(/not allowed/);
    }
    // a padded but harmless metadata part still passes; an unreadable one does not
    const [ct, body] = await form([["metadata", new Blob([pad({ main_module: "index.js", bindings: [] })], { type: "application/json" }), "m.json"]]);
    expect(await uploadBindingsProblem(ct, body, [own])).toBeNull();
    const [ct2, body2] = await form([["metadata", new Blob(["not json"], { type: "application/json" }), "m.json"]]);
    expect(await uploadBindingsProblem(ct2, body2, [own])).toMatch(/not JSON/);
  });

  it("allows large module parts, refuses large parts of any other type, and JSON-checks large JSON parts", async () => {
    const big = "x".repeat(2 * 1024 * 1024);
    for (const type of ["application/javascript+module", "text/javascript", "application/wasm", "application/source-map", "application/octet-stream", "text/plain; charset=utf-8"]) {
      const [ct, body] = await form([["metadata", new Blob([JSON.stringify({ main_module: "index.js", bindings: [] })], { type: "application/json" }), "metadata.json"], ["index.js", new Blob([big], { type }), "index.js"]]);
      expect(await uploadBindingsProblem(ct, body, [own]), type).toBeNull();
    }
    const [ct, body] = await form([["blob", new Blob([big], { type: "image/png" }), "x.png"]]);
    expect(await uploadBindingsProblem(ct, body, [own])).toMatch(/too large to inspect/);
    const [ct3, body3] = await form([["data.json", new Blob([pad(bad)], { type: "application/json" }), "data.json"]]);
    expect(await uploadBindingsProblem(ct3, body3, [own])).toMatch(/not allowed/);
  });
});

describe("follow-up: the integrate dependency install's npm path", () => {
  const key = "c".repeat(64);
  const url = new URL("http://registry.npmjs.org/hono");
  const now = Date.now();

  it("integrate jobs: registry reads only with the per-job npm key (the runner's install), never without it", () => {
    const p = { expiresAt: now + 60_000, npmKey: key };
    expect(decideNpmRequest(p, "GET", url, `Bearer ${key}`, now)).toEqual({ ok: true });
    expect(decideNpmRequest(p, "HEAD", new URL("http://registry.npmjs.org/hono/-/hono-4.13.13.tgz"), `bearer ${key}`, now)).toEqual({ ok: true });
    for (const auth of [null, "", `Bearer ${"d".repeat(64)}`, `Bearer ${key.slice(1)}`, key, `Basic ${key}`]) {
      expect(decideNpmRequest(p, "GET", url, auth, now).ok, String(auth)).toBe(false);
    }
    expect(decideNpmRequest(p, "PUT", url, `Bearer ${key}`, now).ok).toBe(false);
    expect(decideNpmRequest(p, "GET", new URL("http://evil.example/hono"), `Bearer ${key}`, now).ok).toBe(false);
    expect(decideNpmRequest(p, "GET", url, `Bearer ${key}`, now + 60_000).ok).toBe(false);
  });

  it("build jobs (preview/release recipes) keep anonymous registry reads", () => {
    const p = { expiresAt: now + 60_000 };
    expect(decideNpmRequest(p, "GET", url, null, now)).toEqual({ ok: true });
    expect(decideNpmRequest(p, "POST", url, null, now).ok).toBe(false);
  });
});

describe("follow-up Task 23: check network per job", () => {
  const coords = (repoName: string) => ({ kind: "artifacts" as const, namespace: "commonforge-dev-o-1-canonical", repoName, repoId: repoName, remoteUrl: `https://${HOST}/git/commonforge-dev-o-1-canonical/${repoName}.git` });
  const integrate = (targets: unknown[], extra: Record<string, unknown> = {}) =>
    ({ kind: "integrate", proposalId: "prop-1", proposalHash: "d".repeat(64), candidates: [], targets, references: [{ resourceId: "res-web", coords: coords("res-web") }], integrationRef: "refs/commonforge/integrations/prop-1/job-1", checks: [], contracts: [], ...extra }) as never;
  const preview = { kind: "preview-build", previewId: "pv-1", integrationSha: {}, sources: [{ resourceId: "res-web", mountName: "web", canonical: coords("res-web") }], recipe: { recipeId: "r", revision: 1, steps: [] } } as never;

  it("assets-only integrate jobs (no write repository) run their checks with no network too", () => {
    expect(checkNetworkFor(integrate([], { assetChanges: [{ resourceId: "res-brand", baseManifestId: "a".repeat(64), newManifestId: "b".repeat(64) }] }), true)).toBe("none");
    expect(checkNetworkFor(integrate([{ resourceId: "res-api", canonical: coords("res-api"), expectedHead: `art:res-api:${"a".repeat(40)}` }]), true)).toBe("none");
    // read-only build jobs keep the gateway-limited network; nothing is "none" without namespaces
    expect(checkNetworkFor(preview, true)).toBe("inherit");
    expect(checkNetworkFor(integrate([]), false)).toBe("inherit");
  });
});
