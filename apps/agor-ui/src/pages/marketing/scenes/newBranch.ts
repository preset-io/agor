// Scene — "newBranch" (8s, loop-perfect, booth-loop candidate).
// The real NewBranchModal (prop/store-driven, no client dependency) opens,
// a branch name is typed into its REAL input via a native-setter + `input`
// event (so React's controlled-input onChange actually fires — antd Select/
// dropdown clicks elsewhere in this pipeline use mousedown+click, but a text
// Input needs its value set this way), then a real click on Create Branch.
// The instant the modal closes, fix-flaky-login-test flies onto the board
// from off-canvas and lands in Review, already running — the fixture branch
// was there all along (see fixtureData.ts), just parked off-screen until
// this moment.
// Tune via /demo/marketing-video?scene=newBranch&play=1

import {
  type ActionKeyframe,
  clickPulses,
  type SceneDefinition,
  Track,
  type ViewportState,
} from '../timeline';

const DURATION = 8_000;
const BRANCH_NAME = 'fix-flaky-login-test';
const FPS = 30;
const FIX_FLAKY_LOGIN_BRANCH_ID = '019ee88d-demo-branch-0000-000000000109';
const SPIN_PERIOD_MS = 1_000;

const PANE_CENTER = { x: 960, y: 508 };
const focusOn = (fx: number, fy: number, zoom: number): ViewportState => ({
  x: PANE_CENTER.x - fx * zoom,
  y: PANE_CENTER.y - fy * zoom,
  zoom,
});

const WIDE: ViewportState = { x: 109, y: 0, zoom: 0.56 };
// zone-review spans (820,650)-(1500,1730); the card lands at zone-relative
// (80,900) -> absolute (900,1550).
const CARD_FOCUS = focusOn(1110, 1720, 1.35);

const OBJECT_ID = 'board-object-019ee88d-demo-branch-0000-000000000109';
const HOME_REL = { x: 80, y: 900 };
const HOME_ABS = { x: 900, y: 1550 };
const OFFSCREEN: { x: number; y: number } = { x: -800, y: -800 };

const setReactInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const getBranchNameInput = (): HTMLInputElement | null => {
  const items = Array.from(
    document.querySelectorAll<HTMLElement>('.ant-modal-body .ant-form-item')
  );
  const item = items.find((candidate) =>
    candidate.querySelector('.ant-form-item-label')?.textContent?.includes('Branch Name')
  );
  return item?.querySelector<HTMLInputElement>('input') ?? null;
};

const typeBranchName = (upTo: number) => {
  const input = getBranchNameInput();
  if (input) setReactInputValue(input, BRANCH_NAME.slice(0, upTo));
};

const clickCreate = () => {
  const button = document.querySelector<HTMLElement>('.ant-modal-content .ant-btn-primary');
  button?.click();
};

const TYPE_START = 1_200;
const TYPE_END = 2_900;
const CREATE_CLICK_T = 3_200;
const MODAL_CLOSE_T = 3_350;

const typeActions = Array.from({ length: BRANCH_NAME.length }, (_, index) => {
  const t = TYPE_START + ((TYPE_END - TYPE_START) * (index + 1)) / BRANCH_NAME.length;
  return { t, run: () => typeBranchName(index + 1) };
});

// The branch materializes already RUNNING — same frozen-<Spin> fix as
// multiAgentRace.ts (motion:false kills the real CSS animation).
const rotateSpinner = (ms: number) => {
  const angle = ((ms % SPIN_PERIOD_MS) / SPIN_PERIOD_MS) * 360;
  for (const dot of document.querySelectorAll<HTMLElement>(
    `[data-session-id^="${FIX_FLAKY_LOGIN_BRANCH_ID}"] .ant-spin-dot`
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

export const newBranchScene: SceneDefinition = {
  name: 'newBranch',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: WIDE },
    { t: 3_600, v: WIDE, easing: 'hold' },
    { t: 4_800, v: CARD_FOCUS },
    { t: 6_800, v: CARD_FOCUS, easing: 'hold' },
    { t: 8_000, v: WIDE },
  ]),
  cursors: [],
  nodePlacements: [
    {
      objectId: OBJECT_ID,
      pos: new Track([
        { t: 0, v: OFFSCREEN },
        { t: 4_000, v: OFFSCREEN, easing: 'hold' },
        { t: 4_800, v: HOME_ABS, easing: 'easeOutCubic' },
        { t: 4_850, v: HOME_REL, easing: 'hold' },
        { t: 7_950, v: HOME_REL, easing: 'hold' },
        { t: 8_000, v: OFFSCREEN, easing: 'hold' },
      ]),
      zoneId: new Track<string | null>([
        { t: 0, v: null },
        { t: 4_850, v: 'zone-review', easing: 'hold' },
        { t: 7_950, v: null, easing: 'hold' },
      ]),
    },
  ],
  commentTexts: [],
  uiFlags: {
    newBranchOpen: new Track([
      { t: 0, v: 0 },
      { t: 800, v: 1, easing: 'hold' },
      { t: MODAL_CLOSE_T, v: 0, easing: 'hold' },
    ]),
    pointerVisible: new Track([{ t: 0, v: 1 }]),
    pointerX: new Track([
      { t: 0, v: 960 },
      { t: 900, v: 780 },
      { t: 1_150, v: 780, easing: 'hold' },
      { t: 2_950, v: 1_040 },
      { t: 3_150, v: 1_040, easing: 'hold' },
    ]),
    pointerY: new Track([
      { t: 0, v: 600 },
      { t: 900, v: 430 },
      { t: 1_150, v: 430, easing: 'hold' },
      { t: 2_950, v: 620 },
      { t: 3_150, v: 620, easing: 'hold' },
    ]),
    pointerRipple: clickPulses([3_200]),
  },
  actions: [...typeActions, { t: CREATE_CLICK_T, run: clickCreate }, ...spinActions],
};
