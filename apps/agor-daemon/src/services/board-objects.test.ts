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

describe('BoardObjectsService.patch', () => {
  it.each([
    { x: Number.NaN, y: 100 },
    { x: 100, y: Number.POSITIVE_INFINITY },
  ])('rejects invalid position $x x $y before persistence', async (position) => {
    const service = new BoardObjectsService({} as Database);

    await expect(service.patch('object-1', { position })).rejects.toThrow(
      'position x and y must be finite numbers'
    );
  });

  it('persists a valid measured size through the repository boundary', async () => {
    const service = new BoardObjectsService({} as Database);
    const updateSize = vi.fn(async (_id, size) => ({ object_id: 'object-1', size }));
    (
      service as unknown as {
        boardObjectRepo: { updateSize: typeof updateSize };
      }
    ).boardObjectRepo = { updateSize };

    await expect(
      service.patch('object-1', { size: { width: 486, height: 237 } })
    ).resolves.toMatchObject({ size: { width: 486, height: 237 } });
    expect(updateSize).toHaveBeenCalledWith('object-1', { width: 486, height: 237 });
  });

  it.each([
    { width: 0, height: 100 },
    { width: 100, height: -1 },
    { width: Number.NaN, height: 100 },
    { width: 100, height: Number.POSITIVE_INFINITY },
  ])('rejects invalid measured size $width x $height', async (size) => {
    const service = new BoardObjectsService({} as Database);

    await expect(service.patch('object-1', { size })).rejects.toThrow(
      'size width and height must be positive finite numbers'
    );
  });

  it('persists position, size, and compact state as one layout update', async () => {
    const service = new BoardObjectsService({} as Database);
    const updateLayout = vi.fn(async (_id, layout) => ({ object_id: 'object-1', ...layout }));
    const findByObjectId = vi.fn(async () => ({
      object_id: 'object-1',
      entity_type: 'branch' as const,
    }));
    (
      service as unknown as {
        boardObjectRepo: {
          findByObjectId: typeof findByObjectId;
          updateLayout: typeof updateLayout;
        };
      }
    ).boardObjectRepo = { findByObjectId, updateLayout };

    await expect(
      service.patch('object-1', {
        size: { width: 486, height: 237 },
        position: { x: 20, y: 30 },
        compact: true,
      })
    ).resolves.toMatchObject({
      position: { x: 20, y: 30 },
      size: { width: 486, height: 237 },
      compact: true,
    });
    expect(updateLayout).toHaveBeenCalledTimes(1);
    expect(updateLayout).toHaveBeenCalledWith('object-1', {
      position: { x: 20, y: 30 },
      size: { width: 486, height: 237 },
      compact: true,
    });
  });

  it('accepts compact state for a generic card with rendered body content', async () => {
    const service = new BoardObjectsService({} as Database);
    const findByObjectId = vi.fn(async () => ({
      object_id: 'card-placement',
      board_id: 'board-1',
      card_id: 'card-1',
      entity_type: 'card' as const,
    }));
    const updateCompact = vi.fn(async () => ({
      object_id: 'card-placement',
      board_id: 'board-1',
      card_id: 'card-1',
      entity_type: 'card' as const,
      compact: true,
    }));
    const findById = vi.fn(async () => ({
      card_id: 'card-1',
      board_id: 'board-1',
      title: 'Fictional card',
      description: 'Rendered details',
    }));
    (
      service as unknown as {
        boardObjectRepo: {
          findByObjectId: typeof findByObjectId;
          updateCompact: typeof updateCompact;
        };
        cardRepo: { findById: typeof findById };
      }
    ).boardObjectRepo = { findByObjectId, updateCompact };
    (service as unknown as { cardRepo: { findById: typeof findById } }).cardRepo = { findById };

    await expect(service.patch('card-placement', { compact: true })).resolves.toMatchObject({
      compact: true,
    });
    expect(updateCompact).toHaveBeenCalledWith('card-placement', true);
  });

  it('rejects compact state for a header-only generic card before persistence', async () => {
    const service = new BoardObjectsService({} as Database);
    const findByObjectId = vi.fn(async () => ({
      object_id: 'card-placement',
      board_id: 'board-1',
      card_id: 'card-1',
      entity_type: 'card' as const,
    }));
    const updateCompact = vi.fn();
    const findById = vi.fn(async () => ({
      card_id: 'card-1',
      board_id: 'board-1',
      title: 'Header only',
    }));
    (service as unknown as { boardObjectRepo: unknown }).boardObjectRepo = {
      findByObjectId,
      updateCompact,
    };
    (service as unknown as { cardRepo: unknown }).cardRepo = { findById };

    await expect(service.patch('card-placement', { compact: true })).rejects.toThrow(
      'worktrees and generic cards with body content'
    );
    expect(updateCompact).not.toHaveBeenCalled();
  });

  it('fails closed when the card body is outside the scoped board/tenant read', async () => {
    const service = new BoardObjectsService({} as Database);
    const findByObjectId = vi.fn(async () => ({
      object_id: 'card-placement',
      board_id: 'board-tenant-a',
      card_id: 'card-tenant-b',
      entity_type: 'card' as const,
    }));
    const updateCompact = vi.fn();
    const findById = vi.fn(async () => null);
    (service as unknown as { boardObjectRepo: unknown }).boardObjectRepo = {
      findByObjectId,
      updateCompact,
    };
    (service as unknown as { cardRepo: unknown }).cardRepo = { findById };

    await expect(service.patch('card-placement', { compact: true })).rejects.toThrow(
      'worktrees and generic cards with body content'
    );
    expect(findById).toHaveBeenCalledWith('card-tenant-b');
    expect(updateCompact).not.toHaveBeenCalled();
  });

  it('returns the authoritative row without writing a repeated density state', async () => {
    const service = new BoardObjectsService({} as Database);
    const existing = {
      object_id: 'branch-placement',
      entity_type: 'branch' as const,
      compact: true,
      size: { width: 500, height: 64 },
    };
    const findByObjectId = vi.fn(async () => existing);
    const updateCompact = vi.fn();
    (service as unknown as { boardObjectRepo: unknown }).boardObjectRepo = {
      findByObjectId,
      updateCompact,
    };

    await expect(service.patch('branch-placement', { compact: true })).resolves.toBe(existing);
    expect(updateCompact).not.toHaveBeenCalled();
  });

  it('uses the tenant-visible read boundary for compact capability checks', async () => {
    const service = new BoardObjectsService({} as Database);
    const visibleBranch = { object_id: 'branch-placement', entity_type: 'branch' as const };
    const findVisibleByObjectId = vi.fn(async () => visibleBranch);
    const findByObjectId = vi.fn();
    const updateCompact = vi.fn(async () => ({ ...visibleBranch, compact: true }));
    (
      service as unknown as {
        boardObjectRepo: {
          findVisibleByObjectId: typeof findVisibleByObjectId;
          findByObjectId: typeof findByObjectId;
          updateCompact: typeof updateCompact;
        };
      }
    ).boardObjectRepo = { findVisibleByObjectId, findByObjectId, updateCompact };

    await expect(
      service.patch('branch-placement', { compact: true }, {
        _agorSqlBoardAccessUserId: 'user-a',
      } as never)
    ).resolves.toMatchObject({ compact: true });
    expect(findVisibleByObjectId).toHaveBeenCalledWith('user-a', 'branch-placement');
    expect(findByObjectId).not.toHaveBeenCalled();
    expect(updateCompact).toHaveBeenCalledWith('branch-placement', true);
  });
});
