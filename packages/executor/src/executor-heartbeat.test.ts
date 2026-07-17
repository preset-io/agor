import { describe, expect, it, vi } from 'vitest';
import { startExecutorHeartbeat } from './executor-heartbeat';

describe('startExecutorHeartbeat', () => {
  it('writes immediately and then at the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const reportRuntimeTelemetry = vi.fn().mockResolvedValue({});
      const client = { service: () => ({ reportRuntimeTelemetry }) } as never;
      const handle = startExecutorHeartbeat({
        client,
        taskId: 'task-1',
        intervalMs: 1000,
      });

      await Promise.resolve();
      expect(reportRuntimeTelemetry).toHaveBeenCalledWith({ task_id: 'task-1' });

      await vi.advanceTimersByTimeAsync(1000);
      expect(reportRuntimeTelemetry).toHaveBeenCalledTimes(2);

      handle.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(reportRuntimeTelemetry).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when disabled', async () => {
    vi.useFakeTimers();
    try {
      const reportRuntimeTelemetry = vi.fn().mockResolvedValue({});
      const client = { service: () => ({ reportRuntimeTelemetry }) } as never;
      startExecutorHeartbeat({ client, taskId: 'task-1', enabled: false, intervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(reportRuntimeTelemetry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces many pulses into the latest fact at heartbeat cadence', async () => {
    vi.useFakeTimers();
    try {
      const reportRuntimeTelemetry = vi.fn().mockResolvedValue({});
      const client = { service: () => ({ reportRuntimeTelemetry }) } as never;
      const handle = startExecutorHeartbeat({ client, taskId: 'task-1', intervalMs: 1000 });
      await Promise.resolve();

      for (let index = 1; index <= 100; index++) {
        handle.recordPulse('progress', `event.${index}`);
      }
      expect(reportRuntimeTelemetry).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(reportRuntimeTelemetry).toHaveBeenCalledTimes(2);
      expect(reportRuntimeTelemetry).toHaveBeenLastCalledWith({
        task_id: 'task-1',
        pulse: { sequence: 100, kind: 'progress', detail: 'event.100' },
      });
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
