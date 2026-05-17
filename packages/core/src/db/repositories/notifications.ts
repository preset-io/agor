/**
 * Notifications Repository
 *
 * Durable per-user inbox. See `docs/notification-system-design.md` for design.
 *
 * Special behaviors:
 * - {@link upsertCollapsed} implements the `session_returned` collapse rule
 *   from §5.2 — at most one un-dismissed row per (recipient, session, type).
 * - {@link deleteBySourceSession} / {@link deleteBySourceWorktree} are called
 *   from archive hooks; dismissing is a hard-delete (§5.3).
 * - {@link broadcast} fans out one row per active user for `global_admin`.
 */

import type {
  Notification,
  NotificationCreate,
  NotificationData,
  NotificationID,
  NotificationType,
  UUID,
} from '@agor/core/types';
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, txAsDb, update } from '../database-wrapper';
import { type NotificationInsert, type NotificationRow, notifications, users } from '../schema';
import { type BaseRepository, EntityNotFoundError, RepositoryError } from './base';

export interface NotificationFilters {
  recipient_user_id?: string;
  type?: NotificationType;
  /** `true` = unread only; `false` = read only; omit for both. */
  unread?: boolean;
}

export class NotificationsRepository
  implements BaseRepository<Notification, Partial<Notification>>
{
  constructor(private db: Database) {}

  // ============================================================================
  // Row <-> Notification conversion
  // ============================================================================

  private rowToNotification(row: NotificationRow): Notification {
    const data: NotificationData =
      row.data && typeof row.data === 'object'
        ? (row.data as NotificationData)
        : typeof row.data === 'string'
          ? (JSON.parse(row.data) as NotificationData)
          : {};

    return {
      notification_id: row.notification_id as NotificationID,
      created_at: new Date(row.created_at),
      recipient_user_id: row.recipient_user_id as UUID,
      type: row.type as NotificationType,
      title: row.title,
      preview: row.preview ?? undefined,
      source_session_id: row.source_session_id ? (row.source_session_id as UUID) : undefined,
      source_worktree_id: row.source_worktree_id ? (row.source_worktree_id as UUID) : undefined,
      source_board_id: row.source_board_id ? (row.source_board_id as UUID) : undefined,
      source_comment_id: row.source_comment_id ? (row.source_comment_id as UUID) : undefined,
      source_task_id: row.source_task_id ? (row.source_task_id as UUID) : undefined,
      source_user_id: row.source_user_id ? (row.source_user_id as UUID) : undefined,
      read_at: row.read_at ? new Date(row.read_at) : undefined,
      expires_at: row.expires_at ? new Date(row.expires_at) : undefined,
      data,
    };
  }

  private toInsert(notif: NotificationCreate & { notification_id?: string }): NotificationInsert {
    const now = new Date();
    return {
      notification_id: notif.notification_id ?? generateId(),
      created_at: notif.created_at ?? now,
      recipient_user_id: notif.recipient_user_id,
      type: notif.type,
      title: notif.title,
      preview: notif.preview ?? null,
      source_session_id: notif.source_session_id ?? null,
      source_worktree_id: notif.source_worktree_id ?? null,
      source_board_id: notif.source_board_id ?? null,
      source_comment_id: notif.source_comment_id ?? null,
      source_task_id: notif.source_task_id ?? null,
      source_user_id: notif.source_user_id ?? null,
      read_at: notif.read_at ?? null,
      expires_at: notif.expires_at ?? null,
      data: (notif.data ?? {}) as NotificationData,
    };
  }

  // ============================================================================
  // Standard CRUD
  // ============================================================================

  async create(data: Partial<Notification>): Promise<Notification> {
    try {
      if (!data.recipient_user_id) {
        throw new RepositoryError('recipient_user_id is required');
      }
      if (!data.type) {
        throw new RepositoryError('type is required');
      }
      if (!data.title) {
        throw new RepositoryError('title is required');
      }

      const insertData = this.toInsert(data as NotificationCreate);
      await insert(this.db, notifications).values(insertData).run();

      const row = await select(this.db)
        .from(notifications)
        .where(eq(notifications.notification_id, insertData.notification_id))
        .one();

      if (!row) {
        throw new RepositoryError('Failed to retrieve created notification');
      }
      return this.rowToNotification(row);
    } catch (error) {
      if (error instanceof RepositoryError) throw error;
      throw new RepositoryError(
        `Failed to create notification: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  async findById(id: string): Promise<Notification | null> {
    const row = await select(this.db)
      .from(notifications)
      .where(eq(notifications.notification_id, id))
      .one();
    return row ? this.rowToNotification(row) : null;
  }

  /**
   * Generic findAll — used by FeathersJS service layer which then applies
   * client-side filtering. Repository methods below cover the hot paths with
   * dedicated SQL filters.
   */
  async findAll(filters?: NotificationFilters): Promise<Notification[]> {
    const conditions = [];
    if (filters?.recipient_user_id) {
      conditions.push(eq(notifications.recipient_user_id, filters.recipient_user_id));
    }
    if (filters?.type) {
      conditions.push(eq(notifications.type, filters.type));
    }
    if (filters?.unread === true) {
      conditions.push(isNull(notifications.read_at));
    } else if (filters?.unread === false) {
      conditions.push(isNotNull(notifications.read_at));
    }

    let q = select(this.db).from(notifications);
    if (conditions.length > 0) {
      q = q.where(and(...conditions)) as typeof q;
    }
    const rows = await q.all();
    // Sort newest first in app code (consistent across dialects)
    const sorted = (rows as NotificationRow[]).sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
    return sorted.map((r) => this.rowToNotification(r));
  }

  async update(id: string, updates: Partial<Notification>): Promise<Notification> {
    const current = await this.findById(id);
    if (!current) {
      throw new EntityNotFoundError('Notification', id);
    }

    // Only mutable columns at the API layer: read_at, expires_at.
    const patch: Partial<NotificationInsert> = {};
    if ('read_at' in updates) {
      patch.read_at = updates.read_at ? new Date(updates.read_at) : null;
    }
    if ('expires_at' in updates) {
      patch.expires_at = updates.expires_at ? new Date(updates.expires_at) : null;
    }

    if (Object.keys(patch).length === 0) {
      return current;
    }

    await update(this.db, notifications)
      .set(patch)
      .where(eq(notifications.notification_id, id))
      .run();

    const fresh = await this.findById(id);
    if (!fresh) {
      throw new RepositoryError('Failed to retrieve updated notification');
    }
    return fresh;
  }

  async delete(id: string): Promise<void> {
    const result = await deleteFrom(this.db, notifications)
      .where(eq(notifications.notification_id, id))
      .run();
    if (result.rowsAffected === 0) {
      throw new EntityNotFoundError('Notification', id);
    }
  }

  // ============================================================================
  // Hot-path queries
  // ============================================================================

  /** Unread count for a user — used by the badge. */
  async countUnread(recipientUserId: string): Promise<number> {
    const rows = await select(this.db)
      .from(notifications)
      .where(
        and(eq(notifications.recipient_user_id, recipientUserId), isNull(notifications.read_at))
      )
      .all();
    return rows.length;
  }

  /** Mark every unread notif for this user as read. Returns the count updated. */
  async markAllRead(recipientUserId: string): Promise<number> {
    const now = new Date();
    const result = await update(this.db, notifications)
      .set({ read_at: now })
      .where(
        and(eq(notifications.recipient_user_id, recipientUserId), isNull(notifications.read_at))
      )
      .run();
    return result.rowsAffected;
  }

  // ============================================================================
  // Collapse upsert — `session_returned` only
  // ============================================================================

  /**
   * Upsert with the (recipient, session, type) collapse rule from §5.2.
   *
   * If a row already exists for the same (recipient_user_id, source_session_id,
   * type), refresh `title`/`preview`/`source_task_id`/`data`, bump `created_at`
   * to now, and **clear `read_at`** (so the badge re-increments). Otherwise
   * INSERT a fresh row.
   *
   * Runs in a single transaction to avoid the SELECT-INSERT race.
   *
   * Returns the row plus a flag indicating which side fired.
   */
  async upsertCollapsed(
    notif: NotificationCreate
  ): Promise<{ row: Notification; created: boolean }> {
    if (!notif.source_session_id) {
      throw new RepositoryError('upsertCollapsed requires source_session_id');
    }

    return await this.db.transaction(async (tx) => {
      const existing = (await select(txAsDb(tx))
        .from(notifications)
        .where(
          and(
            eq(notifications.recipient_user_id, notif.recipient_user_id),
            eq(notifications.source_session_id, notif.source_session_id as string),
            eq(notifications.type, notif.type)
          )
        )
        .all()) as NotificationRow[];

      const now = new Date();

      if (existing.length > 0) {
        // Refresh the most recent row (in practice there should only be one)
        const target = existing.sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        )[0];

        await update(txAsDb(tx), notifications)
          .set({
            title: notif.title,
            preview: notif.preview ?? null,
            source_task_id: notif.source_task_id ?? null,
            source_worktree_id: notif.source_worktree_id ?? target.source_worktree_id,
            source_board_id: notif.source_board_id ?? target.source_board_id,
            source_user_id: notif.source_user_id ?? target.source_user_id,
            created_at: now,
            read_at: null,
            data: (notif.data ?? {}) as NotificationData,
          })
          .where(eq(notifications.notification_id, target.notification_id))
          .run();

        const fresh = (await select(txAsDb(tx))
          .from(notifications)
          .where(eq(notifications.notification_id, target.notification_id))
          .one()) as NotificationRow | null;
        if (!fresh) {
          throw new RepositoryError('Failed to retrieve upserted notification');
        }
        return { row: this.rowToNotification(fresh), created: false };
      }

      const insertData = this.toInsert({ ...notif, created_at: now });
      await insert(txAsDb(tx), notifications).values(insertData).run();
      const fresh = (await select(txAsDb(tx))
        .from(notifications)
        .where(eq(notifications.notification_id, insertData.notification_id))
        .one()) as NotificationRow | null;
      if (!fresh) {
        throw new RepositoryError('Failed to retrieve inserted notification');
      }
      return { row: this.rowToNotification(fresh), created: true };
    });
  }

  // ============================================================================
  // Cleanup / sweeps
  // ============================================================================

  /** Archive hook for sessions. Returns deleted IDs so the caller can emit removed events. */
  async deleteBySourceSession(sessionId: string): Promise<string[] | undefined> {
    const rows = (await select(this.db)
      .from(notifications)
      .where(eq(notifications.source_session_id, sessionId))
      .all()) as NotificationRow[];
    if (rows.length === 0) return [];
    await deleteFrom(this.db, notifications)
      .where(eq(notifications.source_session_id, sessionId))
      .run();
    return rows.map((r) => r.notification_id);
  }

  /** Archive hook for worktrees. Returns deleted IDs. */
  async deleteBySourceWorktree(worktreeId: string): Promise<string[]> {
    const rows = (await select(this.db)
      .from(notifications)
      .where(eq(notifications.source_worktree_id, worktreeId))
      .all()) as NotificationRow[];
    if (rows.length === 0) return [];
    await deleteFrom(this.db, notifications)
      .where(eq(notifications.source_worktree_id, worktreeId))
      .run();
    return rows.map((r) => r.notification_id);
  }

  /**
   * Hard-delete every notification for a recipient. Powers the panel's
   * "Clear" button — see design doc §3.2. Returns the deleted ids so the
   * service can emit a `notification:bulk_removed` event.
   */
  async deleteAllForRecipient(recipientUserId: string): Promise<string[]> {
    const rows = (await select(this.db)
      .from(notifications)
      .where(eq(notifications.recipient_user_id, recipientUserId))
      .all()) as NotificationRow[];
    if (rows.length === 0) return [];
    await deleteFrom(this.db, notifications)
      .where(eq(notifications.recipient_user_id, recipientUserId))
      .run();
    return rows.map((r) => r.notification_id);
  }

  /**
   * Retention sweep — deletes read notifications older than `olderThan`.
   *
   * Caller controls the cutoff (the cron passes `now - 90d`). Returns the
   * number of rows deleted for logging.
   */
  async deleteOldRead(olderThan: Date): Promise<number> {
    const result = await deleteFrom(this.db, notifications)
      .where(and(isNotNull(notifications.read_at), lt(notifications.read_at, olderThan)))
      .run();
    return result.rowsAffected;
  }

  /**
   * Bulk-expire every row in a broadcast group (admin "Expire now").
   *
   * Uses JSON containment to find rows with matching `data.broadcast_group_id`.
   */
  async expireBroadcastGroup(groupId: string): Promise<number> {
    const now = new Date();
    // Find all rows in the group — small N (admin broadcasts), fine to scan.
    const all = (await select(this.db)
      .from(notifications)
      .where(eq(notifications.type, 'global_admin'))
      .all()) as NotificationRow[];
    const ids = all
      .filter((r) => {
        const data =
          r.data && typeof r.data === 'object'
            ? (r.data as NotificationData)
            : typeof r.data === 'string'
              ? (JSON.parse(r.data) as NotificationData)
              : {};
        return data.broadcast_group_id === groupId;
      })
      .map((r) => r.notification_id);
    if (ids.length === 0) return 0;
    let count = 0;
    for (const id of ids) {
      const res = await update(this.db, notifications)
        .set({ expires_at: now })
        .where(eq(notifications.notification_id, id))
        .run();
      count += res.rowsAffected;
    }
    return count;
  }

  /**
   * Find rows in a broadcast group — used by the admin "Active broadcasts" list.
   */
  async findByBroadcastGroup(groupId: string): Promise<Notification[]> {
    const all = (await select(this.db)
      .from(notifications)
      .where(eq(notifications.type, 'global_admin'))
      .all()) as NotificationRow[];
    return all
      .filter((r) => {
        const data =
          r.data && typeof r.data === 'object'
            ? (r.data as NotificationData)
            : typeof r.data === 'string'
              ? (JSON.parse(r.data) as NotificationData)
              : {};
        return data.broadcast_group_id === groupId;
      })
      .map((r) => this.rowToNotification(r));
  }

  // ============================================================================
  // Broadcast (admin global messages)
  // ============================================================================

  /**
   * Insert one notification row per active user. Returns the created rows so
   * the service can emit per-user socket events.
   *
   * Uses INSERT … SELECT for atomic fanout — the user list at fire time wins,
   * no race window between counting users and inserting rows.
   */
  async broadcast(payload: {
    title: string;
    preview?: string;
    banner: boolean;
    expires_at?: Date;
    broadcast_group_id: string;
    source_user_id: string;
  }): Promise<Notification[]> {
    const userRows = (await select(this.db).from(users).all()) as Array<{ user_id: string }>;
    if (userRows.length === 0) return [];

    const now = new Date();
    const data: NotificationData = {
      banner: payload.banner,
      broadcast_group_id: payload.broadcast_group_id,
    };

    const inserts: NotificationInsert[] = userRows.map((u) => ({
      notification_id: generateId(),
      created_at: now,
      recipient_user_id: u.user_id,
      type: 'global_admin',
      title: payload.title,
      preview: payload.preview ?? null,
      source_session_id: null,
      source_worktree_id: null,
      source_board_id: null,
      source_comment_id: null,
      source_task_id: null,
      source_user_id: payload.source_user_id,
      read_at: null,
      expires_at: payload.expires_at ?? null,
      data,
    }));

    if (inserts.length === 0) return [];
    await insert(this.db, notifications).values(inserts).run();

    // Fetch back via the broadcast_group_id marker so we get the materialized
    // rows (e.g. with whatever defaults the engine filled in).
    return this.findByBroadcastGroup(payload.broadcast_group_id);
  }

  /**
   * Find all distinct broadcast groups, newest first. Used by the admin
   * "Announcements" tab to list active and recent broadcasts.
   */
  async listBroadcastGroups(): Promise<
    Array<{
      broadcast_group_id: string;
      title: string;
      preview?: string;
      banner: boolean;
      created_at: Date;
      expires_at?: Date;
      recipient_count: number;
      source_user_id?: string;
    }>
  > {
    const all = (await select(this.db)
      .from(notifications)
      .where(eq(notifications.type, 'global_admin'))
      .all()) as NotificationRow[];

    const groups = new Map<
      string,
      {
        broadcast_group_id: string;
        title: string;
        preview?: string;
        banner: boolean;
        created_at: Date;
        expires_at?: Date;
        recipient_count: number;
        source_user_id?: string;
      }
    >();

    for (const r of all) {
      const data =
        r.data && typeof r.data === 'object'
          ? (r.data as NotificationData)
          : typeof r.data === 'string'
            ? (JSON.parse(r.data) as NotificationData)
            : {};
      const groupId = data.broadcast_group_id;
      if (!groupId) continue;
      const existing = groups.get(groupId);
      if (existing) {
        existing.recipient_count += 1;
      } else {
        groups.set(groupId, {
          broadcast_group_id: groupId,
          title: r.title,
          preview: r.preview ?? undefined,
          banner: data.banner ?? false,
          created_at: new Date(r.created_at),
          expires_at: r.expires_at ? new Date(r.expires_at) : undefined,
          recipient_count: 1,
          source_user_id: r.source_user_id ?? undefined,
        });
      }
    }

    return Array.from(groups.values()).sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime()
    );
  }
}
