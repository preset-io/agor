/**
 * Self-hosted feature announcements: CHANGELOG.md -> FeatureAnnouncementDTO[].
 *
 * The release PR that finalizes a CHANGELOG section is the review step, so
 * every released Features/Fixes/Security/Breaking entry becomes an item.
 * `## Unreleased` and Chores never ship. `highlights.json` (next to the visuals
 * in `apps/agor-docs/public/whats-new/`) sets the in-app copy, picture, button
 * and channels for an entry, keyed by PR number.
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

/** Features are new; everything else improves something that exists. Features ring the bell. */
const SECTION_KINDS: Record<string, FeatureAnnouncementItemDTO['kind']> = {
  Features: 'new',
  Fixes: 'improved',
  Security: 'improved',
  Breaking: 'improved',
};

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

/** Newest-first releases for the latest `limit` dated versions in `markdown`. */
export function parseChangelogFeatureAnnouncements(
  markdown: string,
  highlights: FeatureAnnouncementHighlights['items'] = {},
  limit = BUNDLED_FEATURE_ANNOUNCEMENT_VERSIONS
): FeatureAnnouncementDTO[] {
  const releases: FeatureAnnouncementDTO[] = [];
  let release: FeatureAnnouncementDTO | null = null;
  let newUntil = '';
  let kind: FeatureAnnouncementItemDTO['kind'] | null = null;
  let entry: string[] | null = null;

  const flushEntry = () => {
    if (release && kind && entry) {
      release.items.push(
        parseEntry(entry, `${release.id}-${release.items.length + 1}`, kind, newUntil)
      );
    }
    entry = null;
  };
  const flushRelease = () => {
    flushEntry();
    if (release && release.items.length > 0) releases.push(release);
    release = null;
    kind = null;
  };

  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      flushRelease();
      if (releases.length >= limit) break;
      const heading = line.match(VERSION_HEADING);
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
      }
      continue;
    }
    if (!release) continue;
    if (line.startsWith('### ')) {
      flushEntry();
      kind = SECTION_KINDS[line.slice(4).trim()] ?? null;
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
  flushRelease();

  for (const item of releases.flatMap((r) => r.items)) {
    for (const pr of item.pr_numbers) {
      const highlight = highlights[String(pr)];
      if (highlight) Object.assign(item, highlight);
    }
  }
  return releases;
}
