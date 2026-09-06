// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Scene — "leaderboard" (8s, loop-perfect, booth-loop candidate).
// Camera pushes in on the Agent leaderboard artifact — a real Sandpack app
// published to the board (same mechanism as the existing burndown/cost-
// tracker artifacts), ranking models by tasks completed this week. A cursor
// arrives and points down the ranked rows as the camera settles (the
// artifact renders in a cross-origin Sandpack iframe, so this is a visual
// point-and-read gesture, not a click that changes anything inside it).
// Tune via /demo/marketing-video?scene=leaderboard&play=1

import { clickPulses, path, type SceneDefinition, Track, type ViewportState } from '../timeline';

const DURATION = 8_000;

const PANE_CENTER = { x: 960, y: 508 };
const focusOn = (fx: number, fy: number, zoom: number): ViewportState => ({
  x: PANE_CENTER.x - fx * zoom,
  y: PANE_CENTER.y - fy * zoom,
  zoom,
});

const WIDE: ViewportState = { x: 109, y: 0, zoom: 0.56 };
// app-leaderboard sits at absolute (2520,80), 620x495.
const ARTIFACT_FOCUS = focusOn(2830, 330, 1.5);

// Row positions calibrated against the artifact's actual layout.
const REST: [number, number] = [3100, 200];
const ROW_CLAUDE: [number, number] = [2563, 205];
const ROW_CODEX: [number, number] = [2563, 263];

export const leaderboardScene: SceneDefinition = {
  name: 'leaderboard',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: WIDE },
    { t: 1_200, v: WIDE, easing: 'hold' },
    { t: 2_600, v: ARTIFACT_FOCUS },
    { t: 6_400, v: ARTIFACT_FOCUS, easing: 'hold' },
    { t: 8_000, v: WIDE },
  ]),
  cursors: [
    {
      userIndex: 2,
      color: '#fb923c',
      pos: path([
        [0, ...REST],
        [2_600, ...REST, 'hold'],
        [3_200, ...ROW_CLAUDE],
        [3_500, ...ROW_CLAUDE, 'hold'],
        [4_300, ...ROW_CODEX],
        [4_600, ...ROW_CODEX, 'hold'],
        [6_400, ...REST],
        [8_000, REST[0], REST[1], 'hold'],
      ]),
      ripple: clickPulses([3_550]),
    },
  ],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {},
  actions: [],
};
