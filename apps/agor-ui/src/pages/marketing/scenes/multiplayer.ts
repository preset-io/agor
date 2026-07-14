// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Scene — "multiplayer" (8s, loop-perfect showcase cut).
// ONE collaborative story told in a single session, using the board + staged
// session-panel composition (DemoSessionStage's 'collab' variant):
//   · Ari's cursor moves to the session composer, types a prompt, hits Send —
//     the agent starts responding in the transcript.
//   · Jules arrives at the SAME composer and types a follow-up while the
//     agent is still running; sending it lands as a QUEUED TASK (tasks are
//     the queueable unit) — the drawer + Send-button badge appear.
//   · Meanwhile Mina drops a spatial comment on the board at left, typed
//     char-by-char in the pin's hover bubble.
// Loop closure: a full-frame veil (uiFlags.globalVeil) masks the reset of the
// transcript, composer, queue, and comment back to the establish beat.
// No AgorClaw in this scene. Tune via ?scene=multiplayer&play=1

import { clickPulses, type Keyframe, path, type SceneDefinition, Track } from '../timeline';

const DURATION = 8_000;

export const MULTIPLAYER_PROMPT = 'Add ⌘1–⌘9 shortcuts to jump between boards?';
export const MULTIPLAYER_FOLLOWUP = 'Also wire ⌘K to open the board switcher?';
export const MULTIPLAYER_RESPONSE =
  'On it — ⌘1 through ⌘9 now jump straight to your pinned boards. Wiring the bindings into `useKeyboardShortcuts.ts`…';

// Viewport framing: the left 1040px strip frames the Ship zone (flow
// (60,650)–(740,1730)) with both branch cards and the comment pins; the
// 880px session panel owns the right side. Gentle drift returns home.
const VIEW_START = { x: -32, y: -427, zoom: 0.78 };
const VIEW_END = { x: -44, y: -439, zoom: 0.8 };

// Mina's spatial comment: branch multiplayer-presence (130,1170) + offset
// (420,80) → abs (550,1250). Flow-space cursor coordinates.
const COMMENT_ID = '019ee88d-demo-comment-0000-000000000301';
const COMMENT_TEXT = 'Presence cursors feel alive — love seeing who is in the session 👀';
const MINA_REST: [number, number] = [2550, 260]; // off-frame right; she enters
// Hold just below-left of the pin so her name chip never covers the bubble.
const MINA_PIN: [number, number] = [498, 1296];

// Screen-space waypoints (page px, 1920×1080) for the panel interactions —
// same composer/send calibration as scenes/session.ts.
const COMPOSER: [number, number] = [1_250, 1_014];
const SEND_BUTTON: [number, number] = [1_852, 1_050];
const ARI_REST: [number, number] = [620, 420];
const ARI_TRANSCRIPT: [number, number] = [1_380, 690];
const JULES_REST: [number, number] = [1_500, 250];
const JULES_QUEUE: [number, number] = [1_300, 900];

/** Toggle a specific comment pin's React hover state so its preview bubble
 * shows the live-typed content (mouseover/mouseout reach React's handlers). */
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

/** Typewriter reveal between t0–t1 (with caret), cleared instantly at tClear. */
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

/** Two people share one composer: segment A types then clears at its send,
 * segment B types then clears at ITS send. */
const twoTypists = (
  a: { text: string; t0: number; t1: number; tClear: number },
  b: { text: string; t0: number; t1: number; tClear: number }
): Track<string> => {
  const keyframes: Keyframe<string>[] = [{ t: 0, v: '' }];
  for (const segment of [a, b]) {
    const chars = [...segment.text];
    const perChar = (segment.t1 - segment.t0) / Math.max(chars.length, 1);
    chars.forEach((_, index) => {
      const revealed = chars.slice(0, index + 1).join('');
      keyframes.push({
        t: segment.t0 + perChar * (index + 1),
        v: index + 1 < chars.length ? `${revealed}▍` : revealed,
        easing: 'hold',
      });
    });
    keyframes.push({ t: segment.tClear, v: '', easing: 'hold' });
  }
  return new Track(keyframes);
};

// Full-frame loop-closure veil — opaque 7_300–7_500 while everything resets.
const VEIL = new Track([
  { t: 0, v: 0 },
  { t: 6_900, v: 0, easing: 'hold' },
  { t: 7_300, v: 1 },
  { t: 7_500, v: 1, easing: 'hold' },
  { t: 7_950, v: 0 },
]);

export const multiplayerScene: SceneDefinition = {
  name: 'multiplayer',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: VIEW_START },
    { t: 7_000, v: VIEW_END, easing: 'linear' },
    { t: 8_000, v: VIEW_START },
  ]),
  cursors: [
    {
      // Mina (flow-space, on the board): drops her spatial comment on the
      // multiplayer-presence card while the panel story unfolds at right.
      userIndex: 2,
      color: '#f97316',
      pos: path([
        [0, ...MINA_REST],
        [1_200, MINA_PIN[0] + 14, MINA_PIN[1] - 36],
        [1_350, ...MINA_PIN],
        [4_900, MINA_PIN[0] + 6, MINA_PIN[1] + 4],
        [6_900, ...MINA_PIN],
        [7_900, ...MINA_REST],
      ]),
      ripple: clickPulses([1_400]),
    },
  ],
  screenCursors: [
    {
      // Ari (screen-space, over the panel): prompts the session.
      userIndex: 1,
      color: '#06b6d4',
      pos: path([
        [0, ...ARI_REST],
        [700, ...COMPOSER],
        [2_600, COMPOSER[0], COMPOSER[1], 'hold'],
        [2_750, ...SEND_BUTTON],
        [3_050, SEND_BUTTON[0], SEND_BUTTON[1], 'hold'],
        [3_700, ...ARI_TRANSCRIPT],
        [5_600, ARI_TRANSCRIPT[0] + 40, ARI_TRANSCRIPT[1] + 30],
        [6_900, ...ARI_TRANSCRIPT],
        [7_900, ...ARI_REST],
      ]),
      ripple: clickPulses([780, 2_850]),
    },
    {
      // Jules (screen-space): queues a follow-up in the SAME composer while
      // the agent is still running.
      userIndex: 5,
      color: '#eab308',
      pos: path([
        [0, ...JULES_REST],
        [2_900, JULES_REST[0], JULES_REST[1], 'hold'],
        [3_500, COMPOSER[0] - 30, COMPOSER[1] - 4],
        [5_400, COMPOSER[0] - 30, COMPOSER[1] - 4, 'hold'],
        [5_550, ...SEND_BUTTON],
        [5_850, SEND_BUTTON[0], SEND_BUTTON[1], 'hold'],
        [6_400, ...JULES_QUEUE],
        [6_900, JULES_QUEUE[0] + 30, JULES_QUEUE[1] + 10],
        [7_900, ...JULES_REST],
      ]),
      ripple: clickPulses([3_600, 5_650]),
    },
  ],
  nodePlacements: [],
  commentTexts: [
    {
      commentId: COMMENT_ID,
      // Mina types 1.5–4.9s; cleared under the opaque veil at 7.4s.
      text: typeThenClear(COMMENT_TEXT, 1_500, 4_900, 7_400),
    },
  ],
  uiFlags: {
    // Transcript phases (see scenes/session.ts legend). The live task NEVER
    // completes here — it stays running so Jules's queued follow-up makes
    // sense. Reset to the establish beat under the opaque veil.
    sessionPhase: new Track([
      { t: 0, v: 0 },
      { t: 2_900, v: 1, easing: 'hold' },
      { t: 3_250, v: 2, easing: 'hold' },
      { t: 3_800, v: 3, easing: 'hold' },
      { t: 4_350, v: 4, easing: 'hold' },
      { t: 7_400, v: 0, easing: 'hold' },
    ]),
    // Jules's follow-up lands as a queued task when he hits Send (5.65s).
    queuedVisible: new Track([
      { t: 0, v: 0 },
      { t: 5_700, v: 1, easing: 'hold' },
      { t: 7_400, v: 0, easing: 'hold' },
    ]),
    globalVeil: VEIL,
  },
  textTracks: {
    // One composer, two authors: Ari 0.8–2.6s (sends at 2.85s), then Jules
    // 3.7–5.4s (sends at 5.65s, queueing).
    composer: twoTypists(
      { text: MULTIPLAYER_PROMPT, t0: 800, t1: 2_600, tClear: 2_900 },
      { text: MULTIPLAYER_FOLLOWUP, t0: 3_700, t1: 5_400, tClear: 5_700 }
    ),
    // Agent reply streams in while the task keeps running; cleared under veil.
    response: typeThenClear(MULTIPLAYER_RESPONSE, 4_550, 6_800, 7_400),
  },
  actions: [
    // Open Mina's pin hover bubble while she types (the bubble is the only
    // place the typed text is visible); close it under the opaque veil.
    { t: 1_400, run: () => hoverCommentPin(COMMENT_ID, true) },
    { t: 7_350, run: () => hoverCommentPin(COMMENT_ID, false) },
  ],
};
