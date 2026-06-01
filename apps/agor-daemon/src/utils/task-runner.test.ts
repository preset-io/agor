/**
 * Behavior tests for the helpers behind `POST /tasks/:id/run` (issue #1118).
 *
 * The route handler in `register-routes.ts` does parse + early validation +
 * RBAC + acquires `withSessionTurnLock`, then delegates to `runExistingTask`,
 * which re-validates task status under the lock. These tests pin the
 * revalidation contract — the part most likely to drift.
 */
import { Conflict, NotFound } from '@agor/core/feathers';
import type { Params, Task, TaskID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  normalizeMessageSource,
  type RunExistingTaskOptions,
  runExistingTask,
} from './task-runner';

const fakeTask = (overrides: Partial<Task> = {}): Task =>
  ({
    task_id: 'task-aaaa1111' as TaskID,
    session_id: 'session-bbbb2222',
    created_by: 'user-1',
    full_prompt: 'do the thing',
    status: TaskStatus.CREATED,
    tool_use_count: 0,
    message_range: {
      start_index: -1,
      end_index: -1,
      start_timestamp: '2026-05-09T00:00:00.000Z',
    },
    git_state: { ref_at_start: '', sha_at_start: '' },
    created_at: '2026-05-09T00:00:00.000Z',
    ...overrides,
  }) as Task;

const baseOptions: RunExistingTaskOptions = { stream: true };
const baseParams: Params = { provider: 'rest' };

describe('runExistingTask', () => {
  it('hands a CREATED task off to spawnFn after re-fetching it', async () => {
    const task = fakeTask();
    const spawnFn = vi.fn(async (t: Task) => ({ ...t, status: TaskStatus.RUNNING }) as Task);
    const findTaskById = vi.fn(async () => task);

    const result = await runExistingTask(task, baseOptions, baseParams, {
      findTaskById,
      spawnFn,
    });

    expect(findTaskById).toHaveBeenCalledWith(task.task_id);
    expect(spawnFn).toHaveBeenCalledWith(task, baseOptions, baseParams);
    expect(result.status).toBe(TaskStatus.RUNNING);
  });

  it('throws NotFound if the task disappears between route lookup and claim', async () => {
    const task = fakeTask();
    const spawnFn = vi.fn();
    const findTaskById = vi.fn(async () => null);

    await expect(
      runExistingTask(task, baseOptions, baseParams, {
        findTaskById,
        spawnFn,
      })
    ).rejects.toBeInstanceOf(NotFound);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('throws Conflict if the task moved away from CREATED before revalidation', async () => {
    const task = fakeTask();
    const drained: Task = { ...task, status: TaskStatus.RUNNING } as Task;
    const spawnFn = vi.fn();
    const findTaskById = vi.fn(async () => drained);

    await expect(
      runExistingTask(task, baseOptions, baseParams, {
        findTaskById,
        spawnFn,
      })
    ).rejects.toBeInstanceOf(Conflict);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('throws Conflict if the task became QUEUED mid-claim', async () => {
    const task = fakeTask();
    const queued: Task = { ...task, status: TaskStatus.QUEUED } as Task;
    const spawnFn = vi.fn();
    const findTaskById = vi.fn(async () => queued);

    await expect(
      runExistingTask(task, baseOptions, baseParams, {
        findTaskById,
        spawnFn,
      })
    ).rejects.toBeInstanceOf(Conflict);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('propagates spawnFn errors unchanged', async () => {
    const task = fakeTask();
    const spawnFn = vi.fn(async () => {
      throw new Error('executor blew up');
    });
    const findTaskById = vi.fn(async () => task);

    await expect(
      runExistingTask(task, baseOptions, baseParams, {
        findTaskById,
        spawnFn,
      })
    ).rejects.toThrow('executor blew up');
  });
});

describe('normalizeMessageSource', () => {
  it('passes through valid values', () => {
    expect(normalizeMessageSource('agor', { provider: 'rest' })).toBe('agor');
    expect(normalizeMessageSource('gateway', { provider: 'rest' })).toBe('gateway');
  });

  it('returns undefined for undefined input', () => {
    expect(normalizeMessageSource(undefined, { provider: 'rest' })).toBeUndefined();
  });

  it('falls back to "agor" for invalid values from external callers', () => {
    expect(normalizeMessageSource('bogus' as unknown as 'agor', { provider: 'rest' })).toBe('agor');
  });

  it('falls back to undefined for invalid values from internal calls', () => {
    expect(normalizeMessageSource('bogus' as unknown as 'agor', {})).toBeUndefined();
  });
});
