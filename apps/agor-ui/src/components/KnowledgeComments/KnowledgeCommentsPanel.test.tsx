import type { CommentID, KnowledgeDocumentComment, User, UserID } from '@agor-live/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionProvider } from '../../contexts/ConnectionContext';
import { KnowledgeCommentsPanel } from './KnowledgeCommentsPanel';

// MarkdownRenderer pulls in Streamdown (Mermaid/KaTeX/highlighting), which is
// far heavier than these assertions need.
vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock('../AutocompleteTextarea', () => ({
  AutocompleteTextarea: ({
    value,
    onChange,
    onKeyPress,
    placeholder,
  }: {
    value: string;
    onChange: (value: string) => void;
    onKeyPress?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyPress}
    />
  ),
}));

const AUTHOR: User = {
  user_id: 'user-1' as UserID,
  email: 'author@test.local',
  name: 'Author',
} as User;

const HEADINGS = [
  { slug: 'overview', text: 'Overview', level: 2 },
  { slug: 'setup', text: 'Setup', level: 2 },
];

function makeComment(overrides: Partial<KnowledgeDocumentComment> = {}): KnowledgeDocumentComment {
  return {
    comment_id: 'comment-1' as CommentID,
    document_id: 'doc-1' as KnowledgeDocumentComment['document_id'],
    created_by: AUTHOR.user_id,
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

// The composer is gated on a live daemon connection, so the panel is mounted
// as it appears to a connected user.
const CONNECTED = {
  connected: true,
  connecting: false,
  outOfSync: false,
  capturedSha: null,
  currentSha: null,
};

function renderPanel(props: Partial<React.ComponentProps<typeof KnowledgeCommentsPanel>> = {}) {
  const onAddComment = vi.fn();
  render(
    <ConnectionProvider value={CONNECTED}>
      <KnowledgeCommentsPanel
        client={null}
        comments={[]}
        headings={HEADINGS}
        userById={new Map([[AUTHOR.user_id, AUTHOR]])}
        currentUserId={AUTHOR.user_id}
        pendingAnchor={{ anchor_slug: null, anchor_label: null }}
        onClearPendingAnchor={vi.fn()}
        canComment
        onAddComment={onAddComment}
        onReplyComment={vi.fn()}
        onToggleResolved={vi.fn()}
        onToggleReaction={vi.fn()}
        onDeleteComment={vi.fn()}
        {...props}
      />
    </ConnectionProvider>
  );
  return { onAddComment };
}

describe('KnowledgeCommentsPanel', () => {
  it('groups threads under the section they are anchored to', () => {
    renderPanel({
      comments: [
        makeComment({
          comment_id: 'c-setup' as CommentID,
          content: 'About setup',
          anchor_slug: 'setup',
          anchor_label: 'Setup',
        }),
        makeComment({ comment_id: 'c-doc' as CommentID, content: 'About the page' }),
      ],
    });

    expect(screen.getByText('Setup')).toBeInTheDocument();
    expect(screen.getByText('Whole page')).toBeInTheDocument();
    expect(screen.getByText('About setup')).toBeInTheDocument();
  });

  it('re-anchors a thread by heading text when its slug changed', () => {
    renderPanel({
      comments: [
        makeComment({ content: 'Moved along', anchor_slug: 'installation', anchor_label: 'Setup' }),
      ],
    });

    expect(screen.getByText('Setup')).toBeInTheDocument();
    expect(screen.queryByText('Removed sections')).not.toBeInTheDocument();
  });

  // One visual language for "came unmoored", regardless of why the anchor
  // failed to resolve — not a separate treatment per failure mode.
  it('collapses every orphan reason into the one Removed sections group', () => {
    renderPanel({
      headings: [
        { slug: 'overview', text: 'Overview', level: 2 },
        { slug: 'setup', text: 'Setup', level: 2 },
        { slug: 'setup-1', text: 'Setup', level: 3 },
      ],
      comments: [
        makeComment({
          comment_id: 'c-gone' as CommentID,
          content: 'Section was deleted',
          anchor_slug: 'deprecated',
          anchor_label: 'Deprecated API',
        }),
        makeComment({
          comment_id: 'c-ambiguous' as CommentID,
          content: 'Label matches two sections',
          anchor_slug: 'old-setup-slug',
          anchor_label: 'Setup',
        }),
        makeComment({
          comment_id: 'c-deduped' as CommentID,
          content: 'Deduped anchor lost its twin',
          anchor_slug: 'setup-2',
          anchor_label: 'Setup',
        }),
      ],
    });

    expect(screen.getAllByText('Removed sections')).toHaveLength(1);
    expect(screen.getByText('Section was deleted')).toBeInTheDocument();
    expect(screen.getByText('Label matches two sections')).toBeInTheDocument();
    expect(screen.getByText('Deduped anchor lost its twin')).toBeInTheDocument();
  });

  it('keeps a thread visible when its section is gone', () => {
    renderPanel({
      comments: [
        makeComment({
          content: 'Still here',
          anchor_slug: 'deprecated',
          anchor_label: 'Deprecated API',
        }),
      ],
    });

    expect(screen.getByText('Removed sections')).toBeInTheDocument();
    expect(screen.getByText('Still here')).toBeInTheDocument();
  });

  it('anchors a new thread to the pending section', () => {
    const { onAddComment } = renderPanel({
      pendingAnchor: { anchor_slug: 'setup', anchor_label: 'Setup' },
    });

    const composer = screen.getByRole('textbox');
    fireEvent.change(composer, { target: { value: 'Anchored thread' } });
    fireEvent.keyDown(composer, { key: 'Enter' });

    expect(onAddComment).toHaveBeenCalledWith('Anchored thread', {
      anchor_slug: 'setup',
      anchor_label: 'Setup',
    });
    expect(screen.getByText('Setup')).toBeInTheDocument();
  });

  it('hides commenting affordances from read-only viewers', () => {
    renderPanel({
      canComment: false,
      comments: [makeComment({ content: 'Read me' })],
    });

    expect(screen.getByText('Read me')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send comment' })).not.toBeInTheDocument();
  });

  it('hides resolved threads until the All filter is chosen', () => {
    renderPanel({
      comments: [
        makeComment({ comment_id: 'c-open' as CommentID, content: 'Open thread' }),
        makeComment({
          comment_id: 'c-done' as CommentID,
          content: 'Settled thread',
          resolved: true,
        }),
      ],
    });

    expect(screen.queryByText('Settled thread')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(screen.getByText('Settled thread')).toBeInTheDocument();
    expect(screen.getByText('Open thread')).toBeInTheDocument();
  });

  it('surfaces a load failure without dropping the panel', () => {
    renderPanel({ error: 'Boom' });

    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Could not load comments')).toBeInTheDocument();
  });
});
