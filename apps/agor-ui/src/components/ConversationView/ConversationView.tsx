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
import { BranchesOutlined, CopyOutlined, ForkOutlined } from '@ant-design/icons';
import { Alert, Spin, Typography, theme } from 'antd';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStreamingMessages, useTasks } from '../../hooks';
import type { StreamingMessage } from '../../hooks/useStreamingMessages';
import { useCopyToClipboard } from '../../utils/clipboard';
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
   * All users for emoji avatars (Map-based)
   */
  userById?: Map<string, User>;

  /**
   * Current user ID for showing emoji
   */
  currentUserId?: string;

  /**
   * Callback to expose scroll functions to parent
   */
  onScrollRef?: (scrollToBottom: () => void, scrollToTop: () => void) => void;

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

  /**
   * Session genealogy for showing fork/spawn origin
   */
  genealogy?: {
    forked_from_session_id?: string;
    fork_point_task_id?: string;
    fork_point_message_index?: number;
    parent_session_id?: string;
    spawn_point_task_id?: string;
    spawn_point_message_index?: number;
  };
}

export const ConversationView = React.memo<ConversationViewProps>(
  ({
    client,
    sessionId,
    agentic_tool,
    sessionModel,
    userById = new Map(),
    currentUserId,
    onScrollRef,
    onPermissionDecision,
    worktreeName,
    scheduledFromWorktree,
    scheduledRunAt,
    emptyStateMessage = 'No messages yet. Send a prompt to start the conversation.',
    isActive = true,
    genealogy,
  }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const { token } = theme.useToken();
    const [copied, copy] = useCopyToClipboard();

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

    // Scroll to top function
    const scrollToTop = useCallback(() => {
      if (containerRef.current) {
        containerRef.current.scrollTop = 0;
      }
    }, []);

    // Expose scroll functions to parent
    useEffect(() => {
      if (onScrollRef) {
        onScrollRef(scrollToBottom, scrollToTop);
      }
    }, [onScrollRef, scrollToBottom, scrollToTop]);

    // Fetch tasks for this session
    const currentUser = currentUserId ? userById.get(currentUserId) || null : null;
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
        <div
          style={{
            flex: 1,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '2rem',
          }}
        >
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
            src={`${import.meta.env.BASE_URL}favicon.png`}
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

    // Genealogy banner component
    const isForked = !!genealogy?.forked_from_session_id;
    const isSpawned = !!genealogy?.parent_session_id;

    const GenealogyBanner = () => {
      if (!isForked && !isSpawned) return null;

      const sessionId = isForked ? genealogy?.forked_from_session_id : genealogy?.parent_session_id;
      const messageIndex = isForked
        ? genealogy?.fork_point_message_index
        : genealogy?.spawn_point_message_index;
      const icon = isForked ? <ForkOutlined /> : <BranchesOutlined />;
      const actionText = isForked ? 'Forked' : 'Spawned';
      const shortId = sessionId?.substring(0, 8);

      return (
        <div
          style={{
            margin: '12px 0',
            padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 4}px`,
            background: isForked ? token.colorInfoBg : token.colorPrimaryBg,
            border: `1px solid ${isForked ? token.colorInfoBorder : token.colorPrimaryBorder}`,
            borderRadius: token.borderRadiusLG,
            display: 'flex',
            alignItems: 'center',
            gap: token.sizeUnit * 3,
          }}
        >
          <span style={{ fontSize: 20, color: token.colorTextSecondary }}>{icon}</span>
          <div style={{ flex: 1 }}>
            <Text style={{ fontSize: token.fontSizeLG }}>
              {actionText} from session{' '}
              <Text code strong style={{ fontSize: token.fontSizeLG }}>
                {shortId}
              </Text>
              {messageIndex !== undefined && (
                <>
                  {' '}
                  as of message{' '}
                  <Text code strong style={{ fontSize: token.fontSizeLG }}>
                    {messageIndex}
                  </Text>
                </>
              )}
            </Text>
          </div>
          <CopyOutlined
            onClick={() => sessionId && copy(sessionId)}
            style={{
              cursor: 'pointer',
              fontSize: 16,
              color: copied ? token.colorSuccess : token.colorTextSecondary,
            }}
            title={copied ? 'Copied!' : 'Copy session ID'}
          />
        </div>
      );
    };

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
        {/* Genealogy Banner */}
        <GenealogyBanner />

        {/* Task-organized conversation */}
        {tasks.map((task) => (
          <TaskBlock
            key={task.task_id}
            task={task}
            client={client}
            agentic_tool={agentic_tool}
            sessionModel={sessionModel}
            userById={userById}
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
