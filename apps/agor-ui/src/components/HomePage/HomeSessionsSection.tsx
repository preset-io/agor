import type { Board, Branch, Session } from '@agor-live/client';
import { BranchesOutlined } from '@ant-design/icons';
import { Typography, theme } from 'antd';
import type React from 'react';
import { memo, useMemo, useState } from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useAgorStore } from '../../store/agorStore';
import { selectBoardById, selectBranchById, selectSessionById } from '../../store/selectors';
import {
  getMatchSnippet,
  isOwnActiveSession,
  isSessionSearchActive,
  SESSION_SORT_STORAGE_KEY,
  type SessionSort,
  searchSessions,
  sessionToolMatches,
  sortSessions,
} from '../../utils/sessionSearch';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { formatRelativeTime } from '../../utils/time';
import { getBoardEmoji } from '../BoardTile';
import { HighlightMatch } from '../HighlightMatch';
import { SessionRelationshipIcon } from '../SessionRelationshipIcon';
import {
  getSessionRowFill,
  getSessionRowStateLabel,
  isSessionRowFailed,
  isSessionRowRead,
  SESSION_ROW_LOGO_SIZE,
  SessionRowLogo,
  SessionStatusMark,
} from '../SessionRow';
import { SessionSearchToolbar, SessionSortButton } from '../SessionSearchControls';
import { HomeBlock, HomeEmpty, HomeLink, HomeSurfaceCard } from './HomeBlock';
import { compactRelativeTime, HomeRow, HomeTime } from './HomeRow';
import type { HomePageProps } from './types';

const HOME_SESSIONS_LIMIT = 100;
/** Home shows the first few in the saved sort; "View all" opens the full, searchable list. */
const HOME_SESSIONS_PREVIEW = 8;
/** The ready dot is the resting state; on home it would mark nearly every row. */
const READY_STATE_LABEL = 'ready for prompt';

// Memo'd so a patch to one session leaves every other row's DOM untouched:
// unaffected rows keep their entity references and bail out of the re-render.
export const HomeSessionRow = memo(function HomeSessionRow({
  session,
  branch,
  board,
  boardEmoji,
  query = '',
  showBranch = false,
  showStateLabel = false,
  onSessionClick,
}: {
  session: Session;
  branch?: Branch;
  board?: Board;
  boardEmoji?: string;
  query?: string;
  /** Show the branch beside the title (full list); previews keep it in the tooltip. */
  showBranch?: boolean;
  /** Spell out the waiting state beside its mark ("Awaiting input"). */
  showStateLabel?: boolean;
  onSessionClick: (sessionId: string) => void;
}) {
  const { token } = theme.useToken();
  const title = getSessionDisplayTitle(session, { includeAgentFallback: true });
  const failed = isSessionRowFailed(session);
  const state = getSessionRowStateLabel(session);
  const where = [board?.name, branch?.name].filter(Boolean).join(' / ');
  const relative = formatRelativeTime(session.last_updated);
  const snippet =
    query && session.title && session.description
      ? getMatchSnippet(session.description, query)
      : null;
  const toolMatches = Boolean(query) && sessionToolMatches(session, query);
  const snippetStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    lineHeight: 1.4,
    paddingInlineStart: SESSION_ROW_LOGO_SIZE + token.marginXS,
    paddingBlockEnd: token.paddingXXS,
  };

  return (
    <HomeRow
      ariaLabel={[`Open session ${title}`, where, state].filter(Boolean).join('; ')}
      onOpen={() => onSessionClick(session.session_id)}
      leading={
        <>
          <SessionRowLogo tool={session.agentic_tool} />
          <SessionRelationshipIcon session={session} size={10} />
        </>
      }
      title={<HighlightMatch text={title} query={query} />}
      tooltip={[title, where, relative].filter(Boolean).join('\n')}
      read={isSessionRowRead(session, false)}
      meta={
        showBranch && branch ? (
          <>
            {boardEmoji ? <span style={{ fontSize: 11 }}>{boardEmoji}</span> : <BranchesOutlined />}{' '}
            {branch.name}
          </>
        ) : undefined
      }
      // Marks only what moves or needs you; resting rows show when they last moved.
      trailing={
        state && state !== READY_STATE_LABEL ? (
          <>
            {showStateLabel && (
              <span style={{ fontSize: 11, color: token.colorTextSecondary }}>
                {state.charAt(0).toUpperCase() + state.slice(1)}
              </span>
            )}
            <SessionStatusMark session={session} />
          </>
        ) : (
          <HomeTime>{compactRelativeTime(relative)}</HomeTime>
        )
      }
      fill={failed ? getSessionRowFill(token, { failed, selected: false }) : undefined}
      below={
        <>
          {toolMatches && (
            <Typography.Text type="secondary" style={snippetStyle}>
              Agent: <HighlightMatch text={session.agentic_tool} query={query} />
            </Typography.Text>
          )}
          {snippet && snippet !== title && (
            <Typography.Text type="secondary" style={{ ...snippetStyle, fontStyle: 'italic' }}>
              <HighlightMatch text={snippet} query={query} />
            </Typography.Text>
          )}
        </>
      }
    />
  );
});

export const HomeSessionsSection: React.FC<
  Pick<HomePageProps, 'currentUserId' | 'onSessionClick'>
> = ({ currentUserId, onSessionClick }) => {
  const { token } = theme.useToken();
  const sessionById = useAgorStore(selectSessionById);
  const branchById = useAgorStore(selectBranchById);
  const boardById = useAgorStore(selectBoardById);
  const [expanded, setExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useLocalStorage<SessionSort>(SESSION_SORT_STORAGE_KEY, 'recent');
  const allSessions = useMemo(
    () =>
      Array.from(sessionById.values()).filter((session) =>
        isOwnActiveSession(session, currentUserId)
      ),
    [currentUserId, sessionById]
  );
  const trimmed = searchQuery.trim();
  const searching = expanded && isSessionSearchActive(trimmed);
  const displaySessions = useMemo(() => {
    if (!expanded) return sortSessions(allSessions, sort).slice(0, HOME_SESSIONS_PREVIEW);
    const sessions = searching
      ? searchSessions(allSessions, trimmed).map(({ session }) => session)
      : sortSessions(allSessions, sort);
    return sessions.slice(0, HOME_SESSIONS_LIMIT);
  }, [allSessions, expanded, searching, trimmed, sort]);

  const collapse = () => {
    setExpanded(false);
    setSearchQuery('');
  };

  return (
    <HomeBlock
      label={currentUserId ? 'My sessions' : 'Sessions'}
      count={allSessions.length}
      actions={
        // One fragment in both states so the toggle link keeps its identity (and focus).
        <>
          {!expanded && <SessionSortButton sort={sort} onSortChange={setSort} compact />}
          {(expanded || allSessions.length > HOME_SESSIONS_PREVIEW) && (
            <HomeLink onClick={expanded ? collapse : () => setExpanded(true)}>
              {expanded ? 'Show less' : 'View all'}
            </HomeLink>
          )}
        </>
      }
    >
      <HomeSurfaceCard>
        {expanded && (
          <div style={{ padding: token.paddingXS }}>
            <SessionSearchToolbar
              value={searchQuery}
              onChange={setSearchQuery}
              sort={sort}
              onSortChange={setSort}
              searching={searching}
              placeholder="Filter sessions..."
            />
          </div>
        )}
        <div style={expanded ? { maxHeight: 560, overflowY: 'auto' } : undefined}>
          {displaySessions.length === 0 ? (
            <HomeEmpty>{searching ? 'No matching sessions' : 'No sessions yet'}</HomeEmpty>
          ) : (
            displaySessions.map((session) => {
              const branch = branchById.get(session.branch_id);
              const board = branch?.board_id ? boardById.get(branch.board_id) : undefined;
              return (
                <HomeSessionRow
                  key={session.session_id}
                  session={session}
                  branch={branch}
                  board={board}
                  boardEmoji={board ? getBoardEmoji(board, branchById) : undefined}
                  query={searching ? trimmed : ''}
                  showBranch={expanded}
                  onSessionClick={onSessionClick}
                />
              );
            })
          )}
          {expanded && !searching && allSessions.length > displaySessions.length && (
            <HomeEmpty>
              Showing {displaySessions.length} of {allSessions.length} — filter to find the rest
            </HomeEmpty>
          )}
        </div>
      </HomeSurfaceCard>
    </HomeBlock>
  );
};
