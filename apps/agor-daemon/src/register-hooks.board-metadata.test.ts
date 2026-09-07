import {
  BoardRepository,
  CapabilityPolicyRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  UsersRepository,
} from '@agor/core/db';
import type { UserID } from '@agor/core/types';
import { expect } from 'vitest';
import { dbTest } from '../../../packages/core/src/db/test-helpers.js';
import { boardMetadataTestApp } from '../test/board-metadata-app.js';
import type { RegisterHooksContext } from './register-hooks.js';

dbTest(
  'board projection authenticates and enters tenant scope; metadata retains owner and capability authority',
  async ({ db: rawDb }) => {
    const users = new UsersRepository(rawDb);
    const owner = await users.create({ email: 'owner@example.test', role: 'member' });
    const viewer = await users.create({ email: 'viewer@example.test', role: 'member' });
    const editor = await users.create({ email: 'editor@example.test', role: 'member' });
    const boards = new BoardRepository(rawDb);
    const board = await boards.create({ name: 'Original', created_by: owner.user_id });
    const policies = new CapabilityPolicyRepository(rawDb);
    const policy = await policies.getBoardPolicies(board.board_id);
    await policies.replaceBoardPolicies(
      board.board_id,
      {
        ...policy,
        board_access: {
          ...policy.board_access,
          sharing_mode: 'shared',
          // Even an explicit No access entry cannot demote the immutable owner.
          entries: [
            {
              entry_id: generateId(),
              principal: { principal_type: 'user', user_id: owner.user_id },
              preset: 'none',
              capabilities: [],
              fs_access: 'none',
            },
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
    const baselinePolicy = await policies.getBoardPolicies(board.board_id);
    const db = createTenantScopedDatabaseProxy(rawDb, { label: 'board-metadata-test' });
    const server = await boardMetadataTestApp(db, {
      database: { dialect: 'sqlite' },
      multi_tenancy: { mode: 'static', static_tenant_id: 'board-metadata-test' },
      execution: {},
    } as RegisterHooksContext['config']);
    const resource = `${server.url}/boards/${board.board_id}`;
    const metadata = { name: 'Renamed', icon: '👩🏽‍💻', description: 'Owner updated all metadata' };
    const mutate = (userId: UserID, method: string, data: unknown) =>
      fetch(resource, {
        method,
        headers: server.headers(userId),
        body: JSON.stringify(data),
      });
    try {
      expect((await fetch(`${resource}/effective-access`)).status).toBe(401);
      const access = await fetch(`${resource}/effective-access`, {
        headers: server.headers(owner.user_id),
      });
      expect(access.status, await access.clone().text()).toBe(200);
      await expect(access.json()).resolves.toMatchObject({
        is_primary_owner: true,
        source: 'primary_owner',
        capabilities: expect.arrayContaining(['board.edit']),
      });
      const viewerAccess = await fetch(`${resource}/effective-access`, {
        headers: server.headers(viewer.user_id),
      });
      expect(viewerAccess.status).toBe(200);
      await expect(viewerAccess.json()).resolves.toMatchObject({
        is_primary_owner: false,
        capabilities: ['board.view'],
      });

      // Both exposed mutation verbs must enforce the same capability. Exercise
      // individual fields as well as the payload emitted by the real modal.
      for (const method of ['PATCH', 'PUT']) {
        for (const data of [
          { name: metadata.name },
          { icon: metadata.icon },
          { description: metadata.description },
          metadata,
        ]) {
          const denied = await mutate(viewer.user_id, method, data);
          expect(denied.status).toBe(403);
          const allowed = await mutate(owner.user_id, method, data);
          expect(allowed.status, await allowed.clone().text()).toBe(200);
          await expect(allowed.json()).resolves.toMatchObject(data);
        }
      }
      expect(await boards.findById(board.board_id)).toMatchObject(metadata);
      const editorSave = await mutate(editor.user_id, 'PATCH', {
        ...metadata,
        name: 'Editor updated',
      });
      expect(editorSave.status, await editorSave.clone().text()).toBe(200);
      const forgedOwner = await mutate(viewer.user_id, 'PATCH', {
        ...metadata,
        primary_owner_user_id: viewer.user_id,
      });
      expect(forgedOwner.status).toBe(403);
      const reassign = await mutate(owner.user_id, 'PATCH', {
        primary_owner_user_id: editor.user_id,
      });
      expect(reassign.ok).toBe(false);
      expect((await boards.findById(board.board_id))?.primary_owner_user_id).toBe(owner.user_id);
      expect(await policies.getBoardPolicies(board.board_id)).toEqual(baselinePolicy);
    } finally {
      await server.close();
    }
  }
);
