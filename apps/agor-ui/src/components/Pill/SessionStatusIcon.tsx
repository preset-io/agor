import { type Session, SessionStatus } from '@agor-live/client';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  MinusCircleOutlined,
  PauseCircleOutlined,
  QuestionCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { theme } from 'antd';
import type React from 'react';
import {
  describeSessionStatus,
  getSessionStatusTone,
  READY_STATUS,
  type SessionStatusCopy,
  type StatusTone,
} from '../../utils/sessionStatus';

type StatusIcon = React.ComponentType<{ 'aria-hidden'?: boolean }>;
type StatusSession = Pick<Session, 'status' | 'ready_for_prompt' | 'scheduler_init_failure_code'>;

/** Icons follow TaskStatusIcon; each state gets its own icon so colour is never the only cue. */
const STATUS_ICONS: Record<SessionStatus, StatusIcon> = {
  [SessionStatus.RUNNING]: LoadingOutlined,
  [SessionStatus.STOPPING]: StopOutlined,
  [SessionStatus.AWAITING_PERMISSION]: PauseCircleOutlined,
  [SessionStatus.AWAITING_INPUT]: QuestionCircleOutlined,
  [SessionStatus.TIMED_OUT]: ClockCircleOutlined,
  [SessionStatus.FAILED]: CloseCircleOutlined,
  [SessionStatus.IDLE]: MinusCircleOutlined,
  [SessionStatus.COMPLETED]: CheckCircleOutlined,
};

export interface SessionStatusPresentation extends SessionStatusCopy {
  /** `primary` is Ready; every other value is the session's status tone. */
  tone: StatusTone | 'primary';
  Icon: StatusIcon;
}

export function getSessionStatusPresentation(session: StatusSession): SessionStatusPresentation {
  if (session.status === SessionStatus.IDLE && session.ready_for_prompt) {
    return { ...READY_STATUS, tone: 'primary', Icon: CheckCircleOutlined };
  }
  return {
    ...describeSessionStatus(session),
    tone: getSessionStatusTone(session.status),
    Icon: STATUS_ICONS[session.status as SessionStatus] ?? MinusCircleOutlined,
  };
}

/** Standalone status icon (mobile nav rows), named by its label. */
export const SessionStatusIcon: React.FC<{ session: StatusSession }> = ({ session }) => {
  const { token } = theme.useToken();
  const { label, description, tone, Icon } = getSessionStatusPresentation(session);
  const color = {
    primary: token.colorPrimary,
    processing: token.colorInfo,
    warning: token.colorWarning,
    error: token.colorError,
    success: token.colorSuccess,
    default: token.colorTextTertiary,
  }[tone];
  return (
    <span
      role="img"
      aria-label={label}
      title={description}
      style={{ color, display: 'inline-flex' }}
    >
      <Icon aria-hidden />
    </span>
  );
};
