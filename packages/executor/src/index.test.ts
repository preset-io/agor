import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  execute: vi.fn().mockResolvedValue(undefined),
  initialize: vi.fn().mockResolvedValue(undefined),
  recordPulse: vi.fn(),
  stopHeartbeat: vi.fn(),
  startHeartbeat: vi.fn(),
  refreshMcp: vi.fn().mockResolvedValue({}),
  createExecutorClient: vi.fn(),
}));
vi.mock('./executor-heartbeat.js', () => ({
  startExecutorHeartbeat: (...args: unknown[]) => {
    runtime.startHeartbeat(...args);
    return { recordPulse: runtime.recordPulse, stop: runtime.stopHeartbeat };
  },
}));
vi.mock('./handlers/sdk/tool-registry.js', () => ({
  initializeToolRegistry: runtime.initialize,
  ToolRegistry: { execute: runtime.execute },
}));
vi.mock('./mcp-runtime-refresh.js', () => ({
  requestMCPRuntimeRefresh: runtime.refreshMcp,
}));
vi.mock('./services/feathers-client.js', () => ({
  createExecutorClient: runtime.createExecutorClient,
}));

import { AUTHORIZATION_REVOKED_TERMINATION_MESSAGE } from '@agor/core/types';
import { AgorExecutor } from './index.js';
import { globalPermissionManager } from './permissions/permission-manager.js';

const evidence = {
  reason: 'no_first_progress' as const,
  elapsed_ms: 1_000,
  watchdog_action: 'enforced' as const,
};

function harness(reportSdkHealthFailure: () => Promise<unknown>) {
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
          abort_grace_ms: 100,
          claude_idle_timeout_ms: null,
        },
      },
    },
  }) as unknown as {
    client: { service: () => { reportSdkHealthFailure: typeof reportSdkHealthFailure } };
    heartbeat: { stop: ReturnType<typeof vi.fn> } | null;
    abortController: AbortController;
    handleWatchdogDecision(input: typeof evidence): Promise<void>;
  };
  executor.client = { service: () => ({ reportSdkHealthFailure }) };
  executor.heartbeat = { stop: vi.fn() };
  return executor;
}

describe('AgorExecutor watchdog handoff', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    runtime.execute.mockResolvedValue(undefined);
    runtime.refreshMcp.mockResolvedValue({});
    runtime.createExecutorClient.mockReset();
  });

  it('keeps a recovered non-managed Stop exit successful', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    runtime.createExecutorClient.mockResolvedValue({
      service: () => ({
        on: vi.fn(),
        connectExecutor: vi.fn(async () => ({
          task_id: 'task-1',
          session_id: 'session-1',
          status: 'running',
        })),
      }),
    });
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'codex',
      daemonUrl: 'http://daemon',
    });
    const methods = executor as unknown as {
      setupShutdownHandlers: () => void;
      executeTask: () => Promise<void>;
      recoverTerminationAfterExecutionError: () => Promise<boolean>;
    };
    methods.setupShutdownHandlers = vi.fn();
    methods.executeTask = vi.fn(async () => {
      throw new Error('Stop raced the provider');
    });
    methods.recoverTerminationAfterExecutionError = vi.fn(async () => true);

    await executor.start();
    expect(methods.recoverTerminationAfterExecutionError).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it('admits one of two outer invocations before heartbeat/provider work', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let finishWinner!: () => void;
    runtime.execute.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWinner = resolve;
        })
    );
    const holderId = '00000000-0000-7000-8000-000000000005';
    const admission = {
      outcome: 'admitted',
      attempt: {
        task_id: 'task-1',
        holder_instance_id: holderId,
        write_state: 'open',
        retired_at: null,
        store_id: '00000000-0000-7000-8000-000000000006',
      },
      input: null,
    };
    const rejected = { outcome: 'rejected', code: 'already_admitted' };
    const makeClient = (begin: (holderInstanceId: string) => Promise<unknown>) => ({
      service(path: string) {
        if (path === 'tasks')
          return {
            connectExecutor: vi
              .fn()
              .mockResolvedValue({ task_id: 'task-1', session_id: 'session-1', status: 'running' }),
            on: vi.fn(),
            get: vi.fn(),
            reportTerminationComplete: vi.fn(),
          };
        if (path === 'opencode-native-state')
          return {
            begin: vi.fn(async (input: { holder_instance_id: string }) => {
              const result = await begin(input.holder_instance_id);
              return result === admission
                ? {
                    ...admission,
                    attempt: { ...admission.attempt, holder_instance_id: input.holder_instance_id },
                  }
                : result;
            }),
          };
        return { on: vi.fn() };
      },
    });
    const winnerClient = makeClient(async () => admission);
    const loserClient = makeClient(async () => rejected);
    runtime.createExecutorClient
      .mockResolvedValueOnce(winnerClient)
      .mockResolvedValueOnce(loserClient);

    const makeExecutor = () => {
      const executor = new AgorExecutor({
        sessionToken: 'token',
        sessionId: 'session-1',
        taskId: 'task-1',
        prompt: 'prompt',
        tool: 'opencode',
        daemonUrl: 'http://daemon',
        agenticToolContext: { version: 3, mode: 'managed-projection' },
        managedOpenCodeLocator: {
          runId: 'run-1',
          cellId: 'cell-1',
          namespace: 'tenant-ns',
          podName: 'pod-1',
          podUid: 'pod-uid-1',
          containerName: 'executor',
        },
      });
      (executor as unknown as { setupShutdownHandlers: () => void }).setupShutdownHandlers =
        vi.fn();
      return executor;
    };
    const winner = makeExecutor();
    const loser = makeExecutor();

    const winnerRun = winner.start();
    await vi.waitFor(() => expect(runtime.execute).toHaveBeenCalledOnce());
    const loserRun = loser.start();
    await Promise.all([loserRun]);

    expect(runtime.execute).toHaveBeenCalledOnce();
    expect(runtime.startHeartbeat).toHaveBeenCalledOnce();
    expect(runtime.createExecutorClient.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.startHeartbeat.mock.invocationCallOrder[0]!
    );
    expect(runtime.startHeartbeat.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.execute.mock.invocationCallOrder[0]!
    );
    expect(exit).toHaveBeenCalledWith(1);

    finishWinner();
    await winnerRun;
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it('reports a pre-admission rejection as a task failure without starting provider work', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const patch = vi.fn().mockResolvedValue({ status: 'failed' });
    const begin = vi.fn().mockResolvedValue({ outcome: 'rejected', code: 'identity_invalid' });
    runtime.createExecutorClient.mockResolvedValue({
      service(path: string) {
        if (path === 'tasks')
          return {
            on: vi.fn(),
            connectExecutor: vi
              .fn()
              .mockResolvedValue({ task_id: 'task-1', session_id: 'session-1', status: 'running' }),
            get: vi
              .fn()
              .mockResolvedValue({ task_id: 'task-1', session_id: 'session-1', status: 'running' }),
            patch,
          };
        if (path === 'opencode-native-state') return { begin };
        return { on: vi.fn() };
      },
    });
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'opencode',
      daemonUrl: 'http://daemon',
      agenticToolContext: { version: 3, mode: 'managed-projection' },
      managedOpenCodeLocator: {
        runId: 'run-1',
        cellId: 'cell-1',
        namespace: 'tenant-ns',
        podName: 'pod-1',
        podUid: 'pod-uid-1',
        containerName: 'executor',
      },
    });
    (executor as unknown as { setupShutdownHandlers: () => void }).setupShutdownHandlers = vi.fn();

    await executor.start();

    expect(begin).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'failed' }));
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(exit).toHaveBeenLastCalledWith(1);
  });

  it('acknowledges Stop when it wins the pre-admission failure-patch race', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const requestedAt = '2026-09-24T00:00:00.000Z';
    const running = { task_id: 'task-1', session_id: 'session-1', status: 'running' };
    const stopping = {
      ...running,
      status: 'stopping',
      termination_request: { cause: 'user_stop', requested_at: requestedAt },
    };
    const get = vi
      .fn()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(stopping);
    const patch = vi.fn().mockResolvedValue(stopping);
    const reportTerminationComplete = vi.fn().mockResolvedValue(stopping);
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'opencode',
      daemonUrl: 'http://daemon',
      agenticToolContext: { version: 3, mode: 'managed-projection' },
    }) as unknown as {
      client: object;
      settleManagedOpenCodeBeforeAdmission(): Promise<void>;
    };
    executor.client = { service: () => ({ get, patch, reportTerminationComplete }) };

    await executor.settleManagedOpenCodeBeforeAdmission();

    expect(patch).toHaveBeenCalledOnce();
    expect(reportTerminationComplete).toHaveBeenCalledWith({
      task_id: 'task-1',
      requested_at: requestedAt,
    });
  });

  it('recovers and drains a response-lost begin grant after Stop with the original holder', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const requestedAt = '2026-09-24T00:00:00.000Z';
    const stopping = {
      task_id: 'task-1',
      session_id: 'session-1',
      status: 'stopping',
      termination_request: { cause: 'user_stop', requested_at: requestedAt },
    };
    const closeRead = vi.fn().mockRejectedValueOnce({ code: 503 }).mockResolvedValue(undefined);
    const abandon = vi.fn().mockResolvedValue(undefined);
    const reportTerminationComplete = vi.fn().mockResolvedValue(stopping);
    let executor!: AgorExecutor;
    const begin = vi
      .fn()
      .mockImplementationOnce(async (input: { holder_instance_id: string }) => {
        (
          executor as unknown as { handleTaskLifecycleUpdate(task: unknown): void }
        ).handleTaskLifecycleUpdate(stopping);
        throw { code: 408 };
      })
      .mockImplementation(async (input: { holder_instance_id: string }) => ({
        outcome: 'admitted',
        attempt: { task_id: 'task-1', holder_instance_id: input.holder_instance_id },
        input: { storeId: 'store-1', attemptTaskId: 'source-task-1' },
      }));
    runtime.createExecutorClient.mockResolvedValue({
      service(path: string) {
        if (path === 'tasks')
          return {
            on: vi.fn(),
            connectExecutor: vi.fn().mockResolvedValue({
              task_id: 'task-1',
              session_id: 'session-1',
              status: 'running',
            }),
            get: vi.fn().mockResolvedValue(stopping),
            reportTerminationComplete,
            patch: vi.fn(),
          };
        if (path === 'opencode-native-state') return { begin, closeRead, abandon };
        return { on: vi.fn() };
      },
    });
    executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'opencode',
      daemonUrl: 'http://daemon',
      agenticToolContext: { version: 3, mode: 'managed-projection' },
      managedOpenCodeLocator: {
        runId: 'run-1',
        cellId: 'cell-1',
        namespace: 'tenant-ns',
        podName: 'pod-1',
        podUid: 'pod-uid-1',
        containerName: 'executor',
      },
    });
    (executor as unknown as { setupShutdownHandlers: () => void }).setupShutdownHandlers = vi.fn();

    await executor.start();

    expect(begin).toHaveBeenCalledTimes(2);
    const holderId = begin.mock.calls[0][0].holder_instance_id;
    expect(begin.mock.calls[1][0].holder_instance_id).toBe(holderId);
    expect(closeRead).toHaveBeenCalledWith({
      task_id: 'task-1',
      holder_instance_id: holderId,
      input: { storeId: 'store-1', taskId: 'source-task-1' },
    });
    expect(closeRead).toHaveBeenCalledTimes(2);
    expect(abandon).toHaveBeenCalledWith({ task_id: 'task-1', holder_instance_id: holderId });
    expect(reportTerminationComplete).toHaveBeenCalledWith({
      task_id: 'task-1',
      requested_at: requestedAt,
      holder_instance_id: holderId,
    });
    expect(runtime.execute).not.toHaveBeenCalled();
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
            abort_grace_ms: 100,
            claude_idle_timeout_ms: null,
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

  it('stops liveness and exits for containment when the daemon does not acknowledge', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const executor = harness(() => Promise.reject(new Error('offline')));
    const heartbeat = executor.heartbeat;

    await executor.handleWatchdogDecision(evidence);

    expect(heartbeat?.stop).toHaveBeenCalledOnce();
    expect(executor.heartbeat).toBeNull();
    expect(executor.abortController.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).toHaveBeenCalledWith(70);
  });

  it('exits authorization revocation cooperatively with a sanitized message and quiescence ack', async () => {
    const reportTerminationComplete = vi.fn().mockResolvedValue({});
    const heartbeatStop = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
      recoverTerminationAfterExecutionError(): Promise<boolean>;
    };
    executor.client = { service: () => ({ reportTerminationComplete }) };
    executor.heartbeat = { stop: heartbeatStop };

    executor.handleTaskLifecycleUpdate({
      task_id: 'task-1',
      status: 'stopping',
      termination_request: {
        cause: 'authorization_revoked',
        requested_at: '2026-07-23T12:00:00.000Z',
        error_message: AUTHORIZATION_REVOKED_TERMINATION_MESSAGE,
      },
    });

    expect(executor.abortController.signal.aborted).toBe(true);
    expect(warn).toHaveBeenCalledWith(AUTHORIZATION_REVOKED_TERMINATION_MESSAGE);
    expect(heartbeatStop).not.toHaveBeenCalled();
    // `run()` maps this recovered result to its normal code-0 exit path.
    await expect(executor.recoverTerminationAfterExecutionError()).resolves.toBe(true);
    expect(reportTerminationComplete).toHaveBeenCalledWith({
      task_id: 'task-1',
      requested_at: '2026-07-23T12:00:00.000Z',
    });
  });

  it('acknowledges Stop when an aborted provider rejects', async () => {
    const reportTerminationComplete = vi.fn().mockResolvedValue({});
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
      handleTaskLifecycleUpdate(task: unknown): void;
      recoverTerminationAfterExecutionError(): Promise<boolean>;
    };
    executor.client = { service: () => ({ reportTerminationComplete }) };
    executor.handleTaskLifecycleUpdate({
      task_id: 'task-1',
      status: 'stopping',
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-07-23T12:00:00.000Z',
      },
    });

    await expect(executor.recoverTerminationAfterExecutionError()).resolves.toBe(true);
    expect(reportTerminationComplete).toHaveBeenCalledWith({
      task_id: 'task-1',
      requested_at: '2026-07-23T12:00:00.000Z',
    });
  });

  it('reports quiescence for a stop claimed before this executor could connect', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const reportTerminationComplete = vi.fn().mockResolvedValue({});
    const get = vi.fn().mockResolvedValue({
      task_id: 'task-1',
      status: 'stopping',
      executor_mode: 'templated',
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-07-23T12:00:00.000Z',
      },
    });
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'codex',
      daemonUrl: 'http://daemon',
    }) as unknown as {
      client: {
        service: () => {
          reportTerminationComplete: typeof reportTerminationComplete;
          get: typeof get;
        };
      };
      recoverTerminationAfterExecutionError(): Promise<boolean>;
    };
    executor.client = { service: () => ({ reportTerminationComplete, get }) };

    // connectExecutor rejected with Conflict because the task was already
    // stopping; no termination request had been observed over the socket.
    await expect(executor.recoverTerminationAfterExecutionError()).resolves.toBe(true);
    expect(get).toHaveBeenCalledOnce();
    expect(reportTerminationComplete).toHaveBeenCalledWith({
      task_id: 'task-1',
      requested_at: '2026-07-23T12:00:00.000Z',
    });
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it('warns once when provider cleanup remains active after Stop', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let settleProvider!: () => void;
    runtime.execute.mockImplementationOnce(
      () => new Promise<void>((resolve) => (settleProvider = resolve))
    );
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'codex',
      daemonUrl: 'http://daemon',
    }) as unknown as {
      client: object;
      executeTask(): Promise<void>;
      handleTaskLifecycleUpdate(task: unknown): void;
    };
    executor.client = {};
    const execution = executor.executeTask();
    await vi.advanceTimersByTimeAsync(0);
    executor.handleTaskLifecycleUpdate({
      task_id: 'task-1',
      status: 'stopping',
      termination_request: {
        cause: 'user_stop',
        requested_at: '2026-07-23T12:00:00.000Z',
      },
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('provider_cleanup_slow'))
    ).toHaveLength(1);

    settleProvider();
    await execution;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      warn.mock.calls.filter(([message]) => String(message).includes('provider_cleanup_slow'))
    ).toHaveLength(1);
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
    expect(heartbeatStop).not.toHaveBeenCalled();
  });

  it('deduplicates patched-event storms for one durable MCP recovery identity', async () => {
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'claude-code',
      daemonUrl: 'http://daemon',
    }) as unknown as { requestDurableMcpRecovery(task: unknown): void };
    runtime.refreshMcp.mockRejectedValue(new Error('daemon unavailable'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const task = {
      task_id: 'task-1',
      session_id: 'session-1',
      metadata: {
        mcp_recovery: {
          generation: 9,
          status: 'refresh_requested',
          request_id: 'request-9',
          refresh_deadline_at: new Date(Date.now() + 30_000).toISOString(),
          provider: { mode: 'in_place', transport_reload: true, retries_unstarted_call: false },
        },
      },
    };

    for (let index = 0; index < 20; index += 1) executor.requestDurableMcpRecovery(task);
    await Promise.resolve();
    expect(runtime.refreshMcp).toHaveBeenCalledTimes(1);
    expect(runtime.refreshMcp).toHaveBeenCalledWith('task-1', {
      requestId: 'request-9',
      reason: 'authority_changed',
      expectedGeneration: 9,
    });
  });

  it('receives user_reconnect over the task event listener and retries a poisoned identity', async () => {
    const listeners = new Map<string, (data: unknown) => void>();
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
    executor.setupEventListeners();
    runtime.refreshMcp.mockRejectedValue(new Error('transient daemon failure'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const event = {
      task_id: 'task-1',
      session_id: 'session-1',
      request_id: 'request-1',
      generation: 1,
      reason: 'authority_changed',
    };
    listeners.get('tasks:mcp_refresh_requested')?.(event);
    await vi.waitFor(() => expect(runtime.refreshMcp).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();
    listeners.get('tasks:mcp_refresh_requested')?.({ ...event, reason: 'user_reconnect' });
    await vi.waitFor(() => expect(runtime.refreshMcp).toHaveBeenCalledTimes(2));
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
  });
});
