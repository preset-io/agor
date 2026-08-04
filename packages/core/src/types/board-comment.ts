import type { ThreadedComment } from './comment';
import type { BoardID, BranchID, MessageID, SessionID, TaskID } from './id';

/**
 * Board Comment - Human-to-human conversations and collaboration
 *
 * Flexible attachment strategy supporting:
 * - Board-level: General conversations (no attachments)
 * - Object-level: Attached to sessions, tasks, messages, or branches
 * - Spatial: Positioned on canvas (absolute or relative to objects)
 *
 * Threading model: Figma-style 2-layer (thread roots + replies)
 * - Thread roots: parent_comment_id IS NULL, can be resolved, must have attachments
 * - Replies: parent_comment_id IS NOT NULL, cannot be resolved, inherit parent context
 */
export interface BoardComment extends ThreadedComment {
  /** Board this comment belongs to */
  board_id: BoardID;

  // ============================================================================
  // Optional Attachments (Phase 2)
  // ============================================================================

  /** Optional: Attached to session */
  session_id?: SessionID;

  /** Optional: Attached to task */
  task_id?: TaskID;

  /** Optional: Attached to message */
  message_id?: MessageID;

  /** Optional: Attached to branch */
  branch_id?: BranchID;

  // ============================================================================
  // Spatial Positioning (Phase 3)
  // ============================================================================

  /** Optional: Spatial positioning on canvas */
  position?: {
    /** Absolute board coordinates (React Flow coordinates) */
    absolute?: { x: number; y: number };
    /** OR relative to session/zone/branch (follows parent when it moves) */
    relative?: {
      /** Parent object ID - can be session_id, zone object ID, or branch_id */
      parent_id: string;
      /** Type of parent for proper lookup */
      parent_type: 'session' | 'zone' | 'branch';
      /** Offset from parent's top-left corner */
      offset_x: number;
      offset_y: number;
    };
  };
}

/**
 * Comment attachment type determination
 *
 * Hierarchy (most specific → least specific):
 * 1. MESSAGE - Attached to specific message
 * 2. TASK - Attached to task
 * 3. SESSION_SPATIAL - Spatial pin on session (relative positioning)
 * 4. SESSION - Attached to session
 * 5. BRANCH_SPATIAL - Spatial pin on branch (relative positioning)
 * 6. BRANCH - Attached to branch
 * 7. ZONE_SPATIAL - Spatial pin on zone (relative positioning)
 * 8. BOARD_SPATIAL - Spatial pin on board (absolute positioning)
 * 9. BOARD - General board conversation
 */
export const CommentAttachmentType = {
  MESSAGE: 'message',
  TASK: 'task',
  SESSION_SPATIAL: 'session-spatial',
  SESSION: 'session',
  BRANCH_SPATIAL: 'branch-spatial',
  BRANCH: 'branch',
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
    if (comment.position.relative.parent_type === 'branch') {
      return CommentAttachmentType.BRANCH_SPATIAL;
    }
    if (comment.position.relative.parent_type === 'zone') {
      return CommentAttachmentType.ZONE_SPATIAL;
    }
  }

  // FK-based attachments
  if (comment.session_id) return CommentAttachmentType.SESSION;
  if (comment.branch_id) return CommentAttachmentType.BRANCH;

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

// Threading, reaction and preview helpers live in `./comment`, shared with the
// other comment domains and re-exported from `types/index`.
