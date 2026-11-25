import {
  AmbiguousIdError,
  type BoardRepository,
  EntityNotFoundError,
  RepositoryError,
} from '@agor/core/db';
import type { Board, HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  isCallerBoardAdmin,
  isWorkspaceAdminOnBoard,
  requireAuthorizedBoardRoute,
} from './board-route-authorization';

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

describe('isCallerBoardAdmin', () => {
  it('returns false on normal authorization denial without throwing', async () => {
    const repository = {
      canManage: vi.fn().mockResolvedValue(false),
      findById: vi.fn(),
    };
    const user = { user_id: USER_ID, role: 'member' };

    await expect(isCallerBoardAdmin(repository, user, BOARD_ID)).resolves.toBe(false);
    expect(repository.canManage).toHaveBeenCalledWith(BOARD_ID, USER_ID);
  });

  it('returns true on successful authorization', async () => {
    const repository = {
      canManage: vi.fn().mockResolvedValue(true),
      findById: vi.fn(),
    };
    const user = { user_id: USER_ID, role: 'member' };

    await expect(isCallerBoardAdmin(repository, user, BOARD_ID)).resolves.toBe(true);
    expect(repository.canManage).toHaveBeenCalledWith(BOARD_ID, USER_ID);
  });

  it('propagates unexpected repository failures without converting them to false', async () => {
    const repository = {
      canManage: vi.fn().mockRejectedValue(new RepositoryError('connection pool exhausted')),
      findById: vi.fn(),
    };
    const user = { user_id: USER_ID, role: 'member' };

    await expect(isCallerBoardAdmin(repository, user, BOARD_ID)).rejects.toThrow(
      'connection pool exhausted'
    );
  });

  it('returns false when the board is not found according to EntityNotFoundError convention', async () => {
    const repository = {
      canManage: vi.fn().mockRejectedValue(new EntityNotFoundError('Board', BOARD_ID)),
      findById: vi.fn(),
    };
    const user = { user_id: USER_ID, role: 'member' };

    await expect(isCallerBoardAdmin(repository, user, BOARD_ID)).resolves.toBe(false);
  });

  it('resolves workspace ADMIN and service accounts within tenant scope', async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue(board),
      canManage: vi.fn(),
    };
    const adminUser = { user_id: USER_ID, role: 'admin' };
    const serviceAccount = { user_id: USER_ID, role: 'member', _isServiceAccount: true };
    const serviceAccountWithoutUserId = { role: 'service', _isServiceAccount: true };

    await expect(isCallerBoardAdmin(repository, adminUser, BOARD_ID)).resolves.toBe(true);
    expect(repository.findById).toHaveBeenCalledWith(BOARD_ID);
    expect(repository.canManage).not.toHaveBeenCalled();

    await expect(isCallerBoardAdmin(repository, serviceAccount, BOARD_ID)).resolves.toBe(true);
    await expect(
      isCallerBoardAdmin(repository, serviceAccountWithoutUserId, BOARD_ID)
    ).resolves.toBe(true);
  });

  it('distinguishes tenant-scoped workspace ADMIN from member Board Managers in isWorkspaceAdminOnBoard', async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue(board),
      canManage: vi.fn().mockResolvedValue(true),
    };

    await expect(
      isWorkspaceAdminOnBoard(repository, { user_id: USER_ID, role: 'admin' }, BOARD_ID)
    ).resolves.toBe(true);
    await expect(
      isWorkspaceAdminOnBoard(repository, { role: 'service', _isServiceAccount: true }, BOARD_ID)
    ).resolves.toBe(true);
    await expect(
      isWorkspaceAdminOnBoard(repository, { user_id: USER_ID, role: 'member' }, BOARD_ID)
    ).resolves.toBe(false);
    await expect(
      isWorkspaceAdminOnBoard(repository, { user_id: USER_ID, role: 'viewer' }, BOARD_ID)
    ).resolves.toBe(false);
    expect(repository.canManage).not.toHaveBeenCalled();
  });

  it('returns false for workspace ADMIN when board does not resolve in tenant scope', async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue(null),
      canManage: vi.fn(),
    };
    const adminUser = { user_id: USER_ID, role: 'admin' };

    await expect(isCallerBoardAdmin(repository, adminUser, BOARD_ID)).resolves.toBe(false);
  });

  it('propagates unexpected repository failures during workspace ADMIN lookup', async () => {
    const repository = {
      findById: vi.fn().mockRejectedValue(new RepositoryError('database connectivity failure')),
      canManage: vi.fn(),
    };
    const adminUser = { user_id: USER_ID, role: 'admin' };

    await expect(isCallerBoardAdmin(repository, adminUser, BOARD_ID)).rejects.toThrow(
      'database connectivity failure'
    );
  });

  it('returns false for callers below the workspace member role floor', async () => {
    const repository = {
      canManage: vi.fn(),
      findById: vi.fn(),
    };
    const viewerUser = { user_id: USER_ID, role: 'viewer' };

    await expect(isCallerBoardAdmin(repository, viewerUser, BOARD_ID)).resolves.toBe(false);
    expect(repository.canManage).not.toHaveBeenCalled();
    expect(repository.findById).not.toHaveBeenCalled();
  });

  it('returns false when user or boardId is missing', async () => {
    const repository = {
      canManage: vi.fn(),
      findById: vi.fn(),
    };

    expect(await isCallerBoardAdmin(repository, undefined, BOARD_ID)).toBe(false);
    expect(
      await isCallerBoardAdmin(repository, { user_id: USER_ID, role: 'member' }, undefined)
    ).toBe(false);
  });
});
