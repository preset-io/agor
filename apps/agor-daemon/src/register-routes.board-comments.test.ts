import type { BoardComment, UUID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeBoardCommentRouteAccess,
  boardCommentReactionInput,
  boardCommentReplyInput,
} from './register-routes.js';

const USER = '018f0000-0000-7000-8000-000000000001';
const OTHER = '018f0000-0000-7000-8000-000000000002';
const COMMENT = {
  comment_id: '018f0000-0000-7000-8000-000000000003',
  board_id: '018f0000-0000-7000-8000-000000000004',
  content: 'private comment',
  created_by: OTHER,
} as BoardComment;

function params(role = ROLES.MEMBER) {
  return {
    provider: 'socketio',
    user: { user_id: USER, email: 'member@example.test', role },
  } as const;
}

describe('board comment custom-route authorization', () => {
  it('requires current attachment visibility and does not enumerate denied comments', async () => {
    const findComment = vi.fn(async () => COMMENT);
    const findVisibleComment = vi.fn(async () => null);
    const denied = await authorizeBoardCommentRouteAccess({
      commentId: COMMENT.comment_id,
      params: params(),
      findComment,
      findVisibleComment,
    }).catch((error: Error & { code?: number }) => ({
      code: error.code,
      message: error.message,
    }));
    const missing = await authorizeBoardCommentRouteAccess({
      commentId: 'missing',
      params: params(),
      findComment: async () => null,
      findVisibleComment,
    }).catch((error: Error & { code?: number }) => ({
      code: error.code,
      message: error.message,
    }));

    expect(denied).toEqual(missing);
    expect(denied).toMatchObject({ code: 404 });
    expect(findVisibleComment).toHaveBeenCalledWith(COMMENT.comment_id, USER as UUID);
  });

  it('allows a current viewer and preserves the admin authority path', async () => {
    await expect(
      authorizeBoardCommentRouteAccess({
        commentId: COMMENT.comment_id,
        params: params(),
        findComment: async () => COMMENT,
        findVisibleComment: async () => COMMENT,
      })
    ).resolves.toBe(COMMENT);

    const findVisibleComment = vi.fn(async () => null);
    await expect(
      authorizeBoardCommentRouteAccess({
        commentId: COMMENT.comment_id,
        params: params(ROLES.ADMIN),
        findComment: async () => COMMENT,
        findVisibleComment,
      })
    ).resolves.toBe(COMMENT);
    expect(findVisibleComment).not.toHaveBeenCalled();
  });

  it('derives reaction/reply ownership and strips caller-controlled resource fields', () => {
    expect(boardCommentReactionInput({ user_id: OTHER, emoji: '👍' } as never, params())).toEqual({
      user_id: USER,
      emoji: '👍',
    });
    expect(
      boardCommentReplyInput(
        {
          content: 'reply',
          created_by: OTHER,
          board_id: 'foreign-board' as never,
          parent_comment_id: 'foreign-parent' as never,
          reactions: [{ user_id: OTHER as never, emoji: '👎' }],
          mentions: [OTHER as never],
          resolved: true,
        },
        params()
      )
    ).toEqual({
      content: 'reply',
      created_by: USER,
      mentions: [OTHER],
    });
  });
});
