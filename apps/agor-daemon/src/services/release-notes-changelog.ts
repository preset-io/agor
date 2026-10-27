/**
 * Self-hosted release notes: CHANGELOG.md -> ReleaseNoteDTO[].
 *
 * The release PR that finalizes a CHANGELOG section is the review step, so
 * every released Features/Fixes/Security/Breaking entry becomes an `update`
 * item. `## Unreleased` and Chores never ship. A small highlights sidecar
 * (next to the visuals in `apps/agor-docs/public/whats-new/`) can promote an
 * entry, keyed by PR number, to `major` with modal copy, visuals and a CTA.
 *
 * Runs once at daemon startup on the CHANGELOG copied into dist/ (or the
 * repository copy in a source checkout).
 */

import type { ReleaseNoteDTO, ReleaseNoteItemCategory, ReleaseNoteItemDTO } from '@agor/core/types';

export const BUNDLED_RELEASE_NOTE_VERSIONS = 10;

const SECTION_CATEGORIES: Record<string, ReleaseNoteItemCategory> = {
  Features: 'feature',
  Fixes: 'fix',
  Security: 'security',
  Breaking: 'improvement',
};

/** Fields a highlight may set on the entry whose PR it names. */
export type ReleaseNoteHighlight = Partial<
  Pick<
    ReleaseNoteItemDTO,
    | 'tier'
    | 'audience'
    | 'title'
    | 'subtitle'
    | 'agent_brief'
    | 'docs_url'
    | 'visual_url'
    | 'visual_url_dark'
    | 'cta_label'
    | 'cta_path'
  >
>;

export interface ReleaseNoteHighlights {
  /** Keyed by preset-io/agor PR number. */
  items?: Record<string, ReleaseNoteHighlight>;
}

const VERSION_HEADING = /^## (?:\[([^\]]+)\]\([^)]*\)|(\S+))\s*\((\d{4}-\d{2}-\d{2})\)\s*$/;
const PR_LINK = /\[#(\d+)\]\([^)]*\)/g;
const TRAILING_PR_LINKS = /\s*\((?:\[#\d+\]\([^)]*\)(?:,\s*)?)+\)\s*\.?\s*$/;
const HEADLINE = /^\*\*(.+?)\*\*\s*(?:[—–]|-)\s*/;

function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseEntry(
  lines: string[],
  id: string,
  category: ReleaseNoteItemCategory
): ReleaseNoteItemDTO {
  const [first, ...rest] = lines;
  const text = first.replace(/^- /, '').trim();
  const prNumbers = [...new Set([...lines.join('\n').matchAll(PR_LINK)].map((m) => Number(m[1])))];
  const headline = text.match(HEADLINE);
  const title = headline ? headline[1].trim() : plainText(text).slice(0, 120);
  const rawLead = (headline ? text.slice(headline[0].length) : text)
    .replace(TRAILING_PR_LINKS, '')
    .trim();
  // Entries continue the headline ("**X** — adds ..."); standalone they start a sentence.
  const lead = rawLead.charAt(0).toUpperCase() + rawLead.slice(1);
  const details = rest
    .map((line) => line.replace(/^ {2}/, ''))
    .join('\n')
    .trim();
  const body = [lead, details].filter(Boolean).join('\n\n');
  return {
    id,
    tier: 'update',
    category,
    audience: 'all',
    title,
    subtitle: null,
    body_md: body,
    agent_brief: plainText(`${title}. ${lead}`).slice(0, 600),
    docs_url: null,
    visual_url: null,
    visual_url_dark: null,
    cta_label: null,
    cta_path: null,
    pr_numbers: prNumbers,
  };
}

/** Newest-first notes for the latest `limit` dated releases in `markdown`. */
export function parseChangelogReleaseNotes(
  markdown: string,
  highlights: ReleaseNoteHighlights = {},
  limit = BUNDLED_RELEASE_NOTE_VERSIONS
): ReleaseNoteDTO[] {
  const notes: ReleaseNoteDTO[] = [];
  let note: ReleaseNoteDTO | null = null;
  let category: ReleaseNoteItemCategory | null = null;
  let entry: string[] | null = null;

  const flushEntry = () => {
    if (note && category && entry) {
      note.items.push(parseEntry(entry, `${note.id}-${note.items.length + 1}`, category));
    }
    entry = null;
  };
  const flushNote = () => {
    flushEntry();
    if (note && note.items.length > 0) notes.push(note);
    note = null;
    category = null;
  };

  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      flushNote();
      if (notes.length >= limit) break;
      const heading = line.match(VERSION_HEADING);
      if (heading) {
        const version = heading[1] ?? heading[2];
        note = {
          id: `oss-${version}`,
          version,
          published_at: new Date(`${heading[3]}T00:00:00.000Z`).toISOString(),
          title: `Agor ${version}`,
          summary_md: null,
          items: [],
        };
      }
      continue;
    }
    if (!note) continue;
    if (line.startsWith('### ')) {
      flushEntry();
      category = SECTION_CATEGORIES[line.slice(4).trim()] ?? null;
      continue;
    }
    if (!category) continue;
    if (line.startsWith('- ')) {
      flushEntry();
      entry = [line];
    } else if (entry && line.startsWith('  ')) {
      entry.push(line);
    } else if (entry && line.trim() === '') {
      flushEntry();
    }
  }
  flushNote();

  const byPr = highlights.items ?? {};
  for (const item of notes.flatMap((n) => n.items)) {
    for (const pr of item.pr_numbers) {
      const highlight = byPr[String(pr)];
      if (highlight) Object.assign(item, highlight);
    }
  }
  return notes;
}
