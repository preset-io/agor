import { rm } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { expect, it } from 'vitest';
import { createDatabase } from './client';
import { executeRaw, isSQLiteDatabase, rawRows } from './database-wrapper';
import { checkMigrationStatus, runMigrations } from './migrate';
import {
  beforeTeamsMigrations,
  insertLegacyInbound,
  seedLegacyGateway,
  stageFailingTeamsMigration,
  TEAMS_MIGRATION,
} from './teams-gateway-migration.test-support';

it('upgrades current-main SQLite, disables Teams only and preserves old insert shape', async () => {
  const folder = await beforeTeamsMigrations('sqlite');
  const db = createDatabase({ url: ':memory:' });
  if (!isSQLiteDatabase(db)) throw new Error('Expected SQLite');
  try {
    await migrate(db, { migrationsFolder: folder });
    const fixture = await seedLegacyGateway(db);
    expect((await checkMigrationStatus(db)).pending).toEqual([TEAMS_MIGRATION]);
    await expect(runMigrations(db)).rejects.toThrow('Offline migration cutover required');
    await stageFailingTeamsMigration(folder, 'sqlite');
    await expect(migrate(db, { migrationsFolder: folder })).rejects.toThrow();
    expect(
      rawRows(
        await executeRaw(db, sql`SELECT enabled FROM gateway_channels WHERE channel_type='teams'`)
      )
    ).toEqual([{ enabled: 1 }, { enabled: 1 }]);
    await runMigrations(db, { allowOfflineCutover: true });
    expect(
      rawRows(
        await executeRaw(db, sql`SELECT enabled FROM gateway_channels WHERE channel_type='teams'`)
      )
    ).toEqual([{ enabled: 0 }, { enabled: 0 }]);
    expect(
      rawRows(
        await executeRaw(db, sql`SELECT enabled FROM gateway_channels WHERE id=${fixture.slack}`)
      )
    ).toEqual([{ enabled: 1 }]);
    expect(await insertLegacyInbound(db, fixture.slack)).toEqual({
      next_attempt_at: 0,
      payload_encrypted: null,
    });
    await executeRaw(db, sql`UPDATE gateway_channels SET enabled=1 WHERE id=${fixture.teams}`);
    await expect(
      executeRaw(db, sql`UPDATE gateway_channels SET enabled=1 WHERE id=${fixture.duplicate}`)
    ).rejects.toThrow();
    expect(rawRows(await executeRaw(db, sql`PRAGMA foreign_key_check`))).toEqual([]);
    // INDEXED BY proves applicability and ordering, not optimizer preference on an empty fixture.
    const plan = rawRows(
      await executeRaw(
        db,
        sql`EXPLAIN QUERY PLAN SELECT id FROM gateway_inbound_events INDEXED BY gateway_inbound_events_teams_due_idx
      WHERE status IN ('pending','processing') AND payload_expires_at IS NOT NULL AND next_attempt_at <= 100
      ORDER BY next_attempt_at,id LIMIT 25`
      )
    );
    expect(JSON.stringify(plan)).toContain('gateway_inbound_events_teams_due_idx');
    const lane = rawRows(
      await executeRaw(
        db,
        sql`EXPLAIN QUERY PLAN SELECT id FROM gateway_inbound_events INDEXED BY gateway_inbound_events_teams_lane_idx
      WHERE gateway_channel_id='channel' AND thread_id='thread' AND status IN ('pending','processing')
        AND received_at < 100`
      )
    );
    expect(JSON.stringify(lane)).toContain('gateway_inbound_events_teams_lane_idx');
    await runMigrations(db);
  } finally {
    (db as typeof db & { $client: { close(): void } }).$client.close();
    await rm(folder, { recursive: true, force: true });
  }
}, 30000);

it('applies a fresh SQLite journal and installs partial delivery discovery and lane indexes', async () => {
  const db = createDatabase({ url: ':memory:' });
  if (!isSQLiteDatabase(db)) throw new Error('Expected SQLite');
  try {
    await runMigrations(db);
    const indexes = rawRows(
      await executeRaw(
        db,
        sql`SELECT name,sql FROM sqlite_master WHERE type='index' AND name IN
      ('teams_message_deliveries_discovery_idx','teams_message_deliveries_lane_idx','gateway_inbound_events_teams_expiry_idx')`
      )
    );
    expect(indexes).toHaveLength(3);
    for (const index of indexes)
      expect(index.sql).toContain("WHERE \"status\" IN ('pending', 'processing')");
    // INDEXED BY proves applicability and ordering, not optimizer preference on an empty fixture.
    const plan = rawRows(
      await executeRaw(
        db,
        sql`EXPLAIN QUERY PLAN SELECT delivery_id FROM teams_message_deliveries INDEXED BY teams_message_deliveries_discovery_idx
      WHERE status IN ('pending','processing') AND next_attempt_at <= 100 ORDER BY next_attempt_at,delivery_id LIMIT 25`
      )
    );
    expect(JSON.stringify(plan)).toContain('teams_message_deliveries_discovery_idx');
  } finally {
    (db as typeof db & { $client: { close(): void } }).$client.close();
  }
}, 30000);
