// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Scene — "gateway" (8s, loop-perfect).
// Split-screen message-gateway story: the LEFT half is a hand-rolled
// Slack-style channel panel (DemoSlackStage — aubergine sidebar, #eng-support
// header, square avatars, APP badge); the RIGHT half is the staged Agor
// session panel (DemoSessionStage's 'gateway' variant).
//   · Sam's cursor clicks the Slack composer and types an "@Agor …" message
//     char-by-char, then hits send — the message posts to the channel.
//   · A beat later the same message arrives in the Agor session as the
//     inbound prompt; the agent investigates with a Read/Edit tool chain and
//     its reply typewriters in.
//   · The reply then lands back in the Slack thread as a bot message.
// Loop closure: a full-frame veil (uiFlags.globalVeil) masks the reset of
// both panels back to the establish beat.
// Tune via /demo/marketing-video?scene=gateway&play=1

import { clickPulses, type Keyframe, path, type SceneDefinition, Track } from '../timeline';

const DURATION = 8_000;

export const GATEWAY_PROMPT = '@Agor the OAuth redirect loops on staging — can you take a look?';
export const GATEWAY_RESPONSE =
  'Found it — last night’s deploy changed the OAuth redirect URL. I patched `oauth-config.ts`, redeployed staging, and posted the fix back to the Slack thread.';

// The canvas is fully covered (Slack left, session panel right), so the
// viewport just holds still.
const VIEW = { x: 250, y: -590, zoom: 1.0 };

// Screen-space waypoints inside the Slack panel (sidebar is 248px wide, the
// composer sits at the bottom of the 1040px stage).
const SAM_REST: [number, number] = [620, 330];
const SLACK_INPUT: [number, number] = [480, 965];
const SLACK_SEND: [number, number] = [992, 1_008];
const SLACK_THREAD: [number, number] = [700, 700];

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

// Full-frame loop-closure veil — opaque 7_300–7_500 while both panels reset.
const VEIL = new Track([
  { t: 0, v: 0 },
  { t: 6_900, v: 0, easing: 'hold' },
  { t: 7_300, v: 1 },
  { t: 7_500, v: 1, easing: 'hold' },
  { t: 7_950, v: 0 },
]);

export const gatewayScene: SceneDefinition = {
  name: 'gateway',
  durationMs: DURATION,
  viewport: new Track([{ t: 0, v: VIEW }]),
  cursors: [],
  screenCursors: [
    {
      // Sam works the Slack side: click the composer, type, send, then hover
      // the thread while the agent works.
      userIndex: 6,
      color: '#8b5cf6',
      pos: path([
        [0, ...SAM_REST],
        [550, ...SLACK_INPUT],
        [750, SLACK_INPUT[0], SLACK_INPUT[1], 'hold'],
        // Drift ahead of the text while typing so the name chip never covers
        // the line being typed.
        [1_000, 845, 988],
        [2_450, 845, 988, 'hold'],
        [2_600, ...SLACK_SEND],
        [2_950, SLACK_SEND[0], SLACK_SEND[1], 'hold'],
        [3_700, ...SLACK_THREAD],
        [6_200, SLACK_THREAD[0] + 30, SLACK_THREAD[1] - 20],
        [6_900, SLACK_THREAD[0], SLACK_THREAD[1] + 40],
        [7_900, ...SAM_REST],
      ]),
      ripple: clickPulses([640, 2_700]),
    },
  ],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {
    // Slack channel state: 0 = prior chatter · 1 = Sam's @Agor message posted
    // (+ "Agor is working on it…" indicator) · 2 = the bot reply landed.
    slackPhase: new Track([
      { t: 0, v: 0 },
      { t: 2_800, v: 1, easing: 'hold' },
      { t: 6_300, v: 2, easing: 'hold' },
      { t: 7_400, v: 0, easing: 'hold' },
    ]),
    // Agor transcript phases (scenes/session.ts legend); phase 1 is the
    // INBOUND message landing — nobody types in this composer.
    sessionPhase: new Track([
      { t: 0, v: 0 },
      { t: 3_000, v: 1, easing: 'hold' },
      { t: 3_400, v: 2, easing: 'hold' },
      { t: 4_000, v: 3, easing: 'hold' },
      { t: 4_500, v: 4, easing: 'hold' },
      { t: 6_200, v: 5, easing: 'hold' },
      { t: 7_400, v: 0, easing: 'hold' },
    ]),
    globalVeil: VEIL,
  },
  textTracks: {
    // Sam types in the SLACK composer 0.7–2.5s; it clears when he sends.
    slackInput: typeThenClear(GATEWAY_PROMPT, 700, 2_500, 2_800),
    // Agent reply typewriters into the Agor panel 4.6–6.1s.
    response: typeThenClear(GATEWAY_RESPONSE, 4_600, 6_100, 7_400),
  },
  actions: [],
};
