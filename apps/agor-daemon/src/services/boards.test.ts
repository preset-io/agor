/**
 * BoardsService Tests
 *
 * Basic tests to verify custom export/import/clone methods are properly wired up.
 */

import {
  BoardObjectRepository,
  BoardRepository,
  BranchRepository,
  type Database,
  generateId,
  RepoRepository,
  UsersRepository,
} from '@agor/core/db';
import type { Board, BoardID, BranchID, UUID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { type BoardParams, BoardsService } from './boards';

const TEST_USER = 'test-user' as UUID;
const TEST_PARAMS = { user: { user_id: TEST_USER } } as never;

async function ensureTestUser(db: Database) {
  const users = new UsersRepository(db);
  await users.create({
    user_id: TEST_USER,
    email: 'test-user@example.com',
    name: 'Test User',
    role: 'member',
  });
}

function createRepoData(overrides?: { repo_id?: UUID; slug?: string }) {
  const slug = overrides?.slug ?? `test-repo-${generateId()}`;
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

function createBranchData(overrides?: { branch_id?: BranchID; repo_id?: UUID; name?: string }) {
  const name = overrides?.name ?? `feature-${generateId()}`;
  return {
    branch_id: overrides?.branch_id ?? (generateId() as BranchID),
    repo_id: overrides?.repo_id ?? (generateId() as UUID),
    name,
    ref: `refs/heads/${name}`,
    branch_unique_id: 1,
    path: `/home/user/.agor/repos/test-repo/${name}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: TEST_USER,
  };
}

describe('BoardsService - Custom Methods', () => {
  dbTest('toBlob should export board to JSON blob', async ({ db }) => {
    const service = new BoardsService(db);

    // Create a test board
    const board = (await service.create({
      name: 'Test Board',
      slug: 'test-board',
      description: 'Board for testing export',
      icon: '🧪',
      created_by: TEST_USER,
    })) as Board;

    // Export to blob
    const blob = await service.toBlob(board.board_id);

    expect(blob).toHaveProperty('name');
    expect(blob.name).toBe('Test Board');
    expect(blob.slug).toBe('test-board');
    expect(blob.icon).toBe('🧪');
  });

  dbTest('toBlob should accept slug identifiers', async ({ db }) => {
    const service = new BoardsService(db);

    await service.create({
      name: 'Slug Export Board',
      slug: 'slug-export',
      created_by: TEST_USER,
    });

    const blob = await service.toBlob('slug-export');

    expect(blob.name).toBe('Slug Export Board');
    expect(blob.slug).toBe('slug-export');
  });

  dbTest('fromBlob should import board from JSON blob', async ({ db }) => {
    await ensureTestUser(db);
    const service = new BoardsService(db);

    // Create and export a board
    const original = (await service.create({
      name: 'Original Board',
      slug: 'original-board',
      icon: '🔷',
      created_by: TEST_USER,
    })) as Board;

    const blob = await service.toBlob(original.board_id);

    // Modify blob and import
    blob.name = 'Imported Board';
    blob.slug = 'imported-board';

    const imported = await service.fromBlob(blob, TEST_PARAMS);

    expect(imported.name).toBe('Imported Board');
    expect(imported.slug).toBe('imported-board');
    expect(imported.board_id).not.toBe(original.board_id);
    expect(imported.icon).toBe('🔷'); // Icon should be preserved
  });

  dbTest('toYaml should export board to YAML string', async ({ db }) => {
    const service = new BoardsService(db);

    const board = (await service.create({
      name: 'YAML Board',
      slug: 'yaml-board',
      icon: '📄',
      created_by: TEST_USER,
    })) as Board;

    const yaml = await service.toYaml(board.board_id);

    expect(typeof yaml).toBe('string');
    expect(yaml).toContain('name: YAML Board');
    expect(yaml).toContain('slug: yaml-board');
    expect(yaml).toContain('icon: 📄');
  });

  dbTest('fromYaml should import board from YAML string', async ({ db }) => {
    await ensureTestUser(db);
    const service = new BoardsService(db);

    // Create and export to YAML
    const original = (await service.create({
      name: 'Original YAML Board',
      slug: 'original-yaml',
      description: 'Test description',
      created_by: TEST_USER,
    })) as Board;

    const yaml = await service.toYaml(original.board_id);

    // Modify YAML and import
    const modifiedYaml = yaml
      .replace('name: Original YAML Board', 'name: Imported YAML Board')
      .replace('slug: original-yaml', 'slug: imported-yaml');

    const imported = await service.fromYaml(modifiedYaml, TEST_PARAMS);

    expect(imported.name).toBe('Imported YAML Board');
    expect(imported.slug).toBe('imported-yaml');
    expect(imported.board_id).not.toBe(original.board_id);
    expect(imported.description).toBe('Test description'); // Preserved from YAML
  });

  dbTest('clone should create a copy with new name', async ({ db }) => {
    await ensureTestUser(db);
    const service = new BoardsService(db);

    const original = (await service.create({
      name: 'Original Board',
      slug: 'original',
      description: 'To be cloned',
      icon: '🔵',
      created_by: TEST_USER,
    })) as Board;

    const cloned = await service.clone(original.board_id, 'Cloned Board', TEST_PARAMS);

    expect(cloned.name).toBe('Cloned Board');
    expect(cloned.slug).toBe('cloned-board');
    expect(cloned.board_id).not.toBe(original.board_id);
    expect(cloned.icon).toBe(original.icon);
    expect(cloned.description).toBe(original.description);
  });

  dbTest('clone should accept slug identifiers', async ({ db }) => {
    await ensureTestUser(db);
    const service = new BoardsService(db);

    await service.create({
      name: 'Slug Clone Source',
      slug: 'slug-source',
      created_by: TEST_USER,
    });

    const cloned = await service.clone('slug-source', 'Slug Clone Target', TEST_PARAMS);

    expect(cloned.name).toBe('Slug Clone Target');
    expect(cloned.slug).toBe('slug-clone-target');
  });

  dbTest(
    'removeBoardObject clears zone-pinned entities with absolute positions',
    async ({ db }) => {
      const emitBoardObjectPatched = vi.fn();
      const service = new BoardsService(db, emitBoardObjectPatched);
      const repoRepo = new RepoRepository(db);
      const branchRepo = new BranchRepository(db);
      const boardObjectRepo = new BoardObjectRepository(db);

      const repo = await repoRepo.create(createRepoData());
      const branch = await branchRepo.create(createBranchData({ repo_id: repo.repo_id }));
      const board = (await service.create({
        name: 'Zone Cleanup Board',
        slug: `zone-cleanup-${generateId()}`,
        created_by: TEST_USER,
        objects: {
          'zone-review': {
            type: 'zone',
            x: 100,
            y: 200,
            width: 400,
            height: 300,
            label: 'Review',
          },
        },
      })) as Board;

      const boardObject = await boardObjectRepo.create({
        board_id: board.board_id,
        branch_id: branch.branch_id,
        position: { x: 10, y: 20 },
        zone_id: 'zone-review',
      });

      await service.removeBoardObject(board.board_id, 'zone-review');

      const updatedBoardObject = await boardObjectRepo.findByObjectId(boardObject.object_id);
      expect(updatedBoardObject?.zone_id).toBeUndefined();
      expect(updatedBoardObject?.position).toEqual({ x: 110, y: 220 });
      expect(emitBoardObjectPatched).toHaveBeenCalledWith(
        expect.objectContaining({
          object_id: boardObject.object_id,
          position: { x: 110, y: 220 },
          zone_id: null,
        })
      );
    }
  );

  dbTest(
    'ensureTeammateWelcomeNote creates rendered static markdown server-side',
    async ({ db }) => {
      const service = new BoardsService(db);
      const board = (await service.create({
        name: 'Teammate Board',
        slug: `teammate-board-${generateId()}`,
        created_by: TEST_USER,
      })) as Board;

      const params = {};
      const updated = await service.ensureTeammateWelcomeNote(
        {
          boardId: board.board_id,
          teammateName: '<img src=x onerror=alert(1)>',
          teammateEmoji: '🤖',
        },
        params
      );

      const note = updated.objects?.['welcome-note'];
      expect(params).toEqual({
        teammateWelcomeNoteMutated: true,
      });
      expect(note?.type).toBe('markdown');
      expect(note?.content).not.toContain('<img src=x onerror=alert(1)>');
      expect(note?.content).toContain('&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;');
      expect(note?.content).toContain('🤖');
    }
  );

  dbTest(
    'ensureTeammateWelcomeNote is a no-op when welcome note already exists',
    async ({ db }) => {
      const service = new BoardsService(db);
      const board = (await service.create({
        name: 'Teammate Board Existing Note',
        slug: `teammate-board-existing-${generateId()}`,
        created_by: TEST_USER,
        objects: {
          'welcome-note': {
            type: 'markdown',
            x: 12,
            y: 34,
            width: 456,
            content: '# Welcome to {{teammate.name}}',
          },
        },
      })) as Board;

      const params = {};
      const updated = await service.ensureTeammateWelcomeNote(
        {
          boardId: board.board_id,
          teammateName: 'Ignored Bot',
          teammateEmoji: '🛠️',
        },
        params
      );

      expect(params).toEqual({});
      expect(updated.objects?.['welcome-note']).toEqual(board.objects?.['welcome-note']);
    }
  );

  dbTest('ensureTeammateWelcomeNote preserves custom existing welcome notes', async ({ db }) => {
    const service = new BoardsService(db);
    const board = (await service.create({
      name: 'Teammate Board Custom',
      slug: `teammate-board-custom-${generateId()}`,
      created_by: TEST_USER,
      objects: {
        'welcome-note': {
          type: 'markdown',
          x: 1,
          y: 2,
          width: 300,
          content: 'My custom welcome note',
        },
      },
    })) as Board;

    const params = {};
    const updated = await service.ensureTeammateWelcomeNote(
      {
        boardId: board.board_id,
        teammateName: 'Ignored Bot',
      },
      params
    );

    expect(params).toEqual({});
    expect(updated.objects?.['welcome-note']).toEqual(board.objects?.['welcome-note']);
  });

  dbTest('find with lean omits objects/custom_css; get + full find keep them', async ({ db }) => {
    const service = new BoardsService(db);

    const board = (await service.create({
      name: 'Lean Board',
      slug: `lean-board-${generateId()}`,
      created_by: TEST_USER,
      custom_css: '.canvas { background: #000 }',
      objects: {
        'zone-1': { type: 'zone', x: 0, y: 0, width: 100, height: 100, label: 'Review' },
      },
    })) as Board;

    const findBoardById = (result: Awaited<ReturnType<BoardsService['find']>>) => {
      const list = Array.isArray(result) ? result : result.data;
      const found = list.find((b) => b.board_id === board.board_id);
      if (!found) throw new Error('board missing from find result');
      return found;
    };

    // Lean list drops the heavy annotations but keeps metadata.
    const leanBoard = findBoardById(await service.find({ query: { lean: true } } as never));
    expect(leanBoard.name).toBe('Lean Board');
    expect(leanBoard.objects).toBeUndefined();
    expect(leanBoard.custom_css).toBeUndefined();

    // Default (non-lean) list still carries them.
    const fullBoard = findBoardById(await service.find({ query: {} } as never));
    expect(fullBoard.objects).toBeDefined();
    expect(Object.keys(fullBoard.objects ?? {})).toContain('zone-1');
    expect(fullBoard.custom_css).toBe('.canvas { background: #000 }');

    // Single-board read is always full, regardless of list leanness.
    const got = await service.get(board.board_id);
    expect(Object.keys(got.objects ?? {})).toContain('zone-1');
    expect(got.custom_css).toBe('.canvas { background: #000 }');
  });

  dbTest('find with lean:false returns the same full boards as a non-lean find', async ({ db }) => {
    const service = new BoardsService(db);

    const board = (await service.create({
      name: 'Lean False Board',
      slug: `lean-false-board-${generateId()}`,
      created_by: TEST_USER,
      custom_css: '.canvas { background: #111 }',
      objects: {
        'zone-1': { type: 'zone', x: 0, y: 0, width: 100, height: 100, label: 'Review' },
      },
    })) as Board;

    const findBoardById = (result: Awaited<ReturnType<BoardsService['find']>>) => {
      const list = Array.isArray(result) ? result : result.data;
      const found = list.find((b) => b.board_id === board.board_id);
      if (!found) throw new Error('board missing from find result');
      return found;
    };

    // `lean: false` is a valid whitelisted query value — it must NOT leak into
    // the adapter's field filtering (boards have no `lean` column) and empty the
    // result. It returns the same full boards as a plain non-lean find.
    const leanFalseBoard = findBoardById(await service.find({ query: { lean: false } } as never));
    const fullBoard = findBoardById(await service.find({ query: {} } as never));

    expect(leanFalseBoard.objects).toBeDefined();
    expect(Object.keys(leanFalseBoard.objects ?? {})).toContain('zone-1');
    expect(leanFalseBoard.custom_css).toBe('.canvas { background: #111 }');
    expect(leanFalseBoard).toEqual(fullBoard);
  });

  dbTest('should have all custom methods defined', async ({ db }) => {
    const service = new BoardsService(db);

    // Verify methods exist and are functions
    expect(typeof service.toBlob).toBe('function');
    expect(typeof service.fromBlob).toBe('function');
    expect(typeof service.toYaml).toBe('function');
    expect(typeof service.fromYaml).toBe('function');
    expect(typeof service.clone).toBe('function');
    expect(typeof service.ensureTeammateWelcomeNote).toBe('function');
  });

  dbTest('manually emits archive transitions from the custom method', async ({ db }) => {
    const emitBoardEvent = vi.fn();
    const service = new BoardsService(db, undefined, emitBoardEvent);
    const board = (await service.create({
      name: 'Archive realtime',
      slug: 'archive-realtime',
      created_by: TEST_USER,
    })) as Board;
    const params = {
      user: { user_id: TEST_USER },
      tenant: { tenant_id: 'tenant-a', source: 'auth_claim' },
    } as never;

    const archived = await service.archive(board.board_id, params);

    expect(archived.archived).toBe(true);
    expect(emitBoardEvent).toHaveBeenCalledWith({
      event: 'patched',
      data: archived,
      params,
      id: board.board_id,
    });
  });
});

describe('BoardsService.find SQL pushdown', () => {
  async function seed(db: Database) {
    const service = new BoardsService(db);
    const repo = new BoardRepository(db);
    const b1 = (await service.create({
      name: 'Beta',
      slug: 'beta',
      created_by: TEST_USER,
    })) as Board;
    const b2 = (await service.create({
      name: 'Alpha',
      slug: 'alpha',
      created_by: TEST_USER,
    })) as Board;
    const archived = (await service.create({
      name: 'Gamma',
      slug: 'gamma',
      created_by: TEST_USER,
    })) as Board;
    await repo.update(archived.board_id, { archived: true });
    return { service, b1, b2, archived };
  }

  dbTest('reads the whole table when no scope is present (rbac off)', async ({ db }) => {
    const { service } = await seed(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { boardRepo: BoardRepository }).boardRepo,
      'findAll'
    );

    // The boards validator strips `archived`, so with no board_id scope there is
    // nothing high-selectivity to push: the read falls through to the whole
    // table and `find` returns every board (including archived) — the real win
    // is the RBAC board_id $in scope covered below.
    const result = (await service.find({ query: { $sort: { name: 1 } } })) as {
      data: Board[];
      total: number;
    };

    expect(repoFindAll).toHaveBeenCalledWith({});
    expect(result.total).toBe(3);
    expect(result.data.map((b) => b.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  dbTest('pushes an accessible board_id $in set into SQL (rbac on)', async ({ db }) => {
    const { service, b1, b2 } = await seed(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { boardRepo: BoardRepository }).boardRepo,
      'findAll'
    );

    const result = (await service.find({
      query: { board_id: { $in: [b1.board_id as BoardID, b2.board_id as BoardID] } },
    })) as { data: Board[]; total: number };

    expect(repoFindAll).toHaveBeenCalledWith({
      boardIds: [b1.board_id, b2.board_id],
    });
    expect(result.total).toBe(2);
    expect(result.data.map((b) => b.board_id).sort()).toEqual([b1.board_id, b2.board_id].sort());
  });

  dbTest('pushes a scalar board_id as a single-id set', async ({ db }) => {
    const { service, b1 } = await seed(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { boardRepo: BoardRepository }).boardRepo,
      'findAll'
    );

    const result = (await service.find({ query: { board_id: b1.board_id } })) as {
      data: Board[];
      total: number;
    };

    expect(repoFindAll).toHaveBeenCalledWith({ boardIds: [b1.board_id] });
    expect(result.total).toBe(1);
    expect(result.data[0].board_id).toBe(b1.board_id);
  });

  dbTest(
    'returns no rows for an empty accessible set without reading the table',
    async ({ db }) => {
      const { service } = await seed(db);
      const repoFindAll = vi.spyOn(
        (service as unknown as { boardRepo: BoardRepository }).boardRepo,
        'findAll'
      );

      const result = (await service.find({ query: { board_id: { $in: [] } } })) as {
        data: Board[];
        total: number;
      };

      expect(repoFindAll).toHaveBeenCalledWith({ boardIds: [] });
      expect(result.total).toBe(0);
      expect(result.data).toHaveLength(0);
    }
  );

  dbTest('pushes the RBAC SQL visibility marker into the repository read', async ({ db }) => {
    const { service } = await seed(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { boardRepo: BoardRepository }).boardRepo,
      'findAll'
    );

    await service.find({
      _agorSqlBoardAccessUserId: TEST_USER as UUID,
      query: {},
    } as BoardParams);

    expect(repoFindAll).toHaveBeenCalledWith({ visibleToUserId: TEST_USER });
  });

  dbTest('lean list still enforces board RBAC visibility', async ({ db }) => {
    const OTHER_USER = 'other-user' as UUID;
    const service = new BoardsService(db);

    // Visible: a board the viewer created, carrying the heavy annotations the
    // lean projection is expected to drop.
    const visible = (await service.create({
      name: 'Visible Board',
      slug: `visible-${generateId()}`,
      created_by: TEST_USER,
      access_mode: 'shared',
      custom_css: '.canvas { background: #111 }',
      objects: {
        'zone-1': { type: 'zone', x: 0, y: 0, width: 100, height: 100, label: 'Review' },
      },
    })) as Board;

    // Hidden: a private board owned by someone else — never visible to the viewer.
    const hidden = (await service.create({
      name: 'Hidden Board',
      slug: `hidden-${generateId()}`,
      created_by: OTHER_USER,
      access_mode: 'private',
      objects: {
        'zone-2': { type: 'zone', x: 0, y: 0, width: 10, height: 10, label: 'Secret' },
      },
    })) as Board;

    const repoFindAll = vi.spyOn(
      (service as unknown as { boardRepo: BoardRepository }).boardRepo,
      'findAll'
    );

    const result = (await service.find({
      _agorSqlBoardAccessUserId: TEST_USER as UUID,
      query: { lean: true },
    } as BoardParams)) as { data: Board[]; total: number };

    // RBAC visibility and the lean projection ride the SAME repository read, so
    // the lean list can never widen visibility past the SQL RBAC predicate.
    expect(repoFindAll).toHaveBeenCalledWith({ visibleToUserId: TEST_USER, lean: true });

    const ids = result.data.map((b) => b.board_id);
    expect(ids).toContain(visible.board_id);
    expect(ids).not.toContain(hidden.board_id);

    // The surviving board is genuinely lean (heavy annotations dropped).
    const visibleRow = result.data.find((b) => b.board_id === visible.board_id);
    expect(visibleRow?.objects).toBeUndefined();
    expect(visibleRow?.custom_css).toBeUndefined();
  });
});
