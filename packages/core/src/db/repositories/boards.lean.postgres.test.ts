import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateId } from '../../lib/ids';
import type { BoardID, UserID } from '../../types/id';
import { createDatabase, type Database } from '../client';
import { select, update } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { boards } from '../schema';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { ensureTestUser } from '../test-helpers';
import { getHiddenTenantId } from './base';
import { BoardRepository } from './boards';

const url = process.env.AGOR_TEST_POSTGRES_URL;

describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'board lean PostgreSQL/RLS',
  () => {
    let db: Database;
    const tenantA = `board-lean-a-${generateId()}`;
    const tenantB = `board-lean-b-${generateId()}`;
    let foreignId: BoardID;

    beforeAll(async () => {
      db = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(db);
      // A bypass role would make negative RLS coverage meaningless.
      const role = await select(db, { safe: sql<boolean>`NOT rolsuper AND NOT rolbypassrls` })
        .from(sql`pg_roles`)
        .where(sql`rolname = current_user`)
        .one();
      expect(role?.safe).toBe(true);
      for (const tenant of [tenantA, tenantB]) {
        await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          // User IDs are globally unique even though visibility is tenant-scoped.
          const owner = await ensureTestUser(scoped, generateId() as UserID);
          const board = await new BoardRepository(scoped).create({
            name: 'Same name',
            slug: 'same-slug',
            created_by: owner,
            custom_css: '/* large */'.repeat(10000),
          });
          if (tenant === tenantB) foreignId = board.board_id;
          await update(scoped, boards)
            .set({
              data: {
                objects: { note: { type: 'markdown', content: 'annotation'.repeat(10000) } },
                custom_css: '/* large */'.repeat(10000),
                description: null,
                future_field: { objects: 'keep nested', custom_css: null },
              },
            })
            .where(eq(boards.board_id, board.board_id))
            .run();
        });
      }
    }, 60000);

    afterAll(async () => {
      if (db) await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });

    it('projects before decoding, retains hidden identity, and cannot read/count foreign boards', async () => {
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const repo = new BoardRepository(scoped);
        const full = await repo.findAll();
        expect(full).toHaveLength(1);
        const { objects: _objects, custom_css: _css, ...expected } = full[0];
        const decoder = vi.spyOn(boards.data, 'mapFromDriverValue');
        try {
          for (const read of [
            () => repo.findAll({ lean: true }),
            async () => (await repo.findPage({ lean: true, limit: 1, sort: { name: 1 } })).data,
          ]) {
            decoder.mockClear();
            const rows = await read();
            expect(rows).toEqual([expected]);
            expect(getHiddenTenantId(rows[0])).toBe(tenantA);
            expect(Object.keys(rows[0])).not.toContain('tenant_id');
            expect(decoder.mock.calls).toHaveLength(1);
            const value = decoder.mock.calls[0][0];
            const data = typeof value === 'string' ? JSON.parse(value) : value;
            expect(data).not.toHaveProperty('objects');
            expect(data).not.toHaveProperty('custom_css');
            expect(data).toMatchObject({
              future_field: { objects: 'keep nested', custom_css: null },
            });
          }
          expect(await repo.findAll({ lean: true, boardIds: [foreignId] })).toEqual([]);
          expect(await repo.findPage({ lean: true, boardIds: [foreignId] })).toEqual({
            data: [],
            total: 0,
          });
          expect((await repo.findPage({ lean: true })).total).toBe(1);
          expect(await repo.findById(foreignId)).toBeNull();
          expect(await repo.findById(full[0].board_id)).toEqual(full[0]);
        } finally {
          decoder.mockRestore();
        }
      });
    });
    it('matches full conversion for missing/null fields and non-object legacy JSON', async () => {
      await runWithTenantDatabaseScope(db, tenantB, async (scoped) => {
        const repo = new BoardRepository(scoped);
        for (const data of [
          {},
          { objects: null, custom_css: null, retained: null },
          { objects: {}, custom_css: '', retained: false },
          ['objects', 'custom_css'],
          'legacy',
        ]) {
          await update(scoped, boards).set({ data }).where(eq(boards.board_id, foreignId)).run();
          const full = (await repo.findAll())[0];
          const { objects: _objects, custom_css: _css, ...expected } = full;
          expect(await repo.findAll({ lean: true })).toEqual([expected]);
          expect((await repo.findPage({ lean: true })).data).toEqual([expected]);
        }
        // JSON null was already rejected by rowToBoard; SQL must not turn it into {}.
        await update(scoped, boards)
          .set({ data: sql`'null'::jsonb` })
          .where(eq(boards.board_id, foreignId))
          .run();
        await expect(repo.findAll()).rejects.toThrow('Failed to find all boards');
        await expect(repo.findAll({ lean: true })).rejects.toThrow('Failed to find all boards');
        await expect(repo.findPage({ lean: true })).rejects.toThrow();
      });
    });
  }
);
