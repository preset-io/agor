import { feathers } from '@agor/core/feathers';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { requireExecutorRuntimeToken } from '../auth/executor-runtime-scope';
import { protectServerManagedTaskWrites } from '../register-hooks';
import { TasksService } from './tasks';

const TASK_ID = '018f0000-0000-7000-8000-000000000001';
const SESSION_ID = '018f0000-0000-7000-8000-000000000002';
const USER_ID = '018f0000-0000-7000-8000-000000000003';
const EXECUTOR_ATTEMPT_ID = '018f0000-0000-7000-8000-000000000004';
const TENANT_ID = '018f0000-0000-7000-8000-000000000006';

function createService(ownerAttemptId = EXECUTOR_ATTEMPT_ID) {
  const service = Object.create(TasksService.prototype) as TasksService & {
    patch: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
  };
  const recordExecutorTelemetry = vi.fn(async (_id, attemptId, telemetry) =>
    attemptId === ownerAttemptId
      ? {
          task_id: TASK_ID,
          session_id: SESSION_ID,
          created_by: USER_ID,
          status: TaskStatus.RUNNING,
          executor_attempt_id: ownerAttemptId,
          ...telemetry,
        }
      : null
  );
  Reflect.set(service, 'taskRepo', {
    recordExecutorTelemetry,
  });
  Reflect.set(service, 'app', { service: vi.fn(() => service) });
  Reflect.set(service, 'publishExecutorHeartbeat', vi.fn());
  service.patch = vi.fn(async (_id, data) => ({ task_id: TASK_ID, ...data }));
  service.emit = vi.fn();
  return service;
}

describe('TasksService executor telemetry', () => {
  it('uses daemon time and strips unmodeled pulse data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    try {
      const service = createService();
      const params = {
        tenant: { tenant_id: TENANT_ID, source: 'explicit' },
      } as never;

      await service.reportExecutorTelemetry(
        {
          task_id: TASK_ID,
          executor_attempt_id: EXECUTOR_ATTEMPT_ID,
          heartbeat: true,
          pulse: {
            kind: 'tool.progress',
            id: 'tool-1',
            label: 'Bash',
            secret: 'do not persist',
            at: '1999-01-01T00:00:00.000Z',
          } as never,
        },
        params
      );

      expect(Reflect.get(service, 'taskRepo').recordExecutorTelemetry).toHaveBeenCalledWith(
        TASK_ID,
        EXECUTOR_ATTEMPT_ID,
        {
          last_executor_heartbeat_at: '2026-01-01T00:00:05.000Z',
          latest_executor_pulse: {
            kind: 'tool.progress',
            id: 'tool-1',
            label: 'Bash',
            at: '2026-01-01T00:00:05.000Z',
          },
        }
      );
      expect(service.patch).not.toHaveBeenCalled();
      expect(service.emit).toHaveBeenCalledWith(
        'patched',
        expect.objectContaining({
          last_executor_heartbeat_at: '2026-01-01T00:00:05.000Z',
        }),
        expect.objectContaining({
          path: 'tasks',
          method: 'patch',
          event: 'patched',
          id: TASK_ID,
          params,
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects telemetry from a process attempt that did not win the claim', async () => {
    const service = createService('018f0000-0000-7000-8000-000000000005');

    await expect(
      service.reportExecutorTelemetry({
        task_id: TASK_ID,
        executor_attempt_id: EXECUTOR_ATTEMPT_ID,
        heartbeat: true,
      })
    ).rejects.toThrow('Executor does not own this task or telemetry is no longer accepted');
    expect(Reflect.get(service, 'taskRepo').recordExecutorTelemetry).toHaveBeenCalledOnce();
    expect(service.emit).not.toHaveBeenCalled();
  });

  it('allows a final pulse flush without advancing the heartbeat', async () => {
    const service = createService();

    await service.reportExecutorTelemetry({
      task_id: TASK_ID,
      executor_attempt_id: EXECUTOR_ATTEMPT_ID,
      heartbeat: false,
      pulse: { kind: 'tool.finished', label: 'Bash' },
    });

    expect(
      Reflect.get(service, 'taskRepo').recordExecutorTelemetry.mock.calls[0]?.[2]
    ).not.toHaveProperty('last_executor_heartbeat_at');
  });

  it('does not let fallback SDK chatter replace meaningful progress', async () => {
    const service = createService();

    await service.reportExecutorTelemetry({
      task_id: TASK_ID,
      executor_attempt_id: EXECUTOR_ATTEMPT_ID,
      heartbeat: true,
      pulse: { kind: 'sdk.unknown', label: 'event_msg' },
    });

    expect(
      Reflect.get(service, 'taskRepo').recordExecutorTelemetry.mock.calls[0]?.[2]
    ).not.toHaveProperty('latest_executor_pulse');
  });

  it('accepts authenticated executor telemetry through Feathers without weakening patch guards', async () => {
    const app = feathers();
    const service = createService();
    app.use('tasks', service as never, {
      methods: ['patch', 'reportExecutorTelemetry'],
    });
    app.service('tasks').hooks({
      before: {
        patch: [protectServerManagedTaskWrites],
        reportExecutorTelemetry: [requireExecutorRuntimeToken()],
      },
    });

    const params = {
      provider: 'socketio',
      authentication: {
        strategy: 'jwt',
        payload: {
          type: 'executor-session',
          purpose: 'executor-task',
          task_id: TASK_ID,
          executor_attempt_id: EXECUTOR_ATTEMPT_ID,
        },
      },
    };
    const tasks = app.service('tasks') as unknown as {
      patch: (id: string, data: Record<string, unknown>, params: unknown) => Promise<unknown>;
      reportExecutorTelemetry: (
        data: {
          task_id: string;
          executor_attempt_id: string;
          heartbeat: boolean;
        },
        params: unknown
      ) => Promise<unknown>;
    };

    await expect(
      tasks.patch(TASK_ID, { last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z' }, params)
    ).rejects.toThrow('executor-owned task state is server-managed');
    await expect(
      tasks.reportExecutorTelemetry(
        {
          task_id: TASK_ID,
          executor_attempt_id: EXECUTOR_ATTEMPT_ID,
          heartbeat: true,
        },
        params
      )
    ).resolves.toMatchObject({
      task_id: TASK_ID,
      last_executor_heartbeat_at: expect.any(String),
    });
  });
});
