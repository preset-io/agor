// Pull the teammate clips the e2e studio exported (npm run clip -- <id> --snappy
// in ../e2e) into this project: the 4K tight raw cuts into public/clips/,
// and their marks into src/teammates/marks.json, which the composition times
// itself from.
//
//   npm run sync
//
// Videos stay out of git (public/clips/ is ignored); the marks are committed
// so the edit is reviewable.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIPS =
  process.env.AGOR_CLIPS_DIR ?? path.join(os.homedir(), 'Desktop', 'agor_video', 'clips');
const BOTS = ['databot', 'engbot', 'legalbot', 'opsbot'];
// Which cut to use: the snappy replay, tightened (the trailer cut).
const CUT = process.env.AGOR_CLIP_CUT ?? 'snappy-tight';

mkdirSync(path.join(ROOT, 'public', 'clips'), { recursive: true });
const marks = {};
for (const bot of BOTS) {
  const dir = path.join(CLIPS, `teammate-${bot}`);
  const video = path.join(dir, `teammate-${bot}-${CUT}-raw.mp4`);
  const markFile = path.join(dir, `teammate-${bot}-${CUT}-marks.json`);
  if (!existsSync(video) || !existsSync(markFile)) {
    throw new Error(`missing ${video} (run: npm run clip -- teammate-${bot} --snappy in ../e2e)`);
  }
  copyFileSync(video, path.join(ROOT, 'public', 'clips', `${bot}.mp4`));
  const byLabel = Object.fromEntries(
    JSON.parse(readFileSync(markFile, 'utf8')).map((m) => [m.label, m.seconds])
  );
  marks[bot] = { question: byLabel.question, sent: byLabel.sent, answered: byLabel.answered };
  console.log(`${bot}: ${JSON.stringify(marks[bot])}`);
}
writeFileSync(
  path.join(ROOT, 'src', 'teammates', 'marks.json'),
  `${JSON.stringify(marks, null, 2)}\n`
);
