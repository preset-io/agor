import {
  createDatabase,
  createTenantScopedDatabaseProxy,
  type Database,
  executeRaw,
  initializeDatabase,
  rawRows,
  runWithoutTenantDatabaseScope,
  runWithTenantDatabaseScope,
  sql,
} from '@agor/core/db';
import type { AuthenticatedParams } from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertPreferenceRace, seedPreferenceRace } from './teammate-preference-race.test-support';

const hook = vi.hoisted(() => ({ afterRead: undefined as (() => Promise<void>) | undefined }));
vi.mock('@agor/core/db', async () => {
  const actual = await vi.importActual<typeof import('@agor/core/db')>('@agor/core/db');
  return {
    ...actual,
    select: (...args: Parameters<typeof actual.select>) => {
      const query = actual.select(...args);
      return {
        ...query,
        from: (table: Parameters<typeof query.from>[0]) => {
          const wrap = (builder: ReturnType<typeof query.from>): ReturnType<typeof query.from> =>
            new Proxy(builder, {
              get(target, key) {
                if (key === 'one')
                  return async () => {
                    const row = await target.one();
                    if (table === actual.users && hook.afterRead) {
                      const run = hook.afterRead;
                      hook.afterRead = undefined;
                      await run();
                    }
                    return row;
                  };
                const value = Reflect.get(target, key);
                return typeof value === 'function'
                  ? (...values: unknown[]) => wrap(value.apply(target, values))
                  : value;
              },
            });
          return wrap(query.from(table));
        },
      };
    },
  };
});

const url = process.env.AGOR_TEST_POSTGRES_URL;
describe.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'preference race (two PostgreSQL connections/RLS)',
  () => {
    let raw: Database;
    let peerRaw: Database;
    beforeAll(async () => {
      raw = createDatabase({ dialect: 'postgresql', url: url! });
      peerRaw = createDatabase({ dialect: 'postgresql', url: url! });
      await initializeDatabase(raw);
      expect(
        rawRows(
          await executeRaw(
            raw,
            sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    }, 60000);
    afterAll(async () => {
      for (const db of [raw, peerRaw])
        await (db as Database & { $client: { end(): Promise<void> } }).$client.end();
    });
    for (const remove of ['retirement', 'self-clear'] as const) {
      it(remove, async () => {
        const db = createTenantScopedDatabaseProxy(raw, { requireScope: true });
        const peer = createTenantScopedDatabaseProxy(peerRaw, { requireScope: true });
        const tenant = `race-${remove}`;
        const fixture = await runWithTenantDatabaseScope(db, tenant, () => seedPreferenceRace(db));
        await runWithTenantDatabaseScope(db, tenant, () =>
          assertPreferenceRace(
            db,
            fixture,
            remove,
            (run) => {
              hook.afterRead = run;
            },
            (work) =>
              runWithoutTenantDatabaseScope(() =>
                runWithTenantDatabaseScope(peer, tenant, () => work(peer))
              )
          )
        );
        await runWithTenantDatabaseScope(peer, 'foreign-tenant', async () => {
          const { UsersService } = await import('./users');
          await expect(
            new UsersService(peer).setPrimaryAgenticToolIfUnset(
              { tool: 'codex', expectedUserId: fixture.user.user_id },
              { user: fixture.user } as AuthenticatedParams
            )
          ).rejects.toThrow();
        });
      });
    }
  }
);
