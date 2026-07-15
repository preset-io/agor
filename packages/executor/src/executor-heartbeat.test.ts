import { describe, expect, it, vi } from 'vitest';
import { startExecutorHeartbeat } from './executor-heartbeat';

describe('startExecutorHeartbeat', () => {
  it('writes immediately and then at the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const reportExecutorTelemetry = vi.fn().mockResolvedValue({});
      const client = { service: () => ({ reportExecutorTelemetry }) } as any;
      const handle = startExecutorHeartbeat({
        client,
        taskId: 'task-1',
        executorAttemptId: 'attempt-1',
        intervalMs: 1000,
      });

      await Promise.resolve();
      expect(reportExecutorTelemetry).toHaveBeenCalledWith({
        task_id: 'task-1',
        executor_attempt_id: 'attempt-1',
        heartbeat: true,
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(reportExecutorTelemetry).toHaveBeenCalledTimes(2);

      handle.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(reportExecutorTelemetry).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when disabled', async () => {
    vi.useFakeTimers();
    try {
      const reportExecutorTelemetry = vi.fn().mockResolvedValue({});
      const client = { service: () => ({ reportExecutorTelemetry }) } as any;
      startExecutorHeartbeat({
        client,
        taskId: 'task-1',
        executorAttemptId: 'attempt-1',
        enabled: false,
        intervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(reportExecutorTelemetry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
