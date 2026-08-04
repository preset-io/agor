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
    ).resolves.toBeUndefined();

    expect(reportExecutorSettlement).toHaveBeenCalledWith({
      task_id: 't1',
      kind: 'quiesced',
      result: 'failure',
      failure_cause: 'runtime_failure',
      task_patch: { error_message: 'boom', model: 'test-model' },
    });
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
