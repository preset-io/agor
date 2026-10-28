import type { Session } from '@agor-live/client';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  LoadingOutlined,
} from '@ant-design/icons';
import { theme } from 'antd';
import type React from 'react';
import { isUnreadResult } from '../../store/homeSelectors';
import { getSessionStatusTone } from '../../utils/sessionStatus';
import { getSessionDisplayTitle } from '../../utils/sessionTitle';

export type SessionTabStatus = 'needs-you' | 'running' | 'unread' | 'failed' | 'idle';

export const SESSION_TAB_STATUS_LABELS: Record<SessionTabStatus, string> = {
  'needs-you': 'Needs you',
  running: 'Running',
  unread: 'Completed, not read yet',
  failed: 'Failed',
  idle: 'Idle',
};

/** The selected tab is being read, so it never shows as unread. */
export function getSessionTabStatus(session: Session, selected = false): SessionTabStatus {
  const tone = getSessionStatusTone(session.status);
  if (tone === 'warning') return 'needs-you';
  if (tone === 'processing') return 'running';
  if (tone === 'error') return 'failed';
  return !selected && isUnreadResult(session) ? 'unread' : 'idle';
}

export const getSessionTabTitle = (session: Session) =>
  getSessionDisplayTitle(session) || 'Untitled session';

export const filterNeedsYou = (sessions: Session[]) =>
  sessions.filter((session) => getSessionTabStatus(session) === 'needs-you');

/** "1 needs you: A" / "2 need you: A, B"; empty when nobody is waiting. */
export function formatNeedsYou(waiting: Session[]): string {
  if (!waiting.length) return '';
  const titles = waiting.map(getSessionTabTitle).join(', ');
  return `${waiting.length} ${waiting.length === 1 ? 'needs' : 'need'} you: ${titles}`;
}

const STATUS_ICONS = {
  'needs-you': ExclamationCircleFilled,
  running: LoadingOutlined,
  unread: CheckCircleFilled,
  failed: CloseCircleFilled,
} as const;

export const SessionTabStatusIcon: React.FC<{ status: SessionTabStatus }> = ({ status }) => {
  const { token } = theme.useToken();
  if (status === 'idle') return null;
  const Icon = STATUS_ICONS[status];
  const color = {
    'needs-you': token.colorWarning,
    running: token.colorPrimary,
    unread: token.colorPrimary,
    failed: token.colorError,
  }[status];
  return (
    <Icon
      role="img"
      aria-label={SESSION_TAB_STATUS_LABELS[status]}
      spin={status === 'running'}
      style={{ flex: 'none', color }}
    />
  );
};
