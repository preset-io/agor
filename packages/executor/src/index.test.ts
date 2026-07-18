import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
