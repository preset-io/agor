// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Scene — "boards" (8s, loop-perfect).
// The cinematic camera piece over the launch-board fixtures, with every
// cursor doing something PURPOSEFUL where the camera is looking:
//   · Mina opens with a deliberate inspect beat on the cost-cockpit chart
//     (hover trace → click-pulse) while the framing is still wide.
//   · Ari DRAGS the landing-hero-polish branch card Ship → Review (grab
//     pulse → arc → drop pulse) exactly as the camera pushes from the Ship
//     zone across to the Review lane — and drags it home during the final
//     pull-back so the loop closes.
//   · Jules types a reply on the spatial comment (char-by-char in the pin's
//     hover bubble) as the camera passes the Ship/Review seam.
//   · AgorClaw, with purpose: after Ari's drop, it sweeps to the card in its
//     new zone and click-pulses a session row — the agent picks up the work —
//     then heads home to the Teammates zone just as the camera arrives there.
// Camera: wide → Ship push-in → Review drift → Teammates glide → wide.
// Tune via /demo/marketing-video?scene=boards&play=1

import { demoAgentUser } from '../fixtureData';
import {
  clickPulses,
  type Keyframe,
  path,
  type SceneDefinition,
  Track,
  type ViewportState,
} from '../timeline';

const DURATION = 8_000;

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

// Camera waypoints (flow-space focus points):
// zone-ship spans (60,650)–(740,1730); its card column sits ~x 130–550.
const SHIP_FOCUS = focusOn(430, 1130, 0.82);
// zone-review spans (820,650)–(1500,1730); biased low so Ari's drop spot and
// the card's session rows sit comfortably in frame.
const REVIEW_FOCUS = focusOn(1150, 1210, 0.82);
// zone-teammates spans (1580,650)–(2980,1730) — wider, so ease the zoom off
// and bias toward its card cluster on the left.
const TEAMMATES_FOCUS = focusOn(2060, 1090, 0.66);

// --- Ari's drag: landing-hero-polish, Ship → Review → (loop) → Ship -------
// Identical pin/unpin math to the product: zone-relative while zoneId is
// set, absolute while null, flipped at the exact grab/drop instants.
const HERO_OBJECT_ID = 'board-object-019ee88d-demo-branch-0000-000000000101';
const HERO_HOME_REL = { x: 70, y: 110 };
const HERO_HOME_ABS = { x: 130, y: 760 };
const HERO_DROP_REL = { x: 140, y: 750 };
const HERO_DROP_ABS = { x: 960, y: 1400 };
const HERO_ARC_MID = { x: 545, y: 980 };

// Cursor tip rides the card's header while dragging.
const GRAB_OFFSET = { x: 200, y: 24 };
const grab = (p: { x: number; y: number }): [number, number] => [
  p.x + GRAB_OFFSET.x,
  p.y + GRAB_OFFSET.y,
];
const [heroGrabX, heroGrabY] = grab(HERO_HOME_ABS);
const [heroDropX, heroDropY] = grab(HERO_DROP_ABS);
const [heroMidX, heroMidY] = grab(HERO_ARC_MID);

// Rest positions (match demoStaticCursors).
const ARI_REST: [number, number] = [1370, 620];
const MINA_REST: [number, number] = [2550, 260];
const JULES_REST: [number, number] = [650, 820];

// Mina's inspect beat: the cost-cockpit artifact, (620,80) 780×495.
const COCKPIT: [number, number] = [1010, 330];

// Jules's reply pin: comment ...302, branch multiplayer-presence (130,1170)
// + offset (560,300) → abs (690,1470).
const REPLY_COMMENT_ID = '019ee88d-demo-comment-0000-000000000302';
const REPLY_TEXT = '@mina capped at five with a +7 chip — done ✅';
// On the pin's avatar circle (measured at the 1.8s click: the old point sat
// ~90 flow px below it, so the click missed the pin).
const REPLY_PIN: [number, number] = [678, 1411];

// AgorClaw tidies the Teammates zone: it drags the "Usage cockpit" artifact
// card (card-202) home in the opening wide shot, and back out to the open
// right side in the closing Teammates shot, so state(0) === state(8s).
const CLAW_REST: [number, number] = [2380, 1480];
const TEAMMATES_ZONE = { x: 1580, y: 650 };
const COCKPIT_CARD_ID = 'board-object-card-202';
const COCKPIT_HOME_REL = { x: 80, y: 750 };
const COCKPIT_OUT_REL = { x: 700, y: 420 };
const CARD_GRAB = { x: 120, y: 22 };
const cardGrab = (rel: { x: number; y: number }): [number, number] => [
  TEAMMATES_ZONE.x + rel.x + CARD_GRAB.x,
  TEAMMATES_ZONE.y + rel.y + CARD_GRAB.y,
];
const COCKPIT_OUT_GRAB = cardGrab(COCKPIT_OUT_REL);
const COCKPIT_HOME_GRAB = cardGrab(COCKPIT_HOME_REL);

/** Toggle a specific comment pin's hover bubble (same helper as multiplayer). */
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

/** Types text between t0–t1 (with caret), snaps back to '' at tReset —
 * scheduled AFTER the hover bubble closes, so the reset is invisible. */
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

export const boardsScene: SceneDefinition = {
  name: 'boards',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: WIDE },
    { t: 1_500, v: WIDE, easing: 'hold' },
    { t: 3_000, v: SHIP_FOCUS },
    { t: 3_400, v: SHIP_FOCUS, easing: 'hold' },
    { t: 4_600, v: REVIEW_FOCUS },
    { t: 5_700, v: REVIEW_FOCUS, easing: 'hold' },
    { t: 6_700, v: TEAMMATES_FOCUS },
    { t: 8_000, v: WIDE },
  ]),
  cursors: [
    {
      // Ari: grab pulse → arc drag Ship → Review → drop pulse, tracked by the
      // camera; drags the card home during the pull-back so the loop closes.
      userIndex: 1,
      color: '#06b6d4',
      pos: path([
        [0, ...ARI_REST],
        [2_600, heroGrabX, heroGrabY],
        [2_900, heroGrabX, heroGrabY, 'hold'],
        [3_700, heroMidX, heroMidY],
        [4_500, heroDropX, heroDropY],
        [5_000, heroDropX + 80, heroDropY - 84],
        [6_300, heroDropX + 80, heroDropY - 84, 'hold'],
        [6_500, heroDropX, heroDropY],
        [7_100, heroMidX, heroMidY],
        [7_600, heroGrabX, heroGrabY],
        [8_000, ...ARI_REST],
      ]),
      // Final drop pulse at 7.6s so its 350ms ripple fully fades before the
      // loop wrap at 8s.
      ripple: clickPulses([2_950, 4_600, 6_550, 7_600]),
    },
    {
      // Mina: deliberate inspect beat on the cost cockpit — hover trace along
      // the chart, then a click-pulse — while the framing is still wide.
      userIndex: 2,
      color: '#f97316',
      pos: path([
        [0, ...MINA_REST],
        [600, COCKPIT[0] + 110, COCKPIT[1] - 30],
        [1_000, COCKPIT[0] + 50, COCKPIT[1] + 30],
        [1_300, COCKPIT[0] - 60, COCKPIT[1] - 20],
        [1_900, COCKPIT[0] - 60, COCKPIT[1] - 20, 'hold'],
        [3_200, ...MINA_REST],
        [8_000, MINA_REST[0], MINA_REST[1], 'hold'],
      ]),
      ripple: clickPulses([1_400]),
    },
    {
      // Jules: types a reply on the spatial comment as the camera passes.
      userIndex: 5,
      color: '#eab308',
      pos: path([
        [0, ...JULES_REST],
        [1_500, REPLY_PIN[0] + 22, REPLY_PIN[1] - 42],
        [1_700, ...REPLY_PIN],
        [5_600, REPLY_PIN[0] + 6, REPLY_PIN[1] + 4],
        [6_200, REPLY_PIN[0] + 22, REPLY_PIN[1] - 42],
        [7_200, ...JULES_REST],
        [8_000, JULES_REST[0], JULES_REST[1], 'hold'],
      ]),
      ripple: clickPulses([1_800]),
    },
    {
      // AgorClaw: drags the cockpit card home (wide shot, 0.25–1.25s), rests,
      // then drags it back out once the camera reaches Teammates (6.0–7.3s).
      userIndex: 0,
      user: demoAgentUser,
      color: '#34d399',
      pos: path([
        [0, ...COCKPIT_OUT_GRAB],
        [250, COCKPIT_OUT_GRAB[0], COCKPIT_OUT_GRAB[1], 'hold'],
        [1_200, ...COCKPIT_HOME_GRAB],
        [1_900, ...CLAW_REST],
        [5_600, CLAW_REST[0], CLAW_REST[1], 'hold'],
        [6_000, ...COCKPIT_HOME_GRAB],
        [6_100, COCKPIT_HOME_GRAB[0], COCKPIT_HOME_GRAB[1], 'hold'],
        [7_300, ...COCKPIT_OUT_GRAB],
        [8_000, COCKPIT_OUT_GRAB[0], COCKPIT_OUT_GRAB[1], 'hold'],
      ]),
      ripple: clickPulses([250, 1_250, 6_050, 7_350]),
    },
  ],
  nodePlacements: [
    {
      objectId: COCKPIT_CARD_ID,
      pos: new Track([
        { t: 0, v: COCKPIT_OUT_REL },
        { t: 300, v: COCKPIT_OUT_REL, easing: 'hold' },
        { t: 1_200, v: COCKPIT_HOME_REL },
        { t: 6_100, v: COCKPIT_HOME_REL, easing: 'hold' },
        { t: 7_300, v: COCKPIT_OUT_REL },
      ]),
      zoneId: new Track<string | null>([{ t: 0, v: 'zone-teammates' }]),
    },
    {
      objectId: HERO_OBJECT_ID,
      // rel↔abs flips at the exact grab/drop instants (product pin math).
      pos: new Track([
        { t: 0, v: HERO_HOME_REL },
        { t: 2_950, v: HERO_HOME_ABS, easing: 'hold' },
        { t: 3_000, v: HERO_HOME_ABS },
        { t: 3_700, v: HERO_ARC_MID },
        { t: 4_500, v: HERO_DROP_ABS },
        { t: 4_600, v: HERO_DROP_REL, easing: 'hold' },
        { t: 6_500, v: HERO_DROP_ABS, easing: 'hold' },
        { t: 6_550, v: HERO_DROP_ABS },
        { t: 7_100, v: HERO_ARC_MID },
        { t: 7_600, v: HERO_HOME_ABS },
        { t: 7_650, v: HERO_HOME_REL, easing: 'hold' },
      ]),
      zoneId: new Track<string | null>([
        { t: 0, v: 'zone-ship' },
        { t: 2_950, v: null, easing: 'hold' },
        { t: 4_600, v: 'zone-review', easing: 'hold' },
        { t: 6_550, v: null, easing: 'hold' },
        { t: 7_650, v: 'zone-ship', easing: 'hold' },
      ]),
    },
  ],
  commentTexts: [
    {
      commentId: REPLY_COMMENT_ID,
      // Jules types 2.0–5.6s; snaps back to empty at 6.5s, AFTER the hover
      // bubble closes at 6.4s (invisible), so frame 0 == frame 8s.
      text: typeThenReset(REPLY_TEXT, 2_000, 5_600, 6_500),
    },
  ],
  uiFlags: {},
  actions: [
    { t: 1_850, run: () => hoverCommentPin(REPLY_COMMENT_ID, true) },
    { t: 6_400, run: () => hoverCommentPin(REPLY_COMMENT_ID, false) },
  ],
};
