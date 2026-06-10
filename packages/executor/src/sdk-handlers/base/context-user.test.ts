import { describe, expect, it, vi } from 'vitest';
import type { TaskID } from '../../types.js';
import { resolveContextUserId } from './context-user';

describe('resolveContextUserId', () => {
  it('prefers the task creator over the session owner', async () => {
    const tasksService = { get: vi.fn().mockResolvedValue({ created_by: 'prompter' }) };

    const result = await resolveContextUserId({
      session: { created_by: 'owner' },
      taskId: 'task-1' as TaskID,
      tasksService: tasksService as never,
    });

    expect(tasksService.get).toHaveBeenCalledWith('task-1');
    expect(result).toBe('prompter');
  });

  it('falls back to the session owner when there is no task id', async () => {
    const tasksService = { get: vi.fn() };

    const result = await resolveContextUserId({
      session: { created_by: 'owner' },
      tasksService: tasksService as never,
    });

    expect(tasksService.get).not.toHaveBeenCalled();
    expect(result).toBe('owner');
  });

  it('falls back to the session owner when the task lookup throws', async () => {
    const tasksService = { get: vi.fn().mockRejectedValue(new Error('not found')) };

    const result = await resolveContextUserId({
      session: { created_by: 'owner' },
      taskId: 'task-1' as TaskID,
      tasksService: tasksService as never,
    });

    expect(result).toBe('owner');
  });

  it('falls back to the session owner when the task has no creator', async () => {
    const tasksService = { get: vi.fn().mockResolvedValue({ created_by: null }) };

    const result = await resolveContextUserId({
      session: { created_by: 'owner' },
      taskId: 'task-1' as TaskID,
      tasksService: tasksService as never,
    });

    expect(result).toBe('owner');
  });

  it('returns undefined when neither task creator nor session owner is known', async () => {
    const result = await resolveContextUserId({
      session: { created_by: null },
    });

    expect(result).toBeUndefined();
  });
});
