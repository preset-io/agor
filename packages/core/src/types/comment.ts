import type { CommentID, UserID } from './id';

/** Max length of the materialized `content_preview` column. */
export const COMMENT_PREVIEW_LENGTH = 200;

/**
 * Individual reaction on a comment
 * Stored as JSON array: [{ user_id: "abc", emoji: "👍" }, ...]
 */
export interface CommentReaction {
  user_id: string;
  emoji: string;
}

/**
 * Reactions grouped by emoji for display
 * Example: { "👍": ["alice", "bob"], "🎉": ["charlie"] }
 */
export type ReactionSummary = Record<string, string[]>;

/**
 * Fields shared by every Agor comment domain (board comments, Knowledge
 * document comments, ...).
 *
 * Threading model: Figma-style 2 layers (thread roots + replies)
 * - Thread roots: parent_comment_id IS NULL, can be resolved
 * - Replies: parent_comment_id IS NOT NULL, cannot be resolved
 *
 * Domain-specific attachment (board/session/document/...) lives on the
 * extending interface so `CommentsPanel` can render any of them.
 */
export interface ThreadedComment {
  /** Unique comment identifier (UUIDv7) */
  comment_id: CommentID;

  /** User who created the comment */
  created_by: UserID;

  /** Comment content (Markdown-supported) */
  content: string;

  /** First `COMMENT_PREVIEW_LENGTH` chars for list views */
  content_preview: string;

  /** Optional: Parent comment for threaded replies */
  parent_comment_id?: CommentID;

  /** Whether comment is resolved (GitHub PR-style) */
  resolved: boolean;

  /** Whether comment was edited after creation */
  edited: boolean;

  /** Emoji reactions (for both thread roots and replies) */
  reactions: CommentReaction[];

  /** Optional: @mentioned user IDs */
  mentions?: UserID[];

  created_at: Date;
  updated_at?: Date;
}

/** Materialized preview for list views. */
export function commentContentPreview(content: string): string {
  return content.length > COMMENT_PREVIEW_LENGTH
    ? `${content.slice(0, COMMENT_PREVIEW_LENGTH)}...`
    : content;
}

/**
 * Check if comment is a thread root (top-level comment)
 */
export function isThreadRoot(comment: Pick<ThreadedComment, 'parent_comment_id'>): boolean {
  return !comment.parent_comment_id;
}

/**
 * Check if comment is a reply (nested comment)
 */
export function isReply(comment: Pick<ThreadedComment, 'parent_comment_id'>): boolean {
  return !!comment.parent_comment_id;
}

/**
 * Check if comment can be resolved
 * Only thread roots can be resolved, replies cannot
 */
export function isResolvable(comment: Pick<ThreadedComment, 'parent_comment_id'>): boolean {
  return isThreadRoot(comment);
}

/**
 * Group reactions by emoji for display
 * Input: [{ user_id: "alice", emoji: "👍" }, { user_id: "bob", emoji: "👍" }, { user_id: "charlie", emoji: "🎉" }]
 * Output: { "👍": ["alice", "bob"], "🎉": ["charlie"] }
 */
export function groupReactions(reactions: CommentReaction[]): ReactionSummary {
  const grouped: Record<string, string[]> = {};
  for (const { emoji, user_id } of reactions) {
    if (!grouped[emoji]) {
      grouped[emoji] = [];
    }
    grouped[emoji].push(user_id);
  }
  return grouped;
}

/**
 * Toggle a user's emoji reaction: remove it when present, add it otherwise.
 */
export function toggleCommentReaction(
  reactions: CommentReaction[],
  userId: string,
  emoji: string
): CommentReaction[] {
  const existingIndex = reactions.findIndex((r) => r.user_id === userId && r.emoji === emoji);
  return existingIndex >= 0
    ? reactions.filter((_, index) => index !== existingIndex)
    : [...reactions, { user_id: userId, emoji }];
}
