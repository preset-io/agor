import type { BoardComment, User } from '@agor-live/client';
import { render, screen } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { describe, expect, it } from 'vitest';
import { CommentsPanel } from './CommentsPanel';

const author = { user_id: 'user-author', name: 'Ada', email: 'ada@example.com', role: 'member' };
const member = { user_id: 'user-member', name: 'Bo', email: 'bo@example.com', role: 'member' };
const admin = { user_id: 'user-admin', name: 'Cy', email: 'cy@example.com', role: 'admin' };
const userById = new Map(
  [author, member, admin].map((user) => [user.user_id, user as unknown as User])
);

function comment(overrides: Partial<BoardComment> = {}): BoardComment {
  return {
    comment_id: 'comment-1',
    board_id: 'board-1',
    created_by: author.user_id,
    content: 'Ship it',
    content_preview: 'Ship it',
    resolved: false,
    edited: false,
    reactions: [],
    created_at: '2026-10-09T10:00:00.000Z',
    ...overrides,
  } as BoardComment;
}

function renderPanel(currentUserId: string, comments: BoardComment[] = [comment()]) {
  render(
    <AntdApp>
      <CommentsPanel
        client={null}
        boardId="board-1"
        comments={comments}
        userById={userById}
        currentUserId={currentUserId}
        onSendComment={() => undefined}
        onResolveComment={() => undefined}
        onDeleteComment={() => undefined}
        alwaysShowActions
      />
    </AntdApp>
  );
}

// The server lets only the comment's author or an administrator resolve, reopen or delete it.
describe('CommentsPanel moderation actions', () => {
  it('offers Resolve and Delete to the author', () => {
    renderPanel(author.user_id);
    expect(screen.getByTitle('Resolve')).toBeVisible();
    expect(screen.getByTitle('Delete')).toBeVisible();
  });

  it('offers Resolve and Delete to an administrator', () => {
    renderPanel(admin.user_id);
    expect(screen.getByTitle('Resolve')).toBeVisible();
    expect(screen.getByTitle('Delete')).toBeVisible();
  });

  it('hides Resolve, Reopen and Delete from other members', () => {
    renderPanel(member.user_id, [comment(), comment({ comment_id: 'comment-2', resolved: true })]);
    expect(screen.queryByTitle('Resolve')).toBeNull();
    expect(screen.queryByTitle('Reopen')).toBeNull();
    expect(screen.queryByTitle('Delete')).toBeNull();
  });
});
