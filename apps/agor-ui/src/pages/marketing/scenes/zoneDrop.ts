// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Scene — "zoneDrop" (8s, loop-perfect, booth-loop candidate).
// Devon drags multiplayer-presence from Ship into the Review lane. The
// instant it lands, Review's own zone trigger — "Run a security/docs pass on
// {{branch.name}} and leave concise review notes." (see fixtureData's
// zone-review.trigger) — pops as a spatial-comment toast pinned to the card,
// typewriter-revealing the rendered prompt. Devon drags the card home during
// the pull-back so the loop closes.
// Tune via /demo/marketing-video?scene=zoneDrop&play=1

import {
  type ActionKeyframe,
  clickPulses,
  type Keyframe,
  path,
  type SceneDefinition,
  Track,
  type ViewportState,
} from '../timeline';

const DURATION = 8_000;
const FPS = 30;
const MULTIPLAYER_PRESENCE_BRANCH_ID = '019ee88d-demo-branch-0000-000000000102';
const SPIN_PERIOD_MS = 1_000;

// Pane is 1920×1016 (1080 viewport minus 64px header); its center is
// (960, 508) in pane space. viewport = paneCenter - flowFocus * zoom.
const PANE_CENTER = { x: 960, y: 508 };

const focusOn = (fx: number, fy: number, zoom: number): ViewportState => ({
  x: PANE_CENTER.x - fx * zoom,
  y: PANE_CENTER.y - fy * zoom,
  zoom,
});

const WIDE: ViewportState = { x: 109, y: 0, zoom: 0.56 };

// zone-ship spans (60,650)-(740,1730); multiplayer-presence sits lower in
// its card column than the boards.ts hero card.
const SHIP_FOCUS = focusOn(340, 1350, 1.1);
// zone-review spans (820,650)-(1500,1730); the drop point (below the
// existing rbac/security cards) biased so the toast lands in frame too.
const REVIEW_FOCUS = focusOn(1170, 1500, 1.55);

// Rendered zone-review trigger template (fixtureData's zone-review.trigger,
// {{branch.name}} substituted by hand — the demo has no Handlebars runtime).
const TRIGGER_TOAST =
  '🔎 Run a security/docs pass on multiplayer-presence and leave concise review notes.';

const OBJECT_ID = 'board-object-019ee88d-demo-branch-0000-000000000102';
const HOME_REL = { x: 70, y: 520 };
const HOME_ABS = { x: 130, y: 1170 };
const DROP_REL = { x: 140, y: 750 };
const DROP_ABS = { x: 960, y: 1400 };
const ARC_MID = { x: 545, y: 1248 };

// Cursor tip rides the card's header while dragging (matches boards.ts).
const GRAB_OFFSET = { x: 200, y: 24 };
const grab = (p: { x: number; y: number }): [number, number] => [
  p.x + GRAB_OFFSET.x,
  p.y + GRAB_OFFSET.y,
];
const [grabX, grabY] = grab(HOME_ABS);
const [dropX, dropY] = grab(DROP_ABS);
const [midX, midY] = grab(ARC_MID);

const DEVON_REST: [number, number] = [1500, 950];

const TOAST_COMMENT_ID = '019ee88d-demo-comment-0000-000000000303';

/** Toggle the toast pin's hover bubble (same DOM-dispatch helper as boards.ts). */
const hoverCommentPin = (commentId: string, hovered: boolean) => {
  const pin = document.querySelector(
    `.react-flow__node-comment[data-id="comment-${commentId}"] > div`
  );
  pin?.dispatchEvent(
    new MouseEvent(hovered ? 'mouseover' : 'mouseout', {
      bubbles: true,
      relatedTarget: document.body,
    })
  );
};

/** Types text between t0-t1 (with caret), snaps back to '' at tReset —
 * scheduled after the hover bubble closes, so the reset is invisible. */
const typeThenReset = (text: string, t0: number, t1: number, tReset: number): Track<string> => {
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
  keyframes.push({ t: tReset, v: '', easing: 'hold' });
  return new Track(keyframes);
};

// multiplayer-presence's Codex session is RUNNING — same frozen-<Spin> fix
// as multiAgentRace.ts (motion:false kills the real CSS animation).
const rotateSpinner = (ms: number) => {
  const angle = ((ms % SPIN_PERIOD_MS) / SPIN_PERIOD_MS) * 360;
  for (const dot of document.querySelectorAll<HTMLElement>(
    `[data-session-id^="${MULTIPLAYER_PRESENCE_BRANCH_ID}"] .ant-spin-dot`
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

export const zoneDropScene: SceneDefinition = {
  name: 'zoneDrop',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: WIDE },
    { t: 1_200, v: WIDE, easing: 'hold' },
    { t: 2_900, v: SHIP_FOCUS },
    { t: 3_300, v: SHIP_FOCUS, easing: 'hold' },
    { t: 4_600, v: REVIEW_FOCUS },
    { t: 6_900, v: REVIEW_FOCUS, easing: 'hold' },
    { t: 8_000, v: WIDE },
  ]),
  cursors: [
    {
      // Devon: grab pulse -> arc drag Ship -> Review -> drop pulse, drags
      // the card home during the pull-back so the loop closes.
      userIndex: 3,
      color: '#f97316',
      pos: path([
        [0, ...DEVON_REST],
        [2_600, grabX, grabY],
        [2_900, grabX, grabY, 'hold'],
        [3_700, midX, midY],
        [4_500, dropX, dropY],
        [6_800, dropX, dropY, 'hold'],
        [7_100, midX, midY],
        [7_600, grabX, grabY],
        [8_000, ...DEVON_REST],
      ]),
      ripple: clickPulses([2_950, 4_600, 7_650]),
    },
  ],
  nodePlacements: [
    {
      objectId: OBJECT_ID,
      // rel<->abs flips at the exact grab/drop instants (product pin math).
      pos: new Track([
        { t: 0, v: HOME_REL },
        { t: 2_950, v: HOME_ABS, easing: 'hold' },
        { t: 3_000, v: HOME_ABS },
        { t: 3_700, v: ARC_MID },
        { t: 4_500, v: DROP_ABS },
        { t: 4_600, v: DROP_REL, easing: 'hold' },
        { t: 7_000, v: DROP_ABS, easing: 'hold' },
        { t: 7_050, v: DROP_ABS },
        { t: 7_100, v: ARC_MID },
        { t: 7_600, v: HOME_ABS },
        { t: 7_650, v: HOME_REL, easing: 'hold' },
      ]),
      zoneId: new Track<string | null>([
        { t: 0, v: 'zone-ship' },
        { t: 2_950, v: null, easing: 'hold' },
        { t: 4_600, v: 'zone-review', easing: 'hold' },
        { t: 7_050, v: null, easing: 'hold' },
        { t: 7_650, v: 'zone-ship', easing: 'hold' },
      ]),
    },
  ],
  commentTexts: [
    {
      commentId: TOAST_COMMENT_ID,
      text: typeThenReset(TRIGGER_TOAST, 4_800, 6_300, 7_500),
    },
  ],
  uiFlags: {},
  actions: [
    { t: 4_700, run: () => hoverCommentPin(TOAST_COMMENT_ID, true) },
    { t: 7_100, run: () => hoverCommentPin(TOAST_COMMENT_ID, false) },
    ...spinActions,
  ],
};
