# Hyperframes Composition Brief: agor

## Objective

Create a short (~20s) launch-style brag video for **agor** — a premium product film
that breaks out of the terminal into Agor's signature warm-orange multiplayer canvas.

## Output

- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: ~20 seconds (scene plan sums to 20.0s)

## Source Material

- Project root: `/var/lib/agor/home/agorpg/.agor/worktrees/preset-io/agor/stage-marketing-screenshots`
- Primary files read: `apps/agor-docs/components/LandingPage.tsx`,
  `apps/agor-docs/components/LandingPage.module.css`, the live site agor.live
  (captured via Playwright), `context/messaging-and-positioning.md`, and the marketing
  screenshots in `apps/agor-docs/public/screenshots/`.
- Product name: agor
- Tagline / strongest claim: **Team command center for all things agentic.**
- The positioning one-liner (the hook): _One agent in a terminal is fine. Five agents
  across a team is chaos._
- Key UI / visual moment to recreate: the **warm-orange Agor board** (`board-hero.png`)
  emerging from a cold dark-teal terminal — the cool→warm contrast IS the visual hook.
- Real product screenshots to show (all under `apps/agor-docs/public/screenshots/`):
  - `board-hero.png` — the hero board (spatial canvas, zones, branch cards, AI-spend &
    burndown dashboards). The centerpiece.
  - `marketing/agor-marketing-facepile-tooltip.png` — the live facepile (emoji avatars + "+7").
  - `marketing/agor-marketing-cursor-indicator.png` — the orange "Mina" live cursor.
  - `marketing/agor-marketing-social-comment-context.png` — a board comment thread on an
    active branch card ("Can we keep the facepile capped but still show the +7 overflow?").
  - `marketing/agor-marketing-slack-thread.png` — an agent pinged in Slack
    ("@DatAgor can you help me debug the Airflow job that failed this AM?").
  - Harness logos in `apps/agor-docs/public/tools/`: `claude-code.png`, `codex.png`,
    `gemini.png`, `copilot.png`, `opencode.png`.
- Copy that must appear verbatim:
  - `one agent in a terminal is fine.`
  - `five across a team? chaos.`
  - `Meet your team of AI assistants.`
  - `Live cursors. Comments. Presence.`
  - `Pick the best harness per session.`
  - `Reach them from Slack, GitHub, anywhere.`
  - `Team command center for all things agentic.`
  - `open source · agor.live`

## Creative Direction

- Tone preset: app-store
- Creative direction: a premium product film — "break out of the terminal into a living,
  multiplayer canvas," with one warm cinematic swell on the board reveal.
- Interpretation: clean, confident reveals with generous holds. Motion energy comes from
  snappy entrances and one big perspective sweep, not clutter. Restraint everywhere except
  the single reveal swell. Hold every readable line long enough to read it.
- Angle: Everyone runs agents alone in a terminal. Agor breaks them onto one warm, living
  canvas the whole team sees at once. Show the things a terminal can never do — live
  multiplayer presence, every harness side by side, and agents reachable from Slack.
- Hook: a lone terminal prompt on the dark-teal agor.live background; line 1 types
  "one agent in a terminal is fine.", then "five across a team? chaos." snaps in.
- Outro / punchline: dark-teal canvas + constellation resolve; agor wordmark + tagline
  "Team command center for all things agentic." and "open source · agor.live". One logo hit.
- Avoid:
  - Generic SaaS language ("streamline your workflow", "supercharge", "10x")
  - Abstract filler visuals / particle systems / equalizer bars
  - Unrelated visual redesign — match agor.live exactly (see Visual Identity + design.md)

## Visual Identity

**A `design.md` is provided in `brag-output/composition/` — it is the source of truth.
Use its exact values.** Summary:

- Background: dark teal-navy gradient `#05070b → #09111d → #070b12`, with faint teal radial
  glows (top-left `rgba(46,154,146,0.22)`, top-right `rgba(35,136,242,0.16)`).
- Signature motif: thin teal **constellation/network lines** connecting small dots,
  drifting slowly — the agor.live parallax background. Use subtly behind the text scenes
  (hook + outro). Render with a seeded PRNG (deterministic) — do NOT use Math.random().
- Accent (teal): `#7fe8df`; deep teal `#2e9a92`; mint `#d9fb89`.
- Reveal/warm: amber→orange board gradient (≈ `#f0a23a → #e8731f`) — the hero contrast color.
- Cursor/label orange: `#e8731f`.
- Text: `#f8fafc`; muted `#aeb9c8`.
- Display font: heavy system sans (Inter / system-ui), weight 800–900, very tight tracking
  (~-0.05em) — mirrors agor.live's headline. Body: same family, regular.
- Primary button look (for outro silhouette, optional): pill `border-radius: 999px`,
  `linear-gradient(135deg, #2e9a92, #7fe8df)`, dark text `#031311`.

## Storyboard

Use the storyboard in `brag-output/brag-plan.md` as the creative contract. Scene summary:

1. **Terminal hook** — 3.5s — type "one agent in a terminal is fine.", then snap
   "five across a team? chaos." on the dark-teal + constellation bg. Cold, cramped.
2. **The reveal** — 4.5s — terminal cracks; `board-hero.png` sweeps in with a slight 3D
   tilt (cool→warm); headline "Meet your team of AI assistants." slams down. Hold the board.
3. **Multiplayer presence** — 4.5s — facepile avatars pop in one by one; the orange Mina
   cursor glides across; the board-comment popover pops. Caption "Live cursors. Comments.
   Presence." Use the three `marketing/*presence/cursor/facepile/comment*` screenshots.
4. **Every harness, anywhere** — 4.5s — harness logos (Claude Code, Codex, Gemini, Copilot,
   OpenCode) arrive one by one → caption "Pick the best harness per session."; then the
   Slack thread card slides in → caption "Reach them from Slack, GitHub, anywhere."
5. **Outro / logo** — 3.0s — dark-teal canvas + constellation; agor wordmark + tagline
   - "open source · agor.live". One clean logo hit.

## Audio

- Audio role: warm, clean business-product bed with one cinematic swell on the reveal.
- Audio arc: quiet/filtered under the terminal hook → swell into the board reveal →
  steady & confident through multiplayer / harness / Slack → soft resolve + gentle fade
  under the logo.
- Music: `happy-beats-business-moves-vol-1-by-ende-dot-app.mp3` (~120.19 BPM). Bundled.
  Copied into `assets/music/`. Bed volume 0.32–0.38, never above 0.5.
- Music treatment: start 0:00 low; open up on the reveal; gentle ~0.6s fade-out at the end.
- Music cue guidance: bundled preset at `assets/music/cues/<stem>.music-cues.json` (copied in).
  ~120.19 BPM; beat grid begins ~3.02s (beats ~0.5s apart); strong cues cluster 16.0–23.5s.
  - Lock the **board reveal** (scene 2) to a beat near ~4.0s (3.52 / 4.02). `// beat-locked`
  - Snap sequential facepile pops (scene 3) and harness-logo pops (scene 4) to consecutive
    beats (~0.5s apart — fine for icons, not text). `// beat-grid`
  - Optionally lock the Slack-card / logo landing to a strong cue (17.02 / 18.52 / 20.02).
  - Hold every readable text line to its reading floor regardless of beats.
- Audio-reactive treatment: subtle — use music RMS/bass to make the board glow and the
  constellation presence breathe gently on the reveal. NO waveform/equalizer visuals,
  no strobing, no text scaling. Follow the hyperframes `references/audio-reactive.md`
  workflow to extract per-frame data and wire ONE visual element. If extraction is
  unavailable (no helper / ffmpeg), document it and skip — do not block the render.
- Audio-coupled moments:
  - Scene 1 typing — randomized `keyboard/keypress-*.wav` per character; soft low tone as
    line 2 snaps in.
  - Scene 2 reveal sweep — one soft whoosh + low bell (e.g. `impact/impactSoft_medium_*`
    or `impact/impactBell_heavy_000`), aligned to the reveal beat.
  - Scene 3 facepile — a soft pop per avatar (e.g. `interface/drop_*`); light tick on the
    comment popover.
  - Scene 4 logos — a pop per logo; a subtle notification chime (e.g. `impactPlate_light`)
    as the Slack card lands.
  - Scene 5 logo — one clean accent (e.g. `impactBell_heavy_000`) at the wordmark landing.
- SFX selection guidance: app-store energy — a consistent light layer at 0.65–0.75 volume.
  Match sound to motion; accent first/last/strongest items in sequences rather than every one
  if it gets busy. Keep it premium, never hype.
- SFX analysis guidance: read `~/.claude/skills/brag/assets/sfx/sfx-analysis.md` before
  choosing files; prefer low/medium high-frequency-risk files for repeated/polished moments.
- Exact SFX choice: Hyperframes chooses filenames, timestamps, density, and volume based on
  the implemented animation. Copy chosen SFX into `assets/sfx/...` (relative paths only).
- Audio files: music + cue preset already copied to `assets/music/`. Copy any selected SFX
  into `brag-output/composition/assets/sfx/<family>/`.

## Hyperframes Instructions

Use the installed HyperFrames skills under `.agents/skills/` (hyperframes, hyperframes-core,
hyperframes-animation, hyperframes-media, hyperframes-creative, hyperframes-cli) and the
`npx hyperframes` CLI. Prefer native HyperFrames conventions over anything in `/brag`.

Requirements:

- Read `design.md` first — it is the brand source of truth. Use its exact colors/fonts.
- Always-read references before authoring: `references/video-composition.md`,
  `references/beat-direction.md`, `references/typography.md`, `references/motion-principles.md`,
  `references/transitions.md`. For the music reaction: `references/audio-reactive.md`.
- Show real product UI: scenes 2–4 are built from the real screenshots listed above.
- Use transitions between every scene; entrance animations on every element; no exit
  animations except the final scene (per the skill's non-negotiable transition rules).
- Deterministic only — seeded PRNG for the constellation; NO Math.random()/Date.now().
- Keep all text readable in the final render; hold readable lines to their floor.
- Keep total duration 15–25s (~20s target).
- Lint + validate (contrast) must pass; run inspect and fix or justify overflows.
- Use local relative asset paths only (never absolute `/...` paths in the HTML).
- Render to `brag-output/brag.mp4` (1920x1080).
