---
name: demo-videos
description: Record footage of the REAL Agor app (daemon + UI) with Playwright at human pace — standalone clips (npm run clip) with seeded state, multiple signed-in people and live cursors, and scripted zoom/pan, tutorial/how-to snippets, and the from-zero syllabus and its reel — in apps/agor-docs/demo-videos/e2e. Use for any real-app video; for choreographed fixture videos use marketing-scenes (start at agor-video if unsure).
---

# Real-app video capture

The suite at `apps/agor-docs/demo-videos/e2e/` drives a REAL daemon + UI in
an isolated scratch workspace and records it with Playwright. It has two
Playwright projects:

- **`flow`** (`tests/flow/`, metadata in `support/syllabus.ts`): the
  syllabus, one chained story from an empty workspace. Each lesson is a
  regression test, a training snippet, and reel footage, and running it
  leaves behind the checkpoint ladder clips start from.
- **`clips`** (`tests/clips/`, metadata in `support/clips.ts`): standalone
  shots. Each starts from a seeded state, films one moment (with as many
  signed-in people as it needs), and is exported on its own with scripted
  zooms. **New footage almost always goes here.**

Read this before touching any of it; it encodes several days of hard-won
debugging.

## Making a clip (the usual job)

Clips are written against the **studio** (`support/studio.ts`): cast
members as actors, a virtual camera, and a seeded world. Copy
`tests/clips/two-cursors.spec.ts` (multiplayer) or `board-tour.spec.ts`.

1. **Pick or write a seed** (`support/seeds.ts`): the state the clip opens
   on, built off camera through the daemon's REST API by `support/seeder.ts`
   (cast accounts, AI connection, repos, boards with zones, real git
   branches placed in zones, committed files, sessions, real agent turns,
   notes, comment threads with replies and reactions). Seeds stack with
   `extends`, and each is cached as a checkpoint keyed by a hash of its
   code, so editing one rebuilds only it and what stacks on it.
   `npm run seed -- --list` / `npm run seed -- <name> [--rebuild]`.
   A clip can instead start `{ after: '<clip>' }` (where another clip
   ended; it's recorded first if needed), `{ checkpoint }`, or `'empty'`.
2. **Register it** in `support/clips.ts`: id, title, purpose, `start`,
   `agent`, `layout` (`single`, or `split` for two filmed actors side by
   side), beat-sheet `script`, `outputs` (`master` always; `site` for
   agor.live renditions; `tv` for a 4K30 Roku master).
3. **Write `tests/clips/<id>.spec.ts`** with `clip('<id>', async ({ studio }) => ...)`:
   - `studio.actor('sam', { filmed: true })`, `studio.actor('ada')`: each is a
     separate signed-in browser. Unfilmed actors keep their live cursor on
     everyone's screen (Agor hides an idle remote cursor after 5s).
   - `actor.open(path)`, then `await studio.action()` when everyone is on
     screen: the clip starts there (boot screens are cut).
   - Actor verbs: `click`, `type`, `glideTo`, `spotlight`, `move`, `drag`,
     `dragTo` (fractions of the target, so it holds at any board zoom),
     `press`, `beat`, `settle`, `hold`, `act(page => ...)` for raw steps.
     Locators: `card(branch)`, `node(text)`, `remoteCursor(castKey)`.
   - Camera: `actor.camera.focus(locator | locators[] | rect, { zoom, ms, ease })`
     and `camera.wide()`. It waits for the move by default, so the action
     follows the push-in. Eases: `smooth` (default), `spring`, `linear`.
   - `studio.world.board('main').path`, `.branch(name)`, `.session(name)`:
     what the seed built, by name. `studio.mark(label)` drops a cut point.
4. **Record + export:** `npm run clip -- <id>`. Records at 4K (true 2x
   pixels, so zooms up to 2x stay sharp in the 1080p master), then renders
   to `~/Desktop/agor_video/clips/<id>/`. Flags: `--export-only`
   (re-render the last take), `--live` (record agent turns), `--1080`,
   `--reseed`, `--no-open`.
5. **Tune without re-shooting:** the take's `timeline.jsonl` (in
   `~/Desktop/agor_video/takes/<id>/`) holds every camera
   move with its time, target rect, zoom, length and ease. Edit it and
   `--export-only`. The export warns when a resting cursor falls outside
   the camera's frame or an explicit zoom exceeds what the source holds.
6. **Verify** with the recipes below, then commit the spec, registry entry
   and any seed. For site use, copy the renditions into
   `apps/agor-docs/public/videos/` (formats in the `agor-video` skill).

### How the camera and sync work

- Filmed actors are recorded by `support/recorder.ts`, not Playwright's
  recorder: Chromium's screencast frames (JPEG, true 4K) are written to
  `<take>/<actor>-frames/` with the wall time each was painted, and nothing
  is encoded until export. Playwright's recorder encodes VP8 in real time
  and falls minutes behind on long 4K takes. Frames only arrive when the
  screen changes, so still stretches cost nothing; motion captures at
  60-70 fps. Sync is exact from the timestamps (older webm takes still
  render via their magenta sync flash).
- Clips launch Chromium's **new headless mode** (`channel: 'chromium'` in
  `playwright.config.ts`). The default headless shell delivered only ~13
  fps of 4K frames on the real app; new headless delivers 60+.
- `scripts/lib/render.ts` applies the camera with ffmpeg's `perspective`
  filter (per-frame corner expressions, cubic sampling: sub-pixel smooth
  pans, unlike `crop`/`zoompan`), as a balanced `if()` tree over the
  frame counter. About real time at 4K. No other dependencies.
- Clicks by filmed actors draw a soft ring (cursor ripple) at capture.
- The board's side panel starts collapsed (`actor(..., { sidePanel: 'open' })`
  to keep it); other localStorage UI prefs can be added the same way in
  `Studio.actor`.

## Teammate Q&A clips and fictional companies

- `support/seeds/orbitly.ts`: **Orbitly**, a fictional B2B SaaS (field-service
  scheduling). Engineering board with branches named for Jira tickets
  (`issue_url`, `pull_request_url`), sessions by their owners, and three
  teammates: **DataBot** (dbt project + DuckDB warehouse cloned into its
  branch), **EngBot** (reads the board and PRs), **LegalBot** (playbook in its
  branch; the contract is attached on camera).
- `support/seeds/donut-ops.ts`: the Donut Shop with **OpsBot** and the
  shop's real demo history in a local DuckDB.
- A teammate is `Seeder.teammate()`: a branch of the framework repo with
  `custom_context.teammate`, its persona written into `IDENTITY.md`/`USER.md`,
  `ONBOARDING.md` removed. The persona is where to steer what the answer
  looks like.
- `support/scenes.ts` `askTeammate()`: open the seeded empty session,
  optionally attach a file, type, send, wait for the real turn over REST,
  hold. Marks `question`, `sent`, `answered`.
- Outputs include `raw`: `<id>-raw.mp4` (native 4K, no camera) plus
  `<id>-marks.json`, for editing elsewhere.

**Fixtures** (`fixtures/`, committed):

- `repos/<name>/` become real git repos with a local bare "GitHub" remote
  (`localRepo()`; `url.<bare>.insteadOf` keeps the github.com URL working
  offline).
- `bin/gh` is a GitHub CLI stand-in. The harness copies it into the scratch
  workspace and puts it first on the daemon's PATH, so agents can open and
  list PRs without touching real GitHub. Its data is
  `<scratch>/fake-github/<owner>__<repo>.json`, seeded by `fakeGithub()`.
- `data/orbitly/build.sql` generates the SaaS warehouse deterministically
  (hash-based "randomness") ending today. `data/donut-shop/` is a Parquet
  export of the DonutShop MotherDuck database; `buildDonutShopWarehouse()`
  drops stray post-history orders and shifts every date so the last full day
  of trade is yesterday.
- `docs/*.html` render to PDFs with `scripts/build-fixture-docs.ts`.

**Time and clocks:** everything runs in `DEMO_TIMEZONE` (default
`America/Los_Angeles`, `AGOR_E2E_TIMEZONE` overrides): the daemon, agents'
tools, the browser and the seeded data, so takes look the same wherever
they're recorded. Seed checkpoints include today's date in their cache key
and rebuild once a day, so relative dates never go stale. A replayed answer
keeps the wording of the day it was captured; recapture with `--live` when
that matters.

**Agent turns:** seeded accounts hold a placeholder credential; in live mode
the cassette proxy swaps in the real `CLAUDE_CODE_OAUTH_TOKEN` on the way
upstream, so a real token never lands in the scratch DB or checkpoints.
Replay streams each answer at its recorded pace (`AGOR_E2E_REPLAY_SPEED`
scales it). The proxy gives up on an upstream request after 90 s of
silence so a network drop doesn't hang a take, and `npm run clip` runs
under `caffeinate` (closing the lid still sleeps the Mac).

## Architecture map

- `support/harness.ts` — global setup/teardown. Scratch DB + git home in
  `~/.agor-e2e/runtime` (wiped per run), ports 3131/5199/8899 (daemon/UI/cassette
  proxy). Dev-admin bootstrap (admin@agor.live/admin) via three env gates.
  Login is REST-minted into Playwright storageState — never on camera.
  Demo repos mirrored once into `.e2e-cache/`, fresh clones cut per run.
  The teammate framework repo is pre-registered by slug so the wizard's
  auto-clone never fires. Exports `BOARD_PATH` (the wizard-created board).
- `support/pacing.ts` — the ONLY way lessons interact: `pacedMove` (eased,
  slightly arced, 28ms/step — never `mouse.move({steps})`, which fires all
  steps back-to-back and records as a slideshow), `glideAndClick`, `glideTo`,
  `spotlight` (hover + dwell, for pointing at options), `typeInto`,
  `beat`/`settle`, and `openLesson(page, urlPath, lessonId)` which waits out
  loading screens and writes per-lesson trim marks to
  `~/.agor-e2e/runtime/trim-marks.jsonl` for the stitcher.
- `support/cassette-proxy.ts` — records/replays Anthropic traffic.
  `AGOR_E2E_AGENT_MODE=live` records real (metered!) turns into
  `cassettes/flow.json` (committed; auth headers redacted); `replay` plays
  them back offline. Replay matches per-(method+path) in recorded order, so
  lesson order matters and a live run re-records ALL agent lessons at once.
- `support/syllabus.ts` — canonical lesson metadata (id, number, title,
  tagline, status, script, notes). `npm run syllabus:md` regenerates
  SYLLABUS.md; the stitcher renders titles from the same data.
- `scripts/stitch-reel.ts` — `npm run reel`. Animated 4K30 logo intro
  (`../animated_agor_logo/agor_logo_reveal_4k.mp4`, duration probed fresh),
  lower-third titles (Space Grotesk from `.e2e-cache/reel-assets/`),
  fade-through-black xfades, per-lesson head trims from the trim marks.
  Output: 4K30 h264 high@5.1 crf17 + silent AAC (Roku USB players refuse
  audio-less files), faststart mp4. `AGOR_E2E_REEL_RES=1080`,
  `AGOR_E2E_REEL_FPS=NN` to override; fps changes NEVER affect playback
  speed (frames duplicate, timestamps rule).
- Capture quality: `setupHarness` idempotently patches playwright-core's
  bundle (JPEG screencast q80→95, VP8 1M→12M, 25→30fps). A reinstall just
  gets repatched on the next run. If Playwright is upgraded and the stock
  strings change, the patch warns and degrades gracefully — fix the
  constants in harness.ts.

## Harness facts that changed after the syllabus (Oct 2026)

- The harness builds the daemon's workspace packages and the executor
  through turbo before starting (`pnpm turbo run build
--filter=@agor/daemon^... --filter=@agor/executor...`): ~6 min cold, seconds
  when cached. `AGOR_E2E_SKIP_BUILD=1` skips it.
- The daemon refuses to start without `daemon.deployment_id`, `jwtSecret`
  and `masterSecret`; the harness writes fresh ones into the scratch
  `config.yaml` (and adds them to older checkpoints).
- Restored checkpoints are migrated to the current schema on every run, so
  old snapshots still boot.
- macOS has no `timeout`; run long suites in the background instead.
- Biome skips `demo-videos/e2e/` in repo-wide runs but checks files passed
  explicitly (`npx biome check --write <files>`, which the commit hook
  does). There's no tsconfig; typecheck with the root `tsc` and
  `--ignoreConfig --allowImportingTsExtensions --module nodenext
--moduleResolution nodenext --strict --skipLibCheck <files>`.
- **Timezone bug, fixed in #3069:** on SQLite Agor read `CURRENT_TIMESTAMP`
  as local time, so outside UTC every executor heartbeat was off by the
  host's offset (east of UTC: agent turns killed as `heartbeat_lost` within
  seconds). If turns die instantly with a huge `approx_heartbeat_age_ms`,
  check that fix is in the branch.
- **4K needs `--force-device-scale-factor=2`** (set in
  `playwright.config.ts` when `AGOR_E2E_VIDEO=4k`). Without it, Chromium's
  screencast drops to CSS-pixel frames after the first navigation and a
  "4K" video is a 1080p picture in the top-left quarter of a grey frame
  (Chromium 151). Recordings made with `--4k` before Oct 2026 have this.
- Checkpoints copy the database with SQLite's online backup (`sqlite3
.backup`), so snapshots taken while the daemon runs are consistent.
- Seeding facts: board edit rights for members come from the board's
  `others` policy (the seeder sets editor + collaborator; branch
  capabilities must include `terminal.open` when filesystem access isn't
  `none`). `onboarding_completed` can only be set by the user on their own
  row after creation. Creating a branch is async (`filesystem_status`
  `creating` → `ready`). REST can't write a finished transcript (tasks are
  executor-owned); use `prompt()` for a real turn, or copy
  `packages/core/src/seed/demo-fixtures.ts` for DB-level transcripts.

## Iron rules

1. **Timing fixes happen in Playwright, never in ffmpeg.** No framerate
   games on the video side; the capture must be genuinely smooth.
2. **Nothing robo-fast.** Every click glides, every payoff settles. Secrets
   are pasted (with breaths around the paste); everything else types at
   45ms/char.
3. **Lessons start where the activity starts.** Board lessons open
   `BOARD_PATH` directly. `openLesson` handles loading screens + trim marks;
   always pass the lessonId.
4. **Live runs cost real money.** `test:live` re-records every agent lesson.
   Before burning one, smoke the structure free: run ungated lessons with no
   `AGOR_E2E_AGENT_MODE` (gated specs skip), or accept that replay feeds
   stale responses to NEW agent lessons (structure validates, content lies).
5. **Never touch the user's real `~/.agor`.** The harness is fully isolated;
   keep it that way. Secrets live in `.e2e-secrets/secrets.env` (0600,
   gitignored) — never print values, never commit.
6. **Any workaround you write is a finding.** If a lesson needs a workaround
   for product behavior, add it to `ONBOARDING_FINDINGS.md` (see the
   `onboarding-findings` skill) in the same sitting.

## Adding a lesson (checklist)

1. Recon exact selectors from `apps/agor-ui/src/` first (an Explore agent
   works well). This app has ~no testids: use visible text, aria-labels,
   `data-session-id`, `data-panel-id`, `.react-flow__node`, Ant classes.
   Verify captions in code, don't guess (e.g. the Create dialog's teammate
   button is exactly "Create AI teammate").
2. Write `tests/flow/NN-kebab-id.spec.ts` using only pacing verbs. Gate
   agent lessons with `resolveAgentMode()`+`test.skip`. Depend only on
   state earlier lessons created (alphabetical order = run order).
3. Add the syllabus entry (status `planned` → `done` when recorded), then
   `npm run syllabus:md`.
4. Smoke structurally (free), then `npm run test:replay` (full 8+) or
   `test:live` when new agent turns are needed.
5. `npm run reel`; verify (below); copy reel + clips to
   `~/Desktop/agor_video/syllabus/` and open for Evan; commit (biome first).

## Verification recipes (do these, don't eyeball-only)

- **Smoothness / duplicated frames**: extract frames
  (`ffmpeg -i clip.webm -vf fps=30,scale=480:270 f%04d.png`), then PIL
  `ImageChops.difference(prev, cur).getbbox()` per pair — `None` means a
  duplicated frame. Use getbbox (any pixel), NOT mean-diff thresholds —
  cursor-only motion has near-zero mean and will misread as static.
- **Lesson opening frames**: compute each lesson's reel offset (intro
  duration + cumulative trimmed durations − fades), extract a frame ~1.2s
  in, and Read it — must show real UI, never "Loading workspace data…".
- **Scroll/teleport check**: per-pair mean-diff timeline; an instant jump
  is one isolated big spike, a smooth scroll is a run of moderate values.

## Known traps (each cost a recording run)

- **Stale daemon on 3131**: an aborted run's daemon keeps serving OLD state
  while the new one dies on EADDRINUSE (and Agor's daemon logs FATAL but
  keeps running). `setupHarness` reaps the suite's ports now; if lessons
  fail bizarrely (wizard missing, repo already registered), suspect this
  first and check `.e2e-runtime/daemon.log`.
- **Save order in agent settings**: base URL must be saved BEFORE the
  token or the verification probe hits api.anthropic.com.
- **Password policy**: 15-char minimum for created users.
- **SVG `<title>` is not queryable-as-visible** and `getByTitle` only
  matches title _attributes_ — assert on rendered text (e.g. the presence
  cursor's name chip), not svg titles.
- **Second browser contexts** (`browser.newContext()`) do NOT inherit
  config `use` options — no video recorded unless you pass `recordVideo`.
  That's desirable: the lesson's footage stays the main page's POV.
- **Background children must log to file descriptors** (`logFd`), never
  pipes through the setup process — parent exit → EPIPE storm → wedged
  daemon at 100% CPU.
- Codex CLI ignores `OPENAI_BASE_URL` → Codex lessons are live-only.

## Recording targets

Roku TV via USB stick: mp4, h264 high profile, yuv420p, CFR, faststart,
WITH an audio track (silent AAC). Final reel: 4K30. Capture 4K via
`AGOR_E2E_VIDEO=4k` (deviceScaleFactor 2) — verify smoothness with the
frame-diff recipe before committing to a full 4K run; fall back to 1080p
capture + the stitcher's lanczos upscale if 4K capture janks.
