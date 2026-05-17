/**
 * Notifications Service
 *
 * Durable per-user inbox. See `docs/notification-system-design.md`.
 *
 * Surface:
 * - `find` — scoped to the authenticated user by a hook (recipient_user_id forced).
 * - `get` / `patch` / `remove` — standard, but only the recipient can act.
 * - `broadcast` — custom admin-only fanout (one row per user + per-user emit).
 * - `markAllRead` — custom convenience for the "Mark all read" button.
 *
 * Producers (`session_returned`, `mention`) write through this service so the
 * Feathers `created` event fires for every recipient and the per-user socket
 * room receives the row. The collapse upsert for `session_returned` is
 * handled by `NotificationsRepository.upsertCollapsed` and surfaces here as
 * either a `created` or `patched` event depending on which side fired.
 */

import { PAGINATION } from '@agor/core/config';
import { type Database, generateId, NotificationsRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type {
  AuthenticatedParams,
  Notification,
  NotificationBroadcastInput,
  NotificationCreate,
  QueryParams,
} from '@agor/core/types';
import { DrizzleService } from '../adapters/drizzle';
import { userRoomName } from '../setup/socketio';

export type NotificationsParams = QueryParams<{
  recipient_user_id?: string;
  type?: Notification['type'];
  unread?: boolean;
}> &
  AuthenticatedParams;

type AppWithIO = Application & {
  io?: {
    to: (room: string) => { emit: (event: string, payload: unknown) => void };
    emit: (event: string, payload: unknown) => void;
  };
};

export class NotificationsService extends DrizzleService<
  Notification,
  Partial<Notification>,
  NotificationsParams
> {
  private notifRepo: NotificationsRepository;
  private app: AppWithIO;

  constructor(db: Database, app: Application) {
    const notifRepo = new NotificationsRepository(db);
    super(notifRepo, {
      id: 'notification_id',
      resourceType: 'Notification',
      paginate: {
        default: PAGINATION.DEFAULT_LIMIT,
        max: PAGINATION.MAX_LIMIT,
      },
      multi: ['patch', 'remove'],
    });
    this.notifRepo = notifRepo;
    this.app = app as AppWithIO;
  }

  /** FeathersJS hook helper — derives the current user's id from auth params. */
  private getRequestingUserId(params?: NotificationsParams): string | undefined {
    return params?.user?.user_id;
  }

  /**
   * Override find so we can use repository filters efficiently instead of
   * fetching every row and filtering client-side. Also enforces the rule
   * that a user can only see their own notifications.
   */
  async find(params?: NotificationsParams) {
    const userId = this.getRequestingUserId(params);
    const q = params?.query ?? {};

    const filters = {
      recipient_user_id: userId, // authenticated user only
      type: q.type as Notification['type'] | undefined,
      unread: q.unread,
    };

    const all = await this.notifRepo.findAll(filters);

    const $limit = q.$limit ?? PAGINATION.DEFAULT_LIMIT;
    const $skip = q.$skip ?? 0;
    const data = all.slice($skip, $skip + $limit);

    return {
      total: all.length,
      limit: $limit,
      skip: $skip,
      data,
    };
  }

  /**
   * Override patch to enforce that only the recipient can mark a notification
   * read, and to emit on the per-user room.
   */
  async patch(
    id: string | null,
    data: Partial<Notification>,
    params?: NotificationsParams
  ): Promise<Notification | Notification[]> {
    if (id === null) {
      // multi-patch is enabled but we don't expose it externally; let the
      // default adapter behavior handle it for completeness.
      return super.patch(id, data, params);
    }

    const existing = await this.notifRepo.findById(id);
    if (!existing) {
      // Defer to base behavior to throw the canonical NotFoundError.
      return super.patch(id, data, params) as Promise<Notification>;
    }

    const userId = this.getRequestingUserId(params);
    if (userId && existing.recipient_user_id !== userId) {
      throw new Error("Cannot patch another user's notification");
    }

    const result = (await super.patch(id, data, params)) as Notification;
    this.emitToRecipient('patched', result);
    return result;
  }

  /**
   * Override remove similarly — only the recipient can dismiss.
   */
  async remove(
    id: string | null,
    params?: NotificationsParams
  ): Promise<Notification | Notification[]> {
    if (id === null) {
      return super.remove(id, params);
    }

    const existing = await this.notifRepo.findById(id);
    if (!existing) {
      return super.remove(id, params) as Promise<Notification>;
    }

    const userId = this.getRequestingUserId(params);
    if (userId && existing.recipient_user_id !== userId) {
      throw new Error("Cannot remove another user's notification");
    }

    const result = (await super.remove(id, params)) as Notification;
    this.emitToRecipient('removed', result);
    return result;
  }

  /**
   * Internal write path used by producers. Bypasses authentication checks
   * (the caller has already authorized the recipient).
   */
  async deliver(notif: NotificationCreate): Promise<Notification> {
    const row = await this.notifRepo.create(notif as Partial<Notification>);
    this.emit?.('created', row);
    this.emitToRecipient('notification:created', row);
    return row;
  }

  /**
   * Internal collapse-upsert used by the `session_returned` producer. Emits
   * either `notification:created` or `notification:patched` based on which
   * side of the upsert fired.
   */
  async deliverCollapsed(notif: NotificationCreate): Promise<Notification> {
    const { row, created } = await this.notifRepo.upsertCollapsed(notif);
    if (created) {
      this.emit?.('created', row);
      this.emitToRecipient('notification:created', row);
    } else {
      this.emit?.('patched', row);
      this.emitToRecipient('notification:patched', row);
    }
    return row;
  }

  /**
   * Custom method: Mark every unread notification for the calling user as read.
   */
  async markAllRead(_data: unknown, params?: NotificationsParams): Promise<{ updated: number }> {
    const userId = this.getRequestingUserId(params);
    if (!userId) {
      throw new Error('Authentication required');
    }
    const count = await this.notifRepo.markAllRead(userId);
    // Push a synthetic event so connected tabs can recompute the unread count
    // without re-fetching every row.
    if (this.app.io && count > 0) {
      this.app.io.to(userRoomName(userId)).emit('notification:all_read', {
        recipient_user_id: userId,
        updated: count,
        read_at: new Date().toISOString(),
      });
    }
    return { updated: count };
  }

  /**
   * Custom method: Unread count for the calling user. Used by the badge.
   */
  async unreadCount(_data: unknown, params?: NotificationsParams): Promise<{ count: number }> {
    const userId = this.getRequestingUserId(params);
    if (!userId) {
      return { count: 0 };
    }
    const count = await this.notifRepo.countUnread(userId);
    return { count };
  }

  /**
   * Custom method: Admin broadcast. Fans out one row per active user.
   *
   * Authorization: admin/superadmin only — enforced by a service-level hook
   * in register-services.ts so this method assumes the caller is allowed.
   */
  async broadcast(
    data: NotificationBroadcastInput,
    params?: NotificationsParams
  ): Promise<{ broadcast_group_id: string; recipient_count: number }> {
    const author = this.getRequestingUserId(params);
    if (!author) {
      throw new Error('Authentication required');
    }
    if (!data.title || data.title.length === 0) {
      throw new Error('title is required');
    }

    const groupId = data.broadcast_group_id ?? generateId();
    const rows = await this.notifRepo.broadcast({
      title: data.title,
      preview: data.preview,
      banner: data.banner ?? false,
      expires_at: data.expires_at ?? undefined,
      broadcast_group_id: groupId,
      source_user_id: author,
    });

    if (this.app.io) {
      for (const row of rows) {
        this.app.io.to(userRoomName(row.recipient_user_id)).emit('notification:created', row);
      }
    }

    return { broadcast_group_id: groupId, recipient_count: rows.length };
  }

  /**
   * Custom method: Expire a broadcast immediately. Sets `expires_at = now` on
   * every row in the group and emits a patched event per recipient.
   */
  async expireBroadcast(
    data: { broadcast_group_id: string },
    _params?: NotificationsParams
  ): Promise<{ updated: number }> {
    const updated = await this.notifRepo.expireBroadcastGroup(data.broadcast_group_id);
    // Refresh the affected rows so the client can drop the banner.
    if (this.app.io) {
      const rows = await this.notifRepo.findByBroadcastGroup(data.broadcast_group_id);
      for (const row of rows) {
        this.app.io.to(userRoomName(row.recipient_user_id)).emit('notification:patched', row);
      }
    }
    return { updated };
  }

  /**
   * Custom method: List broadcast groups for the admin UI.
   */
  async listBroadcasts(
    _data: unknown,
    _params?: NotificationsParams
  ): Promise<
    Array<{
      broadcast_group_id: string;
      title: string;
      preview?: string;
      banner: boolean;
      created_at: string;
      expires_at?: string;
      recipient_count: number;
      source_user_id?: string;
    }>
  > {
    const groups = await this.notifRepo.listBroadcastGroups();
    return groups.map((g) => ({
      broadcast_group_id: g.broadcast_group_id,
      title: g.title,
      preview: g.preview,
      banner: g.banner,
      created_at: g.created_at.toISOString(),
      expires_at: g.expires_at?.toISOString(),
      recipient_count: g.recipient_count,
      source_user_id: g.source_user_id,
    }));
  }

  /**
   * Producer-callable cleanup: drop every notification whose source_session_id
   * matches `sessionId`. Emits a removed event per row.
   */
  async cleanupForSession(sessionId: string): Promise<number> {
    const ids = await this.notifRepo.deleteBySourceSession(sessionId);
    if (!ids || ids.length === 0) return 0;
    if (this.app.io) {
      // We don't have recipient info anymore; fan out a synthetic event on the
      // authenticated channel so every tab recomputes.
      this.app.io.emit('notification:bulk_removed', { source_session_id: sessionId, ids });
    }
    return ids.length;
  }

  async cleanupForWorktree(worktreeId: string): Promise<number> {
    const ids = await this.notifRepo.deleteBySourceWorktree(worktreeId);
    if (!ids || ids.length === 0) return 0;
    if (this.app.io) {
      this.app.io.emit('notification:bulk_removed', { source_worktree_id: worktreeId, ids });
    }
    return ids.length;
  }

  /**
   * Retention sweep — deletes read notifs older than `olderThanMs` ms.
   * Called by the nightly cron in register-services.
   */
  async retentionSweep(olderThanMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    return this.notifRepo.deleteOldRead(cutoff);
  }

  /** Direct repository access for producer code that wants finer control. */
  get notificationsRepository(): NotificationsRepository {
    return this.notifRepo;
  }

  /** Emit on the recipient's per-user socket room. No-op if app.io is absent. */
  private emitToRecipient(event: string, row: Notification): void {
    if (this.app.io && row.recipient_user_id) {
      this.app.io.to(userRoomName(row.recipient_user_id)).emit(event, row);
    }
  }
}

/** Factory function matching the other services in this directory. */
export function createNotificationsService(db: Database, app: Application): NotificationsService {
  return new NotificationsService(db, app);
}
