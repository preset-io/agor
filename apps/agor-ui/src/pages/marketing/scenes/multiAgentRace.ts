// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Scene — "multiAgentRace" (8s, loop-perfect, booth-loop candidate).
// Camera pushes in on the checkout-empty-state branch card, where the SAME
// prompt was fired at all four supported models — Claude, Codex, Gemini,
// OpenCode — as parallel sessions on one branch, all four `RUNNING`. A
// cursor arrives during the hold and points at two of the racing rows.
//
// MarketingVideoPage forces antd `token.motion = false` so captured frames
// are deterministic (a real CSS animation runs on the wall clock, which a
// frame-stepped Playwright capture can't follow — see MarketingVideoPage.tsx).
// That also freezes each session row's real <Spin> loading icon, which is
// exactly the "in progress" cue this scene is selling. So the spin is
// reproduced here as scene-authored motion instead: one action keyframe per
// output frame rotates each session row's `.ant-spin-dot` by hand, driven by
// the same virtual clock as everything else.
// Tune via /demo/marketing-video?scene=multiAgentRace&play=1

import {
  type ActionKeyframe,
  clickPulses,
  path,
  type SceneDefinition,
  Track,
  type ViewportState,
} from '../timeline';

const DURATION = 8_000;
const FPS = 30;
const RACE_BRANCH_ID = '019ee88d-demo-branch-0000-000000000106';
const SPIN_PERIOD_MS = 1_000;

// Pane is 1920×1016 (1080 viewport minus 64px header); its center is
// (960, 508) in pane space. viewport = paneCenter - flowFocus * zoom.
const PANE_CENTER = { x: 960, y: 508 };

const focusOn = (fx: number, fy: number, zoom: number): ViewportState => ({
  x: PANE_CENTER.x - fx * zoom,
  y: PANE_CENTER.y - fy * zoom,
  zoom,
});

// Wide establishing framing — the showcase videos' shared visual home base.
const WIDE: ViewportState = { x: 109, y: 0, zoom: 0.56 };

// checkout-empty-state sits in zone-teammates (flow origin 1580,650) at
// zone-relative (620,120) -> absolute (2200,770); a 420-wide card with a
// 4-session list runs tall, so bias the focus point toward its middle.
const RACE_FOCUS = focusOn(2450, 1050, 1.7);

// Card top-left ~(2200,770); row offsets calibrated against the same card
// structure used in genealogyTree.ts/teammateReveal.ts.
const REST: [number, number] = [2700, 650];
const ROW_CLAUDE: [number, number] = [2410, 935];
const ROW_GEMINI: [number, number] = [2410, 1055];

const rotateRaceSpinners = (ms: number) => {
  const angle = ((ms % SPIN_PERIOD_MS) / SPIN_PERIOD_MS) * 360;
  for (const dot of document.querySelectorAll<HTMLElement>(
    `[data-session-id^="${RACE_BRANCH_ID}"] .ant-spin-dot`
  )) {
    dot.style.transform = `rotate(${angle}deg)`;
  }
};

const spinActions: ActionKeyframe[] = Array.from(
  { length: Math.round((DURATION / 1000) * FPS) + 1 },
  (_, frame) => {
    const ms = (frame / FPS) * 1000;
    return { t: ms, run: () => rotateRaceSpinners(ms) };
  }
);

export const multiAgentRaceScene: SceneDefinition = {
  name: 'multiAgentRace',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: WIDE },
    { t: 1_200, v: WIDE, easing: 'hold' },
    { t: 2_600, v: RACE_FOCUS },
    { t: 6_400, v: RACE_FOCUS, easing: 'hold' },
    { t: 8_000, v: WIDE },
  ]),
  cursors: [
    {
      userIndex: 4,
      color: '#f472b6',
      pos: path([
        [0, ...REST],
        [2_600, ...REST, 'hold'],
        [3_200, ...ROW_CLAUDE],
        [3_500, ...ROW_CLAUDE, 'hold'],
        [4_300, ...ROW_GEMINI],
        [4_600, ...ROW_GEMINI, 'hold'],
        [6_400, ...REST],
        [8_000, REST[0], REST[1], 'hold'],
      ]),
      ripple: clickPulses([3_550, 4_650]),
    },
  ],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {},
  actions: spinActions,
};
