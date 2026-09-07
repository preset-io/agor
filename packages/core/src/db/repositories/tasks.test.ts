/**
 * TaskRepository Tests
 *
 * Tests for type-safe CRUD operations on tasks with short ID support.
 */

import type { MessageID, Task, TaskPendingDispatchStatus, UserID, UUID } from '@agor/core/types';
import { MessageRole, SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { generateId, toShortId } from '../../lib/ids';
import type { Database } from '../client';
import { ownedDbTest as dbTest, setTestBranchUserRole } from '../test-helpers';
import { AmbiguousIdError, EntityNotFoundError, RepositoryError } from './base';
import { BranchRepository } from './branches';
import { MessagesRepository } from './messages';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { MISSING_TASK_ACTOR_ERROR, TaskRepository } from './tasks';
import { UsersRepository } from './users';

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

// Counter for unique branch IDs
let branchCounter = 1;

/**
 * Create a session with required dependencies (repo and branch)
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

  // Create branch
  const branchRepo = new BranchRepository(db);
  const branch = await branchRepo.create({
    branch_id: generateId(),
    repo_id: repo.repo_id,
    name: 'test-branch',
    ref: 'main',
    branch_unique_id: branchCounter++,
    path: '/tmp/test/branch',
    created_by: 'test-user' as UUID,
  });

  // Create session
  const sessionRepo = new SessionRepository(db);
  const session = await sessionRepo.create({
    session_id: generateId(),
    branch_id: branch.branch_id,
    agentic_tool: 'claude-code',
    created_by: 'test-user' as UUID,
  });

  return session.session_id;
}

async function bindTestRuntimeAuthority(db: Database, taskRepo: TaskRepository, task: Task) {
  const session = await new SessionRepository(db).findById(task.session_id);
  if (!session?.branch_id) throw new Error('Test runtime Session Branch is unavailable');
  await taskRepo.bindExecutorLaunchAuthority(task.task_id);
  return {
    token_fingerprint: 'a'.repeat(64),
    principal_user_id: task.created_by,
    session_id: task.session_id,
    branch_id: session.branch_id,
    standalone_token_current: true,
  };
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
    expect(created.last_executor_heartbeat_at).toBeUndefined();
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

  dbTest('should leave Task.model undefined when not provided', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId });
    delete (data as any).model;

    const created = await taskRepo.create(data);

    expect(created.model).toBeUndefined();
  });

  dbTest('should preserve explicit Task.model when provided', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId, model: 'gpt-5.5' });

    const created = await taskRepo.create(data);

    expect(created.model).toBe('gpt-5.5');
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
      TaskStatus.DISPATCHING,
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
// HA runtime discovery and containment fencing
// ============================================================================

describe('TaskRepository runtime reconciliation', () => {
  dbTest(
    'discovers expired runtime facts in bounded order without treating fresh work as stale',
    async ({ db }) => {
      const tasks = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const now = new Date('2026-08-06T12:00:00.000Z');

      for (const [index, startedAt] of [
        '2026-08-06T11:50:00.000Z',
        '2026-08-06T11:51:00.000Z',
        '2026-08-06T11:52:00.000Z',
      ].entries()) {
        await tasks.create(
          createTaskData({
            session_id: sessionId,
            full_prompt: `dispatch ${index}`,
            status: TaskStatus.DISPATCHING,
            started_at: startedAt,
          })
        );
      }
      await tasks.create(
        createTaskData({
          session_id: sessionId,
          status: TaskStatus.DISPATCHING,
          started_at: '2026-08-06T11:59:59.000Z',
        })
      );

      const expiredDispatches = await tasks.findExpiredDispatchRefs(60_000, {
        now,
        limit: 2,
      });
      expect(expiredDispatches).toHaveLength(2);
      const remainingDispatches = await tasks.findExpiredDispatchRefs(60_000, {
        now,
        limit: 2,
        after: expiredDispatches.at(-1)!.cursor,
      });
      expect(remainingDispatches).toHaveLength(1);
      expect(
        new Set([...expiredDispatches, ...remainingDispatches].map((ref) => ref.task_id)).size
      ).toBe(3);

      const stale = await tasks.create(
        createTaskData({
          session_id: sessionId,
          status: TaskStatus.RUNNING,
          executor_connected_at: '2026-08-06T11:50:00.000Z',
          last_executor_heartbeat_at: '2026-08-06T11:55:00.000Z',
        })
      );
      const fresh = await tasks.create(
        createTaskData({
          session_id: sessionId,
          status: TaskStatus.RUNNING,
          executor_connected_at: '2026-08-06T11:59:58.000Z',
          last_executor_heartbeat_at: '2026-08-06T11:59:59.000Z',
        })
      );

      const staleHeartbeats = await tasks.findStaleHeartbeatRefs(60_000, { now, limit: 25 });
      expect(staleHeartbeats).toContainEqual(
        expect.objectContaining({
          task_id: stale.task_id,
          executor_heartbeat_at: '2026-08-06T11:55:00.000Z',
        })
      );
      expect(staleHeartbeats.map((ref) => ref.task_id)).not.toContain(fresh.task_id);
    }
  );

  dbTest('elects one containment coordinator and fences the losing settlement', async ({ db }) => {
    const tasksA = new TaskRepository(db);
    const tasksB = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await tasksA.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
    );
    await tasksA.claimTermination({
      taskId: task.task_id,
      cause: 'heartbeat_lost',
      errorMessage: 'heartbeat stale',
      sdkFailure: {
        reason: 'heartbeat_lost',
        detected_at: '2026-08-06T12:00:00.000Z',
        tool: 'codex',
        termination: 'requested',
      },
      now: new Date('2026-08-06T12:00:00.000Z'),
    });

    const claims = await Promise.all([
      tasksA.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'claim-a',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-a',
        bootId: 'boot-a',
        now: new Date('2026-08-06T12:00:01.000Z'),
      }),
      tasksB.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'claim-b',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-b',
        bootId: 'boot-b',
        now: new Date('2026-08-06T12:00:01.000Z'),
      }),
    ]);
    expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
    const winningToken = claims.find((claim) => claim.outcome === 'claimed')!.task
      .termination_request!.coordination!.claim_token;
    const losingToken = winningToken === 'claim-a' ? 'claim-b' : 'claim-a';

    await expect(
      tasksA.settleTermination({
        taskId: task.task_id,
        outcome: 'verified_absent',
        coordinationToken: losingToken,
        now: new Date('2026-08-06T12:00:02.000Z'),
      })
    ).resolves.toMatchObject({
      outcome: 'condition_changed',
      task: { status: TaskStatus.STOPPING },
    });
    await expect(
      tasksB.settleTermination({
        taskId: task.task_id,
        outcome: 'verified_absent',
        coordinationToken: winningToken,
        now: new Date('2026-08-06T12:00:02.000Z'),
      })
    ).resolves.toMatchObject({ outcome: 'transitioned', task: { status: TaskStatus.FAILED } });
  });

  dbTest(
    'reclaims an expired coordinator and does not rediscover guarded unverified work',
    async ({ db }) => {
      const tasks = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const task = await tasks.create(
        createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
      );
      await tasks.claimTermination({
        taskId: task.task_id,
        cause: 'heartbeat_lost',
        errorMessage: 'heartbeat stale',
        now: new Date('2026-08-06T12:00:00.000Z'),
      });
      await tasks.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'dead-coordinator',
        leaseDurationMs: 1_000,
        instanceId: 'daemon-a',
        bootId: 'boot-a',
        now: new Date('2026-08-06T12:00:00.000Z'),
      });

      expect(
        await tasks.findStrandedTerminationRefs({
          now: new Date('2026-08-06T12:00:00.999Z'),
        })
      ).toEqual([]);
      expect(
        (
          await tasks.findStrandedTerminationRefs({ now: new Date('2026-08-06T12:00:01.000Z') })
        ).map((ref) => ref.task_id)
      ).toContain(task.task_id);

      const replacement = await tasks.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'replacement',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-b',
        bootId: 'boot-b',
        now: new Date('2026-08-06T12:00:01.000Z'),
      });
      expect(replacement.outcome).toBe('claimed');
      expect(
        await tasks.settleTermination({
          taskId: task.task_id,
          outcome: 'unverified',
          coordinationToken: 'replacement',
          sdkFailure: {
            reason: 'termination_unverified',
            detected_at: '2026-08-06T12:00:02.000Z',
            tool: 'codex',
            termination: 'unverified',
          },
          errorMessage: 'No matching local process handle exists.',
          now: new Date('2026-08-06T12:00:02.000Z'),
        })
      ).toMatchObject({ outcome: 'unverified' });
      await expect(
        tasks.settleTermination({
          taskId: task.task_id,
          outcome: 'verified_absent',
          coordinationToken: 'replacement',
          now: new Date('2026-08-06T12:00:03.000Z'),
        })
      ).resolves.toMatchObject({
        outcome: 'condition_changed',
        task: { status: TaskStatus.STOPPING },
      });
      expect(
        await tasks.findStrandedTerminationRefs({ now: new Date('2026-08-06T13:00:00.000Z') })
      ).toEqual([]);
    }
  );

  dbTest(
    'paginates expired and unclaimed termination work with a stable NULLS-LAST cursor',
    async ({ db }) => {
      const tasks = new TaskRepository(db);
      const expiredSessionId = await createSessionWithDeps(db);
      const unclaimedSessionId = await createSessionWithDeps(db);
      const expired = await tasks.create(
        createTaskData({ session_id: expiredSessionId, status: TaskStatus.RUNNING })
      );
      const unclaimed = await tasks.create(
        createTaskData({ session_id: unclaimedSessionId, status: TaskStatus.RUNNING })
      );
      for (const task of [expired, unclaimed]) {
        await tasks.claimTermination({
          taskId: task.task_id,
          cause: 'heartbeat_lost',
          errorMessage: 'heartbeat stale',
          now: new Date('2026-08-06T12:00:00.000Z'),
        });
      }
      await tasks.claimTerminationCoordination({
        taskId: expired.task_id,
        claimToken: 'expired-claim',
        leaseDurationMs: 1_000,
        instanceId: 'daemon-a',
        bootId: 'boot-a',
        now: new Date('2026-08-06T12:00:00.000Z'),
      });

      const first = await tasks.findStrandedTerminationRefs({
        now: new Date('2026-08-06T12:00:02.000Z'),
        limit: 1,
      });
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        task_id: expired.task_id,
        cursor: { order_at: '2026-08-06T12:00:01.000Z' },
      });
      const second = await tasks.findStrandedTerminationRefs({
        now: new Date('2026-08-06T12:00:02.000Z'),
        limit: 1,
        after: first[0].cursor,
      });
      expect(second).toEqual([
        expect.objectContaining({
          task_id: unclaimed.task_id,
          cursor: { task_id: unclaimed.task_id },
        }),
      ]);
      await expect(
        tasks.findStrandedTerminationRefs({
          now: new Date('2026-08-06T12:00:02.000Z'),
          limit: 1,
          after: second[0].cursor,
        })
      ).resolves.toEqual([]);
    }
  );

  dbTest('fences non-owner recovery with the database-authored request age', async ({ db }) => {
    const tasks = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await tasks.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
    );
    await tasks.claimTermination({
      taskId: task.task_id,
      cause: 'heartbeat_lost',
      errorMessage: 'heartbeat stale',
      now: new Date('2026-08-06T12:00:00.000Z'),
    });

    await expect(
      tasks.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'too-early',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-b',
        bootId: 'boot-b',
        minimumRequestAgeMs: 15_000,
        now: new Date('2026-08-06T12:00:14.999Z'),
      })
    ).resolves.toMatchObject({ outcome: 'condition_changed' });
    await expect(
      tasks.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'old-enough',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-b',
        bootId: 'boot-b',
        minimumRequestAgeMs: 15_000,
        now: new Date('2026-08-06T12:00:15.000Z'),
      })
    ).resolves.toMatchObject({
      outcome: 'claimed',
      task: { termination_request: { coordination: { claim_token: 'old-enough' } } },
    });
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
    const idPrefix = toShortId(data.task_id!, 8);
    const byShort = await taskRepo.findById(idPrefix);
    expect(byShort?.task_id).toBe(data.task_id);

    // Case insensitive
    const byUpper = await taskRepo.findById(idPrefix.toUpperCase());
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

  dbTest('should restrict by visibleToUserId through session branch access', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const users = new UsersRepository(db);
    const repos = new RepoRepository(db);
    const branches = new BranchRepository(db);
    const sessions = new SessionRepository(db);
    const viewerId = generateId() as UUID;
    await users.create({
      user_id: viewerId,
      email: 'tasks-visible@example.com',
      name: 'Tasks Viewer',
    });
    const repo = await repos.create({
      repo_id: generateId(),
      slug: `tasks-visible-${branchCounter++}`,
      name: 'Tasks Visible',
      repo_type: 'remote' as const,
      remote_url: 'https://github.com/test/repo.git',
      local_path: '/tmp/tasks-visible',
      default_branch: 'main',
    });
    const visibleBranch = await branches.create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `visible-${branchCounter}`,
      ref: 'main',
      branch_unique_id: branchCounter++,
      path: '/tmp/tasks-visible/visible',
      created_by: 'test-user' as UUID,
      permission_source: 'override',
      others_can: 'none',
    });
    const hiddenBranch = await branches.create({
      branch_id: generateId(),
      repo_id: repo.repo_id,
      name: `hidden-${branchCounter}`,
      ref: 'main',
      branch_unique_id: branchCounter++,
      path: '/tmp/tasks-visible/hidden',
      created_by: 'test-user' as UUID,
      permission_source: 'override',
      others_can: 'none',
    });
    await setTestBranchUserRole(db, visibleBranch.branch_id, viewerId as UserID, 'manager');
    const visibleSession = await sessions.create({
      session_id: generateId(),
      branch_id: visibleBranch.branch_id,
      agentic_tool: 'claude-code',
      created_by: 'test-user' as UUID,
    });
    const hiddenSession = await sessions.create({
      session_id: generateId(),
      branch_id: hiddenBranch.branch_id,
      agentic_tool: 'claude-code',
      created_by: 'test-user' as UUID,
    });
    const visibleTask = await taskRepo.create(
      createTaskData({ session_id: visibleSession.session_id, full_prompt: 'visible' })
    );
    await taskRepo.create(
      createTaskData({ session_id: hiddenSession.session_id, full_prompt: 'hidden' })
    );

    const visible = await taskRepo.findAll({ visibleToUserId: viewerId });
    expect(visible.map((task) => task.task_id)).toEqual([visibleTask.task_id]);
  });
});

describe('TaskRepository.findPage', () => {
  dbTest('counts and returns only the requested deterministic SQL page', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const created = [];
    for (let index = 0; index < 12; index += 1) {
      created.push(
        await taskRepo.create(
          createTaskData({ session_id: sessionId, full_prompt: `Task ${index}` })
        )
      );
    }

    const client = (
      db as unknown as {
        $client: { execute: (...args: unknown[]) => Promise<unknown> };
      }
    ).$client;
    const execute = vi.spyOn(client, 'execute');
    const page = await taskRepo.findPage({
      sessionId,
      sort: { task_id: 1 },
      limit: 2,
      skip: 3,
    });

    const expected = [...created]
      .sort((left, right) => left.task_id.localeCompare(right.task_id))
      .slice(3, 5)
      .map((task) => task.task_id);
    expect(page.total).toBe(12);
    expect(page.data.map((task) => task.task_id)).toEqual(expected);
    expect(
      execute.mock.calls.some(
        ([query]) => /tasks/i.test(JSON.stringify(query)) && /limit/i.test(JSON.stringify(query))
      )
    ).toBe(true);
  });

  dbTest('projects only task_id for hydration membership verification', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({ session_id: sessionId, full_prompt: 'large Task payload' })
    );

    await expect(
      taskRepo.findPage({ sessionId, selectTaskIdOnly: true, limit: 10 })
    ).resolves.toEqual({ total: 1, data: [{ task_id: task.task_id }] });
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
// Nonterminal cascade guards
// ============================================================================

describe('TaskRepository nonterminal cascade guards', () => {
  dbTest('detects unfinished work by session and by its owning branch', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionRepo = new SessionRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const session = await sessionRepo.findById(sessionId);
    expect(session).not.toBeNull();

    const task = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
    );

    expect(await taskRepo.hasNonterminalForSession(sessionId)).toBe(true);
    expect(await taskRepo.hasNonterminalForBranch(session!.branch_id)).toBe(true);

    await taskRepo.update(task.task_id, { status: TaskStatus.COMPLETED });

    expect(await taskRepo.hasNonterminalForSession(sessionId)).toBe(false);
    expect(await taskRepo.hasNonterminalForBranch(session!.branch_id)).toBe(false);
  });

  dbTest('does not widen a branch guard to an unrelated branch', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionRepo = new SessionRepository(db);
    const activeSessionId = await createSessionWithDeps(db);
    const otherSessionId = await createSessionWithDeps(db);
    const activeSession = await sessionRepo.findById(activeSessionId);
    const otherSession = await sessionRepo.findById(otherSessionId);
    expect(activeSession).not.toBeNull();
    expect(otherSession).not.toBeNull();

    await taskRepo.create(
      createTaskData({ session_id: activeSessionId, status: TaskStatus.RUNNING })
    );

    expect(await taskRepo.hasNonterminalForBranch(activeSession!.branch_id)).toBe(true);
    expect(await taskRepo.hasNonterminalForBranch(otherSession!.branch_id)).toBe(false);
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

describe('TaskRepository.findExecutingByCreator', () => {
  dbTest('returns every executing state for only the immutable prompt actor', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const users = new UsersRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const actor = await users.create({ email: `actor-${generateId()}@example.com`, name: 'Actor' });
    const other = await users.create({ email: `other-${generateId()}@example.com`, name: 'Other' });

    for (const status of [
      TaskStatus.DISPATCHING,
      TaskStatus.RUNNING,
      TaskStatus.STOPPING,
      TaskStatus.AWAITING_PERMISSION,
      TaskStatus.AWAITING_INPUT,
    ]) {
      await taskRepo.create(
        createTaskData({ session_id: sessionId, created_by: actor.user_id, status })
      );
    }
    await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        created_by: actor.user_id,
        status: TaskStatus.COMPLETED,
      })
    );
    await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        created_by: other.user_id,
        status: TaskStatus.RUNNING,
      })
    );

    const executing = await taskRepo.findExecutingByCreator(actor.user_id);
    expect(executing).toHaveLength(5);
    expect(executing.every((task) => task.created_by === actor.user_id)).toBe(true);
    expect(new Set(executing.map((task) => task.status))).toEqual(
      new Set([
        TaskStatus.DISPATCHING,
        TaskStatus.RUNNING,
        TaskStatus.STOPPING,
        TaskStatus.AWAITING_PERMISSION,
        TaskStatus.AWAITING_INPUT,
      ])
    );
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
      TaskStatus.DISPATCHING,
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
// Executor connection
// ============================================================================

const startupWarning = 'Remote executor is still starting.';

async function createExecutorDispatch(
  db: Database,
  executorMode: 'local' | 'templated' = 'templated'
) {
  const taskRepo = new TaskRepository(db);
  const sessionId = await createSessionWithDeps(db);
  const task = await taskRepo.create(
    createTaskData({
      session_id: sessionId,
      status: TaskStatus.DISPATCHING,
      executor_mode: executorMode,
      started_at: '2026-01-01T00:00:00.000Z',
    })
  );
  return { taskRepo, task };
}

describe('TaskRepository.connectExecutor', () => {
  dbTest(
    'atomically transitions dispatching to running with a server timestamp',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const startedAt = '2026-01-01T00:00:00.000Z';
      const created = await taskRepo.create(
        createTaskData({
          session_id: sessionId,
          status: TaskStatus.DISPATCHING,
          started_at: startedAt,
        })
      );

      const connection = await taskRepo.connectExecutor(created.task_id);
      const found = await taskRepo.findById(created.task_id);

      expect(connection?.transitioned).toBe(true);
      expect(connection?.task.status).toBe(TaskStatus.RUNNING);
      expect(connection?.task.started_at).toBe(startedAt);
      expect(connection?.task.executor_connected_at).toBeDefined();
      expect(connection?.task.last_executor_heartbeat_at).toBe(
        connection?.task.executor_connected_at
      );
      expect(found).toMatchObject({
        status: TaskStatus.RUNNING,
        started_at: startedAt,
        executor_connected_at: connection?.task.executor_connected_at,
        last_executor_heartbeat_at: connection?.task.executor_connected_at,
      });
    }
  );

  dbTest(
    'is idempotent once running and does not rewrite the connection timestamp',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const created = await taskRepo.create(
        createTaskData({ session_id: sessionId, status: TaskStatus.DISPATCHING })
      );

      const first = await taskRepo.connectExecutor(created.task_id);
      const second = await taskRepo.connectExecutor(created.task_id);

      expect(second).toEqual({ task: first?.task, transitioned: false });
    }
  );

  dbTest('serializes concurrent executor claims without SQLite lock errors', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const created = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.DISPATCHING })
    );

    const claims = await Promise.all([
      taskRepo.connectExecutor(created.task_id),
      taskRepo.connectExecutor(created.task_id),
    ]);

    expect(claims.map((claim) => claim?.transitioned).sort()).toEqual([false, true]);
    expect(new Set(claims.map((claim) => claim?.task.executor_connected_at)).size).toBe(1);
    expect(new Set(claims.map((claim) => claim?.task.last_executor_heartbeat_at)).size).toBe(1);
    expect((await taskRepo.findById(created.task_id))?.status).toBe(TaskStatus.RUNNING);
  });

  dbTest('clears a templated startup warning when the executor connects', async ({ db }) => {
    const { taskRepo, task } = await createExecutorDispatch(db);

    expect(await taskRepo.recordExecutorStartupWarning(task.task_id, startupWarning)).toMatchObject(
      { error_message: startupWarning }
    );
    expect(await taskRepo.recordExecutorStartupWarning(task.task_id, startupWarning)).toBeNull();
    expect(
      (
        await taskRepo.findExpiredDispatchRefs(1, {
          now: new Date('2027-01-01T00:00:00.000Z'),
        })
      ).map((candidate) => candidate.task_id)
    ).not.toContain(task.task_id);

    const connection = await taskRepo.connectExecutor(task.task_id);
    expect(connection).toMatchObject({
      transitioned: true,
      task: { status: TaskStatus.RUNNING },
    });
    expect(connection?.task.error_message).toBeUndefined();
  });

  dbTest('rejects a stale startup warning after connection wins', async ({ db }) => {
    const { taskRepo, task } = await createExecutorDispatch(db);

    await taskRepo.connectExecutor(task.task_id);

    expect(await taskRepo.recordExecutorStartupWarning(task.task_id, startupWarning)).toBeNull();
    const connected = await taskRepo.findById(task.task_id);
    expect(connected?.status).toBe(TaskStatus.RUNNING);
    expect(connected?.error_message).toBeUndefined();
  });

  dbTest('serializes a concurrent startup warning and connection', async ({ db }) => {
    const { taskRepo, task } = await createExecutorDispatch(db);

    await Promise.all([
      taskRepo.recordExecutorStartupWarning(task.task_id, startupWarning),
      taskRepo.connectExecutor(task.task_id),
    ]);

    const connected = await taskRepo.findById(task.task_id);
    expect(connected?.status).toBe(TaskStatus.RUNNING);
    expect(connected?.error_message).toBeUndefined();
  });

  dbTest('rejects startup warnings for local executors', async ({ db }) => {
    const { taskRepo, task } = await createExecutorDispatch(db, 'local');
    expect(await taskRepo.recordExecutorStartupWarning(task.task_id, startupWarning)).toBeNull();
  });

  dbTest('does not accept a timestamp-less running row as a prior claim', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const corrupted = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
    );

    expect(await taskRepo.connectExecutor(corrupted.task_id)).toBeNull();
    expect(await taskRepo.findById(corrupted.task_id)).toMatchObject({
      status: TaskStatus.RUNNING,
      executor_connected_at: undefined,
    });
  });

  dbTest('does not revive stopping, stopped, or terminal tasks', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    for (const status of [
      TaskStatus.STOPPING,
      TaskStatus.STOPPED,
      TaskStatus.COMPLETED,
      TaskStatus.FAILED,
      TaskStatus.TIMED_OUT,
    ]) {
      const task = await taskRepo.create(createTaskData({ session_id: sessionId, status }));
      expect(await taskRepo.connectExecutor(task.task_id)).toBeNull();
      expect((await taskRepo.findById(task.task_id))?.status).toBe(status);
    }
  });

  dbTest(
    'includes dispatching in orphan cleanup but not connected-heartbeat supervision',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const task = await taskRepo.create(
        createTaskData({
          session_id: sessionId,
          status: TaskStatus.DISPATCHING,
          last_executor_heartbeat_at: '2026-01-01T00:00:00.000Z',
        })
      );

      expect((await taskRepo.findOrphaned()).map((item) => item.task_id)).toContain(task.task_id);
      expect(
        (await taskRepo.findActiveWithExecutorHeartbeat()).map((item) => item.task_id)
      ).not.toContain(task.task_id);
    }
  );
});

describe('TaskRepository.reportRuntimeTelemetry', () => {
  dbTest('stamps heartbeat and advances only to a greater pulse sequence', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.DISPATCHING })
    );
    const authority = await bindTestRuntimeAuthority(db, taskRepo, task);
    await taskRepo.connectExecutor(task.task_id);

    const first = await taskRepo.reportRuntimeTelemetry(
      task.task_id,
      authority,
      { sequence: 2, kind: 'progress', detail: 'tool.start' },
      new Date('2026-01-01T00:00:02.000Z')
    );
    const retry = await taskRepo.reportRuntimeTelemetry(
      task.task_id,
      authority,
      { sequence: 2, kind: 'waiting' },
      new Date('2026-01-01T00:00:03.000Z')
    );

    expect(first).toMatchObject({
      outcome: 'continued',
      task: {
        last_executor_heartbeat_at: '2026-01-01T00:00:02.000Z',
        latest_executor_pulse: {
          sequence: 2,
          kind: 'progress',
          detail: 'tool.start',
          observed_at: '2026-01-01T00:00:02.000Z',
        },
      },
    });
    expect(retry).toMatchObject({
      outcome: 'continued',
      task: {
        last_executor_heartbeat_at: '2026-01-01T00:00:03.000Z',
        latest_executor_pulse:
          first.outcome === 'continued' ? first.task.latest_executor_pulse : {},
      },
    });
  });

  dbTest(
    'retains heartbeat and progress evidence while cancellation is stopping',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const task = await taskRepo.create(
        createTaskData({ session_id: sessionId, status: TaskStatus.DISPATCHING })
      );
      const authority = await bindTestRuntimeAuthority(db, taskRepo, task);
      await taskRepo.connectExecutor(task.task_id);
      await taskRepo.claimTermination({
        taskId: task.task_id,
        cause: 'user_stop',
        errorMessage: 'Stopped by user',
        now: new Date('2026-01-01T00:00:02.000Z'),
      });

      await expect(
        taskRepo.reportRuntimeTelemetry(
          task.task_id,
          authority,
          { sequence: 3, kind: 'progress', detail: 'provider.cancel.pending' },
          new Date('2026-01-01T00:00:03.000Z')
        )
      ).resolves.toMatchObject({
        outcome: 'continued',
        task: {
          status: TaskStatus.STOPPING,
          last_executor_heartbeat_at: '2026-01-01T00:00:03.000Z',
          latest_executor_pulse: {
            sequence: 3,
            kind: 'progress',
            detail: 'provider.cancel.pending',
          },
        },
      });
    }
  );

  dbTest('rejects late telemetry after executor quiescence', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.DISPATCHING })
    );
    const authority = await bindTestRuntimeAuthority(db, taskRepo, task);
    await taskRepo.connectExecutor(task.task_id);
    const claim = await taskRepo.claimTermination({
      taskId: task.task_id,
      cause: 'user_stop',
      errorMessage: 'Stopped by user',
      now: new Date('2026-01-01T00:00:02.000Z'),
    });
    await taskRepo.recordExecutorQuiescence(
      {
        task_id: task.task_id,
        requested_at: claim.task.termination_request!.requested_at,
      },
      new Date('2026-01-01T00:00:03.000Z')
    );

    await expect(taskRepo.reportRuntimeTelemetry(task.task_id, authority)).resolves.toMatchObject({
      outcome: 'control',
      task: { status: TaskStatus.STOPPING },
    });
  });

  dbTest(
    'retains late telemetry when containment is unverified but the executor is live',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const task = await taskRepo.create(
        createTaskData({ session_id: sessionId, status: TaskStatus.DISPATCHING })
      );
      const authority = await bindTestRuntimeAuthority(db, taskRepo, task);
      await taskRepo.connectExecutor(task.task_id);
      await taskRepo.claimTermination({
        taskId: task.task_id,
        cause: 'heartbeat_lost',
        errorMessage: 'Heartbeat lost',
      });
      await taskRepo.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'telemetry-claim',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-a',
        bootId: 'boot-a',
      });
      await taskRepo.settleTermination({
        taskId: task.task_id,
        outcome: 'unverified',
        coordinationToken: 'telemetry-claim',
        errorMessage: 'Containment remains unverified.',
        sdkFailure: {
          reason: 'termination_unverified',
          detected_at: '2026-01-01T00:00:03.000Z',
          tool: 'codex',
          termination: 'unverified',
        },
      });

      await expect(
        taskRepo.reportRuntimeTelemetry(
          task.task_id,
          authority,
          { sequence: 4, kind: 'progress', detail: 'provider.cancel.still_pending' },
          new Date('2026-01-01T00:00:04.000Z')
        )
      ).resolves.toMatchObject({
        outcome: 'continued',
        task: {
          status: TaskStatus.STOPPING,
          sdk_failure: { termination: 'unverified' },
          last_executor_heartbeat_at: '2026-01-01T00:00:04.000Z',
          latest_executor_pulse: { sequence: 4, detail: 'provider.cancel.still_pending' },
        },
      });
    }
  );

  dbTest('rejects telemetry before connect and after terminality', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.DISPATCHING })
    );
    const authority = await bindTestRuntimeAuthority(db, taskRepo, task);

    expect(await taskRepo.reportRuntimeTelemetry(task.task_id, authority)).toMatchObject({
      outcome: 'control',
    });
    await taskRepo.connectExecutor(task.task_id);
    await taskRepo.update(task.task_id, { status: TaskStatus.COMPLETED });
    expect(await taskRepo.reportRuntimeTelemetry(task.task_id, authority)).toMatchObject({
      outcome: 'control',
    });
  });
});

describe('TaskRepository.recordSdkHealthObservation', () => {
  dbTest('serializes observe-only evidence with normal completion', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.RUNNING,
        executor_connected_at: '2026-01-01T00:00:01.000Z',
      })
    );
    const failure = {
      reason: 'no_first_progress' as const,
      detected_at: '2026-01-01T00:03:01.000Z',
      tool: 'codex' as const,
      watchdog_action: 'would_fire' as const,
      termination: 'not_requested' as const,
    };

    const [, observed] = await Promise.all([
      taskRepo.update(task.task_id, { status: TaskStatus.COMPLETED }),
      taskRepo.recordSdkHealthObservation(task.task_id, failure),
    ]);
    const completed = await taskRepo.findById(task.task_id);

    expect(completed).toMatchObject({ status: TaskStatus.COMPLETED });
    expect(completed?.sdk_failure).toEqual(observed?.sdk_failure);
    expect(await taskRepo.recordSdkHealthObservation(task.task_id, failure)).toBeNull();
    expect((await taskRepo.findById(task.task_id))?.sdk_failure).toEqual(completed?.sdk_failure);
  });
});

// ============================================================================
// Update
// ============================================================================

describe('TaskRepository.update', () => {
  dbTest('does not let generic updates claim a dispatching task', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const created = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.DISPATCHING })
    );

    await expect(taskRepo.update(created.task_id, { status: TaskStatus.RUNNING })).rejects.toThrow(
      'dispatching tasks must be claimed through connectExecutor'
    );
    expect((await taskRepo.findById(created.task_id))?.status).toBe(TaskStatus.DISPATCHING);
  });

  dbTest('should update task by full UUID and short ID', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const data = createTaskData({ session_id: sessionId, status: TaskStatus.CREATED });
    await taskRepo.create(data);

    // Update by full UUID
    const updated = await taskRepo.update(data.task_id!, { status: TaskStatus.RUNNING });
    expect(updated.status).toBe(TaskStatus.RUNNING);

    // Update by short ID
    const idPrefix = toShortId(data.task_id!, 8);
    const updated2 = await taskRepo.update(idPrefix, { status: TaskStatus.COMPLETED });
    expect(updated2.status).toBe(TaskStatus.COMPLETED);
  });

  dbTest('keeps persisted identity authoritative over update payloads', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const created = await taskRepo.create(createTaskData({ session_id: sessionId }));

    const updated = await taskRepo.update(created.task_id, {
      task_id: generateId(),
      session_id: await createSessionWithDeps(db),
      created_by: 'forged-user',
      created_at: '2000-01-01T00:00:00.000Z',
      status: TaskStatus.COMPLETED,
    });

    expect(updated).toMatchObject({
      task_id: created.task_id,
      session_id: created.session_id,
      created_by: created.created_by,
      created_at: created.created_at,
      status: TaskStatus.COMPLETED,
    });
    expect(await taskRepo.findById(created.task_id)).toMatchObject({
      task_id: created.task_id,
      session_id: created.session_id,
      created_by: created.created_by,
    });
  });

  dbTest('allows a running executor task to complete normally', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const created = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
    );

    const updated = await taskRepo.update(created.task_id, {
      status: TaskStatus.COMPLETED,
      completed_at: '2026-07-10T20:00:00.000Z',
    });

    expect(updated).toMatchObject({
      status: TaskStatus.COMPLETED,
      completed_at: '2026-07-10T20:00:00.000Z',
    });
  });

  for (const [taskStatus, sessionStatus] of [
    [TaskStatus.COMPLETED, SessionStatus.IDLE],
    [TaskStatus.FAILED, SessionStatus.FAILED],
    [TaskStatus.STOPPED, SessionStatus.IDLE],
    [TaskStatus.TIMED_OUT, SessionStatus.TIMED_OUT],
  ] as const) {
    dbTest(
      `atomically projects terminal task status ${taskStatus} onto the owning Session`,
      async ({ db }) => {
        const taskRepo = new TaskRepository(db);
        const sessionRepo = new SessionRepository(db);
        const sessionId = await createSessionWithDeps(db);
        const task = await taskRepo.create(
          createTaskData({
            session_id: sessionId,
            status: TaskStatus.RUNNING,
            executor_connected_at: '2026-08-30T12:00:00.000Z',
          })
        );
        await sessionRepo.update(sessionId, {
          status: SessionStatus.RUNNING,
          ready_for_prompt: false,
          tasks: [task.task_id],
          scheduled_from_branch: taskStatus === TaskStatus.TIMED_OUT,
        });

        await taskRepo.updateFromExecutor(task.task_id, { status: taskStatus });
        await expect(taskRepo.findById(task.task_id)).resolves.toMatchObject({
          status: taskStatus,
          completed_at: expect.any(String),
        });
        await expect(sessionRepo.findById(sessionId)).resolves.toMatchObject({
          status: sessionStatus,
          ready_for_prompt: true,
        });
      }
    );
  }

  dbTest(
    'does not let an older terminal Task clobber a newer active Session claim',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const older = await taskRepo.create(
        createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
      );
      const newer = await taskRepo.create(
        createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
      );
      await sessionRepo.update(sessionId, {
        status: SessionStatus.RUNNING,
        ready_for_prompt: false,
        tasks: [older.task_id, newer.task_id],
      });

      await taskRepo.update(older.task_id, { status: TaskStatus.FAILED });

      await expect(sessionRepo.findById(sessionId)).resolves.toMatchObject({
        status: SessionStatus.RUNNING,
        ready_for_prompt: false,
      });
    }
  );

  dbTest('computes terminal timing at the row-locked mutation boundary', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const startedAt = '2026-07-10T20:00:00.000Z';
    const completedAt = '2026-07-10T20:00:05.000Z';
    const created = await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.RUNNING,
        started_at: startedAt,
        message_range: {
          start_index: 0,
          end_index: 0,
          start_timestamp: startedAt,
        },
      })
    );

    await expect(
      taskRepo.update(created.task_id, { status: TaskStatus.COMPLETED, completed_at: completedAt })
    ).resolves.toMatchObject({
      completed_at: completedAt,
      duration_ms: 5_000,
      message_range: { end_timestamp: completedAt },
    });
  });

  dbTest('round-trips bounded executor health state through JSON data', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const created = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
    );
    await taskRepo.update(created.task_id, {
      sdk_watchdog_mode: 'enforce',
      sdk_failure: {
        reason: 'no_first_progress',
        detected_at: '2026-07-10T20:03:00.000Z',
        tool: 'codex',
        watchdog_action: 'enforced',
        termination: 'requested',
      },
      termination_request: {
        cause: 'sdk_health_failure',
        requested_at: '2026-07-10T20:03:00.000Z',
      },
    });

    expect(await taskRepo.findById(created.task_id)).toMatchObject({
      sdk_watchdog_mode: 'enforce',
      sdk_failure: { reason: 'no_first_progress', termination: 'requested' },
      termination_request: { cause: 'sdk_health_failure' },
    });
  });

  dbTest(
    'atomically gives user Stop precedence over a concurrent health failure',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const task = await taskRepo.create(
        createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
      );

      const [health, stop] = await Promise.all([
        taskRepo.claimTermination({
          taskId: task.task_id,
          cause: 'sdk_health_failure',
          errorMessage: 'SDK stalled',
          sdkFailure: {
            reason: 'no_first_progress',
            detected_at: '2026-07-10T20:03:00.000Z',
            tool: 'codex',
            termination: 'requested',
          },
        }),
        taskRepo.claimTermination({
          taskId: task.task_id,
          cause: 'user_stop',
          errorMessage: 'Stopped by user',
        }),
      ]);

      expect([health.outcome, stop.outcome]).toContain('claimed');
      expect(await taskRepo.findById(task.task_id)).toMatchObject({
        status: TaskStatus.STOPPING,
        termination_request: { cause: 'user_stop' },
      });
      await taskRepo.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'stop-winner',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-a',
        bootId: 'boot-a',
      });

      const settled = await taskRepo.settleTermination({
        taskId: task.task_id,
        outcome: 'verified_absent',
        coordinationToken: 'stop-winner',
      });
      expect(settled).toMatchObject({
        outcome: 'transitioned',
        task: { status: TaskStatus.STOPPED },
      });
      await expect(new SessionRepository(db).findById(sessionId)).resolves.toMatchObject({
        status: SessionStatus.IDLE,
        ready_for_prompt: true,
      });
    }
  );

  dbTest('does not erase unverified evidence when user Stop takes precedence', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.STOPPING,
        termination_request: {
          cause: 'sdk_health_failure',
          requested_at: '2026-07-10T20:03:00.000Z',
        },
        sdk_failure: {
          reason: 'termination_unverified',
          detected_at: '2026-07-10T20:03:00.000Z',
          tool: 'codex',
          termination: 'unverified',
        },
      })
    );

    const result = await taskRepo.claimTermination({
      taskId: task.task_id,
      cause: 'user_stop',
      errorMessage: 'Stopped by user',
    });

    expect(result).toMatchObject({
      outcome: 'claimed',
      task: {
        termination_request: { cause: 'user_stop' },
        sdk_failure: { termination: 'unverified' },
      },
    });
  });

  dbTest('rejects a stale-heartbeat claim when the observed heartbeat changed', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.DISPATCHING,
      })
    );
    const authority = await bindTestRuntimeAuthority(db, taskRepo, task);
    await taskRepo.connectExecutor(task.task_id, new Date('2026-07-10T20:00:01.000Z'));
    await taskRepo.reportRuntimeTelemetry(
      task.task_id,
      authority,
      undefined,
      new Date('2026-07-10T20:00:05Z')
    );

    const claim = await taskRepo.claimTermination({
      taskId: task.task_id,
      cause: 'heartbeat_lost',
      errorMessage: 'Heartbeat lost',
      expectedStatus: TaskStatus.RUNNING,
      expectedHeartbeatAt: '2026-07-10T20:00:01.000Z',
      heartbeatStaleBefore: '2026-07-10T20:00:02.000Z',
    });

    expect(claim).toMatchObject({
      outcome: 'condition_changed',
      task: { status: TaskStatus.RUNNING },
    });
  });

  dbTest('rejects a startup-timeout claim after the executor connects', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.DISPATCHING })
    );
    await taskRepo.connectExecutor(task.task_id);

    const claim = await taskRepo.claimTermination({
      taskId: task.task_id,
      cause: 'startup_timeout',
      errorMessage: 'Executor did not connect',
      expectedStatus: TaskStatus.DISPATCHING,
      requireExecutorDisconnected: true,
    });

    expect(claim).toMatchObject({
      outcome: 'condition_changed',
      task: { status: TaskStatus.RUNNING },
    });
  });

  dbTest('makes repeated claims and settlements idempotent', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
    );
    const request = {
      taskId: task.task_id,
      cause: 'user_stop' as const,
      errorMessage: 'Stopped by user',
    };

    expect((await taskRepo.claimTermination(request)).outcome).toBe('claimed');
    expect((await taskRepo.claimTermination(request)).outcome).toBe('unchanged');
    await taskRepo.claimTerminationCoordination({
      taskId: task.task_id,
      claimToken: 'idempotent-claim',
      leaseDurationMs: 30_000,
      instanceId: 'daemon-a',
      bootId: 'boot-a',
    });
    expect(
      (
        await taskRepo.settleTermination({
          taskId: task.task_id,
          outcome: 'verified_absent',
          coordinationToken: 'idempotent-claim',
        })
      ).outcome
    ).toBe('transitioned');
    expect(
      (
        await taskRepo.settleTermination({
          taskId: task.task_id,
          outcome: 'verified_absent',
          coordinationToken: 'idempotent-claim',
        })
      ).outcome
    ).toBe('terminal');
  });

  dbTest('projects the Session only when termination becomes authoritative', async ({ db }) => {
    const tasks = new TaskRepository(db);
    const sessions = new SessionRepository(db);
    const sessionId = await createSessionWithDeps(db);
    await sessions.update(sessionId, {
      status: SessionStatus.STOPPING,
      ready_for_prompt: false,
    });
    const task = await tasks.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
    );
    const termination = await tasks.claimTermination({
      taskId: task.task_id,
      cause: 'heartbeat_lost',
      errorMessage: 'Heartbeat lost',
    });
    await expect(sessions.findById(sessionId)).resolves.toMatchObject({
      status: SessionStatus.STOPPING,
      ready_for_prompt: false,
    });
    await tasks.claimTerminationCoordination({
      taskId: task.task_id,
      claimToken: 'projection-claim',
      leaseDurationMs: 30_000,
      instanceId: 'daemon-a',
      bootId: 'boot-a',
    });

    await tasks.settleTermination({
      taskId: task.task_id,
      outcome: 'unverified',
      coordinationToken: 'projection-claim',
      errorMessage: 'Containment is not verified',
      sdkFailure: {
        reason: 'termination_unverified',
        detected_at: '2026-08-06T12:00:00.000Z',
        tool: 'codex',
        termination: 'unverified',
      },
    });
    await expect(sessions.findById(sessionId)).resolves.toMatchObject({
      status: SessionStatus.STOPPING,
      ready_for_prompt: false,
    });

    const staleForce = await tasks.settleTermination({
      taskId: task.task_id,
      outcome: 'forced_unverified',
      expectedTerminationRequestedAt: '2026-08-06T11:59:59.000Z',
      errorMessage: 'Force-failed by an authorized user',
    });
    expect(staleForce).toMatchObject({
      outcome: 'condition_changed',
      task: { status: TaskStatus.STOPPING },
    });
    const forced = await tasks.settleTermination({
      taskId: task.task_id,
      outcome: 'forced_unverified',
      expectedTerminationRequestedAt: termination.task.termination_request!.requested_at,
      errorMessage: 'Force-failed by an authorized user',
    });
    expect(forced).toMatchObject({
      outcome: 'transitioned',
      task: { status: TaskStatus.FAILED },
    });
    await expect(sessions.findById(sessionId)).resolves.toMatchObject({
      status: SessionStatus.FAILED,
      ready_for_prompt: true,
    });
  });

  dbTest('records only the current termination request as executor-quiesced', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.RUNNING,
        executor_connected_at: '2026-07-10T20:00:00.000Z',
      })
    );
    const claim = await taskRepo.claimTermination({
      taskId: task.task_id,
      cause: 'user_stop',
      errorMessage: 'Stopped by user',
      now: new Date('2026-07-10T20:01:00.000Z'),
    });
    const requestedAt = claim.task.termination_request!.requested_at;

    expect(
      await taskRepo.recordExecutorQuiescence({
        task_id: task.task_id,
        requested_at: '2026-07-10T19:59:00.000Z',
      })
    ).toBeNull();

    const reported = await taskRepo.recordExecutorQuiescence(
      { task_id: task.task_id, requested_at: requestedAt },
      new Date('2026-07-10T20:01:00.125Z')
    );
    expect(reported).toMatchObject({
      status: TaskStatus.STOPPING,
      termination_request: {
        requested_at: requestedAt,
        executor_quiesced_at: '2026-07-10T20:01:00.125Z',
      },
    });
    expect(
      await taskRepo.recordExecutorQuiescence(
        { task_id: task.task_id, requested_at: requestedAt },
        new Date('2026-07-10T20:01:01.000Z')
      )
    ).toEqual(reported);
  });

  dbTest(
    'reconciles a late fenced quiescence report after containment was unverified',
    async ({ db }) => {
      const tasks = new TaskRepository(db);
      const sessions = new SessionRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const task = await tasks.create(
        createTaskData({
          session_id: sessionId,
          status: TaskStatus.RUNNING,
          executor_mode: 'templated',
          executor_connected_at: '2026-07-10T20:00:00.000Z',
        })
      );
      const requested = await tasks.claimTermination({
        taskId: task.task_id,
        cause: 'user_stop',
        errorMessage: 'Stopped by user',
        now: new Date('2026-07-10T20:01:00.000Z'),
      });
      const requestedAt = requested.task.termination_request!.requested_at;
      await tasks.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'initial-claim',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-a',
        bootId: 'boot-a',
        now: new Date('2026-07-10T20:01:00.010Z'),
      });
      await tasks.settleTermination({
        taskId: task.task_id,
        outcome: 'unverified',
        coordinationToken: 'initial-claim',
        errorMessage: 'Executor acknowledgement did not arrive in time.',
        sdkFailure: {
          reason: 'termination_unverified',
          detected_at: '2026-07-10T20:01:01.500Z',
          tool: 'codex',
          termination: 'unverified',
        },
        now: new Date('2026-07-10T20:01:01.500Z'),
      });

      const reported = await tasks.recordExecutorQuiescence(
        { task_id: task.task_id, requested_at: requestedAt },
        new Date('2026-07-10T20:01:02.000Z')
      );

      expect(reported).toMatchObject({
        status: TaskStatus.STOPPING,
        termination_request: { executor_quiesced_at: '2026-07-10T20:01:02.000Z' },
      });
      expect(reported?.sdk_failure).toBeUndefined();
      expect(reported?.error_message).toBeUndefined();
      expect(
        (
          await tasks.findStrandedTerminationRefs({
            now: new Date('2026-07-10T20:01:02.001Z'),
          })
        ).map((ref) => ref.task_id)
      ).toContain(task.task_id);

      await expect(
        tasks.claimTerminationCoordination({
          taskId: task.task_id,
          claimToken: 'late-quiescence-claim',
          leaseDurationMs: 30_000,
          instanceId: 'daemon-b',
          bootId: 'boot-b',
          now: new Date('2026-07-10T20:01:02.010Z'),
        })
      ).resolves.toMatchObject({ outcome: 'claimed' });
      const settled = await tasks.settleTermination({
        taskId: task.task_id,
        outcome: 'verified_absent',
        coordinationToken: 'late-quiescence-claim',
        now: new Date('2026-07-10T20:01:02.020Z'),
      });
      expect(settled).toMatchObject({
        outcome: 'transitioned',
        task: { status: TaskStatus.STOPPED },
      });
      expect(settled.task.sdk_failure).toBeUndefined();
      expect(settled.task.error_message).toBeUndefined();
      await expect(sessions.findById(sessionId)).resolves.toMatchObject({
        status: SessionStatus.IDLE,
        ready_for_prompt: true,
      });
    }
  );

  dbTest(
    'does not let a duplicate quiescence report reopen renewed unverified containment',
    async ({ db }) => {
      const tasks = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const task = await tasks.create(
        createTaskData({
          session_id: sessionId,
          status: TaskStatus.RUNNING,
          executor_mode: 'templated',
          executor_connected_at: '2026-07-10T20:00:00.000Z',
        })
      );
      const requested = await tasks.claimTermination({
        taskId: task.task_id,
        cause: 'user_stop',
        errorMessage: 'Stopped by user',
        now: new Date('2026-07-10T20:01:00.000Z'),
      });
      const requestedAt = requested.task.termination_request!.requested_at;
      const markUnverified = async (claimToken: string, at: string) => {
        await tasks.claimTerminationCoordination({
          taskId: task.task_id,
          claimToken,
          leaseDurationMs: 30_000,
          instanceId: 'daemon-a',
          bootId: 'boot-a',
          now: new Date(at),
        });
        return tasks.settleTermination({
          taskId: task.task_id,
          outcome: 'unverified',
          coordinationToken: claimToken,
          errorMessage: 'Executor containment remains unverified.',
          sdkFailure: {
            reason: 'termination_unverified',
            detected_at: at,
            tool: 'codex',
            termination: 'unverified',
          },
          now: new Date(at),
        });
      };

      await markUnverified('initial-claim', '2026-07-10T20:01:01.000Z');
      await tasks.recordExecutorQuiescence(
        { task_id: task.task_id, requested_at: requestedAt },
        new Date('2026-07-10T20:01:02.000Z')
      );
      await markUnverified('renewed-claim', '2026-07-10T20:01:03.000Z');

      const duplicate = await tasks.recordExecutorQuiescence(
        { task_id: task.task_id, requested_at: requestedAt },
        new Date('2026-07-10T20:01:04.000Z')
      );
      expect(duplicate).toMatchObject({
        status: TaskStatus.STOPPING,
        sdk_failure: { termination: 'unverified' },
        termination_request: { executor_quiesced_at: '2026-07-10T20:01:02.000Z' },
      });
      expect(
        (
          await tasks.findStrandedTerminationRefs({
            now: new Date('2026-07-10T20:01:04.001Z'),
          })
        ).map((ref) => ref.task_id)
      ).not.toContain(task.task_id);
    }
  );

  dbTest(
    'preserves a real SDK diagnosis when late quiescence reopens containment',
    async ({ db }) => {
      const tasks = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const task = await tasks.create(
        createTaskData({
          session_id: sessionId,
          status: TaskStatus.RUNNING,
          executor_mode: 'templated',
          executor_connected_at: '2026-07-10T20:00:00.000Z',
        })
      );
      const failure = {
        reason: 'heartbeat_lost' as const,
        detected_at: '2026-07-10T20:01:00.000Z',
        tool: 'codex' as const,
        termination: 'requested' as const,
      };
      const request = await tasks.claimTermination({
        taskId: task.task_id,
        cause: 'heartbeat_lost',
        errorMessage: 'Heartbeat lost',
        sdkFailure: failure,
        now: new Date('2026-07-10T20:01:00.000Z'),
      });
      await tasks.claimTerminationCoordination({
        taskId: task.task_id,
        claimToken: 'health-claim',
        leaseDurationMs: 30_000,
        instanceId: 'daemon-a',
        bootId: 'boot-a',
        now: new Date('2026-07-10T20:01:00.010Z'),
      });
      await tasks.settleTermination({
        taskId: task.task_id,
        outcome: 'unverified',
        coordinationToken: 'health-claim',
        errorMessage: 'Heartbeat lost; containment remains unverified.',
        sdkFailure: { ...failure, termination: 'unverified' },
        now: new Date('2026-07-10T20:01:01.000Z'),
      });

      const reported = await tasks.recordExecutorQuiescence(
        {
          task_id: task.task_id,
          requested_at: request.task.termination_request!.requested_at,
        },
        new Date('2026-07-10T20:01:02.000Z')
      );
      expect(reported).toMatchObject({
        sdk_failure: { reason: 'heartbeat_lost', termination: 'requested' },
      });
      expect(reported?.error_message).toBeUndefined();
    }
  );

  dbTest(
    'releases a stopping task after restart without claiming verified absence',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const task = await taskRepo.create(
        createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
      );
      await taskRepo.claimTermination({
        taskId: task.task_id,
        cause: 'user_stop',
        errorMessage: 'Stopped by user',
      });

      const result = await taskRepo.settleTermination({
        taskId: task.task_id,
        outcome: 'restart_unverified',
        errorMessage: 'Daemon restarted',
        sdkFailure: {
          reason: 'termination_unverified',
          detected_at: '2026-07-10T20:03:00.000Z',
          tool: 'codex',
          termination: 'unverified',
        },
      });

      expect(result).toMatchObject({
        outcome: 'transitioned',
        task: {
          status: TaskStatus.STOPPED,
          error_message: 'Daemon restarted',
          sdk_failure: { termination: 'unverified' },
        },
      });
    }
  );

  dbTest('reserves termination-owned terminality for settlement', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
    );
    await taskRepo.claimTermination({
      taskId: task.task_id,
      cause: 'user_stop',
      errorMessage: 'Stopped by user',
    });

    await expect(taskRepo.update(task.task_id, { status: TaskStatus.COMPLETED })).rejects.toThrow(
      'termination-owned tasks must be settled through settleTermination'
    );
    await expect(taskRepo.update(task.task_id, { status: TaskStatus.RUNNING })).rejects.toThrow(
      'termination-owned tasks must be settled through settleTermination'
    );
  });

  for (const terminalStatus of [TaskStatus.COMPLETED, TaskStatus.STOPPED]) {
    dbTest(
      `does not revive a ${terminalStatus} task through awaiting_permission then running`,
      async ({ db }) => {
        const taskRepo = new TaskRepository(db);
        const sessionId = await createSessionWithDeps(db);
        const created = await taskRepo.create(
          createTaskData({
            session_id: sessionId,
            status: terminalStatus,
            executor_connected_at: '2026-07-10T20:00:00.000Z',
          })
        );

        await expect(
          taskRepo.update(created.task_id, { status: TaskStatus.AWAITING_PERMISSION })
        ).rejects.toThrow(`terminal task status cannot be changed from ${terminalStatus}`);
        await expect(
          taskRepo.update(created.task_id, { status: TaskStatus.RUNNING })
        ).rejects.toThrow(`terminal task status cannot be changed from ${terminalStatus}`);
        expect((await taskRepo.findById(created.task_id))?.status).toBe(terminalStatus);
      }
    );
  }

  for (const terminalStatus of [TaskStatus.COMPLETED, TaskStatus.STOPPED]) {
    dbTest(
      `does not revive a ${terminalStatus} task through awaiting_input then running`,
      async ({ db }) => {
        const taskRepo = new TaskRepository(db);
        const sessionId = await createSessionWithDeps(db);
        const created = await taskRepo.create(
          createTaskData({
            session_id: sessionId,
            status: terminalStatus,
            executor_connected_at: '2026-07-10T20:00:00.000Z',
          })
        );

        await expect(
          taskRepo.update(created.task_id, { status: TaskStatus.AWAITING_INPUT })
        ).rejects.toThrow(`terminal task status cannot be changed from ${terminalStatus}`);
        await expect(
          taskRepo.update(created.task_id, { status: TaskStatus.RUNNING })
        ).rejects.toThrow(`terminal task status cannot be changed from ${terminalStatus}`);
        expect((await taskRepo.findById(created.task_id))?.status).toBe(terminalStatus);
      }
    );
  }

  dbTest(
    'allows metadata-only updates after completion without changing status',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const created = await taskRepo.create(
        createTaskData({ session_id: sessionId, status: TaskStatus.COMPLETED })
      );

      const updated = await taskRepo.update(created.task_id, { tool_use_count: 7 });

      expect(updated).toMatchObject({ status: TaskStatus.COMPLETED, tool_use_count: 7 });
    }
  );

  dbTest('rejects executor writes after termination owns the locked row', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.RUNNING,
        executor_connected_at: '2026-07-10T20:00:00.000Z',
      })
    );

    const [claim, executorWrite] = await Promise.allSettled([
      taskRepo.claimTermination({
        taskId: task.task_id,
        cause: 'user_stop',
        errorMessage: 'Stopped by user',
      }),
      taskRepo.updateFromExecutor(task.task_id, { status: TaskStatus.AWAITING_PERMISSION }),
    ]);

    expect(claim).toMatchObject({ status: 'fulfilled', value: { outcome: 'claimed' } });
    if (executorWrite.status === 'rejected') {
      expect(String(executorWrite.reason)).toContain('not connected and executor-writable');
    }
    expect(await taskRepo.findById(task.task_id)).toMatchObject({
      status: TaskStatus.STOPPING,
      termination_request: { cause: 'user_stop' },
    });
    await expect(taskRepo.updateFromExecutor(task.task_id, { model: 'late' })).rejects.toThrow(
      'not connected and executor-writable'
    );
  });

  dbTest(
    'freezes executor metadata after terminality without freezing internal writes',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const task = await taskRepo.create(
        createTaskData({
          session_id: sessionId,
          status: TaskStatus.COMPLETED,
          executor_connected_at: '2026-07-10T20:00:00.000Z',
        })
      );

      await expect(taskRepo.updateFromExecutor(task.task_id, { model: 'late' })).rejects.toThrow(
        'not connected and executor-writable'
      );
      await expect(taskRepo.update(task.task_id, { model: 'internal' })).resolves.toMatchObject({
        model: 'internal',
      });
    }
  );

  dbTest('accepts executor results while the connected executor owns the row', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.create(
      createTaskData({
        session_id: sessionId,
        status: TaskStatus.RUNNING,
        executor_connected_at: '2026-07-10T20:00:00.000Z',
      })
    );

    await expect(
      taskRepo.updateFromExecutor(task.task_id, { status: TaskStatus.DISPATCHING })
    ).rejects.toThrow('Task status is not executor-managed');
    await expect(
      taskRepo.updateFromExecutor(task.task_id, {
        status: TaskStatus.COMPLETED,
        model: 'test-model',
      })
    ).resolves.toMatchObject({ status: TaskStatus.COMPLETED, model: 'test-model' });
  });

  for (const resumableStatus of [TaskStatus.AWAITING_PERMISSION, TaskStatus.AWAITING_INPUT]) {
    dbTest(
      `keeps terminal status across a concurrent resume from ${resumableStatus}`,
      async ({ db }) => {
        const taskRepo = new TaskRepository(db);
        const sessionId = await createSessionWithDeps(db);
        const created = await taskRepo.create(
          createTaskData({
            session_id: sessionId,
            status: resumableStatus,
            executor_connected_at: '2026-07-10T20:00:00.000Z',
          })
        );

        // Do not assume which transaction acquires the row lock first. If the
        // resume wins it may complete before the terminal write; if completion
        // wins, the resume must reject. The lifecycle invariant is identical.
        const [completionResult, resumeResult] = await Promise.allSettled([
          taskRepo.update(created.task_id, { status: TaskStatus.COMPLETED }),
          taskRepo.update(created.task_id, { status: TaskStatus.RUNNING }),
        ]);

        expect(completionResult.status).toBe('fulfilled');
        if (resumeResult.status === 'fulfilled') {
          expect(resumeResult.value.status).toBe(TaskStatus.RUNNING);
        } else {
          expect(String(resumeResult.reason)).toContain(
            'terminal task status cannot be changed from completed'
          );
        }
        expect((await taskRepo.findById(created.task_id))?.status).toBe(TaskStatus.COMPLETED);
      }
    );
  }

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

  dbTest('should round-trip last_executor_heartbeat_at on update', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const created = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
    );
    const heartbeatAt = '2026-01-01T00:00:00.000Z';

    const updated = await taskRepo.update(created.task_id, {
      last_executor_heartbeat_at: heartbeatAt,
    });
    const found = await taskRepo.findById(created.task_id);

    expect(updated.last_executor_heartbeat_at).toBe(heartbeatAt);
    expect(found?.last_executor_heartbeat_at).toBe(heartbeatAt);
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

    const errorMessage = 'Delegated execution home key is unavailable for this session.';
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

    const data1 = createTaskData({ session_id: sessionId, status: TaskStatus.QUEUED });
    const data2 = createTaskData({ session_id: sessionId, status: TaskStatus.QUEUED });
    await taskRepo.create(data1);
    await taskRepo.create(data2);

    // Delete by full UUID
    await taskRepo.delete(data1.task_id!);
    expect(await taskRepo.findById(data1.task_id!)).toBeNull();

    // Delete by short ID
    const idPrefix = toShortId(data2.task_id!, 8);
    await taskRepo.delete(idPrefix);
    expect(await taskRepo.findById(data2.task_id!)).toBeNull();
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    await expect(taskRepo.delete('99999999')).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('never deletes an active task', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const running = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.RUNNING })
    );

    await expect(taskRepo.delete(running.task_id)).rejects.toThrow(
      'Only queued tasks can be deleted'
    );
    expect(await taskRepo.findById(running.task_id)).toMatchObject({
      status: TaskStatus.RUNNING,
    });
  });

  dbTest('never deletes work that concurrently leaves the queue', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const queued = await taskRepo.create(
      createTaskData({ session_id: sessionId, status: TaskStatus.QUEUED })
    );

    const [deletion, dispatch] = await Promise.allSettled([
      taskRepo.delete(queued.task_id),
      taskRepo.update(queued.task_id, { status: TaskStatus.DISPATCHING }),
    ]);

    const survivor = await taskRepo.findById(queued.task_id);
    if (survivor) {
      expect(survivor.status).toBe(TaskStatus.DISPATCHING);
      expect(dispatch.status).toBe('fulfilled');
      expect(deletion.status).toBe('rejected');
    } else {
      expect(deletion.status).toBe('fulfilled');
      expect(dispatch.status).toBe('rejected');
    }
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
    const data1 = createTaskData({ session_id: session1, status: TaskStatus.QUEUED });
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
  status: TaskPendingDispatchStatus;
  created_by?: string;
  full_prompt?: string;
  metadata?: Parameters<TaskRepository['createPending']>[0]['metadata'];
}): Parameters<TaskRepository['createPending']>[0] {
  return {
    session_id: overrides.session_id as Parameters<
      TaskRepository['createPending']
    >[0]['session_id'],
    full_prompt: overrides.full_prompt ?? 'test prompt',
    created_by: overrides.created_by ?? 'test-user',
    status: overrides.status,
    metadata: overrides.metadata,
  };
}

describe('TaskRepository.createPending', () => {
  dbTest('reconciles concurrent stable-ID creation to one task', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const taskId = generateId();
    const input = createPendingInput({ session_id: sessionId, status: TaskStatus.CREATED });

    const tasks = await Promise.all(
      Array.from({ length: 5 }, () => taskRepo.createPending({ ...input, task_id: taskId }))
    );

    expect(new Set(tasks.map((task) => task.task_id))).toEqual(new Set([taskId]));
    expect(await taskRepo.findBySession(sessionId)).toHaveLength(1);
  });

  dbTest('reconciles concurrent stable-ID queue admission to one position', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const taskId = generateId();
    const input = createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED });

    const admitted = await Promise.all(
      Array.from({ length: 5 }, () => taskRepo.createPending({ ...input, task_id: taskId }))
    );

    expect(new Set(admitted.map((task) => task.task_id))).toEqual(new Set([taskId]));
    expect(new Set(admitted.map((task) => task.queue_position))).toEqual(new Set([1]));
    expect(await taskRepo.findQueued(sessionId)).toHaveLength(1);
  });

  dbTest(
    'recovers a stable CREATED task into queue order without changing identity',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const taskId = generateId();
      const stableInput = createPendingInput({
        session_id: sessionId,
        status: TaskStatus.CREATED,
        full_prompt: 'scheduled occurrence',
      });
      await taskRepo.createPending({ ...stableInput, task_id: taskId });
      const existingHead = await taskRepo.createPending(
        createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
      );

      const recovered = await taskRepo.createPending({
        ...stableInput,
        status: TaskStatus.QUEUED,
        task_id: taskId,
      });

      expect(recovered).toMatchObject({
        task_id: taskId,
        status: TaskStatus.QUEUED,
        queue_position: 2,
      });
      expect((await taskRepo.findQueued(sessionId)).map((task) => task.task_id)).toEqual([
        existingHead.task_id,
        taskId,
      ]);
    }
  );

  dbTest('atomically fences concurrent dispatch claims', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const task = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.CREATED })
    );

    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        taskRepo.claimDispatchAndProjectSession(task.task_id, TaskStatus.CREATED, {
          status: TaskStatus.DISPATCHING,
          started_at: new Date('2026-08-05T00:00:00Z').toISOString(),
        })
      )
    );

    expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.outcome === 'already_claimed')).toHaveLength(4);
    expect((await taskRepo.findById(task.task_id))?.status).toBe(TaskStatus.DISPATCHING);
    await expect(new SessionRepository(db).findById(sessionId)).resolves.toMatchObject({
      status: SessionStatus.RUNNING,
      ready_for_prompt: false,
      tasks: [task.task_id],
    });
  });

  dbTest('serializes different Task claims to one active Session dispatch', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const [first, second] = await Promise.all([
      taskRepo.createPending(
        createPendingInput({ session_id: sessionId, status: TaskStatus.CREATED })
      ),
      taskRepo.createPending(
        createPendingInput({ session_id: sessionId, status: TaskStatus.CREATED })
      ),
    ]);

    const claims = await Promise.all([
      taskRepo.claimDispatchAndProjectSession(first.task_id, TaskStatus.CREATED, {
        status: TaskStatus.DISPATCHING,
      }),
      taskRepo.claimDispatchAndProjectSession(second.task_id, TaskStatus.CREATED, {
        status: TaskStatus.DISPATCHING,
      }),
    ]);

    expect(claims.filter((claim) => claim.outcome === 'claimed')).toHaveLength(1);
    expect(claims.filter((claim) => claim.outcome === 'condition_changed')).toHaveLength(1);
    const persisted = await taskRepo.findBySession(sessionId);
    expect(persisted.filter((task) => task.status === TaskStatus.DISPATCHING)).toHaveLength(1);
    await expect(new SessionRepository(db).findById(sessionId)).resolves.toMatchObject({
      status: SessionStatus.RUNNING,
      tasks: [claims.find((claim) => claim.outcome === 'claimed')!.task.task_id],
    });
  });

  dbTest('only lets the durable queue head claim dispatch', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const first = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
    );
    const second = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
    );

    await expect(
      taskRepo.claimDispatchAndProjectSession(second.task_id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      })
    ).resolves.toMatchObject({ outcome: 'condition_changed', task: { status: TaskStatus.QUEUED } });
    await expect(
      taskRepo.claimDispatchAndProjectSession(first.task_id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      })
    ).resolves.toMatchObject({ outcome: 'claimed' });
  });

  dbTest('does not let an explicit CREATED Task jump a durable prompt queue', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const queued = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
    );
    const created = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.CREATED })
    );

    await expect(
      taskRepo.claimDispatchAndProjectSession(created.task_id, TaskStatus.CREATED, {
        status: TaskStatus.DISPATCHING,
      })
    ).resolves.toMatchObject({
      outcome: 'condition_changed',
      task: { status: TaskStatus.CREATED },
    });
    await expect(
      taskRepo.claimDispatchAndProjectSession(queued.task_id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      })
    ).resolves.toMatchObject({ outcome: 'claimed' });
  });

  dbTest('clears queue position when claiming a queued task for dispatch', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const queued = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
    );

    const claim = await taskRepo.claimDispatchAndProjectSession(queued.task_id, TaskStatus.QUEUED, {
      status: TaskStatus.DISPATCHING,
    });

    expect(claim.outcome).toBe('claimed');
    expect(claim.task.queue_position).toBeUndefined();
    expect((await taskRepo.findById(queued.task_id))?.queue_position).toBeUndefined();
  });

  dbTest('atomically fails a queued head whose immutable actor was deleted', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const users = new UsersRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const actor = await users.create({
      email: `${generateId()}-queued-actor@example.com`,
      role: 'member',
    });
    const queued = await taskRepo.createPending(
      createPendingInput({
        session_id: sessionId,
        status: TaskStatus.QUEUED,
        created_by: actor.user_id,
      })
    );
    await users.delete(actor.user_id);

    await expect(taskRepo.failQueuedTaskIfCreatorMissing(queued.task_id)).resolves.toMatchObject({
      outcome: 'actor_missing',
      task: {
        status: TaskStatus.FAILED,
        queue_position: undefined,
        error_message: MISSING_TASK_ACTOR_ERROR,
      },
    });
    await expect(
      taskRepo.claimDispatchAndProjectSession(queued.task_id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      })
    ).resolves.toMatchObject({ outcome: 'condition_changed', task: { status: TaskStatus.FAILED } });
  });

  dbTest('never overwrites a dispatch claim while checking a queue actor', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionId = await createSessionWithDeps(db);
    const queued = await taskRepo.createPending(
      createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
    );
    await expect(
      taskRepo.claimDispatchAndProjectSession(queued.task_id, TaskStatus.QUEUED, {
        status: TaskStatus.DISPATCHING,
      })
    ).resolves.toMatchObject({ outcome: 'claimed' });

    await expect(taskRepo.failQueuedTaskIfCreatorMissing(queued.task_id)).resolves.toMatchObject({
      outcome: 'condition_changed',
      task: { status: TaskStatus.DISPATCHING },
    });
    await expect(taskRepo.findById(queued.task_id)).resolves.toMatchObject({
      status: TaskStatus.DISPATCHING,
      queue_position: undefined,
    });
  });

  dbTest(
    'writes one correctly ordered widget transcript row only after busy-session drain claims it',
    async ({ db }) => {
      const taskRepo = new TaskRepository(db);
      const sessionRepo = new SessionRepository(db);
      const messagesRepo = new MessagesRepository(db);
      const sessionId = await createSessionWithDeps(db);
      const first = await taskRepo.createPending(
        createPendingInput({ session_id: sessionId, status: TaskStatus.QUEUED })
      );
      const firstClaim = await taskRepo.claimDispatchAndProjectSession(
        first.task_id,
        TaskStatus.QUEUED,
        { status: TaskStatus.DISPATCHING }
      );
      expect(firstClaim.outcome).toBe('claimed');
      await messagesRepo.create({
        message_id: generateId() as MessageID,
        session_id: sessionId,
        task_id: first.task_id,
        type: 'user',
        role: MessageRole.USER,
        index: 0,
        timestamp: new Date().toISOString(),
        content_preview: 'active prompt',
        content: 'active prompt',
      });

      const widgetTaskId = generateId();
      const widgetTask = await taskRepo.createPending({
        ...createPendingInput({
          session_id: sessionId,
          status: TaskStatus.QUEUED,
          metadata: {
            system_authored: true,
            widget_id: generateId() as MessageID,
            initial_message_id: widgetTaskId as MessageID,
          },
        }),
        task_id: widgetTaskId,
      });
      const lost = await taskRepo.claimDispatchAndProjectSession(
        widgetTask.task_id,
        TaskStatus.QUEUED,
        { status: TaskStatus.DISPATCHING }
      );
      expect(lost).toMatchObject({
        outcome: 'condition_changed',
        task: { status: TaskStatus.QUEUED },
      });
      expect(await messagesRepo.findByTaskId(widgetTask.task_id)).toHaveLength(0);

      await taskRepo.update(first.task_id, { status: TaskStatus.COMPLETED });
      await sessionRepo.update(sessionId, {
        status: SessionStatus.IDLE,
        ready_for_prompt: true,
      });
      const drained = await taskRepo.claimDispatchAndProjectSession(
        widgetTask.task_id,
        TaskStatus.QUEUED,
        {
          status: TaskStatus.DISPATCHING,
          message_range: {
            start_index: 1,
            end_index: 2,
            start_timestamp: new Date().toISOString(),
          },
        }
      );
      expect(drained.outcome).toBe('claimed');
      const stableMessageId = drained.task.metadata!.initial_message_id!;
      if (!(await messagesRepo.findById(stableMessageId))) {
        await messagesRepo.create({
          message_id: stableMessageId,
          session_id: sessionId,
          task_id: widgetTask.task_id,
          type: 'user',
          role: MessageRole.USER,
          index: drained.task.message_range.start_index,
          timestamp: drained.task.message_range.start_timestamp,
          content_preview: widgetTask.full_prompt,
          content: widgetTask.full_prompt,
        });
      }
      // A replacement daemon repeats reconciliation against the same durable
      // identity rather than creating a random second row.
      if (!(await messagesRepo.findById(stableMessageId))) {
        throw new Error('stable message unexpectedly missing');
      }

      const widgetMessages = await messagesRepo.findByTaskId(widgetTask.task_id);
      expect(widgetMessages).toHaveLength(1);
      expect(widgetMessages[0]).toMatchObject({ message_id: stableMessageId, index: 1 });
      expect(
        (await messagesRepo.findBySessionId(sessionId)).map((message) => message.index)
      ).toEqual([0, 1]);
    }
  );

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
      // libSQL serializes concurrent write transactions. The repository may
      // retry transient SQLITE_BUSY, but callers still receive one successful,
      // ordered admission decision rather than a leaked contention error.
      const admitted = await Promise.all([
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

      expect(admitted.map((task) => task.queue_position).sort()).toEqual([1, 2, 3]);
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

  dbTest('discovers bounded queued Session refs with a stable cursor', async ({ db }) => {
    const taskRepo = new TaskRepository(db);
    const sessionA = await createSessionWithDeps(db);
    const sessionB = await createSessionWithDeps(db);
    await taskRepo.createPending(
      createPendingInput({ session_id: sessionA, status: TaskStatus.QUEUED })
    );
    await taskRepo.createPending(
      createPendingInput({ session_id: sessionA, status: TaskStatus.QUEUED })
    );
    await taskRepo.createPending(
      createPendingInput({ session_id: sessionB, status: TaskStatus.QUEUED })
    );

    const firstPage = await taskRepo.findQueuedSessionRefs(1);
    const secondPage = await taskRepo.findQueuedSessionRefs(1, firstPage[0]);

    expect(firstPage).toHaveLength(1);
    expect(secondPage).toHaveLength(1);
    expect(new Set([firstPage[0]!.session_id, secondPage[0]!.session_id])).toEqual(
      new Set([sessionA, sessionB])
    );
    expect(firstPage[0]!.tenant_id).toBeUndefined();
    expect(Number.isFinite(firstPage[0]!.first_queued_at)).toBe(true);
    await expect(taskRepo.findQueuedSessionRefs(0)).rejects.toThrow(/between 1 and 1000/);
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
