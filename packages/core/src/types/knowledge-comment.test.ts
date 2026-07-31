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

  it('orphans rather than guessing when the label matches several sections', () => {
    expect(
      resolveKnowledgeCommentAnchor(
        { anchor_slug: 'old-setup-slug', anchor_label: 'Setup' },
        headings
      )
    ).toEqual({ state: 'orphaned', slug: 'old-setup-slug', label: 'Setup' });
  });

  it('orphans a deduped anchor instead of falling back onto its twin', () => {
    // The h3 "Setup" (setup-1) was deleted. Its label alone now looks unique,
    // but it points at the unrelated h2 that was always a different section.
    const afterDeletingTheH3 = headings.filter((heading) => heading.slug !== 'setup-1');

    expect(
      resolveKnowledgeCommentAnchor(
        { anchor_slug: 'setup-1', anchor_label: 'Setup' },
        afterDeletingTheH3
      )
    ).toEqual({ state: 'orphaned', slug: 'setup-1', label: 'Setup' });
  });

  it('re-anchors on label when it was and still is unique', () => {
    const withoutDuplicate = headings.filter((heading) => heading.slug !== 'setup-1');

    expect(
      resolveKnowledgeCommentAnchor(
        { anchor_slug: 'old-setup-slug', anchor_label: 'Setup' },
        withoutDuplicate
      )
    ).toEqual({ state: 'anchored', slug: 'setup', label: 'Setup' });
  });

  // Known limitation: positional dedup suffixes renumber when an earlier
  // same-named heading is deleted, so rung 1 matches a section the thread was
  // never on. Recorded so it is not rediscovered as a mystery bug.
  it('cannot yet tell a renumbered duplicate heading from the original', () => {
    const afterDeletingTheFirstSetup = [
      { slug: 'overview', text: 'Overview', level: 2 },
      { slug: 'setup', text: 'Setup', level: 3 },
    ];

    expect(
      resolveKnowledgeCommentAnchor(
        { anchor_slug: 'setup', anchor_label: 'Setup' },
        afterDeletingTheFirstSetup
      )
    ).toEqual({ state: 'anchored', slug: 'setup', label: 'Setup' });
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
