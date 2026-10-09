/**
 * The one session status vocabulary: desktop rows, mobile pills and Home all read
 * labels, descriptions and tones from here. Tones follow #2977: red = broke,
 * amber = needs you, blue = in progress.
 */
import { type Session, SessionStatus } from '@agor-live/client';

export type StatusTone = 'processing' | 'warning' | 'error' | 'success' | 'default';

/** `SessionStatus`, `TaskStatus` and the `'pending'` synonym; unknown values are `'default'`. */
export type StatusInput = Session['status'] | string;

export function getSessionStatusTone(status: StatusInput): StatusTone {
  switch (status) {
    case 'running':
    case 'stopping':
      return 'processing';
    case 'awaiting_input':
    case 'awaiting_permission':
    case 'timed_out':
      return 'warning';
    case 'failed':
      return 'error';
    case 'completed':
      return 'success';
    default:
      return 'default';
  }
}

export const isSessionFailed = (session: Pick<Session, 'status'>): boolean =>
  session.status === SessionStatus.FAILED;

const STATUS_COPY: Record<SessionStatus, { label: string; description: string }> = {
  [SessionStatus.RUNNING]: { label: 'Running', description: 'Running' },
  [SessionStatus.AWAITING_PERMISSION]: {
    label: 'Waiting for approval',
    description: 'The agent is waiting for your approval.',
  },
  [SessionStatus.AWAITING_INPUT]: {
    label: 'Waiting for your reply',
    description: 'The agent is waiting for your reply.',
  },
  [SessionStatus.STOPPING]: { label: 'Stopping', description: 'Stopping the agent…' },
  [SessionStatus.TIMED_OUT]: {
    label: 'Approval timed out',
    description: 'The agent stopped waiting for approval.',
  },
  [SessionStatus.FAILED]: {
    label: 'Last run failed',
    description: 'The last run ended with an error.',
  },
  [SessionStatus.IDLE]: { label: 'Idle', description: 'Idle' },
  [SessionStatus.COMPLETED]: { label: 'Done', description: 'Done' },
};

const SCHEDULED_RUN_DIDNT_START = {
  label: "Scheduled run didn't start",
  description: "This scheduled run didn't start.",
};

export const READY_STATUS = { label: 'Ready', description: 'Ready for your next message.' };

export interface SessionStatusCopy {
  label: string;
  description: string;
}

/** The scheduler writes `failed` and its init failure code together, so the code names the cause. */
export function describeSessionStatus(
  session: Pick<Session, 'status'> & Partial<Pick<Session, 'scheduler_init_failure_code'>>
): SessionStatusCopy {
  if (isSessionFailed(session) && session.scheduler_init_failure_code) {
    return SCHEDULED_RUN_DIDNT_START;
  }
  const fallback = session.status.replaceAll('_', ' ');
  return STATUS_COPY[session.status as SessionStatus] ?? { label: fallback, description: fallback };
}

export const getSessionStatusLabel = (status: string): string =>
  describeSessionStatus({ status: status as SessionStatus }).label;
