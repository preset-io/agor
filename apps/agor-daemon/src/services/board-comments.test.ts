import { Forbidden } from '@agor/core/feathers';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationAuthorization } from '../utils/collaboration-authorization.js';
import { BoardCommentsService } from './board-comments.js';

function rejectingAuthorization() {
  const requireCommentAttachments = vi.fn(async (): Promise<boolean> => {
    throw new Forbidden('Attached resource does not belong to this board');
  });
  const authorization = {
    requireBoard: vi.fn(async () => undefined),
    requireCommentAttachments,
  } as unknown as CollaborationAuthorization;
  return { authorization, requireCommentAttachments };
}

describe('BoardCommentsService attachment boundary', () => {
  const params = {
    provider: 'rest',
    user: { user_id: 'user-a', role: 'member' },
  } as never;

  it('rejects creation when an attachment does not belong to the selected board', async () => {
    const { authorization } = rejectingAuthorization();
    const service = new BoardCommentsService({} as never, authorization);

    await expect(
      service.create(
        { board_id: 'board-a' as never, branch_id: 'branch-b' as never, content: 'nope' },
        params
      )
    ).rejects.toBeInstanceOf(Forbidden);
  });

  it('rejects the whole bulk request before writing when any attachment is invalid', async () => {
    const { authorization, requireCommentAttachments } = rejectingAuthorization();
    requireCommentAttachments
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Forbidden('Attached resource does not belong to this board'));
    const service = new BoardCommentsService({} as never, authorization);

    await expect(
      service.bulkCreate(
        [
          { board_id: 'board-a' as never, content: 'first' },
          { board_id: 'board-a' as never, branch_id: 'branch-b' as never, content: 'second' },
        ],
        params
      )
    ).rejects.toBeInstanceOf(Forbidden);
  });
});
