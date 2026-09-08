import { createClient, createRestClient } from '@agor/core/api';
import {
  BoardObjectRepository,
  BranchRepository,
  CardRepository,
  createTenantScopedDatabaseProxy,
} from '@agor/core/db';
import type { McpServer } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { dbTest } from '../../../packages/core/src/db/test-helpers.js';
import { seedBoardEntities } from '../test/board-entity-fixture.js';
import { boardMetadataTestApp } from '../test/board-metadata-app.js';
import { ToolDispatcher, toolDispatcherProxy } from './mcp/register-tool-proxy.js';
import type { McpContext } from './mcp/server.js';
import { tenantScopedToolProxy } from './mcp/tenant-scope.js';
import { registerBoardTools } from './mcp/tools/boards.js';
import type { RegisterHooksContext } from './register-hooks.js';

dbTest(
  'board entity archive/count/page pushdown preserves real transport authorization and MCP semantics',
  async ({ db }) => {
    const fixture = await seedBoardEntities(db);
    const server = await boardMetadataTestApp(
      createTenantScopedDatabaseProxy(db),
      {
        database: { dialect: 'sqlite' },
        multi_tenancy: { mode: 'static', static_tenant_id: 'entity-audit' },
        execution: {},
      } as RegisterHooksContext['config'],
      true
    );
    const accessToken = server.headers(fixture.owner.user_id).authorization.slice(7);
    const rest = await createRestClient(server.url);
    const socket = createClient(server.url, true, {
      socketAuthentication: { accessToken },
      ackTimeout: 2000,
    });
    const query = {
      board_id: fixture.board.board_id,
      zone_id: 'zone-review',
      exclude_archived_branches: true,
      $limit: 1,
      $skip: 1,
    };
    try {
      await rest.authenticate({ strategy: 'jwt', accessToken });
      for (const client of [rest, socket]) {
        const branchPage = await client.service('branches').find({
          query: {
            board_id: fixture.board.board_id,
            zone_id: 'zone-review',
            archived: false,
            $limit: 1,
            $skip: 1,
          },
        });
        expect(branchPage).toMatchObject({
          total: 2,
          limit: 1,
          skip: 1,
          data: [{ branch_id: fixture.entities[2].branch_id }],
        });
        expect(await client.service('board-objects').find({ query })).toMatchObject({
          total: 3,
          limit: 1,
          skip: 1,
          data: [{ object_id: fixture.entities[2].object_id }],
        });
        expect(
          await client.service('board-objects').find({ query: { ...query, $skip: 9 } })
        ).toMatchObject({ total: 3, data: [] });
        expect(
          await client
            .service('board-objects')
            .find({ query: { ...query, $skip: 0, $limit: 10, entity_type: 'branch' } })
        ).toMatchObject({
          total: 2,
          data: [
            { object_id: fixture.entities[1].object_id },
            { object_id: fixture.entities[2].object_id },
          ],
        });
        expect(
          await client
            .service('board-objects')
            .find({ query: { ...query, $skip: 0, $limit: 10, entity_type: 'card' } })
        ).toMatchObject({ total: 1, data: [{ object_id: fixture.cardObject.object_id }] });
        expect(
          await client
            .service('board-objects')
            .find({ query: { ...query, $skip: 0, $limit: 10, exclude_archived_branches: false } })
        ).toMatchObject({ total: 4 });
        await expect(
          client
            .service('board-objects')
            .find({ query: { ...query, exclude_archived_branches: 'invalid' } })
        ).rejects.toMatchObject({ code: 400 });
      }
      const denied = await fetch(
        `${server.url}/board-objects?board_id=${fixture.board.board_id}&exclude_archived_branches=true`,
        { headers: server.headers(fixture.other.user_id) }
      );
      expect(await denied.json()).toMatchObject({ total: 0, data: [] });

      // Real MCP handler plus registered services. A branch lookup here would
      // reject on the old scalar-only query validator; no mocked archive filter.
      const dispatcher = new ToolDispatcher();
      const stub = { registerTool() {} } as unknown as McpServer;
      const ctx = {
        app: server.app,
        db,
        userId: fixture.owner.user_id,
        authenticatedUser: fixture.owner,
        baseServiceParams: { provider: 'mcp', authentication: { strategy: 'jwt', accessToken } },
      } as unknown as McpContext;
      registerBoardTools(tenantScopedToolProxy(toolDispatcherProxy(stub, dispatcher), ctx), ctx);
      const findBranches = vi.spyOn(server.app.service('branches'), 'find');
      const getBoard = async (args: Record<string, unknown>) => {
        const result = (await dispatcher.get('agor_boards_get')!.handler({
          boardId: fixture.board.board_id,
          includeEntities: true,
          entityZoneId: 'zone-review',
          ...args,
        })) as { content: { text: string }[] };
        return JSON.parse(result.content[0].text);
      };
      expect(await getBoard({ entitiesLimit: 1, entitiesSkip: 1 })).toMatchObject({
        entities: [{ object_id: fixture.entities[2].object_id }],
        entities_pagination: { total: 3, limit: 1, skip: 1 },
      });
      expect(await getBoard({ entitiesSkip: 2 })).toMatchObject({
        entities: [{ object_id: fixture.cardObject.object_id }],
        entities_pagination: { total: 3, limit: null, skip: 2 },
      });
      expect((await getBoard({})).entities).toHaveLength(3);
      expect((await getBoard({ includeArchived: true })).entities).toHaveLength(4);
      expect(findBranches).not.toHaveBeenCalled();

      // Two SQL statements regardless of returned row count: COUNT + bounded page.
      const execute = vi.spyOn(
        (db as unknown as { $client: { execute: (...args: unknown[]) => unknown } }).$client,
        'execute'
      );
      const objects = new BoardObjectRepository(db);
      execute.mockClear();
      await objects.countVisibleToUser(fixture.owner.user_id, query);
      await objects.findVisibleToUser(fixture.owner.user_id, query, { limit: 1, offset: 1 });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(execute.mock.calls)).toMatch(/exists/i);
      execute.mockClear();
      const branchPage = await new BranchRepository(db).findPage({
        board_id: fixture.board.board_id,
        zone_id: 'zone-review',
        archived: false,
        visibleToUserId: fixture.owner.user_id,
        limit: 1,
        offset: 1,
      });
      expect(branchPage.total).toBe(2);
      expect(branchPage.data[0].branch_id).toBe(fixture.entities[2].branch_id);
      expect(execute).toHaveBeenCalledTimes(2);
      execute.mockRestore();

      // Exceed the default 100-row page even after skipping the original three
      // visible entities: omitted limits must still return the entire tail.
      const cards = new CardRepository(db);
      const addedObjects = [];
      for (let index = 0; index < 105; index++) {
        const card = await cards.create({
          board_id: fixture.board.board_id,
          title: `Unlimited-read fixture ${index}`,
          created_by: fixture.owner.user_id,
        });
        addedObjects.push(
          await objects.create({
            board_id: fixture.board.board_id,
            card_id: card.card_id,
            position: { x: index, y: 1 },
            zone_id: 'zone-review',
          })
        );
      }
      const unlimited = await getBoard({});
      expect(unlimited.entities_pagination).toEqual({ total: 108, limit: null, skip: 0 });
      expect(unlimited.entities).toHaveLength(108);
      expect(unlimited.entities).toEqual(
        expect.arrayContaining(
          addedObjects.map(({ object_id }) => expect.objectContaining({ object_id }))
        )
      );
      const tail = await getBoard({ entitiesSkip: 3 });
      expect(tail.entities_pagination).toEqual({ total: 108, limit: null, skip: 3 });
      expect(tail.entities).toHaveLength(105);
      expect(tail.entities).toEqual(unlimited.entities.slice(3));
      expect(findBranches).not.toHaveBeenCalled();
    } finally {
      socket.io.disconnect();
      await server.close();
    }
  },
  30000
);
