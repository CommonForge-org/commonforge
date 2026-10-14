import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FakeApi, FIXTURE_ORG as ORG, FIXTURE_PROJECT as PID, FIXTURE_PROPOSALS as P } from "../src/api/fake.js";
import { changedSections, fromPolicy, issuesAt, toPolicy, unclaimedIssues } from "../src/lib/policy.js";
import { policyExamples, releaseTargetIds, SECTION_HELP } from "../src/lib/policy-examples.js";
import { PolicyView, savePolicy, type PolicyViewProps } from "../src/screens/PolicyTab.js";

describe("fake policy (mirrors the worker in outline)", () => {
  it("developers read a real-shaped policy; clients get none", async () => {
    const p = await new FakeApi({ role: "developer" }).getProject(ORG, PID);
    expect(p.policy!.checks[0]).toMatchObject({ checkId: expect.any(String), mountName: expect.any(String), command: expect.any(String) });
    expect(p.policy!.approvalRoles).toEqual(["owner", "client"]);
    expect((await new FakeApi({ role: "client" }).getProject(ORG, PID)).policy).toBeUndefined();
  });

  it("validate reports issues by path; owners save with expectedRevision; a stale one is refused", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.getProject(ORG, PID);
    const bad = await api.validatePolicy(ORG, PID, { ...p.policy!, approvalRoles: [], checks: [{ checkId: "x", mountName: "website", command: "", timeoutSeconds: 0 }] });
    expect(bad.ok).toBe(false);
    expect(bad.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["approvalRoles", "checks.0.command", "checks.0.timeoutSeconds"]));
    const saved = await api.putPolicy(ORG, PID, { ...p.policy!, rules: ["Be kind"] }, p.policyRevision);
    expect(saved.policyRevision).toBe(p.policyRevision + 1);
    expect((await api.getProject(ORG, PID)).policyChanged?.by).toBeTruthy();
    await expect(api.putPolicy(ORG, PID, p.policy!, p.policyRevision)).rejects.toMatchObject({ code: "policy_changed" });
  });

  it("validate never touches the revision or who changed it", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.getProject(ORG, PID);
    await api.validatePolicy(ORG, PID, { ...p.policy!, rules: ["x"] });
    await api.validatePolicy(ORG, PID, { ...p.policy!, approvalRoles: [] });
    const after = await api.getProject(ORG, PID);
    expect(after.policyRevision).toBe(p.policyRevision);
    expect(after.policyChanged).toEqual(p.policyChanged);
    expect(after.policy).toEqual(p.policy);
  });

  it("a save checks the document before the revision, as the worker does", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.getProject(ORG, PID);
    // invalid AND stale: the schema refusal wins
    await expect(api.putPolicy(ORG, PID, { ...p.policy!, approvalRoles: [] }, p.policyRevision + 7)).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("missing lists are treated as empty, not a crash", async () => {
    const api = new FakeApi({ role: "owner" });
    const r = await api.validatePolicy(ORG, PID, { approvalRoles: ["owner"] } as any);
    expect(r).toEqual({ ok: true, issues: [] });
  });

  it("approvals follow the fixture project's approvalRoles (403 approval_role_not_allowed, as the worker)", async () => {
    const api = new FakeApi({ role: "developer" });
    const pr = await api.getProposal(ORG, P.quoteRepaired);
    // the fixture policy allows owner and client only
    await expect(api.approve(ORG, pr.proposalId, pr.proposalHash)).rejects.toMatchObject({ status: 403, code: "approval_role_not_allowed" });
    api.role = "owner";
    const p = await api.getProject(ORG, PID);
    await api.putPolicy(ORG, PID, { ...p.policy!, approvalRoles: ["owner", "developer"] }, p.policyRevision);
    api.role = "developer";
    await expect(api.approve(ORG, pr.proposalId, pr.proposalHash)).resolves.toMatchObject({ role: "developer" });
    api.role = "client";
    await expect(api.approve(ORG, pr.proposalId, pr.proposalHash)).rejects.toMatchObject({ code: "approval_role_not_allowed" });
  });

  it("only owners validate or save", async () => {
    const dev = new FakeApi({ role: "developer" });
    const p = await dev.getProject(ORG, PID);
    await expect(dev.validatePolicy(ORG, PID, p.policy!)).rejects.toMatchObject({ code: "insufficient_role" });
    await expect(dev.putPolicy(ORG, PID, p.policy!, p.policyRevision)).rejects.toMatchObject({ code: "insufficient_role" });
  });
});

describe("policy draft model", () => {
  const base = { checks: [{ checkId: "build", mountName: "website", command: "pnpm build", timeoutSeconds: 300, required: true }], contracts: [], rules: ["r1"], approvalRoles: ["owner", "client"] as const, publishRoles: ["owner"] as const };

  it("round-trips a policy through the draft; unset roles show their defaults", () => {
    const d = fromPolicy({ ...base, approvalRoles: undefined, publishRoles: undefined } as any);
    expect(d.approvalRoles).toEqual(["owner", "developer", "client"]);
    expect(d.publishRoles).toEqual(["owner"]);
    expect(d.preview).toBe("");
    const back = toPolicy(fromPolicy(base as any));
    expect(back.issues).toEqual([]);
    expect(back.policy).toEqual({ ...base, approvalRoles: ["owner", "client"], publishRoles: ["owner"] });
  });

  it("reports JSON and empty-role problems as issues at their section paths", () => {
    const d = { ...fromPolicy(base as any), contracts: "{ not json", approvalRoles: [] as never[] };
    const r = toPolicy(d);
    expect(r.policy).toBeUndefined();
    expect(r.issues.map((i) => i.path).sort()).toEqual(["approvalRoles", "contracts"]);
    expect(toPolicy({ ...fromPolicy(base as any), contracts: "{}" }).issues[0]!.path).toBe("contracts");
  });

  it("an empty Preview or Release means none", () => {
    const r = toPolicy({ ...fromPolicy(base as any), preview: "  ", release: "" });
    expect(r.policy).not.toHaveProperty("preview");
    expect(r.policy).not.toHaveProperty("release");
  });

  it("lists only the sections that changed, with before and after", () => {
    const after = { ...base, rules: ["r1", "r2"], approvalRoles: ["owner"] as const };
    const c = changedSections(base as any, after as any);
    expect(c.map((x) => x.section)).toEqual(["approvalRoles", "rules"]);
    expect(c[1]!.after).toContain("r2");
    // unset roles equal their defaults: no change
    expect(changedSections({ ...base, approvalRoles: undefined } as any, { ...base, approvalRoles: ["owner", "developer", "client"] } as any)).toEqual([]);
  });

  it("keeps approval roles the form doesn't show (viewer), and saves them unchanged", () => {
    const stored = { ...base, approvalRoles: ["viewer", "owner"] } as any;
    const d = fromPolicy(stored);
    expect(d.approvalRoles).toEqual(["owner"]);
    expect(d.otherApprovalRoles).toEqual(["viewer"]);
    expect(toPolicy(d).policy!.approvalRoles).toEqual(["viewer", "owner"]);
    expect(changedSections(stored, toPolicy(d).policy!)).toEqual([]);
    // unticking every shown role still leaves the viewer: not "Choose at least one role"
    const hiddenOnly = toPolicy({ ...d, approvalRoles: [] });
    expect(hiddenOnly.issues).toEqual([]);
    expect(hiddenOnly.policy!.approvalRoles).toEqual(["viewer"]);
    expect(changedSections(stored, hiddenOnly.policy!).map((c) => c.section)).toEqual(["approvalRoles"]);
    // a stored list of hidden roles only is a valid document too
    const onlyViewer = fromPolicy({ ...base, approvalRoles: ["viewer"] } as any);
    expect(onlyViewer.approvalRoles).toEqual([]);
    expect(toPolicy(onlyViewer).issues).toEqual([]);
    expect(toPolicy(onlyViewer).policy!.approvalRoles).toEqual(["viewer"]);
    // with nothing hidden, an empty list is still a problem
    expect(toPolicy({ ...fromPolicy(base as any), approvalRoles: [] }).issues.map((i) => i.path)).toEqual(["approvalRoles"]);
  });

  it("unclaimedIssues keeps the issues no field shows", () => {
    const d = fromPolicy(base as any); // one check, one rule
    const issues = [
      { path: "approvalRoles", message: "a" },
      { path: "checks.0.command", message: "b" },
      { path: "checks.3", message: "stale check" },
      { path: "checks", message: "c" },
      { path: "rules.0", message: "d" },
      { path: "rules.2", message: "stale rule" },
      { path: "rules", message: "too many rules" },
      { path: "release.targets.0", message: "e" },
      { path: "", message: "root" },
      { path: "unknownKey", message: "unknown" },
    ];
    expect(unclaimedIssues(issues, d).map((i) => i.message)).toEqual(["stale check", "stale rule", "root", "unknown"]);
  });

  it("issuesAt finds a path and everything below it", () => {
    const issues = [{ path: "checks.0.command", message: "a" }, { path: "checks.1.command", message: "b" }, { path: "release", message: "c" }];
    expect(issuesAt(issues, "checks.0").map((i) => i.message)).toEqual(["a"]);
    expect(issuesAt(issues, "release.targets").length).toBe(0);
    expect(issuesAt(issues, "release").length).toBe(1);
  });
});

const html = (el: Parameters<typeof render>[0]) => render(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
const noop = () => {};
const draft = fromPolicy({ checks: [{ checkId: "build", mountName: "website", command: "pnpm build", timeoutSeconds: 300, required: true }], contracts: [], rules: ["Keep it stable"], approvalRoles: ["owner", "client"], publishRoles: ["owner"] });
const view: PolicyViewProps = {
  editable: true,
  mounts: [{ mountName: "website" }, { mountName: "api" }],
  revision: 3,
  changed: { at: "2026-10-07T10:00:00.000Z", by: "owner@agency.example" },
  draft,
  issues: [],
  dirty: false,
  review: null,
  busy: false,
  error: null,
  conflict: null,
  checking: false,
  checkFailed: false,
  onRetryCheck: noop,
  onChange: noop,
  onReview: noop,
  onBack: noop,
  onSave: noop,
  onReload: noop,
};

describe("PolicyView", () => {
  it("shows the revision, who changed it, the role forms, checks, rules and JSON sections", () => {
    const out = html(createElement(PolicyView, view));
    expect(out).toContain("Revision 3");
    expect(out).toContain("owner@agency.example");
    expect(out).toContain("Who can approve changes");
    expect(out).toContain("Who can approve publishing");
    expect(out).toContain('aria-label="Command of check 1"');
    expect(out).toContain("A failing optional check is recorded but doesn't block.");
    expect(out).toContain("Given to agents with every task.");
    expect(out).toContain("Contracts (JSON)");
    expect(out).toContain("Edit as JSON.");
    expect(out).toContain("Edit as JSON; leave empty for none.");
    expect(out).toContain("Staging starts after the first production publish.");
    // no examples until the Worker name prefix is known
    expect(out).not.toContain("Show example");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Review changes/);
  });

  it("shows each issue next to its field", () => {
    const out = html(createElement(PolicyView, { ...view, dirty: true, issues: [{ path: "checks.0.timeoutSeconds", message: "Number must be at most 3600" }, { path: "release", message: "release target not allowed" }] }));
    expect(out).toContain("Number must be at most 3600");
    expect(out).toContain("release target not allowed");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Review changes/);
  });

  it("while the edited document is being checked: a quiet note, and Review waits", () => {
    const out = html(createElement(PolicyView, { ...view, dirty: true, checking: true }));
    expect(out).toContain("Checking…");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Review changes/);
    expect(out).not.toContain("Couldn't check the policy");
    const done = html(createElement(PolicyView, { ...view, dirty: true }));
    expect(done).not.toContain("Checking…");
    expect(done).not.toMatch(/<button[^>]*disabled[^>]*>Review changes/);
  });

  it("a failed check says so, offers Retry, and blocks Review", () => {
    const out = html(createElement(PolicyView, { ...view, dirty: true, checkFailed: true }));
    expect(out).toContain("Couldn't check the policy. Try again.");
    expect(out).toMatch(/<button[^>]*>Retry<\/button>/);
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Review changes/);
    expect(out).not.toContain("Checking…");
  });

  it("issues no field shows are listed under Other problems", () => {
    const out = html(createElement(PolicyView, { ...view, dirty: true, issues: [{ path: "", message: "Expected object" }, { path: "checks.4.command", message: "stale row problem" }, { path: "checks.0.command", message: "shown at the row" }] }));
    expect(out).toContain("Other problems");
    const other = out.slice(out.indexOf("Other problems"));
    expect(other).toContain("Expected object");
    expect(other).toContain("stale row problem");
    expect(other).not.toContain("shown at the row");
    expect(out).toContain("shown at the row");
    expect(html(createElement(PolicyView, view))).not.toContain("Other problems");
  });

  it("each Required checkbox names its check", () => {
    const out = html(createElement(PolicyView, view));
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*aria-label="Check 1 is required"|<input[^>]*aria-label="Check 1 is required"[^>]*type="checkbox"/);
  });

  it("approval roles the form doesn't show are named, so nobody is surprised", () => {
    const out = html(createElement(PolicyView, { ...view, draft: { ...draft, otherApprovalRoles: ["viewer"] } }));
    expect(out).toContain("Also allowed (not changeable here): Viewer");
    expect(html(createElement(PolicyView, view))).not.toContain("Also allowed");
  });

  it("the review lists before and after per changed section and explains what saving means", () => {
    const out = html(createElement(PolicyView, { ...view, dirty: true, review: [{ section: "rules", label: "Rules", before: '[\n  "a"\n]', after: '[\n  "a",\n  "b"\n]' }] }));
    expect(out).toContain('aria-label="Before: Rules"');
    expect(out).toContain('aria-label="After: Rules"');
    expect(out).toContain("Changes checked or released after this save use the new policy.");
    expect(out).toContain(">Save<");
  });

  it("a conflict offers the newer version", () => {
    const out = html(createElement(PolicyView, { ...view, review: [], conflict: 4 }));
    expect(out).toContain("revision 4");
    expect(out).toContain("Load the newer version");
  });

  it("developers read it without controls", () => {
    const out = html(createElement(PolicyView, { ...view, editable: false }));
    expect(out).toContain("Only owners can change the policy.");
    expect(out).not.toContain("Review changes");
    expect(out).not.toContain("Add check");
  });

  it("without edit rights every input and control is disabled", () => {
    const out = html(createElement(PolicyView, { ...view, editable: false }));
    for (const label of ["Name of check 1", "Folder of check 1", "Command of check 1", "Timeout of check 1 in seconds", "Rule 1"]) expect(out).toMatch(new RegExp(`<(input|select|textarea)[^>]*aria-label="${label}"[^>]*disabled`));
    expect(out).not.toMatch(/<(input|select|textarea)(?![^>]*disabled)[^>]*>/);
    expect(out).not.toContain("Remove check");
  });

  it("Save is disabled while there is a conflict", () => {
    const out = html(createElement(PolicyView, { ...view, review: [{ section: "rules", label: "Rules", before: "[]", after: '["a"]' }], conflict: 4 }));
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Save/);
    expect(html(createElement(PolicyView, { ...view, review: [], conflict: null }))).not.toMatch(/<button[^>]*disabled[^>]*>Save/);
  });
});

describe("savePolicy", () => {
  it("saves under the current revision", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.getProject(ORG, PID);
    const r = await savePolicy(api, ORG, PID, { ...p.policy!, rules: ["Be kind"] }, p.policyRevision);
    expect(r).toEqual({ saved: { policyRevision: p.policyRevision + 1 } });
    const after = await api.getProject(ORG, PID);
    expect(after.policyRevision).toBe(p.policyRevision + 1);
    expect(after.policy!.rules).toEqual(["Be kind"]);
  });

  it("a stale revision is a conflict carrying the current one, and changes nothing", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.getProject(ORG, PID);
    await api.putPolicy(ORG, PID, { ...p.policy!, rules: ["Theirs"] }, p.policyRevision);
    const r = await savePolicy(api, ORG, PID, { ...p.policy!, rules: ["Mine"] }, p.policyRevision);
    expect(r).toEqual({ conflict: p.policyRevision + 1 });
    const after = await api.getProject(ORG, PID);
    expect(after.policyRevision).toBe(p.policyRevision + 1);
    expect(after.policy!.rules).toEqual(["Theirs"]);
  });

  it("other errors are rethrown", async () => {
    const owner = new FakeApi({ role: "owner" });
    const p = await owner.getProject(ORG, PID);
    await expect(savePolicy(owner, ORG, PID, { ...p.policy!, approvalRoles: [] }, p.policyRevision)).rejects.toMatchObject({ code: "invalid_request" });
    const dev = new FakeApi({ role: "developer" });
    await expect(savePolicy(dev, ORG, PID, p.policy!, p.policyRevision)).rejects.toMatchObject({ code: "insufficient_role" });
  });
});

describe("policy draft: staging section", () => {
  it("round-trips staging as JSON and reports it as a changed section", () => {
    const base = { checks: [], contracts: [], rules: [] };
    const d = fromPolicy(base);
    expect(d.staging).toBe("");
    const edited = { ...d, staging: JSON.stringify({ captureVars: ["PAYMENT_WEBHOOK_URL"] }) };
    const { policy, issues } = toPolicy(edited);
    expect(issues).toEqual([]);
    expect(policy?.staging).toEqual({ captureVars: ["PAYMENT_WEBHOOK_URL"] });
    expect(changedSections(base, policy!).map((c) => c.section)).toEqual(["staging"]);
  });
});

describe("JSON section help and examples", () => {
  const examples = policyExamples({ workerPrefix: "cfapp-o-aaaa11112222-", folders: [{ mountName: "website", resourceId: "res-web", provider: "artifacts" }, { mountName: "brand", resourceId: "res-brand", provider: "r2-assets" }, { mountName: "api", resourceId: "res-api", provider: "artifacts" }] });

  it("builds each example from the project's git folders and the org's Worker name prefix", () => {
    const release = JSON.parse(examples.release);
    expect(release.targets[0]).toMatchObject({ kind: "worker", mountName: "website", workerName: "cfapp-o-aaaa11112222-site" });
    expect(release.healthCheck).toEqual({ targetId: "site", path: "/version" });
    expect(Object.keys(JSON.parse(examples.staging).environment)).toEqual(release.targets.map((t: { targetId: string }) => t.targetId));
    expect(JSON.parse(examples.staging).promotion.rules[0].paths).toEqual(["website/content/**"]);
    expect(JSON.parse(examples.contracts)[0]).toMatchObject({ producerResource: "res-api", consumerResource: "res-web" });
    expect(JSON.parse(examples.preview).recipe.output).toEqual({ mountName: "website", path: "dist" });
    // the Staging example configures the saved release's first target
    const custom = policyExamples({ workerPrefix: "cfapp-o-1-", folders: [], releaseTargets: releaseTargetIds({ targets: [{ targetId: "api" }, { targetId: "web" }] }) });
    expect(Object.keys(JSON.parse(custom.staging).environment)).toEqual(["api"]);
    expect(releaseTargetIds(undefined)).toEqual([]);
    expect(releaseTargetIds({ targets: "x" })).toEqual([]);
    // every section parses back through the editor
    expect(toPolicy({ ...fromPolicy(undefined), ...examples }).issues).toEqual([]);
  });

  it("each JSON section explains itself, and Show example offers Use this example only on an empty section the viewer can edit", () => {
    const out = html(createElement(PolicyView, { ...view, examples, draft: { ...draft, release: examples.release } }));
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    for (const k of ["release", "staging", "preview", "contracts"] as const) expect(out).toContain(esc(SECTION_HELP[k]));
    expect(out.match(/<summary>Show example<\/summary>/g)?.length).toBe(4);
    expect(out).toContain('aria-label="Example: Release"');
    // release is filled in: three empty sections (contracts is an empty list) offer the example
    expect(out.match(/>Use this example</g)?.length).toBe(3);
    const ro = html(createElement(PolicyView, { ...view, examples, editable: false }));
    expect(ro).toContain("Show example");
    expect(ro).not.toContain("Use this example");
  });

  it("shows the staging note under the Staging section", () => {
    const out = html(createElement(PolicyView, { ...view, stagingNote: createElement("p", { "data-testid": "note" }, "Staging starts after your first production publish.") }));
    expect(out).toMatch(/data-testid="policy-json-staging"[\s\S]*Staging starts after your first production publish/);
  });
});
