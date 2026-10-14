# CommonForge demo script (target 8:00, hard limit 10:00)

Derived from PRD §14.4 and plan §C.1. Narration expanded 2026-10-06 after the final pipeline review found the original Say lines totalled about 240 words (a two-minute video); the composition's scene lengths follow the narration audio, so the text below is sized for roughly eight minutes at 130 words per minute with margin under the ten-minute cap. Each `**Say:**` line is one spoken paragraph; `video/scripts/script-text.ts` reads them. Everything shown runs live against the dedicated Cloudflare account; nothing is prerecorded or simulated in the core path. Record in one take if possible; a second take is fine. Keep the `evidence/` output of the recorded run.

**Judging lens:** originality of the collaboration model (50%), concurrency / coordination / context / review / conflicts (25%), ease of use (25%). Every beat below names which lens it serves.

**One-line thesis to say first:** "One project. Many sources. Your preferred tools. Parallel agents. One approved path to production. And the client never touches the production repository."

## Cast

| Role | Who / what | Credentials they hold |
|---|---|---|
| Developer (you) | Browser, developer role | Everything |
| Client | Second browser profile, client role | Edition read token only |
| Agent A | Real agent CLI session, developer authority | Write tokens to task forks of `website` and `api` |
| Agent B | Real agent CLI session, client edition | Write token to the edition task fork only |
| Agent C | Real agent CLI session, developer authority | Write token to task fork of `requirements` + asset staging |

Fixture project "Demo Client / Customer Portal": `website` (static quote UI), `api` (Hono Worker `/quote`), `brand-assets` (R2: logo + 50 MB video), `requirements` (small text repo with `contracts/quote.schema.json`).

## Timeline

### 0:00–0:45 — The mess, then one project (originality, usability)

**Show:** a folder with two repos, a ZIP prototype, a brand folder with a 50 MB video.
**Do:** "Add files" (today intake is API-only, so this beat is a terminal pane running the intake call unless the UX polish adds the screen) → dry-run inventory appears: nested repos detected, `node_modules` excluded, the video flagged as too large for Git and routed to R2, a fake `.env` blocked with the value hidden.
**Say:** "Here is what a client hands us on a normal Tuesday. Two application repositories, a prototype built with an AI tool and exported as a zip, a brand folder with a fifty-megabyte launch video, and a note that says: can you make this work together."
**Say:** "Most tools would make us flatten all of that into one repository. CommonForge does not. Intake runs a dry-run inventory before anything is written: it keeps the nested repositories separate, excludes dependencies, routes the large video to object storage instead of Git, and blocks a stray environment file without ever showing its contents."
**Say:** "The result is one project the client can understand, built from resources that keep their own identity, history and permissions. The source inspector shows the real Artifacts repository behind the website and the asset manifest behind the brand folder."
**Evidence on screen:** project tree with four resources; source inspector reveals the Artifacts repo and revision behind `website`, the R2 manifest behind `brand-assets`.

### 0:45–1:30 — Client starts an update without production access (originality, usability)

**Switch to client profile.** Click "Start an update" → choose edition "Website pages" → download the working copy (ZIP).
**Say:** "Now the client. They want to improve the quote page on their own portal, and they do not want to learn Git to do it."
**Say:** "They click Start an update. CommonForge pins the version that is actually live, not whatever is on a main branch, and publishes a working copy from an allowlist the developer configured. It is a fresh repository with a single commit. Not a branch of production. Not a fork with history."
**Say:** "Watch the terminal. With the client's own credentials, cloning the canonical repository is denied. Cloning the edition works, and the log shows exactly one commit. A secret seeded into the real repository's old history is simply not there."
**Say:** "The client sees a folder. The developer keeps the repository."
**Evidence:** terminal with the client's token: `git clone <canonical website remote>` → **denied**; `git clone <edition remote>` → works; `git log` in the edition shows one commit. Mention the canary: a secret seeded in old canonical history is absent (point at the test name, don't spend time on it).

### 1:30–2:30 — Client edits in their own tool (usability)

**Do:** open the edition folder in one real external tool (Cursor or Codex), make a visible UI change to the quote form (new "breakdown" section). Zip and "Return changes" in the browser. No Git commands.
**Say:** "This is the part clients care about. They open that working copy in whatever tool they already use. Here it is Cursor. They ask for an itemised breakdown on the quote form, the tool edits the files, and that is the whole workflow."
**Say:** "When they are done, they zip the folder and click Return changes. The platform compares the returned files against the inventory it recorded when it published the copy, so it knows precisely which two files changed."
**Say:** "Then it enforces scope. Allowed paths are mapped back onto the real repository. Protected paths are blocked with a plain reason. If someone edits the manifest to redirect the change, that is refused as a path escape, because the manifest on the server is the authority, never the one in the folder."
**Say:** "Two files changed, zero blocked. The client's work is now a candidate, and it has not touched production."
**Evidence:** return screen shows 2 files changed, 0 blocked; a second return attempt with an edited `.commonforge/manifest.json` shows **blocked: path_escape** (10 seconds, optional if short on time).

### 2:30–4:00 — Three real agents, concurrently, one of them spanning two repos (concurrency)

**Do:** run the orchestrator; three terminal panes start within seconds. Agent A's workspace has `website/` and `api/` as sibling checkouts; it changes the `/quote` response and the UI together. Agent B works the client edition. Agent C replaces the logo and updates requirements text.
**Say:** "Meanwhile the developer's agents have been working, and this is where Artifacts earns its place. Three real agent sessions start within seconds of each other. These are live coding agents, not replays; the timestamps come from the platform's event log."
**Say:** "Agent A has one task that spans two repositories. Its workspace holds the website and the API side by side, each a fork of the canonical repository with its own short-lived write token. It changes the quote endpoint and the interface that consumes it as one piece of work."
**Say:** "Agent B is the client's edition from a moment ago. Agent C is replacing the logo in the asset collection and updating the written requirements."
**Say:** "Nobody shares a writable directory. Nobody holds a token to production. When an agent submits, the platform freezes the exact commit, revokes its write token and records the candidate. One more push after that is denied."
**Say:** "Isolation here is a credential boundary, not a convention, and that is what lets hundreds of agents share a project safely."
**Evidence:** activity view with overlapping `task.started` / `candidate_frozen` timestamps; "concurrency.json" exported; the agents' tokens revoked at freeze (token list shows revoked).

### 4:00–5:00 — The combined app is not ready, and the platform proves it (conflicts)

**Do:** open the Change. Integration ran: Git merged cleanly, but the contract check failed — `api` changed the `/quote` schema and the `website` contract test fails.
**Say:** "Now the interesting part. Integration runs in an isolated runner. Git merges all three candidates without a single textual conflict."
**Say:** "CommonForge does not trust a clean merge. The project declares a contract between the API and the website: the shape of the quote response. Agent A changed that shape, and the website's contract test fails against the merged result."
**Say:** "So the Change stops. Nothing is accepted, production is untouched, and the evidence panel shows exactly why: merge clean, contract failed, fourteen of fourteen tests passing elsewhere. The badge says Needs your decision."
**Say:** "A clean merge is not proof the application works. Declared contracts and executable checks are. An agent saying the tests passed is not evidence; the runner's signed results are."
**Evidence:** evidence panel: `mergeOutcome: clean`, `contractChecks: quote → FAIL`; proposal hash shown; "Needs your decision" badge.

### 5:00–6:00 — Repair, validate, private preview (conflicts, usability)

**Do:** Agent A (or you) fixes the UI contract, resubmits. New proposal hash. Integration passes. Click "Open preview" as the client: the quote flow works end to end on the separate `commonforge-preview` origin with fixture data (per-candidate hostnames need the demo zone; spike A7 was PARTIAL).
**Say:** "The developer sends the conflict to the repair agent. It gets a fresh isolated workspace on the current accepted version, with both candidates attached as read-only references, and reconciles the interface with the new API shape."
**Say:** "When it resubmits, the proposal identifier changes. Every edit is a new immutable identity, so an approval given to the old version cannot ride along with the new one. Integration runs again. Contracts pass. Tests pass."
**Say:** "Now the client gets a private preview on a separate origin, behind an expiring token, with isolated test data and outbound traffic disabled. They can actually use the quote flow, and the side-effect counters stay at zero, because nothing in a preview can reach a real database, email or payment."
**Evidence:** preview origin differs from the app's; the link is token-gated and expiring; side-effect counters unchanged after submitting a test quote.

### 6:00–7:15 — Approve, accept, publish: three separate authorities (originality, conflicts)

**Do:** Client clicks "Approve outcome". Developer clicks "Accept" — ledger records the new accepted version, canonical `main` reconciles. Then "Publish" — a separate release record; deploy runs; `/version` health check turns green; the live demo app shows the change.
**Say:** "Three decisions get this change to production, and they are three separate records with three separate permissions, even when one person holds all three."
**Say:** "First the client approves the outcome. They tested the preview, it does what they asked, they click Approve. That decision is theirs."
**Say:** "Second the developer accepts. The ledger, a Durable Object, checks in one atomic transaction that the proposal identity matches what was reviewed, that the accepted heads of all three resources are still what the candidate was built on, and that the approval is not stale. Only then do the accepted versions advance. The Git branches follow the ledger, not the other way round."
**Say:** "Third, publishing. A separate release record binds the accepted version, the build digest and the target. The developer approves the release, the deploy runs, the health check turns green, and the live portal shows the new quote breakdown."
**Say:** "Switch to the client's view. Same proposal identifier, same timeline, and it is live. What they do not see is a publish button. They never had that permission, and they never needed it."
**Evidence:** Change timeline with three distinct events; release receipt with accepted version id, build digest, observed live version. Optional 10 s: switch to the client view to show it has no publish controls at all (clients never see Prepare/Approve-publishing/Publish).

### 7:15–8:00 — Restore code and assets together, export everything (originality, usability)

**Do:** Versions → pick the previous version (old logo + old quote UI) → "Restore this version" → publish through the same gate (today the UI has no restore-then-publish path; the release is created with `POST /releases {acceptedVersionId}` from a terminal pane unless the UX polish adds it). Then "Export": git bundles + asset manifest downloaded; `git bundle verify` in terminal.
**Say:** "One more thing, because real projects need it. Suppose the new logo was a mistake. We go to Versions, pick the previous version, and restore it. Code and assets come back together, because a version is the whole project."
**Say:** "Restore is a new forward version, never a history rewrite. The audit trail stays intact, and it goes through the same publish gate as everything else."
**Say:** "And nothing is locked in. Export gives you ordinary Git bundles and an asset manifest with hashes, verifiable with plain Git. No proprietary filesystem, no vendor format."
**Close:** "Clients work in their own tools. Agents work in isolation. Developers keep authority. One approved path to production, built on Cloudflare Workers and Artifacts. CommonForge. Build together faster."

## Staging client scenes (always-on staging; staging Phase 4-2)

Spec §2 and §12 (docs/superpowers/specs/2026-10-07-always-on-preview-promotion-design.md): once staging is
verified live, the client scenes (0:45–2:30, edition and return) are told with three client tasks
on a staging-mode project instead. Verified live on CI on 2026-10-11 (Phase 4-1) and with this exact
seed (Phase 4-2, `scripts/ci-live/seed-staging.ts`, evidence `evidence/ci/seed-staging-*`).
In a staging-mode project there is no edition, no Propose and no Preview (the Worker refuses them,
P42-2), so these scenes replace the edition scenes; they do not sit next to them.

**Seed** (the owner, the day before or the morning of; ~25 min, mostly staging builds):
`pnpm seed -- --client-email <client> --new-org "Demo Client" --staging --stage-tasks`. The take opens on the client's **Tasks board** with three cards **In staging**:
"Update the home page heading", "Add a phone field to the contacts", "Rename the contact email column".

1. **Copy (gate `self`).** Client clicks the copy card's **Promote**, confirms the sheet.
   **Say:** "The client changed the heading. Staging already shows it. Text on the home page is the
   client's to ship, so Promote goes straight to production." The card moves to **Live** (~3–4 min:
   cut while it releases); the production page shows "Customer Portal: quotes in seconds".
2. **Phone field (gate `classify`).** Client promotes the phone card. The classifier (Jev) reads the
   diff and the migration. In every live run so far it **declined** (risk medium), so the card waits in
   **Waiting for approval**: the phone field goes to a developer (owner decision 2026-10-11).
   **Say:** "API code and a database change. The platform asks a classifier; it is not sure enough, so
   a developer looks." Switch to the developer: **Review** opens the promotion review with Jev's
   answers and the additive migration; **Approve**. Production's database gets the column before the
   code (~3–4 min). If Jev ever clears it, say so and skip the developer beat.
3. **Rename (migration veto).** Client promotes the rename card. **Say:** "Renaming a column would
   break whatever reads it. No classifier gets asked: a destructive migration always goes to a
   person." Developer: the review names the `RENAME COLUMN` statement; **Send back to staging** with
   the note "Renaming a column breaks existing callers; add a new column instead." The client's card
   shows the note. Production never saw the rename.

**Fallback** if the live seed fails or a beat stalls: the fixture demo at `/?staging` (all three
beats, no backend) — record the board and the review screen there and say it is the same screen.
Selectors for these screens: `selectors.json` `shared` keys `staging*`.

## Cut order if the take runs long

1. The manifest-tampering demonstration (1:30 block).
2. The client-has-no-publish-controls cut (6:00 block).
3. Agent C's requirements text edit (keep the logo replacement; restore needs it).
4. The `git bundle verify` terminal (keep the export download).

Never cut: canonical clone denied, three overlapping agents, contract failure, three-authority publish, restore.

## Pre-flight checklist (run 30 minutes before recording)

- Fresh fixture project seeded; previous demo run's forks collected.
- All three agent CLIs logged in; prompts are in `apps/demo-agents/src/prompts.ts`.
- Client browser profile logged in as client role; developer profile as owner.
- Live app at the previous version; preview origin resolving (add the demo zone first if you want per-candidate hostnames).
- `wrangler tail` running in a hidden pane for recovery if something stalls.
- Screen recording at 1080p, 30 fps; system audio off; microphone tested.

## Option B — "Two agents, one component" (owner idea, 2026-10-06)

**Owner decision 2026-10-06:** ship the main timeline for the submission; Option B (linked developer request + automatic conflict-to-resolution task) is deferred and will be revisited in a later iteration, likely after the first live rehearsal. Nothing below is authorized for implementation now.

A sharper conflict story that keeps the P0 trust boundaries. Replaces the 2:30–6:00 blocks of the timeline above; everything else stays.

**Pitch line:** "Zero babysitting. Two human decisions."

### Storyboard

1. **Client agent** (edition, client authority) adds a financing option to the quote UI and also tries to change the API. The platform blocks the API path for the client with a reason and offers **"Request developer change"**, creating a linked developer Change that carries the client's intent and the UI candidate as a read-only reference.
2. **Developer agent** (developer authority) is already restyling the same quote component in its own fork. It picks up the linked request, adds the API field and updates `requirements/contracts/quote.schema.json`.
3. **Collision.** Integration shows a textual conflict in the same component file and the UI contract test fails against the new schema. Nothing is accepted; production is untouched.
4. **Auto-resolution.** On `textual_conflict` / `stale_base` the system dispatches a resolution task to the developer agent: fresh isolated workspace on the current accepted head, both candidates attached as references. The agent produces a merged candidate; contracts and tests pass; the private preview shows both changes working.
5. **Review Brief.** What changed, what was verified, the protected API change flagged separately from the cosmetic edit, the resolution's provenance (which candidates, which agent, which checks). Client approves the outcome; developer accepts; publish; live.
6. Restore and export as in the main timeline.

### Why the human clicks stay

PRD FR-10 (AI may explain or propose, never certify correctness), FR-20 and §11.1 (every client-authored change needs technical-owner acceptance and explicit publish; no automatic low-risk publish engine in P0). The automation is everything *before* Accept and Publish. "The agent said it was safe → deployed" would read as reckless to this audience and contradicts the product thesis.

### Database variant (optional stretch)

The owner's original phrasing had the client change needing a database row. The fixture has no database and previews are fixture-isolated, so the equivalent used above is a **new API field** (protected path for the client, contract-schema change for the developer). If a D1 table is added to the `api` fixture later, the honest extra beat is: restore reverts code and assets, and the platform shows that the schema change stays (PRD FR-12).

### Capability gaps (code work; estimate before committing to Option B)

| Gap | Size | Notes |
|---|---|---|
| Blocked protected path → "Request developer change" linked Change | Small | Blocking with reasons exists (Task 21). New: a button that creates a developer-authority Change with the client intent and the UI candidate as a reference. |
| Conflict → auto-dispatched resolution task | ~1 focused day + freeze time | Trigger on `textual_conflict`/`stale_base`; create a task on the current head with both candidates as references; hand to the demo-agents orchestrator; existing `integrate` job validates the result. Reverses the P0 "stale-refuse, no auto-rebase" decision; must be demo-stable. |
| Review Brief with protected-change separation and resolution provenance | Small–medium | Evidence panel exists (Task 20); add the protected-surface split and provenance lines (research RC-01). |

**Decision rule:** build the linked-request button regardless. Attempt auto-resolution with a hard stop at end of day October 11; if not stable, fall back to the main timeline with the developer agent re-run manually using the conflict context. Do not let Option B consume Task 23's freeze.

### Cheap extra beats (any option)

- **Stale approval (15 s):** client approves; developer agent lands one more change; the approval is invalidated on screen.
- **Revoked token (10 s):** after freeze the agent tries one more push and is denied.
- **Split screen:** client view and developer view with the identical proposal hash.
- **Scale card (10 s):** Task 5 benchmark: 700 task lifecycles, 0 throttled requests, ~24% of the control-plane limit at concurrency 100. Answers the "hundreds of thousands of agents" framing honestly.
- **Crash-and-resume:** kill an agent session mid-task; resume from the pushed checkpoint in a new session. Confirm with the implementing session whether resume-elsewhere is demo-ready before promising it.

## Known UI gaps that affect the script (2026-10-06)

- Intake ("Add files", UX-3, owner only): Files → Add files → ZIP or public URL → dry-run inventory with reasons → Confirm. Confirming a ZIP creates the resources and folders but does not copy the archive's content into them yet (`pendingPopulation`; the runner `intake-apply` job does not exist); the screen says so before and after Confirm. A URL import is complete (first version bound). Fixture mode has an empty "Agency handover" project for this beat; the populated project still comes from the seed.
- Restore-then-publish (UX-3): after "Restore this version" on a code resource, Versions offers "Publish this version" (prepare `{acceptedVersionId}` → publish approval → deploy). Asset collections are not release sources, so restoring one shows a neutral note instead of a publish offer.
- Clients have no publish controls at all (good); there is no "disabled button" to show.
- Agent output is not live-streamed; terminal panes are rendered from the orchestrator's timestamped per-lane log.
- Option B's "Request developer change" and auto-resolution are not built.
