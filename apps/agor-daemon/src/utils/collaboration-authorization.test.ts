import { BoardRepository, BranchRepository } from '@agor/core/db';
import { Forbidden } from '@agor/core/feathers';
import { ROLES } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationAuthorization } from './collaboration-authorization.js';

describe('CollaborationAuthorization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('denies a different user at the shared service boundary', async () => {
    vi.spyOn(BoardRepository.prototype, 'canView').mockResolvedValue(false);
    const authorization = new CollaborationAuthorization({} as never, true);

    await expect(
      authorization.requireBoard(
        { provider: 'rest', user: { user_id: 'tenant-user-b', role: ROLES.MEMBER } as never },
        'private-board-a',
        'view'
      )
    ).rejects.toBeInstanceOf(Forbidden);
  });

  it('uses the current actor for mutate decisions and honors revocation', async () => {
    const canMutate = vi
      .spyOn(BoardRepository.prototype, 'canMutate')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const authorization = new CollaborationAuthorization({} as never, true);
    const params = {
      provider: 'socketio',
      user: { user_id: 'user-a', role: ROLES.MEMBER } as never,
    };

    await authorization.requireBoard(params, 'board-a', 'mutate');
    await expect(authorization.requireBoard(params, 'board-a', 'mutate')).rejects.toBeInstanceOf(
      Forbidden
    );
    expect(canMutate).toHaveBeenCalledTimes(2);
    expect(canMutate).toHaveBeenLastCalledWith('board-a', 'user-a');
  });

  it('rejects an attachment whose branch belongs to another board', async () => {
    vi.spyOn(BranchRepository.prototype, 'findById').mockResolvedValue({
      branch_id: 'branch-b',
      board_id: 'board-b',
    } as never);
    const authorization = new CollaborationAuthorization({} as never, true);

    await expect(
      authorization.requireCommentAttachments(
        { provider: 'mcp', user: { user_id: 'user-a', role: ROLES.MEMBER } as never },
        { boardId: 'board-a', branchId: 'branch-b' }
      )
    ).rejects.toBeInstanceOf(Forbidden);
  });
});
