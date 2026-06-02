import type { AgorClient, Message, Session, User } from '@agor-live/client';
import { TaskStatus } from '@agor-live/client';
import { Alert, Button, Empty, Spin, Typography, theme } from 'antd';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import { useStreamingMessagesByTask } from '../../hooks/useStreamingMessagesByTask';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { TaskBlock } from '../TaskBlock';
import { useLatestBranchTask } from './useLatestBranchTask';

interface BranchLatestTaskStreamProps {
  client: AgorClient | null;
  sessions: Session[];
  userById: Map<string, User>;
  currentUserId?: string;
  branchName?: string;
  enabled: boolean;
  onSessionClick?: (sessionId: string) => void;
}

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_STREAMING_MESSAGES = new Map();

export const BranchLatestTaskStream = React.memo<BranchLatestTaskStreamProps>(
  ({ client, sessions, userById, currentUserId, branchName, enabled, onSessionClick }) => {
    const { token } = theme.useToken();
    const { onPermissionDecision } = useAppActions();
    const containerRef = useRef<HTMLDivElement>(null);
    const userScrolledUpRef = useRef(false);
    const userScrollIntentRef = useRef(false);
    const [isReloading, setIsReloading] = useState(false);

    const {
      task: discoveredTask,
      session,
      loading: latestTaskLoading,
      error: latestTaskError,
    } = useLatestBranchTask(client, sessions, enabled);

    const sessionId = session?.session_id ?? null;
    const { handle: reactiveSession, state: reactiveState } = useSharedReactiveSession(
      client,
      sessionId,
      {
        enabled: enabled && !!sessionId,
        reactiveOptions: { taskHydration: 'lazy' },
      }
    );
    const currentReactiveState = reactiveState?.sessionId === sessionId ? reactiveState : null;

    const task = useMemo(() => {
      if (!discoveredTask) return null;
      return (
        currentReactiveState?.tasks.find(
          (candidate) => candidate.task_id === discoveredTask.task_id
        ) || discoveredTask
      );
    }, [currentReactiveState?.tasks, discoveredTask]);

    const allStreamingMessages =
      currentReactiveState?.streamingMessages || EMPTY_STREAMING_MESSAGES;
    const streamingMessagesByTask = useStreamingMessagesByTask(allStreamingMessages);

    const isNearBottom = useCallback(() => {
      if (!containerRef.current) return true;
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      return scrollHeight - scrollTop - clientHeight < 24;
    }, []);

    const scrollToBottom = useCallback(() => {
      if (!containerRef.current) return;
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }, []);

    const scheduleAutoScroll = useCallback(() => {
      requestAnimationFrame(scrollToBottom);
    }, [scrollToBottom]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: reset the scroll lock when the displayed task changes
    useEffect(() => {
      userScrolledUpRef.current = false;
      userScrollIntentRef.current = false;
      scheduleAutoScroll();
    }, [scheduleAutoScroll, task?.task_id]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: follow streaming/task status changes unless the user scrolls away
    useEffect(() => {
      if (!enabled || userScrolledUpRef.current) return;
      scheduleAutoScroll();
    }, [allStreamingMessages, enabled, scheduleAutoScroll, task?.status]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container || !enabled) return;

      const markUserScrollIntent = () => {
        userScrollIntentRef.current = true;
      };
      const handleScroll = () => {
        if (isNearBottom()) {
          userScrolledUpRef.current = false;
          userScrollIntentRef.current = false;
          return;
        }
        if (userScrollIntentRef.current) {
          userScrolledUpRef.current = true;
        }
      };

      container.addEventListener('wheel', markUserScrollIntent, { passive: true });
      container.addEventListener('touchstart', markUserScrollIntent, { passive: true });
      container.addEventListener('pointerdown', markUserScrollIntent);
      container.addEventListener('scroll', handleScroll, { passive: true });

      return () => {
        container.removeEventListener('wheel', markUserScrollIntent);
        container.removeEventListener('touchstart', markUserScrollIntent);
        container.removeEventListener('pointerdown', markUserScrollIntent);
        container.removeEventListener('scroll', handleScroll);
      };
    }, [enabled, isNearBottom]);

    const handleExpandChange = useCallback(() => {
      // The branch-card stream intentionally shows exactly one expanded task.
      // Keep it open even if the TaskBlock header is clicked.
    }, []);

    const handleLoadTaskMessages = useCallback(
      (taskId: string) => {
        if (!reactiveSession) return;
        return reactiveSession.loadTaskMessages(taskId).then(() => undefined);
      },
      [reactiveSession]
    );

    const handleUnloadTaskMessages = useCallback(
      (taskId: string) => {
        if (!reactiveSession) return;
        reactiveSession.unloadTaskMessages(taskId);
      },
      [reactiveSession]
    );

    const loading = latestTaskLoading || (!!sessionId && currentReactiveState?.loading && !task);
    const error = latestTaskError || currentReactiveState?.error || null;
    const isTerminalError = !!currentReactiveState?.terminal;

    return (
      <div
        className="nodrag nopan nowheel"
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          background: token.colorBgContainer,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: `${token.sizeUnit * 1.5}px ${token.sizeUnit * 2}px`,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            gap: token.sizeUnit * 2,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <Typography.Text strong>Latest task stream</Typography.Text>
            {session && (
              <Typography.Text
                type="secondary"
                style={{ display: 'block', fontSize: 12 }}
                ellipsis={{
                  tooltip: getSessionDisplayTitle(session, { includeAgentFallback: true }),
                }}
              >
                {getSessionDisplayTitle(session, { includeAgentFallback: true })}
              </Typography.Text>
            )}
          </div>
          {session && onSessionClick && (
            <Button
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                onSessionClick(session.session_id);
              }}
            >
              Open
            </Button>
          )}
        </div>

        <div
          ref={containerRef}
          style={{
            height: 520,
            overflowY: 'auto',
            padding: `${token.sizeUnit}px ${token.sizeUnit * 2}px`,
            background: token.colorBgLayout,
          }}
        >
          {error ? (
            <Alert
              type="error"
              message="Failed to load latest task"
              description={error}
              showIcon
              action={
                reactiveSession && currentReactiveState && !isTerminalError ? (
                  <Button
                    size="small"
                    loading={isReloading}
                    onClick={async () => {
                      setIsReloading(true);
                      try {
                        await reactiveSession.resync();
                      } finally {
                        setIsReloading(false);
                      }
                    }}
                  >
                    Reload
                  </Button>
                ) : undefined
              }
            />
          ) : loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: token.sizeXL }}>
              <Spin />
            </div>
          ) : !task || !session ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No task output yet for this branch"
              style={{ marginTop: token.sizeXL }}
            />
          ) : task.status === TaskStatus.QUEUED ? (
            <Alert
              type="info"
              showIcon
              message="Latest task is queued"
              description={task.full_prompt || 'Waiting for the session to become available.'}
            />
          ) : (
            <TaskBlock
              task={task}
              agentic_tool={session.agentic_tool}
              sessionModel={session.model_config?.model}
              userById={userById}
              currentUserId={currentUserId}
              isExpanded={true}
              onExpandChange={handleExpandChange}
              sessionId={session.session_id}
              onPermissionDecision={onPermissionDecision}
              branchName={branchName}
              scheduledFromBranch={session.scheduled_from_branch}
              scheduledRunAt={session.scheduled_run_at}
              streamingMessages={streamingMessagesByTask.get(task.task_id)}
              taskMessages={
                currentReactiveState?.messagesByTask.get(task.task_id) || EMPTY_MESSAGES
              }
              taskMessagesLoaded={!!currentReactiveState?.loadedTaskIds.has(task.task_id)}
              onLoadTaskMessages={handleLoadTaskMessages}
              onUnloadTaskMessages={handleUnloadTaskMessages}
              assistantEmoji={undefined}
              isLatestTask={true}
              client={client}
            />
          )}
        </div>
      </div>
    );
  }
);

BranchLatestTaskStream.displayName = 'BranchLatestTaskStream';
