import { describe, expect, it } from "vitest";
import { codeResource, harness, ownerWithOrg, projectWith } from "../helpers.js";

const release = {
  recipe: { recipeId: "api-release", revision: 1, steps: [{ stepId: "build", mountName: "api", command: "pnpm exec wrangler deploy --dry-run --outdir dist" }] },
  targets: [{ targetId: "api", kind: "worker", mountName: "api", outputPath: "dist", main: "index.js", workerName: "" }],
  environment: {},
  healthCheck: { targetId: "api", path: "/version" },
};
const staging = {
  environment: { api: { vars: { APP_ENV: "staging" }, kv: [{ binding: "ORDERS", seed: "seed/orders.json" }], d1: [{ binding: "DB", migrationsDir: "migrations", seed: ["seed/contacts.sql"] }] } },
  captureVars: ["PAYMENT_WEBHOOK_URL"],
  promotion: { rules: [{ paths: ["api/migrations/**"], level: "classify" }], classifier: { provider: "jev", threshold: 0.9 } },
};

async function setup() {
  const h = harness();
  const o = await ownerWithOrg(h);
  const api = await codeResource(h, o, "api", { "src/index.ts": "export default {};\n" });
  const pid = await projectWith(h, o, [{ mountName: "api", resourceId: api.resourceId }]);
  const P = `/api/orgs/${o.orgId}/projects/${pid}`;
  const rel = { ...release, targets: [{ ...release.targets[0]!, workerName: `cfapp-${o.orgId}-api` }] };
  return { h, o, P, rel };
}

describe("policy: staging section", () => {
  it("is saved and returned with the policy", async () => {
    const { h, o, P, rel } = await setup();
    const put = await h.api("PUT", `${P}/policy`, { token: o.token, body: { release: rel, staging } });
    expect(put.status).toBe(200);
    expect(put.body.policy.staging.environment.api.d1[0]).toEqual({ binding: "DB", migrationsDir: "migrations", seed: ["seed/contacts.sql"] });
    expect(put.body.policy.staging.promotion.classifier).toEqual({ provider: "jev", threshold: 0.9 });
  });
  it("needs a release section, known targets, unique bindings and capture vars that are not set by hand", async () => {
    const { h, o, P, rel } = await setup();
    const v = async (body: unknown) => (await h.api("POST", `${P}/policy/validate`, { token: o.token, body })).body.issues.map((i: { path: string }) => i.path);
    expect(await v({ staging })).toContain("staging");
    expect(await v({ release: rel, staging: { ...staging, environment: { web: { vars: {}, kv: [], d1: [] } } } })).toContain("staging.environment.web");
    expect(await v({ release: rel, staging: { ...staging, environment: { api: { vars: {}, kv: [{ binding: "DB" }], d1: [{ binding: "DB" }] } } } })).toContain("staging.environment.api");
    expect(await v({ release: rel, staging: { ...staging, environment: { api: { vars: { PAYMENT_WEBHOOK_URL: "https://pay.example" }, kv: [], d1: [] } } } })).toContain("staging.captureVars");
    expect(await v({ release: rel, staging })).toEqual([]);
  });
  it("refuses a release target whose staging Worker name (<workerName>-staging) would exceed 63 characters", async () => {
    const { h, o, P, rel } = await setup();
    const v = async (body: unknown) => (await h.api("POST", `${P}/policy/validate`, { token: o.token, body })).body.issues as Array<{ path: string; message: string }>;
    const name = (len: number) => `cfapp-${o.orgId}-${"a".repeat(len - `cfapp-${o.orgId}-`.length)}`;
    const long = { ...rel, targets: [{ ...rel.targets[0]!, workerName: name(60) }] };
    // the production name alone is valid; only staging makes it too long
    expect(await v({ release: long })).toEqual([]);
    expect(await v({ release: long, staging })).toEqual([{ path: "release.targets.0.workerName", message: expect.stringMatching(/-staging.*63/) }]);
    expect(await v({ release: { ...rel, targets: [{ ...rel.targets[0]!, workerName: name(55) }] }, staging })).toEqual([]);
    const put = await h.api("PUT", `${P}/policy`, { token: o.token, body: { release: long, staging } });
    expect([put.status, put.body.error.code]).toEqual([400, "invalid_policy"]);
  });
  it("PUT refuses what validate reports", async () => {
    const { h, o, P } = await setup();
    const put = await h.api("PUT", `${P}/policy`, { token: o.token, body: { staging } });
    expect([put.status, put.body.error.code]).toEqual([400, "invalid_policy"]);
  });
});
