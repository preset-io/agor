/**
 * Behavior tests for the helpers behind `POST /tasks/:id/run` (issue #1118).
 *
 * The route handler in `register-routes.ts` does parse + early validation +
 * RBAC and then delegates to `claimAndRunExistingTask`, which is the
 * race-protected, status-revalidating layer above `spawnTaskExecutor`.
 * These tests pin its concurrency contract — the part most likely to drift.
 */
import { Conflict, NotFound } from '@agor/core/feathers';
import type { Params, Task, TaskID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type ClaimAndRunDeps,
  type ClaimAndRunOptions,
  claimAndRunExistingTask,
  normalizeMessageSource,
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

const baseOptions: ClaimAndRunOptions = { stream: true };
const baseParams: Params = { provider: 'rest' };

describe('claimAndRunExistingTask', () => {
  it('hands a CREATED task off to spawnFn after re-fetching it', async () => {
    const task = fakeTask();
    const spawnFn = vi.fn(async (t: Task) => ({ ...t, status: TaskStatus.RUNNING }) as Task);
    const findTaskById = vi.fn(async () => task);
    const locks = new Map<TaskID, Promise<void>>();

    const result = await claimAndRunExistingTask(task, baseOptions, baseParams, {
      findTaskById,
      spawnFn,
      locks,
    });

    expect(findTaskById).toHaveBeenCalledWith(task.task_id);
    expect(spawnFn).toHaveBeenCalledWith(task, baseOptions, baseParams);
    expect(result.status).toBe(TaskStatus.RUNNING);
    expect(locks.size).toBe(0);
  });

  it('rejects a concurrent claim for the same task with Conflict', async () => {
    const task = fakeTask();
    let releaseSpawn!: () => void;
    const spawnFn = vi.fn(
      () =>
        new Promise<Task>((resolve) => {
          releaseSpawn = () => resolve({ ...task, status: TaskStatus.RUNNING });
        })
    );
    const findTaskById = vi.fn(async () => task);
    const locks = new Map<TaskID, Promise<void>>();

    const deps: ClaimAndRunDeps = { findTaskById, spawnFn, locks };

    // First call enters the lock and parks inside spawnFn.
    const first = claimAndRunExistingTask(task, baseOptions, baseParams, deps);
    // Yield once so the lock is registered before the second call observes it.
    await Promise.resolve();
    await Promise.resolve();

    await expect(
      claimAndRunExistingTask(task, baseOptions, baseParams, deps)
    ).rejects.toBeInstanceOf(Conflict);

    // Let the first call finish and verify the lock was released.
    releaseSpawn();
    await first;
    expect(locks.size).toBe(0);
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('releases the lock after spawnFn throws', async () => {
    const task = fakeTask();
    const spawnFn = vi.fn(async () => {
      throw new Error('executor blew up');
    });
    const findTaskById = vi.fn(async () => task);
    const locks = new Map<TaskID, Promise<void>>();

    await expect(
      claimAndRunExistingTask(task, baseOptions, baseParams, {
        findTaskById,
        spawnFn,
        locks,
      })
    ).rejects.toThrow('executor blew up');
    expect(locks.size).toBe(0);
  });

  it('throws NotFound if the task disappears between route lookup and claim', async () => {
    const task = fakeTask();
    const spawnFn = vi.fn();
    const findTaskById = vi.fn(async () => null);
    const locks = new Map<TaskID, Promise<void>>();

    await expect(
      claimAndRunExistingTask(task, baseOptions, baseParams, {
        findTaskById,
        spawnFn,
        locks,
      })
    ).rejects.toBeInstanceOf(NotFound);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(locks.size).toBe(0);
  });

  it('throws Conflict if the task moved away from CREATED mid-claim', async () => {
    const task = fakeTask();
    const drained: Task = { ...task, status: TaskStatus.QUEUED } as Task;
    const spawnFn = vi.fn();
    const findTaskById = vi.fn(async () => drained);
    const locks = new Map<TaskID, Promise<void>>();

    await expect(
      claimAndRunExistingTask(task, baseOptions, baseParams, {
        findTaskById,
        spawnFn,
        locks,
      })
    ).rejects.toBeInstanceOf(Conflict);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(locks.size).toBe(0);
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
