# Brag Plan: agor (v2 — 40s cinematic product tour)

## What is this app?

Agor is a multiplayer, Figma-like spatial canvas where a whole team runs their AI coding
agents — Claude Code, Codex, Gemini, and long-lived assistants — side by side on isolated
git branches, with live cursors, comments, and presence. The team command center for all
things agentic.

## The angle

A premium, cinematic product tour that **follows the agor.live flow**: break out of the
terminal → meet your team of AI assistants on the warm canvas → the harnesses you already
use → multiplayer presence → a flash tour of the product surfaces → raise team assistants →
tagline. Cool dark-teal everywhere, one warm orange board moment, scored to an epic
adventure build that peaks right as we land the "team assistants" beat.

## Hook (first 2-3 seconds)

A lone terminal on the dark-teal agor.live background (soft music intro). A command types,
then the line resolves to the site's own provocation: **"Break out of the terminal."**

## Tone

- Preset: app-store → leaning **cinematic** (the epic track earns it).
- Creative direction: premium product film; bigger, slower-breathing motion; one warm
  reveal swell; dramatic but never cluttered. Restraint everywhere except the reveal + the
  music-peak feature beat.
- Interpretation: hold readable lines to their floor; energy comes from the board sweep,
  beat-synced montage, and confident transitions — not flashing text.

## Format: landscape — 1920x1080

## Duration: 40.0s

## Music (chosen by user)

- Track: `assets/music/agor-epic-40s.mp3` — "Adventure Epic" (Kornev, Pixabay, royalty-free,
  no attribution required). 40s bed = the track's natural 0–40s build, 0.08s fade-in +
  1.2s fade-out baked in. ~120.19 BPM.
- Source track also kept at `assets/music/adventure-epic-478847.mp3`.
- Cue preset (bed-relative): `assets/music/cues/agor-epic-40s.music-cues.json`.
- Arc: soft intro under the terminal (0–5s) → first lift at **5.39s** = board reveal →
  rising energy through harnesses/multiplayer/montage → build peak at **29.4 & 32.7s**
  (intensity 0.94) = last feature + "team assistants" beat → outro hit **38.05s** → fade.
- Bed volume 0.32–0.38. Cinematic SFX (deeper hits), sparse and motion-matched.
- Audio-reactive: subtle — board glow + constellation breathe with RMS/bass on the reveal.
  Regenerate per-frame audio data from the 40s bed (delete the stale 20s `audio-data.*`).

## Beat map (lock these)

- **Board reveal headline → 5.39s** (strong lift, intensity 0.87). `// beat-locked`
- Feature montage cards (5) snap to consecutive strong cues: ~18.72 / 21.39 / 24.06 /
  26.70 / 29.38s. `// beat-grid`
- "Team assistants" beat lands on **32.71s** (intensity 0.94 — the build's peak).
- Outro wordmark lands on **38.05s**; music fades 38.8→40.0s.
- Harness logos + facepile pops may snap to the ~0.5s beat grid (icons, not text).

## Storyboard (7 scenes = 40.0s)

### Scene 1 — Terminal hook — 0.0→5.0s (5.0s)

Dark-teal bg (`#05070b`→`#09111d`) + subtle deterministic teal constellation lines (seeded
PRNG). Minimal monospace terminal: a command types (e.g. `agor ▸ run agent…`) then the line
resolves/types to **"Break out of the terminal."** Cold, single, cramped. Soft music intro.
Audio: key ticks (randomized `keyboard/keypress-*`); low cinematic tone as the line settles.
Transition: the terminal cracks/dissolves → Scene 2 (dramatic).

### Scene 2 — Board reveal — 5.0→10.0s (5.0s)

On the **5.39s lift**, the terminal cracks and the warm-orange board
`assets/screenshots/board-hero.png` sweeps in near-fullscreen with a cinematic 3D tilt
(cool→warm). Headline slams down (heavy white, weight 800–900, tracking -0.05em):
**"Meet your team of AI assistants."** Hold on the board.
Audio: whoosh + deep bell/impact on the lift; board glow breathes with RMS.
Transition: push-in → Scene 3.

### Scene 3 — Harnesses — 10.0→14.0s (4.0s)

Dark canvas. Eyebrow "Built on the harnesses you already use." Logos arrive one by one:
`assets/tools/claude-code.png`, `codex.png`, `gemini.png`, `copilot.png`, `opencode.png`.
Caption: **"Pick the best harness per session. No lock-in."**
Audio: a pop per logo (beat grid). Transition: clean wipe → Scene 4.

### Scene 4 — Multiplayer presence — 14.0→18.5s (4.5s)

Eyebrow "Multiplayer by default." Composite over a dimmed board: facepile avatars
(`marketing/agor-marketing-facepile-tooltip.png`) popping in one by one; the orange Mina
cursor (`marketing/agor-marketing-cursor-indicator.png`) gliding; the board comment popover
(`marketing/agor-marketing-social-comment-context.png`) popping. Caption:
**"Live cursors. Comments. Presence."**
Audio: soft pop per avatar; light tick on the comment. Transition: wipe → Scene 5.

### Scene 5 — Feature flash montage — 18.5→31.5s (13.0s)

Section title beat "So much more than a chat box." Then 5 surfaces flash, each ~2.6s
(label + screenshot), snapped to strong cues (18.72 / 21.39 / 24.06 / 26.70 / 29.38s):

1. **Rich agent sessions** — "Every tool call, fork & handoff" — `conversation_full_page.png`
2. **Shared knowledge base** — "Shared memory for humans + agents" — `knowledge-hero.png`
3. **Live artifacts** — "Dashboards & tools, rendered on the board" — `artifacts-hero.png`
4. **Scheduler** — "Standups, audits & digests on a cadence" — `scheduler-modal.png`
5. **MCP-native** — "Anything you can do, an agent can do too" — `mcp_environment.png`
   Each card holds past its reading floor (label ≥0.8s settled). Hard-but-smooth cuts.
   Audio: a cinematic tick/hit per card on its cue. Transition: → Scene 6.

### Scene 6 — Raise team assistants — 31.5→36.0s (4.5s)

Lands on the **32.71s build peak**. Eyebrow "The shared workspace." `assistants-list.png`
presents, headline: **"Raise team assistants — memory, skills, a place to work."** Then a
sub-beat: the Slack thread `marketing/agor-marketing-slack-thread.png` slides in with
**"Reach them from Slack, GitHub, anywhere."** (message gateway).
Audio: the music peak carries it; a soft notification chime as the Slack card lands.
Transition: soft → Scene 7.

### Scene 7 — Outro / logo — 36.0→40.0s (4.0s)

Back to dark-teal + settling constellation. The `agor` wordmark (heavy display, teal "o"
glyph) resolves on the **38.05s** hit, with tagline **"Team command center for all things
agentic."** and **"open source · agor.live"**. One clean bell; music fades 38.8→40.0s.
This is the only scene that may fade elements out.

**Audio summary:** A soft epic intro under the terminal blooms into a warm cinematic swell
on the board reveal, rises through harnesses/multiplayer/feature-flash, peaks on the "team
assistants" beat (32.7s), and resolves on the wordmark with a clean fade.
