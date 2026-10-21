import { type Task, TaskStatus, TERMINATION_CAUSES } from '@agor/core/types';
import { expect, it } from 'vitest';
import { taskFailureAnalytics } from './task-failure-analytics';

it('uses the recorded termination cause without reclassifying SDK observations', () => {
  for (const cause of TERMINATION_CAUSES) {
    const task = {
      status: TaskStatus.FAILED,
      termination_request: { cause, requested_at: '2026-01-01T00:00:00Z' },
      sdk_failure: { reason: 'progress_stalled', watchdog_action: 'would_fire' },
    };
    expect(taskFailureAnalytics(task)).toEqual({ succeeded: false, failure_reason: cause });
  }
});

it('does not export unknown runtime causes or private error content', () => {
  const task = {
    status: TaskStatus.FAILED,
    termination_request: { cause: 'PRIVATE', requested_at: '2026-01-01T00:00:00Z' },
    error_message: 'PRIVATE OOMKilled exit 137',
    full_prompt: 'PRIVATE',
  } as unknown as Pick<Task, 'status' | 'termination_request'>;
  expect(taskFailureAnalytics(task)).toEqual({ succeeded: false, failure_reason: 'unknown' });
});
