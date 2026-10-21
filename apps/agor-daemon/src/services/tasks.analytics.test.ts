import {
  createAnalyticsLogger,
  resetAnalyticsLoggerForTests,
  setAnalyticsLoggerForTests,
} from '@agor/core/analytics';
import { runWithTenantContext } from '@agor/core/db';
import { SessionStatus, type Task, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutorCleanupCommandResult } from '../utils/executor-cleanup-command.js';
import { TasksService } from './tasks';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: '018f0000-0000-7000-8000-000000000001',
    session_id: '018f0000-0000-7000-8000-000000000002',
    created_by: '018f0000-0000-7000-8000-000000000003',
    full_prompt: 'do not emit this prompt',
    status: TaskStatus.CREATED,
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: '2026-01-01T00:00:00.000Z',
    },
    git_state: {
      ref_at_start: 'main',
      sha_at_start: 'abc123',
    },
    model: 'test-model',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeService(repository: {
  create?: ReturnType<typeof vi.fn>;
  findById?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  settleTermination?: ReturnType<typeof vi.fn>;
}) {
  const sessionsService = {
    get: vi.fn().mockResolvedValue({
      session_id: '018f0000-0000-7000-8000-000000000002',
      tasks: ['018f0000-0000-7000-8000-000000000001'],
    }),
    patch: vi.fn().mockResolvedValue({}),
    emit: vi.fn(),
    triggerQueueProcessing: vi.fn().mockResolvedValue(undefined),
  };
  const service = Object.create(TasksService.prototype) as {
    repository: typeof repository;
    taskRepo: typeof repository;
    id: string;
    emit: ReturnType<typeof vi.fn>;
    app: { service: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  };
  service.repository = repository;
  service.taskRepo = repository;
  service.id = 'task_id';
  service.emit = vi.fn();
  service.app = { service: vi.fn(() => sessionsService), get: vi.fn() };
  return { service: service as unknown as TasksService, sessionsService, repository };
}

describe('TasksService analytics lifecycle events', () => {
  afterEach(() => {
    resetAnalyticsLoggerForTests();
  });

  it('emits a curated task.created event when a task is created', async () => {
    const track = vi.fn();
    setAnalyticsLoggerForTests({
      isEnabled: () => true,
      track,
    });

    const task = makeTask();
    const { service } = makeService({ create: vi.fn().mockResolvedValue(task) });

    await service.create({ session_id: task.session_id, full_prompt: task.full_prompt });

    expect(track).toHaveBeenCalledWith(
      'task.created',
      expect.objectContaining({
        task_id: task.task_id,
        session_id: task.session_id,
        status: TaskStatus.CREATED,
        model: 'test-model',
      }),
      { userId: task.created_by }
    );
    expect(track.mock.calls[0][1]).not.toHaveProperty('full_prompt');
    expect(track.mock.calls[0][1]).not.toHaveProperty('tool_use_count');
    expect(track.mock.calls[0][1]).toHaveProperty('recorded_tool_count', null);
  });

  it('emits task.started once when transitioning into running', async () => {
    const track = vi.fn();
    setAnalyticsLoggerForTests({ isEnabled: () => true, track });

    const currentTask = makeTask({ status: TaskStatus.CREATED });
    const runningTask = makeTask({
      status: TaskStatus.RUNNING,
      started_at: '2026-01-01T00:00:01.000Z',
    });
    const { service, repository } = makeService({
      findById: vi.fn().mockResolvedValueOnce(currentTask).mockResolvedValueOnce(currentTask),
      update: vi.fn().mockResolvedValue(runningTask),
    });

    await service.patch(currentTask.task_id, { status: TaskStatus.RUNNING });

    expect(track).toHaveBeenCalledWith(
      'task.started',
      expect.objectContaining({ task_id: currentTask.task_id, status: TaskStatus.RUNNING }),
      { userId: currentTask.created_by }
    );

    track.mockClear();
    repository.findById = vi
      .fn()
      .mockResolvedValueOnce(runningTask)
      .mockResolvedValueOnce(runningTask);
    await service.patch(currentTask.task_id, { status: TaskStatus.RUNNING });

    expect(track).not.toHaveBeenCalledWith('task.started', expect.anything(), expect.anything());
  });

  it('emits task.completed once when transitioning to a terminal status, including timed_out', async () => {
    const track = vi.fn();
    setAnalyticsLoggerForTests({ isEnabled: () => true, track });

    const runningTask = makeTask({
      status: TaskStatus.RUNNING,
      started_at: '2026-01-01T00:00:00.000Z',
    });
    const timedOutTask = makeTask({
      status: TaskStatus.TIMED_OUT,
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:05.000Z',
      duration_ms: 5000,
      recorded_tool_count: 2,
    });
    const { service, sessionsService, repository } = makeService({
      findById: vi.fn().mockResolvedValueOnce(runningTask).mockResolvedValueOnce(runningTask),
      update: vi.fn().mockResolvedValue(timedOutTask),
    });

    const projectedSession = {
      session_id: runningTask.session_id,
      tasks: [runningTask.task_id],
      status: SessionStatus.TIMED_OUT,
      ready_for_prompt: true,
    };
    sessionsService.get.mockResolvedValue(projectedSession);
    const params = { suppressTerminalQueueProcessing: false };
    await service.patch(runningTask.task_id, { status: TaskStatus.TIMED_OUT }, params);

    expect(sessionsService.emit).toHaveBeenCalledTimes(1);
    expect(sessionsService.emit).toHaveBeenCalledWith(
      'patched',
      projectedSession,
      expect.objectContaining({ path: 'sessions', id: runningTask.session_id, params })
    );
    expect(sessionsService.triggerQueueProcessing).toHaveBeenCalledTimes(1);
    expect(sessionsService.triggerQueueProcessing).toHaveBeenCalledWith(
      runningTask.session_id,
      params
    );
    expect(sessionsService.patch).not.toHaveBeenCalled();

    expect(track).toHaveBeenCalledWith(
      'task.completed',
      expect.objectContaining({
        task_id: runningTask.task_id,
        status: TaskStatus.TIMED_OUT,
        duration_ms: 5000,
        recorded_tool_count: 2,
      }),
      { userId: runningTask.created_by }
    );
    track.mockClear();
    repository.findById = vi
      .fn()
      .mockResolvedValueOnce(timedOutTask)
      .mockResolvedValueOnce(timedOutTask);
    await service.patch(runningTask.task_id, { status: TaskStatus.TIMED_OUT });

    expect(track).not.toHaveBeenCalledWith('task.completed', expect.anything(), expect.anything());
    expect(sessionsService.emit).toHaveBeenCalledTimes(1);
    expect(sessionsService.triggerQueueProcessing).toHaveBeenCalledTimes(1);
  });

  it.each([
    [TaskStatus.FAILED, 'unknown'],
    [TaskStatus.TIMED_OUT, 'timed_out'],
    [TaskStatus.COMPLETED, null],
    [TaskStatus.STOPPED, null],
  ] as const)(
    'classifies ordinary %s terminal patches without exporting error prose',
    async (status, reason) => {
      const track = vi.fn();
      setAnalyticsLoggerForTests({ isEnabled: () => true, track });
      const running = makeTask({ status: TaskStatus.RUNNING });
      const terminal = makeTask({ status, error_message: 'PRIVATE provider response and token' });
      const { service } = makeService({
        findById: vi.fn().mockResolvedValue(running),
        update: vi.fn().mockResolvedValue(terminal),
      });
      Reflect.set(service, 'processTerminalTaskTransition', vi.fn());
      await service.patch(running.task_id, { status });
      expect(track).toHaveBeenCalledExactlyOnceWith(
        'task.completed',
        expect.objectContaining({
          status,
          succeeded: status === TaskStatus.COMPLETED,
          failure_reason: reason,
        }),
        { userId: terminal.created_by }
      );
      expect(JSON.stringify(track.mock.calls)).not.toMatch(/PRIVATE|full_prompt/);
    }
  );
});

describe('TasksService structured cleanup completion analytics', () => {
  afterEach(() => {
    resetAnalyticsLoggerForTests();
    vi.restoreAllMocks();
  });

  const evidence: ExecutorCleanupCommandResult = {
    confirmed: true,
    cause: 'oom_killed',
    memoryLimitBytes: 1536 * 1024 ** 2,
    diagnostic: 'private helper diagnostic',
  };

  function settlementService(outcome = 'transitioned') {
    const settledTask = makeTask({
      status: TaskStatus.FAILED,
      error_message: 'oom_killed: private error prose',
      completed_at: '2026-01-01T00:00:05.000Z',
    });
    const repository = {
      settleTermination: vi.fn().mockResolvedValue({ outcome, task: settledTask }),
    };
    const { service } = makeService(repository);
    // This suite owns analytics, not callback dispatch or queue advancement.
    Reflect.set(service, 'processTerminalTaskTransition', vi.fn().mockResolvedValue(undefined));
    return { service, repository, settledTask };
  }

  it.each<{
    name: string;
    cleanupResult?: ExecutorCleanupCommandResult;
    fields: Record<string, unknown>;
  }>([
    {
      name: 'confirmed OOM (extra helper details are not exported)',
      cleanupResult: evidence,
      fields: { failure_reason: 'oom_killed' },
    },
    {
      name: 'non-OOM despite diagnostic prose and a limit',
      cleanupResult: { confirmed: true, diagnostic: 'oom_killed', memoryLimitBytes: 1024 },
      fields: {},
    },
    { name: 'no helper evidence despite OOM error prose', fields: {} },
    {
      name: 'unconfirmed helper evidence',
      cleanupResult: { ...evidence, confirmed: false },
      fields: {},
    },
  ])('emits only allowlisted fields: $name', async ({ cleanupResult, fields }) => {
    const track = vi.fn();
    setAnalyticsLoggerForTests({ isEnabled: () => true, track });
    const { service, repository, settledTask } = settlementService();
    const input = {
      taskId: settledTask.task_id,
      outcome: 'verified_absent' as const,
      coordinationToken: 'private-coordination-token',
    };
    await service.settleTermination({ ...input, cleanupResult });

    expect(repository.settleTermination).toHaveBeenCalledExactlyOnceWith(input);
    expect(track).toHaveBeenCalledExactlyOnceWith(
      'task.completed',
      {
        task_id: settledTask.task_id,
        session_id: settledTask.session_id,
        status: TaskStatus.FAILED,
        model: 'test-model',
        queue_position: null,
        recorded_tool_count: null,
        is_callback: false,
        source: null,
        completed_at: settledTask.completed_at,
        duration_ms: null,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        cost_usd: null,
        context_window_limit: null,
        context_window_percentage: null,
        has_error: true,
        failure_reason: 'unknown',
        succeeded: false,
        ...fields,
      },
      { userId: settledTask.created_by }
    );
    expect(JSON.stringify(track.mock.calls)).not.toMatch(
      /private|full_prompt|diagnostic|cleanupResult/
    );

    // Evidence is per-call, never cached on the service or recovered from prose.
    track.mockClear();
    await service.settleTermination(input);
    expect(track.mock.calls[0][1]).toHaveProperty('failure_reason', 'unknown');
    expect(track.mock.calls[0][1]).not.toHaveProperty('memory_limit_bytes');
  });

  it.each(['unverified', 'condition_changed', 'terminal'])(
    'does not emit a completion for a %s settlement result',
    async (outcome) => {
      const track = vi.fn();
      setAnalyticsLoggerForTests({ isEnabled: () => true, track });
      const { service, settledTask } = settlementService(outcome);
      await service.settleTermination({
        taskId: settledTask.task_id,
        outcome: 'verified_absent',
        coordinationToken: 'private-token',
        cleanupResult: evidence,
      });
      expect(track).not.toHaveBeenCalledWith(
        'task.completed',
        expect.anything(),
        expect.anything()
      );
      if (outcome === 'unverified') {
        expect(track).toHaveBeenCalledExactlyOnceWith(
          'task.termination_unverified',
          expect.objectContaining({ succeeded: false, failure_reason: 'termination_unverified' }),
          { userId: settledTask.created_by }
        );
        expect(track.mock.calls[0][1]).not.toHaveProperty('memory_limit_bytes');
      } else {
        expect(track).not.toHaveBeenCalled();
      }
    }
  );

  it('does not attach OOM evidence to a forced-unverified completion', async () => {
    const track = vi.fn();
    setAnalyticsLoggerForTests({ isEnabled: () => true, track });
    const { service, settledTask } = settlementService();
    await service.settleTermination({
      taskId: settledTask.task_id,
      outcome: 'forced_unverified',
      expectedTerminationRequestedAt: '2026-01-01T00:00:00.000Z',
      cleanupResult: evidence,
    });
    expect(track).toHaveBeenCalledOnce();
    expect(track.mock.calls[0][1]).toHaveProperty('failure_reason', 'unknown');
    expect(track.mock.calls[0][1]).not.toHaveProperty('memory_limit_bytes');
  });

  it.each([
    { enabled: true, exclude_events: [], delivered: true },
    { enabled: false, exclude_events: [], delivered: false },
    { enabled: true, exclude_events: ['task.*'], delivered: false },
  ])('preserves operator wire format and controls: %j', async (config) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setAnalyticsLoggerForTests(
      await createAnalyticsLogger({
        enabled: config.enabled,
        filters: { exclude_events: config.exclude_events },
        plugins: [{ type: 'stdout', enabled: true }],
      })
    );
    const { service, settledTask } = settlementService();
    await runWithTenantContext('tenant-a', () =>
      service.settleTermination({
        taskId: settledTask.task_id,
        outcome: 'verified_absent',
        coordinationToken: 'private-token',
        cleanupResult: evidence,
      })
    );
    const events = () =>
      log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line));
    if (!config.delivered) {
      expect(events()).toEqual([]);
      return;
    }
    await vi.waitFor(() => expect(events()).toHaveLength(1));
    expect(events()[0]).toMatchObject({
      type: 'track',
      event: 'agor_event',
      userId: settledTask.created_by,
      context: { tenant_id: 'tenant-a' },
      properties: {
        event_type: 'task.completed',
        failure_reason: 'oom_killed',
        succeeded: false,
      },
    });
    expect(JSON.stringify(events())).not.toMatch(/private|full_prompt|diagnostic|cleanupResult/);
  });
});
