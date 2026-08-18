import type { Task } from '@agor/core/types';
import { EXECUTING_TASK_STATUSES, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { findActiveTasksForSession, findHostTaskForSession } from './session-tasks.js';

function task(taskId: string, status: Task['status'], createdAt: string): Task {
  return {
    task_id: taskId,
    session_id: 'session-long',
    status,
    created_at: createdAt,
  } as Task;
}

describe('Session Task targeting', () => {
  it('finds a newest active Task without scanning a capped historical page', async () => {
    const active = task('task-active-newest', TaskStatus.RUNNING, '2026-08-14T10:00:00.000Z');
    const find = vi.fn(async ({ query }: { query: Record<string, unknown> }) => ({
      total: query.status === TaskStatus.RUNNING ? 1 : 0,
      limit: 1,
      skip: 0,
      data: query.status === TaskStatus.RUNNING ? [active] : [],
    }));
    const app = { service: () => ({ find }) } as never;

    await expect(
      findActiveTasksForSession(app, 'session-long' as never, { provider: 'rest' })
    ).resolves.toEqual([active]);
    expect(find).toHaveBeenCalledTimes(EXECUTING_TASK_STATUSES.size);
    for (const status of EXECUTING_TASK_STATUSES) {
      expect(find).toHaveBeenCalledWith({
        provider: 'rest',
        query: {
          session_id: 'session-long',
          status,
          $sort: { created_at: -1, task_id: -1 },
          $limit: 1,
          $skip: 0,
        },
      });
    }
  });

  it('uses one targeted newest-Task fallback when no executor-owned Task exists', async () => {
    const latest = task('task-latest', TaskStatus.COMPLETED, '2026-08-14T10:00:00.000Z');
    const find = vi.fn(async ({ query }: { query: Record<string, unknown> }) => ({
      total: query.status ? 0 : 1,
      limit: 1,
      skip: 0,
      data: query.status ? [] : [latest],
    }));

    await expect(
      findHostTaskForSession({ service: () => ({ find }) } as never, 'session-long' as never, {
        provider: 'rest',
      })
    ).resolves.toEqual(latest);
    expect(find).toHaveBeenLastCalledWith({
      provider: 'rest',
      query: {
        session_id: 'session-long',
        $sort: { created_at: -1, task_id: -1 },
        $limit: 1,
        $skip: 0,
      },
    });
  });
});
