// Deterministic keyframe timeline for the marketing demo-video route.
// All motion on /demo/marketing-video is a pure function of a virtual clock
// `t` (ms) so the Playwright capture pipeline can step frames and get
// identical output every run. No wall-clock, no randomness.

import type { User } from '@agor-live/client';

export type Easing = 'linear' | 'easeInOut' | 'easeOutCubic' | 'hold';

export interface Keyframe<T> {
  t: number;
  v: T;
  /** Easing applied while interpolating INTO this keyframe. Default 'easeInOut'. */
  easing?: Easing;
}

const EASINGS: Record<Easing, (k: number) => number> = {
  linear: (k) => k,
  easeInOut: (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2),
  easeOutCubic: (k) => 1 - (1 - k) ** 3,
  // 'hold' keeps the previous value until the keyframe time is reached.
  hold: (k) => (k >= 1 ? 1 : 0),
};

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

const interpolate = <T>(a: T, b: T, k: number): T => {
  if (typeof a === 'number' && typeof b === 'number') {
    return lerp(a, b, k) as T;
  }
  if (typeof a === 'boolean' || typeof a === 'string') {
    return (k >= 1 ? b : a) as T;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(a as Record<string, unknown>)) {
      out[key] = interpolate(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        k
      );
    }
    return out as T;
  }
  return k >= 1 ? b : a;
};

export class Track<T> {
  private readonly keyframes: Keyframe<T>[];

  constructor(keyframes: Keyframe<T>[]) {
    this.keyframes = [...keyframes].sort((a, b) => a.t - b.t);
    if (this.keyframes.length === 0) {
      throw new Error('Track requires at least one keyframe');
    }
  }

  sample(t: number): T {
    const kfs = this.keyframes;
    if (t <= kfs[0].t) return kfs[0].v;
    const last = kfs[kfs.length - 1];
    if (t >= last.t) return last.v;
    let i = 1;
    while (kfs[i].t < t) i += 1;
    const prev = kfs[i - 1];
    const next = kfs[i];
    const span = next.t - prev.t;
    const k = span === 0 ? 1 : (t - prev.t) / span;
    const eased = EASINGS[next.easing ?? 'easeInOut'](k);
    return interpolate(prev.v, next.v, eased);
  }
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

/** Fires side effects (real DOM clicks etc.) exactly once as `t` crosses them.
 * Requires monotonically increasing `t`; backward scrubbing needs a reload. */
export interface ActionKeyframe {
  t: number;
  run: () => void;
}

export class ActionRunner {
  private readonly actions: ActionKeyframe[];
  private nextIndex = 0;

  constructor(actions: ActionKeyframe[]) {
    this.actions = [...actions].sort((a, b) => a.t - b.t);
  }

  advanceTo(t: number): void {
    while (this.nextIndex < this.actions.length && this.actions[this.nextIndex].t <= t) {
      this.actions[this.nextIndex].run();
      this.nextIndex += 1;
    }
  }

  reset(): void {
    this.nextIndex = 0;
  }
}

// ---------------------------------------------------------------------------
// Choreography helpers — sugar for building keyframe arrays.
// ---------------------------------------------------------------------------

/** [t, x, y, easing?] tuples → position track. */
export const path = (points: Array<[number, number, number, Easing?]>): Track<Vec2> =>
  new Track(points.map(([t, x, y, easing]) => ({ t, v: { x, y }, easing })));

const RIPPLE_DURATION_MS = 350;

/** Click-pulse track: ripple progress runs 0→1 over 350ms at each click time,
 * 0 elsewhere. Renderers draw an expanding, fading ring for 0 < v <= 1. */
export const clickPulses = (times: number[]): Track<number> => {
  const keyframes: Keyframe<number>[] = [{ t: 0, v: 0 }];
  for (const t of [...times].sort((a, b) => a - b)) {
    keyframes.push({ t: t - 1, v: 0, easing: 'hold' });
    keyframes.push({ t, v: 0.001, easing: 'linear' });
    keyframes.push({ t: t + RIPPLE_DURATION_MS, v: 1, easing: 'linear' });
    keyframes.push({ t: t + RIPPLE_DURATION_MS + 1, v: 0, easing: 'hold' });
  }
  return new Track(keyframes);
};

/** Per-character typewriter reveal between t0 and t1, with a trailing caret
 * while typing is in progress. */
export const typeText = (
  text: string,
  t0: number,
  t1: number,
  options: { caret?: string } = {}
): Track<string> => {
  const caret = options.caret ?? '▍';
  const chars = [...text];
  const keyframes: Keyframe<string>[] = [{ t: 0, v: '' }];
  const perChar = (t1 - t0) / Math.max(chars.length, 1);
  chars.forEach((_, index) => {
    const revealed = chars.slice(0, index + 1).join('');
    keyframes.push({
      t: t0 + perChar * (index + 1),
      v: index + 1 < chars.length ? revealed + caret : revealed,
      easing: 'hold',
    });
  });
  return new Track(keyframes);
};

/** Constant-value track. */
export const constant = <T>(v: T): Track<T> => new Track([{ t: 0, v }]);

// ---------------------------------------------------------------------------
// Scene model — consumed by MarketingVideoPage.
// ---------------------------------------------------------------------------

export interface CursorTimeline {
  /** Index into demoUsers. Ignored when `user` is provided. */
  userIndex: number;
  /** Explicit user override for cursors that aren't part of demoUsers
   * (e.g. agent-labeled cursors like AgorClaw). */
  user?: User;
  color: string;
  pos: Track<Vec2>;
  /** Ripple progress 0..1 (see clickPulses). */
  ripple?: Track<number>;
}

/** Labeled cursor in SCREEN space (page px, 1920×1080) rather than flow space.
 * Used when a named teammate interacts with UI that sits above the canvas
 * (the staged session panel, the Slack stage) where flow-space cursors would
 * be hidden behind the overlay. Rendered by MarketingVideoPage. */
export interface ScreenCursorTimeline {
  userIndex: number;
  user?: User;
  color: string;
  pos: Track<Vec2>;
  ripple?: Track<number>;
}

export interface NodePlacementTimeline {
  objectId: string;
  /** Position in flow coordinates — zone-relative while zoneId is set,
   * absolute while zoneId is null (mirrors product pin/unpin semantics). */
  pos: Track<Vec2>;
  zoneId: Track<string | null>;
}

export interface CommentTextTimeline {
  commentId: string;
  text: Track<string>;
}

export interface SceneDefinition {
  name: string;
  durationMs: number;
  viewport: Track<ViewportState>;
  cursors: CursorTimeline[];
  /** Labeled cursors rendered in screen space above panels/overlays. */
  screenCursors?: ScreenCursorTimeline[];
  nodePlacements: NodePlacementTimeline[];
  commentTexts: CommentTextTimeline[];
  /** Free-form scalar tracks for scene-specific UI (overlay reveal progress,
   * modal visibility, screen-space pointer position, ...). */
  uiFlags: Record<string, Track<number>>;
  /** Free-form string tracks for scene-specific staged text (composer
   * contents, typewritten replies, ...). */
  textTracks?: Record<string, Track<string>>;
  actions: ActionKeyframe[];
}
