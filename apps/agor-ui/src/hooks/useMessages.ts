/**
 * React hook for fetching and subscribing to messages for a session
 */

import type { AgorClient } from '@agor/core/api';
import { PAGINATION } from '@agor/core/config/browser';
import type { Message, SessionID } from '@agor/core/types';
import { useCallback, useEffect, useState } from 'react';

interface UseMessagesResult {
  messages: Message[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch and subscribe to messages for a specific session
 *
 * @param client - Agor client instance
 * @param sessionId - Session ID to fetch messages for
 * @returns Messages array, loading state, error, and refetch function
 */
export function useMessages(
  client: AgorClient | null,
  sessionId: SessionID | null
): UseMessagesResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch messages for session
  const fetchMessages = useCallback(async () => {
    if (!client || !sessionId) {
      setMessages([]);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const result = await client.service('messages').find({
        query: {
          session_id: sessionId,
          $limit: PAGINATION.DEFAULT_LIMIT,
          $sort: {
            index: 1, // Sort by index ascending
          },
        },
      });

      const messagesList = Array.isArray(result) ? result : result.data;
      setMessages(messagesList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch messages');
    } finally {
      setLoading(false);
    }
  }, [client, sessionId]);

  // Subscribe to real-time message updates
  useEffect(() => {
    if (!client || !sessionId) return;

    // Initial fetch
    fetchMessages();

    // Subscribe to message events for this session
    const messagesService = client.service('messages');

    const handleMessageCreated = (message: Message) => {
      // Only add if it belongs to this session
      if (message.session_id === sessionId) {
        // OPTIMIZED: Removed flushSync - React 18 automatic batching is efficient
        // and doesn't require forcing synchronous renders. Message ordering is
        // guaranteed by the server index field, not client-side ordering.
        setMessages((prev) => {
          // Check if message already exists (avoid duplicates)
          if (prev.some((m) => m.message_id === message.message_id)) {
            return prev;
          }
          // Insert in correct position based on index
          const newMessages = [...prev, message];
          // CRITICAL: Create NEW array for sort to trigger React re-renders
          // .sort() mutates in place, which breaks useMemo dependencies
          return [...newMessages].sort((a, b) => a.index - b.index);
        });
      }
    };

    const handleMessagePatched = (message: Message) => {
      if (message.session_id === sessionId) {
        setMessages((prev) => prev.map((m) => (m.message_id === message.message_id ? message : m)));
      }
    };

    const handleMessageRemoved = (message: Message) => {
      if (message.session_id === sessionId) {
        setMessages((prev) => prev.filter((m) => m.message_id !== message.message_id));
      }
    };

    messagesService.on('created', handleMessageCreated);
    messagesService.on('patched', handleMessagePatched);
    messagesService.on('updated', handleMessagePatched);
    messagesService.on('removed', handleMessageRemoved);

    // Cleanup listeners
    return () => {
      messagesService.removeListener('created', handleMessageCreated);
      messagesService.removeListener('patched', handleMessagePatched);
      messagesService.removeListener('updated', handleMessagePatched);
      messagesService.removeListener('removed', handleMessageRemoved);
    };
  }, [client, sessionId, fetchMessages]);

  return {
    messages,
    loading,
    error,
    refetch: fetchMessages,
  };
}
