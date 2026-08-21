import { describe, expect, it } from 'vitest';
import { publicBoardCommentCreateInput } from './board-comments.js';

describe('publicBoardCommentCreateInput', () => {
  it('projects the canonical thread-root fields', () => {
    expect(
      publicBoardCommentCreateInput({
        board_id: 'board-1',
        content: 'hello',
        branch_id: 'branch-1',
        mentions: ['user-1'],
      })
    ).toEqual({
      board_id: 'board-1',
      content: 'hello',
      branch_id: 'branch-1',
      mentions: ['user-1'],
    });
  });

  it('rejects a generic create linked to a hidden or unrelated parent', () => {
    expect(() =>
      publicBoardCommentCreateInput({
        board_id: 'visible-board',
        content: 'smuggled reply',
        parent_comment_id: 'hidden-parent',
      })
    ).toThrow(/Unsupported board comment create fields: parent_comment_id/);
  });

  it.each(['comment_id', 'created_by', 'content_preview', 'reactions', 'resolved', 'edited'])(
    'rejects caller-controlled server field %s',
    (field) => {
      expect(() =>
        publicBoardCommentCreateInput({ board_id: 'board-1', content: 'hello', [field]: 'forged' })
      ).toThrow(/Unsupported board comment create fields/);
    }
  );
});
