/**
 * Validates apps/agor-docs/public/whats-new/highlights.json against the shared
 * feature announcement schema, and checks that every picture or video it names
 * is a file in that folder (served from https://agor.live/whats-new/).
 */
import { existsSync, readFileSync } from 'node:fs';
import { featureAnnouncementHighlightsSchema } from '../packages/core/src/types/feature-announcements.ts';

const folder = new URL('../apps/agor-docs/public/whats-new/', import.meta.url);
const file = new URL('highlights.json', folder);
const MEDIA_PREFIX = 'https://agor.live/whats-new/';

const result = featureAnnouncementHighlightsSchema.safeParse(
  JSON.parse(readFileSync(file, 'utf8'))
);
if (!result.success) {
  for (const issue of result.error.issues) {
    console.error(`highlights.json ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  process.exit(1);
}

const problems: string[] = [];
for (const [pr, entry] of Object.entries(result.data.items)) {
  if (entry.visual?.type !== 'media') continue;
  for (const url of [entry.visual.url, entry.visual.url_dark]) {
    if (!url) continue;
    if (!url.startsWith(MEDIA_PREFIX)) {
      problems.push(`items.${pr}.visual: ${url} must be served from ${MEDIA_PREFIX}`);
    } else if (!existsSync(new URL(url.slice(MEDIA_PREFIX.length), folder))) {
      problems.push(`items.${pr}.visual: ${url} is not in apps/agor-docs/public/whats-new/`);
    }
  }
}
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`highlights.json: ${Object.keys(result.data.items).length} highlight(s) OK`);
