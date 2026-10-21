import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { UserID } from '../../types/id';
import { createDatabase, type Database } from '../client';
import { select } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { ensureTestUser } from '../test-helpers';
import { BoardRepository } from './boards';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'board tab_order PostgreSQL',
  () => {
    let db: Database;
    const tenant = `board-tab-order-${generateId()}`;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
      const role = await select(db, { safe: sql<boolean>`NOT rolsuper AND NOT rolbypassrls` })
        .from(sql`pg_roles`)
        .where(sql`rolname = current_user`)
        .one();
      expect(role?.safe).toBe(true);
    }, 60000);

    afterAll(async () => {
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    it('jsonSetJson writes only data.tab_order', async () => {
      await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
        const owner = await ensureTestUser(scoped, generateId() as UserID);
        const repo = new BoardRepository(scoped);
        const board = await repo.create({
          name: 'Board',
          created_by: owner,
          description: 'Notes',
          custom_context: { team: 'Backend' },
        });
        const reordered = await repo.setTabOrder(board.board_id, ['chat', 'board', 'files']);
        expect(reordered.tab_order).toEqual(['chat', 'board', 'files']);
        expect(reordered.description).toBe('Notes');
        expect(reordered.custom_context).toEqual({ team: 'Backend' });
      });
    });
  }
);
