import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  execute: vi.fn().mockResolvedValue(undefined),
  initialize: vi.fn().mockResolvedValue(undefined),
  recordPulse: vi.fn(),
  stopHeartbeat: vi.fn(),
}));
vi.mock('./executor-heartbeat.js', () => ({
  startExecutorHeartbeat: () => ({
    recordPulse: runtime.recordPulse,
    stop: runtime.stopHeartbeat,
  }),
}));
vi.mock('./handlers/sdk/tool-registry.js', () => ({
  initializeToolRegistry: runtime.initialize,
  ToolRegistry: { execute: runtime.execute },
}));

import { AgorExecutor } from './index.js';

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
  });

  it('starts SDK observation before invoking the tool', async () => {
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'opencode',
      agenticToolContext: { dataHome: '/opaque/opencode-home' },
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
    expect(runtime.execute).toHaveBeenCalledWith(
      'opencode',
      expect.objectContaining({
        agenticToolContext: { dataHome: '/opaque/opencode-home' },
      })
    );
    expect(runtime.recordPulse.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.execute.mock.invocationCallOrder[0]!
    );
  });

  it('settles adapter completion only after the runner returns from runtime cleanup', async () => {
    const complete = vi.fn().mockResolvedValue({});
    runtime.execute.mockResolvedValueOnce({
      completion: { model: 'provider/model' },
    });
    const executor = new AgorExecutor({
      sessionToken: 'token',
      sessionId: 'session-1',
      taskId: 'task-1',
      prompt: 'prompt',
      tool: 'opencode',
      agenticToolContext: { dataHome: '/opaque/opencode-home' },
      daemonUrl: 'http://daemon',
    }) as unknown as {
      client: { service: () => { complete: typeof complete } };
      executeTask(): Promise<void>;
    };
    executor.client = { service: () => ({ complete }) };

    await executor.executeTask();

    expect(complete).toHaveBeenCalledWith('task-1', { model: 'provider/model' });
    expect(runtime.execute.mock.invocationCallOrder.at(-1)).toBeLessThan(
      complete.mock.invocationCallOrder[0]!
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
});
