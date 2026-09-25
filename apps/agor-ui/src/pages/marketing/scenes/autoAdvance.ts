// Scene — "autoAdvance" (8s, loop-perfect, booth-loop candidate).
// docs-freshness-check glides from Ship into Review on its own — no cursor,
// no drag. The board moves itself when the work is done. Same
// nodePlacements rel<->abs flip mechanic as zoneDrop.ts, just without a
// cursor driving it (the differentiating detail two of three submitted
// batches independently pitched for the kanban idea).
// Tune via /demo/marketing-video?scene=autoAdvance&play=1

import { type SceneDefinition, Track, type ViewportState } from '../timeline';

const DURATION = 8_000;

const PANE_CENTER = { x: 960, y: 508 };
const focusOn = (fx: number, fy: number, zoom: number): ViewportState => ({
  x: PANE_CENTER.x - fx * zoom,
  y: PANE_CENTER.y - fy * zoom,
  zoom,
});

const WIDE: ViewportState = { x: 109, y: 0, zoom: 0.56 };
// Wide enough to hold both the Ship source and the Review destination in
// frame for the glide itself.
const GLIDE_FOCUS = focusOn(700, 1780, 0.62);
// docs-freshness-check lands at zone-review (80,1300) -> absolute
// (900,1950); push in tight once it's settled.
const LANDED_FOCUS = focusOn(1110, 2120, 1.3);

const OBJECT_ID = 'board-object-019ee88d-demo-branch-0000-000000000108';
const HOME_REL = { x: 70, y: 950 };
const HOME_ABS = { x: 130, y: 1600 };
const DROP_REL = { x: 80, y: 1300 };
const DROP_ABS = { x: 900, y: 1950 };

export const autoAdvanceScene: SceneDefinition = {
  name: 'autoAdvance',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: WIDE },
    { t: 1_200, v: WIDE, easing: 'hold' },
    { t: 2_600, v: GLIDE_FOCUS },
    { t: 4_600, v: GLIDE_FOCUS, easing: 'hold' },
    { t: 6_000, v: LANDED_FOCUS },
    { t: 7_600, v: LANDED_FOCUS, easing: 'hold' },
    { t: 8_000, v: WIDE },
  ]),
  cursors: [],
  nodePlacements: [
    {
      objectId: OBJECT_ID,
      pos: new Track([
        { t: 0, v: HOME_REL },
        { t: 3_600, v: HOME_REL, easing: 'hold' },
        { t: 3_650, v: HOME_ABS },
        { t: 4_500, v: DROP_ABS, easing: 'easeInOut' },
        { t: 4_550, v: DROP_REL, easing: 'hold' },
        { t: 7_950, v: DROP_REL, easing: 'hold' },
        { t: 8_000, v: HOME_REL, easing: 'hold' },
      ]),
      zoneId: new Track<string | null>([
        { t: 0, v: 'zone-ship' },
        { t: 3_650, v: null, easing: 'hold' },
        { t: 4_550, v: 'zone-review', easing: 'hold' },
        { t: 8_000, v: 'zone-ship', easing: 'hold' },
      ]),
    },
  ],
  commentTexts: [],
  uiFlags: {},
  actions: [],
};
