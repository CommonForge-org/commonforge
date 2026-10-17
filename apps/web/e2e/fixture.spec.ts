/**
 * Fixture-mode UI smoke of the eight-minute demo path (docs/DEMO-SCRIPT.md, plan §G.4).
 *
 * Runs the production UI bundle built with VITE_COMMONFORGE_FIXTURE=1: every answer comes from the
 * in-memory demo story (src/api/fake.ts) and the page always carries the "Fixture mode" banner.
 * This proves the screens and their order, deterministically, in CI. It is NOT evidence of a live
 * run; e2e/local-stack.spec.ts drives the real Worker, and the live rehearsal drives the account.
 *
 * The fake lives in the page, so a full page load resets the story: after the first `goto`, the
 * tests move only through in-app navigation (`spa()`), like a user would.
 */
import { expect, test, type Page } from "@playwright/test";
import { handoverZip } from "./handover-zip.js";

const ORG = "o-0de0c11e0001";
const PID = "p-c0570a1e0001";
const A1 = "prop-a15e0000-0000-4000-8000-00000000a100"; // contract failure
const A2 = "prop-a25e0000-0000-4000-8000-00000000a200"; // the repair

/** Client-side navigation (keeps the in-page fake and its state). */
async function spa(page: Page, path: string) {
  await page.evaluate((p) => {
    window.history.pushState(null, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function viewAs(page: Page, who: "Developer" | "Client") {
  await page.getByRole("note").getByRole("button", { name: who, exact: true }).click();
  await expect(page.locator(".fixture-banner .seg-active")).toHaveText(who);
}

/** The fixture seeds the quote change mid-repair (UX-4 review C-1): finishing the running agent submits the repair. */
async function finishRepair(page: Page) {
  await page.getByRole("note").getByRole("button", { name: "Finish running agent" }).click();
}

async function openProject(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("note")).toContainText("Fixture mode");
  await expect(page.getByRole("note")).toContainText("Not a live run");
  await page.getByRole("link", { name: /Customer Portal/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Customer Portal" })).toBeVisible();
}

test.describe("fixture: eight-minute path", () => {
  test("0:00 one project, many sources: tree, source inspector, the video stays in R2", async ({ page }) => {
    await openProject(page);
    const tree = page.getByRole("tree", { name: "Project files" });
    for (const name of ["Website", "API", "Brand and media", "Requirements", "Quote-builder concept"]) await expect(tree.locator(".tree-name", { hasText: name }).first()).toBeVisible();

    // the source inspector reveals what each folder really is
    await tree.getByRole("button", { name: /Website/ }).first().click();
    const inspector = page.locator(".browser-inspector");
    await expect(inspector).toContainText("Artifacts repository");
    await expect(inspector).toContainText("Coordinates");
    await expect(inspector).toContainText(`commonforge-dev-${ORG}-canonical`);

    await tree.getByRole("button", { name: /Brand and media/ }).click();
    await expect(inspector).toContainText("R2 asset collection");
    await tree.getByRole("button", { name: /videos/ }).click();
    await tree.getByRole("button", { name: /launch-film\.mp4/ }).click();
    await expect(inspector).toContainText("50.0 MB");
    await expect(inspector).toContainText("No preview for this file type or size");

    // clients see the same tree, never coordinates
    await viewAs(page, "Client");
    await page.getByRole("tree", { name: "Project files" }).getByRole("button", { name: /Website/ }).first().click();
    await expect(page.locator(".browser-inspector")).toContainText("Artifacts repository");
    await expect(page.locator(".browser-inspector")).not.toContainText("Coordinates");
    await expect(page.locator(".browser-inspector")).not.toContainText("canonical");
  });

  test("2:30 three sessions at once (two agents and a client edition session); the decision badge", async ({ page }) => {
    await openProject(page);
    await page.getByRole("link", { name: /^Changes/ }).click();
    const lanes = page.getByTestId("lanes");
    await expect(lanes).toContainText(/Up to 3 sessions at once/);
    await expect(page.getByTestId("change-row")).toHaveCount(3);
    // UX-4: each lane is a card with its agent, task, current step and elapsed time
    await expect(lanes.getByTestId("lane")).toHaveCount(3);
    // UX-6: the client-edition path is a lane: client avatar, session title, current step
    const session = lanes.locator('[data-testid="lane"][data-kind="session"]');
    await expect(session).toHaveCount(1);
    await expect(session).toContainText("Friendlier quote form copy");
    await expect(session).toContainText("client@customer.example");
    await expect(lanes).toContainText(/[1-9] working now/);
    await expect(lanes.getByTestId("lane").first()).toContainText(/\d+ min \d+ s/);
    await expect(page.getByRole("navigation", { name: "Project sections" })).toContainText(/Changes\s*Needs your decision · \d/);
  });

  test("4:00–7:15 contract failure → fix → identical hash for client and developer → approve, accept, publish as three records", async ({ page }) => {
    await openProject(page);

    // the first attempt: Git merged cleanly, the contract failed, acceptance is blocked
    await spa(page, `/o/${ORG}/p/${PID}/changes/${A1}`);
    const blocked = page.getByTestId("blocked-banner");
    await expect(blocked).toContainText("blocked");
    await expect(blocked).toContainText("Production is unchanged");
    await blocked.getByText("Runner output").click();
    await expect(blocked).toContainText("contract quote-schema");
    await expect(page.locator(".evidence")).toContainText("quote-schema");
    // UX-4: the storyboard's Check step: the contract-fail chip, the trust badge, the rail at Check
    await expect(page.getByTestId("contract-fail-chip")).toContainText(/Contract quote-schema failed · API response no longer matches what Website expects/);
    await expect(page.getByTestId("change-rail").locator('[aria-current="step"]')).toContainText("Check");
    await expect(page.getByTestId("decision-rail")).toBeVisible();
    const a1Hash = await page.getByTestId("proposal-hash").getAttribute("data-hash");
    // UX-4 review C-1: at 4:00 the repair is still running: amber, Needs your decision, the repair brief
    await expect(page.getByTestId("story-status")).toHaveText("Needs your decision");
    await expect(page.getByRole("button", { name: "Copy repair brief for the agent" })).toBeVisible();
    await expect(blocked).toContainText("An agent on this change is working again");
    await expect(page.getByRole("link", { name: "Review the latest" })).toHaveCount(0);
    // the repair agent submits: the next poll shows the newer proposal
    await finishRepair(page);
    await expect(page.getByRole("link", { name: "Review the latest" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy repair brief for the agent" })).toHaveCount(0);

    // the repair: a new identity that passes what failed before
    await page.getByRole("link", { name: "Review the latest" }).click();
    await expect(page).toHaveURL(new RegExp(`/changes/${A2}$`));
    await expect(page.getByTestId("fixed-banner")).toContainText("Fixed");
    // UX-4: the current step is Review; building a preview moves it to Approve (UX-1 review M-3)
    await expect(page.getByTestId("change-rail").locator('[aria-current="step"]')).toContainText("Review");
    await page.getByRole("button", { name: "Build preview" }).click();
    await expect(page.getByTestId("open-preview")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("change-rail").locator('[aria-current="step"]')).toContainText("Approve");
    const devHash = await page.getByTestId("proposal-hash").getAttribute("data-hash");
    expect(devHash).toMatch(/^[0-9a-f]{64}$/);
    // every edit is a new immutable identity
    expect(devHash).not.toBe(a1Hash);

    // accept is blocked until someone approves this exact identity
    const accept = page.getByTestId("step-accept").getByRole("button", { name: "Accept as new version" });
    await expect(accept).toBeDisabled();
    await expect(page.getByTestId("step-accept")).toContainText("No approval for this identity yet");
    // publish is not offered before acceptance
    await expect(page.getByTestId("step-publish").getByRole("button", { name: "Publish to production" })).toBeDisabled();

    // the client sees the same identity and approves it; the client cannot accept or publish
    await viewAs(page, "Client");
    const clientHash = page.getByTestId("proposal-hash");
    await expect(clientHash).toHaveAttribute("data-hash", devHash!);
    await clientHash.getByRole("button", { name: "Show full code" }).click();
    await expect(clientHash.locator(".review-code-value")).toHaveText(devHash!.match(/.{4}/g)!.join(" "));
    await expect(page.getByRole("button", { name: "Accept as new version" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Publish/ })).toHaveCount(0);
    // UX-2: the client's review: checks chip, before/after, details collapsed, publishing is the developer's
    await expect(page.getByTestId("checks-chip")).toHaveText(/Checks passed/);
    await expect(page.getByTestId("preview-before-after")).toContainText("With this update");
    await expect(page.locator(".tech-details")).not.toHaveAttribute("open", "");
    await expect(page.getByTestId("decision-rail")).toContainText("Your developer");
    await page.getByRole("button", { name: "Approve this result" }).click();
    await expect(page.locator(".client-side")).toContainText("Approved by client");
    await expect(page.locator(".client-side")).toContainText("Your developer will publish");

    // the developer accepts: a ledger record, not a deploy
    await viewAs(page, "Developer");
    await expect(page.getByTestId("step-approve")).toContainText("Approved by client");
    await expect(accept).toBeEnabled();
    await accept.click();
    await expect(page.getByTestId("step-accept")).toContainText(/New version \d+ recorded in the ledger/);
    const trail = page.getByTestId("decision-trail");
    await expect(trail).toContainText("Approved by client");
    await expect(trail).toContainText(/Accepted as version \d+/);
    await expect(trail).toContainText("Not published yet");
    const publish = page.getByTestId("step-publish");
    await expect(publish).toContainText("Not live");

    // publishing is a third record: prepare → publish approval → deploy → live
    await publish.getByRole("button", { name: "Prepare release" }).click();
    await expect(publish.getByRole("button", { name: "Approve publishing this release" })).toBeVisible();
    await expect(publish).not.toContainText("Live ·");
    await publish.getByRole("button", { name: "Approve publishing this release" }).click();
    await publish.getByRole("button", { name: "Publish to production" }).click();
    await expect(publish.locator(".pill", { hasText: "Live" })).toBeVisible({ timeout: 15_000 });
    await expect(trail).toContainText("Live ·");
    await expect(publish.getByTestId("release-record")).toContainText("Release for");
    // UX-4: the release receipt binds version, build, target, observed live version and health
    const receipt = page.getByTestId("release-receipt");
    await expect(receipt.getByTestId("receipt-state")).toHaveText("Live");
    await expect(receipt).toContainText(/Version \d+ \(this release\)/);
    await expect(receipt).toContainText("Healthy · version check passed");
    // the developer's short review code is the client's
    await expect(page.getByTestId("proposal-hash")).toHaveAttribute("data-hash", devHash!);
    await expect(page.getByTestId("proposal-hash")).toContainText(devHash!.slice(0, 4));
  });

  test("7:15 restore is a new forward version; export downloads everything", async ({ page }) => {
    await openProject(page);
    await page.getByRole("link", { name: "Versions" }).click();
    await page.getByRole("navigation", { name: "Resources" }).getByRole("button", { name: /Brand and media/ }).click();
    const versions = page.getByTestId("versions");
    await expect(versions.locator(".version")).toHaveCount(1);

    // accept the brand refresh (assets only) first, so there is something to restore
    await spa(page, `/o/${ORG}/p/${PID}/changes/prop-c15e0000-0000-4000-8000-00000000c100`);
    await page.getByRole("button", { name: "Run validation" }).click();
    await expect(page.getByRole("button", { name: "Approve this result" })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole("button", { name: "Approve this result" }).click();
    await page.getByRole("button", { name: "Accept as new version" }).click();
    await expect(page.getByTestId("step-accept")).toContainText(/New version \d+ recorded in the ledger/);

    await page.getByRole("link", { name: "Versions" }).click();
    await page.getByRole("navigation", { name: "Resources" }).getByRole("button", { name: /Brand and media/ }).click();
    await expect(versions.locator(".version")).toHaveCount(2);
    await expect(versions.locator(".version-current")).toContainText("Accepted change");
    // Cancel (here: Escape) gives keyboard focus back to the row's restore button
    const rowRestore = versions.getByRole("button", { name: "Restore this version" });
    await rowRestore.click();
    await expect(page.locator(".confirm")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator(".confirm")).toHaveCount(0);
    await expect(rowRestore).toBeFocused();
    await rowRestore.click();
    await page.locator(".confirm").getByRole("button", { name: "Restore this version" }).click();
    const restored = page.getByRole("status").filter({ hasText: "Restored." });
    await expect(restored).toContainText("The earlier history is kept");
    // the trigger row is gone after a restore: focus lands on the result note
    await expect(restored).toBeFocused();
    await expect(versions.locator(".version")).toHaveCount(3);
    await expect(versions.locator(".version").first()).toContainText("Restored an earlier version");
    // assets are never released: a neutral note, no publish offer
    await expect(page.getByTestId("publish-version-assets")).toContainText("publishing does not change which assets production uses");
    await expect(page.getByTestId("publish-version")).toHaveCount(0);

    await page.getByRole("button", { name: "Export" }).click();
    const dialog = page.getByRole("dialog", { name: "Export project" });
    await dialog.getByRole("button", { name: "Start export" }).click();
    await expect(dialog).toContainText("Ready. One file per resource", { timeout: 10_000 });
    await expect(dialog.getByRole("link", { name: "website.bundle" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "brand-assets.manifest.json" })).toBeVisible();
  });

  test("0:00 Add files: the agency's ZIP is checked (nothing run), sorted with reasons, and added honestly", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("note")).toContainText("Fixture mode");
    // the empty "Agency handover" project is where the handover starts
    await page.getByRole("link", { name: /Agency handover/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Agency handover" })).toBeVisible();
    await expect(page.getByText("This project has no files yet.")).toBeVisible();
    await page.getByRole("link", { name: "Add files" }).click();
    await expect(page.getByRole("heading", { name: "Add files" })).toBeVisible();
    await page.getByLabel("Project archive (ZIP)").setInputFiles({ name: "agency-handover.zip", mimeType: "application/zip", buffer: handoverZip() });
    await page.getByRole("button", { name: "Check this archive" }).click();
    const inv = page.getByTestId("intake-inventory");
    await expect(inv).toBeVisible({ timeout: 10_000 });
    await expect(inv).toContainText("54 files checked, nothing run");
    // every part has a place: nothing is already taken in an empty project
    await expect(inv.getByTestId("intake-placement")).toHaveCount(4);
    for (const name of ["api", "requirements", "website", "agency-handover-assets"]) await expect(inv.getByRole("checkbox", { name: `Add ${name}` })).toBeChecked();
    // the film is too large for Git: it goes to an asset collection
    await expect(inv.getByTestId("intake-placement").filter({ hasText: "agency-handover-assets" })).toContainText("over 32 MB stay out of Git");
    // the .env is blocked by name, its value never shown
    const secret = inv.locator('[data-kind="secret"]');
    await expect(secret).toContainText("website/.env");
    await expect(secret).toContainText("contents were not read");
    await expect(page.locator("main")).not.toContainText("sk_live");
    // UX-6: one row per nested repository, its files behind a disclosure
    const nested = inv.locator('[data-kind="nested"]');
    await expect(nested.getByTestId("intake-excluded-folder")).toHaveCount(2);
    await expect(nested).toContainText("api/ nested repository (26 files): import by URL to keep its history");
    await expect(nested.getByText("api/.git/HEAD")).toBeHidden();
    await nested.getByText("api/", { exact: true }).click();
    await expect(nested.getByText("api/.git/HEAD")).toBeVisible();
    // UX-6: .npmrc says what it may hold
    await expect(secret).toContainText("website/.npmrc · may contain a registry token");
    await expect(inv.locator('[data-kind="dependency"]')).toContainText("website/node_modules/");
    // said before Confirm: the folders start empty
    await expect(inv.getByTestId("intake-starts-empty")).toContainText("start empty");
    // §11.3: the owner inspected .npmrc and includes it anyway; Confirm waits for the attestation
    await expect(secret.getByTestId("intake-include-anyway")).toHaveCount(2);
    await secret.getByRole("checkbox", { name: "Include website/.npmrc anyway" }).check();
    const attest = inv.getByTestId("intake-include-attest");
    await expect(attest).toContainText("I have inspected this file and it contains no secrets");
    await expect(page.getByTestId("intake-confirm")).toBeDisabled();
    await attest.getByRole("checkbox").check();
    await expect(page.getByTestId("intake-confirm")).toBeEnabled();

    await page.getByTestId("intake-confirm").click();
    await expect(page.getByTestId("intake-pending")).toContainText("still to be copied in");
    await expect(page.getByTestId("intake-included-anyway")).toContainText("website/.npmrc");
    await expect(page.locator("main")).not.toContainText("npm_not_a_real_token");
    const created = page.getByTestId("intake-created");
    await expect(created).toHaveCount(4);
    await expect(created.first()).toContainText("Created · content pending");
    await created.filter({ hasText: "agency-handover-assets" }).getByRole("link", { name: "Open in Files" }).click();
    await expect(page.getByTestId("resource-chips")).toContainText("agency-handover-assets");

    // a public repository: imported with a first version and mounted
    await page.getByRole("link", { name: "Add files" }).click();
    await page.getByLabel("Repository address").fill("https://github.com/example-agency/portal-docs.git");
    await page.getByRole("button", { name: "Import repository" }).click();
    await expect(page.getByTestId("intake-result")).toContainText("Imported", { timeout: 10_000 });
    await page.getByRole("link", { name: "Open in Files" }).click();
    await expect(page.getByRole("tree", { name: "Project files" })).toContainText("portal-docs");

    // only the owner adds files
    await viewAs(page, "Client");
    await expect(page.getByRole("link", { name: "Add files" })).toHaveCount(0);
  });

  test("7:15 restore, then publish this version through the same gate", async ({ page }) => {
    await openProject(page);
    // accept the repaired change, so the website has an earlier version to go back to
    await finishRepair(page);
    await spa(page, `/o/${ORG}/p/${PID}/changes/${A2}`);
    await viewAs(page, "Client");
    await page.getByRole("button", { name: "Approve this result" }).click();
    await viewAs(page, "Developer");
    await page.getByTestId("step-accept").getByRole("button", { name: "Accept as new version" }).click();
    await expect(page.getByTestId("step-accept")).toContainText(/New version \d+ recorded in the ledger/);

    await page.getByRole("link", { name: "Versions" }).click();
    await page.getByRole("navigation", { name: "Resources" }).getByRole("button", { name: /Website/ }).click();
    const versions = page.getByTestId("versions");
    await expect(page.getByTestId("publish-version")).toHaveCount(0);
    await versions.getByRole("button", { name: "Restore this version" }).first().click();
    await page.locator(".confirm").getByRole("button", { name: "Restore this version" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Restored." })).toBeVisible();

    const panel = page.getByTestId("publish-version");
    await expect(panel).toContainText("Restoring changed the accepted version, not production");
    await expect(panel).toContainText("Not live");
    await panel.getByRole("button", { name: "Publish this version" }).click();
    await panel.getByRole("button", { name: "Approve publishing this release" }).click({ timeout: 10_000 });
    await expect(panel).toContainText("Approved, not live");
    await panel.getByRole("button", { name: "Publish to production" }).click();
    await expect(panel.locator(".badge", { hasText: /^Live$/ })).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId("release-record")).toContainText("Release for");
    // the timeline's Live badge moves to the restored version
    await expect(versions.locator(".version-current .badge", { hasText: /^Live$/ })).toBeVisible({ timeout: 10_000 });
    await expect(versions.locator(".version-live")).toHaveCount(1);

    // the client sees the restored history but no publish controls
    await viewAs(page, "Client");
    await expect(page.getByTestId("publish-version")).toHaveCount(0);
  });

  test("0:45–2:30 client editions: start an update, download, send back; protected files are not taken over", async ({ page }) => {
    await page.goto("/?role=client");
    await expect(page.getByRole("note")).toContainText("Fixture mode");
    await page.getByRole("link", { name: /Customer Portal/ }).click();
    // clients get no developer actions
    await expect(page.getByRole("button", { name: "Client editions" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Export" })).toHaveCount(0);

    // UX-2: clients land on the Overview; its hero carries the one Start an update
    await expect(page.getByRole("heading", { level: 1, name: "Your Customer Portal" })).toBeVisible();
    await page.getByRole("button", { name: "Start an update" }).click();
    const panel = page.getByRole("dialog", { name: "Start an update" });
    // UX-2 review I2: a real modal: the app behind is inert and Tab / Shift+Tab stay in the sheet
    await expect(page.locator("#root")).toHaveAttribute("inert", "");
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(i % 2 ? "Tab" : "Shift+Tab");
      await expect(panel.locator(":focus")).toHaveCount(1);
    }
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    await expect(panel.locator(":focus")).toHaveCount(1);
    // edition cards: what you can and can't change
    const cards = panel.getByTestId("edition-cards");
    // radio pattern: one tab stop, Space selects
    await expect(cards.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);
    await expect(cards.getByRole("radio", { name: /Website pages/ })).toHaveAttribute("aria-checked", "true");
    await expect(cards).toContainText("You can't change");
    await panel.getByLabel("What do you want to change?").fill("Explain what the quote covers");
    await panel.getByRole("button", { name: "Open working copy" }).click();
    await expect(panel.getByRole("link", { name: "Download working copy" })).toBeVisible();

    await panel.getByLabel("Edited working copy (ZIP)").setInputFiles({ name: "website-pages.zip", mimeType: "application/zip", buffer: Buffer.from("PK\u0005\u0006" + "\0".repeat(18), "binary") });
    await panel.getByRole("button", { name: "Send back edited copy" }).click();
    const ret = panel.getByTestId("edition-return");
    await expect(ret).toContainText("Ready for review", { timeout: 10_000 });
    await expect(ret).toContainText("src/quote.ts");
    await expect(ret.getByTestId("return-summary")).toHaveText(/\d+ files? changed · 1 blocked/);
    await expect(ret).toContainText("package.json was not taken over: your developer protects this file.");
    await expect(ret.getByRole("link", { name: "Ask the developer" })).toHaveAttribute("href", /^mailto:/);
    await expect(ret.getByRole("link", { name: "Review and approve the result" })).toBeVisible();
    // Escape closes the sheet and gives focus back to its button
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start an update" })).toBeFocused();
    await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  });

  test("developer editions panel: policy, publish, give the client access", async ({ page }) => {
    await openProject(page);
    await page.getByRole("button", { name: "Client editions" }).click();
    const panel = page.getByRole("dialog", { name: "Client editions" });
    await expect(panel.getByTestId("edition")).toContainText("Website pages");
    await expect(panel.getByTestId("edition")).toContainText("Published");
    await panel.getByRole("button", { name: "New edition" }).click();
    await panel.getByLabel("Name").fill("Copy deck");
    await panel.getByRole("button", { name: "Create and publish" }).click();
    await expect(panel.getByTestId("edition")).toHaveCount(2);
    await panel.getByLabel("Give a client access to Copy deck").selectOption({ label: "client@customer.example" });
    await expect(panel).not.toContainText("error", { ignoreCase: true });
  });

  test("UX-1 shell: section nav, Needs you, keyboard inspector for developers only", async ({ page }) => {
    await openProject(page);
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Customer Portal");
    await expect(page.getByText("Viewing as developer")).toBeVisible();

    await nav.getByRole("link", { name: "Overview" }).click();
    await expect(page.getByTestId("needs-you")).toContainText("Needs you");
    await expect(page.getByRole("list", { name: "Change progress" }).first()).toBeVisible();
    await nav.getByRole("link", { name: "Activity" }).click();
    // the quote repair is still running in the fixture (UX-4 review C-1)
    await expect(page.locator("main")).toContainText("Validation blocked it");

    // the inspector opens from the keyboard, takes focus, and Escape gives focus back
    const toggle = page.getByRole("button", { name: "Inspector", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("complementary", { name: "Inspector" });
    await expect(drawer).toBeVisible();
    await expect(page.getByRole("heading", { name: "Inspector" })).toBeFocused();
    await expect(drawer).toContainText("p-c0570a1e0001");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // on a review, the drawer carries the proposal's identity with copy buttons
    await finishRepair(page);
    await spa(page, `/o/${ORG}/p/${PID}/changes/${A2}`);
    await toggle.click();
    await expect(drawer.getByRole("button", { name: "Copy Proposal hash" })).toBeVisible();
    await toggle.click();

    await viewAs(page, "Client");
    await expect(page.getByText("Viewing as client")).toBeVisible();
    await expect(page.getByRole("button", { name: "Inspector", exact: true })).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Progress" }).first()).toBeVisible();
  });

  test("admin: invite a client from Members, change the role, and create an organization", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("note")).toContainText("Fixture mode");
    await page.getByRole("navigation", { name: "Organization" }).getByRole("link", { name: "Members" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    const invite = page.getByRole("form", { name: "Invite a member" });
    await invite.getByLabel("Email").fill("new.client@customer.example");
    await invite.getByLabel("Role").selectOption("client");
    await invite.getByRole("button", { name: "Invite" }).click();
    await expect(page.getByText("Added. We emailed them an invite.")).toBeVisible();
    await expect(invite.getByLabel("Email")).toHaveValue("");
    await page.getByLabel("Role of new.client@customer.example").selectOption("viewer");
    await page.getByRole("button", { name: "Change role" }).click();
    await expect(page.getByLabel("Role of new.client@customer.example")).toHaveValue("viewer");

    await page.getByLabel(/Switch organization/).click();
    await page.getByRole("link", { name: "New organization" }).click();
    await page.getByLabel("Organization name").fill("Second Client");
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Second Client");
  });

  test("admin: hide a folder from the client in Settings → Access, then see it on the client's page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("note")).toContainText("Fixture mode");
    await page.getByRole("link", { name: /Customer Portal/ }).click();
    await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("region", { name: "Access" })).toBeVisible();
    const row = page.locator(".access-row", { hasText: "client@customer.example" });
    await row.getByText("Folders").click();
    await page.getByLabel("Access of client@customer.example to api").selectOption("none");
    await page.getByRole("button", { name: "Save access for client@customer.example" }).click();
    await expect(page.getByLabel("Access of client@customer.example to api")).toHaveValue("none");

    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Demo Client" }).click();
    await page.getByRole("navigation", { name: "Organization" }).getByRole("link", { name: "Members" }).click();
    await page.getByRole("link", { name: "client@customer.example" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("client@customer.example");
    // the fixture's client may change the project's folders ("Can change")
    await expect(page.getByLabel("Access of Customer Portal", { exact: true })).toHaveValue("write");
  });

  test("admin: create a project, add a folder, attach a folder, detach it", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("note")).toContainText("Fixture mode");
    // Cancel clears the form: a second New project starts empty
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Project name").fill("Draft");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "New project" }).click();
    await expect(page.getByLabel("Project name")).toHaveValue("");
    await page.getByLabel("Project name").fill("Intranet");
    await page.getByLabel("Project workflow").selectOption("legacy");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("region", { name: "Folders" })).toBeVisible();
    await expect(page.getByText("This project has no folders yet.")).toBeVisible();

    const add = page.getByRole("form", { name: "New folder" });
    // a name the Worker would refuse is said before sending
    await add.getByLabel("New folder").fill(".hidden");
    await expect(add.getByRole("alert")).toContainText("can't start with a dot");
    await expect(add.getByLabel("New folder")).toHaveAttribute("aria-invalid", "true");
    await expect(add.getByLabel("New folder")).toHaveAccessibleDescription(/can't start with a dot/);
    await expect(add.getByRole("button", { name: "Add folder" })).toBeDisabled();
    await add.getByLabel("New folder").fill("media");
    await add.getByRole("button", { name: "Add folder" }).click();
    // one kind of folder: no kind label, it sets itself up
    await expect(page.locator(".folder-row", { hasText: "media" })).toContainText("Ready");
    await expect(page.locator(".folder-row", { hasText: "media" })).not.toContainText("Code (git)");
    // the form starts empty again after a success
    await expect(add.getByRole("textbox")).toHaveValue("");
    await expect(page.getByText("Public git URLs only; ZIP plans folders but doesn't fill them yet.")).toBeVisible();

    const attach = page.getByRole("form", { name: "Attach an existing folder" });
    await attach.getByLabel("Attach an existing folder").selectOption({ label: "Website" });
    await attach.getByRole("button", { name: "Attach" }).click();
    await expect(page.locator(".folder-row", { hasText: "Also in: Customer Portal" })).toBeVisible();
    await expect(attach.getByLabel("Attach an existing folder")).toHaveValue("");
    await expect(attach.getByLabel("Name in this project")).toHaveValue("");
    await expect(attach.getByRole("option", { name: "Website", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Detach media" }).click();
    await expect(page.getByText("The folder itself is not deleted.")).toBeVisible();
    await page.getByRole("button", { name: "Detach", exact: true }).click();
    await expect(page.locator(".folder-row", { hasText: "media" })).toHaveCount(0);
  });

  test("add folder, upload, edit, move, delete, restore", async ({ page }) => {
    // every change polls to its end (1.5 s a step)
    test.setTimeout(180_000);
    const nav = () => page.getByRole("navigation", { name: "Project sections" });
    const tree = () => page.getByRole("tree", { name: "Project files" });
    const row = (name: string) => tree().locator(".tree-row", { has: page.locator(".tree-name", { hasText: new RegExp(`^${name.replace(/[.]/g, "\\.")}$`) }) });
    const tray = page.getByRole("region", { name: "Uploads and changes" });
    const lastBatch = () => tray.locator(".tray-batch").last();
    const actions = (name: string) => page.getByRole("group", { name: `Actions for ${name}` });

    // 1. add folder media: Setting up…, then Ready
    await page.goto("/");
    await expect(page.getByRole("note")).toContainText("Fixture mode");
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Project name").fill("Intranet");
    await page.getByLabel("Project workflow").selectOption("legacy");
    await page.getByRole("button", { name: "Create project" }).click();
    const add = page.getByRole("form", { name: "New folder" });
    await add.getByLabel("New folder").fill("media");
    await add.getByRole("button", { name: "Add folder" }).click();
    const folderRow = page.locator(".folder-row", { hasText: "media" });
    await expect(folderRow).toContainText("Setting up…");
    await expect(folderRow).toContainText("Ready");

    // 2. Files shows the three files of its first commit
    await nav().getByRole("link", { name: "Files" }).click();
    await tree().getByRole("button", { name: /media/ }).click();
    for (const name of [".gitattributes", ".lfsconfig", "README.md"]) await expect(row(name)).toBeVisible();
    await row("README.md").click();
    await expect(page.locator(".preview-text")).toHaveText("# media\n");
    await row(".lfsconfig").click();
    await expect(page.locator(".preview-text")).toContainText("/info/lfs");

    // 3. upload a small binary as clip.mp4: Added, stored in LFS (.gitattributes says *.mp4)
    await tree().getByRole("button", { name: /media/ }).click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("form", { name: "Upload" }).getByRole("button", { name: "Upload files" }).click();
    await (await chooser).setFiles([{ name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 1, 2, 3]) }]);
    await expect(lastBatch().locator(".change-status")).toHaveAttribute("data-state", "added", { timeout: 15_000 });
    await expect(lastBatch()).toContainText("Added");
    await expect(row("clip.mp4")).toBeVisible();

    // 4. edit README.md
    await row("README.md").click();
    await actions("README.md").getByRole("button", { name: "Edit" }).click();
    const contents = page.getByLabel("File contents");
    await expect(contents).toHaveValue("# media\n");
    await contents.fill("# media\n\nVideos for the site.\n");
    await page.getByRole("button", { name: "Review changes" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(lastBatch().locator(".change-status")).toHaveAttribute("data-state", "added", { timeout: 15_000 });
    await expect(page.locator(".preview-text")).toHaveText("# media\n\nVideos for the site.\n");

    // 5. move clip.mp4 to video/clip.mp4
    await row("clip.mp4").click();
    await actions("clip.mp4").getByRole("button", { name: "Rename or move" }).click();
    const moveSheet = page.getByRole("form", { name: "Move files" });
    await moveSheet.getByLabel("New path").fill("video/clip.mp4");
    await moveSheet.getByRole("button", { name: "Move", exact: true }).click();
    await expect(lastBatch().locator(".change-status")).toHaveAttribute("data-state", "added", { timeout: 15_000 });
    await expect(row("clip.mp4")).toHaveCount(0);
    await row("video").click();
    await expect(row("clip.mp4")).toBeVisible();

    // 6. delete it
    await row("clip.mp4").click();
    await actions("clip.mp4").getByRole("button", { name: "Delete" }).click();
    const deleteSheet = page.getByRole("form", { name: "Delete files" });
    await expect(deleteSheet).toContainText("video/clip.mp4");
    await deleteSheet.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(lastBatch().locator(".change-status")).toHaveAttribute("data-state", "added", { timeout: 15_000 });
    await expect(row("clip.mp4")).toHaveCount(0);

    // 7. Versions: restore the version that had it, and Files shows it again
    await nav().getByRole("link", { name: "Versions" }).click();
    await page.getByRole("navigation", { name: "Resources" }).getByRole("button", { name: /media/ }).click();
    const versions = page.getByTestId("versions");
    // the first version (genesis), then upload, edit, move, delete
    await expect(versions.locator(".version")).toHaveCount(5);
    await versions.getByRole("button", { name: "Restore this version" }).first().click();
    await page.locator(".confirm").getByRole("button", { name: "Restore this version" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Restored." })).toBeVisible();
    await nav().getByRole("link", { name: "Files" }).click();
    await tree().getByRole("button", { name: /media/ }).click();
    await row("video").click();
    await expect(row("clip.mp4")).toBeVisible();
  });

  test("admin: a folder whose setup fails shows the error, and Try again sets it up", async ({ page }) => {
    await page.goto("/?folderSetupFails");
    await expect(page.getByRole("note")).toContainText("Fixture mode");
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Project name").fill("Intranet");
    await page.getByLabel("Project workflow").selectOption("legacy");
    await page.getByRole("button", { name: "Create project" }).click();
    const add = page.getByRole("form", { name: "New folder" });
    await add.getByLabel("New folder").fill("media");
    await add.getByRole("button", { name: "Add folder" }).click();
    const row = page.locator(".folder-row", { hasText: "media" });
    await expect(row).toContainText("Setting up…");
    await expect(row).toContainText("Setup failed");
    await expect(row).toContainText("Setting up this folder failed");
    // Files: a folder with no version is read-only, with the setup error instead of a listing
    const nav = page.getByRole("navigation", { name: "Project sections" });
    await nav.getByRole("link", { name: "Files" }).click();
    await page.getByRole("tree", { name: "Project files" }).getByRole("button", { name: /media/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "Setting up this folder failed" })).toBeVisible();
    await expect(page.getByRole("form", { name: "Upload" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New file" })).toHaveCount(0);
    await nav.getByRole("link", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Folders" }).click();
    await row.getByRole("button", { name: "Try again" }).click();
    await expect(row).toContainText("Ready");
    await expect(row.getByRole("button", { name: "Try again" })).toHaveCount(0);
    // Files: now it has a version, the write actions are back
    await nav.getByRole("link", { name: "Files" }).click();
    await page.getByRole("tree", { name: "Project files" }).getByRole("button", { name: /media/ }).click();
    await expect(page.getByRole("form", { name: "Upload" })).toBeVisible();
  });

  test("admin: change who can approve, see a check issue, review and save the policy", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("note")).toContainText("Fixture mode");
    await page.getByRole("link", { name: /Customer Portal/ }).click();
    await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Settings" }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Policy" }).click();
    const policy = page.getByRole("region", { name: "Policy" });
    await expect(policy).toContainText("Revision 1");

    // The validation debounce: a timeout of 0 shows an issue and blocks Review until it is fixed.
    await policy.getByLabel("Timeout of check 1 in seconds").fill("0");
    await expect(policy.getByRole("alert").first()).toBeVisible();
    await expect(policy.getByRole("button", { name: "Review changes" })).toBeDisabled();
    await policy.getByLabel("Timeout of check 1 in seconds").fill("300");

    await policy.getByRole("group", { name: "Who can approve changes" }).getByLabel("Developer", { exact: true }).check();
    await expect(policy.getByRole("button", { name: "Review changes" })).toBeEnabled();
    await policy.getByRole("button", { name: "Review changes" }).click();
    await expect(page.getByLabel("After: Who can approve changes")).toContainText("developer");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(policy).toContainText("Revision 2");
  });

  test("files: upload, edit, move, delete, restore", async ({ page }) => {
    // every change polls to its end (1.5 s a step); nine steps in one story
    test.setTimeout(180_000);
    const nav = () => page.getByRole("navigation", { name: "Project sections" });
    const tree = () => page.getByRole("tree", { name: "Project files" });
    const row = (name: string) => tree().locator(".tree-row", { has: page.locator(".tree-name", { hasText: new RegExp(`^${name.replace(/[.]/g, "\\.")}$`) }) });
    const tray = page.getByRole("region", { name: "Uploads and changes" });
    const lastBatch = () => tray.locator(".tray-batch").last();
    const upload = async (files: Array<{ name: string; mimeType: string; buffer: Buffer }>) => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("form", { name: "Upload" }).getByRole("button", { name: "Upload files" }).click();
      await (await chooser).setFiles(files);
    };
    const actions = (name: string) => page.getByRole("group", { name: `Actions for ${name}` });

    // 1. Files, a git folder
    await openProject(page);
    await nav().getByRole("link", { name: "Files" }).click();
    await tree().getByRole("button", { name: /Requirements/ }).click();
    await expect(page.getByRole("form", { name: "Upload" })).toContainText("Into requirements");

    // 2. two files through Upload files; the tray reaches Added
    const big = Buffer.alloc(2 * 1024 * 1024, 7); // binary and 2 MiB: stored in LFS
    await upload([
      { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n\nFirst draft.\n") },
      { name: "hero.png", mimeType: "image/png", buffer: big },
    ]);
    await expect(lastBatch()).toContainText("Uploaded 2 files");
    await expect(lastBatch().locator(".change-status")).toHaveAttribute("data-state", "added", { timeout: 15_000 });
    await expect(lastBatch()).toContainText("Added");

    // 3. the tree lists both, the large one tagged LFS with its real size
    await expect(row("notes.md")).toBeVisible();
    await expect(row("hero.png")).toContainText("LFS");
    await expect(row("hero.png")).toContainText("2.0 MB");
    await expect(row("notes.md")).not.toContainText("LFS");

    // 4. edit the small text file, review the diff, save: Added, and the new content shows
    await row("notes.md").click();
    await actions("notes.md").getByRole("button", { name: "Edit" }).click();
    const contents = page.getByLabel("File contents");
    await expect(contents).toHaveValue("# Notes\n\nFirst draft.\n");
    await contents.fill("# Notes\n\nSecond draft, edited in place.\n");
    await page.getByRole("button", { name: "Review changes" }).click();
    const diff = page.getByRole("table", { name: "Changes to notes.md" });
    await expect(diff).toContainText("Second draft, edited in place.");
    await expect(diff).toContainText("First draft.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(lastBatch()).toContainText("Added", { timeout: 15_000 });
    await expect(lastBatch().locator(".change-status")).toHaveAttribute("data-state", "added");
    await expect(page.locator(".preview-text")).toHaveText("# Notes\n\nSecond draft, edited in place.\n");

    // 5. rename one file, then move both into a new subfolder
    await actions("notes.md").getByRole("button", { name: "Rename or move" }).click();
    const moveSheet = page.getByRole("form", { name: "Move files" });
    await moveSheet.getByLabel("New path").fill("draft-notes.md");
    await moveSheet.getByRole("button", { name: "Move", exact: true }).click();
    await expect(lastBatch().locator(".change-status")).toHaveAttribute("data-state", "added", { timeout: 15_000 });
    await expect(row("draft-notes.md")).toBeVisible();
    await expect(row("notes.md")).toHaveCount(0);

    await tree().getByRole("button", { name: /Requirements/ }).click();
    await page.getByRole("form", { name: "Upload" }).getByRole("button", { name: "New folder" }).click();
    const folderSheet = page.getByRole("form", { name: "New folder" });
    await folderSheet.getByLabel("Folder name").fill("media");
    await folderSheet.getByRole("button", { name: "Create folder" }).click();
    await expect(tree()).toContainText("Upload a file to keep this folder");
    await tree().getByLabel("Select draft-notes.md").check();
    await tree().getByLabel("Select hero.png").check();
    const selected = page.getByRole("group", { name: "Selected files" });
    await expect(selected).toContainText("2 selected");
    await selected.getByRole("button", { name: "Move" }).click();
    await moveSheet.getByLabel("Move 2 files to").fill("media");
    await moveSheet.getByRole("button", { name: "Move", exact: true }).click();
    await expect(lastBatch().locator(".change-status")).toHaveAttribute("data-state", "added", { timeout: 15_000 });
    await expect(row("draft-notes.md")).toHaveCount(0);
    await row("media").click();
    await expect(row("draft-notes.md")).toBeVisible();
    await expect(row("hero.png")).toBeVisible();
    await expect(tree()).not.toContainText("Upload a file to keep this folder");

    // 6. delete one, then restore the folder's previous version from Versions, and see it back
    await row("hero.png").click();
    await actions("hero.png").getByRole("button", { name: "Delete" }).click();
    const deleteSheet = page.getByRole("form", { name: "Delete files" });
    await expect(deleteSheet).toContainText("media/hero.png");
    await deleteSheet.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(lastBatch().locator(".change-status")).toHaveAttribute("data-state", "added", { timeout: 15_000 });
    await expect(row("hero.png")).toHaveCount(0);

    await nav().getByRole("link", { name: "Versions" }).click();
    await page.getByRole("navigation", { name: "Resources" }).getByRole("button", { name: /Requirements/ }).click();
    const versions = page.getByTestId("versions");
    // the first version, then one per change: upload, edit, rename, move, delete
    await expect(versions.locator(".version")).toHaveCount(6);
    await expect(versions.locator(".version-current")).toContainText("Accepted change");
    // newest first: the first offered restore is the version before the delete
    await versions.getByRole("button", { name: "Restore this version" }).first().click();
    await page.locator(".confirm").getByRole("button", { name: "Restore this version" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Restored." })).toBeVisible();
    await expect(versions.locator(".version")).toHaveCount(7);
    await expect(versions.locator(".version").first()).toContainText("Restored an earlier version");
    await nav().getByRole("link", { name: "Files" }).click();
    await tree().getByRole("button", { name: /Requirements/ }).click();
    await row("media").click();
    await expect(row("hero.png")).toContainText("LFS");

    // 7. the brand-assets file collection: no Edit, and the upload reaches Added
    await tree().getByRole("button", { name: /Brand and media/ }).click();
    await expect(page.getByRole("form", { name: "Upload" })).toContainText("Into brand-assets");
    await expect(page.getByRole("form", { name: "Upload" }).getByRole("button", { name: "New file" })).toHaveCount(0);
    await upload([{ name: "press-note.txt", mimeType: "text/plain", buffer: Buffer.from("For the press.\n") }]);
    await expect(lastBatch().locator(".change-status")).toHaveAttribute("data-state", "added", { timeout: 15_000 });
    await expect(lastBatch()).toContainText("Added");
    await row("press-note.txt").click();
    await expect(actions("press-note.txt").getByRole("button", { name: "Delete" })).toBeVisible();
    await expect(actions("press-note.txt").getByRole("button", { name: "Edit" })).toHaveCount(0);

    // 8. a developer, under the default policy (approvals from owner and client only): waiting for approval
    await page.goto("/?role=developer");
    await page.getByRole("link", { name: /Customer Portal/ }).click();
    await nav().getByRole("link", { name: "Files" }).click();
    await tree().getByRole("button", { name: /Requirements/ }).click();
    await upload([{ name: "dev-note.md", mimeType: "text/markdown", buffer: Buffer.from("From the developer.\n") }]);
    await expect(lastBatch().locator(".change-status")).toHaveAttribute("data-state", "waiting_approval", { timeout: 15_000 });
    await expect(lastBatch()).toContainText("Waiting for approval");
    await expect(lastBatch()).toContainText("someone with approval rights approves it");
    await expect(lastBatch().getByRole("link", { name: "View the change" })).toBeVisible();

    // 9. a client: no write actions anywhere, Download only
    await page.goto("/?role=client");
    await page.getByRole("link", { name: /Customer Portal/ }).click();
    await nav().getByRole("link", { name: "Files" }).click();
    await tree().getByRole("button", { name: /Requirements/ }).click();
    await row("README.md").click();
    await expect(actions("README.md").getByRole("link", { name: "Download" })).toBeVisible();
    await expect(actions("README.md").getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("form", { name: "Upload" })).toHaveCount(0);
    await expect(tree().getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Uploads and changes" })).toHaveCount(0);
  });

  test("staging header: the staging link, Reset demo data returns focus to its button", async ({ page }) => {
    await page.goto("/?staging&role=client");
    await page.getByRole("link", { name: /Customer Portal/ }).click();
    const bar = page.getByTestId("staging-header");
    await expect(bar).toBeVisible();
    await expect(bar.getByTestId("staging-link")).toHaveAttribute("href", /^https:\/\//);
    await bar.getByTestId("staging-reset").click();
    await page.getByRole("button", { name: "Reset demo data" }).last().click();
    await expect(bar.getByTestId("staging-reset")).toBeFocused();
    await expect(bar.getByTestId("staging-building")).toBeVisible();
  });

  test("staging: three tasks to production", async ({ page }) => {
    // the in-page fake moves staging builds and promotion steps on the page's clock: the test drives
    // that clock forward instead of waiting (each fast-forward also fires the screens' polls)
    await page.clock.install();
    const advance = async (check: () => Promise<void>) => {
      await expect(async () => {
        await page.clock.fastForward(1500);
        await check();
      }).toPass({ timeout: 30_000, intervals: [100] });
    };
    const nav = () => page.getByRole("navigation", { name: "Project sections" });
    const board = () => page.getByTestId("tasks-board");
    const card = (title: string) => board().locator(`[data-testid="task-card"][aria-label="${title}"]`);
    const column = (id: "working" | "staging" | "waiting" | "live") => board().getByTestId(`board-col-${id}`);
    const COPY = "Update the home page copy, banner and footer";
    const PHONE = "Add a phone field to the contact form";
    const RENAME = "Rename the contact name column";
    const NEW = "Add a map to the contact page";
    const promote = async (title: string) => {
      await card(title).getByRole("button", { name: "Promote", exact: true }).click();
      await expect(card(title).getByTestId("promote-set")).toContainText(title);
      await card(title).getByRole("button", { name: "Promote", exact: true }).click();
    };

    await page.goto("/?staging");
    await expect(page.getByRole("note")).toContainText("Fixture mode");
    await page.getByRole("link", { name: /Customer Portal/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Customer Portal" })).toBeVisible();
    // staging phase 4-2 (P42-2): once the poll says staging is on, no client editions and no Start an update
    await expect(page.getByTestId("staging-header")).toBeVisible();
    await expect(page.getByRole("button", { name: "Client editions" })).toHaveCount(0);
    await viewAs(page, "Client");
    await nav().getByRole("link", { name: /Tasks/ }).click();
    await expect(board()).toBeVisible();
    await expect(page.getByRole("button", { name: "Start an update" })).toHaveCount(0);

    // the staging header: the staging site, and what staging sent (caught, never delivered)
    const bar = page.getByTestId("staging-header");
    await expect(bar.getByTestId("staging-link")).toHaveAttribute("href", /^https:\/\//);
    await bar.getByTestId("staging-sent-toggle").click();
    await expect(page.getByTestId("capture")).toHaveCount(2);
    await expect(page.getByTestId("capture").first()).toContainText("/payments");
    await bar.getByTestId("staging-sent-toggle").click();
    await expect(page.getByTestId("capture")).toHaveCount(0);

    // New task → the hand-off for the agent → Working → the agent submits → In staging
    await page.getByTestId("new-task-open").click();
    const form = page.getByTestId("new-task");
    await form.getByLabel("Title").fill(NEW);
    await form.getByLabel("What should the agent do?").fill("Embed a map with our address under the contact form.");
    await page.getByTestId("new-task-submit").click();
    await expect(page.getByTestId("task-handoff-command")).toContainText("cforge checkout");
    await page.getByTestId("task-handoff").getByRole("button", { name: "Done" }).click();
    await expect(column("working").locator(`[aria-label="${NEW}"]`)).toBeVisible();
    await page.getByRole("note").getByRole("button", { name: "Finish running agent" }).click();
    await advance(async () => {
      await expect(column("staging").locator(`[aria-label="${NEW}"]`)).toBeVisible({ timeout: 200 });
      await expect(card(NEW)).toContainText("Live on staging", { timeout: 200 });
    });
    for (const t of [COPY, PHONE, RENAME]) await expect(column("staging").locator(`[aria-label="${t}"]`)).toBeVisible();

    // the copy task: the client may release every file → Live
    await promote(COPY);
    await advance(() => expect(column("live").locator(`[aria-label="${COPY}"]`)).toBeVisible({ timeout: 200 }));

    // the phone field: the automatic review (Jev) is not confident it is low risk → waits for a developer
    await promote(PHONE);
    await advance(() => expect(column("waiting").locator(`[aria-label="${PHONE}"]`)).toBeVisible({ timeout: 200 }));
    await expect(card(PHONE).getByTestId("task-card-heading")).toHaveText("Production update pending approval");
    await expect(card(PHONE).getByTestId("task-card-reason")).toContainText("The automatic review could not confirm this change is low risk.");
    // the client never sees the classifier's evidence
    await expect(card(PHONE)).not.toContainText("Jev");
    await expect(card(PHONE)).not.toContainText("%");

    // the developer: Needs you → the review screen (the automatic review's answers) → Approve → Live
    const review = async (title: string) => {
      await viewAs(page, "Developer");
      await nav().getByRole("link", { name: /Overview/ }).click();
      const needs = page.getByTestId("needs-you");
      await advance(() => expect(needs.locator(".needs-you-item", { hasText: title })).toBeVisible({ timeout: 200 }));
      await needs.locator(".needs-you-item", { hasText: title }).getByRole("link", { name: "Review" }).click();
      await expect(page.getByTestId("promotion-review")).toBeVisible();
    };
    const approve = async () => {
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await expect(page.getByTestId("promotion-actions").locator(".confirm-does")).toContainText("with database changes applied first");
      await page.getByRole("button", { name: "Approve", exact: true }).click();
      await advance(() => expect(page.getByTestId("promotion-review").locator(".promotion-head")).toContainText("Live", { timeout: 200 }));
    };
    await review(PHONE);
    const reviewScreen = page.getByTestId("promotion-review");
    await expect(reviewScreen).toContainText("The automatic review could not confirm this change is low risk.");
    await expect(reviewScreen).toContainText("Jev (TypeSafe)");
    await expect(reviewScreen).toContainText("jev-1.13.0");
    await expect(reviewScreen).toContainText("Not confident enough");
    await expect(reviewScreen).toContainText(/How risky is the change\?\s*medium\s*40\.0%\s*needs 90%\s*Below/);
    await approve();
    await viewAs(page, "Client");
    await nav().getByRole("link", { name: /Tasks/ }).click();
    await advance(() => expect(column("live").locator(`[aria-label="${PHONE}"]`)).toBeVisible({ timeout: 200 }));

    // the rename: a destructive migration → waits for a developer, with the reason
    await promote(RENAME);
    await advance(() => expect(column("waiting").locator(`[aria-label="${RENAME}"]`)).toBeVisible({ timeout: 200 }));
    await expect(card(RENAME).getByTestId("task-card-heading")).toHaveText("Production update pending approval");
    await expect(card(RENAME).getByTestId("task-card-reason")).toContainText("Changes the database structure in a way that needs a developer.");

    // the developer: the review screen (veto statement, paths) → Send back with a note
    const NOTE = "Please keep the name column and add full_name next to it; we migrate the data first.";
    await review(RENAME);
    await expect(page.getByTestId("promotion-veto")).toContainText("ALTER TABLE contacts RENAME COLUMN name TO full_name");
    await expect(page.getByTestId("promotion-paths")).toContainText("api/migrations/0003_rename_contact_name.sql");
    await expect(page.getByTestId("promotion-paths")).toContainText("Automatic review");
    await page.getByRole("button", { name: "Send back to staging" }).click();
    await page.getByLabel("Note for the client").fill(NOTE);
    await page.getByRole("button", { name: "Send back", exact: true }).click();
    await expect(page.getByTestId("promotion-review").locator(".promotion-head")).toContainText("Sent back to staging");

    // the client: the card is back In staging with the note, word for word
    await viewAs(page, "Client");
    await nav().getByRole("link", { name: /Tasks/ }).click();
    await advance(() => expect(column("staging").locator(`[aria-label="${RENAME}"]`)).toBeVisible({ timeout: 200 }));
    await expect(card(RENAME)).toContainText("Sent back to staging");
    await expect(card(RENAME).getByTestId("task-card-reason")).toContainText(NOTE);

    // promoted again, the developer approves → Live
    await promote(RENAME);
    await advance(() => expect(column("waiting").locator(`[aria-label="${RENAME}"]`)).toBeVisible({ timeout: 200 }));
    await review(RENAME);
    await approve();
    await viewAs(page, "Client");
    await nav().getByRole("link", { name: /Tasks/ }).click();
    await advance(() => expect(column("live").locator(`[aria-label="${RENAME}"]`)).toBeVisible({ timeout: 200 }));
    for (const t of [COPY, PHONE]) await expect(column("live").locator(`[aria-label="${t}"]`)).toBeVisible();
  });
});

test.describe("fixture: agent hand-off", () => {
  test("outside staging: New task on Changes → the hand-off → checked out → submitted → Make proposal", async ({ page }) => {
    await page.clock.install();
    await openProject(page);
    await page.getByRole("link", { name: /^Changes/ }).click();
    const TITLE = "Show opening hours on the contact page";
    await page.getByTestId("new-task-open").click();
    const form = page.getByTestId("new-task");
    await form.getByLabel("Title").fill(TITLE);
    await form.getByLabel("What should the agent do?").fill("Add our hours under the address.");
    // owners and developers may narrow the folders (clients never see this)
    await form.getByText("Choose folders").click();
    await form.locator('input[name="write"][value="website"]').check();
    await page.getByTestId("new-task-submit").click();

    // the hand-off: one Copy button leads; install (from npm), sign in with this origin and checkout
    // are under "Run the steps yourself"
    const handoff = page.getByTestId("task-handoff");
    await expect(handoff.getByTestId("handoff-copy-prompt")).toBeVisible();
    await handoff.getByText("Run the steps yourself").click();
    await handoff.getByText("See the prompt").click();
    await expect(handoff.getByTestId("handoff-install-command")).toHaveText("npm install -g @commonforge-org/cli");
    await expect(handoff).not.toContainText("isn't on npm yet");
    const origin = new URL(page.url()).origin;
    await expect(handoff.getByTestId("handoff-login-command")).toHaveText(`cforge login --api-url ${origin} --email dev@agency.example`);
    await expect(handoff.getByTestId("task-handoff-command")).toHaveText(/^cforge checkout task-[0-9a-f-]+ show-opening-hours-on-the-contact-page$/);
    const prompt = handoff.getByTestId("handoff-prompt-text");
    await expect(prompt).toContainText(`Title: ${TITLE}`);
    await expect(prompt).toContainText("Add our hours under the address.");
    await expect(prompt).toContainText("- You may change: website");
    await expect(prompt).toContainText(/cforge submit --commit="Finish task task-[0-9a-f-]+"/);
    await expect(handoff).toContainText("Make proposal");
    await expect(prompt).toContainText("cforge login --api-url");
    await expect(handoff.getByRole("button", { name: "Copy the prompt for your agent" })).toBeVisible();
    await expect(handoff.getByTestId("handoff-developer")).toHaveCount(0);
    await handoff.getByRole("button", { name: "Done" }).click();

    // the task under Changes: waiting for an agent → checked out → submitted → Make proposal
    const item = page.locator('[data-testid="change-task"]', { hasText: TITLE });
    await expect(async () => {
      await page.clock.fastForward(2000);
      await expect(item.getByTestId("change-task-agent")).toContainText("Waiting for an agent to check it out.", { timeout: 200 });
    }).toPass({ timeout: 20_000 });
    // the hand-off opens again from the row
    await item.getByTestId("change-task-handoff").click();
    await expect(page.getByTestId("task-handoff-command")).toContainText("show-opening-hours-on-the-contact-page");
    await page.getByTestId("task-handoff").getByRole("button", { name: "Done" }).click();

    await page.getByRole("note").getByRole("button", { name: "Agent checks out" }).click();
    await expect(async () => {
      await page.clock.fastForward(3000);
      await expect(item.getByTestId("change-task-agent")).toContainText("The agent is working.", { timeout: 200 });
    }).toPass({ timeout: 20_000 });

    await finishRepair(page);
    await expect(async () => {
      await page.clock.fastForward(3000);
      await expect(item.getByTestId("change-task-propose")).toBeVisible({ timeout: 200 });
    }).toPass({ timeout: 20_000 });
    await item.getByTestId("change-task-propose").click();
    await expect(page).toHaveURL(/\/changes\/prop-/);
  });

  test("staging, as the client: the hand-off from a Working card, with a message for the developer", async ({ page }) => {
    await page.goto("/?staging&role=client");
    await page.getByRole("link", { name: /Customer Portal/ }).click();
    const board = page.getByTestId("tasks-board");
    await expect(board).toBeVisible();
    const TITLE = "Add opening hours";
    await page.getByTestId("new-task-open").click();
    await page.getByTestId("new-task").getByLabel("Title").fill(TITLE);
    // a client chooses no folders
    await expect(page.getByTestId("new-task").locator('input[name="write"]')).toHaveCount(0);
    await page.getByTestId("new-task-submit").click();
    await expect(page.getByTestId("task-handoff")).toContainText("In staging on the Tasks board");
    await page.getByTestId("task-handoff").getByRole("button", { name: "Done" }).click();

    const card = board.locator(`[data-testid="task-card"][aria-label="${TITLE}"]`);
    await card.getByTestId("task-card-handoff").click();
    const handoff = page.getByTestId("task-handoff");
    await expect(handoff.getByTestId("handoff-login-command")).toContainText("--email client@customer.example");
    await handoff.getByText("Send this to your developer").click();
    await expect(handoff.getByTestId("handoff-developer-message")).toContainText("cforge checkout task-");
    await expect(handoff.getByTestId("handoff-developer-message")).toContainText("--email <your email>");

    // the task is ready for an agent a moment after it is created; then the agent checks out
    await expect(async () => {
      await page.getByRole("note").getByRole("button", { name: "Agent checks out" }).click();
      await expect(card.getByTestId("task-card-agent")).toContainText("The agent is working.", { timeout: 3500 });
    }).toPass({ timeout: 20_000 });
  });
});

test.describe("fixture: getting started in a brand-new organization", () => {
  test("the demo project starts with its checklist hidden (the fixture's seed), so it stays out of the demo", async ({ page }) => {
    await openProject(page);
    await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Overview" }).click();
    // the checklist renders with the Overview (both wait for the same project poll)
    await expect(page.getByRole("heading", { level: 2, name: "Updates in progress" })).toBeVisible();
    await expect(page.getByTestId("getting-started")).toHaveCount(0);
  });

  test("the checklist walks a new owner from an empty org to code, a release target and an invited client", async ({ page }) => {
    // `?orgs` adds "Second Client", an organization with no projects (main.tsx)
    await page.goto("/o/o-0de0c11e0002?orgs");
    await expect(page.getByRole("note")).toContainText("Fixture mode");
    const org = page.getByTestId("getting-started");
    await expect(org).toContainText("1 of 6 done");
    await expect(org.getByTestId("gs-org")).toHaveAttribute("data-done", "true");
    await expect(page.getByText("No projects you can see")).toHaveCount(0);

    // 1. the checklist's New project opens the form
    await org.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Project name").fill("Bakery site");
    await page.getByLabel("Project workflow").selectOption("legacy");
    await page.getByRole("button", { name: "Create project" }).click();
    await expect(page.getByRole("region", { name: "Folders" })).toBeVisible();
    await expect(page.getByText("This project has no folders yet.")).toBeVisible();

    // 2. the project's Overview: org and project done, Import from Git is next
    await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Overview" }).click();
    const gs = page.getByTestId("getting-started");
    await expect(gs).toContainText("2 of 10 done");
    await expect(gs.getByTestId("gs-code")).toHaveAttribute("data-done", "false");
    await expect(gs.getByTestId("gs-code")).toContainText("A ZIP creates its folders empty for now");
    await gs.getByRole("link", { name: "Import from Git" }).click();
    await expect(page.getByTestId("intake-git-public")).toContainText("Private repositories are not supported");
    await expect(page.getByTestId("intake-zip-empty")).toContainText("creates the planned folders empty");
    await page.getByLabel("Repository address").fill("https://github.com/acme/bakery-site");
    await page.getByRole("button", { name: "Import repository" }).click();
    await expect(page.getByTestId("intake-result")).toContainText("Imported", { timeout: 10_000 });

    // 3. code done; the release target is next: the Policy's Release example, used as is
    await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Overview" }).click();
    await expect(gs.getByTestId("gs-code")).toHaveAttribute("data-done", "true", { timeout: 15_000 });
    await expect(gs).toContainText("3 of 10 done");
    await gs.getByTestId("gs-release").getByRole("link", { name: "Open Policy" }).click();
    const release = page.getByTestId("policy-json-release");
    await release.getByText("Show example").click();
    await expect(release.getByLabel("Example: Release")).toContainText("cfapp-o-0de0c11e0002-site");
    await release.getByRole("button", { name: "Use this example" }).click();
    const policy = page.getByRole("region", { name: "Policy" });
    await expect(policy.getByRole("button", { name: "Review changes" })).toBeEnabled();
    await policy.getByRole("button", { name: "Review changes" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(policy).toContainText("Revision 1");

    // 4. release done; publishing is next, in Versions
    await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Overview" }).click();
    await expect(gs.getByTestId("gs-release")).toHaveAttribute("data-done", "true");
    await expect(gs.getByTestId("gs-publish")).toContainText("prepare, approve publishing, then publish");
    await expect(gs.getByTestId("gs-staging")).toContainText("optional");

    // 5. invite the client with access to this project
    await gs.getByTestId("gs-client").getByRole("link", { name: "Open Members" }).click();
    await expect(page.getByText("Only owners so far.")).toBeVisible();
    const invite = page.getByRole("form", { name: "Invite a member" });
    await invite.getByLabel("Email").fill("ana@bakery.example");
    await invite.getByLabel("Role").selectOption("client");
    await invite.getByRole("checkbox", { name: "Bakery site" }).check();
    await invite.getByRole("button", { name: "Invite" }).click();
    await expect(page.getByText("Only owners so far.")).toHaveCount(0);
    await page.getByRole("navigation", { name: "Organization" }).getByRole("link", { name: "Projects" }).click();
    await page.getByRole("link", { name: /Bakery site/ }).click();
    await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Overview" }).click();
    await expect(gs.getByTestId("gs-client")).toHaveAttribute("data-done", "true", { timeout: 15_000 });

    // Hide: the checklist goes away for this project
    await gs.getByRole("button", { name: "Hide" }).click();
    await expect(page.getByTestId("getting-started")).toHaveCount(0);
  });
});
