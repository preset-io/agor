import type { AgorClient, Branch, Session, SessionID, SpawnConfig, User } from '@agor-live/client';
import {
  getGatewaySource as getGatewaySourceCore,
  isGatewaySession as isGatewaySessionCore,
} from '@agor-live/client';
import {
  ClockCircleOutlined,
  InboxOutlined,
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
import { useServiceEnabled } from '../../hooks/useServicesConfig';
import { useSessionActions } from '../../hooks/useSessionActions';
import { useThemedMessage } from '../../utils/message';
import { getSessionDisplayTitle, getSessionTitleStyles } from '../../utils/sessionTitle';
import { type ForkSpawnAction, ForkSpawnModal } from '../ForkSpawnModal';
import { ChannelPill } from '../Pill';
import { SessionRelationshipIcon } from '../SessionRelationshipIcon';
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
  defaultExpanded?: boolean;
  mode?: BranchSessionSectionsMode;
  client: AgorClient | null;
}

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

  const isPanel = mode === 'panel';

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
        title: 'Archive Session',
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
  const sessionTreeData = useMemo(() => buildSessionTree(manualSessions), [manualSessions]);

  const hasRunningScheduledSession = useMemo(
    () => scheduledSessions.some((s) => s.status === 'running' || s.status === 'stopping'),
    [scheduledSessions]
  );
  const hasRunningGatewaySession = useMemo(
    () => gatewaySessions.some((s) => s.status === 'running' || s.status === 'stopping'),
    [gatewaySessions]
  );

  const isCreating = branch.filesystem_status === 'creating';
  const isFailed = branch.filesystem_status === 'failed';

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
    return {
      border: session.ready_for_prompt
        ? `1px solid ${token.colorPrimary}`
        : `1px solid ${isPanel ? token.colorBorderSecondary : 'rgba(255, 255, 255, 0.1)'}`,
      borderRadius: isPanel ? 6 : 4,
      padding: isPanel ? 10 : 8,
      background: isPanel ? token.colorBgContainer : 'transparent',
      display: 'flex',
      alignItems: 'center',
      cursor: 'pointer',
      marginBottom: 4,
      boxShadow: session.ready_for_prompt ? `0 0 12px ${token.colorPrimary}30` : undefined,
      ...(isSessionSelected
        ? { outline: `1px dashed ${token.colorTextBase}`, outlineOffset: -2 }
        : {}),
    };
  };

  const renderSessionNode = (node: SessionTreeNode) => {
    const session = node.session;
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
            <SessionRelationshipIcon session={session} size={10} />
            <Typography.Text
              strong
              style={{
                fontSize: isPanel ? 13 : 12,
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
              style={sessionRowStyle(session)}
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
                    fontSize: isPanel ? 13 : 12,
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
                  <Typography.Text
                    style={{ fontSize: isPanel ? 13 : 12, ...getSessionTitleStyles(2) }}
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

  return (
    <>
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
          {manualSessions.length > 0 && (
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
          )}

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
