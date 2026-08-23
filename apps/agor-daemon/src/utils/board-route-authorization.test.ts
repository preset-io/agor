import { AmbiguousIdError, type BoardRepository } from '@agor/core/db';
import type { Board, HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { requireAuthorizedBoardRoute } from './board-route-authorization';

const BOARD_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';
const board = { board_id: BOARD_ID } as Board;

const context = (role = 'member') =>
  ({
    path: 'boards/:id/owners',
    method: 'find',
    params: {
      provider: 'rest',
      route: { id: '00000000' },
      user: { user_id: USER_ID, role },
    },
  }) as unknown as HookContext;

describe('requireAuthorizedBoardRoute', () => {
  it('resolves short IDs inside visibility and canonicalizes the authorized route', async () => {
    const repository = {
      findVisibleById: vi.fn().mockResolvedValue(board),
      canMutate: vi.fn(),
    } as unknown as BoardRepository;
    const hook = requireAuthorizedBoardRoute(repository, 'view', 'view board owners');
    const hookContext = context();

    await hook(hookContext);

    expect(repository.findVisibleById).toHaveBeenCalledWith(USER_ID, '00000000');
    expect(hookContext.params.route?.id).toBe(BOARD_ID);
    expect(repository.canMutate).not.toHaveBeenCalled();
  });

  it('checks mutation authority only against the canonical visible board ID', async () => {
    const repository = {
      findVisibleById: vi.fn().mockResolvedValue(board),
      canMutate: vi.fn().mockResolvedValue(true),
    } as unknown as BoardRepository;
    const hook = requireAuthorizedBoardRoute(repository, 'mutate', 'manage board owners');
    const hookContext = context();

    await hook(hookContext);

    expect(repository.canMutate).toHaveBeenCalledWith(BOARD_ID, USER_ID);
    expect(hookContext.params.route?.id).toBe(BOARD_ID);
  });

  it.each([
    ['hidden or missing rows', null],
    [
      'visibility-scoped short-ID failures',
      new AmbiguousIdError('Board', '00000000', [BOARD_ID, `${BOARD_ID.slice(0, -1)}3`]),
    ],
  ])('gives %s the same non-enumerating denial', async (_name, result) => {
    const findVisibleById =
      result instanceof Error
        ? vi.fn().mockRejectedValue(result)
        : vi.fn().mockResolvedValue(result);
    const repository = { findVisibleById } as unknown as BoardRepository;

    await expect(
      requireAuthorizedBoardRoute(repository, 'view', 'view board owners')(context())
    ).rejects.toMatchObject({
      name: 'Forbidden',
      message: 'Board resource is unavailable to view board owners',
      code: 403,
    });
  });

  it('does not disguise unexpected repository failures as authorization denials', async () => {
    const repository = {
      findVisibleById: vi.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as BoardRepository;

    await expect(
      requireAuthorizedBoardRoute(repository, 'view', 'view board owners')(context())
    ).rejects.toThrow('database unavailable');
  });

  it('resolves admin routes in tenant scope without applying user visibility', async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue(board),
      findVisibleById: vi.fn(),
      canMutate: vi.fn(),
    } as unknown as BoardRepository;
    const hookContext = context('admin');

    await requireAuthorizedBoardRoute(repository, 'mutate', 'manage board owners')(hookContext);

    expect(repository.findById).toHaveBeenCalledWith('00000000');
    expect(repository.findVisibleById).not.toHaveBeenCalled();
    expect(repository.canMutate).not.toHaveBeenCalled();
    expect(hookContext.params.route?.id).toBe(BOARD_ID);
  });
});
