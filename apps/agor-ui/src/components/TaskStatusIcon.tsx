import { type SessionStatus, TaskStatus } from '@agor/core/types';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
  PauseCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { Spin, theme } from 'antd';
import type React from 'react';

type TaskStatusValue = (typeof TaskStatus)[keyof typeof TaskStatus];
type SessionStatusValue = (typeof SessionStatus)[keyof typeof SessionStatus];

interface TaskStatusIconProps {
  status: TaskStatusValue | SessionStatusValue;
  size?: number;
}

/**
 * Shared icon renderer for task status indicators.
 *
 * Keeps status → icon/color mapping in one place so TaskBlock, TaskListItem, etc.
 * stay visually consistent.
 */
export const TaskStatusIcon: React.FC<TaskStatusIconProps> = ({ status, size = 16 }) => {
  const { token } = theme.useToken();
  const iconStyle = { fontSize: size };
  const spinSize = size <= 14 ? 'small' : size >= 24 ? 'large' : 'default';

  switch (status) {
    case TaskStatus.COMPLETED:
      return <CheckCircleOutlined style={{ ...iconStyle, color: token.colorSuccess }} />;
    case TaskStatus.RUNNING:
      return <Spin size={spinSize} />;
    case TaskStatus.STOPPING:
      return <StopOutlined style={{ ...iconStyle, color: token.colorWarning }} />;
    case TaskStatus.AWAITING_PERMISSION:
      return <PauseCircleOutlined style={{ ...iconStyle, color: token.colorWarning }} />;
    case TaskStatus.FAILED:
      return <CloseCircleOutlined style={{ ...iconStyle, color: token.colorError }} />;
    case TaskStatus.STOPPED:
      return <MinusCircleOutlined style={{ ...iconStyle, color: token.colorWarning }} />;
    default:
      return <ClockCircleOutlined style={{ ...iconStyle, color: token.colorTextDisabled }} />;
  }
};
