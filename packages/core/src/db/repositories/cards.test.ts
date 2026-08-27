/**
 * CardRepository Tests
 *
 * Focused on the find filters that back the SQL pushdown on CardsService.find.
 */

import type { BoardID, CardID, UUID } from '@agor/core/types';
import { describe, expect, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { ownedDbTest as dbTest } from '../test-helpers';
import { BoardObjectRepository } from './board-objects';
import { BoardRepository } from './boards';
import { CardRepository } from './cards';
import { UsersRepository } from './users';

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

describe('CardRepository.findByZoneId', () => {
  dbTest('joins placements in one query instead of one lookup per card', async ({ db }) => {
    const board = await createBoard(db);
    const cards = new CardRepository(db);
    const objects = new BoardObjectRepository(db);
    const first = await cards.create({ board_id: board, title: 'first' });
    const second = await cards.create({ board_id: board, title: 'second' });
    await objects.create({
      board_id: board,
      card_id: first.card_id as CardID,
      position: { x: 0, y: 0 },
      zone_id: 'todo',
    });
    await objects.create({
      board_id: board,
      card_id: second.card_id as CardID,
      position: { x: 1, y: 0 },
      zone_id: 'done',
    });

    const client = (
      db as unknown as { $client: { execute: (...args: unknown[]) => Promise<unknown> } }
    ).$client;
    const execute = vi.spyOn(client, 'execute');
    const result = await cards.findByZoneId(board, 'todo');

    expect(result.map((card) => card.title)).toEqual(['first']);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('CardRepository.findVisibleById', () => {
  dbTest('resolves prefixes only among boards visible to the caller', async ({ db }) => {
    const userId = generateId() as UUID;
    const hiddenOwnerId = generateId() as UUID;
    const users = new UsersRepository(db);
    await users.create({
      user_id: userId,
      email: `visible-card-owner-${userId}@example.invalid`,
      role: 'member',
    });
    await users.create({
      user_id: hiddenOwnerId,
      email: `hidden-card-owner-${hiddenOwnerId}@example.invalid`,
      role: 'member',
    });
    const boards = new BoardRepository(db);
    const visibleBoard = await boards.create({
      board_id: generateId(),
      name: 'Visible private board',
      created_by: userId,
      access_mode: 'private',
    });
    const hiddenBoard = await boards.create({
      board_id: generateId(),
      name: 'Hidden private board',
      created_by: hiddenOwnerId,
      access_mode: 'private',
    });
    const repo = new CardRepository(db);
    const visible = await repo.create({
      card_id: '01933e5a-1111-7c35-a8f3-000000000001' as CardID,
      board_id: visibleBoard.board_id,
      title: 'visible',
    });
    await repo.create({
      card_id: '01933e5a-2222-7c35-a8f3-000000000002' as CardID,
      board_id: hiddenBoard.board_id,
      title: 'hidden collision',
    });
    const hiddenOnly = await repo.create({
      card_id: '01933e5b-2222-7c35-a8f3-000000000003' as CardID,
      board_id: hiddenBoard.board_id,
      title: 'hidden only',
    });

    await expect(repo.findVisibleById(userId, '01933e5a')).resolves.toMatchObject({
      card_id: visible.card_id,
    });
    await expect(repo.findVisibleById(userId, '01933e5b')).resolves.toBeNull();
    await expect(repo.findVisibleById(userId, hiddenOnly.card_id)).resolves.toBeNull();
  });
});
