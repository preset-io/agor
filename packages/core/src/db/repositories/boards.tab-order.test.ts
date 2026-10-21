import type { BoardObject } from '@agor/core/types';
import { describe, expect } from 'vitest';
import { ownedDbTest as dbTest } from '../test-helpers';
import { BoardRepository, mapBoardExportBlobToCreateData } from './boards';

const zone: BoardObject = {
  type: 'zone',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  label: 'Ready',
} as BoardObject;

describe('BoardRepository tab_order', () => {
  dbTest('create stores a normalized tab_order; absent stays absent', async ({ db }) => {
    const repo = new BoardRepository(db);
    const plain = await repo.create({ name: 'Plain', created_by: 'test-user' });
    expect(plain.tab_order).toBeUndefined();
    const teammate = await repo.create({
      name: 'Teammate',
      created_by: 'test-user',
      tab_order: ['chat', 'board', 'files'],
    });
    expect(teammate.tab_order).toEqual(['chat', 'board', 'files']);
    expect((await repo.findById(teammate.board_id))?.tab_order).toEqual(['chat', 'board', 'files']);
  });

  dbTest('generic update rejects tab_order and keeps the stored one', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create({
      name: 'Board',
      created_by: 'test-user',
      tab_order: ['chat', 'board', 'files'],
    });
    await expect(
      repo.update(board.board_id, { tab_order: ['board', 'chat', 'files'] })
    ).rejects.toThrow(/setTabOrder/);
    const renamed = await repo.update(board.board_id, { name: 'Renamed' });
    expect(renamed.tab_order).toEqual(['chat', 'board', 'files']);
  });

  dbTest(
    'setTabOrder changes only tab_order and keeps objects written before it',
    async ({ db }) => {
      const repo = new BoardRepository(db);
      const board = await repo.create({
        name: 'Board',
        created_by: 'test-user',
        description: 'Notes',
        custom_context: { team: 'Backend' },
      });
      await repo.upsertBoardObject(board.board_id, 'zone-1', zone);

      const reordered = await repo.setTabOrder(board.board_id, ['chat', 'board', 'files']);

      expect(reordered.tab_order).toEqual(['chat', 'board', 'files']);
      expect(reordered.objects).toEqual({ 'zone-1': zone });
      expect(reordered.description).toBe('Notes');
      expect(reordered.custom_context).toEqual({ team: 'Backend' });
      expect(reordered.name).toBe('Board');
    }
  );

  dbTest('export, import and clone keep tab_order', async ({ db }) => {
    const repo = new BoardRepository(db);
    const board = await repo.create({ name: 'Source', created_by: 'test-user' });
    await repo.setTabOrder(board.board_id, ['files', 'chat', 'board']);

    const blob = await repo.toBlob(board.board_id);
    expect(blob.tab_order).toEqual(['files', 'chat', 'board']);
    expect(mapBoardExportBlobToCreateData(blob, 'test-user').tab_order).toEqual([
      'files',
      'chat',
      'board',
    ]);
    const imported = await repo.fromYaml(await repo.toYaml(board.board_id), 'test-user');
    expect(imported.tab_order).toEqual(['files', 'chat', 'board']);
    const cloned = await repo.clone(board.board_id, 'Copy', 'test-user');
    expect(cloned.tab_order).toEqual(['files', 'chat', 'board']);
  });
});
