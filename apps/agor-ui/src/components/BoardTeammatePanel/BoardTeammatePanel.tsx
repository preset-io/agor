import type {
  AgorClient,
  Board,
  Branch,
  BranchArchiveOrDeleteOptions,
  Repo,
  SpawnConfig,
} from '@agor-live/client';
import { getTeammateConfig, isTeammate } from '@agor-live/client';
import { LeftOutlined, RobotOutlined } from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Empty,
  Modal,
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
import { useCanManageBoard } from '../../hooks/useCanManageBoard';
import { useAgorStore } from '../../store/agorStore';
import {
  selectBranchById,
  selectCommentById,
  selectRepoById,
  selectSessionsByBranch,
  selectUserById,
} from '../../store/selectors';
import { mapToArray } from '../../utils/mapHelpers';
import { useThemedMessage } from '../../utils/message';
import { BranchSessionSections } from '../BranchCard';
import { BranchFilesystemRecovery } from '../BranchFilesystemRecovery';
import { BranchHeaderPill } from '../BranchHeaderPill';
import { BoardBranchList, BoardSessionList } from '../BranchListDrawer';
import { BranchMetadataRow } from '../BranchMetadataRow';
import type { BranchModalTab } from '../BranchModal';
import { CommentsPanel } from '../CommentsPanel';
import { MarkdownRenderer } from '../MarkdownRenderer';

export type BoardTeammatePanelTab = 'teammate' | 'all-sessions' | 'all-branches' | 'comments';

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
  onArchiveOrDelete?: (branchId: string, options: BranchArchiveOrDeleteOptions) => void;
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
  unreadCommentsCount?: number;
  hasUserMentions?: boolean;
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
  unreadCommentsCount = 0,
  hasUserMentions = false,
  onCollapse,
  deferSessionDetails = false,
  onDeferredDetailsHydrated,
  client,
}) => {
  const { token } = theme.useToken();
  const { showError, showSuccess } = useThemedMessage();
  // Subscribe to entity maps by slice from the store: each selector only wakes
  // this panel when its own slice changes.
  const sessionsByBranch = useAgorStore(selectSessionsByBranch);
  const branchById = useAgorStore(selectBranchById);
  const repoById = useAgorStore(selectRepoById);
  const userById = useAgorStore(selectUserById);
  const commentById = useAgorStore(selectCommentById);
  const boardObjects = board?.objects;
  const canEditBoard = useCanManageBoard(
    client,
    board ?? undefined,
    currentUserId ? userById.get(currentUserId) : undefined
  );
  const [primaryAction, setPrimaryAction] = useState<'clear' | 'replace' | null>(null);
  const [changingPrimary, setChangingPrimary] = useState(false);
  const primaryId = board?.primary_teammate_id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: cancel stale confirmation when realtime designation or board identity changes.
  useEffect(() => {
    setPrimaryAction(null);
  }, [board?.board_id, primaryId]);
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

  const branchOwners = useMemo(() => {
    const ownerId =
      primaryTeammateBranch?.primary_owner_user_id ?? primaryTeammateBranch?.created_by;
    if (!ownerId) return [];
    const owner = userById.get(ownerId);
    return owner ? [owner] : [];
  }, [primaryTeammateBranch?.primary_owner_user_id, primaryTeammateBranch?.created_by, userById]);

  const teammateOptions = useMemo(() => {
    return Array.from(branchById.values())
      .filter(
        (branch) =>
          isTeammate(branch) &&
          !branch.archived &&
          branch.branch_id !== primaryId &&
          // Replacing an existing designation is atomic only for this board's
          // teammates. Cross-board movement retains its own authorization flow;
          // clear first to use the existing empty-board assignment workflow.
          (!primaryId || branch.board_id === board?.board_id)
      )
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
  }, [branchById, primaryId, board?.board_id, repoById]);
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
    if (!board || !client || !selectedTeammateId || !canEditBoard) return;

    const teammate = branchById.get(selectedTeammateId);
    if (!teammate) return;

    setAssigningTeammate(true);
    try {
      // The server performs any board move and assignment atomically through
      // the same branch relocation path used by BranchModal Save.
      await client.service('boards').setPrimaryTeammate({
        boardId: board.board_id,
        branchId: selectedTeammateId,
      });
      showSuccess('Teammate assigned');
    } catch (error) {
      showError(
        `Failed to assign teammate: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setAssigningTeammate(false);
    }
  };

  const handleChangePrimary = async () => {
    if (!board || !client || !canEditBoard || !primaryAction || changingPrimary) return;
    if (primaryAction === 'replace' && !selectedTeammateId) return;
    setChangingPrimary(true);
    try {
      if (primaryAction === 'clear') {
        await client.service('boards').clearPrimaryTeammate(board.board_id);
      } else {
        await client.service('boards').setPrimaryTeammate({
          boardId: board.board_id,
          branchId: selectedTeammateId!,
        });
      }
      setPrimaryAction(null);
      showSuccess(
        primaryAction === 'clear'
          ? 'Board primary teammate cleared'
          : 'Board primary teammate replaced'
      );
    } catch (error) {
      showError(
        `Failed to ${primaryAction} board primary teammate: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setChangingPrimary(false);
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
        <div
          style={{
            padding: 16,
            height: '100%',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              flexShrink: 0,
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

            <BranchFilesystemRecovery branch={primaryTeammateBranch} client={client} />
            <BranchMetadataRow
              branch={primaryTeammateBranch}
              repo={primaryTeammateRepo}
              owners={branchOwners}
              currentUserId={currentUserId}
              style={{ minWidth: 0 }}
            >
              <BranchHeaderPill
                repo={primaryTeammateRepo}
                branch={primaryTeammateBranch}
                sessionCount={teammateSessions.length}
                onOpenBranch={onOpenSettings}
                showEnvButtons={false}
                compact
                truncateToFit
              />
            </BranchMetadataRow>
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
              mode="panel"
              fillAvailableHeight
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
        {canEditBoard && (
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text strong>Assign an existing teammate</Typography.Text>
            <Select
              showSearch
              aria-label="Select a teammate"
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
        )}
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
      <Modal
        open={canEditBoard && primaryAction !== null}
        title={
          primaryAction === 'clear'
            ? 'Clear board primary teammate?'
            : 'Replace board primary teammate'
        }
        okText={primaryAction === 'clear' ? 'Clear primary' : 'Replace primary'}
        onOk={handleChangePrimary}
        onCancel={() => {
          if (!changingPrimary) setPrimaryAction(null);
        }}
        confirmLoading={changingPrimary}
        cancelButtonProps={{ disabled: changingPrimary }}
        okButtonProps={{
          disabled: changingPrimary || (primaryAction === 'replace' && !selectedTeammateId),
        }}
        closable={!changingPrimary}
        mask={{ closable: !changingPrimary }}
        keyboard={!changingPrimary}
        destroyOnHidden
      >
        <Typography.Paragraph>
          This changes only the board's primary designation. It does not retire the teammate or
          change personal primary assistants.
        </Typography.Paragraph>
        {primaryAction === 'replace' && (
          <Space orientation="vertical" style={{ width: '100%' }}>
            <Select
              aria-label="Replacement teammate"
              placeholder="Select a replacement"
              showSearch
              optionFilterProp="searchText"
              options={teammateOptions}
              value={selectedTeammateId}
              onChange={setSelectedTeammateId}
              disabled={changingPrimary || teammateOptions.length === 0}
              style={{ width: '100%' }}
            />
            <Typography.Text type="secondary">
              Choose a teammate on this board. To move one from another board, clear the primary
              first, then assign it.
            </Typography.Text>
          </Space>
        )}
      </Modal>
      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as BoardTeammatePanelTab)}
        items={[
          {
            key: 'teammate',
            label: 'Teammate',
            children: (
              <div
                style={{
                  height: '100%',
                  overflow: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {primaryId && canEditBoard && (
                  <Space wrap style={{ padding: token.paddingSM, flexShrink: 0 }}>
                    <Button
                      size="small"
                      onClick={() => setPrimaryAction('replace')}
                      disabled={changingPrimary}
                    >
                      Replace primary teammate
                    </Button>
                    <Button
                      size="small"
                      onClick={() => setPrimaryAction('clear')}
                      disabled={changingPrimary}
                    >
                      Clear primary teammate
                    </Button>
                  </Space>
                )}
                <div style={{ flex: 1, minHeight: 0 }}>{teammateContent}</div>
              </div>
            ),
          },
          {
            key: 'all-sessions',
            label: 'Sessions',
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
            key: 'all-branches',
            label: 'Branches',
            children: board ? (
              <div style={{ height: 'calc(100vh - 112px)', overflow: 'auto' }}>
                {sessionDetailsHydrated ? (
                  <BoardBranchList board={board} repoById={repoById} client={client} />
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
            label: (
              <Badge
                count={unreadCommentsCount}
                size="small"
                offset={[8, 0]}
                style={{
                  backgroundColor: hasUserMentions ? token.colorError : token.colorPrimaryBgHover,
                }}
              >
                <span>Comments</span>
              </Badge>
            ),
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
        styles={{ body: { height: '100%' }, content: { height: '100%' } }}
        tabBarStyle={{ margin: 0, padding: '0 12px' }}
        tabBarExtraContent={{
          right: onCollapse ? (
            <Tooltip title="Collapse panel" placement="bottom">
              <Button
                type="text"
                size="small"
                aria-label="Collapse panel"
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
