import type { Repo, Session, Task, User, Worktree } from '@agor/core/types';
import {
  BranchesOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  DeleteOutlined,
  DragOutlined,
  EditOutlined,
  ForkOutlined,
  PlusOutlined,
  PushpinFilled,
  SubnodeOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Card, Collapse, Space, Tag, Tree, Typography, theme } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { DeleteWorktreePopconfirm } from '../DeleteWorktreePopconfirm';
import { EnvironmentPill } from '../EnvironmentPill';
import { type ForkSpawnAction, ForkSpawnModal } from '../ForkSpawnModal';
import { CreatedByTag } from '../metadata';
import { IssuePill, PullRequestPill } from '../Pill';
import { TaskStatusIcon } from '../TaskStatusIcon';
import { ToolIcon } from '../ToolIcon';
import { buildSessionTree, type SessionTreeNode } from './buildSessionTree';

const _WORKTREE_CARD_MAX_WIDTH = 600;

// Session title display configuration for tree view
const SESSION_TITLE_MAX_LINES = 2; // Limit to 2 lines in tree view
const SESSION_TITLE_FALLBACK_CHARS = 100; // Fallback truncation for unsupported browsers (smaller font = less chars per line)

interface WorktreeCardProps {
  worktree: Worktree;
  repo: Repo;
  sessions: Session[];
  tasks: Record<string, Task[]>;
  users: User[];
  currentUserId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onCreateSession?: (worktreeId: string) => void;
  onForkSession?: (sessionId: string, prompt: string) => Promise<void>;
  onSpawnSession?: (sessionId: string, prompt: string) => Promise<void>;
  onDelete?: (worktreeId: string, deleteFromFilesystem: boolean) => void;
  onOpenSettings?: (worktreeId: string) => void;
  onOpenTerminal?: (commands: string[]) => void;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onViewLogs?: (worktreeId: string) => void;
  onUnpin?: (worktreeId: string) => void;
  isPinned?: boolean;
  zoneName?: string;
  zoneColor?: string;
  defaultExpanded?: boolean;
}

const WorktreeCard = ({
  worktree,
  repo,
  sessions,
  tasks,
  users,
  currentUserId,
  onTaskClick,
  onSessionClick,
  onCreateSession,
  onForkSession,
  onSpawnSession,
  onDelete,
  onOpenSettings,
  onOpenTerminal,
  onStartEnvironment,
  onStopEnvironment,
  onViewLogs,
  onUnpin,
  isPinned = false,
  zoneName,
  zoneColor,
  defaultExpanded = true,
}: WorktreeCardProps) => {
  const { token } = theme.useToken();

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

  // Tree expansion state - track which nodes are expanded
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);

  // Handle fork/spawn modal confirm
  const handleForkSpawnConfirm = async (prompt: string) => {
    if (!forkSpawnModal.session) return;

    if (forkSpawnModal.action === 'fork') {
      await onForkSession?.(forkSpawnModal.session.session_id, prompt);
    } else {
      await onSpawnSession?.(forkSpawnModal.session.session_id, prompt);
    }
  };

  // Separate manual sessions from scheduled runs
  const manualSessions = useMemo(
    () => sessions.filter(s => !s.scheduled_from_worktree),
    [sessions]
  );
  const scheduledSessions = useMemo(
    () =>
      sessions
        .filter(s => s.scheduled_from_worktree)
        .sort((a, b) => (b.scheduled_run_at || 0) - (a.scheduled_run_at || 0)), // Most recent first
    [sessions]
  );

  // Build genealogy tree structure (only for manual sessions)
  const sessionTreeData = useMemo(() => buildSessionTree(manualSessions), [manualSessions]);

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
        onClick: () => {
          setForkSpawnModal({
            open: true,
            action: 'spawn',
            session,
          });
        },
      },
    ];

    return (
      <div
        style={{
          border: `1px solid rgba(255, 255, 255, 0.1)`,
          borderRadius: 4,
          padding: 8,
          background: 'rgba(0, 0, 0, 0.2)',
          display: 'flex',
          alignItems: 'center',
          cursor: 'pointer',
          marginBottom: 4,
        }}
        onClick={() => onSessionClick?.(session.session_id)}
        onContextMenu={e => {
          // Show fork/spawn menu on right-click if handlers exist
          if (onForkSession || onSpawnSession) {
            e.preventDefault();
          }
        }}
      >
        <Space size={4} align="center" style={{ flex: 1, minWidth: 0 }}>
          <ToolIcon tool={session.agentic_tool} size={20} />
          {getRelationshipIcon()}
          <Typography.Text
            strong
            style={{
              fontSize: 12,
              flex: 1,
              display: '-webkit-box',
              WebkitLineClamp: SESSION_TITLE_MAX_LINES,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              wordBreak: 'break-word',
            }}
          >
            {(() => {
              const displayText = session.title || session.description || session.agentic_tool;
              // Fallback truncation for browsers that don't support line-clamp
              if (
                !session.title &&
                session.description &&
                session.description.length > SESSION_TITLE_FALLBACK_CHARS
              ) {
                return `${session.description.substring(0, SESSION_TITLE_FALLBACK_CHARS)}...`;
              }
              return displayText;
            })()}
          </Typography.Text>
        </Space>

        {/* Status indicator - fixed width to prevent layout shift */}
        <div
          style={{
            marginLeft: 8,
            width: 24,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <TaskStatusIcon status={session.status} size={16} />
        </div>
      </div>
    );
  };

  // Session list content (collapsible) - only used when sessions exist
  const sessionListContent = (
    <Tree
      treeData={sessionTreeData}
      expandedKeys={expandedKeys}
      onExpand={keys => setExpandedKeys(keys as React.Key[])}
      showLine
      showIcon={false}
      selectable={false}
      titleRender={renderSessionNode}
      style={{
        background: 'transparent',
      }}
    />
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
            onClick={e => {
              e.stopPropagation();
              onCreateSession(worktree.worktree_id);
            }}
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
      </Space>
    </div>
  );

  // Scheduled runs content (flat list, no genealogy tree needed)
  const scheduledRunsContent = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {scheduledSessions.map(session => (
        <div
          key={session.session_id}
          style={{
            border: `1px solid rgba(255, 255, 255, 0.1)`,
            borderRadius: 4,
            padding: 8,
            background: 'rgba(0, 0, 0, 0.2)',
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
          }}
          onClick={() => onSessionClick?.(session.session_id)}
        >
          <Space size={4} align="center" style={{ flex: 1, minWidth: 0 }}>
            <ToolIcon tool={session.agentic_tool} size={20} />
            <Typography.Text
              style={{
                fontSize: 12,
                flex: 1,
                display: '-webkit-box',
                WebkitLineClamp: SESSION_TITLE_MAX_LINES,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word',
                color: token.colorTextSecondary,
              }}
            >
              {session.title || session.description || session.agentic_tool}
            </Typography.Text>
          </Space>

          {/* Status indicator */}
          <div
            style={{
              marginLeft: 8,
              width: 24,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <TaskStatusIcon status={session.status} size={16} />
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <Card
      style={{
        width: 500,
        cursor: 'default', // Override React Flow's drag cursor - only drag handles should show grab cursor
        ...(isPinned && zoneColor ? { borderColor: zoneColor, borderWidth: 1 } : {}),
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
          <div
            className="drag-handle"
            style={{ display: 'flex', alignItems: 'center', cursor: 'grab' }}
          >
            <BranchesOutlined style={{ fontSize: 32, color: token.colorPrimary }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <Typography.Text strong className="nodrag">
              {repo.slug}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {worktree.name}
            </Typography.Text>
          </div>
        </Space>

        <Space size={4}>
          <div className="nodrag">
            {isPinned && zoneName && (
              <Tag
                icon={<PushpinFilled style={{ color: zoneColor }} />}
                onClick={e => {
                  e.stopPropagation();
                  onUnpin?.(worktree.worktree_id);
                }}
                style={{
                  cursor: 'pointer',
                  backgroundColor: zoneColor ? `${zoneColor}1a` : undefined, // 10% alpha (1a in hex = 26/255 ≈ 10%)
                  borderColor: zoneColor,
                }}
                title={`Pinned to ${zoneName} (click to unpin)`}
              />
            )}
          </div>
          <Button
            type="text"
            size="small"
            icon={<DragOutlined />}
            className="drag-handle"
            title="Drag to reposition"
            style={{ cursor: 'grab' }}
          />
          <div className="nodrag">
            {onOpenTerminal && (
              <Button
                type="text"
                size="small"
                icon={<CodeOutlined />}
                onClick={e => {
                  e.stopPropagation();
                  onOpenTerminal([`cd ${worktree.path}`]);
                }}
                title="Open terminal in worktree directory"
              />
            )}
            {onOpenSettings && (
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={e => {
                  e.stopPropagation();
                  onOpenSettings(worktree.worktree_id);
                }}
                title="Edit worktree"
              />
            )}
            {onDelete && (
              <DeleteWorktreePopconfirm
                worktree={worktree}
                sessionCount={sessions.length}
                onConfirm={deleteFromFilesystem =>
                  onDelete(worktree.worktree_id, deleteFromFilesystem)
                }
              >
                <Button
                  type="text"
                  size="small"
                  icon={<DeleteOutlined />}
                  onClick={e => e.stopPropagation()}
                  title="Delete worktree"
                  danger
                />
              </DeleteWorktreePopconfirm>
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
              users={users}
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
          />
        </Space>
      </div>

      {/* Notes */}
      {worktree.notes && (
        <div className="nodrag" style={{ marginBottom: 8 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontStyle: 'italic' }}>
            {worktree.notes}
          </Typography.Text>
        </div>
      )}

      {/* Sessions & Scheduled Runs - collapsible sections */}
      <div className="nodrag">
        {sessions.length === 0 ? (
          // No sessions at all: show create button without collapse wrapper
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
            {onCreateSession && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={e => {
                  e.stopPropagation();
                  onCreateSession(worktree.worktree_id);
                }}
                size="middle"
              >
                Create Session
              </Button>
            )}
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
                  },
                ]}
                ghost
                style={{ marginTop: 8 }}
              />
            )}

            {/* Scheduled Runs */}
            {scheduledSessions.length > 0 && (
              <Collapse
                defaultActiveKey={defaultExpanded ? ['scheduled-runs'] : []}
                items={[
                  {
                    key: 'scheduled-runs',
                    label: scheduledRunsHeader,
                    children: scheduledRunsContent,
                  },
                ]}
                ghost
                style={{ marginTop: manualSessions.length > 0 ? 0 : 8 }}
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
        onConfirm={handleForkSpawnConfirm}
        onCancel={() =>
          setForkSpawnModal({
            open: false,
            action: 'fork',
            session: null,
          })
        }
      />
    </Card>
  );
};

export default WorktreeCard;
