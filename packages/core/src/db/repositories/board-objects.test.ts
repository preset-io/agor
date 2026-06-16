/**
 * BoardObjectRepository Tests
 *
 * Tests for board object CRUD operations with branch positioning.
 */

import type { BoardID, BranchID, UUID } from '@agor/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { boardObjects, boards } from '../schema';
import { dbTest } from '../test-helpers';
import { EntityNotFoundError, RepositoryError } from './base';
import { BoardObjectRepository } from './board-objects';
import { BranchRepository } from './branches';
import { RepoRepository } from './repos';

/**
 * Create test repo data
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
 */
function createBranchData(overrides?: { branch_id?: BranchID; repo_id?: UUID; name?: string }) {
  const name = overrides?.name ?? 'feature-branch';
  const repoId = overrides?.repo_id ?? (generateId() as UUID);
  return {
    branch_id: overrides?.branch_id ?? (generateId() as BranchID),
    repo_id: repoId,
    name,
    ref: `refs/heads/${name}`,
    branch_unique_id: 1,
    path: `/home/user/.agor/repos/test-repo/${name}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: 'test-user' as UUID,
  };
}

/**
 * Create test board
 */
async function createBoard(db: Database, overrides?: { board_id?: BoardID; name?: string }) {
  const boardId = (overrides?.board_id ?? generateId()) as BoardID;
  await (db as any).insert(boards).values({
    board_id: boardId,
    created_at: new Date(),
    created_by: 'test-user',
    name: overrides?.name ?? 'Test Board',
    data: {},
  });
  return boardId;
}

// ============================================================================
// Create
// ============================================================================

describe('BoardObjectRepository.create', () => {
  dbTest('should create board object with position', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 100, y: 200 },
    });

    expect(created.object_id).toBeDefined();
    expect(created.board_id).toBe(boardId);
    expect(created.branch_id).toBe(branch.branch_id);
    expect(created.position).toEqual({ x: 100, y: 200 });
    expect(created.zone_id).toBeUndefined();
    expect(created.created_at).toBeDefined();
  });

  dbTest('should create board object with zone_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 50, y: 75 },
      zone_id: 'zone-123',
    });

    expect(created.position).toEqual({ x: 50, y: 75 });
    expect(created.zone_id).toBe('zone-123');
  });

  dbTest('should prevent duplicate branch on boards', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 100, y: 100 },
    });

    // Attempt to add same branch to another board (or same board)
    const boardId2 = await createBoard(db, { name: 'Second Board' });

    await expect(
      boRepo.create({
        board_id: boardId2,
        branch_id: branch.branch_id,
        position: { x: 200, y: 200 },
      })
    ).rejects.toThrow(RepositoryError);
    await expect(
      boRepo.create({
        board_id: boardId2,
        branch_id: branch.branch_id,
        position: { x: 200, y: 200 },
      })
    ).rejects.toThrow('already on a board');
  });

  dbTest('should allow multiple branches on same board', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const wt1 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'feature-1' }));
    const wt2 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'feature-2' }));
    const boardId = await createBoard(db);

    const obj1 = await boRepo.create({
      board_id: boardId,
      branch_id: wt1.branch_id,
      position: { x: 0, y: 0 },
    });

    const obj2 = await boRepo.create({
      board_id: boardId,
      branch_id: wt2.branch_id,
      position: { x: 300, y: 300 },
    });

    expect(obj1.board_id).toBe(obj2.board_id);
    expect(obj1.object_id).not.toBe(obj2.object_id);
    expect(obj1.branch_id).not.toBe(obj2.branch_id);
  });

  dbTest('should handle negative and zero coordinates', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: -100, y: 0 },
    });

    expect(created.position).toEqual({ x: -100, y: 0 });
  });

  dbTest('should handle decimal coordinates', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 123.456, y: 789.012 },
    });

    expect(created.position).toEqual({ x: 123.456, y: 789.012 });
  });
});

// ============================================================================
// FindAll
// ============================================================================

describe('BoardObjectRepository.findAll', () => {
  dbTest('should return empty array when no board objects', async ({ db }) => {
    const boRepo = new BoardObjectRepository(db);

    const objects = await boRepo.findAll();

    expect(objects).toEqual([]);
  });

  dbTest('should return all board objects across all boards', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const wt1 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt1' }));
    const wt2 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt2' }));
    const wt3 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt3' }));

    const boardId1 = await createBoard(db, { name: 'Board 1' });
    const boardId2 = await createBoard(db, { name: 'Board 2' });

    await boRepo.create({
      board_id: boardId1,
      branch_id: wt1.branch_id,
      position: { x: 0, y: 0 },
    });
    await boRepo.create({
      board_id: boardId1,
      branch_id: wt2.branch_id,
      position: { x: 100, y: 100 },
    });
    await boRepo.create({
      board_id: boardId2,
      branch_id: wt3.branch_id,
      position: { x: 200, y: 200 },
    });

    const all = await boRepo.findAll();

    expect(all).toHaveLength(3);
    expect(all.map((o) => o.branch_id).sort()).toEqual(
      [wt1.branch_id, wt2.branch_id, wt3.branch_id].sort()
    );
  });

  dbTest(
    'should apply filters, count, and pagination in SQL-facing findAll APIs',
    async ({ db }) => {
      const repoRepo = new RepoRepository(db);
      const wtRepo = new BranchRepository(db);
      const boRepo = new BoardObjectRepository(db);

      const repo = await repoRepo.create(createRepoData());
      const wt1 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt1' }));
      const wt2 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt2' }));
      const wt3 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt3' }));
      const boardId1 = await createBoard(db, { name: 'Board 1' });
      const boardId2 = await createBoard(db, { name: 'Board 2' });

      await boRepo.create({
        board_id: boardId1,
        branch_id: wt1.branch_id,
        position: { x: 0, y: 0 },
        zone_id: 'zone-review',
      });
      await boRepo.create({
        board_id: boardId1,
        branch_id: wt2.branch_id,
        position: { x: 100, y: 100 },
        zone_id: 'zone-review',
      });
      await boRepo.create({
        board_id: boardId2,
        branch_id: wt3.branch_id,
        position: { x: 200, y: 200 },
        zone_id: 'zone-done',
      });

      await expect(
        boRepo.count({ board_id: boardId1, zone_id: 'zone-review', entity_type: 'branch' })
      ).resolves.toBe(2);

      const page = await boRepo.findAll(
        { board_id: boardId1, zone_id: 'zone-review', entity_type: 'branch' },
        { limit: 1, offset: 1 }
      );

      expect(page).toHaveLength(1);
      expect([wt1.branch_id, wt2.branch_id]).toContain(page[0].branch_id);
    }
  );

  dbTest('should scope visible board objects with SQL RBAC predicates', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const visibleBranch = await wtRepo.create(
      createBranchData({ repo_id: repo.repo_id, name: 'visible' })
    );
    const hiddenBranch = await wtRepo.create(
      createBranchData({ repo_id: repo.repo_id, name: 'hidden' })
    );
    await wtRepo.update(hiddenBranch.branch_id, { others_can: 'none' });
    const boardId = await createBoard(db);
    const layoutObjectId = generateId();

    await boRepo.create({
      board_id: boardId,
      branch_id: visibleBranch.branch_id,
      position: { x: 0, y: 0 },
    });
    await boRepo.create({
      board_id: boardId,
      branch_id: hiddenBranch.branch_id,
      position: { x: 100, y: 100 },
    });
    await (db as any).insert(boardObjects).values({
      object_id: layoutObjectId,
      board_id: boardId,
      created_at: new Date(),
      branch_id: null,
      card_id: null,
      data: { position: { x: 200, y: 200 } },
    });

    const userId = generateId() as UUID;

    await expect(boRepo.countVisibleToUser(userId, { board_id: boardId })).resolves.toBe(2);

    const visibleObjects = await boRepo.findVisibleToUser(userId, { board_id: boardId });
    expect(visibleObjects.map((object) => object.object_id)).toContain(layoutObjectId);
    expect(visibleObjects.map((object) => object.branch_id)).toContain(visibleBranch.branch_id);
    expect(visibleObjects.map((object) => object.branch_id)).not.toContain(hiddenBranch.branch_id);
  });

  dbTest('should include all fields in returned objects', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 50, y: 75 },
      zone_id: 'zone-abc',
    });

    const all = await boRepo.findAll();

    expect(all).toHaveLength(1);
    const obj = all[0];
    expect(obj.object_id).toBeDefined();
    expect(obj.board_id).toBe(boardId);
    expect(obj.branch_id).toBe(branch.branch_id);
    expect(obj.position).toEqual({ x: 50, y: 75 });
    expect(obj.zone_id).toBe('zone-abc');
    expect(obj.created_at).toBeDefined();
  });
});

// ============================================================================
// FindByBoardId
// ============================================================================

describe('BoardObjectRepository.findByBoardId', () => {
  dbTest('should return empty array for board with no objects', async ({ db }) => {
    const boRepo = new BoardObjectRepository(db);
    const boardId = await createBoard(db);

    const objects = await boRepo.findByBoardId(boardId);

    expect(objects).toEqual([]);
  });

  dbTest('should filter objects by board_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const wt1 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt1' }));
    const wt2 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt2' }));
    const wt3 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt3' }));

    const boardId1 = await createBoard(db, { name: 'Board 1' });
    const boardId2 = await createBoard(db, { name: 'Board 2' });

    await boRepo.create({
      board_id: boardId1,
      branch_id: wt1.branch_id,
      position: { x: 10, y: 20 },
    });
    await boRepo.create({
      board_id: boardId1,
      branch_id: wt2.branch_id,
      position: { x: 30, y: 40 },
    });
    await boRepo.create({
      board_id: boardId2,
      branch_id: wt3.branch_id,
      position: { x: 50, y: 60 },
    });

    const board1Objects = await boRepo.findByBoardId(boardId1);

    expect(board1Objects).toHaveLength(2);
    expect(board1Objects.every((o) => o.board_id === boardId1)).toBe(true);
    expect(board1Objects.map((o) => o.branch_id).sort()).toEqual(
      [wt1.branch_id, wt2.branch_id].sort()
    );

    const board2Objects = await boRepo.findByBoardId(boardId2);
    expect(board2Objects).toHaveLength(1);
    expect(board2Objects[0].branch_id).toBe(wt3.branch_id);
  });

  dbTest('should preserve position and zone data', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const wt1 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt1' }));
    const wt2 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt2' }));

    const boardId = await createBoard(db);

    await boRepo.create({
      board_id: boardId,
      branch_id: wt1.branch_id,
      position: { x: 111, y: 222 },
      zone_id: 'zone-1',
    });
    await boRepo.create({
      board_id: boardId,
      branch_id: wt2.branch_id,
      position: { x: 333, y: 444 },
    });

    const objects = await boRepo.findByBoardId(boardId);

    const obj1 = objects.find((o) => o.branch_id === wt1.branch_id);
    const obj2 = objects.find((o) => o.branch_id === wt2.branch_id);

    expect(obj1?.position).toEqual({ x: 111, y: 222 });
    expect(obj1?.zone_id).toBe('zone-1');
    expect(obj2?.position).toEqual({ x: 333, y: 444 });
    expect(obj2?.zone_id).toBeUndefined();
  });
});

// ============================================================================
// FindByObjectId
// ============================================================================

describe('BoardObjectRepository.findByObjectId', () => {
  dbTest('should find board object by object_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 123, y: 456 },
      zone_id: 'zone-test',
    });

    const found = await boRepo.findByObjectId(created.object_id);

    expect(found).not.toBeNull();
    expect(found?.object_id).toBe(created.object_id);
    expect(found?.board_id).toBe(boardId);
    expect(found?.branch_id).toBe(branch.branch_id);
    expect(found?.position).toEqual({ x: 123, y: 456 });
    expect(found?.zone_id).toBe('zone-test');
  });

  dbTest('should return null for non-existent object_id', async ({ db }) => {
    const boRepo = new BoardObjectRepository(db);

    const found = await boRepo.findByObjectId('non-existent-id');

    expect(found).toBeNull();
  });

  dbTest('should distinguish between different objects', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const wt1 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt1' }));
    const wt2 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt2' }));
    const boardId = await createBoard(db);

    const obj1 = await boRepo.create({
      board_id: boardId,
      branch_id: wt1.branch_id,
      position: { x: 0, y: 0 },
    });
    const obj2 = await boRepo.create({
      board_id: boardId,
      branch_id: wt2.branch_id,
      position: { x: 100, y: 100 },
    });

    const found1 = await boRepo.findByObjectId(obj1.object_id);
    const found2 = await boRepo.findByObjectId(obj2.object_id);

    expect(found1?.object_id).toBe(obj1.object_id);
    expect(found2?.object_id).toBe(obj2.object_id);
    expect(found1?.branch_id).toBe(wt1.branch_id);
    expect(found2?.branch_id).toBe(wt2.branch_id);
  });
});

// ============================================================================
// FindByBranchId
// ============================================================================

describe('BoardObjectRepository.findByBranchId', () => {
  dbTest('should find board object by branch_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 250, y: 350 },
    });

    const found = await boRepo.findByBranchId(branch.branch_id);

    expect(found).not.toBeNull();
    expect(found?.object_id).toBe(created.object_id);
    expect(found?.branch_id).toBe(branch.branch_id);
    expect(found?.position).toEqual({ x: 250, y: 350 });
  });

  dbTest('should return null for branch not on any board', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));

    const found = await boRepo.findByBranchId(branch.branch_id);

    expect(found).toBeNull();
  });

  dbTest('should enforce one-board-per-branch constraint', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const wt1 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt1' }));
    const wt2 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt2' }));
    const boardId = await createBoard(db);

    await boRepo.create({
      board_id: boardId,
      branch_id: wt1.branch_id,
      position: { x: 0, y: 0 },
    });

    // wt1 should have a board object
    const found1 = await boRepo.findByBranchId(wt1.branch_id);
    expect(found1).not.toBeNull();

    // wt2 should not
    const found2 = await boRepo.findByBranchId(wt2.branch_id);
    expect(found2).toBeNull();
  });
});

// ============================================================================
// UpdatePosition
// ============================================================================

describe('BoardObjectRepository.updatePosition', () => {
  dbTest('should update position', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 100, y: 200 },
    });

    const updated = await boRepo.updatePosition(created.object_id, { x: 300, y: 400 });

    expect(updated.position).toEqual({ x: 300, y: 400 });
    expect(updated.object_id).toBe(created.object_id);
    expect(updated.board_id).toBe(created.board_id);
    expect(updated.branch_id).toBe(created.branch_id);
  });

  dbTest('should preserve zone_id when updating position', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 0, y: 0 },
      zone_id: 'zone-preserved',
    });

    const updated = await boRepo.updatePosition(created.object_id, { x: 500, y: 600 });

    expect(updated.position).toEqual({ x: 500, y: 600 });
    expect(updated.zone_id).toBe('zone-preserved');
  });

  dbTest('should preserve undefined zone_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 0, y: 0 },
    });

    const updated = await boRepo.updatePosition(created.object_id, { x: 700, y: 800 });

    expect(updated.position).toEqual({ x: 700, y: 800 });
    expect(updated.zone_id).toBeUndefined();
  });

  dbTest('should throw EntityNotFoundError for non-existent object', async ({ db }) => {
    const boRepo = new BoardObjectRepository(db);

    await expect(boRepo.updatePosition('non-existent-id', { x: 100, y: 100 })).rejects.toThrow(
      EntityNotFoundError
    );
  });

  dbTest('should handle negative position updates', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 100, y: 100 },
    });

    const updated = await boRepo.updatePosition(created.object_id, { x: -50, y: -75 });

    expect(updated.position).toEqual({ x: -50, y: -75 });
  });
});

// ============================================================================
// UpdateZone
// ============================================================================

describe('BoardObjectRepository.updateZone', () => {
  dbTest('should set zone_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 0, y: 0 },
    });

    const updated = await boRepo.updateZone(created.object_id, 'zone-new');

    expect(updated.zone_id).toBe('zone-new');
    expect(updated.position).toEqual({ x: 0, y: 0 });
    expect(updated.object_id).toBe(created.object_id);
  });

  dbTest('should update existing zone_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 100, y: 200 },
      zone_id: 'zone-old',
    });

    const updated = await boRepo.updateZone(created.object_id, 'zone-changed');

    expect(updated.zone_id).toBe('zone-changed');
    expect(updated.position).toEqual({ x: 100, y: 200 });
  });

  dbTest('should clear zone_id with undefined', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 50, y: 75 },
      zone_id: 'zone-to-remove',
    });

    const updated = await boRepo.updateZone(created.object_id, undefined);

    expect(updated.zone_id).toBeUndefined();
    expect(updated.position).toEqual({ x: 50, y: 75 });
  });

  dbTest('should clear zone_id with null', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 25, y: 30 },
      zone_id: 'zone-to-null',
    });

    const updated = await boRepo.updateZone(created.object_id, null);

    expect(updated.zone_id).toBeUndefined();
    expect(updated.position).toEqual({ x: 25, y: 30 });
  });

  dbTest('should preserve position when updating zone', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 999, y: 888 },
    });

    const updated = await boRepo.updateZone(created.object_id, 'zone-123');

    expect(updated.position).toEqual({ x: 999, y: 888 });
    expect(updated.zone_id).toBe('zone-123');
  });

  dbTest('should throw EntityNotFoundError for non-existent object', async ({ db }) => {
    const boRepo = new BoardObjectRepository(db);

    await expect(boRepo.updateZone('non-existent-id', 'zone-test')).rejects.toThrow(
      EntityNotFoundError
    );
  });
});

// ============================================================================
// Remove
// ============================================================================

describe('BoardObjectRepository.remove', () => {
  dbTest('should remove board object by object_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 0, y: 0 },
    });

    await boRepo.remove(created.object_id);

    const found = await boRepo.findByObjectId(created.object_id);
    expect(found).toBeNull();
  });

  dbTest('should throw EntityNotFoundError for non-existent object', async ({ db }) => {
    const boRepo = new BoardObjectRepository(db);

    await expect(boRepo.remove('non-existent-id')).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('should not affect other board objects', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const wt1 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt1' }));
    const wt2 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt2' }));
    const boardId = await createBoard(db);

    const obj1 = await boRepo.create({
      board_id: boardId,
      branch_id: wt1.branch_id,
      position: { x: 0, y: 0 },
    });
    const obj2 = await boRepo.create({
      board_id: boardId,
      branch_id: wt2.branch_id,
      position: { x: 100, y: 100 },
    });

    await boRepo.remove(obj1.object_id);

    const remaining = await boRepo.findAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].object_id).toBe(obj2.object_id);
  });

  dbTest('should allow re-adding branch after removal', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId1 = await createBoard(db, { name: 'Board 1' });
    const boardId2 = await createBoard(db, { name: 'Board 2' });

    const obj1 = await boRepo.create({
      board_id: boardId1,
      branch_id: branch.branch_id,
      position: { x: 0, y: 0 },
    });

    await boRepo.remove(obj1.object_id);

    // Should now be able to add to another board
    const obj2 = await boRepo.create({
      board_id: boardId2,
      branch_id: branch.branch_id,
      position: { x: 200, y: 200 },
    });

    expect(obj2.board_id).toBe(boardId2);
    expect(obj2.object_id).not.toBe(obj1.object_id);
  });
});

// ============================================================================
// RemoveByBranchId
// ============================================================================

describe('BoardObjectRepository.removeByBranchId', () => {
  dbTest('should remove board object by branch_id', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 0, y: 0 },
    });

    await boRepo.removeByBranchId(branch.branch_id);

    const found = await boRepo.findByBranchId(branch.branch_id);
    expect(found).toBeNull();
  });

  dbTest('should not throw for branch not on any board', async ({ db }) => {
    const boRepo = new BoardObjectRepository(db);

    await expect(boRepo.removeByBranchId(generateId() as BranchID)).resolves.not.toThrow();
  });

  dbTest('should not affect other branches', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const wt1 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt1' }));
    const wt2 = await wtRepo.create(createBranchData({ repo_id: repo.repo_id, name: 'wt2' }));
    const boardId = await createBoard(db);

    await boRepo.create({
      board_id: boardId,
      branch_id: wt1.branch_id,
      position: { x: 0, y: 0 },
    });
    await boRepo.create({
      board_id: boardId,
      branch_id: wt2.branch_id,
      position: { x: 100, y: 100 },
    });

    await boRepo.removeByBranchId(wt1.branch_id);

    const remaining = await boRepo.findAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].branch_id).toBe(wt2.branch_id);
  });
});

// ============================================================================
// Foreign Key Constraints (Cascade Deletes)
// ============================================================================

describe('BoardObjectRepository FK constraints', () => {
  dbTest('should cascade delete when board is deleted', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 0, y: 0 },
    });

    // Delete the board
    await (db as any).delete(boards).where(eq(boards.board_id, boardId));

    // Board object should be cascade deleted
    const found = await boRepo.findByBranchId(branch.branch_id);
    expect(found).toBeNull();
  });

  dbTest('should cascade delete when branch is deleted', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 0, y: 0 },
    });

    // Delete the branch
    await wtRepo.delete(branch.branch_id);

    // Board object should be cascade deleted
    const found = await boRepo.findByObjectId(created.object_id);
    expect(found).toBeNull();
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('BoardObjectRepository edge cases', () => {
  dbTest('should handle large coordinate values', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 999999, y: -999999 },
    });

    expect(created.position).toEqual({ x: 999999, y: -999999 });
  });

  dbTest('should handle very long zone_id strings', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const longZoneId = 'z'.repeat(200);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 0, y: 0 },
      zone_id: longZoneId,
    });

    expect(created.zone_id).toBe(longZoneId);
  });

  dbTest('should handle rapid position updates', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 0, y: 0 },
    });

    // Rapid sequential updates
    await boRepo.updatePosition(created.object_id, { x: 1, y: 1 });
    await boRepo.updatePosition(created.object_id, { x: 2, y: 2 });
    await boRepo.updatePosition(created.object_id, { x: 3, y: 3 });
    const final = await boRepo.updatePosition(created.object_id, { x: 4, y: 4 });

    expect(final.position).toEqual({ x: 4, y: 4 });
  });

  dbTest('should handle zone updates with position preserved across changes', async ({ db }) => {
    const repoRepo = new RepoRepository(db);
    const wtRepo = new BranchRepository(db);
    const boRepo = new BoardObjectRepository(db);

    const repo = await repoRepo.create(createRepoData());
    const branch = await wtRepo.create(createBranchData({ repo_id: repo.repo_id }));
    const boardId = await createBoard(db);

    const created = await boRepo.create({
      board_id: boardId,
      branch_id: branch.branch_id,
      position: { x: 100, y: 200 },
      zone_id: 'zone-1',
    });

    // Update zone
    const updated1 = await boRepo.updateZone(created.object_id, 'zone-2');
    expect(updated1.zone_id).toBe('zone-2');
    expect(updated1.position).toEqual({ x: 100, y: 200 });

    // Update position
    const updated2 = await boRepo.updatePosition(created.object_id, { x: 300, y: 400 });
    expect(updated2.zone_id).toBe('zone-2');
    expect(updated2.position).toEqual({ x: 300, y: 400 });

    // Clear zone
    const updated3 = await boRepo.updateZone(created.object_id, undefined);
    expect(updated3.zone_id).toBeUndefined();
    expect(updated3.position).toEqual({ x: 300, y: 400 });
  });
});
