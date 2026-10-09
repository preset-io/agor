/**
 * Session.tasks is the dispatch log the lean transcript places history by:
 * only the Task repository's dispatch claim appends to it. The dispatch vs.
 * settings-patch race is proven in sessions.tasks-dispatch.postgres.test.ts.
 */
import type { AgorConfig } from '@agor/core/config';
import {
  BranchRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  type TenantScopeAwareDatabase,
  UsersRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import { type TaskID, TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { generateId } from '../../../../packages/core/src/lib/ids';
import { SessionsService } from './sessions';

async function fixture(db: TenantScopeAwareDatabase) {
  const user = await new UsersRepository(db).create({
    email: `${generateId()}-session-tasks@example.com`,
    name: 'Session tasks owner',
  });
  const repo = await new RepoRepository(db).create({
    slug: `session-tasks-${generateId()}`,
    name: 'Session tasks repo',
    repo_type: 'remote',
    remote_url: 'https://example.com/session-tasks.git',
    local_path: `/tmp/${generateId()}`,
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    repo_id: repo.repo_id,
    name: `session-tasks-${generateId()}`,
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: `/tmp/${generateId()}`,
    base_ref: 'main',
    new_branch: false,
    created_by: user.user_id,
  });
  const session = await new SessionRepository(db).create({
    branch_id: branch.branch_id,
    created_by: user.user_id,
    agentic_tool: 'claude-code',
  });
  const config = { execution: { unix_user_mode: 'simple' } } as AgorConfig;
  const app = {
    get: (key: string) => (key === 'config' ? config : undefined),
  } as unknown as Application;
  return { user, branch, session, service: new SessionsService(db, app) };
}

/** Admit one queued prompt and claim its dispatch, as the queue drain does. */
async function dispatch(tasks: TaskRepository, sessionId: string, createdBy: string) {
  const task = await tasks.createPending({
    session_id: sessionId as never,
    created_by: createdBy,
    full_prompt: 'turn',
    status: TaskStatus.QUEUED,
  });
  return {
    task,
    claim: () =>
      tasks.claimDispatchAndProjectSession(task.task_id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      }),
  };
}

describe('Session.tasks is server-managed', () => {
  dbTest(
    'rejects tasks on patch and update from every caller, metadata-authorized or internal',
    async ({ db }) => {
      const f = await fixture(db);
      const tasks = new TaskRepository(db);
      const turn = await dispatch(tasks, f.session.session_id, f.user.user_id);
      expect((await turn.claim()).outcome).toBe('claimed');
      const listed = [turn.task.task_id];
      const replaced = [generateId(), generateId()];
      for (const params of [undefined, { provider: 'rest' }, { provider: 'socketio' }] as const) {
        await expect(
          f.service.patch(f.session.session_id, { tasks: replaced } as never, params as never)
        ).rejects.toThrow(/tasks is server-managed/);
        // Mixed with metadata (the 'all' tier path) or an empty list: still refused.
        await expect(
          f.service.patch(f.session.session_id, { title: 'x', tasks: [] } as never, params as never)
        ).rejects.toThrow(/tasks is server-managed/);
        await expect(
          f.service.update(f.session.session_id, { tasks: replaced } as never, params as never)
        ).rejects.toThrow(/tasks is server-managed/);
      }
      const after = await new SessionRepository(db).findById(f.session.session_id);
      expect(after?.tasks).toEqual(listed);
      expect(after?.title).toBe(f.session.title);
    }
  );

  dbTest(
    'starts a Session with no dispatched Tasks; a non-empty list is refused',
    async ({ db }) => {
      const f = await fixture(db);
      await expect(
        f.service.create({
          branch_id: f.branch.branch_id,
          created_by: f.user.user_id,
          agentic_tool: 'claude-code',
          tasks: [generateId()],
        } as never)
      ).rejects.toThrow(/tasks is server-managed/);
    }
  );

  dbTest(
    'reports tasks_complete from one snapshot of Session.tasks and its Tasks',
    async ({ db }) => {
      const f = await fixture(db);
      const other = await fixture(db);
      const tasks = new TaskRepository(db);
      const sessions = new SessionRepository(db);
      const turn = async (sessionId: string, status: TaskStatus) =>
        (await tasks.create({ session_id: sessionId as never, created_by: f.user.user_id, status }))
          .task_id;
      const [a, b] = [
        await turn(f.session.session_id, TaskStatus.COMPLETED),
        await turn(f.session.session_id, TaskStatus.FAILED),
      ];
      // Never run: no position by design.
      await turn(f.session.session_id, TaskStatus.CREATED);
      await turn(f.session.session_id, TaskStatus.QUEUED);
      const foreign = await turn(other.session.session_id, TaskStatus.COMPLETED);
      // Legacy rows: written directly, as older daemons let callers do.
      const completeWith = async (listed: string[]) => {
        await sessions.update(f.session.session_id, { tasks: listed as TaskID[] });
        return (
          await f.service.get(f.session.session_id, { query: { include_tasks_complete: true } })
        ).tasks_complete;
      };

      expect(await completeWith([a, b])).toBe(true);
      expect((await f.service.get(f.session.session_id)).tasks_complete).toBeUndefined();
      expect(await completeWith([a])).toBe(false); // a dispatched Task is unlisted
      expect(await completeWith([a, b, generateId()])).toBe(false); // names no Task
      expect(await completeWith([a, b, b])).toBe(false); // duplicate
      expect(await completeWith([a, foreign])).toBe(false); // another Session's Task
      expect(await completeWith([a, b, foreign])).toBe(false);
      // NULL makes `NOT IN` unknown, so it must not hide the omitted run Task b.
      expect(await completeWith([a, null as unknown as string])).toBe(false);

      // A dispatch between the row read and the check extends the list: the
      // row's list is a prefix of the snapshot's, so it was complete.
      await sessions.update(f.session.session_id, { tasks: [a, b] });
      expect(await tasks.isSessionTaskListComplete(f.session.session_id, [a])).toBe(true);
      expect(await tasks.isSessionTaskListComplete(f.session.session_id, [b])).toBe(false);
      expect(await tasks.isSessionTaskListComplete(generateId() as never, [])).toBe(false);
    }
  );
});
