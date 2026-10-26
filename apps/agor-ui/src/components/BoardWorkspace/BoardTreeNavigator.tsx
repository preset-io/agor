import type { Board, Branch, Session } from '@agor-live/client';
import { isTeammate } from '@agor-live/client';
import { SettingOutlined } from '@ant-design/icons';
import {
  Button,
  Collapse,
  Empty,
  Flex,
  Input,
  Select,
  Skeleton,
  Space,
  Tabs,
  Typography,
  theme,
} from 'antd';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useBranchAccess } from '../../hooks/useBranchAccess';
import { useAgorStore } from '../../store/agorStore';
import { makeBoardPartitionSelector } from '../../store/boardPartitions';
import {
  makeSessionsForBranchSelector,
  selectBranchById,
  selectCommentById,
  selectUserById,
} from '../../store/selectors';
import { canStartSessions } from '../../utils/branchAccess';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { getRouterBasename } from '../../utils/uiRoutes';
import {
  BoardTeammatePanel,
  type BoardTeammatePanelProps,
} from '../BoardTeammatePanel/BoardTeammatePanel';
import { BranchSessionSections } from '../BranchCard';
import { BranchFilesystemRecovery } from '../BranchFilesystemRecovery';
import { CommentsPanel } from '../CommentsPanel';
import { BoardPartitionError } from '../SessionCanvas/BoardPartitionStatus';
import { type BoardContentSelection, useBoardContentEntries } from './BoardContent';
import { branchTreeLabel, sortBoardTreeBranches } from './boardTree';
import type { BoardViewPreferences } from './useBoardViewPreferences';
import { boardViewPreferenceKey } from './useBoardViewPreferences';

const EMPTY_SESSIONS: Session[] = [];
const EMPTY_SESSION_MAP = new Map<string, Session[]>();
const BranchSessions = memo(function BranchSessions({
  branch,
  actions,
}: {
  branch: Branch;
  actions: BoardTeammatePanelProps;
}) {
  const sessions =
    useAgorStore(
      useMemo(() => makeSessionsForBranchSelector(branch.branch_id), [branch.branch_id])
    ) ?? EMPTY_SESSIONS;
  const users = useAgorStore(selectUserById);
  const user = actions.currentUserId ? users.get(actions.currentUserId) : undefined;
  const access = useBranchAccess(actions.client, branch, user, true);
  const canCreate =
    typeof access === 'object' && canStartSessions(access) && !branch.deletion_status;
  return (
    <>
      <BranchFilesystemRecovery branch={branch} client={actions.client} currentUser={user} />
      <BranchSessionSections
        branch={branch}
        sessions={sessions}
        userById={users}
        currentUserId={actions.currentUserId}
        selectedSessionId={actions.selectedSessionId}
        onSessionClick={actions.onSessionClick}
        onCreateSession={canCreate ? actions.onCreateSession : undefined}
        onForkSession={actions.onForkSession}
        onSpawnSession={actions.onSpawnSession}
        onOpenSessionSettings={actions.onOpenSessionSettings}
        preferenceScope={
          actions.currentUserId && actions.board
            ? boardViewPreferenceKey(
                getRouterBasename(),
                actions.currentUserId,
                actions.board.board_id
              )
            : undefined
        }
        mode="panel"
        client={actions.client}
      />
    </>
  );
});

export function BoardTreeNavigator({
  board,
  branches,
  actions,
  preferences,
  updatePreferences,
  onBranchClick,
  onContentClick,
}: {
  board: Board;
  branches: Branch[];
  actions: BoardTeammatePanelProps;
  preferences: BoardViewPreferences;
  updatePreferences: (patch: Partial<BoardViewPreferences>) => void;
  onBranchClick: (id: string) => void;
  onContentClick: (selection: BoardContentSelection) => void;
}) {
  const { token } = theme.useToken();
  const [query, setQuery] = useState('');
  const [searchedCommentId, setSearchedCommentId] = useState<string | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTop = useRef(preferences.scrollTop);
  const sessionsByBranch = useAgorStore((state) =>
    preferences.sort === 'recent' || query.trim() ? state.sessionsByBranch : EMPTY_SESSION_MAP
  );
  const users = useAgorStore(selectUserById);
  const branchById = useAgorStore(selectBranchById);
  const commentById = useAgorStore(selectCommentById);
  const partition = useAgorStore(
    useMemo(() => makeBoardPartitionSelector(board.board_id), [board.board_id])
  );
  const comments = useMemo(
    () => Array.from(commentById.values()).filter((c) => c.board_id === board.board_id),
    [board.board_id, commentById]
  );
  const entries = useBoardContentEntries(board);
  const ordered = useMemo(
    () =>
      sortBoardTreeBranches(
        branches,
        board.primary_teammate_id,
        preferences.sort,
        sessionsByBranch
      ),
    [branches, board.primary_teammate_id, preferences.sort, sessionsByBranch]
  );
  // Reopening a session reveals its container, but live patches do not undo an
  // intentional collapse. This effect follows selection, not the session map.
  const selectedBranchId = useAgorStore((state) =>
    actions.selectedSessionId
      ? state.sessionById.get(actions.selectedSessionId)?.branch_id
      : undefined
  );
  const selectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      selectedBranchId &&
      branches.some((b) => b.branch_id === selectedBranchId) &&
      actions.selectedSessionId !== selectionRef.current
    ) {
      selectionRef.current = actions.selectedSessionId ?? null;
      updatePreferences({
        tab: 'sessions',
        expanded: { ...preferences.expanded, [selectedBranchId]: true },
      });
    }
  }, [
    actions.selectedSessionId,
    selectedBranchId,
    branches,
    preferences.expanded,
    updatePreferences,
  ]);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollTop.current;
    return () => {
      clearTimeout(scrollTimer.current);
      updatePreferences({ scrollTop: scrollTop.current });
    };
  }, [updatePreferences]);
  const text = query.trim().toLocaleLowerCase();
  const sessionMatches = text
    ? ordered.flatMap((branch) =>
        (sessionsByBranch.get(branch.branch_id) ?? [])
          .filter(
            (s) =>
              !s.archived &&
              `${branchTreeLabel(branch)} ${s.title ?? ''} ${s.description ?? ''}`
                .toLocaleLowerCase()
                .includes(text)
          )
          .map((session) => ({ branch, session }))
      )
    : [];
  const branchMatches = text
    ? ordered.filter((b) => branchTreeLabel(b).toLocaleLowerCase().includes(text))
    : [];
  const commentMatches = text
    ? comments.filter((c) => c.content.toLocaleLowerCase().includes(text))
    : [];
  const contentMatches = entries.filter(
    (entry) => !text || `${entry.title} ${entry.type}`.toLocaleLowerCase().includes(text)
  );
  const contentRows = (items: typeof entries) =>
    items.map((entry) => (
      <Button
        key={`${entry.selection.kind}:${entry.selection.id}`}
        type="text"
        block
        style={{
          textAlign: 'start',
          justifyContent: 'flex-start',
          height: 'auto',
          whiteSpace: 'normal',
        }}
        onClick={() => onContentClick(entry.selection)}
      >
        <Typography.Text type="secondary">{entry.type} · </Typography.Text>
        {entry.title}
      </Button>
    ));
  const sessionTree = (
    <>
      <Flex align="center" justify="space-between" style={{ paddingBlock: token.paddingXS }}>
        <Typography.Text type="secondary">Teammates & branches</Typography.Text>
        <Select
          aria-label="Branch order"
          size="small"
          value={preferences.sort}
          onChange={(sort) => updatePreferences({ sort })}
          options={[
            { value: 'alpha', label: 'Alphabetical' },
            { value: 'recent', label: 'Recently updated' },
          ]}
        />
      </Flex>
      {!branches.some((b) => b.branch_id === board.primary_teammate_id && !b.archived) && (
        <BoardTeammatePanel {...actions} activeTab="teammate" teammateOnly />
      )}
      {ordered.length === 0 && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No branches yet" />
      )}
      <Collapse
        ghost
        activeKey={ordered
          .filter(
            (b) => preferences.expanded[b.branch_id] ?? b.branch_id === board.primary_teammate_id
          )
          .map((b) => b.branch_id)}
        onChange={(keys) => {
          const open = new Set(Array.isArray(keys) ? keys : [keys]);
          updatePreferences({
            expanded: {
              ...preferences.expanded,
              ...Object.fromEntries(ordered.map((b) => [b.branch_id, open.has(b.branch_id)])),
            },
          });
        }}
        items={ordered.map((branch) => ({
          key: branch.branch_id,
          label: (
            <Flex align="center" gap="small" style={{ minWidth: 0 }}>
              <Typography.Text
                style={{ flex: 1, minWidth: 0 }}
                ellipsis={{ tooltip: branchTreeLabel(branch) }}
              >
                {branchTreeLabel(branch)}
              </Typography.Text>
              {branch.branch_id === board.primary_teammate_id ? (
                <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
                  Primary
                </Typography.Text>
              ) : isTeammate(branch) ? (
                <Typography.Text type="secondary" style={{ flexShrink: 0 }}>
                  Teammate
                </Typography.Text>
              ) : null}
            </Flex>
          ),
          extra: (
            <Button
              type="text"
              size="small"
              aria-label={`Open ${branchTreeLabel(branch)} details`}
              icon={<SettingOutlined />}
              onClick={(event) => {
                event.stopPropagation();
                onBranchClick(branch.branch_id);
              }}
            />
          ),
          children: <BranchSessions branch={branch} actions={actions} />,
        }))}
        destroyOnHidden
      />
    </>
  );
  const readyContent = text ? (
    <Space orientation="vertical" style={{ width: '100%' }}>
      {branchMatches.map((branch) => (
        <Button
          type="text"
          block
          key={branch.branch_id}
          onClick={() => onBranchClick(branch.branch_id)}
        >
          Branch · {branchTreeLabel(branch)}
        </Button>
      ))}
      <Typography.Text type="secondary">Sessions</Typography.Text>
      {sessionMatches.map(({ branch, session }) => (
        <Button
          block
          type="text"
          key={session.session_id}
          onClick={() => actions.onSessionClick(session.session_id)}
          style={{ height: 'auto', whiteSpace: 'normal', textAlign: 'start' }}
        >
          {getSessionDisplayTitle(session)} · {branchTreeLabel(branch)}
        </Button>
      ))}
      <Typography.Text type="secondary">Content</Typography.Text>
      {contentRows(contentMatches)}
      <Button
        onClick={() => {
          updatePreferences({ tab: 'comments' });
          setQuery('');
        }}
      >
        Browse comments
      </Button>
      {commentMatches.map((comment) => (
        <Button
          block
          type="text"
          key={comment.comment_id}
          style={{ height: 'auto', whiteSpace: 'normal', textAlign: 'start' }}
          onClick={() => {
            setSearchedCommentId(comment.comment_id);
            updatePreferences({ tab: 'comments' });
            setQuery('');
          }}
        >
          Comment · {comment.content.slice(0, 100)}
        </Button>
      ))}
      {!branchMatches.length &&
        !sessionMatches.length &&
        !contentMatches.length &&
        !commentMatches.length && <Typography.Text>No matching board content.</Typography.Text>}
    </Space>
  ) : (
    <Tabs
      activeKey={preferences.tab}
      onChange={(tab) => updatePreferences({ tab: tab as BoardViewPreferences['tab'] })}
      items={[
        { key: 'sessions', label: 'Sessions', children: sessionTree },
        {
          key: 'content',
          label: 'Content',
          children: entries.length ? contentRows(entries) : <Empty description="No content yet" />,
        },
        {
          key: 'comments',
          label: `Comments${actions.unreadCommentsCount ? ` (${actions.unreadCommentsCount})` : ''}`,
          children: (
            <CommentsPanel
              client={actions.client}
              boardId={board.board_id}
              comments={comments}
              userById={users}
              currentUserId={actions.currentUserId ?? ''}
              boardObjects={board.objects}
              branchById={branchById}
              onSendComment={actions.onSendComment ?? (() => {})}
              onReplyComment={actions.onReplyComment}
              onResolveComment={actions.onResolveComment}
              onToggleReaction={actions.onToggleReaction}
              onDeleteComment={actions.onDeleteComment}
              hoveredCommentId={actions.hoveredCommentId}
              selectedCommentId={searchedCommentId ?? actions.selectedCommentId}
            />
          ),
        },
      ]}
    />
  );
  return (
    <Flex
      vertical
      style={{
        height: '100%',
        minHeight: 0,
        background: token.colorBgContainer,
        padding: token.paddingSM,
      }}
    >
      <Input.Search
        aria-label="Search board"
        placeholder="Search this board"
        allowClear
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div
        ref={scrollRef}
        onScroll={(event) => {
          scrollTop.current = event.currentTarget.scrollTop;
          clearTimeout(scrollTimer.current);
          scrollTimer.current = setTimeout(
            () => updatePreferences({ scrollTop: scrollTop.current }),
            150
          );
        }}
        style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
      >
        {!actions.boardReady ? (
          partition?.status === 'error' ? (
            <BoardPartitionError boardId={board.board_id} />
          ) : (
            <Skeleton active />
          )
        ) : (
          readyContent
        )}
      </div>
    </Flex>
  );
}

/** Board's comments inspector, independent of the tree navigation. */
export function BoardComments({
  board,
  actions,
}: {
  board: Board;
  actions: BoardTeammatePanelProps;
}) {
  const commentById = useAgorStore(selectCommentById);
  const users = useAgorStore(selectUserById);
  const branchById = useAgorStore(selectBranchById);
  const comments = useMemo(
    () => Array.from(commentById.values()).filter((c) => c.board_id === board.board_id),
    [board.board_id, commentById]
  );
  return (
    <CommentsPanel
      client={actions.client}
      boardId={board.board_id}
      comments={comments}
      userById={users}
      currentUserId={actions.currentUserId ?? ''}
      boardObjects={board.objects}
      branchById={branchById}
      onSendComment={actions.onSendComment ?? (() => {})}
      onReplyComment={actions.onReplyComment}
      onResolveComment={actions.onResolveComment}
      onToggleReaction={actions.onToggleReaction}
      onDeleteComment={actions.onDeleteComment}
      hoveredCommentId={actions.hoveredCommentId}
      selectedCommentId={actions.selectedCommentId}
    />
  );
}
