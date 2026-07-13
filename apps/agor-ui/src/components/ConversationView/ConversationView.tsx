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
 */

import type { AgorClient, Message, PermissionScope, SessionID, User } from '@agor-live/client';
import { shortId, TaskStatus } from '@agor-live/client';
import { BranchesOutlined, CopyOutlined, ForkOutlined } from '@ant-design/icons';
import { Alert, Button, Spin, Typography, theme } from 'antd';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { BRAND, brandMarkHref } from '../../branding/brand';
import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import { useStreamingMessagesByTask } from '../../hooks/useStreamingMessagesByTask';
import { useCopyToClipboard } from '../../utils/clipboard';
import { TaskBlock } from '../TaskBlock';

const { Text } = Typography;
const EMPTY_STREAMING_MESSAGES = new Map();
// Default-param `= new Map()` would mint a fresh Map on every render and
// defeat every TaskBlock's React.memo whenever the prop is omitted.
const EMPTY_USER_MAP = new Map<string, User>();
// Shared empty-array sentinel so TaskBlock's `taskMessages` prop keeps a stable
// reference for tasks whose messages haven't been loaded — otherwise `|| []`
// would mint a fresh array on every render and thrash TaskBlock's React.memo.
const EMPTY_MESSAGES: Message[] = [];

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
   * Branch name for hiding redundant branch names
   */
  branchName?: string;

  /**
   * Whether this session was created by the scheduler
   */
  scheduledFromBranch?: boolean;

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

  /**
   * Emoji override for teammate avatar in message bubbles
   */
  teammateEmoji?: string;

  /**
   * When true, all task blocks are force-expanded (used by in-session search)
   */
  forceExpandAll?: boolean;
}

export const ConversationView = React.memo<ConversationViewProps>(
  ({
    client,
    sessionId,
    agentic_tool,
    sessionModel,
    userById = EMPTY_USER_MAP,
    currentUserId,
    onScrollRef,
    onPermissionDecision,
    branchName,
    scheduledFromBranch,
    scheduledRunAt,
    emptyStateMessage = 'No messages yet. Send a prompt to start the conversation.',
    isActive = true,
    genealogy,
    teammateEmoji,
    forceExpandAll = false,
  }) => {
    const { token } = theme.useToken();
    const [copied, copy] = useCopyToClipboard();

    // use-stick-to-bottom owns the entire auto-scroll lifecycle. It keeps a
    // PERSISTENT ResizeObserver on the content element, so any late content
    // growth (images, lazy markdown/code, fonts, async tool output) keeps the
    // viewport pinned while the user is at bottom — and stops the moment the
    // user scrolls up. `scrollRef` goes on the scroll container, `contentRef`
    // on the inner content wrapper. `initial`/`resize: 'instant'` avoids
    // smooth-scroll animation jank on first paint and on layout growth.
    const { scrollRef, contentRef, scrollToBottom, stopScroll, state } = useStickToBottom({
      initial: 'instant',
      resize: 'instant',
    });

    // Public scroll-to-bottom exposed via onScrollRef (button clicks) and the
    // resume-on-send wiring in SessionPanel. Wrap to a plain `() => void` so we
    // don't leak the library's optional ScrollToBottom options to callers.
    const handleScrollToBottom = useCallback(() => {
      // The library's scrollToBottom() sets isAtBottom=true but never clears
      // escapedFromLock, so a prior scroll-up leaves the bottom lock half-engaged:
      // the resize-driven re-pin that follows late/streamed content is gated on
      // isAtBottom, which a stale escapedFromLock keeps flipping back to false.
      // Clearing the escape on an explicit go-to-bottom intent lets the pin
      // survive until the round-tripped/streamed content actually arrives.
      state.escapedFromLock = false;
      scrollToBottom();
    }, [state, scrollToBottom]);

    // Scroll to top. While content is still streaming/growing, the library's
    // persistent observer can re-pin to the bottom before our scrollTop write
    // takes effect, snapping the user right back down. `stopScroll()`
    // synchronously releases the bottom lock (and cancels any in-flight scroll
    // animation) so the scrollTop = 0 sticks.
    const scrollToTop = useCallback(() => {
      stopScroll();
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
      }
    }, [scrollRef, stopScroll]);

    // Expose scroll functions to parent
    useEffect(() => {
      if (onScrollRef) {
        onScrollRef(handleScrollToBottom, scrollToTop);
      }
    }, [onScrollRef, handleScrollToBottom, scrollToTop]);

    const { handle: reactiveSession, state: reactiveState } = useSharedReactiveSession(
      client,
      sessionId,
      {
        enabled: isActive,
        reactiveOptions: { taskHydration: 'lazy' },
      }
    );
    const currentReactiveState = reactiveState?.sessionId === sessionId ? reactiveState : null;

    // Queued tasks belong to the queue drawer, not the conversation. They
    // haven't run yet — there's no message_range, no user-message row, no
    // agent output to render — so showing them here as TaskBlocks just
    // duplicates what the queue panel already shows.
    //
    // Memoized so the filtered array's identity is stable across re-renders
    // when the underlying reactive `tasks` list hasn't changed. Without this,
    // every streaming chunk produced a fresh array → every downstream useMemo
    // depending on `tasks` would invalidate and rebuild.
    const tasks = useMemo(
      () => (currentReactiveState?.tasks || []).filter((t) => t.status !== TaskStatus.QUEUED),
      [currentReactiveState?.tasks]
    );

    // Land at the bottom on panel open / session switch — but only once real
    // content is mounted. On a cold open ConversationView early-returns <Spin/>
    // (scrollRef/contentRef unmounted), so firing before tasks exist is a no-op
    // that never re-runs; gating on tasks.length>0 fires it when the container
    // mounts. handleScrollToBottom also clears the escape so the library's
    // persistent observer reliably follows lazy/streamed growth from there.
    const hasContent = tasks.length > 0;
    useEffect(() => {
      if (isActive && sessionId && hasContent) {
        handleScrollToBottom();
      }
    }, [isActive, sessionId, hasContent, handleScrollToBottom]);

    const allStreamingMessages =
      currentReactiveState?.streamingMessages || EMPTY_STREAMING_MESSAGES;
    const loading = currentReactiveState ? currentReactiveState.loading : !!sessionId;
    const error = currentReactiveState?.error || null;
    const isTerminalError = !!currentReactiveState?.terminal;
    const [isReloading, setIsReloading] = useState(false);

    const streamingMessagesByTask = useStreamingMessagesByTask(allStreamingMessages);

    // Track which tasks are expanded (default: last task expanded)
    const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => {
      if (tasks.length > 0) {
        return new Set([tasks[tasks.length - 1].task_id]);
      }
      return new Set();
    });

    // When a new task arrives (i.e. the *last* task id changes), expand it.
    // If the user is still at the bottom, collapse older tasks and follow the
    // new one; if the user has scrolled away, preserve what they were reading.
    // Following is handled by the library's persistent observer — a new last
    // task while `isAtBottom` re-pins automatically, so we only need to manage
    // the expand state here. We deliberately depend on `lastTaskId` rather than
    // `tasks` so that:
    //   1. unrelated re-renders don't fire this effect (`tasks` still gets
    //      a new reference whenever any task patch lands — the useMemo bails
    //      out only when the *upstream* `reactiveState.tasks` array is
    //      identity-stable), and
    //   2. if the user collapses the current last task, we don't immediately
    //      re-open it — that "auto re-expand on empty" behavior fought the
    //      user and showed up as a flicker.
    const lastTaskId = tasks.length > 0 ? tasks[tasks.length - 1].task_id : null;
    useEffect(() => {
      if (!isActive || !lastTaskId) return;
      // Read the library's SYNCHRONOUS live state, not the returned `isAtBottom`
      // React value. The returned value lags a render and also counts
      // "near bottom" as pinned — both would mis-classify a user who just
      // scrolled up moments before a task arrives, collapsing the tasks they're
      // reading. `state.escapedFromLock` is mutated synchronously the instant
      // the user scrolls away from the bottom lock, restoring the old
      // `userScrolledUpRef` semantics exactly.
      const userScrolledUp = state.escapedFromLock;
      setExpandedTaskIds((prev) => {
        if (prev.has(lastTaskId)) return prev;
        if (userScrolledUp) {
          // User has scrolled away — just expand the new task, keep older ones
          // visible so we don't disturb what they're reading.
          const next = new Set(prev);
          next.add(lastTaskId);
          return next;
        }
        // At bottom — collapse older tasks and focus the new one.
        return new Set([lastTaskId]);
      });
    }, [isActive, lastTaskId, state]);

    // Handle task expand/collapse. Single stable callback shared by every
    // TaskBlock — the callback takes `taskId` so we don't need to mint a
    // per-task closure (which previously rebuilt on every render and broke
    // TaskBlock's React.memo for the entire task list).
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

    // Stable load/unload callbacks. The previous inline arrows were minted on
    // every ConversationView render → every TaskBlock saw new `onLoadTaskMessages`
    // / `onUnloadTaskMessages` refs → memo bailout failed for every TaskBlock,
    // including ones whose messages weren't changing.
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

    // Streaming auto-scroll, manual scroll-away detection, and lazy-content
    // re-pinning are all handled by use-stick-to-bottom's persistent
    // ResizeObserver — no manual scroll listeners or streaming effect needed.

    if (error) {
      // Deterministic escape hatch when auto-recovery (socket-reconnect resync,
      // TOKENS_REFRESHED_EVENT listener, visibility-change listener in
      // useSharedReactiveSession) didn't catch the error — e.g. the user
      // returns hours later and the only signal we'd otherwise act on was the
      // socket `connect` event that already happened with stale auth.
      return (
        <Alert
          type="error"
          title="Failed to load conversation"
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
            src={brandMarkHref()}
            alt={BRAND.name}
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
      const idShort = sessionId ? shortId(sessionId) : undefined;

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
                {idShort}
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
        ref={scrollRef}
        data-testid="conversation-scroll-container"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 0',
          minHeight: 0,
        }}
      >
        <div ref={contentRef}>
          {/* Genealogy Banner */}
          <GenealogyBanner />

          {/* Task-organized conversation */}
          {tasks.map((task, taskIndex) => (
            <TaskBlock
              key={task.task_id}
              task={task}
              agentic_tool={agentic_tool}
              sessionModel={sessionModel}
              userById={userById}
              currentUserId={currentUserId}
              isExpanded={forceExpandAll || expandedTaskIds.has(task.task_id)}
              onExpandChange={handleTaskExpandChange}
              sessionId={sessionId}
              onPermissionDecision={onPermissionDecision}
              branchName={branchName}
              scheduledFromBranch={scheduledFromBranch}
              scheduledRunAt={scheduledRunAt}
              streamingMessages={streamingMessagesByTask.get(task.task_id)}
              taskMessages={
                currentReactiveState?.messagesByTask.get(task.task_id) || EMPTY_MESSAGES
              }
              taskMessagesLoaded={!!currentReactiveState?.loadedTaskIds.has(task.task_id)}
              onLoadTaskMessages={handleLoadTaskMessages}
              onUnloadTaskMessages={handleUnloadTaskMessages}
              teammateEmoji={teammateEmoji}
              isLatestTask={taskIndex === tasks.length - 1}
              client={client}
            />
          ))}
        </div>
      </div>
    );
  }
);

ConversationView.displayName = 'ConversationView';
