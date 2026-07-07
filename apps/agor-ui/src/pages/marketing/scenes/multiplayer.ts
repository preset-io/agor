// Scene 1 — "multiplayer" (8s, loop-perfect).
// Ari drags the landing-hero-polish branch card from Ship → Review and back,
// Mina types her spatial comment, Jules inspects the cost-cockpit artifact.
// Every track returns to its t=0 value by 8000ms so the video loops seamlessly.
//
// Coordinates are flow-space (board units). Rest positions match
// demoStaticCursors so the video's first frame agrees with the static
// screenshot fixture. Tune visually via /demo/marketing-video?scene=multiplayer&play=1

import { clickPulses, type Keyframe, path, type SceneDefinition, Track } from '../timeline';

const DURATION = 8_000;

// Viewport framing: board content spans roughly x 60–2980, y 80–1730.
// Pane is 1920×1016 (1080 viewport minus 64px header) → zoom 0.56 centers it.
const BASE_VIEWPORT = { x: 109, y: 0, zoom: 0.56 };

// landing-hero-polish: zone-ship (60,650) + rel (70,110) → abs (130,760).
const HERO_OBJECT_ID = 'board-object-019ee88d-demo-branch-0000-000000000101';
const HERO_HOME_REL = { x: 70, y: 110 };
const HERO_HOME_ABS = { x: 130, y: 760 };
// Drop target: zone-review (820,650) + rel (140,750) → abs (960,1400).
const HERO_DROP_REL = { x: 140, y: 750 };
const HERO_DROP_ABS = { x: 960, y: 1400 };
// Raised midpoint gives the drag path a natural arc.
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

// Rest positions (must match demoStaticCursors).
const ARI_REST: [number, number] = [1370, 620];
const MINA_REST: [number, number] = [2550, 260];
const JULES_REST: [number, number] = [650, 820];

// Mina's spatial comment sits at branch multiplayer-presence (130,1170) + offset (420,80).
const COMMENT_ID = '019ee88d-demo-comment-0000-000000000301';
const COMMENT_TEXT = 'Can we keep the facepile capped but still show the +7 overflow?';
const COMMENT_POS: [number, number] = [620, 1300];

// Cost-cockpit app node: (620,80) 780×495 → center ~(1010,330).
const COCKPIT_CENTER: [number, number] = [1010, 330];

/** Toggle the spatial comment pin's React hover state so its preview bubble
 * shows the live-typed content. React's onMouseEnter/onMouseLeave respond to
 * dispatched mouseover/mouseout events. */
const hoverCommentPin = (hovered: boolean) => {
  const pin = document.querySelector('.react-flow__node-comment > div');
  pin?.dispatchEvent(
    new MouseEvent(hovered ? 'mouseover' : 'mouseout', {
      bubbles: true,
      relatedTarget: document.body,
    })
  );
};

/** Type text between t0–t1, hold, then erase quickly between t2–t3 so the
 * scene loops back to an empty comment. */
const typeAndErase = (
  text: string,
  t0: number,
  t1: number,
  t2: number,
  t3: number
): Track<string> => {
  const chars = [...text];
  const keyframes: Keyframe<string>[] = [{ t: 0, v: '' }];
  const typeStep = (t1 - t0) / chars.length;
  chars.forEach((_, index) => {
    const revealed = chars.slice(0, index + 1).join('');
    keyframes.push({
      t: t0 + typeStep * (index + 1),
      v: index + 1 < chars.length ? `${revealed}▍` : revealed,
      easing: 'hold',
    });
  });
  const eraseStep = (t3 - t2) / chars.length;
  chars.forEach((_, index) => {
    keyframes.push({
      t: t2 + eraseStep * (index + 1),
      v: chars.slice(0, chars.length - index - 1).join(''),
      easing: 'hold',
    });
  });
  return new Track(keyframes);
};

export const multiplayerScene: SceneDefinition = {
  name: 'multiplayer',
  durationMs: DURATION,
  viewport: new Track([{ t: 0, v: BASE_VIEWPORT }]),
  cursors: [
    {
      // Ari drags the branch card Ship → Review → Ship.
      userIndex: 1,
      color: '#06b6d4',
      pos: path([
        [0, ...ARI_REST],
        [800, heroGrabX, heroGrabY],
        [950, heroGrabX, heroGrabY, 'hold'],
        [1_780, heroMidX, heroMidY],
        [2_600, heroDropX, heroDropY],
        [3_200, heroDropX + 80, heroDropY - 70],
        [5_400, heroDropX, heroDropY],
        [5_550, heroDropX, heroDropY, 'hold'],
        [6_400, heroMidX, heroMidY],
        [7_200, heroGrabX, heroGrabY],
        [8_000, ...ARI_REST],
      ]),
      ripple: clickPulses([900, 2_700, 5_500, 7_300]),
    },
    {
      // Mina types her spatial comment.
      userIndex: 2,
      color: '#f97316',
      pos: path([
        [0, ...MINA_REST],
        [1_800, COMMENT_POS[0], COMMENT_POS[1]],
        [2_000, COMMENT_POS[0] - 20, COMMENT_POS[1] - 20],
        [4_600, COMMENT_POS[0] - 20, COMMENT_POS[1] - 20, 'hold'],
        [5_600, COMMENT_POS[0] + 80, COMMENT_POS[1] - 100],
        [7_600, ...MINA_REST],
      ]),
      ripple: clickPulses([1_900, 4_700]),
    },
    {
      // Jules inspects the cost-cockpit artifact.
      userIndex: 5,
      color: '#eab308',
      pos: path([
        [0, ...JULES_REST],
        [3_600, COCKPIT_CENTER[0], COCKPIT_CENTER[1]],
        [4_000, COCKPIT_CENTER[0] + 70, COCKPIT_CENTER[1] - 30],
        [4_400, COCKPIT_CENTER[0], COCKPIT_CENTER[1] - 60],
        [4_800, COCKPIT_CENTER[0] - 70, COCKPIT_CENTER[1] - 30],
        [5_200, COCKPIT_CENTER[0], COCKPIT_CENTER[1]],
        [7_400, ...JULES_REST],
      ]),
      ripple: clickPulses([5_300]),
    },
  ],
  nodePlacements: [
    {
      objectId: HERO_OBJECT_ID,
      // Positions flip rel↔abs at the exact instants zoneId flips, mirroring
      // the product's pin/unpin math so the node never jumps on screen.
      pos: new Track([
        { t: 0, v: HERO_HOME_REL },
        { t: 900, v: HERO_HOME_ABS, easing: 'hold' },
        { t: 950, v: HERO_HOME_ABS },
        { t: 1_780, v: HERO_ARC_MID },
        { t: 2_600, v: HERO_DROP_ABS },
        { t: 2_700, v: HERO_DROP_REL, easing: 'hold' },
        { t: 5_500, v: HERO_DROP_ABS, easing: 'hold' },
        { t: 5_550, v: HERO_DROP_ABS },
        { t: 6_400, v: HERO_ARC_MID },
        { t: 7_200, v: HERO_HOME_ABS },
        { t: 7_300, v: HERO_HOME_REL, easing: 'hold' },
      ]),
      zoneId: new Track<string | null>([
        { t: 0, v: 'zone-ship' },
        { t: 900, v: null, easing: 'hold' },
        { t: 2_700, v: 'zone-review', easing: 'hold' },
        { t: 5_500, v: null, easing: 'hold' },
        { t: 7_300, v: 'zone-ship', easing: 'hold' },
      ]),
    },
  ],
  commentTexts: [
    {
      commentId: COMMENT_ID,
      text: typeAndErase(COMMENT_TEXT, 2_000, 4_600, 7_300, 7_800),
    },
  ],
  uiFlags: {},
  actions: [
    // Open the comment pin's hover preview while Mina types (the bubble is
    // the only place the typed text is visible), close it before loop wrap.
    { t: 1_900, run: () => hoverCommentPin(true) },
    { t: 5_100, run: () => hoverCommentPin(false) },
  ],
};
