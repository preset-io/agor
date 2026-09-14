/**
 * React hook for authorized multiplayer presence and cursor state.
 *
 * State is keyed by the server-generated connection `presenceId`, then folded
 * to one facepile/cursor entry per user. This is what makes leave/disconnect
 * safe with multiple tabs or devices: retiring one connection never erases a
 * still-active sibling connection.
 */

import {
  type ActiveUser,
  type AgorClient,
  type BoardID,
  type CursorLeftEvent,
  type CursorMovedEvent,
  PRESENCE_SOCKET_EVENTS,
  type PresenceLeftEvent,
  type PresenceUpdatedEvent,
  type User,
} from '@agor-live/client';
import { useEffect, useMemo, useState } from 'react';
import { PRESENCE_CONFIG } from '../config/presence';

interface UsePresenceOptions {
  client: AgorClient | null;
  boardId: BoardID | null;
  users: User[];
  enabled?: boolean;
  globalPresence?: boolean;
  /** Coalesce unchanged facepile updates inside this window. */
  presenceMinUpdateIntervalMs?: number;
}

interface UsePresenceResult {
  activeUsers: ActiveUser[];
  remoteCursors: Map<string, { x: number; y: number; user: User; timestamp: number }>;
}

interface CursorInstance {
  userId: string;
  x: number;
  y: number;
  timestamp: number;
}

interface PresenceInstance {
  userId: string;
  timestamp: number;
  boardId?: BoardID;
  boardTimestamp?: number;
  x?: number;
  y?: number;
}

function instanceKey(event: { userId: string; presenceId?: string }): string {
  // Compatibility for the short rolling window where an already-loaded old
  // server can still emit the pre-instance event shape. It remains tenant/room
  // scoped; only multi-tab precision is unavailable until reconnect.
  return event.presenceId || `legacy:${event.userId}`;
}

function eventTimestamp(value: unknown): number {
  const now = Date.now();
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(value, now + 5_000) : now;
}

function rememberBounded<T extends { timestamp: number }>(
  map: Map<string, T>,
  key: string,
  value: T,
  limit: number
): void {
  if (!map.has(key) && map.size >= limit) {
    let oldestKey: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const [candidateKey, candidate] of map) {
      if (candidate.timestamp < oldestTimestamp) {
        oldestKey = candidateKey;
        oldestTimestamp = candidate.timestamp;
      }
    }
    if (oldestKey) map.delete(oldestKey);
  }
  map.set(key, value);
}

export function usePresence(options: UsePresenceOptions): UsePresenceResult {
  const {
    client,
    boardId,
    users,
    enabled = true,
    globalPresence = false,
    presenceMinUpdateIntervalMs = 0,
  } = options;

  const [cursorMap, setCursorMap] = useState<Map<string, CursorInstance>>(new Map());
  const [presenceMap, setPresenceMap] = useState<Map<string, PresenceInstance>>(new Map());

  useEffect(() => {
    if (!enabled || !client?.io || (!globalPresence && !boardId)) {
      setCursorMap(new Map());
      setPresenceMap(new Map());
      return;
    }

    const handleCursorMoved = (event: CursorMovedEvent) => {
      if (
        !event ||
        typeof event.userId !== 'string' ||
        !Number.isFinite(event.x) ||
        !Number.isFinite(event.y)
      ) {
        return;
      }
      const timestamp = eventTimestamp(event.timestamp);
      const key = instanceKey(event);

      if (boardId && event.boardId === boardId) {
        const updateData: CursorInstance = {
          userId: event.userId,
          x: event.x,
          y: event.y,
          timestamp,
        };
        setCursorMap((previous) => {
          const existing = previous.get(key);
          if (existing && timestamp < existing.timestamp) return previous;
          if (
            existing &&
            existing.x === updateData.x &&
            existing.y === updateData.y &&
            existing.timestamp === updateData.timestamp
          ) {
            return previous;
          }
          const next = new Map(previous);
          rememberBounded(next, key, updateData, PRESENCE_CONFIG.MAX_TRACKED_CURSOR_INSTANCES);
          return next;
        });
      }

      if (!globalPresence && event.boardId === boardId) {
        const updateData: PresenceInstance = {
          userId: event.userId,
          boardId: event.boardId,
          boardTimestamp: timestamp,
          x: event.x,
          y: event.y,
          timestamp,
        };
        setPresenceMap((previous) => {
          const existing = previous.get(key);
          if (existing && timestamp < existing.timestamp) return previous;
          if (
            existing &&
            existing.boardId === updateData.boardId &&
            presenceMinUpdateIntervalMs > 0 &&
            timestamp - existing.timestamp < presenceMinUpdateIntervalMs
          ) {
            return previous;
          }
          const next = new Map(previous);
          rememberBounded(next, key, updateData, PRESENCE_CONFIG.MAX_TRACKED_PRESENCE_INSTANCES);
          return next;
        });
      }
    };

    const handlePresenceUpdated = (event: PresenceUpdatedEvent) => {
      if (!globalPresence || !event || typeof event.userId !== 'string') return;
      const timestamp = eventTimestamp(event.timestamp);
      const key = instanceKey(event);
      setPresenceMap((previous) => {
        const existing = previous.get(key);
        if (existing && timestamp < existing.timestamp) return previous;

        const unchangedBoard = !event.boardId || existing?.boardId === event.boardId;
        if (
          existing &&
          unchangedBoard &&
          presenceMinUpdateIntervalMs > 0 &&
          timestamp - existing.timestamp < presenceMinUpdateIntervalMs
        ) {
          return previous;
        }

        const update: PresenceInstance = {
          ...existing,
          userId: event.userId,
          timestamp,
          ...(event.boardId ? { boardId: event.boardId, boardTimestamp: timestamp } : {}),
        };
        const next = new Map(previous);
        rememberBounded(next, key, update, PRESENCE_CONFIG.MAX_TRACKED_PRESENCE_INSTANCES);
        return next;
      });
    };

    const handlePresenceLeft = (event: PresenceLeftEvent) => {
      if (!globalPresence || !event || typeof event.userId !== 'string') return;
      const timestamp = eventTimestamp(event.timestamp);
      const key = instanceKey(event);
      setPresenceMap((previous) => {
        const existing = previous.get(key);
        if (!existing) return previous;
        if (!event.boardId) {
          if (timestamp < existing.timestamp) return previous;
          const next = new Map(previous);
          next.delete(key);
          return next;
        }
        if (
          existing.boardId !== event.boardId ||
          (existing.boardTimestamp !== undefined && timestamp < existing.boardTimestamp)
        ) {
          return previous;
        }
        const next = new Map(previous);
        next.set(key, {
          userId: existing.userId,
          timestamp: Math.max(existing.timestamp, timestamp),
        });
        return next;
      });
    };

    const handleCursorLeft = (event: CursorLeftEvent) => {
      if (!event || event.boardId !== boardId || typeof event.userId !== 'string') return;
      const key = instanceKey(event);
      const timestamp = eventTimestamp(event.timestamp);
      setCursorMap((previous) => {
        const existing = previous.get(key);
        if (!existing || timestamp < existing.timestamp) return previous;
        const next = new Map(previous);
        next.delete(key);
        return next;
      });
      if (!globalPresence) {
        setPresenceMap((previous) => {
          const existing = previous.get(key);
          if (!existing || timestamp < existing.timestamp) return previous;
          const next = new Map(previous);
          next.delete(key);
          return next;
        });
      }
    };

    const clearTransportState = () => {
      setCursorMap(new Map());
      setPresenceMap(new Map());
    };

    client.io.on(PRESENCE_SOCKET_EVENTS.cursorMoved, handleCursorMoved);
    client.io.on(PRESENCE_SOCKET_EVENTS.updated, handlePresenceUpdated);
    client.io.on(PRESENCE_SOCKET_EVENTS.left, handlePresenceLeft);
    client.io.on(PRESENCE_SOCKET_EVENTS.cursorLeft, handleCursorLeft);
    client.io.on('disconnect', clearTransportState);

    const cursorCleanupInterval = setInterval(() => {
      setCursorMap((previous) => {
        const now = Date.now();
        if (
          ![...previous.values()].some(
            (cursor) => now - cursor.timestamp >= PRESENCE_CONFIG.CURSOR_HIDE_AFTER_MS
          )
        ) {
          return previous;
        }
        const next = new Map(previous);
        for (const [key, cursor] of previous) {
          if (now - cursor.timestamp >= PRESENCE_CONFIG.CURSOR_HIDE_AFTER_MS) next.delete(key);
        }
        return next;
      });
    }, PRESENCE_CONFIG.CURSOR_HIDE_AFTER_MS);

    const presenceCleanupInterval = setInterval(() => {
      setPresenceMap((previous) => {
        const now = Date.now();
        if (
          ![...previous.values()].some(
            (entry) => now - entry.timestamp > PRESENCE_CONFIG.ACTIVE_USER_TIMEOUT_MS
          )
        ) {
          return previous;
        }
        const next = new Map(previous);
        for (const [key, entry] of previous) {
          if (now - entry.timestamp > PRESENCE_CONFIG.ACTIVE_USER_TIMEOUT_MS) next.delete(key);
        }
        return next;
      });
    }, 30_000);

    return () => {
      client.io.off(PRESENCE_SOCKET_EVENTS.cursorMoved, handleCursorMoved);
      client.io.off(PRESENCE_SOCKET_EVENTS.updated, handlePresenceUpdated);
      client.io.off(PRESENCE_SOCKET_EVENTS.left, handlePresenceLeft);
      client.io.off(PRESENCE_SOCKET_EVENTS.cursorLeft, handleCursorLeft);
      client.io.off('disconnect', clearTransportState);
      clearInterval(cursorCleanupInterval);
      clearInterval(presenceCleanupInterval);
    };
  }, [client, boardId, enabled, globalPresence, presenceMinUpdateIntervalMs]);

  return useMemo(() => {
    const userById = new Map<string, User>(users.map((user) => [user.user_id, user]));
    const activeByUser = new Map<
      string,
      { lastSeen: number; boardId?: BoardID; boardTimestamp?: number; x?: number; y?: number }
    >();
    for (const instance of presenceMap.values()) {
      const existing = activeByUser.get(instance.userId);
      const next = existing ?? { lastSeen: instance.timestamp };
      next.lastSeen = Math.max(next.lastSeen, instance.timestamp);
      if (
        instance.boardId &&
        (next.boardTimestamp === undefined ||
          (instance.boardTimestamp ?? instance.timestamp) >= next.boardTimestamp)
      ) {
        next.boardId = instance.boardId;
        next.boardTimestamp = instance.boardTimestamp ?? instance.timestamp;
        next.x = instance.x;
        next.y = instance.y;
      }
      activeByUser.set(instance.userId, next);
    }

    const activeUsers: ActiveUser[] = [];
    for (const [userId, presence] of activeByUser) {
      const user = userById.get(userId);
      if (!user) continue;
      activeUsers.push({
        user,
        lastSeen: presence.lastSeen,
        ...(presence.boardId ? { boardId: presence.boardId } : {}),
        ...(typeof presence.x === 'number' && typeof presence.y === 'number'
          ? { cursor: { x: presence.x, y: presence.y } }
          : {}),
      });
    }

    const latestCursorByUser = new Map<string, CursorInstance>();
    for (const cursor of cursorMap.values()) {
      const existing = latestCursorByUser.get(cursor.userId);
      if (!existing || cursor.timestamp >= existing.timestamp) {
        latestCursorByUser.set(cursor.userId, cursor);
      }
    }
    const remoteCursors = new Map<
      string,
      { x: number; y: number; user: User; timestamp: number }
    >();
    for (const [userId, cursor] of latestCursorByUser) {
      const user = userById.get(userId);
      if (!user) continue;
      remoteCursors.set(userId, {
        x: cursor.x,
        y: cursor.y,
        user,
        timestamp: cursor.timestamp,
      });
    }

    return { activeUsers, remoteCursors };
  }, [cursorMap, presenceMap, users]);
}
