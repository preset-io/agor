/**
 * ConversationView - Task-centric conversation interface
 *
 * Displays conversation as collapsible task sections with:
 * - Tasks as primary organization unit
 * - Messages grouped within each task
 * - Tool use blocks properly rendered
 * - Latest task expanded by default
 * - Progressive disclosure for older tasks
 * - Auto-scrolling to latest content
 *
 * Based on design in context/explorations/conversation-design.md
 */

import type { AgorClient } from '@agor/core/api';
import type { Message, PermissionScope, SessionID, User } from '@agor/core/types';
import { Alert, Empty, Spin } from 'antd';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useMessages, useStreamingMessages, useTasks } from '../../hooks';
import { TaskBlock } from '../TaskBlock';

export interface ConversationViewProps {
  /**
   * Agor client for fetching messages
   */
  client: AgorClient | null;

  /**
   * Session ID to fetch messages for
   */
  sessionId: SessionID | null;

  /**
   * Agentic tool name for showing tool icon
   */
  agentic_tool?: string;

  /**
   * All users for emoji avatars
   */
  users?: User[];

  /**
   * Current user ID for showing emoji
   */
  currentUserId?: string;

  /**
   * Callback to expose scroll-to-bottom function to parent
   */
  onScrollRef?: (scrollToBottom: () => void) => void;

  /**
   * Permission decision handler
   */
  onPermissionDecision?: (
    sessionId: string,
    requestId: string,
    taskId: string,
    allow: boolean,
    scope: PermissionScope
  ) => void;
}

export const ConversationView: React.FC<ConversationViewProps> = ({
  client,
  sessionId,
  agentic_tool,
  users = [],
  currentUserId,
  onScrollRef,
  onPermissionDecision,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Check if user is scrolled near the bottom (within 100px)
  const isNearBottom = useCallback(() => {
    if (!containerRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    return scrollHeight - scrollTop - clientHeight < 100;
  }, []);

  // Scroll to bottom function (wrapped in useCallback to avoid re-renders)
  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, []);

  // Expose scroll function to parent
  useEffect(() => {
    if (onScrollRef) {
      onScrollRef(scrollToBottom);
    }
  }, [onScrollRef, scrollToBottom]);

  // Fetch messages and tasks for this session
  const {
    messages,
    loading: messagesLoading,
    error: messagesError,
  } = useMessages(client, sessionId);
  const { tasks, loading: tasksLoading, error: tasksError } = useTasks(client, sessionId);

  // Track real-time streaming messages
  const streamingMessages = useStreamingMessages(client, sessionId || undefined);

  const loading = messagesLoading || tasksLoading;
  const error = messagesError || tasksError;

  // Merge streaming messages with DB messages
  const allMessages = useMemo(() => {
    // Filter out DB messages that are already in streaming (avoid duplicates)
    const dbOnlyMessages = messages.filter(msg => !streamingMessages.has(msg.message_id));

    // Combine and sort by timestamp
    return ([...dbOnlyMessages, ...Array.from(streamingMessages.values())] as Message[]).sort(
      (a, b) => a.timestamp.localeCompare(b.timestamp)
    );
  }, [messages, streamingMessages]);

  // Group messages by task
  const taskWithMessages = useMemo(() => {
    if (tasks.length === 0) return [];

    return tasks.map(task => ({
      task,
      messages: allMessages.filter(msg => msg.task_id === task.task_id),
    }));
  }, [tasks, allMessages]);

  // Auto-scroll to bottom when new messages arrive (only if user is already at bottom)
  // biome-ignore lint/correctness/useExhaustiveDependencies: We want to scroll on messages/streaming change
  useEffect(() => {
    if (isNearBottom()) {
      scrollToBottom();
    }
  }, [allMessages, tasks]);

  if (error) {
    return (
      <Alert type="error" message="Failed to load conversation" description={error} showIcon />
    );
  }

  if (loading && messages.length === 0 && tasks.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
        <Spin />
      </div>
    );
  }

  if (messages.length === 0 && tasks.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
          padding: '2rem',
        }}
      >
        <Empty description="No conversation yet" />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: '12px',
      }}
    >
      {/* Task-organized conversation */}
      {taskWithMessages.map(({ task, messages: taskMessages }, index) => (
        <TaskBlock
          key={task.task_id}
          task={task}
          messages={taskMessages}
          agentic_tool={agentic_tool}
          users={users}
          currentUserId={currentUserId}
          // Expand only the last task by default
          defaultExpanded={index === taskWithMessages.length - 1}
          sessionId={sessionId}
          onPermissionDecision={onPermissionDecision}
        />
      ))}
    </div>
  );
};
