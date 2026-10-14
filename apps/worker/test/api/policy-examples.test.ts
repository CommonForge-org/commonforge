/**
 * The web app's "Show example" texts for the JSON policy sections (apps/web/src/lib/policy-examples.ts)
 * are valid as shown: built from a project's real folders and the org's `workerPrefix`, they pass
 * `POST …/policy/validate` (schema, release targets, staging rules), and a save of Release + Staging
 * turns staging on, waiting for the first production publish.
 */
import { describe, expect, it } from "vitest";
import { policyExamples } from "../../../web/src/lib/policy-examples.js";
import { codeResource, harness, ownerWithOrg, projectWith } from "../helpers.js";

const base = { checks: [], contracts: [], rules: [] };

describe("policy examples shown in the web app", () => {
  for (const two of [false, true]) {
    it(`each section's example validates, alone and Release with Staging (${two ? "two folders" : "one folder"})`, async () => {
      const h = harness();
      const o = await ownerWithOrg(h);
      const folders = [{ mountName: "website", resourceId: (await codeResource(h, o, "website", { "index.html": "hi" })).resourceId }];
      if (two) folders.push({ mountName: "api", resourceId: (await codeResource(h, o, "api", { "src/index.ts": "export default {}" })).resourceId });
      const pid = await projectWith(h, o, folders);
      const P = `/api/orgs/${o.orgId}/projects/${pid}`;
      const dr = await h.api("GET", `/api/orgs/${o.orgId}/deploy-resources`, { token: o.token });
      expect(dr.status).toBe(200);
      const ex = policyExamples({ workerPrefix: dr.body.workerPrefix, folders: folders.map((f) => ({ ...f, provider: "artifacts" })) });
      const release = JSON.parse(ex.release);
      for (const body of [{ ...base, release }, { ...base, release, staging: JSON.parse(ex.staging) }, { ...base, preview: JSON.parse(ex.preview) }, { ...base, contracts: JSON.parse(ex.contracts) }]) {
        const r = await h.api("POST", `${P}/policy/validate`, { token: o.token, body });
        expect(r.body, Object.keys(body).join(",")).toEqual({ ok: true, issues: [] });
      }
    });
  }

  it("saving the Release and Staging examples turns staging on, waiting for the first production publish", async () => {
    const h = harness();
    const o = await ownerWithOrg(h);
    const web = await codeResource(h, o, "website", { "index.html": "hi" });
    const pid = await projectWith(h, o, [{ mountName: "website", resourceId: web.resourceId }]);
    const P = `/api/orgs/${o.orgId}/projects/${pid}`;
    const dr = await h.api("GET", `/api/orgs/${o.orgId}/deploy-resources`, { token: o.token });
    const ex = policyExamples({ workerPrefix: dr.body.workerPrefix, folders: [{ mountName: "website", resourceId: web.resourceId, provider: "artifacts" }] });
    const put = await h.api("PUT", `${P}/policy`, { token: o.token, body: { ...base, release: JSON.parse(ex.release), staging: JSON.parse(ex.staging) } });
    expect(put.status).toBe(200);
    const s = await h.api("GET", `${P}/staging`, { token: o.token });
    expect(s.body).toMatchObject({ enabled: true, state: "awaiting_baseline", stateText: "Waiting for the owner's first production publish.", baseline: null });
  });
});
