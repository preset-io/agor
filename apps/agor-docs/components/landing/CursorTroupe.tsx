'use client';

import { useEffect, useRef, useState } from 'react';
import { CRT_INTRO_ATTR } from '../../lib/crtIntro';
import styles from './CursorTroupe.module.css';

/**
 * Three cursors (Maya, Ari, and Sam in the code; unnamed on screen) follow
 * the reader down the home page and act out each section's point, with
 * three guest cursors who join for the hero and the final CTA. A director picks the section on stage (sections mark themselves
 * with data-troupe-section) and plays its beat once.
 *
 * Positions live in page coordinates and every target is re-read from the
 * page each frame (an element, a text range, or one glyph's counter), so
 * cursors stay locked to what they're touching while the page scrolls. They
 * idle at two-thirds size and grow to full size to do things; gestures are
 * motion only. Beats can also nudge the page: light a hover state, cue the
 * hero's "team" letter wave, or drive an element (the board panel they haul
 * in, the "confidence" they stretch). Scrolling back up finds them parked
 * where each beat ended; once they've left at the final CTA they stay gone.
 * Clicking the hero's Agor logo starts the show again. On by default;
 * `?cursors=off` turns it off for that browser (`?cursors` turns it back on).
 * Never under reduced motion or on touch.
 */

const ENABLED_KEY = 'agor-cursor-troupe';

const CAST = [
  { name: 'Maya', color: '#f5a3c7', hz: 2.1, extra: false },
  { name: 'Ari', color: '#6fdcf0', hz: 1.8, extra: false },
  { name: 'Sam', color: '#f2d27a', hz: 1.55, extra: false },
  // Guests: they join the hero's huddle and the final CTA's ring.
  { name: 'Lee', color: '#b9f18c', hz: 1.9, extra: true },
  { name: 'Kit', color: '#c3a6ff', hz: 1.7, extra: true },
  { name: 'Rho', color: '#ff9f7a', hz: 2.0, extra: true },
] as const;

const SECTIONS = [
  'hero',
  'problem',
  'work-together',
  'board',
  'teammates',
  'command-center',
  'roster',
  'governance',
  'final',
] as const;
type SectionId = (typeof SECTIONS)[number];

interface RectLike {
  getBoundingClientRect(): DOMRect;
}
type Anchor = (root: HTMLElement) => Element | RectLike | null | undefined;
type Gesture = 'wave' | 'look' | 'jump' | 'heave' | 'tugUp' | 'tugDown' | 'click';

interface Mark {
  at: number;
  anchor: Anchor;
  /** Offset as a fraction of the anchor's size from its center (-0.5..0.5). */
  fx?: number;
  fy?: number;
  dx?: number;
  dy?: number;
  /** Follow stiffly (it's holding or riding the thing). */
  lock?: boolean;
  /** Follow loosely at first, then lock after this many seconds. */
  lockAfter?: number;
  /** Turn to point at this anchor's center. */
  point?: Anchor;
  /** Circle the target point; squash < 1 flattens it into an ellipse. */
  orbit?: { r: number; speed: number; phase: number; squash?: number };
  /** Bounce around inside the anchor's box, screensaver style (px/s). */
  roam?: { speed: number; angle: number };
  /** Size while at this mark (overrides idle/busy sizing). */
  size?: number;
  /** A small nervous jitter. */
  tremble?: boolean;
  /** Play role k of the cursors recorded in the panel video's track. */
  perform?: number;
}

interface Part {
  marks: Mark[];
  cues?: Array<{ at: number; gesture: Gesture }>;
  /** Hidden until this time. */
  appear?: number;
  /** Fades out from this time and stays gone. */
  vanish?: number;
  /** Keep the last position when the anchor goes away (instead of fading). */
  hold?: boolean;
  /** Extra windows (beat seconds) when this cursor is at work. */
  busy?: Array<[number, number]>;
  /** Read a press from the anchor's data-pressed (the demo's own clicks). */
  pressFromAnchor?: boolean;
  /** Full size while the anchor is visible (opacity > 0.5), idle otherwise. */
  sizeFromAnchor?: boolean;
}

interface Beat {
  delay: number;
  /** Is this section on stage, given its rect, the viewport height, and root? */
  active: (rect: DOMRect, vh: number, root: HTMLElement) => boolean;
  /** Hide the cursors behind this rect (a hole in the layer) until `until`. */
  mask?: { anchor: Anchor; until: number };
  /** Show the cursors only inside these ellipses, from `from` on. */
  clip?: { anchors: Anchor[]; from: number };
  /** One part per cast member in this beat (by index; missing = not in it). */
  parts: Array<Part | undefined>;
  /** One-shot side effects on the page, e.g. lighting a hover state. */
  events?: Array<{ at: number; run: (root: HTMLElement) => void }>;
  /** Drive an element: 'before' (not reached yet), 'play' (with t), 'done'. */
  drive?: (root: HTMLElement, phase: 'before' | 'play' | 'done', t: number) => void;
  /** Sets a data attribute on <html> while on stage. */
  htmlFlag?: string;
}

const q =
  (selector: string): Anchor =>
  (root) =>
    root.querySelector(selector);
const nth =
  (selector: string, index: number): Anchor =>
  (root) =>
    root.querySelectorAll(selector)[index];
const at = (x: number, y: number): RectLike => ({
  getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
});
/** A point on an ellipse around an anchor's center (angle in degrees, 0 = right). */
const around =
  (anchor: Anchor, rx: number, ry: number, deg: number): Anchor =>
  (root) => {
    const r = anchor(root)?.getBoundingClientRect();
    if (!r) return null;
    const a = (deg * Math.PI) / 180;
    return at(r.left + r.width / 2 + Math.cos(a) * rx, r.top + r.height / 2 + Math.sin(a) * ry);
  };
/** Just off the viewport's left, bottom, or right edge, level with an anchor. */
const offstage =
  (anchor: Anchor, side: 0 | 1 | 2): Anchor =>
  (root) => {
    const r = anchor(root)?.getBoundingClientRect();
    if (!r) return null;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (side === 0) return at(-60, cy);
    if (side === 1) return at(cx, window.innerHeight + 60);
    return at(window.innerWidth + 60, cy);
  };

/** A Range around `text` inside `el` (or one character of it). */
function textRange(el: Element | null | undefined, text: string, char?: number): Range | null {
  if (!el) return null;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = node.textContent?.indexOf(text) ?? -1;
    if (index >= 0) {
      const range = document.createRange();
      const start = index + (char ?? 0);
      range.setStart(node, start);
      range.setEnd(node, char === undefined ? index + text.length : start + 1);
      return range;
    }
  }
  return null;
}

let measure: CanvasRenderingContext2D | null = null;
/** The ink box of a text range (where the glyphs actually draw), from font metrics. */
function inkRect(range: Range | null): DOMRect | null {
  const parent = range?.startContainer.parentElement;
  if (!range || !parent) return null;
  measure ??= document.createElement('canvas').getContext('2d');
  if (!measure) return null;
  const cs = getComputedStyle(parent);
  measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = measure.measureText(range.toString());
  const box = range.getBoundingClientRect();
  const content = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const baseline = box.top + (m.fontBoundingBoxAscent * box.height) / content;
  return new DOMRect(
    box.left - m.actualBoundingBoxLeft,
    baseline - m.actualBoundingBoxAscent,
    m.actualBoundingBoxLeft + m.actualBoundingBoxRight,
    m.actualBoundingBoxAscent + m.actualBoundingBoxDescent
  );
}

/** The counter (the hole) of a glyph like "o", from its font metrics. */
function counterRect(range: Range | null): DOMRect | null {
  const parent = range?.startContainer.parentElement;
  if (!range || !parent) return null;
  measure ??= document.createElement('canvas').getContext('2d');
  if (!measure) return null;
  const cs = getComputedStyle(parent);
  measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = measure.measureText(range.toString());
  const box = range.getBoundingClientRect();
  const content = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const baseline = box.top + (m.fontBoundingBoxAscent * box.height) / content;
  const inkTop = baseline - m.actualBoundingBoxAscent;
  const inkBottom = baseline + m.actualBoundingBoxDescent;
  const inkLeft = box.left - m.actualBoundingBoxLeft;
  const inkRight = box.left + m.actualBoundingBoxRight;
  // The stroke eats more of the glyph the heavier the weight.
  const weight = Number.parseInt(cs.fontWeight, 10) || 400;
  const stroke = 0.05 + (0.17 * Math.min(600, Math.max(100, weight)) - 17) / 500;
  const sw = (inkRight - inkLeft) * stroke;
  const sh = (inkBottom - inkTop) * stroke * 0.9;
  return new DOMRect(
    inkLeft + sw,
    inkTop + sh,
    inkRight - inkLeft - 2 * sw,
    inkBottom - inkTop - 2 * sh
  );
}
const counterOf =
  (find: (root: HTMLElement) => Range | null): Anchor =>
  (root) => {
    const rect = counterRect(find(root));
    return rect ? { getBoundingClientRect: () => rect } : null;
  };

const centerBand = (r: DOMRect, vh: number) => r.top < vh * 0.6 && r.bottom > vh * 0.4;

// Hero
const pill = q('[class*="homeBadge"]');
/** The hero logo's dots (HeroLogo): top, bottom-left, and right. */
const logoDot = (i: number): Anchor => nth('[data-logo-dot]', [0, 2, 3][i]);
// After the CRT intro (lib/crtIntro.ts) the three burst out of the spot its
// screen collapsed to, the middle of the viewport, instead of the logo.
const fromCrt = () => document.documentElement.getAttribute(CRT_INTRO_ATTR) === 'done';
const crtDot: Anchor = () => ({
  getBoundingClientRect: () =>
    new DOMRect(window.innerWidth / 2 - 1, window.innerHeight / 2 - 1, 2, 2),
});
const emergeFrom =
  (i: number): Anchor =>
  (root) =>
    fromCrt() ? crtDot(root) : logoDot(i)(root);
const ROW_ITEM = 'a[class*="homeRowItem"]';
const rowItem = (i: number) => nth(ROW_ITEM, i);
const team = q('[data-wave-word]');
const heroButton = (i: number): Anchor =>
  i === 2
    ? () => document.querySelector('header [class*="ctaSlot"] a')
    : nth('[class*="homeCtaRow"] > *', i);
// Problem: "Don’t let AI silo your team" has three o's.
const problemHeading = (root: HTMLElement) => root.querySelector('h2');
const O_COUNTERS = [
  counterOf((root) => textRange(problemHeading(root), 'Don', 1)),
  counterOf((root) => textRange(problemHeading(root), 'silo', 3)),
  counterOf((root) => textRange(problemHeading(root), 'your', 1)),
];
// Work together
const demoCursor = (i: number) => q(`[data-troupe-cursor="${i}"]`);
// Board
const boardPanel = q('[data-troupe="board-panel"]');

interface CursorTrack {
  fps: number;
  frameCount: number;
  /** Per cursor id: one [x, y, ripple] (0..1 of the video frame) or null per frame. */
  cursors: Record<string, { color: string; frames: Array<[number, number, number] | null> }>;
  /** Roles: cursor ids in order of first appearance. */
  roles?: string[];
}
const tracks = new Map<string, CursorTrack | 'loading' | 'missing'>();
function loadTrack(url: string): CursorTrack | null {
  const cached = tracks.get(url);
  if (cached === undefined) {
    tracks.set(url, 'loading');
    fetch(url)
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((track: CursorTrack) => {
        const first = (id: string) => track.cursors[id].frames.findIndex(Boolean);
        track.roles = Object.keys(track.cursors).sort(
          (a, b) => first(a) - first(b) || (a < b ? -1 : 1)
        );
        tracks.set(url, track);
      })
      .catch(() => tracks.set(url, 'missing'));
    return null;
  }
  return typeof cached === 'string' ? null : cached;
}
// Which friend plays which role rotates each time a clip starts (or loops),
// tag-team style: in a two-role clip the two on the sidelines swap in next
// time. `since` lets the troupe glide into a new clip's roles before locking.
const clip = { key: '', last: 0, offset: 0, since: 0 };
function clipFor(video: HTMLVideoElement, url: string) {
  const now = performance.now();
  if (url !== clip.key || video.currentTime < clip.last - 0.5) {
    clip.offset = clip.key ? (clip.offset + 2) % 4 : 0;
    clip.key = url;
    clip.since = now;
  }
  clip.last = video.currentTime;
  return { offset: clip.offset, age: (now - clip.since) / 1000 };
}

/** Where cast slot k's role is right now in the panel's video (viewport px). */
function performAt(
  root: HTMLElement,
  k: number
): { x: number; y: number; ripple: number; age: number } | null {
  const video = root.querySelector<HTMLVideoElement>('video[data-troupe-video]');
  const url = video?.dataset.troupeVideo;
  if (!video || !url) return null;
  const track = loadTrack(url);
  if (!track?.roles) return null;
  const { offset, age } = clipFor(video, url);
  const id = track.roles[(k - offset + 4) % 4];
  if (!id) return null;
  const index = Math.min(track.frameCount - 1, Math.floor(video.currentTime * track.fps));
  const frame = track.cursors[id].frames[index];
  if (!frame) return null;
  const r = video.getBoundingClientRect();
  // Tracks keep off-frame tips (the camera pans past them): hug the edge.
  const clamp = (v: number) => Math.min(0.985, Math.max(0.015, v));
  return {
    x: r.left + clamp(frame[0]) * r.width,
    y: r.top + clamp(frame[1]) * r.height,
    ripple: frame[2],
    age,
  };
}

/** "What needs you" still: where the glowing card sits in the screenshot (0..1). */
const LIT_CARD = { left: 0.041, top: 0.127, right: 0.479, bottom: 0.62 };
/** Spots around the lit card for friends who are just interested in it. */
function aroundLitCard(
  root: HTMLElement,
  k: number,
  t: number
): { x: number; y: number; cx: number; cy: number } | null {
  const img = root.querySelector<HTMLImageElement>('[data-troupe="board-panel"] img');
  if (!img?.naturalWidth) return null;
  // The still is object-fit: contain; find the drawn image's box.
  const box = img.getBoundingClientRect();
  const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  const x0 = box.left + (box.width - w) / 2;
  const y0 = box.top + (box.height - h) / 2;
  const cx = x0 + ((LIT_CARD.left + LIT_CARD.right) / 2) * w;
  const cy = y0 + ((LIT_CARD.top + LIT_CARD.bottom) / 2) * h;
  // Under and beside the card, each bobbing a little on its own beat.
  const spots = [
    [LIT_CARD.left + 0.06, LIT_CARD.bottom + 0.07],
    [(LIT_CARD.left + LIT_CARD.right) / 2, LIT_CARD.bottom + 0.1],
    [LIT_CARD.right - 0.05, LIT_CARD.bottom + 0.07],
    [LIT_CARD.right + 0.05, (LIT_CARD.top + LIT_CARD.bottom) / 2],
  ];
  const [sx, sy] = spots[k % spots.length];
  return {
    x: x0 + sx * w + Math.sin(t * 1.6 + k * 1.9) * 5,
    y: y0 + sy * h + Math.cos(t * 1.3 + k * 2.4) * 4,
    cx,
    cy,
  };
}
// Teammates
const RING_NODE = 'a[class*="ringNode"]';
const ringNode = (i: number) => nth(RING_NODE, i);
const ringHub = q('[class*="ringHub"]');
// Command center
const ccHeading = q('h2');
// Roster
const LINKED_BLIP = 'a[class*="radarBlip"]';
const blip = (i: number) => nth(LINKED_BLIP, i);
const radarScope = q('[class*="radarScope"]');
const rosterLink = q('a[href="/agent-roster"]');
const ROSTER_PARK = 5.8;
/** Just outside the radar, `lag` degrees behind its sweep. */
const chaseSweep =
  (lag: number): Anchor =>
  (root) => {
    const scope = radarScope(root)?.getBoundingClientRect();
    const sweep = root.querySelector('[class*="radarSweep"]');
    if (!scope || !sweep) return null;
    const m = new DOMMatrixReadOnly(getComputedStyle(sweep).transform);
    // The sweep's 0° is straight up, turning clockwise.
    const sweepDeg = (Math.atan2(m.b, m.a) * 180) / Math.PI;
    const a = ((sweepDeg - lag - 90) * Math.PI) / 180;
    const r = scope.width / 2 + 24;
    return at(
      scope.left + scope.width / 2 + Math.cos(a) * r,
      scope.top + scope.height / 2 + Math.sin(a) * r
    );
  };
// Governance
const confidenceWord = q('h2 [class*="compoundWord"]');
/** The ink box of the final "e" of "confidence" (it grows as they stretch it). */
const lastE: Anchor = (root) => {
  const range = textRange(confidenceWord(root) as Element | null, 'confidence', 9);
  const rect = inkRect(range);
  return rect ? { getBoundingClientRect: () => rect } : null;
};
const BUS_DOT = '[class*="busNodeDot"]';
const busDot = (i: number) => nth(BUS_DOT, i);
// Final
const together = q('[data-troupe="together"]');
const ctaButton = (i: number) => nth('[class*="heroActions"] > *', i);

const hover = (el?: Element | RectLike | null) =>
  el instanceof Element &&
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: null }));
const unhover = (el?: Element | RectLike | null) =>
  el instanceof Element &&
  el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
/** CSS :hover can't be faked; these rows style [data-troupe-hover] the same. */
const lightRow = (root: HTMLElement, index: number | null) => {
  root.querySelectorAll(ROW_ITEM).forEach((item, i) => {
    item.toggleAttribute('data-troupe-hover', i === index);
  });
};
const setHtmlFlag = (name: string, on: boolean) =>
  document.documentElement.toggleAttribute(name, on);

/** Progress (0..1) through a series of pulls: [start, end, from, to]. */
function pulled(pulls: Array<[number, number, number, number]>, t: number): number {
  let p = 0;
  for (const [a, b, from, to] of pulls) {
    if (t >= b) p = to;
    else if (t > a) p = from + (to - from) * (1 - (1 - (t - a) / (b - a)) ** 3);
  }
  return p;
}

// Board: the panel is hauled in from the right in three heaves.
const BOARD_PULLS: Array<[number, number, number, number]> = [
  [0.9, 1.35, 0, 0.3],
  [1.6, 2.05, 0.3, 0.62],
  [2.3, 2.9, 0.62, 1],
];
/** When the haul is done and the troupe takes its roles. */
const BOARD_HAULED = 2.9;
// Per panel: the transform last written, and its untransformed left edge
// (measured once per viewport width, not every frame, so the drive never
// forces layout while the page scrolls).
const boardState = new WeakMap<
  Element,
  { offset: string; left: number; vw: number; played: boolean }
>();
function driveBoard(root: HTMLElement, phase: 'before' | 'play' | 'done', t: number) {
  const panel = boardPanel(root) as HTMLElement | null;
  if (!panel) return;
  const video = panel.querySelector('video');
  let state = boardState.get(panel);
  if (phase === 'done') {
    if (state && state.offset) {
      panel.style.transform = '';
      state.offset = '';
    }
    if (state && !state.played && video) {
      state.played = true;
      video.play().catch(() => {});
    }
    return;
  }
  const vw = window.innerWidth;
  if (!state || state.vw !== vw) {
    const prev = panel.style.transform;
    panel.style.transform = '';
    state = {
      offset: '',
      left: panel.getBoundingClientRect().left,
      vw,
      played: state?.played ?? false,
    };
    panel.style.transform = prev;
    boardState.set(panel, state);
  }
  // Peek ~70px of the panel's left edge in from the viewport's right edge.
  const start = Math.max(0, vw - 70 - state.left);
  const progress = phase === 'play' ? pulled(BOARD_PULLS, t) : 0;
  const offset = start * (1 - progress);
  const transform = offset > 0.5 ? `translateX(${offset.toFixed(0)}px)` : '';
  if (transform !== state.offset) {
    panel.style.transform = transform;
    state.offset = transform;
  }
  // The clip waits at its first frame until it's hauled in, then plays.
  if (video) {
    if (progress < 1) {
      if (!video.paused) video.pause();
      if (video.currentTime > 0.05) video.currentTime = 0;
      state.played = false;
    } else if (!state.played) {
      state.played = true;
      video.play().catch(() => {});
    }
  }
}

// Governance: "confidence" starts at heading size and is stretched to full.
const STRETCH_PULLS: Array<[number, number, number, number]> = [
  [1.5, 2.1, 0, 0.35],
  [2.5, 3.1, 0.35, 0.7],
  [3.5, 4.3, 0.7, 1],
];
const fullSizes = new WeakMap<Element, number>();
function driveConfidence(root: HTMLElement, phase: 'before' | 'play' | 'done', t: number) {
  const word = confidenceWord(root) as HTMLElement | null;
  const heading = word?.parentElement;
  if (!word || !heading) return;
  if (phase === 'done') {
    if (fullSizes.has(word)) {
      word.style.fontSize = '';
      fullSizes.delete(word);
    }
    return;
  }
  if (!fullSizes.has(word)) {
    word.style.fontSize = '';
    fullSizes.set(word, Number.parseFloat(getComputedStyle(word).fontSize));
  }
  const full = fullSizes.get(word) ?? 0;
  const base = Number.parseFloat(getComputedStyle(heading).fontSize);
  const p = phase === 'play' ? pulled(STRETCH_PULLS, t) : 0;
  word.style.fontSize = `${(base + (full - base) * p).toFixed(1)}px`;
}

const ROW_SWEEP = [0, 1, 2, 3, 4].map((k) => 1.4 + k * 0.38);
const HERO_GATHER = ROW_SWEEP[4] + 0.6;
const HERO_FRIENDS = HERO_GATHER + 0.9;
// Around "team": the three mains, then the three guests in between.
const TEAM_SPOTS = [200, 340, 90, 140, 40, 270];

const BEATS: Record<SectionId, Beat> = {
  // Out from behind the Multiplayer AI pill. Ari sweeps the landing-page row
  // along the bottom, lighting each link; all three gather around "team"
  // pointing in, and its letters do a wave. Then three friends pop out of
  // Sign up, Book a demo, and Try Agor Cloud to join the huddle.
  // They wait for the logo's dots to land, then emerge from behind them
  // (after the CRT intro: out of the dot its screen collapsed to).
  hero: {
    delay: 0,
    active: (r, vh, root) =>
      r.bottom > vh * 0.45 && (fromCrt() || Boolean(root.querySelector('[data-dots-landed]'))),
    parts: [0, 1, 2, 3, 4, 5].map((i): Part => {
      const spot = around(team, 40, 19, TEAM_SPOTS[i]);
      if (i >= 3) {
        const appear = HERO_FRIENDS + (i - 3) * 0.15;
        return {
          appear,
          marks: [
            { at: 0, anchor: heroButton(i - 3) },
            { at: appear + 0.15, anchor: spot, point: team },
          ],
          busy: [[appear, appear + 1.4]],
        };
      }
      return {
        appear: 0,
        marks: [
          // A speck behind its dot, then zooming out of it.
          { at: 0, anchor: emergeFrom(i), size: 0.06, lock: true },
          { at: 0.12 + i * 0.14, anchor: pill, fx: (i - 1) * 0.6, dx: (i - 1) * 40, dy: 44 },
          ...(i === 1
            ? ROW_SWEEP.map((when, k) => ({ at: when, anchor: rowItem(k), fx: -0.3, fy: -0.2 }))
            : []),
          { at: i === 1 ? HERO_GATHER : 1.6 + i * 0.2, anchor: spot, point: team },
        ],
        cues: [{ at: 0.9 + i * 0.25, gesture: 'look' as const }],
        busy: [i === 1 ? [1.2, HERO_GATHER + 1] : [HERO_GATHER, HERO_GATHER + 1.6]] as Array<
          [number, number]
        >,
      };
    }),
    events: [
      ...ROW_SWEEP.map((when, k) => ({
        at: when + 0.15,
        run: (root: HTMLElement) => lightRow(root, k),
      })),
      { at: HERO_GATHER + 0.2, run: (root: HTMLElement) => lightRow(root, null) },
      { at: HERO_GATHER + 0.9, run: () => setHtmlFlag('data-troupe-wave', true) },
    ],
  },
  // Siloed: one trapped in each "o" of "Don’t let AI silo your", bouncing
  // around in it screensaver style and trembling, shown only inside it.
  problem: {
    delay: 0.2,
    active: (r, vh) => r.top < vh * 0.55 && r.bottom > vh * 0.5,
    clip: { anchors: O_COUNTERS, from: 0.9 },
    parts: O_COUNTERS.map((counter, i) => ({
      marks: [
        { at: 0, anchor: counter, dy: -70 },
        { at: 0.2 + i * 0.15, anchor: counter, size: 0.55 },
        {
          at: 0.9,
          anchor: counter,
          size: 0.55,
          roam: { speed: 16 + i * 5, angle: 0.8 + i * 2.2 },
          tremble: true,
        },
      ],
    })),
  },
  // The demo's Maya, Ari, and Sam are these three: follow their markers
  // (the demo hides its own while we're here) and press when they press.
  // They ease over first rather than snapping to the demo's off-board starts.
  'work-together': {
    delay: 0,
    active: (r, vh) => r.top < vh * 0.7 && r.bottom > vh * 0.3,
    htmlFlag: 'data-troupe-wt',
    parts: [0, 1, 2].map((i) => ({
      marks: [{ at: 0, anchor: demoCursor(i), fx: -0.5, fy: -0.5, dx: 2, dy: 1, lockAfter: 1.4 }],
      hold: true,
      pressFromAnchor: true,
      sizeFromAnchor: true,
    })),
  },
  // Three heaves to haul the media panel on screen from the right.
  board: {
    delay: 0.2,
    active: (r, vh) => r.top < vh * 0.65 && r.bottom > vh * 0.35,
    drive: driveBoard,
    // Then they *are* the video's cursors: the clean cut plays and each takes
    // a role from its recorded track (a fourth friend joins for the boards
    // clip). Roles the current clip doesn't have watch from under the panel.
    parts: [
      ...[-0.28, 0, 0.28].map(
        (fy, i): Part => ({
          marks: [
            { at: 0, anchor: boardPanel, fx: -0.5, fy, dx: 16 },
            { at: 0.6, anchor: boardPanel, fx: -0.5, fy, dx: 16, lock: true },
            { at: BOARD_HAULED + 0.1, anchor: boardPanel, perform: i },
          ],
          cues: BOARD_PULLS.map(([a]) => ({ at: a - 0.25, gesture: 'heave' as const })),
          busy: [[0.5, BOARD_HAULED + 0.1]],
        })
      ),
      {
        marks: [
          { at: 0, anchor: offstage(boardPanel, 2) },
          { at: BOARD_HAULED - 0.3, anchor: boardPanel, perform: 3 },
        ],
      },
    ],
  },
  // Ari laps the ring, lighting each node; then all three point at Shared
  // ownership: the team owns it.
  teammates: {
    delay: 0.3,
    active: centerBand,
    parts: [
      {
        marks: [
          { at: 0, anchor: ringHub, fx: -0.32, fy: 0.1 },
          { at: 3.2, anchor: ringNode(0), dx: -62, dy: 56, point: ringNode(0) },
        ],
        cues: [{ at: 1.4, gesture: 'look' }],
      },
      {
        marks: [
          ...[1, 2, 3, 4, 5, 6, 0].map((n, k) => ({
            at: 0.3 + 0.34 * k,
            anchor: ringNode(n),
            fx: 0.18,
            fy: 0.22,
          })),
          { at: 3.3, anchor: ringNode(0), dy: 86, point: ringNode(0) },
        ],
        busy: [[0.2, 4.4]],
      },
      {
        marks: [
          { at: 0, anchor: ringHub, fx: 0.32, fy: 0.1 },
          { at: 3.4, anchor: ringNode(0), dx: 62, dy: 56, point: ringNode(0) },
        ],
        cues: [{ at: 1.9, gesture: 'look' }],
      },
    ],
    events: [1, 2, 3, 4, 5, 6, 0].map((n, k) => ({
      at: 0.45 + 0.34 * k,
      run: (root: HTMLElement) => hover(ringNode(n)(root)),
    })),
  },
  // Not much to do here yet (the section is getting a redesign): they take
  // their seats beside the heading and look the place over.
  'command-center': {
    delay: 0.3,
    active: centerBand,
    parts: [0, 1, 2].map((i) => ({
      marks: [{ at: 0, anchor: ccHeading, fx: 0.5, dx: 40 + i * 34, fy: -0.2 + i * 0.25 }],
      cues: [{ at: 1.2 + i * 0.5, gesture: 'look' as const }],
    })),
  },
  // Maya introduces a few teammates one by one (the radar shows one card at
  // a time); Ari and Sam circle just outside the scope, chasing its sweep and
  // pointing in at it.
  roster: {
    delay: 0.3,
    active: centerBand,
    parts: [
      {
        marks: [0, 1, 2, 3, 4].map((k) => ({
          at: 0.2 + k * 1.1,
          anchor: blip(k),
          fx: 0.18,
          fy: -0.05,
        })),
        busy: [[0, 6]] as Array<[number, number]>,
      },
      ...[18, 44].map((lag) => ({
        marks: [
          { at: 0, anchor: chaseSweep(lag), point: radarScope },
          { at: 0.9, anchor: chaseSweep(lag), point: radarScope, lock: true },
        ],
      })),
    ]
      .map(
        (part, i): Part => ({
          // About a lap of the sweep, then a tight huddle under the link.
          ...part,
          marks: [
            ...part.marks,
            {
              at: ROSTER_PARK + i * 0.15,
              anchor: rosterLink,
              fx: -0.3,
              dx: i * 14,
              fy: 0.5,
              dy: 18,
            },
          ],
        })
      )
      .concat(
        // The three friends come in from off screen to join the huddle.
        ([0, 1, 2] as const).map(
          (side): Part => ({
            marks: [
              { at: 0, anchor: offstage(radarScope, side) },
              {
                at: ROSTER_PARK - 0.4 + side * 0.15,
                anchor: rosterLink,
                fx: -0.3,
                dx: (3 + side) * 14,
                fy: 0.5,
                dy: 18,
              },
            ],
            busy: [[ROSTER_PARK - 0.4, ROSTER_PARK + 1.2]],
          })
        )
      ),
    events: [
      ...[0, 1, 2, 3, 4].map((k) => ({
        at: 0.55 + k * 1.1,
        run: (root: HTMLElement) => {
          if (k > 0) unhover(blip(k - 1)(root));
          hover(blip(k)(root));
        },
      })),
      { at: 6.2, run: (root: HTMLElement) => unhover(blip(4)(root)) },
    ],
  },
  // Confidence: "confidence" starts at heading size; Maya and Ari grab it and
  // stretch it out in three tugs while Sam watches. Then each clicks onto one
  // of the trust list's pulses and stays there.
  governance: {
    delay: 0.2,
    active: centerBand,
    drive: driveConfidence,
    parts: [
      ...[
        { fy: -0.5, dy: -2 },
        { fy: 0.5, dy: 2 },
      ].map(
        (grip, i): Part => ({
          marks: [
            { at: 0, anchor: lastE, ...grip, dy: i ? 40 : -40 },
            { at: 1.1, anchor: lastE, ...grip, lock: true },
            { at: 4.8 + i * 0.4, anchor: busDot(1 + i * 2) },
          ],
          cues: [
            ...STRETCH_PULLS.map(([a]) => ({
              at: a - 0.3,
              gesture: (i ? 'tugDown' : 'tugUp') as Gesture,
            })),
            { at: 5.6 + i * 0.4, gesture: 'click' as const },
          ],
          busy: [[1.0, 6.4 + i * 0.4] as [number, number]],
        })
      ),
      {
        marks: [
          { at: 0, anchor: confidenceWord, fx: 0.5, dx: 70, dy: 50, point: confidenceWord },
          { at: 5.6, anchor: busDot(5) },
        ],
        cues: [
          { at: 2.0, gesture: 'look' },
          { at: 6.4, gesture: 'click' },
        ],
        busy: [[5.5, 7.2]],
      },
      // The friends hang back under the stretch, then take the other pulses.
      ...([0, 1, 2] as const).map(
        (j): Part => ({
          marks: [
            { at: 0, anchor: confidenceWord, fx: -0.3 + j * 0.25, dy: 110 + (j % 2) * 18 },
            { at: 4.6 + j * 0.35, anchor: busDot(j * 2) },
          ],
          cues: [{ at: 5.4 + j * 0.35, gesture: 'click' as const }],
          busy: [[4.5, 6.4 + j * 0.35]],
        })
      ),
    ],
  },
  // Circle the wagons: all six ring "together", pointing in, turning slowly.
  // The guests head off; the three regulars each click a CTA and they're
  // gone (for good, until the pill brings them back).
  final: {
    delay: 0.2,
    active: (r, vh) => r.top < vh * 0.55 && r.bottom > vh * 0.3,
    parts: [0, 1, 2, 3, 4, 5].map((k): Part => {
      const ring = {
        r: 170,
        speed: 0.7,
        phase: (k * Math.PI) / 3 + Math.PI / 6,
        squash: 0.42,
      };
      if (k >= 3) {
        const side = (k - 3) as 0 | 1 | 2;
        return {
          marks: [
            { at: 0, anchor: together, dx: (side - 1) * 80, dy: -60 },
            { at: 0.3 + side * 0.2, anchor: together, orbit: ring, point: together },
            { at: 3.6 + side * 0.15, anchor: offstage(together, side) },
          ],
          busy: [[0, 4.4]],
          vanish: 4.6 + side * 0.15,
        };
      }
      return {
        marks: [
          { at: 0, anchor: together, dx: (k - 1) * 60, dy: 70 },
          { at: 0.5, anchor: together, orbit: ring, point: together },
          { at: 3.9 + k * 0.2, anchor: ctaButton(k), fx: 0.12, fy: 0.15 },
        ],
        cues: [{ at: 4.8 + k * 0.18, gesture: 'click' as const }],
        busy: [[0.4, 5.6]],
        vanish: 5.9 + k * 0.1,
      };
    }),
  },
};
/** Once the final beat gets this far, the show is over. */
const FINAL_EXIT = 6.3;

const GESTURE_SECONDS: Record<Gesture, number> = {
  wave: 0.9,
  look: 1.0,
  jump: 0.5,
  heave: 0.9,
  tugUp: 0.9,
  tugDown: 0.9,
  click: 0.8,
};

/** Offset (px), tilt (deg), and press for a gesture `u` (0..1) of the way through. */
function gestureAt(
  gesture: Gesture,
  u: number
): { ox: number; oy: number; rot: number; press?: boolean } {
  const fade = 1 - u;
  switch (gesture) {
    case 'wave':
      return {
        ox: Math.sin(u * Math.PI * 6) * 7 * fade,
        oy: 0,
        rot: Math.sin(u * Math.PI * 6) * 12 * fade,
      };
    case 'look':
      return { ox: 0, oy: 0, rot: -Math.sin(u * Math.PI) * 18 };
    case 'jump':
      return { ox: 0, oy: -Math.sin(u * Math.PI) * 18, rot: 0 };
    case 'heave': {
      // Lean back (right), then yank left with the pull, then recover.
      const ox = u < 0.3 ? 9 * (u / 0.3) : u < 0.55 ? 9 - 23 * ((u - 0.3) / 0.25) : -14 * fade;
      return { ox, oy: Math.sin(u * Math.PI) * 3, rot: u < 0.3 ? 8 * (u / 0.3) : 0 };
    }
    case 'tugUp':
    case 'tugDown': {
      // Ease in toward the letter, then yank outward (up or down), recover.
      const dir = gesture === 'tugUp' ? -1 : 1;
      const oy =
        u < 0.3
          ? -6 * dir * (u / 0.3)
          : u < 0.55
            ? dir * (-6 + 20 * ((u - 0.3) / 0.25))
            : 14 * dir * fade;
      return { ox: 0, oy, rot: 0 };
    }
    case 'click':
      return { ox: 0, oy: 0, rot: 0, press: u < 0.25 };
  }
}

/** The arrow points up and left: from its body toward the tip is about -125°. */
const ARROW_ANGLE = -125;

const IDLE_SCALE = 0.66;
const MOVE_SECONDS = 1.1;
/** No cursor moves faster than this (px/s), so section changes don't whip. */
const MAX_SPEED = 2200;

function isBusy(part: Part, t: number): boolean {
  const pad = 0.25;
  const within = (a: number, b: number) => t >= a - pad && t < b + pad;
  return (
    (part.cues ?? []).some((cue) => within(cue.at, cue.at + GESTURE_SECONDS[cue.gesture])) ||
    part.marks.slice(1).some((mark) => within(mark.at, mark.at + MOVE_SECONDS)) ||
    (part.busy ?? []).some(([a, b]) => within(a, b))
  );
}

interface CursorState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  opacity: number;
  size: number;
  /** Screensaver bounce, relative to the roam box's top-left. */
  roam: { x: number; y: number; vx: number; vy: number; key: string };
}

export function CursorTroupe() {
  const [enabled, setEnabled] = useState(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const cursorRefs = useRef<Array<HTMLDivElement | null>>([]);
  const ringRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    // On by default. `?cursors=off` (or `false`/`0`) turns it off for this
    // browser; `?cursors` / `?cursors=on` turns it back on.
    const param = new URLSearchParams(window.location.search).get('cursors');
    let off = param !== null && ['off', 'false', '0'].includes(param);
    try {
      if (param !== null) {
        if (off) localStorage.setItem(ENABLED_KEY, '0');
        else localStorage.removeItem(ENABLED_KEY);
      }
      off ||= param === null && localStorage.getItem(ENABLED_KEY) === '0';
    } catch {
      // Storage blocked: only the query param counts.
    }
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    setEnabled(!off && fine && !calm);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setHtmlFlag('data-troupe-on', true);
    const states: CursorState[] = CAST.map(() => ({
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      rot: 0,
      opacity: 0,
      size: IDLE_SCALE,
      roam: { x: 0, y: 0, vx: 0, vy: 0, key: '' },
    }));
    const played = new Set<SectionId>();
    const fired = new Set<string>();
    let active: SectionId | null = null;
    let since = performance.now();
    let last = since;
    let finished = false;
    let raf = 0;

    // Cached: the director checks every section each frame.
    const roots = new Map<SectionId, HTMLElement | null>();
    const sectionRoot = (id: SectionId) => {
      const cached = roots.get(id);
      if (cached?.isConnected) return cached;
      const found = document.querySelector<HTMLElement>(`[data-troupe-section="${id}"]`);
      roots.set(id, found);
      return found;
    };

    // The pill starts the whole show again.
    const heroRoot = sectionRoot('hero');
    const pillEl = heroRoot ? (pill(heroRoot) as HTMLElement | null) : null;
    const replay = () => {
      played.clear();
      fired.clear();
      finished = false;
      active = null;
      for (const state of states) state.opacity = 0;
    };
    if (pillEl) {
      pillEl.style.cursor = 'pointer';
      pillEl.title = 'Again!';
      pillEl.addEventListener('click', replay);
    }

    const frame = (now: number) => {
      const dt = Math.min(1 / 30, (now - last) / 1000);
      last = now;
      if (document.hidden) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const sx = window.scrollX;
      const sy = window.scrollY;

      let next: SectionId | null = null;
      for (const id of [...SECTIONS].reverse()) {
        const root = sectionRoot(id);
        if (root && BEATS[id].active(root.getBoundingClientRect(), vh, root)) {
          next = id;
          break;
        }
      }
      if (next !== active) {
        if (active) played.add(active);
        active = next;
        since = now;
        // Stay with the reader: pull anyone left behind to the viewport's
        // edge, so they come in from there rather than from far away.
        states.forEach((state, i) => {
          if (CAST[i].extra) return;
          state.x = Math.min(sx + vw - 30, Math.max(sx + 30, state.x));
          state.y = Math.min(sy + vh - 40, Math.max(sy + 70, state.y));
        });
      }

      const beat = active ? BEATS[active] : null;
      const root = active ? sectionRoot(active) : null;
      const replaying = Boolean(active && played.has(active));
      const t = beat ? (replaying ? 999 : (now - since) / 1000 - beat.delay) : 0;
      if (active === 'final' && t > FINAL_EXIT) finished = true;

      // Page side effects.
      for (const id of SECTIONS) {
        const b = BEATS[id];
        const r = sectionRoot(id);
        if (b.drive && r) {
          b.drive(r, id === active && !replaying ? 'play' : played.has(id) ? 'done' : 'before', t);
        }
        if (b.htmlFlag) setHtmlFlag(b.htmlFlag, id === active && !finished);
      }
      if (beat?.events && root && !replaying && !finished) {
        beat.events.forEach((event, index) => {
          const key = `${active}:${index}`;
          if (t >= event.at && !fired.has(key)) {
            fired.add(key);
            event.run(root);
          }
        });
      }

      // Masks: a hole the cursors hide behind, or the only windows they show in.
      const layer = layerRef.current;
      let maskImage = '';
      if (layer && beat && root && !finished) {
        if (beat.mask && t < beat.mask.until) {
          const hole = beat.mask.anchor(root)?.getBoundingClientRect();
          if (hole) {
            const fill = 'linear-gradient(#000, #000)';
            maskImage = `${fill}, ${fill}`;
            layer.style.maskSize = `100% 100%, ${hole.width}px ${hole.height}px`;
            layer.style.maskPosition = `0 0, ${hole.left}px ${hole.top}px`;
            layer.style.maskComposite = 'exclude';
            layer.style.setProperty('-webkit-mask-composite', 'xor');
          }
        } else if (beat.clip && t >= beat.clip.from) {
          const windows = beat.clip.anchors
            .map((anchor) => anchor(root)?.getBoundingClientRect())
            .filter((r): r is DOMRect => Boolean(r));
          if (windows.length) {
            maskImage = windows
              .map(
                (w) =>
                  `radial-gradient(ellipse ${w.width / 2}px ${w.height / 2}px at ${
                    w.left + w.width / 2
                  }px ${w.top + w.height / 2}px, #000 96%, transparent 100%)`
              )
              .join(', ');
            layer.style.maskSize = '100% 100%';
            layer.style.maskPosition = '0 0';
            layer.style.maskComposite = 'add';
            layer.style.setProperty('-webkit-mask-composite', 'source-over');
          }
        }
        layer.style.maskRepeat = 'no-repeat';
      }
      if (layer && layer.style.maskImage !== maskImage) layer.style.maskImage = maskImage;

      CAST.forEach((member, i) => {
        const state = states[i];
        const el = cursorRefs.current[i];
        const ring = ringRefs.current[i];
        if (!el || !ring) return;
        const part = finished ? undefined : beat?.parts[i];
        let target: { x: number; y: number } | null = null;
        let mark: Mark | null = null;
        let locked = false;
        let show = false;
        let ox = 0;
        let oy = 0;
        let gestureRot = 0;
        let press = false;
        let pointRot: number | null = null;
        let pulse = -1;
        let anchorVisible = false;
        let performing = false;
        if (part && root) {
          const current = [...part.marks].reverse().find((m) => m.at <= t) ?? part.marks[0];
          mark = current;
          locked =
            Boolean(current.lock) ||
            (current.lockAfter !== undefined && t >= current.at + current.lockAfter);
          const anchorEl = current.anchor(root);
          if (anchorEl) {
            const r = anchorEl.getBoundingClientRect();
            let x = r.left + sx + r.width * (0.5 + (current.fx ?? 0)) + (current.dx ?? 0);
            let y = r.top + sy + r.height * (0.5 + (current.fy ?? 0)) + (current.dy ?? 0);
            if (current.orbit) {
              const angle = current.orbit.phase + current.orbit.speed * (t - current.at);
              x += Math.cos(angle) * current.orbit.r;
              y += Math.sin(angle) * current.orbit.r * (current.orbit.squash ?? 0.5);
            }
            if (current.roam) {
              // Keep the whole arrow inside: it hangs down and right of its tip.
              const px = 20 * (current.size ?? 1);
              const w = Math.max(0, r.width - px * 0.75);
              const h = Math.max(0, r.height - px * 0.95);
              const ro = state.roam;
              const key = `${active}:${i}:${current.at}`;
              if (ro.key !== key) {
                ro.key = key;
                ro.x = w / 2;
                ro.y = h / 2;
                ro.vx = Math.cos(current.roam.angle) * current.roam.speed;
                ro.vy = Math.sin(current.roam.angle) * current.roam.speed;
              }
              ro.x += ro.vx * dt;
              ro.y += ro.vy * dt;
              if (ro.x < 0 || ro.x > w) {
                ro.vx = -ro.vx;
                ro.x = Math.min(w, Math.max(0, ro.x));
              }
              if (ro.y < 0 || ro.y > h) {
                ro.vy = -ro.vy;
                ro.y = Math.min(h, Math.max(0, ro.y));
              }
              x = r.left + sx + ro.x;
              y = r.top + sy + ro.y;
              locked = true;
            }
            target = { x, y };
            if (current.perform !== undefined) {
              const role = performAt(root, current.perform);
              if (role) {
                target = { x: role.x + sx, y: role.y + sy };
                // Glide into a new clip's role, then lock on.
                locked = role.age > 0.7;
                performing = true;
                if (role.ripple > 0 && role.ripple <= 1) {
                  pulse = role.ripple;
                  press = role.ripple < 0.25;
                }
              } else if (aroundLitCard(root, current.perform, t)) {
                // The "What needs you" still: gather round the card that's
                // glowing for attention, pointing at it.
                const spot = aroundLitCard(root, current.perform, t) as {
                  x: number;
                  y: number;
                  cx: number;
                  cy: number;
                };
                target = { x: spot.x + sx, y: spot.y + sy };
                const deg =
                  (Math.atan2(spot.cy + sy - state.y, spot.cx + sx - state.x) * 180) / Math.PI;
                pointRot = ((deg - ARROW_ANGLE + 540) % 360) - 180;
              } else {
                // Not in this clip: watch from under the panel, pointing in.
                target = {
                  x: r.left + sx + r.width * (0.3 + 0.13 * current.perform),
                  y: r.bottom + sy + 28,
                };
                const deg =
                  (Math.atan2(
                    r.top + r.height / 2 + sy - state.y,
                    r.left + r.width / 2 + sx - state.x
                  ) *
                    180) /
                  Math.PI;
                pointRot = ((deg - ARROW_ANGLE + 540) % 360) - 180;
              }
            }
            if (current.point) {
              const p = current.point(root)?.getBoundingClientRect();
              if (p) {
                const deg =
                  (Math.atan2(
                    p.top + sy + p.height / 2 - state.y,
                    p.left + sx + p.width / 2 - state.x
                  ) *
                    180) /
                  Math.PI;
                pointRot = ((deg - ARROW_ANGLE + 540) % 360) - 180;
              }
            }
            if (anchorEl instanceof HTMLElement) {
              anchorVisible = Number(anchorEl.style.opacity || '1') > 0.5;
              if (part.pressFromAnchor && anchorEl.hasAttribute('data-pressed')) press = true;
            }
          }
          show =
            (Boolean(target) || (part.hold === true && state.opacity > 0.05)) &&
            (part.appear === undefined || t >= part.appear) &&
            (part.vanish === undefined || t < part.vanish);
          for (const cue of part.cues ?? []) {
            const u = (t - cue.at) / GESTURE_SECONDS[cue.gesture];
            if (u >= 0 && u < 1) {
              const g = gestureAt(cue.gesture, u);
              ox += g.ox;
              oy += g.oy;
              gestureRot += g.rot;
              if (g.press) press = true;
              if (cue.gesture === 'click') pulse = u;
            }
          }
          if (current.tremble) {
            ox += Math.sin(now / 37 + i * 1.7) * 1.1;
            oy += Math.cos(now / 29 + i * 2.3) * 0.8;
          }
        } else if (member.extra && state.opacity > 0.05 && !finished) {
          // A guest whose scene is over heads off the side it's nearest.
          const leftward = state.x - sx < vw / 2;
          target = { x: state.x + (leftward ? -1 : 1) * 900, y: state.y };
          show = state.x > sx - 40 && state.x < sx + vw + 40;
        }
        const busy = performing
          ? true
          : part
            ? part.sizeFromAnchor
              ? anchorVisible || press
              : isBusy(part, t)
            : false;
        const wantSize = mark?.size ?? (busy ? 1 : IDLE_SCALE);

        if (target) {
          if (state.opacity < 0.05 && part) {
            state.x = target.x;
            state.y = target.y;
            state.vx = 0;
            state.vy = 0;
            if (part.appear !== undefined && member.extra) state.size = 0.2;
          } else {
            // Damped spring, each member a little lazier than the last, plus
            // a sideways pull that bows free moves up and left (a right
            // hand's arc). Locked parts follow stiffly and straight. Small
            // semi-implicit steps: the stiff (9 Hz) follow is unstable at one
            // step per frame. Speed is capped so section changes don't whip.
            const hz = locked ? 9 : mark?.orbit ? 5 : member.hz;
            const k = (2 * Math.PI * hz) ** 2;
            const c = 2 * Math.sqrt(k);
            const steps = Math.ceil(dt / (1 / 240));
            const h = dt / steps;
            for (let n = 0; n < steps; n++) {
              const dx = target.x - state.x;
              const dy = target.y - state.y;
              const dist = Math.hypot(dx, dy);
              let ax = k * dx - c * state.vx;
              let ay = k * dy - c * state.vy;
              if (!locked && !mark?.orbit && dist > 2) {
                let nx = -dy / dist;
                let ny = dx / dist;
                if (nx + ny > 0) {
                  nx = -nx;
                  ny = -ny;
                }
                ax += nx * k * dist * 0.18;
                ay += ny * k * dist * 0.18;
              }
              state.vx += ax * h;
              state.vy += ay * h;
              const speed = Math.hypot(state.vx, state.vy);
              if (!locked && speed > MAX_SPEED) {
                state.vx *= MAX_SPEED / speed;
                state.vy *= MAX_SPEED / speed;
              }
              state.x += state.vx * h;
              state.y += state.vy * h;
            }
          }
        }
        if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) {
          state.x = target?.x ?? sx + vw / 2;
          state.y = target?.y ?? sy + vh / 2;
          state.vx = 0;
          state.vy = 0;
        }
        state.opacity += ((show ? 1 : 0) - state.opacity) * Math.min(1, dt * 8);
        state.size += (wantSize - state.size) * Math.min(1, dt * 6);
        state.rot += ((pointRot ?? 0) - state.rot) * Math.min(1, dt * 7);
        const still = locked || mark?.orbit;
        const fidget = still ? 0 : Math.sin(now / 760 + i * 2.1) * 2;
        const px = state.x - sx + ox + fidget;
        const py = state.y - sy + oy + fidget * 0.6;
        el.style.opacity = state.opacity.toFixed(3);
        el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) rotate(${(
          state.rot + gestureRot
        ).toFixed(1)}deg) scale(${(state.size * (press ? 0.8 : 1)).toFixed(3)})`;
        if (pulse >= 0) {
          ring.style.opacity = (1 - pulse).toFixed(3);
          ring.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) scale(${(
            0.3 + pulse * 1.4
          ).toFixed(3)})`;
        } else if (ring.style.opacity !== '0') {
          ring.style.opacity = '0';
        }
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      pillEl?.removeEventListener('click', replay);
      for (const id of SECTIONS) {
        const b = BEATS[id];
        const r = sectionRoot(id);
        if (b.drive && r) b.drive(r, 'done', 0);
        if (b.htmlFlag) setHtmlFlag(b.htmlFlag, false);
      }
      setHtmlFlag('data-troupe-on', false);
      setHtmlFlag('data-troupe-wave', false);
      if (heroRoot) lightRow(heroRoot, null);
    };
  }, [enabled]);

  if (!enabled) return null;
  return (
    <div className={styles.layer} ref={layerRef} aria-hidden="true">
      {CAST.map((member, i) => (
        <div
          key={`ring-${member.name}`}
          className={styles.ring}
          style={{ borderColor: member.color }}
          ref={(el) => {
            ringRefs.current[i] = el;
          }}
        />
      ))}
      {CAST.map((member, i) => (
        <div
          key={member.name}
          className={styles.cursor}
          ref={(el) => {
            cursorRefs.current[i] = el;
          }}
        >
          <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true">
            <path
              d="M2 1l15 8-7 1.6L7 18z"
              fill={member.color}
              stroke="#061010"
              strokeWidth="1.2"
            />
          </svg>
        </div>
      ))}
    </div>
  );
}
