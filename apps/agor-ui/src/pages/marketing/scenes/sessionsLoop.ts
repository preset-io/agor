// Scene — "sessions" (8s, loop-perfect showcase cut of the session story).
// Same staged panel as the hero "session" scene (see DemoSessionStage): the
// pointer drifts to the composer, a prompt types char-by-char, submits, a
// thinking/tool chain accumulates, and the assistant's reply typewriters in.
// Unlike the hero cut, this one closes its own loop: a panel-colored veil
// fades over the transcript in the final second, the staged state resets to
// the establish beat underneath it, and the veil lifts — so state(8s) is
// pixel-identical to state(0) and the video loops seamlessly.
// Tune via /demo/marketing-video?scene=sessions&play=1

import { clickPulses, type Keyframe, type SceneDefinition, Track } from '../timeline';
import { SESSION_PROMPT, SESSION_RESPONSE } from './session';

const DURATION = 8_000;

// Viewport framing — identical values to the hero session scene, but the
// drift returns home so the canvas strip also loops.
const VIEW_START = { x: 250, y: -590, zoom: 1.0 };
const VIEW_END = { x: 230, y: -610, zoom: 1.04 };

// Screen-space pointer waypoints (calibrated against the staged panel).
const POINTER_REST: [number, number] = [760, 640];
const COMPOSER: [number, number] = [1_250, 1_014];
const SEND_BUTTON: [number, number] = [1_852, 1_050];
const TRANSCRIPT: [number, number] = [1_380, 760];

/** Type text between t0–t1 (with caret), then clear instantly at tClear. */
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

// Loop-closure choreography: the veil is fully opaque 7_300–7_500 while the
// staged transcript state (sessionPhase, response text) snaps back to the
// establish beat at 7_400, invisibly.
const VEIL = new Track([
  { t: 0, v: 0 },
  { t: 6_900, v: 0, easing: 'hold' },
  { t: 7_300, v: 1 },
  { t: 7_500, v: 1, easing: 'hold' },
  { t: 7_950, v: 0 },
]);

export const sessionsLoopScene: SceneDefinition = {
  name: 'sessions',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: VIEW_START },
    { t: 7_000, v: VIEW_END, easing: 'linear' },
    { t: 8_000, v: VIEW_START },
  ]),
  cursors: [],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    // Stepwise transcript state — see the phase legend in scenes/session.ts.
    sessionPhase: new Track([
      { t: 0, v: 0 },
      { t: 2_750, v: 1, easing: 'hold' },
      { t: 3_100, v: 2, easing: 'hold' },
      { t: 3_600, v: 3, easing: 'hold' },
      { t: 4_100, v: 4, easing: 'hold' },
      { t: 6_100, v: 5, easing: 'hold' },
      // Reset to the establish beat under the opaque veil.
      { t: 7_400, v: 0, easing: 'hold' },
    ]),
    resetVeil: VEIL,
    // Screen-space pointer (px in the 1920×1080 page). Glides home during
    // the veil so the loop wrap is seamless.
    pointerVisible: new Track([{ t: 0, v: 1 }]),
    pointerX: new Track([
      { t: 0, v: POINTER_REST[0] },
      { t: 550, v: COMPOSER[0] },
      { t: 2_350, v: COMPOSER[0], easing: 'hold' },
      { t: 2_650, v: SEND_BUTTON[0] },
      { t: 3_000, v: SEND_BUTTON[0], easing: 'hold' },
      { t: 4_000, v: TRANSCRIPT[0] },
      { t: 6_900, v: TRANSCRIPT[0] + 40 },
      { t: 7_900, v: POINTER_REST[0] },
    ]),
    pointerY: new Track([
      { t: 0, v: POINTER_REST[1] },
      { t: 550, v: COMPOSER[1] },
      { t: 2_350, v: COMPOSER[1], easing: 'hold' },
      { t: 2_650, v: SEND_BUTTON[1] },
      { t: 3_000, v: SEND_BUTTON[1], easing: 'hold' },
      { t: 4_000, v: TRANSCRIPT[1] },
      { t: 6_900, v: TRANSCRIPT[1] + 30 },
      { t: 7_900, v: POINTER_REST[1] },
    ]),
    pointerRipple: clickPulses([600, 2_700]),
  },
  textTracks: {
    // Prompt types 0.6–2.65s, clears at submit (2.75s).
    composer: typeThenClear(SESSION_PROMPT, 600, 2_650, 2_750),
    // Assistant reply typewriters in 4.3–6.1s, cleared under the veil.
    response: typeThenClear(SESSION_RESPONSE, 4_300, 6_100, 7_400),
  },
  actions: [],
};
