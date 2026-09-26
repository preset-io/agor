import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { deleteBranchDataBatch } from './branch-deletion-data';
import { proveBoundedTeamsCleanup } from './branch-deletion-teams.test-support';
import { createDatabase } from './client';
import { executeRaw, rawRows } from './database-wrapper';
import { initializeDatabase } from './migrate';
import { runWithTenantDatabaseScope } from './tenant-scope';

const url = process.env.AGOR_TEST_POSTGRES_URL;
it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'bounds Teams cleanup under tenant RLS and refuses foreign-branch ownership',
  async () => {
    const db = createDatabase({ dialect: 'postgresql', url: url! });
    try {
      await initializeDatabase(db);
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const fixture = await proveBoundedTeamsCleanup((work) =>
        runWithTenantDatabaseScope(db, 'teams-cleanup-a', work)
      );
      // Tenant B cannot use A's surviving neighbor branch as a deletion root.
      await runWithTenantDatabaseScope(db, 'teams-cleanup-b', async (scoped) => {
        expect(
          await deleteBranchDataBatch(scoped, fixture.neighbor.branch.branch_id, 'fixture-command')
        ).toEqual({ remaining: false, changed: 0 });
      });
      await runWithTenantDatabaseScope(db, 'teams-cleanup-a', async (scoped) => {
        expect(
          rawRows(await executeRaw(scoped, sql`SELECT delivery_id FROM teams_message_deliveries`))
        ).toEqual([{ delivery_id: fixture.retainedDelivery }]);
        expect(
          rawRows(
            await executeRaw(scoped, sql`SELECT address_id FROM teams_conversation_addresses`)
          )
        ).toEqual([{ address_id: fixture.retainedAddress }]);
      });
    } finally {
      await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  180000
);
