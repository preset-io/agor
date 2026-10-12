// Standalone clips, as data: the registry for tests/clips/*.spec.ts.
//
// The syllabus (support/syllabus.ts, tests/flow/) is one chained story from
// an empty workspace. Clips are independent shots: each starts from a known
// state, films one moment, and is exported on its own by
// `npm run clip -- <id>` (scripts/clip.ts). Specs are written against the
// studio (support/studio.ts): actors, a virtual camera, the seeded world.

export type ClipOutput =
  /** 1080p h264 master (always produced). */
  | 'master'
  /** agor.live renditions: 1600×900, 960×540, poster. */
  | 'site'
  /** Conference TV / Roku: 4K30 upscale with a silent AAC track. */
  | 'tv';

export type ClipStart =
  /** A seed's cached state (support/seeds.ts): the usual choice. */
  | { seed: string }
  /** Where another clip ended (its post-<id> checkpoint), for stacked scenes. */
  | { after: string }
  /** Any checkpoint by directory name (e.g. a syllabus pre-<lesson> one). */
  | { checkpoint: string }
  /** A brand-new workspace: only the bootstrap admin, onboarding not done. */
  | 'empty';

export interface ClipMeta {
  /** Stable id: the spec filename stem (tests/clips/<id>.spec.ts) and output name. */
  id: string;
  title: string;
  /** What the clip is for and where it will be used. */
  purpose: string;
  start: ClipStart;
  /**
   * Films real agent turns on camera (recorded into cassettes/clip-<id>.json
   * on the first --live take, replayed after).
   */
  agent?: boolean;
  /** 'split' puts two filmed actors side by side. Default 'single'. */
  layout?: 'single' | 'split';
  /**
   * Capture resolution. 4K (the default) gives the camera 2x of lossless
   * zoom; 1080 halves the load but can't zoom without softening.
   */
  capture?: '4k' | '1080';
  /** Beat sheet: what the viewer sees, in order. Keep it in sync with the spec. */
  script: string[];
  outputs: ClipOutput[];
  timeoutMs?: number;
}

export const CLIPS: ClipMeta[] = [
  {
    id: 'board-tour',
    title: 'A tour of a live team board',
    purpose: 'Pipeline smoke test and a candidate home-page establishing shot.',
    start: { seed: 'team-board' },
    script: [
      'Open the Donut Shop team board: four zones, branches in flight',
      'Push in on the branch being built, then on the review thread',
      'Pull back wide on the whole board',
    ],
    outputs: ['master', 'site'],
  },
  {
    id: 'two-cursors',
    title: 'Two people, one board',
    purpose: 'Multiplayer groundwork test; a candidate home-page clip.',
    start: { seed: 'team-board' },
    layout: 'single',
    script: [
      "Sam's view of the team board; Ada's live cursor is already there",
      "Ada drags her branch from Building to In review; it moves on Sam's screen",
      'Camera follows the card, then pulls back wide',
    ],
    outputs: ['master', 'site'],
  },
];

export function clipById(id: string): ClipMeta {
  const clip = CLIPS.find((c) => c.id === id);
  if (!clip) {
    throw new Error(`Unknown clip "${id}". Known: ${CLIPS.map((c) => c.id).join(', ')}`);
  }
  return clip;
}
