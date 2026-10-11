// Standalone clips, as data: the registry for tests/clips/*.spec.ts.
//
// The syllabus (support/syllabus.ts, tests/flow/) is one chained story from
// an empty workspace. Clips are independent shots: each starts from a known
// workspace state (a checkpoint, or empty), films one thing, and is exported
// on its own by `npm run clip -- <id>` (scripts/clip.ts).
//
// Starting states come from the checkpoint ladder the flow leaves behind
// (~/.agor-e2e/checkpoints/pre-<lessonId>, refreshed whenever the flow runs),
// so a clip can open on "a board with a repo and branches" without replaying
// the onboarding on camera. A clip may also seed extra state itself before
// openLesson() (REST calls through the daemon, off camera).

export type ClipOutput =
  /** 1080p h264 master (always produced). */
  | 'master'
  /** agor.live renditions: 1600×900, 960×540, poster. */
  | 'site'
  /** Conference TV / Roku: 4K30 upscale with a silent AAC track. */
  | 'tv';

export interface ClipMeta {
  /** Stable id: the spec filename stem (tests/clips/<id>.spec.ts) and output name. */
  id: string;
  title: string;
  /** What the clip is for and where it will be used. */
  purpose: string;
  /**
   * Checkpoint to start from (a directory name in ~/.agor-e2e/checkpoints,
   * e.g. 'pre-07-parallel-worktrees'), or null to start from an empty
   * workspace. Run the flow once to (re)create the ladder.
   */
  startFrom: string | null;
  /** Needs AGOR_E2E_AGENT_MODE (makes real or replayed model calls). */
  agent: boolean;
  /** Beat sheet: what the viewer sees, in order. Keep it in sync with the spec. */
  script: string[];
  outputs: ClipOutput[];
}

export const CLIPS: ClipMeta[] = [
  {
    id: 'board-tour',
    title: 'A tour of a live board',
    purpose: 'Example clip and pipeline smoke test; a candidate home-page establishing shot.',
    startFrom: 'pre-07-parallel-worktrees',
    agent: false,
    script: [
      'Open the team board, already populated with a repo, branches, and zones',
      'Glide across the zones, pausing on each branch card',
      'Hover a card to show its sessions, then settle on the full board',
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
