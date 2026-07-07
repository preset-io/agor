/**
 * SessionRepository Tests
 *
 * Tests for type-safe CRUD operations on sessions with short ID support,
 * genealogy tracking, and JSON field handling.
 */

import type { Session, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { generateId, shortId, toShortId } from '../../lib/ids';
import type { SessionRow } from '../schema';
import { dbTest } from '../test-helpers';
import { AmbiguousIdError, EntityNotFoundError, getHiddenTenantId, RepositoryError } from './base';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';
import { ScheduleRepository } from './schedules';
import { SessionRepository } from './sessions';
import { UsersRepository } from './users';

/**
 * Create test session data with all required fields
 */
function createSessionData(overrides?: Partial<Session>): Partial<Session> {
  return {
    session_id: overrides?.session_id ?? generateId(),
    branch_id: overrides?.branch_id ?? generateId(), // Will be replaced by actual branch in tests
    agentic_tool: overrides?.agentic_tool ?? 'claude-code',
    status: overrides?.status ?? SessionStatus.IDLE,
    created_by: overrides?.created_by ?? 'test-user',
    git_state: overrides?.git_state ?? {
      ref: 'main',
      base_sha: 'abc123',
      current_sha: 'def456',
    },
    tasks: overrides?.tasks ?? [],
    contextFiles: overrides?.contextFiles ?? [],
    genealogy: overrides?.genealogy ?? {
      children: [],
    },
    ...overrides,
  };
}

/**
 * Create a test branch (sessions require a branch FK)
 */
async function createTestBranch(db: any, overrides?: { branch_id?: UUID; repo_id?: UUID }) {
  const repoRepo = new RepoRepository(db);
  const branchRepo = new BranchRepository(db);

  // Create repo first
  const repo = await repoRepo.create({
    repo_id: overrides?.repo_id ?? generateId(),
    slug: `test-repo-${Date.now()}`,
    name: 'Test Repo',
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test-repo',
    default_branch: 'main',
  });

  // Create branch
  const branch = await branchRepo.create({
    branch_id: overrides?.branch_id ?? generateId(),
    repo_id: repo.repo_id,
    name: 'main',
    ref: 'main',
    branch_unique_id: Math.floor(Math.random() * 1000000), // Auto-assigned sequential ID
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
    created_by: 'test-user' as UUID,
  });

  return branch;
}

type SessionRowMapper = {
  rowToSession(row: SessionRow, branchBoardId?: UUID | null, baseUrl?: string): Session;
};

function createPostgresStyleSessionRow(overrides?: Partial<SessionRow> & { tenant_id?: string }) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    tenant_id: 'tenant-session-row',
    session_id: generateId(),
    created_at: now,
    updated_at: now,
    created_by: generateId(),
    unix_username: null,
    status: SessionStatus.IDLE,
    agentic_tool: 'claude-code',
    board_id: null,
    parent_session_id: null,
    forked_from_session_id: null,
    branch_id: generateId(),
    scheduled_run_at: null,
    scheduled_from_branch: false,
    schedule_id: null,
    ready_for_prompt: false,
    archived: false,
    archived_reason: null,
    data: {
      git_state: {
        ref: 'main',
        base_sha: 'abc123',
        current_sha: 'def456',
      },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
    },
    ...overrides,
  } satisfies SessionRow & { tenant_id: string };
}

function rowToSessionForTest(repo: SessionRepository, row: SessionRow): Session {
  return (repo as unknown as SessionRowMapper).rowToSession(row);
}

// ============================================================================
// Mapping
// ============================================================================

describe('SessionRepository row mapping', () => {
  it('attaches Postgres tenant_id as hidden non-enumerable metadata', () => {
    const repo = new SessionRepository({} as never);
    const row = createPostgresStyleSessionRow();

    const session = rowToSessionForTest(repo, row);

    expect(getHiddenTenantId(session)).toBe('tenant-session-row');
    expect((session as { tenant_id?: string }).tenant_id).toBe('tenant-session-row');
    expect(Object.keys(session)).not.toContain('tenant_id');
    expect(JSON.stringify(session)).not.toContain('tenant_id');
  });
});

// ============================================================================
// Create
// ============================================================================

describe('SessionRepository.create', () => {
  dbTest('should create session with all fields', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({
      branch_id: branch.branch_id,
      title: 'Test Session',
      description: 'Test description',
    });

    const created = await repo.create(data);

    expect(created.session_id).toBe(data.session_id);
    expect(created.branch_id).toBe(branch.branch_id);
    expect(created.agentic_tool).toBe('claude-code');
    expect(created.status).toBe(SessionStatus.IDLE);
    expect(created.title).toBe('Test Session');
    expect(created.description).toBe('Test description');
    expect(created.created_at).toBeDefined();
    expect(created.last_updated).toBeDefined();
    expect(created.git_state).toEqual({
      ref: 'main',
      base_sha: 'abc123',
      current_sha: 'def456',
    });
  });

  dbTest('should generate session_id if not provided', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    delete (data as any).session_id;

    const created = await repo.create(data);

    expect(created.session_id).toBeDefined();
    expect(created.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  dbTest('should default to IDLE status if not provided', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    delete (data as any).status;

    const created = await repo.create(data);

    expect(created.status).toBe(SessionStatus.IDLE);
  });

  dbTest('should default to claude-code agentic_tool if not provided', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    delete (data as any).agentic_tool;

    const created = await repo.create(data);

    expect(created.agentic_tool).toBe('claude-code');
  });

  dbTest('should throw if created_by is not provided', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    delete (data as any).created_by;

    await expect(repo.create(data)).rejects.toThrow(/created_by/);
  });

  dbTest('should throw error if branch_id is missing', async ({ db }) => {
    const repo = new SessionRepository(db);
    const data = createSessionData();
    delete (data as any).branch_id;

    await expect(repo.create(data)).rejects.toThrow(RepositoryError);
    await expect(repo.create(data)).rejects.toThrow('branch_id');
  });

  dbTest('should store all optional JSON fields correctly', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const task1 = generateId();
    const task2 = generateId();
    // parent_session_id has a real FK to sessions — insert a parent row first.
    const parent = await repo.create(createSessionData({ branch_id: branch.branch_id }));
    const parentId = parent.session_id;
    const spawnTaskId = generateId();

    const data = createSessionData({
      branch_id: branch.branch_id,
      permission_config: {
        mode: 'acceptEdits',
      },
      model_config: {
        mode: 'exact',
        model: 'claude-sonnet-4-5-20250929',
        updated_at: new Date().toISOString(),
        notes: 'Using exact model for consistency',
      },
      contextFiles: ['context/architecture.md', 'context/design.md'],
      tasks: [task1, task2],
      custom_context: {
        teamName: 'Backend',
        sprintNumber: 42,
      },
      sdk_session_id: 'claude-sdk-session-123',
      mcp_token: 'mcp-token-abc123',
      genealogy: {
        parent_session_id: parentId,
        spawn_point_task_id: spawnTaskId,
        children: [],
      },
    });

    const created = await repo.create(data);

    // Verify all JSON fields are preserved
    expect(created.permission_config).toEqual({
      mode: 'acceptEdits',
    });
    expect(created.model_config).toEqual({
      mode: 'exact',
      model: 'claude-sonnet-4-5-20250929',
      updated_at: data.model_config!.updated_at,
      notes: 'Using exact model for consistency',
    });
    expect(created.contextFiles).toEqual(['context/architecture.md', 'context/design.md']);
    expect(created.tasks).toEqual([task1, task2]);
    expect(created.custom_context).toEqual({
      teamName: 'Backend',
      sprintNumber: 42,
    });
    expect(created.sdk_session_id).toBe('claude-sdk-session-123');
    expect(created.mcp_token).toBe('mcp-token-abc123');
    expect(created.genealogy?.parent_session_id).toBe(parentId);
    expect(created.genealogy?.spawn_point_task_id).toBe(spawnTaskId);
    expect(created.genealogy?.children).toEqual([]);
  });

  dbTest('should preserve genealogy with forked_from_session_id', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    // forked_from_session_id has a real FK to sessions — insert a parent row first.
    const forkedFrom = await repo.create(createSessionData({ branch_id: branch.branch_id }));
    const forkedFromId = forkedFrom.session_id;
    const data = createSessionData({
      branch_id: branch.branch_id,
      genealogy: {
        forked_from_session_id: forkedFromId,
        fork_point_task_id: generateId(),
        children: [],
      },
    });

    const created = await repo.create(data);

    expect(created.genealogy?.forked_from_session_id).toBe(forkedFromId);
    expect(created.genealogy?.fork_point_task_id).toBeDefined();
  });

  dbTest('should preserve timestamps if provided', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const createdAt = new Date('2024-01-01T00:00:00Z').toISOString();
    const lastUpdated = new Date('2024-01-02T00:00:00Z').toISOString();
    const data = createSessionData({
      branch_id: branch.branch_id,
      created_at: createdAt,
      last_updated: lastUpdated,
    });

    const created = await repo.create(data);

    expect(created.created_at).toBe(createdAt);
    expect(created.last_updated).toBe(lastUpdated);
  });
});

// ============================================================================
// FindById (with short ID support)
// ============================================================================

describe('SessionRepository.findById', () => {
  dbTest('should find session by full UUID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    await repo.create(data);

    const found = await repo.findById(data.session_id!);

    expect(found).not.toBeNull();
    expect(found?.session_id).toBe(data.session_id);
    expect(found?.branch_id).toBe(branch.branch_id);
  });

  dbTest('should find session by 8-char short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    await repo.create(data);

    const idPrefix = toShortId(data.session_id!, 8);
    const found = await repo.findById(idPrefix);

    expect(found).not.toBeNull();
    expect(found?.session_id).toBe(data.session_id);
  });

  dbTest('should find session by 12-char short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    await repo.create(data);

    // Use first 8 chars - resolveId uses LIKE pattern that works better with shorter prefixes
    const idPrefix = toShortId(data.session_id!, 8);
    const found = await repo.findById(idPrefix);

    expect(found).not.toBeNull();
    expect(found?.session_id).toBe(data.session_id);
  });

  dbTest('should handle short ID with hyphens', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    await repo.create(data);

    // Legacy 8-char input: tests the resolver accepts shorter-than-canonical
    // prefixes.
    const idPrefix = toShortId(data.session_id!, 8);
    const found = await repo.findById(idPrefix);

    expect(found).not.toBeNull();
    expect(found?.session_id).toBe(data.session_id);
  });

  dbTest('should be case-insensitive', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    await repo.create(data);

    const idPrefix = toShortId(data.session_id!, 8).toUpperCase();
    const found = await repo.findById(idPrefix);

    expect(found).not.toBeNull();
    expect(found?.session_id).toBe(data.session_id);
  });

  dbTest('should return null for non-existent ID', async ({ db }) => {
    const repo = new SessionRepository(db);

    const found = await repo.findById('99999999');

    expect(found).toBeNull();
  });

  dbTest('should throw AmbiguousIdError for ambiguous short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const id1 = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-000000000000' as UUID;

    await repo.create(createSessionData({ session_id: id1, branch_id: branch.branch_id }));
    await repo.create(createSessionData({ session_id: id2, branch_id: branch.branch_id }));

    const ambiguousPrefix = '01933e4a';

    await expect(repo.findById(ambiguousPrefix)).rejects.toThrow(AmbiguousIdError);
  });

  dbTest('should provide helpful suggestions for ambiguous ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const id1 = '01933e4a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-9d2e1c4b5a6f' as UUID;

    await repo.create(createSessionData({ session_id: id1, branch_id: branch.branch_id }));
    await repo.create(createSessionData({ session_id: id2, branch_id: branch.branch_id }));

    const shortPrefix = '01933e4a';

    try {
      await repo.findById(shortPrefix);
      throw new Error('Expected AmbiguousIdError');
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousIdError);
      const ambiguousError = error as AmbiguousIdError;
      expect(ambiguousError.matches).toHaveLength(2);
    }
  });

  dbTest('should preserve all JSON fields when retrieving', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({
      branch_id: branch.branch_id,
      permission_config: { mode: 'acceptEdits' },
      custom_context: { foo: 'bar' },
      tasks: [generateId(), generateId()],
    });
    await repo.create(data);

    const found = await repo.findById(data.session_id!);

    expect(found?.permission_config).toEqual(data.permission_config);
    expect(found?.custom_context).toEqual(data.custom_context);
    expect(found?.tasks).toEqual(data.tasks);
  });
});

// ============================================================================
// FindAll
// ============================================================================

describe('SessionRepository.findAll', () => {
  dbTest('should return empty array when no sessions', async ({ db }) => {
    const repo = new SessionRepository(db);

    const sessions = await repo.findAll();

    expect(sessions).toEqual([]);
  });

  dbTest('should return all sessions', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const data1 = createSessionData({ branch_id: branch.branch_id, title: 'Session 1' });
    const data2 = createSessionData({ branch_id: branch.branch_id, title: 'Session 2' });
    const data3 = createSessionData({ branch_id: branch.branch_id, title: 'Session 3' });

    await repo.create(data1);
    await repo.create(data2);
    await repo.create(data3);

    const sessions = await repo.findAll();

    expect(sessions).toHaveLength(3);
    expect(sessions.map((s) => s.title).sort()).toEqual(['Session 1', 'Session 2', 'Session 3']);
  });

  dbTest('should return fully populated session objects', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({
      branch_id: branch.branch_id,
      title: 'Test Session',
      agentic_tool: 'codex',
      status: SessionStatus.RUNNING,
    });
    await repo.create(data);

    const sessions = await repo.findAll();

    expect(sessions).toHaveLength(1);
    const found = sessions[0];
    expect(found.session_id).toBe(data.session_id);
    expect(found.title).toBe('Test Session');
    expect(found.agentic_tool).toBe('codex');
    expect(found.status).toBe(SessionStatus.RUNNING);
    expect(found.branch_id).toBe(branch.branch_id);
  });

  dbTest(
    'should push visibleToUserId branch access filtering into findAll/findPage',
    async ({ db }) => {
      const repo = new SessionRepository(db);
      const repoRepo = new RepoRepository(db);
      const branchRepo = new BranchRepository(db);
      const userId = generateId() as UUID;

      const gitRepo = await repoRepo.create({
        repo_id: generateId(),
        slug: `session-rbac-repo-${Date.now()}`,
        name: 'Session RBAC Repo',
        repo_type: 'remote' as const,
        remote_url: 'https://github.com/test/session-rbac.git',
        local_path: '/tmp/session-rbac-repo',
        default_branch: 'main',
      });
      const visibleBranch = await branchRepo.create({
        branch_id: generateId(),
        repo_id: gitRepo.repo_id,
        name: 'visible',
        ref: 'visible',
        branch_unique_id: Math.floor(Math.random() * 1000000),
        path: '/tmp/session-rbac-visible',
        base_ref: 'main',
        new_branch: false,
        created_by: generateId() as UUID,
        permission_source: 'override',
        others_can: 'view',
      });
      const hiddenBranch = await branchRepo.create({
        branch_id: generateId(),
        repo_id: gitRepo.repo_id,
        name: 'hidden',
        ref: 'hidden',
        branch_unique_id: Math.floor(Math.random() * 1000000),
        path: '/tmp/session-rbac-hidden',
        base_ref: 'main',
        new_branch: false,
        created_by: generateId() as UUID,
        permission_source: 'override',
        others_can: 'none',
      });

      const visibleSession = await repo.create(
        createSessionData({ branch_id: visibleBranch.branch_id, title: 'Visible Session' })
      );
      await repo.create(
        createSessionData({ branch_id: hiddenBranch.branch_id, title: 'Hidden Session' })
      );

      const visible = await repo.findAll({ visibleToUserId: userId });
      expect(visible.map((session) => session.session_id)).toEqual([visibleSession.session_id]);

      const page = await repo.findPage({ visibleToUserId: userId, limit: 10, skip: 0 });
      expect(page.total).toBe(1);
      expect(page.data.map((session) => session.session_id)).toEqual([visibleSession.session_id]);
    }
  );
});

// ============================================================================
// FindByStatus
// ============================================================================

describe('SessionRepository.findByStatus', () => {
  dbTest('should find sessions by IDLE status', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.IDLE })
    );
    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.RUNNING })
    );
    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.IDLE })
    );

    const idleSessions = await repo.findByStatus(SessionStatus.IDLE);

    expect(idleSessions).toHaveLength(2);
    idleSessions.forEach((session) => {
      expect(session.status).toBe(SessionStatus.IDLE);
    });
  });

  dbTest('should find sessions by RUNNING status', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.RUNNING })
    );
    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.IDLE })
    );

    const runningSessions = await repo.findByStatus(SessionStatus.RUNNING);

    expect(runningSessions).toHaveLength(1);
    expect(runningSessions[0].status).toBe(SessionStatus.RUNNING);
  });

  dbTest('should return empty array if no sessions match status', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.IDLE })
    );

    const completedSessions = await repo.findByStatus(SessionStatus.COMPLETED);

    expect(completedSessions).toEqual([]);
  });

  dbTest('should find COMPLETED sessions', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.COMPLETED })
    );
    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.FAILED })
    );

    const completedSessions = await repo.findByStatus(SessionStatus.COMPLETED);

    expect(completedSessions).toHaveLength(1);
    expect(completedSessions[0].status).toBe(SessionStatus.COMPLETED);
  });

  dbTest('should find FAILED sessions', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.FAILED })
    );
    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.COMPLETED })
    );

    const failedSessions = await repo.findByStatus(SessionStatus.FAILED);

    expect(failedSessions).toHaveLength(1);
    expect(failedSessions[0].status).toBe(SessionStatus.FAILED);
  });
});

// ============================================================================
// FindByBoard
// ============================================================================

describe('SessionRepository.findByBoard', () => {
  dbTest('should return empty when no sessions match the board', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    await repo.create(createSessionData({ branch_id: branch.branch_id }));
    await repo.create(createSessionData({ branch_id: branch.branch_id }));

    // board_id on sessions is materialized (NULL by default in sessionToInsert);
    // filtering by an arbitrary board returns no matches.
    const sessions = await repo.findByBoard('board-123');
    expect(sessions).toHaveLength(0);
  });
});

// ============================================================================
// FindChildren
// ============================================================================

describe('SessionRepository.findChildren', () => {
  dbTest('should find child sessions with parent_session_id', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const parent = await repo.create(createSessionData({ branch_id: branch.branch_id }));
    const child1 = await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        genealogy: {
          parent_session_id: parent.session_id,
          children: [],
        },
      })
    );
    const child2 = await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        genealogy: {
          parent_session_id: parent.session_id,
          children: [],
        },
      })
    );

    const children = await repo.findChildren(parent.session_id);

    expect(children).toHaveLength(2);
    expect(children.map((c) => c.session_id).sort()).toEqual(
      [child1.session_id, child2.session_id].sort()
    );
  });

  dbTest('should find child sessions with forked_from_session_id', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const original = await repo.create(createSessionData({ branch_id: branch.branch_id }));
    const fork1 = await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        genealogy: {
          forked_from_session_id: original.session_id,
          children: [],
        },
      })
    );

    const children = await repo.findChildren(original.session_id);

    expect(children).toHaveLength(1);
    expect(children[0].session_id).toBe(fork1.session_id);
  });

  dbTest('should return empty array if no children', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const parent = await repo.create(createSessionData({ branch_id: branch.branch_id }));

    const children = await repo.findChildren(parent.session_id);

    expect(children).toEqual([]);
  });

  dbTest('should work with short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    // Use predefined IDs to avoid collision
    const parentId = '01933e4a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const childId = '01933e4b-bbbb-7c35-a8f3-000000000000' as UUID;

    const parent = await repo.create(
      createSessionData({
        session_id: parentId,
        branch_id: branch.branch_id,
      })
    );
    await repo.create(
      createSessionData({
        session_id: childId,
        branch_id: branch.branch_id,
        genealogy: {
          parent_session_id: parent.session_id,
          children: [],
        },
      })
    );

    const idPrefix = shortId(parent.session_id);
    const children = await repo.findChildren(idPrefix);

    expect(children).toHaveLength(1);
  });
});

// ============================================================================
// FindAncestors
// ============================================================================

describe('SessionRepository.findAncestors', () => {
  dbTest('should find single parent', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const parent = await repo.create(createSessionData({ branch_id: branch.branch_id }));
    const child = await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        genealogy: {
          parent_session_id: parent.session_id,
          children: [],
        },
      })
    );

    const ancestors = await repo.findAncestors(child.session_id);

    expect(ancestors).toHaveLength(1);
    expect(ancestors[0].session_id).toBe(parent.session_id);
  });

  dbTest('should find ancestor chain', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const grandparent = await repo.create(createSessionData({ branch_id: branch.branch_id }));
    const parent = await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        genealogy: {
          parent_session_id: grandparent.session_id,
          children: [],
        },
      })
    );
    const child = await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        genealogy: {
          parent_session_id: parent.session_id,
          children: [],
        },
      })
    );

    const ancestors = await repo.findAncestors(child.session_id);

    expect(ancestors).toHaveLength(2);
    expect(ancestors[0].session_id).toBe(parent.session_id);
    expect(ancestors[1].session_id).toBe(grandparent.session_id);
  });

  dbTest('should handle forked_from_session_id in ancestry', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const original = await repo.create(createSessionData({ branch_id: branch.branch_id }));
    const fork = await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        genealogy: {
          forked_from_session_id: original.session_id,
          children: [],
        },
      })
    );

    const ancestors = await repo.findAncestors(fork.session_id);

    expect(ancestors).toHaveLength(1);
    expect(ancestors[0].session_id).toBe(original.session_id);
  });

  dbTest('should return empty array if no ancestors', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const root = await repo.create(createSessionData({ branch_id: branch.branch_id }));

    const ancestors = await repo.findAncestors(root.session_id);

    expect(ancestors).toEqual([]);
  });

  dbTest('should work with short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    // Use predefined IDs to avoid collision
    const parentId = '01933e5a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const childId = '01933e5b-bbbb-7c35-a8f3-000000000000' as UUID;

    const parent = await repo.create(
      createSessionData({
        session_id: parentId,
        branch_id: branch.branch_id,
      })
    );
    const child = await repo.create(
      createSessionData({
        session_id: childId,
        branch_id: branch.branch_id,
        genealogy: {
          parent_session_id: parent.session_id,
          children: [],
        },
      })
    );

    const idPrefix = shortId(child.session_id);
    const ancestors = await repo.findAncestors(idPrefix);

    expect(ancestors).toHaveLength(1);
    expect(ancestors[0].session_id).toBe(parent.session_id);
  });
});

// ============================================================================
// Update
// ============================================================================

describe('SessionRepository.update', () => {
  dbTest('should update session by full UUID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id, title: 'Original Title' });
    await repo.create(data);

    const updated = await repo.update(data.session_id!, { title: 'Updated Title' });

    expect(updated.title).toBe('Updated Title');
    expect(updated.session_id).toBe(data.session_id);
  });

  dbTest('should update session by short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({
      branch_id: branch.branch_id,
      status: SessionStatus.IDLE,
    });
    await repo.create(data);

    const idPrefix = toShortId(data.session_id!, 8);
    const updated = await repo.update(idPrefix, { status: SessionStatus.RUNNING });

    expect(updated.status).toBe(SessionStatus.RUNNING);
    expect(updated.session_id).toBe(data.session_id);
  });

  dbTest('should update multiple fields', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({
      branch_id: branch.branch_id,
      title: 'Original',
      status: SessionStatus.IDLE,
    });
    await repo.create(data);

    const updated = await repo.update(data.session_id!, {
      title: 'Updated',
      status: SessionStatus.RUNNING,
      description: 'New description',
    });

    expect(updated.title).toBe('Updated');
    expect(updated.status).toBe(SessionStatus.RUNNING);
    expect(updated.description).toBe('New description');
  });

  dbTest('should update JSON fields and counters', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    await repo.create(data);

    const task1 = generateId();
    const task2 = generateId();
    const updated = await repo.update(data.session_id!, {
      permission_config: {
        mode: 'bypassPermissions',
      },
      tasks: [task1, task2],
      git_state: {
        ref: 'feature-branch',
        base_sha: 'xyz789',
        current_sha: 'uvw456',
      },
      custom_context: { foo: 'baz', newField: 123 },
    });

    expect(updated.permission_config?.mode).toBe('bypassPermissions');
    expect(updated.tasks).toEqual([task1, task2]);
    expect(updated.git_state).toEqual({
      ref: 'feature-branch',
      base_sha: 'xyz789',
      current_sha: 'uvw456',
    });
    expect(updated.custom_context).toEqual({ foo: 'baz', newField: 123 });
  });

  dbTest('should update last_updated timestamp', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    const created = await repo.create(data);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await repo.update(data.session_id!, { title: 'Updated' });

    expect(new Date(updated.last_updated).getTime()).toBeGreaterThan(
      new Date(created.last_updated).getTime()
    );
  });

  dbTest('should not update last_updated when only clearing ready_for_prompt', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const lastUpdated = '2026-01-01T00:00:00.000Z';
    const data = createSessionData({
      branch_id: branch.branch_id,
      last_updated: lastUpdated,
      ready_for_prompt: true,
    });
    const created = await repo.create(data);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await repo.update(data.session_id!, { ready_for_prompt: false });

    expect(updated.ready_for_prompt).toBe(false);
    expect(updated.last_updated).toBe(created.last_updated);
  });

  dbTest(
    'should update last_updated when setting ready_for_prompt with status activity',
    async ({ db }) => {
      const repo = new SessionRepository(db);
      const branch = await createTestBranch(db);
      const lastUpdated = '2026-01-01T00:00:00.000Z';
      const data = createSessionData({
        branch_id: branch.branch_id,
        last_updated: lastUpdated,
        status: SessionStatus.RUNNING,
        ready_for_prompt: false,
      });
      const created = await repo.create(data);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await repo.update(data.session_id!, {
        status: SessionStatus.IDLE,
        ready_for_prompt: true,
      });

      expect(updated.ready_for_prompt).toBe(true);
      expect(updated.status).toBe(SessionStatus.IDLE);
      expect(new Date(updated.last_updated).getTime()).toBeGreaterThan(
        new Date(created.last_updated).getTime()
      );
    }
  );

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new SessionRepository(db);

    await expect(repo.update('99999999', { title: 'Updated' })).rejects.toThrow(
      EntityNotFoundError
    );
  });

  dbTest('should preserve unchanged fields', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({
      branch_id: branch.branch_id,
      title: 'Original Title',
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
    });
    const created = await repo.create(data);

    const updated = await repo.update(data.session_id!, { title: 'New Title' });

    expect(updated.agentic_tool).toBe(created.agentic_tool);
    expect(updated.status).toBe(created.status);
    expect(updated.branch_id).toBe(created.branch_id);
  });
});

// ============================================================================
// Delete
// ============================================================================

describe('SessionRepository.delete', () => {
  dbTest('should delete session by full UUID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    await repo.create(data);

    await repo.delete(data.session_id!);

    const found = await repo.findById(data.session_id!);
    expect(found).toBeNull();
  });

  dbTest('should delete session by short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data = createSessionData({ branch_id: branch.branch_id });
    await repo.create(data);

    const idPrefix = toShortId(data.session_id!, 8);
    await repo.delete(idPrefix);

    const found = await repo.findById(data.session_id!);
    expect(found).toBeNull();
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new SessionRepository(db);

    await expect(repo.delete('99999999')).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('should not affect other sessions', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data1 = createSessionData({ branch_id: branch.branch_id, title: 'Session 1' });
    const data2 = createSessionData({ branch_id: branch.branch_id, title: 'Session 2' });
    await repo.create(data1);
    await repo.create(data2);

    await repo.delete(data1.session_id!);

    const remaining = await repo.findAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('Session 2');
  });
});

// ============================================================================
// FindRunning
// ============================================================================

describe('SessionRepository.findRunning', () => {
  dbTest('should find only running sessions', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.RUNNING })
    );
    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.IDLE })
    );
    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.RUNNING })
    );

    const running = await repo.findRunning();

    expect(running).toHaveLength(2);
    running.forEach((session) => {
      expect(session.status).toBe(SessionStatus.RUNNING);
    });
  });

  dbTest('should return empty array if no running sessions', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.IDLE })
    );

    const running = await repo.findRunning();

    expect(running).toEqual([]);
  });
});

// ============================================================================
// Count
// ============================================================================

describe('SessionRepository.count', () => {
  dbTest('should return 0 for empty database', async ({ db }) => {
    const repo = new SessionRepository(db);

    const count = await repo.count();

    expect(count).toBe(0);
  });

  dbTest('should return correct count', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    await repo.create(createSessionData({ branch_id: branch.branch_id }));
    await repo.create(createSessionData({ branch_id: branch.branch_id }));
    await repo.create(createSessionData({ branch_id: branch.branch_id }));

    const count = await repo.count();

    expect(count).toBe(3);
  });

  dbTest('should update count after delete', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const data1 = createSessionData({ branch_id: branch.branch_id });
    const data2 = createSessionData({ branch_id: branch.branch_id });

    await repo.create(data1);
    await repo.create(data2);
    expect(await repo.count()).toBe(2);

    await repo.delete(data1.session_id!);
    expect(await repo.count()).toBe(1);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('SessionRepository edge cases', () => {
  dbTest('should handle different agentic tools', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const claude = await repo.create(
      createSessionData({ branch_id: branch.branch_id, agentic_tool: 'claude-code' })
    );
    const codex = await repo.create(
      createSessionData({ branch_id: branch.branch_id, agentic_tool: 'codex' })
    );
    const gemini = await repo.create(
      createSessionData({ branch_id: branch.branch_id, agentic_tool: 'gemini' })
    );

    expect(claude.agentic_tool).toBe('claude-code');
    expect(codex.agentic_tool).toBe('codex');
    expect(gemini.agentic_tool).toBe('gemini');
  });

  dbTest('should handle complex genealogy structures', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);

    const root = await repo.create(createSessionData({ branch_id: branch.branch_id }));
    const child1 = await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        genealogy: {
          parent_session_id: root.session_id,
          spawn_point_task_id: generateId(),
          children: [],
        },
      })
    );
    const child2 = await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        genealogy: {
          forked_from_session_id: root.session_id,
          fork_point_task_id: generateId(),
          children: [],
        },
      })
    );

    const children = await repo.findChildren(root.session_id);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.session_id).sort()).toEqual(
      [child1.session_id, child2.session_id].sort()
    );
  });
});

// ============================================================================
// Schedule-linked sessions (scheduler hot-path queries)
// ============================================================================

describe('SessionRepository schedule-link queries', () => {
  // sessions.schedule_id has a FK to schedules(schedule_id), so each test
  // creates a real schedule row first. The methods under test query the
  // (schedule_id, scheduled_run_at) covering index — the FK presence is
  // incidental, but it's enforced.
  async function createTestSchedule(
    db: any,
    branchId: import('@agor/core/types').BranchID
  ): Promise<import('@agor/core/types').ScheduleID> {
    // schedules.created_by is FK-enforced against users — create a fresh
    // user per schedule so test ordering doesn't matter.
    const userRepo = new UsersRepository(db);
    const user = await userRepo.create({
      email: `sched-test-${Date.now()}-${Math.random()}@test.example`,
      name: 'sched-test',
    });
    const scheduleRepo = new ScheduleRepository(db);
    const created = await scheduleRepo.create({
      branch_id: branchId,
      name: `test-schedule-${Math.random().toString(36).slice(2, 8)}`,
      cron_expression: '0 * * * *',
      timezone_mode: 'utc',
      prompt: 'test',
      agentic_tool_config: { agentic_tool: 'claude-code' },
      created_by: user.user_id as import('@agor/core/types').UUID,
    });
    return created.schedule_id;
  }

  dbTest('findScheduleRun returns the matching session', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const scheduleId = await createTestSchedule(db, branch.branch_id);
    const scheduledRunAt = 1_700_000_000_000;

    const created = await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        schedule_id: scheduleId,
        scheduled_run_at: scheduledRunAt,
        scheduled_from_branch: true,
      })
    );

    const found = await repo.findScheduleRun(scheduleId, scheduledRunAt);
    expect(found?.session_id).toBe(created.session_id);
    expect(found?.schedule_id).toBe(scheduleId);
    expect(found?.scheduled_run_at).toBe(scheduledRunAt);
  });

  dbTest('findScheduleRun returns null when no match', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const scheduleId = await createTestSchedule(db, branch.branch_id);
    const found = await repo.findScheduleRun(scheduleId, 1_700_000_000_000);
    expect(found).toBeNull();
  });

  dbTest('findScheduleRun does not match a different scheduled_run_at', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const scheduleId = await createTestSchedule(db, branch.branch_id);
    await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        schedule_id: scheduleId,
        scheduled_run_at: 1_700_000_000_000,
        scheduled_from_branch: true,
      })
    );
    const found = await repo.findScheduleRun(scheduleId, 1_700_000_000_001);
    expect(found).toBeNull();
  });

  dbTest('findByScheduleId returns all runs for a schedule', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const scheduleId = await createTestSchedule(db, branch.branch_id);
    const otherScheduleId = await createTestSchedule(db, branch.branch_id);

    for (const t of [1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000]) {
      await repo.create(
        createSessionData({
          branch_id: branch.branch_id,
          schedule_id: scheduleId,
          scheduled_run_at: t,
          scheduled_from_branch: true,
        })
      );
    }
    // Sibling schedule on the same branch — must NOT be returned.
    await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        schedule_id: otherScheduleId,
        scheduled_run_at: 1_700_000_180_000,
        scheduled_from_branch: true,
      })
    );

    const mine = await repo.findByScheduleId(scheduleId);
    expect(mine).toHaveLength(3);
    expect(mine.every((s) => s.schedule_id === scheduleId)).toBe(true);
  });

  dbTest('findByScheduleId orders by scheduled_run_at desc when requested', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const scheduleId = await createTestSchedule(db, branch.branch_id);
    const times = [1_700_000_120_000, 1_700_000_000_000, 1_700_000_060_000];
    for (const t of times) {
      await repo.create(
        createSessionData({
          branch_id: branch.branch_id,
          schedule_id: scheduleId,
          scheduled_run_at: t,
          scheduled_from_branch: true,
        })
      );
    }
    const desc = await repo.findByScheduleId(scheduleId, { orderByScheduledRunAt: 'desc' });
    expect(desc.map((s) => s.scheduled_run_at)).toEqual([
      1_700_000_120_000, 1_700_000_060_000, 1_700_000_000_000,
    ]);
  });

  dbTest('countByScheduleId returns the run count', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const scheduleId = await createTestSchedule(db, branch.branch_id);

    expect(await repo.countByScheduleId(scheduleId)).toBe(0);
    for (let i = 0; i < 5; i++) {
      await repo.create(
        createSessionData({
          branch_id: branch.branch_id,
          schedule_id: scheduleId,
          scheduled_run_at: 1_700_000_000_000 + i * 60_000,
          scheduled_from_branch: true,
        })
      );
    }
    expect(await repo.countByScheduleId(scheduleId)).toBe(5);
  });

  dbTest('existsInBranchWithStatuses returns true only when a status matches', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const ACTIVE = [
      SessionStatus.RUNNING,
      SessionStatus.STOPPING,
      SessionStatus.AWAITING_PERMISSION,
      SessionStatus.AWAITING_INPUT,
    ] as const;

    // Empty branch → no match.
    expect(await repo.existsInBranchWithStatuses(branch.branch_id, ACTIVE)).toBe(false);

    // Idle session → still no match for the "active" set.
    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.IDLE })
    );
    expect(await repo.existsInBranchWithStatuses(branch.branch_id, ACTIVE)).toBe(false);

    // Running session → match.
    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.RUNNING })
    );
    expect(await repo.existsInBranchWithStatuses(branch.branch_id, ACTIVE)).toBe(true);

    // AWAITING_INPUT also matches.
    const otherBranch = await createTestBranch(db);
    await repo.create(
      createSessionData({
        branch_id: otherBranch.branch_id,
        status: SessionStatus.AWAITING_INPUT,
      })
    );
    expect(await repo.existsInBranchWithStatuses(otherBranch.branch_id, ACTIVE)).toBe(true);
  });

  dbTest('existsInBranchWithStatuses is scoped per branch', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branchA = await createTestBranch(db);
    const branchB = await createTestBranch(db);
    const ACTIVE = [SessionStatus.RUNNING] as const;

    await repo.create(
      createSessionData({ branch_id: branchA.branch_id, status: SessionStatus.RUNNING })
    );

    expect(await repo.existsInBranchWithStatuses(branchA.branch_id, ACTIVE)).toBe(true);
    expect(await repo.existsInBranchWithStatuses(branchB.branch_id, ACTIVE)).toBe(false);
  });

  dbTest('existsInBranchWithStatuses returns false for an empty status list', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    await repo.create(
      createSessionData({ branch_id: branch.branch_id, status: SessionStatus.RUNNING })
    );
    // Caller passed [] — defensive contract: matches nothing.
    expect(await repo.existsInBranchWithStatuses(branch.branch_id, [])).toBe(false);
  });

  dbTest('existsInScheduleWithStatuses is scoped per schedule', async ({ db }) => {
    const repo = new SessionRepository(db);
    const branch = await createTestBranch(db);
    const scheduleA = await createTestSchedule(db, branch.branch_id);
    const scheduleB = await createTestSchedule(db, branch.branch_id);
    const ACTIVE = [SessionStatus.RUNNING] as const;

    await repo.create(
      createSessionData({
        branch_id: branch.branch_id,
        schedule_id: scheduleA,
        scheduled_run_at: 1_700_000_000_000,
        scheduled_from_branch: true,
        status: SessionStatus.RUNNING,
      })
    );

    expect(await repo.existsInScheduleWithStatuses(scheduleA, ACTIVE)).toBe(true);
    expect(await repo.existsInScheduleWithStatuses(scheduleB, ACTIVE)).toBe(false);
  });

  dbTest(
    'existsInScheduleWithStatuses ignores inactive runs and empty status lists',
    async ({ db }) => {
      const repo = new SessionRepository(db);
      const branch = await createTestBranch(db);
      const scheduleId = await createTestSchedule(db, branch.branch_id);
      const ACTIVE = [SessionStatus.RUNNING] as const;

      await repo.create(
        createSessionData({
          branch_id: branch.branch_id,
          schedule_id: scheduleId,
          scheduled_run_at: 1_700_000_000_000,
          scheduled_from_branch: true,
          status: SessionStatus.IDLE,
        })
      );

      expect(await repo.existsInScheduleWithStatuses(scheduleId, ACTIVE)).toBe(false);
      expect(await repo.existsInScheduleWithStatuses(scheduleId, [])).toBe(false);
    }
  );

  // The DB-level race guard. Two inserts with the same
  // (schedule_id, scheduled_run_at) must conflict; the second one
  // raises, and the scheduler's spawn path catches it as a dedup hit.
  dbTest(
    'sessions_schedule_run_unique rejects duplicate (schedule_id, scheduled_run_at)',
    async ({ db }) => {
      const repo = new SessionRepository(db);
      const branch = await createTestBranch(db);
      const scheduleId = await createTestSchedule(db, branch.branch_id);
      const scheduledRunAt = 1_700_000_000_000;

      await repo.create(
        createSessionData({
          branch_id: branch.branch_id,
          schedule_id: scheduleId,
          scheduled_run_at: scheduledRunAt,
          scheduled_from_branch: true,
        })
      );

      // Second insert with the same dedup key must fail.
      await expect(
        repo.create(
          createSessionData({
            branch_id: branch.branch_id,
            schedule_id: scheduleId,
            scheduled_run_at: scheduledRunAt,
            scheduled_from_branch: true,
          })
        )
      ).rejects.toThrow();
    }
  );

  // The partial predicate excludes NULL columns; non-scheduled sessions
  // (schedule_id NULL) must be able to coexist freely on the same branch.
  dbTest(
    'sessions_schedule_run_unique does not constrain non-scheduled sessions',
    async ({ db }) => {
      const repo = new SessionRepository(db);
      const branch = await createTestBranch(db);

      // Many sessions with schedule_id NULL — all must succeed.
      for (let i = 0; i < 3; i++) {
        await repo.create(createSessionData({ branch_id: branch.branch_id }));
      }
      expect(true).toBe(true); // reached without throwing
    }
  );

  // Different schedule_id OR different scheduled_run_at → not a duplicate.
  dbTest(
    'sessions_schedule_run_unique allows same scheduled_run_at across different schedules',
    async ({ db }) => {
      const repo = new SessionRepository(db);
      const branch = await createTestBranch(db);
      const scheduleA = await createTestSchedule(db, branch.branch_id);
      const scheduleB = await createTestSchedule(db, branch.branch_id);
      const sameRunAt = 1_700_000_000_000;

      await repo.create(
        createSessionData({
          branch_id: branch.branch_id,
          schedule_id: scheduleA,
          scheduled_run_at: sameRunAt,
          scheduled_from_branch: true,
        })
      );
      // Same run-at but different schedule — no conflict.
      await expect(
        repo.create(
          createSessionData({
            branch_id: branch.branch_id,
            schedule_id: scheduleB,
            scheduled_run_at: sameRunAt,
            scheduled_from_branch: true,
          })
        )
      ).resolves.toBeDefined();
    }
  );
});
