// Rectangles in two spaces:
// - "app" space: CSS pixels of the recorded Agor window (1920x1080), which is
//   how views into a clip are described (the clips are 4K, 2x those pixels).
// - composition space: pixels of the 1920x1080 output.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const APP = { w: 1920, h: 1080 };
export const FULL: Rect = { x: 0, y: 0, w: 1920, h: 1080 };

/** A 16:9 view of the app, `w` wide, centered on (cx, cy), kept inside the window. */
export function view(cx: number, cy: number, w: number): Rect {
  const h = (w * 9) / 16;
  return {
    x: Math.min(APP.w - w, Math.max(0, cx - w / 2)),
    y: Math.min(APP.h - h, Math.max(0, cy - h / 2)),
    w,
    h,
  };
}

/** The 2x2 grid the shots settle into, in reading order. */
const GAP = 24;
const TILE_W = (1920 - 3 * GAP) / 2;
const TILE_H = (TILE_W * 9) / 16;
const TOP = (1080 - 2 * TILE_H - GAP) / 2;
export const TILES: Rect[] = [
  { x: GAP, y: TOP, w: TILE_W, h: TILE_H },
  { x: 2 * GAP + TILE_W, y: TOP, w: TILE_W, h: TILE_H },
  { x: GAP, y: TOP + TILE_H + GAP, w: TILE_W, h: TILE_H },
  { x: 2 * GAP + TILE_W, y: TOP + TILE_H + GAP, w: TILE_W, h: TILE_H },
];

export function mix(a: Rect, b: Rect, t: number): Rect {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}
