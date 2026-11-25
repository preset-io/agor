// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Scene — "scheduleFiring" (9.5s, loop-perfect, booth-loop candidate).
// Camera pushes in on docs-freshness-check, whose "Scheduled Runs" section
// (BranchSessionSections' dedicated cron list — anything with
// `scheduled_from_branch: true`) is showing tonight's crawl mid-run. A
// cursor arrives and points at the scheduled row, then the REAL ScheduleTab
// (BranchModal/tabs/ScheduleTab.tsx) opens over the board — the actual
// cron config: name, humanized schedule, cron expression, next/last run,
// enabled toggle — and a real "Run now" click plays out its real
// loading-then-success sequence. See DemoScheduleStage.tsx / demoSchedule*.ts.
//
// Same frozen-<Spin> fix as the other RUNNING-session scenes (see
// multiAgentRace.ts) — the running scheduled session's spinner is
// scene-authored motion, scoped to this branch. (BranchSessionSections.tsx
// was also fixed to actually put `data-session-id` on the scheduled-runs
// row — it was missing, which is why this selector previously matched
// nothing.)
// Tune via /demo/marketing-video?scene=scheduleFiring&play=1

import {
  type ActionKeyframe,
  clickPulses,
  path,
  type SceneDefinition,
  Track,
  type ViewportState,
} from '../timeline';

const DURATION = 9_500;
const FPS = 30;
const BRANCH_ID = '019ee88d-demo-branch-0000-000000000108';
const SPIN_PERIOD_MS = 1_000;

const PANE_CENTER = { x: 960, y: 508 };
const focusOn = (fx: number, fy: number, zoom: number): ViewportState => ({
  x: PANE_CENTER.x - fx * zoom,
  y: PANE_CENTER.y - fy * zoom,
  zoom,
});

const WIDE: ViewportState = { x: 109, y: 0, zoom: 0.56 };
// zone-ship spans (60,650)-(740,1730); docs-freshness-check sits at
// zone-relative (70,950) -> absolute (130,1600), well below the other two
// zone-ship cards.
const CARD_FOCUS = focusOn(340, 1780, 1.5);

// Row offsets calibrated against this card's actual layout (card top-left
// ~(130,1600); "Scheduled Runs" is the second section, below Sessions).
const REST: [number, number] = [600, 1700];
const ROW_SCHEDULED: [number, number] = [200, 1928];

const rotateSpinner = (ms: number) => {
  const angle = ((ms % SPIN_PERIOD_MS) / SPIN_PERIOD_MS) * 360;
  for (const dot of document.querySelectorAll<HTMLElement>(
    `[data-session-id^="${BRANCH_ID}"] .ant-spin-dot`
  )) {
    dot.style.transform = `rotate(${angle}deg)`;
  }
};

const spinActions: ActionKeyframe[] = Array.from(
  { length: Math.round((DURATION / 1000) * FPS) + 1 },
  (_, frame) => {
    const ms = (frame / FPS) * 1000;
    return { t: ms, run: () => rotateSpinner(ms) };
  }
);

const RUN_NOW_LABEL = 'Run schedule Nightly docs freshness crawl now';
const clickRunNow = () => {
  document.querySelector<HTMLButtonElement>(`[aria-label="${RUN_NOW_LABEL}"]`)?.click();
};

export const scheduleFiringScene: SceneDefinition = {
  name: 'scheduleFiring',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: WIDE },
    { t: 1_200, v: WIDE, easing: 'hold' },
    { t: 2_600, v: CARD_FOCUS },
    { t: 8_100, v: CARD_FOCUS, easing: 'hold' },
    { t: 9_500, v: WIDE },
  ]),
  cursors: [
    {
      userIndex: 5,
      color: '#22d3ee',
      pos: path([
        [0, ...REST],
        [2_600, ...REST, 'hold'],
        [3_400, ...ROW_SCHEDULED],
        [3_700, ...ROW_SCHEDULED, 'hold'],
      ]),
      ripple: clickPulses([3_750]),
    },
  ],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    scheduleTabOpen: new Track([
      { t: 0, v: 0 },
      { t: 3_950, v: 0, easing: 'hold' },
      { t: 4_000, v: 1, easing: 'hold' },
      { t: 7_600, v: 1, easing: 'hold' },
      { t: 7_650, v: 0, easing: 'hold' },
    ]),
    pointerVisible: new Track([
      { t: 0, v: 0 },
      { t: 3_999, v: 0, easing: 'hold' },
      { t: 4_400, v: 1, easing: 'hold' },
      { t: 7_600, v: 1, easing: 'hold' },
      { t: 7_650, v: 0, easing: 'hold' },
    ]),
    pointerX: new Track([
      { t: 4_400, v: 960 },
      { t: 5_400, v: 1359 },
      { t: 5_900, v: 1359, easing: 'hold' },
    ]),
    pointerY: new Track([
      { t: 4_400, v: 300 },
      { t: 5_400, v: 418 },
      { t: 5_900, v: 418, easing: 'hold' },
    ]),
    pointerRipple: clickPulses([5_950]),
  },
  actions: [...spinActions, { t: 6_000, run: clickRunNow }],
};
