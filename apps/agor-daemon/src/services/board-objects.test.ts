import type { Database } from '@agor/core/db';
import type { BoardEntityObject, BoardID, UUID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { BoardObjectsService } from './board-objects.js';

describe('BoardObjectsService.find', () => {
  it('filters board entities by zone/type and applies explicit pagination', async () => {
    const service = new BoardObjectsService({} as Database);
    const count = vi.fn(async () => 2);
    const findAll = vi.fn(async () => [
      {
        object_id: 'obj-4',
        board_id: 'board-1',
        branch_id: 'branch-3',
        entity_type: 'branch',
        position: { x: 30, y: 30 },
        zone_id: 'zone-review',
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ]);

    (
      service as unknown as {
        boardObjectRepo: {
          count: typeof count;
          findAll: typeof findAll;
        };
      }
    ).boardObjectRepo = { count, findAll };

    const result = await service.find({
      query: {
        board_id: 'board-1' as BoardID,
        zone_id: 'zone-review',
        entity_type: 'branch',
        $skip: 1,
        $limit: 1,
      },
    });

    expect(count).toHaveBeenCalledWith({
      board_id: 'board-1',
      zone_id: 'zone-review',
      entity_type: 'branch',
    });
    expect(findAll).toHaveBeenCalledWith(
      {
        board_id: 'board-1',
        zone_id: 'zone-review',
        entity_type: 'branch',
      },
      { offset: 1, limit: 1 }
    );
    expect(result.total).toBe(2);
    expect(result.skip).toBe(1);
    expect(result.limit).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].object_id).toBe('obj-4');
  });

  it('preserves legacy unpaginated data when no $limit/$skip is requested', async () => {
    const service = new BoardObjectsService({} as Database);
    const count = vi.fn(async () => 2);
    const findAll = vi.fn(async () => [
      {
        object_id: 'obj-1',
        board_id: 'board-1',
        branch_id: 'branch-1',
        entity_type: 'branch',
        position: { x: 0, y: 0 },
        created_at: '2026-06-01T00:00:00.000Z',
      },
      {
        object_id: 'obj-2',
        board_id: 'board-2',
        branch_id: 'branch-2',
        entity_type: 'branch',
        position: { x: 10, y: 10 },
        created_at: '2026-06-01T00:00:00.000Z',
      },
    ]);

    (
      service as unknown as {
        boardObjectRepo: {
          count: typeof count;
          findAll: typeof findAll;
        };
      }
    ).boardObjectRepo = { count, findAll };

    const result = await service.find();

    expect(count).toHaveBeenCalledWith({});
    expect(findAll).toHaveBeenCalledWith({}, {});
    expect(result.total).toBe(2);
    expect(result.limit).toBe(100);
    expect(result.skip).toBe(0);
    expect(result.data).toHaveLength(2);
  });
});

describe('BoardObjectsService.get', () => {
  const object = {
    object_id: 'obj-1',
    board_id: 'board-1',
    branch_id: 'branch-1',
    entity_type: 'branch',
    position: { x: 0, y: 0 },
    created_at: '2026-06-01T00:00:00.000Z',
  } as BoardEntityObject;

  it('uses the shared visibility-aware repository path for an RBAC-scoped read', async () => {
    const service = new BoardObjectsService({} as Database);
    const findVisibleByObjectId = vi.fn(async () => object);
    const findByObjectId = vi.fn(async () => object);
    (
      service as unknown as {
        boardObjectRepo: {
          findVisibleByObjectId: typeof findVisibleByObjectId;
          findByObjectId: typeof findByObjectId;
        };
      }
    ).boardObjectRepo = { findVisibleByObjectId, findByObjectId };

    await expect(
      service.get('obj-1', {
        _agorSqlBoardAccessUserId: '00000000-0000-7000-8000-0000000000ff' as UUID,
      })
    ).resolves.toBe(object);
    expect(findVisibleByObjectId).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-0000000000ff',
      'obj-1'
    );
    expect(findByObjectId).not.toHaveBeenCalled();
  });

  it('retains the unscoped path for trusted internal and RBAC-disabled reads', async () => {
    const service = new BoardObjectsService({} as Database);
    const findVisibleByObjectId = vi.fn(async () => object);
    const findByObjectId = vi.fn(async () => object);
    (
      service as unknown as {
        boardObjectRepo: {
          findVisibleByObjectId: typeof findVisibleByObjectId;
          findByObjectId: typeof findByObjectId;
        };
      }
    ).boardObjectRepo = { findVisibleByObjectId, findByObjectId };

    await expect(service.get('obj-1')).resolves.toBe(object);
    expect(findByObjectId).toHaveBeenCalledWith('obj-1');
    expect(findVisibleByObjectId).not.toHaveBeenCalled();
  });
});
