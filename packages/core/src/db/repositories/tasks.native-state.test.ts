/**
 * Hosted OpenCode native-state publication through the task completion
 * transition (`context/explorations/opencode-cloud.md` §5 step 5).
 */

import type { Task, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { ownedDbTest as dbTest } from '../test-helpers';
import { RepositoryError } from './base';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';

let branchCounter = 1;

async function createSession(db: Database): Promise<UUID> {
  const repo = await new RepoRepository(db).create({
    repo_id: generateId(),
    slug: `native-state-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test',
    default_branch: 'main',
  });
  const branch = await new BranchRepository(db).create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'test-branch',
    ref: 'main',
    branch_unique_id: branchCounter++,
    path: '/tmp/test/branch',
    created_by: 'test-user' as UUID,
  });
  const session = await new SessionRepository(db).create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'opencode',
    created_by: 'test-user' as UUID,
  });
  return session.session_id;
}

async function runningTask(db: Database, sessionId: UUID): Promise<Task> {
  const taskRepo = new TaskRepository(db);
  const created = await taskRepo.create({
    task_id: generateId(),
    session_id: sessionId,
    created_by: 'test-user',
    full_prompt: 'Continue',
    status: TaskStatus.DISPATCHING,
    message_range: { start_index: 0, end_index: 0, start_timestamp: new Date().toISOString() },
    tool_use_count: 0,
    git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
  });
  const connection = await taskRepo.connectExecutor(created.task_id);
  if (!connection) throw new Error('executor connection failed');
  return connection.task;
}

function attemptFor(task: Task, overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    attemptTaskId: task.task_id,
    digest: `sha256:${'b'.repeat(64)}`,
    bytes: 167936,
    openCodeSessionId: 'ses_accepted',
    publishedAt: '2026-09-10T22:18:55.000Z',
    ...overrides,
  };
}

describe('TaskRepository.completeWithNativeStatePublication', () => {
  dbTest('publishes the pointer and native session id together with completion', async ({ db }) => {
    const sessionId = await createSession(db);
    const task = await runningTask(db, sessionId);
    const attempt = attemptFor(task);

    const completed = await new TaskRepository(db).completeWithNativeStatePublication(
      task.task_id,
      { status: TaskStatus.COMPLETED, native_state_attempt: attempt }
    );

    expect(completed.status).toBe(TaskStatus.COMPLETED);
    expect(completed.native_state_attempt).toEqual(attempt);
    const session = await new SessionRepository(db).findById(sessionId);
    expect(session?.sdk_native_state).toEqual(attempt);
    expect(session?.sdk_session_id).toBe('ses_accepted');
  });

  dbTest(
    'refuses a late publication once the task is terminal (stale writer fence)',
    async ({ db }) => {
      const sessionId = await createSession(db);
      const task = await runningTask(db, sessionId);
      const taskRepo = new TaskRepository(db);
      await taskRepo.updateFromExecutor(task.task_id, {
        status: TaskStatus.FAILED,
        error_message: 'force-failed',
      });

      await expect(
        taskRepo.completeWithNativeStatePublication(task.task_id, {
          status: TaskStatus.COMPLETED,
          native_state_attempt: attemptFor(task),
        })
      ).rejects.toThrow(RepositoryError);
      const session = await new SessionRepository(db).findById(sessionId);
      expect(session?.sdk_native_state).toBeUndefined();
      expect(session?.sdk_session_id).toBeUndefined();
      expect((await taskRepo.findById(task.task_id))?.status).toBe(TaskStatus.FAILED);
    }
  );

  dbTest(
    'rejects malformed pointers, foreign task ids, and non-completed statuses',
    async ({ db }) => {
      const sessionId = await createSession(db);
      const task = await runningTask(db, sessionId);
      const taskRepo = new TaskRepository(db);

      await expect(
        taskRepo.completeWithNativeStatePublication(task.task_id, {
          status: TaskStatus.COMPLETED,
          native_state_attempt: attemptFor(task, { digest: 'md5:nope' }) as never,
        })
      ).rejects.toThrow(/malformed/);
      await expect(
        taskRepo.completeWithNativeStatePublication(task.task_id, {
          status: TaskStatus.COMPLETED,
          native_state_attempt: attemptFor(task, { attemptTaskId: generateId() }),
        })
      ).rejects.toThrow(/must name the completing task/);
      await expect(
        taskRepo.completeWithNativeStatePublication(task.task_id, {
          status: TaskStatus.FAILED,
          native_state_attempt: attemptFor(task),
        })
      ).rejects.toThrow(/completed status/);
      expect((await taskRepo.findById(task.task_id))?.status).toBe(TaskStatus.RUNNING);
      expect(
        (await new SessionRepository(db).findById(sessionId))?.sdk_native_state
      ).toBeUndefined();
    }
  );
});
