// Record and export one standalone clip (support/clips.ts).
//
//   npm run clip -- <id>                # record + export
//   npm run clip -- <id> --export-only  # re-export the last take (after editing
//                                       # its timeline.jsonl: zooms, timing)
//   npm run clip -- <id> --live         # agent clips: record real (metered) turns
//   npm run clip -- <id> --snappy       # trailer pace: brisk beats, fast replay
//                                       # (recorded agent clips only); writes <id>-snappy*
//   npm run clip -- <id> --1080         # capture at 1080p (no lossless zoom)
//   npm run clip -- <id> --reseed       # rebuild the clip's seed first
//
// Recording: builds or reuses the clip's starting state (a seed, or the end
// of another clip, recording that one first if needed), restores it, and
// runs tests/clips/<id>.spec.ts. The take (timeline + each filmed actor's
// video) lands in <TEST_RESULTS_DIR>/takes/<id>/.
//
// Export renders the take (sync, head trim, camera moves, layout) into
// ~/Desktop/agor_video/clips/<id>/:
//   <id>.mp4             1080p30 h264 master (CRF 18, faststart)
//   <id>-poster.jpg
//   site:  <id>-1600.mp4 (CRF 23), <id>-540.mp4 (CRF 25)  — agor.live renditions
//   tv:    <id>-4k30.mp4 (lanczos upscale, silent AAC for Roku)
//   raw:   <id>-raw.mp4 (native 4K, no camera moves) + <id>-marks.json
//   tight: <id>-tight.mp4 (+ -tight-raw.mp4, -tight-marks.json): still
//          stretches squeezed to a beat (see planTighten in lib/render.ts)

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ClipMeta, clipById } from '../support/clips.ts';
import { CACHE_DIR, CASSETTES_DIR, CHECKPOINTS_DIR } from '../support/harness.ts';
import { readTimeline, takeDir } from '../support/timeline.ts';
import { planTighten, renderMaster } from './lib/render.ts';
import { ensureSeed } from './seed.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = path.resolve(HERE, '..');
const OUT_ROOT = path.join(os.homedir(), 'Desktop', 'agor_video', 'clips');
const FONT = path.join(CACHE_DIR, 'reel-assets', 'SpaceGrotesk.ttf');

interface Flags {
  live: boolean;
  /** Trailer pace: brisk scene beats and a fast, low-latency replay. */
  snappy: boolean;
  capture1080: boolean;
  reseed: boolean;
}

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(cmd, args, { cwd: E2E_DIR, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
}

function ffmpeg(args: string[]): void {
  sh('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
}

/** The checkpoint a clip starts from, building or recording it if it's missing. */
function resolveStart(clip: ClipMeta, flags: Flags): string | null {
  const start = clip.start;
  if (start === 'empty') return null;
  if ('seed' in start) return ensureSeed(start.seed, { rebuild: flags.reseed });
  if ('after' in start) {
    const name = `post-${start.after}`;
    if (!existsSync(path.join(CHECKPOINTS_DIR, name, 'agor-e2e.db'))) {
      console.log(
        `[clip] ${clip.id} starts where ${start.after} ends; recording ${start.after} first`
      );
      record(clipById(start.after), flags);
    }
    return name;
  }
  if (!existsSync(path.join(CHECKPOINTS_DIR, start.checkpoint, 'agor-e2e.db'))) {
    throw new Error(`Checkpoint ${start.checkpoint} is missing from ${CHECKPOINTS_DIR}`);
  }
  return start.checkpoint;
}

function record(clip: ClipMeta, flags: Flags): void {
  const checkpoint = resolveStart(clip, flags);
  const env: NodeJS.ProcessEnv = { ...process.env, AGOR_E2E_CHECKPOINTS: '0' };
  delete env.AGOR_E2E_FROM_CHECKPOINT;
  delete env.AGOR_E2E_AGENT_MODE;
  delete env.AGOR_E2E_HOLD_AGENTS;
  if (checkpoint) env.AGOR_E2E_FROM_CHECKPOINT = checkpoint;
  if (clip.agent === 'hold') {
    env.AGOR_E2E_CASSETTE_NAME = `clip-${clip.id}`;
    env.AGOR_E2E_AGENT_MODE = 'replay';
    env.AGOR_E2E_HOLD_AGENTS = '1';
  } else if (clip.agent) {
    const cassette = `clip-${clip.id}`;
    env.AGOR_E2E_CASSETTE_NAME = cassette;
    const recorded = existsSync(path.join(CASSETTES_DIR, `${cassette}.json`));
    if (!recorded && !flags.live) {
      throw new Error(
        `${clip.id} films agent turns and has no cassette yet: record it with --live`
      );
    }
    env.AGOR_E2E_AGENT_MODE = flags.live ? 'live' : 'replay';
  }
  if (flags.snappy) {
    if (flags.live)
      throw new Error('--snappy replays a recorded take; capture it first with --live');
    env.AGOR_E2E_PACE = 'snappy';
    // Answers stream 3x faster and each model call starts within 150 ms;
    // tool calls (queries, files, the gh stand-in) still really run.
    env.AGOR_E2E_REPLAY_SPEED = '3';
    env.AGOR_E2E_REPLAY_FIRST_CHUNK_MS = '150';
  } else {
    delete env.AGOR_E2E_PACE;
  }
  env.AGOR_E2E_VIDEO = flags.capture1080 || clip.capture === '1080' ? '1080' : '4k';
  sh('npx', ['playwright', 'test', '--project=clips', `tests/clips/${clip.id}.spec.ts`], env);
}

function exportClip(clip: ClipMeta, open: boolean, pace?: 'snappy'): void {
  const dir = takeDir(clip.id, pace);
  // The snappy take's files sit beside the honest ones: <id>-snappy*.
  const name = pace === 'snappy' ? `${clip.id}-snappy` : clip.id;
  const events = readTimeline(dir);
  const filmed = events.flatMap((e) =>
    e.type === 'actor' && (e.video || e.frames) ? [e.actor] : []
  );
  const outDir = path.join(OUT_ROOT, clip.id);
  mkdirSync(outDir, { recursive: true });
  const master = path.join(outDir, `${name}.mp4`);
  console.log(`[clip] rendering ${clip.id} (${filmed.join(' + ')})...`);
  const warnings = renderMaster({
    takeDir: dir,
    events,
    actors: filmed,
    layout: clip.layout ?? 'single',
    out: master,
    font: FONT,
  });
  for (const w of warnings) console.warn(`[clip] warning: ${w}`);

  const ready = events.find((e) => e.type === 'ready');
  const marks = events.flatMap((e) =>
    e.type === 'mark' && ready
      ? [{ label: e.label, frame: Math.round(((e.wall - ready.wall) * 30) / 1000) }]
      : []
  );
  const writeMarks = (file: string, map: (frame: number) => number = (f) => f) =>
    writeFileSync(
      path.join(outDir, file),
      `${JSON.stringify(
        marks.map((m) => ({ label: m.label, seconds: Number((map(m.frame) / 30).toFixed(3)) })),
        null,
        2
      )}\n`
    );

  // The cursor's path (every sample of every glide) and its clicks, for an
  // edit that draws its own cursor over a cursorless take; and any close-up
  // stills (studio typeStills), with when each was taken.
  const at = (wall: number) => Math.round(((wall - (ready?.wall ?? wall)) * 30) / 1000);
  const writeCursor = (file: string, map: (frame: number) => number = (f) => f) => {
    const sec = (wall: number) => Number((map(at(wall)) / 30).toFixed(3));
    const pointer = events.flatMap((e) =>
      e.type === 'pointer' && ready && e.wall >= ready.wall ? [[sec(e.wall), e.x, e.y]] : []
    );
    const clicks = events.flatMap((e) =>
      e.type === 'click' && ready && e.wall >= ready.wall ? [[sec(e.wall), e.x, e.y]] : []
    );
    if (pointer.length === 0) return;
    writeFileSync(path.join(outDir, file), `${JSON.stringify({ pointer, clicks })}\n`);
  };
  const stills = events.flatMap((e) => (e.type === 'still' ? [e] : []));
  if (stills.length > 0) {
    const stillsDir = path.join(outDir, `${name}-stills`);
    rmSync(stillsDir, { recursive: true, force: true });
    mkdirSync(stillsDir, { recursive: true });
    for (const st of stills)
      cpSync(path.join(dir, st.file), path.join(stillsDir, path.basename(st.file)));
    writeFileSync(
      path.join(stillsDir, 'index.json'),
      `${JSON.stringify(
        {
          rect: stills[0].rect,
          scale: stills[0].scale,
          files: stills.map((st) => path.basename(st.file)),
        },
        null,
        2
      )}\n`
    );
  }

  if (clip.outputs.includes('raw')) {
    console.log(`[clip] rendering the raw 4K cut...`);
    renderMaster({
      takeDir: dir,
      events,
      actors: filmed,
      layout: 'single',
      out: path.join(outDir, `${name}-raw.mp4`),
      raw: true,
    });
    writeMarks(`${name}-marks.json`);
    writeCursor(`${name}-cursor.json`);
  }

  if (clip.outputs.includes('tight')) {
    // Tight cut: still stretches (thinking, queries, ticking timers)
    // squeezed to a beat; motion, typing, marks and camera moves kept whole.
    const plan = planTighten(dir, events, filmed[0]);
    console.log(
      `[clip] tight cut: ${(plan.frames / 30).toFixed(1)}s -> ${(plan.keptFrames / 30).toFixed(1)}s`
    );
    renderMaster({
      takeDir: dir,
      events,
      actors: filmed,
      layout: 'single',
      out: path.join(outDir, `${name}-tight.mp4`),
      keep: plan.keep,
    });
    if (clip.outputs.includes('raw')) {
      renderMaster({
        takeDir: dir,
        events,
        actors: filmed,
        layout: 'single',
        out: path.join(outDir, `${name}-tight-raw.mp4`),
        raw: true,
        keep: plan.keep,
      });
    }
    writeMarks(`${name}-tight-marks.json`, plan.map);
    writeCursor(`${name}-tight-cursor.json`, plan.map);
  }

  const h264 = [
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-preset',
    'slow',
    '-movflags',
    '+faststart',
  ];
  ffmpeg([
    '-ss',
    '0.5',
    '-i',
    master,
    '-vframes',
    '1',
    '-q:v',
    '3',
    path.join(outDir, `${name}-poster.jpg`),
  ]);
  if (clip.outputs.includes('site') && !pace) {
    for (const [w, h, crf, suffix] of [
      [1600, 900, 23, '1600'],
      [960, 540, 25, '540'],
    ] as const) {
      ffmpeg([
        '-i',
        master,
        '-vf',
        `scale=${w}:${h}:flags=lanczos,format=yuv420p`,
        ...h264,
        '-crf',
        String(crf),
        '-an',
        path.join(outDir, `${clip.id}-${suffix}.mp4`),
      ]);
    }
  }
  if (clip.outputs.includes('tv') && !pace) {
    ffmpeg([
      '-i',
      master,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-vf',
      'scale=3840:2160:flags=lanczos,format=yuv420p',
      ...h264,
      '-crf',
      '17',
      '-level',
      '5.1',
      '-c:a',
      'aac',
      '-shortest',
      path.join(outDir, `${clip.id}-4k30.mp4`),
    ]);
  }
  console.log(`[clip] wrote ${readdirSync(outDir).join(', ')} to ${outDir}`);
  if (open && process.platform === 'darwin') spawnSync('open', [outDir]);
}

/** Keep the Mac from idle-sleeping while this process runs (a long agent take). */
function stayAwake(): void {
  if (process.platform !== 'darwin') return;
  const awake = spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore' });
  awake.unref();
}

function main(): void {
  stayAwake();
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    throw new Error(
      'Usage: npm run clip -- <id> [--export-only] [--live] [--snappy] [--1080] [--reseed] [--no-open]'
    );
  }
  const clip = clipById(id);
  const flags: Flags = {
    live: args.includes('--live'),
    snappy: args.includes('--snappy'),
    capture1080: args.includes('--1080'),
    reseed: args.includes('--reseed'),
  };
  if (!args.includes('--export-only')) record(clip, flags);
  exportClip(clip, !args.includes('--no-open'), flags.snappy ? 'snappy' : undefined);
}

main();
