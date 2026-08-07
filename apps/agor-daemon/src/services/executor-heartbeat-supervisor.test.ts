import { beforeEach, describe, expect, it, vi } from 'vitest';

const discovery = vi.hoisted(() => ({
  dispatch: vi.fn(),
  heartbeat: vi.fn(),
  termination: vi.fn(),
}));
const requestExecutorTermination = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ status: 'terminal', task: {} })
);
const getTrackedExecutor = vi.hoisted(() => vi.fn());
const assertTenantWritable = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();
  return {
    ...actual,
    assertTenantWritable,
    TaskRepository: class {
      findExpiredDispatchRefs = discovery.dispatch;
      findStaleHeartbeatRefs = discovery.heartbeat;
      findStrandedTerminationRefs = discovery.termination;
    },
    runWithSystemDatabaseScope: (_db: unknown, _reason: string, work: () => unknown) => work(),
    runWithTenantDatabaseScope: (_db: unknown, _tenantId: string, work: () => unknown) => work(),
    runWithTenantContext: (_tenantId: string, work: () => unknown) => work(),
  };
});
vi.mock('../termination-coordinator.js', () => ({ requestExecutorTermination }));
vi.mock('../executor-tracking.js', () => ({ getTrackedExecutor }));

import { EXECUTOR_HEARTBEAT_LOST_MESSAGE, TaskRuntimeReconciler } from './task-runtime-reconciler';

const now = () => new Date('2026-01-01T00:00:05.000Z');
const config = {
  enabled: true,
  interval_ms: 1000,
  stale_after_ms: 3000,
  callback: { command_template: null, timeout_ms: 3000 },
};

function harness(tasksById: Record<string, Record<string, unknown>>) {
  const recordExecutorStartupWarning = vi.fn(async (taskId: string) => tasksById[taskId] ?? null);
  const app = {
    service: (name: string) => {
      if (name === 'tasks') {
        return {
          get: vi.fn(async (taskId: string) => tasksById[taskId]),
          recordExecutorStartupWarning,
        };
      }
      if (name === 'sessions') {
        return { get: vi.fn().mockResolvedValue({ agentic_tool: 'codex' }) };
      }
      throw new Error(`unknown service ${name}`);
    },
  } as never;

  const create = (
    overrides: Partial<ConstructorParameters<typeof TaskRuntimeReconciler>[0]> = {}
  ) =>
    new TaskRuntimeReconciler({
      app,
      db: {} as never,
      config,
      workIdentity: { instanceId: 'daemon-a', bootId: 'boot-a' },
      tenantId: 'tenant-a',
      now,
      startupOffsetMaxMs: 0,
      ...overrides,
    });

  return { app, create, recordExecutorStartupWarning };
}

describe('TaskRuntimeReconciler', () => {
  beforeEach(() => {
    discovery.dispatch.mockReset().mockResolvedValue([]);
    discovery.heartbeat.mockReset().mockResolvedValue([]);
    discovery.termination.mockReset().mockResolvedValue([]);
    requestExecutorTermination.mockReset().mockResolvedValue({ status: 'terminal', task: {} });
    getTrackedExecutor.mockReset();
    assertTenantWritable.mockReset().mockResolvedValue(undefined);
  });

  it('claims the exact stale-heartbeat fact discovered by the bounded scan', async () => {
    const staleTask = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      status: 'running',
      last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    };
    discovery.heartbeat.mockResolvedValue([
      {
        task_id: staleTask.task_id,
        executor_heartbeat_at: staleTask.last_executor_heartbeat_at,
      },
    ]);
    const { create } = harness({ [staleTask.task_id]: staleTask });

    await create().checkOnce();

    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: staleTask.task_id,
        cause: 'heartbeat_lost',
        errorMessage: EXECUTOR_HEARTBEAT_LOST_MESSAGE,
        expectedStatus: staleTask.status,
        expectedHeartbeatAt: staleTask.last_executor_heartbeat_at,
      })
    );
  });

  it('loses safely when a heartbeat becomes fresh between discovery and tenant reload', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000011',
      session_id: '018f0000-0000-7000-8000-000000000012',
      status: 'running',
      last_executor_heartbeat_at: '2026-01-01T00:00:04.000Z',
    };
    discovery.heartbeat.mockResolvedValue([
      {
        task_id: task.task_id,
        executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const { create } = harness({ [task.task_id]: task });

    expect(await create().checkOnce()).toMatchObject({ processed: 0, failures: 0 });
    expect(requestExecutorTermination).not.toHaveBeenCalled();
  });

  it('loses safely when an executor connects after dispatch-timeout discovery', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000021',
      session_id: '018f0000-0000-7000-8000-000000000022',
      status: 'running',
      executor_connected_at: '2026-01-01T00:00:04.000Z',
    };
    discovery.dispatch.mockResolvedValue([{ task_id: task.task_id }]);
    const { create } = harness({ [task.task_id]: task });

    expect(await create().checkOnce()).toMatchObject({ processed: 0, failures: 0 });
    expect(requestExecutorTermination).not.toHaveBeenCalled();
  });

  it('warns but does not contain a slow templated dispatch', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000031',
      session_id: '018f0000-0000-7000-8000-000000000032',
      status: 'dispatching',
      executor_mode: 'templated',
    };
    discovery.dispatch.mockResolvedValue([{ task_id: task.task_id }]);
    const { create, recordExecutorStartupWarning } = harness({ [task.task_id]: task });

    await create().checkOnce();

    expect(recordExecutorStartupWarning).toHaveBeenCalledWith(
      task.task_id,
      expect.stringContaining('still waiting'),
      expect.objectContaining({
        provider: undefined,
        tenant: expect.objectContaining({ tenant_id: 'tenant-a' }),
      })
    );
    expect(requestExecutorTermination).not.toHaveBeenCalled();
  });

  it('resumes a stranded remote request and guards an unowned local request', async () => {
    const remote = {
      task_id: '018f0000-0000-7000-8000-000000000041',
      session_id: '018f0000-0000-7000-8000-000000000042',
      status: 'stopping',
      executor_mode: 'templated',
      termination_request: {
        cause: 'heartbeat_lost',
        requested_at: '2026-01-01T00:00:00.000Z',
      },
    };
    const local = {
      task_id: '018f0000-0000-7000-8000-000000000051',
      session_id: '018f0000-0000-7000-8000-000000000052',
      status: 'stopping',
      executor_mode: 'local',
      termination_request: {
        cause: 'heartbeat_lost',
        requested_at: '2026-01-01T00:00:00.000Z',
      },
    };
    discovery.termination.mockResolvedValue([
      { task_id: remote.task_id },
      { task_id: local.task_id },
    ]);
    const { create } = harness({ [remote.task_id]: remote, [local.task_id]: local });

    await create({ localOwnerGraceMs: 1000 }).checkOnce();

    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: remote.task_id })
    );
    expect(requestExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: local.task_id,
        allowUnownedLocalContainment: true,
        unownedLocalOwnerGraceMs: 1000,
      })
    );
    expect(getTrackedExecutor).toHaveBeenCalledWith(local.session_id, expect.anything());
  });

  it('advances saturated keyset scans past a failing candidate and wraps after exhaustion', async () => {
    const firstId = '018f0000-0000-7000-8000-000000000071';
    const secondId = '018f0000-0000-7000-8000-000000000072';
    const firstCursor = { task_id: firstId, order_at: '2026-01-01T00:00:00.000Z' };
    const secondCursor = { task_id: secondId, order_at: '2026-01-01T00:00:01.000Z' };
    discovery.dispatch.mockImplementation(
      async (_timeoutMs: number, options: { after?: typeof firstCursor }) => {
        if (!options.after) return [{ task_id: firstId, cursor: firstCursor }];
        if (options.after.task_id === firstId) {
          return [{ task_id: secondId, cursor: secondCursor }];
        }
        return [];
      }
    );
    const secondTask = {
      task_id: secondId,
      session_id: '018f0000-0000-7000-8000-000000000073',
      status: 'dispatching',
      executor_mode: 'templated',
    };
    const { create, recordExecutorStartupWarning } = harness({ [secondId]: secondTask });
    const reconciler = create({ scanBatchSize: 1 });

    await expect(reconciler.checkOnce()).resolves.toMatchObject({ failures: 1, saturated: true });
    await expect(reconciler.checkOnce()).resolves.toMatchObject({ processed: 1, saturated: true });
    await expect(reconciler.checkOnce()).resolves.toMatchObject({ candidates: 0 });
    await expect(reconciler.checkOnce()).resolves.toMatchObject({ failures: 1, saturated: true });

    expect(discovery.dispatch.mock.calls[1]?.[1]).toMatchObject({ after: firstCursor });
    expect(discovery.dispatch.mock.calls[2]?.[1]).toMatchObject({ after: secondCursor });
    expect(discovery.dispatch.mock.calls[3]?.[1]).not.toHaveProperty('after');
    expect(recordExecutorStartupWarning).toHaveBeenCalledWith(
      secondId,
      expect.any(String),
      expect.any(Object)
    );
  });

  it('fails closed at the tenant write gate before reconciliation mutation', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000081',
      session_id: '018f0000-0000-7000-8000-000000000082',
      status: 'running',
      last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
    };
    discovery.heartbeat.mockResolvedValue([
      {
        task_id: task.task_id,
        executor_heartbeat_at: task.last_executor_heartbeat_at,
        cursor: { task_id: task.task_id, order_at: task.last_executor_heartbeat_at },
      },
    ]);
    assertTenantWritable.mockRejectedValueOnce(new Error('tenant writes held'));
    const { create } = harness({ [task.task_id]: task });

    await expect(create().checkOnce()).resolves.toMatchObject({ failures: 1, processed: 0 });
    expect(requestExecutorTermination).not.toHaveBeenCalled();
  });

  it('uses deterministic startup offset and saturated drain jitter', async () => {
    vi.useFakeTimers();
    try {
      const task = {
        task_id: '018f0000-0000-7000-8000-000000000061',
        session_id: '018f0000-0000-7000-8000-000000000062',
        status: 'dispatching',
        executor_mode: 'templated',
      };
      discovery.dispatch.mockResolvedValue([{ task_id: task.task_id }]);
      const { create } = harness({ [task.task_id]: task });
      const reconciler = create({
        scanBatchSize: 1,
        startupOffsetMaxMs: 1000,
        random: () => 0.25,
      });

      reconciler.start();
      await vi.advanceTimersByTimeAsync(249);
      expect(discovery.dispatch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(discovery.dispatch).toHaveBeenCalledTimes(1);

      // 150ms with +/-2/3 jitter and sample .25 is exactly 100ms.
      await vi.advanceTimersByTimeAsync(99);
      expect(discovery.dispatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(discovery.dispatch).toHaveBeenCalledTimes(2);
      reconciler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off idle scans deterministically', async () => {
    vi.useFakeTimers();
    try {
      const { create } = harness({});
      const reconciler = create({
        tickIntervalMs: 1000,
        maxIdleIntervalMs: 4000,
        random: () => 0.5,
      });
      reconciler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(discovery.dispatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(discovery.dispatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(discovery.dispatch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(discovery.dispatch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(discovery.dispatch).toHaveBeenCalledTimes(3);
      reconciler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
