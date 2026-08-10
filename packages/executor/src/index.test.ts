import { type SdkHealthFailureInput, TaskStatus } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  createClient: vi.fn(),
  execute: vi.fn().mockResolvedValue(undefined),
  initialize: vi.fn().mockResolvedValue(undefined),
  recordPulse: vi.fn(),
  flushProgressThrough: vi.fn(),
  stopHeartbeat: vi.fn(),
}));
vi.mock('./services/feathers-client.js', () => ({
  createFeathersClient: runtime.createClient,
  reportSdkHealthFailureWithAckTimeout: (
    client: { service: (path: string) => { reportSdkHealthFailure: (input: unknown) => unknown } },
    input: unknown
  ) => client.service('tasks').reportSdkHealthFailure(input),
}));
vi.mock('./executor-heartbeat.js', () => ({
  startExecutorHeartbeat: () => ({
    recordPulse: runtime.recordPulse,
    flushProgressThrough: runtime.flushProgressThrough,
    stop: runtime.stopHeartbeat,
  }),
}));
vi.mock('./handlers/sdk/tool-registry.js', () => ({
  initializeToolRegistry: runtime.initialize,
  ToolRegistry: { execute: runtime.execute },
}));

import { AgorExecutor } from './index.js';
import { globalPermissionManager } from './permissions/permission-manager.js';
import { SdkWatchdog } from './sdk-watchdog.js';
import { RuntimeCleanupError } from './terminal-task.js';

type WatchdogEvidence = Omit<SdkHealthFailureInput, 'task_id'>;

const evidence = {
  reason: 'no_first_progress' as const,
  elapsed_ms: 1_000,
  watchdog_action: 'enforced' as const,
  pulse_sequence_at_detection: 1,
} satisfies WatchdogEvidence;

function harness(reportSdkHealthFailure: (input: SdkHealthFailureInput) => Promise<unknown>) {
  const executor = new AgorExecutor({
    sessionToken: 'token',
    sessionId: 'session-1',
    taskId: 'task-1',
    prompt: 'prompt',
    tool: 'codex',
    daemonUrl: 'http://daemon',
    resolvedConfig: {
      execution: {
        sdk_watchdog: {
          mode: 'enforce',
          first_progress_timeout_ms: 1_000,
          operation_absolute_timeout_ms: 10_000,
          abort_grace_ms: 100,
          claude_idle_timeout_ms: null,
          codex_idle_timeout_ms: null,
        },
      },
    },
  }) as unknown as {
    client: { service: () => { reportSdkHealthFailure: typeof reportSdkHealthFailure } };
    heartbeat: {
      stop: ReturnType<typeof vi.fn>;
      flushProgressThrough: ReturnType<typeof vi.fn>;
    } | null;
    abortController: AbortController;
    latestPulseSequence?: number;
    latestProgressSequence?: number;
    handleWatchdogDecision(input: WatchdogEvidence): Promise<'authorized' | 'superseded' | 'retry'>;
  };
  executor.client = { service: () => ({ reportSdkHealthFailure }) };
  executor.heartbeat = {
    stop: vi.fn(),
    flushProgressThrough: runtime.flushProgressThrough.mockResolvedValue(undefined),
  };
  executor.latestPulseSequence = 1;
  return executor;
}

describe('AgorExecutor watchdog handoff', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('starts SDK observation before invoking the tool', async () => {
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'opencode',
      daemonUrl: 'http://daemon',
      resolvedConfig: {
        execution: {
          sdk_watchdog: {
            mode: 'observe',
            first_progress_timeout_ms: 60_000,
            operation_absolute_timeout_ms: 600_000,
            abort_grace_ms: 100,
            claude_idle_timeout_ms: null,
            codex_idle_timeout_ms: null,
          },
        },
      },
    }) as unknown as {
      client: object;
      executeTask(): Promise<void>;
    };
    executor.client = {};

    await executor.executeTask();

    expect(runtime.recordPulse).toHaveBeenCalledWith('sdk_started', 'opencode');
    expect(runtime.recordPulse.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.execute.mock.invocationCallOrder[0]!
    );
  });

  it('preserves the STOPPING settlement response after adapter cleanup', async () => {
    const tasks = {
      reportExecutorSettlement: vi.fn().mockResolvedValue({
        task_id: 'task-1',
        status: 'stopping',
        termination_request: {
          cause: 'runtime_settlement',
          requested_at: '2026-07-23T12:00:00.000Z',
        },
      }),
    };
    let settleAdapter!: (value: { result: 'success'; taskPatch: { model: string } }) => void;
    runtime.execute.mockReturnValueOnce(
      new Promise((resolve) => {
        settleAdapter = resolve;
      })
    );
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'codex',
      daemonUrl: 'http://daemon',
    }) as unknown as {
      client: { service: () => typeof tasks };
      abortController: AbortController;
      executeTask(): Promise<void>;
    };
    executor.client = { service: () => tasks };

    const execution = executor.executeTask();
    await vi.waitFor(() => expect(runtime.execute).toHaveBeenCalledOnce());
    expect(tasks.reportExecutorSettlement).not.toHaveBeenCalled();

    settleAdapter({
      result: 'success',
      taskPatch: { model: 'openai/test-model' },
    });
    await execution;

    expect(runtime.stopHeartbeat).toHaveBeenCalledOnce();
    expect(executor.abortController.signal.aborted).toBe(true);
    expect(tasks.reportExecutorSettlement).toHaveBeenCalledWith({
      task_id: 'task-1',
      kind: 'quiesced',
      result: 'success',
      task_patch: { model: 'openai/test-model' },
    });
    expect(runtime.execute.mock.invocationCallOrder[0]).toBeLessThan(
      tasks.reportExecutorSettlement.mock.invocationCallOrder[0]!
    );
    expect(tasks.reportExecutorSettlement.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.stopHeartbeat.mock.invocationCallOrder[0]!
    );
  });

  it('exits after normal quiesced settlement without reporting termination twice', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const reportTerminationComplete = vi
      .fn()
      .mockRejectedValue(new Error('normal settlement must not wait for coordinator containment'));
    const stoppingTask = {
      task_id: 'task-1',
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'runtime_settlement',
        requested_at: '2026-07-23T12:00:00.000Z',
      },
    };
    const tasks = {
      connectExecutor: vi.fn().mockResolvedValue({
        task_id: 'task-1',
        status: TaskStatus.RUNNING,
      }),
      reportExecutorSettlement: vi.fn().mockResolvedValue(stoppingTask),
      reportTerminationComplete,
      on: vi.fn(),
    };
    runtime.createClient.mockResolvedValueOnce({
      service: (path: string) => (path === 'tasks' ? tasks : { on: vi.fn() }),
    });
    runtime.execute.mockResolvedValueOnce({ result: 'success' });
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'codex',
      daemonUrl: 'http://daemon',
    }) as unknown as {
      start(): Promise<void>;
      setupShutdownHandlers(): void;
    };
    executor.setupShutdownHandlers = vi.fn();

    await executor.start();

    expect(tasks.reportExecutorSettlement).toHaveBeenCalledOnce();
    expect(reportTerminationComplete).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('reports containment instead of quiescence when provider cleanup fails after SDK start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stoppingTask = {
      task_id: 'task-1',
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-07-23T12:00:00.000Z',
      },
    };
    const reportTerminationComplete = vi.fn().mockResolvedValue(stoppingTask);
    const reportExecutorSettlement = vi.fn().mockResolvedValue(stoppingTask);
    const tasks = {
      connectExecutor: vi.fn().mockResolvedValue({
        task_id: 'task-1',
        status: TaskStatus.RUNNING,
      }),
      get: vi.fn().mockResolvedValue(stoppingTask),
      reportTerminationComplete,
      reportExecutorSettlement,
      on: vi.fn(),
    };
    runtime.createClient.mockResolvedValueOnce({
      service: (path: string) => (path === 'tasks' ? tasks : { on: vi.fn() }),
    });
    runtime.execute.mockRejectedValueOnce(
      new RuntimeCleanupError('OpenCode', new Error('provider abort failed'), true)
    );
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'opencode',
      daemonUrl: 'http://daemon',
    }) as unknown as { start(): Promise<void>; setupShutdownHandlers(): void };
    executor.setupShutdownHandlers = vi.fn();

    await executor.start();

    expect(reportTerminationComplete).not.toHaveBeenCalled();
    expect(reportExecutorSettlement).toHaveBeenCalledWith({
      task_id: 'task-1',
      kind: 'containment_required',
      error_message: expect.stringContaining('OpenCode runtime cleanup failed'),
      runtime_cleanup_unverified: true,
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('reports quiescence only when termination wins before SDK work starts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stoppingTask = {
      task_id: 'task-1',
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-07-23T12:00:00.000Z',
      },
    };
    const reportTerminationComplete = vi.fn().mockResolvedValue(stoppingTask);
    const tasks = {
      connectExecutor: vi.fn().mockRejectedValue(new Error('cannot connect from stopping')),
      get: vi.fn().mockResolvedValue(stoppingTask),
      reportTerminationComplete,
      on: vi.fn(),
    };
    runtime.createClient.mockResolvedValueOnce({
      service: (path: string) => (path === 'tasks' ? tasks : { on: vi.fn() }),
    });
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'codex',
      daemonUrl: 'http://daemon',
    }) as unknown as { start(): Promise<void>; setupShutdownHandlers(): void };
    executor.setupShutdownHandlers = vi.fn();

    await executor.start();

    expect(runtime.execute).not.toHaveBeenCalled();
    expect(reportTerminationComplete).toHaveBeenCalledWith({
      task_id: 'task-1',
      requested_at: stoppingTask.termination_request.requested_at,
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('keeps runtime ownership when the daemon does not authorize containment', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const executor = harness(() => Promise.reject(new Error('offline')));
    const heartbeat = executor.heartbeat;

    await executor.handleWatchdogDecision(evidence);

    expect(heartbeat?.stop).not.toHaveBeenCalled();
    expect(executor.heartbeat).toBe(heartbeat);
    expect(executor.abortController.signal.aborted).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('invalidates enforced evidence when its progress flush acknowledges newer work', async () => {
    const reportSdkHealthFailure = vi.fn().mockResolvedValue({
      task_id: 'task-1',
      status: TaskStatus.STOPPING,
    });
    const executor = harness(reportSdkHealthFailure);
    runtime.flushProgressThrough.mockResolvedValueOnce(2);

    await expect(executor.handleWatchdogDecision(evidence)).resolves.toBe('superseded');

    expect(runtime.flushProgressThrough).toHaveBeenCalledWith(1);
    expect(reportSdkHealthFailure).not.toHaveBeenCalled();
    expect(executor.abortController.signal.aborted).toBe(false);
  });

  it('keeps an absolute turn failure live across newer progress before and after acknowledgement', async () => {
    let resolveFirst!: (task: unknown) => void;
    const reportSdkHealthFailure = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue({ task_id: 'task-1', status: TaskStatus.STOPPING });
    const executor = harness(reportSdkHealthFailure);
    runtime.flushProgressThrough.mockResolvedValue(3);
    const absoluteEvidence = { ...evidence, reason: 'turn_timed_out' as const };

    const first = executor.handleWatchdogDecision(absoluteEvidence);
    await vi.waitFor(() => expect(reportSdkHealthFailure).toHaveBeenCalledOnce());
    executor.latestProgressSequence = 3;
    resolveFirst({
      task_id: 'task-1',
      status: TaskStatus.RUNNING,
      latest_executor_progress: { sequence: 3, kind: 'progress' },
    });

    await expect(first).resolves.toBe('retry');
    await expect(executor.handleWatchdogDecision(absoluteEvidence)).resolves.toBe('authorized');
    expect(runtime.flushProgressThrough).not.toHaveBeenCalled();
    expect(reportSdkHealthFailure).toHaveBeenCalledTimes(2);
    expect(reportSdkHealthFailure.mock.calls).toEqual([
      [expect.objectContaining({ reason: 'turn_timed_out' })],
      [expect.objectContaining({ reason: 'turn_timed_out' })],
    ]);
  });

  it('serializes health authorization attempts without parallel reports', async () => {
    let resolveFirst!: (task: unknown) => void;
    const reportSdkHealthFailure = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue({ task_id: 'task-1', status: TaskStatus.RUNNING });
    const executor = harness(reportSdkHealthFailure);

    const firstDecision = executor.handleWatchdogDecision(evidence);
    const secondDecision = executor.handleWatchdogDecision(evidence);
    await vi.waitFor(() => expect(reportSdkHealthFailure).toHaveBeenCalledOnce());
    resolveFirst({ task_id: 'task-1', status: TaskStatus.RUNNING });
    await expect(firstDecision).resolves.toBe('retry');
    await expect(secondDecision).resolves.toBe('retry');
    expect(reportSdkHealthFailure).toHaveBeenCalledTimes(2);
  });

  it('sends enforced evidence after an in-flight diagnostic report settles', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(task: unknown) => void> = [];
    const reportSdkHealthFailure = vi.fn(
      (_input: SdkHealthFailureInput) =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        })
    );
    const executor = harness(reportSdkHealthFailure);

    const diagnostic = executor.handleWatchdogDecision({
      ...evidence,
      reason: 'unknown_activity',
      watchdog_action: 'would_fire',
    });
    await Promise.resolve();
    expect(reportSdkHealthFailure).toHaveBeenCalledOnce();

    const enforced = executor.handleWatchdogDecision({
      ...evidence,
      reason: 'adapter_incompatible',
    });
    await Promise.resolve();
    expect(reportSdkHealthFailure).toHaveBeenCalledOnce();

    resolvers[0]?.({ task_id: 'task-1', status: TaskStatus.RUNNING });
    await expect(diagnostic).resolves.toBe('retry');
    await Promise.resolve();
    expect(reportSdkHealthFailure).toHaveBeenCalledTimes(2);
    expect(reportSdkHealthFailure.mock.calls[1]?.[0]).toMatchObject({
      reason: 'adapter_incompatible',
      watchdog_action: 'enforced',
    });

    resolvers[1]?.({
      task_id: 'task-1',
      status: TaskStatus.STOPPING,
      termination_request: {
        cause: 'sdk_health_failure',
        requested_at: '2026-01-01T00:00:02.000Z',
      },
    });
    await expect(enforced).resolves.toBe('authorized');

    expect(executor.abortController.signal.aborted).toBe(true);
  });

  it('drops enforced evidence when newer progress arrives behind a delayed diagnostic', async () => {
    vi.useFakeTimers();
    let resolveDiagnostic!: (task: unknown) => void;
    const reportSdkHealthFailure = vi.fn(
      (_input: SdkHealthFailureInput) =>
        new Promise((resolve) => {
          resolveDiagnostic = resolve;
        })
    );
    const executor = harness(reportSdkHealthFailure);
    let acknowledgedProgress = 1;
    runtime.flushProgressThrough.mockImplementation(async () => acknowledgedProgress);

    const diagnostic = executor.handleWatchdogDecision({
      ...evidence,
      reason: 'unknown_activity',
      watchdog_action: 'would_fire',
    });
    await Promise.resolve();
    expect(reportSdkHealthFailure).toHaveBeenCalledOnce();

    const enforced = executor.handleWatchdogDecision({
      ...evidence,
      reason: 'progress_stalled',
    });
    await Promise.resolve();
    acknowledgedProgress = 2;
    executor.latestProgressSequence = 2;
    resolveDiagnostic({ task_id: 'task-1', status: TaskStatus.RUNNING });

    await expect(diagnostic).resolves.toBe('retry');
    await expect(enforced).resolves.toBe('superseded');
    expect(runtime.flushProgressThrough).toHaveBeenCalledWith(1);
    expect(reportSdkHealthFailure).toHaveBeenCalledOnce();
    expect(executor.abortController.signal.aborted).toBe(false);
  });

  it('preserves progress observed during a delayed rejected report and rearms supervision', async () => {
    let resolveFirst!: (task: unknown) => void;
    const reportSdkHealthFailure = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue({ task_id: 'task-1', status: TaskStatus.RUNNING });
    const executor = harness(reportSdkHealthFailure) as ReturnType<typeof harness> & {
      watchdog: SdkWatchdog;
    };
    let now = 0;
    const watchdog = new SdkWatchdog({
      tool: 'codex',
      config: {
        mode: 'enforce',
        first_progress_timeout_ms: 10,
        operation_absolute_timeout_ms: 1_000,
        abort_grace_ms: 100,
        claude_idle_timeout_ms: null,
        codex_idle_timeout_ms: 10,
      },
      now: () => now,
      pulseSequenceAtDetection: () => executor.latestPulseSequence,
      onDecision: (decision) => executor.handleWatchdogDecision(decision as typeof evidence),
    });
    executor.watchdog = watchdog;

    watchdog.record({ type: 'sdk_started' });
    now = 11;
    watchdog.record({ type: 'sdk_started' });
    await vi.waitFor(() => expect(reportSdkHealthFailure).toHaveBeenCalledTimes(1));
    expect(reportSdkHealthFailure.mock.calls[0]?.[0]).toMatchObject({
      reason: 'no_first_progress',
      pulse_sequence_at_detection: 1,
    });

    now = 12;
    watchdog.record({ type: 'progress', detail: 'newer-progress' });
    executor.latestPulseSequence = 3;
    resolveFirst({
      task_id: 'task-1',
      status: TaskStatus.RUNNING,
      latest_executor_progress: { sequence: 3, kind: 'progress' },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(executor.abortController.signal.aborted).toBe(false);
    expect(executor.heartbeat?.stop).not.toHaveBeenCalled();

    now = 23;
    watchdog.record({ type: 'sdk_started' });
    await vi.waitFor(() => expect(reportSdkHealthFailure).toHaveBeenCalledTimes(2));
    expect(reportSdkHealthFailure.mock.calls[1]?.[0]).toMatchObject({
      reason: 'progress_stalled',
      pulse_sequence_at_detection: 3,
    });
    watchdog.stop();
  });

  it('aborts immediately on the durable stopping patch and reports quiescence', async () => {
    const reportTerminationComplete = vi.fn().mockResolvedValue({});
    const heartbeatStop = vi.fn();
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'codex',
      daemonUrl: 'http://daemon',
    }) as unknown as {
      client: {
        service: () => { reportTerminationComplete: typeof reportTerminationComplete };
      };
      heartbeat: { stop: typeof heartbeatStop } | null;
      abortController: AbortController;
      handleTaskLifecycleUpdate(task: unknown): void;
      reportTerminationComplete(): Promise<void>;
    };
    executor.client = { service: () => ({ reportTerminationComplete }) };
    executor.heartbeat = { stop: heartbeatStop };

    executor.handleTaskLifecycleUpdate({
      task_id: 'task-1',
      status: 'stopping',
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-07-23T12:00:00.000Z',
      },
    });

    expect(executor.abortController.signal.aborted).toBe(true);
    expect(heartbeatStop).toHaveBeenCalledOnce();
    await executor.reportTerminationComplete();
    expect(reportTerminationComplete).toHaveBeenCalledWith({
      task_id: 'task-1',
      requested_at: '2026-07-23T12:00:00.000Z',
    });
  });

  it('relinquishes runtime ownership when the daemon already settled the Task', () => {
    const heartbeatStop = vi.fn();
    const watchdogStop = vi.fn();
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'codex',
      daemonUrl: 'http://daemon',
    }) as unknown as {
      heartbeat: { stop: typeof heartbeatStop } | null;
      watchdog: { stop: typeof watchdogStop } | null;
      abortController: AbortController;
      handleTaskLifecycleUpdate(task: unknown): void;
    };
    executor.heartbeat = { stop: heartbeatStop };
    executor.watchdog = { stop: watchdogStop };

    executor.handleTaskLifecycleUpdate({ task_id: 'task-1', status: 'failed' });

    expect(executor.abortController.signal.aborted).toBe(true);
    expect(heartbeatStop).toHaveBeenCalledOnce();
    expect(watchdogStop).toHaveBeenCalledOnce();
    expect(executor.heartbeat).toBeNull();
    expect(executor.watchdog).toBeNull();
  });

  it('handles the private task-scoped termination socket event', () => {
    const listeners = new Map<string, (data: unknown) => void>();
    const heartbeatStop = vi.fn();
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'codex',
      daemonUrl: 'http://daemon',
    }) as unknown as {
      client: {
        service(path: string): {
          on(event: string, listener: (data: unknown) => void): void;
        };
      };
      heartbeat: { stop: typeof heartbeatStop } | null;
      abortController: AbortController;
      setupEventListeners(): void;
    };
    executor.client = {
      service(path) {
        return {
          on(event, listener) {
            listeners.set(`${path}:${event}`, listener);
          },
        };
      },
    };
    executor.heartbeat = { stop: heartbeatStop };
    executor.setupEventListeners();

    listeners.get('tasks:termination_requested')?.({
      task_id: 'task-1',
      status: 'stopping',
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-07-23T12:00:00.000Z',
      },
    });
    listeners.get('tasks:termination_requested')?.({
      task_id: 'task-1',
      status: 'stopping',
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-07-23T12:00:00.000Z',
      },
    });

    expect(executor.abortController.signal.aborted).toBe(true);
    expect(heartbeatStop).toHaveBeenCalledOnce();
  });

  it('forwards only this Task permission decision to the live permission waiter', () => {
    const listeners = new Map<string, (data: unknown) => void>();
    const resolvePermission = vi
      .spyOn(globalPermissionManager, 'resolvePermission')
      .mockImplementation(() => undefined);
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'claude-code',
      daemonUrl: 'http://daemon',
    }) as unknown as {
      client: {
        service(path: string): {
          on(event: string, listener: (data: unknown) => void): void;
        };
      };
      heartbeat: { recordPulse: typeof runtime.recordPulse } | null;
      setupEventListeners(): void;
    };
    executor.client = {
      service(path) {
        return {
          on(event, listener) {
            listeners.set(`${path}:${event}`, listener);
          },
        };
      },
    };
    executor.heartbeat = { recordPulse: runtime.recordPulse };
    executor.setupEventListeners();

    listeners.get('messages:permission_resolved')?.({
      requestId: 'request-other',
      taskId: 'task-other',
      sessionId: 'session-1',
      allow: true,
      remember: false,
      scope: 'once',
      decidedBy: 'user-a',
    });
    listeners.get('messages:permission_resolved')?.({
      requestId: 'request-wrong-session',
      taskId: 'task-1',
      sessionId: 'session-other',
      allow: true,
      remember: false,
      scope: 'once',
      decidedBy: 'user-a',
    });
    listeners.get('messages:permission_resolved')?.({
      requestId: 'request-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      allow: true,
      reason: 'Approved by user',
      remember: false,
      scope: 'once',
      decidedBy: 'user-a',
    });

    expect(resolvePermission).toHaveBeenCalledOnce();
    expect(resolvePermission).toHaveBeenCalledWith({
      requestId: 'request-1',
      taskId: 'task-1',
      allow: true,
      reason: 'Approved by user',
      remember: false,
      scope: 'once',
      decidedBy: 'user-a',
    });
    expect(runtime.recordPulse).toHaveBeenCalledWith('sdk_started', 'permission.resolved');
  });
});
