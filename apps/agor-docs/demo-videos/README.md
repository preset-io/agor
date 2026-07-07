# Demo videos

Reproducible pipeline that renders the choreographed demo fixture at
`/demo/marketing-video` (agor-ui) into short, loopable hero videos for
agor.live. Sibling of `../launch-video/`; binaries are gitignored, the final
compressed assets are committed to `../public/videos/`.

The **static screenshot** pipeline is separate and untouched — see
`context/marketing/screenshots/README.md` and `/demo/marketing-screenshots`.

## How it works

All motion on the video route — cursors, card drags, typed comments, viewport
pans, overlays, modal — is a pure function of a virtual clock `t`
(see `apps/agor-ui/src/pages/marketing/`):

- `timeline.ts` — keyframe/track engine + `ActionRunner` (one-shot DOM clicks)
- `scenes/{multiplayer,artifact,settings}.ts` — the choreography (data only)
- `MarketingVideoPage.tsx` — fork of the screenshot fixture that samples the
  scene at `t` and exposes `window.__agorDemo = { setTime, getDuration, isReady }`

`capture.mjs` never interacts in real time: it steps `setTime(frame / fps)`,
waits a triple-rAF settle, and screenshots at `deviceScaleFactor: 2`
(3840×2160 frames). `encode.sh` assembles per-scene mp4s and stitches the
scenes into one sequential loop with fade-through-dark joins.

Scene 1 (`multiplayer`) is loop-perfect on its own: every track returns to its
t=0 value at 8s, so `multiplayer.mp4` can be looped standalone.

## Contracts & gotchas

- `setTime` must be called **monotonically** within a pass — action keyframes
  (real DOM clicks in the settings scene) fire once when crossed and don't
  rewind. Scrubbing backward requires a page reload.
- Sandpack app nodes need network access (codesandbox bundler) and settle
  time; capture waits for `isReady()` plus a per-scene floor wait before
  frame 0. The artifact scene hides Sandpack timing behind a timeline-owned
  reveal overlay, so determinism never depends on the bundler.
- The video page sets antd `token.motion: false` — if you add UI to a scene,
  drive its motion from the timeline, not CSS transitions.

## Commands

```bash
# One-time setup (standalone install; NOT part of the pnpm workspace)
cd apps/agor-docs/demo-videos
npm install
npx playwright install chromium

# Terminal 1: UI dev server
pnpm --filter agor-ui dev        # vite on :5173

# Terminal 2: capture + encode
node capture.mjs                 # all scenes  (--scene <name> for one)
./encode.sh                      # per-scene mp4s + agor-hero.mp4 + poster
./encode.sh --publish            # copy final assets into ../public/videos/
```

Debugging:

```bash
node capture.mjs --scene multiplayer --frame 120   # single 4K frame
# Browser preview (wall-clock loop of the same timeline):
open "http://localhost:5173/demo/marketing-video?scene=multiplayer&play=1"
# Scrub from the console:
#   __agorDemo.setTime(4000)
```

## Adding a scene

1. Create `apps/agor-ui/src/pages/marketing/scenes/<name>.ts` exporting a
   `SceneDefinition` (copy an existing scene for the shape).
2. Register it in the `SCENES` map in `MarketingVideoPage.tsx`.
3. Add it to `SCENES` in `capture.mjs` (pick a Sandpack floor wait) and to the
   `SCENES` array in `encode.sh`.
4. Iterate with `?scene=<name>&play=1`, then capture single frames to check
   composition before a full run.

## Output

| File                       | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `out/<scene>.mp4`          | 1080p per-scene cut (CRF 21, faststart, muted)               |
| `out/<scene>-4k.mp4`       | 4K master (CRF 18)                                           |
| `out/agor-hero.mp4`        | All scenes stitched with 0.25s fades — loop this in the hero |
| `out/agor-hero-poster.jpg` | Poster frame for the `<video>` element                       |

Embed shape (hero div, reduced-motion fallback to the static screenshot):

```html
<video autoplay muted loop playsinline poster="/videos/agor-hero-poster.jpg">
  <source src="/videos/agor-hero.mp4" type="video/mp4" />
</video>
```
