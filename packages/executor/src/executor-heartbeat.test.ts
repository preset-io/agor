import { describe, expect, it, vi } from 'vitest';
import { startExecutorHeartbeat } from './executor-heartbeat';

describe('startExecutorHeartbeat', () => {
  it('writes immediately and then at the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const patch = vi.fn().mockResolvedValue({});
      const client = { service: () => ({ patch }) } as any;
      const handle = startExecutorHeartbeat({
        client,
        taskId: 'task-1',
        intervalMs: 1000,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });

      await Promise.resolve();
      expect(patch).toHaveBeenCalledWith('task-1', {
        last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(patch).toHaveBeenCalledTimes(2);

      handle.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(patch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when disabled', async () => {
    vi.useFakeTimers();
    try {
      const patch = vi.fn().mockResolvedValue({});
      const client = { service: () => ({ patch }) } as any;
      startExecutorHeartbeat({ client, taskId: 'task-1', enabled: false, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(patch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
