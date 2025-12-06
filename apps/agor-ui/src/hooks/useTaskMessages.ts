/**
 * React hook for fetching and subscribing to messages for a specific task
 *
 * This hook enables lazy-loading of messages per task, improving performance
 * for long conversations by only fetching messages when tasks are expanded.
 */

import type { AgorClient } from '@agor/core/api';
import { PAGINATION } from '@agor/core/config/browser';
import type { Message, TaskID } from '@agor/core/types';
import { useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

interface UseTaskMessagesResult {
  messages: Message[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Fetch and subscribe to messages for a specific task
 *
 * @param client - Agor client instance
 * @param taskId - Task ID to fetch messages for
 * @param enabled - Whether to fetch messages (for lazy loading)
 * @returns Messages array, loading state, error, and refetch function
 */
export function useTaskMessages(
  client: AgorClient | null,
  taskId: TaskID | null,
  enabled = true
): UseTaskMessagesResult {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch messages for task
  const fetchMessages = useCallback(async () => {
    if (!client || !taskId || !enabled) {
      setMessages([]);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const result = await client.service('messages').find({
        query: {
          task_id: taskId,
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
  }, [client, taskId, enabled]);

  // Subscribe to real-time message updates
  useEffect(() => {
    if (!client || !taskId) return;

    // If not enabled, clear messages and unsubscribe
    if (!enabled) {
      setMessages([]);
      return;
    }

    // Initial fetch
    fetchMessages();

    // Subscribe to message events for this task
    const messagesService = client.service('messages');

    const handleMessageCreated = (message: Message) => {
      // Only add if it belongs to this task
      if (message.task_id === taskId) {
        // Use flushSync to force immediate render (bypass React 18 automatic batching)
        flushSync(() => {
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
        });
      }
    };

    const handleMessagePatched = (message: Message) => {
      if (message.task_id === taskId) {
        setMessages((prev) => prev.map((m) => (m.message_id === message.message_id ? message : m)));
      }
    };

    const handleMessageRemoved = (message: Message) => {
      if (message.task_id === taskId) {
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
  }, [client, taskId, enabled, fetchMessages]);

  return {
    messages,
    loading,
    error,
    refetch: fetchMessages,
  };
}
