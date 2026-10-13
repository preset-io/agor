/**
 * Session status labels, descriptions and tones for status pills, session rows and
 * mobile icons. Red means it broke, amber means it needs you, blue means in progress.
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

export interface SessionStatusCopy {
  label: string;
  /** Only where it says more than the label. */
  description?: string;
}

const STATUS_COPY: Record<SessionStatus, SessionStatusCopy> = {
  [SessionStatus.RUNNING]: { label: 'Running' },
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
  [SessionStatus.IDLE]: { label: 'Idle' },
  [SessionStatus.COMPLETED]: { label: 'Done' },
};

const SCHEDULED_RUN_DIDNT_START = {
  label: "Scheduled run didn't start",
  description: "This scheduled run didn't start.",
};

export const READY_STATUS: SessionStatusCopy = {
  label: 'Ready',
  description: 'Ready for your next message.',
};

export type SessionStatusInput = Pick<Session, 'status'> &
  Partial<Pick<Session, 'scheduler_init_failure_code' | 'scheduler_init_retry_at' | 'tasks'>>;

/**
 * A failure code without a retry time is the scheduler's permanent "never started" record;
 * a code with a retry time is transient and can coexist with a run that did start.
 * The record is never cleared, so once the session has a Task a later failure is that run's.
 */
export function describeSessionStatus(session: SessionStatusInput): SessionStatusCopy {
  if (
    isSessionFailed(session) &&
    session.scheduler_init_failure_code &&
    !session.scheduler_init_retry_at &&
    !session.tasks?.length
  ) {
    return SCHEDULED_RUN_DIDNT_START;
  }
  return (
    STATUS_COPY[session.status as SessionStatus] ?? { label: session.status.replaceAll('_', ' ') }
  );
}

export const getSessionStatusLabel = (status: string): string =>
  describeSessionStatus({ status: status as SessionStatus }).label;
