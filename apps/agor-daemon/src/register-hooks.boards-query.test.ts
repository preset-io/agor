import { createClient, createRestClient } from '@agor/core/api';
import {
  BoardRepository,
  createTenantScopedDatabaseProxy,
  generateId,
  UsersRepository,
} from '@agor/core/db';
import { MAX_PRESENCE_BOARD_SUBSCRIPTIONS, PRESENCE_SOCKET_EVENTS } from '@agor/core/types';
import { expect } from 'vitest';
import { dbTest } from '../../../packages/core/src/db/test-helpers.js';
import { boardMetadataTestApp } from '../test/board-metadata-app.js';
import { boardPresenceAssociationRoomName } from './realtime/routing.js';
import type { RegisterHooksContext } from './register-hooks.js';

dbTest(
  'validates presence set queries through registered REST/Socket.IO hooks without widening board access',
  async ({ db: rawDb }) => {
    const users = new UsersRepository(rawDb);
    const owner = await users.create({ email: 'owner@example.test', role: 'member' });
    const stranger = await users.create({ email: 'stranger@example.test', role: 'member' });
    const repo = new BoardRepository(rawDb);
    for (let i = 0; i < 3; i++)
      await repo.create({ name: `Board ${i}`, created_by: owner.user_id, access_mode: 'private' });
    const privateBoard = await repo.create({
      name: 'Other owner',
      created_by: stranger.user_id,
      access_mode: 'private',
    });
    const server = await boardMetadataTestApp(
      createTenantScopedDatabaseProxy(rawDb),
      {
        database: { dialect: 'sqlite' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'board-query-audit' },
        execution: {},
      } as RegisterHooksContext['config'],
      true
    );
    const socket = createClient(server.url, true, {
      socketAuthentication: { accessToken: server.headers(owner.user_id).authorization.slice(7) },
      ackTimeout: 2000,
    });
    const rest = await createRestClient(server.url);
    try {
      await rest.authenticate({
        strategy: 'jwt',
        accessToken: server.headers(owner.user_id).authorization.slice(7),
      });
      for (const client of [rest, socket]) {
        for (const query of [
          { lean: true, $limit: 100 },
          { $limit: 100 },
          { lean: true, $limit: 1 },
          { $limit: 1 },
          {
            lean: true,
            archived: false,
            $limit: 1,
            $skip: 0,
            $sort: { created_at: -1, board_id: 1 },
          },
        ]) {
          const result = await client.service('boards').findAll({ query });
          expect(result).toHaveLength(3);
        }
        for (const query of [
          { lean: 'invalid' },
          { board_id: 'not-a-uuid' },
          { $limit: -1 },
          { $skip: 10001 },
          { board_id: { $in: ['not-a-uuid'] } },
        ]) {
          await expect(client.service('boards').find({ query })).rejects.toMatchObject({
            code: 400,
            message: 'validation failed',
          });
        }
      }
      // A maximum-size set exceeds HTTP header limits before REST validation;
      // exercise the schema ceiling on Socket.IO, where presence sends it.
      await expect(
        socket.service('boards').find({
          query: {
            board_id: {
              $in: Array(MAX_PRESENCE_BOARD_SUBSCRIPTIONS + 1).fill(privateBoard.board_id),
            },
          },
        })
      ).rejects.toMatchObject({ code: 400, message: 'validation failed' });
      const denied = await fetch(`${server.url}/boards?lean=true&$limit=1`, {
        headers: server.headers(stranger.user_id),
      });
      expect(denied.status).toBe(200);
      expect(await denied.json()).toMatchObject({
        total: 1,
        data: [{ board_id: privateBoard.board_id }],
      });
      const boards = await rest.service('boards').findAll();
      const requested = [boards[0].board_id, privateBoard.board_id, generateId()];
      for (const client of [rest, socket]) {
        expect(
          await client.service('boards').findAll({
            query: { board_id: { $in: requested }, archived: false, lean: true, $limit: 1 },
          })
        ).toMatchObject([{ board_id: boards[0].board_id }]);
        expect(
          await client.service('boards').findAll({ query: { board_id: boards[0].board_id } })
        ).toHaveLength(1);
      }
      // The REST client's serializer omits empty arrays; native presence uses
      // Socket.IO and explicitly bypasses find for an empty subscription set.
      expect(await socket.service('boards').findAll({ query: { board_id: { $in: [] } } })).toEqual(
        []
      );
      // This native UI event used to emit an unsupported board_id.$in query,
      // fail before the list read, and acknowledge every nonempty set negatively.
      const subscribe = (boardIds: string[]) =>
        socket.io
          .timeout(2000)
          .emitWithAck(PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations, { boardIds });
      expect(await subscribe(requested)).toEqual({ ok: true });
      const rooms = server.app.io.sockets.sockets.get(socket.io.id!)!.rooms;
      expect(
        rooms.has(boardPresenceAssociationRoomName('board-query-audit', boards[0].board_id))
      ).toBe(true);
      for (const id of [boards[1].board_id, ...requested.slice(1)]) {
        expect(rooms.has(boardPresenceAssociationRoomName('board-query-audit', id))).toBe(false);
      }
      expect(await subscribe([])).toEqual({ ok: true });
      expect(
        rooms.has(boardPresenceAssociationRoomName('board-query-audit', boards[0].board_id))
      ).toBe(false);
    } finally {
      socket.io.disconnect();
      await server.close();
    }
  },
  30000
);
