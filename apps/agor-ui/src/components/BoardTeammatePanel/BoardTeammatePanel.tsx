import type { AgorClient, Board, Branch, Repo, SpawnConfig } from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { LeftOutlined, RobotOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Empty,
  Select,
  Skeleton,
  Space,
  Spin,
  Tabs,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import {
  selectBranchById,
  selectCommentById,
  selectRepoById,
  selectSessionsByBranch,
  selectUserById,
} from '../../store/selectors';
import { mapToArray } from '../../utils/mapHelpers';
import { BranchSessionSections } from '../BranchCard';
import { BranchHeaderPill } from '../BranchHeaderPill';
import { BoardSessionList } from '../BranchListDrawer';
import type { BranchModalTab } from '../BranchModal';
import { CommentsPanel } from '../CommentsPanel';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { CreatedByTag } from '../metadata';
import { IssuePill, PullRequestPill } from '../Pill';

export type BoardTeammatePanelTab = 'teammate' | 'all-sessions' | 'comments';

interface BoardTeammatePanelProps {
  board: Board | null;
  activeTab?: BoardTeammatePanelTab;
  onTabChange?: (tab: BoardTeammatePanelTab) => void;
  primaryTeammateBranch?: Branch;
  primaryTeammateRepo?: Repo;
  primaryTeammateInaccessible: boolean;
  currentUserId?: string;
  selectedSessionId?: string | null;
  onSessionClick: (sessionId: string) => void;
  onCreateSession?: (branchId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onArchiveOrDelete?: (
    branchId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onOpenSettings?: (branchId: string, tab?: BranchModalTab) => void;
  onOpenSessionSettings?: (sessionId: string) => void;
  onOpenTerminal?: (commands: string[], branchId?: string) => void;
  onStartEnvironment?: (branchId: string) => void;
  onStopEnvironment?: (branchId: string) => void;
  onViewLogs?: (branchId: string) => void;
  onNukeEnvironment?: (branchId: string) => void;
  onExecuteScheduleNow?: (branchId: string) => Promise<void>;
  onSendComment?: (content: string) => void;
  onReplyComment?: (parentId: string, content: string) => void;
  onResolveComment?: (commentId: string) => void;
  onToggleReaction?: (commentId: string, emoji: string) => void;
  onDeleteComment?: (commentId: string) => void;
  hoveredCommentId?: string | null;
  selectedCommentId?: string | null;
  onCollapse?: () => void;
  deferSessionDetails?: boolean;
  onDeferredDetailsHydrated?: () => void;
  client: AgorClient | null;
}

const BoardTeammatePanelComponent: React.FC<BoardTeammatePanelProps> = ({
  board,
  activeTab: controlledActiveTab,
  onTabChange,
  primaryTeammateBranch,
  primaryTeammateRepo,
  primaryTeammateInaccessible,
  currentUserId,
  selectedSessionId,
  onSessionClick,
  onCreateSession,
  onForkSession,
  onSpawnSession,
  onOpenSettings,
  onOpenSessionSettings,
  onSendComment,
  onReplyComment,
  onResolveComment,
  onToggleReaction,
  onDeleteComment,
  hoveredCommentId,
  selectedCommentId,
  onCollapse,
  deferSessionDetails = false,
  onDeferredDetailsHydrated,
  client,
}) => {
  const { token } = theme.useToken();
  const { message } = AntApp.useApp();
  // Subscribe to entity maps by slice from the store: each selector only wakes
  // this panel when its own slice changes.
  const sessionsByBranch = useAgorStore(selectSessionsByBranch);
  const branchById = useAgorStore(selectBranchById);
  const repoById = useAgorStore(selectRepoById);
  const userById = useAgorStore(selectUserById);
  const commentById = useAgorStore(selectCommentById);
  const boardObjects = board?.objects;
  const defaultTab: BoardTeammatePanelTab = primaryTeammateInaccessible
    ? 'all-sessions'
    : 'teammate';
  const [uncontrolledActiveTab, setUncontrolledActiveTab] =
    useState<BoardTeammatePanelTab>(defaultTab);
  const isControlled = controlledActiveTab !== undefined;
  const activeTab = controlledActiveTab ?? uncontrolledActiveTab;
  const [sessionDetailsHydrated, setSessionDetailsHydrated] = useState(() => !deferSessionDetails);
  useEffect(() => {
    setSessionDetailsHydrated(!deferSessionDetails);
  }, [deferSessionDetails]);

  const hydrateDeferredDetails = useCallback(() => {
    if (sessionDetailsHydrated) return;
    setSessionDetailsHydrated(true);
    onDeferredDetailsHydrated?.();
  }, [onDeferredDetailsHydrated, sessionDetailsHydrated]);

  useEffect(() => {
    if (!deferSessionDetails || sessionDetailsHydrated) return;

    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let idleCallbackId: number | undefined;
    const hydrate = () => hydrateDeferredDetails();

    if ('requestIdleCallback' in window) {
      idleCallbackId = window.requestIdleCallback(hydrate, { timeout: 2500 });
    } else {
      fallbackTimer = globalThis.setTimeout(hydrate, 2000);
    }

    return () => {
      if (idleCallbackId !== undefined) window.cancelIdleCallback?.(idleCallbackId);
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
    };
  }, [deferSessionDetails, hydrateDeferredDetails, sessionDetailsHydrated]);

  const setActiveTab = (tab: BoardTeammatePanelTab) => {
    hydrateDeferredDetails();
    setUncontrolledActiveTab(tab);
    onTabChange?.(tab);
  };

  // Derive board comments only when the comments tab is actually visible. The
  // default teammate tab does not need to scan the global comment map during
  // Home → board navigation.
  const comments = useMemo(
    () =>
      activeTab === 'comments'
        ? mapToArray(commentById).filter((c) => c.board_id === board?.board_id)
        : [],
    [activeTab, commentById, board?.board_id]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the tab when switching boards, even if the default tab string is unchanged.
  useEffect(() => {
    setUncontrolledActiveTab(defaultTab);
    if (!isControlled) {
      onTabChange?.(defaultTab);
    }
  }, [defaultTab, board?.board_id, isControlled, onTabChange]);

  const teammateOptions = useMemo(() => {
    if (primaryTeammateBranch || primaryTeammateInaccessible) return [];

    return Array.from(branchById.values())
      .filter((branch) => isTeammate(branch) && !branch.archived)
      .sort((a, b) => {
        const aConfig = getTeammateConfig(a);
        const bConfig = getTeammateConfig(b);
        return (aConfig?.displayName ?? a.name).localeCompare(bConfig?.displayName ?? b.name);
      })
      .map((branch) => {
        const config = getTeammateConfig(branch);
        const repo = repoById.get(branch.repo_id);
        const label = config?.displayName ?? branch.name;
        return {
          value: branch.branch_id,
          label,
          searchText: `${label} ${branch.name} ${repo?.slug ?? ''}`,
          branch,
          repo,
        };
      });
  }, [branchById, primaryTeammateBranch, primaryTeammateInaccessible, repoById]);
  const [selectedTeammateId, setSelectedTeammateId] = useState<string | undefined>();
  const [assigningTeammate, setAssigningTeammate] = useState(false);

  useEffect(() => {
    if (
      selectedTeammateId &&
      teammateOptions.some((option) => option.value === selectedTeammateId)
    ) {
      return;
    }
    setSelectedTeammateId(teammateOptions[0]?.value);
  }, [teammateOptions, selectedTeammateId]);

  const handleAssignTeammate = async () => {
    if (!board || !client || !selectedTeammateId) return;

    const teammate = branchById.get(selectedTeammateId);
    if (!teammate) return;

    setAssigningTeammate(true);
    try {
      if (teammate.board_id !== board.board_id) {
        await client.service('branches').patch(selectedTeammateId, {
          board_id: board.board_id,
        });
      }
      await client.service('boards').setPrimaryTeammate({
        boardId: board.board_id,
        branchId: selectedTeammateId,
      });
      message.success('Teammate assigned');
    } catch (error) {
      message.error(
        `Failed to assign teammate: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setAssigningTeammate(false);
    }
  };

  const teammateSessions = useMemo(
    () =>
      primaryTeammateBranch ? sessionsByBranch.get(primaryTeammateBranch.branch_id) || [] : [],
    [primaryTeammateBranch, sessionsByBranch]
  );

  const teammateContent = (() => {
    if (primaryTeammateBranch && primaryTeammateRepo) {
      const teammateConfig = getTeammateConfig(primaryTeammateBranch);
      const teammateDescription = primaryTeammateBranch.notes?.trim();
      const isCreating = primaryTeammateBranch.filesystem_status === 'creating';

      return (
        <div style={{ padding: 16 }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              paddingBottom: 12,
              marginBottom: 4,
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                {isCreating ? (
                  <Spin />
                ) : teammateConfig?.emoji ? (
                  <span style={{ fontSize: 30 }}>{teammateConfig.emoji}</span>
                ) : (
                  <RobotOutlined style={{ fontSize: 30, color: token.colorInfo }} />
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <Typography.Title
                  level={4}
                  style={{ margin: 0, fontWeight: 600 }}
                  ellipsis={{
                    tooltip: teammateConfig?.displayName ?? primaryTeammateBranch.name,
                  }}
                >
                  {teammateConfig?.displayName ?? primaryTeammateBranch.name}
                </Typography.Title>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Primary teammate
                </Typography.Text>
              </div>
            </div>

            <Space size={4} wrap>
              <BranchHeaderPill
                repo={primaryTeammateRepo}
                branch={primaryTeammateBranch}
                sessionCount={teammateSessions.length}
                onOpenBranch={onOpenSettings}
                showEnvButtons={false}
                compact
              />
              {primaryTeammateBranch.created_by && (
                <CreatedByTag
                  createdBy={primaryTeammateBranch.created_by}
                  currentUserId={currentUserId}
                  userById={userById}
                  prefix="Created by"
                />
              )}
              {primaryTeammateBranch.issue_url && (
                <IssuePill
                  issueUrl={primaryTeammateBranch.issue_url}
                  currentRepo={primaryTeammateRepo}
                />
              )}
              {primaryTeammateBranch.pull_request_url && (
                <PullRequestPill
                  prUrl={primaryTeammateBranch.pull_request_url}
                  currentRepo={primaryTeammateRepo}
                />
              )}
            </Space>
            {teammateDescription && (
              <div className="markdown-compact" style={{ color: token.colorTextSecondary }}>
                <MarkdownRenderer content={teammateDescription} compact showControls={false} />
              </div>
            )}
          </div>

          {sessionDetailsHydrated ? (
            <BranchSessionSections
              branch={primaryTeammateBranch}
              sessions={teammateSessions}
              userById={userById}
              currentUserId={currentUserId}
              selectedSessionId={selectedSessionId}
              onSessionClick={onSessionClick}
              onCreateSession={onCreateSession}
              onForkSession={onForkSession}
              onSpawnSession={onSpawnSession}
              onOpenSessionSettings={onOpenSessionSettings}
              defaultExpanded={true}
              mode="panel"
              client={client}
            />
          ) : (
            <div style={{ paddingTop: 8 }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Loading sessions…
                </Typography.Text>
                <Skeleton active paragraph={{ rows: 3 }} title={false} />
                <Button
                  size="small"
                  type="link"
                  onClick={hydrateDeferredDetails}
                  style={{ padding: 0 }}
                >
                  Show now
                </Button>
              </Space>
            </div>
          )}
        </div>
      );
    }

    if (primaryTeammateInaccessible) {
      return (
        <div style={{ padding: 16 }}>
          <Alert
            type="info"
            showIcon
            message="Teammate unavailable"
            description="This board has a primary teammate, but you do not have access to that teammate branch."
          />
        </div>
      );
    }

    return (
      <div style={{ padding: 16 }}>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Typography.Text type="secondary">
              This board does not have a primary teammate yet.
            </Typography.Text>
          }
          style={{ padding: '24px 0 16px' }}
        />
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Typography.Text strong>Assign an existing teammate</Typography.Text>
          <Select
            showSearch
            placeholder="Select a teammate"
            value={selectedTeammateId}
            onChange={setSelectedTeammateId}
            options={teammateOptions}
            optionFilterProp="searchText"
            disabled={assigningTeammate || teammateOptions.length === 0}
            style={{ width: '100%' }}
          />
          {teammateOptions.length === 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              No existing teammates are available to assign.
            </Typography.Text>
          )}
          <Button
            type="primary"
            onClick={handleAssignTeammate}
            loading={assigningTeammate}
            disabled={!selectedTeammateId || !board || !client}
          >
            Assign
          </Button>
        </Space>
      </div>
    );
  })();

  return (
    <div
      style={{
        height: '100%',
        background: token.colorBgContainer,
        borderRight: `1px solid ${token.colorBorderSecondary}`,
        overflow: 'hidden',
      }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as BoardTeammatePanelTab)}
        items={[
          {
            key: 'teammate',
            label: 'Teammate',
            children: (
              <div style={{ height: 'calc(100vh - 112px)', overflow: 'auto' }}>
                {teammateContent}
              </div>
            ),
          },
          {
            key: 'all-sessions',
            label: 'All sessions',
            children: board ? (
              <div style={{ height: 'calc(100vh - 112px)', overflow: 'auto' }}>
                {sessionDetailsHydrated ? (
                  <BoardSessionList
                    board={board}
                    currentBoardId={board.board_id}
                    branchById={branchById}
                    repoById={repoById}
                    sessionsByBranch={sessionsByBranch}
                    onSessionClick={onSessionClick}
                  />
                ) : (
                  <div style={{ padding: 16 }}>
                    <Skeleton active paragraph={{ rows: 4 }} title={false} />
                  </div>
                )}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No board selected" />
            ),
          },
          {
            key: 'comments',
            label: 'Comments',
            children: board ? (
              <div style={{ height: 'calc(100vh - 112px)' }}>
                <CommentsPanel
                  client={client}
                  boardId={board.board_id}
                  comments={comments}
                  userById={userById}
                  currentUserId={currentUserId || 'unknown'}
                  boardObjects={boardObjects}
                  branchById={branchById}
                  onSendComment={(content) => onSendComment?.(content)}
                  onReplyComment={onReplyComment}
                  onResolveComment={onResolveComment}
                  onToggleReaction={onToggleReaction}
                  onDeleteComment={onDeleteComment}
                  hoveredCommentId={hoveredCommentId}
                  selectedCommentId={selectedCommentId}
                />
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No board selected" />
            ),
          },
        ]}
        style={{ height: '100%' }}
        tabBarStyle={{ margin: 0, padding: '0 12px' }}
        tabBarExtraContent={{
          right: onCollapse ? (
            <Tooltip title="Collapse panel" placement="bottom">
              <Button
                type="text"
                size="small"
                icon={<LeftOutlined style={{ fontSize: 11 }} />}
                onClick={onCollapse}
                style={{ marginRight: 4 }}
              />
            </Tooltip>
          ) : undefined,
        }}
      />
    </div>
  );
};

// Memoized: the inner App stabilizes every handler prop it passes (via
// useStableCallback), so React.memo bails out of re-renders driven by unrelated
// store patches and only re-renders when a value prop it draws actually changes.
export const BoardTeammatePanel = memo(BoardTeammatePanelComponent);

export default BoardTeammatePanel;
