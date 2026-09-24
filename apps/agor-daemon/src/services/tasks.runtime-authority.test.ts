import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scheduler } from 'node:timers/promises';
import { analyticsLogger } from '@agor/core/analytics';
import { getCurrentTenantId } from '@agor/core/db';
import type { RuntimeTelemetryInput } from '@agor/core/types';
import { AUTHORIZATION_REVOKED_TERMINATION_MESSAGE, TaskStatus } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { beginExecutorTermination } = vi.hoisted(() => ({
  beginExecutorTermination: vi.fn(),
}));
const withFreshTenantWrite = vi.hoisted(() =>
  vi.fn(async (_db: unknown, _tenantId: string, work: () => Promise<unknown>) => work())
);

vi.mock('../termination-coordinator.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../termination-coordinator.js')>()),
  beginExecutorTermination,
}));
vi.mock('../utils/tenant-db-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/tenant-db-scope.js')>()),
  withFreshTenantWrite,
}));

import { NOOP_METRICS } from '../metrics/noop.js';
import { ExecutorHeartbeatCallbackRunner } from '../utils/executor-heartbeat-callback.js';
import { TasksService } from './tasks.js';

const task = {
  task_id: '018f0000-0000-7000-8000-000000000001',
  session_id: '018f0000-0000-7000-8000-000000000002',
  created_by: '018f0000-0000-7000-8000-000000000003',
  status: TaskStatus.RUNNING,
  last_executor_heartbeat_at: '2026-08-28T00:00:01.000Z',
} as const;
const branchId = '018f0000-0000-7000-8000-000000000004';

function runtimeParams(overrides: Record<string, unknown> = {}, tenantId?: string) {
  const payload = {
    type: 'executor-session',
    purpose: 'executor-task',
    sub: task.created_by,
    tenant_id: 'tenant-a',
    session_id: task.session_id,
    task_id: task.task_id,
    branch_id: branchId,
    ...overrides,
  };
  return {
    provider: 'rest',
    tenant: { tenant_id: tenantId ?? payload.tenant_id, source: 'auth_claim' },
    authentication: {
      strategy: 'jwt',
      accessToken: 'verified-task-runtime-token',
      payload,
    },
  } as never;
}

function serviceHarness(input: {
  report: Record<string, unknown>;
  tokenCurrent?: boolean;
  tokenFailure?: Error;
  postgres?: boolean;
}) {
  const service = Object.create(TasksService.prototype) as TasksService;
  const reportRuntimeTelemetry = vi.fn().mockResolvedValue(input.report);
  const isTaskTokenAuthorityCurrent = input.tokenFailure
    ? vi.fn().mockRejectedValue(input.tokenFailure)
    : vi.fn().mockResolvedValue(input.tokenCurrent ?? true);
  Reflect.set(service, 'taskRepo', { reportRuntimeTelemetry });
  const db = input.postgres ? { transaction() {} } : { run() {} };
  Reflect.set(service, 'db', db);
  Reflect.set(service, 'runtimeAuthorityOptions', {});
  Reflect.set(service, 'executorCredentialRevoker', { isTaskTokenAuthorityCurrent });
  Reflect.set(service, 'heartbeatCallbackRunner', { isConfigured: () => false });
  Reflect.set(service, 'app', { service: () => ({ emit: vi.fn() }) });
  return { service, db, reportRuntimeTelemetry, isTaskTokenAuthorityCurrent };
}

describe('TasksService heartbeat authority control', () => {
  beforeEach(() => {
    beginExecutorTermination.mockReset();
    withFreshTenantWrite.mockClear();
  });

  it('claims the existing fenced STOPPING path with one sanitized revoked cause', async () => {
    const stopping = {
      ...task,
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'authorization_revoked',
        requested_at: '2026-08-28T00:00:10.000Z',
        error_message: AUTHORIZATION_REVOKED_TERMINATION_MESSAGE,
      },
    };
    beginExecutorTermination.mockResolvedValue(stopping);
    const { service } = serviceHarness({
      report: {
        outcome: 'authorization_revoked',
        task,
        reason: 'filesystem_access_revoked',
      },
    });

    await expect(
      service.reportRuntimeTelemetry({ task_id: task.task_id }, runtimeParams())
    ).resolves.toBe(stopping);
    expect(beginExecutorTermination).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.task_id,
        cause: 'authorization_revoked',
        errorMessage: AUTHORIZATION_REVOKED_TERMINATION_MESSAGE,
      })
    );
  });

  it('commits the PostgreSQL heartbeat unit before claiming revoked termination', async () => {
    const stopping = {
      ...task,
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'authorization_revoked',
        requested_at: '2026-08-28T00:00:10.000Z',
        error_message: AUTHORIZATION_REVOKED_TERMINATION_MESSAGE,
      },
    };
    beginExecutorTermination.mockResolvedValue(stopping);
    const { service, db, reportRuntimeTelemetry } = serviceHarness({
      postgres: true,
      report: {
        outcome: 'authorization_revoked',
        task,
        reason: 'branch_capability_revoked',
      },
    });

    await expect(
      service.reportRuntimeTelemetry({ task_id: task.task_id }, runtimeParams())
    ).resolves.toBe(stopping);

    expect(withFreshTenantWrite).toHaveBeenCalledWith(db, 'tenant-a', expect.any(Function));
    expect(reportRuntimeTelemetry).toHaveBeenCalledOnce();
    expect(withFreshTenantWrite.mock.invocationCallOrder[0]).toBeLessThan(
      beginExecutorTermination.mock.invocationCallOrder[0]
    );
    expect(reportRuntimeTelemetry.mock.invocationCallOrder[0]).toBeLessThan(
      beginExecutorTermination.mock.invocationCallOrder[0]
    );
  });

  it('does not refresh liveness or start a second watchdog on authority-store failure', async () => {
    const { service, reportRuntimeTelemetry } = serviceHarness({
      report: { outcome: 'continued', task },
      tokenFailure: new Error('authority store unavailable'),
    });

    await expect(
      service.reportRuntimeTelemetry({ task_id: task.task_id }, runtimeParams())
    ).rejects.toThrow('authority store unavailable');
    expect(reportRuntimeTelemetry).not.toHaveBeenCalled();
    expect(beginExecutorTermination).not.toHaveBeenCalled();
  });

  it('rejects a wrong Task binding before repository mutation or termination', async () => {
    const { service, reportRuntimeTelemetry } = serviceHarness({
      report: { outcome: 'continued', task },
    });

    await expect(
      service.reportRuntimeTelemetry(
        { task_id: task.task_id },
        runtimeParams({ task_id: '018f0000-0000-7000-8000-000000000099' })
      )
    ).rejects.toMatchObject({ code: 403 });
    expect(reportRuntimeTelemetry).not.toHaveBeenCalled();
    expect(beginExecutorTermination).not.toHaveBeenCalled();
  });
});

describe('accepted runtime telemetry to real callback command stdin', () => {
  let directory: string;
  let output: string;
  let runner: ExecutorHeartbeatCallbackRunner;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agor-heartbeat-stdin-'));
    output = join(directory, 'callback.json');
    runner = new ExecutorHeartbeatCallbackRunner({
      enabled: true,
      callback: {
        // A real, local executable; cap capture size even if the bridge regresses.
        command_template: `exec head -c 2049 > '${output.replaceAll("'", "'\\''")}'`,
        timeout_ms: 2000,
      },
    });
    vi.spyOn(runner, 'run'); // Call through: no mocked spawn or stdin serialization.
    vi.spyOn(analyticsLogger, 'track').mockImplementation(() => undefined);
    beginExecutorTermination.mockReset();
    beginExecutorTermination.mockResolvedValue({ ...task, status: TaskStatus.STOPPING });
  });

  afterEach(async () => {
    // Wait for the real child to exit before deleting its capture directory.
    await vi.waitFor(() => expect(Reflect.get(runner, 'runningByTask').size).toBe(0));
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function attachCallback(service: TasksService) {
    Reflect.set(service, 'heartbeatCallbackRunner', runner);
    Reflect.set(
      service,
      'findHeartbeatBranchId',
      vi.fn(async () => {
        expect(getCurrentTenantId()).toBe('tenant-a');
        return branchId;
      })
    );
  }

  const current = {
    rss: 123,
    heap_used: 45,
    heap_total: 67,
    heap_limit: 890,
    external: 12,
    array_buffers: 0,
  };

  it.each([
    {
      name: 'all six fields and no unknown content',
      sample: {
        current: { ...current, secret: 'do not forward', cgroup: 999 },
        sampled_peak: { rss: 999 },
        children: [{ rss: 999 }],
        version: 1,
        timestamp: 'not forwarded',
      },
      expected: { current },
    },
    {
      name: 'partial sample excluding invalid numbers',
      sample: {
        current: {
          rss: 0,
          heap_used: -1,
          heap_total: 1.5,
          heap_limit: Number.MAX_SAFE_INTEGER + 1,
          external: Infinity,
          array_buffers: '12',
        },
      },
      expected: { current: { rss: 0 } },
    },
    ...[
      undefined,
      null,
      'bad',
      [],
      { current: null },
      { current: [] },
      { current: { rss: NaN, unknown: 1 } },
    ].map((sample, index) => ({
      name: `absent/malformed sample ${index}`,
      sample,
      expected: undefined,
    })),
  ])('preserves liveness and writes $name', async ({ sample, expected }) => {
    const { service, reportRuntimeTelemetry } = serviceHarness({
      report: { outcome: 'continued', task },
    });
    attachCallback(service);
    const result = await service.reportRuntimeTelemetry(
      {
        task_id: task.task_id,
        memory: sample as RuntimeTelemetryInput['memory'],
      },
      runtimeParams()
    );

    expect(result).toBe(task);
    expect(result).not.toHaveProperty('memory');
    expect(reportRuntimeTelemetry).toHaveBeenCalledWith(
      task.task_id,
      expect.any(Object),
      undefined
    );
    expect(analyticsLogger.track).toHaveBeenCalledWith(
      'executor.heartbeat',
      {
        task_id: task.task_id,
        session_id: task.session_id,
        status: task.status,
        last_executor_heartbeat_at: task.last_executor_heartbeat_at,
      },
      { userId: task.created_by }
    );
    await vi.waitFor(async () => {
      const raw = await readFile(output, 'utf8');
      expect(Buffer.byteLength(raw)).toBeLessThan(2049);
      expect(raw.endsWith('\n')).toBe(true);
      expect(JSON.parse(raw)).toEqual({
        event: 'executor_heartbeat',
        task_id: task.task_id,
        session_id: task.session_id,
        last_executor_heartbeat_at: task.last_executor_heartbeat_at,
        branch_id: branchId,
        ...(expected ? { memory: expected } : {}),
      });
    });
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it.each([
    'scope_mismatch',
    'authorization_revoked',
    'control',
    'wrong_task',
    'wrong_tenant',
    'store_failure',
  ])('does not launch or forward telemetry for %s', async (reason) => {
    const { service, reportRuntimeTelemetry } = serviceHarness({
      report: {
        outcome: ['wrong_task', 'wrong_tenant', 'store_failure'].includes(reason)
          ? 'continued'
          : reason,
        task,
        reason: 'branch_capability_revoked',
      },
      ...(reason === 'store_failure' ? { tokenFailure: new Error('authority unavailable') } : {}),
    });
    attachCallback(service);
    const params = runtimeParams(
      reason === 'wrong_task' ? { task_id: '018f0000-0000-7000-8000-000000000099' } : {},
      reason === 'wrong_tenant' ? 'tenant-b' : undefined
    );
    const report = service.reportRuntimeTelemetry(
      { task_id: task.task_id, memory: { current } },
      params
    );
    if (reason === 'authorization_revoked')
      await expect(report).resolves.toMatchObject({ status: TaskStatus.STOPPING });
    else await expect(report).rejects.toThrow();
    if (['wrong_task', 'wrong_tenant', 'store_failure'].includes(reason)) {
      expect(reportRuntimeTelemetry).not.toHaveBeenCalled();
    }
    await scheduler.yield(); // Drain the service's deferred callback boundary.
    expect(runner.run).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
    expect(analyticsLogger.track).not.toHaveBeenCalled();
  });
});

it('exports memory only after accepted authority, never for another tenant or a revoked task', async () => {
  for (const outcome of ['continued', 'scope_mismatch', 'authorization_revoked']) {
    const { service } = serviceHarness({
      report: { outcome, task, reason: 'branch_capability_revoked' },
    });
    const distribution = vi.fn();
    Reflect.set(service, 'app', {
      get: () => ({ ...NOOP_METRICS, enabled: true, distribution }),
      service: () => ({ emit: vi.fn() }),
    });
    const input = {
      task_id: task.task_id,
      memory: { current: { rss: 123 }, sampled_peak: { rss: 456 } },
    };
    await service
      .reportRuntimeTelemetry(
        input,
        runtimeParams(outcome === 'scope_mismatch' ? { tenant_id: 'tenant-b' } : {})
      )
      .catch(() => undefined);
    expect(distribution.mock.calls.length).toBe(outcome === 'continued' ? 1 : 0);
  }
});
