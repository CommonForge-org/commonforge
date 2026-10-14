/**
 * UX-4: the developer Change storyboard, its Review Brief, Release Receipt and inspector, and the
 * swim-lane agent board. Pure derivations are tested directly; views by server rendering.
 */
import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FakeApi, FIXTURE_ORG as ORG, FIXTURE_PROJECT as PID, FIXTURE_PROPOSALS as P } from "../src/api/fake.js";
import type { PreviewView, ReleaseList, Role } from "../src/api/types.js";
import { validationSummary } from "../src/lib/model.js";
import { agentCards, evidenceChips, ledgerCodes, releaseReceipt, repairBrief, resourceCards, stepKey, storyPosition } from "../src/lib/storyboard.js";
import { changeInspector } from "../src/screens/ChangeStoryboard.js";
import { ChangesView, changeContext, resourceName } from "../src/screens/Changes.js";
import { loadLive } from "../src/screens/project-data.js";
import { ProposalReviewView } from "../src/screens/ProposalReview.js";

const noop = () => {};

function renderToString(el: Parameters<typeof render>[0]): string {
  return render(el).replace(/<!-- -->/g, "");
}

const readyPreview = (proposalId: string, hash: string): PreviewView => ({ previewId: "pv-1", proposalId, proposalHash: hash, forCurrentHash: true, state: "ready", createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:01:00.000Z", expiresAt: "2099-10-07T10:01:00.000Z", url: "https://preview.fixture.invalid/p/x/pv-1/tok/", error: null });

async function approve(api: FakeApi, id: string, role: Role = "client") {
  const p = await api.getProposal(ORG, id);
  const before = api.role;
  api.role = role;
  await api.approve(ORG, id, p.proposalHash);
  api.role = before;
}

async function story(proposalId: string, opts: { api?: FakeApi; mutate?: (api: FakeApi) => Promise<void>; newerProposalId?: string; previews?: (hash: string) => PreviewView[]; releases?: ReleaseList; acceptedVersionId?: string | null } = {}) {
  const api = opts.api ?? new FakeApi({ role: "owner" });
  if (opts.mutate) await opts.mutate(api);
  const p = await api.getProposal(ORG, proposalId);
  const project = await api.getProject(ORG, PID);
  const live = await loadLive(api, ORG, PID, "owner");
  const cx = changeContext(live, project, "owner");
  const html = renderToString(
    createElement(ProposalReviewView, {
      p,
      project,
      role: "owner",
      org: ORG,
      pid: PID,
      title: cx.titleOf(p.changeId),
      newerProposalId: opts.newerProposalId ?? null,
      previous: null,
      cx,
      decisions: {
        onApprove: noop,
        approveBusy: false,
        approveError: null,
        onAccept: noop,
        acceptBusy: false,
        acceptError: null,
        acceptedVersionId: opts.acceptedVersionId ?? null,
        ...(opts.releases ? { publish: { releases: opts.releases, acceptedVersionId: opts.acceptedVersionId ?? null, onPrepare: noop, onApprove: noop, onDeploy: noop, busy: null, error: null } } : {}),
      },
      validate: { onValidate: noop, busy: false, error: null },
      preview: { previews: opts.previews ? opts.previews(p.proposalHash) : [], blockedWhy: null, onRequest: noop, busy: false, error: null },
      story: { versionOf: (id) => (id ? 4 : null) },
    }),
  );
  return { html, p, project, api };
}

/** The default view: everything before the collapsed full diff (the inspector is not part of the page). */
const defaultView = (html: string) => html.slice(0, html.indexOf('id="full-diff"'));
const primaries = (html: string) => (html.match(/class="btn btn-primary[^"]*"/g) ?? []).length;

describe("change storyboard: the blocked check (4:00)", () => {
  it("expands Check in amber with evidence chips, the contract-fail chip, the trust badge and one primary action", async () => {
    const { html } = await story(P.quoteFailed);
    expect(html).toContain('data-testid="blocked-banner"');
    expect(html).toContain('class="story-step story-step-decision"');
    expect(html).toContain("Check: the combined app is not ready");
    expect(html).toMatch(/class="rail-step rail-current rail-state-decision" aria-current="step"><span class="rail-line[^"]*"[^>]*><\/span><span[^>]*><\/span><span class="rail-label">Check/);
    expect(html).toContain("Merge clean · 2 repositories");
    expect(html).toMatch(/data-testid="contract-fail-chip"[^>]*>.*Contract <code class="chip-code">quote-schema<\/code> failed · API response no longer matches what Website expects/);
    expect(html).toContain("Checks 3 of 3");
    expect(html).toContain("Scope: every edit is in a writable resource");
    expect(html).toContain("Production is unchanged");
    expect(html).toContain("A clean merge is not proof the application works; the contract is.");
    expect(html).toContain("Accept is blocked");
    expect(html).toContain("Copy repair brief for the agent");
    expect(html).toContain("Open runner output");
    expect(html).toContain("Needs your decision");
    expect(primaries(html)).toBe(1);
  });

  it("a replaced blocked version offers no repair: the newer proposal is the way forward", async () => {
    const { html } = await story(P.quoteFailed, { newerProposalId: P.quoteRepaired });
    expect(html).toContain("This version was blocked.");
    expect(html).toContain("Review the latest");
    expect(html).not.toContain("Copy repair brief");
    expect(primaries(html)).toBe(0);
  });

  it("the repair brief carries the failure, the files and the runner output", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.getProposal(ORG, P.quoteFailed);
    const project = await api.getProject(ORG, PID);
    const brief = repairBrief(p, validationSummary(p, (r) => resourceName(project, r)), "Add a quote breakdown", (r) => resourceName(project, r));
    expect(brief).toContain("Repair: Add a quote breakdown");
    expect(brief).toContain("API and Website do not agree on the quote format yet");
    expect(brief).toContain("API: src/index.ts");
    expect(brief).toContain("additionalProperties: false");
  });
});

describe("change storyboard: review, approve, accept, publish, live", () => {
  it("Review: build a preview is the one primary; decisions sit lower with the identical review code", async () => {
    const { html, p } = await story(P.quoteRepaired);
    expect(html).toMatch(/aria-current="step">.*?<span class="rail-label">Review/);
    expect(primaries(html)).toBe(1);
    expect(html).toContain('data-testid="decision-rail"');
    expect(html).toContain(`data-testid="proposal-hash" data-hash="${p.proposalHash}"`);
    expect(html).toContain("same for client");
    // no raw ids, revisions or job ids in the default view
    expect(defaultView(html)).not.toMatch(/prop-|chg-|task-|art:|r2m:|job-|av-|rel-/);
  });

  it("Approve is the current step once a preview of this identity is ready (UX-1 review M-3)", async () => {
    const { html } = await story(P.quoteRepaired, { previews: (h) => [readyPreview(P.quoteRepaired, h)] });
    expect(html).toMatch(/aria-current="step">.*?<span class="rail-label">Approve/);
    expect(html).toContain("Approve: waiting for an approval of this exact result");
    expect(html).toMatch(/<button type="button" class="btn btn-primary">Approve this result<\/button>/);
    expect(html).toContain('data-testid="open-preview"');
    expect(primaries(html)).toBe(1);
    expect(html).toContain('data-testid="release-receipt" data-state="ready-for-review"');
  });

  it("Accept after the client approved: Accept is the primary, Approve is done", async () => {
    const { html } = await story(P.quoteRepaired, { mutate: (api) => approve(api, P.quoteRepaired), previews: (h) => [readyPreview(P.quoteRepaired, h)] });
    expect(html).toMatch(/aria-current="step">.*?<span class="rail-label">Accept/);
    expect(html).toContain("Accept: approved by client, ready to become a new version");
    expect(html).toMatch(/<button type="button" class="btn btn-primary">Accept as new version<\/button>/);
    expect(primaries(html)).toBe(1);
  });

  it("Publish and Live: the receipt binds version, build, target, observed live version and health", async () => {
    const now = { t: Date.parse("2026-10-06T12:00:00.000Z") };
    const api = new FakeApi({ role: "owner", now: () => now.t });
    await approve(api, P.quoteRepaired);
    const { acceptedVersionId } = await api.accept(ORG, P.quoteRepaired, "accept:story-1");
    const at = async () => story(P.quoteRepaired, { api, releases: await api.listReleases(ORG, PID), acceptedVersionId });
    const accepted = await at();
    expect(accepted.html).toContain("Publish: version 4 is accepted, not live");
    expect(accepted.html).toContain("New version 4 recorded in the ledger");
    expect(accepted.html).toContain("Accepted as version 4");
    expect(accepted.html).toContain('data-state="accepted"');
    expect(accepted.html).toContain("Accepted, not published");
    expect(accepted.html).toContain("Version 4 (the previous release)");
    expect(accepted.html).toMatch(/<button type="button" class="btn btn-primary">Prepare release<\/button>/);
    expect(primaries(accepted.html)).toBe(1);
    const rel = await api.prepareRelease(ORG, PID);
    now.t += 2000;
    const built = (await api.listReleases(ORG, PID)).releases.find((r) => r.releaseId === rel.releaseId)!;
    await api.approvePublish(ORG, rel.releaseId, built.outputDigest!);
    const approved = await at();
    expect(approved.html).toContain('data-state="approved-not-live"');
    expect(approved.html).toContain("Approved, not live");
    await api.deployRelease(ORG, rel.releaseId, "deploy:story-1");
    now.t += 2000;
    const live = await at();
    expect(live.html).toContain('data-state="live"');
    expect(live.html).toContain("Healthy · version check passed");
    expect(live.html).toContain("Version 4 (this release)");
    expect(live.html).toMatch(/rail-developer[^>]*>.*Live<span class="sr-only"> \(done\)/);
    expect(live.html).toContain("Live: version 4 is running in production");
  });
});

describe("storyboard derivations", () => {
  it("the Review Brief flags protected surfaces: the contract's producer and edits to contract files", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.getProposal(ORG, P.quoteRepaired);
    const project = await api.getProject(ORG, PID);
    const cards = resourceCards(p, (r) => resourceName(project, r));
    expect(cards.map((c) => [c.name, c.protected])).toEqual([
      ["Website", null],
      ["API", "Protected surface: produces the quote-schema contract"],
      ["Requirements", "Protected surface: edits a contract definition"],
    ]);
    expect(cards[0]!.summary).toBe("2 files · index.html, quote.ts");
    expect(cards[0]!.by).toBe("Claude agent");
  });

  it("evidence chips come from the runner's evidence; a not-run proposal claims nothing", async () => {
    const api = new FakeApi({ role: "owner" });
    const project = await api.getProject(ORG, PID);
    const brand = await api.getProposal(ORG, P.brandRefresh);
    const chips = evidenceChips(brand, validationSummary(brand), project, (r) => resourceName(project, r));
    expect(chips.map((c) => c.lead)).toEqual(["Not validated yet", "Scope: every edit is in a writable resource"]);
  });

  it("ledger codes name why accept is refused right now", async () => {
    const api = new FakeApi({ role: "owner" });
    expect(ledgerCodes(await api.getProposal(ORG, P.quoteFailed))).toEqual(["evidence_missing", "approval_invalid"]);
    expect(ledgerCodes(await api.getProposal(ORG, P.quoteRepaired))).toEqual(["approval_invalid"]);
    await approve(api, P.quoteRepaired);
    expect(ledgerCodes(await api.getProposal(ORG, P.quoteRepaired))).toEqual([]);
    // review m-1: only the Worker's codes; a moved write target vs a moved read dependency; open is not prepared
    const brand = await api.getProposal(ORG, P.brandRefresh);
    const reqs = brand.resourceChanges[0]!.resourceId;
    const dep = (brand.readDependencies[0] as { resourceId: string }).resourceId;
    expect(ledgerCodes({ ...brand, stale: [reqs, dep] })).toEqual(["expected_head_stale", "dependency_stale", "evidence_missing", "approval_invalid"]);
    expect(ledgerCodes({ ...brand, state: "open" })).toEqual(["proposal_not_prepared"]);
    expect(ledgerCodes({ ...brand, state: "withdrawn" })).toEqual([]);
  });

  it("rail position: Check → Review → Approve (preview ready) → Accept → Publish → Live", async () => {
    const api = new FakeApi({ role: "owner" });
    const failed = await api.getProposal(ORG, P.quoteFailed);
    const ok = await api.getProposal(ORG, P.quoteRepaired);
    const f = { replaced: false, previewReady: false, release: null };
    expect(stepKey(storyPosition(failed, f))).toBe("check");
    expect(storyPosition(failed, f).state).toBe("decision");
    expect(stepKey(storyPosition(ok, f))).toBe("review");
    expect(stepKey(storyPosition(ok, { ...f, previewReady: true }))).toBe("approve");
    expect(storyPosition(failed, { ...f, replaced: true }).state).toBe("superseded");
  });

  it("the release receipt's four states", () => {
    const p = { state: "accepted" } as never;
    const base = { releaseId: "rel-1", projectId: PID, acceptedVersionId: "av-1", recipeRevision: 1, envDigest: "e".repeat(64), outputDigest: "a3f92c71".padEnd(64, "0"), state: "prepared" as const, buildState: "built" as const, status: "Ready for publish approval", live: false, publishApproved: false, deployAttempts: 0, createdAt: "", updatedAt: "", error: null, deployments: [], health: null };
    const opts = { versionOf: (id: string | null | undefined) => (id === "av-1" ? 5 : id === "av-0" ? 4 : null), acceptedVersionId: "av-1", live: { acceptedVersionId: "av-0" } };
    expect(releaseReceipt({ state: "prepared", approvals: [], proposalHash: "h" } as never, null, opts).label).toBe("Ready for review");
    const approved = releaseReceipt(p, { ...base, state: "publish_approved", publishApproved: true }, opts);
    expect(approved.label).toBe("Approved, not live");
    expect(approved.rows.find((r) => r.label === "Build")!.value).toBe("built · a3f9 2c71 0000");
    expect(approved.rows.find((r) => r.label === "Observed live")!.value).toBe("Version 4 (the previous release)");
    expect(releaseReceipt(p, { ...base, state: "failed", publishApproved: true }, opts).label).toBe("Deployment failed");
    const live = releaseReceipt(p, { ...base, state: "live", live: true, health: { ok: true, checkedAt: "" } }, { ...opts, live: { acceptedVersionId: "av-1" } });
    expect(live.label).toBe("Live");
    expect(live.rows.find((r) => r.label === "Observed live")!.value).toBe("Version 5 (this release)");
  });

  it("agents on this change: one card per agent task with its elapsed time, no invented transcripts", async () => {
    const api = new FakeApi({ role: "owner" });
    const live = await loadLive(api, ORG, PID, "owner");
    const project = await api.getProject(ORG, PID);
    const p = await api.getProposal(ORG, P.quoteRepaired);
    const cards = agentCards(p, live.tasks, live.events, (r) => resourceName(project, r), Date.now());
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ who: "Claude agent", role: "developer", status: { label: "Submitted" } });
    expect(cards[0]!.elapsed).toMatch(/^7 min/);
    expect(cards[0]!.detail).toContain("Website + API + Requirements");
  });

  it("the inspector holds the technical detail: same short hash, snapshot, candidates, tokens, ledger, refs, evidence JSON, diff", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.getProposal(ORG, P.quoteFailed);
    const project = await api.getProject(ORG, PID);
    const sections = changeInspector(p, { project, replaced: false, heads: { [p.resourceChanges[0]!.resourceId]: { resourceId: "x", revisionId: "y", versionSeq: 1, acceptedVersionId: null, acceptedAt: "", reconciliation: "synced" } } });
    expect(sections.map((s) => s.title)).toEqual(["Change", "Candidates", "Tokens (policy)", "Last integration", "Ledger", "Canonical refs", "Evidence and diff"]);
    const html = renderToString(createElement("div", null, sections.flatMap((s) => s.rows.map((r) => createElement("p", { key: `${s.title}-${r.label}` }, r.label, ": ", r.value)))));
    expect(html).toContain("same for client");
    expect(html).toContain(`#${p.proposalHash.slice(0, 4)} ${p.proposalHash.slice(4, 8)} ${p.proposalHash.slice(8, 12)}`);
    expect(html).toMatch(/snapshot [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} · 3 resources pinned/);
    expect(html).toContain("by policy, a freeze revokes their write tokens");
    expect(html).toContain("website · Artifacts");
    expect(html).toContain("Contract quote-schema: FAIL");
    expect(html).toContain("refused now: evidence_missing, approval_invalid");
    expect(html).toContain("website: synced");
    expect(html).toContain("Download evidence JSON");
    expect(html).toContain("Open full diff");
  });
});

describe("swim-lane agent board (2:30)", () => {
  it("each lane is a card: avatar, agent, task, current step, elapsed; the overlap band and lanes test id stay", async () => {
    const api = new FakeApi();
    const live = await loadLive(api, ORG, PID, "owner");
    const project = await api.getProject(ORG, PID);
    const html = renderToString(createElement(ChangesView, { live, project, role: "owner", org: ORG, pid: PID, now: Date.now() }));
    expect(html).toContain('data-testid="lanes"');
    expect((html.match(/data-testid="lane"/g) ?? []).length).toBe(3);
    expect(html).toContain("lanes-overlap");
    expect(html).toContain('class="lane-avatar"');
    expect(html).toMatch(/lane-step[^>]*>[^<]*Review/);
    expect(html).toMatch(/lane-step[^>]*>[^<]*Work/);
    expect(html).toMatch(/lane-elapsed[^>]*>\d+ min \d+ s/);
  });
});

describe("UX-4 review fixes", () => {
  it("C-1: the browser fixture seeds the quote change mid-repair; Finish running agent submits the repaired proposal", async () => {
    const api = new FakeApi({ role: "owner", repair: "running" });
    expect((await api.listProposals(ORG, PID)).map((p) => p.proposalId)).not.toContain(P.quoteRepaired);
    expect((await api.listTasks(ORG, PID)).map((t) => t.state)).toEqual(["running", "running", "submitted"]);
    // 4:00: A1 is the latest proposal: amber Check, Needs your decision, the repair brief, a repair in progress
    const { html } = await story(P.quoteFailed, { api });
    expect(html).toContain('class="story-step story-step-decision" aria-labelledby="story-step-title" data-testid="blocked-banner"');
    expect(html).toMatch(/data-testid="story-status">.*Needs your decision/);
    expect(html).toMatch(/<button type="button" class="btn btn-primary btn-lg">.*Copy repair brief for the agent<\/button>/);
    expect(html).toContain('<p class="story-lead" role="alert">');
    expect(html).toContain("An agent on this change is working again");
    expect(html).toContain('role="status" aria-live="polite"');
    api.completeRunningTasks();
    const a2 = await api.getProposal(ORG, P.quoteRepaired);
    expect(a2.lastAttempt?.state).toBe("succeeded");
    expect((await api.listTasks(ORG, PID)).every((t) => t.state === "submitted")).toBe(true);
    const events = (await api.listEvents(ORG, { projectId: PID })).events;
    expect(events.filter((e) => e.action === "task.started" && e.subject.id === "task-a15e0000-0000-4000-8000-00000000a100")).toHaveLength(2);
  });

  it("C-1: a replaced failed version keeps a red outline and offers no action", async () => {
    const { html } = await story(P.quoteFailed, { newerProposalId: P.quoteRepaired });
    expect(html).toContain('class="story-step story-step-blocked"');
    expect(html).not.toContain('role="alert"');
  });

  it("I-1: a release that was live and has been replaced is not 'Approved, not live'", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.getProposal(ORG, P.quoteRepaired);
    const accepted = { ...p, state: "accepted" as const };
    const rel = { releaseId: "rel-1", projectId: PID, acceptedVersionId: "av-1", recipeRevision: 1, envDigest: "e".repeat(64), outputDigest: "a".repeat(64), state: "live" as const, buildState: "built" as const, status: "Superseded", live: false, publishApproved: true, deployAttempts: 1, createdAt: "", updatedAt: "", error: null, deployments: [], health: { ok: true, checkedAt: "" } };
    const pos = storyPosition(accepted, { replaced: false, previewReady: true, release: rel });
    expect(pos).toEqual({ current: 7, state: "superseded", complete: false });
    const versionOf = (id: string | null | undefined) => (id === "av-1" ? 2 : id === "av-2" ? 3 : null);
    const r = releaseReceipt(accepted, rel, { versionOf, acceptedVersionId: "av-1", live: { acceptedVersionId: "av-2" } });
    expect(r).toMatchObject({ state: "superseded", label: "Was live, replaced by a newer release", badge: "neutral" });
    expect(r.rows.find((x) => x.label === "Observed live")!.value).toBe("Version 3 (a newer release)");
    // a rollback in progress is not a failure yet
    const rolling = releaseReceipt(accepted, { ...rel, state: "recovery_required", status: "Not verified, rolling back", rollback: { state: "running" } }, { versionOf, acceptedVersionId: "av-1", live: { acceptedVersionId: "av-0" } });
    expect(rolling).toMatchObject({ state: "rolling-back", label: "Not verified, rolling back", badge: "working" });
    expect(storyPosition(accepted, { replaced: false, previewReady: true, release: { ...rel, state: "recovery_required", rollback: { state: "running" } } }).state).toBe("working");
    // approved before acceptance
    expect(releaseReceipt({ ...p, approvals: [{ approvalId: "a", role: "client", approvedAt: "", proposalHash: p.proposalHash, approver: { kind: "user" } }] }, null, { versionOf, acceptedVersionId: null, live: null }).label).toBe("Approved, not accepted");
  });

  it("m-3, m-4: open proposals are at Work, withdrawn ones stay where they stopped, a stale base asks for a rebuild", async () => {
    const api = new FakeApi({ role: "owner" });
    const failed = await api.getProposal(ORG, P.quoteFailed);
    const f = { replaced: false, previewReady: false, release: null };
    expect(storyPosition({ ...failed, state: "open" }, f)).toEqual({ current: 1, state: "working", complete: false });
    expect(storyPosition({ ...failed, state: "withdrawn" }, f)).toEqual({ current: 2, state: "superseded", complete: false });
    const stale = { ...failed, lastAttempt: { ...failed.lastAttempt!, code: "stale_base", contractChecks: [], detail: "stale" } };
    const { html } = await story(P.quoteFailed, { mutate: async () => {}, api: Object.assign(new FakeApi({ role: "owner" }), { getProposal: async () => stale }) });
    expect(html).toContain("Copy rebuild brief for the agent");
    expect(html).not.toContain("Copy repair brief");
  });

  it("I-2: the Changes list and lanes use the storyboard's position with release facts (live after publishing)", async () => {
    const now = { t: Date.parse("2026-10-06T12:00:00.000Z") };
    const api = new FakeApi({ role: "owner", now: () => now.t });
    await approve(api, P.quoteRepaired);
    await api.accept(ORG, P.quoteRepaired, "accept:lanes-1");
    const rel = await api.prepareRelease(ORG, PID);
    now.t += 2000;
    const built = (await api.listReleases(ORG, PID)).releases.find((r) => r.releaseId === rel.releaseId)!;
    await api.approvePublish(ORG, rel.releaseId, built.outputDigest!);
    await api.deployRelease(ORG, rel.releaseId, "deploy:lanes-1");
    now.t += 2000;
    const live = await loadLive(api, ORG, PID, "owner");
    expect(live.releases?.live).not.toBeNull();
    const html = renderToString(createElement(ChangesView, { live, project: await api.getProject(ORG, PID), role: "owner", org: ORG, pid: PID, now: now.t }));
    expect(html).toMatch(/lane-step[^>]*>Live · Live</);
    expect(html).toMatch(/aria-label="Open change: Add a quote breakdown \(website \+ API\), Live · Live"/);
    expect(html).toContain('<span class="pill pill-good">Live</span>');
  });
});
