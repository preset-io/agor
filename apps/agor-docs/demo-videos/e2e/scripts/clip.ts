// Record and export one standalone clip (support/clips.ts).
//
//   npm run clip -- <id>                 # record (replay mode for agent clips) + export
//   npm run clip -- <id> --live          # agent clips: record real (metered) turns
//   npm run clip -- <id> --4k            # capture at 3840×2160 (verify smoothness!)
//   npm run clip -- <id> --export-only   # re-export the last recording
//
// Recording restores the clip's starting checkpoint (startFrom), runs
// tests/clips/<id>.spec.ts in the `clips` project, and keeps Playwright's
// video. Export trims the boot screens off the head (openLesson's trim
// mark) and writes, into ~/Desktop/agor_video/clips/<id>/:
//   <id>.mp4             1080p h264 master (CRF 18, CFR 30, faststart)
//   <id>-poster.jpg
//   site:  <id>-1600.mp4 (CRF 23), <id>-540.mp4 (CRF 25)  — agor.live renditions
//   tv:    <id>-4k30.mp4 (lanczos upscale, silent AAC for Roku)
// then opens the folder.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipById } from '../support/clips.ts';
import { CHECKPOINTS_DIR, SCRATCH_DIR, TEST_RESULTS_DIR } from '../support/harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E_DIR = path.resolve(HERE, '..');
const OUT_ROOT = path.join(os.homedir(), 'Desktop', 'agor_video', 'clips');
const TRIM_MARKS_FILE = path.join(SCRATCH_DIR, 'trim-marks.jsonl');

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const result = spawnSync(cmd, args, { cwd: E2E_DIR, env, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}`);
  }
}

function ffmpeg(args: string[]): void {
  sh('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
}

/** The newest video Playwright recorded for this clip's test. */
function latestVideo(id: string): string {
  if (!existsSync(TEST_RESULTS_DIR)) throw new Error(`No test results in ${TEST_RESULTS_DIR}`);
  const dirs = readdirSync(TEST_RESULTS_DIR)
    .filter((d) => d.includes(id))
    .map((d) => path.join(TEST_RESULTS_DIR, d, 'video.webm'))
    .filter((f) => existsSync(f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (dirs.length === 0) throw new Error(`No recorded video for ${id} under ${TEST_RESULTS_DIR}`);
  return dirs[0];
}

/** Seconds of boot screens to cut from the head (last mark for this id). */
function trimSeconds(id: string): number {
  if (!existsSync(TRIM_MARKS_FILE)) return 0;
  let trim = 0;
  for (const line of readFileSync(TRIM_MARKS_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const mark = JSON.parse(line) as { lessonId: string; trimSeconds: number };
    if (mark.lessonId === id) trim = mark.trimSeconds;
  }
  return trim;
}

function main(): void {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) throw new Error('Usage: npm run clip -- <id> [--live] [--4k] [--export-only]');
  const clip = clipById(id);

  if (!args.includes('--export-only')) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (clip.startFrom) {
      if (!existsSync(path.join(CHECKPOINTS_DIR, clip.startFrom))) {
        throw new Error(
          `Checkpoint ${clip.startFrom} is missing from ${CHECKPOINTS_DIR}. Run the flow ` +
            '(npm run test:replay) once to build the checkpoint ladder.'
        );
      }
      env.AGOR_E2E_FROM_CHECKPOINT = clip.startFrom;
    }
    if (clip.agent) env.AGOR_E2E_AGENT_MODE = args.includes('--live') ? 'live' : 'replay';
    if (args.includes('--4k')) env.AGOR_E2E_VIDEO = '4k';
    sh('npx', ['playwright', 'test', '--project=clips', `tests/clips/${id}.spec.ts`], env);
  }

  const source = latestVideo(id);
  const trim = trimSeconds(id);
  const outDir = path.join(OUT_ROOT, id);
  mkdirSync(outDir, { recursive: true });
  const master = path.join(outDir, `${id}.mp4`);
  console.log(`[clip] exporting ${source} (trimming ${trim.toFixed(2)}s of boot screens)`);

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
    trim.toFixed(3),
    '-i',
    source,
    '-vf',
    'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p',
    ...h264,
    '-crf',
    '18',
    '-an',
    master,
  ]);
  ffmpeg([
    '-ss',
    '0.5',
    '-i',
    master,
    '-vframes',
    '1',
    '-q:v',
    '3',
    path.join(outDir, `${id}-poster.jpg`),
  ]);

  if (clip.outputs.includes('site')) {
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
        path.join(outDir, `${id}-${suffix}.mp4`),
      ]);
    }
  }
  if (clip.outputs.includes('tv')) {
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
      path.join(outDir, `${id}-4k30.mp4`),
    ]);
  }

  console.log(`[clip] wrote ${readdirSync(outDir).join(', ')} to ${outDir}`);
  if (process.platform === 'darwin') spawnSync('open', [outDir]);
}

main();
