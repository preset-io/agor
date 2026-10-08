import type { AgorClient, HomeWorkView, User } from '@agor-live/client';
import { HOME_WORK_VIEWS, hasMinimumRole, ROLES } from '@agor-live/client';
import { PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Dropdown, Flex, Skeleton, Typography, theme } from 'antd';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useConnectionDisabled, useConnectionState } from '../../contexts/ConnectionContext';
import type { NewSessionConfig, SessionCreationResult } from '../../domain/sessionCreation';
import { useCommentsForYou } from '../../hooks/useCommentsForYou';
import { useConfirmArchiveSession } from '../../hooks/useConfirmArchiveSession';
import { useIdleReady } from '../../hooks/useIdleReady';
import { useIsMobileViewport } from '../../hooks/useIsMobileViewport';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useStableCallback } from '../../hooks/useStableCallback';
import { useUserLocalStorage } from '../../hooks/useUserLocalStorage';
import {
  type AgorState,
  agorStore,
  shallow,
  useAgorStore,
  useStoreWithEqualityFn,
} from '../../store/agorStore';
import {
  compareHomeNeeds,
  type HomeCommentNeed,
  type HomeSessionNeed,
  isUnreadResult,
  lastRunStartedAt,
  makeHomeBucketsSelector,
} from '../../store/selectors';
import { useThemedMessage } from '../../utils/message';
import { runWithLimit } from '../../utils/promisePool';
import {
  OPEN_BOARD_SWITCHER_EVENT,
  OPEN_GLOBAL_SEARCH_EVENT,
  requestShellPicker,
} from '../../utils/shellEvents';
import { patchUserPreferences } from '../../utils/userPreferences';
import { type CreateTab, createMenuItems } from '../CreateDialog/createMenuItems';
import { HomeAskBox } from './HomeAskBox';
import { HomeKnowledgeSection } from './HomeKnowledgeSection';
import { HomeMyWork, MY_WORK_PAGE, type MyWorkTab } from './HomeMyWork';
import { HomeNeedsYou, NEEDS_MAX, NEEDS_PREVIEW, type NeedsFilter } from './HomeNeedsYou';
import { HomeRecentBoards } from './HomeRecentBoards';
import { HomeFrame } from './HomeSection';
import { HomeTeammatesSection } from './HomeTeammates';
import { HOME_MAIN_COLUMN_BASIS, HOME_PAGE_TITLE_LEVEL, HOME_RAIL_BASIS } from './homeLayout';
import { OnboardingCard } from './OnboardingCard';

const RECENT_BOARDS = 5;
const ONBOARDING_HIDDEN_KEY = 'agor:onboarding-card-hidden';
// Longer than the 7-day failure window, since a later patch can keep an old failure in view.
const OPENED_FAILURES_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Mark all as read patches a few sessions at a time, not the whole backlog at once. */
const MARK_ALL_CONCURRENCY = 4;
const NO_BOARD_IDS: string[] = [];
/** Opened failure → the run it showed (server clock) and when it was opened; a bare number is the older click-time form. */
type OpenedFailure = number | { run: number; at: number };
const NO_OPENED_FAILURES: Record<string, OpenedFailure> = {};
const openedField = (entry: unknown, field: 'run' | 'at'): number => {
  if (typeof entry === 'number') return entry;
  const value = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[field] : 0;
  return typeof value === 'number' ? value : 0;
};
const openedAt = (entry: OpenedFailure) => openedField(entry, 'at');
const openedRun = (entry: OpenedFailure) => openedField(entry, 'run');
// A stored container that isn't a plain object (null, a list, a number) reads as empty.
const asOpenedFailures = (stored: unknown): Record<string, OpenedFailure> =>
  stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, OpenedFailure>)
    : NO_OPENED_FAILURES;

const isHomeWorkView = (value: unknown): value is HomeWorkView =>
  HOME_WORK_VIEWS.includes(value as HomeWorkView);

/** Route state other surfaces use to land on part of Home. */
export interface HomeLocationState {
  needsFilter?: NeedsFilter;
}

export interface HomePageProps {
  client: AgorClient | null;
  currentUser?: User | null;
  recentBoardIds?: string[];
  onBoardClick: (boardId: string) => void;
  /** `boardId` is where the branch lives, for callers that can't find the branch itself. */
  onBranchClick: (branchId: string, boardId: string) => void;
  onSessionClick: (sessionId: string) => void;
  /** Omitted for callers who can't start sessions: the ask box hides. */
  onCreateSession?: (
    config: NewSessionConfig,
    boardId: string
  ) => Promise<SessionCreationResult | null>;
  /** Header New menu and onboarding steps; the phone shell creates from its More sheet instead. */
  onOpenCreateDialog?: (tab: CreateTab, boardId?: string) => void;
  onOpenSettings?: (section: 'repos' | 'mcp' | 'users') => void;
  /** Defaults to the header board switcher. */
  onAllBoards?: () => void;
  /** Defaults to header search filtered to sessions. */
  onSeeAllSessions?: () => void;
  /** Opens the teammates directory; the rail's "See all" hides without it. */
  onSeeAllTeammates?: () => void;
}

const scrollToSection = (id: string) =>
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

const focusAsk = () => {
  scrollToSection('ask');
  document.querySelector<HTMLTextAreaElement>('#ask textarea')?.focus();
};

function greeting(date = new Date()) {
  const hour = date.getHours();
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

const selectHydrated = (s: AgorState) => s.sessionsHydrated && s.branchesHydrated;

/** Onboarding steps the caller can perform, subscribed only while the card can still show. */
const HomeOnboarding: React.FC<{
  isAdmin: boolean;
  /** Without it there is no ask box, so the session step hides. */
  canStartSessions: boolean;
  onOpenCreateDialog?: HomePageProps['onOpenCreateDialog'];
  onOpenSettings: NonNullable<HomePageProps['onOpenSettings']>;
  onDismiss: () => void;
}> = ({ isAdmin, canStartSessions, onOpenCreateDialog, onOpenSettings, onDismiss }) => {
  const done = useStoreWithEqualityFn(
    agorStore,
    (s) => ({
      repo: s.repoById.size > 0,
      board: s.boardById.size > 0,
      mcp: s.mcpServerById.size > 0,
      invite: s.userById.size > 1,
    }),
    shallow
  );
  const steps = [
    {
      id: 'repo',
      label: 'Connect a repository',
      cta: 'Connect',
      done: done.repo,
      onClick: () => onOpenSettings('repos'),
    },
    {
      id: 'board',
      label: 'Create your first board',
      cta: 'Create',
      done: done.board,
      onClick: onOpenCreateDialog && (() => onOpenCreateDialog('board')),
    },
    ...(canStartSessions
      ? [
          {
            id: 'session',
            label: 'Launch an AI session',
            cta: 'Start',
            done: false,
            onClick: onOpenCreateDialog ? () => onOpenCreateDialog('teammate') : focusAsk,
          },
        ]
      : []),
    ...(isAdmin ? adminSteps(done, onOpenSettings) : []),
  ];
  if (steps.every((step) => step.done)) return null;
  return <OnboardingCard steps={steps} onDismiss={onDismiss} />;
};

/** Workspace setup only admins can do. */
const adminSteps = (
  done: { mcp: boolean; invite: boolean },
  onOpenSettings: NonNullable<HomePageProps['onOpenSettings']>
) => [
  {
    id: 'mcp',
    label: 'Configure MCP tools',
    cta: 'Set up',
    done: done.mcp,
    onClick: () => onOpenSettings('mcp'),
  },
  {
    id: 'invite',
    label: 'Invite a teammate',
    cta: 'Invite',
    done: done.invite,
    onClick: () => onOpenSettings('users'),
  },
];

export const HomePage = memo(function HomePage({
  client,
  currentUser,
  recentBoardIds = NO_BOARD_IDS,
  onBoardClick,
  onBranchClick,
  onSessionClick,
  onCreateSession,
  onOpenCreateDialog,
  onOpenSettings,
  onAllBoards,
  onSeeAllSessions,
  onSeeAllTeammates,
}: HomePageProps) {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobileViewport();
  const { connected, connecting } = useConnectionState();
  const mutationDisabled = useConnectionDisabled();
  const railReady = useIdleReady();
  const confirmArchive = useStableCallback(useConfirmArchiveSession(client));
  const userId = currentUser?.user_id;

  const [needsFilter, setNeedsFilter] = useState<NeedsFilter>('all');
  const [needsExpanded, setNeedsExpanded] = useState(false);
  const [tab, setTab] = useState<MyWorkTab>('recent');
  // This visit's pick wins over the loaded record; keyed by user so it never crosses accounts.
  const [viewPick, setViewPick] = useState<{ userId?: string; view: HomeWorkView }>();
  const savedView = currentUser?.preferences?.homeWorkView;
  const workView: HomeWorkView =
    viewPick && viewPick.userId === userId
      ? viewPick.view
      : isHomeWorkView(savedView)
        ? savedView
        : HOME_WORK_VIEWS[0];
  const viewWrites = useRef(Promise.resolve());
  const changeWorkView = useCallback(
    (view: HomeWorkView) => {
      setViewPick({ userId, view });
      if (!client || !userId) return;
      // Chained so the last pick lands last; a failed write keeps the pick on this device.
      viewWrites.current = viewWrites.current
        .then(async () => {
          await patchUserPreferences(client, userId, { homeWorkView: view });
        })
        .catch(() => {});
    },
    [client, userId]
  );
  const [onlyStartedByMe, setOnlyStartedByMe] = useUserLocalStorage(
    userId,
    'home-only-mine',
    false
  );
  const [storedOpenedFailures, setOpenedFailures] = useUserLocalStorage(
    userId,
    'home-opened-failures',
    NO_OPENED_FAILURES
  );
  const openedRuns = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(asOpenedFailures(storedOpenedFailures)).map(([id, entry]) => [
          id,
          openedRun(entry),
        ])
      ),
    [storedOpenedFailures]
  );
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [workLimit, setWorkLimit] = useState(MY_WORK_PAGE);
  // Frozen at mount: Home unmounts on navigation, so the 7-day failure window stays fresh enough.
  const [now] = useState(Date.now);
  const [onboardingHidden, setOnboardingHidden] = useLocalStorage(ONBOARDING_HIDDEN_KEY, false);

  const hydrated = useAgorStore(selectHydrated);
  // Visit history that still names live boards; when none do, recent sessions stand in.
  const visitedBoardIds = useStoreWithEqualityFn(
    agorStore,
    useMemo(
      () => (s: AgorState) =>
        recentBoardIds.filter((id) => {
          const board = s.boardById.get(id);
          return !!board && !board.archived;
        }),
      [recentBoardIds]
    ),
    shallow
  );
  const buckets = useStoreWithEqualityFn(
    agorStore,
    useMemo(
      () =>
        makeHomeBucketsSelector({
          userId,
          now,
          needsLimit: needsExpanded ? NEEDS_MAX : NEEDS_PREVIEW,
          recentLimit: workLimit,
          boardsLimit: visitedBoardIds.length ? 0 : RECENT_BOARDS,
          query: deferredQuery,
          onlyStartedByMe,
          openedFailures: openedRuns,
        }),
      [
        userId,
        now,
        needsExpanded,
        workLimit,
        visitedBoardIds.length,
        deferredQuery,
        onlyStartedByMe,
        openedRuns,
      ]
    ),
    shallow
  );
  const comments = useCommentsForYou(client, currentUser);
  const needsLimit = needsExpanded ? NEEDS_MAX : NEEDS_PREVIEW;
  const needs = useMemo(
    () =>
      (needsFilter === 'comments'
        ? comments
        : [...buckets.needs, ...comments].sort(compareHomeNeeds)
      ).slice(0, needsLimit),
    [needsFilter, comments, buckets.needs, needsLimit]
  );
  const needsCount = buckets.needsCount + comments.length;
  const newUser = hydrated && !buckets.hasSessions && comments.length === 0;

  useEffect(() => {
    if (!comments.length) setNeedsFilter('all');
  }, [comments.length]);

  // A landing filter applies once there is something to show, then leaves the history entry.
  const routeFilter = (location.state as HomeLocationState | null)?.needsFilter;
  const { pathname, search, hash } = location;
  useEffect(() => {
    if (!routeFilter) return;
    const applicable = routeFilter !== 'comments' || comments.length > 0;
    if (!applicable && !hydrated) return;
    if (applicable) setNeedsFilter(routeFilter);
    requestAnimationFrame(() => scrollToSection('needs'));
    navigate({ pathname, search, hash }, { replace: true, state: null });
  }, [routeFilter, comments.length, hydrated, navigate, pathname, search, hash]);

  const openComment = useCallback(
    ({ thread }: HomeCommentNeed) => {
      if (thread.session_id) onSessionClick(thread.session_id);
      else if (thread.branch_id) onBranchClick(thread.branch_id, thread.board_id);
      else onBoardClick(thread.board_id);
    },
    [onBoardClick, onBranchClick, onSessionClick]
  );
  // A group header stands for its earlier failures too, so opening it marks every one seen.
  const openFailure = useCallback(
    (need: HomeSessionNeed) => {
      const now = Date.now();
      const cutoff = now - OPENED_FAILURES_WINDOW_MS;
      const { sessionById } = agorStore.getState();
      const opened = [need.session, ...(need.earlier ?? [])].map(({ session_id }) => {
        const session = sessionById.get(session_id);
        // The run the person saw, on the server clock, so only a newer run brings the failure back.
        return [session_id, { run: session ? lastRunStartedAt(session) : now, at: now }] as const;
      });
      setOpenedFailures((prev) => ({
        ...Object.fromEntries(
          Object.entries(asOpenedFailures(prev)).filter(([, entry]) => openedAt(entry) > cutoff)
        ),
        ...Object.fromEntries(opened),
      }));
      onSessionClick(need.session.session_id);
    },
    [onSessionClick, setOpenedFailures]
  );
  const markRead = useCallback(
    (sessionId: string) => {
      client
        ?.service('sessions')
        .patch(sessionId, { ready_for_prompt: false })
        .catch(() => showError('Couldn’t mark as read'));
    },
    [client, showError]
  );
  const [markingAll, setMarkingAll] = useState(false);
  const markAllRead = useCallback(async () => {
    if (!client) return;
    const ids = [...agorStore.getState().sessionById.values()]
      .filter((s) => s.created_by === userId && !s.archived && isUnreadResult(s))
      .map((s) => s.session_id);
    setMarkingAll(true);
    try {
      const failed = await runWithLimit(ids, MARK_ALL_CONCURRENCY, (id) =>
        client.service('sessions').patch(id, { ready_for_prompt: false })
      );
      if (failed.length === ids.length && failed.length) showError('Couldn’t mark as read');
      else if (failed.length) showError(`Couldn’t mark ${failed.length} of ${ids.length} as read`);
    } finally {
      setMarkingAll(false);
    }
  }, [client, userId, showError]);
  const showMoreWork = useCallback(() => setWorkLimit((limit) => limit + MY_WORK_PAGE), []);
  const archive = useCallback((sessionId: string) => confirmArchive(sessionId), [confirmArchive]);
  const showRunning = useCallback(() => {
    setTab('running');
    scrollToSection('mywork');
  }, []);
  const jumpToNeeds = useCallback(() => scrollToSection('needs'), []);
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const allBoards = useCallback(
    () => (onAllBoards ?? (() => requestShellPicker(OPEN_BOARD_SWITCHER_EVENT)))(),
    [onAllBoards]
  );
  const seeAllSessions = useCallback(
    () => (onSeeAllSessions ?? (() => requestShellPicker(OPEN_GLOBAL_SEARCH_EVENT, 'session')))(),
    [onSeeAllSessions]
  );

  const firstName = currentUser?.name?.trim().split(/\s+/)[0] || 'there';
  // Waits for hydration so returning users never see it flash on a cold load.
  const onboarding = hydrated && !onboardingHidden && onOpenSettings && !buckets.hasSessions && (
    <HomeOnboarding
      isAdmin={isAdmin}
      canStartSessions={!!onCreateSession}
      onOpenCreateDialog={onOpenCreateDialog}
      onOpenSettings={onOpenSettings}
      onDismiss={() => setOnboardingHidden(true)}
    />
  );
  const textButton = { paddingInline: 0 };

  return (
    <HomeFrame>
      {!isMobile && !connected && (
        <Alert
          type={connecting ? 'info' : 'warning'}
          showIcon
          title={
            connecting
              ? 'Reconnecting… showing what we had before the connection dropped.'
              : 'You’re offline. Showing what we had before the connection dropped.'
          }
        />
      )}
      <div style={{ minWidth: 0 }}>
        <Flex align="center" justify="space-between" gap={token.marginSM}>
          <Typography.Title level={HOME_PAGE_TITLE_LEVEL} style={{ margin: 0, minWidth: 0 }}>
            Good {greeting()}, {firstName}
          </Typography.Title>
          {onOpenCreateDialog && (
            <Dropdown
              trigger={['click']}
              menu={{
                items: createMenuItems(isAdmin),
                onClick: ({ key }) => onOpenCreateDialog(key as CreateTab),
              }}
            >
              <Button icon={<PlusOutlined />}>New</Button>
            </Dropdown>
          )}
        </Flex>
        {!hydrated ? (
          <Skeleton.Input active size="small" style={{ width: 220 }} />
        ) : (
          !newUser && (
            <Flex align="center" gap={token.marginXS} wrap>
              <Button type="text" size="small" style={textButton} onClick={jumpToNeeds}>
                {needsCount ? (
                  <span>
                    <Typography.Text strong>{needsCount}</Typography.Text> need you
                  </span>
                ) : (
                  'All caught up'
                )}
              </Button>
              {buckets.runningCount > 0 && (
                <>
                  <Typography.Text type="secondary" aria-hidden>
                    ·
                  </Typography.Text>
                  <Button type="text" size="small" style={textButton} onClick={showRunning}>
                    <span>
                      <Typography.Text strong>{buckets.runningCount}</Typography.Text> running
                    </span>
                  </Button>
                </>
              )}
            </Flex>
          )
        )}
      </div>
      <HomeRecentBoards
        recentBoardIds={visitedBoardIds.length ? visitedBoardIds : buckets.boardIds}
        onBoardClick={onBoardClick}
        onAllBoards={allBoards}
      />
      {onCreateSession && (
        <div id="ask">
          <HomeAskBox
            client={client}
            currentUser={currentUser}
            hasSessions={!hydrated || buckets.hasSessions}
            disabled={mutationDisabled}
            onCreateSession={onCreateSession}
            onOpenSession={onSessionClick}
          />
        </div>
      )}
      <Flex gap={token.marginXL} wrap align="flex-start">
        <Flex
          vertical
          gap={token.marginXL}
          style={{ flex: `999 1 ${HOME_MAIN_COLUMN_BASIS}px`, minWidth: 0 }}
        >
          {!newUser && (
            <HomeNeedsYou
              client={client}
              needs={needs}
              needsCount={needsCount}
              needsByReason={buckets.needsByReason}
              commentCount={comments.length}
              filter={needsFilter}
              onFilterChange={setNeedsFilter}
              expanded={needsExpanded}
              onExpandedChange={setNeedsExpanded}
              hydrated={hydrated}
              onOpenSession={onSessionClick}
              onOpenFailure={openFailure}
              onOpenComment={openComment}
              onMarkRead={markRead}
              onMarkAllRead={client && buckets.unreadCount > 0 ? markAllRead : undefined}
              markingAllRead={markingAll}
              markAllReadDisabled={mutationDisabled}
              onArchive={mutationDisabled ? undefined : archive}
            />
          )}
          {onboarding}
          <HomeMyWork
            recent={buckets.recent}
            recentCount={buckets.recentCount}
            running={buckets.running}
            runningCount={buckets.runningCount}
            runningMatchCount={buckets.runningMatchCount}
            hydrated={hydrated}
            tab={tab}
            onTabChange={setTab}
            view={workView}
            onViewChange={changeWorkView}
            query={query}
            onQueryChange={setQuery}
            onlyStartedByMe={onlyStartedByMe}
            onOnlyStartedByMeChange={setOnlyStartedByMe}
            onOpenSession={onSessionClick}
            onShowMore={showMoreWork}
            onOpenBoard={onBoardClick}
            onSeeAll={seeAllSessions}
          />
        </Flex>
        {railReady && (
          <Flex
            vertical
            gap={token.marginXL}
            style={{ flex: `1 1 ${HOME_RAIL_BASIS}px`, minWidth: 0 }}
          >
            <HomeTeammatesSection
              client={client}
              currentUser={currentUser}
              checkAccess={!!onCreateSession}
              onOpenBoard={onBoardClick}
              onSeeAll={onSeeAllTeammates}
            />
            <HomeKnowledgeSection client={client} connected={connected} />
          </Flex>
        )}
      </Flex>
    </HomeFrame>
  );
});

export default HomePage;
