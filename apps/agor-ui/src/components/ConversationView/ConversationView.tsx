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

import type {
  AgenticToolName,
  AgorClient,
  Message,
  PermissionScope,
  SessionID,
  User,
} from '@agor-live/client';
import { shortId, TaskStatus } from '@agor-live/client';
import { BranchesOutlined, CopyOutlined, ForkOutlined } from '@ant-design/icons';
import { Alert, Button, Spin, Typography, theme } from 'antd';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { useSharedReactiveSession } from '../../hooks/useSharedReactiveSession';
import { useStreamingMessagesByTask } from '../../hooks/useStreamingMessagesByTask';
import { useCopyToClipboard } from '../../utils/clipboard';
import { BrandMark } from '../BrandMark';
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

  onOpenAgenticToolSettings?: (tool: AgenticToolName) => void;

  /** Use the denser, full-width task treatment for phone-sized session routes. */
  compact?: boolean;
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
    onOpenAgenticToolSettings,
    compact = false,
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

    // The hook observes content growth, not changes to the scroll viewport.
    // A queue/composer resize changes only the latter. Reconcile through the
    // same bottom lock so a scrolled-up reader is never pulled away.
    const viewportCleanupRef = useRef<(() => void) | null>(null);
    const setScrollViewport = useCallback(
      (element: HTMLDivElement | null) => {
        viewportCleanupRef.current?.();
        viewportCleanupRef.current = null;
        scrollRef(element);
        if (!element) return;
        let height = element.clientHeight;
        let resizeGeneration = 0;
        let guardedDifference = 0;
        const observer = new ResizeObserver(() => {
          const nextHeight = element.clientHeight;
          if (nextHeight === height) return;
          const difference = nextHeight - height;
          height = nextHeight;
          const generation = ++resizeGeneration;
          // Share the hook's resize guard: growing the viewport can make the
          // browser clamp scrollTop upward before its deferred scroll handler.
          // That is layout, not a reader escaping the bottom lock.
          state.resizeDifference = difference;
          guardedDifference = difference;
          requestAnimationFrame(() => {
            setTimeout(() => {
              // Consecutive frames can resize by the same number of pixels.
              // An older timer must not clear the newer frame's scroll guard.
              if (resizeGeneration === generation && state.resizeDifference === difference) {
                state.resizeDifference = 0;
              }
            }, 1);
          });
          if (state.isAtBottom && !state.escapedFromLock) {
            scrollToBottom({ animation: 'instant' });
          }
        });
        observer.observe(element);
        viewportCleanupRef.current = () => {
          ++resizeGeneration;
          observer.disconnect();
          if (state.resizeDifference === guardedDifference) state.resizeDifference = 0;
        };
      },
      [scrollRef, scrollToBottom, state]
    );

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
        reactiveOptions: { taskHydration: 'lean' },
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

    // Stable task-scoped detail loading; the transcript itself never collapses.
    const handleLoadTaskMessages = useCallback(
      (taskId: string) => {
        if (!reactiveSession) return;
        return reactiveSession.loadTaskMessages(taskId).then(() => undefined);
      },
      [reactiveSession]
    );

    const [loadingOlder, setLoadingOlder] = useState(false);
    const olderInflight = useRef<object | null>(null);
    const previousScrollTop = useRef(0);
    const olderAnchor = useRef<{
      element: HTMLElement;
      top: number;
      sessionId: SessionID | null;
    } | null>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: reset view-local paging ownership when the session handle changes.
    useLayoutEffect(() => {
      olderInflight.current = null;
      olderAnchor.current = null;
      previousScrollTop.current = 0;
      setLoadingOlder(false);
      return () => {
        olderInflight.current = null;
        olderAnchor.current = null;
      };
    }, [reactiveSession]);
    const loadOlder = useCallback(async () => {
      if (!reactiveSession || olderInflight.current || !currentReactiveState?.hasOlderTasks) return;
      const viewport = scrollRef.current;
      if (!viewport) return;
      stopScroll();
      const anchor = Array.from(viewport.querySelectorAll<HTMLElement>('[data-task-block]')).find(
        (element) => element.getBoundingClientRect().bottom >= viewport.getBoundingClientRect().top
      );
      if (anchor)
        olderAnchor.current = {
          element: anchor,
          top: anchor.getBoundingClientRect().top,
          sessionId,
        };
      const request = {};
      olderInflight.current = request;
      setLoadingOlder(true);
      try {
        await reactiveSession.loadOlderTasks();
      } catch {
        /* Existing history stays visible; the state carries a retryable error. */
      } finally {
        if (olderInflight.current === request) {
          olderInflight.current = null;
          setLoadingOlder(false);
        }
      }
    }, [reactiveSession, currentReactiveState?.hasOlderTasks, scrollRef, stopScroll, sessionId]);
    useLayoutEffect(() => {
      const anchor = olderAnchor.current;
      if (!anchor || loadingOlder || !scrollRef.current) return;
      if (anchor.sessionId === sessionId && anchor.element.isConnected) {
        scrollRef.current.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top;
        previousScrollTop.current = scrollRef.current.scrollTop;
      }
      olderAnchor.current = null;
    }, [loadingOlder, scrollRef, sessionId]);

    // Streaming auto-scroll, manual scroll-away detection, and lazy-content
    // re-pinning are all handled by use-stick-to-bottom's persistent
    // ResizeObserver — no manual scroll listeners or streaming effect needed.

    if (error && (isTerminalError || tasks.length === 0)) {
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
          <BrandMark size={160} style={{ opacity: 0.5 }} />
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
        ref={setScrollViewport}
        data-testid="conversation-scroll-container"
        onWheel={(event) => {
          // At the top (including an underfilled page), upward intent cannot
          // produce a scroll event. Fetch one page; loadOlder coalesces bursts.
          if (event.deltaY < 0 && event.currentTarget.scrollTop <= 0) void loadOlder();
        }}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          if (top < previousScrollTop.current && top < 80) void loadOlder();
          previousScrollTop.current = top;
        }}
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

          {error && <Alert type="error" title={error} />}
          {currentReactiveState?.hasOlderTasks && (
            <Button loading={loadingOlder} onClick={() => void loadOlder()}>
              Load older history
            </Button>
          )}
          {/* Task-organized conversation */}
          {tasks.map((task, taskIndex) => (
            <TaskBlock
              key={task.task_id}
              task={task}
              latestActivity={currentReactiveState?.toolsByTask.get(task.task_id)?.at(-1)}
              agentic_tool={agentic_tool}
              sessionModel={sessionModel}
              userById={userById}
              currentUserId={currentUserId}
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
              teammateEmoji={teammateEmoji}
              isLatestTask={taskIndex === tasks.length - 1}
              client={client}
              onOpenAgenticToolSettings={onOpenAgenticToolSettings}
              compact={compact}
            />
          ))}
        </div>
      </div>
    );
  }
);

ConversationView.displayName = 'ConversationView';
