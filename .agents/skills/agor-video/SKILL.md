---
name: agor-video
description: Start here for any Agor video work (product clips, tutorial or how-to snippets, home-page or landing-page videos, booth loops, sizzle reels). Picks the right capture pipeline, lists the shared rules and delivery formats, and hands off to the marketing-scenes or demo-videos skill.
---

# Agor video: which pipeline?

There are two ways to make Agor footage. Pick one per shot, then load its
skill.

|               | **Marketing scenes** (`marketing-scenes` skill)                                                                 | **Real-app capture** (`demo-videos` skill)                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| What it films | Real UI components on fixture data, choreographed on a virtual clock                                            | The real daemon + UI from an empty or checkpointed workspace, driven by Playwright with human pacing                 |
| Best for      | Polished, loopable site videos; things the app can't do on cue (six cursors, perfect timing, impossible states) | Proof that it really works: multiplayer with real accounts and live cursors, agent turns, how-tos; scripted zoom/pan |
| Determinism   | Frame-exact (stepped clock)                                                                                     | Real time; agent turns recorded once and replayed from a cassette                                                    |
| Cost          | Free                                                                                                            | Free on replay; live agent turns cost real API money                                                                 |
| Lives in      | `apps/agor-ui/src/pages/marketing/` + `apps/agor-docs/demo-videos/`                                             | `apps/agor-docs/demo-videos/e2e/`                                                                                    |
| Output        | `apps/agor-docs/public/videos/` (site)                                                                          | `~/Desktop/agor_video/` (clips, reels), then site if wanted                                                          |

Rules of thumb:

- If the shot must loop seamlessly or show something staged, use scenes.
- If a viewer should be able to repeat it in their own Agor, use real-app
  capture.
- Home-page product videos have been scenes so far (they need loops, the
  cursor troupe's cursor-free cuts and cursor tracks). Real-app clips can
  replace them when authenticity matters more than polish; they still need
  the site renditions below.

## Editing clips together

Trailer, sizzle-reel and website edits are Remotion compositions in
`apps/agor-docs/demo-videos/remotion/`, built from the real-app clips'
raw cuts and marks. Load the `agor-reel` skill (brand look, camera framing,
review loop, Evan's motion notes). Remotion's official agent skills install locally there
(`npx skills add remotion-dev/skills`). Remotion's license is free for
individuals only: a company license is needed before others use it.

## Shared rules

1. **Never film private data.** Real-app capture runs against its own
   scratch workspace (`~/.agor-e2e/`), never Evan's `~/.agor`. Scene capture
   runs against a fresh agor-ui dev server on a scratch port, never a
   daemon-connected instance (port 5180 can be `agor-installed` with real
   sessions; 5173 is often an unrelated app).
2. **Motion is fixed at capture, not in ffmpeg.** No speed ramps or frame
   tricks to hide jank; fix the timeline or the pacing.
3. **Human pace.** Cursors glide on arcs, payoffs get a beat, typing is
   human speed. Nothing robo-fast.
4. **Verify frames, don't just watch.** Extract frames and Read them;
   use the frame-diff recipes (in `demo-videos`) for smoothness and seams.
5. **Secrets** live in `apps/agor-docs/demo-videos/e2e/.e2e-secrets/secrets.env`
   (0600, gitignored). Never print or commit them.
6. **Copy follows Messaging & Positioning** (Agor team Knowledge base,
   `marketing/messaging-and-positioning`): Multiplayer AI first; no
   em-dashes in on-screen text; "Agor Community Edition", never "open source".

## Delivery formats

| Target               | Spec                                                                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site video           | h264 high, yuv420p, CFR 30, `+faststart`, muted (`-an`), poster JPG. Showcase 1600×900 CRF 23 (keep under ~2.5 MB); hero 1080p plus `-720` and `-540` renditions; phones get 540p via `<source media="(max-width: 720px)">`. |
| Cursor-troupe pair   | Also a cursor-free cut (`-clean`, `-clean-540`) and a `-cursors.json` track (scenes: `capture.mjs --clean`).                                                                                                                 |
| Conference TV / Roku | mp4, h264 high, yuv420p, CFR, faststart, WITH a silent AAC track (Roku refuses audio-less files). 4K30 masters.                                                                                                              |
| Hand-off to Evan     | `~/Desktop/agor_video/<project>/`, then `open` the folder.                                                                                                                                                                   |

## Where things are

- `~/Desktop/agor_video/`: earlier deliverables (syllabus clips and reel,
  showcase and hero masters, booth loops, raw recordings).
- `apps/agor-docs/demo-videos/animated_agor_logo/`: the animated logo
  reveal used as reel intros.
- `apps/agor-docs/public/videos/`: everything the site serves.
