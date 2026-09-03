import { getCurrentTenantId, SessionRepository } from '@agor/core/db';
import type { Message, Session, Task, WorkloadCompletionInput } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks';

describe('TasksService executor connection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs successful executor connection latency', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      created_by: '018f0000-0000-7000-8000-000000000003',
      full_prompt: 'test',
      status: TaskStatus.RUNNING,
      message_range: {
        start_index: 0,
        end_index: 0,
        start_timestamp: '2026-01-01T00:00:00.000Z',
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
      tool_use_count: 0,
      created_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:01.000Z',
      executor_connected_at: '2026-01-01T00:00:01.125Z',
    } as Task;
    const service = Object.create(TasksService.prototype) as TasksService;
    const emit = vi.fn();
    Reflect.set(service, 'taskRepo', {
      connectExecutor: vi.fn().mockResolvedValue({ task, transitioned: true }),
    });
    Reflect.set(service, 'app', { service: () => ({ emit }) });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await service.connectExecutor({ task_id: task.task_id });

    expect(log).toHaveBeenCalledWith(
      '🔌 [TasksService] Executor connected for task 018f00000000700080000000 in 125ms'
    );
    expect(emit).toHaveBeenCalledWith('patched', task, expect.objectContaining({ path: 'tasks' }));
  });

  it('publishes a startup warning only when the repository changes it', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      status: TaskStatus.DISPATCHING,
      error_message: 'still waiting',
    } as Task;
    const service = Object.create(TasksService.prototype) as TasksService;
    const emit = vi.fn();
    const recordExecutorStartupWarning = vi
      .fn()
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce(null);
    Reflect.set(service, 'taskRepo', { recordExecutorStartupWarning });
    Reflect.set(service, 'app', { service: () => ({ emit }) });

    await service.recordExecutorStartupWarning(task.task_id, task.error_message!);
    await service.recordExecutorStartupWarning(task.task_id, task.error_message!);

    expect(emit).toHaveBeenCalledOnce();
  });
});

describe('TasksService executor patches', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTask(fullPrompt: string): Task {
    return {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      created_by: '018f0000-0000-7000-8000-000000000003',
      full_prompt: fullPrompt,
      status: TaskStatus.RUNNING,
      created_at: '2026-01-01T00:00:00.000Z',
      executor_connected_at: '2026-01-01T00:00:01.000Z',
    } as Task;
  }

  function makePatchHarness(task: Task, agenticTool: Session['agentic_tool']) {
    const updateFromExecutor = vi.fn(
      async (_id: string, updates: Partial<Task>): Promise<Task> => ({ ...task, ...updates })
    );
    const service = Object.create(TasksService.prototype) as TasksService;
    vi.spyOn(service, 'get').mockResolvedValue(task);
    vi.spyOn(SessionRepository.prototype, 'findById').mockResolvedValue({
      agentic_tool: agenticTool,
    } as Session);
    Reflect.set(service, 'taskRepo', { updateFromExecutor });
    Reflect.set(service, 'db', {});
    Reflect.set(service, 'trackTaskCompleted', vi.fn());
    Reflect.set(service, 'retireTaskExecutorCredentials', vi.fn());
    Reflect.set(service, 'processCompletionSideEffects', vi.fn().mockResolvedValue(true));
    return { service, updateFromExecutor };
  }

  it('uses the row-locked executor mutation path for transport patches', async () => {
    const service = Object.create(TasksService.prototype) as TasksService;
    const updateFromExecutor = vi
      .fn()
      .mockResolvedValue({ task_id: 'task-1', model: 'test-model' });
    Reflect.set(service, 'taskRepo', { updateFromExecutor });

    await service.patch('task-1', { model: 'test-model' }, { provider: 'rest' });

    expect(updateFromExecutor).toHaveBeenCalledWith('task-1', { model: 'test-model' });
  });

  it.each([TaskStatus.STOPPED, TaskStatus.TIMED_OUT])(
    'rejects an executor-originated %s patch for controlled failure',
    async (status) => {
      const task = makeTask('{"schemaVersion":1,"profile":"controlled-failure","delayMs":10}');
      const { service, updateFromExecutor } = makePatchHarness(task, 'workload');

      await expect(
        service.patch(
          task.task_id,
          {
            status,
            completed_at: '2026-01-01T00:00:05.000Z',
            error_message: 'caller supplied terminality',
          },
          { provider: 'rest' }
        )
      ).rejects.toThrow('Controlled workload failures must complete through completeWorkload');
      expect(updateFromExecutor).not.toHaveBeenCalled();
    }
  );

  it.each([TaskStatus.STOPPED, TaskStatus.TIMED_OUT])(
    'preserves controlled failure executor %s patches for non-workload sessions',
    async (status) => {
      const task = makeTask('{"schemaVersion":1,"profile":"controlled-failure","delayMs":10}');
      const { service, updateFromExecutor } = makePatchHarness(task, 'codex');

      await expect(
        service.patch(
          task.task_id,
          { status, completed_at: '2026-01-01T00:00:05.000Z' },
          { provider: 'rest' }
        )
      ).resolves.toMatchObject({ status });
      expect(updateFromExecutor).toHaveBeenCalledWith(
        task.task_id,
        expect.objectContaining({ status, completed_at: '2026-01-01T00:00:05.000Z' })
      );
    }
  );

  it.each([TaskStatus.STOPPED, TaskStatus.TIMED_OUT])(
    'preserves wait workload executor %s patches',
    async (status) => {
      const task = makeTask('{"schemaVersion":1,"profile":"wait","durationMs":1000}');
      const { service, updateFromExecutor } = makePatchHarness(task, 'workload');

      await expect(
        service.patch(
          task.task_id,
          { status, completed_at: '2026-01-01T00:00:05.000Z' },
          { provider: 'rest' }
        )
      ).resolves.toMatchObject({ status });
      expect(updateFromExecutor).toHaveBeenCalledWith(
        task.task_id,
        expect.objectContaining({ status, completed_at: '2026-01-01T00:00:05.000Z' })
      );
      expect(SessionRepository.prototype.findById).not.toHaveBeenCalled();
    }
  );

  it('preserves explicit failure details', async () => {
    const service = Object.create(TasksService.prototype) as TasksService;
    service.patch = vi.fn().mockResolvedValue({ task_id: 'task-1', status: TaskStatus.FAILED });

    await service.fail('task-1', { error: 'launch rejected' });

    expect(service.patch).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: TaskStatus.FAILED, error_message: 'launch rejected' }),
      undefined
    );
  });

  it('uses the durable failed workload status for completion side effects', async () => {
    const task = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      session_id: '018f0000-0000-7000-8000-000000000002',
      created_by: '018f0000-0000-7000-8000-000000000003',
      full_prompt: '{"schemaVersion":1,"profile":"controlled-failure"}',
      status: TaskStatus.FAILED,
    } as Task;
    const completeWorkload = vi.fn().mockResolvedValue({
      outcome: 'transitioned',
      task,
      message: {} as Message,
    });
    const processCompletionSideEffects = vi.fn().mockResolvedValue(true);
    const trackTaskCompleted = vi.fn();
    const emit = vi.fn();
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', { completeWorkload });
    Reflect.set(service, 'app', { service: () => ({ emit }) });
    Reflect.set(service, 'retireTaskExecutorCredentials', vi.fn());
    Reflect.set(service, 'processCompletionSideEffects', processCompletionSideEffects);
    Reflect.set(service, 'trackTaskCompleted', trackTaskCompleted);

    await service.completeWorkload({
      task_id: task.task_id,
      result_message_id: '018f0000-0000-7000-8000-000000000004',
      profile: 'controlled-failure',
      requested_delay_ms: 0,
    });

    expect(trackTaskCompleted).toHaveBeenCalledWith(task);
    expect(processCompletionSideEffects).toHaveBeenCalledWith(
      task,
      TaskStatus.FAILED,
      expect.objectContaining({ provider: undefined }),
      true
    );
  });

  it('rejects non-canonical workspace inspection fields before repository mutation', async () => {
    const completeWorkload = vi.fn();
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', { completeWorkload });
    const invalid = {
      task_id: '018f0000-0000-7000-8000-000000000001',
      result_message_id: '018f0000-0000-7000-8000-000000000004',
      profile: 'workspace-inspection',
      inspection: {
        node: { state: 'available', version: '22.18.0' },
        npm: { state: 'unavailable' },
        pnpm: { state: 'unavailable' },
        packageJson: { state: 'absent' },
        packageManager: { state: 'unavailable' },
        lockfiles: [],
        repositoryMarkerPresent: false,
        cwd: '/private/workspace',
      },
    } as unknown as WorkloadCompletionInput;

    await expect(service.completeWorkload(invalid)).rejects.toThrow('WORKLOAD_COMPLETION_INVALID');
    expect(completeWorkload).not.toHaveBeenCalled();
  });
});

describe('TasksService runtime telemetry', () => {
  const branchId = '018f0000-0000-7000-8000-000000000004';
  const task = {
    task_id: '018f0000-0000-7000-8000-000000000001',
    session_id: '018f0000-0000-7000-8000-000000000002',
    created_by: '018f0000-0000-7000-8000-000000000003',
    full_prompt: 'test',
    status: TaskStatus.RUNNING,
    message_range: { start_index: 0, end_index: 0, start_timestamp: '2026-01-01' },
    git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
    tool_use_count: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    executor_connected_at: '2026-01-01T00:00:01.000Z',
    last_executor_heartbeat_at: '2026-01-01T00:00:02.000Z',
  } as Task;

  function runtimeParams(tenantId = 'tenant-a') {
    return {
      provider: 'rest',
      tenant: { tenant_id: tenantId, source: 'auth_claim' },
      authentication: {
        strategy: 'jwt',
        accessToken: 'verified-runtime-bearer',
        payload: {
          type: 'executor-session',
          purpose: 'executor-task',
          sub: task.created_by,
          tenant_id: tenantId,
          session_id: task.session_id,
          task_id: task.task_id,
          branch_id: branchId,
        },
      },
    } as never;
  }

  function setRuntimeDependencies(service: TasksService) {
    Reflect.set(service, 'db', { run() {} });
    Reflect.set(service, 'runtimeAuthorityOptions', {
      branchRbacEnabled: true,
    });
    Reflect.set(service, 'executorCredentialRevoker', {
      isTaskTokenAuthorityCurrent: vi.fn().mockResolvedValue(true),
    });
  }

  it('validates, persists, and publishes one bounded pulse fact', async () => {
    const service = Object.create(TasksService.prototype) as TasksService;
    const emit = vi.fn();
    const reportRuntimeTelemetry = vi.fn().mockResolvedValue({ outcome: 'continued', task });
    const heartbeatCallback = vi.fn().mockResolvedValue(undefined);
    Reflect.set(service, 'taskRepo', { reportRuntimeTelemetry });
    Reflect.set(service, 'handleExecutorHeartbeat', heartbeatCallback);
    Reflect.set(service, 'heartbeatCallbackRunner', { isConfigured: () => false });
    Reflect.set(service, 'app', { service: () => ({ emit }) });
    setRuntimeDependencies(service);

    const result = await service.reportRuntimeTelemetry(
      {
        task_id: task.task_id,
        pulse: { sequence: 1, kind: 'progress', detail: 'tool.start' },
      },
      runtimeParams()
    );

    expect(result).toBe(task);
    expect(reportRuntimeTelemetry).toHaveBeenCalledWith(
      task.task_id,
      expect.objectContaining({
        principal_user_id: task.created_by,
        session_id: task.session_id,
        branch_id: branchId,
        standalone_token_current: true,
      }),
      { sequence: 1, kind: 'progress', detail: 'tool.start' }
    );
    expect(emit).toHaveBeenCalledWith('patched', task, expect.objectContaining({ path: 'tasks' }));
  });

  it.each([
    { sequence: 0, kind: 'progress' },
    { sequence: 1, kind: 'progress', detail: 'raw prompt content!' },
    { sequence: 1, kind: 'progress', detail: 'x'.repeat(129) },
  ] as const)('rejects malformed pulse %#', async (pulse) => {
    const service = Object.create(TasksService.prototype) as TasksService;
    Reflect.set(service, 'taskRepo', { reportRuntimeTelemetry: vi.fn() });
    await expect(
      service.reportRuntimeTelemetry({ task_id: task.task_id, pulse })
    ).rejects.toThrow();
  });

  it.each([
    { tenantId: 'tenant-a', expectedBranchId: 'branch-a' },
    { tenantId: 'tenant-b', expectedBranchId: undefined },
  ])(
    'enriches deferred heartbeat callbacks only inside the originating tenant ($tenantId)',
    async ({ tenantId, expectedBranchId }) => {
      const service = Object.create(TasksService.prototype) as TasksService;
      const callbackRun = vi.fn();
      const findHeartbeatBranchId = vi.fn(async () => {
        if (getCurrentTenantId() !== 'tenant-a') throw new Error('session not found');
        return 'branch-a';
      });
      const emit = vi.fn();
      Reflect.set(service, 'taskRepo', {
        reportRuntimeTelemetry: vi.fn().mockResolvedValue({ outcome: 'continued', task }),
      });
      Reflect.set(service, 'heartbeatCallbackRunner', {
        isConfigured: () => true,
        run: callbackRun,
      });
      Reflect.set(service, 'findHeartbeatBranchId', findHeartbeatBranchId);
      Reflect.set(service, 'app', { service: () => ({ emit }) });
      setRuntimeDependencies(service);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await service.reportRuntimeTelemetry({ task_id: task.task_id }, runtimeParams(tenantId));
      await vi.waitFor(() => expect(callbackRun).toHaveBeenCalledOnce());

      expect(findHeartbeatBranchId).toHaveBeenCalledWith(task.session_id);
      expect(callbackRun).toHaveBeenCalledWith({
        event: 'executor_heartbeat',
        task_id: task.task_id,
        session_id: task.session_id,
        last_executor_heartbeat_at: task.last_executor_heartbeat_at,
        ...(expectedBranchId ? { branch_id: expectedBranchId } : {}),
      });
      if (!expectedBranchId) {
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Could not resolve branch_id'),
          'session not found'
        );
      }
    }
  );
});
