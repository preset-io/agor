import { describe, expect, it, vi } from 'vitest';
import { RuntimeOverseer, type RuntimeOverseerOptions } from './runtime-overseer.js';
import type { AgorClient } from './services/feathers-client.js';

const EXECUTOR_ATTEMPT_ID = '018f0000-0000-7000-8000-000000000004';

function createClient(reportExecutorTelemetry = vi.fn().mockResolvedValue({})) {
  return {
    service: vi.fn(() => ({ reportExecutorTelemetry })),
  } as unknown as AgorClient;
}

function createRuntime(
  reportExecutorTelemetry = vi.fn().mockResolvedValue({}),
  options: Partial<Omit<RuntimeOverseerOptions, 'client' | 'taskId' | 'executorAttemptId'>> = {}
) {
  return new RuntimeOverseer({
    client: createClient(reportExecutorTelemetry),
    taskId: 'task-1',
    executorAttemptId: EXECUTOR_ATTEMPT_ID,
    ...options,
  });
}

describe('RuntimeOverseer', () => {
  it('writes an immediate heartbeat with the executor.connected pulse', async () => {
    vi.useFakeTimers();
    try {
      const reportExecutorTelemetry = vi.fn().mockResolvedValue({});
      const runtime = createRuntime(reportExecutorTelemetry, {
        heartbeatIntervalMs: 1000,
      });

      runtime.start();
      await Promise.resolve();

      expect(reportExecutorTelemetry).toHaveBeenCalledWith({
        task_id: 'task-1',
        executor_attempt_id: EXECUTOR_ATTEMPT_ID,
        heartbeat: true,
        pulse: { kind: 'executor.connected' },
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(reportExecutorTelemetry).toHaveBeenCalledTimes(2);
      expect(reportExecutorTelemetry.mock.calls[1]?.[0]).not.toHaveProperty('pulse');

      runtime.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(reportExecutorTelemetry).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit heartbeat patches when disabled', async () => {
    vi.useFakeTimers();
    try {
      const reportExecutorTelemetry = vi.fn().mockResolvedValue({});
      const runtime = createRuntime(reportExecutorTelemetry, {
        enabled: false,
        heartbeatIntervalMs: 1000,
      });

      runtime.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(reportExecutorTelemetry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes the latest pulse without treating heartbeat as a pulse', async () => {
    const reportExecutorTelemetry = vi.fn().mockResolvedValue({});
    const runtime = createRuntime(reportExecutorTelemetry);

    runtime.pulse({ kind: 'tool.started', id: 'tool-1', label: 'Bash' });
    await runtime.heartbeat();
    await runtime.heartbeat();

    expect(reportExecutorTelemetry).toHaveBeenCalledTimes(2);
    expect(reportExecutorTelemetry.mock.calls[0]?.[0]).toEqual({
      task_id: 'task-1',
      executor_attempt_id: EXECUTOR_ATTEMPT_ID,
      heartbeat: true,
      pulse: { kind: 'tool.started', id: 'tool-1', label: 'Bash' },
    });
    expect(reportExecutorTelemetry.mock.calls[1]?.[0]).not.toHaveProperty('pulse');
  });

  it('warns and keeps running when a telemetry write fails', async () => {
    const warn = vi.fn();
    const reportExecutorTelemetry = vi
      .fn()
      .mockRejectedValueOnce(new Error('daemon down'))
      .mockResolvedValueOnce({});
    const runtime = createRuntime(reportExecutorTelemetry, { warn });

    await runtime.heartbeat();
    await runtime.heartbeat();

    expect(warn).toHaveBeenCalledWith(
      '[runtime-overseer] Failed to write heartbeat:',
      'daemon down'
    );
    expect(reportExecutorTelemetry).toHaveBeenCalledTimes(2);
  });

  it('self-fences when an in-flight heartbeat outlives the lease', async () => {
    vi.useFakeTimers();
    try {
      const onLeaseLost = vi.fn();
      const reportExecutorTelemetry = vi.fn(() => new Promise<void>(() => {}));
      const runtime = createRuntime(reportExecutorTelemetry, {
        heartbeatIntervalMs: 1000,
        heartbeatStaleAfterMs: 3000,
        onLeaseLost,
      });

      runtime.start();
      await vi.advanceTimersByTimeAsync(3000);

      expect(reportExecutorTelemetry).toHaveBeenCalledTimes(1);
      expect(onLeaseLost).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3000);
      expect(onLeaseLost).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('self-fences immediately when the daemon rejects the attempt lease', async () => {
    const onLeaseLost = vi.fn();
    const rejection = Object.assign(new Error('attempt revoked'), { code: 409 });
    const runtime = createRuntime(vi.fn().mockRejectedValue(rejection), {
      heartbeatStaleAfterMs: 30_000,
      onLeaseLost,
    });

    await runtime.heartbeat();

    expect(onLeaseLost).toHaveBeenCalledOnce();
  });

  it('does not let fallback SDK chatter replace meaningful progress', async () => {
    const reportExecutorTelemetry = vi.fn().mockResolvedValue({});
    const runtime = createRuntime(reportExecutorTelemetry);

    runtime.pulse({ kind: 'tool.progress', id: 'tool-1', label: 'Bash' });
    runtime.pulse({ kind: 'sdk.progress', label: 'token_count' });
    await runtime.heartbeat();

    expect(reportExecutorTelemetry.mock.calls[0]?.[0].pulse).toEqual({
      kind: 'tool.progress',
      id: 'tool-1',
      label: 'Bash',
    });
  });

  it('does not overlap heartbeat patches', async () => {
    let resolvePatch: (() => void) | undefined;
    const reportExecutorTelemetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePatch = resolve;
        })
    );
    const runtime = createRuntime(reportExecutorTelemetry);

    const first = runtime.heartbeat();
    await runtime.heartbeat();

    expect(reportExecutorTelemetry).toHaveBeenCalledTimes(1);
    resolvePatch?.();
    await first;
  });

  it('flushes a pulse emitted while an earlier heartbeat is in flight', async () => {
    let resolvePatch: (() => void) | undefined;
    const reportExecutorTelemetry = vi.fn(() => {
      if (reportExecutorTelemetry.mock.calls.length === 1) {
        return new Promise<void>((resolve) => {
          resolvePatch = resolve;
        });
      }
      return Promise.resolve();
    });
    const runtime = createRuntime(reportExecutorTelemetry);

    const first = runtime.heartbeat();
    runtime.pulse({ kind: 'tool.finished', label: 'Bash' });

    const flush = runtime.flush();
    expect(reportExecutorTelemetry).toHaveBeenCalledTimes(1);

    resolvePatch?.();
    await first;
    await flush;

    expect(reportExecutorTelemetry).toHaveBeenCalledTimes(2);
    expect(reportExecutorTelemetry.mock.calls[1]?.[0]).toEqual({
      task_id: 'task-1',
      executor_attempt_id: EXECUTOR_ATTEMPT_ID,
      heartbeat: false,
      pulse: { kind: 'tool.finished', label: 'Bash' },
    });
  });

  it.each([
    0, 100,
  ])('times out flush after %d ms when an in-flight heartbeat never settles', async (timeoutMs) => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const reportExecutorTelemetry = vi.fn(() => new Promise<void>(() => {}));
      const runtime = createRuntime(reportExecutorTelemetry, { warn });

      void runtime.heartbeat();
      const flush = runtime.flush(timeoutMs);

      await vi.advanceTimersByTimeAsync(timeoutMs);

      await expect(flush).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(
        '[runtime-overseer] Timed out flushing in-flight heartbeat'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one timeout budget between the in-flight heartbeat and final pulse', async () => {
    vi.useFakeTimers();
    try {
      let resolveHeartbeat: (() => void) | undefined;
      const reportExecutorTelemetry = vi.fn(() => {
        if (reportExecutorTelemetry.mock.calls.length === 1) {
          return new Promise<void>((resolve) => {
            resolveHeartbeat = resolve;
          });
        }
        return new Promise<void>(() => {});
      });
      const runtime = createRuntime(reportExecutorTelemetry);

      void runtime.heartbeat();
      runtime.pulse({ kind: 'tool.finished', label: 'Bash' });
      const flush = runtime.flush(100);

      await vi.advanceTimersByTimeAsync(80);
      resolveHeartbeat?.();
      await vi.advanceTimersByTimeAsync(19);
      expect(reportExecutorTelemetry).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);

      await expect(flush).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns false when the final pulse cannot be delivered', async () => {
    const warn = vi.fn();
    const runtime = createRuntime(vi.fn().mockRejectedValue(new Error('connection closed')), {
      warn,
    });
    runtime.pulse({ kind: 'tool.finished', label: 'Bash' });

    await expect(runtime.flush()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[runtime-overseer] Failed to flush runtime pulse:',
      'connection closed'
    );
  });
});
