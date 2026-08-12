import type { Task } from '@agor-live/client';
import { CheckCircleOutlined, CloseCircleOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { Typography, theme } from 'antd';

interface CallbackEventRowProps {
  task: Task;
  /** Same stable callback ConversationView hands every TaskBlock. */
  onExpandChange: (taskId: string, expanded: boolean) => void;
}

/**
 * One-line rendering of a daemon-synthesized callback task (child session
 * completed/failed). These are system events, not conversation turns — the
 * full TaskBlock (prompt echo, chips, agent reply) renders only after the
 * user expands the row, so nothing is lost, it just stops shouting.
 */
export function CallbackEventRow({ task, onExpandChange }: CallbackEventRowProps) {
  const { token } = theme.useToken();

  const firstLine = (task.full_prompt || 'System event')
    .split('\n')[0]
    .replace(/^\[Agor\]\s*/, '')
    .replace(/\.\s*$/, '');
  const failed = /has failed/i.test(firstLine);
  const completed = /has completed/i.test(firstLine);
  const icon = failed ? (
    <CloseCircleOutlined style={{ color: token.colorError, fontSize: 13 }} />
  ) : completed ? (
    <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: 13 }} />
  ) : (
    <InfoCircleOutlined style={{ color: token.colorTextTertiary, fontSize: 13 }} />
  );

  return (
    <button
      type="button"
      data-conversation-block
      onClick={() => onExpandChange(task.task_id, true)}
      title="Show details"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: token.sizeUnit,
        width: '100%',
        padding: `${token.sizeUnit / 2}px ${token.sizeUnit}px`,
        margin: `${token.sizeUnit / 2}px 0`,
        background: 'transparent',
        border: 0,
        borderRadius: token.borderRadiusSM,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = token.colorFillQuaternary;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {icon}
      <Typography.Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 0 }} ellipsis>
        {firstLine}
      </Typography.Text>
    </button>
  );
}
