// Turns a recorded take (timeline.jsonl + one video per filmed actor) into
// a finished 1080p master: syncs every video to the wall clock, cuts the
// boot screens off the head, applies the camera track (eased zoom and pan),
// and lays out one actor full frame or two side by side.
//
// The camera is rendered with ffmpeg's `perspective` filter: four corner
// expressions evaluated per frame with cubic interpolation, so the framing
// moves in sub-pixel steps. (crop and zoompan round to whole pixels, which
// reads as a shimmer during slow moves.) The expressions are piecewise
// functions of the frame counter `in`, built from the camera events as a
// balanced if() tree.
//
// Zoom is only lossless while the source has pixels to spare: a 3840-wide
// 4K capture can zoom 2x into a 1920-wide master before anything is
// upscaled. A 1080p capture can't zoom without softening, so the renderer
// caps zoom at what the source supports and says so.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Ease, Rect, TimelineEvent } from '../../support/timeline.ts';

export const FPS = 30;
export const OUT_W = 1920;
export const OUT_H = 1080;

/** Breathing room around a focus target, as a fraction of its size (min 48 CSS px). */
const FOCUS_PAD = 0.18;
const FOCUS_PAD_MIN = 48;

interface Probe {
  width: number;
  height: number;
}

function probe(video: string): Probe {
  const out = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      video,
    ],
    { encoding: 'utf8' }
  );
  if (out.status !== 0) throw new Error(`ffprobe failed on ${video}: ${out.stderr}`);
  const stream = (JSON.parse(out.stdout) as { streams: Probe[] }).streams[0];
  return { width: stream.width, height: stream.height };
}

/**
 * Index of the first frame (at FPS, counted from the video's first frame)
 * showing the sync flash: a full-screen magenta card studio.ts paints
 * during the boot screens, which the head trim removes again.
 */
export function findSyncFrame(video: string, maxSeconds = 120): number {
  const w = 16;
  const h = 9;
  const out = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      video,
      '-vf',
      `fps=${FPS},scale=${w}:${h}:flags=area`,
      '-frames:v',
      String(maxSeconds * FPS),
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: maxSeconds * FPS * w * h * 3 + 1024 }
  );
  if (out.status !== 0) throw new Error(`ffmpeg failed reading ${video}: ${out.stderr}`);
  const frame = w * h * 3;
  const buf = out.stdout as Buffer;
  for (let i = 0; i * frame < buf.length; i++) {
    let magenta = 0;
    for (let p = 0; p < w * h; p++) {
      const o = i * frame + p * 3;
      if (buf[o] > 200 && buf[o + 1] < 70 && buf[o + 2] > 200) magenta++;
    }
    if (magenta >= w * h * 0.9) return i;
  }
  throw new Error(`No sync flash found in the first ${maxSeconds}s of ${video}`);
}

/** The visible source region: left, top, and width in source pixels (height follows 16:9). */
interface View {
  l: number;
  t: number;
  w: number;
}

interface Piece {
  from: number; // first frame (inclusive)
  a: View;
  b: View;
  dur: number; // 0 = hold at `a`
  ease: Ease;
}

function easeExpr(ease: Ease, p: string): string {
  switch (ease) {
    case 'linear':
      return p;
    case 'spring': {
      const k = 7;
      const norm = 1 - (1 + k) * Math.exp(-k);
      return `((1-(1+${k}*${p})*exp(-${k}*${p}))/${norm.toFixed(6)})`;
    }
    default:
      return `(${p}*${p}*${p}*(${p}*(6*${p}-15)+10))`;
  }
}

function easeValue(ease: Ease, p: number): number {
  switch (ease) {
    case 'linear':
      return p;
    case 'spring': {
      const k = 7;
      return (1 - (1 + k * p) * Math.exp(-k * p)) / (1 - (1 + k) * Math.exp(-k));
    }
    default:
      return p * p * p * (p * (6 * p - 15) + 10);
  }
}

function viewAt(piece: Piece, frame: number): View {
  if (piece.dur === 0) return piece.a;
  const p = Math.min(1, Math.max(0, (frame - piece.from) / piece.dur));
  const e = easeValue(piece.ease, p);
  return {
    l: piece.a.l + (piece.b.l - piece.a.l) * e,
    t: piece.a.t + (piece.b.t - piece.a.t) * e,
    w: piece.a.w + (piece.b.w - piece.a.w) * e,
  };
}

export interface CameraPlan {
  pieces: Piece[];
  /** Human-readable problems worth fixing in the clip script. */
  warnings: string[];
}

/**
 * Lay the actor's camera events out as frame-indexed pieces. A new move
 * starts from wherever the camera actually is at that instant, so moves
 * can interrupt each other without a jump.
 */
export function planCamera(
  events: TimelineEvent[],
  actor: string,
  readyWall: number,
  src: Probe,
  viewport: { width: number; height: number }
): CameraPlan {
  const s = src.width / viewport.width;
  const full: View = { l: 0, t: 0, w: src.width };
  const maxZoom = Math.max(1, src.width / OUT_W);
  const warnings: string[] = [];
  const pieces: Piece[] = [{ from: 0, a: full, b: full, dur: 0, ease: 'smooth' }];
  const toFrame = (wall: number) => Math.max(0, Math.round(((wall - readyWall) * FPS) / 1000));

  const cams = events
    .filter((e): e is Extract<TimelineEvent, { type: 'camera' }> => e.type === 'camera')
    .filter((e) => e.actor === actor)
    .sort((x, y) => x.wall - y.wall);

  for (const cam of cams) {
    const at = toFrame(cam.wall);
    const current = viewAt(pieces[pieces.length - 1], at);
    let target = full;
    if (cam.rect) {
      const r: Rect = cam.rect;
      const padX = Math.max(FOCUS_PAD_MIN, r.w * FOCUS_PAD);
      const padY = Math.max(FOCUS_PAD_MIN, r.h * FOCUS_PAD);
      let zoom =
        cam.zoom ?? Math.min(viewport.width / (r.w + 2 * padX), viewport.height / (r.h + 2 * padY));
      if (zoom > maxZoom) {
        // Fit-to-target zooms past the cap are normal (small targets); only
        // an explicit zoom, or a source with no headroom at all, is news.
        if (cam.zoom !== undefined || maxZoom === 1) {
          warnings.push(
            `camera at ${((cam.wall - readyWall) / 1000).toFixed(1)}s wants ${zoom.toFixed(2)}x; ` +
              `capped at ${maxZoom.toFixed(2)}x (the most this ${src.width}px source holds` +
              `${maxZoom === 1 ? '; record with --4k to zoom' : ''})`
          );
        }
        zoom = maxZoom;
      }
      zoom = Math.max(1, zoom);
      const w = src.width / zoom;
      const h = (w * src.height) / src.width;
      const cx = (r.x + r.w / 2) * s;
      const cy = (r.y + r.h / 2) * s;
      target = {
        l: Math.min(src.width - w, Math.max(0, cx - w / 2)),
        t: Math.min(src.height - h, Math.max(0, cy - h / 2)),
        w,
      };
    }
    const dur = Math.max(1, Math.round((cam.ms * FPS) / 1000));
    pieces.push({ from: at, a: current, b: target, dur, ease: cam.ease });
  }

  // Cursor checks: a resting cursor outside the frame is a viewer losing the action.
  for (const ev of events) {
    if (ev.type !== 'cursor' || ev.actor !== actor || ev.wall < readyWall) continue;
    const f = toFrame(ev.wall);
    const piece = [...pieces].reverse().find((p) => p.from <= f) ?? pieces[0];
    const v = viewAt(piece, f);
    const h = (v.w * src.height) / src.width;
    const x = ev.x * s;
    const y = ev.y * s;
    const margin = 12 * s;
    if (x < v.l + margin || x > v.l + v.w - margin || y < v.t + margin || y > v.t + h - margin) {
      warnings.push(
        `${actor}'s cursor rests outside the frame at ${(f / FPS).toFixed(1)}s ` +
          `(${Math.round(ev.x)},${Math.round(ev.y)}); refocus the camera before that move`
      );
    }
  }
  return { pieces, warnings };
}

/** One view component as an expression of the frame counter `in`. */
function pieceExpr(piece: Piece, key: keyof View): string {
  const a = piece.a[key];
  const b = piece.b[key];
  if (piece.dur === 0 || Math.abs(b - a) < 0.001) return a.toFixed(3);
  const p = `min(1,max(0,(in-${piece.from})/${piece.dur}))`;
  return `(${a.toFixed(3)}+${(b - a).toFixed(3)}*${easeExpr(piece.ease, p)})`;
}

/** Balanced if() tree: depth log2(pieces), so long clips stay cheap to parse. */
function treeExpr(pieces: Piece[], key: keyof View): string {
  if (pieces.length === 1) return pieceExpr(pieces[0], key);
  const mid = Math.floor(pieces.length / 2);
  return `if(lt(in,${pieces[mid].from}),${treeExpr(pieces.slice(0, mid), key)},${treeExpr(pieces.slice(mid), key)})`;
}

/** The perspective filter for a camera plan, or null when the camera never moves. */
export function cameraFilter(plan: CameraPlan, src: Probe): string | null {
  if (plan.pieces.length === 1) return null;
  const l = treeExpr(plan.pieces, 'l');
  const t = treeExpr(plan.pieces, 't');
  const w = treeExpr(plan.pieces, 'w');
  const r = `(${l}+${w})`;
  const b = `(${t}+${w}*${(src.height / src.width).toFixed(6)})`;
  const q = (e: string) => `'${e}'`;
  return (
    `perspective=x0=${q(l)}:y0=${q(t)}:x1=${q(r)}:y1=${q(t)}` +
    `:x2=${q(l)}:y2=${q(b)}:x3=${q(r)}:y3=${q(b)}:interpolation=cubic:eval=frame`
  );
}

/**
 * Write an ffconcat list for a frame-recorded actor covering [from, to] in
 * wall time: the frame on screen at `from` first, every later frame held
 * until the next was painted, the last held until `to`.
 */
function framesConcatList(dir: string, from: number, to: number): { file: string; first: string } {
  const index = readFileSync(path.join(dir, 'index.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { file: string; wall: number })
    .sort((a, b) => a.wall - b.wall);
  if (index.length === 0) throw new Error(`no frames recorded in ${dir}`);
  let i = 0;
  while (i + 1 < index.length && index[i + 1].wall <= from) i++;
  const lines = ['ffconcat version 1.0'];
  let at = from;
  for (; i < index.length && at < to; i++) {
    const until = Math.min(to, i + 1 < index.length ? index[i + 1].wall : to);
    if (until <= at) continue;
    lines.push(`file '${path.join(dir, index[i].file).replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${((until - at) / 1000).toFixed(4)}`);
    at = until;
  }
  // The concat demuxer drops the last entry's duration unless it is repeated.
  lines.push(lines[lines.length - 2]);
  const file = path.join(dir, 'concat.ffconcat');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return { file, first: path.join(dir, index[0].file) };
}

export type Layout = 'single' | 'split';

export interface RenderInput {
  takeDir: string;
  events: TimelineEvent[];
  /** Filmed actors in pane order (left to right). */
  actors: string[];
  layout: Layout;
  out: string;
  /** Pane captions for split layout (defaults to actor names). */
  labels?: Record<string, string>;
  font?: string;
  /**
   * Raw cut: skip the camera track and keep the source's full frame at its
   * own size (3840x2160 from a 4K take), for editing elsewhere.
   */
  raw?: boolean;
}

/** Render the take to a 1080p30 h264 master. Returns warnings worth showing. */
export function renderMaster(input: RenderInput): string[] {
  const { events, actors, layout } = input;
  const ready = events.find((e) => e.type === 'ready');
  const end = [...events].reverse().find((e) => e.type === 'end');
  if (ready?.type !== 'ready') throw new Error('timeline has no ready event');
  if (end?.type !== 'end') throw new Error('timeline has no end event (did the take finish?)');
  const frames = Math.round(((end.wall - ready.wall) * FPS) / 1000);
  if (layout === 'single' && actors.length !== 1) throw new Error('single layout films one actor');
  if (layout === 'split' && actors.length !== 2) throw new Error('split layout films two actors');

  const warnings: string[] = [];
  const args: string[] = ['-y', '-v', 'error'];
  const chains: string[] = [];
  if (input.raw && layout !== 'single') throw new Error('raw export is single layout only');
  const firstVideo = events.find(
    (e): e is Extract<TimelineEvent, { type: 'actor' }> =>
      e.type === 'actor' && e.actor === actors[0]
  );
  let rawWidth = OUT_W;
  if (input.raw && firstVideo?.frames) {
    const index = readFileSync(path.join(input.takeDir, firstVideo.frames, 'index.jsonl'), 'utf8');
    const first = JSON.parse(index.split('\n')[0]) as { file: string };
    rawWidth = probe(path.join(input.takeDir, firstVideo.frames, first.file)).width;
  } else if (input.raw && firstVideo?.video) {
    rawWidth = probe(path.join(input.takeDir, firstVideo.video)).width;
  }
  const paneW = layout === 'single' ? rawWidth : 928;
  const paneH = (paneW * 9) / 16;

  actors.forEach((actor, i) => {
    const meta = events.find(
      (e): e is Extract<TimelineEvent, { type: 'actor' }> => e.type === 'actor' && e.actor === actor
    );
    let src: Probe;
    let start: number;
    if (meta?.frames) {
      // Frame-recorded take: a concat list that starts exactly at `ready`,
      // each frame held until the next one was painted.
      const list = framesConcatList(path.join(input.takeDir, meta.frames), ready.wall, end.wall);
      src = probe(list.first);
      start = 0;
      args.push('-f', 'concat', '-safe', '0', '-i', list.file);
    } else {
      // Older take: Playwright's webm, pinned to the clock by its sync flash.
      const sync = events.find(
        (e): e is Extract<TimelineEvent, { type: 'sync' }> => e.type === 'sync' && e.actor === actor
      );
      if (!meta?.video) throw new Error(`${actor} was not filmed in this take`);
      if (!sync) throw new Error(`no sync flash logged for ${actor}`);
      const video = path.join(input.takeDir, meta.video);
      if (!existsSync(video)) throw new Error(`missing ${video}`);
      src = probe(video);
      start = findSyncFrame(video) + Math.round(((ready.wall - sync.wall) * FPS) / 1000);
      args.push('-i', video);
    }
    const plan = planCamera(events, actor, ready.wall, src, meta.viewport);
    warnings.push(...plan.warnings);
    const camera = input.raw ? null : cameraFilter(plan, src);
    chains.push(
      [
        `[${i}:v]fps=${FPS}`,
        `setpts=N/${FPS}/TB`,
        `trim=start_frame=${start}:end_frame=${start + frames}`,
        'setpts=PTS-STARTPTS',
        'format=yuv444p',
        ...(camera ? [camera] : []),
        `scale=${paneW}:${paneH}:flags=lanczos`,
        `setsar=1[p${i}]`,
      ].join(',')
    );
  });

  let graph: string;
  if (layout === 'single') {
    graph = `${chains[0]};[p0]format=yuv420p[out]`;
  } else {
    // Two panes on the app's own dark canvas, captions underneath.
    const gap = (OUT_W - 2 * paneW) / 3;
    const top = Math.round((OUT_H - paneH) / 2) - 24;
    const bg = `color=c=0x0b0d12:s=${OUT_W}x${OUT_H}:r=${FPS}:d=${(frames / FPS).toFixed(3)}[bg]`;
    let label = '';
    if (input.font && existsSync(input.font)) {
      label = actors
        .map((actor, i) => {
          const text = (input.labels?.[actor] ?? actor).replace(/[:'\\]/g, '');
          const cx = Math.round(gap + i * (paneW + gap) + paneW / 2);
          return `drawtext=fontfile='${input.font}':text='${text}':fontcolor=0xd8dde6:fontsize=30:x=${cx}-tw/2:y=${top + paneH + 28}`;
        })
        .join(',');
    }
    graph = [
      ...chains,
      bg,
      `[bg][p0]overlay=x=${Math.round(gap)}:y=${top}:shortest=1[l]`,
      `[l][p1]overlay=x=${Math.round(2 * gap + paneW)}:y=${top}:shortest=1${label ? `,${label}` : ''},format=yuv420p[out]`,
    ].join(';');
  }

  args.push(
    '-filter_complex',
    graph,
    '-map',
    '[out]',
    '-frames:v',
    String(frames),
    '-r',
    String(FPS),
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-preset',
    'slow',
    '-crf',
    input.raw ? '14' : '18',
    '-movflags',
    '+faststart',
    '-an',
    input.out
  );
  const res = spawnSync('ffmpeg', args, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`ffmpeg render failed (${res.status})`);
  return warnings;
}
