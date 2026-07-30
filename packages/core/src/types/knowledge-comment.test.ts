import { describe, expect, it } from 'vitest';
import { type KnowledgeDocumentHeading, resolveKnowledgeCommentAnchor } from './knowledge-comment';

const headings: KnowledgeDocumentHeading[] = [
  { slug: 'overview', text: 'Overview', level: 2 },
  { slug: 'setup', text: 'Setup', level: 2 },
  { slug: 'setup-1', text: 'Setup', level: 3 },
];

describe('resolveKnowledgeCommentAnchor', () => {
  it('treats a missing anchor as document level', () => {
    expect(
      resolveKnowledgeCommentAnchor({ anchor_slug: null, anchor_label: null }, headings)
    ).toEqual({ state: 'document', slug: null, label: null });
  });

  it('prefers an exact slug match and refreshes the label', () => {
    expect(
      resolveKnowledgeCommentAnchor(
        { anchor_slug: 'setup', anchor_label: 'Stale heading text' },
        headings
      )
    ).toEqual({ state: 'anchored', slug: 'setup', label: 'Setup' });
  });

  it('re-anchors by heading text when the slug changed', () => {
    expect(
      resolveKnowledgeCommentAnchor(
        { anchor_slug: 'installation', anchor_label: 'Overview' },
        headings
      )
    ).toEqual({ state: 'anchored', slug: 'overview', label: 'Overview' });
  });

  it('orphans a thread whose section is gone, keeping its stored label', () => {
    expect(
      resolveKnowledgeCommentAnchor(
        { anchor_slug: 'deprecated', anchor_label: 'Deprecated API' },
        headings
      )
    ).toEqual({ state: 'orphaned', slug: 'deprecated', label: 'Deprecated API' });
  });

  it('orphans rather than guessing when no label was captured', () => {
    expect(
      resolveKnowledgeCommentAnchor({ anchor_slug: 'gone', anchor_label: null }, headings)
    ).toEqual({ state: 'orphaned', slug: 'gone', label: null });
  });

  it('does not re-anchor a blank label to a blank heading', () => {
    expect(
      resolveKnowledgeCommentAnchor({ anchor_slug: 'gone', anchor_label: '   ' }, [
        { slug: 'blank', text: '  ', level: 2 },
      ])
    ).toEqual({ state: 'orphaned', slug: 'gone', label: '   ' });
  });
});
