import type { BoardComment, User } from '@agor-live/client';
import {
  getTeammateConfig,
  matchSearchTokens,
  SEARCHABLE_FIELDS,
  tokenizeSearchQuery,
} from '@agor-live/client';
import { ArrowLeftOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Empty, Input, List, Typography, theme } from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgorStore } from '../../store/agorStore';
import {
  selectArtifactById,
  selectBoardById,
  selectBranchById,
  selectCommentById,
  selectMcpServerById,
  selectSessionById,
} from '../../store/selectors';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';
import { MIN_QUERY_LENGTH } from '../GlobalSearch/types';
import { useGlobalSearch } from '../GlobalSearch/useGlobalSearch';

interface MobileSearchPageProps {
  currentUser?: User | null;
  onOpenWorkspaceSettings: (section: string) => void;
}

const COMMENT_LIMIT = 8;
// 16px avoids the iOS focus zoom that smaller controls trigger.
const NO_AUTOZOOM_FONT_SIZE = 16;

interface Row {
  key: string;
  title: string;
  subtitle?: string;
  onClick: () => void;
}

/**
 * Full-screen global search across the workspace. Reuses the desktop search
 * backend: the shared `useGlobalSearch` hook (sessions / branches / teammates /
 * boards / artifacts / MCP) plus the same `@agor/core` matcher + searchable-field
 * registry for comments. Results are grouped by type; tapping one navigates.
 */
export const MobileSearchPage: React.FC<MobileSearchPageProps> = ({
  currentUser,
  onOpenWorkspaceSettings,
}) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [query, setQuery] = useState('');

  const sessionById = useAgorStore(selectSessionById);
  const branchById = useAgorStore(selectBranchById);
  const artifactById = useAgorStore(selectArtifactById);
  const boardById = useAgorStore(selectBoardById);
  const mcpServerById = useAgorStore(selectMcpServerById);
  const commentById = useAgorStore(selectCommentById);

  const { results, hasAnyResults } = useGlobalSearch({
    query,
    ownedByMe: false, // global scope
    activeTypeChip: 'all',
    currentUserId: currentUser?.user_id,
    sessionById,
    branchById,
    artifactById,
    boardById,
    mcpServerById,
  });

  // Comments aren't in the entity hook's buckets; match them with the same
  // shared tokenizer + registry so this stays one search backend, not a fork.
  const commentResults = useMemo<BoardComment[]>(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) return [];
    const tokens = tokenizeSearchQuery(trimmed);
    if (tokens.length === 0) return [];
    const time = (c: BoardComment) => (c.updated_at ? new Date(c.updated_at).getTime() : 0);
    return Array.from(commentById.values())
      .filter((c) => matchSearchTokens(tokens, SEARCHABLE_FIELDS.comment(c)))
      .sort((a, b) => time(b) - time(a))
      .slice(0, COMMENT_LIMIT);
  }, [query, commentById]);

  const sections: { title: string; rows: Row[] }[] = useMemo(() => {
    const s: { title: string; rows: Row[] }[] = [];
    if (results.session.length) {
      s.push({
        title: 'Sessions',
        rows: results.session.map((r) => ({
          key: r.item.session_id,
          title: getSessionDisplayTitle(r.item, { fallbackChars: 40 }),
          subtitle: r.parentBranch?.name,
          onClick: () => navigate(`/m/session/${r.item.session_id}`),
        })),
      });
    }
    if (results.teammate.length) {
      s.push({
        title: 'Teammates',
        rows: results.teammate.map((r) => ({
          key: r.item.branch_id,
          title: getTeammateConfig(r.item)?.displayName ?? r.item.name,
          onClick: () => (r.item.board_id ? navigate(`/m/board/${r.item.board_id}`) : undefined),
        })),
      });
    }
    if (results.branch.length) {
      s.push({
        title: 'Branches',
        rows: results.branch.map((r) => ({
          key: r.item.branch_id,
          title: r.item.name,
          subtitle: r.item.board_id ? boardById.get(r.item.board_id)?.name : undefined,
          onClick: () => (r.item.board_id ? navigate(`/m/board/${r.item.board_id}`) : undefined),
        })),
      });
    }
    if (results.board.length) {
      s.push({
        title: 'Boards',
        rows: results.board.map((r) => ({
          key: r.item.board_id,
          title: r.item.name,
          onClick: () => navigate(`/m/board/${r.item.board_id}`),
        })),
      });
    }
    if (results.artifact.length) {
      s.push({
        title: 'Artifacts',
        rows: results.artifact.map((r) => ({
          key: r.item.artifact_id,
          title: r.item.name,
          subtitle: r.parentBranch?.name,
          onClick: () =>
            r.parentBranch?.board_id
              ? navigate(`/m/board/${r.parentBranch.board_id}`)
              : navigate(`/a/${r.item.artifact_id}/fullscreen`),
        })),
      });
    }
    if (results.mcp.length) {
      s.push({
        title: 'MCP servers',
        rows: results.mcp.map((r) => ({
          key: r.item.mcp_server_id,
          title: r.item.display_name || r.item.name,
          onClick: () => onOpenWorkspaceSettings('mcp'),
        })),
      });
    }
    if (commentResults.length) {
      s.push({
        title: 'Comments',
        rows: commentResults.map((c) => ({
          key: c.comment_id,
          title: c.content,
          subtitle: boardById.get(c.board_id)?.name,
          onClick: () => navigate(`/m/comments/${c.board_id}`),
        })),
      });
    }
    return s;
  }, [results, commentResults, boardById, navigate, onOpenWorkspaceSettings]);

  const showEmpty =
    query.trim().length >= MIN_QUERY_LENGTH && !hasAnyResults && !commentResults.length;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: token.marginXS,
          paddingInline: token.padding,
          paddingBlock: token.paddingXS,
          borderBottom: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
          background: token.colorBgContainer,
        }}
      >
        <Button
          type="text"
          aria-label="Back"
          icon={<ArrowLeftOutlined />}
          onClick={() => navigate(-1)}
          style={{ marginInlineStart: -token.marginXS }}
        />
        <Input
          autoFocus
          allowClear
          size="large"
          inputMode="search"
          prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
          placeholder="Search sessions, branches, boards, comments"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, fontSize: NO_AUTOZOOM_FONT_SIZE }}
        />
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: token.paddingLG }}>
        {query.trim().length < MIN_QUERY_LENGTH ? (
          <div style={{ padding: token.paddingXL, textAlign: 'center' }}>
            <Typography.Text type="secondary">
              Find sessions, branches, boards, and comments across your workspace.
            </Typography.Text>
          </div>
        ) : showEmpty ? (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Empty description={`No results for "${query.trim()}"`} />
          </div>
        ) : (
          sections.map((section) => (
            <List
              key={section.title}
              size="small"
              header={
                <Typography.Text strong style={{ paddingInline: token.padding }}>
                  {section.title}
                </Typography.Text>
              }
              dataSource={section.rows}
              renderItem={(row) => (
                <List.Item
                  role="button"
                  tabIndex={0}
                  aria-label={row.title}
                  onClick={row.onClick}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      row.onClick();
                    }
                  }}
                  style={{ cursor: 'pointer', paddingInline: token.padding, minHeight: 44 }}
                >
                  <List.Item.Meta
                    title={
                      <Typography.Text ellipsis style={{ maxWidth: '100%' }}>
                        {row.title}
                      </Typography.Text>
                    }
                    description={
                      row.subtitle ? (
                        <Typography.Text
                          type="secondary"
                          ellipsis
                          style={{ fontSize: token.fontSizeSM }}
                        >
                          {row.subtitle}
                        </Typography.Text>
                      ) : undefined
                    }
                  />
                </List.Item>
              )}
            />
          ))
        )}
      </div>
    </div>
  );
};
