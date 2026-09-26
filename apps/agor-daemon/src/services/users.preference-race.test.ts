import { createTenantScopedDatabaseProxy } from '@agor/core/db';
import { describe, vi } from 'vitest';
import { dbTest } from '../../../../packages/core/src/db/test-helpers';
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

describe('primary coding agent preserves concurrently removed teammate preference (SQLite)', () => {
  for (const remove of ['retirement', 'self-clear'] as const) {
    dbTest(remove, async ({ db: raw }) => {
      const db = createTenantScopedDatabaseProxy(raw, { requireScope: false });
      const fixture = await seedPreferenceRace(db);
      await assertPreferenceRace(
        db,
        fixture,
        remove,
        (run) => {
          hook.afterRead = run;
        },
        (work) => work(db)
      );
    });
  }
});
