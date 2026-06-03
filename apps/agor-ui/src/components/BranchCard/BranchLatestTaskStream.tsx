import type { AgorClient, Message, Session, StreamingMessageState, User } from '@agor-live/client';
import { shortId, TaskStatus } from '@agor-live/client';
import { Alert, Button, Empty, Input, Space, Spin, Typography, theme } from 'antd';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import { useStreamingMessagesByTask } from '../../hooks/useStreamingMessagesByTask';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { TaskBlock } from '../TaskBlock';
import { ToolIcon } from '../ToolIcon';
import { chooseBranchPromptTargetSession } from './latestBranchTask';
import { useLatestBranchTask } from './useLatestBranchTask';

interface BranchLatestTaskStreamProps {
  client: AgorClient | null;
  sessions: Session[];
  userById: Map<string, User>;
  currentUserId?: string;
  branchName?: string;
  enabled: boolean;
  selectedSessionId?: string | null;
}

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_STREAMING_MESSAGES: Map<string, StreamingMessageState> = new Map();

export const BranchLatestTaskStream = React.memo<BranchLatestTaskStreamProps>(
  ({ client, sessions, userById, currentUserId, branchName, enabled, selectedSessionId }) => {
    const { token } = theme.useToken();
    const { onPermissionDecision, onSendPrompt } = useAppActions();
    const connectionDisabled = useConnectionDisabled();
    const containerRef = useRef<HTMLDivElement>(null);
    const userScrolledUpRef = useRef(false);
    const userScrollIntentRef = useRef(false);
    const initialMessagesScrollDoneForTaskRef = useRef<string | null>(null);
    const [isReloading, setIsReloading] = useState(false);
    const [prompt, setPrompt] = useState('');

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
    const taskId = task?.task_id ?? null;
    const taskMessagesLoaded = !!taskId && !!currentReactiveState?.loadedTaskIds.has(taskId);

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
      initialMessagesScrollDoneForTaskRef.current = null;
      scheduleAutoScroll();
    }, [scheduleAutoScroll, taskId]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: follow streaming/task status changes unless the user scrolls away
    useEffect(() => {
      if (!enabled || userScrolledUpRef.current) return;
      scheduleAutoScroll();
    }, [allStreamingMessages, enabled, scheduleAutoScroll, task?.status]);

    useEffect(() => {
      if (!enabled || !taskId || !taskMessagesLoaded) return;
      if (initialMessagesScrollDoneForTaskRef.current === taskId) return;

      initialMessagesScrollDoneForTaskRef.current = taskId;
      if (!userScrolledUpRef.current) {
        scheduleAutoScroll();
      }
    }, [enabled, scheduleAutoScroll, taskId, taskMessagesLoaded]);

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

    useEffect(() => {
      if (!reactiveSession || !taskId) return;
      return () => {
        reactiveSession.unloadTaskMessages(taskId);
      };
    }, [reactiveSession, taskId]);

    const loading = latestTaskLoading || (!!sessionId && currentReactiveState?.loading && !task);
    const error = latestTaskError || currentReactiveState?.error || null;
    const isTerminalError = !!currentReactiveState?.terminal;
    const promptTargetSession = useMemo(
      () =>
        chooseBranchPromptTargetSession({
          sessions,
          latestTaskSession: session,
          selectedSessionId,
        }),
      [selectedSessionId, session, sessions]
    );
    const trimmedPrompt = prompt.trim();
    const canPrompt = !!promptTargetSession && !!onSendPrompt && !connectionDisabled;
    const promptPermissionMode = promptTargetSession?.permission_config?.mode;
    const promptPlaceholder =
      promptTargetSession?.status === 'running'
        ? 'Queue a prompt for this session…'
        : 'Prompt this session…';

    // biome-ignore lint/correctness/useExhaustiveDependencies: clear the draft when the target session changes
    useEffect(() => {
      setPrompt('');
    }, [promptTargetSession?.session_id]);

    const handlePromptSubmit = useCallback(() => {
      if (!promptTargetSession || !onSendPrompt || !trimmedPrompt || connectionDisabled) return;
      onSendPrompt(promptTargetSession.session_id, trimmedPrompt, promptPermissionMode);
      setPrompt('');
    }, [
      connectionDisabled,
      onSendPrompt,
      promptPermissionMode,
      promptTargetSession,
      trimmedPrompt,
    ]);

    return (
      <div className="nodrag nopan nowheel">
        <div
          ref={containerRef}
          style={{
            height: 520,
            overflowY: 'auto',
            padding: `${token.sizeUnit}px ${token.sizeUnit * 2}px`,
            background: token.colorBgLayout,
            borderRadius: token.borderRadiusLG,
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
        <div
          style={{
            display: 'flex',
            gap: token.sizeUnit,
            alignItems: 'flex-end',
            marginTop: token.sizeUnit,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            {promptTargetSession && (
              <Space size={4} align="center" style={{ marginBottom: token.sizeUnit / 2 }}>
                <ToolIcon tool={promptTargetSession.agentic_tool} size={14} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Prompting{' '}
                  {getSessionDisplayTitle(promptTargetSession, { includeAgentFallback: true })} ·{' '}
                  {shortId(promptTargetSession.session_id)}
                </Typography.Text>
              </Space>
            )}
            <Input.TextArea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  handlePromptSubmit();
                }
              }}
              disabled={!canPrompt}
              placeholder={canPrompt ? promptPlaceholder : 'No promptable session selected…'}
              autoSize={{ minRows: 1, maxRows: 4 }}
            />
          </div>
          <Button
            type="primary"
            onClick={handlePromptSubmit}
            disabled={!canPrompt || !trimmedPrompt}
          >
            Prompt
          </Button>
        </div>
      </div>
    );
  }
);

BranchLatestTaskStream.displayName = 'BranchLatestTaskStream';
