---
name: demo-videos
description: Build, record, verify, and stitch the Agor demo-video syllabus (apps/agor-docs/demo-videos/e2e) — the from-zero E2E suite whose lessons are simultaneously regression tests, training snippets, and the conference sizzle reel.
---

# Demo-video syllabus workflow

The suite at `apps/agor-docs/demo-videos/e2e/` drives a REAL daemon + UI from
an empty workspace. Every lesson in `tests/flow/` is three things at once: a
regression test, a training-ready video snippet, and reel footage. Read this
before touching any of it; it encodes several days of hard-won debugging.

## Architecture map

- `support/harness.ts` — global setup/teardown. Scratch DB + git home in
  `.e2e-runtime/` (wiped per run), ports 3131/5199/8899 (daemon/UI/cassette
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
  `.e2e-runtime/trim-marks.jsonl` for the stitcher.
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
