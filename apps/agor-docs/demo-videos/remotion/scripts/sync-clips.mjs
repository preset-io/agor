// Pull the teammate clips the e2e studio exported (npm run clip -- <id> --snappy
// in ../e2e) into this project: the 4K tight raw cuts into public/clips/,
// and their marks into src/teammates/marks.json, which the composition times
// itself from.
//
//   npm run sync
//
// Videos stay out of git (public/clips/ is ignored); the marks are committed
// so the edit is reviewable.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  // The sharp close-up stills of the question being typed (one per key).
  const stills = path.join(dir, `teammate-${bot}-snappy-stills`);
  if (existsSync(stills)) {
    const to = path.join(ROOT, 'public', 'clips', `${bot}-stills`);
    rmSync(to, { recursive: true, force: true });
    cpSync(stills, to, { recursive: true });
    const index = JSON.parse(readFileSync(path.join(stills, 'index.json'), 'utf8'));
    marks[bot].stills = { rect: index.rect, scale: index.scale, count: index.files.length };
  }
  console.log(`${bot}: ${JSON.stringify(marks[bot])}`);
}
// The Agor logo draw-on (from the syllabus reel) opens the edits.
copyFileSync(
  path.join(ROOT, '..', 'animated_agor_logo', 'agor_logo_reveal_4k.mp4'),
  path.join(ROOT, 'public', 'clips', 'agor-logo.mp4')
);
writeFileSync(
  path.join(ROOT, 'src', 'teammates', 'marks.json'),
  `${JSON.stringify(marks, null, 2)}\n`
);

// "Raise AI teammates together": one UI clip per pillar (snappy, untightened
// raw), with every mark it logged.
const PILLARS = ['personality', 'integrity', 'capability', 'agency'];
const raiseMarks = {};
const raiseCursors = {};
for (const pillar of PILLARS) {
  const id = `raise-${pillar}`;
  const dir = path.join(CLIPS, id);
  const video = path.join(dir, `${id}-snappy-raw.mp4`);
  const markFile = path.join(dir, `${id}-snappy-marks.json`);
  if (!existsSync(video) || !existsSync(markFile)) {
    throw new Error(`missing ${video} (run: npm run clip -- ${id} --snappy in ../e2e)`);
  }
  copyFileSync(video, path.join(ROOT, 'public', 'clips', `${id}.mp4`));
  raiseMarks[pillar] = Object.fromEntries(
    JSON.parse(readFileSync(markFile, 'utf8')).map((m) => [m.label, m.seconds])
  );
  // The cursorless take's mouse path, for the edit's own cursor.
  const cursorFile = path.join(dir, `${id}-snappy-cursor.json`);
  if (existsSync(cursorFile)) raiseCursors[pillar] = JSON.parse(readFileSync(cursorFile, 'utf8'));
  console.log(`${id}: ${JSON.stringify(raiseMarks[pillar])}`);
}
mkdirSync(path.join(ROOT, 'src', 'raise'), { recursive: true });
writeFileSync(
  path.join(ROOT, 'src', 'raise', 'marks.json'),
  `${JSON.stringify(raiseMarks, null, 2)}\n`
);
writeFileSync(path.join(ROOT, 'src', 'raise', 'cursors.json'), `${JSON.stringify(raiseCursors)}\n`);

// "Multiply engineering throughput": the EngTeam clips (snappy, untightened
// raw), with every mark, the mouse path, and the typing stills.
const ENG = ['eng-build', 'eng-fanout', 'eng-flow'];
const engMarks = {};
const engCursors = {};
for (const id of ENG) {
  const dir = path.join(CLIPS, id);
  const video = path.join(dir, `${id}-snappy-raw.mp4`);
  const markFile = path.join(dir, `${id}-snappy-marks.json`);
  if (!existsSync(video) || !existsSync(markFile)) {
    throw new Error(`missing ${video} (run: npm run clip -- ${id} --snappy in ../e2e)`);
  }
  copyFileSync(video, path.join(ROOT, 'public', 'clips', `${id}.mp4`));
  engMarks[id] = Object.fromEntries(
    JSON.parse(readFileSync(markFile, 'utf8')).map((m) => [m.label, m.seconds])
  );
  const cursorFile = path.join(dir, `${id}-snappy-cursor.json`);
  if (existsSync(cursorFile)) engCursors[id] = JSON.parse(readFileSync(cursorFile, 'utf8'));
  const stills = path.join(dir, `${id}-snappy-stills`);
  if (existsSync(stills)) {
    const to = path.join(ROOT, 'public', 'clips', `${id}-stills`);
    rmSync(to, { recursive: true, force: true });
    cpSync(stills, to, { recursive: true });
    const index = JSON.parse(readFileSync(path.join(stills, 'index.json'), 'utf8'));
    engMarks[id].stills = { rect: index.rect, scale: index.scale, count: index.files.length };
  }
  console.log(`${id}: ${JSON.stringify(engMarks[id])}`);
}
mkdirSync(path.join(ROOT, 'src', 'throughput'), { recursive: true });
writeFileSync(
  path.join(ROOT, 'src', 'throughput', 'marks.json'),
  `${JSON.stringify(engMarks, null, 2)}\n`
);
writeFileSync(
  path.join(ROOT, 'src', 'throughput', 'cursors.json'),
  `${JSON.stringify(engCursors)}\n`
);
