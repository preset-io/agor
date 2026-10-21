import { type Task, TaskStatus, TERMINATION_CAUSES } from '@agor/core/types';
import { expect, it } from 'vitest';
import { taskFailureAnalytics } from './task-failure-analytics';

// This pure projection needs only lifecycle fields, not a repository fixture.
const task = (fields: Partial<Task>): Parameters<typeof taskFailureAnalytics>[0] => ({
  status: TaskStatus.FAILED,
  ...fields,
});

it.each(TERMINATION_CAUSES)('projects the bounded termination cause %s', (cause) => {
  const result = taskFailureAnalytics(
    task({ termination_request: { cause, requested_at: '2026-01-01T00:00:00Z' } })
  );
  expect(result.termination_cause).toBe(cause);
  expect(result.failure_reason).toBe(cause);
});

it('does not classify ordinary success or a verified user stop as failure', () => {
  for (const status of [TaskStatus.COMPLETED, TaskStatus.STOPPED]) {
    expect(
      taskFailureAnalytics(
        task({
          status,
          termination_request: { cause: 'user_stop', requested_at: '2026-01-01T00:00:00Z' },
        })
      ).failure_reason
    ).toBeNull();
  }
});

it('keeps unknown failures unknown, including OOM-looking prose and exit 137', () => {
  for (const error_message of [
    'The agent went over its 6 GiB memory limit and was stopped.',
    'Exit 137 SIGKILL OOMKilled; private provider text',
    'API key secret-token rejected for private@example.test',
  ]) {
    const result = taskFailureAnalytics(task({ error_message }));
    expect(result.failure_reason).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain(error_message);
    expect(result).not.toHaveProperty('memory_limit_bytes');
  }
  expect(taskFailureAnalytics(task({ status: TaskStatus.TIMED_OUT })).failure_reason).toBe(
    'timed_out'
  );
});

it('separates an observed SDK stall from an enforced health failure', () => {
  const sdk_failure: Task['sdk_failure'] = {
    reason: 'progress_stalled',
    detected_at: '2026-01-01T00:00:00Z',
    tool: 'codex',
    termination: 'not_requested',
    watchdog_action: 'would_fire',
    elapsed_ms: 60000,
    sdk_version: 'not-exported',
    last_pulse: { sequence: 1, kind: 'progress', observed_at: 'now', detail: 'private-content' },
  };
  const observed = taskFailureAnalytics(task({ sdk_failure }));
  expect(observed).toMatchObject({
    failure_reason: 'unknown',
    sdk_failure_reason: 'progress_stalled',
    watchdog_action: 'would_fire',
    sdk_elapsed_ms: 60000,
  });
  expect(
    taskFailureAnalytics(task({ status: TaskStatus.COMPLETED, sdk_failure })).failure_reason
  ).toBeNull();
  const enforced = taskFailureAnalytics(
    task({
      sdk_failure: { ...sdk_failure, watchdog_action: 'enforced', termination: 'verified' },
      termination_request: { cause: 'sdk_health_failure', requested_at: 'now' },
    })
  );
  expect(enforced.failure_reason).toBe('progress_stalled');
  expect(JSON.stringify(enforced)).not.toMatch(/private-content|not-exported/);
});

it('reports unverified containment even though the task remains stopping', () => {
  const result = taskFailureAnalytics(
    task({
      status: TaskStatus.STOPPING,
      sdk_failure: {
        reason: 'heartbeat_lost',
        detected_at: 'now',
        tool: 'codex',
        termination: 'unverified',
      },
      termination_request: { cause: 'heartbeat_lost', requested_at: 'now' },
    })
  );
  expect(result).toMatchObject({
    failure_reason: 'termination_unverified',
    termination_cause: 'heartbeat_lost',
    sdk_failure_reason: 'heartbeat_lost',
  });
});

it('drops unrecognized runtime enums, nested content, and invalid numeric details', () => {
  const malformed = {
    status: TaskStatus.FAILED,
    full_prompt: 'PRIVATE',
    error_message: 'PRIVATE',
    executor_mode: 'PRIVATE',
    termination_request: {
      cause: 'PRIVATE',
      error_message: 'PRIVATE',
      cleanup_diagnostic: 'PRIVATE',
    },
    sdk_failure: {
      reason: 'PRIVATE',
      termination: 'PRIVATE',
      watchdog_action: 'PRIVATE',
      elapsed_ms: Infinity,
      last_pulse: { detail: 'PRIVATE' },
    },
  } as unknown as Parameters<typeof taskFailureAnalytics>[0];
  expect(taskFailureAnalytics(malformed)).toEqual({
    failure_reason: 'unknown',
    termination_cause: null,
    sdk_failure_reason: null,
    termination_state: null,
    watchdog_action: null,
    sdk_elapsed_ms: null,
    executor_mode: null,
    executor_connected: false,
  });
});
