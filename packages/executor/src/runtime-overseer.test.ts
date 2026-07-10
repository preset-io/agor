import { describe, expect, it, vi } from 'vitest';
import { RuntimeOverseer, sanitizePulse } from './runtime-overseer.js';

function createClient(patch = vi.fn().mockResolvedValue({})) {
  return {
    service: vi.fn(() => ({ patch })),
  } as any;
}

describe('RuntimeOverseer', () => {
  it('writes an immediate heartbeat with the executor.connected pulse', async () => {
    vi.useFakeTimers();
    try {
      const patch = vi.fn().mockResolvedValue({});
      const runtime = new RuntimeOverseer({
        client: createClient(patch),
        taskId: 'task-1',
        heartbeatIntervalMs: 1000,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });

      runtime.start();
      await Promise.resolve();

      expect(patch).toHaveBeenCalledWith('task-1', {
        last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
        latest_executor_pulse: {
          kind: 'executor.connected',
          at: '2026-01-01T00:00:00.000Z',
        },
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(patch).toHaveBeenCalledTimes(2);

      runtime.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(patch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit heartbeat patches when disabled', async () => {
    vi.useFakeTimers();
    try {
      const patch = vi.fn().mockResolvedValue({});
      const runtime = new RuntimeOverseer({
        client: createClient(patch),
        taskId: 'task-1',
        enabled: false,
        heartbeatIntervalMs: 1000,
      });

      runtime.start();
      await vi.advanceTimersByTimeAsync(5000);

      expect(patch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes the latest pulse without treating heartbeat as a pulse', async () => {
    const patch = vi.fn().mockResolvedValue({});
    const runtime = new RuntimeOverseer({
      client: createClient(patch),
      taskId: 'task-1',
      now: () => new Date('2026-01-01T00:00:05.000Z'),
    });

    runtime.pulse({ kind: 'tool.started', id: 'tool-1', label: 'Bash' });
    await runtime.heartbeat();
    await runtime.heartbeat();

    expect(patch).toHaveBeenCalledTimes(2);
    for (const call of patch.mock.calls) {
      expect(call[1].latest_executor_pulse).toEqual({
        kind: 'tool.started',
        id: 'tool-1',
        label: 'Bash',
        at: '2026-01-01T00:00:05.000Z',
      });
    }
  });

  it('warns and keeps running when a heartbeat patch fails', async () => {
    const warn = vi.fn();
    const patch = vi.fn().mockRejectedValueOnce(new Error('daemon down')).mockResolvedValueOnce({});
    const runtime = new RuntimeOverseer({
      client: createClient(patch),
      taskId: 'task-1',
      warn,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    await runtime.heartbeat();
    await runtime.heartbeat();

    expect(warn).toHaveBeenCalledWith(
      '[runtime-overseer] Failed to write heartbeat:',
      'daemon down'
    );
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it('does not overlap heartbeat patches', async () => {
    let resolvePatch: (() => void) | undefined;
    const patch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvePatch = resolve;
        })
    );
    const runtime = new RuntimeOverseer({
      client: createClient(patch),
      taskId: 'task-1',
    });

    const first = runtime.heartbeat();
    await runtime.heartbeat();

    expect(patch).toHaveBeenCalledTimes(1);
    resolvePatch?.();
    await first;
  });

  it('flushes a pulse emitted while an earlier heartbeat is in flight', async () => {
    let resolvePatch: (() => void) | undefined;
    const patch = vi.fn(() => {
      if (patch.mock.calls.length === 1) {
        return new Promise<void>((resolve) => {
          resolvePatch = resolve;
        });
      }
      return Promise.resolve();
    });
    let tick = 0;
    const runtime = new RuntimeOverseer({
      client: createClient(patch),
      taskId: 'task-1',
      now: () => new Date(`2026-01-01T00:00:0${tick++}.000Z`),
    });

    const first = runtime.heartbeat();
    runtime.pulse({ kind: 'tool.finished', label: 'Bash' });

    const flush = runtime.flush();
    expect(patch).toHaveBeenCalledTimes(1);

    resolvePatch?.();
    await first;
    await flush;

    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1][1]).toEqual({
      latest_executor_pulse: {
        kind: 'tool.finished',
        label: 'Bash',
        at: '2026-01-01T00:00:01.000Z',
      },
    });
    expect(patch.mock.calls[1][1]).not.toHaveProperty('last_executor_heartbeat_at');
  });

  it('times out flush when an in-flight heartbeat never settles', async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const patch = vi.fn(() => new Promise<void>(() => {}));
      const runtime = new RuntimeOverseer({
        client: createClient(patch),
        taskId: 'task-1',
        warn,
      });

      void runtime.heartbeat();
      const flush = runtime.flush(100);

      await vi.advanceTimersByTimeAsync(100);

      await expect(flush).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(
        '[runtime-overseer] Timed out flushing in-flight heartbeat'
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sanitizePulse', () => {
  it('keeps only bounded pulse fields and drops unmodeled data', () => {
    const pulse = sanitizePulse({
      kind: 'sdk.progress',
      id: ` ${'x'.repeat(200)} `,
      label: ` ${'B'.repeat(140)} `,
      metadata: {
        token: 'secret',
        prompt: 'private prompt',
        command: 'cat ~/.agor/config.yaml',
        input: 'raw input',
        output: 'raw output',
        cwd: '/private/worktree',
        url: 'https://user:password@example.com',
        object: { raw: true },
      },
    } as unknown as Parameters<typeof sanitizePulse>[0]);

    expect(pulse.id).toHaveLength(160);
    expect(pulse.label).toHaveLength(120);
    expect(pulse).not.toHaveProperty('metadata');
  });
});
