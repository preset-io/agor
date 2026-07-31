import type { CommentID, KnowledgeDocumentComment, UserID } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { summarizeKnowledgeAnchors } from './knowledgeCommentAnchors';

const HEADINGS = [
  { slug: 'overview', text: 'Overview', level: 2 },
  { slug: 'setup', text: 'Setup', level: 2 },
];

let nextId = 0;

function makeComment(overrides: Partial<KnowledgeDocumentComment> = {}): KnowledgeDocumentComment {
  nextId += 1;
  return {
    comment_id: `comment-${nextId}` as CommentID,
    document_id: 'doc-1' as KnowledgeDocumentComment['document_id'],
    created_by: 'user-1' as UserID,
    content: 'A comment',
    content_preview: 'A comment',
    anchor_slug: null,
    anchor_label: null,
    resolved: false,
    edited: false,
    reactions: [],
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('summarizeKnowledgeAnchors', () => {
  it('counts thread roots per live section, ignoring replies', () => {
    const root = makeComment({ anchor_slug: 'setup', anchor_label: 'Setup' });
    const summary = summarizeKnowledgeAnchors(
      [
        root,
        makeComment({
          anchor_slug: 'setup',
          anchor_label: 'Setup',
          parent_comment_id: root.comment_id,
        }),
        makeComment({ anchor_slug: 'overview', anchor_label: 'Overview' }),
      ],
      HEADINGS
    );

    expect(summary.totalBySlug.get('setup')).toBe(1);
    expect(summary.totalBySlug.get('overview')).toBe(1);
    expect(summary.unresolvedTotal).toBe(2);
  });

  it('separates resolved threads from the unresolved badge count', () => {
    const summary = summarizeKnowledgeAnchors(
      [
        makeComment({ anchor_slug: 'setup', anchor_label: 'Setup' }),
        makeComment({ anchor_slug: 'setup', anchor_label: 'Setup', resolved: true }),
      ],
      HEADINGS
    );

    expect(summary.totalBySlug.get('setup')).toBe(2);
    expect(summary.unresolvedBySlug.get('setup')).toBe(1);
    expect(summary.unresolvedTotal).toBe(1);
  });

  it('counts document-level and orphaned threads in the total but against no section', () => {
    const summary = summarizeKnowledgeAnchors(
      [makeComment(), makeComment({ anchor_slug: 'deprecated', anchor_label: 'Deprecated API' })],
      HEADINGS
    );

    expect(summary.totalBySlug.size).toBe(0);
    expect(summary.unresolvedTotal).toBe(2);
  });

  it('follows a section whose slug changed but whose heading text survived', () => {
    const summary = summarizeKnowledgeAnchors(
      [makeComment({ anchor_slug: 'installation', anchor_label: 'Setup' })],
      HEADINGS
    );

    expect(summary.unresolvedBySlug.get('setup')).toBe(1);
  });
});
