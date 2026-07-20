import { type SdkFailure, TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const beginExecutorTermination = vi.hoisted(() => vi.fn());
vi.mock('../termination-coordinator.js', () => ({ beginExecutorTermination }));

import { TasksService } from './tasks.js';

const task = {
  task_id: '018f0000-0000-7000-8000-000000000001',
  session_id: '018f0000-0000-7000-8000-000000000002',
  status: TaskStatus.RUNNING,
  created_at: '2026-01-01T00:00:00.000Z',
  executor_connected_at: '2026-01-01T00:00:01.000Z',
  sdk_watchdog_mode: 'observe' as const,
};

function serviceFor(current = task, observationAccepted = true) {
  const service = Object.create(TasksService.prototype) as TasksService & {
    app: unknown;
    get: ReturnType<typeof vi.fn>;
  };
  service.get = vi.fn().mockResolvedValue(current);
  Object.defineProperty(service, 'taskRepo', {
    value: {
      recordSdkHealthObservation: vi.fn(async (_id: string, failure: SdkFailure) =>
        observationAccepted ? { ...current, sdk_failure: failure } : null
      ),
    },
  });
  service.app = {
    get: () => ({ execution: { sdk_watchdog: { abort_grace_ms: 25 } } }),
    service: (name: string) => {
      if (name === 'sessions') return { get: vi.fn().mockResolvedValue({ agentic_tool: 'codex' }) };
      if (name === 'tasks') return { emit: vi.fn() };
      throw new Error(`unexpected service ${name}`);
    },
  };
  return service;
}

describe('TasksService SDK health reports', () => {
  beforeEach(() => beginExecutorTermination.mockReset());

  it('persists observe-only evidence without lifecycle side effects', async () => {
    const service = serviceFor();
    const result = await service.reportSdkHealthFailure({
      task_id: task.task_id,
      reason: 'no_first_progress',
      elapsed_ms: 180_000,
      watchdog_action: 'would_fire',
      sdk_version: 'sdk@1.0.0',
    });

    expect(result).toMatchObject({
      status: TaskStatus.RUNNING,
      sdk_failure: {
        reason: 'no_first_progress',
        watchdog_action: 'would_fire',
        termination: 'not_requested',
      },
    });
    expect(beginExecutorTermination).not.toHaveBeenCalled();
  });

  it('does not attach observe-only evidence after normal completion wins', async () => {
    await expect(
      serviceFor(task, false).reportSdkHealthFailure({
        task_id: task.task_id,
        reason: 'no_first_progress',
        watchdog_action: 'would_fire',
      })
    ).rejects.toThrow('no longer active');
    expect(beginExecutorTermination).not.toHaveBeenCalled();
  });

  it('rejects non-watchdog failure reasons at the runtime boundary', async () => {
    await expect(
      serviceFor().reportSdkHealthFailure({
        task_id: task.task_id,
        reason: 'heartbeat_lost' as never,
        watchdog_action: 'would_fire',
      })
    ).rejects.toThrow('invalid SDK health reason');
  });

  it('hands enforced decisions to the shared coordinator with the configured grace', async () => {
    const current = { ...task, sdk_watchdog_mode: 'enforce' as const };
    const service = serviceFor(current);
    beginExecutorTermination.mockResolvedValue({ ...current, status: TaskStatus.STOPPING });

    await service.reportSdkHealthFailure({
      task_id: task.task_id,
      reason: 'no_first_progress',
      watchdog_action: 'enforced',
    });

    expect(beginExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.task_id,
        cause: 'sdk_health_failure',
        signalDelayMs: 25,
        sdkFailure: expect.objectContaining({ termination: 'requested' }),
      })
    );
  });

  it('rejects terminal, disconnected, disabled, and authority-escalating reports', async () => {
    await expect(
      serviceFor({ ...task, status: TaskStatus.COMPLETED }).reportSdkHealthFailure({
        task_id: task.task_id,
        reason: 'no_first_progress',
        watchdog_action: 'would_fire',
      })
    ).rejects.toThrow('not connected and active');
    await expect(
      serviceFor({ ...task, sdk_watchdog_mode: 'disabled' }).reportSdkHealthFailure({
        task_id: task.task_id,
        reason: 'no_first_progress',
        watchdog_action: 'would_fire',
      })
    ).rejects.toThrow('disabled');
    await expect(
      serviceFor().reportSdkHealthFailure({
        task_id: task.task_id,
        reason: 'no_first_progress',
        watchdog_action: 'enforced',
      })
    ).rejects.toThrow('must be would_fire');
  });

  it('returns the persisted result for a retry after coordinator ownership', async () => {
    const current = {
      ...task,
      status: TaskStatus.STOPPING,
      sdk_watchdog_mode: 'enforce' as const,
      sdk_failure: {
        reason: 'no_first_progress' as const,
        detected_at: '2026-01-01T00:03:01.000Z',
        tool: 'codex' as const,
        watchdog_action: 'enforced' as const,
        termination: 'requested' as const,
      },
      termination_request: {
        cause: 'sdk_health_failure' as const,
        requested_at: '2026-01-01T00:03:01.000Z',
      },
    };
    await expect(
      serviceFor(current).reportSdkHealthFailure({
        task_id: task.task_id,
        reason: 'no_first_progress',
        watchdog_action: 'enforced',
      })
    ).resolves.toBe(current);
  });
});
