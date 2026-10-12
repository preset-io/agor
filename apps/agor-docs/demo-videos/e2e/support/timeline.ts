// The take's timeline: everything the export step needs to cut, sync, and
// zoom a clip after the fact, written as JSONL while the clip records.
//
// All times are wall-clock milliseconds (Date.now()). Each filmed actor's
// frames carry the wall time they were painted (support/recorder.ts), so
// camera moves, clicks, and chapter marks land on the right frame no matter
// when each browser started recording.
//
// The file lives in the take directory beside the actors' videos
// (~/Desktop/agor_video/takes/<clipId>/timeline.jsonl). It is plain text on
// purpose: nudge a camera move's `ms` or `zoom` by hand and re-export with
// `npm run clip -- <id> --export-only` instead of re-shooting.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TEST_RESULTS_DIR } from './harness.ts';

// Beside (not inside) Playwright's results folder, which it wipes at the
// start of every run: takes must survive to be re-exported.
export const TAKES_DIR = path.join(path.dirname(TEST_RESULTS_DIR), 'takes');

/** A rectangle in CSS pixels of the actor's viewport. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Camera transition curve. */
export type Ease =
  /** Smootherstep: gentle start and landing. The default. */
  | 'smooth'
  /** Critically damped spring: quick start, long soft landing (Screen Studio's feel). */
  | 'spring'
  /** Constant speed: for slow drifts across a wide shot. */
  | 'linear';

export type TimelineEvent =
  | {
      type: 'actor';
      actor: string;
      /** Video file name inside the take dir (older takes recorded with Playwright's recorder). */
      video: string | null;
      /** Frames directory inside the take dir (support/recorder.ts), for filmed actors. */
      frames?: string | null;
      viewport: { width: number; height: number };
      /** Device pixels per CSS pixel the video was captured at. */
      scale: number;
    }
  /** The wall time the actor's sync flash was on screen (Playwright-recorder takes only). */
  | { type: 'sync'; actor: string; wall: number }
  /** The scene starts here: every filmed video is cut to begin at this instant. */
  | { type: 'ready'; wall: number }
  /**
   * Move the actor's camera to frame `rect` (null: back to the full frame)
   * over `ms`. `zoom` overrides the fit-to-rect zoom.
   */
  | {
      type: 'camera';
      actor: string;
      wall: number;
      rect: Rect | null;
      zoom?: number;
      ms: number;
      ease: Ease;
    }
  /** Where an actor's cursor came to rest (used to check it stays in frame). */
  | { type: 'cursor'; actor: string; wall: number; x: number; y: number }
  | { type: 'click'; actor: string; wall: number; x: number; y: number }
  /** A named point for editing clips together later (chapters, cut points). */
  | { type: 'mark'; label: string; wall: number }
  | { type: 'end'; wall: number };

export class Timeline {
  readonly file: string;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'timeline.jsonl');
    writeFileSync(this.file, '');
  }

  log(event: TimelineEvent): void {
    appendFileSync(this.file, `${JSON.stringify(event)}\n`);
  }
}

export function takeDir(clipId: string): string {
  return path.join(TAKES_DIR, clipId);
}

export function readTimeline(dir: string): TimelineEvent[] {
  const file = path.join(dir, 'timeline.jsonl');
  if (!existsSync(file)) throw new Error(`No timeline in ${dir} (record the clip first)`);
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TimelineEvent);
}
