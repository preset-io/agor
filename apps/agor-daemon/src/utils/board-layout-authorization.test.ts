import type { BoardEntityObject, HookContext } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeBoardLayoutPlacements,
  boardLayoutPlacementIds,
} from './board-layout-authorization';

const BOARD_ID = '00000000-0000-7000-8000-000000000001';
const USER_ID = '00000000-0000-7000-8000-000000000002';

const context = (role = 'member', provider: string | null = 'socketio') =>
  ({
    path: 'boards',
    method: 'patch',
    id: '00000000',
    params: { provider: provider ?? undefined, user: { user_id: USER_ID, role } },
  }) as unknown as HookContext;

function repositories(visibleIds: string[]) {
  return {
    boardRepository: { findBySlugOrId: vi.fn().mockResolvedValue({ board_id: BOARD_ID }) },
    boardObjectsRepository: {
      findVisibleToUser: vi
        .fn()
        .mockResolvedValue(
          visibleIds.map((object_id) => ({ object_id }) as unknown as BoardEntityObject)
        ),
    },
  };
}

describe('boardLayoutPlacementIds', () => {
  it('covers written and expected placements once each', () => {
    expect(
      boardLayoutPlacementIds({
        placements: { a: { position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } },
        expected: { objects: {}, placements: { a: { position: { x: 0, y: 0 } } } },
      }).sort()
    ).toEqual(['a']);
    expect(
      boardLayoutPlacementIds({
        placements: {},
        expected: { objects: {}, placements: { hidden: { position: { x: 0, y: 0 } } } },
      })
    ).toEqual(['hidden']);
  });
});

describe('authorizeBoardLayoutPlacements', () => {
  it('admits a board editor whose every placement is visible on the canonical board', async () => {
    const repos = repositories(['visible-a', 'visible-b']);

    await authorizeBoardLayoutPlacements(repos, context(), '00000000', ['visible-a', 'visible-b']);

    expect(repos.boardRepository.findBySlugOrId).toHaveBeenCalledWith('00000000');
    expect(repos.boardObjectsRepository.findVisibleToUser).toHaveBeenCalledWith(USER_ID, {
      board_id: BOARD_ID,
    });
  });

  it('rejects a layout that moves a placement of a branch the editor cannot view', async () => {
    const repos = repositories(['visible-a']);

    await expect(
      authorizeBoardLayoutPlacements(repos, context(), '00000000', ['visible-a', 'hidden-branch'])
    ).rejects.toMatchObject({
      name: 'Forbidden',
      message: 'Board resource is unavailable to update board objects',
    });
  });

  it('denies every placement when the board cannot be resolved', async () => {
    const repos = repositories(['visible-a']);
    repos.boardRepository.findBySlugOrId.mockResolvedValue(null);

    await expect(
      authorizeBoardLayoutPlacements(repos, context(), '00000000', ['visible-a'])
    ).rejects.toMatchObject({ name: 'Forbidden' });
  });

  it.each([
    ['admins', context('admin')],
    ['internal calls', context('member', null)],
  ])('does not apply user visibility to %s', async (_name, hookContext) => {
    const repos = repositories([]);

    await authorizeBoardLayoutPlacements(repos, hookContext, '00000000', ['any']);

    expect(repos.boardObjectsRepository.findVisibleToUser).not.toHaveBeenCalled();
  });

  it('skips the visibility read for a canvas-only batch', async () => {
    const repos = repositories([]);

    await authorizeBoardLayoutPlacements(repos, context(), '00000000', []);

    expect(repos.boardObjectsRepository.findVisibleToUser).not.toHaveBeenCalled();
  });
});
