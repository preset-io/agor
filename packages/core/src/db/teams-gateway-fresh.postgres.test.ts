import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createDatabase } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { checkMigrationStatus, runMigrations } from './migrate';

const url = process.env.AGOR_TEST_POSTGRES_URL;
it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'applies a fresh PostgreSQL journal including Teams indexes and FORCE RLS',
  async () => {
    const db = createDatabase({ dialect: 'postgresql', url: url! });
    if (!isPostgresDatabase(db)) throw new Error('Expected PostgreSQL');
    try {
      await runMigrations(db);
      expect((await checkMigrationStatus(db)).hasPending).toBe(false);
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT indexname FROM pg_indexes WHERE indexname IN
      ('gateway_inbound_events_teams_due_idx','gateway_inbound_events_teams_expiry_idx','gateway_inbound_events_teams_lane_idx','teams_message_deliveries_discovery_idx','teams_message_deliveries_lane_idx')`
          )
        )
      ).toHaveLength(5);
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('teams_conversation_addresses','teams_message_deliveries')`
          )
        )
      ).toEqual([
        { relrowsecurity: true, relforcerowsecurity: true },
        { relrowsecurity: true, relforcerowsecurity: true },
      ]);
    } finally {
      await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
    }
  },
  180000
);
