import type { AgorClient, Branch, Session, SessionID, SpawnConfig, User } from '@agor-live/client';
import {
  getGatewaySource as getGatewaySourceCore,
  isGatewaySession as isGatewaySessionCore,
  isSessionExecuting,
  SessionStatus,
} from '@agor-live/client';
import {
  ArrowUpOutlined,
  ClockCircleOutlined,
  DisconnectOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  EyeOutlined,
  LinkOutlined,
  MessageOutlined,
  PlusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  App,
  Badge,
  Button,
  Collapse,
  ConfigProvider,
  Space,
  Spin,
  Tooltip,
  Tree,
  Typography,
  theme,
} from 'antd';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { useServiceEnabled } from '../../hooks/useServicesConfig';
import { useSessionActions } from '../../hooks/useSessionActions';
import { useThemedMessage } from '../../utils/message';
import {
  getMatchSnippet,
  isSessionSearchActive,
  SESSION_SORT_STORAGE_KEY,
  type SessionSort,
  searchSessions,
  sessionToolMatches,
  sortSessions,
} from '../../utils/sessionSearch';
import { getSessionDisplayTitle, getSessionTitleStyles } from '../../utils/sessionTitle';
import { ArchiveActionButton } from '../ArchiveButton';
import { type ForkSpawnAction, ForkSpawnModal } from '../ForkSpawnModal';
import { HighlightMatch } from '../HighlightMatch';
import { ChannelPill } from '../Pill';
import { SessionRelationshipIcon } from '../SessionRelationshipIcon';
import {
  SessionRelevanceLabel,
  SessionSearchToolbar,
  SessionSortButton,
} from '../SessionSearchControls';
import { ToolIcon } from '../ToolIcon';
import { buildSessionTree, type SessionTreeNode } from './buildSessionTree';

export type BranchSessionSectionsMode = 'card' | 'panel';

export interface BranchSessionSectionsProps {
  branch: Branch;
  sessions: Session[];
  userById: Map<string, User>;
  currentUserId?: string;
  selectedSessionId?: string | null;
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (branchId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, config: string | Partial<SpawnConfig>) => Promise<void>;
  onOpenSessionSettings?: (sessionId: string) => void;
  peekedSessionIds?: Set<string>;
  onTogglePeekSession?: (sessionId: string) => void;
  defaultExpanded?: boolean;
  mode?: BranchSessionSectionsMode;
  client: AgorClient | null;
}

/** Wrapper that adds hover action buttons (settings + archive) overlay to session items */
const SessionItemWithActions: React.FC<{
  sessionId: string;
  isArchiving: boolean;
  isPeeked?: boolean;
  onArchive: (sessionId: string, e: React.MouseEvent) => void;
  onSettings?: (sessionId: string, e: React.MouseEvent) => void;
  onTogglePeek?: (sessionId: string, e: React.MouseEvent) => void;
  onToggleCallback?: (sessionId: string, e: React.MouseEvent) => void;
  onOpenRemoteParent?: (sessionId: string, e: React.MouseEvent) => void;
  callbackToggle?: {
    enabled: boolean;
    disabled?: boolean;
    tooltip: string;
  };
  remoteParentLink?: {
    disabled?: boolean;
    tooltip: string;
  };
  children: React.ReactNode;
}> = ({
  sessionId,
  isArchiving,
  isPeeked = false,
  onArchive,
  onSettings,
  onTogglePeek,
  onToggleCallback,
  onOpenRemoteParent,
  callbackToggle,
  remoteParentLink,
  children,
}) => {
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
  const peekButtonStyle: React.CSSProperties = isPeeked
    ? {
        ...buttonStyle,
        color: token.colorPrimary,
        background: token.colorPrimaryBg,
      }
    : buttonStyle;

  return (
    <div
      style={{ position: 'relative', minWidth: 0, width: '100%' }}
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
        {onTogglePeek && (
          <Tooltip title={isPeeked ? 'Stop peeking at latest prompt' : 'Peek at latest prompt'}>
            <Button
              type="text"
              size="small"
              icon={<EyeOutlined />}
              onClick={(e) => onTogglePeek(sessionId, e)}
              style={peekButtonStyle}
            />
          </Tooltip>
        )}
        {onOpenRemoteParent && remoteParentLink && (
          <Tooltip title={remoteParentLink.tooltip}>
            <Button
              type="text"
              size="small"
              disabled={remoteParentLink.disabled}
              icon={<ArrowUpOutlined />}
              onClick={(e) => onOpenRemoteParent(sessionId, e)}
              style={{
                ...buttonStyle,
                color: token.colorTextSecondary,
              }}
            />
          </Tooltip>
        )}
        {onToggleCallback && callbackToggle && (
          <Tooltip title={callbackToggle.tooltip}>
            <Button
              type="text"
              size="small"
              disabled={callbackToggle.disabled}
              icon={callbackToggle.enabled ? <LinkOutlined /> : <DisconnectOutlined />}
              onClick={(e) => onToggleCallback(sessionId, e)}
              style={{
                ...buttonStyle,
                color: callbackToggle.enabled ? token.colorPrimary : token.colorTextTertiary,
                background: callbackToggle.enabled ? token.colorPrimaryBg : buttonStyle.background,
              }}
            />
          </Tooltip>
        )}
        <ArchiveActionButton
          tooltip="Archive session"
          loading={isArchiving}
          onClick={(e) => onArchive(sessionId, e)}
          style={buttonStyle}
        />
      </div>
    </div>
  );
};

export const BranchSessionSections: React.FC<BranchSessionSectionsProps> = ({
  branch,
  sessions,
  userById,
  currentUserId,
  selectedSessionId,
  onSessionClick,
  onCreateSession,
  onForkSession,
  onSpawnSession,
  onOpenSessionSettings,
  peekedSessionIds,
  onTogglePeekSession,
  defaultExpanded = true,
  mode = 'card',
  client,
}) => {
  const { token } = theme.useToken();
  const { modal } = App.useApp();
  const { showSuccess, showError } = useThemedMessage();
  const connectionDisabled = useConnectionDisabled();
  const schedulerEnabled = useServiceEnabled('scheduler');
  const gatewayEnabled = useServiceEnabled('gateway');
  const { archiveSession } = useSessionActions(client);

  const [forkSpawnModal, setForkSpawnModal] = useState<{
    open: boolean;
    action: ForkSpawnAction;
    session: Session | null;
  }>({
    open: false,
    action: 'fork',
    session: null,
  });
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [archivingSessionIds, setArchivingSessionIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [sort, setSort] = useLocalStorage<SessionSort>(SESSION_SORT_STORAGE_KEY, 'recent');

  const isPanel = mode === 'panel';
  const peekedIds = peekedSessionIds ?? new Set<string>();
  const trimmedSearchQuery = searchQuery.trim();
  const searchActive = isSessionSearchActive(trimmedSearchQuery);

  const handleTogglePeekSession = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      onTogglePeekSession?.(sessionId);
    },
    [onTogglePeekSession]
  );

  const getCallbackRelationship = useCallback((session: Session) => {
    return (
      session.remote_surrogate?.relationship ??
      session.remote_relationships?.as_target?.find(
        (relationship) => relationship.relationship_type === 'remote_create'
      )
    );
  }, []);

  const getRemoteParentId = useCallback(
    (session: Session): string | undefined => {
      if (session.remote_surrogate) return undefined;

      const relationshipParentId = session.remote_relationships?.as_target?.find(
        (relationship) => relationship.relationship_type === 'remote_create'
      )?.source_session_id;
      if (relationshipParentId) return relationshipParentId;

      // Defensive fallback for live-patched session rows that may temporarily
      // lack enriched remote_relationships. A cross-branch callback target is
      // still local to the already-loaded Agor session store and points at the
      // same creator/remote-parent session for remote-created children.
      const callbackTargetId = session.callback_config?.callback_session_id;
      const callbackTarget = callbackTargetId
        ? sessions.find((candidate) => candidate.session_id === callbackTargetId)
        : undefined;
      if (callbackTarget && callbackTarget.branch_id !== session.branch_id) {
        return callbackTargetId;
      }

      return undefined;
    },
    [sessions]
  );

  const getCallbackTargetId = useCallback(
    (session: Session): string | undefined => {
      const relationship = getCallbackRelationship(session);
      return (
        session.callback_config?.callback_session_id ??
        relationship?.callback_session_id ??
        session.genealogy?.parent_session_id ??
        session.remote_surrogate?.source_session_id
      );
    },
    [getCallbackRelationship]
  );

  const getCallbackToggle = useCallback(
    (session: Session) => {
      const targetId = getCallbackTargetId(session);
      if (!targetId) return null;

      const relationship = getCallbackRelationship(session);
      const enabled = session.callback_config?.enabled ?? relationship?.callback_enabled ?? true;

      return {
        enabled,
        disabled: connectionDisabled || !client,
        tooltip: enabled
          ? 'Callbacks linked — click to stop callback notifications while keeping the relationship'
          : 'Callbacks unlinked — click to resume callback notifications for this relationship',
      };
    },
    [client, connectionDisabled, getCallbackRelationship, getCallbackTargetId]
  );

  const handleToggleCallback = useCallback(
    async (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!client) return;

      const session = sessions.find((candidate) => candidate.session_id === sessionId);
      if (!session) return;

      const targetId = getCallbackTargetId(session);
      if (!targetId) return;

      const toggle = getCallbackToggle(session);
      const nextEnabled = !(toggle?.enabled ?? false);

      try {
        await client.service('sessions').patch(session.session_id, {
          callback_config: {
            ...(session.callback_config ?? {}),
            callback_session_id: targetId as SessionID,
            enabled: nextEnabled,
          },
        });
        showSuccess(nextEnabled ? 'Callbacks linked' : 'Callbacks unlinked');
      } catch (error) {
        showError(
          `Failed to update callbacks: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    [client, getCallbackTargetId, getCallbackToggle, sessions, showError, showSuccess]
  );

  const handleOpenRemoteParent = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      const session = sessions.find((candidate) => candidate.session_id === sessionId);
      const remoteParentId = session ? getRemoteParentId(session) : undefined;
      if (!remoteParentId) return;
      onSessionClick?.(remoteParentId);
    },
    [getRemoteParentId, onSessionClick, sessions]
  );

  const handleForkSpawnConfirm = async (config: string | Partial<SpawnConfig>) => {
    if (!forkSpawnModal.session) return;

    if (forkSpawnModal.action === 'fork') {
      const prompt = typeof config === 'string' ? config : config.prompt || '';
      await onForkSession?.(forkSpawnModal.session.session_id, prompt);
    } else {
      await onSpawnSession?.(forkSpawnModal.session.session_id, config);
    }
  };

  const handleArchiveSession = useCallback(
    (sessionId: string, e: React.MouseEvent) => {
      e.stopPropagation();

      modal.confirm({
        title: 'Archive session?',
        content: 'Are you sure you want to archive this session?',
        okText: 'Archive',
        cancelText: 'Cancel',
        onOk: async () => {
          setArchivingSessionIds((prev) => new Set(prev).add(sessionId));
          try {
            const result = await archiveSession(sessionId as SessionID);
            if (result) {
              showSuccess('Session archived');
            } else {
              showError('Failed to archive session');
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
    [archiveSession, modal, showSuccess, showError]
  );

  const getGatewaySource = useCallback(
    (session: Session) => getGatewaySourceCore(session) ?? undefined,
    []
  );

  const isGatewaySession = useCallback((session: Session): boolean => {
    return isGatewaySessionCore(session);
  }, []);

  const activeSessions = useMemo(() => sessions.filter((s) => !s.archived), [sessions]);
  const manualSessions = useMemo(
    () => activeSessions.filter((s) => !s.scheduled_from_branch && !isGatewaySession(s)),
    [activeSessions, isGatewaySession]
  );
  const scheduledSessions = useMemo(
    () =>
      activeSessions
        .filter((s) => s.scheduled_from_branch)
        .sort((a, b) => (b.scheduled_run_at || 0) - (a.scheduled_run_at || 0)),
    [activeSessions]
  );
  const gatewaySessions = useMemo(
    () => activeSessions.filter((s) => isGatewaySession(s)),
    [activeSessions, isGatewaySession]
  );
  const searchablePanelSessions = useMemo(
    () => [
      ...manualSessions,
      ...(schedulerEnabled ? scheduledSessions : []),
      ...(gatewayEnabled ? gatewaySessions : []),
    ],
    [gatewayEnabled, gatewaySessions, manualSessions, scheduledSessions, schedulerEnabled]
  );
  const sortedManualSessions = useMemo(
    () => sortSessions(manualSessions, sort),
    [manualSessions, sort]
  );
  const sessionTreeData = useMemo(
    () => buildSessionTree(sortedManualSessions),
    [sortedManualSessions]
  );
  const searchResults = useMemo(
    () =>
      isPanel && searchActive
        ? searchSessions(searchablePanelSessions, trimmedSearchQuery).map(({ session }) => session)
        : [],
    [isPanel, searchActive, searchablePanelSessions, trimmedSearchQuery]
  );

  const hasRunningScheduledSession = useMemo(
    () => scheduledSessions.some(isSessionExecuting),
    [scheduledSessions]
  );
  const hasRunningGatewaySession = useMemo(
    () => gatewaySessions.some(isSessionExecuting),
    [gatewaySessions]
  );

  const isCreating = branch.filesystem_status === 'creating';
  const isFailed = branch.filesystem_status === 'failed';

  const isSessionFailed = (session: Session): boolean => session.status === SessionStatus.FAILED;

  useEffect(() => {
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

    setExpandedKeys(collectKeysWithChildren(sessionTreeData));
  }, [sessionTreeData]);

  const sessionRowStyle = (session: Session): React.CSSProperties => {
    const isSessionSelected = session.session_id === selectedSessionId;
    const isRemoteSurrogate = Boolean(session.remote_surrogate);
    return {
      border: session.ready_for_prompt
        ? `1px solid ${token.colorPrimary}`
        : isRemoteSurrogate
          ? `1px dashed ${token.colorBorderSecondary}`
          : `1px solid ${isPanel ? token.colorBorderSecondary : 'rgba(255, 255, 255, 0.1)'}`,
      borderRadius: isPanel ? 6 : 4,
      padding: isPanel ? 10 : 8,
      background: isRemoteSurrogate
        ? token.colorFillQuaternary
        : isPanel
          ? token.colorBgContainer
          : 'transparent',
      display: 'flex',
      alignItems: 'center',
      width: '100%',
      boxSizing: 'border-box',
      cursor: 'pointer',
      marginBottom: 4,
      opacity: isRemoteSurrogate ? 0.78 : undefined,
      boxShadow: session.ready_for_prompt ? `0 0 12px ${token.colorPrimary}30` : undefined,
      ...(isSessionSelected
        ? { outline: `1px dashed ${token.colorTextBase}`, outlineOffset: -2 }
        : {}),
    };
  };

  const renderSessionTitle = (
    session: Session,
    options: { strong?: boolean; secondary?: boolean; query?: string } = {}
  ) => {
    const titleText = getSessionDisplayTitle(session, { includeAgentFallback: true });
    const failed = isSessionFailed(session);

    return (
      <Typography.Text
        strong={options.strong}
        type={failed ? 'danger' : options.secondary ? 'secondary' : undefined}
        style={{
          fontSize: isPanel ? 13 : 12,
          flex: 1,
          minWidth: 0,
          ...getSessionTitleStyles(2),
        }}
      >
        <HighlightMatch text={titleText} query={options.query ?? ''} />
      </Typography.Text>
    );
  };

  const renderSessionFailureIcon = (session: Session) => {
    if (!isSessionFailed(session)) return null;

    return (
      <Tooltip title="Latest task failed">
        <ExclamationCircleOutlined
          aria-label="Latest task failed"
          style={{ color: token.colorErrorText, fontSize: 12, flex: '0 0 auto' }}
        />
      </Tooltip>
    );
  };

  const renderSessionTitleWithFailure = (
    session: Session,
    options: { strong?: boolean; secondary?: boolean; query?: string } = {}
  ) => (
    <>
      {renderSessionFailureIcon(session)}
      {renderSessionTitle(session, options)}
    </>
  );

  const renderFlatSessionRow = (session: Session, query = '') => {
    const isActive = isSessionExecuting(session);
    const callbackToggle = getCallbackToggle(session);
    const remoteParentId = getRemoteParentId(session);
    const titleText = getSessionDisplayTitle(session, { includeAgentFallback: true });
    const descriptionSnippet =
      query && session.title && session.description
        ? getMatchSnippet(session.description, query)
        : null;
    const toolMatches = query ? sessionToolMatches(session, query) : false;
    const sourceLabel = session.scheduled_from_branch
      ? 'Scheduled'
      : isGatewaySession(session)
        ? 'Gateway'
        : null;

    return (
      <SessionItemWithActions
        key={session.session_id}
        sessionId={session.session_id}
        isArchiving={archivingSessionIds.has(session.session_id)}
        onArchive={handleArchiveSession}
        callbackToggle={callbackToggle ?? undefined}
        onToggleCallback={callbackToggle ? handleToggleCallback : undefined}
        remoteParentLink={
          remoteParentId
            ? { tooltip: 'Open remote parent session that created this session' }
            : undefined
        }
        onOpenRemoteParent={remoteParentId ? handleOpenRemoteParent : undefined}
        onSettings={
          onOpenSessionSettings
            ? (id, e) => {
                e.stopPropagation();
                onOpenSessionSettings(id);
              }
            : undefined
        }
      >
        <div style={sessionRowStyle(session)} onClick={() => onSessionClick?.(session.session_id)}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, flex: 1, minWidth: 0 }}>
            {isActive ? <Spin size="small" /> : <ToolIcon tool={session.agentic_tool} size={20} />}
            <SessionRelationshipIcon session={session} size={10} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                {renderSessionTitleWithFailure(session, { query })}
              </div>
              {(sourceLabel || toolMatches) && (
                <Typography.Text
                  type="secondary"
                  style={{ fontSize: 11, display: 'block', marginTop: 2 }}
                >
                  {sourceLabel}
                  {sourceLabel && toolMatches ? ' · ' : ''}
                  {toolMatches && (
                    <>
                      Agent: <HighlightMatch text={session.agentic_tool} query={query} />
                    </>
                  )}
                </Typography.Text>
              )}
              {descriptionSnippet && descriptionSnippet !== titleText && (
                <Typography.Text
                  type="secondary"
                  style={{
                    fontSize: 11,
                    fontStyle: 'italic',
                    lineHeight: 1.4,
                    display: 'block',
                    marginTop: 2,
                  }}
                >
                  <HighlightMatch text={descriptionSnippet} query={query} />
                </Typography.Text>
              )}
            </div>
          </div>
        </div>
      </SessionItemWithActions>
    );
  };

  const renderSessionNode = (node: SessionTreeNode) => {
    const session = node.session;
    const isActive = isSessionExecuting(session);
    const isRemoteSurrogate = node.relationshipType === 'remote';
    const callbackToggle = getCallbackToggle(session);
    const remoteParentId = getRemoteParentId(session);

    return (
      <SessionItemWithActions
        sessionId={session.session_id}
        isArchiving={archivingSessionIds.has(session.session_id)}
        isPeeked={peekedIds.has(session.session_id)}
        onArchive={handleArchiveSession}
        onTogglePeek={onTogglePeekSession ? handleTogglePeekSession : undefined}
        callbackToggle={callbackToggle ?? undefined}
        onToggleCallback={callbackToggle ? handleToggleCallback : undefined}
        remoteParentLink={
          remoteParentId
            ? { tooltip: 'Open remote parent session that created this session' }
            : undefined
        }
        onOpenRemoteParent={remoteParentId ? handleOpenRemoteParent : undefined}
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
          style={sessionRowStyle(session)}
          onClick={() => onSessionClick?.(session.session_id)}
          onContextMenu={(e) => {
            if (onForkSession || onSpawnSession) {
              e.preventDefault();
            }
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0 }}>
            {isActive ? <Spin size="small" /> : <ToolIcon tool={session.agentic_tool} size={20} />}
            {isRemoteSurrogate ? (
              <Tooltip title="Remote session created from this session. Click to open it in its own branch.">
                <ExportOutlined style={{ fontSize: 11, color: token.colorTextTertiary }} />
              </Tooltip>
            ) : (
              <SessionRelationshipIcon session={session} size={10} />
            )}
            {renderSessionTitleWithFailure(session)}
          </div>
        </div>
      </SessionItemWithActions>
    );
  };

  const sessionListContent = (
    <ConfigProvider theme={{ components: { Tree: { colorBgContainer: 'transparent' } } }}>
      <Tree
        className="agor-flat-tree"
        treeData={sessionTreeData}
        expandedKeys={expandedKeys}
        onExpand={(keys) => setExpandedKeys(keys as React.Key[])}
        showLine
        showIcon={false}
        blockNode
        selectable={false}
        style={{ background: 'transparent', borderRadius: 0, padding: 0 }}
        titleRender={renderSessionNode}
      />
    </ConfigProvider>
  );

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
        {!isPanel && (
          <SessionSortButton sort={sort} onSortChange={setSort} compact stopPropagation />
        )}
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
              onCreateSession(branch.branch_id);
            }}
            title={isCreating ? 'Branch is being created...' : undefined}
          >
            New Session
          </Button>
        </div>
      )}
    </div>
  );

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

  const scheduledRunsContent = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {scheduledSessions.map((session) => {
        const isActive = isSessionExecuting(session);
        const callbackToggle = getCallbackToggle(session);
        const remoteParentId = getRemoteParentId(session);
        return (
          <SessionItemWithActions
            key={session.session_id}
            sessionId={session.session_id}
            isArchiving={archivingSessionIds.has(session.session_id)}
            isPeeked={peekedIds.has(session.session_id)}
            onArchive={handleArchiveSession}
            onTogglePeek={onTogglePeekSession ? handleTogglePeekSession : undefined}
            callbackToggle={callbackToggle ?? undefined}
            onToggleCallback={callbackToggle ? handleToggleCallback : undefined}
            remoteParentLink={
              remoteParentId
                ? { tooltip: 'Open remote parent session that created this session' }
                : undefined
            }
            onOpenRemoteParent={remoteParentId ? handleOpenRemoteParent : undefined}
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
              style={sessionRowStyle(session)}
              onClick={() => onSessionClick?.(session.session_id)}
            >
              <Space size={4} align="center" style={{ flex: 1, minWidth: 0 }}>
                {isActive ? (
                  <Spin size="small" />
                ) : (
                  <ToolIcon tool={session.agentic_tool} size={20} />
                )}
                {renderSessionTitleWithFailure(session, { secondary: true })}
              </Space>
            </div>
          </SessionItemWithActions>
        );
      })}
    </div>
  );

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

  const gatewaySessionsContent = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {gatewaySessions.map((session) => {
        const gatewaySource = getGatewaySource(session);
        const isActive = isSessionExecuting(session);
        const callbackToggle = getCallbackToggle(session);
        const remoteParentId = getRemoteParentId(session);

        return (
          <SessionItemWithActions
            key={session.session_id}
            sessionId={session.session_id}
            isArchiving={archivingSessionIds.has(session.session_id)}
            isPeeked={peekedIds.has(session.session_id)}
            onArchive={handleArchiveSession}
            onTogglePeek={onTogglePeekSession ? handleTogglePeekSession : undefined}
            callbackToggle={callbackToggle ?? undefined}
            onToggleCallback={callbackToggle ? handleToggleCallback : undefined}
            remoteParentLink={
              remoteParentId
                ? { tooltip: 'Open remote parent session that created this session' }
                : undefined
            }
            onOpenRemoteParent={remoteParentId ? handleOpenRemoteParent : undefined}
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
              style={sessionRowStyle(session)}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                    {renderSessionTitleWithFailure(session)}
                  </div>
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

  const sessionSearchBar =
    isPanel && activeSessions.length > 0 ? (
      <div style={{ paddingBottom: 12, paddingTop: 4 }}>
        <SessionSearchToolbar
          value={searchQuery}
          onChange={setSearchQuery}
          sort={sort}
          onSortChange={setSort}
          searching={searchActive}
        />
      </div>
    ) : null;

  if (isPanel && searchActive && searchablePanelSessions.length > 0) {
    return (
      <>
        {sessionSearchBar}
        {searchResults.length > 0 && (
          <Typography.Text
            type="secondary"
            style={{ fontSize: 11, padding: '2px 8px 4px', display: 'block' }}
          >
            {searchResults.length} of {searchablePanelSessions.length} · <SessionRelevanceLabel />
          </Typography.Text>
        )}
        {searchResults.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: '24px 16px',
              gap: 6,
            }}
          >
            <Typography.Text strong style={{ fontSize: 13 }}>
              No results
            </Typography.Text>
            <Typography.Text
              type="secondary"
              style={{ fontSize: 12, textAlign: 'center', lineHeight: 1.5, maxWidth: 180 }}
            >
              Nothing matched <Typography.Text code>{trimmedSearchQuery}</Typography.Text>
            </Typography.Text>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {searchResults.map((session) => renderFlatSessionRow(session, trimmedSearchQuery))}
          </div>
        )}

        <ForkSpawnModal
          open={forkSpawnModal.open}
          action={forkSpawnModal.action}
          session={forkSpawnModal.session}
          currentUser={currentUserId ? userById.get(currentUserId) : undefined}
          onConfirm={handleForkSpawnConfirm}
          onCancel={() => setForkSpawnModal({ open: false, action: 'fork', session: null })}
          client={client}
          userById={userById}
        />
      </>
    );
  }

  return (
    <>
      {sessionSearchBar}
      {activeSessions.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            alignItems: 'center',
            padding: isPanel ? '24px 0' : '16px 0',
            marginTop: 8,
          }}
        >
          {isCreating ? (
            <Typography.Text type="secondary">Creating branch on filesystem...</Typography.Text>
          ) : isFailed ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'center' }}>
              <Typography.Text type="danger" strong>
                Branch creation failed
              </Typography.Text>
              {branch.error_message && (
                <Tooltip title={branch.error_message} placement="bottom">
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
                    {branch.error_message}
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
                onCreateSession(branch.branch_id);
              }}
              size="middle"
            >
              Create Session
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {manualSessions.length > 0 ? (
            <Collapse
              defaultActiveKey={defaultExpanded ? ['sessions'] : []}
              items={[
                {
                  key: 'sessions',
                  label: sessionListHeader,
                  children: sessionListContent,
                  styles: {
                    body: { background: 'transparent', paddingInline: isPanel ? 0 : undefined },
                  },
                },
              ]}
              ghost
              style={{ marginTop: 8 }}
            />
          ) : onCreateSession ? (
            <div style={{ marginTop: 8 }}>{sessionListHeader}</div>
          ) : null}

          {schedulerEnabled && scheduledSessions.length > 0 && (
            <Collapse
              defaultActiveKey={[]}
              items={[
                {
                  key: 'scheduled-runs',
                  label: scheduledRunsHeader,
                  children: scheduledRunsContent,
                  styles: {
                    body: { background: 'transparent', paddingInline: isPanel ? 0 : undefined },
                  },
                },
              ]}
              ghost
              style={{ marginTop: manualSessions.length > 0 ? 0 : 8 }}
            />
          )}

          {gatewayEnabled && gatewaySessions.length > 0 && (
            <Collapse
              defaultActiveKey={[]}
              items={[
                {
                  key: 'gateway-sessions',
                  label: gatewaySessionsHeader,
                  children: gatewaySessionsContent,
                  styles: {
                    body: { background: 'transparent', paddingInline: isPanel ? 0 : undefined },
                  },
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

      <ForkSpawnModal
        open={forkSpawnModal.open}
        action={forkSpawnModal.action}
        session={forkSpawnModal.session}
        currentUser={currentUserId ? userById.get(currentUserId) : undefined}
        onConfirm={handleForkSpawnConfirm}
        onCancel={() => setForkSpawnModal({ open: false, action: 'fork', session: null })}
        client={client}
        userById={userById}
      />
    </>
  );
};
