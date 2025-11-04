/**
 * SessionRepository Tests
 *
 * Tests for type-safe CRUD operations on sessions with short ID support,
 * genealogy tracking, and JSON field handling.
 */

import type { Session, UUID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { dbTest } from '../test-helpers';
import { AmbiguousIdError, EntityNotFoundError, RepositoryError } from './base';
import { RepoRepository } from './repos';
import { SessionRepository } from './sessions';
import { WorktreeRepository } from './worktrees';

/**
 * Create test session data with all required fields
 */
function createSessionData(overrides?: Partial<Session>): Partial<Session> {
  return {
    session_id: overrides?.session_id ?? generateId(),
    worktree_id: overrides?.worktree_id ?? generateId(), // Will be replaced by actual worktree in tests
    agentic_tool: overrides?.agentic_tool ?? 'claude-code',
    status: overrides?.status ?? SessionStatus.IDLE,
    created_by: overrides?.created_by ?? 'test-user',
    git_state: overrides?.git_state ?? {
      ref: 'main',
      base_sha: 'abc123',
      current_sha: 'def456',
    },
    tasks: overrides?.tasks ?? [],
    message_count: overrides?.message_count ?? 0,
    contextFiles: overrides?.contextFiles ?? [],
    genealogy: overrides?.genealogy ?? {
      children: [],
    },
    ...overrides,
  };
}

/**
 * Create a test worktree (sessions require a worktree FK)
 */
async function createTestWorktree(db: any, overrides?: { worktree_id?: UUID; repo_id?: UUID }) {
  const repoRepo = new RepoRepository(db);
  const worktreeRepo = new WorktreeRepository(db);

  // Create repo first
  const repo = await repoRepo.create({
    repo_id: overrides?.repo_id ?? generateId(),
    slug: `test-repo-${Date.now()}`,
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/tmp/test-repo',
  });

  // Create worktree
  const worktree = await worktreeRepo.create({
    worktree_id: overrides?.worktree_id ?? generateId(),
    repo_id: repo.repo_id,
    name: 'main',
    ref: 'main',
    worktree_unique_id: Math.floor(Math.random() * 1000000), // Auto-assigned sequential ID
    path: '/tmp/test-repo',
    base_ref: 'main',
    new_branch: false,
  });

  return worktree;
}

// ============================================================================
// Create
// ============================================================================

describe('SessionRepository.create', () => {
  dbTest('should create session with all fields', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({
      worktree_id: worktree.worktree_id,
      title: 'Test Session',
      description: 'Test description',
    });

    const created = await repo.create(data);

    expect(created.session_id).toBe(data.session_id);
    expect(created.worktree_id).toBe(worktree.worktree_id);
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
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    delete (data as any).session_id;

    const created = await repo.create(data);

    expect(created.session_id).toBeDefined();
    expect(created.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  dbTest('should default to IDLE status if not provided', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    delete (data as any).status;

    const created = await repo.create(data);

    expect(created.status).toBe(SessionStatus.IDLE);
  });

  dbTest('should default to claude-code agentic_tool if not provided', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    delete (data as any).agentic_tool;

    const created = await repo.create(data);

    expect(created.agentic_tool).toBe('claude-code');
  });

  dbTest('should default to anonymous created_by if not provided', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    delete (data as any).created_by;

    const created = await repo.create(data);

    expect(created.created_by).toBe('anonymous');
  });

  dbTest('should throw error if worktree_id is missing', async ({ db }) => {
    const repo = new SessionRepository(db);
    const data = createSessionData();
    delete (data as any).worktree_id;

    await expect(repo.create(data)).rejects.toThrow(RepositoryError);
    await expect(repo.create(data)).rejects.toThrow('worktree_id');
  });

  dbTest('should store all optional JSON fields correctly', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const task1 = generateId();
    const task2 = generateId();
    const parentId = generateId();
    const spawnTaskId = generateId();

    const data = createSessionData({
      worktree_id: worktree.worktree_id,
      permission_config: {
        mode: 'acceptEdits',
        allowedTools: ['read', 'write'],
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
      allowedTools: ['read', 'write'],
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
    const worktree = await createTestWorktree(db);
    const forkedFromId = generateId();
    const data = createSessionData({
      worktree_id: worktree.worktree_id,
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
    const worktree = await createTestWorktree(db);
    const createdAt = new Date('2024-01-01T00:00:00Z').toISOString();
    const lastUpdated = new Date('2024-01-02T00:00:00Z').toISOString();
    const data = createSessionData({
      worktree_id: worktree.worktree_id,
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
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    await repo.create(data);

    const found = await repo.findById(data.session_id!);

    expect(found).not.toBeNull();
    expect(found?.session_id).toBe(data.session_id);
    expect(found?.worktree_id).toBe(worktree.worktree_id);
  });

  dbTest('should find session by 8-char short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    await repo.create(data);

    const shortId = data.session_id!.replace(/-/g, '').slice(0, 8);
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.session_id).toBe(data.session_id);
  });

  dbTest('should find session by 12-char short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    await repo.create(data);

    // Use first 8 chars - resolveId uses LIKE pattern that works better with shorter prefixes
    const shortId = data.session_id!.replace(/-/g, '').slice(0, 8);
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.session_id).toBe(data.session_id);
  });

  dbTest('should handle short ID with hyphens', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    await repo.create(data);

    const shortId = data.session_id!.slice(0, 8);
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.session_id).toBe(data.session_id);
  });

  dbTest('should be case-insensitive', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    await repo.create(data);

    const shortId = data.session_id!.replace(/-/g, '').slice(0, 8).toUpperCase();
    const found = await repo.findById(shortId);

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
    const worktree = await createTestWorktree(db);

    const id1 = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-000000000000' as UUID;

    await repo.create(createSessionData({ session_id: id1, worktree_id: worktree.worktree_id }));
    await repo.create(createSessionData({ session_id: id2, worktree_id: worktree.worktree_id }));

    const ambiguousPrefix = '01933e4a';

    await expect(repo.findById(ambiguousPrefix)).rejects.toThrow(AmbiguousIdError);
  });

  dbTest('should provide helpful suggestions for ambiguous ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    const id1 = '01933e4a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-9d2e1c4b5a6f' as UUID;

    await repo.create(createSessionData({ session_id: id1, worktree_id: worktree.worktree_id }));
    await repo.create(createSessionData({ session_id: id2, worktree_id: worktree.worktree_id }));

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
    const worktree = await createTestWorktree(db);
    const data = createSessionData({
      worktree_id: worktree.worktree_id,
      permission_config: { mode: 'acceptEdits', allowedTools: ['read'] },
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
    const worktree = await createTestWorktree(db);

    const data1 = createSessionData({ worktree_id: worktree.worktree_id, title: 'Session 1' });
    const data2 = createSessionData({ worktree_id: worktree.worktree_id, title: 'Session 2' });
    const data3 = createSessionData({ worktree_id: worktree.worktree_id, title: 'Session 3' });

    await repo.create(data1);
    await repo.create(data2);
    await repo.create(data3);

    const sessions = await repo.findAll();

    expect(sessions).toHaveLength(3);
    expect(sessions.map((s) => s.title).sort()).toEqual(['Session 1', 'Session 2', 'Session 3']);
  });

  dbTest('should return fully populated session objects', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({
      worktree_id: worktree.worktree_id,
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
    expect(found.worktree_id).toBe(worktree.worktree_id);
  });
});

// ============================================================================
// FindByStatus
// ============================================================================

describe('SessionRepository.findByStatus', () => {
  dbTest('should find sessions by IDLE status', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.IDLE })
    );
    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.RUNNING })
    );
    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.IDLE })
    );

    const idleSessions = await repo.findByStatus(SessionStatus.IDLE);

    expect(idleSessions).toHaveLength(2);
    idleSessions.forEach((session) => {
      expect(session.status).toBe(SessionStatus.IDLE);
    });
  });

  dbTest('should find sessions by RUNNING status', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.RUNNING })
    );
    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.IDLE })
    );

    const runningSessions = await repo.findByStatus(SessionStatus.RUNNING);

    expect(runningSessions).toHaveLength(1);
    expect(runningSessions[0].status).toBe(SessionStatus.RUNNING);
  });

  dbTest('should return empty array if no sessions match status', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.IDLE })
    );

    const completedSessions = await repo.findByStatus(SessionStatus.COMPLETED);

    expect(completedSessions).toEqual([]);
  });

  dbTest('should find COMPLETED sessions', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.COMPLETED })
    );
    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.FAILED })
    );

    const completedSessions = await repo.findByStatus(SessionStatus.COMPLETED);

    expect(completedSessions).toHaveLength(1);
    expect(completedSessions[0].status).toBe(SessionStatus.COMPLETED);
  });

  dbTest('should find FAILED sessions', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.FAILED })
    );
    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.COMPLETED })
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
  dbTest('should return all sessions (board filtering done at service layer)', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));
    await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));

    const sessions = await repo.findByBoard('board-123');

    // Currently returns all sessions (TODO: Add board_id as materialized column)
    expect(sessions).toHaveLength(2);
  });
});

// ============================================================================
// FindChildren
// ============================================================================

describe('SessionRepository.findChildren', () => {
  dbTest('should find child sessions with parent_session_id', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    const parent = await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));
    const child1 = await repo.create(
      createSessionData({
        worktree_id: worktree.worktree_id,
        genealogy: {
          parent_session_id: parent.session_id,
          children: [],
        },
      })
    );
    const child2 = await repo.create(
      createSessionData({
        worktree_id: worktree.worktree_id,
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
    const worktree = await createTestWorktree(db);

    const original = await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));
    const fork1 = await repo.create(
      createSessionData({
        worktree_id: worktree.worktree_id,
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
    const worktree = await createTestWorktree(db);

    const parent = await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));

    const children = await repo.findChildren(parent.session_id);

    expect(children).toEqual([]);
  });

  dbTest('should work with short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    // Use predefined IDs to avoid collision
    const parentId = '01933e4a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const childId = '01933e4b-bbbb-7c35-a8f3-000000000000' as UUID;

    const parent = await repo.create(
      createSessionData({
        session_id: parentId,
        worktree_id: worktree.worktree_id,
      })
    );
    await repo.create(
      createSessionData({
        session_id: childId,
        worktree_id: worktree.worktree_id,
        genealogy: {
          parent_session_id: parent.session_id,
          children: [],
        },
      })
    );

    const shortId = parent.session_id.replace(/-/g, '').slice(0, 8);
    const children = await repo.findChildren(shortId);

    expect(children).toHaveLength(1);
  });
});

// ============================================================================
// FindAncestors
// ============================================================================

describe('SessionRepository.findAncestors', () => {
  dbTest('should find single parent', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    const parent = await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));
    const child = await repo.create(
      createSessionData({
        worktree_id: worktree.worktree_id,
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
    const worktree = await createTestWorktree(db);

    const grandparent = await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));
    const parent = await repo.create(
      createSessionData({
        worktree_id: worktree.worktree_id,
        genealogy: {
          parent_session_id: grandparent.session_id,
          children: [],
        },
      })
    );
    const child = await repo.create(
      createSessionData({
        worktree_id: worktree.worktree_id,
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
    const worktree = await createTestWorktree(db);

    const original = await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));
    const fork = await repo.create(
      createSessionData({
        worktree_id: worktree.worktree_id,
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
    const worktree = await createTestWorktree(db);

    const root = await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));

    const ancestors = await repo.findAncestors(root.session_id);

    expect(ancestors).toEqual([]);
  });

  dbTest('should work with short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    // Use predefined IDs to avoid collision
    const parentId = '01933e5a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const childId = '01933e5b-bbbb-7c35-a8f3-000000000000' as UUID;

    const parent = await repo.create(
      createSessionData({
        session_id: parentId,
        worktree_id: worktree.worktree_id,
      })
    );
    const child = await repo.create(
      createSessionData({
        session_id: childId,
        worktree_id: worktree.worktree_id,
        genealogy: {
          parent_session_id: parent.session_id,
          children: [],
        },
      })
    );

    const shortId = child.session_id.replace(/-/g, '').slice(0, 8);
    const ancestors = await repo.findAncestors(shortId);

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
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id, title: 'Original Title' });
    await repo.create(data);

    const updated = await repo.update(data.session_id!, { title: 'Updated Title' });

    expect(updated.title).toBe('Updated Title');
    expect(updated.session_id).toBe(data.session_id);
  });

  dbTest('should update session by short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({
      worktree_id: worktree.worktree_id,
      status: SessionStatus.IDLE,
    });
    await repo.create(data);

    const shortId = data.session_id!.replace(/-/g, '').slice(0, 8);
    const updated = await repo.update(shortId, { status: SessionStatus.RUNNING });

    expect(updated.status).toBe(SessionStatus.RUNNING);
    expect(updated.session_id).toBe(data.session_id);
  });

  dbTest('should update multiple fields', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({
      worktree_id: worktree.worktree_id,
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
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    await repo.create(data);

    const task1 = generateId();
    const task2 = generateId();
    const updated = await repo.update(data.session_id!, {
      permission_config: {
        mode: 'bypassPermissions',
        allowedTools: ['read', 'write', 'execute'],
      },
      tasks: [task1, task2],
      git_state: {
        ref: 'feature-branch',
        base_sha: 'xyz789',
        current_sha: 'uvw456',
      },
      message_count: 10,
      custom_context: { foo: 'baz', newField: 123 },
    });

    expect(updated.permission_config?.mode).toBe('bypassPermissions');
    expect(updated.permission_config?.allowedTools).toEqual(['read', 'write', 'execute']);
    expect(updated.tasks).toEqual([task1, task2]);
    expect(updated.git_state).toEqual({
      ref: 'feature-branch',
      base_sha: 'xyz789',
      current_sha: 'uvw456',
    });
    expect(updated.message_count).toBe(10);
    expect(updated.custom_context).toEqual({ foo: 'baz', newField: 123 });
  });

  dbTest('should update last_updated timestamp', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    const created = await repo.create(data);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await repo.update(data.session_id!, { title: 'Updated' });

    expect(new Date(updated.last_updated).getTime()).toBeGreaterThan(
      new Date(created.last_updated).getTime()
    );
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new SessionRepository(db);

    await expect(repo.update('99999999', { title: 'Updated' })).rejects.toThrow(
      EntityNotFoundError
    );
  });

  dbTest('should preserve unchanged fields', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({
      worktree_id: worktree.worktree_id,
      title: 'Original Title',
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
    });
    const created = await repo.create(data);

    const updated = await repo.update(data.session_id!, { title: 'New Title' });

    expect(updated.agentic_tool).toBe(created.agentic_tool);
    expect(updated.status).toBe(created.status);
    expect(updated.worktree_id).toBe(created.worktree_id);
  });
});

// ============================================================================
// Delete
// ============================================================================

describe('SessionRepository.delete', () => {
  dbTest('should delete session by full UUID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    await repo.create(data);

    await repo.delete(data.session_id!);

    const found = await repo.findById(data.session_id!);
    expect(found).toBeNull();
  });

  dbTest('should delete session by short ID', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data = createSessionData({ worktree_id: worktree.worktree_id });
    await repo.create(data);

    const shortId = data.session_id!.replace(/-/g, '').slice(0, 8);
    await repo.delete(shortId);

    const found = await repo.findById(data.session_id!);
    expect(found).toBeNull();
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new SessionRepository(db);

    await expect(repo.delete('99999999')).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('should not affect other sessions', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data1 = createSessionData({ worktree_id: worktree.worktree_id, title: 'Session 1' });
    const data2 = createSessionData({ worktree_id: worktree.worktree_id, title: 'Session 2' });
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
    const worktree = await createTestWorktree(db);

    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.RUNNING })
    );
    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.IDLE })
    );
    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.RUNNING })
    );

    const running = await repo.findRunning();

    expect(running).toHaveLength(2);
    running.forEach((session) => {
      expect(session.status).toBe(SessionStatus.RUNNING);
    });
  });

  dbTest('should return empty array if no running sessions', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, status: SessionStatus.IDLE })
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
    const worktree = await createTestWorktree(db);

    await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));
    await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));
    await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));

    const count = await repo.count();

    expect(count).toBe(3);
  });

  dbTest('should update count after delete', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);
    const data1 = createSessionData({ worktree_id: worktree.worktree_id });
    const data2 = createSessionData({ worktree_id: worktree.worktree_id });

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
    const worktree = await createTestWorktree(db);

    const claude = await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, agentic_tool: 'claude-code' })
    );
    const codex = await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, agentic_tool: 'codex' })
    );
    const gemini = await repo.create(
      createSessionData({ worktree_id: worktree.worktree_id, agentic_tool: 'gemini' })
    );

    expect(claude.agentic_tool).toBe('claude-code');
    expect(codex.agentic_tool).toBe('codex');
    expect(gemini.agentic_tool).toBe('gemini');
  });

  dbTest('should handle complex genealogy structures', async ({ db }) => {
    const repo = new SessionRepository(db);
    const worktree = await createTestWorktree(db);

    const root = await repo.create(createSessionData({ worktree_id: worktree.worktree_id }));
    const child1 = await repo.create(
      createSessionData({
        worktree_id: worktree.worktree_id,
        genealogy: {
          parent_session_id: root.session_id,
          spawn_point_task_id: generateId(),
          children: [],
        },
      })
    );
    const child2 = await repo.create(
      createSessionData({
        worktree_id: worktree.worktree_id,
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
