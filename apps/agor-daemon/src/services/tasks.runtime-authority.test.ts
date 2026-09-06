import { AUTHORIZATION_REVOKED_TERMINATION_MESSAGE, TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { TasksService } from './tasks.js';

const task = {
  task_id: '018f0000-0000-7000-8000-000000000001',
  session_id: '018f0000-0000-7000-8000-000000000002',
  created_by: '018f0000-0000-7000-8000-000000000003',
  status: TaskStatus.RUNNING,
  last_executor_heartbeat_at: '2026-08-28T00:00:01.000Z',
} as const;
const branchId = '018f0000-0000-7000-8000-000000000004';

function runtimeParams(overrides: Record<string, unknown> = {}) {
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
    tenant: { tenant_id: payload.tenant_id, source: 'auth_claim' },
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
