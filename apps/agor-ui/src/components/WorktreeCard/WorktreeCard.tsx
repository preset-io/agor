import type {
  AgorClient,
  Repo,
  Session,
  SessionID,
  SpawnConfig,
  User,
  Worktree,
} from '@agor-live/client';
import {
  getAssistantConfig,
  getGatewaySource as getGatewaySourceCore,
  isAssistant,
  isGatewaySession as isGatewaySessionCore,
} from '@agor-live/client';
import {
  BranchesOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  DeleteOutlined,
  DragOutlined,
  EditOutlined,
  ForkOutlined,
  InboxOutlined,
  MessageOutlined,
  PlusOutlined,
  PushpinFilled,
  RobotOutlined,
  SettingOutlined,
  SubnodeOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import {
  App,
  Badge,
  Button,
  Card,
  Collapse,
  ConfigProvider,
  message,
  Space,
  Spin,
  Tooltip,
  Tree,
  Typography,
  theme,
} from 'antd';
import { AggregationColor } from 'antd/es/color-picker/color';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useServiceEnabled } from '../../hooks/useServicesConfig';
import { useSessionActions } from '../../hooks/useSessionActions';
import { getSessionDisplayTitle, getSessionTitleStyles } from '../../utils/sessionTitle';
import { ensureColorVisible, isDarkTheme } from '../../utils/theme';
import { ArchiveDeleteWorktreeModal } from '../ArchiveDeleteWorktreeModal';
import { EnvironmentPill } from '../EnvironmentPill';
import { type ForkSpawnAction, ForkSpawnModal } from '../ForkSpawnModal';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { CreatedByTag } from '../metadata';
import { ChannelPill, IssuePill, PullRequestPill } from '../Pill';
import { ToolIcon } from '../ToolIcon';
import { buildSessionTree, type SessionTreeNode } from './buildSessionTree';

const _WORKTREE_CARD_MAX_WIDTH = 600;
const NOTES_MAX_LENGTH = 200; // Character limit for truncated notes

/** Wrapper that adds hover action buttons (settings + archive) overlay to session items */
const SessionItemWithActions: React.FC<{
  sessionId: string;
  isArchiving: boolean;
  onArchive: (sessionId: string, e: React.MouseEvent) => void;
  onSettings?: (sessionId: string, e: React.MouseEvent) => void;
  children: React.ReactNode;
}> = ({ sessionId, isArchiving, onArchive, onSettings, children }) => {
  const [hovered, setHovered] = useState(false);
  const { token } = theme.useToken();

  const buttonStyle: React.CSSProperties = {
    background: `${token.colorBgContainer}cc`,
    borderRadius: 4,
    width: 24,
    height: 24,
    minWidth: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <div
      style={{ position: 'relative', minWidth: 120 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
      <div
        style={{
          position: 'absolute',
          right: 4,
          top: '50%',
          transform: 'translateY(-50%)',
          opacity: hovered ? 1 : 0,
          transition: 'opacity 0.15s ease-in-out',
          pointerEvents: hovered ? 'auto' : 'none',
          display: 'flex',
          gap: 2,
          width: 'fit-content',
        }}
      >
        {onSettings && (
          <Tooltip title="Session settings">
            <Button
              type="text"
              size="small"
              icon={<SettingOutlined />}
              onClick={(e) => onSettings(sessionId, e)}
              style={buttonStyle}
            />
          </Tooltip>
        )}
        <Tooltip title="Archive session">
          <Button
            type="text"
            size="small"
            icon={<InboxOutlined />}
            loading={isArchiving}
            onClick={(e) => onArchive(sessionId, e)}
            style={buttonStyle}
          />
        </Tooltip>
      </div>
    </div>
  );
};

interface WorktreeCardProps {
  worktree: Worktree;
  repo: Repo;
  sessions: Session[]; // Sessions for this specific worktree
  userById: Map<string, User>;
  currentUserId?: string;
  selectedSessionId?: string | null; // Currently open session in drawer
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (worktreeId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onArchiveOrDelete?: (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onOpenSettings?: (worktreeId: string) => void;
  onOpenSessionSettings?: (sessionId: string) => void;
  onOpenTerminal?: (commands: string[], worktreeId?: string) => void;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onViewLogs?: (worktreeId: string) => void;
  onNukeEnvironment?: (worktreeId: string) => void;
  onUnpin?: (worktreeId: string) => void;
  isPinned?: boolean;
  zoneName?: string;
  zoneColor?: string;
  defaultExpanded?: boolean;
  inPopover?: boolean; // NEW: Enable popover-optimized mode (hides board-specific controls)
  client: AgorClient | null;
}

const WorktreeCardComponent = ({
  worktree,
  repo,
  sessions,
  userById,
  currentUserId,
  selectedSessionId,
  onTaskClick,
  onSessionClick,
  onCreateSession,
  onForkSession,
  onSpawnSession,
  onArchiveOrDelete,
  onOpenSettings,
  onOpenSessionSettings,
  onOpenTerminal,
  onStartEnvironment,
  onStopEnvironment,
  onViewLogs,
  onNukeEnvironment,
  onUnpin,
  isPinned = false,
  zoneName,
  zoneColor,
  defaultExpanded = true,
  inPopover = false,
  client,
}: WorktreeCardProps) => {
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const connectionDisabled = useConnectionDisabled();
  const schedulerEnabled = useServiceEnabled('scheduler');
  const gatewayEnabled = useServiceEnabled('gateway');

  // Fork/Spawn modal state
  const [forkSpawnModal, setForkSpawnModal] = useState<{
    open: boolean;
    action: ForkSpawnAction;
    session: Session | null;
  }>({
    open: false,
    action: 'fork',
    session: null,
  });

  // Archive/Delete modal state
  const [archiveDeleteModalOpen, setArchiveDeleteModalOpen] = useState(false);

  // Tree expansion state - track which nodes are expanded
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);

  // Notes expansion state
  const [notesExpanded, setNotesExpanded] = useState(false);

  // Handle fork/spawn modal confirm
  const handleForkSpawnConfirm = async (config: string | Partial<SpawnConfig>) => {
    if (!forkSpawnModal.session) return;

    if (forkSpawnModal.action === 'fork') {
      // Fork only takes a string prompt
      const prompt = typeof config === 'string' ? config : config.prompt || '';
      await onForkSession?.(forkSpawnModal.session.session_id, prompt);
    } else {
      // Spawn accepts full SpawnConfig
      await onSpawnSession?.(forkSpawnModal.session.session_id, config);
    }
  };

  // Session archive via shared hook
  const { archiveSession } = useSessionActions(client);
  const [archivingSessionIds, setArchivingSessionIds] = useState<Set<string>>(new Set());

  const handleArchiveSession = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();

      modal.confirm({
        title: 'Archive Session',
        content: 'Are you sure you want to archive this session?',
        okText: 'Archive',
        cancelText: 'Cancel',
        onOk: async () => {
          setArchivingSessionIds((prev) => new Set(prev).add(sessionId));
          try {
            const result = await archiveSession(sessionId as SessionID);
            if (result) {
              message.success('Session archived');
            } else {
              message.error('Failed to archive session');
            }
          } finally {
            setArchivingSessionIds((prev) => {
              const next = new Set(prev);
              next.delete(sessionId);
              return next;
            });
          }
        },
      });
    },
    [archiveSession, modal]
  );

  // Gateway session helpers (delegating to @agor-live/client)
  const getGatewaySource = useCallback(
    (session: Session) => getGatewaySourceCore(session) ?? undefined,
    []
  );

  const isGatewaySession = useCallback((session: Session): boolean => {
    return isGatewaySessionCore(session);
  }, []);

  // Filter out archived sessions from board card display
  const activeSessions = useMemo(() => sessions.filter((s) => !s.archived), [sessions]);

  // Separate sessions by type: manual, scheduled, and gateway
  const manualSessions = useMemo(
    () => activeSessions.filter((s) => !s.scheduled_from_worktree && !isGatewaySession(s)),
    [activeSessions, isGatewaySession]
  );
  const scheduledSessions = useMemo(
    () =>
      activeSessions
        .filter((s) => s.scheduled_from_worktree)
        .sort((a, b) => (b.scheduled_run_at || 0) - (a.scheduled_run_at || 0)), // Most recent first
    [activeSessions]
  );
  const gatewaySessions = useMemo(
    () => activeSessions.filter((s) => isGatewaySession(s)),
    [activeSessions, isGatewaySession]
  );

  // Build genealogy tree structure (only for manual sessions)
  const sessionTreeData = useMemo(() => buildSessionTree(manualSessions), [manualSessions]);

  // Check if any active (non-archived) session is running or stopping
  const hasRunningSession = useMemo(
    () => activeSessions.some((s) => s.status === 'running' || s.status === 'stopping'),
    [activeSessions]
  );

  // Check if any scheduled session is running (for collapse header spinner)
  const hasRunningScheduledSession = useMemo(
    () => scheduledSessions.some((s) => s.status === 'running' || s.status === 'stopping'),
    [scheduledSessions]
  );

  // Check if any gateway session is running (for collapse header spinner)
  const hasRunningGatewaySession = useMemo(
    () => gatewaySessions.some((s) => s.status === 'running' || s.status === 'stopping'),
    [gatewaySessions]
  );

  // Check if worktree is still being created on filesystem
  const isCreating = worktree.filesystem_status === 'creating';
  const isFailed = worktree.filesystem_status === 'failed';

  // Check if this worktree is a persisted agent
  const assistantConfig = useMemo(() => getAssistantConfig(worktree), [worktree]);
  const isAgent = isAssistant(worktree);

  // Check if worktree needs attention (newly created OR has ready sessions)
  // Don't highlight if a session from this worktree is currently open in the drawer
  const needsAttention = useMemo(() => {
    const hasReadySession = activeSessions.some((s) => s.ready_for_prompt === true);
    const hasOpenSession = activeSessions.some((s) => s.session_id === selectedSessionId);
    const shouldHighlight = (worktree.needs_attention || hasReadySession) && !hasOpenSession;

    return shouldHighlight;
  }, [activeSessions, worktree.needs_attention, selectedSessionId]);

  // Auto-expand all nodes on mount and when new nodes with children are added
  useEffect(() => {
    // Collect all node keys that have children
    const collectKeysWithChildren = (nodes: SessionTreeNode[]): React.Key[] => {
      const keys: React.Key[] = [];
      for (const node of nodes) {
        if (node.children && node.children.length > 0) {
          keys.push(node.key);
          keys.push(...collectKeysWithChildren(node.children));
        }
      }
      return keys;
    };

    const allKeysWithChildren = collectKeysWithChildren(sessionTreeData);
    setExpandedKeys(allKeysWithChildren);
  }, [sessionTreeData]);

  // Render function for tree nodes (our rich session cards)
  const renderSessionNode = (node: SessionTreeNode) => {
    const session = node.session;

    // Get relationship icon based on type
    const getRelationshipIcon = () => {
      if (node.relationshipType === 'fork') {
        if (session.fork_origin === 'btw') {
          return (
            <Typography.Text
              style={{
                fontSize: 9,
                color: token.colorWarning,
                fontWeight: 'bold',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              btw
            </Typography.Text>
          );
        }
        return <ForkOutlined style={{ fontSize: 10, color: token.colorWarning }} />;
      }
      if (node.relationshipType === 'spawn') {
        return <SubnodeOutlined style={{ fontSize: 10, color: token.colorInfo }} />;
      }
      return null;
    };

    // Dropdown menu items for session actions
    const _sessionMenuItems: MenuProps['items'] = [
      {
        key: 'fork',
        icon: <ForkOutlined />,
        label: 'Fork Session',
        disabled: connectionDisabled,
        onClick: () => {
          setForkSpawnModal({
            open: true,
            action: 'fork',
            session,
          });
        },
      },
      {
        key: 'spawn',
        icon: <SubnodeOutlined />,
        label: 'Spawn Subsession',
        disabled: connectionDisabled,
        onClick: () => {
          setForkSpawnModal({
            open: true,
            action: 'spawn',
            session,
          });
        },
      },
    ];

    const isActive = session.status === 'running' || session.status === 'stopping';

    return (
      <SessionItemWithActions
        sessionId={session.session_id}
        isArchiving={archivingSessionIds.has(session.session_id)}
        onArchive={handleArchiveSession}
        onSettings={
          onOpenSessionSettings
            ? (id, e) => {
                e.stopPropagation();
                onOpenSessionSettings(id);
              }
            : undefined
        }
      >
        <div
          style={{
            border: session.ready_for_prompt
              ? `2px solid ${token.colorPrimary}`
              : `1px solid rgba(255, 255, 255, 0.1)`,
            borderRadius: 4,
            padding: 8,
            background: 'transparent',
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            marginBottom: 4,
            boxShadow: session.ready_for_prompt ? `0 0 12px ${token.colorPrimary}30` : undefined,
          }}
          onClick={() => onSessionClick?.(session.session_id)}
          onContextMenu={(e) => {
            // Show fork/spawn menu on right-click if handlers exist
            if (onForkSession || onSpawnSession) {
              e.preventDefault();
            }
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
            {isActive ? <Spin size="small" /> : <ToolIcon tool={session.agentic_tool} size={20} />}
            {getRelationshipIcon()}
            <Typography.Text
              strong
              style={{
                fontSize: 12,
                flex: 1,
                minWidth: 0,
                ...getSessionTitleStyles(2),
              }}
            >
              {getSessionDisplayTitle(session, { includeAgentFallback: true })}
            </Typography.Text>
          </div>
        </div>
      </SessionItemWithActions>
    );
  };

  // Session list content (collapsible) - only used when sessions exist
  const sessionListContent = (
    <ConfigProvider theme={{ components: { Tree: { colorBgContainer: 'transparent' } } }}>
      <Tree
        treeData={sessionTreeData}
        expandedKeys={expandedKeys}
        onExpand={(keys) => setExpandedKeys(keys as React.Key[])}
        showLine
        showIcon={false}
        selectable={false}
        titleRender={renderSessionNode}
      />
    </ConfigProvider>
  );

  // Session list collapse header
  const sessionListHeader = (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        width: '100%',
      }}
    >
      <Space size={4} align="center">
        <Typography.Text strong>Sessions</Typography.Text>
        <Badge
          count={manualSessions.length}
          showZero
          style={{ backgroundColor: token.colorPrimaryBgHover }}
        />
      </Space>
      {onCreateSession && (
        <div className="nodrag">
          <Button
            type="default"
            size="small"
            icon={<PlusOutlined />}
            disabled={connectionDisabled || isCreating}
            onClick={(e) => {
              e.stopPropagation();
              onCreateSession(worktree.worktree_id);
            }}
            title={isCreating ? 'Worktree is being created...' : undefined}
          >
            New Session
          </Button>
        </div>
      )}
    </div>
  );

  // Scheduled runs header
  const scheduledRunsHeader = (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        width: '100%',
      }}
    >
      <Space size={4} align="center">
        <ClockCircleOutlined style={{ color: token.colorInfo }} />
        <Typography.Text strong>Scheduled Runs</Typography.Text>
        <Badge
          count={scheduledSessions.length}
          showZero
          style={{ backgroundColor: token.colorInfoBgHover }}
        />
        {hasRunningScheduledSession && <Spin size="small" />}
      </Space>
    </div>
  );

  // Scheduled runs content (flat list, no genealogy tree needed)
  const scheduledRunsContent = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {scheduledSessions.map((session) => {
        const isActive = session.status === 'running' || session.status === 'stopping';
        return (
          <SessionItemWithActions
            key={session.session_id}
            sessionId={session.session_id}
            isArchiving={archivingSessionIds.has(session.session_id)}
            onArchive={handleArchiveSession}
            onSettings={
              onOpenSessionSettings
                ? (id, e) => {
                    e.stopPropagation();
                    onOpenSessionSettings(id);
                  }
                : undefined
            }
          >
            <div
              style={{
                border: `1px solid rgba(255, 255, 255, 0.1)`,
                borderRadius: 4,
                padding: 8,
                background: 'transparent',
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
              }}
              onClick={() => onSessionClick?.(session.session_id)}
            >
              <Space size={4} align="center" style={{ flex: 1, minWidth: 0 }}>
                {isActive ? (
                  <Spin size="small" />
                ) : (
                  <ToolIcon tool={session.agentic_tool} size={20} />
                )}
                <Typography.Text
                  style={{
                    fontSize: 12,
                    flex: 1,
                    color: token.colorTextSecondary,
                    ...getSessionTitleStyles(2),
                  }}
                >
                  {getSessionDisplayTitle(session, { includeAgentFallback: true })}
                </Typography.Text>
              </Space>
            </div>
          </SessionItemWithActions>
        );
      })}
    </div>
  );

  // Gateway sessions header
  const gatewaySessionsHeader = (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        width: '100%',
      }}
    >
      <Space size={4} align="center">
        <MessageOutlined style={{ color: token.colorSuccess }} />
        <Typography.Text strong>Gateway Sessions</Typography.Text>
        <Badge
          count={gatewaySessions.length}
          showZero
          style={{ backgroundColor: token.colorSuccessBgHover }}
        />
        {hasRunningGatewaySession && <Spin size="small" />}
      </Space>
    </div>
  );

  // Gateway sessions content (flat list with channel info)
  const gatewaySessionsContent = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {gatewaySessions.map((session) => {
        // Extract denormalized gateway metadata (stamped at session creation)
        const gatewaySource = getGatewaySource(session);

        const isActive = session.status === 'running' || session.status === 'stopping';

        return (
          <SessionItemWithActions
            key={session.session_id}
            sessionId={session.session_id}
            isArchiving={archivingSessionIds.has(session.session_id)}
            onArchive={handleArchiveSession}
            onSettings={
              onOpenSessionSettings
                ? (id, e) => {
                    e.stopPropagation();
                    onOpenSessionSettings(id);
                  }
                : undefined
            }
          >
            <div
              style={{
                border: `1px solid rgba(255, 255, 255, 0.1)`,
                borderRadius: 4,
                padding: 8,
                background: 'transparent',
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
              }}
              onClick={() => onSessionClick?.(session.session_id)}
            >
              <Space size={4} align="center" style={{ flex: 1, minWidth: 0 }}>
                {isActive ? (
                  <Spin size="small" />
                ) : (
                  <ToolIcon tool={session.agentic_tool} size={20} />
                )}
                <div
                  style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}
                >
                  <Typography.Text
                    style={{
                      fontSize: 12,
                      ...getSessionTitleStyles(2),
                    }}
                  >
                    {getSessionDisplayTitle(session, { includeAgentFallback: true })}
                  </Typography.Text>
                  <div style={{ alignSelf: 'flex-start' }}>
                    {gatewaySource ? (
                      <ChannelPill
                        channelType={gatewaySource.channel_type}
                        channelName={gatewaySource.channel_name}
                      />
                    ) : (
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 11, fontStyle: 'italic' }}
                      >
                        (Gateway - metadata unavailable)
                      </Typography.Text>
                    )}
                  </div>
                </div>
              </Space>
            </div>
          </SessionItemWithActions>
        );
      })}
    </div>
  );

  const isDarkMode = isDarkTheme(token);

  // Memoize glow shadow string to avoid recomputing color normalization on every render
  const attentionGlowShadow = useMemo(() => {
    const rawGlowColor = token.colorTextBase || (isDarkMode ? '#ffffff' : '#000000');

    let glowColor: string;
    try {
      const color = new AggregationColor(rawGlowColor);
      glowColor = color.toHexString();
    } catch {
      glowColor = isDarkMode ? '#ffffff' : '#000000';
    }

    // 2-layer glow: tight solid ring + soft halo (reduced from 4 layers for less paint work)
    return `0 0 0 3px ${glowColor}, 0 0 24px 6px ${glowColor}99`;
  }, [token.colorTextBase, isDarkMode]);

  // Ensure pin color is visible (adjust lightness if too pale)
  const visiblePinColor = useMemo(() => {
    if (!zoneColor) return undefined;
    return ensureColorVisible(zoneColor, isDarkMode, 50, 50);
  }, [zoneColor, isDarkMode]);

  // Determine if notes should show "See more" button
  const notesNeedTruncation = worktree.notes && worktree.notes.length > NOTES_MAX_LENGTH;
  const displayedNotes = useMemo(() => {
    if (!worktree.notes) return '';
    if (!notesNeedTruncation || notesExpanded) return worktree.notes;
    // Truncate at word boundary for cleaner display
    const truncated = worktree.notes.slice(0, NOTES_MAX_LENGTH);
    const lastSpace = truncated.lastIndexOf(' ');
    return lastSpace > NOTES_MAX_LENGTH * 0.8
      ? `${truncated.slice(0, lastSpace)}...`
      : `${truncated}...`;
  }, [worktree.notes, notesNeedTruncation, notesExpanded]);

  return (
    <Card
      style={{
        width: 500,
        cursor: 'default', // Override React Flow's drag cursor - only drag handles should show grab cursor
        transition: 'box-shadow 0.6s ease-in-out, border 0.6s ease-in-out',
        willChange: needsAttention && !inPopover ? 'box-shadow' : 'auto',
        ...(needsAttention && !inPopover
          ? {
              boxShadow: attentionGlowShadow,
              border: 'none',
            }
          : isPinned && zoneColor
            ? { borderColor: zoneColor, borderWidth: 1 }
            : isAgent
              ? { borderColor: token.colorInfo, borderWidth: 1 }
              : {}),
        ...(isAgent ? { backgroundColor: token.colorInfoBg } : {}),
      }}
      styles={{
        body: { padding: 16 },
      }}
    >
      {/* Worktree header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <Space size={8} align="center">
          {!inPopover && (
            <div
              className="drag-handle"
              style={{
                display: 'flex',
                alignItems: 'center',
                cursor: 'grab',
                width: 32,
                height: 32,
                justifyContent: 'center',
              }}
            >
              {isCreating || hasRunningSession ? (
                <Spin size="large" />
              ) : isAgent && assistantConfig?.emoji ? (
                <span style={{ fontSize: 32 }}>{assistantConfig.emoji}</span>
              ) : isAgent ? (
                <RobotOutlined
                  style={{
                    fontSize: 32,
                    color: isFailed ? token.colorError : token.colorInfo,
                  }}
                />
              ) : (
                <BranchesOutlined
                  style={{
                    fontSize: 32,
                    color: isFailed ? token.colorError : token.colorPrimary,
                  }}
                />
              )}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <Typography.Text strong className="nodrag">
              {assistantConfig?.displayName ?? worktree.name}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {assistantConfig ? `${repo.slug} / ${worktree.name}` : repo.slug}
            </Typography.Text>
          </div>
        </Space>

        <Space size={4}>
          {!inPopover && isPinned && (
            <Tooltip
              title={
                zoneName
                  ? `Pinned to [${zoneName}] zone (click to unpin)`
                  : 'Pinned (click to unpin)'
              }
            >
              <Button
                type="text"
                size="small"
                icon={<PushpinFilled style={{ color: visiblePinColor }} />}
                onClick={(e) => {
                  e.stopPropagation();
                  onUnpin?.(worktree.worktree_id);
                }}
                className="nodrag"
              />
            </Tooltip>
          )}
          {!inPopover && (
            <Button
              type="text"
              size="small"
              icon={<DragOutlined />}
              className="drag-handle"
              title="Drag to reposition"
              style={{ cursor: 'grab' }}
            />
          )}
          <div className="nodrag">
            {onOpenTerminal && (
              <Button
                type="text"
                size="small"
                icon={<CodeOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenTerminal([`cd ${worktree.path}`], worktree.worktree_id);
                }}
                title="Open terminal in worktree directory"
              />
            )}
            {onOpenSettings && (
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSettings(worktree.worktree_id);
                }}
                title="Edit worktree"
              />
            )}
            {!inPopover && onArchiveOrDelete && (
              <Button
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                disabled={connectionDisabled}
                onClick={(e) => {
                  e.stopPropagation();
                  setArchiveDeleteModalOpen(true);
                }}
                title="Archive or delete worktree"
                danger
              />
            )}
          </div>
        </Space>
      </div>

      {/* Worktree metadata - all pills on one row with wrapping */}
      <div className="nodrag" style={{ marginBottom: 8 }}>
        <Space size={4} wrap>
          {worktree.created_by && (
            <CreatedByTag
              createdBy={worktree.created_by}
              currentUserId={currentUserId}
              userById={userById}
              prefix="Created by"
            />
          )}
          {worktree.issue_url && <IssuePill issueUrl={worktree.issue_url} />}
          {worktree.pull_request_url && <PullRequestPill prUrl={worktree.pull_request_url} />}
          <EnvironmentPill
            repo={repo}
            worktree={worktree}
            onEdit={() => onOpenSettings?.(worktree.worktree_id)}
            onStartEnvironment={onStartEnvironment}
            onStopEnvironment={onStopEnvironment}
            onViewLogs={onViewLogs}
            onNukeEnvironment={onNukeEnvironment}
            connectionDisabled={connectionDisabled}
          />
        </Space>
      </div>

      {/* Notes */}
      {worktree.notes && (
        <div className="nodrag" style={{ marginBottom: 8 }}>
          <div
            className="markdown-compact"
            style={{
              maxHeight: notesExpanded ? 'none' : '120px',
              overflow: 'hidden',
              transition: 'max-height 0.3s ease',
            }}
          >
            <MarkdownRenderer
              content={displayedNotes}
              style={{ fontSize: 12, color: token.colorTextSecondary, lineHeight: '1.5' }}
              compact={false}
              showControls={false}
            />
          </div>
          {notesNeedTruncation && (
            <Button
              type="link"
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                setNotesExpanded(!notesExpanded);
              }}
              style={{
                padding: 0,
                height: 'auto',
                fontSize: 12,
                color: token.colorLink,
              }}
            >
              {notesExpanded ? 'See less' : 'See more'}
            </Button>
          )}
        </div>
      )}

      {/* Sessions & Scheduled Runs - collapsible sections */}
      <div className="nodrag">
        {activeSessions.length === 0 ? (
          // No active sessions: show create button without collapse wrapper
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              alignItems: 'center',
              padding: '16px 0',
              marginTop: 8,
            }}
          >
            {isCreating ? (
              <Typography.Text type="secondary">Creating worktree on filesystem...</Typography.Text>
            ) : isFailed ? (
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'center' }}
              >
                <Typography.Text type="danger" strong>
                  Worktree creation failed
                </Typography.Text>
                {worktree.error_message && (
                  <Tooltip title={worktree.error_message} placement="bottom">
                    <Typography.Text
                      type="secondary"
                      style={{
                        fontSize: 12,
                        maxWidth: 220,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        cursor: 'help',
                      }}
                    >
                      {worktree.error_message}
                    </Typography.Text>
                  </Tooltip>
                )}
              </div>
            ) : onCreateSession ? (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={connectionDisabled}
                onClick={(e) => {
                  e.stopPropagation();
                  onCreateSession(worktree.worktree_id);
                }}
                size="middle"
              >
                Create Session
              </Button>
            ) : null}
          </div>
        ) : (
          // Has sessions: show collapsible sections
          <>
            {/* Manual Sessions */}
            {manualSessions.length > 0 && (
              <Collapse
                defaultActiveKey={defaultExpanded ? ['sessions'] : []}
                items={[
                  {
                    key: 'sessions',
                    label: sessionListHeader,
                    children: sessionListContent,
                    styles: { body: { background: 'transparent' } },
                  },
                ]}
                ghost
                style={{ marginTop: 8 }}
              />
            )}

            {/* Scheduled Runs */}
            {schedulerEnabled && scheduledSessions.length > 0 && (
              <Collapse
                defaultActiveKey={[]}
                items={[
                  {
                    key: 'scheduled-runs',
                    label: scheduledRunsHeader,
                    children: scheduledRunsContent,
                    styles: { body: { background: 'transparent' } },
                  },
                ]}
                ghost
                style={{ marginTop: manualSessions.length > 0 ? 0 : 8 }}
              />
            )}

            {/* Gateway Sessions */}
            {gatewayEnabled && gatewaySessions.length > 0 && (
              <Collapse
                defaultActiveKey={[]}
                items={[
                  {
                    key: 'gateway-sessions',
                    label: gatewaySessionsHeader,
                    children: gatewaySessionsContent,
                    styles: { body: { background: 'transparent' } },
                  },
                ]}
                ghost
                style={{
                  marginTop: manualSessions.length > 0 || scheduledSessions.length > 0 ? 0 : 8,
                }}
              />
            )}
          </>
        )}
      </div>

      {/* Fork/Spawn Modal */}
      <ForkSpawnModal
        open={forkSpawnModal.open}
        action={forkSpawnModal.action}
        session={forkSpawnModal.session}
        currentUser={currentUserId ? userById.get(currentUserId) : undefined}
        onConfirm={handleForkSpawnConfirm}
        onCancel={() =>
          setForkSpawnModal({
            open: false,
            action: 'fork',
            session: null,
          })
        }
        client={client}
        userById={userById}
      />

      {/* Archive/Delete Modal */}
      <ArchiveDeleteWorktreeModal
        open={archiveDeleteModalOpen}
        worktree={worktree}
        sessionCount={sessions.length}
        environmentRunning={worktree.environment_instance?.status === 'running'}
        onConfirm={(options) => {
          onArchiveOrDelete?.(worktree.worktree_id, options);
          setArchiveDeleteModalOpen(false);
        }}
        onCancel={() => setArchiveDeleteModalOpen(false)}
      />
    </Card>
  );
};

// Memoize WorktreeCard to prevent unnecessary re-renders when parent updates
// Only re-render when worktree, repo, sessions, or callback props actually change
const WorktreeCard = React.memo(WorktreeCardComponent);

export default WorktreeCard;
