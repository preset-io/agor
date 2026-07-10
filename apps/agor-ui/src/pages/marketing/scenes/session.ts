// Scene — "session" (7s, zoomed single-player).
// A real session panel (TaskBlock transcript + AutocompleteTextarea composer
// + SessionFooter) staged over the right half of the canvas — see
// DemoSessionStage.tsx. The pointer drifts to the composer, a prompt types
// char-by-char, submits, the user bubble lands, a thinking/tool chain
// accumulates, and the assistant's reply typewriters in before a settle hold.
// Tune via /demo/marketing-video?scene=session&play=1
//
// `sessionPhase` is the stepwise transcript state sampled by DemoSessionStage:
//   0 — establish: panel idle, composer empty, prior task only
//   1 — prompt submitted: live task appears (running) with the user message
//   2 — thinking block appears in the agent chain
//   3 — Read tool call joins the chain
//   4 — Edit tool call joins the chain (+ Read result lands)
//   5 — task completes: Edit result lands, duration pill, status flips

import { clickPulses, type Keyframe, type SceneDefinition, Track, typeText } from '../timeline';

const DURATION = 7_000;

export const SESSION_PROMPT = 'Can you add dark-mode support to the settings page?';
export const SESSION_RESPONSE =
  'On it! I moved the palette into theme tokens and added a dark-mode toggle under **Settings → Appearance**.';

// Panel geometry (screen px, 1920×1080 page): DemoSessionStage pins an
// 880px-wide panel to the right edge, below the 64px header.
export const SESSION_PANEL_WIDTH = 880;

// Viewport framing: the canvas keeps the left 1040px. Zoom on the
// landing-hero-polish branch card (abs flow pos ~(130,760), ~420 wide) so it
// fills the visible strip while the session panel owns the right side.
const VIEW_START = { x: 250, y: -590, zoom: 1.0 };
const VIEW_END = { x: 230, y: -610, zoom: 1.04 };

// Screen-space pointer waypoints (calibrated against the staged panel:
// textarea spans x1065–1896 at y≈1003–1035; Send button center ≈ (1860,1055)).
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

export const sessionScene: SceneDefinition = {
  name: 'session',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: VIEW_START },
    { t: DURATION, v: VIEW_END, easing: 'linear' },
  ]),
  cursors: [],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    // Stepwise transcript state — see the phase legend at the top of the file.
    sessionPhase: new Track([
      { t: 0, v: 0 },
      { t: 3_050, v: 1, easing: 'hold' },
      { t: 3_400, v: 2, easing: 'hold' },
      { t: 3_950, v: 3, easing: 'hold' },
      { t: 4_450, v: 4, easing: 'hold' },
      { t: 6_400, v: 5, easing: 'hold' },
    ]),
    // Screen-space pointer (px in the 1920×1080 page).
    pointerVisible: new Track([{ t: 0, v: 1 }]),
    pointerX: new Track([
      { t: 0, v: 760 },
      { t: 600, v: COMPOSER[0] },
      { t: 2_650, v: COMPOSER[0], easing: 'hold' },
      { t: 2_950, v: SEND_BUTTON[0] },
      { t: 3_300, v: SEND_BUTTON[0], easing: 'hold' },
      { t: 4_300, v: TRANSCRIPT[0] },
      { t: 7_000, v: TRANSCRIPT[0] + 40 },
    ]),
    pointerY: new Track([
      { t: 0, v: 640 },
      { t: 600, v: COMPOSER[1] },
      { t: 2_650, v: COMPOSER[1], easing: 'hold' },
      { t: 2_950, v: SEND_BUTTON[1] },
      { t: 3_300, v: SEND_BUTTON[1], easing: 'hold' },
      { t: 4_300, v: TRANSCRIPT[1] },
      { t: 7_000, v: TRANSCRIPT[1] + 30 },
    ]),
    pointerRipple: clickPulses([650, 3_000]),
  },
  textTracks: {
    // Prompt types 0.7–2.95s, clears at submit (3.05s).
    composer: typeThenClear(SESSION_PROMPT, 700, 2_950, 3_050),
    // Assistant reply typewriters in 4.7–6.4s.
    response: typeText(SESSION_RESPONSE, 4_700, 6_400),
  },
  actions: [],
};
