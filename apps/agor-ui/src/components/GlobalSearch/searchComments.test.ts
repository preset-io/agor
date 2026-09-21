import type { Board, BoardComment } from '@agor-live/client';
import { describe, expect, it } from 'vitest';
import { searchComments } from './searchComments';

const comment = (id: string, board: string, content: string, updated_at: string) =>
  ({ comment_id: id, board_id: board, content, updated_at }) as unknown as BoardComment;

const boardById = new Map([['board-1', { board_id: 'board-1' } as unknown as Board]]);
const commentById = new Map(
  [
    comment('c-old', 'board-1', 'deploy the fictional service', '2026-01-01T00:00:00Z'),
    comment('c-new', 'board-1', 'Deploy notes', '2026-02-01T00:00:00Z'),
    comment('c-hidden', 'board-2', 'deploy secrets', '2026-03-01T00:00:00Z'),
    comment('c-other', 'board-1', 'unrelated', '2026-03-01T00:00:00Z'),
  ].map((c) => [c.comment_id, c])
);

describe('searchComments', () => {
  it('returns newest-first matches, only from boards the caller can see', () => {
    const ids = searchComments({ query: 'deploy', commentById, boardById, limit: 8 }).map(
      (c) => c.comment_id
    );
    expect(ids).toEqual(['c-new', 'c-old']);
  });

  it('applies the limit and ignores queries below the minimum length', () => {
    expect(searchComments({ query: 'deploy', commentById, boardById, limit: 1 })).toHaveLength(1);
    expect(searchComments({ query: 'd', commentById, boardById, limit: 8 })).toEqual([]);
  });
});
