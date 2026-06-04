import { describe, expect, it } from 'vitest';
import { extractKnowledgeLinks } from './knowledge';

describe('extractKnowledgeLinks', () => {
  it('returns an empty array for blank input', () => {
    expect(extractKnowledgeLinks('')).toEqual([]);
    expect(extractKnowledgeLinks(null)).toEqual([]);
    expect(extractKnowledgeLinks(undefined)).toEqual([]);
  });

  it('extracts a route-style markdown link', () => {
    const md = 'See [Architecture](/kb/global/pages/architecture) for details.';
    expect(extractKnowledgeLinks(md)).toEqual([
      { namespace_slug: 'global', path: 'pages/architecture' },
    ]);
  });

  it('extracts the /knowledge route variant', () => {
    const md = '[Onboarding](/knowledge/team/guides/onboarding)';
    expect(extractKnowledgeLinks(md)).toEqual([
      { namespace_slug: 'team', path: 'guides/onboarding' },
    ]);
  });

  it('extracts canonical agor://kb URIs', () => {
    const md = 'ref agor://kb/global/pages/getting-started here';
    expect(extractKnowledgeLinks(md)).toEqual([
      { namespace_slug: 'global', path: 'pages/getting-started' },
    ]);
  });

  it('extracts rename-proof agor://kb/document/<uuid> id references', () => {
    const id = '0190a000-0000-7000-8000-0000000000aa';
    const md = `See [Arch](agor://kb/document/${id}) for details.`;
    expect(extractKnowledgeLinks(md)).toEqual([{ document_id: id }]);
  });

  it('lowercases uppercase uuids and deduplicates id references', () => {
    const id = '0190a000-0000-7000-8000-0000000000aa';
    const md = `[A](agor://kb/document/${id.toUpperCase()}) and [B](agor://kb/document/${id})`;
    expect(extractKnowledgeLinks(md)).toEqual([{ document_id: id }]);
  });

  it('treats a non-uuid path under the document namespace as a path link', () => {
    const md = '[x](/kb/document/pages/notes)';
    expect(extractKnowledgeLinks(md)).toEqual([
      { namespace_slug: 'document', path: 'pages/notes' },
    ]);
  });

  it('decodes percent-encoded path segments', () => {
    const md = '[Release Notes](/kb/global/pages/release%20notes)';
    expect(extractKnowledgeLinks(md)).toEqual([
      { namespace_slug: 'global', path: 'pages/release notes' },
    ]);
  });

  it('strips query strings and fragments', () => {
    const md = '[A](/kb/global/pages/a?draft=page&mode=edit#section)';
    expect(extractKnowledgeLinks(md)).toEqual([{ namespace_slug: 'global', path: 'pages/a' }]);
  });

  it('deduplicates repeated references', () => {
    const md =
      '[A](/kb/global/pages/a) and again [A2](/kb/global/pages/a) plus [B](/kb/global/pages/b)';
    expect(extractKnowledgeLinks(md)).toEqual([
      { namespace_slug: 'global', path: 'pages/a' },
      { namespace_slug: 'global', path: 'pages/b' },
    ]);
  });

  it('extracts multiple distinct links across namespaces', () => {
    const md = '[A](/kb/global/a)\n[B](/kb/team/sub/b)\nagor://kb/personal/c';
    expect(extractKnowledgeLinks(md)).toEqual([
      { namespace_slug: 'global', path: 'a' },
      { namespace_slug: 'team', path: 'sub/b' },
      { namespace_slug: 'personal', path: 'c' },
    ]);
  });

  it('ignores non-knowledge links', () => {
    const md = '[Home](/) [Docs](https://example.com/kb-ish) [Branch](/branches/foo)';
    expect(extractKnowledgeLinks(md)).toEqual([]);
  });

  it('skips malformed paths that fail normalization', () => {
    // Trailing-period segment is rejected by normalizeKnowledgePath.
    const md = '[bad](/kb/global/pages/bad.)';
    expect(extractKnowledgeLinks(md)).toEqual([]);
  });
});
