# CommonForge demo video

Remotion project that composes the competition demo video from captured footage
(Playwright clips, screenshots, asciinema casts) and per-scene narration. Narration text:
[docs/DEMO-SCRIPT.md](../docs/DEMO-SCRIPT.md).

This directory is a **standalone** pnpm project (own `pnpm-workspace.yaml` and
lockfile). It is not part of the monorepo workspace, so its dependencies never
touch the root `pnpm-lock.yaml`.

## Requirements

- Node 22 or newer, pnpm 10
- `ffmpeg` and `ffprobe` on `PATH` (placeholders, narration durations; override with `FFMPEG=` / `FFPROBE=`)
- Capture: `pnpm exec playwright install chromium` once (also needed by `pnpm test`), `curl`, `jq`, `zip`
- Optional: the `whisper` CLI (`pipx install openai-whisper`) for word timings from owner recordings
- Rendering downloads Remotion's Chrome Headless Shell into `node_modules/.remotion/` on first use
- About 2 GB free temp space for a full render

## Commands

Run everything from `video/`:

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies (standalone lockfile) |
| `pnpm placeholders` | Generate placeholder media for every file `narration.json` and `media.json` reference, marked as placeholders and recorded in `.placeholder-manifest.json`; existing files are kept (`--force` regenerates only files that are still placeholders, never real media) |
| `pnpm check:fit` | Per scene: how long each pane is on screen, the source window it plays against the source length, and the capture marks inside it; flags clips that would freeze, marks outside the window, casts cut short and missing files |
| `pnpm check:placeholders` | The final-render guard: lists placeholder files left in `public/clips` and `public/audio`, missing or placeholder proposal hashes, clips and screenshots without a live capture proof, and a length outside 5–10 minutes |
| `pnpm narration:build` | Rebuild `narration.json` from the audio in `public/audio/` (durations via ffprobe; `--whisper` adds word timings; `--trim-silence` cuts leading/trailing silence) |
| `pnpm narration:elevenlabs` | Generate narration with ElevenLabs, then rebuild `narration.json` (`--only 1,5` for some scenes) |
| `pnpm dev` | Open Remotion Studio |
| `pnpm render:preview` | Half-resolution check render → `out/preview.mp4` (about 3 minutes) |
| `pnpm render` | Final 1920×1080, 30 fps H.264/AAC → `out/commonforge-demo.mp4`; refuses while any placeholder remains |
| `pnpm seed -- …` | Seed a fresh demo project on a CommonForge Worker before a take (see below) |
| `pnpm capture:dry` | Run every browser capture against the fixture-mode web build (selector check) → `public/clips-dry/`, never final footage |
| `pnpm capture` | Record browser clips and screenshots from the live app → `public/clips/` (`--scenes 1,5` for some) |
| `pnpm capture:terminals` | Run one demo-agents orchestrator and timestamp its lane lines into `public/clips/orchestrator.log` (`--dry-run` or `-- <command>`: a rehearsal, logged to `.capture/rehearsal/`) |
| `pnpm casts` | Split `orchestrator.log` into the scene 4 agent casts (`--step-logs <run-dir>/logs` appends the agents' step logs) |
| `pnpm align-lanes` | Write scene 4's `castOffsetSec` to `media.json` from `orchestrator.log` and the lanes clip's `.marks.json`, so the agent panes run in step with the clip (`--dry-run` prints it only) |
| `pnpm record-cast` | Record any command's output as an asciinema cast (`--out <file> -- <command>`) |
| `pnpm evidence` | Copy the take and `concurrency.json` to `evidence/video/<timestamp>/` with `MANIFEST.json` (`--publish` also uploads it to R2 and records each public URL); refuses a take where a secret scan finds an unredacted token |
| `pnpm test` / `pnpm typecheck` | Unit tests (timing, data validation, cast parser, narration tooling, seeder, capture tooling) / TypeScript |

`pnpm render` runs `scripts/check-no-placeholders.ts` first (in the script itself, and as
`prerender`) and stops, listing every problem, while:

- `public/clips` or `public/audio` holds generated placeholder media: any file matching
  `.placeholder-manifest.json` by content (wherever it was copied), a file carrying the marker
  `pnpm placeholders` burns in (WebM title `PLACEHOLDER`, PNG text chunk `Comment=PLACEHOLDER`,
  a cast titled `PLACEHOLDER…`), or silent narration audio;
- the proposal hashes (`media.json` `hashes`, `public/clips/hashes.json`) are missing or not
  real 64-hex hashes;
- a clip or screenshot `media.json` names has no cookie-mode `.marks.json` from `pnpm capture`
  and is not listed in `media.json` `manual` (hand-made files the owner vouches for), or a cast
  comes from a dry-run orchestrator (the same audit as `pnpm evidence`);
- the composition is shorter than 5 or longer than 10 minutes.

`pnpm render:preview` does not check, so the composition can be reviewed before capture.

`render:preview` does not use `--every-nth-frame`: Remotion supports that flag
for GIFs only, and with H.264 audio it fragments audio mixing into thousands of
temp files (over 17 GB, then "No space left on device").

## Seeding the demo project (one fresh project per take)

`scripts/seed-demo.ts` creates a fully configured "Demo Client / Customer Portal" on a
CommonForge Worker and writes `seed-output.json`
(`{ orgId, projectId, resourceIds: { website, api, requirements, brandAssets }, canonicalRemotes: { website, api, requirements }, editionId, clientUserId }`;
the remotes are plain URLs, no credentials) for capture and the demo agents.

**One owner identity.** The owner who seeds is the owner capture signs in as, so sign both
personas in first (see the [runbook](#capture-day-runbook), step 2) and seed with the same
`CAPTURE_OWNER_SESSION_FILE`; `--client-email` is the address the client persona signed in with.

```sh
export CAPTURE_BASE_URL=https://commonforge-worker.<subdomain>.workers.dev   # your deployment's app URL
export CAPTURE_OWNER_SESSION_FILE=~/cf-capture/owner/session.json   # from the runbook, step 2
source ../scripts/load-dev-vars.sh            # CF_API_TOKEN, CF_ACCOUNT_ID (values never printed)
pnpm seed -- --client-email you+client@example.com             # new org "Demo Client"
pnpm seed -- --plan --client-email you+client@example.com      # print the requests, send nothing
```

`--plan` runs the sequence against the scripted stand-in in `scripts/seed-demo-plan.ts` and prints
`<CF_ACCOUNT_ID>` in place of the account id. The unit tests use the same stand-in, so neither can
catch drift from the real API; only a live seed proves it.

Options: `--new-org <name>` (default `Demo Client`) or `--org <o-…>` to reuse an org;
`--project-name` (default `Customer Portal`); `--replace`; `--workers-subdomain <sub>` (derived from
a `*.workers.dev` base URL); `--video <file>`; `--out <file>`. `CAPTURE_BASE_URL` overrides the
session file's `apiUrl`.

What it does, in order (apps/worker/API.md; docs/plans/capture-briefing.md):

1. Checks the session (`GET /api/me`) and resolves the org.
2. Creates the `website`, `api` and `requirements` Artifacts resources. For each one, it mints a
   15-minute write token for the empty canonical repo with `CF_API_TOKEN`, pushes
   `fixtures/<name>` as committed at `HEAD` (tracked files only, one fresh commit), revokes the
   token and calls `adopt-head`. Uncommitted fixture edits are not pushed. A failed push still
   revokes the token; if that revoke fails too, it is logged and the push error is reported. A
   revoke that fails after a successful push is logged and the seed continues. Either way the
   token expires on its own after 15 minutes.
3. Creates the `brand-assets` R2 resource, the project and its four mounts.
4. Uploads `logo.png` and `brand-video.mp4` (~50 MB; generated once with
   `fixtures/brand-assets/scripts/make-video.sh` if missing, needs `ffmpeg`). The API has no owner
   upload route, so this uses the only asset write path: a task "Add brand assets" that writes
   `brand-assets` and has no reference mounts (`readMounts: []`), with a lease (stage, upload,
   commit, freeze), then an assets-only proposal that is integrated, approved by the
   owner and accepted. This needs the integration runner, and the change shows in the project's
   history. If staging, an upload, the commit or the freeze fails, the lease is released before
   the run stops. An integration attempt that expires while still queued (no runner took it) stops
   the run at once.
5. Creates or reuses the org's `orders` KV, then sends the whole policy in one `PUT`: the
   `quote-contract` check, the `quote` contract, rules, the preview recipe and the release recipe
   (Workers `cfapp-<orgId>-api` and `cfapp-<orgId>-website`).
6. Adds the client member (or reuses the address if it is already a client) with read grants on the
   project and all four resources.
7. Creates, builds and grants the client edition "Website pages (client edition)".

**Idempotent per project name.** If the project already exists (in `--org`, or in any org you own
named like `--new-org`), the seeder stops before writing anything. `--replace` seeds anyway.
With `--new-org` that means a new org of the same name, because projects and orgs cannot be
deleted. With `--org` the old project stays, and its release recipe is removed so the new project
can use the Worker names. An org allows only 5 release Workers, so **use a new org per take**
(`--new-org "Demo Client <take>"`).

**When a run fails** it stops at the failing call and prints what it left behind, for example
`partial: org=o-… project=p-… resources=res-…,res-…` (`none` where nothing exists), and writes the
same as JSON to `seed-output.partial.json` next to `--out` (with the brand assets task, proposal,
KV, client and edition ids it reached, whether it created the org, and the error). Nothing is
rolled back: projects and orgs cannot be deleted. Before retrying:

- Failed before the project existed (`project=none`): the org is left with only resources. A
  default run creates another org of the same name; pass a new `--new-org` name so takes stay
  apart.
- Failed after it (`project=p-…`): a rerun refuses until `--replace`. Seed a new org instead
  (`--new-org "Demo Client <take>"`), since `--replace` with `--new-org` also makes a new org.
- A brand assets task left behind has no lease; the Worker's GC cancels a `running` task after 7
  days without activity (API.md "Outbox, wakeups and GC"). It does not affect the next take.

## How the video is driven

- **Look.** Colours, shadows and fonts come from `src/theme.ts` only (components derive
  translucent variants with `alpha()`). Text is IBM Plex Sans, hashes and terminals IBM Plex
  Mono, loaded from Google Fonts by `src/fonts.ts` before the first frame; a render host
  without network falls back to system fonts with a warning instead of failing.
- **Brand assets.** `public/brand/commonforge-headerlogo-dark.png` (owner-supplied, 1200×220,
  for dark backgrounds; a copy of `brand/` at the repo root, keep them in sync) is the title
  card logo and the close card logo. `public/brand/commonforge-icon-512.png` (owner-supplied,
  512×512, the C-shaped mark alone; also a copy of `brand/`) is the small mark in every lower
  third, where the full logo would be illegible. Never recolour either; the wordmark mint is the
  theme accent (`#38F0D0`).
- **`narration.json`** lists the ten scenes in order. A scene lasts
  `max(durationSec, minDurationSec)`: `durationSec` is its narration audio length
  (measured, never typed) and `minDurationSec` an optional hand-set floor (default
  3 s for the title and close, none for the others) that `pnpm narration:build`
  keeps when it rebuilds the file. Narration starts at the scene start; the footage
  fills the rest. Scenes cross-fade over 12 frames, and each scene is padded by
  that overlap, so narration never overlaps and the total equals the summed scene
  lengths. **The competition allows 5–10 minutes**: `pnpm narration:build` prints
  every scene's length and the total and warns outside that range, and `pnpm render`
  refuses it. `words` (optional timestamps) drive captions; with no words the
  scene's `text` is shown as one caption.
- **`media.json`** maps each scene id to its footage. All paths are relative to
  `public/`. Every narrated scene needs an entry (`{}` when it has no footage).
  - `clip`: WebM/MP4 shown in a browser frame; `shots`: PNG screenshots;
    `casts`: asciinema v2 `.cast` files shown as terminal panes.
  - **Fitting real footage.** A clip is a path or
    `{ "src": …, "from": s, "to": s, "speed": n }` (source seconds; default the
    whole clip at the scene's `speed`); after `to` the last frame is held. A cast
    is a path or `{ "src": …, "from": s, "to": s, "speed": n, "maxIdleGapSec": s }`:
    output before `from` appears at once, output after `to` is dropped, and every
    silence longer than `maxIdleGapSec` is shortened to it (order and content kept).
    `pnpm check:fit` shows, per scene, what each pane plays and flags footage that
    runs out before its pane ends or marks outside the window.
  - `speed`: the scene's time-compression factor (default for its clips and casts).
    Any pane above 1×, or with idle gaps cut, shows an amber badge ("8× speed",
    "idle > 2 s cut") for its whole duration.
  - `callouts`: `{ t, x, y, w, h, label }`. `t` is seconds after the clip
    appears on screen (composition time, not source time); `x y w h` are 0–1
    fractions of the 16:9 media area. Scene 1 is the exception: intake has no
    screen, so its callouts sit on the intake terminal pane (fractions of the
    pane's text area, `t` from when the pane appears).
  - Terminal panes: scene 1 shows `cast-intake.cast` beside the project-tree
    clip; scene 4 stacks the three agent lanes (newest 8 rows each, wall-clock
    time of the shown output in each title bar, from the cast's `timestamp`);
    scene 8 stacks `casts[0]` (`cast-release.cast`, the restored version
    through the release gate) and `casts[1]` (`cast-08-bundle-verify.cast`).
    Placeholder casts carry a PLACEHOLDER badge from their first frame.
- Music bed: drop a file at `public/audio/bed.mp3` and it plays at gain 0.08,
  ducked by 6 dB while narration plays and faded out over the last 1.5 s
  (`src/lib/music.ts`). Without it, no bed is rendered.

## Swapping in real media

1. Copy captures into `public/clips/` and narration into `public/audio/` using
   the file names in `media.json` / `narration.json` (or edit those files to
   point at the new names). `pnpm placeholders` never overwrites existing files,
   so real media is safe once in place.
2. Run `pnpm narration:build` (see [Narration](#narration)) so `durationSec`
   and `words` come from the real audio.
3. Adjust callout `t` values in `media.json` to the real footage: each captured
   clip has a `<clip>.marks.json` beside it (seconds from the clip's start for each
   beat); a callout's `t` is `(mark - from) / speed` for the clip's window
   (`pnpm check:fit` prints it next to each mark).
4. Fit each clip and cast to its scene: `pnpm check:fit` lists what every pane
   plays; set `from` / `to` / `speed` (and `maxIdleGapSec` for casts) in
   `media.json` until it flags nothing.
5. Scenes 6 and 7 show the review codes (the web app's short code: the first 12
   hex characters in groups of four) from `public/clips/hashes.json`, which
   `pnpm capture --scenes 5,6` writes from the page's `data-hash`; there is
   nothing to copy by hand. `pnpm render` refuses while any placeholder clip,
   screenshot, cast, narration file or hash remains.

`public/clips/`, `public/audio/`, `out/` and `.env` are git-ignored. Raw
captures of the recorded run are kept in `evidence/video/`.

## Capture

All footage is captured from the running product; nothing is simulated. The
plan for every `media.json` file is in
[`scripts/capture/scenes.ts`](scripts/capture/scenes.ts) (`MEDIA_SOURCES`), and
every UI selector and on-screen text the capture relies on is in
[`scripts/selectors.json`](scripts/selectors.json). When the web UI changes,
update that file and rerun `pnpm capture:dry`.

| Source | Files |
|---|---|
| Browser (`pnpm capture`) | `clip-01` … `clip-08`, `shot-05-contract-fail.png`, `shot-07-client-view.png`, `shot-07-developer-view.png` |
| Orchestrator log (`pnpm capture:terminals`, `pnpm casts`) | `cast-04-agent-a/b/c.cast` (agent-1/2/3) |
| Terminal script (`pnpm record-cast`) | `cast-intake.cast` (scene 1), `cast-02-clone.cast` (scene 2), `cast-release.cast` and `cast-08-bundle-verify.cast` (scene 8) |
| Capture data (`pnpm capture`) | `hashes.json`: the failing (scene 5) and repaired (scene 6) proposals' hashes, read from the page |
| Owner, by hand | `shot-01-client-folder.png` (Finder screenshot of the hand-off folder); optionally a screen recording of the scene 3 edit in Cursor or Codex, shown before `clip-03` (media.json scene 3 `insert`; list it in `manual`) |

**How the browser capture works.** Each unit opens a 1920×1080 context at device
scale 2 (screenshots are 3840×2160), records video, and waits on visible UI
states with timeouts, never fixed sleeps; the app polls every 3 s and pauses
when the tab is hidden, so the recording tab is brought to the front. In cookie
mode each persona gets its own context with its `cfs_…` session injected as the
`__Host-cf_session` cookie and checked with `GET /api/me` (the persona must be
`owner` or `client` in the org); only the context that shows the scene records,
the other persona's preparatory clicks (building the preview, the client's
approval) happen in an unrecorded context. Scenes 2 and 3 are one unit: the
client's update session lives in the page, so it is recorded once and cut into
`clip-02` and `clip-03` with ffmpeg. Nothing reaches `public/clips/` unless its
whole unit succeeds, saving included: screenshots, cut clips and their marks
are staged in the work dir and moved together only once every one is ready (a
failed cut leaves the previous take untouched), and a failed unit leaves `.capture/live/<unit>.failed.webm` and
`<unit>.failure.png` for review. A rerun keeps the file it replaces (clip,
screenshot, marks) as `.capture/live/<name>.prev.<ext>`. Each clip's
`.marks.json` records `startedAtMs` (epoch ms of its first frame) to line it up
with `orchestrator.log`. The scene 4 lanes unit waits up to 45 minutes by
default. Tokens are never printed; casts mask CommonForge tokens, Artifacts
repository tokens (`art_v…`) and any `Authorization` header value.

**Cookie mode needs https.** The session cookie is `__Host-cf_session`, which
browsers only accept from a secure origin, so browser capture cannot rehearse
against the http local stack (`wrangler dev`); rehearse with `pnpm capture:dry`
(fixture build) and capture cookie mode against the deployed https Worker.

**Dry run.** `pnpm capture:dry` serves `../apps/web/dist-fixture` (build it from
the repo root with `pnpm install --frozen-lockfile --filter "@commonforge-org/web..."`
then `pnpm --filter @commonforge-org/web run build:fixture`; or set
`CAPTURE_FIXTURE_DIR`, or `CAPTURE_BASE_URL` to a running fixture server) and runs
every unit on the in-page demo story, switching persona with the banner's "View
as". It proves the selectors and the flow, not the backend: the fixture preview
link is not opened, and its clips go to `public/clips-dry/` (git-ignored, refused
by `pnpm evidence`). Cookie mode refuses to record a page that shows the fixture
banner.

### Capture day runbook

1. **Freeze.** Everything merged and deployed; the live demo app is at the
   previous version; record the commit you deployed. No deploys until the
   manifest is written.
2. **Sign in the personas** once each (5 magic links per address per 15 min). The
   owner address is the one that seeds and owns the demo org; the client address is
   the one you pass to the seeder as `--client-email`:

   ```sh
   export CAPTURE_BASE_URL=https://commonforge-worker.<subdomain>.workers.dev   # your deployment's app URL
   CFORGE_CONFIG_DIR=~/cf-capture/owner  cforge login --email you@example.com        --api-url "$CAPTURE_BASE_URL"
   CFORGE_CONFIG_DIR=~/cf-capture/client cforge login --email you+client@example.com --api-url "$CAPTURE_BASE_URL"
   export CAPTURE_OWNER_SESSION_FILE=~/cf-capture/owner/session.json
   export CAPTURE_CLIENT_SESSION_FILE=~/cf-capture/client/session.json
   ```
3. **Seed** a fresh project as that owner, with the same `CAPTURE_OWNER_SESSION_FILE`
   (see the seed section):
   `source ../scripts/load-dev-vars.sh && pnpm seed -- --new-org "Demo Client <take>" --client-email you+client@example.com`.
   It writes `seed-output.json`, which capture and the terminal scripts read for the org,
   project, edition and canonical remote (`CAPTURE_ORG` / `CAPTURE_PROJECT` override it).
4. **Scene 1.** `pnpm capture --scenes 1`. Intake has no screen, so the dry-run
   inventory is a terminal pane:
   `CAPTURE_INTAKE_DIR=~/client-handoff pnpm record-cast --out public/clips/cast-intake.cast -- bash scripts/terminal/intake.sh`
   (stops at the inventory; it never confirms). Take `shot-01-client-folder.png` by hand.
5. **Scenes 2–3.** `CAPTURE_EDITED_ZIP=~/Desktop/edited-copy.zip pnpm capture --scenes 2,3`.
   The client starts an update and the working copy is saved to
   `.capture/live/working-copy.zip`; capture then waits (up to
   `CAPTURE_LONG_TIMEOUT_MIN`, default 20) while you edit it in your own tool and
   save the edited ZIP at `CAPTURE_EDITED_ZIP`, then sends it back. Then record the
   clone pane as the client:
   `pnpm record-cast --out public/clips/cast-02-clone.cast -- bash scripts/terminal/clone.sh`
   (uses `CAPTURE_CLIENT_SESSION_FILE`; takes a read token from the client's edition session:
   cloning the canonical website repo, `seed-output.json` `canonicalRemotes.website`, is
   denied, cloning the edition works, `git log --oneline` shows one commit; the token goes to
   git through its environment only, and the script fails if the canonical clone succeeds or
   the edition has more than one commit). Optional: record your screen while editing and save
   it as e.g. `public/clips/clip-03-tool-insert.mov`, then set media.json scene 3
   `"insert": { "src": "clips/clip-03-tool-insert.mov", "from": …, "to": … }` and add it to
   `manual`.
6. **Scene 4.** In one terminal `pnpm capture --scenes 4` (it waits for agents);
   in a second, after `pnpm build` at the repo root, `pnpm capture:terminals`
   (one orchestrator, `--agents 1,2,3 --client-edition edition --gate api`; extra
   flags in `CAPTURE_DEMO_ARGS`). Then
   `pnpm casts --step-logs "$(jq -r .runDir public/clips/orchestrator-run.json)/logs"`
   (omit `--step-logs` for live lines only), then `pnpm align-lanes` so the agent
   panes show what the agents printed at the moment the lanes clip shows (it writes
   `castOffsetSec`: the cast time at the clip's first frame, from the clip's
   `startedAtMs` and the log's first stamp). Every attempt's log is kept.
   Rehearse with `pnpm capture:terminals --dry-run` (or `-- <command>`): it logs to
   `.capture/rehearsal/`, never `public/clips/`. `pnpm casts` stamps casts made from a
   `--dry-run` orchestrator's log `dryRun` (from `orchestrator-run.json` beside the
   log), and `pnpm evidence` refuses them.
7. **Scenes 5–7.** `pnpm capture --scenes 5,6,7`. The contract-failure proposal
   and its repair are found through the API (`CAPTURE_FAIL_PROPOSAL` /
   `CAPTURE_FIX_PROPOSAL` override). Scene 6 builds the preview as the developer
   if none is ready, then records the client opening it on the preview origin.
   Scene 7 approves as the client (unrecorded), then records accept, prepare,
   publish approval and publish until the release is live.
8. **Scene 8.** Accept the agents' asset change first if the restore should bring
   back the old logo, then `pnpm capture --scenes 8` (`CAPTURE_RESTORE`, default
   `website,brand`). The UI cannot publish a restored version, so record the
   release through the gate from a terminal:
   `pnpm record-cast --out public/clips/cast-release.cast -- bash scripts/terminal/release-after-restore.sh`,
   then `pnpm record-cast --out public/clips/cast-08-bundle-verify.cast -- bash scripts/terminal/bundle-verify.sh`.
9. **Review.** Watch every clip; check the `.marks.json` beats; set callout `t`
   values (scene 1's on the intake pane); `pnpm check:fit` must flag nothing;
   `pnpm narration:build --trim-silence` once the narration is final;
   `pnpm render:preview`, then `pnpm check:placeholders` must list nothing.
10. **Manifest.** `CAPTURE_BASE_URL=… WRANGLER="pnpm --dir ../apps/worker exec wrangler" pnpm evidence`
    (hand-made files listed in `media.json` `manual` are allowlisted; name any other with
    `--manual <file>`) copies `public/clips/` and the run's `concurrency.json` to
    `evidence/video/<timestamp>/` and writes `MANIFEST.json` (sha256 per file,
    capture times, git sha, the latest `commonforge-worker` deployment id when
    wrangler is logged in, `/health`; the Worker has no `/api/version`). The media
    under `evidence/video/*/clips/` is git-ignored; commit the manifest.
    It refuses, listing the files, a take that still holds placeholder media
    (recognised by content through `.placeholder-manifest.json`, even under
    `--manual`, and casts titled `PLACEHOLDER…`), any clip or screenshot without a
    cookie-mode `.marks.json` from `pnpm capture` (failed units, hand-made files
    not named with `--manual`), casts stamped `dryRun`, a dry-run orchestrator run,
    or fixture-mode footage; `--manual` names must be files in the take. Before anything is
    written or published, every cast, log and JSON in the take (and `concurrency.json`) goes
    through the same redaction as the casts; if that would change anything (a token or
    `Authorization` value escaped), it refuses, naming the files, never the secret.
    `--allow-unverified` writes an interim manifest with `verified: false` and those
    files listed (never for fixture footage, and never with `--publish`).
11. **Publish.** Add `--publish` to the same command (a verified take only) to upload every file of the
    take to the R2 bucket `commonforge-evidence` (CommonForge account) under
    `video/<timestamp>/` and record each file's public URL next to its sha256 in
    `MANIFEST.json`. The bucket must already exist with public read (an r2.dev URL
    or a custom domain); the command never creates or reconfigures it. Credentials
    go in `video/.env` (git-ignored) and are never printed:

    ```sh
    CF_ACCOUNT_ID=...
    CF_R2_ACCESS_KEY_ID=...        # R2 API token, Object Read & Write on the bucket
    CF_R2_SECRET_ACCESS_KEY=...
    CF_R2_PUBLIC_URL=https://...   # the bucket's public base URL
    ```

    R2 checks every upload against its sha256 and rejects a mismatch. If an upload
    fails, nothing is written locally; rerun for a new timestamped take. Commit
    `evidence/video/<timestamp>/MANIFEST.json` and `concurrency.json`; the media
    stays git-ignored locally and public in R2.

**What a judge can verify from `MANIFEST.json`.** Each `files[]` entry has the
path, size, capture time, sha256 and (published takes) a public `url`: download
it and compare `shasum -a 256` with the recorded hash to confirm the footage in
the video is the file that was captured. `verified: true` means no placeholder,
dry-run or unmarked media was in the take, and `manual` lists the hand-made files
the owner vouched for. `git.sha` is the app commit, `worker.latestDeploymentId`
the Worker deployment that served the capture, and `health` its `/health`
response at manifest time. `concurrency.json` (also hashed) is the orchestrator's
record of the three agents' overlapping `task.started` intervals.

Tuning: `CAPTURE_DWELL_SEC` (seconds each finished state stays on screen,
default 3 live, 0 dry), `CAPTURE_STEP_TIMEOUT_SEC` (default 30),
`CAPTURE_LONG_TIMEOUT_MIN` (integration, previews, releases, agents; default
20), `CAPTURE_HEADED=1` to watch, `CAPTURE_UPDATE_REQUEST` (the client's
request text).

## Narration

`narration.json` is generated; do not edit durations by hand. Scene text comes
from [docs/DEMO-SCRIPT.md](../docs/DEMO-SCRIPT.md): the thesis line (scene 0),
the **Say:** line(s) of each Timeline block (scenes 1–8, `0:00–0:45` → scene 1
… `7:15–8:00` → scene 8) and the **Close:** line (scene 9). A spaced em dash is
spoken as a comma. Edit the script, not `narration.json`, then rebuild.

**Owner voice.** Record one file per scene as `public/audio/scene-NN.<ext>`
(`m4a`, `mp3`, `wav`, `aac`, `ogg`, `opus` or `flac`; `scene-00` … `scene-09`),
then run `pnpm narration:build`. It measures every file with ffprobe, takes the
text from the script and writes `narration.json`; it fails naming the scene if
a file is missing. Audio is chosen by content, never by file date: when a scene
has several files, silent ones (the placeholders are pure silence, peak at or
below -80 dB) are ignored, and two or more non-silent files stop the build with
a list of them; delete or rename the extras (and their `.words.json`). A scene
left with only silent audio gets a `WARNING` per scene and in the summary; never
ship a final render with that warning (`pnpm render` refuses it). The recording's
length is the scene's length: `pnpm narration:build --trim-silence` cuts leading and
trailing silence (below -45 dB for at least 0.3 s) into copies under
`public/audio/trimmed/`, measures those, points `narration.json` at them and shifts
word timings by the cut lead. The originals are kept; silent placeholders are never
trimmed.

**Word timings.** Captions highlight words when a scene has timings and show
the scene's whole text otherwise (`words: []`). Timings live beside the audio in
`scene-NN.words.json`, tied to that exact file by a SHA-256 hash: re-record a
scene and its old timings are ignored. `pnpm narration:build --whisper` runs the
local `whisper` CLI (model `base.en`; set `WHISPER_MODEL`, or `WHISPER` for the
binary path) on scenes without valid timings and saves the result. Without the
CLI it prints a note and leaves `words: []`; the build still succeeds.

**ElevenLabs.** Put the key and voice in `video/.env` (git-ignored; never commit
it):

```sh
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
# optional; default eleven_multilingual_v2
# ELEVENLABS_MODEL_ID=eleven_multilingual_v2
```

`pnpm narration:elevenlabs` sends each scene's text to
`text-to-speech/{voice}/with-timestamps`, writes `public/audio/scene-NN.mp3` and
`scene-NN.words.json` (word timings from the character alignment), then runs the
same build. `--only 1,5` regenerates just those scenes (each call uses ElevenLabs
credits). It refuses to start without both variables and never prints the key.
The placeholder `.m4a` beside a new `.mp3` is silent, so the `.mp3` is used. To
switch a scene to the owner's voice later, remove or rename `scene-NN.mp3` and
`scene-NN.words.json`, add the recording and run `pnpm narration:build`.

After narration lengths change, existing placeholder clips keep their old
length; `pnpm placeholders --force` regenerates every file that is still a
placeholder. It recognises them by `.placeholder-manifest.json` or by the marker
burned into each one (WebM title `PLACEHOLDER`, PNG text chunk
`Comment=PLACEHOLDER`, cast title, hash text; silence for narration) and never
touches anything else: real clips, screenshots, casts and narration, and any file
beside a cookie-mode `.marks.json`, are always kept.
