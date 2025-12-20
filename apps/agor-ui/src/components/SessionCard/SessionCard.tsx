import type { Session, Task, User } from '@agor/core/types';
import {
  BranchesOutlined,
  CloseOutlined,
  DragOutlined,
  EditOutlined,
  ExpandOutlined,
  ForkOutlined,
  PlusCircleOutlined,
  PushpinFilled,
  SettingOutlined,
} from '@ant-design/icons';
import { App, Button, Card, Collapse, Space, Typography } from 'antd';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { getSessionDisplayTitle, getSessionTitleStyles } from '../../utils/sessionTitle';
import { CreatedByTag } from '../metadata';
import { Tag } from '../Tag';
import TaskListItem from '../TaskListItem';
import { TaskStatusIcon } from '../TaskStatusIcon';
import { ToolIcon } from '../ToolIcon';

const SESSION_CARD_MAX_WIDTH = 560;

interface SessionCardProps {
  session: Session;
  tasks?: Task[]; // Optional - will be fetched via useTasks if not provided
  userById: Map<string, User>;
  currentUserId?: string;
  onTaskClick?: (taskId: string) => void;
  onSessionClick?: () => void;
  onDelete?: (sessionId: string) => void;
  onOpenSettings?: (sessionId: string) => void;
  onUnpin?: (sessionId: string) => void;
  isPinned?: boolean;
  zoneName?: string;
  zoneColor?: string;
  defaultExpanded?: boolean;
}

const SessionCard = ({
  session,
  tasks = [], // Default to empty array - tasks fetching will be added later via useTasks
  userById,
  currentUserId,
  onTaskClick,
  onSessionClick,
  onDelete,
  onOpenSettings,
  onUnpin,
  isPinned = false,
  zoneName,
  zoneColor,
  defaultExpanded = true,
}: SessionCardProps) => {
  const { modal } = App.useApp();
  const connectionDisabled = useConnectionDisabled();

  const handleDelete = () => {
    modal.confirm({
      title: 'Delete Session',
      content: 'Are you sure you want to delete this session? This action cannot be undone.',
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: () => {
        onDelete?.(session.session_id);
      },
    });
  };

  // Show last 5 tasks (oldest to newest)
  const visibleTasks = tasks.slice(-5);
  const hiddenTaskCount = tasks.length - visibleTasks.length;

  const isForked = !!session.genealogy.forked_from_session_id;
  const isSpawned = !!session.genealogy.parent_session_id;

  // Check if git state is dirty
  const isDirty = session.git_state.current_sha.endsWith('-dirty');
  const cleanSha = session.git_state.current_sha.replace('-dirty', '');

  // Task list collapse header (just the "Tasks" label)
  const taskListHeader = (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        width: '100%',
      }}
    >
      <Typography.Text strong>Tasks</Typography.Text>
      {tasks.length > 5 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          (showing latest 5 of {tasks.length})
        </Typography.Text>
      )}
    </div>
  );

  // Task list content (collapsible)
  const taskListContent = (
    <div>
      {hiddenTaskCount > 0 && (
        <div style={{ marginBottom: 8 }}>
          <Button
            type="text"
            icon={<PlusCircleOutlined />}
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onSessionClick?.();
            }}
          >
            See {hiddenTaskCount} more {hiddenTaskCount === 1 ? 'task' : 'tasks'}
          </Button>
        </div>
      )}

      {visibleTasks.map((task) => (
        <TaskListItem key={task.task_id} task={task} onClick={() => onTaskClick?.(task.task_id)} />
      ))}
    </div>
  );

  return (
    <Card
      style={{
        maxWidth: SESSION_CARD_MAX_WIDTH,
        ...(isPinned && zoneColor ? { borderColor: zoneColor, borderWidth: 1 } : {}),
      }}
      styles={{
        body: { padding: 16 },
      }}
    >
      {/* Session header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <Space size={8} align="center">
          <div className="drag-handle" style={{ display: 'flex', alignItems: 'center' }}>
            <ToolIcon tool={session.agentic_tool} size={32} />
          </div>
          <Typography.Text strong className="nodrag">
            {session.agentic_tool}
          </Typography.Text>
          <TaskStatusIcon status={session.status} size={16} />
        </Space>

        <Space size={4}>
          <div className="nodrag">
            {isForked && (
              <Tag icon={<ForkOutlined />} color="cyan">
                FORK
              </Tag>
            )}
            {isSpawned && (
              <Tag icon={<BranchesOutlined />} color="purple">
                SPAWN
              </Tag>
            )}
            {isPinned && zoneName && (
              <Tag
                icon={<PushpinFilled />}
                color="blue"
                onClick={(e) => {
                  e.stopPropagation();
                  onUnpin?.(session.session_id);
                }}
                style={{ cursor: 'pointer' }}
                title={`Pinned to ${zoneName} (click to unpin)`}
              >
                {zoneName}
              </Tag>
            )}
          </div>
          <Button
            type="text"
            size="small"
            icon={<DragOutlined />}
            className="drag-handle"
            title="Drag to reposition"
          />
          <div className="nodrag">
            {onSessionClick && (
              <Button
                type="text"
                size="small"
                icon={<ExpandOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onSessionClick();
                }}
                title="Open in drawer"
              />
            )}
            {onOpenSettings && (
              <Button
                type="text"
                size="small"
                icon={<SettingOutlined />}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSettings(session.session_id);
                }}
                title="Session settings"
              />
            )}
            {onDelete && (
              <Button
                type="text"
                size="small"
                icon={<CloseOutlined />}
                disabled={connectionDisabled}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete();
                }}
                title="Delete session"
                danger
              />
            )}
          </div>
        </Space>
      </div>

      {/* Session metadata */}
      <div className="nodrag">
        {/* Title/Description */}
        {(session.title || session.description) && (
          <Typography.Text
            strong
            style={{
              fontSize: 16,
              marginBottom: 8,
              ...getSessionTitleStyles(2),
            }}
          >
            {getSessionDisplayTitle(session)}
          </Typography.Text>
        )}

        {/* Created By Tag */}
        {session.created_by && (
          <div style={{ marginBottom: 8 }}>
            <CreatedByTag
              createdBy={session.created_by}
              currentUserId={currentUserId}
              userById={userById}
              prefix="Created by"
            />
          </div>
        )}

        {/* Git State */}
        <div style={{ marginBottom: 8 }}>
          <Space size={4}>
            <Typography.Text type="secondary">
              📍 {session.git_state.ref} @ {cleanSha.substring(0, 7)}
            </Typography.Text>
            {isDirty && (
              <Tag icon={<EditOutlined />} color="orange" style={{ fontSize: 11 }}>
                uncommitted
              </Tag>
            )}
          </Space>
        </div>

        {/* Concepts - TODO: Re-implement with contextFiles */}
        {/* {session.contextFiles && session.contextFiles.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <Space size={4} wrap>
              <Typography.Text type="secondary">📦</Typography.Text>
              {session.contextFiles.map((file) => (
                <Tag key={file} color="geekblue">
                  {file}
                </Tag>
              ))}
            </Space>
          </div>
        )} */}
      </div>

      {/* Tasks - collapsible */}
      <div className="nodrag">
        <Collapse
          defaultActiveKey={defaultExpanded ? ['tasks'] : []}
          items={[
            {
              key: 'tasks',
              label: taskListHeader,
              children: taskListContent,
            },
          ]}
          ghost
          style={{ marginTop: 8 }}
        />

        {/* Footer metadata - always visible */}
        <div style={{ marginTop: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            💬 {session.message_count} messages
          </Typography.Text>
        </div>
      </div>
    </Card>
  );
};

export default SessionCard;
