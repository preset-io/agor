import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../client';
import { isPostgresDatabase } from '../database-wrapper';
import { initializeDatabase } from '../migrate';
import { runWithTenantDatabaseScope } from '../tenant-scope';
import { KnowledgeSemanticSettingsRepository } from './knowledge-semantic-settings';

const postgresUrl = process.env.AGOR_TEST_POSTGRES_URL;
const usesPostgresSchema = process.env.AGOR_DB_DIALECT === 'postgresql';

describe.skipIf(!postgresUrl || !usesPostgresSchema)(
  'KnowledgeSemanticSettingsRepository PostgreSQL RLS',
  () => {
    let db: Database;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tenantA = `knowledge-settings-a-${suffix}`;
    const tenantB = `knowledge-settings-b-${suffix}`;

    beforeAll(async () => {
      process.env.AGOR_MASTER_SECRET ||= 'knowledge-semantic-settings-postgres-test-secret';
      db = createDatabase({ dialect: 'postgresql', url: postgresUrl! });
      await initializeDatabase(db);
      if (!isPostgresDatabase(db)) throw new Error('PostgreSQL test requires PostgreSQL');
    });

    afterAll(async () => {
      await (db as Database & { $client: { end: () => Promise<void> } }).$client.end();
    });

    it('isolates typed policy and encrypted credentials between tenants', async () => {
      await runWithTenantDatabaseScope(db, tenantA, async (tenantDb) => {
        await new KnowledgeSemanticSettingsRepository(tenantDb).patch({
          enabled: true,
          model: 'text-embedding-3-large',
          api_key: 'tenant-a-secret',
          chunking: { target_tokens: 640 },
        });
      });
      await runWithTenantDatabaseScope(db, tenantB, async (tenantDb) => {
        await new KnowledgeSemanticSettingsRepository(tenantDb).patch({
          enabled: false,
          api_key: 'tenant-b-secret',
          chunking: { target_tokens: 720 },
        });
      });

      await runWithTenantDatabaseScope(db, tenantA, async (tenantDb) => {
        const repository = new KnowledgeSemanticSettingsRepository(tenantDb);
        await expect(repository.find()).resolves.toMatchObject({
          enabled: true,
          model: 'text-embedding-3-large',
          api_key_configured: true,
          chunking: { target_tokens: 640 },
        });
        await expect(repository.getApiKey()).resolves.toBe('tenant-a-secret');
      });
      await runWithTenantDatabaseScope(db, tenantB, async (tenantDb) => {
        const repository = new KnowledgeSemanticSettingsRepository(tenantDb);
        await expect(repository.find()).resolves.toMatchObject({
          enabled: false,
          model: 'text-embedding-3-small',
          api_key_configured: true,
          chunking: { target_tokens: 720 },
        });
        await expect(repository.getApiKey()).resolves.toBe('tenant-b-secret');
      });
    });

    it('serializes credential-only and policy-only patches through one tenant lock', async () => {
      const tenant = `knowledge-settings-concurrent-${suffix}`;

      await Promise.all([
        runWithTenantDatabaseScope(db, tenant, async (tenantDb) => {
          await new KnowledgeSemanticSettingsRepository(tenantDb).patch({
            api_key: 'concurrent-secret',
          });
        }),
        runWithTenantDatabaseScope(db, tenant, async (tenantDb) => {
          await new KnowledgeSemanticSettingsRepository(tenantDb).patch({
            enabled: true,
          });
        }),
      ]);

      await runWithTenantDatabaseScope(db, tenant, async (tenantDb) => {
        const repository = new KnowledgeSemanticSettingsRepository(tenantDb);
        await expect(repository.find()).resolves.toMatchObject({
          enabled: true,
          api_key_configured: true,
        });
        await expect(repository.getApiKey()).resolves.toBe('concurrent-secret');
      });
    });

    it('blocks credential-only mutation behind the tenant aggregate guard', async () => {
      const tenant = `knowledge-settings-guard-${suffix}`;
      let releaseGuard!: () => void;
      let signalLocked!: () => void;
      const guardLocked = new Promise<void>((resolve) => {
        signalLocked = resolve;
      });
      const holdGuard = new Promise<void>((resolve) => {
        releaseGuard = resolve;
      });

      const holder = runWithTenantDatabaseScope(db, tenant, async (tenantDb) => {
        await new KnowledgeSemanticSettingsRepository(tenantDb).lockAggregateForUpdate(tenantDb);
        signalLocked();
        await holdGuard;
      });
      await guardLocked;

      let mutationCompleted = false;
      const mutation = runWithTenantDatabaseScope(db, tenant, async (tenantDb) => {
        await new KnowledgeSemanticSettingsRepository(tenantDb).patch({
          api_key: 'guarded-secret',
        });
        mutationCompleted = true;
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(mutationCompleted).toBe(false);
      } finally {
        releaseGuard();
      }
      await Promise.all([holder, mutation]);
      expect(mutationCompleted).toBe(true);
    });
  }
);
