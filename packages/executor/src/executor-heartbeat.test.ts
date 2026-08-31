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

  it('forwards authorization termination control without treating it as a retryable write failure', async () => {
    vi.useFakeTimers();
    try {
      const stopping = {
        task_id: 'task-1',
        status: 'stopping',
        termination_request: {
          cause: 'authorization_revoked',
          requested_at: '2026-08-06T12:00:00.000Z',
          error_message: 'Authorization to continue this task was revoked.',
        },
      };
      const reportRuntimeTelemetry = vi.fn().mockResolvedValue(stopping);
      const onTask = vi.fn();
      const warn = vi.fn();
      const client = { service: () => ({ reportRuntimeTelemetry }) } as never;
      const handle = startExecutorHeartbeat({
        client,
        taskId: 'task-1',
        intervalMs: 1000,
        onTask,
        warn,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(onTask).toHaveBeenCalledWith(stopping);
      expect(warn).not.toHaveBeenCalled();
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs only the first consecutive write failure and one recovery summary', async () => {
    vi.useFakeTimers();
    try {
      const reportRuntimeTelemetry = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockRejectedValueOnce(new Error('still offline'))
        .mockResolvedValue({});
      const warn = vi.fn();
      const log = vi.fn();
      const client = { service: () => ({ reportRuntimeTelemetry }) } as never;
      const handle = startExecutorHeartbeat({
        client,
        taskId: 'task-1',
        intervalMs: 1000,
        warn,
        log,
      });

      await vi.advanceTimersByTimeAsync(2_000);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('event=write_failed'));
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('missed_writes=2'));
      handle.stop();
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

  it('keeps 100 concurrent pulse streams bounded to heartbeat cadence', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn().mockResolvedValue({});
      const client = { service: () => ({ reportRuntimeTelemetry: write }) } as never;
      const handles = Array.from({ length: 100 }, (_, executor) => {
        const handle = startExecutorHeartbeat({
          client,
          taskId: `task-${executor}`,
          intervalMs: 1000,
        });
        for (let pulse = 0; pulse < 100; pulse++) handle.recordPulse('progress', `e.${pulse}`);
        return handle;
      });
      await Promise.resolve();
      expect(write).toHaveBeenCalledTimes(100);
      await vi.advanceTimersByTimeAsync(1000);
      expect(write).toHaveBeenCalledTimes(200);
      handles.forEach((handle) => {
        handle.stop();
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
