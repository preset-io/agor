// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Scene — "genealogyTree" (10s, loop-perfect, booth-loop candidate).
// Camera pushes in on auth-token-refresh-race: Claude's root session spawned
// a repro and an audit, then got forked mid-repro to try a mutex-based fix —
// a real fork/spawn family tree, rendered by BranchCard's own genealogy Tree
// (buildSessionTree), not scene-authored DOM. A cursor arrives during the
// hold and points at the root, then the repro session that got forked —
// then the REAL ForkSpawnModal opens (action='fork': the actual product
// flow, which keeps the parent's agent — there's no agent picker on fork,
// only on spawn) with a real prompt typed into its real textarea, showing
// how that fork edge in the tree actually got made.
//
// The forked "patch the race with a mutex" session is RUNNING, so it hits
// the same frozen-<Spin> issue as multiAgentRace.ts (MarketingVideoPage
// forces antd token.motion=false for deterministic capture, which also
// freezes real CSS animations) — same fix, reproduced here scoped to this
// branch's one running session.
// Tune via /demo/marketing-video?scene=genealogyTree&play=1

import {
  type ActionKeyframe,
  clickPulses,
  path,
  type SceneDefinition,
  Track,
  type ViewportState,
} from '../timeline';

const DURATION = 10_000;
const FPS = 30;
const TREE_BRANCH_ID = '019ee88d-demo-branch-0000-000000000107';
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

// auth-token-refresh-race sits in zone-teammates (flow origin 1580,650) at
// zone-relative (620,650) -> absolute (2200,1300); a 4-node genealogy tree
// runs tall, so bias the focus a little below the card's top edge.
const TREE_FOCUS = focusOn(2410, 1560, 1.55);

// Card top-left ~(2200,1300); row offsets calibrated against this card's
// actual layout.
const REST: [number, number] = [2700, 1250];
const ROW_ROOT: [number, number] = [2320, 1521];
const ROW_REPRO: [number, number] = [2320, 1585];

const rotateRaceSpinner = (ms: number) => {
  const angle = ((ms % SPIN_PERIOD_MS) / SPIN_PERIOD_MS) * 360;
  for (const dot of document.querySelectorAll<HTMLElement>(
    `[data-session-id^="${TREE_BRANCH_ID}"] .ant-spin-dot`
  )) {
    dot.style.transform = `rotate(${angle}deg)`;
  }
};

const spinActions: ActionKeyframe[] = Array.from(
  { length: Math.round((DURATION / 1000) * FPS) + 1 },
  (_, frame) => {
    const ms = (frame / FPS) * 1000;
    return { t: ms, run: () => rotateRaceSpinner(ms) };
  }
);

// The fork modal's prompt textarea is a real antd Input.TextArea (native
// <textarea>) — same native-value-setter trick as newBranch.ts/knowledge.ts,
// scoped to HTMLTextAreaElement instead of HTMLInputElement.
const setReactTextareaValue = (el: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const getForkTextarea = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Try a different approach"]');

const FORK_PROMPT = 'Try patching the race with a mutex instead';
const TYPE_START = 4_700;
const TYPE_END = 6_500;
const typeActions: ActionKeyframe[] = Array.from({ length: FORK_PROMPT.length }, (_, index) => {
  const t = TYPE_START + ((TYPE_END - TYPE_START) * (index + 1)) / FORK_PROMPT.length;
  return {
    t,
    run: () => {
      const el = getForkTextarea();
      if (el) setReactTextareaValue(el, FORK_PROMPT.slice(0, index + 1));
    },
  };
});

export const genealogyTreeScene: SceneDefinition = {
  name: 'genealogyTree',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: WIDE },
    { t: 1_200, v: WIDE, easing: 'hold' },
    { t: 2_600, v: TREE_FOCUS },
    { t: 8_100, v: TREE_FOCUS, easing: 'hold' },
    { t: 10_000, v: WIDE },
  ]),
  cursors: [
    {
      userIndex: 3,
      color: '#a78bfa',
      pos: path([
        [0, ...REST],
        [2_600, ...REST, 'hold'],
        [3_100, ...ROW_ROOT],
        [3_300, ...ROW_ROOT, 'hold'],
        [3_800, ...ROW_REPRO],
        [4_000, ...ROW_REPRO, 'hold'],
        [8_000, ...REST],
        [10_000, REST[0], REST[1], 'hold'],
      ]),
      ripple: clickPulses([4_050]),
    },
  ],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    forkSpawnOpen: new Track([
      { t: 0, v: 0 },
      { t: 4_149, v: 0, easing: 'hold' },
      { t: 4_150, v: 1, easing: 'hold' },
      { t: 7_900, v: 1, easing: 'hold' },
      { t: 7_950, v: 0, easing: 'hold' },
    ]),
  },
  actions: [...spinActions, ...typeActions],
};
