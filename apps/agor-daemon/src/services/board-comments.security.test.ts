import { describe, expect, it } from 'vitest';
import {
  publicBoardCommentCreateInput,
  publicBoardCommentPatchInput,
  publicBoardCommentRepositionInput,
  rejectPublicBoardCommentUpdate,
} from './board-comments.js';

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

describe('publicBoardCommentRepositionInput', () => {
  it('projects a bounded position and optional branch precondition', () => {
    expect(
      publicBoardCommentRepositionInput({
        position: {
          relative: {
            parent_id: 'branch-1',
            parent_type: 'branch',
            offset_x: 10,
            offset_y: -5,
          },
        },
        branch_id: 'branch-1',
      })
    ).toEqual({
      position: {
        relative: {
          parent_id: 'branch-1',
          parent_type: 'branch',
          offset_x: 10,
          offset_y: -5,
        },
      },
      branch_id: 'branch-1',
    });
  });

  it('rejects mixed, non-finite, or field-smuggling positions', () => {
    expect(() =>
      publicBoardCommentRepositionInput({
        position: { absolute: { x: 1, y: 2 }, relative: {} },
      })
    ).toThrow(/exactly one/);
    expect(() =>
      publicBoardCommentRepositionInput({ position: { absolute: { x: Number.NaN, y: 2 } } })
    ).toThrow(/finite x and y/);
    expect(() =>
      publicBoardCommentRepositionInput({
        position: { absolute: { x: 1, y: 2 } },
        reactions: [],
      })
    ).toThrow(/Unsupported board comment reposition fields/);
  });
});

describe('publicBoardCommentPatchInput', () => {
  it('projects only author-owned content and resolution state', () => {
    expect(publicBoardCommentPatchInput({ content: 'edited', resolved: true })).toEqual({
      content: 'edited',
      resolved: true,
    });
  });

  it.each([
    'comment_id',
    'created_by',
    'content_preview',
    'reactions',
    'edited',
    'position',
    'mentions',
    'board_id',
    'branch_id',
    'parent_comment_id',
  ])('rejects a generic patch that forges field %s', (field) => {
    expect(() => publicBoardCommentPatchInput({ content: 'edited', [field]: 'forged' })).toThrow(
      /Unsupported board comment patch fields/
    );
  });

  it('rejects invalid or empty public patch values', () => {
    expect(() => publicBoardCommentPatchInput({})).toThrow(/requires content or resolved/);
    expect(() => publicBoardCommentPatchInput({ content: '' })).toThrow(/non-empty string/);
    expect(() => publicBoardCommentPatchInput({ resolved: 'yes' })).toThrow(/must be a boolean/);
  });

  it('rejects external complete replacement instead of accepting forged state', () => {
    expect(() => rejectPublicBoardCommentUpdate()).toThrow(
      /do not support external update; use patch/
    );
  });
});
