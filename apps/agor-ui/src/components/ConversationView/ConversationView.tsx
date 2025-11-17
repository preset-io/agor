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
import type { MessageID, PermissionScope, SessionID, User } from '@agor/core/types';
import { Alert, Spin, Typography } from 'antd';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStreamingMessages, useTasks } from '../../hooks';
import type { StreamingMessage } from '../../hooks/useStreamingMessages';
import { TaskBlock } from '../TaskBlock';

const { Text } = Typography;

/**
 * Check if two Maps are equal (same keys and same content)
 * Used to maintain stable Map references for React memoization
 */
function mapsAreEqual<K, V>(map1: Map<K, V>, map2: Map<K, V>): boolean {
  if (map1.size !== map2.size) return false;

  for (const [key, value1] of map1.entries()) {
    const value2 = map2.get(key);
    // For StreamingMessage objects, compare by reference (they're immutable updates)
    if (value1 !== value2) return false;
  }

  return true;
}

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
   * Session's default model (to hide redundant model pills)
   */
  sessionModel?: string;

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

  /**
   * Worktree name for hiding redundant branch names
   */
  worktreeName?: string;

  /**
   * Whether this session was created by the scheduler
   */
  scheduledFromWorktree?: boolean;

  /**
   * Unix timestamp (ms) of when the session was scheduled to run
   */
  scheduledRunAt?: number;

  /**
   * Custom empty state message (for mobile vs desktop contexts)
   */
  emptyStateMessage?: string;

  /**
   * Whether the view is currently visible/active (pauses sockets when false)
   */
  isActive?: boolean;
}

export const ConversationView = React.memo<ConversationViewProps>(
  ({
    client,
    sessionId,
    agentic_tool,
    sessionModel,
    users = [],
    currentUserId,
    onScrollRef,
    onPermissionDecision,
    worktreeName,
    scheduledFromWorktree,
    scheduledRunAt,
    emptyStateMessage = 'No messages yet. Send a prompt to start the conversation.',
    isActive = true,
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

    // Fetch tasks for this session
    const currentUser = users.find((u) => u.user_id === currentUserId) || null;
    const {
      tasks,
      loading: tasksLoading,
      error: tasksError,
    } = useTasks(client, sessionId, currentUser, isActive);

    // Track real-time streaming messages for the session
    const allStreamingMessages = useStreamingMessages(client, sessionId || undefined, isActive);

    // Store previous task maps to maintain stable references
    const prevTaskMapsRef = useRef<Map<string, Map<MessageID, StreamingMessage>>>(new Map());

    // Create stable Map references per task to avoid unnecessary re-renders
    // Only return new Map objects when the actual messages for that task change
    const streamingMessagesByTask = useMemo(() => {
      const result = new Map<string, Map<MessageID, StreamingMessage>>();
      const prevMaps = prevTaskMapsRef.current;

      // Group messages by task_id
      const tempByTask = new Map<string, Map<MessageID, StreamingMessage>>();
      for (const [msgId, streamingMsg] of allStreamingMessages.entries()) {
        if (streamingMsg.task_id) {
          if (!tempByTask.has(streamingMsg.task_id)) {
            tempByTask.set(streamingMsg.task_id, new Map());
          }
          tempByTask.get(streamingMsg.task_id)!.set(msgId, streamingMsg);
        }
      }

      // For each task, reuse previous Map if content is identical
      for (const [taskId, newTaskMap] of tempByTask.entries()) {
        const prevTaskMap = prevMaps.get(taskId);

        // Check if maps are equal (same keys and values)
        if (prevTaskMap && mapsAreEqual(prevTaskMap, newTaskMap)) {
          // Reuse the previous Map reference (stable reference = no re-render)
          result.set(taskId, prevTaskMap);
        } else {
          // Content changed, use new Map
          result.set(taskId, newTaskMap);
        }
      }

      // Update ref for next render
      prevTaskMapsRef.current = result;

      return result;
    }, [allStreamingMessages]);

    const loading = tasksLoading;
    const error = tasksError;

    // Track which tasks are expanded (default: last task expanded)
    const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => {
      if (tasks.length > 0) {
        return new Set([tasks[tasks.length - 1].task_id]);
      }
      return new Set();
    });

    // Update expanded state when tasks change (expand last task by default)
    useEffect(() => {
      if (tasks.length > 0) {
        const lastTaskId = tasks[tasks.length - 1].task_id;
        setExpandedTaskIds((prev) => {
          // If no tasks expanded or last task changed, expand the last task
          if (prev.size === 0 || !prev.has(lastTaskId)) {
            // Scroll to bottom after expansion is rendered
            requestAnimationFrame(() => {
              scrollToBottom();
            });
            return new Set([lastTaskId]);
          }
          return prev;
        });
      }
    }, [tasks, scrollToBottom]);

    // Handle task expand/collapse
    const handleTaskExpandChange = useCallback((taskId: string, expanded: boolean) => {
      setExpandedTaskIds((prev) => {
        const next = new Set(prev);
        if (expanded) {
          next.add(taskId);
        } else {
          next.delete(taskId);
        }
        return next;
      });
    }, []);

    // Memoize expand handlers per task to keep stable references
    const expandHandlers = useMemo(() => {
      const handlerMap = new Map<string, (expanded: boolean) => void>();
      for (const task of tasks) {
        handlerMap.set(task.task_id, (expanded: boolean) =>
          handleTaskExpandChange(task.task_id, expanded)
        );
      }
      return handlerMap;
    }, [tasks, handleTaskExpandChange]);

    // Auto-scroll to bottom when streaming messages arrive (only if user is already at bottom)
    // biome-ignore lint/correctness/useExhaustiveDependencies: We want to scroll on streaming change
    useEffect(() => {
      if (isNearBottom()) {
        scrollToBottom();
      }
    }, [allStreamingMessages, tasks]);

    if (error) {
      return (
        <Alert type="error" message="Failed to load conversation" description={error} showIcon />
      );
    }

    if (loading && tasks.length === 0) {
      return (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
          <Spin />
        </div>
      );
    }

    if (tasks.length === 0) {
      return (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            height: '100%',
            padding: '2rem',
            flexDirection: 'column',
            gap: '24px',
          }}
        >
          <img
            src="/favicon.png"
            alt="Agor"
            style={{
              width: 160,
              height: 160,
              opacity: 0.5,
              borderRadius: '50%',
            }}
          />
          <Text type="secondary">{emptyStateMessage}</Text>
        </div>
      );
    }

    return (
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 0',
          minHeight: 0,
        }}
      >
        {/* Task-organized conversation */}
        {tasks.map((task) => (
          <TaskBlock
            key={task.task_id}
            task={task}
            client={client}
            agentic_tool={agentic_tool}
            sessionModel={sessionModel}
            users={users}
            currentUserId={currentUserId}
            isExpanded={expandedTaskIds.has(task.task_id)}
            onExpandChange={expandHandlers.get(task.task_id)!}
            sessionId={sessionId}
            onPermissionDecision={onPermissionDecision}
            worktreeName={worktreeName}
            scheduledFromWorktree={scheduledFromWorktree}
            scheduledRunAt={scheduledRunAt}
            streamingMessages={streamingMessagesByTask.get(task.task_id)}
          />
        ))}
      </div>
    );
  }
);

ConversationView.displayName = 'ConversationView';
