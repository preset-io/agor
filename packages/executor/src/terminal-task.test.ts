import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgorClient } from './services/feathers-client.js';
import {
  awaitRuntimeCleanup,
  finalizeTask,
  requestContainment,
  tryRequestContainment,
} from './terminal-task.js';

function makeClient(status: TaskStatus = TaskStatus.RUNNING) {
  const reportExecutorSettlement = vi.fn(async () => ({ status }));
  const client = {
    service: vi.fn((name: string) => {
      if (name !== 'tasks') throw new Error(`unexpected service: ${name}`);
      return { reportExecutorSettlement };
    }),
  } as unknown as AgorClient;
  return { client, reportExecutorSettlement };
}

describe('executor settlement reporting', () => {
  it('reports a quiesced outcome without lifecycle timing fields', async () => {
    const { client, reportExecutorSettlement } = makeClient(TaskStatus.FAILED);

    await expect(
      finalizeTask(client, 't1', {
        result: 'failure',
        failureCause: 'runtime_failure',
        taskPatch: { error_message: 'boom', model: 'test-model' },
      })
    ).resolves.toEqual({ status: TaskStatus.FAILED });

    expect(reportExecutorSettlement).toHaveBeenCalledWith({
      task_id: 't1',
      kind: 'quiesced',
      result: 'failure',
      failure_cause: 'runtime_failure',
      task_patch: { error_message: 'boom', model: 'test-model' },
    });
  });

  it('sanitizes and bounds durable failure diagnostics before settlement', async () => {
    const { client, reportExecutorSettlement } = makeClient(TaskStatus.FAILED);
    const secret = 'secret-opencode-tool-result';
    const databaseFailure = Object.assign(
      new Error(`Failed query: update tasks set data=$1 params: ${secret}`),
      {
        query: 'update tasks set data=$1',
        params: [secret],
        cause: { code: '22P05' },
      }
    );

    await finalizeTask(client, 't1', {
      result: 'failure',
      failureCause: 'runtime_failure',
      taskPatch: { error_message: databaseFailure.message },
      error: databaseFailure,
    });

    const databaseSettlement = reportExecutorSettlement.mock.calls[0]?.[0];
    expect(databaseSettlement?.task_patch?.error_message).toBe('Database operation failed (22P05)');
    expect(JSON.stringify(databaseSettlement)).not.toContain(secret);
    expect(JSON.stringify(databaseSettlement)).not.toContain('update tasks');

    const oversizedFailure = new Error('x'.repeat(2_000));
    await finalizeTask(client, 't2', {
      result: 'failure',
      failureCause: 'runtime_failure',
      taskPatch: { error_message: oversizedFailure.message },
      error: oversizedFailure,
    });

    const oversizedDiagnostic =
      reportExecutorSettlement.mock.calls[1]?.[0].task_patch?.error_message;
    expect(oversizedDiagnostic).toHaveLength(1_024);
    expect(oversizedDiagnostic).toMatch(/…$/);
  });

  it('requests containment instead of terminality when cleanup is uncertain', async () => {
    const { client, reportExecutorSettlement } = makeClient(TaskStatus.STOPPING);

    await requestContainment(client, 't1', new Error('cancel failed'));

    expect(reportExecutorSettlement).toHaveBeenCalledWith({
      task_id: 't1',
      kind: 'containment_required',
      error_message: expect.stringContaining('cancel failed'),
    });
  });

  it('sanitizes database details before requesting containment', async () => {
    const { client, reportExecutorSettlement } = makeClient(TaskStatus.STOPPING);
    const secret = 'secret-runtime-result';
    const failure = Object.assign(new Error(`Failed query: update tasks params: ${secret}`), {
      query: 'update tasks',
      params: [secret],
      cause: { code: '22P05' },
    });

    await requestContainment(client, 't1', failure);

    const persisted = JSON.stringify(reportExecutorSettlement.mock.calls);
    expect(persisted).toContain('Database operation failed (22P05)');
    expect(persisted).not.toContain(secret);
    expect(persisted).not.toContain('update tasks');
  });

  it('surfaces cooperative reporting errors and swallows only fail-safe containment reports', async () => {
    const reportExecutorSettlement = vi.fn().mockRejectedValue(new Error('socket closed'));
    const client = { service: () => ({ reportExecutorSettlement }) } as unknown as AgorClient;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      finalizeTask(client, 't1', { result: 'failure', failureCause: 'runtime_failure' })
    ).rejects.toThrow('socket closed');
    await expect(tryRequestContainment(client, 't1', new Error('boom'))).resolves.toBeUndefined();
  });
});

describe('awaitRuntimeCleanup', () => {
  it('resolves completed cleanup and rejects an expired cleanup deadline', async () => {
    await expect(awaitRuntimeCleanup(Promise.resolve(), 10, 'test')).resolves.toBeUndefined();
    await expect(awaitRuntimeCleanup(new Promise(() => {}), 1, 'test')).rejects.toThrow(
      'test cleanup exceeded 1ms'
    );
  });
});
