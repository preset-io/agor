import { describe, expect, it } from 'vitest';
import type { BoardComment } from './board-comment';
import {
  CommentAttachmentType,
  getCommentAttachmentType,
  groupReactions,
  isReply,
  isResolvable,
  isThreadRoot,
} from './board-comment';

// ============================================================================
// Test Helpers
// ============================================================================

/** Creates minimal valid comment with required fields only */
function createComment(overrides?: Partial<BoardComment>): BoardComment {
  return {
    comment_id: 'comment_123' as any,
    board_id: 'board_123' as any,
    created_by: 'user_123' as any,
    content: 'Test comment content',
    content_preview: 'Test comment content',
    resolved: false,
    edited: false,
    reactions: [],
    created_at: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ============================================================================
// getCommentAttachmentType() Tests
// ============================================================================

describe('getCommentAttachmentType', () => {
  describe('hierarchy precedence (most specific → least specific)', () => {
    it('should return MESSAGE when message_id is present (highest priority)', () => {
      const comment = createComment({
        message_id: 'msg_123' as any,
        task_id: 'task_123' as any,
        session_id: 'session_123' as any,
        branch_id: 'branch_123' as any,
        position: { absolute: { x: 100, y: 200 } },
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.MESSAGE);
    });

    it('should return TASK when task_id is present (2nd priority)', () => {
      const comment = createComment({
        task_id: 'task_123' as any,
        session_id: 'session_123' as any,
        branch_id: 'branch_123' as any,
        position: { absolute: { x: 100, y: 200 } },
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.TASK);
    });

    it('should return SESSION_SPATIAL when session_id + position.relative (3rd priority)', () => {
      const comment = createComment({
        session_id: 'session_123' as any,
        position: {
          relative: {
            parent_id: 'session_123',
            parent_type: 'session',
            offset_x: 10,
            offset_y: 20,
          },
        },
        branch_id: 'branch_123' as any,
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.SESSION_SPATIAL);
    });

    it('should return SESSION when session_id only (4th priority)', () => {
      const comment = createComment({
        session_id: 'session_123' as any,
        branch_id: 'branch_123' as any,
        position: { absolute: { x: 100, y: 200 } },
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.SESSION);
    });

    it('should return BRANCH when branch_id is present (5th priority)', () => {
      const comment = createComment({
        branch_id: 'branch_123' as any,
        position: { absolute: { x: 100, y: 200 } },
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.BRANCH);
    });

    it('should return BOARD_SPATIAL when position.absolute only (6th priority)', () => {
      const comment = createComment({
        position: { absolute: { x: 100, y: 200 } },
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.BOARD_SPATIAL);
    });

    it('should return BOARD when no attachments or position (default)', () => {
      const comment = createComment();
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.BOARD);
    });
  });

  describe('edge cases', () => {
    it('should ignore position.absolute when session_id is present', () => {
      const comment = createComment({
        session_id: 'session_123' as any,
        position: { absolute: { x: 100, y: 200 } },
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.SESSION);
    });

    it('should return SESSION when session_id + position.absolute (not relative)', () => {
      const comment = createComment({
        session_id: 'session_123' as any,
        position: { absolute: { x: 100, y: 200 } },
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.SESSION);
    });

    it('should handle position object with only relative (no absolute)', () => {
      const comment = createComment({
        session_id: 'session_123' as any,
        position: {
          relative: {
            parent_id: 'session_123',
            parent_type: 'session',
            offset_x: 0,
            offset_y: 0,
          },
        },
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.SESSION_SPATIAL);
    });

    it('should return BOARD when position is empty object', () => {
      const comment = createComment({
        position: {} as any,
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.BOARD);
    });

    it('should handle zero coordinates in absolute position', () => {
      const comment = createComment({
        position: { absolute: { x: 0, y: 0 } },
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.BOARD_SPATIAL);
    });

    it('should handle negative coordinates in absolute position', () => {
      const comment = createComment({
        position: { absolute: { x: -100, y: -50 } },
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.BOARD_SPATIAL);
    });

    it('should handle zero offsets in relative position', () => {
      const comment = createComment({
        session_id: 'session_123' as any,
        position: {
          relative: {
            parent_id: 'session_123',
            parent_type: 'session',
            offset_x: 0,
            offset_y: 0,
          },
        },
      });
      expect(getCommentAttachmentType(comment)).toBe(CommentAttachmentType.SESSION_SPATIAL);
    });
  });
});

// ============================================================================
// Thread Predicate Tests
// ============================================================================

describe('isThreadRoot', () => {
  it('should return true when parent_comment_id is undefined', () => {
    const comment = createComment({ parent_comment_id: undefined });
    expect(isThreadRoot(comment)).toBe(true);
  });

  it('should return true when parent_comment_id is missing', () => {
    const comment = createComment();
    expect(isThreadRoot(comment)).toBe(true);
  });

  it('should return false when parent_comment_id is set', () => {
    const comment = createComment({
      parent_comment_id: 'parent_123' as any,
    });
    expect(isThreadRoot(comment)).toBe(false);
  });
});

describe('isReply', () => {
  it('should return false when parent_comment_id is undefined', () => {
    const comment = createComment({ parent_comment_id: undefined });
    expect(isReply(comment)).toBe(false);
  });

  it('should return false when parent_comment_id is missing', () => {
    const comment = createComment();
    expect(isReply(comment)).toBe(false);
  });

  it('should return true when parent_comment_id is set', () => {
    const comment = createComment({
      parent_comment_id: 'parent_123' as any,
    });
    expect(isReply(comment)).toBe(true);
  });
});

describe('isResolvable', () => {
  it('should return true for thread root (no parent_comment_id)', () => {
    const comment = createComment();
    expect(isResolvable(comment)).toBe(true);
  });

  it('should return false for reply (has parent_comment_id)', () => {
    const comment = createComment({
      parent_comment_id: 'parent_123' as any,
    });
    expect(isResolvable(comment)).toBe(false);
  });

  it('should match isThreadRoot behavior exactly', () => {
    const threadRoot = createComment();
    const reply = createComment({ parent_comment_id: 'parent_123' as any });

    expect(isResolvable(threadRoot)).toBe(isThreadRoot(threadRoot));
    expect(isResolvable(reply)).toBe(isThreadRoot(reply));
  });
});

// ============================================================================
// groupReactions() Tests
// ============================================================================

describe('groupReactions', () => {
  describe('basic grouping', () => {
    it('should group empty reactions array', () => {
      const result = groupReactions([]);
      expect(result).toEqual({});
    });

    it('should group single reaction', () => {
      const result = groupReactions([{ user_id: 'alice', emoji: '👍' }]);
      expect(result).toEqual({ '👍': ['alice'] });
    });

    it('should group multiple reactions with same emoji', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: '👍' },
        { user_id: 'bob', emoji: '👍' },
        { user_id: 'charlie', emoji: '👍' },
      ]);
      expect(result).toEqual({ '👍': ['alice', 'bob', 'charlie'] });
    });

    it('should group multiple reactions with different emojis', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: '👍' },
        { user_id: 'bob', emoji: '🎉' },
        { user_id: 'charlie', emoji: '❤️' },
      ]);
      expect(result).toEqual({
        '👍': ['alice'],
        '🎉': ['bob'],
        '❤️': ['charlie'],
      });
    });

    it('should group mixed reactions correctly', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: '👍' },
        { user_id: 'bob', emoji: '👍' },
        { user_id: 'charlie', emoji: '🎉' },
        { user_id: 'dave', emoji: '👍' },
        { user_id: 'eve', emoji: '❤️' },
      ]);
      expect(result).toEqual({
        '👍': ['alice', 'bob', 'dave'],
        '🎉': ['charlie'],
        '❤️': ['eve'],
      });
    });
  });

  describe('order preservation', () => {
    it('should preserve user order within emoji groups', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: '👍' },
        { user_id: 'bob', emoji: '👍' },
        { user_id: 'charlie', emoji: '👍' },
      ]);
      expect(result['👍']).toEqual(['alice', 'bob', 'charlie']);
    });

    it('should preserve order across multiple emoji groups', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: '👍' },
        { user_id: 'bob', emoji: '🎉' },
        { user_id: 'charlie', emoji: '👍' },
        { user_id: 'dave', emoji: '🎉' },
      ]);
      expect(result['👍']).toEqual(['alice', 'charlie']);
      expect(result['🎉']).toEqual(['bob', 'dave']);
    });
  });

  describe('edge cases', () => {
    it('should handle same user with same emoji multiple times', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: '👍' },
        { user_id: 'alice', emoji: '👍' },
      ]);
      expect(result).toEqual({ '👍': ['alice', 'alice'] });
    });

    it('should handle same user with different emojis', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: '👍' },
        { user_id: 'alice', emoji: '🎉' },
        { user_id: 'alice', emoji: '❤️' },
      ]);
      expect(result).toEqual({
        '👍': ['alice'],
        '🎉': ['alice'],
        '❤️': ['alice'],
      });
    });

    it('should handle emoji with skin tone modifiers', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: '👍🏻' },
        { user_id: 'bob', emoji: '👍🏾' },
      ]);
      expect(result).toEqual({
        '👍🏻': ['alice'],
        '👍🏾': ['bob'],
      });
    });

    it('should handle compound emojis', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: '👨‍👩‍👧‍👦' },
        { user_id: 'bob', emoji: '🏳️‍🌈' },
      ]);
      expect(result).toEqual({
        '👨‍👩‍👧‍👦': ['alice'],
        '🏳️‍🌈': ['bob'],
      });
    });

    it('should handle text emojis (emoticons)', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: ':)' },
        { user_id: 'bob', emoji: ':)' },
      ]);
      expect(result).toEqual({ ':)': ['alice', 'bob'] });
    });

    it('should handle empty string emoji', () => {
      const result = groupReactions([{ user_id: 'alice', emoji: '' }]);
      expect(result).toEqual({ '': ['alice'] });
    });

    it('should handle whitespace emoji', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: ' ' },
        { user_id: 'bob', emoji: '  ' },
      ]);
      expect(result).toEqual({
        ' ': ['alice'],
        '  ': ['bob'],
      });
    });

    it('should handle special characters as emoji', () => {
      const result = groupReactions([
        { user_id: 'alice', emoji: '+1' },
        { user_id: 'bob', emoji: '+1' },
      ]);
      expect(result).toEqual({ '+1': ['alice', 'bob'] });
    });
  });

  describe('large datasets', () => {
    it('should handle many users with same emoji', () => {
      const reactions = Array.from({ length: 100 }, (_, i) => ({
        user_id: `user_${i}`,
        emoji: '👍',
      }));
      const result = groupReactions(reactions);
      expect(result['👍']).toHaveLength(100);
      expect(result['👍'][0]).toBe('user_0');
      expect(result['👍'][99]).toBe('user_99');
    });

    it('should handle many emojis with different users', () => {
      const reactions = Array.from({ length: 50 }, (_, i) => ({
        user_id: `user_${i}`,
        emoji: `emoji_${i}`,
      }));
      const result = groupReactions(reactions);
      expect(Object.keys(result)).toHaveLength(50);
      expect(result.emoji_0).toEqual(['user_0']);
      expect(result.emoji_49).toEqual(['user_49']);
    });
  });
});
