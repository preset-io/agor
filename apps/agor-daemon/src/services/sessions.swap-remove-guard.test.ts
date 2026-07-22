/**
 * TOCTOU on the "Switch tool" swap: `canSwitchTool` is evaluated once when
 * the picker opens (session has zero tasks), but on a multiplayer canvas a
 * task can land on that same session — another tab, a collaborator, an MCP
 * `agor_sessions_prompt` call — before the swap *completes* and
 * `chooseAgenticTool` calls `sessions.remove(replacingSessionId)`. Without a
 * server-side re-check, that remove cascade-deletes the now-in-flight
 * session and its task with no confirmation.
 *
 * The client marks a swap-triggered removal via `query._swapReplace` so the
 * daemon can refuse *that* removal (Conflict) while leaving a normal,
 * user-intentional delete of a session with history unaffected.
 */
import {
  BranchRepository,
  generateId,
  RepoRepository,
  SessionRepository,
  TaskRepository,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { Session, Task, UUID } from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { SessionsService } from './sessions';

const STUB_APP = {} as unknown as Application;

async function createBranch(db: any): Promise<UUID> {
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId(),
    slug: `repo-${generateId()}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test-repo',
    default_branch: 'main',
  });
  const branch = await branchRepo.create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'feature',
    ref: 'feature',
    branch_unique_id: Math.floor(Math.random() * 1_000_000),
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
    created_by: 'test-user' as UUID,
  });
  return branch.branch_id as UUID;
}

async function createSession(
  db: any,
  branchId: UUID,
  overrides: Partial<Session> = {}
): Promise<UUID> {
  const sessionRepo = new SessionRepository(db);
  const session = await sessionRepo.create({
    session_id: generateId(),
    branch_id: branchId,
    agentic_tool: 'claude-code',
    status: SessionStatus.IDLE,
    created_by: 'test-user' as UUID,
    git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
    tasks: [],
    contextFiles: [],
    genealogy: { children: [] },
    ...overrides,
  });
  return session.session_id as UUID;
}

async function createTask(db: any, sessionId: UUID, overrides: Partial<Task> = {}): Promise<UUID> {
  const taskRepo = new TaskRepository(db);
  const task = await taskRepo.create({
    task_id: generateId(),
    session_id: sessionId,
    created_by: 'test-user' as UUID,
    full_prompt: 'Do a thing',
    status: TaskStatus.RUNNING,
    message_range: { start_index: 0, end_index: 2, start_timestamp: new Date().toISOString() },
    tool_use_count: 1,
    git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
    ...overrides,
  });
  return task.task_id as UUID;
}

describe('SessionsService.remove — swap-replace TOCTOU guard', () => {
  dbTest(
    'refuses a _swapReplace removal when a task has landed on the session since the swap was initiated',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const sessionId = await createSession(db, branchId);

      // Simulates the TOCTOU window: the picker opened while the session had
      // zero tasks, but a task lands (another tab / collaborator / MCP call)
      // before the swap's remove() call reaches the server.
      await createTask(db, sessionId);

      await expect(
        service.remove(sessionId, { query: { _swapReplace: true } } as any)
      ).rejects.toThrow(/gained.*task/i);

      const sessionRepo = new SessionRepository(db);
      const stillThere = await sessionRepo.findById(sessionId);
      expect(stillThere).not.toBeNull();
    }
  );

  dbTest('allows a _swapReplace removal when the session still has zero tasks', async ({ db }) => {
    const service = new SessionsService(db, STUB_APP);
    const branchId = await createBranch(db);
    const sessionId = await createSession(db, branchId);

    const removed = (await service.remove(sessionId, {
      query: { _swapReplace: true },
    } as any)) as Session;
    expect(removed.session_id).toBe(sessionId);

    const sessionRepo = new SessionRepository(db);
    expect(await sessionRepo.findById(sessionId)).toBeNull();
  });

  dbTest(
    'a normal (non-swap) delete of a session with tasks is unaffected — no confirmation gate added',
    async ({ db }) => {
      const service = new SessionsService(db, STUB_APP);
      const branchId = await createBranch(db);
      const sessionId = await createSession(db, branchId);
      await createTask(db, sessionId);

      // No `_swapReplace` marker — this is a user deleting a real session
      // with history via the normal delete affordance, which must keep
      // working exactly as before.
      const removed = (await service.remove(sessionId)) as Session;
      expect(removed.session_id).toBe(sessionId);

      const sessionRepo = new SessionRepository(db);
      expect(await sessionRepo.findById(sessionId)).toBeNull();
    }
  );
});
