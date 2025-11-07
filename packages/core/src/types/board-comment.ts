import type { BoardID, CommentID, MessageID, SessionID, TaskID, UserID, WorktreeID } from './id';

/**
 * Individual reaction on a comment
 * Stored as JSON array with nested reactions support
 */
export interface CommentReaction {
  /** Unique identifier for this reaction (UUIDv7) */
  reaction_id: string;
  user_id: string;
  emoji: string;
  /** Nested reactions on this reaction (emoji reaction tree) */
  reactions?: CommentReaction[];
}

/**
 * Reactions grouped by emoji for display
 * Example: { "👍": ["alice", "bob"], "🎉": ["charlie"] }
 */
export type ReactionSummary = Record<string, string[]>;

/**
 * Board Comment - Human-to-human conversations and collaboration
 *
 * Flexible attachment strategy supporting:
 * - Board-level: General conversations (no attachments)
 * - Object-level: Attached to sessions, tasks, messages, or worktrees
 * - Spatial: Positioned on canvas (absolute or relative to objects)
 *
 * Threading model: Figma-style 2-layer (thread roots + replies)
 * - Thread roots: parent_comment_id IS NULL, can be resolved, must have attachments
 * - Replies: parent_comment_id IS NOT NULL, cannot be resolved, inherit parent context
 *
 * @see context/explorations/user-comments-and-conversation.md
 */
export interface BoardComment {
  /** Unique comment identifier (UUIDv7) */
  comment_id: CommentID;

  /** Board this comment belongs to */
  board_id: BoardID;

  /** User who created the comment */
  created_by: UserID;

  /** Comment content (Markdown-supported) */
  content: string;

  /** First 200 chars for list views */
  content_preview: string;

  // ============================================================================
  // Optional Attachments (Phase 2)
  // ============================================================================

  /** Optional: Attached to session */
  session_id?: SessionID;

  /** Optional: Attached to task */
  task_id?: TaskID;

  /** Optional: Attached to message */
  message_id?: MessageID;

  /** Optional: Attached to worktree */
  worktree_id?: WorktreeID;

  // ============================================================================
  // Threading & Metadata
  // ============================================================================

  /** Optional: Parent comment for threaded replies */
  parent_comment_id?: CommentID;

  /** Whether comment is resolved (GitHub PR-style) */
  resolved: boolean;

  /** Whether comment was edited after creation */
  edited: boolean;

  // ============================================================================
  // Reactions (Phase 2)
  // ============================================================================

  /** Emoji reactions (for both thread roots and replies) */
  reactions: CommentReaction[];

  // ============================================================================
  // Spatial Positioning (Phase 3)
  // ============================================================================

  /** Optional: Spatial positioning on canvas */
  position?: {
    /** Absolute board coordinates (React Flow coordinates) */
    absolute?: { x: number; y: number };
    /** OR relative to session/zone/worktree (follows parent when it moves) */
    relative?: {
      /** Parent object ID - can be session_id, zone object ID, or worktree_id */
      parent_id: string;
      /** Type of parent for proper lookup */
      parent_type: 'session' | 'zone' | 'worktree';
      /** Offset from parent's top-left corner */
      offset_x: number;
      offset_y: number;
    };
  };

  // ============================================================================
  // Mentions (Phase 4)
  // ============================================================================

  /** Optional: @mentioned user IDs */
  mentions?: UserID[];

  // ============================================================================
  // Timestamps
  // ============================================================================

  created_at: Date;
  updated_at?: Date;
}

/**
 * Comment attachment type determination
 *
 * Hierarchy (most specific → least specific):
 * 1. MESSAGE - Attached to specific message
 * 2. TASK - Attached to task
 * 3. SESSION_SPATIAL - Spatial pin on session (relative positioning)
 * 4. SESSION - Attached to session
 * 5. WORKTREE_SPATIAL - Spatial pin on worktree (relative positioning)
 * 6. WORKTREE - Attached to worktree
 * 7. ZONE_SPATIAL - Spatial pin on zone (relative positioning)
 * 8. BOARD_SPATIAL - Spatial pin on board (absolute positioning)
 * 9. BOARD - General board conversation
 */
export const CommentAttachmentType = {
  MESSAGE: 'message',
  TASK: 'task',
  SESSION_SPATIAL: 'session-spatial',
  SESSION: 'session',
  WORKTREE_SPATIAL: 'worktree-spatial',
  WORKTREE: 'worktree',
  ZONE_SPATIAL: 'zone-spatial',
  BOARD_SPATIAL: 'board-spatial',
  BOARD: 'board',
} as const;

export type CommentAttachmentType =
  (typeof CommentAttachmentType)[keyof typeof CommentAttachmentType];

/**
 * Helper function to determine comment attachment type
 */
export function getCommentAttachmentType(comment: BoardComment): CommentAttachmentType {
  // Most specific → least specific
  if (comment.message_id) return CommentAttachmentType.MESSAGE;
  if (comment.task_id) return CommentAttachmentType.TASK;

  // Check for relative positioning (spatial pins)
  if (comment.position?.relative) {
    if (comment.position.relative.parent_type === 'session') {
      return CommentAttachmentType.SESSION_SPATIAL;
    }
    if (comment.position.relative.parent_type === 'worktree') {
      return CommentAttachmentType.WORKTREE_SPATIAL;
    }
    if (comment.position.relative.parent_type === 'zone') {
      return CommentAttachmentType.ZONE_SPATIAL;
    }
  }

  // FK-based attachments
  if (comment.session_id) return CommentAttachmentType.SESSION;
  if (comment.worktree_id) return CommentAttachmentType.WORKTREE;

  // Absolute positioning or board-level
  if (comment.position?.absolute) return CommentAttachmentType.BOARD_SPATIAL;
  return CommentAttachmentType.BOARD; // Default: board-level conversation
}

/**
 * Create input for new comment (omits auto-generated fields)
 */
export type BoardCommentCreate = Omit<
  BoardComment,
  'comment_id' | 'created_at' | 'updated_at' | 'content_preview'
> & {
  content: string; // Will auto-generate content_preview
};

/**
 * Patch input for updating comment (partial)
 */
export type BoardCommentPatch = Partial<Pick<BoardComment, 'content' | 'resolved'>> & {
  edited?: boolean; // Auto-set to true when content is updated
};

// ============================================================================
// Helper Functions (Phase 2: Threading + Reactions)
// ============================================================================

/**
 * Check if comment is a thread root (top-level comment)
 */
export function isThreadRoot(comment: BoardComment): boolean {
  return !comment.parent_comment_id;
}

/**
 * Check if comment is a reply (nested comment)
 */
export function isReply(comment: BoardComment): boolean {
  return !!comment.parent_comment_id;
}

/**
 * Check if comment can be resolved
 * Only thread roots can be resolved, replies cannot
 */
export function isResolvable(comment: BoardComment): boolean {
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
