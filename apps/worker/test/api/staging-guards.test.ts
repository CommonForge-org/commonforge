/**
 * Staging phase 4-2, ruling P42-2: a staging-mode project refuses the ways around promotion — a
 * proposal straight from a task (`409 staging_proposal`) and a preview (`409 staging_mode`); the
 * edition refusals are in editions.test.ts. What existed before staging was turned on finishes as
 * it is, and a project without staging is unchanged.
 */
import { describe, expect, it } from "vitest";
import { freezeAndPropose, harness, prepareAndIntegrate, provisionedTask, waitUntil, type Harness } from "../helpers.js";

/** A minimal `policy.preview` (previews.test.ts has the full one; importing it would rerun that file). */
const PREVIEW_POLICY = {
  recipe: { recipeId: "site-preview", revision: 1, steps: [{ stepId: "site-build", mountName: "website", command: "pnpm exec vite build --base ./" }], output: { mountName: "website", path: "dist" } },
  ttlSeconds: 3600,
};

/** A release of the `website` mount and an (all-default) staging section: staging mode on. */
function stagingOn(orgId: string) {
  return {
    preview: PREVIEW_POLICY,
    release: {
      recipe: { recipeId: "site-release", revision: 1, steps: [{ stepId: "build", mountName: "website", command: "pnpm run build" }] },
      targets: [{ targetId: "website", kind: "worker", mountName: "website", outputPath: "dist", main: "index.js", workerName: `cfapp-${orgId}-website` }],
      environment: {},
      healthCheck: { targetId: "website", path: "/version" },
    },
    staging: {},
  };
}

async function putPolicy(h: Harness, o: { token: string; orgId: string }, pid: string, body: unknown) {
  const r = await h.api("PUT", `/api/orgs/${o.orgId}/projects/${pid}/policy`, { token: o.token, body });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

describe("staging-mode guards (P42-2)", () => {
  it("without staging a task is proposed and previewed as before", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    await putPolicy(h, t.o, t.pid, { preview: PREVIEW_POLICY });
    const { proposal } = await freezeAndPropose(h, t.o, t.taskId, { "index.html": "v2" });
    await prepareAndIntegrate(h, t.o, proposal.proposalId);
    expect((await h.api("POST", `/api/orgs/${t.o.orgId}/proposals/${proposal.proposalId}/previews`, { token: t.o.token })).status).toBe(202);
  });

  it("refuses a new proposal and a new preview; a proposal and preview from before staging are left to finish", async () => {
    const h = harness();
    const t = await provisionedTask(h);
    const { o, pid, taskId } = t;
    await putPolicy(h, o, pid, { preview: PREVIEW_POLICY });
    const { proposal } = await freezeAndPropose(h, o, taskId, { "index.html": "v2" });
    await prepareAndIntegrate(h, o, proposal.proposalId);
    const pv = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/previews`, { token: o.token });
    expect(pv.status).toBe(202);
    await waitUntil(async () => (await h.api("GET", `/api/orgs/${o.orgId}/previews/${pv.body.previewId}`, { token: o.token })).body.state === "ready");

    await putPolicy(h, o, pid, stagingOn(o.orgId));

    // a proposal straight from a task: promote instead
    const np = await h.api("POST", `/api/orgs/${o.orgId}/proposals`, { token: o.token, body: { taskId } });
    expect(np.status).toBe(409);
    expect(np.body.error.code).toBe("staging_proposal");
    expect(np.body.error.message).toMatch(/promote the task instead/);
    // a new preview: staging replaces previews
    const npv = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/previews`, { token: o.token });
    expect(npv.status).toBe(409);
    expect(npv.body.error.code).toBe("staging_mode");
    // the existing preview stays readable
    const old = await h.api("GET", `/api/orgs/${o.orgId}/previews/${pv.body.previewId}`, { token: o.token });
    expect(old.status).toBe(200);
    expect(old.body.state).toBe("ready");

    // the existing proposal is not refused by the guards: integrate and approve go on. Its accept
    // answers as any proposal made before a policy change does (the policy save made it stale),
    // never with a staging code
    const integrated = await prepareAndIntegrate(h, o, proposal.proposalId);
    const ap = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: o.token, body: { proposalHash: integrated.proposalHash } });
    expect(ap.status, JSON.stringify(ap.body)).toBe(201);
    const acc = await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/accept`, { token: o.token, body: { idempotencyKey: "pre-staging-accept" } });
    expect(acc.status).toBe(409);
    expect(acc.body.error.code).toBe("policy_revision_stale");

    // staging off again: previews are offered as before
    await putPolicy(h, o, pid, { preview: PREVIEW_POLICY });
    expect((await h.api("POST", `/api/orgs/${o.orgId}/proposals/${proposal.proposalId}/previews`, { token: o.token })).status).toBe(202);
  });
});
