/**
 * Self-hosted feature announcements: CHANGELOG.md -> FeatureAnnouncementDTO[].
 *
 * Highlights only: every released Features entry becomes an item, and so does
 * any other entry that `highlights.json` (next to the visuals in
 * `apps/agor-docs/public/whats-new/`) names by PR number; the highlight sets its
 * in-app copy, picture, button and channels. Fixes, Security, Breaking and
 * Chores entries without a highlight never ship, nor does `## Unreleased`.
 *
 * Runs once at daemon startup on the CHANGELOG copied into dist/ (or the
 * repository copy in a source checkout).
 */

import {
  FEATURE_ANNOUNCEMENT_TEXT_LIMITS,
  FEATURE_ANNOUNCEMENTS_LIMITS,
  type FeatureAnnouncementDTO,
  type FeatureAnnouncementHighlights,
  type FeatureAnnouncementItemDTO,
} from '@agor/core/types';

export const BUNDLED_FEATURE_ANNOUNCEMENT_VERSIONS = 10;

const VERSION_HEADING = /^## (?:\[([^\]]+)\]\([^)]*\)|(\S+))\s*\((\d{4}-\d{2}-\d{2})\)\s*$/;
const PR_LINK = /\[#(\d+)\]\([^)]*\)/g;
const TRAILING_PR_LINKS = /\s*\((?:\[#\d+\]\([^)]*\)(?:,\s*)?)+\)\s*\.?\s*$/;
const HEADLINE = /^\*\*(.+?)\*\*\s*(?:[—–]|-)\s*/;

function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** At most `max` characters, cut on a word boundary with an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

function parseEntry(
  lines: string[],
  id: string,
  kind: FeatureAnnouncementItemDTO['kind'],
  newUntil: string
): FeatureAnnouncementItemDTO {
  const text = lines[0].replace(/^- /, '').trim();
  const prNumbers = [...new Set([...lines.join('\n').matchAll(PR_LINK)].map((m) => Number(m[1])))];
  const headline = text.match(HEADLINE);
  const rawLead = plainText(
    (headline ? text.slice(headline[0].length) : text).replace(TRAILING_PR_LINKS, '')
  );
  // Entries continue the headline ("**X** — adds ..."); standalone they start a sentence.
  const lead = rawLead.charAt(0).toUpperCase() + rawLead.slice(1);
  const title = plainText(headline ? headline[1] : text);
  const oneLine = lead.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? lead;
  return {
    id,
    kind,
    title: clip(title, FEATURE_ANNOUNCEMENT_TEXT_LIMITS.title),
    one_line: clip(oneLine || title, FEATURE_ANNOUNCEMENT_TEXT_LIMITS.oneLine),
    learn_more_url: null,
    visual: null,
    visual_alt: null,
    button: null,
    badge: kind === 'new',
    popup: false,
    new_until: newUntil,
    roles: 'everyone',
    tenant_ids: null,
    pr_numbers: prNumbers,
    agent_brief: clip(`${title}. ${lead}`, 600),
  };
}

/** Newest-first releases for the latest `limit` dated versions in `markdown` that have items. */
export function parseChangelogFeatureAnnouncements(
  markdown: string,
  highlights: FeatureAnnouncementHighlights['items'] = {},
  limit = BUNDLED_FEATURE_ANNOUNCEMENT_VERSIONS
): FeatureAnnouncementDTO[] {
  const releases: FeatureAnnouncementDTO[] = [];
  let release: FeatureAnnouncementDTO | null = null;
  let newUntil = '';
  // Features are new and ring the bell; any other section's entries improve
  // something that exists and only ship when highlighted.
  let kind: FeatureAnnouncementItemDTO['kind'] | null = null;
  let entry: string[] | null = null;

  const flushEntry = () => {
    if (release && kind && entry) {
      const item = parseEntry(entry, `${release.id}-${release.items.length + 1}`, kind, newUntil);
      // Keyed by the entry's first PR so seen state survives reordering;
      // entries without a PR (or sharing it) keep the positional ID.
      const prId = item.pr_numbers.length > 0 ? `${release.id}-pr${item.pr_numbers[0]}` : null;
      if (prId && !release.items.some((other) => other.id === prId)) item.id = prId;
      release.items.push(item);
    }
    entry = null;
  };

  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      flushEntry();
      kind = null;
      const heading = line.match(VERSION_HEADING);
      release = null;
      if (heading) {
        const version = heading[1] ?? heading[2];
        const published = new Date(`${heading[3]}T00:00:00.000Z`);
        newUntil = new Date(
          published.getTime() + FEATURE_ANNOUNCEMENTS_LIMITS.bundledNewDays * 86_400_000
        ).toISOString();
        release = {
          id: `oss-${version}`,
          label: version,
          version_label: `Agor ${version}`,
          published_at: published.toISOString(),
          items: [],
        };
        releases.push(release);
      }
      continue;
    }
    if (!release) continue;
    if (line.startsWith('### ')) {
      flushEntry();
      kind = line.slice(4).trim() === 'Features' ? 'new' : 'improved';
      continue;
    }
    if (!kind) continue;
    if (line.startsWith('- ')) {
      flushEntry();
      entry = [line];
    } else if (entry && line.startsWith('  ')) {
      entry.push(line);
    } else if (entry && line.trim() === '') {
      flushEntry();
    }
  }
  flushEntry();

  // A highlight applies to one entry only: the newest Features entry citing its
  // PR, else the newest entry citing it.
  const items = releases.flatMap((r) => r.items);
  const shipped = new Set(items.filter((item) => item.kind === 'new'));
  for (const [pr, highlight] of Object.entries(highlights)) {
    const citing = items.filter((item) => item.pr_numbers.includes(Number(pr)));
    const target = citing.find((item) => shipped.has(item)) ?? citing[0];
    if (!target) continue;
    Object.assign(target, highlight);
    shipped.add(target);
  }
  return releases
    .map((r) => ({ ...r, items: r.items.filter((item) => shipped.has(item)) }))
    .filter((r) => r.items.length > 0)
    .slice(0, limit);
}
