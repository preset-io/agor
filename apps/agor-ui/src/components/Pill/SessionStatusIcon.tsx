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
import type React from 'react';
import {
  describeSessionStatus,
  getSessionStatusTone,
  READY_STATUS,
  type SessionStatusCopy,
  type SessionStatusInput,
  type StatusTone,
} from '../../utils/sessionStatus';

type StatusIcon = React.ComponentType<{ 'aria-hidden'?: boolean }>;
type StatusSession = SessionStatusInput & Partial<Pick<Session, 'ready_for_prompt'>>;
type PresentationTone = StatusTone | 'primary';

/** Ant Design preset per tone: the pill's Tag colour and, via the token, the icon colour. */
const TONE_COLORS = {
  primary: 'blue',
  processing: 'cyan',
  warning: 'orange',
  error: 'red',
  success: 'green',
  default: 'default',
} as const satisfies Record<PresentationTone, string>;

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
  tone: PresentationTone;
  color: (typeof TONE_COLORS)[PresentationTone];
  Icon: StatusIcon;
}

export function getSessionStatusPresentation(session: StatusSession): SessionStatusPresentation {
  if (session.status === SessionStatus.IDLE && session.ready_for_prompt) {
    return {
      ...READY_STATUS,
      tone: 'primary',
      color: TONE_COLORS.primary,
      Icon: CheckCircleOutlined,
    };
  }
  const tone = getSessionStatusTone(session.status);
  return {
    ...describeSessionStatus(session),
    tone,
    color: TONE_COLORS[tone],
    Icon: STATUS_ICONS[session.status as SessionStatus] ?? MinusCircleOutlined,
  };
}
