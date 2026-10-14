# UX polish brief: from technical console to a product people understand

Owner direction (2026-10-06): the web app currently reads as a wall of technical information, even to a developer. Make it polished, easier to read and navigate, and visually representative rather than text-based, with the client side first. This brief sets the direction; a screen-by-screen audit against the current `apps/web` follows once the capture scout's inventory is in.

## 0. Direction mockup

Two artboards showing the intended look, exported into the repo as static HTML and PNG under [`docs/design/mockups/`](design/README.md) (open the HTML in a browser for exact values): the client Overview and the developer Change storyboard with inspector drawer. The editable canvas is the owner's [CommonForge UI Mockups](https://claude.ai/artifact/VW2Um2Vp98ghivEReEc1Vf) artifact (private). **Owner decision 2026-10-06: the mockup's direction is approved, including IBM Plex Sans (UI) + IBM Plex Mono (hashes, code, terminal) in place of Inter.** The accent and attention colours stay as in §5; the mockup exposes them as live tweaks.

**Logo set (owner-supplied 2026-10-06), see `brand/README.md`:** `commonforge-headerlogo-dark.png` for the dark app header and video; `commonforge-headerlogo-light.png` for the GitHub README, submission page and any future light theme (navy wordmark, deep teal `#10B0A0` for the accent on light); `commonforge-icon-512.png` is the mark alone for favicon, app icons, avatars and any placement under about 120 px. Copy what the app needs into `apps/web/public/brand/`. The dark wordmark's mint `#38F0D0` is the brand accent.

## 1. Principles

1. **Two audiences, one truth.** Client and developer see the same objects (Project, Files, Changes, Versions) and the same immutable identities, at different depths. Never a separate "dumbed-down" data model; the developer view is the client view plus an inspector.
2. **Show state, don't print it.** Every state in the PRD state machines gets a visual (icon, colour, position on a rail), a plain-English label, and a one-line "what happens next". Raw enum strings, hashes, IDs and timestamps move into a collapsible "Details" drawer or tooltip.
3. **Progressive disclosure.** Default screens answer "what is this, what changed, what do I need to do". Everything else is one click deeper, never gone.
4. **Plain language from the PRD's vocabulary** (§4.1): "Add files", "Start an update", "Open working copy", "Refresh preview", "Send for approval", "Review result", "Restore this version". Internal terms (fork, candidate, proposal, ledger, reconcile) appear only in the developer inspector, with a glossary tooltip.
5. **Motion with meaning.** Transitions show causality (a candidate sliding into a Change; a hash changing when a candidate changes; an approval badge greying out when invalidated). No decorative animation.
6. **Trust cues stay visible.** "Approved, not live", "Preview is isolated test data", "Client cannot access production repository" are badges, not footnotes. Polish must not hide the product's honesty.

## 2. Information architecture (target)

```text
Project (one per client application)
├── Overview       what is live, what is in review, what needs me        ← landing for both roles
├── Files          visual tree with resource "chips" (repo / assets / notes), inspector on the right
├── Changes        cards, not rows: outcome title, who/what, state on a rail, next action
│   └── Change     storyboard: Request → Work → Check → Review → Approve → Accept → Publish → Live
├── Versions       vertical timeline; each node = code + assets together; "Restore this version"
└── Activity       grouped by Change; agent events collapsed under their Change
Decision inbox     "Needs you" stack at top-right of every page (research RC-04, minimal)
```

## 3. Client experience (first priority)

| Moment | Today (typical) | Target |
|---|---|---|
| Landing | Lists, IDs | "Your Customer Portal" card: live version thumbnail, "Start an update" button, "Needs you" stack |
| Start an update | Edition picker with technical fields | Three cards with icons: "Website pages", "Customer portal interface", "Email content"; each says what you can change and what you can't; one primary button "Open working copy" (download) |
| Return changes | Upload form | Drop zone; after upload, a before/after file list with friendly icons and a plain summary: "2 files changed · 0 blocked"; blocked items explained in one sentence with "Ask the developer" button |
| Review result | Diff and evidence tables | Side-by-side screenshots of the preview (before / after), the outcome text, a green "Checks passed" or amber "Needs a developer decision" chip; technical diff behind "Show details" |
| Approve | Button among others | One clear primary action "Approve this result"; the publish step is visibly someone else's ("Your developer will publish") |
| Status | State strings | Rail with five dots: Working → Preview ready → Approved → Published → Live; the current dot pulses |
| Restore | List of versions | Timeline cards with the preview thumbnail of each version; "Restore this version" opens a confirm sheet that says what restore does and does not do |

## 4. Developer experience

- **Change storyboard** replaces the proposal page: a horizontal rail (Request → Work → Check → Review → Approve → Accept → Publish → Live) with the current step expanded. Each step card shows the minimum: who, when, evidence chips (merge clean / contract FAIL / tests 14/14), and a single primary action.
- **Review Brief** (research RC-01) at the top of Review: requested outcome → what changed (grouped by screen/resource) → what was verified → protected-surface changes flagged amber → unverified items → "Your decision".
- **Inspector drawer** (right side, togglable) holds everything technical: resource provider and revision, proposal hash, candidate shas, token/lease state, ledger decision codes, raw evidence JSON, copy buttons. This is where today's text lives.
- **Agent lanes**: the live lanes view becomes a horizontal swim-lane board; each lane is a card with avatar, task title, current step, elapsed time; clicking opens the terminal transcript.
- **Release Receipt** (research P07): one card binding accepted version, build digest, target, observed live version, health. States as badges: "Ready for review", "Approved, not live", "Deployment failed", "Live".

## 5. Visual language

- **Theme tokens** shared with the demo video (`video/src/theme.ts`): frame `#0B0F17`, panel `#121826`, text `#E6EDF3`, accent mint `#38F0D0` (logo wordmark; deep teal `#08A898` appears in the mark and may be used for hover/pressed), amber `#F59E0B`, success `#34D399`, danger `#F87171`; IBM Plex Sans + IBM Plex Mono (Google Fonts); 8-pt spacing; 12-px radius cards; soft 1-px borders at 8% white.
- **Iconography per object**: repository (branch icon), assets (image stack), notes (document), edition (hand-over), agent (spark), human (person). Consistent across tree chips, cards, timeline nodes and video callouts.
- **State colours** fixed: working teal, ready green, needs-decision amber, blocked/failed red, superseded grey.
- **Dark by default**, with a light theme later; both must pass WCAG AA contrast.
- **Empty states and first-run** written for the client ("No updates yet. Start one when you're ready.").

## 6. Readability rules

- No raw UUIDs, shas or ISO timestamps in the default view. Show "2 minutes ago", "version 7", "#a3f9" short hashes only in the inspector.
- Maximum one primary button per view; secondary actions in a kebab.
- Every table that is really a list of things with state becomes cards or a timeline.
- Every error has a cause and a next step in one sentence.

## 7. How this feeds the demo

Each DEMO-SCRIPT beat gets a "hero frame" the video can zoom on: the resource chips in Files (0:00), the edition cards (0:45), "2 files changed · 0 blocked" (1:30), the swim-lane board (2:30), the amber "Needs a developer decision" chip with "contract FAIL" (4:00), the before/after preview (5:00), the three-badge rail Approve → Accept → Publish with the identical short hash on both roles (6:00), the version timeline with Restore (7:15). Capture selectors (`video/scripts/selectors.json`) should target these hero elements via `data-testid`, so the redesign and the capture script land together.

## 8. Sequencing and ownership

1. **Audit** (controller, after the scout's inventory): map every current screen to the target IA; list which components exist, which change, which are new. Output: an internal task plan (not published).
2. **Design tokens + primitives first** (cards, rail, badges, inspector drawer, timeline), then the client flow (Overview, Start an update, Return, Review, Approve), then the developer Change storyboard and Review Brief, then lanes and receipts.
3. **Every redesigned hero element gets a `data-testid`** named in this brief's §7 so the capture script is stable.
4. Freeze UI changes before the capture run (Task 23 freeze still governs). Visual polish that lands after the capture run does not appear in the video.

## 9. Non-goals for the competition window

Light theme, mobile layouts beyond "readable", localisation, a full annotation widget, and the Decision Inbox beyond a "Needs you" stack. These are P1 per the PRD and the research report.

## 10. Handoff to the implementing session (owner decision 2026-10-06)

The `apps/web` redesign is owned by the session executing the main plan (the Omarchy machine). Scope for that session, in priority order:

1. **Primitives and tokens** (§5): theme tokens, cards, state rail, badges, inspector drawer, timeline. Share token values with `video/src/theme.ts`.
2. **Client flow** (§3): Overview, Start an update (edition cards), Return (drop zone + "N files changed · M blocked"), Review (before/after preview, outcome, checks chip), Approve, status rail, Versions timeline with Restore.
3. **Two demo-blocking gaps** from the internal capture briefing (both have since landed):
   - an **Add files / intake screen** (ZIP or public URL → dry-run inventory with reasons → confirm), backed by the existing `/api/orgs/:o/intake/*` routes;
   - a **restore-then-publish path** from Versions (after "Restore this version", offer "Publish this version", calling `POST /releases {acceptedVersionId}` and the existing publish-approval and deploy steps).
4. **Developer flow** (§4): Change storyboard rail, Review Brief, Release Receipt, swim-lane agent board, inspector drawer holding all technical detail.
5. **Hero `data-testid`s** (§7) on every element the video zooms on; update `video/scripts/selectors.json` in the same PR when a selector changes (the capture script reads only that file).

Rules: keep every existing e2e test passing or update it deliberately; no new authority or API semantics, UI only plus the two thin routes above; land before Task 23's live freeze run, because the capture happens only after the freeze and nothing that lands later appears in the video. Progress was recorded in an internal log (not published).

## 11. Follow-ups found in the first live rehearsal (2026-10-06)

1. **Edition sessions as lanes.** The lanes board says "Up to 2 agents at once" while three agents run, because the client-edition path is a session, not a task. Show active edition sessions as lanes (avatar: client) so the board matches the narration's "three real agent sessions".
2. **Intake inventory: collapse nested repositories.** The dry-run inventory lists every file under a nested `.git/` directory separately (84 of 111 lines for two exported repos). Show one row per nested repository ("nested repository (26 files): import by URL to keep its history") with the files behind a disclosure.
3. **Intake: `.npmrc` is flagged as a credential file.** Correct in principle (it can carry tokens); say "may contain a registry token" rather than "looks like a credential file", and offer "include anyway" for files the owner has inspected.
