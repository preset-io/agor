// Regenerates SYLLABUS.md from support/syllabus.ts — the metadata is the
// source of truth; the markdown is a rendering. Run: npm run syllabus:md

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DONE_LESSONS, PLANNED_LESSONS } from '../support/syllabus.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'SYLLABUS.md');

const lines: string[] = [];
lines.push('<!-- GENERATED from support/syllabus.ts — edit there, then `npm run syllabus:md`. -->');
lines.push('');
lines.push('# The Agor syllabus');
lines.push('');
lines.push(
  'A soup-to-nuts course in real Agor, taught by the E2E suite itself. Every',
  'lesson in `tests/flow/` drives the REAL daemon + UI — no fixtures, no staged',
  'components — starting from a completely empty workspace and onboarding it',
  'one step at a time. Each lesson:',
  '',
  '- **is a regression test** — it runs against real services and asserts real outcomes;',
  '- **records a training-ready video snippet** — paced for a human viewer, signed in from the first frame, 1080p by default (`AGOR_E2E_VIDEO=4k` for true 4K);',
  '- **leaves the state the next lesson starts from** — one continuous story, so lessons run in order (`workers: 1`, no retries).',
  '',
  '## Running it',
  '',
  '```bash',
  'npm run test:replay   # the whole flow, no network, no model cost',
  'npm run test:live     # re-records the cassette: real (metered) model calls',
  'npm test              # UI/DB lessons only; agent lessons skip',
  'npm run reel          # stitch the lesson videos into one reel (titles + crossfades)',
  'npm run syllabus:md   # regenerate this file from support/syllabus.ts',
  '```',
  '',
  '`AGOR_E2E_KEEP_SCRATCH=1` skips the from-zero reset to iterate on one later',
  'lesson against existing state. Videos land in `test-results/<lesson>/video.webm`',
  '(cleared each run — `npm run reel` snapshots them).',
  ''
);

lines.push('## Lessons');
lines.push('');
for (const lesson of DONE_LESSONS) {
  lines.push(`### ${lesson.number} · ${lesson.title}`);
  lines.push('');
  lines.push(`*${lesson.tagline}*${lesson.agent ? ' · _agent lesson_' : ''}`);
  lines.push('');
  for (const beat of lesson.script) {
    lines.push(`1. ${beat}`);
  }
  lines.push('');
  lines.push(`**Ends with:** ${lesson.endsWith}`);
  lines.push('');
}

lines.push('## Planned');
lines.push('');
for (const lesson of PLANNED_LESSONS) {
  lines.push(`### ${lesson.number} · ${lesson.title}`);
  lines.push('');
  lines.push(`*${lesson.tagline}*${lesson.agent ? ' · _agent lesson_' : ''}`);
  lines.push('');
  for (const beat of lesson.script) {
    lines.push(`1. ${beat}`);
  }
  lines.push('');
  lines.push(`**Ends with:** ${lesson.endsWith}`);
  if (lesson.notes) {
    lines.push('');
    lines.push(`> ${lesson.notes}`);
  }
  lines.push('');
}

lines.push('## How the from-zero environment works (support/harness.ts)');
lines.push('');
lines.push(
  '- Scratch SQLite DB + git data home in `.e2e-runtime/` (wiped every run), dedicated ports — never touches `~/.agor`.',
  '- The daemon’s own first-run bootstrap creates the development admin (`admin@agor.live` / `admin`, three explicit env gates, dev-only).',
  '- Login happens over REST in global-setup and is minted into a Playwright storageState — recordings never show the login form.',
  '- Demo repos are mirrored once into `.e2e-cache/` (the only network fetch ever) and fresh working clones are cut per run: `preset-io/donut-shop` (the project the syllabus onboards) and `preset-io/agor-teammate` (pre-registered via `POST /repos/local` so the onboarding wizard’s auto-clone never fires mid-recording).',
  '- Agent traffic goes through the record/replay cassette proxy (support/cassette-proxy.ts) via the credential’s base-URL override — see support/agent-settings.ts for why the API-key sign-in method is the sanctioned way to carry one.',
  '',
  '## Conventions for new lessons',
  '',
  '- Add the lesson to `support/syllabus.ts` FIRST (status `planned`, with its beat sheet), then implement `tests/flow/NN-id.spec.ts` to match; flip to `done` when it records.',
  '- Use `support/pacing.ts` verbs (`glideAndClick`, `spotlight`, `typeInto`, `beat`, `settle`) — never raw `click()`/`type()` — so the video reads as a person demoing, not a test racing.',
  '- Open with `openLesson(page, path)`; re-`reassertCursor` after in-app navigations that re-render the shell.',
  '- Assert the lesson’s real outcome, and never on text the lesson itself typed (a model reply must be proven by words only the model could have produced).',
  '- Gate model-touching lessons on `resolveAgentMode()`.',
  ''
);

writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${OUT}`);
