import { describe, expect, it } from 'vitest';
import { visibleBoardEntityPositions } from './visible-board-entity-positions';

describe('visibleBoardEntityPositions', () => {
  const rows: Record<string, { board_id: string }> = {
    mine: { board_id: 'board-1' },
    'other-board': { board_id: 'board-2' },
  };
  const findVisible = async (objectId: string) => rows[objectId] ?? null;

  it('keeps only entities the caller can see on this board', async () => {
    const allowed = await visibleBoardEntityPositions(
      'board-1',
      {
        mine: { x: 1, y: 2 },
        'other-board': { x: 3, y: 4 },
        hidden: { x: 5, y: 6 },
      },
      findVisible
    );
    expect(allowed).toEqual({ mine: { x: 1, y: 2 } });
  });

  it('drops everything when nothing is visible on the board', async () => {
    expect(
      await visibleBoardEntityPositions('board-9', { mine: { x: 1, y: 2 } }, findVisible)
    ).toEqual({});
  });
});
