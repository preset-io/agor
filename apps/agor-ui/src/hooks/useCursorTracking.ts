/**
 * React hook for tracking and emitting cursor position on a board
 *
 * Throttles cursor movement events and broadcasts to other users via WebSocket
 */

import type { AgorClient } from '@agor/core/api';
import type { BoardID, CursorMoveEvent } from '@agor/core/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactFlowInstance } from 'reactflow';
import { PRESENCE_CONFIG } from '../config/presence';

interface UseCursorTrackingOptions {
  client: AgorClient | null;
  boardId: BoardID | null;
  reactFlowInstance: ReactFlowInstance | null;
  enabled?: boolean;
}

/**
 * Track cursor position and emit to WebSocket
 *
 * @param options - Client, boardId, reactFlowInstance, and enabled flag
 * @returns Callback to manually emit cursor position (rarely needed)
 */
export function useCursorTracking(options: UseCursorTrackingOptions) {
  const { client, boardId, reactFlowInstance, enabled = true } = options;

  // Pause cursor tracking when tab is hidden to save CPU
  const [isTabVisible, setIsTabVisible] = useState(
    typeof document !== 'undefined' ? !document.hidden : true
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const handleVisibilityChange = () => setIsTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Track visibility via ref so emitCursorPosition can check without re-creating the callback
  const isTabVisibleRef = useRef(isTabVisible);
  isTabVisibleRef.current = isTabVisible;

  // Track last emit timestamp for throttling
  const lastEmitRef = useRef<number>(0);
  const throttleTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Track the LATEST position (not the one from closure)
  const latestPositionRef = useRef<{ x: number; y: number } | null>(null);

  // Emit cursor position to server
  const emitCursorPosition = useCallback(
    (x: number, y: number) => {
      if (!client?.io || !boardId || !enabled || !isTabVisibleRef.current) return;

      // Always update latest position
      latestPositionRef.current = { x, y };

      const now = Date.now();
      const timeSinceLastEmit = now - lastEmitRef.current;

      // Throttle: Only emit if enough time has passed
      if (timeSinceLastEmit < PRESENCE_CONFIG.CURSOR_EMIT_THROTTLE_MS) {
        // Schedule a delayed emit if not already scheduled
        if (!throttleTimeoutRef.current) {
          throttleTimeoutRef.current = setTimeout(() => {
            throttleTimeoutRef.current = null;

            // Emit the LATEST position, not the one from closure!
            if (latestPositionRef.current) {
              const latest = latestPositionRef.current;
              const event: CursorMoveEvent = {
                boardId,
                x: latest.x,
                y: latest.y,
                timestamp: Date.now(),
              };
              client.io.emit('cursor-move', event);
              lastEmitRef.current = Date.now();
            }
          }, PRESENCE_CONFIG.CURSOR_EMIT_THROTTLE_MS - timeSinceLastEmit);
        }
        return;
      }

      // Emit cursor-move event immediately
      const event: CursorMoveEvent = {
        boardId,
        x,
        y,
        timestamp: now,
      };

      client.io.emit('cursor-move', event);
      lastEmitRef.current = now;
    },
    [client, boardId, enabled]
  );

  useEffect(() => {
    if (!enabled || !isTabVisible || !client?.io || !boardId || !reactFlowInstance) return;

    // Handle mouse move on React Flow canvas
    const handleMouseMove = (event: MouseEvent) => {
      // Convert screen coordinates to flow coordinates
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      emitCursorPosition(position.x, position.y);
    };

    // Emit cursor-leave when component unmounts or board changes
    const handleCursorLeave = () => {
      if (client?.io && boardId) {
        client.io.emit('cursor-leave', { boardId });
      }
    };

    // Add mouse move listener to window (captures all movement)
    window.addEventListener('mousemove', handleMouseMove);

    // Cleanup
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      handleCursorLeave();

      // Clear any pending throttle timeout
      if (throttleTimeoutRef.current) {
        clearTimeout(throttleTimeoutRef.current);
        throttleTimeoutRef.current = null;
      }
    };
  }, [client, boardId, reactFlowInstance, enabled, isTabVisible, emitCursorPosition]);

  return { emitCursorPosition };
}
