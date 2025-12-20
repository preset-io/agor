import type { Task } from '@agor/core/types';
import {
  EditOutlined,
  FileTextOutlined,
  GithubOutlined,
  MessageOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { List, Space, Tooltip, Typography, theme } from 'antd';
import { Tag } from '../Tag';
import { TaskStatusIcon } from '../TaskStatusIcon';

const { useToken } = theme;

const TRUNCATION_LENGTH = 120;

interface TaskListItemProps {
  task: Task;
  onClick?: () => void;
  compact?: boolean;
}

const TaskListItem = ({ task, onClick, compact = false }: TaskListItemProps) => {
  const { token } = useToken();

  const messageCount = task.message_range.end_index - task.message_range.start_index + 1;
  const hasReport = !!task.report;

  // Git state transition tracking
  const shaAtStart = task.git_state.sha_at_start;
  const shaAtEnd = task.git_state.sha_at_end;
  const hasTransition = shaAtEnd && shaAtEnd !== 'unknown' && shaAtEnd !== shaAtStart;

  // Check if end state is dirty (or start state if no end)
  const displaySha = shaAtEnd && shaAtEnd !== 'unknown' ? shaAtEnd : shaAtStart;
  const isDirty = displaySha?.endsWith('-dirty');
  const cleanSha = displaySha?.replace('-dirty', '');

  // Truncate description if too long
  const description = task.description || task.full_prompt || 'Untitled task';
  const isTruncated = description.length > TRUNCATION_LENGTH;
  const displayDescription = isTruncated
    ? `${description.substring(0, TRUNCATION_LENGTH)}...`
    : description;

  return (
    <List.Item
      onClick={onClick}
      style={{
        cursor: 'pointer',
        padding: compact ? '4px 8px' : '8px 12px',
        borderRadius: token.borderRadius,
      }}
    >
      <div style={{ width: '100%' }}>
        <div style={{ marginBottom: 4 }}>
          <Space size={8}>
            <Tooltip title={<div style={{ whiteSpace: 'pre-wrap' }}>{task.full_prompt}</div>}>
              <span>
                <TaskStatusIcon status={task.status} size={16} />
              </span>
            </Tooltip>
            <Typography.Text style={{ fontSize: compact ? 13 : 14, fontWeight: 500 }}>
              {displayDescription}
            </Typography.Text>
          </Space>
        </div>

        <div style={{ marginLeft: compact ? 20 : 24 }}>
          <Space size={4} wrap>
            <Tag icon={<MessageOutlined />} color="default">
              {messageCount}
            </Tag>
            <Tag icon={<ToolOutlined />} color="default">
              {task.tool_use_count}
            </Tag>
            {hasReport && (
              <Tag icon={<FileTextOutlined />} color="blue">
                report
              </Tag>
            )}
            {!compact && cleanSha && (
              <Tooltip
                title={
                  hasTransition
                    ? 'Git state changed during task'
                    : isDirty
                      ? 'Uncommitted changes'
                      : 'Clean git state'
                }
              >
                <span>
                  <Tag icon={<GithubOutlined />} color={isDirty ? 'orange' : 'purple'}>
                    <Space size={4}>
                      <Typography.Text style={{ fontSize: 11, fontFamily: 'monospace' }}>
                        {hasTransition && '→ '}
                        {cleanSha.substring(0, 7)}
                      </Typography.Text>
                      {isDirty && <EditOutlined style={{ fontSize: 10 }} />}
                    </Space>
                  </Tag>
                </span>
              </Tooltip>
            )}
          </Space>
        </div>
      </div>
    </List.Item>
  );
};

export default TaskListItem;
