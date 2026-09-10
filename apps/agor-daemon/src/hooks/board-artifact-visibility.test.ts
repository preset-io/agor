import { type ArtifactRepository, attachHiddenTenant, getHiddenTenantId } from '@agor/core/db';
import type { ArtifactID, Board, BoardObject, HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { filterBoardArtifactObjects } from './board-artifact-visibility.js';

const artifact = (id: string): BoardObject => ({
  type: 'artifact',
  artifact_id: id as ArtifactID,
  x: 11,
  y: 22,
  width: 600,
  height: 400,
});
const note: BoardObject = { type: 'text', content: 'keep', x: 0, y: 0 };
const board = (objects: Board['objects']) => ({ objects, name: 'unchanged' }) as Board;
const context = (method: 'get' | 'find', result: unknown) =>
  ({
    method,
    result,
    params: { user: { user_id: 'viewer' } },
  }) as HookContext<Board>;

describe('board artifact visibility after hooks', () => {
  it.each(['get', 'find'] as const)(
    'preserves %s no-op identity and hidden tenant metadata',
    async (method) => {
      const findBoardReferenceVisibleIds = vi
        .fn<ArtifactRepository['findBoardReferenceVisibleIds']>()
        .mockResolvedValue(new Set(['visible']));
      const hook = filterBoardArtifactObjects({ findBoardReferenceVisibleIds });
      const variants: Board['objects'][] = [undefined, {}, { note }, { ref: artifact('visible') }];
      for (const objects of variants) {
        const original = attachHiddenTenant(board(objects), { tenant_id: 'tenant-a' });
        const ctx = context(method, method === 'get' ? original : [original]);
        await hook(ctx);
        if (method === 'get') expect(ctx.result).toBe(original);
        expect(original.objects).toBe(objects);
        expect(getHiddenTenantId(original)).toBe('tenant-a');
        expect(Object.keys(original)).not.toContain('tenant_id');
      }
    }
  );

  it('retains hidden tenant metadata when get replaces a filtered board', async () => {
    const findBoardReferenceVisibleIds = vi
      .fn<ArtifactRepository['findBoardReferenceVisibleIds']>()
      .mockResolvedValue(new Set());
    const original = attachHiddenTenant(board({ hidden: artifact('private'), note }), {
      tenant_id: 'tenant-a',
    });
    const ctx = context('get', original);
    await filterBoardArtifactObjects({ findBoardReferenceVisibleIds })(ctx);
    expect(ctx.result).not.toBe(original);
    expect(ctx.result!.objects).toEqual({ note });
    expect(original.objects!.hidden).toBeDefined();
    expect(getHiddenTenantId(ctx.result)).toBe('tenant-a');
    expect(Object.keys(ctx.result!)).not.toContain('tenant_id');
  });

  it.each(['array', 'paginated', 'get'] as const)(
    'batches %s results without changing keys, order or pagination',
    async (shape) => {
      const findBoardReferenceVisibleIds = vi
        .fn<ArtifactRepository['findBoardReferenceVisibleIds']>()
        .mockResolvedValue(new Set(['public', 'own-short']));
      const objects = {
        first: artifact('public'),
        hidden: artifact('private'),
        duplicate: artifact('public'),
        own: artifact('own-short'),
        missing: artifact('missing'),
        note,
        placeholder: artifact(''),
      };
      const boards = [board(objects), board({ repeated: artifact('public') })];
      const result =
        shape === 'get'
          ? boards[0]
          : shape === 'array'
            ? boards
            : { data: boards, total: 42, limit: 2, skip: 4 };
      const ctx = context(shape === 'get' ? 'get' : 'find', result);
      await filterBoardArtifactObjects({ findBoardReferenceVisibleIds })(ctx);
      expect(findBoardReferenceVisibleIds).toHaveBeenCalledExactlyOnceWith(
        ['public', 'private', 'own-short', 'missing'],
        'viewer'
      );
      const filtered = shape === 'get' ? ctx.result : boards[0];
      expect(Object.keys(filtered!.objects!)).toEqual([
        'first',
        'duplicate',
        'own',
        'note',
        'placeholder',
      ]);
      expect(filtered!.objects!.first).toBe(objects.first);
      expect(filtered!.name).toBe('unchanged');
      if (shape === 'paginated')
        expect(result).toMatchObject({ total: 42, limit: 2, skip: 4, data: boards });
      if (shape !== 'get') expect(ctx.result).toBe(result);
    }
  );

  it('fails closed on a read error without removing other object types', async () => {
    const findBoardReferenceVisibleIds = vi
      .fn<ArtifactRepository['findBoardReferenceVisibleIds']>()
      .mockRejectedValue(new Error('database unavailable'));
    const ctx = context('get', board({ hidden: artifact('private'), note }));
    await filterBoardArtifactObjects({ findBoardReferenceVisibleIds })(ctx);
    expect(Object.keys(ctx.result!.objects!)).toEqual(['note']);
  });

  it('does no lookup for an empty page or non-artifact objects and never caches across requests', async () => {
    const findBoardReferenceVisibleIds = vi
      .fn<ArtifactRepository['findBoardReferenceVisibleIds']>()
      .mockResolvedValueOnce(new Set(['id']))
      .mockResolvedValueOnce(new Set());
    const hook = filterBoardArtifactObjects({ findBoardReferenceVisibleIds });
    await hook(context('find', { data: [], total: 0 }));
    await hook(context('get', board({ note })));
    expect(findBoardReferenceVisibleIds).not.toHaveBeenCalled();
    await hook(context('get', board({ ref: artifact('id') })));
    const second = context('get', board({ ref: artifact('id') }));
    await hook(second);
    expect(second.result!.objects).toEqual({});
    expect(findBoardReferenceVisibleIds).toHaveBeenCalledTimes(2);
  });
});
