// Stitches the recorded lesson videos into one continuous reel:
// a logo title card up front, a lower-third title overlay (lesson title +
// tagline, in the website's Space Grotesk display face) fading in at the
// top of each lesson, and fade-through-black transitions. Everything
// textual comes from support/syllabus.ts — the reel is a rendering of the
// same metadata that generates SYLLABUS.md.
//
//   npm run reel                # reads test-results/ from the last run
//   npm run reel -- --dir PATH  # read lesson .webm files from PATH instead
//                               # (expects <lesson-id>.webm names)
//
// Output: reel/agor-syllabus-reel.mp4 (h264, yuv420p, constant 25fps —
// plays anywhere a conference monitor does). Snapshots the per-lesson
// clips into reel/clips/ so a later test run can't destroy the sources.
//
// Assets (cached in .e2e-cache/reel-assets/):
//   - SpaceGrotesk.ttf — the site's display face (fetched once from
//     Google Fonts; any Space Grotesk TTF works)
//   - logo.png — rasterized from apps/agor-docs/public/logo.svg
//     (regenerated automatically when rsvg-convert is available)
//
// Timing gotchas this file already learned the hard way:
//   - xfade needs every branch on the SAME timebase; mixing lavfi and webm
//     inputs without settb=AVTB warps whole segments into slow motion.
//   - Playwright clips open on a white paint-in flash; TRIM_HEAD cuts it
//     (and made the old crossfades look like a fade-to-white).

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DONE_LESSONS } from '../support/syllabus.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.join(HERE, '..');
const REPO_ROOT = path.resolve(E2E_ROOT, '../../../..');
const REEL_DIR = path.join(E2E_ROOT, 'reel');
const CLIPS_DIR = path.join(REEL_DIR, 'clips');
const OUT_FILE = path.join(REEL_DIR, 'agor-syllabus-reel.mp4');

const ASSETS_DIR = path.join(REPO_ROOT, '.e2e-cache', 'reel-assets');
const FONT = path.join(ASSETS_DIR, 'SpaceGrotesk.ttf');
const LOGO = path.join(ASSETS_DIR, 'logo.png');
const LOGO_SVG = path.join(REPO_ROOT, 'apps/agor-docs/public/logo.svg');

const FADE = 0.7; // fade-through-black seconds between segments
const TRIM_HEAD = 0.6; // cut each clip's leading white paint-in flash
const TITLE_IN = 0.8; // overlay fade-in start offset into each clip
const TITLE_HOLD = 4.5; // seconds the overlay stays fully visible
const CARD_SECONDS = 3.5; // opening title card

function ensureAssets(): void {
  if (!existsSync(FONT)) {
    throw new Error(
      `[reel] missing ${FONT} — fetch any Space Grotesk TTF there (the site's display face), e.g.\n` +
        `  curl -sL -A "Mozilla/5.0 (X11; Linux x86_64)" "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500" | grep -o 'https://[^)]*\\.ttf' | head -1 | xargs curl -sL -o ${FONT}`
    );
  }
  if (!existsSync(LOGO)) {
    try {
      mkdirSync(ASSETS_DIR, { recursive: true });
      execFileSync('rsvg-convert', ['-w', '480', '-h', '480', LOGO_SVG, '-o', LOGO]);
    } catch {
      throw new Error(
        `[reel] missing ${LOGO} and rsvg-convert unavailable — rasterize ${LOGO_SVG} to a 480x480 PNG there.`
      );
    }
  }
}

function ffprobeDuration(file: string): number {
  const out = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Number.parseFloat(out.toString().trim());
}

/** drawtext-safe escaping for text values. */
function esc(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll(':', '\\:')
    .replaceAll("'", "\\\\\\'")
    .replaceAll(',', '\\,')
    .replaceAll('%', '\\%');
}

/** Alpha expression: fade in at t0, hold, fade out. */
function alphaExpr(t0: number, hold: number): string {
  const inEnd = t0 + 0.4;
  const outStart = t0 + hold;
  const outEnd = outStart + 0.5;
  return `if(lt(t,${t0}),0,if(lt(t,${inEnd}),(t-${t0})/0.4,if(lt(t,${outStart}),1,if(lt(t,${outEnd}),(${outEnd}-t)/0.5,0))))`;
}

function drawText(opts: {
  text: string;
  size: number;
  x: string;
  y: string;
  t0: number;
  hold: number;
  color?: string;
  box?: boolean;
}): string {
  const parts = [
    `fontfile=${FONT}`,
    `text='${esc(opts.text)}'`,
    `fontsize=${opts.size}`,
    `fontcolor=${opts.color ?? 'white'}`,
    `x=${opts.x}`,
    `y=${opts.y}`,
    `alpha='${alphaExpr(opts.t0, opts.hold)}'`,
  ];
  if (opts.box) {
    parts.push('box=1', 'boxcolor=black@0.55', 'boxborderw=22');
  }
  return `drawtext=${parts.join(':')}`;
}

function main(): void {
  ensureAssets();
  const dirFlagIndex = process.argv.indexOf('--dir');
  const sourceDir = dirFlagIndex !== -1 ? path.resolve(process.argv[dirFlagIndex + 1]) : null;

  mkdirSync(CLIPS_DIR, { recursive: true });

  // Collect one clip per done lesson: either <id>.webm from --dir, or the
  // matching flow-NN* test-results folder from the last run.
  const clips: { id: string; file: string }[] = [];
  for (const lesson of DONE_LESSONS) {
    let source: string | null = null;
    if (sourceDir) {
      const candidate = path.join(sourceDir, `${lesson.id}.webm`);
      if (existsSync(candidate)) source = candidate;
    } else {
      const resultsDir = path.join(E2E_ROOT, 'test-results');
      const match = readdirSync(resultsDir).find((name) =>
        name.startsWith(`flow-${lesson.number}`)
      );
      if (match && existsSync(path.join(resultsDir, match, 'video.webm'))) {
        source = path.join(resultsDir, match, 'video.webm');
      }
    }
    if (!source) {
      console.warn(`[reel] no video for lesson ${lesson.id} — skipping`);
      continue;
    }
    const snapshot = path.join(CLIPS_DIR, `${lesson.id}.webm`);
    copyFileSync(source, snapshot);
    clips.push({ id: lesson.id, file: snapshot });
  }
  if (clips.length === 0) throw new Error('[reel] no lesson videos found');

  const durations = clips.map((clip) => ffprobeDuration(clip.file) - TRIM_HEAD);

  const inputs: string[] = [];
  const filters: string[] = [];

  // Input 0: title-card background; input 1: the Agor logo mark.
  inputs.push('-f', 'lavfi', '-i', `color=c=0x0d1a1a:s=1920x1080:r=25:d=${CARD_SECONDS}`);
  inputs.push('-loop', '1', '-t', String(CARD_SECONDS), '-i', LOGO);
  filters.push(
    `[1:v]scale=360:360[logo];` +
      `[0:v][logo]overlay=(W-w)/2:H/2-300:format=auto,` +
      `${drawText({ text: 'From zero to a working agent team', size: 46, x: '(w-text_w)/2', y: 'h/2+120', t0: 0.5, hold: CARD_SECONDS, color: '0xd8e6e3' })},` +
      `fade=t=in:st=0:d=0.6,settb=AVTB,fps=25,setpts=PTS-STARTPTS[card]`
  );

  // Lesson inputs, each trimmed past the paint-in flash and carrying its
  // lower-third (title + tagline — no lesson numbers on screen).
  const lessonByIndex = DONE_LESSONS.filter((lesson) =>
    clips.some((clip) => clip.id === lesson.id)
  );
  clips.forEach((clip, i) => {
    const lesson = lessonByIndex[i];
    inputs.push('-i', clip.file);
    filters.push(
      `[${i + 2}:v]trim=start=${TRIM_HEAD},setpts=PTS-STARTPTS,scale=1920:1080,` +
        `${drawText({ text: lesson.title, size: 48, x: '64', y: 'h-180', t0: TITLE_IN, hold: TITLE_HOLD, box: true })},` +
        `${drawText({ text: lesson.tagline, size: 30, x: '64', y: 'h-110', t0: TITLE_IN + 0.25, hold: TITLE_HOLD - 0.25, color: '0xd8e6e3', box: true })},` +
        `settb=AVTB,fps=25[v${i}]`
    );
  });

  // Fade-through-black chain: card -> v0 -> v1 -> ...
  const allDurations = [CARD_SECONDS, ...durations];
  let chainLabel = '[card]';
  let elapsed = 0;
  clips.forEach((clip, i) => {
    elapsed += allDurations[i] - FADE;
    const outLabel = i === clips.length - 1 ? '[reel]' : `[x${i}]`;
    filters.push(
      `${chainLabel}[v${i}]xfade=transition=fadeblack:duration=${FADE}:offset=${elapsed.toFixed(3)}${outLabel}`
    );
    chainLabel = outLabel;
  });
  const total = allDurations.reduce((sum, d) => sum + d, 0) - FADE * clips.length;
  filters.push(`[reel]fade=t=out:st=${(total - 0.9).toFixed(3)}:d=0.9,format=yuv420p[out]`);

  const args = [
    '-y',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-r',
    '25',
    '-fps_mode',
    'cfr',
    '-c:v',
    'libx264',
    '-crf',
    '20',
    '-preset',
    'medium',
    '-movflags',
    '+faststart',
    OUT_FILE,
  ];
  console.log(`[reel] stitching ${clips.length} lessons (+title card) -> ${OUT_FILE}`);
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'pipe'] });
  console.log(`[reel] done — ~${Math.round(total)}s total`);
}

main();
