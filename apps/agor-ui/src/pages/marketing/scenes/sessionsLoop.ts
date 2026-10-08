// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Scene — "sessions" (12s, loop-perfect showcase cut of the session story).
// Same staged panel as the hero "session" scene (see DemoSessionStage): your
// pointer clicks the composer, a prompt types char-by-char, submits, a
// thinking/tool chain accumulates, and the assistant's reply typewriters in.
// Then Ari follows up the same way, and a short second reply lands.
// Unlike the hero cut, this one closes its own loop: a panel-colored veil
// fades over the transcript in the final second, the staged state resets to
// the establish beat underneath it, and the veil lifts — so state(8s) is
// pixel-identical to state(0) and the video loops seamlessly.
// Tune via /demo/marketing-video?scene=sessions&play=1

import { clickPulses, type Keyframe, path, type SceneDefinition, Track } from '../timeline';
import { SESSION_PROMPT, SESSION_RESPONSE } from './session';

const DURATION = 12_000;

// Viewport framing — identical values to the hero session scene, but the
// drift returns home so the canvas strip also loops.
const VIEW_START = { x: 250, y: -590, zoom: 1.0 };
const VIEW_END = { x: 230, y: -610, zoom: 1.04 };

// Screen-space waypoints (calibrated against the staged panel). Both rests are
// inside the session panel, so nobody wanders off to the canvas.
const COMPOSER: [number, number] = [1_250, 1_014];
const SEND_BUTTON: [number, number] = [1_852, 1_050];
const TRANSCRIPT: [number, number] = [1_380, 760];
const YOU_REST: [number, number] = [1_520, 560];
const ARI_REST: [number, number] = [1_740, 690];
const ARI_COMPOSER: [number, number] = [1_330, 1_014];

/** Type each text between t0–t1 (with caret), clearing at tClear. */
const typeSegments = (
  segments: Array<{ text: string; t0: number; t1: number; tClear: number }>
): Track<string> => {
  const keyframes: Keyframe<string>[] = [{ t: 0, v: '' }];
  for (const { text, t0, t1, tClear } of segments) {
    const chars = [...text];
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
  }
  return new Track(keyframes);
};

const FOLLOW_PROMPT = 'Nice. Can you add a light/dark toggle to the header too?';
const FOLLOW_RESPONSE =
  'Added an Appearance toggle to the header. It follows the system setting until someone picks one.';

// Loop-closure choreography: the veil is fully opaque 10_900–11_300 while the
// staged state snaps back to the establish beat at 11_100, invisibly.
const VEIL = new Track([
  { t: 0, v: 0 },
  { t: 10_500, v: 0, easing: 'hold' },
  { t: 10_900, v: 1 },
  { t: 11_300, v: 1, easing: 'hold' },
  { t: 11_850, v: 0 },
]);

export const sessionsLoopScene: SceneDefinition = {
  name: 'sessions',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: VIEW_START },
    { t: 10_600, v: VIEW_END, easing: 'linear' },
    { t: DURATION, v: VIEW_START },
  ]),
  cursors: [],
  // Ari follows up once the first exchange lands: click the composer, type,
  // send, then watch the reply.
  screenCursors: [
    {
      userIndex: 1,
      color: '#06b6d4',
      pos: path([
        [0, ...ARI_REST],
        [5_300, ARI_REST[0], ARI_REST[1], 'hold'],
        [5_800, ...ARI_COMPOSER],
        [7_500, ARI_COMPOSER[0], ARI_COMPOSER[1], 'hold'],
        [7_800, ...SEND_BUTTON],
        [8_000, SEND_BUTTON[0], SEND_BUTTON[1], 'hold'],
        [8_900, TRANSCRIPT[0] + 260, TRANSCRIPT[1] + 40],
        [10_500, TRANSCRIPT[0] + 280, TRANSCRIPT[1] + 30],
        [11_800, ...ARI_REST],
        [DURATION, ARI_REST[0], ARI_REST[1], 'hold'],
      ]),
      ripple: clickPulses([5_850, 7_850]),
    },
  ],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    // Stepwise transcript state — see the phase legend in scenes/session.ts.
    sessionPhase: new Track([
      { t: 0, v: 0 },
      { t: 2_750, v: 1, easing: 'hold' },
      { t: 3_100, v: 2, easing: 'hold' },
      { t: 3_500, v: 3, easing: 'hold' },
      { t: 3_900, v: 4, easing: 'hold' },
      { t: 5_400, v: 5, easing: 'hold' },
      // Reset to the establish beat under the opaque veil.
      { t: 11_100, v: 0, easing: 'hold' },
    ]),
    // Ari's follow-up: running from its send, done once the reply lands.
    followPhase: new Track([
      { t: 0, v: 0 },
      { t: 7_950, v: 1, easing: 'hold' },
      { t: 10_000, v: 2, easing: 'hold' },
      { t: 11_100, v: 0, easing: 'hold' },
    ]),
    resetVeil: VEIL,
    // Your pointer (screen px in the 1920×1080 page): composer, type, send,
    // then follow the work from the transcript; home during the veil.
    pointerVisible: new Track([{ t: 0, v: 1 }]),
    pointerX: new Track([
      { t: 0, v: YOU_REST[0] },
      { t: 500, v: COMPOSER[0] },
      { t: 2_350, v: COMPOSER[0], easing: 'hold' },
      { t: 2_650, v: SEND_BUTTON[0] },
      { t: 3_000, v: SEND_BUTTON[0], easing: 'hold' },
      { t: 3_900, v: TRANSCRIPT[0] },
      { t: 10_500, v: TRANSCRIPT[0] - 30 },
      { t: 11_800, v: YOU_REST[0] },
    ]),
    pointerY: new Track([
      { t: 0, v: YOU_REST[1] },
      { t: 500, v: COMPOSER[1] },
      { t: 2_350, v: COMPOSER[1], easing: 'hold' },
      { t: 2_650, v: SEND_BUTTON[1] },
      { t: 3_000, v: SEND_BUTTON[1], easing: 'hold' },
      { t: 3_900, v: TRANSCRIPT[1] },
      { t: 10_500, v: TRANSCRIPT[1] - 60 },
      { t: 11_800, v: YOU_REST[1] },
    ]),
    pointerRipple: clickPulses([550, 2_700]),
  },
  textTracks: {
    // Your prompt 0.6–2.4s (cleared at submit, 2.75s), then Ari's 6.0–7.5s.
    composer: typeSegments([
      { text: SESSION_PROMPT, t0: 600, t1: 2_400, tClear: 2_750 },
      { text: FOLLOW_PROMPT, t0: 6_000, t1: 7_500, tClear: 7_950 },
    ]),
    // Replies typewriter in, then clear under the veil.
    response: typeSegments([{ text: SESSION_RESPONSE, t0: 4_000, t1: 5_300, tClear: 11_100 }]),
    followResponse: typeSegments([{ text: FOLLOW_RESPONSE, t0: 8_600, t1: 9_900, tClear: 11_100 }]),
  },
  actions: [],
};
