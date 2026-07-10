import type { AgorClient, Message, Session, StreamingMessageState, User } from '@agor-live/client';
import { TaskStatus } from '@agor-live/client';
import { Alert, Button, Empty, Input, Spin, theme } from 'antd';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import { useStreamingMessagesByTask } from '../../hooks/useStreamingMessagesByTask';
import { TaskBlock } from '../TaskBlock';
import { chooseLatestSessionTask } from './latestSessionTask';

interface SessionLatestTaskPeekProps {
  client: AgorClient | null;
  session: Session;
  userById: Map<string, User>;
  currentUserId?: string;
  branchName?: string;
  enabled: boolean;
}

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_STREAMING_MESSAGES: Map<string, StreamingMessageState> = new Map();

function isDisposedReactiveSessionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(' is disposed');
}

export const SessionLatestTaskPeek = React.memo<SessionLatestTaskPeekProps>(
  ({ client, session, userById, currentUserId, branchName, enabled }) => {
    const { token } = theme.useToken();
    const { onPermissionDecision, onSendPrompt } = useAppActions();
    const connectionDisabled = useConnectionDisabled();
    const containerRef = useRef<HTMLDivElement>(null);
    const userScrolledUpRef = useRef(false);
    const userScrollIntentRef = useRef(false);
    const initialMessagesScrollDoneForTaskRef = useRef<string | null>(null);
    const [isReloading, setIsReloading] = useState(false);
    const [prompt, setPrompt] = useState('');

    const sessionId = session.session_id;
    const { handle: reactiveSession, state: reactiveState } = useSharedReactiveSession(
      client,
      sessionId,
      {
        enabled,
        reactiveOptions: { taskHydration: 'lazy' },
      }
    );
    const currentReactiveState = reactiveState?.sessionId === sessionId ? reactiveState : null;
    const currentSession = currentReactiveState?.session || session;

    const task = useMemo(() => {
      if (!currentReactiveState) return null;
      return chooseLatestSessionTask([
        ...currentReactiveState.tasks,
        ...currentReactiveState.queuedTasks,
      ]);
    }, [currentReactiveState]);

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
      // Peek panels intentionally show exactly one expanded latest task.
      // Keep it open even if the TaskBlock header is clicked.
    }, []);

    const handleLoadTaskMessages = useCallback(
      (taskId: string) => {
        if (!reactiveSession) return;
        return reactiveSession
          .loadTaskMessages(taskId)
          .then(() => undefined)
          .catch((error) => {
            if (isDisposedReactiveSessionError(error)) return;
            throw error;
          });
      },
      [reactiveSession]
    );

    const safeUnloadTaskMessages = useCallback(
      (taskId: string) => {
        if (!reactiveSession) return;
        try {
          reactiveSession.unloadTaskMessages(taskId);
        } catch (error) {
          if (isDisposedReactiveSessionError(error)) return;
          throw error;
        }
      },
      [reactiveSession]
    );

    useEffect(() => {
      if (!taskId) return;
      return () => {
        safeUnloadTaskMessages(taskId);
      };
    }, [safeUnloadTaskMessages, taskId]);

    const loading = enabled && (!currentReactiveState || (currentReactiveState.loading && !task));
    const error = currentReactiveState?.error || null;
    const isTerminalError = !!currentReactiveState?.terminal;
    const trimmedPrompt = prompt.trim();
    const canPrompt = !!onSendPrompt && !connectionDisabled;
    const promptPermissionMode = currentSession.permission_config?.mode;
    const promptPlaceholder =
      currentSession.status === 'running'
        ? 'Queue a prompt for this session…'
        : 'Prompt this session…';

    const handlePromptSubmit = useCallback(async () => {
      if (!onSendPrompt || !trimmedPrompt || connectionDisabled) return;
      try {
        const sendResult = await onSendPrompt(
          currentSession.session_id,
          trimmedPrompt,
          promptPermissionMode
        );
        if (sendResult !== false) setPrompt('');
      } catch (error) {
        console.error('Failed to send prompt from task peek:', error);
      }
    }, [
      connectionDisabled,
      currentSession.session_id,
      onSendPrompt,
      promptPermissionMode,
      trimmedPrompt,
    ]);

    return (
      <div className="nodrag">
        <div
          ref={containerRef}
          style={{
            height: 360,
            overflowY: 'auto',
          }}
        >
          {error ? (
            <Alert
              type="error"
              message="Failed to load session task"
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
          ) : !task ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No task output yet for this session"
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
              agentic_tool={currentSession.agentic_tool}
              sessionModel={currentSession.model_config?.model}
              userById={userById}
              currentUserId={currentUserId}
              isExpanded={true}
              onExpandChange={handleExpandChange}
              sessionId={currentSession.session_id}
              onPermissionDecision={onPermissionDecision}
              branchName={branchName}
              scheduledFromBranch={currentSession.scheduled_from_branch}
              scheduledRunAt={currentSession.scheduled_run_at}
              streamingMessages={streamingMessagesByTask.get(task.task_id)}
              taskMessages={
                currentReactiveState?.messagesByTask.get(task.task_id) || EMPTY_MESSAGES
              }
              taskMessagesLoaded={!!currentReactiveState?.loadedTaskIds.has(task.task_id)}
              onLoadTaskMessages={handleLoadTaskMessages}
              onUnloadTaskMessages={safeUnloadTaskMessages}
              assistantEmoji={undefined}
              isLatestTask={true}
              client={client}
            />
          )}
        </div>
        <div
          className="nodrag nopan nowheel"
          style={{
            display: 'flex',
            gap: token.sizeUnit,
            alignItems: 'flex-end',
            marginTop: token.sizeUnit,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
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
              placeholder={canPrompt ? promptPlaceholder : 'Session prompting is unavailable…'}
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

SessionLatestTaskPeek.displayName = 'SessionLatestTaskPeek';
