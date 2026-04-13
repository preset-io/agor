import type { AgorClient, Session, SessionID, Worktree } from '@agor-live/client';
import { EyeInvisibleOutlined, EyeOutlined, SearchOutlined } from '@ant-design/icons';
import { Badge, Input, Space, Switch, Table, Tag, Tooltip, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useThemedMessage } from '../../../utils/message';
import { getSessionDisplayTitle } from '../../../utils/sessionTitle';
import { ArchiveToggleButton } from '../../ArchiveToggleButton';
import { TaskStatusIcon } from '../../TaskStatusIcon';
import { ToolIcon } from '../../ToolIcon/ToolIcon';

interface SessionsTabProps {
  worktree: Worktree;
  sessions: Session[];
  client: AgorClient | null;
  onSessionClick?: (sessionId: string) => void;
}

const statusColorMap: Record<string, string> = {
  idle: 'default',
  running: 'processing',
  stopping: 'warning',
  awaiting_permission: 'warning',
  awaiting_input: 'processing',
  timed_out: 'warning',
  completed: 'success',
  failed: 'error',
};

const SessionsTabInner: React.FC<SessionsTabProps> = ({
  worktree,
  sessions,
  client,
  onSessionClick,
}) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const [searchText, setSearchText] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [activeSessions, setActiveSessions] = useState<Session[]>([]);
  const [activeLoading, setActiveLoading] = useState(false);
  const [archivedSessions, setArchivedSessions] = useState<Session[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivingIds, setArchivingIds] = useState<Set<string>>(new Set());
  const initialActiveSessions = useMemo(
    () => sessions.filter((session) => !session.archived),
    [sessions]
  );

  // Keep client ref stable for callbacks
  const clientRef = useRef(client);
  clientRef.current = client;

  const upsertSession = useCallback((list: Session[], session: Session): Session[] => {
    const index = list.findIndex((s) => s.session_id === session.session_id);
    if (index === -1) return [session, ...list];
    if (list[index] === session) return list;
    const next = [...list];
    next[index] = session;
    return next;
  }, []);

  const loadActiveSessions = useCallback(async () => {
    const currentClient = clientRef.current;
    if (!currentClient) return;

    setActiveLoading(true);
    try {
      const result = await currentClient.service('sessions').findAll({
        query: {
          worktree_id: worktree.worktree_id,
          archived: false,
          $limit: 1000,
          $sort: { created_at: -1 },
        },
      });
      setActiveSessions(result as Session[]);
    } catch {
      // Keep tab resilient; table still renders from fallback state
    } finally {
      setActiveLoading(false);
    }
  }, [worktree.worktree_id]);

  const loadArchivedSessions = useCallback(async () => {
    const currentClient = clientRef.current;
    if (!currentClient) return;

    setArchivedLoading(true);
    try {
      const result = await currentClient.service('sessions').findAll({
        query: {
          worktree_id: worktree.worktree_id,
          archived: true,
          $limit: 1000,
          $sort: { created_at: -1 },
        },
      });
      setArchivedSessions(result as Session[]);
      setArchivedLoaded(true);
    } catch {
      // Keep tab resilient; table still renders active sessions
    } finally {
      setArchivedLoading(false);
    }
  }, [worktree.worktree_id]);

  useEffect(() => {
    // Reset per-worktree state when switching modal context.
    // Seed active list from prop for instant render, then refresh from API.
    setActiveSessions(initialActiveSessions);
    setActiveLoading(false);
    setShowArchived(worktree.archived);
    setArchivedSessions([]);
    setArchivedLoaded(false);
    setArchivedLoading(false);
    void loadActiveSessions();
  }, [initialActiveSessions, loadActiveSessions, worktree.archived]);

  useEffect(() => {
    if (showArchived && !archivedLoaded && !archivedLoading) {
      void loadArchivedSessions();
    }
  }, [showArchived, archivedLoaded, archivedLoading, loadArchivedSessions]);

  useEffect(() => {
    if (!client) return;
    const sessionsService = client.service('sessions');

    const handleSessionCreated = (session: Session) => {
      if (session.worktree_id !== worktree.worktree_id) return;
      if (session.archived) {
        setArchivedSessions((prev) => upsertSession(prev, session));
      } else {
        setActiveSessions((prev) => upsertSession(prev, session));
      }
    };

    const handleSessionPatched = (session: Session) => {
      if (session.worktree_id !== worktree.worktree_id) return;
      setActiveSessions((prev) => prev.filter((s) => s.session_id !== session.session_id));
      setArchivedSessions((prev) => prev.filter((s) => s.session_id !== session.session_id));
      if (session.archived) {
        setArchivedSessions((prev) => upsertSession(prev, session));
      } else {
        setActiveSessions((prev) => upsertSession(prev, session));
      }
    };

    const handleSessionRemoved = (session: Session) => {
      if (session.worktree_id !== worktree.worktree_id) return;
      setActiveSessions((prev) => prev.filter((s) => s.session_id !== session.session_id));
      setArchivedSessions((prev) => prev.filter((s) => s.session_id !== session.session_id));
    };

    sessionsService.on('created', handleSessionCreated);
    sessionsService.on('patched', handleSessionPatched);
    sessionsService.on('updated', handleSessionPatched);
    sessionsService.on('removed', handleSessionRemoved);

    return () => {
      sessionsService.removeListener('created', handleSessionCreated);
      sessionsService.removeListener('patched', handleSessionPatched);
      sessionsService.removeListener('updated', handleSessionPatched);
      sessionsService.removeListener('removed', handleSessionRemoved);
    };
  }, [client, upsertSession, worktree.worktree_id]);

  const handleArchiveToggle = useCallback(
    async (sessionId: SessionID, archive: boolean) => {
      const currentClient = clientRef.current;
      if (!currentClient) return;

      setArchivingIds((prev) => new Set(prev).add(sessionId));
      try {
        await currentClient.service('sessions').patch(sessionId, {
          archived: archive,
          archived_reason: archive ? 'manual' : undefined,
        } as Partial<Session>);

        // Keep local archived cache in sync for this modal view
        if (archive) {
          const source = activeSessions.find((s) => s.session_id === sessionId);
          if (source) {
            setActiveSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
            setArchivedSessions((prev) => {
              if (prev.some((s) => s.session_id === sessionId)) return prev;
              return [{ ...source, archived: true }, ...prev];
            });
          } else if (showArchived) {
            void loadArchivedSessions();
          }
        } else {
          const source = archivedSessions.find((s) => s.session_id === sessionId);
          if (source) {
            setActiveSessions((prev) => upsertSession(prev, { ...source, archived: false }));
          }
          setArchivedSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
        }

        showSuccess(archive ? 'Session archived' : 'Session unarchived');
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Failed to update session');
      } finally {
        setArchivingIds((prev) => {
          const next = new Set(prev);
          next.delete(sessionId);
          return next;
        });
      }
    },
    [
      activeSessions,
      archivedSessions,
      loadArchivedSessions,
      showArchived,
      showSuccess,
      showError,
      upsertSession,
    ]
  );

  const combinedSessions = useMemo(() => {
    if (!showArchived) return activeSessions;
    const seen = new Set<string>();
    const merged: Session[] = [];
    for (const session of activeSessions) {
      seen.add(session.session_id);
      merged.push(session);
    }
    for (const session of archivedSessions) {
      if (!seen.has(session.session_id)) {
        merged.push(session);
      }
    }
    return merged;
  }, [activeSessions, archivedSessions, showArchived]);

  // Filter sessions based on search and archive toggle
  const filteredSessions = useMemo(() => {
    let result = combinedSessions;

    // Filter archived
    if (!showArchived) {
      result = result.filter((s) => !s.archived);
    }

    // Filter by search text
    if (searchText.trim()) {
      const lower = searchText.toLowerCase();
      result = result.filter((s) => {
        const title = getSessionDisplayTitle(s, { includeAgentFallback: true });
        return (
          title.toLowerCase().includes(lower) ||
          s.session_id.toLowerCase().includes(lower) ||
          s.agentic_tool.toLowerCase().includes(lower) ||
          s.status.toLowerCase().includes(lower)
        );
      });
    }

    // Sort: running first, then by created_at descending
    // Spread into new array to avoid mutating the prop array
    return [...result].sort((a, b) => {
      const aRunning = a.status === 'running' || a.status === 'stopping' ? 1 : 0;
      const bRunning = b.status === 'running' || b.status === 'stopping' ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [combinedSessions, showArchived, searchText]);

  const activeCount = activeSessions.length;
  const archivedCount = archivedSessions.length;

  const columns: ColumnsType<Session> = [
    {
      title: 'Session',
      key: 'title',
      ellipsis: true,
      render: (_, session) => (
        <Space size={8} align="center" style={{ minWidth: 0 }}>
          <ToolIcon tool={session.agentic_tool} size={18} />
          <Typography.Link
            onClick={(e) => {
              e.stopPropagation();
              onSessionClick?.(session.session_id);
            }}
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'block',
            }}
          >
            {getSessionDisplayTitle(session, { includeAgentFallback: true })}
          </Typography.Link>
          {session.archived && (
            <Tag color="default" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>
              archived
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 130,
      render: (_, session) => (
        <Space size={4}>
          <TaskStatusIcon status={session.status} size={14} />
          <Tag
            color={statusColorMap[session.status] || 'default'}
            style={{ margin: 0, fontSize: 11 }}
          >
            {session.status}
          </Tag>
        </Space>
      ),
      filters: [
        { text: 'Idle', value: 'idle' },
        { text: 'Running', value: 'running' },
        { text: 'Completed', value: 'completed' },
        { text: 'Failed', value: 'failed' },
        { text: 'Awaiting Permission', value: 'awaiting_permission' },
        { text: 'Awaiting Input', value: 'awaiting_input' },
        { text: 'Timed Out', value: 'timed_out' },
      ],
      onFilter: (value, record) => record.status === value,
    },
    {
      title: 'Created',
      key: 'created_at',
      width: 150,
      render: (_, session) => (
        <Tooltip title={new Date(session.created_at).toLocaleString()}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatRelativeTime(session.created_at)}
          </Typography.Text>
        </Tooltip>
      ),
      sorter: (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    },
    {
      title: '',
      key: 'actions',
      width: 40,
      render: (_, session) => (
        <ArchiveToggleButton
          archived={session.archived}
          loading={archivingIds.has(session.session_id)}
          tooltip={session.archived ? 'Archived • Click to unarchive' : 'Click to archive'}
          onToggle={(nextArchived) =>
            handleArchiveToggle(session.session_id as SessionID, nextArchived)
          }
        />
      ),
    },
  ];

  return (
    <div style={{ width: '100%', maxHeight: '70vh', overflowY: 'auto' }}>
      <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
        {/* Toolbar: search + archive toggle */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <Input
            placeholder="Search sessions..."
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            style={{ maxWidth: 300 }}
          />
          <Space size={12}>
            <Space size={4}>
              <Badge count={activeCount} showZero style={{ backgroundColor: token.colorPrimary }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                active
              </Typography.Text>
            </Space>
            {archivedCount > 0 && (
              <Space size={4}>
                <Badge
                  count={archivedCount}
                  showZero
                  style={{ backgroundColor: token.colorTextQuaternary }}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  archived
                </Typography.Text>
              </Space>
            )}
            <Space size={4}>
              <Switch
                size="small"
                checked={showArchived}
                onChange={setShowArchived}
                loading={archivedLoading || activeLoading}
                checkedChildren={<EyeOutlined />}
                unCheckedChildren={<EyeInvisibleOutlined />}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Show archived
              </Typography.Text>
            </Space>
          </Space>
        </div>

        {/* Sessions table */}
        <Table<Session>
          columns={columns}
          dataSource={filteredSessions}
          rowKey="session_id"
          size="small"
          pagination={
            filteredSessions.length > 20 ? { pageSize: 20, showSizeChanger: false } : false
          }
          locale={{
            emptyText: showArchived
              ? 'No sessions match your search'
              : combinedSessions.length > 0
                ? 'All sessions are archived. Toggle "Show archived" to see them.'
                : 'No sessions yet',
          }}
          onRow={(session) => ({
            style: {
              cursor: onSessionClick ? 'pointer' : undefined,
              opacity: session.archived ? 0.6 : 1,
            },
            onClick: () => onSessionClick?.(session.session_id),
          })}
        />
      </Space>
    </div>
  );
};

/**
 * Format a date string as relative time (e.g., "2h ago", "3d ago")
 */
function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

// Memoize to prevent re-renders when parent updates with same data
export const SessionsTab = memo(SessionsTabInner, (prevProps, nextProps) => {
  const clientChanged = (prevProps.client === null) !== (nextProps.client === null);
  return (
    prevProps.worktree.worktree_id === nextProps.worktree.worktree_id &&
    prevProps.sessions === nextProps.sessions &&
    !clientChanged
  );
});
