import {
  BoardRepository,
  CapabilityPolicyRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  UsersRepository,
} from '@agor/core/db';
import type { Board, BoardObject, UserID } from '@agor/core/types';
import { expect } from 'vitest';
import { dbTest } from '../../../packages/core/src/db/test-helpers.js';
import { boardMetadataTestApp } from '../test/board-metadata-app.js';
import type { RegisterHooksContext } from './register-hooks.js';

const zone = { type: 'zone', x: 0, y: 0, width: 400, height: 300, label: 'Ready' } as BoardObject;

dbTest(
  'setTabOrder needs board.edit, normalizes the list, writes only tab_order and emits boards patched',
  async ({ db: rawDb }) => {
    const users = new UsersRepository(rawDb);
    const owner = await users.create({ email: 'owner@example.test', role: 'member' });
    const editor = await users.create({ email: 'editor@example.test', role: 'member' });
    const viewer = await users.create({ email: 'viewer@example.test', role: 'member' });
    const boards = new BoardRepository(rawDb);
    const board = await boards.create({
      name: 'Board',
      description: 'Notes',
      created_by: owner.user_id,
    });
    await boards.upsertBoardObject(board.board_id, 'zone-1', zone);
    const policies = new CapabilityPolicyRepository(rawDb);
    const policy = await policies.getBoardPolicies(board.board_id);
    await policies.replaceBoardPolicies(
      board.board_id,
      {
        ...policy,
        board_access: {
          ...policy.board_access,
          sharing_mode: 'shared',
          entries: [
            {
              entry_id: generateId(),
              principal: { principal_type: 'user', user_id: editor.user_id },
              preset: 'editor',
              capabilities: ['board.view', 'board.edit', 'board.attach_branch'],
              fs_access: 'none',
            },
          ],
          others: { preset: 'viewer', capabilities: ['board.view'], fs_access: 'none' },
        },
      },
      owner.user_id
    );
    const db = createTenantScopedDatabaseProxy(rawDb, { label: 'board-tab-order-test' });
    const server = await boardMetadataTestApp(db, {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'board-tab-order-test' },
      execution: {},
    } as RegisterHooksContext['config']);
    const patched: Board[] = [];
    server.app.service('boards').on('patched', (data: Board) => patched.push(data));
    const setTabOrder = (userId: UserID, tab_order: unknown) =>
      fetch(`${server.url}/boards/${board.board_id}`, {
        method: 'PATCH',
        headers: server.headers(userId),
        body: JSON.stringify({ _action: 'setTabOrder', tab_order }),
      });
    try {
      const denied = await setTabOrder(viewer.user_id, ['chat', 'board', 'files']);
      expect(denied.status).toBe(403);
      expect((await boards.findById(board.board_id))?.tab_order).toBeUndefined();

      for (const bad of ['chat', { chat: 0 }, null]) {
        const rejected = await setTabOrder(editor.user_id, bad);
        expect(rejected.status).toBe(400);
      }
      expect(patched).toHaveLength(0);

      // An older or newer UI's list is normalized: duplicates and unknown views dropped,
      // missing views appended.
      const allowed = await setTabOrder(editor.user_id, ['chat', 'chat', 'canvas']);
      expect(allowed.status, await allowed.clone().text()).toBe(200);
      await expect(allowed.json()).resolves.toMatchObject({
        tab_order: ['chat', 'board', 'files'],
      });
      expect(patched.map((b) => b.tab_order)).toEqual([['chat', 'board', 'files']]);

      const stored = await boards.findById(board.board_id);
      expect(stored).toMatchObject({
        name: 'Board',
        description: 'Notes',
        tab_order: ['chat', 'board', 'files'],
        objects: { 'zone-1': zone },
      });

      // The generic patch path cannot write the order.
      const generic = await fetch(`${server.url}/boards/${board.board_id}`, {
        method: 'PATCH',
        headers: server.headers(owner.user_id),
        body: JSON.stringify({ tab_order: ['board', 'chat', 'files'] }),
      });
      expect(generic.ok).toBe(false);
      expect((await boards.findById(board.board_id))?.tab_order).toEqual([
        'chat',
        'board',
        'files',
      ]);
    } finally {
      await server.close();
    }
  }
);
