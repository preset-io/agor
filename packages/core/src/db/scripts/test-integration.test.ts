/**
 * Test Integration Script Tests
 *
 * Tests the database integration test utilities and functions.
 * Validates that integration test helpers work correctly for testing
 * the complete database layer including ID generation, repositories,
 * JSON serialization, and genealogy queries.
 */

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { formatShortId, generateId } from '../../lib/ids';
import type { Session, SessionID, TaskID, UserID } from '../../types';
import { SessionStatus, TaskStatus } from '../../types';
import { createDatabase } from '../client';
import { isSQLiteDatabase } from '../database-wrapper';
import { initializeDatabase, seedInitialData } from '../migrate';
import {
  BoardRepository,
  RepoRepository,
  SessionRepository,
  TaskRepository,
  WorktreeRepository,
} from '../repositories';

/**
 * Helper to create a test database instance
 */
function createTestDb() {
  return createDatabase({ url: ':memory:' });
}

/**
 * Helper to setup repo and worktree for tests
 */
async function setupRepoAndWorktree(db: ReturnType<typeof createDatabase>) {
  const repoRepo = new RepoRepository(db);
  const worktreeRepo = new WorktreeRepository(db);

  const repo = await repoRepo.create({
    slug: 'test-repo',
    name: 'Test Repository',
    remote_url: 'https://github.com/test/repo.git',
    local_path: '/Users/test/.agor/repos/test-repo',
    default_branch: 'main',
  });

  const worktree = await worktreeRepo.create({
    repo_id: repo.repo_id,
    name: 'main',
    ref: 'refs/heads/main',
    worktree_unique_id: 1,
    path: '/tmp/test-worktree',
    created_by: 'test-user' as UserID,
  });

  return { repo, worktree };
}

// ============================================================================
// Database Initialization Tests
// ============================================================================

describe('Database Initialization', () => {
  it('should create fresh database with all tables', async () => {
    const db = createTestDb();
    await initializeDatabase(db);

    const result = isSQLiteDatabase(db)
      ? await db.run(sql`
          SELECT name FROM sqlite_master
          WHERE type='table' AND name IN (
            'sessions', 'tasks', 'boards', 'repos', 'worktrees',
            'messages', 'users', 'board_comments', 'board_objects',
            'mcp_servers', 'session_mcp_servers'
          )`)
      : await db.execute(sql`
          SELECT table_name as name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name IN (
            'sessions', 'tasks', 'boards', 'repos', 'worktrees',
            'messages', 'users', 'board_comments', 'board_objects',
            'mcp_servers', 'session_mcp_servers'
          )
    `);

    expect((result as any).rows.length).toBeGreaterThanOrEqual(10);
  });

  it('should be idempotent - safe to call multiple times', async () => {
    const db = createTestDb();

    await initializeDatabase(db);
    await initializeDatabase(db);
    await initializeDatabase(db);

    const result = isSQLiteDatabase(db)
      ? await db.run(sql`SELECT name FROM sqlite_master WHERE type='table'`)
      : await db.execute(
          sql`SELECT table_name as name FROM information_schema.tables WHERE table_schema = 'public'`
        );
    expect((result as any).rows.length).toBeGreaterThan(0);
  });

  it('should seed default board', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    await seedInitialData(db);

    const result = isSQLiteDatabase(db)
      ? await db.run(sql`SELECT board_id, name, slug FROM boards WHERE slug = 'default'`)
      : await db.execute(sql`SELECT board_id, name, slug FROM boards WHERE slug = 'default'`);

    expect((result as any).rows.length).toBe(1);
    expect(((result as any).rows[0] as any).name).toBe('Main Board');
    expect(((result as any).rows[0] as any).slug).toBe('default');
  });

  it('should not duplicate default board when called twice', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    await seedInitialData(db);
    await seedInitialData(db);

    const result = isSQLiteDatabase(db)
      ? await db.run(sql`SELECT board_id FROM boards WHERE slug = 'default'`)
      : await db.execute(sql`SELECT board_id FROM boards WHERE slug = 'default'`);
    expect((result as any).rows.length).toBe(1);
  });
});

// ============================================================================
// ID Generation Tests
// ============================================================================

describe('ID Generation', () => {
  it('should generate valid UUID format', () => {
    const id = generateId();
    // Accept both v4 (new) and v7 (legacy) UUIDs
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    expect(id).toMatch(uuidRegex);
  });

  it('should generate unique IDs', () => {
    const ids = Array.from({ length: 100 }, () => generateId());
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(100);
  });

  it('should generate time-ordered IDs', () => {
    const ids = Array.from({ length: 10 }, () => generateId());

    for (let i = 1; i < ids.length; i++) {
      const prevTimestamp = ids[i - 1].replace(/-/g, '').slice(0, 12);
      const currTimestamp = ids[i].replace(/-/g, '').slice(0, 12);

      expect(prevTimestamp <= currTimestamp).toBe(true);
    }
  });

  it('should format short IDs correctly', () => {
    const id = generateId();
    const shortId = formatShortId(id);

    expect(shortId).toHaveLength(8);
    expect(shortId).toBe(id.slice(0, 8));
  });
});

// ============================================================================
// Session Repository Integration Tests
// ============================================================================

describe('Session Repository Integration', () => {
  it('should create session with all required fields', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);
    const session = await repo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: {
        ref: 'main',
        base_sha: 'abc123',
        current_sha: 'abc123',
      },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    expect(session.session_id).toBeDefined();
    expect(session.agentic_tool).toBe('claude-code');
    expect(session.status).toBe(SessionStatus.IDLE);
    expect(session.worktree_id).toBe(worktree.worktree_id);
  });

  it('should resolve short ID to full session', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);
    const session = await repo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    const shortId = formatShortId(session.session_id);
    const found = await repo.findById(shortId);

    expect(found).toBeDefined();
    expect(found!.session_id).toBe(session.session_id);
  });

  it('should preserve JSON data integrity', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);
    const gitState = { ref: 'main', base_sha: 'abc123', current_sha: 'abc123' };
    const session = await repo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: gitState,
      genealogy: { children: [] },
      contextFiles: ['file1.ts', 'file2.ts'],
      tasks: [],
      message_count: 0,
    });

    const found = await repo.findById(session.session_id);

    expect(found!.git_state).toEqual(gitState);
    expect(found!.contextFiles).toEqual(['file1.ts', 'file2.ts']);
  });

  it('should find sessions by status', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);

    const createSession = (status: SessionStatus) =>
      repo.create({
        agentic_tool: 'claude-code',
        status,
        created_by: 'test-user' as UserID,
        worktree_id: worktree.worktree_id,
        git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
        genealogy: { children: [] },
        contextFiles: [],
        tasks: [],
        message_count: 0,
      });

    await createSession(SessionStatus.IDLE);
    await createSession(SessionStatus.RUNNING);
    await createSession(SessionStatus.RUNNING);
    await createSession(SessionStatus.COMPLETED);

    const running = await repo.findByStatus(SessionStatus.RUNNING);
    expect(running).toHaveLength(2);

    const idle = await repo.findByStatus(SessionStatus.IDLE);
    expect(idle).toHaveLength(1);
  });

  it('should handle different agentic tools', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);

    const tools: Array<'claude-code' | 'codex' | 'gemini'> = ['claude-code', 'codex', 'gemini'];

    for (const tool of tools) {
      const session = await repo.create({
        agentic_tool: tool,
        status: SessionStatus.IDLE,
        created_by: 'test-user' as UserID,
        worktree_id: worktree.worktree_id,
        git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
        genealogy: { children: [] },
        contextFiles: [],
        tasks: [],
        message_count: 0,
      });
      expect(session.agentic_tool).toBe(tool);
    }
  });
});

// ============================================================================
// Task Repository Integration Tests
// ============================================================================

describe('Task Repository Integration', () => {
  it('should create task linked to session', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const sessionRepo = new SessionRepository(db);
    const taskRepo = new TaskRepository(db);

    const session = await sessionRepo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    const task = await taskRepo.create({
      session_id: session.session_id,
      description: 'Test task',
      full_prompt: 'This is a test task',
      status: TaskStatus.CREATED,
      message_range: {
        start_index: 0,
        end_index: 1,
        start_timestamp: new Date().toISOString(),
      },
      git_state: {
        ref_at_start: 'main',
        sha_at_start: 'abc123',
      },
      model: 'claude-sonnet-4-5',
      tool_use_count: 5,
    });

    expect(task.task_id).toBeDefined();
    expect(task.session_id).toBe(session.session_id);
    expect(task.description).toBe('Test task');
    expect(task.tool_use_count).toBe(5);
  });

  it('should find tasks by session', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const sessionRepo = new SessionRepository(db);
    const taskRepo = new TaskRepository(db);

    const createSession = () =>
      sessionRepo.create({
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
        created_by: 'test-user' as UserID,
        worktree_id: worktree.worktree_id,
        git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
        genealogy: { children: [] },
        contextFiles: [],
        tasks: [],
        message_count: 0,
      });

    const session1 = await createSession();
    const session2 = await createSession();

    const createTask = (sessionId: SessionID, description: string) =>
      taskRepo.create({
        session_id: sessionId,
        description,
        full_prompt: 'Test prompt',
        status: TaskStatus.CREATED,
        message_range: {
          start_index: 0,
          end_index: 1,
          start_timestamp: new Date().toISOString(),
        },
        git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
        model: 'claude-sonnet-4-5',
      });

    await createTask(session1.session_id, 'Task 1');
    await createTask(session1.session_id, 'Task 2');
    await createTask(session2.session_id, 'Task 3');

    const session1Tasks = await taskRepo.findBySession(session1.session_id);
    expect(session1Tasks).toHaveLength(2);

    const session2Tasks = await taskRepo.findBySession(session2.session_id);
    expect(session2Tasks).toHaveLength(1);
  });

  it('should update task status and completion time', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const sessionRepo = new SessionRepository(db);
    const taskRepo = new TaskRepository(db);

    const session = await sessionRepo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    const task = await taskRepo.create({
      session_id: session.session_id,
      description: 'Test task',
      full_prompt: 'Test prompt',
      status: TaskStatus.CREATED,
      message_range: {
        start_index: 0,
        end_index: 1,
        start_timestamp: new Date().toISOString(),
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
      model: 'claude-sonnet-4-5',
    });

    const completedAt = new Date().toISOString();
    const updated = await taskRepo.update(task.task_id, {
      status: TaskStatus.COMPLETED,
      completed_at: completedAt,
    });

    expect(updated.status).toBe(TaskStatus.COMPLETED);
    expect(updated.completed_at).toBe(completedAt);
  });
});

// ============================================================================
// Board Repository Integration Tests
// ============================================================================

describe('Board Repository Integration', () => {
  it('should get default board after seeding', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    await seedInitialData(db);

    const repo = new BoardRepository(db);
    const defaultBoard = await repo.getDefault();

    expect(defaultBoard).toBeDefined();
    expect(defaultBoard.name).toBe('Main Board');
    expect(defaultBoard.slug).toBe('default');
  });

  it('should create custom board with all fields', async () => {
    const db = createTestDb();
    await initializeDatabase(db);

    const repo = new BoardRepository(db);
    const board = await repo.create({
      name: 'Test Board',
      slug: 'test-board',
      description: 'A test board',
      color: '#ff0000',
      icon: 'rocket',
    });

    expect(board.board_id).toBeDefined();
    expect(board.name).toBe('Test Board');
    expect(board.slug).toBe('test-board');
    expect(board.description).toBe('A test board');
  });

  it('should find board by slug', async () => {
    const db = createTestDb();
    await initializeDatabase(db);

    const repo = new BoardRepository(db);
    const board = await repo.create({
      name: 'My Board',
      slug: 'my-board',
      description: 'Test',
      color: '#000000',
      icon: 'star',
    });

    const found = await repo.findBySlug('my-board');

    expect(found).toBeDefined();
    expect(found!.board_id).toBe(board.board_id);
  });
});

// ============================================================================
// Repo Repository Integration Tests
// ============================================================================

describe('Repo Repository Integration', () => {
  it('should create repo with all required fields', async () => {
    const db = createTestDb();
    await initializeDatabase(db);

    const repo = new RepoRepository(db);
    const created = await repo.create({
      slug: 'test-repo',
      name: 'Test Repository',
      remote_url: 'https://github.com/test/test-repo.git',
      local_path: '/Users/test/.agor/repos/test-repo',
      default_branch: 'main',
    });

    expect(created.repo_id).toBeDefined();
    expect(created.slug).toBe('test-repo');
    expect(created.name).toBe('Test Repository');
  });

  it('should find repo by slug', async () => {
    const db = createTestDb();
    await initializeDatabase(db);

    const repo = new RepoRepository(db);
    const created = await repo.create({
      slug: 'my-repo',
      name: 'My Repository',
      remote_url: 'https://github.com/test/repo.git',
      local_path: '/test/path',
      default_branch: 'main',
    });

    const found = await repo.findBySlug('my-repo');

    expect(found).toBeDefined();
    expect(found!.repo_id).toBe(created.repo_id);
  });

  it('should handle different Git providers', async () => {
    const db = createTestDb();
    await initializeDatabase(db);

    const repo = new RepoRepository(db);

    const github = await repo.create({
      slug: 'github-repo',
      name: 'GitHub Repo',
      remote_url: 'https://github.com/user/repo.git',
      local_path: '/path',
      default_branch: 'main',
    });

    const gitlab = await repo.create({
      slug: 'gitlab-repo',
      name: 'GitLab Repo',
      remote_url: 'https://gitlab.com/user/repo.git',
      local_path: '/path2',
      default_branch: 'main',
    });

    expect(github.remote_url).toContain('github.com');
    expect(gitlab.remote_url).toContain('gitlab.com');
  });
});

// ============================================================================
// Session Genealogy Integration Tests
// ============================================================================

describe('Session Genealogy', () => {
  it('should create parent-child fork relationship', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);

    const parent = await repo.create({
      agentic_tool: 'claude-code',
      status: TaskStatus.COMPLETED,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    const fork = await repo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'def', current_sha: 'def' },
      genealogy: {
        forked_from_session_id: parent.session_id,
        fork_point_task_id: 'task-123' as TaskID,
        children: [],
      },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    expect(fork.genealogy.forked_from_session_id).toBe(parent.session_id);
    expect(fork.genealogy.fork_point_task_id).toBe('task-123');
  });

  it('should find all children of parent session', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);

    const parent = await repo.create({
      agentic_tool: 'claude-code',
      status: TaskStatus.COMPLETED,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    const fork = await repo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
      genealogy: {
        forked_from_session_id: parent.session_id,
        fork_point_task_id: 'task-1' as TaskID,
        children: [],
      },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    const spawn = await repo.create({
      agentic_tool: 'codex',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
      genealogy: {
        parent_session_id: parent.session_id,
        spawn_point_task_id: 'task-2' as TaskID,
        children: [],
      },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    const children = await repo.findChildren(parent.session_id);

    expect(children).toHaveLength(2);

    const childIds = children.map((c: Session) => c.session_id).sort();
    const expectedIds = [fork.session_id, spawn.session_id].sort();

    expect(childIds).toEqual(expectedIds);
  });

  it('should find ancestors of forked session', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);

    const parent = await repo.create({
      agentic_tool: 'claude-code',
      status: TaskStatus.COMPLETED,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'def' },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    const fork = await repo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'def', current_sha: 'def' },
      genealogy: {
        forked_from_session_id: parent.session_id,
        fork_point_task_id: 'task-123' as TaskID,
        children: [],
      },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    const ancestors = await repo.findAncestors(fork.session_id);

    expect(ancestors).toHaveLength(1);
    expect(ancestors[0].session_id).toBe(parent.session_id);
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Error Handling', () => {
  it('should handle invalid database path gracefully', () => {
    expect(() => {
      createDatabase({ url: '' });
    }).toThrow();
  });

  it('should handle missing required session fields', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);

    await expect(
      repo.create({
        agentic_tool: 'claude-code',
        status: SessionStatus.IDLE,
        created_by: 'test-user' as UserID,
        // Missing worktree_id (required)
      } as any)
    ).rejects.toThrow();
  });

  it('should handle invalid session status enum', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);

    await expect(
      repo.create({
        agentic_tool: 'claude-code',
        status: 'invalid-status' as any,
        created_by: 'test-user' as UserID,
        worktree_id: worktree.worktree_id,
        git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
        genealogy: { children: [] },
        contextFiles: [],
        tasks: [],
        message_count: 0,
      })
    ).rejects.toThrow();
  });

  it('should handle duplicate board slugs', async () => {
    const db = createTestDb();
    await initializeDatabase(db);

    const repo = new BoardRepository(db);

    await repo.create({
      name: 'Board 1',
      slug: 'duplicate-slug',
      description: 'Test',
      color: '#000',
      icon: 'star',
    });

    await expect(
      repo.create({
        name: 'Board 2',
        slug: 'duplicate-slug',
        description: 'Test',
        color: '#fff',
        icon: 'rocket',
      })
    ).rejects.toThrow();
  });
});

// ============================================================================
// Edge Cases and Data Integrity Tests
// ============================================================================

describe('Edge Cases and Data Integrity', () => {
  it('should handle empty arrays and zero counts', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);
    const session = await repo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    expect(session.contextFiles).toEqual([]);
    expect(session.tasks).toEqual([]);
    expect(session.message_count).toBe(0);
  });

  it('should preserve exact ISO timestamp format', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const sessionRepo = new SessionRepository(db);
    const taskRepo = new TaskRepository(db);

    const session = await sessionRepo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    const timestamp = '2024-01-15T10:30:45.123Z';
    const task = await taskRepo.create({
      session_id: session.session_id,
      description: 'Test',
      full_prompt: 'Test',
      status: TaskStatus.CREATED,
      message_range: {
        start_index: 0,
        end_index: 1,
        start_timestamp: timestamp,
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
      model: 'claude-sonnet-4-5',
    });

    expect(task.message_range.start_timestamp).toBe(timestamp);
  });

  it('should handle special characters in descriptions', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const sessionRepo = new SessionRepository(db);
    const taskRepo = new TaskRepository(db);

    const session = await sessionRepo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: { ref: 'main', base_sha: 'abc', current_sha: 'abc' },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    const description = 'Task with "quotes", \'apostrophes\', and <tags>';
    const task = await taskRepo.create({
      session_id: session.session_id,
      description,
      full_prompt: 'Test',
      status: TaskStatus.CREATED,
      message_range: {
        start_index: 0,
        end_index: 1,
        start_timestamp: new Date().toISOString(),
      },
      git_state: { ref_at_start: 'main', sha_at_start: 'abc' },
      model: 'claude-sonnet-4-5',
    });

    expect(task.description).toBe(description);
  });

  it('should preserve exact SHA hashes', async () => {
    const db = createTestDb();
    await initializeDatabase(db);
    const { worktree } = await setupRepoAndWorktree(db);

    const repo = new SessionRepository(db);

    const sha = 'a1b2c3d4e5f6789012345678901234567890abcd';
    const session = await repo.create({
      agentic_tool: 'claude-code',
      status: SessionStatus.IDLE,
      created_by: 'test-user' as UserID,
      worktree_id: worktree.worktree_id,
      git_state: {
        ref: 'main',
        base_sha: sha,
        current_sha: sha,
      },
      genealogy: { children: [] },
      contextFiles: [],
      tasks: [],
      message_count: 0,
    });

    expect(session.git_state.base_sha).toBe(sha);
    expect(session.git_state.current_sha).toBe(sha);
  });
});
