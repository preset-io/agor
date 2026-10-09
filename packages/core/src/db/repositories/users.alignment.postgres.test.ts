import { expect, it } from 'vitest';
import { generateId } from '../../lib/ids';
import type { UserID } from '../../types';
import { createDatabase } from '../client';
import { isPostgresDatabase } from '../database-wrapper';
import { runMigrations } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { UsersRepository } from './users';

const url = process.env.AGOR_TEST_POSTGRES_URL;

// Gateway alignment (Teams email and user_map, Slack/GitHub/Shortcut email) must
// resolve only inside the channel's tenant, even for an identical email.
it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'confines gateway user alignment lookups to the channel tenant',
  async () => {
    const db = createDatabase({ dialect: 'postgresql', url: url! });
    if (!isPostgresDatabase(db)) throw new Error('Expected PostgreSQL');
    try {
      await runMigrations(db);
      const email = `aligned-${generateId()}@example.invalid`;
      const tenantB = `alignment-b-${generateId()}`;
      const other = await runWithTenantDatabaseScope(db, tenantB, (scoped) =>
        new UsersRepository(scoped).create({ email })
      );
      const tenantA = `alignment-a-${generateId()}`;
      await runWithTenantDatabaseScope(db, tenantA, async (scoped) => {
        const users = new UsersRepository(scoped);
        expect(await users.findByEmailForAlignment(email)).toBeNull();
        expect(await users.findByEmailForAlignment(email.toUpperCase())).toBeNull();
        // A user_map entry naming another tenant's User ID resolves to nobody.
        expect(await users.findById(other.user_id as UserID)).toBeNull();
        const own = await users.create({ email });
        expect((await users.findByEmailForAlignment(email))?.user_id).toBe(own.user_id);
      });
    } finally {
      await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  180000
);
