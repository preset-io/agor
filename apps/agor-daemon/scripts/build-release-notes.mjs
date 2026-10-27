#!/usr/bin/env node
/**
 * Write dist/release-notes.json from the repository CHANGELOG.md plus the
 * optional highlights sidecar, for the `bundled` What's new source.
 *
 * Runs after tsup in `pnpm --filter @agor/daemon build` and reuses the
 * compiled parser and validator, so the shipped file is exactly what the
 * daemon would compute from a source checkout.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(scriptDir, '..', 'dist');
const repoRoot = join(scriptDir, '..', '..', '..');

const { BUNDLED_RELEASE_NOTES_FILE, parseChangelogReleaseNotes } = await import(
  join(distDir, 'services', 'release-notes-changelog.js')
);
const { parseReleaseNotes, RELEASE_NOTE_HIGHLIGHTS_PATH } = await import(
  join(distDir, 'services', 'release-notes.js')
);

const highlightsPath = join(repoRoot, RELEASE_NOTE_HIGHLIGHTS_PATH);
const highlights = existsSync(highlightsPath)
  ? JSON.parse(readFileSync(highlightsPath, 'utf8'))
  : {};
const notes = parseReleaseNotes(
  parseChangelogReleaseNotes(readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'), highlights)
);

writeFileSync(join(distDir, BUNDLED_RELEASE_NOTES_FILE), `${JSON.stringify(notes)}\n`);
console.log(`✅ Wrote ${BUNDLED_RELEASE_NOTES_FILE} (${notes.length} releases)`);
