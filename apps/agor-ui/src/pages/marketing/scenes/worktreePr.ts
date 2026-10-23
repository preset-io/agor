// Scene — "worktreePr" (8s, loop-perfect, booth-loop candidate).
// Same staged panel as session.ts (DemoSessionStage's 'worktree' variant —
// real TaskBlock/AgentChain/DiffBlock, not a recreation): a prompt to fix a
// flaky test lands, a Read/Edit tool chain runs, a real diff completes. Then
// the canvas — visible in the left strip beside the fixed session panel —
// pans from that branch's card down to a second, unrelated branch card:
// two real git branches, two real PRs, no shared state. Sells worktree
// isolation without needing a second staged panel.
// Tune via /demo/marketing-video?scene=worktreePr&play=1

import { clickPulses, type Keyframe, type SceneDefinition, Track, typeText } from '../timeline';

const DURATION = 8_000;

export const WORKTREE_PROMPT = 'Fix the flaky login test — it fails intermittently in CI.';
export const WORKTREE_RESPONSE =
  'Found it — the redirect assertion ran before the network settled. Added a `waitForLoadState` before the check; reran the suite 20x clean.';

// Canvas keeps the left 1040px (session panel is 880px, fixed right).
// landing-hero-polish (card 1, PR #1248): abs flow pos ~(130,760) — same
// framing session.ts uses. multiplayer-presence (card 2, PR #1251) sits
// 410px lower in flow space at the same zoom.
const VIEW_CARD1 = { x: 250, y: -590, zoom: 1.0 };
const VIEW_CARD1_SETTLED = { x: 230, y: -610, zoom: 1.04 };
const VIEW_CARD2 = { x: 230, y: -1020, zoom: 1.04 };

const COMPOSER: [number, number] = [1_250, 1_014];
const SEND_BUTTON: [number, number] = [1_852, 1_050];
const TRANSCRIPT: [number, number] = [1_380, 760];

const typeThenClear = (text: string, t0: number, t1: number, tClear: number): Track<string> => {
  const chars = [...text];
  const keyframes: Keyframe<string>[] = [{ t: 0, v: '' }];
  const perChar = (t1 - t0) / Math.max(chars.length, 1);
  chars.forEach((_, index) => {
    const revealed = chars.slice(0, index + 1).join('');
    keyframes.push({
      t: t0 + perChar * (index + 1),
      v: index + 1 < chars.length ? `${revealed}▍` : revealed,
      easing: 'hold',
    });
  });
  keyframes.push({ t: tClear, v: '', easing: 'hold' });
  return new Track(keyframes);
};

export const worktreePrScene: SceneDefinition = {
  name: 'worktreePr',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: VIEW_CARD1 },
    { t: 6_300, v: VIEW_CARD1_SETTLED, easing: 'linear' },
    { t: 6_700, v: VIEW_CARD1_SETTLED, easing: 'hold' },
    { t: 7_900, v: VIEW_CARD2 },
    { t: 8_000, v: VIEW_CARD2, easing: 'hold' },
  ]),
  cursors: [],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    sessionPhase: new Track([
      { t: 0, v: 0 },
      { t: 2_950, v: 1, easing: 'hold' },
      { t: 3_300, v: 2, easing: 'hold' },
      { t: 3_850, v: 3, easing: 'hold' },
      { t: 4_350, v: 4, easing: 'hold' },
      { t: 6_100, v: 5, easing: 'hold' },
    ]),
    pointerVisible: new Track([{ t: 0, v: 1 }]),
    pointerX: new Track([
      { t: 0, v: 760 },
      { t: 600, v: COMPOSER[0] },
      { t: 2_650, v: COMPOSER[0], easing: 'hold' },
      { t: 2_950, v: SEND_BUTTON[0] },
      { t: 3_300, v: SEND_BUTTON[0], easing: 'hold' },
      { t: 4_300, v: TRANSCRIPT[0] },
      { t: 8_000, v: TRANSCRIPT[0] + 40 },
    ]),
    pointerY: new Track([
      { t: 0, v: 640 },
      { t: 600, v: COMPOSER[1] },
      { t: 2_650, v: COMPOSER[1], easing: 'hold' },
      { t: 2_950, v: SEND_BUTTON[1] },
      { t: 3_300, v: SEND_BUTTON[1], easing: 'hold' },
      { t: 4_300, v: TRANSCRIPT[1] },
      { t: 8_000, v: TRANSCRIPT[1] + 30 },
    ]),
    pointerRipple: clickPulses([650, 3_000]),
  },
  textTracks: {
    composer: typeThenClear(WORKTREE_PROMPT, 700, 2_950, 3_050),
    response: typeText(WORKTREE_RESPONSE, 4_700, 6_100),
  },
  actions: [],
};
