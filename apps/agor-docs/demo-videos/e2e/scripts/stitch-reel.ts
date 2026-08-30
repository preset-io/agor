// Stitches the recorded lesson videos into one continuous reel:
// the animated Agor logo reveal up front (../animated_agor_logo/ — an
// animated-SVG page captured to video), a lower-third title overlay
// (lesson title + tagline, in the website's Space Grotesk display face)
// fading in at the top of each lesson, and fade-through-black
// transitions. Everything textual comes from support/syllabus.ts — the
// reel is a rendering of the same metadata that generates SYLLABUS.md.
//
//   npm run reel                # reads test-results/ from the last run
//   npm run reel -- --dir PATH  # read lesson .webm files from PATH instead
//                               # (expects <lesson-id>.webm names)
//
// Output: reel/agor-syllabus-reel.mp4 (h264, yuv420p, constant 25fps —
// plays anywhere a conference monitor does). Snapshots the per-lesson
// clips into reel/clips/ so a later test run can't destroy the sources.
//
// Assets:
//   - ../animated_agor_logo/agor_logo_reveal_4k.mp4 — the intro (checked in)
//   - .e2e-cache/reel-assets/SpaceGrotesk.ttf — the site's display face
//     (fetched once from Google Fonts; any Space Grotesk TTF works)
//
// Timing gotchas this file already learned the hard way:
//   - xfade needs every branch on the SAME timebase; mixing lavfi and webm
//     inputs without settb=AVTB warps whole segments into slow motion.
//   - Playwright clips open on a white paint-in flash; TRIM_HEAD cuts it
//     (and made the old crossfades look like a fade-to-white).

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRATCH_DIR } from '../support/harness.ts';
import { DONE_LESSONS } from '../support/syllabus.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.join(HERE, '..');
const REPO_ROOT = path.resolve(E2E_ROOT, '../../../..');
const REEL_DIR = path.join(E2E_ROOT, 'reel');
const CLIPS_DIR = path.join(REEL_DIR, 'clips');
const OUT_FILE = path.join(REEL_DIR, 'agor-syllabus-reel.mp4');

const ASSETS_DIR = path.join(REPO_ROOT, '.e2e-cache', 'reel-assets');
const FONT = path.join(ASSETS_DIR, 'SpaceGrotesk.ttf');
const INTRO = path.join(E2E_ROOT, '..', 'animated_agor_logo', 'agor_logo_reveal_4k.mp4');

const FADE = 0.7; // fade-through-black seconds between segments
const TRIM_HEAD = 0.6; // fallback trim: at least the white paint-in flash
const TITLE_IN = 0.8; // overlay fade-in start offset into each clip
const TITLE_HOLD = 4.0; // seconds the overlay stays fully visible
// Output framerate. Frames are duplicated/dropped to hit it — timestamps
// are authoritative, so playback SPEED never changes with this knob (e.g.
// AGOR_E2E_REEL_FPS=60 for a smoother-capable target).
const REEL_FPS = Number(process.env.AGOR_E2E_REEL_FPS ?? 25);

// Per-lesson trim marks written by openLesson (support/pacing.ts): seconds
// of app-boot to cut so each lesson opens on the settled UI where its
// story starts — never the "Loading workspace data..." screen. The marks
// ride along into reel/clips/ so --dir restitches keep working.
const TRIM_MARKS_RUNTIME = path.join(SCRATCH_DIR, 'trim-marks.jsonl');
const TRIM_MARKS_SNAPSHOT = path.join(CLIPS_DIR, 'trim-marks.jsonl');

function loadTrimMarks(sourceDir: string | null): Map<string, number> {
  const file =
    sourceDir && existsSync(path.join(sourceDir, 'trim-marks.jsonl'))
      ? path.join(sourceDir, 'trim-marks.jsonl')
      : existsSync(TRIM_MARKS_RUNTIME)
        ? TRIM_MARKS_RUNTIME
        : existsSync(TRIM_MARKS_SNAPSHOT)
          ? TRIM_MARKS_SNAPSHOT
          : null;
  const marks = new Map<string, number>();
  if (!file) return marks;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const { lessonId, trimSeconds } = JSON.parse(line) as {
      lessonId: string;
      trimSeconds: number;
    };
    marks.set(lessonId, trimSeconds); // last write wins
  }
  writeFileSync(
    TRIM_MARKS_SNAPSHOT,
    [...marks].map(([l, t]) => JSON.stringify({ lessonId: l, trimSeconds: t })).join('\n')
  );
  return marks;
}

function ensureAssets(): void {
  if (!existsSync(FONT)) {
    throw new Error(
      `[reel] missing ${FONT} — fetch any Space Grotesk TTF there (the site's display face), e.g.\n` +
        `  curl -sL -A "Mozilla/5.0 (X11; Linux x86_64)" "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500" | grep -o 'https://[^)]*\\.ttf' | head -1 | xargs curl -sL -o ${FONT}`
    );
  }
  if (!existsSync(INTRO)) {
    throw new Error(`[reel] missing intro video: ${INTRO}`);
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

  // Each clip's head trim: its recorded loading time when openLesson marked
  // it, never less than the paint-in flash floor.
  const marks = loadTrimMarks(sourceDir);
  const trims = clips.map((clip) => Math.max(TRIM_HEAD, marks.get(clip.id) ?? TRIM_HEAD));
  const durations = clips.map((clip, i) => ffprobeDuration(clip.file) - trims[i]);

  const inputs: string[] = [];
  const filters: string[] = [];

  // Input 0: the animated logo reveal (4K/30fps -> reel format), with the
  // tagline fading in under the settled mark near the end.
  const introSeconds = ffprobeDuration(INTRO);
  inputs.push('-i', INTRO);
  filters.push(
    `[0:v]scale=1920:1080,` +
      `${drawText({ text: 'From zero to a working agent team', size: 46, x: '(w-text_w)/2', y: 'h-150', t0: introSeconds - 2.2, hold: 2.2, color: '0xd8e6e3' })},` +
      `settb=AVTB,fps=${REEL_FPS},setpts=PTS-STARTPTS[card]`
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
      `[${i + 1}:v]trim=start=${trims[i].toFixed(3)},setpts=PTS-STARTPTS,scale=1920:1080,` +
        `${drawText({ text: lesson.title, size: 48, x: '64', y: 'h-180', t0: TITLE_IN, hold: TITLE_HOLD, box: true })},` +
        `${drawText({ text: lesson.tagline, size: 30, x: '64', y: 'h-110', t0: TITLE_IN + 0.25, hold: TITLE_HOLD - 0.25, color: '0xd8e6e3', box: true })},` +
        `settb=AVTB,fps=${REEL_FPS}[v${i}]`
    );
  });

  // Fade-through-black chain: intro -> v0 -> v1 -> ...
  const allDurations = [introSeconds, ...durations];
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

  // A silent stereo track rides along: some TV media players (the Roku USB
  // player included) are unhappy with video-only files.
  const silentAudioIndex = clips.length + 1;
  const args = [
    '-y',
    ...inputs,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-map',
    `${silentAudioIndex}:a`,
    '-shortest',
    '-r',
    String(REEL_FPS),
    '-fps_mode',
    'cfr',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-level:v',
    '4.2',
    '-crf',
    '20',
    '-preset',
    'medium',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    OUT_FILE,
  ];
  console.log(`[reel] stitching ${clips.length} lessons (+title card) -> ${OUT_FILE}`);
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'pipe'] });
  console.log(`[reel] done — ~${Math.round(total)}s total`);
}

main();
