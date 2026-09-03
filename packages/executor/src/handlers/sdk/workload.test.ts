import { readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKLOAD_CONTROLLED_FAILURE_CODE, WORKLOAD_TEMP_IO_MAX_BYTES } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeWorkloadTask,
  parseWorkloadRequest,
  WORKLOAD_REQUEST_MAX_BYTES,
  WORKLOAD_TEMP_PREFIX,
} from './workload.js';

vi.mock('node:http', () => {
  throw new Error('network module imported by workload: node:http');
});
vi.mock('node:https', () => {
  throw new Error('network module imported by workload: node:https');
});
vi.mock('node:net', () => {
  throw new Error('network module imported by workload: node:net');
});
vi.mock('node:dns', () => {
  throw new Error('network module imported by workload: node:dns');
});
vi.mock('node:dns/promises', () => {
  throw new Error('network module imported by workload: node:dns/promises');
});

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

  it('accepts each strict profile and rejects out-of-contract fields and bounds', () => {
    expect(parseWorkloadRequest('{"schemaVersion":1,"profile":"controlled-failure"}')).toEqual({
      schemaVersion: 1,
      profile: 'controlled-failure',
      delayMs: 0,
    });
    expect(
      parseWorkloadRequest('{"schemaVersion":1,"profile":"cpu","durationMs":10,"seed":7}')
    ).toEqual({ schemaVersion: 1, profile: 'cpu', durationMs: 10, seed: 7 });
    expect(
      parseWorkloadRequest('{"schemaVersion":1,"profile":"temporary-io","bytes":32,"seed":7}')
    ).toEqual({ schemaVersion: 1, profile: 'temporary-io', bytes: 32, seed: 7 });
    expect(
      parseWorkloadRequest(
        '{"schemaVersion":1,"profile":"compile-test","repetitions":2,"totalTimeMs":100}'
      )
    ).toEqual({
      schemaVersion: 1,
      profile: 'compile-test',
      repetitions: 2,
      totalTimeMs: 100,
    });
    expect(parseWorkloadRequest('{"schemaVersion":1,"profile":"workspace-inspection"}')).toEqual({
      schemaVersion: 1,
      profile: 'workspace-inspection',
    });
    expect(parseWorkloadRequest('{"schemaVersion":1,"profile":"fixture-command"}')).toEqual({
      schemaVersion: 1,
      profile: 'fixture-command',
      repetitions: 1,
    });
    expect(
      parseWorkloadRequest('{"schemaVersion":1,"profile":"fixture-command","repetitions":10}')
    ).toEqual({ schemaVersion: 1, profile: 'fixture-command', repetitions: 10 });

    for (const prompt of [
      '{"schemaVersion":1,"profile":"controlled-failure","delayMs":120001}',
      '{"schemaVersion":1,"profile":"cpu","durationMs":9,"seed":7}',
      '{"schemaVersion":1,"profile":"cpu","durationMs":10,"seed":4294967296}',
      `{"schemaVersion":1,"profile":"temporary-io","bytes":${WORKLOAD_TEMP_IO_MAX_BYTES + 1},"seed":7}`,
      '{"schemaVersion":1,"profile":"compile-test","repetitions":0,"totalTimeMs":100}',
      '{"schemaVersion":1,"profile":"compile-test","repetitions":2,"totalTimeMs":9}',
      '{"schemaVersion":1,"profile":"cpu","durationMs":10,"seed":7,"path":"/tmp"}',
      '{"schemaVersion":1,"profile":"cpu","durationMs":10,"seed":7,"bytes":8}',
      '{"schemaVersion":1,"profile":"workspace-inspection","path":"/tmp"}',
      '{"schemaVersion":1,"profile":"workspace-inspection","command":"npm test"}',
      '{"schemaVersion":1,"profile":"workspace-inspection","env":{"TOKEN":"secret"}}',
      '{"schemaVersion":1,"profile":"fixture-command","repetitions":0}',
      '{"schemaVersion":1,"profile":"fixture-command","repetitions":11}',
      '{"schemaVersion":1,"profile":"fixture-command","command":"node"}',
      '{"schemaVersion":1,"profile":"fixture-command","argv":["--check"]}',
      '{"schemaVersion":1,"profile":"fixture-command","path":"/tmp"}',
      '{"schemaVersion":1,"profile":"fixture-command","source":"unsafe"}',
      '{"schemaVersion":1,"profile":"fixture-command","env":{"TOKEN":"secret"}}',
      '{"schemaVersion":1,"profile":"fixture-command","output":"raw"}',
      '{"schemaVersion":1,"profile":"fixture-command","package":"unsafe"}',
      '{"schemaVersion":1,"profile":"fixture-command","url":"https://example.com"}',
      '{"schemaVersion":1,"profile":"fixture-command","repo":"owner/name"}',
      '{"schemaVersion":1,"profile":"fixture-command","concurrency":2}',
    ]) {
      expect(() => parseWorkloadRequest(prompt)).toThrow('WORKLOAD_REQUEST_INVALID');
    }
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

    await vi.advanceTimersByTimeAsync(1_000);
    abortController.abort();
    await execution;

    expect(harness.completeWorkload).not.toHaveBeenCalled();
    expect(harness.taskPatch).not.toHaveBeenCalled();
  });

  it('records the controlled failure with a stable code after its optional delay', async () => {
    const harness = clientHarness();
    await executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"controlled-failure","delayMs":0}',
      abortController: new AbortController(),
    });

    expect(harness.taskPatch).not.toHaveBeenCalled();
    expect(harness.completeWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'task-1',
        profile: 'controlled-failure',
        requested_delay_ms: 0,
      })
    );
  });

  it('reconciles a controlled failure whose settlement response was lost', async () => {
    const harness = clientHarness();
    harness.completeWorkload.mockRejectedValueOnce(new Error('response lost'));
    harness.taskGet.mockResolvedValueOnce({
      status: 'failed',
      error_message: WORKLOAD_CONTROLLED_FAILURE_CODE,
    });

    await executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"controlled-failure"}',
      abortController: new AbortController(),
    });

    expect(harness.completeWorkload).toHaveBeenCalledOnce();
    expect(harness.taskGet).toHaveBeenCalledWith('task-1');
    expect(harness.taskPatch).not.toHaveBeenCalled();
  });

  it('cooperatively aborts controlled failure without settling a failure', async () => {
    vi.useFakeTimers();
    const harness = clientHarness();
    const abortController = new AbortController();
    const execution = executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"controlled-failure","delayMs":100}',
      abortController,
    });

    await vi.advanceTimersByTimeAsync(10);
    abortController.abort();
    await execution;

    expect(harness.completeWorkload).not.toHaveBeenCalled();
    expect(harness.taskPatch).not.toHaveBeenCalled();
  });

  it('aborts temporary I/O after directory creation and removes it unconditionally', async () => {
    const harness = clientHarness();
    const abortController = new AbortController();
    let directoryWasPresent = false;
    const onPulse = (_kind: string, detail?: string) => {
      if (detail === 'workload.temporary-io.directory-created') {
        directoryWasPresent = readdirSync(tmpdir()).some((entry) =>
          entry.startsWith(`${WORKLOAD_TEMP_PREFIX}task-1-`)
        );
        abortController.abort();
      }
    };

    await executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"temporary-io","bytes":257,"seed":11}',
      abortController,
      onPulse,
    });

    const temporaryEntries = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith(`${WORKLOAD_TEMP_PREFIX}task-1-`)
    );
    expect(directoryWasPresent).toBe(true);
    expect(temporaryEntries).toEqual([]);
    expect(harness.completeWorkload).not.toHaveBeenCalled();
  });

  it('keeps the controlled failure code daemon-authored', async () => {
    const harness = clientHarness();
    await executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"controlled-failure","delayMs":0}',
      abortController: new AbortController(),
    });

    expect(harness.completeWorkload.mock.calls[0]?.[0]).not.toHaveProperty('error_message');
    expect(harness.taskPatch).not.toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        error_message: expect.any(String),
      })
    );
  });

  it('runs seeded CPU work and allows Stop to abort within the 25ms slice budget', async () => {
    const harness = clientHarness();
    const abortController = new AbortController();
    const startedAt = performance.now();
    const execution = executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"cpu","durationMs":1000,"seed":7}',
      abortController,
    });
    setTimeout(() => abortController.abort(), 8);
    await execution;

    expect(performance.now() - startedAt).toBeLessThanOrEqual(25);
    expect(harness.completeWorkload).not.toHaveBeenCalled();
    expect(harness.taskPatch).not.toHaveBeenCalled();
  });

  it('returns a bounded CPU result with the seed and stable checksum shape', async () => {
    const harness = clientHarness();
    await executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"cpu","durationMs":10,"seed":7}',
      abortController: new AbortController(),
    });

    expect(harness.completeWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: 'cpu',
        requested_duration_ms: 10,
        seed: 7,
        iterations: expect.any(Number),
        checksum: expect.stringMatching(/^[0-9a-f]{8}$/),
      })
    );
  });

  it('writes, reads, hashes, and unconditionally cleans task-private temporary storage', async () => {
    const harness = clientHarness();
    const prompt = '{"schemaVersion":1,"profile":"temporary-io","bytes":257,"seed":11}';
    await executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt,
      abortController: new AbortController(),
    });

    const temporaryEntries = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith(`${WORKLOAD_TEMP_PREFIX}task-1-`)
    );
    expect(temporaryEntries).toEqual([]);
    expect(harness.completeWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: 'temporary-io',
        requested_bytes: 257,
        seed: 11,
        bytes_written: 257,
        bytes_read: 257,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    );
    const firstCompletion = harness.completeWorkload.mock.calls[0]?.[0] as { sha256: string };
    const secondHarness = clientHarness();
    await executeWorkloadTask({
      client: secondHarness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt,
      abortController: new AbortController(),
    });
    const secondCompletion = secondHarness.completeWorkload.mock.calls[0]?.[0] as {
      sha256: string;
    };
    expect(secondCompletion.sha256).toBe(firstCompletion.sha256);
  });

  it('runs only the fixed bundled compile/test fixture', async () => {
    const harness = clientHarness();
    await executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"compile-test","repetitions":3,"totalTimeMs":100}',
      abortController: new AbortController(),
    });

    expect(harness.completeWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: 'compile-test',
        requested_repetitions: 3,
        requested_total_time_ms: 100,
        observed_repetitions: 3,
      })
    );
  });

  it('runs the disposable fixed command fixture through the bounded completion seam', async () => {
    const harness = clientHarness();
    await executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"fixture-command","repetitions":2}',
      workspaceCwd: process.cwd(),
      abortController: new AbortController(),
    });

    const completion = harness.completeWorkload.mock.calls[0]?.[0];
    expect(completion).toMatchObject({
      task_id: 'task-1',
      profile: 'fixture-command',
      requested_repetitions: 2,
      fixture_id: 'node-compile-test-v1',
      outcome: 'completed',
      completed_command_count: 4,
      cleanup_confirmed: true,
      commands: [
        { command: 'node-check', attempted: 2, completed: 2, outcome: 'passed', exit_code: 0 },
        { command: 'node-test', attempted: 2, completed: 2, outcome: 'passed', exit_code: 0 },
      ],
    });
    expect(JSON.stringify(completion)).not.toContain(process.cwd());
    expect(JSON.stringify(completion)).not.toContain('subject.mjs');
    expect(JSON.stringify(completion)).not.toContain('process.env');
    expect(Buffer.byteLength(JSON.stringify(completion))).toBeLessThan(4 * 1024);
    expect(harness.taskPatch).not.toHaveBeenCalled();
  });

  it('publishes workspace inspection through the normal bounded completion path', async () => {
    const harness = clientHarness();
    await executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt: '{"schemaVersion":1,"profile":"workspace-inspection"}',
      workspaceCwd: join(process.cwd(), '../..'),
      abortController: new AbortController(),
    });

    expect(harness.completeWorkload).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: 'task-1',
        profile: 'workspace-inspection',
        inspection: expect.objectContaining({
          node: expect.objectContaining({ state: 'available' }),
          repositoryMarkerPresent: true,
        }),
      })
    );
    expect(
      Buffer.byteLength(JSON.stringify(harness.completeWorkload.mock.calls[0]?.[0]))
    ).toBeLessThan(4 * 1024);
  });

  it.each([
    ['wait', '{"schemaVersion":1,"profile":"wait","durationMs":100}'],
    ['controlled-failure', '{"schemaVersion":1,"profile":"controlled-failure"}'],
    ['cpu', '{"schemaVersion":1,"profile":"cpu","durationMs":10,"seed":1}'],
    ['temporary-io', '{"schemaVersion":1,"profile":"temporary-io","bytes":8,"seed":1}'],
    [
      'compile-test',
      '{"schemaVersion":1,"profile":"compile-test","repetitions":1,"totalTimeMs":100}',
    ],
    ['workspace-inspection', '{"schemaVersion":1,"profile":"workspace-inspection"}'],
    ['fixture-command', '{"schemaVersion":1,"profile":"fixture-command"}'],
  ] as const)('does not use public network access for the %s profile', async (_profile, prompt) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network denied'));
    const harness = clientHarness();
    await executeWorkloadTask({
      client: harness.client,
      sessionId: 'session-1' as never,
      taskId: 'task-1' as never,
      prompt,
      ...(_profile === 'workspace-inspection' ? { workspaceCwd: process.cwd() } : {}),
      abortController: new AbortController(),
    });

    expect(fetch).not.toHaveBeenCalled();
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
