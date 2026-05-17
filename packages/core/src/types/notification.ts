/**
 * Notification — durable inbox row for a single recipient.
 *
 * See `docs/notification-system-design.md` for the full design.
 *
 * v1 types:
 * - `mention`: a board comment whose `data.mentions[]` includes the recipient
 * - `session_returned`: a task on a subscribed session reached COMPLETED/FAILED
 * - `global_admin`: an admin broadcast, fanned out one row per user
 */

import type { BoardID, CommentID, SessionID, TaskID, UserID, UUID, WorktreeID } from './id';

export const NotificationType = {
  MENTION: 'mention',
  SESSION_RETURNED: 'session_returned',
  GLOBAL_ADMIN: 'global_admin',
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

/**
 * Notification identifier — UUIDv7, 36 chars.
 */
export type NotificationID = UUID;

/**
 * Type-specific extras carried alongside the materialized title/preview.
 *
 * Producers stamp the fields they care about; consumers read defensively
 * (everything is optional).
 */
export interface NotificationData {
  /** Sticky-banner flag for admin broadcasts. Defaults to false. */
  banner?: boolean;

  /** Agentic tool icon hint for `session_returned` cards (`claude-code` etc.) */
  agentic_tool?: string;

  /**
   * Group id for admin broadcasts — every fanned-out row in a single broadcast
   * shares this id so we can bulk-expire / bulk-patch.
   */
  broadcast_group_id?: string;
}

export interface Notification {
  notification_id: NotificationID;
  created_at: Date;

  /** The user that should see this row. */
  recipient_user_id: UserID;

  /** Type discriminator — drives icon and link target. */
  type: NotificationType;

  /** Materialized for the panel — no joins required to render. */
  title: string;
  preview?: string;

  /**
   * Source pointers — all optional, depend on type. SET NULL on cascade so
   * the row stays renderable when its source is deleted (the UI shows a
   * "this session was deleted" fallback rather than crashing).
   */
  source_session_id?: SessionID;
  source_worktree_id?: WorktreeID;
  source_board_id?: BoardID;
  source_comment_id?: CommentID;
  source_task_id?: TaskID;
  /** Who triggered this notification (the @-tagger, the broadcasting admin, …). */
  source_user_id?: UserID;

  /** Null = unread; set timestamp = read. Dismiss is hard-delete (no column). */
  read_at?: Date;

  /** Admin-set on "Expire now"; client filters expired banners out. */
  expires_at?: Date;

  /** Type-specific extras (see NotificationData). */
  data: NotificationData;
}

/**
 * Insert shape — the row the producer hands the repository.
 * `notification_id` and `created_at` are auto-filled when omitted.
 */
export type NotificationCreate = Omit<Notification, 'notification_id' | 'created_at'> & {
  notification_id?: NotificationID;
  created_at?: Date;
};

/**
 * Patch shape — clients can flip `read_at` / `expires_at`; everything else
 * is immutable from the API.
 */
export interface NotificationPatch {
  read_at?: Date | null;
  expires_at?: Date | null;
}

/**
 * Payload for the `broadcast` custom service method.
 */
export interface NotificationBroadcastInput {
  title: string;
  preview?: string;
  banner?: boolean;
  expires_at?: Date | null;
  /** Optional override; otherwise the service generates one. */
  broadcast_group_id?: string;
}

/**
 * The Feathers `find` filter shape (also accepted at the REST boundary).
 */
export interface NotificationQuery {
  recipient_user_id?: string;
  type?: NotificationType;
  /** `true` returns only unread rows; `false` returns only read rows. */
  unread?: boolean;
  $limit?: number;
  $skip?: number;
  $sort?: { created_at?: 1 | -1 };
}
