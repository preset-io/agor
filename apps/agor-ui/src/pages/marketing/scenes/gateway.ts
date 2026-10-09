// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Scene — "gateway" (16s, loop-perfect).
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
//   · Ari, in Agor, follows up in the same session; the agent posts what she
//     asked for back to the Slack thread, and Sam says thanks.
// Loop closure: a full-frame veil (uiFlags.globalVeil) masks the reset of
// both panels back to the establish beat.
// Tune via /demo/marketing-video?scene=gateway&play=1

import { clickPulses, type Keyframe, path, type SceneDefinition, Track } from '../timeline';

const DURATION = 16_000;

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
// Ari works the Agor session panel (screen px; same panel as scenes/sessionsLoop).
const ARI_REST: [number, number] = [1_640, 620];
const AGOR_COMPOSER: [number, number] = [1_300, 1_014];
const AGOR_SEND: [number, number] = [1_852, 1_050];
const AGOR_TRANSCRIPT: [number, number] = [1_560, 760];

const FOLLOW_RESPONSE = 'Posted both URLs to the Slack thread for Sam.';
const SAM_THANKS = 'perfect, thanks @Agor (and Ari 🙌)';

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

// Full-frame loop-closure veil — opaque 14_900–15_300 while both panels reset.
const RESET = 15_100;
const VEIL = new Track([
  { t: 0, v: 0 },
  { t: 14_500, v: 0, easing: 'hold' },
  { t: 14_900, v: 1 },
  { t: 15_300, v: 1, easing: 'hold' },
  { t: 15_950, v: 0 },
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
        [11_300, SLACK_THREAD[0] + 10, SLACK_THREAD[1] + 20],
        // Sam's thanks once Ari's answer lands in the thread.
        [11_800, ...SLACK_INPUT],
        [12_000, SLACK_INPUT[0], SLACK_INPUT[1], 'hold'],
        [12_200, 845, 988],
        [13_300, 845, 988, 'hold'],
        [13_500, ...SLACK_SEND],
        [13_800, SLACK_SEND[0], SLACK_SEND[1], 'hold'],
        [14_600, SLACK_THREAD[0], SLACK_THREAD[1] + 60],
        [15_900, ...SAM_REST],
        [DURATION, SAM_REST[0], SAM_REST[1], 'hold'],
      ]),
      ripple: clickPulses([640, 2_700, 11_850, 13_550]),
    },
    {
      // Ari follows up from inside Agor once the first reply lands.
      userIndex: 1,
      color: '#06b6d4',
      pos: path([
        [0, ...ARI_REST],
        [6_500, ARI_REST[0], ARI_REST[1], 'hold'],
        [7_000, ...AGOR_COMPOSER],
        [8_600, AGOR_COMPOSER[0], AGOR_COMPOSER[1], 'hold'],
        [8_900, ...AGOR_SEND],
        [9_100, AGOR_SEND[0], AGOR_SEND[1], 'hold'],
        [9_900, ...AGOR_TRANSCRIPT],
        [14_600, AGOR_TRANSCRIPT[0] + 30, AGOR_TRANSCRIPT[1] - 40],
        [15_900, ...ARI_REST],
        [DURATION, ARI_REST[0], ARI_REST[1], 'hold'],
      ]),
      ripple: clickPulses([7_050, 8_950]),
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
      { t: 10_900, v: 3, easing: 'hold' },
      { t: 13_800, v: 4, easing: 'hold' },
      { t: RESET, v: 0, easing: 'hold' },
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
      { t: RESET, v: 0, easing: 'hold' },
    ]),
    // Ari's follow-up task in the same session.
    followPhase: new Track([
      { t: 0, v: 0 },
      { t: 9_000, v: 1, easing: 'hold' },
      { t: 10_800, v: 2, easing: 'hold' },
      { t: RESET, v: 0, easing: 'hold' },
    ]),
    globalVeil: VEIL,
  },
  textTracks: {
    // Sam types in the SLACK composer 0.7–2.5s; it clears when he sends.
    slackInput: typeSegments([
      { text: GATEWAY_PROMPT, t0: 700, t1: 2_500, tClear: 2_800 },
      { text: SAM_THANKS, t0: 12_100, t1: 13_400, tClear: 13_800 },
    ]),
    // Agent reply typewriters into the Agor panel 4.6–6.1s.
    response: typeThenClear(GATEWAY_RESPONSE, 4_600, 6_100, RESET),
    // Ari types her follow-up in the Agor composer, then the short reply.
    composer: typeSegments([
      {
        text: 'Post the before/after redirect URLs to the thread for Sam.',
        t0: 7_150,
        t1: 8_600,
        tClear: 9_000,
      },
    ]),
    followResponse: typeSegments([{ text: FOLLOW_RESPONSE, t0: 9_700, t1: 10_600, tClear: RESET }]),
  },
  actions: [],
};
