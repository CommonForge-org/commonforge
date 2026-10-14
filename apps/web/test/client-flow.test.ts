import { describe, expect, it } from "vitest";
import type { Proposal, ReleaseList, VersionEntry } from "../src/api/types.js";
import {
  askDeveloperHref,
  blockedSentence,
  clientChecks,
  clientNextStep,
  editionLook,
  isVersionLive,
  liveHeadPerResource,
  liveSite,
  proposalReleaseFacts,
  projectVersions,
  relativeTime,
  returnSummary,
  versionOfProposal,
  versionSummary,
} from "../src/lib/client-flow.js";
import { formatTime } from "../src/lib/model.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const DAY = 86_400_000;

describe("relativeTime: never an ISO timestamp", () => {
  it("reads like speech at every distance", () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("just now");
    expect(relativeTime(ago(MIN), NOW)).toBe("1 min ago");
    expect(relativeTime(ago(42 * MIN), NOW)).toBe("42 min ago");
    expect(relativeTime(ago(60 * MIN), NOW)).toBe("1 hour ago");
    expect(relativeTime(ago(5 * 60 * MIN), NOW)).toBe("5 hours ago");
    expect(relativeTime(ago(DAY), NOW)).toBe("yesterday");
    expect(relativeTime(ago(2 * DAY), NOW)).toBe("2 days ago");
    expect(relativeTime(ago(9 * DAY), NOW)).toBe("9 days ago");
    expect(relativeTime(ago(21 * DAY), NOW)).toBe("3 weeks ago");
    expect(relativeTime(ago(70 * DAY), NOW)).toBe("2 months ago");
    expect(relativeTime(ago(400 * DAY), NOW)).toBe("over a year ago");
  });

  it("handles the future and garbage without leaking the input", () => {
    expect(relativeTime(new Date(NOW.getTime() + 5 * MIN).toISOString(), NOW)).toBe("just now");
    expect(relativeTime("not a date", NOW)).toBe("some time ago");
  });

  it("formatTime (every screen) is relative too, and says when a future time is", () => {
    expect(formatTime(ago(3 * DAY), NOW)).toBe("3 days ago");
    expect(formatTime(ago(5_000), NOW)).toBe("just now");
    expect(formatTime(new Date(NOW.getTime() + 40 * MIN).toISOString(), NOW)).toBe("in 40 min");
    expect(formatTime(new Date(NOW.getTime() + 60 * MIN).toISOString(), NOW)).toBe("in 1 hour");
    expect(formatTime(new Date(NOW.getTime() + 3 * DAY).toISOString(), NOW)).toBe("in 3 days");
  });
});

describe("returnSummary: N files changed · M blocked", () => {
  it("counts changes and blocked files in one plain line", () => {
    expect(returnSummary({ changes: [{ path: "a", kind: "modified" }, { path: "b", kind: "added" }], blocked: [] }).text).toBe("2 files changed · 0 blocked");
    expect(returnSummary({ changes: [{ path: "a", kind: "modified" }], blocked: [{ path: "package.json", reason: "protected" }] })).toEqual({ changed: 1, blocked: 1, text: "1 file changed · 1 blocked" });
    expect(returnSummary({ changes: [], blocked: [] }).text).toBe("0 files changed · 0 blocked");
  });
});

describe("blockedSentence: one sentence, cause and what to do", () => {
  it("explains each refusal reason", () => {
    expect(blockedSentence({ path: "package.json", reason: "protected" })).toBe("package.json was not taken over: your developer protects this file.");
    expect(blockedSentence({ path: "src/x.ts", reason: "read_only" })).toBe("src/x.ts was not taken over: this working copy lets you read it but not change it.");
    expect(blockedSentence({ path: "secret.txt", reason: "not_mapped" })).toBe("secret.txt was not taken over: it is not part of this working copy.");
    expect(blockedSentence({ path: "../x", reason: "path_escape" })).toBe("../x was not taken over: it is outside the working copy folder.");
    expect(blockedSentence({ path: "Readme.md", reason: "case_collision" })).toBe("Readme.md was not taken over: another file has the same name in different upper or lower case.");
    expect(blockedSentence({ path: "a/b", reason: "path_conflict" })).toBe("a/b was not taken over: it clashes with a file or folder of the same name.");
    expect(blockedSentence({ path: "z", reason: "something_new" })).toBe("z was not taken over: your developer's rules do not allow it.");
  });
});

describe("askDeveloperHref", () => {
  it("is a mailto with an encoded subject and body and no invented recipient", () => {
    const href = askDeveloperHref("Please restore Version 2", "Hi,\nplease restore it & thanks");
    expect(href).toBe("mailto:?subject=Please%20restore%20Version%202&body=Hi%2C%0Aplease%20restore%20it%20%26%20thanks");
  });
});

function proposal(over: Partial<Proposal> = {}): Pick<Proposal, "integration" | "lastAttempt" | "stale" | "state"> {
  return { state: "prepared", stale: [], integration: null, lastAttempt: null, ...over };
}

const attempt = (state: "queued" | "applying" | "succeeded" | "failed", forCurrentHash = true, code: string | null = state === "failed" ? "contract_failed" : null) => ({
  state,
  expired: false,
  forCurrentHash,
  requestedAt: ago(MIN),
  completedAt: state === "queued" ? null : ago(0),
  code,
  checks: [{ checkId: "website-build", result: state === "failed" ? "fail" : "pass" }],
  contractChecks: [],
  mergeOutcome: [],
  conflictPaths: [],
  signedEvidence: true,
});

describe("clientChecks: the review chip", () => {
  it("passed is green; a failure, an outdated run or a moved base needs a developer decision", () => {
    expect(clientChecks(proposal({ lastAttempt: attempt("succeeded") }))).toEqual({ kind: "passed", label: "Checks passed", state: "ready", detail: "Your developer's checks passed on the combined result." });
    expect(clientChecks(proposal({ lastAttempt: attempt("failed") }))).toEqual({ kind: "decision", label: "Needs a developer decision", state: "decision", detail: "The checks found a problem. Your developer decides how to fix it." });
    expect(clientChecks(proposal({ lastAttempt: attempt("succeeded", false) }))).toMatchObject({ kind: "decision", detail: "The last check was for an earlier version of this result. Your developer will check it again." });
    expect(clientChecks(proposal({ lastAttempt: attempt("queued") }))).toEqual({ kind: "running", label: "Checking the result", state: "working", detail: "Your developer's checks are running on the combined result." });
    expect(clientChecks(proposal())).toEqual({ kind: "waiting", label: "Checks have not run yet", state: "neutral", detail: "Your developer runs the checks before you approve." });
  });

  it("Task 23 integration states read in plain language", () => {
    // runner done, ledger not yet: still running
    expect(clientChecks(proposal({ lastAttempt: attempt("applying") }))).toEqual({ kind: "running", label: "Recording the check result", state: "working", detail: "The checks finished. Their result is being recorded." });
    // the result never reached the ledger
    expect(clientChecks(proposal({ lastAttempt: attempt("failed", true, "receipt_not_recorded") }))).toMatchObject({ kind: "decision", label: "Needs a developer decision", detail: "The check result was lost. Your developer will run the checks again." });
    // a base or policy reference moved (dependency_stale at accept)
    expect(clientChecks(proposal({ lastAttempt: attempt("succeeded"), stale: ["res-1"] }))).toMatchObject({ kind: "decision", detail: "Out of date: a newer change was accepted first. Your developer will bring this up to date." });
    // a run replaced by a newer one never decides anything
    expect(clientChecks(proposal({ lastAttempt: attempt("failed", true, "integration_superseded") }))).toMatchObject({ kind: "decision", detail: "A newer check replaced this one. Your developer will run the checks again." });
  });
});

describe("clientNextStep: one line, what happens next", () => {
  it("names who acts next at every stage of the client rail", () => {
    expect(clientNextStep("ReadyForReview")).toBe("Next: you review and approve. Your developer publishes.");
    expect(clientNextStep("Approved")).toBe("Your developer will publish.");
    expect(clientNextStep("Accepted")).toBe("Your developer will publish.");
    expect(clientNextStep("Accepted", { publishing: true })).toBe("Publishing to your live site now.");
    expect(clientNextStep("Accepted", { live: true })).toBe("Live on your site.");
    expect(clientNextStep("NeedsResolution")).toBe("Your developer is fixing a problem the checks found.");
    expect(clientNextStep("Stale")).toBe("Your developer is bringing this up to date.");
    expect(clientNextStep("Integrating")).toBe("Nothing for you yet.");
    expect(clientNextStep("Running")).toBe("Nothing for you yet.");
  });

  it("viewers are never asked to act", () => {
    expect(clientNextStep("ReadyForReview", {}, "viewer")).toBe("Waiting for approval.");
    expect(clientNextStep("Integrating", {}, "viewer")).toBe("In progress.");
    expect(clientNextStep("Approved", {}, "viewer")).toBe("Your developer will publish.");
  });
});

const v = (id: string, seq: number, kind: VersionEntry["kind"], rid: string, at: string, proposalId: string | null = null): VersionEntry => ({ acceptedVersionId: id, sequence: seq, kind, proposalId, proposalHash: proposalId ? "h".repeat(64) : null, acceptedAt: at, head: { resourceId: rid, revisionId: `rev-${id}-${rid}` } });

describe("projectVersions: one numbered history for the whole project", () => {
  const website = { resourceId: "r-w", name: "Website", versions: [v("av-acc", 6, "accept", "r-w", ago(2 * DAY), "prop-1"), v("av-bind-w", 1, "accept", "r-w", ago(30 * DAY))] };
  const api = { resourceId: "r-a", name: "API", versions: [v("av-res", 7, "restore", "r-a", ago(DAY)), v("av-acc", 6, "accept", "r-a", ago(2 * DAY), "prop-1"), v("av-bind-a", 2, "bind", "r-a", ago(30 * DAY))] };
  const brand = { resourceId: "r-b", name: "Brand", versions: [v("av-bind-b", 3, "accept", "r-b", ago(30 * DAY))] };

  it("merges the genesis binds into Version 1, groups a multi-resource accept, numbers forward, newest first", () => {
    const pv = projectVersions([website, api, brand]);
    expect(pv.map((x) => [x.number, x.kind, x.resources])).toEqual([
      [3, "restore", ["API"]],
      [2, "accept", ["Website", "API"]],
      [1, "import", ["Website", "API", "Brand"]],
    ]);
    expect(pv[2]!.ids).toEqual(["av-bind-w", "av-bind-a", "av-bind-b"]);
    expect(pv[1]!.proposalId).toBe("prop-1");
    expect(pv[1]!.at).toBe(ago(2 * DAY));
  });

  it("a resource imported after work started is its own version", () => {
    const late = { resourceId: "r-n", name: "Notes", versions: [v("av-bind-n", 8, "bind", "r-n", ago(0))] };
    const pv = projectVersions([website, api, brand, late]);
    expect(pv[0]).toMatchObject({ number: 4, kind: "import", resources: ["Notes"] });
  });

  it("is empty without versions", () => {
    expect(projectVersions([])).toEqual([]);
  });

  it("finds a proposal's version and summarises each version in plain words", () => {
    const pv = projectVersions([website, api, brand]);
    expect(versionOfProposal(pv, "prop-1")?.number).toBe(2);
    expect(versionOfProposal(pv, "prop-x")).toBeNull();
    const title = (pid: string) => (pid === "prop-1" ? "Quote breakdown" : null);
    expect(versionSummary(pv[0]!, title)).toBe("Restored an earlier API");
    expect(versionSummary(pv[1]!, title)).toBe("Quote breakdown");
    expect(versionSummary(pv[2]!, title)).toBe("First version, imported");
    expect(versionSummary({ ...pv[1]!, proposalId: "prop-x" }, title)).toBe("Changes to Website and API");
  });
});

describe("liveSite: what is live, from the release service", () => {
  const pv = projectVersions([{ resourceId: "r-w", name: "Website", versions: [v("av-2", 2, "accept", "r-w", ago(DAY), "prop-1"), v("av-1", 1, "bind", "r-w", ago(30 * DAY))] }]);
  const release = (id: string, av: string, url: string | null) => ({ releaseId: id, acceptedVersionId: av, deployments: [{ targetId: "api", workerName: "api", url: "https://api.example" }, { targetId: "website", workerName: "web", url }] });

  it("names the live version, since when, and the website's address", () => {
    const list = { releases: [release("rel-1", "av-1", "https://portal.example")], live: { releaseId: "rel-1", acceptedVersionId: "av-1", outputDigest: "d", since: ago(2 * DAY) } } as unknown as ReleaseList;
    expect(liveSite(list, pv)).toEqual({ number: 1, since: ago(2 * DAY), url: "https://portal.example" });
  });

  it("falls back to the first deployment with an address, and to null when nothing is live", () => {
    const list = { releases: [release("rel-1", "av-2", null)], live: { releaseId: "rel-1", acceptedVersionId: "av-2", outputDigest: "d", since: ago(0) } } as unknown as ReleaseList;
    expect(liveSite(list, pv)).toEqual({ number: 2, since: ago(0), url: "https://api.example" });
    expect(liveSite({ releases: [], live: null }, pv)).toBeNull();
    expect(liveSite(undefined, pv)).toBeNull();
  });
});

describe("editionLook: an icon and a one-line promise per edition", () => {
  it("recognises the three demo editions and falls back to a generic hand-over", () => {
    expect(editionLook("Website pages").icon).toBe("globe");
    expect(editionLook("Customer portal interface").icon).toBe("layout");
    expect(editionLook("Email content").icon).toBe("mail");
    expect(editionLook("Copy deck").icon).toBe("edition");
  });
});

describe("one live derivation (UX-2 review m1, m2, m3)", () => {
  const w = { resourceId: "r-w", name: "Website", versions: [v("av-res", 4, "restore", "r-w", ago(0)), v("av-3", 3, "accept", "r-w", ago(DAY), "prop-3"), v("av-2", 2, "accept", "r-w", ago(2 * DAY), "prop-2"), v("av-1w", 1, "bind", "r-w", ago(30 * DAY))] };
  const b = { resourceId: "r-b", name: "Brand", versions: [v("av-1b", 1, "bind", "r-b", ago(30 * DAY))] };
  const pv = projectVersions([w, b]);
  const n = (id: string) => pv.find((x) => x.ids.includes(id))!;
  const list = (av: string, state = "live") => ({ releases: [{ releaseId: "rel", acceptedVersionId: av, state, deployments: [] }], live: state === "live" ? { releaseId: "rel", acceptedVersionId: av, outputDigest: "d", since: ago(0) } : null }) as unknown as ReleaseList;

  it("a version is live when it, or a later accept built on it, is live; a restore in between undoes that", () => {
    expect(isVersionLive(pv, n("av-2"), n("av-2").number)).toBe(true);
    expect(isVersionLive(pv, n("av-2"), n("av-3").number)).toBe(true);
    expect(isVersionLive(pv, n("av-3"), n("av-2").number)).toBe(false);
    // Version 4 restores the Website: the change of Version 3 is no longer what is live
    expect(isVersionLive(pv, n("av-3"), n("av-res").number)).toBe(false);
    expect(isVersionLive(pv, n("av-2"), null)).toBe(false);
  });

  it("per resource, the live entry is its newest at or before the live version (also when the live version did not touch it)", () => {
    const heads = liveHeadPerResource([w, b], pv, n("av-3").number);
    expect(heads.get("r-w")).toBe("av-3");
    expect(heads.get("r-b")).toBe("av-1b");
  });

  it("proposalReleaseFacts: live, publishing, or unknown when releases cannot be read", () => {
    expect(proposalReleaseFacts({ versions: pv, releases: list("av-3") }, "prop-2")).toEqual({ live: true, publishing: false, known: true });
    expect(proposalReleaseFacts({ versions: pv, releases: { releases: [{ releaseId: "rel", acceptedVersionId: "av-3", state: "deploying", deployments: [] }], live: null } as unknown as ReleaseList }, "prop-3")).toEqual({ live: false, publishing: true, known: true });
    expect(proposalReleaseFacts({ versions: pv, releases: undefined }, "prop-3")).toEqual({ live: false, publishing: false, known: false });
    expect(proposalReleaseFacts(undefined, "prop-3")).toEqual({ live: false, publishing: false, known: false });
  });
});
