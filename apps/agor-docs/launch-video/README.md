# Agor launch video

The 40-second cinematic product tour for Agor — "Break out of the terminal" → the
warm board reveal → harnesses → multiplayer → a feature flash → team assistants → outro.

**▶ Watch:** https://www.youtube.com/watch?v=rNTp54zz5IE

Built with [HyperFrames](https://hyperframes.heygen.com) (HTML → MP4). The final render
lives on YouTube; this directory keeps the **source** so the video can be rebuilt or
remixed deterministically. Binaries (the mp3 and the mp4) are intentionally **not**
committed — see [What's here](#whats-here).

## What's here

| Path                                                     | Committed?    | Notes                                                                                            |
| -------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `composition/index.html`                                 | ✅            | The composition (timeline, layout, GSAP) — source of truth                                       |
| `composition/design.md`                                  | ✅            | Brand colors/fonts (mirrors agor.live)                                                           |
| `composition/assets/sfx/**`                              | ✅            | SFX actually used (CC0, Kenney.nl)                                                               |
| `composition/assets/music/cues/**`                       | ✅            | Beat/cue presets for the track                                                                   |
| `composition/assets/music/audio-data.js`                 | ✅            | Pre-extracted per-frame audio data (drives the audio-reactive glow) — so no re-extraction needed |
| `brag-plan.md`, `composition-brief.md`, `share-copy.txt` | ✅            | Plan, brief, and the social caption                                                              |
| `composition/assets/screenshots/**`, `assets/tools/**`   | ❌ gitignored | Copies of files already in `../public` — restored by `recreate-assets.sh`                        |
| `composition/assets/music/*.mp3`                         | ❌ gitignored | The track + baked 40s bed — see [Music](#music)                                                  |
| `brag.mp4`                                               | ❌ gitignored | Final render — on YouTube                                                                        |

## Recreate / re-render

```bash
cd apps/agor-docs/launch-video

# 1. Download the music track (one manual step — Pixabay blocks scripts):
#    https://pixabay.com/music/adventure-epic-478847/  →  save as
#    composition/assets/music/adventure-epic-478847.mp3

# 2. Restore gitignored assets (screenshots from ../public, harness logos, baked bed):
./recreate-assets.sh

# 3. Render:
cd composition
npx hyperframes render --output ../brag.mp4
```

Iterate live with `npx hyperframes preview`; validate with `npm run check`
(lint + WCAG contrast + layout inspect).

## Music

**"Adventure Epic" by Kornev** — sourced from Pixabay
(https://pixabay.com/music/adventure-epic-478847/). **Pixabay Content License**:
royalty-free, no attribution required. The video uses the track's natural 0–40s build,
baked to a 40s bed with a 0.08s fade-in + 1.2s fade-out (see `recreate-assets.sh`; the
beat map in `assets/music/cues/agor-epic-40s.*` is keyed to this bed).

If you swap the track, regenerate `audio-data.js` via the HyperFrames audio-reactive
workflow (`npx hyperframes skills`, then its `references/audio-reactive.md` extractor)
and re-detect cues with `npx hyperframes beats`.

## Assets

All screenshots come from the docs site (`apps/agor-docs/public/screenshots`,
`/images`, `/tools`) — the same images used on the landing page — so they stay in sync
and aren't duplicated in git. SFX are CC0 from Kenney.nl, bundled with the HyperFrames
skill.

## Copy

Hook line and headlines are pulled **verbatim from agor.live**
("Break out of the terminal.", "Meet your team of AI assistants.",
"Team command center for all things agentic."). See `share-copy.txt` for the social
caption.
