import { createRestClient } from '@agor/core/api';
import {
  BranchRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  initializeDatabase,
  runWithTenantDatabaseScope,
  sql,
} from '@agor/core/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBoardEntities } from '../test/board-entity-fixture.js';
import { boardMetadataTestApp } from '../test/board-metadata-app.js';
import type { RegisterHooksContext } from './register-hooks.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'board entity and branch zone pushdown (PostgreSQL/RLS)',
  () => {
    let rawDb: Database;
    beforeAll(async () => {
      rawDb = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(rawDb);
      const result = await executeRaw(
        rawDb,
        sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
    }, 60000);
    afterAll(async () => {
      await (rawDb as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('applies archive/zone/RBAC before total and page, including cross-tenant negative reads by an admin', async () => {
      const db = createTenantScopedDatabaseProxy(rawDb);
      const a = await runWithTenantDatabaseScope(db, 'entities-a', (scoped) =>
        seedBoardEntities(scoped)
      );
      const b = await runWithTenantDatabaseScope(db, 'entities-b', (scoped) =>
        seedBoardEntities(scoped, 'admin')
      );
      const server = await boardMetadataTestApp(db, {
        database: { dialect: 'postgresql' },
        multi_tenancy: {
          mode: 'required_from_auth',
          auth_claim: 'tenant_id',
          filesystem_isolation_enabled: true,
        },
        execution: {},
      } as RegisterHooksContext['config']);
      try {
        for (const [fixture, tenantId, foreign] of [
          [a, 'entities-a', b],
          [b, 'entities-b', a],
        ] as const) {
          const client = await createRestClient(server.url);
          await client.authenticate({
            strategy: 'jwt',
            accessToken: server.headers(fixture.owner.user_id, tenantId).authorization.slice(7),
          });
          const query = {
            board_id: fixture.board.board_id,
            zone_id: 'zone-review',
            exclude_archived_branches: true,
            $limit: 1,
            $skip: 1,
          };
          expect(
            await client.service('branches').find({
              query: {
                board_id: fixture.board.board_id,
                zone_id: 'zone-review',
                archived: false,
                $limit: 1,
                $skip: 1,
              },
            })
          ).toMatchObject({ total: 2, data: [{ branch_id: fixture.entities[2].branch_id }] });
          expect(
            await client.service('board-objects').find({
              query: {
                board_id: fixture.board.board_id,
                zone_id: 'zone-review',
                exclude_archived_branches: true,
                $skip: 2,
              },
            })
          ).toMatchObject({ total: 3, data: [{ object_id: fixture.cardObject.object_id }] });
          expect(await client.service('board-objects').find({ query })).toMatchObject({
            total: 3,
            data: [{ object_id: fixture.entities[2].object_id }],
            limit: 1,
            skip: 1,
          });
          expect(
            await client
              .service('board-objects')
              .find({ query: { ...query, $skip: 0, $limit: 10 } })
          ).toMatchObject({
            total: 3,
            data: [
              { object_id: fixture.entities[1].object_id },
              { object_id: fixture.entities[2].object_id },
              { object_id: fixture.cardObject.object_id },
            ],
          });
          expect(
            await client
              .service('board-objects')
              .find({ query: { ...query, exclude_archived_branches: false, $skip: 0 } })
          ).toMatchObject({ total: 4, data: [{ object_id: fixture.entities[0].object_id }] });
          expect(
            await client.service('board-objects').find({ query: { ...query, $skip: 10 } })
          ).toMatchObject({ total: 3, data: [] });
          expect(
            await client
              .service('board-objects')
              .find({ query: { ...query, board_id: foreign.board.board_id, $skip: 0 } })
          ).toMatchObject({ total: 0, data: [] });
          expect(
            await client
              .service('board-objects')
              .find({ query: { ...query, branch_id: foreign.entities[1].branch_id, $skip: 0 } })
          ).toMatchObject({ total: 0, data: [] });
          await runWithTenantDatabaseScope(db, tenantId, async (scoped) => {
            const repo = new BranchRepository(scoped);
            const page = await repo.findPage({
              zone_id: 'zone-review',
              archived: false,
              visibleToUserId: fixture.owner.user_id,
              limit: 1,
              offset: 1,
            });
            expect(page.total).toBe(2);
            expect(page.data[0].branch_id).toBe(fixture.entities[2].branch_id);
            expect(
              await repo.findPage({
                zone_id: 'zone-review',
                board_id: foreign.board.board_id,
                visibleToUserId: fixture.owner.user_id,
              })
            ).toEqual({ total: 0, data: [] });
          });
        }
      } finally {
        await server.close();
      }
    }, 30000);
  }
);
