// @ts-nocheck - WebSocket payload types are dynamic; the runtime values are typed via @agor-live/client.
/**
 * useNotifications — durable inbox state for the current user.
 *
 * - Initial fetch on mount via `client.service('notifications').find()`.
 * - Subscribes to `notification:created` / `notification:patched` /
 *   `notification:removed` on the user's per-user socket room.
 * - Subscribes to `notification:all_read` for the cross-tab mark-all-read sync.
 * - Subscribes to `notification:bulk_removed` for archive sweeps.
 * - Exposes `markRead`, `dismiss`, `markAllRead`, `dismissBroadcast`.
 * - Derives `unreadCount`, `activeBanner` for the AppHeader.
 *
 * Design ref: `docs/notification-system-design.md` §8.
 */

import type { AgorClient, Notification } from '@agor-live/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const PANEL_FETCH_LIMIT = 50;

interface UseNotificationsResult {
  notifications: Notification[];
  unreadCount: number;
  activeBanner: Notification | null;
  loading: boolean;
  markRead: (notificationId: string) => Promise<void>;
  dismiss: (notificationId: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismissBroadcast: (broadcastGroupId: string) => Promise<void>;
  refetch: () => Promise<void>;
}

export function useNotifications(
  client: AgorClient | null,
  userId: string | undefined
): UseNotificationsResult {
  const [byId, setById] = useState<Map<string, Notification>>(new Map());
  const [loading, setLoading] = useState(false);

  // We keep a ref so socket handlers don't capture stale state.
  const byIdRef = useRef<Map<string, Notification>>(new Map());
  byIdRef.current = byId;

  const setRow = useCallback((row: Notification) => {
    setById((prev) => {
      const next = new Map(prev);
      next.set(row.notification_id, row);
      return next;
    });
  }, []);

  const removeRow = useCallback((id: string) => {
    setById((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const refetch = useCallback(async () => {
    if (!client || !userId) return;
    setLoading(true);
    try {
      const result = await client.service('notifications').find({
        query: {
          $limit: PANEL_FETCH_LIMIT,
          $sort: { created_at: -1 },
        },
      });
      const rows: Notification[] = Array.isArray(result) ? result : (result?.data ?? []);
      const next = new Map<string, Notification>();
      for (const row of rows) {
        next.set(row.notification_id, row);
      }
      setById(next);
    } catch (err) {
      console.warn('[useNotifications] initial fetch failed:', err);
    } finally {
      setLoading(false);
    }
  }, [client, userId]);

  // Initial fetch + refetch on user change.
  useEffect(() => {
    if (!client || !userId) {
      setById(new Map());
      return;
    }
    refetch();
  }, [client, userId, refetch]);

  // Socket subscription.
  useEffect(() => {
    if (!client || !userId) return;
    const io = (client as { io?: SocketIOClientLike }).io;
    if (!io) return;

    const handleCreated = (row: Notification) => {
      if (!row || row.recipient_user_id !== userId) return;
      setRow(row);
    };
    const handlePatched = (row: Notification) => {
      if (!row || row.recipient_user_id !== userId) return;
      setRow(row);
    };
    const handleRemoved = (row: Notification) => {
      if (!row) return;
      removeRow(row.notification_id);
    };
    const handleAllRead = (payload: { recipient_user_id: string; read_at: string }) => {
      if (payload?.recipient_user_id !== userId) return;
      setById((prev) => {
        const next = new Map<string, Notification>();
        const ts = new Date(payload.read_at);
        for (const [id, row] of prev) {
          next.set(id, row.read_at ? row : { ...row, read_at: ts });
        }
        return next;
      });
    };
    const handleBulkRemoved = (payload: { ids?: string[] }) => {
      if (!Array.isArray(payload?.ids) || payload.ids.length === 0) return;
      setById((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const id of payload.ids!) {
          if (next.delete(id)) changed = true;
        }
        return changed ? next : prev;
      });
    };

    io.on('notification:created', handleCreated);
    io.on('notification:patched', handlePatched);
    io.on('notification:removed', handleRemoved);
    io.on('notification:all_read', handleAllRead);
    io.on('notification:bulk_removed', handleBulkRemoved);

    return () => {
      io.off('notification:created', handleCreated);
      io.off('notification:patched', handlePatched);
      io.off('notification:removed', handleRemoved);
      io.off('notification:all_read', handleAllRead);
      io.off('notification:bulk_removed', handleBulkRemoved);
    };
  }, [client, userId, setRow, removeRow]);

  // Refetch on reconnect — handles laptop-sleep silent drops (§8.3).
  useEffect(() => {
    if (!client || !userId) return;
    const io = (client as { io?: SocketIOClientLike }).io;
    if (!io) return;

    const handleConnect = () => {
      refetch().catch(() => {});
    };
    io.on('reconnect', handleConnect);
    return () => {
      io.off('reconnect', handleConnect);
    };
  }, [client, userId, refetch]);

  const notifications = useMemo(() => {
    return Array.from(byId.values())
      .filter((n) => {
        // Drop expired admin announcements client-side.
        if (n.expires_at && new Date(n.expires_at).getTime() < Date.now()) return false;
        return true;
      })
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
  }, [byId]);

  const unreadCount = useMemo(() => {
    let count = 0;
    for (const n of notifications) {
      if (!n.read_at) count += 1;
    }
    return count;
  }, [notifications]);

  // Active banner: most-recent un-expired global_admin row with data.banner === true
  const activeBanner = useMemo(() => {
    for (const n of notifications) {
      if (n.type !== 'global_admin') continue;
      if (!n.data?.banner) continue;
      return n;
    }
    return null;
  }, [notifications]);

  const markRead = useCallback(
    async (notificationId: string) => {
      if (!client) return;
      const row = byIdRef.current.get(notificationId);
      if (!row || row.read_at) return;
      try {
        const updated = await client
          .service('notifications')
          .patch(notificationId, { read_at: new Date().toISOString() });
        setRow(updated as Notification);
      } catch (err) {
        console.warn('[useNotifications] markRead failed:', err);
      }
    },
    [client, setRow]
  );

  const dismiss = useCallback(
    async (notificationId: string) => {
      if (!client) return;
      // Optimistic remove — server emits removed to other tabs.
      removeRow(notificationId);
      try {
        await client.service('notifications').remove(notificationId);
      } catch (err) {
        console.warn('[useNotifications] dismiss failed:', err);
        // Refetch to re-sync if the server rejected.
        refetch().catch(() => {});
      }
    },
    [client, removeRow, refetch]
  );

  const markAllRead = useCallback(async () => {
    if (!client || !userId) return;
    try {
      await client.service('notifications').markAllRead({});
      // Optimistic: stamp read_at on everything; server will broadcast the
      // canonical timestamp via `notification:all_read` shortly.
      const now = new Date();
      setById((prev) => {
        const next = new Map<string, Notification>();
        for (const [id, row] of prev) {
          next.set(id, row.read_at ? row : { ...row, read_at: now });
        }
        return next;
      });
    } catch (err) {
      console.warn('[useNotifications] markAllRead failed:', err);
    }
  }, [client, userId]);

  const dismissBroadcast = useCallback(
    async (broadcastGroupId: string) => {
      // Find local row in the broadcast and dismiss it (per-user delete);
      // the server already routes other users' rows separately.
      const row = notifications.find(
        (n) => n.type === 'global_admin' && n.data?.broadcast_group_id === broadcastGroupId
      );
      if (!row) return;
      await dismiss(row.notification_id);
    },
    [notifications, dismiss]
  );

  return {
    notifications,
    unreadCount,
    activeBanner,
    loading,
    markRead,
    dismiss,
    markAllRead,
    dismissBroadcast,
    refetch,
  };
}

interface SocketIOClientLike {
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string, handler: (...args: unknown[]) => void) => void;
}
