---
name: marketing-scenes
description: Make or remake agor.live's product videos from choreographed fixture scenes (the /demo/marketing-video route in agor-ui), frame-captured and encoded into the site's video assets. Use for home-page and landing-page videos, carousel/showcase clips, booth loops, cursor-free cuts and the cursor troupe's tracks. For footage of the REAL app, use the demo-videos skill instead.
---

# Marketing scenes (fixture-driven video)

agor.live's product videos (hero loop, the board selector's clips, booth
loops) are not screen recordings. They're **scenes**: data files that drive
the real UI components on fixture data, at `/demo/marketing-video` in
agor-ui. Every motion (cursors, drags, typing, pans, overlays) is a pure
function of a virtual clock `t`, so capture is deterministic and frame-exact.

Pick this pipeline when the shot needs polish, loops, or choreography the
real app can't produce on cue. Pick the real-app pipeline (`demo-videos`
skill) when the point is "this is really happening" (live agent turns,
onboarding, real settings).

## Map

| Piece                            | Where                                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Scenes (choreography, data only) | `apps/agor-ui/src/pages/marketing/scenes/<name>.ts`                                                                                            |
| Keyframe/track engine            | `apps/agor-ui/src/pages/marketing/timeline.ts` (`path`, `clickPulses`, `typeText`, `constant`, `ActionKeyframe`)                               |
| Stage (samples the scene at `t`) | `apps/agor-ui/src/pages/marketing/MarketingVideoPage.tsx` (`SCENES` registry; exposes `window.__agorDemo = { setTime, getDuration, isReady }`) |
| Session / Slack stages           | `DemoSessionStage.tsx`, `DemoSlackStage.tsx` (a second exchange: `followUp`)                                                                   |
| Fixture data                     | `apps/agor-ui/src/pages/marketing/fixtureData.ts`                                                                                              |
| Capture (frames)                 | `apps/agor-docs/demo-videos/capture.mjs`                                                                                                       |
| Encode / publish                 | `apps/agor-docs/demo-videos/encode.sh`                                                                                                         |
| Site assets                      | `apps/agor-docs/public/videos/` (committed)                                                                                                    |
| Pipeline README                  | `apps/agor-docs/demo-videos/README.md`                                                                                                         |

## Workflow

1. **Start a clean agor-ui dev server on a scratch port.** Never trust
   whatever is already running:
   ```bash
   cd apps/agor-ui && nohup pnpm exec vite --port 5171 --strictPort > /tmp/vite-5171.log 2>&1 &
   curl -s http://localhost:5171/demo/marketing-video | grep -qi agor && echo ok
   ```
   Port 5173 is often an unrelated Vite app; 5180 can be `agor-installed`,
   a REAL daemon-connected instance whose private sessions have leaked into
   a frame before. This pipeline must never touch a daemon.
2. **Write or edit the scene** (copy a similar one). New scenes go in the
   `SCENES` map in `MarketingVideoPage.tsx`, in `SCENES` in `capture.mjs`
   (pick a Sandpack floor wait), and in the right list in `encode.sh`.
   Scene files that hard-code colors start with
   `// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette`.
3. **Iterate in the browser:** `http://localhost:5171/demo/marketing-video?scene=<name>&play=1`
   (wall-clock loop); scrub with `__agorDemo.setTime(ms)` in the console.
4. **Check composition with single frames** before a full capture:
   `node capture.mjs --base-url http://localhost:5171 --scene <name> --frame 120`, then Read the PNG.
5. **Capture:** `node capture.mjs --base-url http://localhost:5171 --scene <name>`
   (3840×2160 frames at 30fps into `frames/<name>/`). Add `--clean` for the
   cursor-free cut + cursor tracks (see below); `--dsf 1` for 1080p frames.
6. **Encode and publish:** `./encode.sh` (hero), `./encode.sh --showcase <name> [--publish]`
   (carousel clips at 1600×900, plus `-clean`, `-clean-540` and tracks when clean
   frames exist), or `./encode.sh --booth <name>` (1080p + 4K conference masters).
7. **Verify** (below), then commit the assets in `apps/agor-docs/public/videos/`.

## Site asset conventions

- Formats: h264 high, yuv420p, CFR 30, `+faststart`, muted (`-an`); every
  clip gets a `-poster.jpg`.
- Sizes: showcase clips 1600×900 at CRF 23 (warns past 2.5 MB); hero
  1080p plus `-720` and `-540`. Phones get the 540p rendition through a
  `<source media="(max-width: 720px)">`.
- **Pairs for the cursor troupe.** The home page's board selector plays
  the cursor-free cut (`showcase-<name>-clean[-540].mp4`) when the troupe is
  on, and the troupe performs the cursors from
  `showcase-<name>-cursors.json` (`{fps, frameCount, cursors: {id: {color,
frames: [[x, y, ripple] | null]}}}`, 0..1 of the frame; off-frame tips are
  kept). Other pages keep the with-cursor cut. If you change a board video,
  re-capture BOTH (`capture.mjs` plain and `--clean`) or the troupe drifts
  out of sync.
- Fixture cursors carry `data-demo-cursor`, `data-demo-color`,
  `data-demo-ripple` and a `[data-demo-cursor-tip]` marker; `?cursors=off`
  hides them. New cursor types must follow that contract for `--clean` to
  track them.
- When a clip's length changes, check the auto-advance in
  `apps/agor-docs/components/landing/BoardSelector.tsx` (videos advance on
  `ended`; stills use `STILL_MS`).

## Traps

- **`setTime` must move forward** within a pass: action keyframes fire
  once when crossed. Scrubbing backward needs a reload.
- **antd motion is off** on the stage (`token.motion = false`), so real
  component animations freeze, e.g. a RUNNING session's `<Spin>`. Fake it
  from the clock: one `ActionKeyframe` per output frame setting
  `.ant-spin-dot`'s `transform: rotate(...)` (see `scenes/multiAgentRace.ts`).
  Any new UI motion must come from the timeline, never CSS transitions.
- **Sandpack** artifact nodes need network (codesandbox bundler) and settle
  time; `isReady()` plus the per-scene floor wait cover it. Hide bundler
  timing behind a timeline-owned overlay rather than depending on it.
- **Disk:** 4K PNG frames are large; `--showcase` deletes each scene's
  frames after encoding it, `--booth` keeps them.

## Verify (don't eyeball-only)

- Read a few extracted frames (start, middle, the loop seam).
- **Loop seam:** for loop-perfect scenes the first and last frames must
  match: `ffmpeg -i clip.mp4 -vf "select=eq(n\,0)" a.png` versus the last
  frame, then a PIL `ImageChops.difference(a, b).getbbox()`.
- **Duplicate/dropped frames:** see the frame-diff recipe in the
  `demo-videos` skill.
- **Clean cut versus tracks:** frame counts must match
  (`ffprobe -count_frames`) and `frameCount` in the JSON.
