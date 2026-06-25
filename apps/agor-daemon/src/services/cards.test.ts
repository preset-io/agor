/**
 * CardsService Tests
 *
 * Verifies the SQL pushdown on CardsService.find: board_id + archived predicates
 * reach the repository read while results stay identical to the in-memory path.
 */

import { BoardRepository, CardRepository, type Database, generateId } from '@agor/core/db';
import type { BoardID, Card } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
import { CardsService } from './cards';

async function seed(db: Database) {
  const boardRepo = new BoardRepository(db);
  const cardRepo = new CardRepository(db);
  const boardA = (
    await boardRepo.create({ board_id: generateId(), name: 'A', created_by: 'test-user' })
  ).board_id as BoardID;
  const boardB = (
    await boardRepo.create({ board_id: generateId(), name: 'B', created_by: 'test-user' })
  ).board_id as BoardID;

  const a1 = await cardRepo.create({ board_id: boardA, title: 'beta' });
  const a2 = await cardRepo.create({ board_id: boardA, title: 'alpha' });
  const aArchived = await cardRepo.create({ board_id: boardA, title: 'gamma' });
  await cardRepo.archive(aArchived.card_id);
  await cardRepo.create({ board_id: boardB, title: 'other' });

  const service = new CardsService(db);
  return { service, boardA, boardB, a1, a2, aArchived };
}

describe('CardsService.find SQL pushdown', () => {
  dbTest('pushes board_id into the repository read', async ({ db }) => {
    const { service, boardA } = await seed(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { cardRepo: CardRepository }).cardRepo,
      'findAll'
    );

    const result = (await service.find({ query: { board_id: boardA } })) as {
      data: Card[];
      total: number;
    };

    // SQL-bounded: the board predicate reaches the repository, not a whole-table read.
    expect(repoFindAll).toHaveBeenCalledWith({ board_id: boardA });
    // boardA has 3 cards (2 active + 1 archived).
    expect(result.total).toBe(3);
    expect(result.data.every((c) => c.board_id === boardA)).toBe(true);
  });

  dbTest('pushes board_id + archived and preserves sort/total parity', async ({ db }) => {
    const { service, boardA } = await seed(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { cardRepo: CardRepository }).cardRepo,
      'findAll'
    );

    const result = (await service.find({
      query: { board_id: boardA, archived: false, $sort: { title: 1 } },
    })) as { data: Card[]; total: number };

    expect(repoFindAll).toHaveBeenCalledWith({ board_id: boardA, archived: false });
    expect(result.total).toBe(2);
    expect(result.data.map((c) => c.title)).toEqual(['alpha', 'beta']);
  });

  dbTest('leaves an uncoerced string archived to the in-memory filter', async ({ db }) => {
    const { service, boardA } = await seed(db);
    const repoFindAll = vi.spyOn(
      (service as unknown as { cardRepo: CardRepository }).cardRepo,
      'findAll'
    );

    // Cards are not query-validated; a raw string 'false' must NOT be pushed as a
    // boolean. The repository read carries only board_id; the string predicate
    // falls through to the in-memory equality filter exactly as before (no card
    // row has archived === 'false', so the result is empty).
    const result = (await service.find({
      query: { board_id: boardA, archived: 'false' as unknown as boolean },
    })) as { data: Card[]; total: number };

    expect(repoFindAll).toHaveBeenCalledWith({ board_id: boardA });
    expect(result.total).toBe(0);
  });
});
