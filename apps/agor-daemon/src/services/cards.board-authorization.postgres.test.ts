import {
  BoardObjectRepository,
  BranchRepository,
  CardRepository,
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  initializeDatabase,
  runWithTenantDatabaseScope,
  sql,
} from '@agor/core/db';
import type { CardID } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedBoardEntities } from '../../test/board-entity-fixture.js';
import { boardMetadataTestApp } from '../../test/board-metadata-app.js';
import type { RegisterHooksContext } from '../register-hooks.js';
import { type CardParams, CardsService } from './cards.js';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'card board authorization across tenants (PostgreSQL/RLS)',
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

    it('an admin bypasses board RBAC only inside their own tenant', async () => {
      const db = createTenantScopedDatabaseProxy(rawDb);
      const a = await runWithTenantDatabaseScope(db, 'cards-a', (scoped) =>
        seedBoardEntities(scoped)
      );
      const b = await runWithTenantDatabaseScope(db, 'cards-b', (scoped) =>
        seedBoardEntities(scoped, 'admin')
      );
      const service = new CardsService(db);
      const adminParams: CardParams = {
        provider: 'mcp',
        authenticated: true,
        user: { user_id: b.owner.user_id, email: b.owner.email, role: 'admin' },
      };
      const foreignCardId = a.cardObject.card_id as CardID;
      const asB = <T>(work: () => Promise<T>) => runWithTenantDatabaseScope(db, 'cards-b', work);
      const foreignCards = () =>
        runWithTenantDatabaseScope(db, 'cards-a', (scoped) =>
          new CardRepository(scoped).findByBoardId(a.board.board_id)
        );
      const before = await foreignCards();

      expect(await asB(() => service.getWithType(foreignCardId, adminParams))).toBeNull();
      await expect(asB(() => service.archive(foreignCardId, adminParams))).rejects.toThrow(
        /not found/i
      );
      await expect(
        asB(() => service.moveToZone(foreignCardId, 'zone-other', undefined, adminParams))
      ).rejects.toThrow();
      await expect(
        asB(() =>
          service.createWithPlacement({ board_id: a.board.board_id, title: 'Planted' }, adminParams)
        )
      ).rejects.toThrow();
      expect(await foreignCards()).toEqual(before);

      const ownCardId = b.cardObject.card_id as CardID;
      expect((await asB(() => service.archive(ownCardId, adminParams))).archived).toBe(true);
    }, 30000);

    it('an admin cannot place their branch on another tenant board through REST', async () => {
      const db = createTenantScopedDatabaseProxy(rawDb);
      const a = await runWithTenantDatabaseScope(db, 'placements-a', (scoped) =>
        seedBoardEntities(scoped)
      );
      const b = await runWithTenantDatabaseScope(db, 'placements-b', (scoped) =>
        seedBoardEntities(scoped, 'admin')
      );
      const unplaced = await runWithTenantDatabaseScope(db, 'placements-b', (scoped) =>
        new BranchRepository(scoped).create({
          repo_id: b.repo.repo_id,
          name: 'unplaced',
          ref: 'unplaced',
          branch_unique_id: 99,
          created_by: b.owner.user_id,
          primary_owner_user_id: b.owner.user_id,
          permission_source: 'override',
          others_can: 'none',
        })
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
      const place = (boardId: string) =>
        fetch(`${server.url}/board-objects`, {
          method: 'POST',
          headers: server.headers(b.owner.user_id, 'placements-b'),
          body: JSON.stringify({
            board_id: boardId,
            branch_id: unplaced.branch_id,
            position: { x: 1, y: 1 },
          }),
        });
      // A planted row would live in tenant B while naming tenant A's board.
      const plantedObjects = () =>
        runWithTenantDatabaseScope(db, 'placements-b', (scoped) =>
          new BoardObjectRepository(scoped).findAll({ board_id: a.board.board_id })
        );
      try {
        expect((await place(a.board.board_id)).status).toBe(403);
        expect(await plantedObjects()).toEqual([]);
        expect((await place(b.board.board_id)).status).toBe(201);
      } finally {
        await server.close();
      }
    }, 30000);
  }
);
