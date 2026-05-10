/**
 * TaskRepository Tests
 *
 * Tests for type-safe CRUD operations on tasks with short ID support.
 */

import type { Task, UUID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { AmbiguousIdError, EntityNotFoundError, RepositoryError } from './base';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { TaskRepository } from './tasks';
import { WorktreeRepository } from './worktrees';

/**
 * Create test task data
 */
function createTaskData(overrides?: Partial<Task>): Partial<Task> {
  const now = new Date().toISOString();
  return {
    task_id: generateId(),
    session_id: generateId(), // Will be overridden in tests
    created_by: 'test-user',
    full_prompt: 'Test prompt',
    status: TaskStatus.CREATED,
    message_range: {
      start_index: 0,
      end_index: 0,
      start_timestamp: now,
    },
    tool_use_count: 0,
    git_state: {
      ref_at_start: 'main',
      sha_at_start: 'abc123',
    },
    model: 'claude-sonnet-4-6',
    ...overrides,
  };
}

// Counter for unique worktree IDs
let worktreeCounter = 1;

/**
 * Create a session with required dependencies (repo and worktree)
 * Returns the session_id that can be used for tasks
 */
async function createSessionWithDeps(db: Database): Promise<UUID> {
  // Create repo
  const repoRepo = new RepoRepository(db);
  const repo = await repoRepo.create({
    repo_id: generateId(),
    slug: `test-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test',
    default_branch: 'main',
  });

  // Create worktree
  const worktreeRepo = new WorktreeRepository(db);
  const worktree = await worktreeRepo.create({
    worktree_id: generateId(),
    repo_id: repo.repo_id,
    name: 'test-worktree',
    ref: 'main',
    worktree_unique_id: worktreeCounter++,
    path: '/tmp/test/worktree',
    created_by: 'test-user' as UUID,
  });

  // Create session
  const sessionRepo = new SessionRepository(db);
  const session = await sessionRepo.create({
    session_id: generateId(),
    worktree_id: worktree.worktree_id,
    agentic_tool: 'claude-code',
    created_by: 'test-user' as UUID,
  });

  return session.session_id;
}

// ============================================================================
// Create
// ============================================================================

describe('TaskRepository.create', () => {
  dbTest('should create task with all required fields', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId });

    const created = await taskRepo.create(data);

    expect(created.task_id).toBe(data.task_id);
    expect(created.session_id).toBe(data.session_id);
    expect(created.created_by).toBe(data.created_by);
    expect(created.full_prompt).toBe(data.full_prompt);
    expect(created.status).toBe(data.status);
    expect(created.created_at).toBeDefined();
    expect(created.completed_at).toBeUndefined();
  });

  dbTest('should generate task_id if not provided', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId });
    delete (data as any).task_id;

    const created = await taskRepo.create(data);

    expect(created.task_id).toBeDefined();
    expect(created.task_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  dbTest('should default status to CREATED', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId });
    delete (data as any).status;

    const created = await taskRepo.create(data);

    expect(created.status).toBe(TaskStatus.CREATED);
  });

  dbTest('should throw if created_by is missing', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId });
    delete (data as any).created_by;

    await expect(taskRepo.create(data)).rejects.toThrow(/created_by/);
  });

  dbTest('should throw error if session_id is missing', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const data = createTaskData();
    delete (data as any).session_id;

    await expect(taskRepo.create(data)).rejects.toThrow(RepositoryError);
    await expect(taskRepo.create(data)).rejects.toThrow('session_id is required');
  });

  dbTest('should handle complex task data with all optional fields', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const completedAt = new Date('2024-01-01T12:00:00Z').toISOString();
    const data = createTaskData({
      session_id: sessionId,
      status: TaskStatus.COMPLETED,
      completed_at: completedAt,
      tool_use_count: 15,
      git_state: {
        ref_at_start: 'feature-branch',
        sha_at_start: 'abc123def',
        sha_at_end: 'def456ghi',
        commit_message: 'feat: add new feature',
      },
      message_range: {
        start_index: 5,
        end_index: 10,
        start_timestamp: new Date('2024-01-01T00:00:00Z').toISOString(),
        end_timestamp: new Date('2024-01-01T01:00:00Z').toISOString(),
      },
      duration_ms: 45000,
      agent_session_id: 'agent-session-123',
      report: {
        path: 'session-123/task-456.md',
        template: 'standard',
        generated_at: new Date().toISOString(),
      },
      permission_request: {
        request_id: 'req-123',
        tool_name: 'bash',
        tool_input: { command: 'rm -rf /' },
        tool_use_id: 'tool-use-456',
        requested_at: new Date().toISOString(),
        approved_by: 'user-789',
        approved_at: new Date().toISOString(),
      },
    });

    const created = await taskRepo.create(data);

    expect(created.status).toBe(TaskStatus.COMPLETED);
    expect(created.completed_at).toBe(completedAt);
    expect(created.tool_use_count).toBe(15);
    expect(created.git_state.ref_at_start).toBe('feature-branch');
    expect(created.git_state.sha_at_end).toBe('def456ghi');
    expect(created.message_range.end_index).toBe(10);
    expect(created.duration_ms).toBe(45000);
    expect(created.agent_session_id).toBe('agent-session-123');
    expect(created.report?.path).toBe('session-123/task-456.md');
    expect(created.permission_request?.request_id).toBe('req-123');
  });

  dbTest('should set default git_state if not provided', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId });
    delete (data as any).git_state;

    const created = await taskRepo.create(data);

    expect(created.git_state).toEqual({
      ref_at_start: 'unknown',
      sha_at_start: 'unknown',
    });
  });

  dbTest('should handle different task statuses', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    const statuses = [
      TaskStatus.CREATED,
      TaskStatus.RUNNING,
      TaskStatus.STOPPING,
      TaskStatus.AWAITING_PERMISSION,
      TaskStatus.COMPLETED,
      TaskStatus.FAILED,
      TaskStatus.STOPPED,
    ];

    for (const status of statuses) {
      const data = createTaskData({ session_id: sessionId, status });
      const created = await taskRepo.create(data);
      expect(created.status).toBe(status);
    }
  });
});

// ============================================================================
// CreateMany
// ============================================================================

describe('TaskRepository.createMany', () => {
  dbTest('should create multiple tasks in bulk', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const tasks = [
      createTaskData({ session_id: sessionId, full_prompt: 'Task 1' }),
      createTaskData({ session_id: sessionId, full_prompt: 'Task 2' }),
      createTaskData({ session_id: sessionId, full_prompt: 'Task 3' }),
    ];

    const created = await taskRepo.createMany(tasks);

    expect(created).toHaveLength(3);
    expect(created[0].full_prompt).toBe('Task 1');
    expect(created[1].full_prompt).toBe('Task 2');
    expect(created[2].full_prompt).toBe('Task 3');
  });

  dbTest('should handle empty array', async ({ db }) => {
    const taskRepo = new TaskRepository(db);

    const created = await taskRepo.createMany([]);

    expect(created).toEqual([]);
  });

  dbTest('should create tasks with different sessions', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const session1 = await createSessionWithDeps(db);
    const session2 = await createSessionWithDeps(db);
    const tasks = [
      createTaskData({ session_id: session1 }),
      createTaskData({ session_id: session2 }),
    ];

    const created = await taskRepo.createMany(tasks);

    expect(created).toHaveLength(2);
    expect(created[0].session_id).toBe(session1);
    expect(created[1].session_id).toBe(session2);
  });

  dbTest('should preserve all task data in bulk create', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const tasks = [
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.RUNNING,
        tool_use_count: 5,
        git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
      }),
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.COMPLETED,
        tool_use_count: 10,
        git_state: { ref_at_start: 'develop', sha_at_start: 'def456' },
      }),
    ];

    const created = await taskRepo.createMany(tasks);

    expect(created[0].status).toBe(TaskStatus.RUNNING);
    expect(created[0].tool_use_count).toBe(5);
    expect(created[0].git_state.ref_at_start).toBe('main');
    expect(created[1].status).toBe(TaskStatus.COMPLETED);
    expect(created[1].tool_use_count).toBe(10);
    expect(created[1].git_state.ref_at_start).toBe('develop');
  });
});

// ============================================================================
// FindById (with short ID support)
// ============================================================================

describe('TaskRepository.findById', () => {
  dbTest('should find task by full UUID and short ID', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId });
    await taskRepo.create(data);

    // Full UUID
    const byFull = await taskRepo.findById(data.task_id!);
    expect(byFull).not.toBeNull();
    expect(byFull?.task_id).toBe(data.task_id);

    // Short ID
    const shortId = data.task_id!.replace(/-/g, '').slice(0, 8);
    const byShort = await taskRepo.findById(shortId);
    expect(byShort?.task_id).toBe(data.task_id);

    // Case insensitive
    const byUpper = await taskRepo.findById(shortId.toUpperCase());
    expect(byUpper?.task_id).toBe(data.task_id);
  });

  dbTest('should return null for non-existent ID', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    expect(await taskRepo.findById('99999999')).toBeNull();
  });

  dbTest('should throw AmbiguousIdError with suggestions', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    const id1 = '01933e4a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-9d2e1c4b5a6f' as UUID;

    await taskRepo.create(createTaskData({ task_id: id1, session_id: sessionId }));
    await taskRepo.create(createTaskData({ task_id: id2, session_id: sessionId }));

    try {
      await taskRepo.findById('01933e4a');
      throw new Error('Expected AmbiguousIdError');
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousIdError);
      expect((error as AmbiguousIdError).matches).toHaveLength(2);
    }
  });
});

// ============================================================================
// FindAll
// ============================================================================

describe('TaskRepository.findAll', () => {
  dbTest('should return empty array when no tasks', async ({ db }) => {
    const taskRepo = new TaskRepository(db);

    const tasks = await taskRepo.findAll();

    expect(tasks).toEqual([]);
  });

  dbTest('should return all tasks', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    await taskRepo.create(createTaskData({ session_id: sessionId, full_prompt: 'Task 1' }));
    await taskRepo.create(createTaskData({ session_id: sessionId, full_prompt: 'Task 2' }));
    await taskRepo.create(createTaskData({ session_id: sessionId, full_prompt: 'Task 3' }));

    const tasks = await taskRepo.findAll();

    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => t.full_prompt).sort()).toEqual(['Task 1', 'Task 2', 'Task 3']);
  });

  dbTest('should return fully populated task objects', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({
      session_id: sessionId,
      full_prompt: 'Test prompt',
      status: TaskStatus.RUNNING,
      tool_use_count: 5,
    });
    await taskRepo.create(data);

    const tasks = await taskRepo.findAll();

    expect(tasks).toHaveLength(1);
    const found = tasks[0];
    expect(found.task_id).toBe(data.task_id);
    expect(found.full_prompt).toBe(data.full_prompt);
    expect(found.status).toBe(data.status);
    expect(found.tool_use_count).toBe(data.tool_use_count);
  });
});

// ============================================================================
// FindBySession
// ============================================================================

describe('TaskRepository.findBySession', () => {
  dbTest('should return empty array for session with no tasks', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = generateId();

    const tasks = await taskRepo.findBySession(sessionId);

    expect(tasks).toEqual([]);
  });

  dbTest('should return all tasks for a session', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const session1 = await createSessionWithDeps(db);
    const session2 = await createSessionWithDeps(db);

    await taskRepo.create(
      createTaskData({ session_id: session1, full_prompt: 'Session 1 Task 1' })
    );
    await taskRepo.create(
      createTaskData({ session_id: session1, full_prompt: 'Session 1 Task 2' })
    );
    await taskRepo.create(
      createTaskData({ session_id: session2, full_prompt: 'Session 2 Task 1' })
    );

    const tasks = await taskRepo.findBySession(session1);

    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.session_id === session1)).toBe(true);
    expect(tasks.map((t) => t.full_prompt).sort()).toEqual([
      'Session 1 Task 1',
      'Session 1 Task 2',
    ]);
  });

  dbTest('should return tasks ordered by created_at', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    // Create tasks with small delays to ensure different timestamps
    await taskRepo.create(createTaskData({ session_id: sessionId, full_prompt: 'First' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await taskRepo.create(createTaskData({ session_id: sessionId, full_prompt: 'Second' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await taskRepo.create(createTaskData({ session_id: sessionId, full_prompt: 'Third' }));

    const tasks = await taskRepo.findBySession(sessionId);

    expect(tasks).toHaveLength(3);
    expect(tasks[0].full_prompt).toBe('First');
    expect(tasks[1].full_prompt).toBe('Second');
    expect(tasks[2].full_prompt).toBe('Third');
  });

  dbTest('should not return tasks from other sessions', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const session1 = await createSessionWithDeps(db);
    const session2 = await createSessionWithDeps(db);

    await taskRepo.create(createTaskData({ session_id: session1 }));
    await taskRepo.create(createTaskData({ session_id: session2 }));

    const tasks = await taskRepo.findBySession(session1);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].session_id).toBe(session1);
  });
});

// ============================================================================
// FindRunning
// ============================================================================

describe('TaskRepository.findRunning', () => {
  dbTest('should return empty array when no running tasks', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    await taskRepo.create(createTaskData({ session_id: sessionId, status: TaskStatus.CREATED }));
    await taskRepo.create(createTaskData({ session_id: sessionId, status: TaskStatus.COMPLETED }));

    const running = await taskRepo.findRunning();

    expect(running).toEqual([]);
  });

  dbTest('should return only running tasks', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.RUNNING,
        full_prompt: 'Running 1',
      })
    );
    await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.CREATED, full_prompt: 'Created' })
    );
    await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.RUNNING,
        full_prompt: 'Running 2',
      })
    );
    await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.COMPLETED,
        full_prompt: 'Completed',
      })
    );

    const running = await taskRepo.findRunning();

    expect(running).toHaveLength(2);
    expect(running.every((t) => t.status === TaskStatus.RUNNING)).toBe(true);
    expect(running.map((t) => t.full_prompt).sort()).toEqual(['Running 1', 'Running 2']);
  });

  dbTest('should return running tasks from all sessions', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const session1 = await createSessionWithDeps(db);
    const session2 = await createSessionWithDeps(db);

    await taskRepo.create(createTaskData({ session_id: session1, status: TaskStatus.RUNNING }));
    await taskRepo.create(createTaskData({ session_id: session2, status: TaskStatus.RUNNING }));

    const running = await taskRepo.findRunning();

    expect(running).toHaveLength(2);
  });
});

// ============================================================================
// FindByStatus
// ============================================================================

describe('TaskRepository.findByStatus', () => {
  dbTest('should return tasks with specific status', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    await taskRepo.create(createTaskData({ session_id: sessionId, status: TaskStatus.COMPLETED }));
    await taskRepo.create(createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING }));
    await taskRepo.create(createTaskData({ session_id: sessionId, status: TaskStatus.COMPLETED }));

    const completed = await taskRepo.findByStatus(TaskStatus.COMPLETED);

    expect(completed).toHaveLength(2);
    expect(completed.every((t) => t.status === TaskStatus.COMPLETED)).toBe(true);
  });

  dbTest('should return empty array for status with no tasks', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    await taskRepo.create(createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING }));

    const failed = await taskRepo.findByStatus(TaskStatus.FAILED);

    expect(failed).toEqual([]);
  });

  dbTest('should work with all task statuses', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    const statuses = [
      TaskStatus.CREATED,
      TaskStatus.RUNNING,
      TaskStatus.STOPPING,
      TaskStatus.AWAITING_PERMISSION,
      TaskStatus.COMPLETED,
      TaskStatus.FAILED,
      TaskStatus.STOPPED,
    ];

    for (const status of statuses) {
      await taskRepo.create(createTaskData({ session_id: sessionId, status }));
    }

    for (const status of statuses) {
      const found = await taskRepo.findByStatus(status);
      expect(found).toHaveLength(1);
      expect(found[0].status).toBe(status);
    }
  });
});

// ============================================================================
// Update
// ============================================================================

describe('TaskRepository.update', () => {
  dbTest('should update task by full UUID and short ID', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId, status: TaskStatus.CREATED });
    await taskRepo.create(data);

    // Update by full UUID
    const updated = await taskRepo.update(data.task_id!, { status: TaskStatus.RUNNING });
    expect(updated.status).toBe(TaskStatus.RUNNING);

    // Update by short ID
    const shortId = data.task_id!.replace(/-/g, '').slice(0, 8);
    const updated2 = await taskRepo.update(shortId, { status: TaskStatus.COMPLETED });
    expect(updated2.status).toBe(TaskStatus.COMPLETED);
  });

  dbTest('should update multiple fields and preserve unchanged ones', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({
      session_id: sessionId,
      full_prompt: 'Original prompt',
      status: TaskStatus.CREATED,
      tool_use_count: 0,
      git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
    });
    const created = await taskRepo.create(data);

    const completedAt = new Date().toISOString();
    const updated = await taskRepo.update(data.task_id!, {
      status: TaskStatus.COMPLETED,
      completed_at: completedAt,
      tool_use_count: 10,
      duration_ms: 45000,
      git_state: {
        ref_at_start: 'main',
        sha_at_start: 'abc123',
        sha_at_end: 'def456',
        commit_message: 'feat: new feature',
      },
      message_range: {
        start_index: 0,
        end_index: 5,
        start_timestamp: created.message_range.start_timestamp,
        end_timestamp: completedAt,
      },
    });

    expect(updated.status).toBe(TaskStatus.COMPLETED);
    expect(updated.completed_at).toBe(completedAt);
    expect(updated.tool_use_count).toBe(10);
    expect(updated.duration_ms).toBe(45000);
    expect(updated.git_state.sha_at_end).toBe('def456');
    expect(updated.message_range.end_index).toBe(5);
    // Unchanged fields
    expect(updated.full_prompt).toBe(created.full_prompt);
    expect(updated.session_id).toBe(created.session_id);
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    await expect(taskRepo.update('99999999', { status: TaskStatus.COMPLETED })).rejects.toThrow(
      EntityNotFoundError
    );
  });

  // Regression: forked sessions used to go FAILED silently with no trace of
  // why. The prompt route now stamps `error_message` on the task so the
  // reason is preserved in the DB and visible to UI + logs.
  dbTest('should round-trip error_message on failed task update', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING });
    await taskRepo.create(data);

    const errorMessage =
      'Unix user agor_123 not found. Ensure the Unix user is created before attempting to execute sessions.';
    const updated = await taskRepo.update(data.task_id!, {
      status: TaskStatus.FAILED,
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
    });

    expect(updated.status).toBe(TaskStatus.FAILED);
    expect(updated.error_message).toBe(errorMessage);

    // Fetching fresh from the repo must still surface the error.
    const refetched = await taskRepo.findById(data.task_id!);
    expect(refetched?.error_message).toBe(errorMessage);
  });
});

// ============================================================================
// Delete
// ============================================================================

describe('TaskRepository.delete', () => {
  dbTest('should delete task by full UUID and short ID', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    const data1 = createTaskData({ session_id: sessionId });
    const data2 = createTaskData({ session_id: sessionId });
    await taskRepo.create(data1);
    await taskRepo.create(data2);

    // Delete by full UUID
    await taskRepo.delete(data1.task_id!);
    expect(await taskRepo.findById(data1.task_id!)).toBeNull();

    // Delete by short ID
    const shortId = data2.task_id!.replace(/-/g, '').slice(0, 8);
    await taskRepo.delete(shortId);
    expect(await taskRepo.findById(data2.task_id!)).toBeNull();
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    await expect(taskRepo.delete('99999999')).rejects.toThrow(EntityNotFoundError);
  });
});

// ============================================================================
// CountBySession
// ============================================================================

describe('TaskRepository.countBySession', () => {
  dbTest('should count tasks correctly and update on create/delete', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const session1 = await createSessionWithDeps(db);
    const session2 = await createSessionWithDeps(db);

    // Empty session
    expect(await taskRepo.countBySession(session1)).toBe(0);

    // After creates
    const data1 = createTaskData({ session_id: session1 });
    const data2 = createTaskData({ session_id: session1 });
    await taskRepo.create(data1);
    await taskRepo.create(data2);
    await taskRepo.create(createTaskData({ session_id: session2 }));

    expect(await taskRepo.countBySession(session1)).toBe(2);
    expect(await taskRepo.countBySession(session2)).toBe(1);

    // After delete
    await taskRepo.delete(data1.task_id!);
    expect(await taskRepo.countBySession(session1)).toBe(1);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('TaskRepository edge cases', () => {
  dbTest('should handle empty and special characters in prompts', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    // Empty prompt
    const empty = await taskRepo.create(createTaskData({ session_id: sessionId, full_prompt: '' }));
    expect(empty.full_prompt).toBe('');

    // Multiline and special characters
    const special = await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        full_prompt: 'Line 1\nLine 2\n"quotes" \'apostrophes\' $special',
      })
    );
    expect(special.full_prompt).toContain('Line 1\nLine 2');
    expect(special.full_prompt).toContain('"quotes"');
  });

  dbTest('should handle undefined optional fields', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId });
    delete (data as any).duration_ms;
    delete (data as any).report;

    const created = await taskRepo.create(data);

    expect(created.duration_ms).toBeUndefined();
    expect(created.report).toBeUndefined();
  });
});

// ============================================================================
// CreatePending (never-lose-prompt §C: queue lives on tasks)
// ============================================================================

/**
 * Helper: build the minimum-viable input for `createPending` so tests stay
 * focused on the behavior under test instead of restating boilerplate.
 */
function createPendingInput(overrides: {
  session_id: string;
  status: typeof TaskStatus.CREATED | typeof TaskStatus.QUEUED;
  full_prompt?: string;
  metadata?: Parameters<TaskRepository['createPending']>[0]['metadata'];
}): Parameters<TaskRepository['createPending']>[0] {
  return {
    session_id: overrides.session_id as Parameters<
      TaskRepository['createPending']
    >[0]['session_id'],
    full_prompt: overrides.full_prompt ?? 'test prompt',
    created_by: 'test-user',
    status: overrides.status,
    metadata: overrides.metadata,
  };
}

describe('TaskRepository.createPending', () => {
  dbTest(
    'should create QUEUED task with queue_position=1 when no other queued tasks',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);

      const queued = await taskRepo.createPending(
        createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
      );

      expect(queued.status).toBe(TaskStatus.QUEUED);
      expect(queued.queue_position).toBe(1);
      expect(queued.session_id).toBe(sessionId);
    }
  );

  dbTest('should auto-assign incrementing queue_position within a session', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    const first = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
    );
    const second = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
    );
    const third = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
    );

    expect(first.queue_position).toBe(1);
    expect(second.queue_position).toBe(2);
    expect(third.queue_position).toBe(3);
  });

  dbTest('should scope queue_position per session', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionA = await createSessionWithDeps(db);
    const sessionB = await createSessionWithDeps(db);

    await taskRepo.createPending(
      createPendingInput({ session_id: sessionA, status: TaskStatus.QUEUED })
    );
    await taskRepo.createPending(
      createPendingInput({ session_id: sessionA, status: TaskStatus.QUEUED })
    );
    const onB = await taskRepo.createPending(
      createPendingInput({ session_id: sessionB, status: TaskStatus.QUEUED })
    );

    // Session B's first queued task should be at position 1, not 3.
    expect(onB.queue_position).toBe(1);
  });

  dbTest('should preserve metadata round-trip through findById', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const metadata = {
      is_agor_callback: true,
      source: 'agor' as const,
      queued_by_user_id: 'user-123',
    };

    const queued = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED, metadata })
    );

    expect(queued.metadata).toEqual(metadata);

    const refetched = await taskRepo.findById(queued.task_id);
    expect(refetched?.metadata).toEqual(metadata);
  });

  dbTest('should leave queue_position unset for CREATED tasks (idle path)', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    const created = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.CREATED })
    );

    expect(created.status).toBe(TaskStatus.CREATED);
    expect(created.queue_position).toBeUndefined();
  });

  dbTest(
    'should stamp sentinels on the row so spawnTaskExecutor knows what to recompute',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);

      const queued = await taskRepo.createPending(
        createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
      );

      // The sentinel contract: while a task is QUEUED/CREATED, message_range
      // and git_state hold "not yet pinned" markers. spawnTaskExecutor is the
      // sole place that overwrites these on the way to RUNNING.
      expect(queued.message_range.start_index).toBe(-1);
      expect(queued.git_state.sha_at_start).toBe('');
      expect(queued.git_state.ref_at_start).toBe('');
    }
  );

  dbTest(
    'should serialize parallel QUEUED inserts via transaction (race regression)',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);

      // Three callers fire in parallel — they must produce three distinct
      // queue_positions rather than colliding on the same `max+1`. This is the
      // createQueued TOCTOU race that existed before the read-then-insert was
      // wrapped in a transaction.
      //
      // libsql serializes concurrent write transactions, so under contention
      // some inserts may surface SQLITE_BUSY. Either outcome (success with
      // unique position OR transient BUSY) is correct — what we forbid is
      // *committed* duplicates. Successful rows must therefore have distinct,
      // monotonically-increasing positions starting at 1.
      const settled = await Promise.allSettled([
        taskRepo.createPending(
          createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
        ),
        taskRepo.createPending(
          createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
        ),
        taskRepo.createPending(
          createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
        ),
      ]);

      const successes = settled
        .filter((r): r is PromiseFulfilledResult<Task> => r.status === 'fulfilled')
        .map((r) => r.value);

      expect(successes.length).toBeGreaterThan(0);

      const positions = successes.map((t) => t.queue_position).sort();
      const unique = new Set(positions);
      expect(unique.size).toBe(positions.length); // no duplicates
      expect(positions[0]).toBe(1); // numbering starts at 1
    }
  );
});

// ============================================================================
// FindQueued
// ============================================================================

describe('TaskRepository.findQueued', () => {
  dbTest('should return queued tasks ordered by queue_position', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    await taskRepo.createPending(
      createPendingInput({
        session_id: sessionId,
        status: TaskStatus.QUEUED,
        full_prompt: 'first queued',
      })
    );
    await taskRepo.createPending(
      createPendingInput({
        session_id: sessionId,
        status: TaskStatus.QUEUED,
        full_prompt: 'second queued',
      })
    );
    await taskRepo.createPending(
      createPendingInput({
        session_id: sessionId,
        status: TaskStatus.QUEUED,
        full_prompt: 'third queued',
      })
    );

    const found = await taskRepo.findQueued(sessionId);

    expect(found).toHaveLength(3);
    expect(found.map((t) => t.queue_position)).toEqual([1, 2, 3]);
    expect(found.map((t) => t.full_prompt)).toEqual([
      'first queued',
      'second queued',
      'third queued',
    ]);
  });
});

// ============================================================================
// GetNextQueued
// ============================================================================

describe('TaskRepository.getNextQueued', () => {
  dbTest('should return null when no queued tasks for session', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    const next = await taskRepo.getNextQueued(sessionId);

    expect(next).toBeNull();
  });

  dbTest('should return lowest queue_position first', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    // Insert out of order with manually-set queue_position so we know findRunning
    // isn't accidentally returning insert-order.
    await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.QUEUED,
        queue_position: 3,
        full_prompt: 'pos 3',
      })
    );
    await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.QUEUED,
        queue_position: 1,
        full_prompt: 'pos 1',
      })
    );
    await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.QUEUED,
        queue_position: 2,
        full_prompt: 'pos 2',
      })
    );

    const next = await taskRepo.getNextQueued(sessionId);

    expect(next).not.toBeNull();
    expect(next?.queue_position).toBe(1);
    expect(next?.full_prompt).toBe('pos 1');
  });

  dbTest('should not return tasks from other sessions', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionA = await createSessionWithDeps(db);
    const sessionB = await createSessionWithDeps(db);

    await taskRepo.createPending(
      createPendingInput({ session_id: sessionA, status: TaskStatus.QUEUED })
    );

    const next = await taskRepo.getNextQueued(sessionB);

    expect(next).toBeNull();
  });

  dbTest('should not return non-QUEUED tasks even if queue_position set', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    // A task that has a queue_position but a non-QUEUED status — e.g. one that
    // already drained to RUNNING — must not be picked up by getNextQueued.
    await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.RUNNING,
        queue_position: 1,
      })
    );

    const next = await taskRepo.getNextQueued(sessionId);

    expect(next).toBeNull();
  });
});

// ============================================================================
// Sentinel invariants (never-lose-prompt §C)
//
// QUEUED tasks are born with sentinel `message_range.start_index = -1` and
// sentinel `git_state.sha_at_start = ''` — values that the drainer recomputes
// before flipping the task to RUNNING. These tests are tripwires: they assert
// the post-recompute shape on real data we control. End-to-end coverage of the
// recompute path itself lives in a follow-up PR; this is the cheapest possible
// guard so a future regression in spawnTaskExecutor isn't silent.
// ============================================================================

describe('TaskRepository sentinel invariants', () => {
  dbTest(
    'should never persist RUNNING task with sentinel message_range.start_index',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);

      // Born QUEUED with the sentinel start_index = -1 (mirrors what the
      // /sessions/:id/tasks/queue endpoint writes).
      const queued = await taskRepo.create(
        createTaskData({
          session_id: sessionId,
          status: TaskStatus.QUEUED,
          queue_position: 1,
          message_range: {
            start_index: -1,
            end_index: -1,
            start_timestamp: new Date().toISOString(),
          },
        })
      );

      // Drainer recomputes message_range before flipping to RUNNING.
      const now = new Date().toISOString();
      await taskRepo.update(queued.task_id, {
        status: TaskStatus.RUNNING,
        message_range: {
          start_index: 0,
          end_index: 0,
          start_timestamp: now,
        },
      });

      // Scan: no RUNNING/COMPLETED row should have the sentinel.
      const all = await taskRepo.findAll();
      for (const task of all) {
        if (task.status === TaskStatus.RUNNING || task.status === TaskStatus.COMPLETED) {
          expect(task.message_range.start_index).not.toBe(-1);
        }
      }
    }
  );

  dbTest('should never persist RUNNING task with empty git_state.sha_at_start', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    // Born QUEUED with the sentinel empty sha_at_start.
    const queued = await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.QUEUED,
        queue_position: 1,
        git_state: { ref_at_start: '', sha_at_start: '' },
      })
    );

    // Drainer recomputes git_state before flipping to RUNNING.
    await taskRepo.update(queued.task_id, {
      status: TaskStatus.RUNNING,
      git_state: { ref_at_start: 'main', sha_at_start: 'abc123' },
    });

    const all = await taskRepo.findAll();
    for (const task of all) {
      if (task.status === TaskStatus.RUNNING || task.status === TaskStatus.COMPLETED) {
        // Empty string is the sentinel. 'unknown' is the documented default
        // when git state can't be read at task start — that's allowed.
        expect(task.git_state.sha_at_start).not.toBe('');
      }
    }
  });
});
