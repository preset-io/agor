// biome-ignore-all lint/plugin/noHardcodedColorLiteral: demo-only marketing fixture palette
// Scene — "teammateReveal" (8s, loop-perfect, booth-loop candidate).
// Camera pushes in on teammate-heartbeat — a scheduled AI teammate, not a
// human-started session — while AgorClaw (the agent-labeled cursor also used
// in boards.ts) sweeps in and click-pulses its own card, presenting the work
// it did unattended: daily backlog scan, Slack digest, three branches spawned.
// No new fixtures — the branch and its story are already in fixtureData.
// Tune via /demo/marketing-video?scene=teammateReveal&play=1

import { demoAgentUser } from '../fixtureData';
import { clickPulses, path, type SceneDefinition, Track, type ViewportState } from '../timeline';

const DURATION = 8_000;

const PANE_CENTER = { x: 960, y: 508 };
const focusOn = (fx: number, fy: number, zoom: number): ViewportState => ({
  x: PANE_CENTER.x - fx * zoom,
  y: PANE_CENTER.y - fy * zoom,
  zoom,
});

const WIDE: ViewportState = { x: 109, y: 0, zoom: 0.56 };
// zone-teammates spans (1580,650)-(2980,1730); teammate-heartbeat sits at
// zone-relative (90,510) -> absolute (1670,1160). Card runs tall (3
// sessions + notes), so bias the focus toward its middle and back the zoom
// off enough that the bottom session row stays in frame.
const CARD_FOCUS = focusOn(1850, 1430, 1.25);

const CARD_TOP_LEFT = { x: 1670, y: 1160 };
const CLAW_REST: [number, number] = [2600, 900];
// Same relative offsets as boards.ts's AgorClaw beat (header point, session
// row), applied to this card's top-left instead of the hero drop point.
const CLAW_HEADER: [number, number] = [CARD_TOP_LEFT.x + 210, CARD_TOP_LEFT.y + 40];
const CLAW_SESSION_ROW: [number, number] = [CARD_TOP_LEFT.x + 190, CARD_TOP_LEFT.y + 160];

export const teammateRevealScene: SceneDefinition = {
  name: 'teammateReveal',
  durationMs: DURATION,
  viewport: new Track([
    { t: 0, v: WIDE },
    { t: 1_200, v: WIDE, easing: 'hold' },
    { t: 2_800, v: CARD_FOCUS },
    { t: 6_800, v: CARD_FOCUS, easing: 'hold' },
    { t: 8_000, v: WIDE },
  ]),
  cursors: [
    {
      userIndex: 0,
      user: demoAgentUser,
      color: '#34d399',
      pos: path([
        [0, ...CLAW_REST],
        [2_800, CLAW_REST[0], CLAW_REST[1], 'hold'],
        [3_300, ...CLAW_HEADER],
        [3_600, CLAW_HEADER[0], CLAW_HEADER[1], 'hold'],
        [4_200, ...CLAW_SESSION_ROW],
        [4_500, CLAW_SESSION_ROW[0], CLAW_SESSION_ROW[1], 'hold'],
        [6_700, ...CLAW_REST],
        [8_000, CLAW_REST[0], CLAW_REST[1], 'hold'],
      ]),
      ripple: clickPulses([3_650, 4_550]),
    },
  ],
  nodePlacements: [],
  commentTexts: [],
  uiFlags: {},
  actions: [],
};
