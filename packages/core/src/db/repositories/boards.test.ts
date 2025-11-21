/**
 * BoardRepository Tests
 *
 * Tests for type-safe CRUD operations on boards with short ID support,
 * board object management (zones/text), and JSON field handling.
 */

import type { Board, BoardObject, UUID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import { dbTest } from '../test-helpers';
import { AmbiguousIdError, EntityNotFoundError } from './base';
import { BoardRepository } from './boards';

/**
 * Create test board data with defaults
 */
function createBoardData(overrides?: Partial<Board>): Partial<Board> {
  return {
    board_id: overrides?.board_id ?? generateId(),
    name: overrides?.name ?? 'Test Board',
    slug: overrides?.slug,
    description: overrides?.description,
    color: overrides?.color,
    icon: overrides?.icon,
    objects: overrides?.objects,
    custom_context: overrides?.custom_context,
    created_by: overrides?.created_by ?? 'test-user',
    created_at: overrides?.created_at,
    last_updated: overrides?.last_updated,
  };
}

// ============================================================================
// Create
// ============================================================================

describe('BoardRepository.create', () => {
  dbTest('should create board with all required fields', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({
      name: 'My Board',
      created_by: 'user-123',
    });

    const created = await repo.create(data);

    expect(created.board_id).toBe(data.board_id);
    expect(created.name).toBe('My Board');
    expect(created.created_by).toBe('user-123');
    expect(created.created_at).toBeDefined();
    expect(created.last_updated).toBeDefined();
  });

  dbTest('should generate board_id if not provided', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData();
    delete (data as any).board_id;

    const created = await repo.create(data);

    expect(created.board_id).toBeDefined();
    expect(created.board_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  dbTest('should default to "Untitled Board" if name not provided', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData();
    delete (data as any).name;

    const created = await repo.create(data);

    expect(created.name).toBe('Untitled Board');
  });

  dbTest('should default to "anonymous" created_by if not provided', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData();
    delete (data as any).created_by;

    const created = await repo.create(data);

    expect(created.created_by).toBe('anonymous');
  });

  dbTest('should store all optional fields correctly', async ({ db }) => {
    const repo = new BoardRepository(db);
    const textObject: BoardObject = {
      type: 'text',
      x: 100,
      y: 200,
      width: 300,
      height: 50,
      content: 'Sprint Planning',
      fontSize: 24,
      color: '#ffffff',
      background: '#1677ff',
    };

    const zoneObject: BoardObject = {
      type: 'zone',
      x: 0,
      y: 0,
      width: 500,
      height: 400,
      label: 'Backend Tasks',
      color: '#52c41a',
      status: 'active',
      trigger: {
        template: 'Fix bug: {{description}}',
        behavior: 'always_new',
      },
    };

    const data = createBoardData({
      name: 'Sprint Board',
      slug: 'sprint-42',
      description: 'Q1 2025 Sprint Board',
      color: '#1677ff',
      icon: '🚀',
      objects: {
        'text-1': textObject,
        'zone-1': zoneObject,
      },
      custom_context: {
        team: 'Backend',
        sprint: 42,
        deadline: '2025-03-15',
      },
    });

    const created = await repo.create(data);

    expect(created.name).toBe('Sprint Board');
    expect(created.slug).toBe('sprint-42');
    expect(created.description).toBe('Q1 2025 Sprint Board');
    expect(created.color).toBe('#1677ff');
    expect(created.icon).toBe('🚀');
    expect(created.objects).toEqual({
      'text-1': textObject,
      'zone-1': zoneObject,
    });
    expect(created.custom_context).toEqual({
      team: 'Backend',
      sprint: 42,
      deadline: '2025-03-15',
    });
  });

  dbTest('should preserve timestamps if provided', async ({ db }) => {
    const repo = new BoardRepository(db);
    const createdAt = new Date('2024-01-01T00:00:00Z').toISOString();
    const lastUpdated = new Date('2024-01-02T00:00:00Z').toISOString();
    const data = createBoardData({
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

describe('BoardRepository.findById', () => {
  dbTest('should find board by full UUID', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({ name: 'Test Board' });
    await repo.create(data);

    const found = await repo.findById(data.board_id!);

    expect(found).not.toBeNull();
    expect(found?.board_id).toBe(data.board_id);
    expect(found?.name).toBe('Test Board');
  });

  dbTest('should find board by 8-char short ID', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData();
    await repo.create(data);

    const shortId = data.board_id!.replace(/-/g, '').slice(0, 8);
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.board_id).toBe(data.board_id);
  });

  dbTest('should handle short ID with hyphens', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData();
    await repo.create(data);

    const shortId = data.board_id!.slice(0, 8);
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.board_id).toBe(data.board_id);
  });

  dbTest('should be case-insensitive', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData();
    await repo.create(data);

    const shortId = data.board_id!.replace(/-/g, '').slice(0, 8).toUpperCase();
    const found = await repo.findById(shortId);

    expect(found).not.toBeNull();
    expect(found?.board_id).toBe(data.board_id);
  });

  dbTest('should return null for non-existent ID', async ({ db }) => {
    const repo = new BoardRepository(db);

    const found = await repo.findById('99999999');

    expect(found).toBeNull();
  });

  dbTest('should throw AmbiguousIdError for ambiguous short ID', async ({ db }) => {
    const repo = new BoardRepository(db);

    const id1 = '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-000000000000' as UUID;

    await repo.create(createBoardData({ board_id: id1, name: 'Board 1' }));
    await repo.create(createBoardData({ board_id: id2, name: 'Board 2' }));

    const ambiguousPrefix = '01933e4a';

    await expect(repo.findById(ambiguousPrefix)).rejects.toThrow(AmbiguousIdError);
  });

  dbTest('should provide helpful suggestions for ambiguous ID', async ({ db }) => {
    const repo = new BoardRepository(db);

    const id1 = '01933e4a-aaaa-7c35-a8f3-9d2e1c4b5a6f' as UUID;
    const id2 = '01933e4a-bbbb-7c35-a8f3-9d2e1c4b5a6f' as UUID;

    await repo.create(createBoardData({ board_id: id1 }));
    await repo.create(createBoardData({ board_id: id2 }));

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
    const repo = new BoardRepository(db);
    const data = createBoardData({
      objects: {
        'text-1': { type: 'text', x: 100, y: 200, content: 'Test' },
      },
      custom_context: { foo: 'bar', nested: { value: 123 } },
    });
    await repo.create(data);

    const found = await repo.findById(data.board_id!);

    expect(found?.objects).toEqual(data.objects);
    expect(found?.custom_context).toEqual(data.custom_context);
  });
});

// ============================================================================
// FindBySlug
// ============================================================================

describe('BoardRepository.findBySlug', () => {
  dbTest('should find board by exact slug match', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({ name: 'Main Board', slug: 'main' });
    await repo.create(data);

    const found = await repo.findBySlug('main');

    expect(found).not.toBeNull();
    expect(found?.slug).toBe('main');
    expect(found?.name).toBe('Main Board');
    expect(found?.board_id).toBe(data.board_id);
  });

  dbTest('should return null for non-existent slug', async ({ db }) => {
    const repo = new BoardRepository(db);

    const found = await repo.findBySlug('non-existent');

    expect(found).toBeNull();
  });

  dbTest('should be case-sensitive for slugs', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({ slug: 'my-board' });
    await repo.create(data);

    const found = await repo.findBySlug('MY-BOARD');

    expect(found).toBeNull();
  });

  dbTest('should distinguish similar slugs', async ({ db }) => {
    const repo = new BoardRepository(db);
    await repo.create(createBoardData({ name: 'Project', slug: 'project' }));
    await repo.create(createBoardData({ name: 'Project 2', slug: 'project-2' }));

    const found = await repo.findBySlug('project');

    expect(found).not.toBeNull();
    expect(found?.slug).toBe('project');
    expect(found?.name).toBe('Project');
  });

  dbTest('should handle boards without slugs', async ({ db }) => {
    const repo = new BoardRepository(db);
    await repo.create(createBoardData({ name: 'No Slug Board' }));

    const found = await repo.findBySlug('no-slug');

    expect(found).toBeNull();
  });
});

// ============================================================================
// FindAll
// ============================================================================

describe('BoardRepository.findAll', () => {
  dbTest('should return empty array when no boards', async ({ db }) => {
    const repo = new BoardRepository(db);

    const boards = await repo.findAll();

    expect(boards).toEqual([]);
  });

  dbTest('should return all boards', async ({ db }) => {
    const repo = new BoardRepository(db);

    const data1 = createBoardData({ name: 'Board 1', slug: 'board-1' });
    const data2 = createBoardData({ name: 'Board 2', slug: 'board-2' });
    const data3 = createBoardData({ name: 'Board 3', slug: 'board-3' });

    await repo.create(data1);
    await repo.create(data2);
    await repo.create(data3);

    const boards = await repo.findAll();

    expect(boards).toHaveLength(3);
    expect(boards.map((b) => b.name).sort()).toEqual(['Board 1', 'Board 2', 'Board 3']);
  });

  dbTest('should return fully populated board objects', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({
      name: 'Test Board',
      slug: 'test',
      description: 'Test description',
      color: '#1677ff',
    });
    await repo.create(data);

    const boards = await repo.findAll();

    expect(boards).toHaveLength(1);
    const found = boards[0];
    expect(found.board_id).toBe(data.board_id);
    expect(found.name).toBe('Test Board');
    expect(found.slug).toBe('test');
    expect(found.description).toBe('Test description');
    expect(found.color).toBe('#1677ff');
    expect(found.created_at).toBeDefined();
    expect(found.last_updated).toBeDefined();
  });
});

// ============================================================================
// Update
// ============================================================================

describe('BoardRepository.update', () => {
  dbTest('should update board by full UUID', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({ name: 'Original Name' });
    await repo.create(data);

    const updated = await repo.update(data.board_id!, { name: 'Updated Name' });

    expect(updated.name).toBe('Updated Name');
    expect(updated.board_id).toBe(data.board_id);
  });

  dbTest('should update board by short ID', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({ name: 'Original' });
    await repo.create(data);

    const shortId = data.board_id!.replace(/-/g, '').slice(0, 8);
    const updated = await repo.update(shortId, { description: 'New description' });

    expect(updated.description).toBe('New description');
    expect(updated.board_id).toBe(data.board_id);
  });

  dbTest('should update multiple fields', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({
      name: 'Original',
      slug: 'original',
    });
    await repo.create(data);

    const updated = await repo.update(data.board_id!, {
      name: 'Updated',
      slug: 'updated',
      description: 'New description',
      color: '#ff4d4f',
      icon: '⚡',
    });

    expect(updated.name).toBe('Updated');
    expect(updated.slug).toBe('updated');
    expect(updated.description).toBe('New description');
    expect(updated.color).toBe('#ff4d4f');
    expect(updated.icon).toBe('⚡');
  });

  dbTest('should update JSON fields (objects and custom_context)', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({
      objects: {
        'text-1': { type: 'text', x: 100, y: 200, content: 'Original' },
      },
      custom_context: { version: 1 },
    });
    await repo.create(data);

    const updated = await repo.update(data.board_id!, {
      objects: {
        'text-1': { type: 'text', x: 150, y: 250, content: 'Updated' },
        'zone-1': { type: 'zone', x: 0, y: 0, width: 500, height: 400, label: 'Zone' },
      },
      custom_context: { version: 2, newField: 'value' },
    });

    expect(updated.objects).toEqual({
      'text-1': { type: 'text', x: 150, y: 250, content: 'Updated' },
      'zone-1': { type: 'zone', x: 0, y: 0, width: 500, height: 400, label: 'Zone' },
    });
    expect(updated.custom_context).toEqual({ version: 2, newField: 'value' });
  });

  dbTest('should update last_updated timestamp', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData();
    const created = await repo.create(data);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = await repo.update(data.board_id!, { name: 'Updated' });

    expect(new Date(updated.last_updated).getTime()).toBeGreaterThan(
      new Date(created.last_updated).getTime()
    );
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new BoardRepository(db);

    await expect(repo.update('99999999', { name: 'Updated' })).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('should preserve unchanged fields', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({
      name: 'Original Name',
      slug: 'original-slug',
      color: '#1677ff',
      icon: '🚀',
      custom_context: { preserved: true },
    });
    const created = await repo.create(data);

    const updated = await repo.update(data.board_id!, { name: 'New Name' });

    expect(updated.slug).toBe(created.slug);
    expect(updated.color).toBe(created.color);
    expect(updated.icon).toBe(created.icon);
    expect(updated.custom_context).toEqual(created.custom_context);
  });
});

// ============================================================================
// Delete
// ============================================================================

describe('BoardRepository.delete', () => {
  dbTest('should delete board by full UUID', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData();
    await repo.create(data);

    await repo.delete(data.board_id!);

    const found = await repo.findById(data.board_id!);
    expect(found).toBeNull();
  });

  dbTest('should delete board by short ID', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData();
    await repo.create(data);

    const shortId = data.board_id!.replace(/-/g, '').slice(0, 8);
    await repo.delete(shortId);

    const found = await repo.findById(data.board_id!);
    expect(found).toBeNull();
  });

  dbTest('should throw EntityNotFoundError for non-existent ID', async ({ db }) => {
    const repo = new BoardRepository(db);

    await expect(repo.delete('99999999')).rejects.toThrow(EntityNotFoundError);
  });

  dbTest('should not affect other boards', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data1 = createBoardData({ name: 'Board 1', slug: 'board-1' });
    const data2 = createBoardData({ name: 'Board 2', slug: 'board-2' });
    await repo.create(data1);
    await repo.create(data2);

    await repo.delete(data1.board_id!);

    const remaining = await repo.findAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('Board 2');
  });
});

// ============================================================================
// GetDefault
// ============================================================================

describe('BoardRepository.getDefault', () => {
  dbTest('should return existing default board', async ({ db }) => {
    const repo = new BoardRepository(db);
    const defaultBoard = await repo.create(
      createBoardData({ name: 'Main Board', slug: 'default' })
    );

    const found = await repo.getDefault();

    expect(found.board_id).toBe(defaultBoard.board_id);
    expect(found.slug).toBe('default');
  });

  dbTest('should create default board if it does not exist', async ({ db }) => {
    const repo = new BoardRepository(db);

    const defaultBoard = await repo.getDefault();

    expect(defaultBoard.slug).toBe('default');
    expect(defaultBoard.name).toBe('Main Board');
    expect(defaultBoard.description).toBe('Main board for all sessions');
    expect(defaultBoard.color).toBe('#1677ff');
    expect(defaultBoard.icon).toBe('⭐');
  });

  dbTest('should not create duplicate default boards', async ({ db }) => {
    const repo = new BoardRepository(db);

    const first = await repo.getDefault();
    const second = await repo.getDefault();

    expect(first.board_id).toBe(second.board_id);

    const allBoards = await repo.findAll();
    const defaultBoards = allBoards.filter((b) => b.slug === 'default');
    expect(defaultBoards).toHaveLength(1);
  });
});

// ============================================================================
// UpsertBoardObject
// ============================================================================

describe('BoardRepository.upsertBoardObject', () => {
  dbTest('should add new text object to empty board', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(createBoardData());

    const textObject: BoardObject = {
      type: 'text',
      x: 100,
      y: 200,
      content: 'Hello',
    };

    const updated = await repo.upsertBoardObject(board.board_id, 'text-1', textObject);

    expect(updated.objects).toEqual({ 'text-1': textObject });
  });

  dbTest('should add new zone object with trigger', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(createBoardData());

    const zoneObject: BoardObject = {
      type: 'zone',
      x: 0,
      y: 0,
      width: 500,
      height: 400,
      label: 'Bug Fixes',
      trigger: {
        template: 'Fix bug: {{description}}',
        behavior: 'show_picker',
      },
    };

    const updated = await repo.upsertBoardObject(board.board_id, 'zone-1', zoneObject);

    expect(updated.objects).toEqual({ 'zone-1': zoneObject });
  });

  dbTest('should update existing object', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(
      createBoardData({
        objects: {
          'text-1': { type: 'text', x: 100, y: 200, content: 'Original' },
        },
      })
    );

    const updatedObject: BoardObject = {
      type: 'text',
      x: 150,
      y: 250,
      content: 'Updated',
    };

    const updated = await repo.upsertBoardObject(board.board_id, 'text-1', updatedObject);

    expect(updated.objects).toEqual({ 'text-1': updatedObject });
  });

  dbTest('should preserve existing objects when adding new one', async ({ db }) => {
    const repo = new BoardRepository(db);
    const existingText: BoardObject = { type: 'text', x: 100, y: 200, content: 'Existing' };
    const board = await repo.create(
      createBoardData({
        objects: { 'text-1': existingText },
      })
    );

    const newZone: BoardObject = {
      type: 'zone',
      x: 0,
      y: 0,
      width: 500,
      height: 400,
      label: 'New Zone',
    };

    const updated = await repo.upsertBoardObject(board.board_id, 'zone-1', newZone);

    expect(updated.objects).toEqual({
      'text-1': existingText,
      'zone-1': newZone,
    });
  });

  dbTest('should work with short ID', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(createBoardData());

    const shortId = board.board_id.replace(/-/g, '').slice(0, 8);
    const textObject: BoardObject = { type: 'text', x: 100, y: 200, content: 'Test' };

    const updated = await repo.upsertBoardObject(shortId, 'text-1', textObject);

    expect(updated.objects).toEqual({ 'text-1': textObject });
  });

  dbTest('should throw EntityNotFoundError for non-existent board', async ({ db }) => {
    const repo = new BoardRepository(db);
    const textObject: BoardObject = { type: 'text', x: 100, y: 200, content: 'Test' };

    await expect(repo.upsertBoardObject('99999999', 'text-1', textObject)).rejects.toThrow(
      EntityNotFoundError
    );
  });
});

// ============================================================================
// RemoveBoardObject
// ============================================================================

describe('BoardRepository.removeBoardObject', () => {
  dbTest('should remove object from board', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(
      createBoardData({
        objects: {
          'text-1': { type: 'text', x: 100, y: 200, content: 'Test' },
          'zone-1': { type: 'zone', x: 0, y: 0, width: 500, height: 400, label: 'Zone' },
        },
      })
    );

    const updated = await repo.removeBoardObject(board.board_id, 'text-1');

    expect(updated.objects).toEqual({
      'zone-1': { type: 'zone', x: 0, y: 0, width: 500, height: 400, label: 'Zone' },
    });
  });

  dbTest('should handle removing last object', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(
      createBoardData({
        objects: {
          'text-1': { type: 'text', x: 100, y: 200, content: 'Test' },
        },
      })
    );

    const updated = await repo.removeBoardObject(board.board_id, 'text-1');

    expect(updated.objects).toEqual({});
  });

  dbTest('should not error when removing non-existent object', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(
      createBoardData({
        objects: {
          'text-1': { type: 'text', x: 100, y: 200, content: 'Test' },
        },
      })
    );

    const updated = await repo.removeBoardObject(board.board_id, 'non-existent');

    expect(updated.objects).toEqual({
      'text-1': { type: 'text', x: 100, y: 200, content: 'Test' },
    });
  });

  dbTest('should work with short ID', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(
      createBoardData({
        objects: {
          'text-1': { type: 'text', x: 100, y: 200, content: 'Test' },
        },
      })
    );

    const shortId = board.board_id.replace(/-/g, '').slice(0, 8);
    const updated = await repo.removeBoardObject(shortId, 'text-1');

    expect(updated.objects).toEqual({});
  });

  dbTest('should throw EntityNotFoundError for non-existent board', async ({ db }) => {
    const repo = new BoardRepository(db);

    await expect(repo.removeBoardObject('99999999', 'text-1')).rejects.toThrow(EntityNotFoundError);
  });
});

// ============================================================================
// BatchUpsertBoardObjects
// ============================================================================

describe('BoardRepository.batchUpsertBoardObjects', () => {
  dbTest('should add multiple objects at once', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(createBoardData());

    const objects: Record<string, BoardObject> = {
      'text-1': { type: 'text', x: 100, y: 200, content: 'Text 1' },
      'text-2': { type: 'text', x: 200, y: 300, content: 'Text 2' },
      'zone-1': { type: 'zone', x: 0, y: 0, width: 500, height: 400, label: 'Zone' },
    };

    const updated = await repo.batchUpsertBoardObjects(board.board_id, objects);

    expect(updated.objects).toEqual(objects);
  });

  dbTest('should update existing and add new objects', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(
      createBoardData({
        objects: {
          'text-1': { type: 'text', x: 100, y: 200, content: 'Original' },
        },
      })
    );

    const objects: Record<string, BoardObject> = {
      'text-1': { type: 'text', x: 150, y: 250, content: 'Updated' },
      'zone-1': { type: 'zone', x: 0, y: 0, width: 500, height: 400, label: 'New Zone' },
    };

    const updated = await repo.batchUpsertBoardObjects(board.board_id, objects);

    expect(updated.objects).toEqual(objects);
  });

  dbTest('should handle empty objects record', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(
      createBoardData({
        objects: {
          'text-1': { type: 'text', x: 100, y: 200, content: 'Existing' },
        },
      })
    );

    const updated = await repo.batchUpsertBoardObjects(board.board_id, {});

    // Empty batch should not change anything
    expect(updated.objects).toEqual({
      'text-1': { type: 'text', x: 100, y: 200, content: 'Existing' },
    });
  });
});

// ============================================================================
// DeleteZone (Deprecated)
// ============================================================================

describe('BoardRepository.deleteZone', () => {
  dbTest('should remove zone object from board', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(
      createBoardData({
        objects: {
          'zone-1': { type: 'zone', x: 0, y: 0, width: 500, height: 400, label: 'Zone' },
          'text-1': { type: 'text', x: 100, y: 200, content: 'Text' },
        },
      })
    );

    const result = await repo.deleteZone(board.board_id, 'zone-1', false);

    expect(result.board.objects).toEqual({
      'text-1': { type: 'text', x: 100, y: 200, content: 'Text' },
    });
    expect(result.affectedSessions).toEqual([]);
  });

  dbTest('should handle deleteAssociatedSessions parameter', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create(
      createBoardData({
        objects: {
          'zone-1': { type: 'zone', x: 0, y: 0, width: 500, height: 400, label: 'Zone' },
        },
      })
    );

    const result = await repo.deleteZone(board.board_id, 'zone-1', true);

    expect(result.affectedSessions).toEqual([]);
  });
});

// ============================================================================
// Edge Cases and Complex Scenarios
// ============================================================================

describe('BoardRepository edge cases', () => {
  dbTest('should handle special characters in board name', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({ name: 'Test "Board" with \'quotes\' & symbols' });

    const created = await repo.create(data);

    expect(created.name).toBe('Test "Board" with \'quotes\' & symbols');
  });

  dbTest('should handle unicode and emoji in content', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({
      name: '世界 Board 🌍',
      icon: '🚀',
      objects: {
        'text-1': { type: 'text', x: 100, y: 200, content: 'Hello 世界 🌍' },
      },
    });

    const created = await repo.create(data);

    expect(created.name).toBe('世界 Board 🌍');
    expect(created.icon).toBe('🚀');
    expect(created.objects?.['text-1']).toEqual({
      type: 'text',
      x: 100,
      y: 200,
      content: 'Hello 世界 🌍',
    });
  });

  dbTest('should handle deeply nested custom_context', async ({ db }) => {
    const repo = new BoardRepository(db);
    const complexContext = {
      team: {
        name: 'Backend',
        members: ['alice', 'bob'],
        metadata: {
          sprint: 42,
          nested: {
            deeply: {
              value: true,
            },
          },
        },
      },
    };

    const data = createBoardData({ custom_context: complexContext });
    const created = await repo.create(data);

    expect(created.custom_context).toEqual(complexContext);
  });

  dbTest('should handle large number of board objects', async ({ db }) => {
    const repo = new BoardRepository(db);
    const objects: Record<string, BoardObject> = {};

    for (let i = 0; i < 100; i++) {
      objects[`text-${i}`] = {
        type: 'text',
        x: i * 10,
        y: i * 10,
        content: `Text ${i}`,
      };
    }

    const board = await repo.create(createBoardData({ objects }));

    expect(Object.keys(board.objects!)).toHaveLength(100);
    expect(board.objects!['text-50']).toEqual({
      type: 'text',
      x: 500,
      y: 500,
      content: 'Text 50',
    });
  });

  dbTest('should handle zone with all optional fields', async ({ db }) => {
    const repo = new BoardRepository(db);
    const zoneObject: BoardObject = {
      type: 'zone',
      x: 0,
      y: 0,
      width: 500,
      height: 400,
      label: 'Complete Zone',
      color: '#52c41a',
      status: 'active',
      trigger: {
        template: 'Complex {{variable}} with {{multiple}} vars',
        behavior: 'always_new',
      },
    };

    const board = await repo.create(
      createBoardData({
        objects: { 'zone-1': zoneObject },
      })
    );

    expect(board.objects!['zone-1']).toEqual(zoneObject);
  });

  dbTest('should handle text object with all optional fields', async ({ db }) => {
    const repo = new BoardRepository(db);
    const textObject: BoardObject = {
      type: 'text',
      x: 100,
      y: 200,
      width: 300,
      height: 50,
      content: 'Complete Text',
      fontSize: 24,
      color: '#ffffff',
      background: '#1677ff',
    };

    const board = await repo.create(
      createBoardData({
        objects: { 'text-1': textObject },
      })
    );

    expect(board.objects!['text-1']).toEqual(textObject);
  });

  dbTest('should handle empty strings in optional fields', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({
      description: '',
      slug: '',
    });

    const created = await repo.create(data);

    expect(created.description).toBe('');
    expect(created.slug).toBe('');
  });

  dbTest('should handle null slug correctly', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data = createBoardData({ name: 'No Slug Board' });
    delete (data as any).slug;

    const created = await repo.create(data);

    expect(created.slug).toBeUndefined();
  });
});

// ============================================================================
// Slug Uniqueness
// ============================================================================

describe('BoardRepository slug uniqueness', () => {
  dbTest('should enforce unique slugs', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data1 = createBoardData({ slug: 'duplicate-slug' });

    await repo.create(data1);

    const data2 = createBoardData({ slug: 'duplicate-slug' });

    await expect(repo.create(data2)).rejects.toThrow();
  });

  dbTest('should allow same slug after deletion', async ({ db }) => {
    const repo = new BoardRepository(db);
    const data1 = createBoardData({ slug: 'reusable-slug' });

    const created1 = await repo.create(data1);
    await repo.delete(created1.board_id);

    const data2 = createBoardData({ slug: 'reusable-slug' });
    const created2 = await repo.create(data2);

    expect(created2.slug).toBe('reusable-slug');
    expect(created2.board_id).not.toBe(created1.board_id);
  });

  dbTest('should allow null slugs for multiple boards', async ({ db }) => {
    const repo = new BoardRepository(db);

    const board1 = await repo.create(createBoardData({ name: 'Board 1' }));
    const board2 = await repo.create(createBoardData({ name: 'Board 2' }));

    expect(board1.slug).toBeUndefined();
    expect(board2.slug).toBeUndefined();
    expect(board1.board_id).not.toBe(board2.board_id);
  });
});
