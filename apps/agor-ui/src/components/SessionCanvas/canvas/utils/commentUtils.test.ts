import type { BoardComment, User } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { canRepositionBoardComment, planBoardCommentReposition } from './commentUtils';

const BASE_COMMENT = {
  comment_id: 'comment-1',
  board_id: 'board-1',
  created_by: 'user-1',
  content: 'pin',
} as BoardComment;

const ZONE = {
  id: 'review',
  type: 'zone' as const,
  absolutePosition: { x: 100, y: 200 },
  reactFlowParentId: 'zone-review',
};

function branch(id: string) {
  return {
    id,
    type: 'branch' as const,
    absolutePosition: { x: 10, y: 20 },
    reactFlowParentId: id,
  };
}

describe('planBoardCommentReposition', () => {
  it('moves a branch-attached comment between its branch, a zone, and free space without changing audience', () => {
    const comment = { ...BASE_COMMENT, branch_id: 'branch-a' } as BoardComment;

    expect(planBoardCommentReposition(comment, { x: 25, y: 45 }, branch('branch-a'))).toEqual({
      data: {
        branch_id: 'branch-a',
        position: {
          relative: {
            parent_id: 'branch-a',
            parent_type: 'branch',
            offset_x: 15,
            offset_y: 25,
          },
        },
      },
      reactFlowParentId: 'branch-a',
    });

    expect(planBoardCommentReposition(comment, { x: 130, y: 260 }, ZONE)).toEqual({
      data: {
        branch_id: 'branch-a',
        position: {
          relative: {
            parent_id: 'review',
            parent_type: 'zone',
            offset_x: 30,
            offset_y: 60,
          },
        },
      },
      reactFlowParentId: 'zone-review',
    });

    expect(planBoardCommentReposition(comment, { x: 500, y: 600 })).toEqual({
      data: { branch_id: 'branch-a', position: { absolute: { x: 500, y: 600 } } },
    });
  });

  it('refuses visual reparenting to a branch that is not the immutable audience anchor', () => {
    const branchAttached = { ...BASE_COMMENT, branch_id: 'branch-a' } as BoardComment;
    expect(
      planBoardCommentReposition(branchAttached, { x: 70, y: 80 }, branch('branch-b'))
    ).toEqual({
      data: { branch_id: 'branch-a', position: { absolute: { x: 70, y: 80 } } },
    });

    expect(planBoardCommentReposition(BASE_COMMENT, { x: 70, y: 80 }, branch('branch-a'))).toEqual({
      data: { branch_id: null, position: { absolute: { x: 70, y: 80 } } },
    });
  });
});

describe('canRepositionBoardComment', () => {
  it('matches the server author-or-admin authorization boundary', () => {
    expect(
      canRepositionBoardComment(BASE_COMMENT, { user_id: 'user-1', role: 'member' } as User)
    ).toBe(true);
    expect(
      canRepositionBoardComment(BASE_COMMENT, { user_id: 'user-2', role: 'member' } as User)
    ).toBe(false);
    expect(
      canRepositionBoardComment(BASE_COMMENT, { user_id: 'admin-1', role: 'admin' } as User)
    ).toBe(true);
  });
});
