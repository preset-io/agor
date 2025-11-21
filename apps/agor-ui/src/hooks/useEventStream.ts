/**
 * React hook for capturing and displaying WebSocket events for debugging
 *
 * Only listens when enabled, captures all events from the socket
 */

import type { AgorClient } from '@agor/core/api';
import { useCallback, useEffect, useState } from 'react';

export interface SocketEvent {
  id: string;
  timestamp: Date;
  type: string;
  eventName: string;
  data: unknown;
}

interface UseEventStreamOptions {
  client: AgorClient | null;
  enabled: boolean; // Only listen when drawer is open
  maxEvents?: number; // Maximum number of events to keep in memory
}

interface UseEventStreamResult {
  events: SocketEvent[];
  clearEvents: () => void;
}

/**
 * Capture all WebSocket events for debugging purposes
 *
 * @param options - Client, enabled flag, and max events
 * @returns Events array and clear function
 */
export function useEventStream(options: UseEventStreamOptions): UseEventStreamResult {
  const { client, enabled, maxEvents = 500 } = options;
  const [events, setEvents] = useState<SocketEvent[]>([]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  useEffect(() => {
    if (!enabled || !client?.io) {
      // Clear events when disabled
      setEvents([]);
      return;
    }

    // Capture all events using Socket.io's onAny listener
    const handleAnyEvent = (eventName: string, ...args: unknown[]) => {
      // Skip generic FeathersJS events that are just duplicates
      // (FeathersJS emits both 'created' and 'messages created' for the same event)
      if (
        eventName === 'created' ||
        eventName === 'patched' ||
        eventName === 'updated' ||
        eventName === 'removed'
      ) {
        return; // Skip these generic events, we'll catch the specific ones
      }

      // Determine event type based on naming convention
      let type = 'other';
      if (
        eventName === 'cursor-move' ||
        eventName === 'cursor-leave' ||
        eventName === 'cursor-moved' ||
        eventName === 'cursor-left'
      ) {
        type = 'cursor';
      } else if (eventName.includes('message') || eventName === 'thinking:chunk') {
        type = 'message';

        // Check if this is a tool-related message
        const messageData = args.length === 1 ? args[0] : undefined;
        if (messageData && typeof messageData === 'object' && 'content' in messageData) {
          const content = (messageData as { content?: unknown }).content;
          // Check if content contains tool_use or tool_result
          if (Array.isArray(content)) {
            const hasToolUse = content.some((block: unknown) => {
              if (typeof block === 'object' && block !== null && 'type' in block) {
                const blockType = (block as { type?: string }).type;
                return blockType === 'tool_use' || blockType === 'tool_result';
              }
              return false;
            });
            if (hasToolUse) {
              type = 'tool';
            }
          }
        }
      } else if (
        eventName.includes('created') ||
        eventName.includes('patched') ||
        eventName.includes('updated') ||
        eventName.includes('removed')
      ) {
        type = 'crud';
      } else if (
        eventName === 'connect' ||
        eventName === 'disconnect' ||
        eventName.includes('connect')
      ) {
        type = 'connection';
      }

      // Extract data payload (handle empty args)
      const data = args.length === 0 ? undefined : args.length === 1 ? args[0] : args;

      const event: SocketEvent = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date(),
        type,
        eventName,
        data,
      };

      setEvents((prev) => {
        const newEvents = [event, ...prev];
        // Keep only the most recent maxEvents
        return newEvents.slice(0, maxEvents);
      });
    };

    // Listen to all events
    client.io.onAny(handleAnyEvent);

    // Cleanup
    return () => {
      client.io.offAny(handleAnyEvent);
    };
  }, [client, enabled, maxEvents]);

  return {
    events,
    clearEvents,
  };
}
