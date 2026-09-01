import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeWorkloadTask,
  parseWorkloadRequest,
  WORKLOAD_REQUEST_MAX_BYTES,
} from './workload.js';

function clientHarness() {
  const taskPatch = vi.fn().mockResolvedValue({ status: 'failed' });
  const taskGet = vi.fn().mockResolvedValue({ status: 'running' });
  const completeWorkload = vi.fn().mockResolvedValue({
    outcome: 'transitioned',
    task: { status: 'completed' },
    message: { role: 'assistant' },
  });
  return {
    client: {
      service(name: string) {
        if (name === 'tasks') return { patch: taskPatch, get: taskGet, completeWorkload };
        throw new Error(`unexpected service ${name}`);
      },
    } as never,
    taskPatch,
    taskGet,
    completeWorkload,
  };
}

describe('deterministic workload runner', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('accepts only the strict bounded wait contract', () => {
    expect(parseWorkloadRequest('{"schemaVersion":1,"profile":"wait","durationMs":100}')).toEqual({
      schemaVersion: 1,
      profile: 'wait',
      durationMs: 100,
    });
    expect(() =>
      parseWorkloadRequest(
        '{"schemaVersion":1,"profile":"wait","durationMs":100,"command":"echo unsafe"}'
      )
    ).toThrow('WORKLOAD_REQUEST_INVALID');
    expect(() =>
      parseWorkloadRequest('{"schemaVersion":1,"profile":"wait","durationMs":120001}')
    ).toThrow('WORKLOAD_REQUEST_INVALID');
    expect(() => parseWorkloadRequest('x'.repeat(WORKLOAD_REQUEST_MAX_BYTES + 1))).toThrow(
      'WORKLOAD_REQUEST_INVALID'
    );
  });

  it('waits, emits progress, writes one bounded result, and completes the normal Task', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T12:00:00.000Z'));
    const harness = clientHarness();
    const onPulse = vi.fn();
    const execution = executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"wait","durationMs":10000}',
      abortController: new AbortController(),
      onPulse,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await execution;

    expect(onPulse).toHaveBeenCalledWith('progress', 'workload.wait');
    expect(harness.completeWorkload).toHaveBeenCalledWith({
      task_id: 'task-1',
      result_message_id: expect.any(String),
      requested_duration_ms: 10_000,
      observed_elapsed_ms: 10_000,
    });
    expect(harness.taskPatch).not.toHaveBeenCalled();
  });

  it('reconciles a committed completion whose response was lost', async () => {
    vi.useFakeTimers();
    const harness = clientHarness();
    harness.completeWorkload.mockRejectedValueOnce(new Error('response lost'));
    harness.taskGet.mockResolvedValueOnce({ status: 'completed' });
    const execution = executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"wait","durationMs":100}',
      abortController: new AbortController(),
    });

    await vi.advanceTimersByTimeAsync(100);
    await execution;

    expect(harness.completeWorkload).toHaveBeenCalledOnce();
    expect(harness.taskGet).toHaveBeenCalledWith('task-1');
    expect(harness.taskPatch).not.toHaveBeenCalled();
  });

  it.each(['running', 'stopping', 'stopped', 'failed'])(
    'preserves a completion failure when durable Task state is %s',
    async (status) => {
      vi.useFakeTimers();
      const harness = clientHarness();
      harness.completeWorkload.mockRejectedValueOnce(new Error('completion rejected'));
      harness.taskGet.mockResolvedValueOnce({ status });
      const execution = executeWorkloadTask({
        client: harness.client,
        sessionId: 'session-1' as never,
        taskId: 'task-1' as never,
        prompt: '{"schemaVersion":1,"profile":"wait","durationMs":100}',
        abortController: new AbortController(),
      });
      const rejected = expect(execution).rejects.toThrow('completion rejected');

      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(harness.taskPatch).not.toHaveBeenCalled();
    }
  );

  it('cooperatively aborts without writing a result or terminal Task state', async () => {
    vi.useFakeTimers();
    const harness = clientHarness();
    const abortController = new AbortController();
    const execution = executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"wait","durationMs":120000}',
      abortController,
    });

    abortController.abort();
    await execution;

    expect(harness.completeWorkload).not.toHaveBeenCalled();
    expect(harness.taskPatch).not.toHaveBeenCalled();
  });

  it('fails invalid input with a stable code and no raw parser details', async () => {
    const harness = clientHarness();
    await executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"wait","durationMs":0}',
      abortController: new AbortController(),
    });

    expect(harness.completeWorkload).not.toHaveBeenCalled();
    expect(harness.taskPatch).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'failed',
        error_message: 'WORKLOAD_REQUEST_INVALID',
      })
    );
  });
});
