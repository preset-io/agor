// Assembles the agor.live stand-in video per Evan's shot list:
// animated logo reveal → homepage capture (trimmed to where the show
// starts) → the same logo reveal played BACKWARDS as the outro.
// Output: 4K30 h264 high@5.1 + silent AAC, Roku-friendly.
//
//   npx tsx scripts/stitch-agorlive.ts

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCRATCH_DIR } from '../support/harness.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const E2E_ROOT = path.join(HERE, '..');
const INTRO = path.join(E2E_ROOT, '..', 'animated_agor_logo', 'agor_logo_reveal_4k.mp4');
const CAPTURE_DIR = path.join(SCRATCH_DIR, 'agorlive-capture');
const OUT = path.join(
  process.env.HOME ?? '~',
  'Desktop',
  'agor_video',
  'agor-live-standin-4k30.mp4'
);

const FADE = 0.7;
const FPS = 30;

function ffprobeDuration(file: string): number {
  return Number.parseFloat(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      file,
    ])
      .toString()
      .trim()
  );
}

function main(): void {
  const capture = execFileSync('ls', [CAPTURE_DIR])
    .toString()
    .split('\n')
    .find((f) => f.endsWith('.webm'));
  if (!capture) throw new Error(`no capture .webm in ${CAPTURE_DIR}`);
  const captureFile = path.join(CAPTURE_DIR, capture);
  const trimJson = path.join(CAPTURE_DIR, 'trim.json');
  const trim = existsSync(trimJson)
    ? (JSON.parse(readFileSync(trimJson, 'utf-8')).trimSeconds as number)
    : 0.6;

  const introSeconds = ffprobeDuration(INTRO);
  const captureSeconds = ffprobeDuration(captureFile) - trim;

  // Inputs: 0 = logo (intro), 1 = capture, 2 = logo again (reversed).
  const filters = [
    `[0:v]scale=3840:2160,settb=AVTB,fps=${FPS},setpts=PTS-STARTPTS[intro]`,
    `[1:v]trim=start=${trim.toFixed(3)},setpts=PTS-STARTPTS,scale=3840:2160:flags=lanczos,` +
      `settb=AVTB,fps=${FPS}[body]`,
    `[2:v]scale=3840:2160,settb=AVTB,fps=${FPS},reverse,setpts=PTS-STARTPTS[outro]`,
    `[intro][body]xfade=transition=fadeblack:duration=${FADE}:offset=${(introSeconds - FADE).toFixed(3)}[a]`,
    `[a][outro]xfade=transition=fadeblack:duration=${FADE}:offset=${(introSeconds - FADE + captureSeconds - FADE).toFixed(3)}[reel]`,
    `[reel]format=yuv420p[out]`,
  ];

  const args = [
    '-y',
    '-i',
    INTRO,
    '-i',
    captureFile,
    '-i',
    INTRO,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-map',
    '3:a',
    '-shortest',
    '-r',
    String(FPS),
    '-fps_mode',
    'cfr',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-level:v',
    '5.1',
    '-crf',
    '17',
    '-preset',
    'medium',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    OUT,
  ];
  const total = introSeconds * 2 + captureSeconds - FADE * 2;
  console.log(`[stitch-agorlive] ${Math.round(total)}s -> ${OUT}`);
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'pipe'] });
  console.log('[stitch-agorlive] done');
}

main();
