/** Design-system primitives (UX-1): pure state logic directly, components by server rendering. */
import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AppHeader,
  Badge,
  Chip,
  CLIENT_STEPS,
  ConfirmSheet,
  CountBadge,
  DEVELOPER_STEPS,
  DropZone,
  EmptyState,
  Icon,
  ICON_NAMES,
  initials,
  InspectorDrawer,
  InspectorToggle,
  NeedsYou,
  railPosition,
  resourceIcon,
  SideNav,
  StateRail,
  stateOfTone,
  stepStatus,
  Timeline,
} from "../src/primitives/index.js";
import { navItems } from "../src/screens/ProjectShell.js";
import { updateRegistry } from "../src/screens/project-data.js";

const noop = () => {};
const html = (el: Parameters<typeof render>[0]) => render(el).replace(/<!-- -->/g, "");

describe("state palette", () => {
  it("maps every model tone onto the fixed state colours", () => {
    expect(stateOfTone("busy")).toBe("working");
    expect(stateOfTone("info")).toBe("ready");
    expect(stateOfTone("good")).toBe("ready");
    expect(stateOfTone("warn")).toBe("decision");
    expect(stateOfTone("bad")).toBe("blocked");
    expect(stateOfTone("muted")).toBe("superseded");
    expect(stateOfTone("neutral")).toBe("neutral");
  });

  it("derives initials from a name or an email", () => {
    expect(initials("Jordan Lee")).toBe("JL");
    expect(initials("client@customer.example")).toBe("CL");
    expect(initials("dev.owner@x.y")).toBe("DO");
  });
});

describe("rail positions", () => {
  it("client rail: five steps, review waits on the client, approval waits on the developer, live completes", () => {
    expect(CLIENT_STEPS).toEqual(["Working", "Preview ready", "Approved", "Published", "Live"]);
    expect(railPosition("client", "Integrating")).toEqual({ current: 0, state: "working", complete: false });
    expect(railPosition("client", "NeedsResolution").state).toBe("blocked");
    expect(railPosition("client", "ReadyForReview")).toEqual({ current: 1, state: "decision", complete: false });
    // UX-2 review: after the client approves, the current dot is Approved (waiting on the developer), not Published
    expect(railPosition("client", "Approved")).toEqual({ current: 2, state: "working", complete: false });
    expect(railPosition("client", "Accepted")).toEqual({ current: 2, state: "working", complete: false });
    expect(railPosition("client", "Accepted", { publishing: true })).toEqual({ current: 3, state: "working", complete: false });
    expect(railPosition("client", "Accepted", { live: true })).toEqual({ current: 4, state: "ready", complete: true });
  });

  it("developer rail: eight steps from request to live", () => {
    expect(DEVELOPER_STEPS).toEqual(["Request", "Work", "Check", "Review", "Approve", "Accept", "Publish", "Live"]);
    expect(railPosition("developer", "Running").current).toBe(1);
    // UX-1 review M-3: a failed check waits on the developer's decision (amber, as in the mockup)
    expect(railPosition("developer", "NeedsResolution")).toEqual({ current: 2, state: "decision", complete: false });
    expect(railPosition("developer", "Failed").state).toBe("blocked");
    expect(railPosition("developer", "ReadyForReview").current).toBe(3);
    // with something to look at (a preview, or nothing to preview) Approve is the current step
    expect(railPosition("developer", "ReadyForReview", { reviewReady: true })).toEqual({ current: 4, state: "decision", complete: false });
    expect(railPosition("developer", "Accepted", { publishApproved: true })).toEqual({ current: 6, state: "decision", complete: false });
    expect(railPosition("developer", "Accepted", { publishFailed: true })).toEqual({ current: 6, state: "blocked", complete: false });
    expect(railPosition("developer", "Approved").current).toBe(5);
    expect(railPosition("developer", "Accepted").current).toBe(6);
    expect(railPosition("developer", "Superseded").state).toBe("superseded");
  });

  it("step status: before the current step is done, after it is todo, all done when complete", () => {
    const pos = { current: 2, complete: false };
    expect([0, 1, 2, 3].map((i) => stepStatus(i, pos))).toEqual(["done", "done", "current", "todo"]);
    expect(stepStatus(4, { current: 4, complete: true })).toBe("done");
  });
});

describe("StateRail", () => {
  it("renders an ordered list with the current step marked and pulsing", () => {
    const out = html(createElement(StateRail, { variant: "client", position: railPosition("client", "ReadyForReview"), testId: "decision-rail" }));
    expect(out).toContain('<ol class="rail rail-client" aria-label="Progress" data-testid="decision-rail">');
    expect((out.match(/class="rail-step /g) ?? []).length).toBe(5);
    expect(out).toMatch(/class="rail-step rail-current rail-state-decision" aria-current="step"/);
    expect(out).toContain("rail-pulse");
    // aria-current says "current"; the spoken word is the step's state
    expect(out).toContain("Preview ready<span class=\"sr-only\"> (waiting for a decision)</span>");
    expect(out).not.toContain("current step");
    expect(out).toContain("Working<span class=\"sr-only\"> (done)</span>");
  });

  it("developer rail shows check marks on done steps; a complete rail does not pulse", () => {
    const dev = html(createElement(StateRail, { variant: "developer", position: railPosition("developer", "Approved") }));
    expect((dev.match(/class="rail-step /g) ?? []).length).toBe(8);
    expect((dev.match(/<svg/g) ?? []).length).toBe(5);
    expect(dev).toContain('aria-label="Change progress"');
    const live = html(createElement(StateRail, { variant: "client", position: railPosition("client", "Accepted", { live: true }) }));
    expect(live).not.toContain("rail-pulse");
    expect(live).not.toContain('aria-current="step"');
    const blocked = html(createElement(StateRail, { variant: "developer", position: railPosition("developer", "NeedsResolution") }));
    expect(blocked).toContain("Check<span class=\"sr-only\"> (waiting for a decision)</span>");
  });

  it("carries optional per-step detail and test ids", () => {
    const out = html(createElement(StateRail, { variant: "developer", position: railPosition("developer", "Accepted"), meta: [undefined, undefined, undefined, undefined, "Client · a3f9", "You · a3f9"], stepTestIds: [undefined, undefined, undefined, undefined, "rail-approve"] }));
    expect(out).toContain('<span class="rail-meta">Client · a3f9</span>');
    expect((out.match(/rail-meta/g) ?? []).length).toBe(2);
    expect(out).toContain('data-testid="rail-approve"');
  });
});

describe("badges and chips", () => {
  it("a badge never relies on colour alone: it carries a glyph or a dot and its text", () => {
    const b = html(createElement(Badge, { state: "decision", icon: true, size: "lg" }, "Needs your decision"));
    expect(b).toContain('class="badge badge-decision badge-lg"');
    expect(b).toContain("<svg");
    expect(b).toContain("Needs your decision");
    expect(html(createElement(Badge, { state: "working", pulse: true }, "Working"))).toContain("badge-dot pulse");
  });

  it("an evidence chip states its result in words for screen readers", () => {
    const c = html(createElement(Chip, { result: "fail", testId: "contract-fail-chip" }, "Contract quote failed"));
    expect(c).toContain('data-testid="contract-fail-chip"');
    expect(c).toContain("evidence-chip-blocked");
    expect(c).toContain('<span class="sr-only"> (failed)</span>');
  });

  it("a count badge hides at zero and can carry a spoken label", () => {
    expect(html(createElement(CountBadge, { count: 0 }))).toBe("");
    const c = html(createElement(CountBadge, { count: 2, state: "decision", label: "Needs your decision · 2" }));
    expect(c).toContain("count-badge-decision");
    expect(c).toContain('<span class="sr-only">Needs your decision · 2</span><span aria-hidden="true">2</span>');
  });
});

describe("icons", () => {
  it("has the six object icons and every icon is decorative unless labelled", () => {
    for (const n of ["repo", "assets", "notes", "edition", "agent", "human"] as const) expect(ICON_NAMES).toContain(n);
    for (const n of ICON_NAMES) expect(html(createElement(Icon, { name: n }))).toContain('aria-hidden="true"');
    expect(html(createElement(Icon, { name: "agent", label: "Agent" }))).toContain('role="img" aria-label="Agent"');
  });

  it("picks an object icon per resource", () => {
    expect(resourceIcon("r2-assets", "Brand and media")).toBe("assets");
    expect(resourceIcon("artifacts", "Requirements")).toBe("notes");
    expect(resourceIcon("artifacts", "Website")).toBe("repo");
  });
});

describe("inspector drawer", () => {
  const sections = [{ title: "Proposal", rows: [{ label: "Proposal hash", value: "a3f9 2c71", copy: "a3f92c71" }, { label: "Ledger", value: "accept blocked: evidence_missing", tone: "bad" as const }] }];

  it("renders nothing when closed and a labelled complementary region with copy buttons when open", () => {
    expect(html(createElement(InspectorDrawer, { open: false, onClose: noop, sections }))).toBe("");
    const out = html(createElement(InspectorDrawer, { open: true, onClose: noop, sections }));
    expect(out).toMatch(/<aside id="cf-inspector" class="inspector" aria-labelledby="cf-inspector-title">/);
    expect(out).toContain('<h2 id="cf-inspector-title" tabindex="-1">Inspector</h2>');
    expect(out).toContain('aria-label="Copy Proposal hash"');
    expect(out).toContain('aria-label="Close inspector"');
    expect(out).toContain('<dd class="mono">');
    expect(out).toContain("inspector-bad");
    expect((out.match(/copy-btn/g) ?? []).length).toBe(1);
  });

  it("the toggle says whether the drawer is open and which element it controls", () => {
    const closed = html(createElement(InspectorToggle, { open: false, onToggle: noop }));
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("aria-controls"); // no reference to an element that is not rendered
    expect(html(createElement(InspectorToggle, { open: true, onToggle: noop }))).toMatch(/aria-expanded="true" aria-controls="cf-inspector"/);
  });
});

describe("timeline, confirm sheet, empty state, drop zone, needs you", () => {
  it("a timeline is an ordered, labelled list with state classes", () => {
    const out = html(createElement(Timeline, { label: "Versions", testId: "versions-timeline", items: [{ key: "7", title: "Version 7", meta: "2 days ago", state: "ready", current: true, icon: "versions" }, { key: "6", title: "Version 6" }] }));
    expect(out).toContain('<ol class="timeline" aria-label="Versions" data-testid="versions-timeline">');
    expect(out).toContain("timeline-ready timeline-current");
    expect(out).toContain('aria-current="true"');
    expect(out).toContain("2 days ago");
    const v = html(createElement(Timeline, { label: "Versions", items: [{ key: "7", title: "Version 7", className: "version version-current", testId: "version-7" }] }));
    expect(v).toContain('class="timeline-item timeline-neutral version version-current" data-testid="version-7"');
  });

  it("inspector registry: keyed, in registration order, removable", () => {
    const a = [{ title: "A", rows: [] }];
    const b = [{ title: "B", rows: [] }];
    let reg = updateRegistry([], "x", a);
    reg = updateRegistry(reg, "y", b);
    expect(reg.map((r) => r.id)).toEqual(["x", "y"]);
    reg = updateRegistry(reg, "x", b);
    expect(reg.map((r) => r.sections[0]!.title)).toEqual(["B", "B"]);
    expect(updateRegistry(reg, "x", null).map((r) => r.id)).toEqual(["y"]);
    expect(updateRegistry(reg, "zz", null)).toHaveLength(2);
  });

  it("a confirm sheet says what the action does and does not do, with one primary action", () => {
    const out = html(createElement(ConfirmSheet, { title: "Restore this version?", does: "Records a new version.", doesNot: "Does not undo database changes.", confirmLabel: "Restore this version", onConfirm: noop, onCancel: noop }));
    expect(out).toContain('class="confirm confirm-decision"');
    expect(out).toContain('aria-label="Restore this version?"');
    expect(out).toContain("Does not undo database changes.");
    expect((out.match(/btn-primary/g) ?? []).length).toBe(1);
    expect(out).toContain(">Cancel</button>");
    expect(html(createElement(ConfirmSheet, { confirmLabel: "Restore", busy: true, onConfirm: noop, onCancel: noop }))).toMatch(/disabled=""[^>]*>Restore…</);
  });

  it("an empty state speaks to the client", () => {
    expect(html(createElement(EmptyState, { title: "No updates yet. Start one when you're ready." }))).toContain("No updates yet. Start one when you&#x27;re ready.");
  });

  it("a drop zone keeps a real, labelled file input", () => {
    const out = html(createElement(DropZone, { inputLabel: "Edited working copy (ZIP)", accept: ".zip", file: null, onFile: noop }));
    expect(out).toMatch(/<input[^>]*type="file"[^>]*accept=".zip"[^>]*aria-label="Edited working copy \(ZIP\)"/);
    expect(out).toContain("Drop your file here");
  });

  it("needs you: one primary action per item, a count, and a calm empty line", () => {
    const out = html(createElement(NeedsYou, { items: [{ key: "a", title: "Quote breakdown", detail: "Preview is ready.", evidence: "All checks passed", evidenceOk: true, href: "/x", action: "Review result" }] }));
    expect(out).toContain('data-testid="needs-you"');
    expect(out).toContain(">Review result</a>");
    expect(out).toContain("count-badge-decision");
    expect(html(createElement(NeedsYou, { items: [] }))).toContain("Nothing is waiting on you.");
    // two stacks on one page: distinct heading ids, own test ids
    const two = html(createElement("div", null, createElement(NeedsYou, { items: [] }), createElement(NeedsYou, { items: [], testId: "needs-you-2" })));
    const ids = [...two.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
    expect(two).toContain('data-testid="needs-you-2"');
  });
});

describe("shell", () => {
  it("header: dark logo, breadcrumb, viewing-as chip, inspector toggle only when given", () => {
    const dev = html(createElement(AppHeader, { crumbs: [{ label: "Demo Client", href: "/" }, { label: "Customer Portal", href: "/p" }, { label: "Changes" }], role: "owner", user: "owner@studio.example", onSignOut: noop, inspector: { open: false, onToggle: noop } }));
    expect(dev).toContain('src="/brand/commonforge-headerlogo-dark.png" alt="CommonForge"');
    expect(dev).toContain('<nav class="crumbbar" aria-label="Breadcrumb">');
    expect(dev).toContain('<span class="crumb-current" aria-current="page">Changes</span>');
    expect(dev).toContain("Viewing as developer");
    expect(dev).toContain(">Inspector</button>");
    expect(dev).toContain(">Sign out</button>");
    const client = html(createElement(AppHeader, { role: "client", user: "client@customer.example" }));
    expect(client).toContain("Viewing as client");
    expect(client).not.toContain("Inspector");
  });

  it("left nav: five sections, the active one marked, decisions counted on Changes", () => {
    const out = html(createElement(SideNav, { items: navItems("o-1", "p-1", 2), active: "changes" }));
    for (const s of ["Overview", "Files", "Changes", "Versions", "Activity"]) expect(out).toContain(s);
    expect(out).toContain('aria-label="Project sections"');
    expect(out).toMatch(/href="\/o\/o-1\/p\/p-1\/changes"[^>]*aria-current="page"/);
    expect(out).toContain("Needs your decision · 2");
  });
});
