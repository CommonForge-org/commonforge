/**
 * Component checks by server rendering (no DOM library is declared in the workspace): every view
 * is a pure function of its props, so its markup is the contract.
 */
import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../src/App.js";
import { FakeApi, FIXTURE_ORG as ORG, FIXTURE_PROJECT as PID, FIXTURE_PROPOSALS as P, FIXTURE_RESOURCES as R } from "../src/api/fake.js";
import type { Role } from "../src/api/types.js";
import { activityLine, activityText, ChangesView, changeContext, clientChangeTitle, collapseRepeats, groupActivity, StaleCallout, type ActivityItem } from "../src/screens/Changes.js";
import { EditionsPanelView, StartUpdatePanelView, defaultPolicyDraft, draftToPolicy, type StartUpdateViewProps } from "../src/screens/Editions.js";
import { ExportStatusView } from "../src/screens/ExportPanel.js";
import { groupMounts, imageDataUrl, ResourceInspectorView } from "../src/screens/Files.js";
import { OrgHomeView } from "../src/screens/Home.js";
import { ClientOverviewView } from "../src/screens/Overview.js";
import { loadClientUpdates, loadHistory } from "../src/screens/client-data.js";
import { decisionCount, loadLive, readEvents } from "../src/screens/project-data.js";
import { EvidenceView, previewBlocked, ProposalReviewView, reviewTitle, shortCode } from "../src/screens/ProposalReview.js";
import { ProjectTabs } from "../src/screens/ProjectShell.js";
import { CliCodeView, SignInView, VerifyView } from "../src/screens/SignIn.js";
import { versionLabel, VersionsView } from "../src/screens/Versions.js";

const noop = () => {};

/** Server markup without React's text-boundary comments, so assertions read like the screen. */
function renderToString(el: Parameters<typeof render>[0]): string {
  return render(el).replace(/<!-- -->/g, "");
}

async function approveAndAccept(api: FakeApi, id: string) {
  const role = api.role;
  const p = await api.getProposal(ORG, id);
  api.role = "client";
  await api.approve(ORG, id, p.proposalHash);
  api.role = "owner";
  await api.accept(ORG, id, `accept:test-${id.slice(5, 13)}`);
  api.role = role;
}

async function review(role: Role, proposalId: string = P.quoteRepaired, opts: { mutate?: (api: FakeApi) => Promise<void>; previousId?: string; newerProposalId?: string } = {}) {
  const api = new FakeApi({ role: "owner" });
  if (opts.mutate) await opts.mutate(api);
  api.role = role;
  const p = await api.getProposal(ORG, proposalId);
  const project = await api.getProject(ORG, PID);
  const live = await loadLive(api, ORG, PID, role);
  const cx = changeContext(live, project, role);
  const previous = opts.previousId ? await api.getProposal(ORG, opts.previousId) : null;
  const html = renderToString(
    createElement(ProposalReviewView, {
      p,
      project,
      role,
      org: ORG,
      pid: PID,
      title: cx.titleOf(p.changeId),
      newerProposalId: opts.newerProposalId ?? null,
      previous,
      cx,
      decisions: { onApprove: noop, approveBusy: false, approveError: null, onAccept: noop, acceptBusy: false, acceptError: null, acceptedVersionId: null },
      validate: { onValidate: noop, busy: false, error: null },
    }),
  );
  return { html, p };
}

function hashIn(html: string): string | undefined {
  return /data-hash="([0-9a-f]{64})"/.exec(html)?.[1];
}

describe("proposal review", () => {
  it("shows the identical proposalHash to the client and the developer (AT-19); clients get a short review code", async () => {
    const dev = await review("owner");
    const client = await review("client");
    expect(hashIn(dev.html)).toBe(dev.p.proposalHash);
    expect(hashIn(client.html)).toBe(dev.p.proposalHash);
    expect(client.html).toContain(shortCode(dev.p.proposalHash));
    expect(shortCode(dev.p.proposalHash)).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
  });

  it("gives developers revisions, diffs and plain-language evidence with ids; clients a checklist and collapsed details", async () => {
    const dev = await review("owner");
    const client = await review("client");
    // UX-4: the developer's Review Brief lists what the runner verified; diffs sit in the full diff
    expect(dev.html).toContain("Show diff");
    expect(dev.html).toContain("Contract <code>quote-schema</code>: holds");
    expect(dev.html).toContain("Website builds: pass");
    expect(dev.html).toContain('<details id="full-diff"');
    expect(client.html).not.toContain("Show diff");
    expect(client.html).not.toMatch(/art:|canonical|job-|quote-schema/);
    expect(client.html).toContain("Update to Website, API and Requirements");
    expect(client.html).toContain("This update changes the Website, API and Requirements.");
    expect(client.html).toContain("✓</span> API and Website agree on the quote format");
    expect(client.html).toContain("<summary>Show details</summary>");
    // UX-2: outcome with the green checks chip, the before/after preview, approve as the one primary
    expect(client.html).toMatch(/badge-ready[^>]*data-testid="checks-chip"[^>]*>.*Checks passed/);
    expect(client.html).toContain('data-testid="preview-before-after"');
    expect((client.html.match(/btn-primary/g) ?? []).length).toBe(1);
    expect(client.html).toContain('data-testid="decision-rail"');
    expect(client.html).toContain("Your developer will publish.");
    expect(client.html).not.toContain("Publish to production");
  });

  it("presents three separate decisions to developers; publishing waits for acceptance", async () => {
    const { html } = await review("owner");
    expect(html).toContain('data-testid="step-approve"');
    expect(html).toContain('data-testid="step-accept"');
    expect(html).toContain('data-testid="step-publish"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Publish to production<\/button>/);
    expect(html).toContain("Available after this change is accepted.");
    // UX-4: the current step (Review) builds the private preview: its one primary action
    expect(html).toContain("Review: build a private preview for the client");
    expect(html).toContain("Loading preview…"); // the preview controls live in that card (no previews passed here)
    expect(html).not.toContain('data-testid="open-preview"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Accept as new version<\/button>/);
    expect(html).toContain("No approval for this identity yet");
  });

  it("UX-2: a failed or stale result shows the amber Needs a developer decision chip to the client", async () => {
    const failed = await review("client", P.quoteFailed);
    expect(failed.html).toMatch(/badge-decision[^>]*data-testid="checks-chip"[^>]*>.*Needs a developer decision/);
    expect(failed.html).toContain("The checks found a problem. Your developer decides how to fix it.");
    const stale = await review("client", P.brandRefresh, { mutate: (api) => approveAndAccept(api, P.quoteRepaired) });
    expect(stale.html).toContain("Out of date: a newer change was accepted first.");
  });

  it("lets a client approve a validated result but never accept it", async () => {
    const { html } = await review("client");
    expect(html).toMatch(/<button type="button" class="btn btn-primary btn-wide">Approve this result<\/button>/);
    expect(html).not.toContain("Accept as new version");
    expect(html).toContain("Needs your decision");
  });

  it("enables accept once the current identity is approved, and shows the decision trail", async () => {
    const { html } = await review("owner", P.quoteRepaired, {
      mutate: async (api) => {
        const p = await api.getProposal(ORG, P.quoteRepaired);
        api.role = "client";
        await api.approve(ORG, P.quoteRepaired, p.proposalHash);
      },
    });
    expect(html).toMatch(/<button type="button" class="btn btn-primary">Accept as new version<\/button>/);
    expect(html).toContain("Approved by client");
    expect(html).toContain('data-testid="decision-trail"');
    expect(html).toContain("Not published");
  });

  it("C-1: a failed run (server lastAttempt) is a headline: blocked banner, plain reason, no approval", async () => {
    const { html } = await review("owner", P.quoteFailed);
    expect(html).toContain('data-testid="blocked-banner"');
    expect(html).toContain("Not safe to accept yet. The parts of the project no longer agree with each other.");
    expect(html).toContain("API and Website do not agree on the quote format yet");
    expect(html).toContain("Production is unchanged");
    expect(html).toContain("Open runner output"); // developers can open the runner's text
    expect(html).toContain("Needs resolution");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve this result<\/button>/);
    const client = await review("client", P.quoteFailed);
    expect(client.html).toContain("Not safe to accept yet");
    expect(client.html).not.toContain("Runner output");
  });

  it("shows the repaired proposal as fixed, naming what failed before", async () => {
    const { html } = await review("owner", P.quoteRepaired, { previousId: P.quoteFailed });
    expect(html).toContain('data-testid="fixed-banner"');
    expect(html).toContain("✓ API and Website agree on the quote format");
  });

  it("I-3: a replaced proposal says so and offers no decision", async () => {
    const { html } = await review("owner", P.quoteFailed, { newerProposalId: P.quoteRepaired });
    expect(html).toContain("Replaced by a newer proposal");
    expect(html).toContain("Review the latest");
    expect(html).toContain("This version was blocked.");
    expect(html).not.toContain("Needs your decision</span>");
  });

  it("explains a stale proposal: what moved, who was accepted first, nothing overwritten, next step", async () => {
    const { html } = await review("owner", P.brandRefresh, { mutate: (api) => approveAndAccept(api, P.quoteRepaired) });
    expect(html).toContain('data-testid="stale-callout"');
    expect(html).toContain("Stale: Requirements moved on.");
    expect(html).toContain("Add a quote breakdown (website + API)");
    expect(html).toContain("Nothing was overwritten.");
    expect(html).toContain("Next: ask the agent to rebuild it on the latest version");
  });

  it("offers validation for code changes", async () => {
    const { html } = await review("owner", P.brandRefresh);
    expect(html).toContain("R2 asset collection");
    expect(html).toContain("Run validation");
  });
});

describe("changes", () => {
  it("shows a coordination timeline: peak concurrency, named agents, resource chips, markers", async () => {
    const api = new FakeApi();
    const live = await loadLive(api, ORG, PID, "owner");
    const project = await api.getProject(ORG, PID);
    const html = renderToString(createElement(ChangesView, { live, project, role: "owner", org: ORG, pid: PID, now: Date.now() }));
    expect(html).toContain("Up to 3 sessions at once");
    expect(html).toContain("one is a client update");
    expect(html).toContain("1 working now");
    expect(html).toContain("Claude agent");
    // UX-6: the client-edition path is a lane too (client avatar, session title, current step)
    expect((html.match(/data-testid="lane"/g) ?? []).length).toBe(3);
    expect(html).toContain('data-kind="session"');
    expect(html).toContain("client@customer.example · Claude");
    expect(html).toContain("Friendlier quote form copy");
    expect(html).toContain("Work · Checking the edited copy");
    expect(html).toMatch(/class="chip chip-\d">Requirements</);
    expect(html).toContain("lane-mark-failed");
    expect(html).toContain("lane-mark-passed");
    expect((html.match(/data-testid="change-row"/g) ?? []).length).toBe(3);
    expect(html).toContain("2 proposals (latest shown)");
    // I-3: the replaced (failed) proposal does not count
    expect(decisionCount(live, "owner", undefined)).toBe(2);
  });

  it("groups activity by Change with named actors and decisions", async () => {
    const api = new FakeApi();
    await approveAndAccept(api, P.quoteRepaired);
    const live = await loadLive(api, ORG, PID, "owner");
    const html = renderToString(createElement(ChangesView, { live, project: await api.getProject(ORG, PID), role: "owner", org: ORG, pid: PID, now: Date.now() }));
    expect(html).toContain("What happened");
    expect(html).toContain("Validation blocked it: the parts of the project no longer agree with each other");
    // UX-5: people are named from the member list; the viewer's own events read "You"; no raw ids or actions
    expect(html).toContain("client@customer.example approved");
    expect(html).toContain("owner@agency.example accepted it as a new version");
    expect(html).toContain("dev@agency.example created the task");
    expect(html).toContain("Claude agent submitted a candidate");
    expect(html).not.toMatch(/\bav-[0-9a-f]/);
    const mine = renderToString(createElement(ChangesView, { live, project: await api.getProject(ORG, PID), role: "owner", org: ORG, pid: PID, now: Date.now(), me: "u-owner" }));
    expect(mine).toContain("You accepted it as a new version");
    expect(html).toContain('data-testid="stale-callout"');
    expect(html).toContain("lane-mark-stale");
  });

  it("client Activity never credits the client's own decisions to the developer (UX-5 review I-1)", async () => {
    const api = new FakeApi();
    await approveAndAccept(api, P.quoteRepaired);
    api.role = "client";
    await api.startUpdate(ORG, (await api.listEditions(ORG, PID))[0]!.editionId, { title: "Explain the quote" });
    const live = await loadLive(api, ORG, PID, "client");
    const project = await api.getProject(ORG, PID);
    const html = renderToString(createElement(ChangesView, { live, project, role: "client", org: ORG, pid: PID, now: Date.now() }));
    const groups = groupActivity(changeContext(live, project, "client"), 50, 50);
    const lines = groups.flatMap((g) => g.items.map(activityLine));
    expect(lines).toContain("Approved");
    expect(lines).toContain("Accepted as a new version");
    expect(lines.join("\n")).not.toMatch(/Your developer (approved|started an update|sent back)/);
    expect(html).not.toMatch(/@agency\.example|@customer\.example/);
    expect(html).not.toMatch(/\bav-[0-9a-f]|u-(owner|developer|client)/);
  });

  it("a staging release event never says production: staging-channel release events are labelled staging", () => {
    const ev = (action: string, channel?: string) => ({ seq: 1, at: "2026-10-07T00:00:00Z", projectId: "p", action, subject: { kind: "release", id: "rel-1" }, actor: { kind: "service" }, detail: channel ? { channel } : {} });
    for (const dev of [false, true]) {
      const live = activityText(ev("release.live", "staging"), undefined, dev)!;
      expect(live.text).toMatch(/staging/i);
      expect(live.text).not.toMatch(/production/i);
    }
    for (const a of ["release.deploy_failed", "release.deploy_lost", "release.rolled_back", "release.prepare_requested", "release.deploy_requested"]) {
      const t = activityText(ev(a, "staging"), undefined, true)!.text;
      expect(t, a).toMatch(/staging/i);
      expect(t, a).not.toMatch(/production/i);
    }
    // production (and older events without a channel) keep their wording
    expect(activityText(ev("release.live", "production"), undefined, false)!.text).toBe("Live in production");
    expect(activityText(ev("release.live"), undefined, false)!.text).toBe("Live in production");
  });

  it("collapses the same activity line repeated back to back", () => {
    const at = "2026-10-06T10:00:00.000Z";
    const line = (seq: number, text: string): ActivityItem => ({ seq, at, text, tone: "plain", proposalId: null });
    const out = collapseRepeats([line(3, "Claude agent submitted a candidate"), line(2, "Claude agent submitted a candidate"), line(1, "Claude agent started work")]);
    expect(out.map(activityLine)).toEqual(["Claude agent submitted a candidate ×2", "Claude agent started work"]);
  });

  it("hides tasks and agents from clients", async () => {
    const api = new FakeApi({ role: "client" });
    const live = await loadLive(api, ORG, PID, "client");
    const project = await api.getProject(ORG, PID);
    const html = renderToString(createElement(ChangesView, { live, project, role: "client", org: ORG, pid: PID, now: Date.now() }));
    expect(live.tasks).toEqual([]);
    expect(html).not.toContain("Agents at work");
    expect(html).not.toContain("task-");
    expect(html).not.toContain("Claude");
    expect(decisionCount(live, "client", undefined)).toBe(1);
  });

  it("puts the decision badge on the Changes tab", () => {
    const html = renderToString(createElement(ProjectTabs, { org: ORG, pid: PID, active: "files", decisions: 2 }));
    expect(html).toContain("Needs your decision · 2");
    expect(renderToString(createElement(ProjectTabs, { org: ORG, pid: PID, active: "files", decisions: 0 }))).not.toContain("Needs your decision");
  });

  it("I-2: overlapping reads of the event log never duplicate events", async () => {
    const api = new FakeApi();
    const [a, b] = await Promise.all([readEvents(api, ORG, PID, "owner"), readEvents(api, ORG, PID, "owner")]);
    const c = await readEvents(api, ORG, PID, "owner");
    for (const list of [a, b, c]) expect(new Set(list.map((e) => e.seq)).size).toBe(list.length);
    expect(c.length).toBe(a.length);
  });

  it("names a Change for clients by its areas", async () => {
    const api = new FakeApi({ role: "client" });
    const project = await api.getProject(ORG, PID);
    expect(clientChangeTitle(project, await api.getProposal(ORG, P.brandRefresh), "chg-x")).toBe("Update to Requirements and Brand and media");
    const live = await loadLive(api, ORG, PID, "client");
    expect(typeof StaleCallout).toBe("function");
    expect(changeContext(live, project, "client").titleOf(live.proposals[0]!.changeId)).toMatch(/^Update to /);
  });
});

describe("files", () => {
  it("groups mounts the way a client thinks about them (same groups for read-only clients)", async () => {
    const project = await new FakeApi({ role: "client" }).getProject(ORG, PID);
    expect(groupMounts(project.mounts).map((g) => [g.label, g.mounts.map((m) => m.mountName)])).toEqual([
      ["Current application", ["website", "api", "requirements"]],
      ["Brand and media", ["brand-assets"]],
      ["Ideas, prototypes and reference", ["quote-builder-concept"]],
    ]);
  });

  it("reveals provider and revision to everyone, coordinates and full revisions to developers only", async () => {
    const api = new FakeApi();
    const project = await api.getProject(ORG, PID);
    const snap = await api.getSnapshot(ORG, PID);
    const mount = project.mounts.find((m) => m.mountName === "brand-assets")!;
    const entry = snap.entries.find((e) => e.mountName === "brand-assets");
    const dev = renderToString(createElement(ResourceInspectorView, { mount, entry, resource: await api.getResource(ORG, R.brand), developer: true }));
    api.role = "client";
    const client = renderToString(createElement(ResourceInspectorView, { mount, entry, resource: await api.getResource(ORG, R.brand), developer: false }));
    for (const html of [dev, client]) {
      expect(html).toContain("R2 asset collection");
      expect(html).toContain("manifest ");
    }
    expect(dev).toContain("Coordinates");
    expect(client).not.toContain("Coordinates");
    expect(client).not.toContain("commonforge-assets-dev");
    expect(client).not.toContain("r2m:"); // m-1: no full revision in a tooltip
  });

  it("I-1: image previews are data: URLs (never blob:, which would inherit this origin)", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const url = await imageDataUrl(new Blob([svg]), "logos/evil.svg");
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(atob(url.split(",")[1]!)).toBe(svg);
  });
});

describe("versions", () => {
  async function versions(role: Role, accept = true) {
    const api = new FakeApi({ role: "owner" });
    if (accept) await approveAndAccept(api, P.quoteRepaired);
    api.role = role;
    const project = await api.getProject(ORG, PID);
    const mount = project.mounts.find((m) => m.mountName === "website")!;
    const props = { org: ORG, pid: PID, mount, resource: await api.getResource(ORG, R.website), versions: await api.listVersions(ORG, R.website), role, confirming: null, onAskRestore: noop, onRestore: noop, busy: false, error: null, restored: null };
    return { html: renderToString(createElement(VersionsView, props)), props };
  }

  it("I-4: after an accept, the imported first version can be restored", async () => {
    const { html, props } = await versions("owner");
    expect(html).toContain("Current");
    expect(html).toContain("Imported (first version)");
    expect((html.match(/Restore this version/g) ?? []).length).toBe(1);
    const genesis = props.versions[props.versions.length - 1]!;
    expect(versionLabel(genesis)).toBe("Imported (first version)");
    const confirming = renderToString(createElement(VersionsView, { ...props, confirming: genesis.head!.revisionId }));
    expect(confirming).toContain("records a new version; nothing is deleted");
  });

  it("never lets a client restore: their sheet says what restore does and asks the developer", async () => {
    const { html, props } = await versions("client");
    expect(html).not.toMatch(/revision|identity|proposal |art:|rev-/);
    const genesis = props.versions[props.versions.length - 1]!;
    const sheet = renderToString(createElement(VersionsView, { ...props, confirming: genesis.head!.revisionId }));
    expect(sheet).toContain("Your developer restores versions");
    expect(sheet).toContain(">Ask the developer to restore</button>");
    expect(sheet).not.toContain("Restoring…");
    expect(sheet).toContain("does not publish to your live site");
  });

  it("UX-2: numbers versions like the project history, marks the live one, and leaves an actions slot", async () => {
    const { props } = await versions("owner");
    const genesis = props.versions[props.versions.length - 1]!;
    const names = { numberOf: (id: string) => (id === genesis.acceptedVersionId ? 1 : 2), summaryOf: () => "First version, imported", liveIds: new Set([genesis.acceptedVersionId]) };
    const html = renderToString(createElement(VersionsView, { ...props, names, versionActions: (v) => (v === genesis ? createElement("button", { type: "button" }, "Publish this version") : null) }));
    expect(html).toMatch(/<strong>Version 2<\/strong>/);
    expect(html).toMatch(/version-live[^>]*>.*Version 1/);
    expect(html).toContain(">Publish this version</button>");
  });
});

describe("auth, home and project actions", () => {
  it("asks for a click before consuming a sign-in link", () => {
    const html = renderToString(createElement(VerifyView, { token: "cfm_x", busy: false, error: null, onConfirm: noop }));
    expect(html).toContain(">Sign in</button>");
    expect(renderToString(createElement(SignInView, { sent: true, email: "a@b.c", busy: false, error: null, onEmail: noop, onSubmit: noop }))).toContain("Check your email");
  });

  it("I-5: the CLI link page shows only the code and posts nothing", () => {
    const html = renderToString(createElement(CliCodeView, { code: "cfm_abc123" }));
    expect(html).toContain("Finish signing in to the CLI");
    expect(html).toContain(">cfm_abc123</pre>");
    expect(html).toContain("Copy code");
    expect(renderToString(createElement(App, { api: new FakeApi(), serverLocation: "/auth/cli?code=cfm_abc123" }))).toContain("Finish signing in to the CLI");
  });

  it("lists an organization's projects with the caller's role", () => {
    const html = renderToString(createElement(OrgHomeView, { membership: { orgId: ORG, name: "Demo Client", role: "client" }, projects: [{ projectId: PID, name: "Customer Portal", createdAt: "2026-10-05T00:00:00.000Z" }] }));
    expect(html).toContain("Customer Portal");
    expect(html).toContain("Client");
  });

  it("n-5: a client's review title names the areas of that proposal, as its body does (replaced proposal of a Change)", async () => {
    const api = new FakeApi({ role: "client" });
    const project = await api.getProject(ORG, PID);
    const live = await loadLive(api, ORG, PID, "client");
    const cx = changeContext(live, project, "client");
    for (const id of [P.quoteFailed, P.quoteRepaired]) {
      const p = await api.getProposal(ORG, id);
      const title = reviewTitle("client", project, p, cx);
      const areas = title.replace(/^Update to /, "");
      expect(title).toBe(clientChangeTitle(project, p, p.changeId));
      const html = renderToString(
        createElement(ProposalReviewView, {
          p,
          project,
          role: "client",
          org: ORG,
          pid: PID,
          title,
          newerProposalId: null,
          previous: null,
          cx,
          decisions: { onApprove: noop, approveBusy: false, approveError: null, onAccept: noop, acceptBusy: false, acceptError: null, acceptedVersionId: null },
          validate: { onValidate: noop, busy: false, error: null },
        }),
      );
      expect(html).toContain(`This update changes the ${areas}.`);
    }
    // developers keep the Change's task title
    api.role = "owner";
    const dev = changeContext(await loadLive(api, ORG, PID, "owner"), project, "owner");
    const p = await api.getProposal(ORG, P.quoteFailed);
    expect(reviewTitle("owner", project, p, dev)).toBe(dev.titleOf(p.changeId));
  });

  it("Start an update: developer setup required without a published edition; then title → working copy", async () => {
    const base: StartUpdateViewProps = { org: ORG, pid: PID, editions: [], editionId: null, onEdition: noop, title: "", onTitle: noop, onStart: noop, startBusy: false, startError: null, session: null, mode: "partial", onMode: noop, file: null, onFile: noop, onSend: noop, sendBusy: false, sendError: null };
    expect(renderToString(createElement(StartUpdatePanelView, base))).toContain("Developer setup required");
    const api = new FakeApi({ role: "client" });
    const editions = await api.listEditions(ORG, PID);
    expect(editions[0]).not.toHaveProperty("policy");
    const choose = renderToString(createElement(StartUpdatePanelView, { ...base, editions }));
    // UX-2: edition cards (the 0:45 hero), each with what you can and can't change
    expect(choose).toContain('data-testid="edition-cards"');
    expect(choose).toMatch(/role="radio" aria-checked="true"[^>]*>.*Website pages/);
    expect(choose).toContain("You can change");
    expect(choose).toContain("You can&#x27;t change");
    expect(choose).toMatch(/disabled=""[^>]*>.*Open working copy/);
    const session = await api.startUpdate(ORG, editions[0]!.editionId, { title: "Explain the quote" });
    const open = renderToString(createElement(StartUpdatePanelView, { ...base, editions, session }));
    expect(open).toContain(`href="${session.downloadUrl.replace(/&/g, "&amp;")}"`);
    expect(open).toMatch(/disabled=""[^>]*>.*Send back edited copy/); // no file chosen yet
    expect(open).toContain("Only the files I changed");
  });

  it("Start an update: a sent-back copy shows what was taken over, what was blocked, and the proposal", async () => {
    let t = Date.parse("2026-10-06T12:00:00.000Z");
    const api = new FakeApi({ role: "client", now: () => t });
    const [e] = await api.listEditions(ORG, PID);
    const s = await api.startUpdate(ORG, e!.editionId, { title: "Explain the quote" });
    await api.sendBack(ORG, s.sessionId, new Blob(["PK"]), { mode: "partial" });
    const base: StartUpdateViewProps = { org: ORG, pid: PID, editions: [e!], editionId: null, onEdition: noop, title: "", onTitle: noop, onStart: noop, startBusy: false, startError: null, session: null, mode: "partial", onMode: noop, file: null, onFile: noop, onSend: noop, sendBusy: false, sendError: null };
    const running = renderToString(createElement(StartUpdatePanelView, { ...base, session: await api.getUpdate(ORG, s.sessionId) }));
    expect(running).toContain("Preparing your change");
    t += 5000;
    const done = renderToString(createElement(StartUpdatePanelView, { ...base, session: await api.getUpdate(ORG, s.sessionId) }));
    expect(done).toContain("Ready for review");
    // UX-2: "N files changed · M blocked" (the 1:30 hero), one sentence per blocked file, Ask the developer
    expect(done).toMatch(/data-testid="return-summary"[^>]*>.*\d+ files? changed · 1 blocked/);
    expect(done).toContain("package.json was not taken over: your developer protects this file.");
    expect(done).toMatch(/href="mailto:\?subject=[^"]*"[^>]*>.*Ask the developer/);
    expect(done).toContain("Review and approve the result");
    expect(done).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    const stale = renderToString(createElement(StartUpdatePanelView, { ...base, session: { ...(await api.getUpdate(ORG, s.sessionId)), stale: true }, file: new File(["x"], "x.zip") }));
    expect(stale).toContain("live application changed");
    expect(stale).toMatch(/disabled=""[^>]*>.*Send back edited copy/);
  });

  it("Client editions (developer): policy draft from the fixture policy, build status and source release", async () => {
    const api = new FakeApi({ role: "owner" });
    const project = await api.getProject(ORG, PID);
    const editions = await api.listEditions(ORG, PID);
    const members = await api.listMembers(ORG);
    const html = renderToString(createElement(EditionsPanelView, { project, editions, clients: members.filter((m) => m.role === "client"), draft: null, onDraft: noop, onCreate: noop, onBuild: noop, onGrant: noop, busy: false, error: null }));
    expect(html).toContain("Published");
    expect(html).toContain("no live release recorded yet");
    expect(html).toContain("client@customer.example");
    const draft = defaultPolicyDraft("website");
    const form = renderToString(createElement(EditionsPanelView, { project, editions, clients: [], draft, onDraft: noop, onCreate: noop, onBuild: noop, onGrant: noop, busy: false, error: null }));
    expect(form).toContain("Never changed by a client (protected)");
    const policy = draftToPolicy(draft);
    expect(policy.sources[0]!.write).toEqual(["index.html", "src", "public", "tests"]);
    expect(policy.protectedPaths).toContain("tests/quote-contract.test.ts");
    const created = await api.createEdition(ORG, PID, policy);
    expect(created.ready).toBe(false);
    await api.buildEdition(ORG, created.editionId);
    expect((await api.getEdition(ORG, created.editionId)).builds![0]!.sourceReleaseId).toBeNull();
    // clients without a grant do not see it
    api.role = "client";
    expect((await api.listEditions(ORG, PID)).map((e) => e.editionId)).not.toContain(created.editionId);
  });

  it("shows export progress, then download links (also for a succeeded export without files)", () => {
    const base = { exportId: "exp-1", projectId: PID, snapshot: null, state: "queued", receipt: null, downloads: [] };
    expect(renderToString(createElement(ExportStatusView, { status: base }))).toContain("Writing git bundles");
    const done = renderToString(createElement(ExportStatusView, { status: { ...base, state: "succeeded", receipt: { items: [{ r2Key: "org/o/exports/exp-1/website.bundle" }] }, downloads: ["/api/orgs/o/exports/exp-1/download?key=org%2Fo%2Fexports%2Fexp-1%2Fwebsite.bundle"] } }));
    expect(done).toContain('download="website.bundle"');
    expect(renderToString(createElement(ExportStatusView, { status: { ...base, state: "succeeded", receipt: { items: [] } } }))).toContain("no files to download");
  });

  it("renders the sign-in route and labels fixture mode", () => {
    const fixture = new FakeApi();
    const html = renderToString(createElement(App, { api: fixture, fixture, serverLocation: "/signin" }));
    expect(html).toContain("Sign in to CommonForge");
    expect(html).toContain("Fixture mode");
    expect(html).toContain("Not a live run");
  });
});

describe("preview and publish (Task 22)", () => {
  async function accepted(api: FakeApi) {
    await approveAndAccept(api, P.quoteRepaired);
  }

  it("a ready preview is a link on the preview origin, opened without referrer; clients see it too", async () => {
    const { PreviewCard } = await import("../src/screens/ReleasePanels.js");
    const ready = { previewId: "pv-1", proposalId: P.quoteRepaired, proposalHash: "a".repeat(64), forCurrentHash: true, state: "ready" as const, createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:01:00.000Z", expiresAt: "2026-10-07T10:01:00.000Z", url: "https://commonforge-preview.example.workers.dev/p/o-1/pv-1/tok/", error: null };
    for (const role of ["owner", "client"] as const) {
      const html = renderToString(createElement(PreviewCard, { role, preview: { previews: [ready], blockedWhy: null, onRequest: noop, busy: false, error: null } }));
      expect(html).toContain('href="https://commonforge-preview.example.workers.dev/p/o-1/pv-1/tok/"');
      expect(html).toContain('rel="noopener noreferrer"');
      expect(html).toContain("never to production");
      expect(html.includes("Build a new preview")).toBe(role === "owner");
    }
    const failed = renderToString(createElement(PreviewCard, { role: "client", preview: { previews: [{ ...ready, state: "failed", url: null, error: { code: "check_failed" } }], blockedWhy: null, onRequest: noop, busy: false, error: null } }));
    expect(failed).toContain("The preview build failed");
    expect(failed).not.toContain("Open preview");
  });

  it("publishing: prepare → owner publish approval → publish; Approved, not live until the deploy is verified", async () => {
    const now = { t: Date.parse("2026-10-06T12:00:00.000Z") };
    const api = new FakeApi({ role: "owner", now: () => now.t, integrationMs: 10 });
    await accepted(api);
    const acceptedVersionId = (await api.listVersions(ORG, R.website))[0]!.acceptedVersionId;
    const { PublishStep, releaseFor } = await import("../src/screens/ReleasePanels.js");
    // the fixture's imported version is already live: an unknown version never borrows its release
    expect(releaseFor(await api.listReleases(ORG, PID), null)).toBeNull();
    const render = async (role: Role) => {
      api.role = role;
      const releases = await api.listReleases(ORG, PID);
      return renderToString(createElement(PublishStep, { role, accepted: true, publish: { releases, acceptedVersionId, onPrepare: noop, onApprove: noop, onDeploy: noop, busy: null, error: null } }));
    };
    expect(await render("owner")).toContain("Prepare release");
    api.role = "owner";
    const rel = await api.prepareRelease(ORG, PID);
    expect(await render("owner")).toContain("Building the release");
    now.t += 2000;
    expect(await render("developer")).toContain("Waiting for a publish approval.");
    const owner = await render("owner");
    expect(owner).toContain("Approve publishing this release");
    expect(owner).not.toContain("Publish to production");
    // accepting is not publishing: deploy before the publish approval is refused
    await expect(api.deployRelease(ORG, rel.releaseId, "deploy:test-0001")).rejects.toMatchObject({ code: "publish_approval_required" });
    const list = await api.listReleases(ORG, PID);
    api.role = "developer";
    await expect(api.approvePublish(ORG, rel.releaseId, list.releases[0]!.outputDigest!)).rejects.toMatchObject({ code: "publish_role_not_allowed" });
    api.role = "owner";
    await api.approvePublish(ORG, rel.releaseId, list.releases[0]!.outputDigest!);
    const approved = await render("owner");
    expect(approved).toContain("Approved, not live");
    expect(approved).toContain("Publish to production");
    await api.deployRelease(ORG, rel.releaseId, "deploy:test-0002");
    expect(await render("owner")).toContain("Deploying");
    now.t += 2000;
    const live = await render("owner");
    expect(live).toContain("pill-good");
    expect(live).toContain("cfapp-o-fixture-api");
  });

  it("n-3: the latest proposal of a Change is the newest created, not the last updated", async () => {
    const { latestPerChange } = await import("../src/lib/model.js");
    const sum = (id: string, createdAt: string, updatedAt: string) => ({ proposalId: id, proposalHash: "a".repeat(64), projectId: PID, changeId: "chg-a", state: "prepared" as const, createdAt, updatedAt });
    // prop-1 (older) finished preparing after prop-2 was created: prop-2 is still the latest
    const latest = latestPerChange([sum("prop-1", "2026-10-06T10:00:00.000Z", "2026-10-06T12:00:00.000Z"), sum("prop-2", "2026-10-06T11:00:00.000Z", "2026-10-06T11:00:00.000Z")]);
    expect(latest.get("chg-a")).toBe("prop-2");
  });

  it("n-4: an expired run never masks an earlier passing validation; without one it says Validation expired, run again", async () => {
    const { validationSummary, proposalStatus } = await import("../src/lib/model.js");
    const api = new FakeApi({ role: "owner" });
    const p = await api.getProposal(ORG, P.quoteRepaired);
    expect(p.integration).not.toBeNull();
    const expired = { state: "failed" as const, expired: false, forCurrentHash: true, requestedAt: "2026-10-06T10:00:00.000Z", completedAt: "2026-10-06T11:00:00.000Z", code: "job_expired", checks: [], contractChecks: [], mergeOutcome: [], conflictPaths: [], signedEvidence: false };
    expect(validationSummary({ ...p, lastAttempt: expired }).verdict).toBe("passed");
    const none = { ...p, integration: null, lastAttempt: expired };
    expect(validationSummary(none)).toMatchObject({ verdict: "not-run", expired: true });
    expect(proposalStatus(none).label).toBe("Validation expired, run again");
  });
});

describe("re-review R3: a result that was never recorded", () => {
  it("reads failed with a plain sentence, and Validate again is enabled", async () => {
    const { validationSummary } = await import("../src/lib/model.js");
    const api = new FakeApi({ role: "owner" });
    const brand = await api.getProposal(ORG, P.brandRefresh);
    const stuck = {
      ...brand,
      integration: null,
      lastAttempt: { state: "failed" as const, expired: false, forCurrentHash: true, requestedAt: "2026-10-06T10:00:30.000Z", completedAt: "2026-10-06T10:01:00.000Z", code: "receipt_not_recorded", checks: [{ checkId: "website-build", result: "pass" }], contractChecks: [], mergeOutcome: [], conflictPaths: [], signedEvidence: true },
    };
    const v = validationSummary(stuck);
    expect(v).toMatchObject({ verdict: "failed", failures: ["The validation result could not be recorded. Validate again"] });
    const html = renderToString(createElement(EvidenceView, { p: stuck, v, developer: true, onValidate: noop, validateBusy: false, validateError: null }));
    expect(html).toContain("Validate again");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Validate again/);
  });
});

describe("assets-only proposals (follow-up Task 23)", () => {
  it("can be validated (the runner runs the checks against the code at the proposal's base) but not previewed", async () => {
    const { validationSummary } = await import("../src/lib/model.js");
    const api = new FakeApi({ role: "owner" });
    const brand = await api.getProposal(ORG, P.brandRefresh);
    const logoOnly = { ...brand, resourceChanges: [], integration: null, lastAttempt: null };
    const html = renderToString(createElement(EvidenceView, { p: logoOnly, v: validationSummary(logoOnly), developer: true, onValidate: noop, validateBusy: false, validateError: null }));
    expect(html).toContain("changes assets only");
    expect(html).toContain("Run validation");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Run validation/);
    expect(previewBlocked(logoOnly)).toBe("Asset-only changes have nothing to preview.");
  });

  it("staging phase 4-2 (P42-2): a staging-mode project offers no preview, with the reason", async () => {
    const api = new FakeApi({ role: "owner" });
    const p = await api.getProposal(ORG, P.quoteRepaired);
    const integrated = { ...p, integration: { ...p.integration!, forCurrentHash: true } };
    expect(previewBlocked(integrated)).toBeNull();
    expect(previewBlocked(integrated, true)).toBe("Staging replaces previews in this project.");
  });
});

describe("version kinds", () => {
  it("labels the ledger's genesis bind as the import", () => {
    const base = { acceptedVersionId: "av-1", sequence: 1, proposalId: null, proposalHash: null, acceptedAt: "2026-10-06T00:00:00.000Z" };
    expect(versionLabel({ ...base, kind: "bind" } as never)).toBe("Imported (first version)");
    expect(versionLabel({ ...base, kind: "restore" } as never)).toBe("Restored an earlier version");
  });
});

describe("publish problems (Task 22 review I-4, I-5)", () => {
  const base = { releaseId: "rel-1", projectId: PID, acceptedVersionId: "av-1", recipeRevision: 1, envDigest: "e".repeat(64), outputDigest: "o".repeat(64), buildState: "built" as const, live: false, publishApproved: true, deployAttempts: 1, createdAt: "2026-10-06T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z", error: { code: "health_check_failed" }, deployments: [], health: null };
  const render = async (rel: Record<string, unknown>) => {
    const { PublishStep } = await import("../src/screens/ReleasePanels.js");
    return renderToString(createElement(PublishStep, { role: "owner", accepted: true, publish: { releases: { releases: [{ ...base, ...rel } as never], live: null }, acceptedVersionId: "av-1", onPrepare: noop, onApprove: noop, onDeploy: noop, busy: null, error: null } }));
  };
  it("never claims the previous release is live while production may run the new one", async () => {
    const rolling = await render({ state: "recovery_required", status: "Not verified, rolling back", rollback: { state: "running" } });
    expect(rolling).toContain("being rolled back");
    expect(rolling).not.toContain("still live");
    expect(rolling).not.toContain("Retry publish");
    const stuck = await render({ state: "recovery_required", status: "Recovery required: production is unverified", rollback: { state: "failed" } });
    expect(stuck).toContain("Production may be running this release unverified");
    expect(stuck).not.toContain("mark recovered"); // no onRecover handler given in this render
    expect(stuck).toContain("Retry publish");
    const rolledBack = await render({ state: "failed", status: "Approved, not live", rollback: { state: "done" } });
    expect(rolledBack).toContain("rolled back: the previous release is live again");
    const partial = await render({ state: "partial", status: "Partly deployed, retry to finish" });
    expect(partial).toContain("Retry to finish publishing");
  });
});

describe("client overview (UX-2)", () => {
  async function overview(mutate?: (api: FakeApi) => Promise<void>, role: "client" | "viewer" = "client", opts: { noReleases?: boolean; staging?: boolean } = {}) {
    const api = new FakeApi({ role: "owner" });
    if (mutate) await mutate(api);
    api.role = role;
    const project = await api.getProject(ORG, PID);
    const loaded = await loadLive(api, ORG, PID, role);
    const live = opts.staging ? { ...loaded, staging: { enabled: true as const, state: "active" as const, stateText: null, baseline: { since: "2026-10-11T00:00:00.000Z" }, url: null, current: null, building: false, landings: [] } } : loaded;
    const history = await loadHistory(api, ORG, PID, project);
    const updates = await loadClientUpdates(api, ORG, PID);
    return renderToString(createElement(ClientOverviewView, { project, org: ORG, pid: PID, live, history: opts.noReleases ? { ...history, releases: undefined } : history, updates, role }));
  }

  it("is the mockup: Your <project> with what is live, Start an update, Open the live site, Needs you, rails, versions, the trust line", async () => {
    const html = await overview();
    expect(html).toContain("<h1");
    expect(html).toContain("Your Customer Portal");
    expect(html).toMatch(/badge-ready[^>]*>.*Live/);
    expect(html).toContain("Version 1 · published");
    expect(html).toContain(">Start an update</button>");
    expect(html).toMatch(/href="https:\/\/cfapp-o-fixture-website\.fixture\.invalid"[^>]*>Open the live site/);
    expect(html).toContain('data-testid="needs-you"');
    expect(html).toContain("All checks passed · test data only");
    expect(html).toContain("Next: you review and approve. Your developer publishes.");
    expect(html).toContain('aria-label="Progress"');
    expect(html).toContain("First version, imported");
    expect(html).toContain("The production repository and its history are never shared");
    // plain language: no raw ids, shas or ISO times
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/\d{4}-\d{2}-\d{2}T|prop-|chg-|av-|art:|[0-9a-f]{16}/);
  });

  it("staging phase 4-2 (P42-2): a staging-mode project offers no Start an update (clients work in tasks)", async () => {
    const html = await overview(undefined, "client", { staging: true });
    expect(html).toContain("Your Customer Portal");
    expect(html).not.toContain("Start an update");
  });

  it("an accepted update waits on the developer's publish (Approved is current, not Published)", async () => {
    const html = await overview((api) => approveAndAccept(api, P.quoteRepaired));
    expect(html).toContain("Your developer will publish.");
    expect(html).toMatch(/rail-current[^>]*aria-current="step"[^>]*>(?:(?!<\/li>).)*Approved/);
    expect(html).toMatch(/Version 2<\/span><span class="muted small">Current/);
    // the live version is marked Live, not offered for restore
    expect(html).toMatch(/Version 1<\/span><span class="co-version-live-label">Live/);
    expect(html).not.toContain("Restore this version");
  });

  it("UX-2 review m3: without read on the release service, accepted updates leave the list", async () => {
    const html = await overview((api) => approveAndAccept(api, P.quoteRepaired), "client", { noReleases: true });
    expect(html).not.toContain("Your developer will publish.");
    expect(html).toContain("Update to Requirements and Brand and media");
  });

  it("UX-2 review I1: viewers are never asked to act: no Start an update, no approve card, no restore links, neutral next steps", async () => {
    const html = await overview(async (api) => {
      await approveAndAccept(api, P.quoteRepaired);
      api.role = "owner";
    }, "viewer");
    const client = await overview(undefined, "client");
    expect(client).toContain("Review result");
    const viewer = await overview(undefined, "viewer");
    expect(viewer).not.toContain("Start an update");
    expect(viewer).not.toContain("Review result");
    expect(viewer).not.toContain("you review and approve");
    expect(viewer).toContain("Waiting for approval.");
    expect(viewer).toContain("Nothing is waiting on you.");
    expect(html).not.toContain("Ask to restore");
  });
});
