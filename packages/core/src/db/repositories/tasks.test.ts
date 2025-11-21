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
    description: 'Test task',
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
    model: 'claude-sonnet-4-5',
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
  });

  // Create session
  const sessionRepo = new SessionRepository(db);
  const session = await sessionRepo.create({
    session_id: generateId(),
    worktree_id: worktree.worktree_id,
    agentic_tool: 'claude-code',
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
    expect(created.description).toBe(data.description);
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

  dbTest('should default created_by to anonymous', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId });
    delete (data as any).created_by;

    const created = await taskRepo.create(data);

    expect(created.created_by).toBe('anonymous');
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
      createTaskData({ session_id: sessionId, description: 'Task 1' }),
      createTaskData({ session_id: sessionId, description: 'Task 2' }),
      createTaskData({ session_id: sessionId, description: 'Task 3' }),
    ];

    const created = await taskRepo.createMany(tasks);

    expect(created).toHaveLength(3);
    expect(created[0].description).toBe('Task 1');
    expect(created[1].description).toBe('Task 2');
    expect(created[2].description).toBe('Task 3');
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

    await taskRepo.create(createTaskData({ session_id: sessionId, description: 'Task 1' }));
    await taskRepo.create(createTaskData({ session_id: sessionId, description: 'Task 2' }));
    await taskRepo.create(createTaskData({ session_id: sessionId, description: 'Task 3' }));

    const tasks = await taskRepo.findAll();

    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => t.description).sort()).toEqual(['Task 1', 'Task 2', 'Task 3']);
  });

  dbTest('should return fully populated task objects', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({
      session_id: sessionId,
      full_prompt: 'Test prompt',
      description: 'Test description',
      status: TaskStatus.RUNNING,
      tool_use_count: 5,
    });
    await taskRepo.create(data);

    const tasks = await taskRepo.findAll();

    expect(tasks).toHaveLength(1);
    const found = tasks[0];
    expect(found.task_id).toBe(data.task_id);
    expect(found.full_prompt).toBe(data.full_prompt);
    expect(found.description).toBe(data.description);
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
      createTaskData({ session_id: session1, description: 'Session 1 Task 1' })
    );
    await taskRepo.create(
      createTaskData({ session_id: session1, description: 'Session 1 Task 2' })
    );
    await taskRepo.create(
      createTaskData({ session_id: session2, description: 'Session 2 Task 1' })
    );

    const tasks = await taskRepo.findBySession(session1);

    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.session_id === session1)).toBe(true);
    expect(tasks.map((t) => t.description).sort()).toEqual([
      'Session 1 Task 1',
      'Session 1 Task 2',
    ]);
  });

  dbTest('should return tasks ordered by created_at', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);

    // Create tasks with small delays to ensure different timestamps
    await taskRepo.create(createTaskData({ session_id: sessionId, description: 'First' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await taskRepo.create(createTaskData({ session_id: sessionId, description: 'Second' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await taskRepo.create(createTaskData({ session_id: sessionId, description: 'Third' }));

    const tasks = await taskRepo.findBySession(sessionId);

    expect(tasks).toHaveLength(3);
    expect(tasks[0].description).toBe('First');
    expect(tasks[1].description).toBe('Second');
    expect(tasks[2].description).toBe('Third');
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
        description: 'Running 1',
      })
    );
    await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.CREATED, description: 'Created' })
    );
    await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.RUNNING,
        description: 'Running 2',
      })
    );
    await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.COMPLETED,
        description: 'Completed',
      })
    );

    const running = await taskRepo.findRunning();

    expect(running).toHaveLength(2);
    expect(running.every((t) => t.status === TaskStatus.RUNNING)).toBe(true);
    expect(running.map((t) => t.description).sort()).toEqual(['Running 1', 'Running 2']);
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
