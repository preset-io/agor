import {
  AnalyticsPackageLogger,
  resetAnalyticsLoggerForTests,
  setAnalyticsLoggerForTests,
} from '@agor/core/analytics';
import { generateId, runWithTenantContext } from '@agor/core/db';
import { type Task, TaskStatus, type TenantID } from '@agor/core/types';
import { afterEach, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

function fixture(status: Task['status'] = TaskStatus.FAILED) {
  const task = {
    task_id: generateId(),
    session_id: generateId(),
    created_by: generateId(),
    status,
    full_prompt: 'PRIVATE PROMPT',
    error_message: 'PRIVATE PROVIDER ERROR',
    termination_request: { cause: 'heartbeat_lost', requested_at: '2026-01-01T00:00:00Z' },
  } as Task;
  const outcome = status === TaskStatus.STOPPING ? 'unverified' : 'transitioned';
  const settleTermination = vi.fn().mockResolvedValue({ outcome, task });
  const service = Object.create(TasksService.prototype) as TasksService;
  Reflect.set(service, 'taskRepo', { settleTermination });
  Reflect.set(service, 'app', { service: () => ({ emit: vi.fn() }), get: vi.fn() });
  // Only post-commit analytics is under test, not callback/queue orchestration.
  Reflect.set(service, 'processTerminalTaskTransition', vi.fn());
  const input = {
    taskId: task.task_id,
    outcome:
      status === TaskStatus.STOPPING ? ('unverified' as const) : ('verified_absent' as const),
    coordinationToken: 'PRIVATE FENCE',
  };
  return { service, task, input };
}

afterEach(() => {
  resetAnalyticsLoggerForTests();
  vi.restoreAllMocks();
});

it.each([TaskStatus.FAILED, TaskStatus.STOPPING])(
  'records structured %s outcomes only for a winning settlement under the originating tenant',
  async (status) => {
    const track = vi.fn().mockResolvedValue(undefined);
    setAnalyticsLoggerForTests(new AnalyticsPackageLogger({ track } as never));
    const { service, task, input } = fixture(status);
    const event = status === TaskStatus.FAILED ? 'task.completed' : 'task.termination_unverified';
    await runWithTenantContext('tenant-a', () => service.settleTermination(input));
    expect(track).toHaveBeenCalledExactlyOnceWith(
      event,
      expect.objectContaining({
        failure_reason: status === TaskStatus.FAILED ? 'heartbeat_lost' : 'termination_unverified',
        succeeded: false,
      }),
      { userId: task.created_by, context: { tenant_id: 'tenant-a' } }
    );
    expect(JSON.stringify(track.mock.calls)).not.toContain('PRIVATE');

    track.mockClear();
    // Explicit cross-tenant publication is refused before either analytics lane.
    await runWithTenantContext('tenant-a', () =>
      service.settleTermination(input, {
        tenant: { tenant_id: 'tenant-b' as TenantID, source: 'explicit' },
      })
    );
    expect(track).not.toHaveBeenCalled();
  }
);

it('does not emit the unverified lane when the task wildcard is excluded', async () => {
  const track = vi.fn().mockResolvedValue(undefined);
  setAnalyticsLoggerForTests(new AnalyticsPackageLogger({ track } as never, ['task.*']));
  const { service, input } = fixture(TaskStatus.STOPPING);
  await runWithTenantContext('tenant-a', () => service.settleTermination(input));
  expect(track).not.toHaveBeenCalled();
});
