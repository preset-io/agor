import type { User } from '@agor-live/client';
import { artifactFullscreenPath } from '@agor-live/client';
import { ArrowLeftOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Empty, Input, List, Typography, theme } from 'antd';
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
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
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { pressableProps } from '../../utils/pressableProps';
import { describeSearchResult } from '../GlobalSearch/describeSearchResult';
import { searchComments } from '../GlobalSearch/searchComments';
import {
  MIN_QUERY_LENGTH,
  SECTION_LABELS,
  SECTION_ORDER,
  type SearchResultItem,
} from '../GlobalSearch/types';
import { useGlobalSearch } from '../GlobalSearch/useGlobalSearch';
import { searchResultKey } from '../GlobalSearch/utils';
import { mobileScrollAreaStyle } from './constants';

interface MobileSearchPageProps {
  currentUser?: User | null;
  onOpenWorkspaceSettings: (section: string) => void;
  onOpenBranch: (branchId: string) => void;
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
 * Full-screen global search across the workspace. Entity matching, section order,
 * labels and row titles come from the desktop GlobalSearch module; the layout,
 * navigation targets, branch board-name subtitle and Comments section are mobile's own.
 */
export const MobileSearchPage: React.FC<MobileSearchPageProps> = ({
  currentUser,
  onOpenWorkspaceSettings,
  onOpenBranch,
}) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [query, setQuery] = useState('');
  // Defer the heavy cross-entity scan so typing stays responsive.
  const deferredQuery = useDeferredValue(query);

  const sessionById = useAgorStore(selectSessionById);
  const branchById = useAgorStore(selectBranchById);
  const artifactById = useAgorStore(selectArtifactById);
  const boardById = useAgorStore(selectBoardById);
  const mcpServerById = useAgorStore(selectMcpServerById);
  const commentById = useAgorStore(selectCommentById);

  const { results, hasAnyResults } = useGlobalSearch({
    query: deferredQuery,
    ownedByMe: false, // global scope
    activeTypeChip: 'all',
    currentUserId: currentUser?.user_id,
    sessionById,
    branchById,
    artifactById,
    boardById,
    mcpServerById,
  });

  // Comments aren't an entity-search bucket yet; match them with the shared backend.
  const commentResults = useMemo(
    () => searchComments({ query: deferredQuery, commentById, boardById, limit: COMMENT_LIMIT }),
    [deferredQuery, commentById, boardById]
  );

  // Where a result leads on the mobile shell; what a row says is shared with desktop.
  const openResult = useCallback(
    (result: SearchResultItem) => {
      switch (result.type) {
        case 'session':
          return navigate(`/m/session/${result.item.session_id}`);
        case 'branch':
        case 'teammate':
          return onOpenBranch(result.item.branch_id);
        case 'board':
          return navigate(`/m/board/${result.item.board_id}`);
        case 'artifact':
          return navigate(artifactFullscreenPath(result.item.artifact_id));
        case 'mcp':
          return onOpenWorkspaceSettings('mcp');
      }
    },
    [navigate, onOpenBranch, onOpenWorkspaceSettings]
  );

  const sections: { title: string; rows: Row[] }[] = useMemo(() => {
    const entitySections = SECTION_ORDER.filter((type) => results[type].length > 0).map((type) => ({
      title: SECTION_LABELS[type],
      rows: (results[type] as SearchResultItem[]).map((result) => {
        const { title, secondary } = describeSearchResult(result);
        const boardName =
          result.type === 'branch' && result.item.board_id
            ? boardById.get(result.item.board_id)?.name
            : undefined;
        return {
          key: searchResultKey(result),
          title,
          subtitle: secondary ?? boardName,
          onClick: () => openResult(result),
        };
      }),
    }));
    if (commentResults.length === 0) return entitySections;
    return [
      ...entitySections,
      {
        title: 'Comments',
        rows: commentResults.map((comment) => ({
          key: comment.comment_id,
          title: comment.content,
          subtitle: boardById.get(comment.board_id)?.name,
          onClick: () => navigate(`/m/comments/${comment.board_id}`),
        })),
      },
    ];
  }, [results, commentResults, boardById, navigate, openResult]);

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
          style={{
            marginInlineStart: -token.marginXS,
            minWidth: MOBILE_TOUCH_TARGET,
            minHeight: MOBILE_TOUCH_TARGET,
          }}
        />
        <Input
          autoFocus
          allowClear
          size="large"
          inputMode="search"
          aria-label="Search"
          prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
          placeholder="Search sessions, branches, boards, comments"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, fontSize: NO_AUTOZOOM_FONT_SIZE }}
        />
      </div>

      <div style={{ ...mobileScrollAreaStyle, paddingBottom: token.paddingLG }}>
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
              rowKey="key"
              renderItem={(row) => (
                <List.Item
                  {...pressableProps(row.onClick)}
                  aria-label={row.title}
                  style={{
                    cursor: 'pointer',
                    paddingInline: token.padding,
                    minHeight: MOBILE_TOUCH_TARGET,
                  }}
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
