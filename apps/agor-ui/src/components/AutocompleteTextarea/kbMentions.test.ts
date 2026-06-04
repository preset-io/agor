import { describe, expect, it } from 'vitest';
import { buildKbDocLink, filterKbDocs, hydrateKbDocLinks, type KbDocMention } from './kbMentions';

let docSeq = 0;
const doc = (title: string, path: string): KbDocMention => {
  docSeq += 1;
  const documentId = `0190a000-0000-7000-8000-${String(docSeq).padStart(12, '0')}`;
  return {
    title,
    documentId,
    path,
    uri: `agor://kb/global/${path}`,
    routePath: `/kb/global/${path}`,
  };
};

const docs: KbDocMention[] = [
  doc('Getting Started', 'pages/getting-started'),
  doc('Architecture Overview', 'pages/architecture'),
  doc('Release Notes', 'pages/releases/notes'),
  doc('Onboarding Guide', 'guides/onboarding'),
];

describe('filterKbDocs', () => {
  it('returns the first N docs when the query is empty', () => {
    expect(filterKbDocs(docs, '', 2)).toEqual(docs.slice(0, 2));
  });

  it('matches against the title (case-insensitive)', () => {
    const result = filterKbDocs(docs, 'arch');
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Architecture Overview');
  });

  it('matches against the path when the title does not match', () => {
    const result = filterKbDocs(docs, 'onboarding');
    expect(result.map((d) => d.title)).toContain('Onboarding Guide');
  });

  it('ranks exact and prefix title matches ahead of substring/path matches', () => {
    const ranked = filterKbDocs(
      [
        doc('Release Plan', 'pages/release-plan'),
        doc('Quarterly Release', 'pages/quarterly'),
        doc('Release', 'pages/release'),
        doc('Misc', 'pages/release-archive'),
      ],
      'release'
    );
    expect(ranked.map((d) => d.title)).toEqual([
      'Release', // exact title match
      'Release Plan', // title prefix
      'Quarterly Release', // title substring
      'Misc', // path-only match
    ]);
  });

  it('excludes docs that match neither title nor path', () => {
    expect(filterKbDocs(docs, 'zzz-nonexistent')).toEqual([]);
  });

  it('respects the result limit', () => {
    expect(filterKbDocs(docs, 'pages', 1)).toHaveLength(1);
  });
});

const UUID = '0190a000-0000-7000-8000-0000000000aa';

describe('buildKbDocLink', () => {
  it('builds a markdown link to the rename-proof document URI', () => {
    expect(buildKbDocLink('Getting Started', UUID)).toBe(
      `[Getting Started](agor://kb/document/${UUID})`
    );
  });

  it('escapes square brackets in the title so the link syntax stays valid', () => {
    expect(buildKbDocLink('Notes [draft]', UUID)).toBe(
      `[Notes \\[draft\\]](agor://kb/document/${UUID})`
    );
  });

  it('falls back to "Untitled" for blank titles', () => {
    expect(buildKbDocLink('   ', UUID)).toBe(`[Untitled](agor://kb/document/${UUID})`);
  });
});

describe('hydrateKbDocLinks', () => {
  const routes: Record<string, string> = { [UUID]: '/kb/global/pages/getting-started' };
  const resolve = (id: string) => routes[id];

  it('rewrites a known document URI to its in-app route', () => {
    expect(hydrateKbDocLinks(`[Getting Started](agor://kb/document/${UUID})`, resolve)).toBe(
      '[Getting Started](/kb/global/pages/getting-started)'
    );
  });

  it('matches the document URI case-insensitively and resolves lowercased ids', () => {
    expect(hydrateKbDocLinks(`[X](agor://kb/document/${UUID.toUpperCase()})`, resolve)).toBe(
      '[X](/kb/global/pages/getting-started)'
    );
  });

  it('leaves unknown document URIs untouched', () => {
    const unknown = '0190a000-0000-7000-8000-0000000000bb';
    const md = `[X](agor://kb/document/${unknown})`;
    expect(hydrateKbDocLinks(md, resolve)).toBe(md);
  });

  it('ignores path-style content links and non-kb text', () => {
    const md = 'See [A](/kb/global/pages/a) and agor://kb/global/pages/b';
    expect(hydrateKbDocLinks(md, resolve)).toBe(md);
  });

  it('returns blank input unchanged', () => {
    expect(hydrateKbDocLinks('', resolve)).toBe('');
  });
});
