import { rm } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { expect, it } from 'vitest';
import { generateId } from '../lib/ids';
import { createDatabase } from './client';
import { executeRaw, isPostgresDatabase, rawRows } from './database-wrapper';
import { checkMigrationStatus, runMigrations } from './migrate';
import { proveTeamsDiscoveryPlans } from './teams-discovery-plans.test-support';
import {
  beforeTeamsMigrations,
  insertLegacyInbound,
  seedLegacyGateway,
  stageFailingTeamsMigration,
  TEAMS_MIGRATION,
} from './teams-gateway-migration.test-support';
import { runWithTenantDatabaseScope } from './tenant-scope';

const url = process.env.AGOR_TEST_POSTGRES_URL;
it.skipIf(!url || process.env.AGOR_DB_DIALECT !== 'postgresql')(
  'upgrades current-main under FORCE RLS with tenant uniqueness, FK fences and old-writer defaults',
  async () => {
    const folder = await beforeTeamsMigrations('postgres');
    const db = createDatabase({ dialect: 'postgresql', url: url! });
    if (!isPostgresDatabase(db)) throw new Error('Expected PostgreSQL');
    try {
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`
          )
        )
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await migrate(db, { migrationsFolder: folder });
      const a = await runWithTenantDatabaseScope(db, 'teams-a', seedLegacyGateway);
      const b = await runWithTenantDatabaseScope(db, 'teams-b', seedLegacyGateway);
      expect((await checkMigrationStatus(db)).pending).toEqual([TEAMS_MIGRATION]);
      await expect(runMigrations(db)).rejects.toThrow('Offline migration cutover required');
      await stageFailingTeamsMigration(folder, 'postgres');
      await expect(migrate(db, { migrationsFolder: folder })).rejects.toThrow();
      await runWithTenantDatabaseScope(db, 'teams-a', async (scoped) => {
        expect(
          rawRows(
            await executeRaw(
              scoped,
              sql`SELECT enabled FROM gateway_channels WHERE channel_type='teams'`
            )
          )
        ).toEqual([{ enabled: true }, { enabled: true }]);
      });
      expect(
        rawRows(
          await executeRaw(
            db,
            sql`SELECT policyname FROM pg_policies WHERE policyname LIKE 'teams_cutover_%'`
          )
        )
      ).toEqual([]);
      await runMigrations(db, { allowOfflineCutover: true });
      for (const [tenant, fixture] of [
        ['teams-a', a],
        ['teams-b', b],
      ] as const) {
        await runWithTenantDatabaseScope(db, tenant, async (scoped) => {
          expect(
            rawRows(
              await executeRaw(
                scoped,
                sql`SELECT enabled FROM gateway_channels WHERE channel_type='teams'`
              )
            )
          ).toEqual([{ enabled: false }, { enabled: false }]);
          expect(
            rawRows(
              await executeRaw(
                scoped,
                sql`SELECT enabled FROM gateway_channels WHERE id=${fixture.slack}`
              )
            )
          ).toEqual([{ enabled: true }]);
          expect(await insertLegacyInbound(scoped, fixture.slack)).toMatchObject({
            next_attempt_at: expect.any(String),
            payload_encrypted: null,
          });
          // Same App ID in two tenants is allowed, but not twice in either one.
          await executeRaw(
            scoped,
            sql`UPDATE gateway_channels SET enabled=true WHERE id=${fixture.teams}`
          );
        });
        await expect(
          runWithTenantDatabaseScope(db, tenant, (scoped) =>
            executeRaw(
              scoped,
              sql`UPDATE gateway_channels SET enabled=true WHERE id=${fixture.duplicate}`
            )
          )
        ).rejects.toThrow();
      }
      const address = (tenant: string, channel: string) =>
        runWithTenantDatabaseScope(db, tenant, (scoped) =>
          executeRaw(
            scoped,
            sql`INSERT INTO teams_conversation_addresses (tenant_id,address_id,gateway_channel_id,thread_id,conversation_id,encrypted_address,verified_app_id,verified_tenant_id,provider_config_generation,refreshed_at)
          VALUES (${tenant},${generateId()},${channel},'thread','conversation','ciphertext','app','entra',1,CURRENT_TIMESTAMP)`
          )
        );
      await address('teams-a', a.teams);
      await expect(address('teams-b', a.teams)).rejects.toThrow();
      await runWithTenantDatabaseScope(db, 'teams-b', async (scoped) => {
        expect(
          rawRows(await executeRaw(scoped, sql`SELECT * FROM teams_conversation_addresses`))
        ).toEqual([]);
        await executeRaw(
          scoped,
          sql`SELECT set_config('agor.system_scope','teams_cutover_0117',true)`
        );
        expect(
          rawRows(
            await executeRaw(scoped, sql`SELECT id FROM gateway_channels WHERE id=${a.teams}`)
          )
        ).toEqual([]);
      });
      const constraints = rawRows(
        await executeRaw(
          db,
          sql`SELECT conname,pg_get_constraintdef(oid) AS definition,condeferrable
        FROM pg_constraint WHERE conrelid IN ('teams_conversation_addresses'::regclass,'teams_message_deliveries'::regclass) AND contype='f'`
        )
      );
      expect(constraints).toHaveLength(4);
      for (const fk of constraints) {
        expect(fk.definition).toContain('FOREIGN KEY (tenant_id,');
        expect(fk.condeferrable).toBe(false); // These deployment-bound rows never move in archives.
      }
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
      await proveTeamsDiscoveryPlans(db, a);
      await runMigrations(db);
    } finally {
      await (db as typeof db & { $client: { end(): Promise<void> } }).$client.end();
      await rm(folder, { recursive: true, force: true });
    }
  },
  180000
);
