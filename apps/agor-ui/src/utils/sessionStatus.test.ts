import { SessionStatus, type TaskID } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { describeSessionStatus, getSessionStatusTone } from './sessionStatus';

describe('describeSessionStatus', () => {
  it.each([
    [SessionStatus.RUNNING, 'Running', undefined, 'processing'],
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
    [SessionStatus.IDLE, 'Idle', undefined, 'default'],
    [SessionStatus.COMPLETED, 'Done', undefined, 'success'],
  ])('%s', (status, label, description, tone) => {
    expect(describeSessionStatus({ status })).toEqual({ label, description });
    expect(getSessionStatusTone(status)).toBe(tone);
  });

  it('names a scheduled run that never started (permanent failure, no retry time)', () => {
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

  it('keeps "Last run failed" when the init failure is transient (retry time set)', () => {
    expect(
      describeSessionStatus({
        status: SessionStatus.FAILED,
        scheduler_init_failure_code: 'initialization_transient',
        scheduler_init_retry_at: '2026-10-11T10:00:00.000Z',
      }).label
    ).toBe('Last run failed');
  });

  it('keeps "Last run failed" for a later run after the scheduled one never started', () => {
    expect(
      describeSessionStatus({
        status: SessionStatus.FAILED,
        scheduler_init_failure_code: 'mcp_server_not_usable',
        tasks: ['task-1' as TaskID],
      }).label
    ).toBe('Last run failed');
  });
});
