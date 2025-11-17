/**
 * React hook for real-time streaming messages
 *
 * Tracks messages that are currently being streamed from the daemon.
 * Buffers chunks by message_id and removes from buffer when streaming completes.
 * The complete message will then be available from the database via useMessages.
 */

import type { Message, MessageID, SessionID } from '@agor/core/types';
import { useEffect, useState } from 'react';
import type { useAgorClient } from './useAgorClient';

export interface StreamingMessage {
  message_id: MessageID;
  session_id: SessionID;
  task_id?: string;
  role: 'assistant';
  content: string; // Accumulated chunks
  thinkingContent?: string; // Accumulated thinking chunks (optional)
  timestamp: string;
  isStreaming: boolean;
  isThinking?: boolean; // True if currently streaming thinking
}

interface StreamingStartEvent {
  message_id: MessageID;
  session_id: SessionID;
  task_id?: string;
  role: 'assistant';
  timestamp: string;
}

interface StreamingChunkEvent {
  message_id: MessageID;
  session_id: SessionID;
  chunk: string;
}

interface StreamingEndEvent {
  message_id: MessageID;
  session_id: SessionID;
}

interface StreamingErrorEvent {
  message_id: MessageID;
  session_id: SessionID;
  error: string;
}

interface ThinkingStartEvent {
  message_id: MessageID;
  session_id: SessionID;
  task_id?: string;
  timestamp: string;
}

interface ThinkingChunkEvent {
  message_id: MessageID;
  session_id: SessionID;
  chunk: string;
}

interface ThinkingEndEvent {
  message_id: MessageID;
  session_id: SessionID;
}

/**
 * Hook to track real-time streaming messages for a session
 *
 * @param client - Agor client instance from useAgorClient
 * @param sessionId - Session ID to filter streaming messages (optional)
 * @param enabled - When false, skip socket subscriptions and clear streaming buffer
 * @returns Map of currently streaming messages keyed by message_id
 */
export function useStreamingMessages(
  client: ReturnType<typeof useAgorClient>['client'],
  sessionId?: SessionID,
  enabled = true
): Map<MessageID, StreamingMessage> {
  const [streamingMessages, setStreamingMessages] = useState<Map<MessageID, StreamingMessage>>(
    new Map()
  );

  useEffect(() => {
    if (!client || !enabled) {
      // Clear streaming buffer when disabled or no client
      setStreamingMessages(new Map());
      return;
    }

    const messagesService = client.service('messages');

    // Handler for streaming:start
    const handleStreamingStart = (data: StreamingStartEvent) => {
      // Only track messages for this session (if sessionId provided)
      if (sessionId && data.session_id !== sessionId) {
        return;
      }

      console.debug(`📡 Streaming start: ${data.message_id.substring(0, 8)}`);

      setStreamingMessages((prev) => {
        const newMap = new Map(prev);
        newMap.set(data.message_id, {
          message_id: data.message_id,
          session_id: data.session_id,
          task_id: data.task_id,
          role: data.role,
          content: '', // Start with empty content
          timestamp: data.timestamp,
          isStreaming: true,
        });
        return newMap;
      });
    };

    // Handler for streaming:chunk
    const handleStreamingChunk = (data: StreamingChunkEvent) => {
      // Only track messages for this session (if sessionId provided)
      if (sessionId && data.session_id !== sessionId) {
        return;
      }

      setStreamingMessages((prev) => {
        const message = prev.get(data.message_id);
        if (!message) {
          return prev;
        }

        const newMap = new Map(prev);
        newMap.set(data.message_id, {
          ...message,
          content: message.content + data.chunk,
        });
        return newMap;
      });
    };

    // Handler for streaming:end
    const handleStreamingEnd = (data: StreamingEndEvent) => {
      // Only track messages for this session (if sessionId provided)
      if (sessionId && data.session_id !== sessionId) {
        return;
      }

      console.debug(`📡 Streaming end: ${data.message_id.substring(0, 8)}`);

      // Mark as ended but DON'T remove yet - wait for DB 'created' event
      // This prevents jitter where streaming message disappears before DB message appears
      setStreamingMessages((prev) => {
        const message = prev.get(data.message_id);
        if (!message) return prev;

        const newMap = new Map(prev);
        newMap.set(data.message_id, {
          ...message,
          isStreaming: false, // Mark as complete but keep content visible
        });
        return newMap;
      });

      // Safety: Remove after 1 second if DB event doesn't arrive
      // This handles edge cases where 'created' event might be missed
      setTimeout(() => {
        setStreamingMessages((prev) => {
          const newMap = new Map(prev);
          newMap.delete(data.message_id);
          return newMap;
        });
      }, 1000);
    };

    // Handler for streaming:error
    const handleStreamingError = (data: StreamingErrorEvent) => {
      // Only track messages for this session (if sessionId provided)
      if (sessionId && data.session_id !== sessionId) {
        return;
      }

      // Mark as error but keep content
      setStreamingMessages((prev) => {
        const message = prev.get(data.message_id);
        if (!message) {
          return prev;
        }

        const newMap = new Map(prev);
        newMap.set(data.message_id, {
          ...message,
          content: `${message.content}\n\n[Error: ${data.error}]`,
        });
        return newMap;
      });
    };

    // Handler for message created (remove from streaming when persisted to DB)
    const handleMessageCreated = (message: Message) => {
      // Only handle messages for this session
      if (sessionId && message.session_id !== sessionId) {
        return;
      }

      console.debug(
        `📡 Message created in DB: ${message.message_id.substring(0, 8)} - removing from streaming buffer`
      );

      // Remove from streaming map now that it's in the DB
      setStreamingMessages((prev) => {
        const newMap = new Map(prev);
        newMap.delete(message.message_id);
        return newMap;
      });
    };

    // Handler for thinking:start
    const handleThinkingStart = (data: ThinkingStartEvent) => {
      // Only track messages for this session (if sessionId provided)
      if (sessionId && data.session_id !== sessionId) {
        return;
      }

      console.debug(`🧠 Thinking start: ${data.message_id.substring(0, 8)}`);

      setStreamingMessages((prev) => {
        const newMap = new Map(prev);
        newMap.set(data.message_id, {
          message_id: data.message_id,
          session_id: data.session_id,
          task_id: data.task_id,
          role: 'assistant',
          content: '', // No text content yet
          thinkingContent: '', // Start with empty thinking
          timestamp: data.timestamp,
          isStreaming: true,
          isThinking: true,
        });
        return newMap;
      });
    };

    // Handler for thinking:chunk
    const handleThinkingChunk = (data: ThinkingChunkEvent) => {
      // Only track messages for this session (if sessionId provided)
      if (sessionId && data.session_id !== sessionId) {
        return;
      }

      setStreamingMessages((prev) => {
        const message = prev.get(data.message_id);
        if (!message) {
          return prev;
        }

        const newMap = new Map(prev);
        newMap.set(data.message_id, {
          ...message,
          thinkingContent: (message.thinkingContent || '') + data.chunk,
          isThinking: true,
        });
        return newMap;
      });
    };

    // Handler for thinking:end
    const handleThinkingEnd = (data: ThinkingEndEvent) => {
      // Only track messages for this session (if sessionId provided)
      if (sessionId && data.session_id !== sessionId) {
        return;
      }

      console.debug(`🧠 Thinking end: ${data.message_id.substring(0, 8)}`);

      setStreamingMessages((prev) => {
        const message = prev.get(data.message_id);
        if (!message) return prev;

        const newMap = new Map(prev);
        newMap.set(data.message_id, {
          ...message,
          isThinking: false, // Stop thinking, may continue with text
        });
        return newMap;
      });
    };

    // Register event listeners
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
    messagesService.on('streaming:start', handleStreamingStart as any);
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
    messagesService.on('streaming:chunk', handleStreamingChunk as any);
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
    messagesService.on('streaming:end', handleStreamingEnd as any);
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
    messagesService.on('streaming:error', handleStreamingError as any);
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
    messagesService.on('thinking:start', handleThinkingStart as any);
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
    messagesService.on('thinking:chunk', handleThinkingChunk as any);
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
    messagesService.on('thinking:end', handleThinkingEnd as any);
    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
    messagesService.on('created', handleMessageCreated as any);

    // Cleanup on unmount or client change
    return () => {
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
      messagesService.removeListener('streaming:start', handleStreamingStart as any);
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
      messagesService.removeListener('streaming:chunk', handleStreamingChunk as any);
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
      messagesService.removeListener('streaming:end', handleStreamingEnd as any);
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
      messagesService.removeListener('streaming:error', handleStreamingError as any);
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
      messagesService.removeListener('thinking:start', handleThinkingStart as any);
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
      messagesService.removeListener('thinking:chunk', handleThinkingChunk as any);
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
      messagesService.removeListener('thinking:end', handleThinkingEnd as any);
      // biome-ignore lint/suspicious/noExplicitAny: FeathersJS emit types are not strict
      messagesService.removeListener('created', handleMessageCreated as any);
    };
  }, [client, sessionId, enabled]);

  return streamingMessages;
}
