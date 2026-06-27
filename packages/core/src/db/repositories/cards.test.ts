/**
 * CardRepository Tests
 *
 * Focused on the find filters that back the SQL pushdown on CardsService.find.
 */

import type { BoardID } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { dbTest } from '../test-helpers';
import { BoardRepository } from './boards';
import { CardRepository } from './cards';

async function createBoard(db: Database): Promise<BoardID> {
  const board = await new BoardRepository(db).create({
    board_id: generateId(),
    name: `Board ${generateId()}`,
    created_by: 'test-user',
  });
  return board.board_id as BoardID;
}

describe('CardRepository.findAll', () => {
  dbTest('returns all cards unfiltered', async ({ db }) => {
    const repo = new CardRepository(db);
    const board = await createBoard(db);

    await repo.create({ board_id: board, title: 'a' });
    await repo.create({ board_id: board, title: 'b' });

    const cards = await repo.findAll();
    expect(cards.map((c) => c.title).sort()).toEqual(['a', 'b']);
  });

  dbTest('filters by board_id', async ({ db }) => {
    const repo = new CardRepository(db);
    const boardA = await createBoard(db);
    const boardB = await createBoard(db);

    await repo.create({ board_id: boardA, title: 'a1' });
    await repo.create({ board_id: boardA, title: 'a2' });
    await repo.create({ board_id: boardB, title: 'b1' });

    const onBoardA = await repo.findAll({ board_id: boardA });
    expect(onBoardA.map((c) => c.title).sort()).toEqual(['a1', 'a2']);
    expect(onBoardA.every((c) => c.board_id === boardA)).toBe(true);
  });

  dbTest('filters by exact archived state', async ({ db }) => {
    const repo = new CardRepository(db);
    const board = await createBoard(db);

    const active = await repo.create({ board_id: board, title: 'active' });
    const archived = await repo.create({ board_id: board, title: 'archived' });
    await repo.archive(archived.card_id);

    const activeOnly = await repo.findAll({ archived: false });
    expect(activeOnly.map((c) => c.card_id)).toEqual([active.card_id]);

    const archivedOnly = await repo.findAll({ archived: true });
    expect(archivedOnly.map((c) => c.card_id)).toEqual([archived.card_id]);
  });

  dbTest('combines board_id and archived', async ({ db }) => {
    const repo = new CardRepository(db);
    const boardA = await createBoard(db);
    const boardB = await createBoard(db);

    await repo.create({ board_id: boardA, title: 'a-active' });
    const aArchived = await repo.create({ board_id: boardA, title: 'a-archived' });
    await repo.archive(aArchived.card_id);
    await repo.create({ board_id: boardB, title: 'b-active' });

    const result = await repo.findAll({ board_id: boardA, archived: false });
    expect(result.map((c) => c.title)).toEqual(['a-active']);
  });
});
