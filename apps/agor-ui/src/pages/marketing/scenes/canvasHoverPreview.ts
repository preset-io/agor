// Scene — "canvasHoverPreview" (8s, loop-perfect, booth-loop candidate).
// The "zoom-out canvas" idea all three submitted batches independently
// pitched (batch 1 #4, batch 2 #02, batch 3 #1), built with the one
// differentiating detail batch 3 #1 added that the others didn't: hovering
// a card pops a small live-looking preview instead of just panning past it.
// Camera holds the same WIDE establishing shot every other scene opens on;
// the fake pointer visits two different cards, each popping a tooltip.
// Tune via /demo/marketing-video?scene=canvasHoverPreview&play=1

import { clickPulses, type SceneDefinition, Track } from '../timeline';

const DURATION = 8_000;
const WIDE = { x: 109, y: 0, zoom: 0.56 };

// Screen-space card positions at WIDE zoom (calibrated against other
// scenes' wide-shot captures): landing-hero-polish's header sits around
// (250,505); checkout-empty-state's around (1413,511).
const CARD1: [number, number] = [250, 505];
const CARD2: [number, number] = [1413, 511];
const TOOLTIP_OFFSET = { x: 40, y: -10 };

export const canvasHoverPreviewScene: SceneDefinition = {
  name: 'canvasHoverPreview',
  durationMs: DURATION,
  viewport: new Track([{ t: 0, v: WIDE }]),
  cursors: [],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    pointerVisible: new Track([{ t: 0, v: 1 }]),
    pointerX: new Track([
      { t: 0, v: 960 },
      { t: 800, v: CARD1[0] },
      { t: 1_600, v: CARD1[0], easing: 'hold' },
      { t: 3_200, v: CARD1[0], easing: 'hold' },
      { t: 4_000, v: CARD2[0] },
      { t: 4_000 + 800, v: CARD2[0], easing: 'hold' },
      { t: 6_000, v: CARD2[0], easing: 'hold' },
      { t: 7_000, v: 960 },
    ]),
    pointerY: new Track([
      { t: 0, v: 700 },
      { t: 800, v: CARD1[1] },
      { t: 1_600, v: CARD1[1], easing: 'hold' },
      { t: 3_200, v: CARD1[1], easing: 'hold' },
      { t: 4_000, v: CARD2[1] },
      { t: 4_000 + 800, v: CARD2[1], easing: 'hold' },
      { t: 6_000, v: CARD2[1], easing: 'hold' },
      { t: 7_000, v: 700 },
    ]),
    pointerRipple: clickPulses([820]),
    hoverPreviewVisible: new Track([
      { t: 0, v: 0 },
      { t: 1_600, v: 0, easing: 'hold' },
      { t: 1_650, v: 1, easing: 'hold' },
      { t: 3_150, v: 1, easing: 'hold' },
      { t: 3_200, v: 0, easing: 'hold' },
      { t: 4_800, v: 0, easing: 'hold' },
      { t: 4_850, v: 1, easing: 'hold' },
      { t: 5_950, v: 1, easing: 'hold' },
      { t: 6_000, v: 0, easing: 'hold' },
    ]),
    hoverPreviewX: new Track([
      { t: 0, v: CARD1[0] + TOOLTIP_OFFSET.x },
      { t: 4_000, v: CARD2[0] + TOOLTIP_OFFSET.x, easing: 'hold' },
    ]),
    hoverPreviewY: new Track([
      { t: 0, v: CARD1[1] + TOOLTIP_OFFSET.y },
      { t: 4_000, v: CARD2[1] + TOOLTIP_OFFSET.y, easing: 'hold' },
    ]),
  },
  textTracks: {
    hoverPreviewLine1: new Track([
      { t: 0, v: '+ hero.css        +12 -3' },
      { t: 4_000, v: '+ EmptyCart.tsx   +48 -0', easing: 'hold' },
    ]),
    hoverPreviewLine2: new Track([
      { t: 0, v: 'M App.tsx          building…' },
      { t: 4_000, v: 'M checkout.ts      4 sessions active', easing: 'hold' },
    ]),
  },
  actions: [],
};
