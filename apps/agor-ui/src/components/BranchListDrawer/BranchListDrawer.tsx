import type { Board, Branch, Repo, Session } from '@agor-live/client';
import { AimOutlined, BranchesOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Drawer, Flex, Tooltip, Typography, theme } from 'antd';
import type React from 'react';
import { memo, useDeferredValue, useMemo, useState } from 'react';
import { useRecenterMap } from '../../contexts/CanvasNavigationContext';
import { useIdleReady } from '../../hooks/useIdleReady';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useStableCallback } from '../../hooks/useStableCallback';
import {
  getMatchSnippet,
  isSessionSearchActive,
  SESSION_SORT_STORAGE_KEY,
  type SessionSort,
  searchSessions,
  sessionToolMatches,
  sortSessions,
} from '../../utils/sessionSearch';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime, formatTimestampWithRelative } from '../../utils/time';
import { HighlightMatch } from '../HighlightMatch';
import { SessionRelationshipIcon } from '../SessionRelationshipIcon';
import {
  getSessionRowFill,
  getSessionRowStateLabel,
  getSessionRowTitleStyle,
  isSessionRowFailed,
  isSessionRowRead,
  SESSION_ROW_LOGO_SIZE,
  SessionRowLogo,
  SessionStatusMark,
} from '../SessionRow';
import { SessionRelevanceLabel, SessionSearchToolbar } from '../SessionSearchControls';

interface BranchListDrawerProps {
  open: boolean;
  onClose: () => void;
  boards: Board[];
  currentBoardId: string;
  onBoardChange: (boardId: string) => void;
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  sessionsByBranch: Map<string, Session[]>;
  onSessionClick: (sessionId: string) => void;
}

export interface BoardSessionListProps {
  board?: Board;
  currentBoardId: string;
  branchById: Map<string, Branch>;
  repoById: Map<string, Repo>;
  sessionsByBranch: Map<string, Session[]>;
  onSessionClick: (sessionId: string) => void;
  onAfterSessionClick?: () => void;
}

interface BoardSessionRowProps {
  session: Session;
  branch?: Branch;
  repo?: Repo;
  query: string;
  onOpen: (sessionId: string) => void;
  /** List-level idle flag; until it flips, the toolbar mounts on first hover/focus. */
  toolbarReady: boolean;
}

/**
 * One-line session row in the teammate panel's row grammar: logo, title, quiet
 * branch metadata and a trailing status mark. Time and the board locator
 * appear on hover/focus. Memoized so typing in search or live patches to other
 * sessions don't re-render every row.
 */
const BoardSessionRow = memo(function BoardSessionRow({
  session,
  branch,
  repo,
  query,
  onOpen,
  toolbarReady,
}: BoardSessionRowProps) {
  const { token } = theme.useToken();
  const recenterMap = useRecenterMap();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const showActions = hovered || focusWithin;
  // Mount the toolbar on hover/focus or once the list is idle: long lists skip hundreds
  // of Tooltips/Buttons on first render, while screen readers can still reach them.
  const [revealedByUser, setRevealedByUser] = useState(false);
  const toolbarMounted = toolbarReady || revealedByUser;

  const titleText = getSessionDisplayTitle(session, { includeAgentFallback: true });
  const descriptionSnippet =
    query && session.title && session.description
      ? getMatchSnippet(session.description, query)
      : null;
  const toolMatches = Boolean(query) && sessionToolMatches(session, query);
  const failed = isSessionRowFailed(session);
  const branchLabel = branch ? (repo ? `${repo.slug} / ${branch.name}` : branch.name) : null;
  const state = getSessionRowStateLabel(session);
  const boardId = branch?.board_id;
  const rowFill = failed
    ? getSessionRowFill(token, { failed, selected: false })
    : showActions
      ? token.controlItemBgHover
      : undefined;

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: token.borderRadiusSM,
        background: rowFill,
        // Long boards: skip layout/paint for off-screen rows.
        contentVisibility: 'auto',
        containIntrinsicSize: `auto ${token.controlHeight}px`,
      }}
      onMouseEnter={() => {
        setHovered(true);
        setRevealedByUser(true);
      }}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => {
        setFocusWithin(true);
        setRevealedByUser(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusWithin(false);
        }
      }}
    >
      <button
        type="button"
        data-session-id={session.session_id}
        aria-label={[
          `Open session ${titleText}`,
          branchLabel ? `branch ${branchLabel}` : 'no branch',
          state,
        ]
          .filter(Boolean)
          .join('; ')}
        onClick={() => onOpen(session.session_id)}
        style={{
          display: 'block',
          width: '100%',
          border: 0,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
          paddingBlock: 0,
          paddingInlineStart: token.paddingXS,
          paddingInlineEnd: token.paddingXS,
        }}
      >
        <Flex align="center" gap={token.marginXS} style={{ minHeight: token.controlHeight }}>
          <SessionRowLogo tool={session.agentic_tool} />
          <SessionRelationshipIcon session={session} size={10} />
          {/* Plain spans keep hundreds of rows cheap; styles come from the shared tokens. */}
          <span
            title={titleText}
            style={{
              color: token.colorText,
              ...getSessionRowTitleStyle(token, {
                read: isSessionRowRead(session, false),
                hug: true,
              }),
            }}
          >
            <HighlightMatch text={titleText} query={query} />
          </span>
          {/* The branch is quiet metadata beside the title, like a gateway channel. */}
          <span
            title={branchLabel ?? 'No branch'}
            style={{
              color: token.colorTextDescription,
              fontSize: token.fontSizeSM,
              // Keep a fixed share for the branch; the title yields space first.
              flex: '0 0 auto',
              minWidth: 0,
              maxWidth: '35%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            <BranchesOutlined /> {branch?.name ?? 'No branch'}
          </span>
          <span style={{ flex: 1 }} />
          <SessionStatusMark session={session} />
        </Flex>
        {toolMatches && (
          <Typography.Text
            type="secondary"
            style={{
              display: 'block',
              fontSize: 11,
              paddingInlineStart: SESSION_ROW_LOGO_SIZE + token.marginXS,
            }}
          >
            Agent: <HighlightMatch text={session.agentic_tool} query={query} />
          </Typography.Text>
        )}
        {descriptionSnippet && descriptionSnippet !== titleText && (
          <Typography.Text
            type="secondary"
            style={{
              display: 'block',
              fontSize: 11,
              lineHeight: 1.4,
              fontStyle: 'italic',
              paddingInlineStart: SESSION_ROW_LOGO_SIZE + token.marginXS,
              paddingBlockEnd: token.paddingXXS,
            }}
          >
            <HighlightMatch text={descriptionSnippet} query={query} />
          </Typography.Text>
        )}
      </button>
      {toolbarMounted && (
        <Flex
          role="group"
          aria-label="Session actions"
          align="center"
          gap={token.marginXXS}
          style={{
            position: 'absolute',
            insetInlineEnd: token.paddingXXS,
            top: token.controlHeight / 2,
            transform: 'translateY(-50%)',
            // Opaque row fill with a leading fade: covered branch text runs out, never shows through.
            paddingInlineStart: token.paddingLG,
            paddingInlineEnd: token.paddingXXS,
            borderRadius: token.borderRadiusSM,
            backgroundImage: [rowFill ?? token.colorBgContainer, token.colorBgContainer]
              .map((fill) => `linear-gradient(to right, transparent, ${fill} ${token.paddingLG}px)`)
              .join(', '),
            opacity: showActions ? 1 : 0,
            pointerEvents: showActions ? 'auto' : 'none',
            transition: `opacity ${token.motionDurationFast}`,
          }}
        >
          <Tooltip title={formatTimestampWithRelative(session.last_updated)}>
            <Typography.Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
              {formatRelativeTime(session.last_updated)}
            </Typography.Text>
          </Tooltip>
          {branch && boardId && (
            <Tooltip title="Go to card on board">
              <Button
                type="text"
                size="small"
                aria-label="Go to card on board"
                icon={<AimOutlined />}
                onClick={(event) => {
                  event.stopPropagation();
                  recenterMap(branch.branch_id, { boardId });
                }}
              />
            </Tooltip>
          )}
        </Flex>
      )}
    </div>
  );
});

export const BranchListDrawer: React.FC<BranchListDrawerProps> = ({
  open,
  onClose,
  boards,
  currentBoardId,
  branchById,
  repoById,
  sessionsByBranch,
  onSessionClick,
}) => {
  const currentBoard = boards.find((b) => b.board_id === currentBoardId);

  return (
    <Drawer
      title={null}
      placement="left"
      size={480}
      open={open}
      onClose={onClose}
      styles={{
        body: { padding: 0 },
      }}
    >
      <BoardSessionList
        board={currentBoard}
        currentBoardId={currentBoardId}
        branchById={branchById}
        repoById={repoById}
        sessionsByBranch={sessionsByBranch}
        onSessionClick={onSessionClick}
        onAfterSessionClick={onClose}
      />
    </Drawer>
  );
};

export const BoardSessionList: React.FC<BoardSessionListProps> = ({
  board,
  currentBoardId,
  branchById,
  repoById,
  sessionsByBranch,
  onSessionClick,
  onAfterSessionClick,
}) => {
  const { token } = theme.useToken();
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useLocalStorage<SessionSort>(SESSION_SORT_STORAGE_KEY, 'recent');

  // Filter sessions by current board (branch-centric model)
  const boardSessions = useMemo(() => {
    // Get branch IDs for this board by iterating the Map
    const boardBranchIds: string[] = [];
    for (const branch of branchById.values()) {
      if (branch.board_id === currentBoardId) {
        boardBranchIds.push(branch.branch_id);
      }
    }

    // Remote-created sessions also appear as same-id surrogates under the creator's branch; list each once, preferring the real row.
    const byId = new Map<string, Session>();
    for (const branchId of boardBranchIds) {
      for (const session of sessionsByBranch.get(branchId) ?? []) {
        const seen = byId.get(session.session_id);
        if (!seen || (seen.remote_surrogate && !session.remote_surrogate)) {
          byId.set(session.session_id, session);
        }
      }
    }
    return [...byId.values()];
  }, [sessionsByBranch, branchById, currentBoardId]);

  // One idle flag mounts every row's hover toolbar in a single commit.
  const toolbarsReady = useIdleReady(true, 2000);
  // Stable so memoized rows skip re-rendering when the parent re-renders.
  const openSession = useStableCallback((sessionId: string) => {
    onSessionClick(sessionId);
    onAfterSessionClick?.();
  });

  // The input updates immediately; the list follows at lower priority so typing stays fluid.
  const trimmedQuery = useDeferredValue(searchQuery.trim());
  const searchActive = isSessionSearchActive(trimmedQuery);
  const displaySessions = useMemo(
    () =>
      searchActive
        ? searchSessions(boardSessions, trimmedQuery).map(({ session }) => session)
        : sortSessions(boardSessions, sort),
    [boardSessions, searchActive, trimmedQuery, sort]
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Search Bar */}
      <div
        style={{
          padding: '16px 24px',
          borderBottom: `1px solid ${token.colorBorder}`,
          flexShrink: 0,
        }}
      >
        <SessionSearchToolbar
          value={searchQuery}
          onChange={setSearchQuery}
          sort={sort}
          onSortChange={setSort}
          searching={searchActive}
        />
      </div>

      {/* Session List: rows inset so their content lines up with the search field. */}
      <div
        style={{
          paddingBlock: token.paddingXS,
          paddingInline: token.padding,
          flex: 1,
          overflowY: 'auto',
        }}
      >
        {displaySessions.length === 0 ? (
          searchActive ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                padding: '28px 16px',
                gap: 6,
              }}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: token.colorFillTertiary,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 2,
                }}
              >
                <SearchOutlined style={{ fontSize: 16, color: token.colorTextTertiary }} />
              </div>
              <Typography.Text strong style={{ fontSize: 13 }}>
                No results
              </Typography.Text>
              <Typography.Text
                type="secondary"
                style={{ fontSize: 12, textAlign: 'center', lineHeight: 1.5, maxWidth: 200 }}
              >
                Nothing matched <Typography.Text code>{trimmedQuery}</Typography.Text>
              </Typography.Text>
            </div>
          ) : (
            <Typography.Text
              type="secondary"
              style={{ display: 'block', textAlign: 'center', padding: '24px 0', fontSize: 12 }}
            >
              No sessions in this board
            </Typography.Text>
          )
        ) : (
          displaySessions.map((session) => {
            const branch = session.branch_id ? branchById.get(session.branch_id) : undefined;
            return (
              <BoardSessionRow
                key={session.session_id}
                session={session}
                branch={branch}
                repo={branch ? repoById.get(branch.repo_id) : undefined}
                query={searchActive ? trimmedQuery : ''}
                onOpen={openSession}
                toolbarReady={toolbarsReady}
              />
            );
          })
        )}
      </div>

      {/* Board Info Footer */}
      {board && (
        <div
          style={{
            flexShrink: 0,
            padding: '16px 24px',
            borderTop: `1px solid ${token.colorBorder}`,
            background: token.colorBgContainer,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {searchActive ? (
              <>
                {displaySessions.length} of {boardSessions.length} · <SessionRelevanceLabel />
                {board.description && ` • ${board.description}`}
              </>
            ) : (
              `${boardSessions.length} session${boardSessions.length === 1 ? '' : 's'}${
                board.description ? ` • ${board.description}` : ''
              }`
            )}
          </Typography.Text>
        </div>
      )}
    </div>
  );
};

export default BranchListDrawer;
