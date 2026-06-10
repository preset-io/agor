/**
 * BranchRepository Tests
 *
 * Tests for type-safe CRUD operations on branches with short ID support.
 */

import type { BranchID, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId, shortId } from '../../lib/ids';
import { boards } from '../schema';
import { dbTest } from '../test-helpers';
import { AmbiguousIdError, EntityNotFoundError } from './base';
import { BoardObjectRepository } from './board-objects';
import { BoardRepository } from './boards';
import { BranchRepository } from './branches';
import { GroupRepository } from './groups';
import { RepoRepository } from './repos';
import { UsersRepository } from './users';

/**
 * Create test repo data (needed as FK for branches)
 */
function createRepoData(overrides?: { repo_id?: UUID; slug?: string }) {
  const slug = overrides?.slug ?? 'test-repo';
  return {
    repo_id: overrides?.repo_id ?? generateId(),
    slug,
    name: slug,
    repo_type: 'remote' as const,
    remote_url: 'https://github.com/test/repo.git',
    local_path: `/home/user/.agor/repos/${slug}`,
    default_branch: 'main',
  };
}

/**
 * Create test branch data
 *
 * Returns object with required fields for create() and commonly used fields
 */
function createBranchData(overrides?: {
  branch_id?: BranchID;
  repo_id?: UUID;
  name?: string;
  ref?: string;
  branch_unique_id?: number;
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
  storage_mode?: 'worktree' | 'clone';
  clone_depth?: number;
  permission_source?: 'board' | 'override';
  others_can?: 'none' | 'view' | 'session' | 'prompt' | 'all';
  others_fs_access?: 'none' | 'read' | 'write';
  dangerously_allow_session_sharing?: boolean;
}) {
  const name = overrides?.name ?? 'feature-branch';
  const repoId = overrides?.repo_id ?? (generateId() as UUID);
  const wtId = overrides?.branch_id ?? (generateId() as BranchID);

  return {
    branch_id: wtId,
    repo_id: repoId,
    name,
    ref: overrides?.ref ?? `refs/heads/${name}`,
    branch_unique_id: overrides?.branch_unique_id ?? 1,
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
    storage_mode: overrides?.storage_mode,
    clone_depth: overrides?.clone_depth,
    permission_source: overrides?.permission_source,
    others_can: overrides?.others_can,
    others_fs_access: overrides?.others_fs_access,
    dangerously_allow_session_sharing: overrides?.dangerously_allow_session_sharing,
  } as const;
}

describe('BranchRepository.findBranchIdsByZone', () => {
  dbTest('finds branch ids by board_objects data.zone_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const branchRepo = new BranchRepository(db);
    const boardObjectRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const boardId = generateId() as UUID;
    await (db as any).insert(boards).values({
      board_id: boardId,
      created_at: new Date(),
      created_by: 'test-user' as UUID,
      name: 'Test Board',
      data: {
        objects: {
          'zone-review': { type: 'zone', label: 'Review' },
          'zone-done': { type: 'zone', label: 'Done' },
        },
      },
    });

    const branchInZone = await branchRepo.create(
      createBranchData({
        repo_id: repo.repo_id,
        branch_id: generateId() as BranchID,
        name: 'feature-in-zone',
        branch_unique_id: 1,
        board_id: boardId,
      })
    );
    const branchOtherZone = await branchRepo.create(
      createBranchData({
        repo_id: repo.repo_id,
        branch_id: generateId() as BranchID,
        name: 'feature-other-zone',
        branch_unique_id: 2,
        board_id: boardId,
      })
    );

    await boardObjectRepo.create({
      board_id: boardId,
      branch_id: branchInZone.branch_id,
      position: { x: 0, y: 0 },
      zone_id: 'zone-review',
    });
    await boardObjectRepo.create({
      board_id: boardId,
      branch_id: branchOtherZone.branch_id,
      position: { x: 100, y: 0 },
      zone_id: 'zone-done',
    });

    await expect(branchRepo.findBranchIdsByZone('zone-review')).resolves.toEqual([
      branchInZone.branch_id,
    ]);
  });
});

// ============================================================================
// Create
// ============================================================================

describe('BranchRepository.create', () => {
  dbTest('should create branch with comprehensive field validation', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const boardId = generateId() as UUID;
    await (db as any).insert(boards).values({
      board_id: boardId,
      created_at: new Date(),
      created_by: 'test-user' as UUID,
      name: 'Test Board',
      data: {},
    });

    // Test with all fields populated
    const data = createBranchData({
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
    expect(created.branch_id).toBe(data.branch_id);
    expect(created.repo_id).toBe(data.repo_id);
    expect(created.name).toBe(data.name);
    expect(created.ref).toBe(data.ref);
    expect(created.branch_unique_id).toBe(data.branch_unique_id);
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

  dbTest(
    'should apply defaults for omitted fields (and throw if created_by missing)',
    async ({ db }) => {
      const repoRepo = new RepoRepository(db);
      const wtRepo = new BranchRepository(db);

      const repo = await repoRepo.create(createRepoData());
      const dataNoCreator = createBranchData({ repo_id: repo.repo_id });
      delete (dataNoCreator as any).branch_id;
      delete (dataNoCreator as any).created_by;
      await expect(wtRepo.create(dataNoCreator)).rejects.toThrow(/created_by/);

      const data = createBranchData({ repo_id: repo.repo_id });
      delete (data as any).branch_id;

      const created = await wtRepo.create(data);

      // Verify defaults
      expect(created.branch_id).toBeDefined();
      expect(created.branch_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(created.created_by).toBeDefined();
      expect(created.new_branch).toBe(false);
      expect(created.board_id).toBeUndefined();
      expect(new Date(created.last_used!).getTime()).toBeGreaterThan(0);
    }
  );

  dbTest('should preserve provided timestamps', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const createdAt = new Date('2024-01-01T00:00:00Z').toISOString();
    const data = {
      ...createBranchData({ repo_id: repo.repo_id }),
      created_at: createdAt,
    };

    const created = await wtRepo.create(data);

    expect(created.created_at).toBe(createdAt);
  });

  // Migration 0044 (sqlite) / 0035 (postgres): storage_mode + clone_depth.
  // Validates both the schema (column exists, default applies, CHECK enforces
  // the enum) and the repository's round-tripping of the new fields. If the
  // migration didn't run, `wtRepo.create` would fail with `no such column`.
  dbTest(
    'defaults storage_mode to "worktree" and leaves clone_depth NULL when unset',
    async ({ db }) => {
      const repoRepo = new RepoRepository(db);
      const wtRepo = new BranchRepository(db);
      const repo = await repoRepo.create(createRepoData());
      const data = createBranchData({ repo_id: repo.repo_id });

      const created = await wtRepo.create(data);

      expect(created.storage_mode).toBe('worktree');
      expect(created.clone_depth).toBeUndefined();

      // Round-trip through findById to catch any rowToBranch drift.
      const fetched = await wtRepo.findById(created.branch_id);
      expect(fetched?.storage_mode).toBe('worktree');
      expect(fetched?.clone_depth).toBeUndefined();
    }
  );

  dbTest('round-trips storage_mode="clone" with a positive clone_depth', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const repo = await repoRepo.create(createRepoData());
    const data = {
      ...createBranchData({ repo_id: repo.repo_id, name: 'shallow-clone-branch' }),
      storage_mode: 'clone' as const,
      clone_depth: 100,
    };

    const created = await wtRepo.create(data);
    expect(created.storage_mode).toBe('clone');
    expect(created.clone_depth).toBe(100);

    const fetched = await wtRepo.findById(created.branch_id);
    expect(fetched?.storage_mode).toBe('clone');
    expect(fetched?.clone_depth).toBe(100);
  });

  // Note: storage_mode enum validation is enforced at the application
  // layer (Drizzle schema enum hint, Zod payload schemas, daemon service
  // checks) — NOT via a DB-side CHECK constraint, per
  // context/guides/creating-database-migrations.md §"Avoid CHECK constraints
  // for enum-like columns on SQLite". A bogus literal would pass the DB
  // here and get rejected at the daemon/MCP boundary instead.
});

// ============================================================================
// FindById (with short ID support)
// ============================================================================

describe('BranchRepository.findById', () => {
  dbTest('should find by full UUID and short ID variants', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const data = createBranchData({
      repo_id: repo.repo_id,
      base_ref: 'main',
      base_sha: 'abc123',
      notes: 'Test notes',
    });
    await wtRepo.create(data);

    // Test full UUID
    const byFull = await wtRepo.findById(data.branch_id);
    expect(byFull?.branch_id).toBe(data.branch_id);
    expect(byFull?.base_ref).toBe('main');

    // Test short ID without hyphens
    const idPrefix = shortId(data.branch_id);
    const byShort = await wtRepo.findById(idPrefix);
    expect(byShort?.branch_id).toBe(data.branch_id);

    // Test short ID with hyphens
    const shortIdHyphens = shortId(data.branch_id);
    const byShortHyphens = await wtRepo.findById(shortIdHyphens);
    expect(byShortHyphens?.branch_id).toBe(data.branch_id);

    // Test case insensitivity
    const byUpper = await wtRepo.findById(idPrefix.toUpperCase());
    expect(byUpper?.branch_id).toBe(data.branch_id);
  });

  dbTest('should return null for non-existent ID', async ({ db }) => {
    const wtRepo = new BranchRepository(db);

    const found = await wtRepo.findById('99999999');

    expect(found).toBeNull();
  });

  dbTest('should throw AmbiguousIdError with suggestions', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo = await repoRepo.create(createRepoData());

    // Create two branches with IDs that share the first 8 characters
    const id1 = '01933e4a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as BranchID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-9d2e1c4b5a6f' as BranchID;

    await wtRepo.create(
      createBranchData({
        branch_id: id1,
        repo_id: repo.repo_id,
        name: 'branch-1',
        branch_unique_id: 1,
      })
    );
    await wtRepo.create(
      createBranchData({
        branch_id: id2,
        repo_id: repo.repo_id,
        name: 'branch-2',
        branch_unique_id: 2,
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
      // AmbiguousIdError carries full UUIDs so the user can disambiguate by
      // pasting one back — short forms collapse to the same string when the
      // prefix collides (which is exactly when the error fires).
      expect(ambiguousError.matches).toEqual(expect.arrayContaining([id1, id2]));
    }
  });
});

// ============================================================================
// FindAll
// ============================================================================

describe('BranchRepository.findAll', () => {
  dbTest('should return all branches unfiltered', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo = await repoRepo.create(createRepoData());

    await wtRepo.create(
      createBranchData({
        repo_id: repo.repo_id,
        name: 'branch-1',
        branch_unique_id: 1,
        base_ref: 'main',
        notes: 'Test notes',
      })
    );
    await wtRepo.create(
      createBranchData({
        repo_id: repo.repo_id,
        name: 'branch-2',
        branch_unique_id: 2,
      })
    );
    await wtRepo.create(
      createBranchData({
        repo_id: repo.repo_id,
        name: 'branch-3',
        branch_unique_id: 3,
      })
    );

    const branches = await wtRepo.findAll();

    expect(branches).toHaveLength(3);
    expect(branches.map((w) => w.name).sort()).toEqual(['branch-1', 'branch-2', 'branch-3']);
    // Verify full object population
    const first = branches.find((w) => w.name === 'branch-1');
    expect(first?.base_ref).toBe('main');
    expect(first?.notes).toBe('Test notes');
  });

  dbTest('should filter by repo_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo1 = await repoRepo.create(createRepoData({ slug: 'repo-1' }));
    const repo2 = await repoRepo.create(createRepoData({ slug: 'repo-2' }));

    await wtRepo.create(
      createBranchData({
        repo_id: repo1.repo_id,
        name: 'repo1-wt',
        branch_unique_id: 1,
      })
    );
    await wtRepo.create(
      createBranchData({
        repo_id: repo2.repo_id,
        name: 'repo2-wt1',
        branch_unique_id: 2,
      })
    );
    await wtRepo.create(
      createBranchData({
        repo_id: repo2.repo_id,
        name: 'repo2-wt2',
        branch_unique_id: 3,
      })
    );

    const repo2Branches = await wtRepo.findAll({ repo_id: repo2.repo_id });

    expect(repo2Branches).toHaveLength(2);
    expect(repo2Branches.map((w) => w.name).sort()).toEqual(['repo2-wt1', 'repo2-wt2']);
    expect(repo2Branches.every((w) => w.repo_id === repo2.repo_id)).toBe(true);
  });

  dbTest('should return empty array for no matches', async ({ db }) => {
    const wtRepo = new BranchRepository(db);

    const empty = await wtRepo.findAll();
    expect(empty).toEqual([]);

    const repoRepo = new RepoRepository(db);
    const repo = await repoRepo.create(createRepoData());
    await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));

    const filtered = await wtRepo.findAll({ repo_id: generateId() });
    expect(filtered).toEqual([]);
  });
});

// ============================================================================
// FindByRepoAndName
// ============================================================================

describe('BranchRepository.findByRepoAndName', () => {
  dbTest('should find by repo_id and name with case sensitivity', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo1 = await repoRepo.create(createRepoData({ slug: 'repo-1' }));
    const repo2 = await repoRepo.create(createRepoData({ slug: 'repo-2' }));

    const data1 = createBranchData({
      repo_id: repo1.repo_id,
      name: 'feature',
      branch_unique_id: 1,
      base_ref: 'main',
      notes: 'Test notes',
    });
    const data2 = createBranchData({
      repo_id: repo2.repo_id,
      name: 'feature',
      branch_unique_id: 2,
    });

    await wtRepo.create(data1);
    await wtRepo.create(data2);

    // Should find in correct repos
    const found1 = await wtRepo.findByRepoAndName(repo1.repo_id, 'feature');
    expect(found1?.branch_id).toBe(data1.branch_id);
    expect(found1?.base_ref).toBe('main');

    const found2 = await wtRepo.findByRepoAndName(repo2.repo_id, 'feature');
    expect(found2?.branch_id).toBe(data2.branch_id);
    expect(found1?.branch_id).not.toBe(found2?.branch_id);

    // Should be case-sensitive
    const notFound = await wtRepo.findByRepoAndName(repo1.repo_id, 'FEATURE');
    expect(notFound).toBeNull();
  });

  dbTest('should return null for non-existent combinations', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo = await repoRepo.create(createRepoData());
    await wtRepo.create(
      createBranchData({
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

describe('BranchRepository.update', () => {
  dbTest('should update by full UUID and short ID', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const data = createBranchData({
      repo_id: repo.repo_id,
      notes: 'Original notes',
      base_ref: 'main',
    });
    await wtRepo.create(data);

    // Update by full UUID
    const updated1 = await wtRepo.update(data.branch_id, { notes: 'Updated notes' });
    expect(updated1.notes).toBe('Updated notes');
    expect(updated1.name).toBe(data.name); // Unchanged

    // Update by short ID
    const idPrefix = shortId(data.branch_id);
    const updated2 = await wtRepo.update(idPrefix, { base_ref: 'develop' });
    expect(updated2.base_ref).toBe('develop');
  });

  dbTest('should update all field types comprehensively', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const boardId = generateId() as UUID;
    await (db as any).insert(boards).values({
      board_id: boardId,
      created_at: new Date(),
      created_by: 'test-user' as UUID,
      name: 'Test Board',
      data: {},
    });

    const data = createBranchData({
      repo_id: repo.repo_id,
      name: 'feature',
      ref: 'refs/heads/feature',
      base_ref: 'main',
      notes: 'Original notes',
    });
    const created = await wtRepo.create(data);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await wtRepo.update(data.branch_id, {
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
    const wtRepo = new BranchRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const boardId = generateId() as UUID;
    await (db as any).insert(boards).values({
      board_id: boardId,
      created_at: new Date(),
      created_by: 'test-user' as UUID,
      name: 'Test Board',
      data: {},
    });

    const data = createBranchData({
      repo_id: repo.repo_id,
      board_id: boardId,
      notes: 'Some notes',
    });
    await wtRepo.create(data);

    // deepMerge treats `undefined` as "leave unchanged" and `null` as
    // "clear" — pass null explicitly to clear optional fields.
    const updated = await wtRepo.update(data.branch_id, {
      board_id: null as unknown as UUID,
      notes: null as unknown as string,
    });

    // board_id is a nullable column; rowToBranch maps null → undefined.
    expect(updated.board_id).toBeUndefined();
    // notes lives inside the JSON `data` blob; a cleared field comes back
    // as null (json serialisation) rather than omitted.
    expect(updated.notes ?? undefined).toBeUndefined();
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const wtRepo = new BranchRepository(db);

    await expect(wtRepo.update('99999999', { notes: 'Updated' })).rejects.toThrow(
      EntityNotFoundError
    );
  });
});

// ============================================================================
// Delete
// ============================================================================

describe('BranchRepository.delete', () => {
  dbTest('should delete by full UUID and short ID', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const data1 = createBranchData({
      repo_id: repo.repo_id,
      name: 'wt1',
      branch_unique_id: 1,
    });
    const data2 = createBranchData({
      repo_id: repo.repo_id,
      name: 'wt2',
      branch_unique_id: 2,
    });
    await wtRepo.create(data1);
    await wtRepo.create(data2);

    // Delete by full UUID
    await wtRepo.delete(data1.branch_id);
    const found1 = await wtRepo.findById(data1.branch_id);
    expect(found1).toBeNull();

    // Delete by short ID
    const idPrefix = shortId(data2.branch_id);
    await wtRepo.delete(idPrefix);
    const found2 = await wtRepo.findById(data2.branch_id);
    expect(found2).toBeNull();
  });

  dbTest('should isolate deletions across branches and repos', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);

    const repo1 = await repoRepo.create(createRepoData({ slug: 'repo-1' }));
    const repo2 = await repoRepo.create(createRepoData({ slug: 'repo-2' }));

    const data1 = createBranchData({
      repo_id: repo1.repo_id,
      name: 'wt1',
      branch_unique_id: 1,
    });
    const data2 = createBranchData({
      repo_id: repo1.repo_id,
      name: 'wt2',
      branch_unique_id: 2,
    });
    const data3 = createBranchData({
      repo_id: repo2.repo_id,
      name: 'wt3',
      branch_unique_id: 3,
    });
    await wtRepo.create(data1);
    await wtRepo.create(data2);
    await wtRepo.create(data3);

    await wtRepo.delete(data1.branch_id);

    // Verify only data1 deleted
    const remaining = await wtRepo.findAll();
    expect(remaining).toHaveLength(2);
    expect(remaining.map((w) => w.name).sort()).toEqual(['wt2', 'wt3']);

    const repo2Branches = await wtRepo.findAll({ repo_id: repo2.repo_id });
    expect(repo2Branches).toHaveLength(1);
    expect(repo2Branches[0].branch_id).toBe(data3.branch_id);
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const wtRepo = new BranchRepository(db);

    await expect(wtRepo.delete('99999999')).rejects.toThrow(EntityNotFoundError);
  });
});

describe('BranchRepository permission_source', () => {
  dbTest(
    'defaults legacy/read branches to override and round-trips board alignment',
    async ({ db }) => {
      const repoRepo = new RepoRepository(db);
      const branchRepo = new BranchRepository(db);
      const repo = await repoRepo.create(createRepoData({ slug: 'permission-source-repo' }));

      const legacy = await branchRepo.create(
        createBranchData({
          repo_id: repo.repo_id,
          name: 'legacy-permission-source',
          branch_unique_id: 9101,
        })
      );
      expect(legacy.permission_source).toBe('override');

      const aligned = await branchRepo.create(
        createBranchData({
          repo_id: repo.repo_id,
          name: 'aligned-permission-source',
          branch_unique_id: 9102,
          permission_source: 'board',
        })
      );
      expect(aligned.permission_source).toBe('board');

      const patched = await branchRepo.update(aligned.branch_id, { permission_source: 'override' });
      expect(patched.permission_source).toBe('override');
    }
  );
});

describe('BranchRepository resolveUserAccess', () => {
  dbTest(
    'uses board session-sharing defaults for direct owners of board-aligned branches',
    async ({ db }) => {
      const repoRepo = new RepoRepository(db);
      const boardRepo = new BoardRepository(db);
      const branchRepo = new BranchRepository(db);
      const usersRepo = new UsersRepository(db);
      const repo = await repoRepo.create(createRepoData({ slug: 'owner-board-defaults-repo' }));
      const ownerId = generateId() as UUID;
      await usersRepo.create({
        user_id: ownerId,
        email: 'owner-board-defaults@example.com',
        name: 'Owner',
      });
      const board = await boardRepo.create({
        board_id: generateId(),
        name: 'Board Defaults',
        created_by: ownerId,
        access_mode: 'shared',
        default_dangerously_allow_session_sharing: true,
      });
      const branch = await branchRepo.create(
        createBranchData({
          repo_id: repo.repo_id,
          board_id: board.board_id,
          name: 'owner-board-defaults',
          branch_unique_id: 9201,
          created_by: ownerId,
          permission_source: 'board',
          dangerously_allow_session_sharing: false,
        })
      );
      await branchRepo.addOwner(branch.branch_id, ownerId);

      const effective = await branchRepo.resolveUserAccess(branch, ownerId);
      expect(effective).toMatchObject({
        can: 'all',
        source: 'owner',
        dangerously_allow_session_sharing: true,
      });
    }
  );

  dbTest(
    'tie-breaks equal app permissions by stronger explicit filesystem access',
    async ({ db }) => {
      const repoRepo = new RepoRepository(db);
      const boardRepo = new BoardRepository(db);
      const branchRepo = new BranchRepository(db);
      const groupRepo = new GroupRepository(db);
      const usersRepo = new UsersRepository(db);
      const repo = await repoRepo.create(createRepoData({ slug: 'fs-tiebreak-repo' }));
      const creatorId = generateId() as UUID;
      const memberId = generateId() as UUID;
      await usersRepo.create({
        user_id: creatorId,
        email: 'creator-fs@example.com',
        name: 'Creator',
      });
      await usersRepo.create({
        user_id: memberId,
        email: 'member-fs@example.com',
        name: 'Member',
      });
      const board = await boardRepo.create({
        board_id: generateId(),
        name: 'FS Tie Board',
        created_by: creatorId,
        access_mode: 'shared',
        default_others_can: 'session',
        default_others_fs_access: 'read',
      });
      const group = await groupRepo.create({ name: 'FS Writers', created_by: creatorId });
      await groupRepo.addMember(group.group_id, memberId, creatorId);
      await groupRepo.upsertBoardGrant({
        board_id: board.board_id,
        group_id: group.group_id,
        can: 'session',
        fs_access: 'write',
        created_by: creatorId,
      });
      const branch = await branchRepo.create(
        createBranchData({
          repo_id: repo.repo_id,
          board_id: board.board_id,
          name: 'fs-tiebreak',
          branch_unique_id: 9202,
          created_by: creatorId,
          permission_source: 'board',
        })
      );

      const effective = await branchRepo.resolveUserAccess(branch, memberId);
      expect(effective).toMatchObject({
        can: 'session',
        fs_access: 'write',
        source: 'board_group',
        group_ids: [group.group_id],
      });
    }
  );
});
