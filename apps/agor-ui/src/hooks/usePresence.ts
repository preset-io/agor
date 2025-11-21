/**
 * React hook for tracking active users and their cursor positions
 *
 * Maintains two separate maps with different timeouts:
 * - presenceMap: 5 minute timeout for facepile (shows users even when multitasking)
 * - cursorMap: 5 second timeout for cursor rendering (hides stale cursors quickly)
 *
 * Subscribes to cursor-moved events and maintains active user state for Facepile
 */

import type { AgorClient } from '@agor/core/api';
import type { ActiveUser, BoardID, CursorMovedEvent, User } from '@agor/core/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PRESENCE_CONFIG } from '../config/presence';

interface UsePresenceOptions {
  client: AgorClient | null;
  boardId: BoardID | null;
  users: User[]; // All users (for looking up user details by ID)
  enabled?: boolean;
}

interface UsePresenceResult {
  activeUsers: ActiveUser[];
  remoteCursors: Map<string, { x: number; y: number; user: User; timestamp: number }>;
}

/**
 * Track active users and remote cursor positions
 *
 * @param options - Client, boardId, users list, and enabled flag
 * @returns Active users for facepile and remote cursors for rendering
 */
export function usePresence(options: UsePresenceOptions): UsePresenceResult {
  const { client, boardId, users, enabled = true } = options;

  // Use ref for users to avoid triggering useMemo recalculation
  const usersRef = useRef(users);
  usersRef.current = users;

  // Separate maps for different timeouts:
  // - cursorMap: for rendering cursors (5 second timeout)
  // - presenceMap: for facepile (5 minute timeout)
  const [cursorMap, setCursorMap] = useState<
    Map<string, { x: number; y: number; timestamp: number }>
  >(new Map());

  const [presenceMap, setPresenceMap] = useState<
    Map<string, { x: number; y: number; timestamp: number }>
  >(new Map());

  useEffect(() => {
    if (!enabled || !client?.io || !boardId) {
      setCursorMap(new Map());
      setPresenceMap(new Map());
      return;
    }

    // Handle cursor-moved events
    const handleCursorMoved = (event: CursorMovedEvent) => {
      // Only track cursors for this board
      if (event.boardId !== boardId) return;

      const updateData = {
        x: event.x,
        y: event.y,
        timestamp: event.timestamp,
      };

      // Update cursor map (for rendering cursors)
      setCursorMap((prev) => {
        const next = new Map(prev);
        const existing = prev.get(event.userId);

        // Only update if this event is newer than the existing one (prevent out-of-order updates)
        if (existing && event.timestamp < existing.timestamp) {
          return prev; // Reject stale update
        }

        next.set(event.userId, updateData);
        return next;
      });

      // Update presence map (for facepile)
      setPresenceMap((prev) => {
        const next = new Map(prev);
        const existing = prev.get(event.userId);

        // Only update if this event is newer than the existing one
        if (existing && event.timestamp < existing.timestamp) {
          return prev; // Reject stale update
        }

        next.set(event.userId, updateData);
        return next;
      });
    };

    // Handle cursor-left events (user navigated away)
    const handleCursorLeft = (event: { userId: string; boardId: BoardID }) => {
      if (event.boardId !== boardId) return;

      setCursorMap((prev) => {
        const next = new Map(prev);
        next.delete(event.userId);
        return next;
      });

      setPresenceMap((prev) => {
        const next = new Map(prev);
        next.delete(event.userId);
        return next;
      });
    };

    // Subscribe to WebSocket events
    client.io.on('cursor-moved', handleCursorMoved);
    client.io.on('cursor-left', handleCursorLeft);

    // Cleanup stale cursors every 5 seconds (for cursor rendering)
    const cursorCleanupInterval = setInterval(() => {
      const now = Date.now();

      // Check if there are any stale cursors BEFORE calling setCursorMap
      setCursorMap((prev) => {
        let hasChanges = false;

        // First pass: check if any cursors are stale
        for (const [_userId, cursor] of prev.entries()) {
          if (now - cursor.timestamp > PRESENCE_CONFIG.CURSOR_HIDE_AFTER_MS) {
            hasChanges = true;
            break;
          }
        }

        if (!hasChanges) {
          return prev; // Return same reference to prevent state update
        }

        // Second pass: create new map with stale cursors removed
        const next = new Map(prev);
        for (const [userId, cursor] of prev.entries()) {
          if (now - cursor.timestamp > PRESENCE_CONFIG.CURSOR_HIDE_AFTER_MS) {
            next.delete(userId);
          }
        }

        return next;
      });
    }, 5000);

    // Cleanup stale presence every 30 seconds (for facepile)
    const presenceCleanupInterval = setInterval(() => {
      const now = Date.now();
      setPresenceMap((prev) => {
        const next = new Map(prev);
        let hasChanges = false;

        for (const [userId, cursor] of next.entries()) {
          if (now - cursor.timestamp > PRESENCE_CONFIG.ACTIVE_USER_TIMEOUT_MS) {
            next.delete(userId);
            hasChanges = true;
          }
        }

        return hasChanges ? next : prev;
      });
    }, 30000);

    // Cleanup
    return () => {
      client.io.off('cursor-moved', handleCursorMoved);
      client.io.off('cursor-left', handleCursorLeft);
      clearInterval(cursorCleanupInterval);
      clearInterval(presenceCleanupInterval);
    };
  }, [client, boardId, enabled]);

  // Derive active users and remote cursors from separate maps
  // - activeUsers from presenceMap (5 minute timeout for facepile)
  // - remoteCursors from cursorMap (5 second timeout for cursor rendering)
  // Memoized to prevent unnecessary re-renders
  const { activeUsers, remoteCursors } = useMemo(() => {
    const activeUsers: ActiveUser[] = [];
    const remoteCursors = new Map<
      string,
      { x: number; y: number; user: User; timestamp: number }
    >();

    // Build active users from presenceMap (longer timeout for facepile)
    for (const [userId, presence] of presenceMap.entries()) {
      const user = usersRef.current.find((u) => u.user_id === userId);
      if (!user) continue;

      activeUsers.push({
        user,
        lastSeen: presence.timestamp,
        cursor: {
          x: presence.x,
          y: presence.y,
        },
      });
    }

    // Build remote cursors from cursorMap (shorter timeout for cursor rendering)
    for (const [userId, cursor] of cursorMap.entries()) {
      const user = usersRef.current.find((u) => u.user_id === userId);
      if (!user) continue;

      remoteCursors.set(userId, {
        x: cursor.x,
        y: cursor.y,
        user,
        timestamp: cursor.timestamp,
      });
    }

    return {
      activeUsers,
      remoteCursors,
    };
  }, [presenceMap, cursorMap]);

  return {
    activeUsers,
    remoteCursors,
  };
}
