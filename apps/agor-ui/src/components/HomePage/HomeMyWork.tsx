import type { Board, Branch, Session } from '@agor-live/client';
import { FilterOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons';
import {
  Badge,
  Button,
  Checkbox,
  Flex,
  Input,
  Popover,
  Segmented,
  Select,
  Typography,
  theme,
} from 'antd';
import { memo, useMemo, useState } from 'react';
import {
  type AgorState,
  agorStore,
  shallow,
  useAgorStore,
  useStoreWithEqualityFn,
} from '../../store/agorStore';
import { makeBoardSelector } from '../../store/selectors';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { sameName, teammateLabel } from '../../utils/teammateLabels';
import { BoardTile, getBoardEmoji } from '../BoardTile';
import { HomeContext, HomeList, HomePressable, HomeSessionRow } from './HomeRow';
import {
  HomeCard,
  HomeLink,
  HomeSection,
  HomeSheet,
  HomeShowMore,
  HomeSkeleton,
  useHomeCompact,
} from './HomeSection';
import { HOME_ROW_LEAD, homeGroupIndent, homeNestedIndent } from './homeLayout';

export const MY_WORK_PAGE = 20;

export type MyWorkTab = 'recent' | 'running';
export type MyWorkView = 'board' | 'list';

interface HomeMyWorkProps {
  recent: Session[];
  recentCount: number;
  running: Session[];
  /** Every running session, before the filters. */
  runningCount: number;
  /** Running sessions that pass the filters, uncapped. */
  runningMatchCount: number;
  hydrated: boolean;
  tab: MyWorkTab;
  onTabChange: (tab: MyWorkTab) => void;
  view: MyWorkView;
  onViewChange: (view: MyWorkView) => void;
  query: string;
  onQueryChange: (query: string) => void;
  onlyStartedByMe: boolean;
  onOnlyStartedByMeChange: (value: boolean) => void;
  onShowMore: () => void;
  onOpenSession: (sessionId: string) => void;
  onOpenBoard: (boardId: string) => void;
  onSeeAll: () => void;
}

const BoardGroupHeader: React.FC<{ boardId?: string; onOpenBoard: (id: string) => void }> = ({
  boardId,
  onOpenBoard,
}) => {
  const { token } = theme.useToken();
  const compact = useHomeCompact();
  const board = useAgorStore(useMemo(() => makeBoardSelector(boardId), [boardId]));
  return (
    <HomePressable
      onOpen={board && (() => onOpenBoard(board.board_id))}
      ariaLabel={`Open ${board?.name}`}
      align="center"
      gap={token.marginXS}
      style={{
        minHeight: compact ? MOBILE_TOUCH_TARGET : undefined,
        padding: `${token.paddingXS}px ${token.paddingSM}px`,
      }}
      trailing={
        board && (
          <Typography.Text
            type="secondary"
            aria-hidden
            className="agor-home-reveal"
            style={{ fontSize: token.fontSizeSM, paddingInlineEnd: token.paddingSM }}
          >
            {!compact && 'Open board '}
            <RightOutlined />
          </Typography.Text>
        )
      }
    >
      <BoardTile emoji={board ? getBoardEmoji(board) : undefined} size={HOME_ROW_LEAD} />
      <Typography.Text strong ellipsis style={{ flex: 1, minWidth: 0 }}>
        {board?.name ?? 'No board'}
      </Typography.Text>
    </HomePressable>
  );
};

interface BranchGroup {
  branchId: string;
  sessions: Session[];
  /** The branch or teammate is named like its board, so the board header says it. */
  redundant: boolean;
}

const NO_HOMES: never[] = [];

/** Each session's branch and board, flattened so a shallow compare skips unrelated patches. */
const makeHomesSelector = (sessions: Session[]) => (s: AgorState) =>
  sessions.flatMap((session) => {
    const branch = s.branchById.get(session.branch_id);
    return [branch, s.boardById.get(session.branch_board_id ?? branch?.board_id ?? '')];
  });

/** Board → branch or teammate → sessions, in the order the sessions arrive. */
function groupByBoard(sessions: Session[], homes: (Branch | Board | undefined)[]) {
  const boards = new Map<string, Map<string, BranchGroup>>();
  for (const [i, session] of sessions.entries()) {
    const branch = homes[2 * i] as Branch | undefined;
    const board = homes[2 * i + 1] as Board | undefined;
    const boardId = board?.board_id ?? '';
    const branches = boards.get(boardId) ?? new Map<string, BranchGroup>();
    boards.set(boardId, branches);
    const group = branches.get(session.branch_id);
    if (group) {
      group.sessions.push(session);
      continue;
    }
    branches.set(session.branch_id, {
      branchId: session.branch_id,
      sessions: [session],
      redundant: !!branch && !!board && sameName(teammateLabel(branch), board.name),
    });
  }
  return [...boards].map(([boardId, branches]) => ({ boardId, branches: [...branches.values()] }));
}

export const HomeMyWork = memo(function HomeMyWork({
  recent,
  recentCount,
  running,
  runningCount,
  runningMatchCount,
  hydrated,
  tab,
  onTabChange,
  view,
  onViewChange,
  query,
  onQueryChange,
  onlyStartedByMe,
  onOnlyStartedByMeChange,
  onShowMore,
  onOpenSession,
  onOpenBoard,
  onSeeAll,
}: HomeMyWorkProps) {
  const { token } = theme.useToken();
  const compact = useHomeCompact();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sessions = tab === 'running' ? running : recent;
  const filtered = !!query.trim() || onlyStartedByMe;
  const total = tab === 'running' ? runningMatchCount : recentCount;
  const grouped = tab === 'recent' && view === 'board';
  const homes = useStoreWithEqualityFn(
    agorStore,
    useMemo(() => (grouped ? makeHomesSelector(sessions) : () => NO_HOMES), [grouped, sessions]),
    shallow
  );
  const groups = useMemo(
    () => (grouped ? groupByBoard(sessions, homes) : []),
    [grouped, sessions, homes]
  );
  const showLogo = sessions.some((s) => s.agentic_tool !== sessions[0]?.agentic_tool);
  const activeFilters = Number(onlyStartedByMe);

  const clearFilters = () => {
    onQueryChange('');
    onOnlyStartedByMeChange(false);
  };
  const empty =
    filtered && (tab === 'recent' || runningCount > 0) ? (
      <>
        No {tab === 'running' ? 'running sessions' : 'sessions'} match{' '}
        {query.trim() ? `“${query}”` : 'your filters'}.{' '}
        <HomeLink onClick={clearFilters}>Clear filters</HomeLink>
      </>
    ) : tab === 'running' ? (
      'No agents running right now.'
    ) : (
      'Nothing here yet.'
    );

  // A view, not a filter: in the toolbar where it fits, in the Filters sheet on phones.
  const viewSelect = (
    <Select<MyWorkView>
      value={view}
      onChange={onViewChange}
      prefix="View"
      styles={{ prefix: { color: token.colorTextSecondary } }}
      aria-label="View"
      popupMatchSelectWidth={false}
      style={{ flex: '0 0 auto' }}
      options={[
        { value: 'list', label: 'List' },
        { value: 'board', label: 'By board' },
      ]}
    />
  );
  const filters = (
    <Flex vertical gap={token.marginSM} style={{ minWidth: 220 }}>
      {compact && viewSelect}
      <Checkbox
        checked={onlyStartedByMe}
        onChange={(e) => onOnlyStartedByMeChange(e.target.checked)}
      >
        Only sessions I started
      </Checkbox>
    </Flex>
  );
  const filtersButton = (
    <Badge count={activeFilters} size="small">
      <Button
        icon={<FilterOutlined />}
        aria-label="Filters"
        onClick={compact ? () => setFiltersOpen(true) : undefined}
      >
        {!compact && 'Filters'}
      </Button>
    </Badge>
  );

  return (
    <HomeSection
      id="mywork"
      title="My work"
      extra={<HomeLink onClick={onSeeAll}>See all sessions</HomeLink>}
    >
      {!hydrated && recent.length === 0 && running.length === 0 ? (
        <HomeSkeleton rows={6} />
      ) : (
        <HomeCard>
          <Flex
            align="center"
            gap={token.marginXS}
            data-home-toolbar
            style={{
              padding: `${token.paddingXS}px ${token.paddingSM}px`,
              borderBottom: `1px solid ${token.colorSplit}`,
            }}
          >
            <Segmented<MyWorkTab>
              value={tab}
              onChange={onTabChange}
              style={{ flex: '0 0 auto' }}
              options={[
                { value: 'recent', label: 'Recent' },
                {
                  value: 'running',
                  label: hydrated && runningCount ? `Running ${runningCount}` : 'Running',
                },
              ]}
            />
            <Input
              allowClear
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
              placeholder={compact ? 'Filter' : 'Filter by title, branch, assistant or board'}
              aria-label="Filter sessions"
              style={{ flex: 1, minWidth: 0 }}
            />
            {!compact && viewSelect}
            {compact ? (
              filtersButton
            ) : (
              <Popover trigger="click" placement="bottomRight" content={filters}>
                {filtersButton}
              </Popover>
            )}
          </Flex>
          {compact && (
            <HomeSheet open={filtersOpen} title="Filters" onClose={() => setFiltersOpen(false)}>
              {filters}
            </HomeSheet>
          )}
          {sessions.length === 0 ? (
            <Typography.Text
              type="secondary"
              style={{ display: 'block', padding: token.paddingSM }}
            >
              {empty}
            </Typography.Text>
          ) : grouped ? (
            groups.map(({ boardId, branches }) => (
              <div key={boardId}>
                <div
                  style={{
                    background: token.colorFillQuaternary,
                    borderBottom: `1px solid ${token.colorSplit}`,
                  }}
                >
                  <BoardGroupHeader boardId={boardId || undefined} onOpenBoard={onOpenBoard} />
                </div>
                {branches.map(({ branchId, sessions: items, redundant }) => (
                  <div key={branchId}>
                    {!redundant && (
                      <Flex
                        align="center"
                        gap={token.marginXS}
                        style={{
                          padding: `${token.paddingXXS}px ${token.paddingSM}px`,
                          paddingInlineStart:
                            token.paddingSM + (compact ? 0 : homeGroupIndent(token)),
                        }}
                      >
                        <HomeContext branchId={branchId} showBoard={false} />
                        {items.length > 1 && (
                          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                            {items.length} sessions
                          </Typography.Text>
                        )}
                      </Flex>
                    )}
                    <HomeList
                      items={items}
                      itemKey={(session) => session.session_id}
                      renderItem={(session) => (
                        <HomeSessionRow
                          session={session}
                          showContext={false}
                          showLogo={showLogo}
                          indent={
                            compact
                              ? token.paddingSM
                              : redundant
                                ? homeGroupIndent(token)
                                : homeNestedIndent(token)
                          }
                          onOpen={onOpenSession}
                        />
                      )}
                    />
                  </div>
                ))}
              </div>
            ))
          ) : (
            <HomeList
              items={sessions}
              itemKey={(session) => session.session_id}
              renderItem={(session) => (
                <HomeSessionRow session={session} showLogo={showLogo} onOpen={onOpenSession} />
              )}
            />
          )}
          {total > sessions.length && (
            <HomeShowMore
              label={`Show ${Math.min(total - sessions.length, MY_WORK_PAGE)} more`}
              onClick={onShowMore}
            />
          )}
        </HomeCard>
      )}
    </HomeSection>
  );
});
