import { SessionStatus } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { describeSessionStatus, getSessionStatusTone } from './sessionStatus';

describe('describeSessionStatus', () => {
  it.each([
    [SessionStatus.RUNNING, 'Running', 'Running', 'processing'],
    [
      SessionStatus.AWAITING_PERMISSION,
      'Waiting for approval',
      'The agent is waiting for your approval.',
      'warning',
    ],
    [
      SessionStatus.AWAITING_INPUT,
      'Waiting for your reply',
      'The agent is waiting for your reply.',
      'warning',
    ],
    [SessionStatus.STOPPING, 'Stopping', 'Stopping the agent…', 'processing'],
    [
      SessionStatus.TIMED_OUT,
      'Approval timed out',
      'The agent stopped waiting for approval.',
      'warning',
    ],
    [SessionStatus.FAILED, 'Last run failed', 'The last run ended with an error.', 'error'],
    [SessionStatus.IDLE, 'Idle', 'Idle', 'default'],
    [SessionStatus.COMPLETED, 'Done', 'Done', 'success'],
  ])('%s', (status, label, description, tone) => {
    expect(describeSessionStatus({ status })).toEqual({ label, description });
    expect(getSessionStatusTone(status)).toBe(tone);
  });

  it('names a scheduled run that never started', () => {
    expect(
      describeSessionStatus({
        status: SessionStatus.FAILED,
        scheduler_init_failure_code: 'creator_unavailable',
      })
    ).toEqual({
      label: "Scheduled run didn't start",
      description: "This scheduled run didn't start.",
    });
  });
});
