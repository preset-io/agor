import { PAGINATION } from '@agor/core/config';
import { feathers } from '@agor/core/feathers';
import type { Paginated, SessionID, Task, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { BranchRepository } from '../../../../packages/core/src/db/repositories/branches';
import { RepoRepository } from '../../../../packages/core/src/db/repositories/repos';
import { SessionRepository } from '../../../../packages/core/src/db/repositories/sessions';
import { TaskRepository } from '../../../../packages/core/src/db/repositories/tasks';
import { UsersRepository } from '../../../../packages/core/src/db/repositories/users';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { createTasksService } from './tasks';

async function createTestSession(db: Parameters<typeof dbTest>[0]['db']): Promise<SessionID> {
  const createdBy = generateId() as UUID;
  await new UsersRepository(db).create({
    user_id: createdBy,
    email: `${createdBy}@tasks.test`,
  });
  const repo = await new RepoRepository(db).create({
    slug: `tasks-page-${generateId()}`,
    name: 'Tasks pagination test',
    repo_type: 'remote',
    remote_url: 'https://example.invalid/tasks.git',
    local_path: `/tmp/tasks-page-${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    name: `tasks-page-${generateId()}`,
    path: `/tmp/tasks-page-branch-${generateId()}`,
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    created_by: createdBy,
  });
  const session = await new SessionRepository(db).create({
    branch_id: branch.branch_id,
    title: 'Tasks pagination test',
    created_by: createdBy,
  });
  return session.session_id;
}

describe('TasksService.find pagination', () => {
  dbTest('composes filters/order in SQL before returning one bounded page', async ({ db }) => {
    const sessionId = await createTestSession(db);
    const otherSessionId = await createTestSession(db);
    const repository = new TaskRepository(db);
    const expected: Task[] = [];
    for (let index = 0; index < 12; index += 1) {
      expected.push(
        await repository.create({
          session_id: sessionId,
          full_prompt: `Task ${index}`,
          status: index % 2 === 0 ? TaskStatus.COMPLETED : TaskStatus.FAILED,
          created_by: generateId() as UUID,
        })
      );
    }
    await repository.create({
      session_id: otherSessionId,
      full_prompt: 'Other Session',
      status: TaskStatus.COMPLETED,
      created_by: generateId() as UUID,
    });

    const execute = vi.spyOn(
      (db as unknown as { $client: { execute: (...args: unknown[]) => Promise<unknown> } }).$client,
      'execute'
    );
    const service = createTasksService(db, feathers());
    const result = (await service.find({
      query: {
        session_id: sessionId,
        status: TaskStatus.COMPLETED,
        $sort: { task_id: 1 },
        $limit: 2,
        $skip: 1,
      },
    })) as Paginated<Task>;

    const expectedIds = expected
      .filter((task) => task.status === TaskStatus.COMPLETED)
      .sort((left, right) => left.task_id.localeCompare(right.task_id))
      .slice(1, 3)
      .map((task) => task.task_id);
    expect(result).toMatchObject({ total: 6, limit: 2, skip: 1 });
    expect(result.data.map((task) => task.task_id)).toEqual(expectedIds);
    expect(
      execute.mock.calls.some(
        ([query]) => /tasks/i.test(JSON.stringify(query)) && /limit/i.test(JSON.stringify(query))
      )
    ).toBe(true);
  });

  dbTest('allows deep offsets only for exact Session hydration', async ({ db }) => {
    const service = createTasksService(db, feathers());
    await expect(
      service.find({ query: { $skip: PAGINATION.MAX_LIMIT + 1, $limit: 1 } })
    ).rejects.toThrow('Deep Task pagination requires an exact session_id filter');
  });

  dbTest('filters by task creator before pagination', async ({ db }) => {
    const sessionId = await createTestSession(db);
    const repository = new TaskRepository(db);
    const creator = generateId() as UUID;
    const expected = await repository.create({
      session_id: sessionId,
      full_prompt: 'Own running task',
      status: TaskStatus.RUNNING,
      created_by: creator,
    });
    await repository.create({
      session_id: sessionId,
      full_prompt: 'Another user running task',
      status: TaskStatus.RUNNING,
      created_by: generateId() as UUID,
    });
    await repository.create({
      session_id: sessionId,
      full_prompt: 'Own completed task',
      status: TaskStatus.COMPLETED,
      created_by: creator,
    });

    const result = (await createTasksService(db, feathers()).find({
      query: { status: TaskStatus.RUNNING, created_by: creator },
    })) as Paginated<Task>;

    expect(result).toMatchObject({ total: 1 });
    expect(result.data.map((task) => task.task_id)).toEqual([expected.task_id]);
  });

  dbTest('walks exact Session Tasks with an immutable Task-ID keyset', async ({ db }) => {
    const sessionId = await createTestSession(db);
    const repository = new TaskRepository(db);
    const created = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        repository.create({
          session_id: sessionId,
          full_prompt: `Task ${index}`,
          created_by: generateId() as UUID,
        })
      )
    );
    const ids = created.map((task) => task.task_id).sort();
    const result = (await createTasksService(db, feathers()).find({
      query: {
        session_id: sessionId,
        task_id: { $gt: ids[0], $lte: ids[2] },
        $sort: { task_id: 1 },
        $limit: 10,
      },
    })) as Paginated<Task>;
    expect(result.data.map((task) => task.task_id)).toEqual(ids.slice(1));
  });
});
