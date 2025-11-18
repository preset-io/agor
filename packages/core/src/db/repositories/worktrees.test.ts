/**
 * WorktreeRepository Tests
 *
 * Tests for type-safe CRUD operations on worktrees with short ID support.
 */

import type { UUID, WorktreeID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { boards } from '../schema';
import { dbTest } from '../test-helpers';
import { AmbiguousIdError, EntityNotFoundError } from './base';
import { RepoRepository } from './repos';
import { WorktreeRepository } from './worktrees';

/**
 * Create test repo data (needed as FK for worktrees)
 */
function createRepoData(overrides?: { repo_id?: UUID; slug?: string }) {
  const slug = overrides?.slug ?? 'test-repo';
  return {
    repo_id: overrides?.repo_id ?? generateId(),
    slug,
    name: slug,
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/home/user/.agor/repos/${slug}`,
    default_branch: 'main',
  };
}

/**
 * Create test worktree data
 *
 * Returns object with required fields for create() and commonly used fields
 */
function createWorktreeData(overrides?: {
  worktree_id?: WorktreeID;
  repo_id?: UUID;
  name?: string;
  ref?: string;
  worktree_unique_id?: number;
  path?: string;
  board_id?: UUID;
  created_by?: UUID;
  base_ref?: string;
  base_sha?: string;
  last_commit_sha?: string;
  tracking_branch?: string;
  new_branch?: boolean;
  issue_url?: string;
  pull_request_url?: string;
  notes?: string;
  environment_instance?: any;
  last_used?: string;
  custom_context?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}) {
  const name = overrides?.name ?? 'feature-branch';
  const repoId = overrides?.repo_id ?? (generateId() as UUID);
  const wtId = overrides?.worktree_id ?? (generateId() as WorktreeID);

  return {
    worktree_id: wtId,
    repo_id: repoId,
    name,
    ref: overrides?.ref ?? `refs/heads/${name}`,
    worktree_unique_id: overrides?.worktree_unique_id ?? 1,
    path: overrides?.path ?? `/home/user/.agor/repos/test-repo/${name}`,
    board_id: overrides?.board_id,
    created_by: overrides?.created_by ?? (generateId() as UUID),
    base_ref: overrides?.base_ref,
    base_sha: overrides?.base_sha,
    last_commit_sha: overrides?.last_commit_sha,
    tracking_branch: overrides?.tracking_branch,
    new_branch: overrides?.new_branch,
    issue_url: overrides?.issue_url,
    pull_request_url: overrides?.pull_request_url,
    notes: overrides?.notes,
    environment_instance: overrides?.environment_instance,
    last_used: overrides?.last_used,
    custom_context: overrides?.custom_context,
    created_at: overrides?.created_at,
    updated_at: overrides?.updated_at,
  } as const;
}

// ============================================================================
// Create
// ============================================================================

describe('WorktreeRepository.create', () => {
  dbTest('should create worktree with comprehensive field validation', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const boardId = generateId() as UUID;
    await (db as any).insert(boards).values({
      board_id: boardId,
      created_at: new Date(),
      created_by: 'anonymous' as UUID,
      name: 'Test Board',
      data: {},
    });

    // Test with all fields populated
    const data = createWorktreeData({
      repo_id: repo.repo_id,
      board_id: boardId,
      base_ref: 'main',
      base_sha: 'abc123',
      last_commit_sha: 'def456',
      tracking_branch: 'origin/feature',
      new_branch: true,
      issue_url: 'https://github.com/test/repo/issues/123',
      pull_request_url: 'https://github.com/test/repo/pull/456',
      notes: 'Test notes',
      environment_instance: { status: 'running' as const },
      custom_context: { note: 'Custom context data' },
    });

    const created = await wtRepo.create(data);

    // Verify all fields
    expect(created.worktree_id).toBe(data.worktree_id);
    expect(created.repo_id).toBe(data.repo_id);
    expect(created.name).toBe(data.name);
    expect(created.ref).toBe(data.ref);
    expect(created.worktree_unique_id).toBe(data.worktree_unique_id);
    expect(created.path).toBe(data.path);
    expect(created.created_by).toBe(data.created_by);
    expect(created.board_id).toBe(boardId);
    expect(created.base_ref).toBe('main');
    expect(created.base_sha).toBe('abc123');
    expect(created.last_commit_sha).toBe('def456');
    expect(created.tracking_branch).toBe('origin/feature');
    expect(created.new_branch).toBe(true);
    expect(created.issue_url).toBe('https://github.com/test/repo/issues/123');
    expect(created.pull_request_url).toBe('https://github.com/test/repo/pull/456');
    expect(created.notes).toBe('Test notes');
    expect(created.environment_instance).toEqual({ status: 'running' });
    expect(created.custom_context).toEqual({ note: 'Custom context data' });
    expect(created.created_at).toBeDefined();
    expect(created.updated_at).toBeDefined();
    expect(created.last_used).toBeDefined();
  });

  dbTest('should apply defaults for omitted fields', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const data = createWorktreeData({ repo_id: repo.repo_id });
    delete (data as any).worktree_id;
    delete (data as any).created_by;

    const created = await wtRepo.create(data);

    // Verify defaults
    expect(created.worktree_id).toBeDefined();
    expect(created.worktree_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(created.created_by).toBe('anonymous');
    expect(created.new_branch).toBe(false);
    expect(created.board_id).toBeUndefined();
    expect(new Date(created.last_used!).getTime()).toBeGreaterThan(0);
  });

  dbTest('should preserve provided timestamps', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const createdAt = new Date('2024-01-01T00:00:00Z').toISOString();
    const data = {
      ...createWorktreeData({ repo_id: repo.repo_id }),
      created_at: createdAt,
    };

    const created = await wtRepo.create(data);

    expect(created.created_at).toBe(createdAt);
  });
});

// ============================================================================
// FindById (with short ID support)
// ============================================================================

describe('WorktreeRepository.findById', () => {
  dbTest('should find by full UUID and short ID variants', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const data = createWorktreeData({
      repo_id: repo.repo_id,
      base_ref: 'main',
      base_sha: 'abc123',
      notes: 'Test notes',
    });
    await wtRepo.create(data);

    // Test full UUID
    const byFull = await wtRepo.findById(data.worktree_id);
    expect(byFull?.worktree_id).toBe(data.worktree_id);
    expect(byFull?.base_ref).toBe('main');

    // Test short ID without hyphens
    const shortId = data.worktree_id.replace(/-/g, '').slice(0, 8);
    const byShort = await wtRepo.findById(shortId);
    expect(byShort?.worktree_id).toBe(data.worktree_id);

    // Test short ID with hyphens
    const shortIdHyphens = data.worktree_id.slice(0, 8);
    const byShortHyphens = await wtRepo.findById(shortIdHyphens);
    expect(byShortHyphens?.worktree_id).toBe(data.worktree_id);

    // Test case insensitivity
    const byUpper = await wtRepo.findById(shortId.toUpperCase());
    expect(byUpper?.worktree_id).toBe(data.worktree_id);
  });

  dbTest('should return null for non-existent ID', async ({ db }) => {
    const wtRepo = new WorktreeRepository(db);

    const found = await wtRepo.findById('99999999');

    expect(found).toBeNull();
  });

  dbTest('should throw AmbiguousIdError with suggestions', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo = await repoRepo.create(createRepoData());

    // Create two worktrees with IDs that share the first 8 characters
    const id1 = '01933e4a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as WorktreeID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-9d2e1c4b5a6f' as WorktreeID;

    await wtRepo.create(
      createWorktreeData({
        worktree_id: id1,
        repo_id: repo.repo_id,
        name: 'worktree-1',
        worktree_unique_id: 1,
      })
    );
    await wtRepo.create(
      createWorktreeData({
        worktree_id: id2,
        repo_id: repo.repo_id,
        name: 'worktree-2',
        worktree_unique_id: 2,
      })
    );

    const shortPrefix = '01933e4a';

    try {
      await wtRepo.findById(shortPrefix);
      throw new Error('Expected AmbiguousIdError');
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousIdError);
      const ambiguousError = error as AmbiguousIdError;
      expect(ambiguousError.matches).toHaveLength(2);
      expect(ambiguousError.matches[0]).toBe('01933e4a');
      expect(ambiguousError.matches[1]).toBe('01933e4a');
    }
  });
});

// ============================================================================
// FindAll
// ============================================================================

describe('WorktreeRepository.findAll', () => {
  dbTest('should return all worktrees unfiltered', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo = await repoRepo.create(createRepoData());

    await wtRepo.create(
      createWorktreeData({
        repo_id: repo.repo_id,
        name: 'worktree-1',
        worktree_unique_id: 1,
        base_ref: 'main',
        notes: 'Test notes',
      })
    );
    await wtRepo.create(
      createWorktreeData({
        repo_id: repo.repo_id,
        name: 'worktree-2',
        worktree_unique_id: 2,
      })
    );
    await wtRepo.create(
      createWorktreeData({
        repo_id: repo.repo_id,
        name: 'worktree-3',
        worktree_unique_id: 3,
      })
    );

    const worktrees = await wtRepo.findAll();

    expect(worktrees).toHaveLength(3);
    expect(worktrees.map((w) => w.name).sort()).toEqual(['worktree-1', 'worktree-2', 'worktree-3']);
    // Verify full object population
    const first = worktrees.find((w) => w.name === 'worktree-1');
    expect(first?.base_ref).toBe('main');
    expect(first?.notes).toBe('Test notes');
  });

  dbTest('should filter by repo_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo1 = await repoRepo.create(createRepoData({ slug: 'repo-1' }));
    const repo2 = await repoRepo.create(createRepoData({ slug: 'repo-2' }));

    await wtRepo.create(
      createWorktreeData({
        repo_id: repo1.repo_id,
        name: 'repo1-wt',
        worktree_unique_id: 1,
      })
    );
    await wtRepo.create(
      createWorktreeData({
        repo_id: repo2.repo_id,
        name: 'repo2-wt1',
        worktree_unique_id: 2,
      })
    );
    await wtRepo.create(
      createWorktreeData({
        repo_id: repo2.repo_id,
        name: 'repo2-wt2',
        worktree_unique_id: 3,
      })
    );

    const repo2Worktrees = await wtRepo.findAll({ repo_id: repo2.repo_id });

    expect(repo2Worktrees).toHaveLength(2);
    expect(repo2Worktrees.map((w) => w.name).sort()).toEqual(['repo2-wt1', 'repo2-wt2']);
    expect(repo2Worktrees.every((w) => w.repo_id === repo2.repo_id)).toBe(true);
  });

  dbTest('should return empty array for no matches', async ({ db }) => {
    const wtRepo = new WorktreeRepository(db);

    const empty = await wtRepo.findAll();
    expect(empty).toEqual([]);

    const repoRepo = new RepoRepository(db);
    const repo = await repoRepo.create(createRepoData());
    await wtRepo.create(createWorktreeData({ repo_id: repo.repo_id }));

    const filtered = await wtRepo.findAll({ repo_id: generateId() });
    expect(filtered).toEqual([]);
  });
});

// ============================================================================
// FindByRepoAndName
// ============================================================================

describe('WorktreeRepository.findByRepoAndName', () => {
  dbTest('should find by repo_id and name with case sensitivity', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo1 = await repoRepo.create(createRepoData({ slug: 'repo-1' }));
    const repo2 = await repoRepo.create(createRepoData({ slug: 'repo-2' }));

    const data1 = createWorktreeData({
      repo_id: repo1.repo_id,
      name: 'feature',
      worktree_unique_id: 1,
      base_ref: 'main',
      notes: 'Test notes',
    });
    const data2 = createWorktreeData({
      repo_id: repo2.repo_id,
      name: 'feature',
      worktree_unique_id: 2,
    });

    await wtRepo.create(data1);
    await wtRepo.create(data2);

    // Should find in correct repos
    const found1 = await wtRepo.findByRepoAndName(repo1.repo_id, 'feature');
    expect(found1?.worktree_id).toBe(data1.worktree_id);
    expect(found1?.base_ref).toBe('main');

    const found2 = await wtRepo.findByRepoAndName(repo2.repo_id, 'feature');
    expect(found2?.worktree_id).toBe(data2.worktree_id);
    expect(found1?.worktree_id).not.toBe(found2?.worktree_id);

    // Should be case-sensitive
    const notFound = await wtRepo.findByRepoAndName(repo1.repo_id, 'FEATURE');
    expect(notFound).toBeNull();
  });

  dbTest('should return null for non-existent combinations', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo = await repoRepo.create(createRepoData());
    await wtRepo.create(
      createWorktreeData({
        repo_id: repo.repo_id,
        name: 'feature-123',
      })
    );

    // Wrong name
    const wrongName = await wtRepo.findByRepoAndName(repo.repo_id, 'non-existent');
    expect(wrongName).toBeNull();

    // Wrong repo
    const wrongRepo = await wtRepo.findByRepoAndName(generateId(), 'feature-123');
    expect(wrongRepo).toBeNull();
  });
});

// ============================================================================
// Update
// ============================================================================

describe('WorktreeRepository.update', () => {
  dbTest('should update by full UUID and short ID', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const data = createWorktreeData({
      repo_id: repo.repo_id,
      notes: 'Original notes',
      base_ref: 'main',
    });
    await wtRepo.create(data);

    // Update by full UUID
    const updated1 = await wtRepo.update(data.worktree_id, { notes: 'Updated notes' });
    expect(updated1.notes).toBe('Updated notes');
    expect(updated1.name).toBe(data.name); // Unchanged

    // Update by short ID
    const shortId = data.worktree_id.replace(/-/g, '').slice(0, 8);
    const updated2 = await wtRepo.update(shortId, { base_ref: 'develop' });
    expect(updated2.base_ref).toBe('develop');
  });

  dbTest('should update all field types comprehensively', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const boardId = generateId() as UUID;
    await (db as any).insert(boards).values({
      board_id: boardId,
      created_at: new Date(),
      created_by: 'anonymous' as UUID,
      name: 'Test Board',
      data: {},
    });

    const data = createWorktreeData({
      repo_id: repo.repo_id,
      name: 'feature',
      ref: 'refs/heads/feature',
      base_ref: 'main',
      notes: 'Original notes',
    });
    const created = await wtRepo.create(data);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await wtRepo.update(data.worktree_id, {
      board_id: boardId,
      base_ref: 'develop',
      base_sha: 'abc123',
      last_commit_sha: 'def456',
      tracking_branch: 'origin/feature',
      new_branch: true,
      issue_url: 'https://github.com/test/repo/issues/123',
      pull_request_url: 'https://github.com/test/repo/pull/456',
      notes: 'Updated notes',
      environment_instance: { status: 'running' as const },
      custom_context: { key: 'Updated context' },
    });

    // Verify all updates
    expect(updated.board_id).toBe(boardId);
    expect(updated.base_ref).toBe('develop');
    expect(updated.base_sha).toBe('abc123');
    expect(updated.last_commit_sha).toBe('def456');
    expect(updated.tracking_branch).toBe('origin/feature');
    expect(updated.new_branch).toBe(true);
    expect(updated.issue_url).toBe('https://github.com/test/repo/issues/123');
    expect(updated.pull_request_url).toBe('https://github.com/test/repo/pull/456');
    expect(updated.notes).toBe('Updated notes');
    expect(updated.environment_instance).toEqual({ status: 'running' });
    expect(updated.custom_context).toEqual({ key: 'Updated context' });

    // Verify unchanged fields
    expect(updated.name).toBe(created.name);
    expect(updated.ref).toBe(created.ref);
    expect(updated.path).toBe(created.path);

    // Verify timestamp behavior
    expect(updated.created_at).toBe(created.created_at);
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(
      new Date(created.updated_at).getTime()
    );
  });

  dbTest('should clear optional fields', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const boardId = generateId() as UUID;
    await (db as any).insert(boards).values({
      board_id: boardId,
      created_at: new Date(),
      created_by: 'anonymous' as UUID,
      name: 'Test Board',
      data: {},
    });

    const data = createWorktreeData({
      repo_id: repo.repo_id,
      board_id: boardId,
      notes: 'Some notes',
    });
    await wtRepo.create(data);

    const updated = await wtRepo.update(data.worktree_id, {
      board_id: undefined,
      notes: undefined,
    });

    expect(updated.board_id).toBeUndefined();
    expect(updated.notes).toBeUndefined();
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const wtRepo = new WorktreeRepository(db);

    await expect(wtRepo.update('99999999', { notes: 'Updated' })).rejects.toThrow(
      EntityNotFoundError
    );
  });
});

// ============================================================================
// Delete
// ============================================================================

describe('WorktreeRepository.delete', () => {
  dbTest('should delete by full UUID and short ID', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const data1 = createWorktreeData({
      repo_id: repo.repo_id,
      name: 'wt1',
      worktree_unique_id: 1,
    });
    const data2 = createWorktreeData({
      repo_id: repo.repo_id,
      name: 'wt2',
      worktree_unique_id: 2,
    });
    await wtRepo.create(data1);
    await wtRepo.create(data2);

    // Delete by full UUID
    await wtRepo.delete(data1.worktree_id);
    const found1 = await wtRepo.findById(data1.worktree_id);
    expect(found1).toBeNull();

    // Delete by short ID
    const shortId = data2.worktree_id.replace(/-/g, '').slice(0, 8);
    await wtRepo.delete(shortId);
    const found2 = await wtRepo.findById(data2.worktree_id);
    expect(found2).toBeNull();
  });

  dbTest('should isolate deletions across worktrees and repos', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new WorktreeRepository(db);

    const repo1 = await repoRepo.create(createRepoData({ slug: 'repo-1' }));
    const repo2 = await repoRepo.create(createRepoData({ slug: 'repo-2' }));

    const data1 = createWorktreeData({
      repo_id: repo1.repo_id,
      name: 'wt1',
      worktree_unique_id: 1,
    });
    const data2 = createWorktreeData({
      repo_id: repo1.repo_id,
      name: 'wt2',
      worktree_unique_id: 2,
    });
    const data3 = createWorktreeData({
      repo_id: repo2.repo_id,
      name: 'wt3',
      worktree_unique_id: 3,
    });
    await wtRepo.create(data1);
    await wtRepo.create(data2);
    await wtRepo.create(data3);

    await wtRepo.delete(data1.worktree_id);

    // Verify only data1 deleted
    const remaining = await wtRepo.findAll();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((w) => w.name).sort()).toEqual(['wt2', 'wt3']);

    const repo2Worktrees = await wtRepo.findAll({ repo_id: repo2.repo_id });
    expect(repo2Worktrees).toHaveLength(1);
    expect(repo2Worktrees[0].worktree_id).toBe(data3.worktree_id);
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const wtRepo = new WorktreeRepository(db);

    await expect(wtRepo.delete('99999999')).rejects.toThrow(EntityNotFoundError);
  });
});
