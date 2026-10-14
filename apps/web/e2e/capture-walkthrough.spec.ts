/**
 * Capture walkthrough (UX-5): proves the video capture script (`video/scripts/capture/scenes.ts`)
 * will find every element it relies on, in fixture mode, before anyone spends a take on it.
 *
 * - Every selector and text comes from `video/scripts/selectors.json`, resolved exactly as the
 *   capture's `Ui` resolves it (`video/scripts/capture/selectors.ts`: testid | role | label | css |
 *   text, then hasText, within, first; `/re/flags` strings are regular expressions).
 * - One test per capture unit, in the order and with the steps `scenes.ts` uses. Each unit starts on
 *   a fresh page, as the capture does, and moves in-app like `SceneRun.goto` (the demo story lives
 *   in the page).
 * - Two steps go beyond today's `scenes.ts` and are what the video session must add (see
 *   `reports/ux-5.md`): "Finish running agent" before opening the repair in the `preview` and
 *   `publish` units, and restore → "Publish this version" for a code resource in `restore`.
 * - A failure names the key: `selectors.json s05-collision.blocked did not resolve …`.
 * - The last test fails if any selectors.json key was never resolved and is not listed in
 *   `LIVE_ONLY` with a reason, so a new key cannot be added without proving it here.
 * - With `CAPTURE_WALKTHROUGH_SHOTS=<dir>`, a 1440×900 screenshot is taken at each hero frame of
 *   docs/UX-POLISH.md §7, named by beat time.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handoverZip } from "./handover-zip.js";

// ------------------------------------------------------------------------------ selectors.json

interface Selector {
  testid?: string;
  role?: Parameters<Page["getByRole"]>[0];
  name?: string;
  exact?: boolean;
  level?: number;
  label?: string;
  css?: string;
  text?: string;
  hasText?: string;
  within?: string;
  first?: boolean;
}
interface Group {
  selectors: Record<string, Selector>;
  texts?: Record<string, string>;
}
interface SelectorsFile {
  shared: Group;
  scenes: Record<string, Group>;
}

const FILE: SelectorsFile = JSON.parse(readFileSync(new URL("../../../video/scripts/selectors.json", import.meta.url), "utf8")) as SelectorsFile;

/** Keys that cannot resolve in fixture mode, with the reason. Everything else must. */
const LIVE_ONLY: Record<string, string> = {
  "s06-repair-preview.previewSubmit": "on the separate preview origin; fixture preview links point at a .invalid host (scenes.ts skips it in fixture mode)",
  "s06-repair-preview.previewResult": "on the separate preview origin (as above)",
};

const resolved = new Set<string>();

const PATTERN = /^\/(.+)\/([a-z]*)$/s;
function pattern(value: string): string | RegExp {
  const m = PATTERN.exec(value);
  return m ? new RegExp(m[1]!, m[2]) : value;
}

/** The capture's `Ui`, plus bookkeeping: which key was used, and errors that name it. */
class Ui {
  constructor(
    readonly page: Page,
    readonly scene: string,
  ) {}

  private lookup(key: string): { id: string; s: Selector } {
    const own = this.scene !== "shared" ? FILE.scenes[this.scene]?.selectors[key] : undefined;
    if (own) return { id: `${this.scene}.${key}`, s: own };
    const shared = FILE.shared.selectors[key];
    if (shared) return { id: `shared.${key}`, s: shared };
    throw new Error(`selectors.json has no selector "${key}" for ${this.scene} or shared`);
  }

  id(key: string): string {
    return this.lookup(key).id;
  }

  sel(key: string): Locator {
    const { s } = this.lookup(key);
    const root: Page | Locator = s.within ? this.sel(s.within) : this.page;
    let loc: Locator;
    if (s.testid !== undefined) loc = root.getByTestId(s.testid);
    else if (s.role !== undefined) {
      loc = root.getByRole(s.role, {
        ...(s.name !== undefined ? { name: pattern(s.name) } : {}),
        ...(s.exact !== undefined ? { exact: s.exact } : {}),
        ...(s.level !== undefined ? { level: s.level } : {}),
      });
    } else if (s.label !== undefined) loc = root.getByLabel(s.label);
    else if (s.css !== undefined) loc = root.locator(s.css);
    else loc = root.getByText(pattern(s.text!));
    if (s.hasText !== undefined) loc = loc.filter({ hasText: pattern(s.hasText) });
    return s.first ? loc.first() : loc;
  }

  text(key: string): string | RegExp {
    const own = this.scene !== "shared" ? FILE.scenes[this.scene]?.texts?.[key] : undefined;
    const value = own ?? FILE.shared.texts?.[key];
    if (value === undefined) throw new Error(`selectors.json has no text "${key}" for ${this.scene} or shared`);
    resolved.add(own !== undefined ? `${this.scene}.texts.${key}` : `shared.texts.${key}`);
    return pattern(value);
  }

  /** Runs `step` on the key's locator; marks the key (and its `within` chain) resolved, or fails naming it. */
  async on<T>(key: string, what: string, step: (l: Locator) => Promise<T>): Promise<T> {
    try {
      const out = await step(this.sel(key));
      this.markChain(key);
      return out;
    } catch (error) {
      throw new Error(`selectors.json ${this.id(key)} did not resolve (${what}): ${(error as Error).message.split("\n")[0]}`);
    }
  }

  private markChain(key: string): void {
    const { id, s } = this.lookup(key);
    resolved.add(id);
    if (s.within) this.markChain(s.within);
  }

  visible(key: string, timeout = STEP): Promise<void> {
    return this.on(key, "visible", (l) => l.first().waitFor({ state: "visible", timeout }));
  }

  attached(key: string, timeout = STEP): Promise<void> {
    return this.on(key, "attached", (l) => l.first().waitFor({ state: "attached", timeout }));
  }

  click(key: string, timeout = STEP): Promise<void> {
    return this.on(key, "click", (l) => l.click({ timeout }));
  }

  /** The capture's `hasText(sel, text)`. */
  hasText(key: string, textKey: string | RegExp, timeout = LONG): Promise<void> {
    const text = typeof textKey === "string" ? this.text(textKey) : textKey;
    return this.on(key, `has text ${String(text)}`, (l) => l.filter({ hasText: text }).first().waitFor({ state: "visible", timeout }));
  }

  atLeast(key: string, count: number, timeout = LONG): Promise<void> {
    return this.on(key, `at least ${count}`, (l) => l.nth(count - 1).waitFor({ state: "visible", timeout }));
  }
}

// ----------------------------------------------------------------------------- capture runner

const STEP = 10_000;
const LONG = 20_000;
const APP_POLL_MS = 4_000;
/** FIXTURE_TARGETS in video/scripts/capture/targets.ts */
const T = {
  org: "o-0de0c11e0001",
  project: "p-c0570a1e0001",
  fail: "prop-a15e0000-0000-4000-8000-00000000a100",
  fix: "prop-a25e0000-0000-4000-8000-00000000a200",
  prepAccept: "prop-c15e0000-0000-4000-8000-00000000c100",
  updateRequest: "Add a price breakdown to the quote form",
};
const projectPath = (tab: "files" | "changes" | "versions") => `/o/${T.org}/p/${T.project}/${tab}`;
const proposalPath = (id: string) => `${projectPath("changes")}/${id}`;

const SHOTS = process.env.CAPTURE_WALKTHROUGH_SHOTS;

/** What a default view must not print (docs/UX-POLISH.md §6); grouped short codes ("6565 3fb2 c2c7") are fine. */
const RAW = [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}\b/gi, /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g, /\b(?:prop|av|rel|task|chg|job|ev|snap|apr|exp|intake|sess)-[0-9a-z]{4,}/gi, /\b[0-9a-f]{8,}\b/gi];

/** One capture unit's fixture session: `SceneRun.page` / `goto` in fixture mode. */
class FixtureRun {
  private booted = false;
  private role: "owner" | "client" | null = null;
  constructor(readonly page: Page) {}

  ui(scene: string): Ui {
    return new Ui(this.page, scene);
  }

  /** `fixturePage(persona)`: the first persona boots the page; later ones switch with the banner. */
  async as(persona: "owner" | "client"): Promise<void> {
    if (this.booted && this.role !== persona) {
      const ui = this.ui("shared");
      await ui.click(persona === "client" ? "viewAsClient" : "viewAsDeveloper");
      await ui.hasText("activeRole", persona === "client" ? "activeClient" : "activeDeveloper", STEP);
    }
    this.role = persona;
  }

  async goto(path: string): Promise<void> {
    const ui = this.ui("shared");
    if (!this.booted) {
      await this.page.goto(`/?role=${this.role ?? "owner"}`);
      await ui.visible("fixtureBanner");
      await ui.click("projectLink");
      await ui.visible("projectHeading");
      this.booted = true;
    }
    await this.page.evaluate((p) => {
      window.history.pushState(null, "", p);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, path);
    await ui.visible("projectHeading", LONG);
  }

  /** Not in scenes.ts yet (UX-4 review C-1): the fixture's repair is still running until this. */
  async finishRunningAgent(): Promise<void> {
    await this.goto(projectPath("changes"));
    await this.ui("shared").click("finishRunningAgent");
  }

  /** Every hero frame is a default view: no raw ids, shas or ISO timestamps on screen (§6), then the screenshot. */
  async shot(beat: string, what: string): Promise<void> {
    const text = await this.page.evaluate(() => document.body.innerText);
    const raw = RAW.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
    expect(raw, `${beat} ${what}: raw ids or timestamps in the default view`).toEqual([]);
    if (!SHOTS) return;
    mkdirSync(SHOTS, { recursive: true });
    await this.page.waitForTimeout(400);
    await this.page.screenshot({ path: join(SHOTS, `${beat}-${what}.png`) });
  }
}

/** A hero element must be on screen (not just in the DOM) at its beat. */
async function onScreen(ui: Ui, key: string): Promise<void> {
  await ui.on(key, "in the viewport", async (l) => {
    await l.first().scrollIntoViewIfNeeded({ timeout: STEP });
    await expect(l.first()).toBeInViewport();
  });
}

test.use({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
test.describe.configure({ mode: "serial" });

test.describe("capture walkthrough: every selectors.json key, in scenes.ts order", () => {
  test("unit files (s01 0:00): tree, resource chips, source inspector", async ({ page }) => {
    const run = new FixtureRun(page);
    await run.as("owner");
    const ui = run.ui("s01-mess");
    await run.goto(projectPath("files"));
    await ui.visible("tree", LONG);
    await onScreen(ui, "resourceChips");
    await run.shot("0m00s", "resource-chips");
    await ui.click("websiteFolder");
    await ui.hasText("inspector", "artifactsRepo", STEP);
    await ui.hasText("inspector", "coordinates", STEP);
    await ui.click("brandFolder");
    await ui.hasText("inspector", "r2Collection", STEP);
  });

  test("s01 0:00 intake (keys not yet used by scenes.ts): Add files → dry-run inventory → confirm", async ({ page }) => {
    const ui = new Ui(page, "s01-mess");
    await page.goto("/?role=owner");
    await ui.visible("fixtureBanner");
    await ui.click("handoverProjectLink");
    await ui.visible("emptyProject");
    await ui.click("addFiles");
    await ui.on("intakeZip", "set files", (l) => l.setInputFiles({ name: "agency-handover.zip", mimeType: "application/zip", buffer: handoverZip() }, { timeout: STEP }));
    await ui.click("checkArchive");
    await ui.hasText("intakeInventory", "nothingRun");
    for (const key of ["intakeSecret", "intakeNested", "intakeDependencies", "intakeAssets", "intakeStartsEmpty"]) await ui.visible(key);
    await onScreen(ui, "intakeInventory");
    await new FixtureRun(page).shot("0m00s", "intake-inventory");
    await ui.click("intakeConfirm");
    await ui.hasText("intakePending", "contentPending");
  });

  test("unit edition (s02 0:45, s03 1:30): Start an update, edition cards, working copy, send back, return summary", async ({ page }) => {
    const run = new FixtureRun(page);
    await run.as("client");
    await run.goto(projectPath("files"));
    const s2 = run.ui("s02-client-update");
    await s2.click("startUpdate");
    await s2.visible("dialogHeading");
    await s2.visible("request", LONG);
    await onScreen(s2, "editionCards");
    await run.shot("0m45s", "edition-cards");
    await s2.on("request", "fill", (l) => l.fill(T.updateRequest, { timeout: STEP }));
    await s2.click("getCopy");
    await s2.visible("download", LONG);
    // the capture saves whatever downloads as working-copy.zip (the fixture's copy is a stand-in file)
    await Promise.all([page.waitForEvent("download", { timeout: LONG }), s2.click("download")]);

    const s3 = run.ui("s03-own-tool");
    await s3.on("zipInput", "set files", (l) => l.setInputFiles({ name: "website-pages.zip", mimeType: "application/zip", buffer: Buffer.from(`PK\u0005\u0006${"\0".repeat(18)}`, "binary") }, { timeout: STEP }));
    await s3.click("send");
    await s3.hasText("returnRow", "returnSettled");
    const result = (await s3.sel("returnRow").innerText()).trim();
    const ready = s3.text("readyForReview");
    expect(typeof ready === "string" ? result.includes(ready) : ready.test(result), `the returned copy did not become a proposal: ${result.split("\n")[0]}`).toBe(true);
    await s3.hasText("returnSummary", /\d+ files? changed · \d+ blocked/, STEP);
    await onScreen(s3, "returnSummary");
    await run.shot("1m30s", "return-summary");
    await expect(s3.sel("dialog")).toBeVisible();
  });

  test("unit lanes (s04 2:30): swim lanes, three changes, the agent finishes", async ({ page }) => {
    const run = new FixtureRun(page);
    await run.as("owner");
    const ui = run.ui("s04-three-agents");
    await run.goto(projectPath("changes"));
    await ui.hasText("lanes", "someWorking");
    await ui.atLeast("changeRow", 3);
    await ui.atLeast("lane", 3);
    await onScreen(ui, "lanes");
    await run.shot("2m30s", "lanes");
    await run.ui("shared").click("finishRunningAgent");
    await ui.hasText("lanes", "noneWorking");
    await ui.hasText("lanes", "agentsAtOnce", STEP);
  });

  test("unit collision (s05 4:00): blocked card, contract-fail chip, Needs your decision", async ({ page }) => {
    const run = new FixtureRun(page);
    await run.as("owner");
    const ui = run.ui("s05-collision");
    await run.goto(proposalPath(T.fail));
    await ui.hasText("blocked", "productionUnchanged");
    const hash = await ui.on("proposalHash", "data-hash", (l) => l.first().getAttribute("data-hash", { timeout: STEP }));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // the 4:00 hero: amber card, red chip, the one primary (UX-4 review C-1)
    await onScreen(ui, "contractFailChip");
    await onScreen(ui, "blocked");
    await ui.hasText("storyStatus", /^Needs your decision$/, STEP);
    await ui.visible("copyRepairBrief");
    await ui.visible("changeRail");
    await run.shot("4m00s", "blocked-contract-fail");
    await ui.click("runnerOutput");
    await ui.on("evidence", "scroll", (l) => l.first().scrollIntoViewIfNeeded({ timeout: STEP }));
    await ui.visible("evidence");
    await ui.visible("reviewBrief");
  });

  test("unit preview (s06 5:00): the repair is Fixed, a preview is built, the client sees before/after", async ({ page }) => {
    const run = new FixtureRun(page);
    await run.as("owner");
    const prep = run.ui("s06-repair-preview");
    await run.finishRunningAgent(); // scenes.ts change (1)
    await run.goto(proposalPath(T.fix));
    await prep.visible("fixed", LONG);
    const ready = await prep.sel("openPreview").first().waitFor({ state: "visible", timeout: APP_POLL_MS }).then(
      () => true,
      () => false,
    );
    if (!ready) {
      await prep.click("buildPreview", LONG);
      await prep.visible("openPreview", LONG);
    }

    await run.as("client");
    const ui = run.ui("s06-repair-preview");
    await run.goto(proposalPath(T.fix));
    await ui.hasText("fixed", "fixed");
    await ui.visible("proposalHash");
    await ui.visible("openPreview", LONG);
    const href = await ui.on("openPreview", "href", (l) => l.first().getAttribute("href", { timeout: STEP }));
    expect(href ?? "", "Open preview has an https link").toMatch(/^https:\/\//);
    await onScreen(ui, "previewBeforeAfter");
    await run.shot("5m00s", "preview-before-after");
    await onScreen(ui, "fixed");
    await run.shot("5m00s", "fixed-banner");
  });

  test("unit publish (s07 6:00): the same short hash for both roles, approve → accept → publish", async ({ page }) => {
    const run = new FixtureRun(page);
    await run.as("client");
    const c = run.ui("s07-approve-publish");
    await run.finishRunningAgent(); // scenes.ts change (2)
    await run.goto(proposalPath(T.fix));
    await c.visible("proposalHash", LONG);
    // opened right after the repair was submitted, before the next poll: never framed as replaced by
    // the older proposal. Checked at once (no retry), so a stale first render would fail here.
    expect(await page.getByText(/Replaced by a newer proposal|A newer proposal replaced this one/).count()).toBe(0);
    const clientHash = await c.sel("proposalHash").first().getAttribute("data-hash");
    const clientShort = (await c.sel("proposalHash").first().locator(".review-code-value").innerText()).trim();
    await onScreen(c, "decisionRail");
    await run.shot("6m00s", "client-decision-rail");
    await c.click("showFullCode");
    await c.click("approve", LONG);
    await page.getByText(c.text("approvedByClient")).first().waitFor({ state: "visible", timeout: LONG });

    await run.as("owner");
    const ui = run.ui("s07-approve-publish");
    await run.goto(proposalPath(T.fix));
    await ui.hasText("stepApprove", "approvedByClient");
    // the 6:00 hero: the developer's review code is the client's, character for character
    await expect(ui.sel("proposalHash").first()).toHaveAttribute("data-hash", clientHash!);
    await expect(ui.sel("proposalHash").first()).toContainText(clientShort);
    await onScreen(ui, "decisionRail");
    await run.shot("6m00s", "developer-decision-rail");
    await ui.click("accept", LONG);
    await ui.hasText("stepAccept", "newVersion");
    await ui.click("prepare");
    await ui.click("approvePublish", LONG);
    await ui.click("publish", LONG);
    await ui.visible("livePill", LONG);
    await ui.hasText("trail", "liveTrail");
    await ui.visible("releaseRecord");
    await ui.visible("releaseReceipt");
    await onScreen(ui, "releaseReceipt");
    await run.shot("6m00s", "release-receipt-live");
  });

  test("unit restore (s08 7:15): versions timeline, restore the brand, export", async ({ page }) => {
    const run = new FixtureRun(page);
    await run.as("owner");
    const ui = run.ui("s08-restore-export");
    await run.goto(proposalPath(T.prepAccept));
    await ui.click("runValidation");
    await ui.click("approve", LONG);
    await ui.click("accept", LONG);
    await ui.hasText("stepAccept", "newVersion");
    await run.goto(projectPath("versions"));
    await ui.click("resourceBrand");
    await ui.atLeast("version", 2);
    await ui.visible("restoreVersion");
    await onScreen(ui, "versions");
    await run.shot("7m15s", "versions-restore");
    await ui.click("restoreRow");
    await ui.visible("confirm");
    await ui.click("confirmRestore");
    await ui.visible("restored", LONG);
    await ui.visible("assetRestoreNote");
    await ui.click("exportButton");
    await ui.click("startExport");
    await ui.hasText("exportDialog", "exportReady");
    await ui.visible("bundleLink");
  });

  test("s08 7:15 restore a code resource, then Publish this version (scenes.ts change 3)", async ({ page }) => {
    const run = new FixtureRun(page);
    await run.as("owner");
    const ui = run.ui("s08-restore-export");
    // a website version to go back to: the repair, approved and accepted
    await run.finishRunningAgent();
    await run.goto(proposalPath(T.fix));
    await run.as("client");
    await ui.click("approve", LONG);
    await run.as("owner");
    await ui.click("accept", LONG);
    await ui.hasText("stepAccept", "newVersion");
    await run.goto(projectPath("versions"));
    await ui.click("resourceWebsite");
    await ui.atLeast("version", 2);
    await ui.click("restoreVersion");
    await ui.visible("confirm");
    await ui.click("confirmRestore");
    await ui.visible("restored", LONG);
    await ui.hasText("publishVersion", "restoreNotProduction");
    await onScreen(ui, "publishThisVersion");
    await run.shot("7m15s", "publish-this-version");
    await ui.click("publishThisVersion");
    await ui.click("approvePublishVersion", LONG);
    await ui.hasText("publishVersion", "approvedNotLive");
    await ui.click("publishVersionDeploy", LONG);
    await ui.visible("publishVersionLive", LONG);
  });

  test("staging capture: client promotes, developer approves or sends back", async ({ page }) => {
    await page.clock.install();
    const ui = new Ui(page, "shared");
    const advance = async (check: () => Promise<void>) => {
      await expect(async () => {
        await page.clock.fastForward(1500);
        await check();
      }).toPass({ timeout: 30_000, intervals: [100] });
    };
    const tasks = async () => {
      await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: /Tasks/ }).click();
      await ui.visible("stagingBoard");
    };
    const inColumn = (column: string, card: string) => ui.on(column, `contains ${card}`, async (l) => {
      await expect(l.locator('[data-testid="task-card"]').and(ui.sel(card))).toBeVisible({ timeout: 200 });
    });
    const promote = async (card: string) => {
      const click = () => ui.on("stagingPromote", `click in ${card}`, (l) => l.and(ui.sel(card).getByRole("button")).click());
      await click();
      await ui.visible("stagingPromoteSheet");
      await click();
    };
    const review = async (card: string) => {
      await ui.click("viewAsDeveloper");
      await ui.on("stagingReviewLink", `review ${card}`, (l) => l.and(ui.sel(card).getByRole("link")).click());
      await ui.visible("stagingReview");
    };

    await page.goto("/?staging&role=client");
    await ui.visible("fixtureBanner");
    await ui.click("projectLink");
    await ui.visible("stagingHeader");
    await tasks();
    for (const card of ["stagingCopyCard", "stagingPhoneCard", "stagingRenameCard"]) {
      await ui.visible(card);
      await inColumn("stagingColInStaging", card);
    }

    await promote("stagingCopyCard");
    await advance(() => inColumn("stagingColLive", "stagingCopyCard"));
    await promote("stagingPhoneCard");
    await advance(() => inColumn("stagingColWaiting", "stagingPhoneCard"));
    await ui.on("stagingCardReason", "phone needs a developer", (l) =>
      expect(l.and(ui.sel("stagingPhoneCard").getByTestId("task-card-reason"))).toContainText("The automatic review could not confirm this change is low risk."));
    await review("stagingPhoneCard");
    await ui.click("stagingApprove");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await advance(() => expect(ui.sel("stagingReview").locator(".promotion-head")).toContainText("Live", { timeout: 200 }));

    await ui.click("viewAsClient");
    await tasks();
    await promote("stagingRenameCard");
    await advance(() => inColumn("stagingColWaiting", "stagingRenameCard"));
    await review("stagingRenameCard");
    await ui.click("stagingSendBack");
    const note = "Keep the existing column until its data has been migrated.";
    await page.getByLabel("Note for the client").fill(note);
    await page.getByRole("button", { name: "Send back", exact: true }).click();
    await expect(ui.sel("stagingReview").locator(".promotion-head")).toContainText("Sent back to staging");
    await ui.click("viewAsClient");
    await tasks();
    await advance(() => inColumn("stagingColInStaging", "stagingRenameCard"));
    await ui.on("stagingCardReason", "client sees the send-back note", (l) =>
      expect(l.and(ui.sel("stagingRenameCard").getByTestId("task-card-reason"))).toContainText(note));
  });

  test("every selectors.json key resolved (or is live-only, with a reason)", () => {
    const all: string[] = [];
    for (const [scene, g] of [["shared", FILE.shared] as const, ...Object.entries(FILE.scenes)]) {
      for (const key of Object.keys(g.selectors)) all.push(`${scene}.${key}`);
      for (const key of Object.keys(g.texts ?? {})) all.push(`${scene}.texts.${key}`);
    }
    const missing = all.filter((k) => !resolved.has(k) && !(k in LIVE_ONLY));
    expect(missing, `selectors.json keys this walkthrough never resolved: ${missing.join(", ")}`).toEqual([]);
    const stale = Object.keys(LIVE_ONLY).filter((k) => !all.includes(k));
    expect(stale, "LIVE_ONLY names keys selectors.json no longer has").toEqual([]);
  });
});
