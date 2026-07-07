// Scene 2 — "creating an artifact" (4s, zoomed single-player).
// The cost-cockpit app node starts covered by a "Generating artifact…"
// overlay; a wipe reveals the live Sandpack chart beneath. Sandpack is fully
// settled before capture starts, so the reveal is 100% timeline-owned.
// Tune via /demo/marketing-video?scene=artifact&play=1

import { clickPulses, type SceneDefinition, Track } from '../timeline';

const DURATION = 4_000;

// Framing the app-usage-cockpit node: flow rect (620,80) 780×495,
// center ≈ (1010, 327). Pane center is (960, 508).
const VIEW_START = { x: -202, y: 132, zoom: 1.15 };
const VIEW_END = { x: -302, y: 99, zoom: 1.25 };

export const artifactScene: SceneDefinition = {
  name: 'artifact',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: VIEW_START },
    { t: DURATION, v: VIEW_END, easing: 'linear' },
  ]),
  cursors: [],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    // 0 = fully covered, 1 = fully revealed (top→bottom wipe).
    overlayReveal: new Track([
      { t: 0, v: 0 },
      { t: 2_200, v: 0, easing: 'hold' },
      { t: 3_200, v: 1 },
    ]),
    // 0 = "Generating artifact…", 1 = "Rendering…" (badge copy phase).
    badgePhase: new Track([
      { t: 0, v: 0 },
      { t: 1_400, v: 1, easing: 'hold' },
    ]),
    // Drives the shimmer sweep across the cover (cycles = value % 1).
    shimmer: new Track([
      { t: 0, v: 0 },
      { t: 3_200, v: 3, easing: 'linear' },
    ]),
    successPulse: clickPulses([3_250]),
    // Screen-space pointer (px in the 1920×1080 page).
    pointerVisible: new Track([{ t: 0, v: 1 }]),
    pointerX: new Track([
      { t: 0, v: 1_980 },
      { t: 1_500, v: 1_250 },
      { t: 2_800, v: 1_080 },
      { t: 3_600, v: 1_010 },
    ]),
    pointerY: new Track([
      { t: 0, v: 860 },
      { t: 1_500, v: 540 },
      { t: 2_800, v: 430 },
      { t: 3_600, v: 500 },
    ]),
    pointerRipple: clickPulses([2_100]),
  },
  actions: [],
};
